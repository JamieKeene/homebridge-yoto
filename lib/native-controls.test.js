import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { NativeControls, getNativeControlsConfig, nativeControlsAddress } from './native-controls.js'
/** @import { Logger } from 'homebridge' */
/** @import { YotoDeviceModel } from 'yoto-nodejs-client' */
/** @import { spawn, ChildProcess } from 'node:child_process' */

const log = /** @type {Logger} */ (/** @type {unknown} */ ({ info () {}, debug () {}, warn () {}, error () {} }))

test('native controls validate config and reject an unassigned bind address', () => {
  assert.throws(() => getNativeControlsConfig({ port: 65536 }), /port/)
  assert.throws(() => getNativeControlsConfig({ devices: [17] }), /player names/)
  assert.throws(() => nativeControlsAddress('192.0.2.254', ['192.0.2.1']), /not assigned/)
  assert.equal(getNativeControlsConfig(undefined).port, 7000)
})

test('managed receivers select players, keep unique ports, retry failures and close on shutdown', async () => {
  const address = '192.0.2.1'
  /** @type {Array<{ args: string[], child: EventEmitter, signals: string[], env: NodeJS.ProcessEnv | undefined }>} */
  const launched = []
  const fakeSpawn = (/** @type {string} */ executable, /** @type {string[]} */ args,
    /** @type {import('node:child_process').SpawnOptions} */ options) => {
    assert.equal(executable, '/fake/python')
    const child = new EventEmitter()
    /** @type {string[]} */ const signals = []
    Object.assign(child, {
      kill (/** @type {string} */ signal) {
        signals.push(signal)
        queueMicrotask(() => child.emit('close', 0, signal))
        return true
      },
      stdout: null,
      stderr: null,
    })
    launched.push({ args, child, signals, env: options.env })
    return /** @type {ChildProcess} */ (/** @type {unknown} */ (child))
  }
  const models = new Map([
    ['one', /** @type {YotoDeviceModel} */ (/** @type {unknown} */ ({ device: { name: 'Bedroom' } }))],
    ['two', /** @type {YotoDeviceModel} */ (/** @type {unknown} */ ({ device: { name: 'Kitchen' } }))],
  ])
  const manager = new NativeControls({ address, devices: ['Bedroom'] }, '/fake/storage', () => models, log,
    { prepare: async () => '/fake/python', address: () => address, spawn: /** @type {typeof spawn} */ (fakeSpawn) })
  try {
    await manager.start()
    assert.equal(launched.length, 1)
    assert.ok(launched[0]?.args.includes('one'))
    assert.ok(!launched[0]?.args.includes(manager.token))
    assert.equal(launched[0]?.env?.['YOTO_MEDIAREMOTE_TOKEN'], manager.token)
    manager.sync()
    assert.equal(launched.length, 1)
    manager.config.devices = []
    manager.sync()
    assert.equal(launched.length, 2)
    assert.equal(manager.children.get('one')?.port, 7000)
    assert.equal(manager.children.get('two')?.port, 7001)
    launched[0]?.child.emit('close', 1, null)
    assert.ok(manager.retry)
    manager.sync()
    assert.equal(manager.children.get('one')?.port, 7000)
    models.delete('two')
    manager.sync()
    assert.deepEqual(launched[1]?.signals, ['SIGTERM'])
  } finally {
    await manager.stop()
  }
  assert.equal(manager.children.size, 0)
  assert.equal(manager.bridge, null)
  assert.equal(manager.retry, null)
  manager.sync()
  assert.equal(launched.length, 3)
})
