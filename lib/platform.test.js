/**
 * Tests for platform startup: staying idle until configured, surviving bad
 * saved logins, retrying when Yoto can't be reached, and handling a login
 * that stops working.
 */

/** @import { API, Logger, PlatformConfig } from 'homebridge' */
/** @import { YotoAccount } from 'yoto-nodejs-client' */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as hap from '@homebridge/hap-nodejs'
import { YotoPlatform } from './platform.js'
import { ListenerGroup, logListenerError } from './utils/listener-group.js'
import { loginStatusPath, readLoginProblem, writeLoginProblem } from './utils/login-status.js'

/** @type {string[]} */
let logs = []

const noop = () => {}

function makeLog () {
  logs = []
  const log = {
    debug: noop,
    info: (/** @type {unknown[]} */ ...args) => { logs.push(`info: ${args.join(' ')}`) },
    success: noop,
    warn: (/** @type {unknown[]} */ ...args) => { logs.push(`warn: ${args.join(' ')}`) },
    error: (/** @type {unknown[]} */ ...args) => { logs.push(`error: ${args.join(' ')}`) },
    log: noop,
  }
  return /** @type {Logger} */ (/** @type {unknown} */ (log))
}

function makeApi () {
  /** @type {string[]} */
  const events = []
  /** @type {Map<string, () => unknown>} */
  const handlers = new Map()
  const storagePath = mkdtempSync(join(tmpdir(), 'yoto-storage-'))
  const api = {
    hap,
    events,
    on: (/** @type {string} */ event, /** @type {() => unknown} */ handler) => {
      events.push(event)
      handlers.set(event, handler)
    },
    user: { configPath: () => '/nonexistent/config.json', storagePath: () => storagePath },
    registerPlatformAccessories: noop,
    updatePlatformAccessories: noop,
    unregisterPlatformAccessories: noop,
    publishExternalAccessories: noop,
  }
  /** Run what the platform registered for an API event */
  const fire = async (/** @type {string} */ event) => { await handlers.get(event)?.() }
  return { api: /** @type {API} */ (/** @type {unknown} */ (api)), events, fire, storagePath }
}

/**
 * A cached accessory, as Homebridge restores it before didFinishLaunching
 * @param {string} name
 */
function makeCachedAccessory (name) {
  const hapAccessory = new hap.Accessory(name, hap.uuid.generate(name))
  const service = hapAccessory.addService(hap.Service.Switch, 'Playback', 'playback')
  const accessory = {
    UUID: hapAccessory.UUID,
    displayName: name,
    context: {},
    get services () { return hapAccessory.services },
  }
  return { accessory: /** @type {import('homebridge').PlatformAccessory} */ (/** @type {unknown} */ (accessory)), on: service.getCharacteristic(hap.Characteristic.On) }
}

/**
 * The HAP status a read fails with, or undefined if it succeeds
 * @param {hap.Characteristic} characteristic
 */
async function readStatus (characteristic) {
  try {
    await characteristic.handleGetRequest()
  } catch (status) {
    return status
  }
  return undefined
}

/**
 * An unsigned JWT with an exp claim, enough for the client to accept it.
 * @param {Record<string, unknown>} [claims]
 * @returns {string}
 */
function makeAccessToken (claims = {}) {
  /** @param {object} value */
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none' })}.${encode({ exp: Math.floor(Date.now() / 1000) + 3600, ...claims })}.sig`
}

/**
 * @param {Record<string, unknown>} [extra]
 * @returns {PlatformConfig}
 */
function makeConfig (extra = {}) {
  return { platform: 'Yoto', accessToken: makeAccessToken(), refreshToken: 'refresh', ...extra }
}

/**
 * Stand-in for YotoAccount whose start() fails a set number of times.
 */
class FakeAccount extends EventEmitter {
  /** @type {Map<string, unknown>} */ devices = new Map()
  startCalls = 0
  stopCalls = 0
  running = false
  /** @type {() => Error} */ makeError = () => new Error('getaddrinfo ENOTFOUND api.yotoplay.com')
  /** @type {Promise<void> | null} */ startGate = null

  /** @param {number} failures */
  constructor (failures) {
    super()
    this.failures = failures
  }

  async start () {
    this.startCalls++
    if (this.startGate) await this.startGate
    if (this.failures > 0) {
      this.failures--
      throw this.makeError()
    }
    this.running = true
  }

  async stop () {
    this.stopCalls++
    // Like YotoAccount, stopping before start() finishes does nothing
    this.running = false
  }

  /** @returns {undefined} */
  getDevice () { return undefined }

  /** @returns {string[]} */
  getDeviceIds () { return [] }
}

/**
 * @param {YotoPlatform} platform
 * @param {FakeAccount} fake
 */
