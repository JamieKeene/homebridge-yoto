import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startMediaRemoteBridge } from './mediaremote-bridge.js'
/** @import { YotoDeviceModel } from 'yoto-nodejs-client' */
/** @import { Logger } from 'homebridge' */

const token = 'test-token-with-at-least-32-characters'
const log = /** @type {Logger} */ (/** @type {unknown} */ ({ info () {}, error () {} }))

test('bridge authenticates, exposes live state, forwards commands and rejects offline devices', async () => {
  /** @type {string[]} */
  const calls = []
  let refreshes = 0
  const fake = {
    device: { name: 'Bedroom' },
    status: { isOnline: true, volume: 8, maxVolume: 10 },
    mqttClient: { async setVolume (/** @type {number} */ value) { calls.push(`volume:${value}`) } },
    playback: { cardId: 'card-one', chapterKey: 'a', trackKey: 'one', cardTitle: 'Test story', trackTitle: 'Chapter one', playbackStatus: 'playing' },
    async startCard (/** @type {{ cardId: string, chapterKey: string, trackKey: string }} */ options) { calls.push(`track:${options.chapterKey}:${options.trackKey}`) },
    async requestEvents () { refreshes++ },
    async pauseCard () { calls.push('pause') },
    async resumeCard () { calls.push('play') },
    async stopCard () { calls.push('stop') },
  }
  const models = new Map([['device-one', /** @type {YotoDeviceModel} */ (/** @type {unknown} */ (fake))]])
  // Reserve a free loopback port, then let the real adapter own it.
  const { createServer } = await import('node:net')
  const reservation = createServer()
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', () => resolve(undefined)))
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise(resolve => reservation.close(() => resolve(undefined)))
  const server = await startMediaRemoteBridge({ port: address.port, token }, () => models, log, () => null, () => [{ chapterKey: 'a', trackKey: 'one' }, { chapterKey: 'b', trackKey: 'two' }, { chapterKey: 'b', trackKey: 'three' }, { chapterKey: 'b', trackKey: 'four' }])
  assert.ok(server)
  const base = `http://127.0.0.1:${address.port}`
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  try {
    assert.equal((await fetch(base + '/devices')).status, 401)
    const devices = await (await fetch(base + '/devices', { headers })).json()
    assert.deepEqual(devices, [{ id: 'device-one', name: 'Bedroom', online: true }])
    const state = await (await fetch(base + '/state?deviceId=device-one', { headers })).json()
    assert.equal(state.trackTitle, 'Chapter one')
    assert.equal(refreshes, 1)
    await fetch(base + '/state?deviceId=device-one', { headers })
    assert.equal(refreshes, 1)
    const command = (/** @type {string} */ value) => fetch(base + '/command?deviceId=device-one', {
      method: 'POST', headers, body: JSON.stringify({ command: value }),
    })
    assert.equal((await command('toggle')).status, 200)
    assert.deepEqual(calls, ['pause'])
    assert.equal(state.volume, 0.5)
    assert.equal(state.supportsNext, true)
    assert.equal(state.supportsPrevious, false)
    assert.equal((await command('previous')).status, 422)
    assert.equal((await command('next')).status, 200)
    assert.deepEqual(calls, ['pause', 'track:b:two'])
    assert.equal((await command('next')).status, 200)
    assert.equal((await command('next')).status, 200)
    assert.deepEqual(calls.slice(-3), ['track:b:two', 'track:b:three', 'track:b:four'])
    assert.equal((await command('next')).status, 422)
    assert.equal((await command('previous')).status, 200)
    assert.equal(calls.at(-1), 'track:b:three')
    fake.playback.trackKey = 'three'
    fake.playback.chapterKey = 'b'
    assert.equal((await command('previous')).status, 200)
    assert.equal(calls.at(-1), 'track:b:two')
    fake.playback.cardId = 'another-card'
    fake.playback.chapterKey = 'a'
    fake.playback.trackKey = 'one'
    assert.equal((await command('next')).status, 200)
    assert.equal(calls.at(-1), 'track:b:two')
    const burst = await Promise.all([command('next'), command('next')])
    assert.deepEqual(burst.map(response => response.status), [200, 200])
    assert.deepEqual(calls.slice(-2), ['track:b:three', 'track:b:four'])
    const setVolume = (/** @type {number} */ volume) => fetch(base + '/command?deviceId=device-one', {
      method: 'POST', headers, body: JSON.stringify({ command: 'volume', volume }),
    })
    assert.equal((await setVolume(1 / 16)).status, 200)
    assert.equal(calls.at(-1), 'volume:7')
    assert.equal((await setVolume(1)).status, 200)
    assert.equal(calls.at(-1), 'volume:63')
    assert.equal((await setVolume(2)).status, 400)
    const beforeOffline = calls.length
    fake.status.isOnline = false
    assert.equal((await command('play')).status, 503)
    assert.equal(calls.length, beforeOffline)
    assert.equal((await fetch(base + '/state?deviceId=missing', { headers })).status, 404)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(() => resolve(undefined)))
  }
})

test('bridge is disabled by default and requires a strong token', async () => {
  assert.equal(await startMediaRemoteBridge(undefined, () => undefined, log), null)
  await assert.rejects(startMediaRemoteBridge({ port: 9000, token: 'short' }, () => undefined, log), /32 characters/)
})
