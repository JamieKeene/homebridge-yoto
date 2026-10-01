/** Homebridge-managed AirPlay receivers backed by the existing Yoto account. */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import { createInterface } from 'node:readline'
import { startMediaRemoteBridge } from './mediaremote-bridge.js'
/** @import { Logger } from 'homebridge' */
/** @import { YotoDeviceModel } from 'yoto-nodejs-client' */
/** @import { ChildProcess } from 'node:child_process' */

const execute = promisify(execFile)
const receiver = fileURLToPath(new URL('../experiments/mediaremote/receiver.py', import.meta.url))
const requirements = fileURLToPath(new URL('../experiments/mediaremote/requirements.txt', import.meta.url))

/** @param {unknown} value */
export function getNativeControlsConfig (value) {
  const config = value && typeof value === 'object'
    ? /** @type {Record<string, unknown>} */ (value)
    : {}
  const port = config['port'] ?? 7000
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Native controls port must be between 1024 and 65535')
  const address = config['address']
  if (address !== undefined && typeof address !== 'string') throw new Error('Native controls address must be an IPv4 address')
  const python = config['pythonPath'] ?? 'python3'
  if (typeof python !== 'string' || !python) throw new Error('Native controls Python path must be a string')
  const devices = config['devices'] ?? []
  if (!Array.isArray(devices) || !devices.every(x => typeof x === 'string')) throw new Error('Native controls devices must be player names or IDs')
  return { port, address: address || undefined, python, devices: /** @type {string[]} */ (devices) }
}

/** @param {string | undefined} configured
 * @param {string[]} [localAddresses]
 */
export function nativeControlsAddress (configured, localAddresses) {
  const addresses = [...new Set(localAddresses ?? Object.values(networkInterfaces()).flatMap(entries =>
    (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal).map(entry => entry.address)))]
  if (configured) {
    if (!addresses.includes(configured)) throw new Error('Native controls LAN address is not assigned to this Homebridge host')
    return configured
  }
  if (addresses.length !== 1) throw new Error('Set the Native Controls LAN Address in plugin settings: Homebridge has multiple or no IPv4 interfaces')
  const address = addresses[0]
  if (!address) throw new Error('No LAN IPv4 address available')
  return address
}

/**
 * @param {string} python
 * @param {string} storage
 * @param {Logger} log
 * @param {AbortSignal} signal
 */
async function preparePython (python, storage, log, signal) {
  const runtime = join(storage, 'yoto-mediaremote-runtime')
  const executable = join(runtime, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const wanted = await readFile(requirements, 'utf8')
  try {
    if (await readFile(join(runtime, 'requirements-installed'), 'utf8') === wanted) {
      await execute(executable, ['-c', 'import pyatv, aiohttp, zeroconf'], { signal, timeout: 30000 })
      return executable
    }
  } catch { /* Create or repair the dedicated runtime below. */ }
  log.info('Preparing native iPhone controls (first startup may take a few minutes)...')
  await mkdir(storage, { recursive: true })
  await execute(python, ['-m', 'venv', runtime], { signal, timeout: 60000 })
  await execute(executable, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements],
    { signal, timeout: 300000, maxBuffer: 4 * 1024 * 1024 })
  await writeFile(join(runtime, 'requirements-installed'), wanted)
  return executable
}

export class NativeControls {
  /** @type {import('node:http').Server | null} */ bridge = null
  /** @type {Map<string, { child: ChildProcess, port: number }>} */ children = new Map()
  /** @type {Map<string, number>} */ ports = new Map()
  /** @type {ReturnType<typeof setTimeout> | null} */ retry = null
  stopped = false
  controller = new AbortController()
  python = ''
  address = ''
  token = randomBytes(32).toString('hex')
  bridgeUrl = ''