function useFakeAccount (platform, fake) {
  const account = /** @type {YotoAccount} */ (/** @type {unknown} */ (fake))
  platform.yotoAccount = account
  platform.accountListeners = new ListenerGroup(account, logListenerError(platform.log, '[Platform]'))
}

const flush = () => new Promise(resolve => setImmediate(resolve))

/**
 * Wait for background file work (the login status file is written without awaiting)
 * @template T
 * @param {() => Promise<T>} check - Resolves to a truthy value when done
 * @returns {Promise<T>}
 */
async function eventually (check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await check()
    if (result) return result
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return check()
}

/**
 * An error shaped like the client's YotoAPIError.
 * @param {number} statusCode
 * @returns {Error}
 */
function makeApiError (statusCode) {
  return Object.assign(new Error('Unexpected response status code'), {
    statusCode,
    jsonBody: { error: 'insufficient_scope' },
  })
}

test('does not start until the plugin is signed in', () => {
  const { api, events } = makeApi()
  const platform = new YotoPlatform(makeLog(), { platform: 'Yoto' }, api)

  assert.equal(platform.yotoAccount, null)
  assert.deepEqual(events, ['didFinishLaunching'], 'only the launch handler that marks cached accessories')
  assert.ok(logs.some(line => line.startsWith('warn:') && line.includes('Homebridge UI')))
})

test('cached accessories show as Not Responding while signed out', async () => {
  const { api, fire } = makeApi()
  const platform = new YotoPlatform(makeLog(), { platform: 'Yoto' }, api)
  const { accessory, on } = makeCachedAccessory('Shep\'s Yoto')
  platform.configureAccessory(accessory)

  assert.equal(await readStatus(on), undefined, 'untouched until Homebridge finishes launching')
  await fire('didFinishLaunching')

  assert.equal(await readStatus(on), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  assert.ok(logs.some(line => line.startsWith('warn:') && line.includes('Not Responding')))
})

test('a malformed saved access token is logged instead of crashing Homebridge', () => {
  const { api, events } = makeApi()
  /** @type {YotoPlatform | undefined} */
  let platform
  assert.doesNotThrow(() => {
    platform = new YotoPlatform(makeLog(), makeConfig({ accessToken: 'not-a-jwt' }), api)
  })

  assert.equal(platform?.yotoAccount, null)
  assert.deepEqual(events, ['didFinishLaunching'])
  assert.ok(logs.some(line => line.startsWith('error:') && line.includes('sign in again')))
})

test('a malformed saved login is recorded for the settings UI and cached accessories go Not Responding', async () => {
  const { api, fire, storagePath } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig({ accessToken: 'not-a-jwt', refreshToken: 'bad-login' }), api)
  const { accessory, on } = makeCachedAccessory('Jude\'s Yoto')
  platform.configureAccessory(accessory)
  await fire('didFinishLaunching')
  await flush()

  assert.equal(await readStatus(on), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  const problem = await eventually(() => readLoginProblem(storagePath, 'bad-login'))
  assert.match(problem?.message ?? '', /could not be read/)
})

test('refreshes with the client ID the saved login was issued to, not a stale configured one', () => {
  const { api } = makeApi()
  const log = makeLog()
  /** @type {string[]} */
  const infos = []
  log.info = (/** @type {unknown[]} */ ...args) => { infos.push(args.join(' ')) }
  const platform = new YotoPlatform(log, makeConfig({
    clientId: 'Y4HJ8BFqRQ24GQoLzgOzZ2KSqWmFG8LI',
    accessToken: makeAccessToken({ azp: 'tpc_ot5BY24FLyZoCX9MnykipB' }),
  }), api)

  assert.ok(platform.yotoAccount)
  assert.ok(infos.some(line => line.includes('(tpc_ot5BY24FLyZoCX9MnykipB) instead of the one in the settings (Y4HJ8BFqRQ24GQoLzgOzZ2KSqWmFG8LI)')))
})

test('uses newer tokens from config.json when Homebridge passes a stale copy', () => {
  const { api } = makeApi()
  const dir = mkdtempSync(join(tmpdir(), 'yoto-config-'))
  const configPath = join(dir, 'config.json')
  const newer = { accessToken: makeAccessToken(), refreshToken: 'rotated', tokenExpiresAt: Date.now() + 86400000 }
  writeFileSync(configPath, JSON.stringify({
    platforms: [{ platform: 'Yoto', _bridge: { username: 'AA:BB' }, ...newer }],
  }))
  api.user.configPath = () => configPath

  const config = makeConfig({ refreshToken: 'already-used', tokenExpiresAt: Date.now() - 1000, _bridge: { username: 'AA:BB' } })
  const platform = new YotoPlatform(makeLog(), config, api)

  assert.ok(platform.yotoAccount)
  assert.equal(config['refreshToken'], 'rotated')
  assert.equal(config['accessToken'], newer.accessToken)
})

test('retries starting the account with backoff when Yoto is unreachable', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(2)
  useFakeAccount(platform, fake)

  await platform.startAccount()
  assert.equal(fake.startCalls, 1)
  assert.ok(logs.some(line => line.includes('Retrying in 30 seconds')))

  t.mock.timers.tick(30 * 1000)
  await flush()
  assert.equal(fake.startCalls, 2)
  assert.ok(logs.some(line => line.includes('Retrying in 60 seconds')), 'the delay doubles')

  t.mock.timers.tick(60 * 1000)
  await flush()
  assert.equal(fake.startCalls, 3)
  assert.equal(platform.startRetryTimer, null, 'no retry is pending once started')
  assert.equal(platform.startRetryCount, 0)
})