  /**
   * @param {unknown} config
   * @param {string} storage
   * @param {() => Map<string, YotoDeviceModel> | undefined} devices
   * @param {Logger} log
   * @param {{ prepare?: typeof preparePython, spawn?: typeof spawn, address?: typeof nativeControlsAddress, artwork?: (cardId: string) => string | null, tracks?: (cardId: string) => import('./utils/card-tracks.js').CardTrack[] | null }} [runtime]
   */
  constructor (config, storage, devices, log, runtime = {}) {
    this.config = getNativeControlsConfig(config)
    this.storage = storage
    this.devices = devices
    this.log = log
    this.prepare = runtime.prepare ?? preparePython
    this.spawn = runtime.spawn ?? spawn
    this.resolveAddress = runtime.address ?? nativeControlsAddress
    this.artwork = runtime.artwork
    this.tracks = runtime.tracks
  }

  async start () {
    if (process.platform === 'win32') throw new Error('Native iPhone controls currently require Linux or macOS')
    this.address = this.resolveAddress(this.config.address)
    this.python = await this.prepare(this.config.python, this.storage, this.log, this.controller.signal)
    if (this.stopped) return
    this.bridge = await startMediaRemoteBridge({ host: '127.0.0.1', port: 0, token: this.token }, this.devices, this.log, this.artwork, this.tracks)
    const address = this.bridge?.address()
    if (!address || typeof address === 'string') throw new Error('Native controls adapter did not start')
    this.bridgeUrl = `http://127.0.0.1:${address.port}`
    if (this.stopped) return this.stop()
    this.sync()
  }

  sync () {
    if (this.stopped || !this.python || !this.bridge) return
    const models = this.devices() ?? new Map()
    const selected = new Map([...models].filter(([id, model]) => !this.config.devices.length ||
      this.config.devices.includes(id) || this.config.devices.includes(model.device.name)))
    for (const [id, entry] of this.children) {
      if (!selected.has(id)) {
        this.children.delete(id)
        entry.child.kill('SIGTERM')
      }
    }
    for (const [id, model] of selected) {
      if (this.children.has(id)) continue
      let port = this.ports.get(id)
      if (port === undefined) {
        port = this.config.port + this.ports.size
        if (port > 65535) { this.log.error('No ports available for native controls'); continue }
        this.ports.set(id, port)
      }
      const child = this.spawn(this.python, [receiver, '--address', this.address,
        '--port', String(port), '--model', 'AudioAccessory5,1', '--bridge-url', this.bridgeUrl,
        '--device-id', id, '--name', model.device.name], {
        env: { ...process.env, YOTO_MEDIAREMOTE_TOKEN: this.token, PYTHONUNBUFFERED: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.children.set(id, { child, port })
      for (const stream of [child.stdout, child.stderr]) {
        if (!stream) continue
        const lines = createInterface({ input: stream })
        lines.on('line', line => {
          const message = `[Native Controls ${model.device.name}] ${line.slice(0, 1000)}`
          if (line.includes('ARTWORK ')) this.log.info(message)
          else this.log.debug(message)
        })
      }
      this.log.info(`Starting native iPhone controls for ${model.device.name} on port ${port}`)
      child.on('error', error => this.log.error(`Native controls for ${model.device.name}: ${error.message}`))
      child.once('close', (code, signal) => {
        if (this.children.get(id)?.child !== child) return
        this.children.delete(id)
        if (!this.stopped) {
          this.log.warn(`Native controls for ${model.device.name} exited (${signal ?? code}); retrying in 30 seconds`)
          this.scheduleRetry()
        }
      })
    }
  }

  scheduleRetry () {
    if (this.retry || this.stopped) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.sync()
    }, 30000)
    this.retry.unref()
  }

  async stop () {
    this.stopped = true
    this.controller.abort()
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const children = [...this.children.values()]
    this.children.clear()
    await Promise.all(children.map(({ child }) => new Promise(resolve => {
      const force = setTimeout(() => { child.kill('SIGKILL'); resolve(undefined) }, 5000)
      force.unref()
      child.once('close', () => { clearTimeout(force); resolve(undefined) })
      child.kill('SIGTERM')
    })))
    this.bridge?.closeAllConnections()
    if (this.bridge) await new Promise(resolve => this.bridge?.close(() => resolve(undefined)))
    this.bridge = null
  }
}