test('does not retry once the login is known to be invalid', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(1)
  useFakeAccount(platform, fake)
  platform.authInvalid = true

  await platform.startAccount()

  assert.equal(platform.startRetryTimer, null)
  assert.ok(logs.some(line => line.startsWith('error:') && line.includes('Failed to start account')))
})

test('shutdown cancels a pending startup retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(5)
  useFakeAccount(platform, fake)

  await platform.startAccount()
  assert.notEqual(platform.startRetryTimer, null)

  await platform.shutdown()
  t.mock.timers.tick(10 * 60 * 1000)
  await flush()

  assert.equal(platform.startRetryTimer, null)
  assert.equal(fake.startCalls, 1)
})

test('errors while registering a discovered device are logged, not thrown', async () => {
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(0)
  const model = { device: { deviceId: 'dev-1', name: 'Kitchen Yoto' } }
  fake.getDevice = () => /** @type {undefined} */ (/** @type {unknown} */ (model))
  platform.registerDevice = async () => { throw new Error('model exploded') }
  useFakeAccount(platform, fake)

  await platform.startAccount()
  fake.emit('deviceAdded', { deviceId: 'dev-1' })
  await flush()

  assert.ok(logs.some(line => line.startsWith('error:') && line.includes('model exploded')))
})

test('a rejected login is reported once instead of retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(5)
  fake.makeError = () => makeApiError(403)
  useFakeAccount(platform, fake)

  await platform.startAccount()
  t.mock.timers.tick(10 * 60 * 1000)
  await flush()

  assert.equal(fake.startCalls, 1)
  assert.equal(platform.startRetryTimer, null)
  const line = logs.find(entry => entry.startsWith('error:') && entry.includes('HTTP 403'))
  assert.ok(line?.includes('sign in again'))
  assert.ok(line?.includes('insufficient_scope'), 'the response body is logged')
})

test('a login Yoto rejects is recorded for the settings UI and its accessories go Not Responding', async () => {
  const { api, storagePath } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig({ refreshToken: 'revoked' }), api)
  const { accessory, on } = makeCachedAccessory('Shep\'s Yoto')
  platform.configureAccessory(accessory)
  const fake = new FakeAccount(1)
  fake.makeError = () => makeApiError(401)
  useFakeAccount(platform, fake)

  await platform.startAccount()
  await flush()

  assert.equal(platform.authInvalid, true)
  assert.equal(await readStatus(on), hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE)
  assert.match((await eventually(() => readLoginProblem(storagePath, 'revoked')))?.message ?? '', /HTTP 401/)
})

test('a login problem is cleared once the account starts', async () => {
  const { api, storagePath } = makeApi()
  await writeLoginProblem(storagePath, { message: 'expired', refreshToken: 'refresh' })
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  useFakeAccount(platform, new FakeAccount(0))

  await platform.startAccount()
  await flush()

  assert.equal(await eventually(async () => !existsSync(loginStatusPath(storagePath))), true)
})

test('refreshed tokens are saved to config.json and logged', async () => {
  const { api } = makeApi()
  const dir = mkdtempSync(join(tmpdir(), 'yoto-config-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({
    platforms: [{ platform: 'Yoto', clientId: 'Y4HJ8BFqRQ24GQoLzgOzZ2KSqWmFG8LI', accessToken: 'old-access', refreshToken: 'old-refresh' }],
  }))
  api.user.configPath = () => configPath
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const newAccess = makeAccessToken()

  await platform.saveRefreshedTokens({
    clientId: 'tpc_ot5BY24FLyZoCX9MnykipB',
    updatedAccessToken: newAccess,
    updatedRefreshToken: 'new-refresh',
    updatedExpiresAt: 1790000000,
    prevAccessToken: 'old-access',
    prevRefreshToken: 'old-refresh',
    prevExpiresAt: 1780000000,
  }, 'tpc_ot5BY24FLyZoCX9MnykipB')

  const saved = JSON.parse(readFileSync(configPath, 'utf8')).platforms[0]
  assert.equal(saved.refreshToken, 'new-refresh')
  assert.equal(saved.accessToken, newAccess)
  assert.equal(saved.tokenExpiresAt, 1790000000000)
  assert.equal(saved.clientId, 'tpc_ot5BY24FLyZoCX9MnykipB', 'the stale client ID is replaced')
  assert.equal(platform.config['refreshToken'], 'new-refresh')
  assert.ok(logs.some(line => line.startsWith('info:') && line.includes('saved it to config.json')))
})

test('a refresh that can\'t be saved is not logged as saved', async () => {
  const { api } = makeApi()
  const dir = mkdtempSync(join(tmpdir(), 'yoto-config-'))
  const configPath = join(dir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ platforms: [{ platform: 'Yoto', refreshToken: 'someone-else' }] }))
  api.user.configPath = () => configPath
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)

  await platform.saveRefreshedTokens({
    clientId: 'tpc_ot5BY24FLyZoCX9MnykipB',
    updatedAccessToken: makeAccessToken(),
    updatedRefreshToken: 'new-refresh',
    updatedExpiresAt: 1790000000,
    prevAccessToken: 'old-access',
    prevRefreshToken: 'old-refresh',
    prevExpiresAt: 1780000000,
  }, 'tpc_ot5BY24FLyZoCX9MnykipB')

  assert.ok(logs.some(line => line.startsWith('warn:') && line.includes('Did not save refreshed tokens')))
  assert.ok(!logs.some(line => line.includes('saved it to config.json')))
})

test('other 4xx responses are not retried', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(5)
  fake.makeError = () => makeApiError(404)
  useFakeAccount(platform, fake)

  await platform.startAccount()

  assert.equal(platform.startRetryTimer, null)
  assert.ok(logs.some(line => line.startsWith('error:') && line.includes('Failed to start account')))
})

test('5xx and 429 responses are retried, with the status in the log', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(2)
  const statuses = [503, 429]
  fake.makeError = () => makeApiError(statuses.shift() ?? 500)
  useFakeAccount(platform, fake)

  await platform.startAccount()
  assert.ok(logs.some(line => line.startsWith('warn:') && line.includes('HTTP 503')))

  t.mock.timers.tick(30 * 1000)
  await flush()
  assert.ok(logs.some(line => line.startsWith('warn:') && line.includes('HTTP 429')))

  t.mock.timers.tick(60 * 1000)
  await flush()
  assert.equal(fake.startCalls, 3)
  assert.ok(fake.running)
})

test('an account start that finishes after shutdown is stopped again', async () => {
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(0)
  /** @type {() => void} */
  let release = noop
  fake.startGate = new Promise(resolve => { release = resolve })
  useFakeAccount(platform, fake)

  const starting = platform.startAccount()
  await flush()
  await platform.shutdown()
  assert.equal(fake.stopCalls, 1)

  release()
  await starting

  assert.equal(fake.running, false, 'what start() opened is stopped')
  assert.equal(fake.stopCalls, 2)
})

test('an account start that fails after shutdown does not schedule a retry', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(1)
  /** @type {() => void} */
  let release = noop
  fake.startGate = new Promise(resolve => { release = resolve })
  useFakeAccount(platform, fake)

  const starting = platform.startAccount()
  await flush()
  await platform.shutdown()
  release()
  await starting

  assert.equal(platform.startRetryTimer, null)
})

test('a throwing account-level listener is logged instead of escaping', async () => {
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const fake = new FakeAccount(0)
  useFakeAccount(platform, fake)
  platform.removeStaleAccessories = () => { throw new Error('unregister exploded') }

  await platform.startAccount()
  logs = []
  assert.doesNotThrow(() => fake.emit('deviceRemoved', { deviceId: 'dev-1' }))

  assert.ok(logs.some(line => line.startsWith('error:') && line.includes('deviceRemoved') && line.includes('unregister exploded')))
})

test('a failed library fetch rejects and is not cached; a good one is', async (t) => {
  const { api } = makeApi()
  const platform = new YotoPlatform(makeLog(), makeConfig(), api)
  const responses = [
    new Response('{"error":"unavailable"}', { status: 503 }),
    Response.json({ cards: [{ cardId: 'abc', card: { title: 'The Gruffalo' } }] }),
  ]
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => responses.shift())

  await assert.rejects(platform.getLibraryCards(), { statusCode: 503 })
  await flush()
  assert.ok(logs.some(line => line.startsWith('warn:') && line.includes('HTTP 503')))

  assert.deepEqual(await platform.getLibraryCards(), [{ cardId: 'abc', title: 'The Gruffalo' }])
  assert.deepEqual(await platform.getLibraryCards(), [{ cardId: 'abc', title: 'The Gruffalo' }])
  assert.equal(fetchMock.mock.callCount(), 2)
})
