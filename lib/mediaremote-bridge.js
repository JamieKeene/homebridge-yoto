/** Experimental HTTP adapter for the separate AirPlay receiver. */
import { adjacentTrack } from './utils/card-tracks.js'
import { setDeviceVolume } from './utils/set-device-volume.js'
import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
/** @import { Server } from 'node:http' */
/** @import { YotoDeviceModel } from 'yoto-nodejs-client' */
/** @import { Logger } from 'homebridge' */

/**
 * @param {unknown} value
 * @param {() => Map<string, YotoDeviceModel> | undefined} devices
 * @param {Logger} log
 * @param {(cardId: string) => string | null} [artwork]
 * @param {(cardId: string) => import('./utils/card-tracks.js').CardTrack[] | null} [tracks]
 * @returns {Promise<Server | null>}
 */
export async function startMediaRemoteBridge (value, devices, log, artwork = () => null, tracks = () => null) {
  if (value === undefined) return null
  if (!value || typeof value !== 'object') throw new Error('mediaRemoteBridge must be an object')
  const config = /** @type {{ host?: unknown, port?: unknown, token?: unknown }} */ (value)
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('mediaRemoteBridge.token must contain at least 32 characters')
  if (typeof config.port !== 'number' || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('mediaRemoteBridge.port must be a TCP port')
  if (config.host !== undefined && typeof config.host !== 'string') throw new Error('mediaRemoteBridge.host must be a string')
  const port = config.port
  const host = config.host ?? '127.0.0.1'
  const expected = Buffer.from(`Bearer ${config.token}`)
  /** @type {WeakMap<YotoDeviceModel, number>} */
  const eventRefreshAt = new WeakMap()
  /** @type {WeakMap<YotoDeviceModel, {cardId: string, chapterKey: string, trackKey: string, expires: number}>} */
  const pendingTracks = new WeakMap()
  /** @type {WeakMap<YotoDeviceModel, Promise<void>>} */
  const navigationQueue = new WeakMap()
  const server = createServer((request, response) => {
    const send = (/** @type {number} */ status, /** @type {unknown} */ body) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    const run = async () => {
      const received = Buffer.from(request.headers.authorization ?? '')
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) return send(401, { error: 'Unauthorized' })
      const url = new URL(request.url ?? '/', 'http://bridge.local')
      const models = devices()
      if (!models) return send(503, { error: 'Yoto account unavailable' })
      if (request.method === 'GET' && url.pathname === '/devices') {
        return send(200, [...models].map(([id, model]) => ({ id, name: model.device.name, online: model.status.isOnline })))
      }
      const model = models.get(url.searchParams.get('deviceId') ?? '')
      if (!model) return send(404, { error: 'Unknown device' })
      if (request.method === 'GET' && url.pathname === '/state') {
        // Events may stop or arrive partially after a physical card swap. Recover
        // from the player itself without blocking the receiver's state response.
        const now = Date.now()
        if (model.status.isOnline && model.mqttClient && typeof model.requestEvents === 'function' && now >= (eventRefreshAt.get(model) ?? 0)) {
          eventRefreshAt.set(model, now + 10000)
          Promise.resolve().then(() => model.requestEvents()).catch(() => {
            log.error('Native controls playback refresh failed; retrying on the next interval')
          })
        }
        const playback = model.playback
        const navigation = playback.cardId ? tracks(playback.cardId) ?? [] : []
        const next = adjacentTrack(navigation, playback.chapterKey, playback.trackKey, 1)
        const previous = adjacentTrack(navigation, playback.chapterKey, playback.trackKey, -1)
        const cover = playback.cardCoverImageUrl || (playback.cardId ? artwork(playback.cardId) : null)
        return send(200, {
          name: model.device.name,
          online: model.status.isOnline,
          ...playback,
          cardCoverImageUrl: cover,
          volume: model.status.volume / 16,
          supportsNext: !!next,
          supportsPrevious: !!previous
        })
      }
      if (request.method !== 'POST' || url.pathname !== '/command') return send(404, { error: 'Unknown route' })
      if (!model.status.isOnline || !model.mqttClient) return send(503, { error: 'Yoto offline' })
      let body = ''
      for await (const chunk of request) {
        body += chunk.toString()
        if (body.length > 1024) return send(413, { error: 'Request too large' })
      }
      let parsed
      try { parsed = JSON.parse(body) } catch { return send(400, { error: 'Invalid JSON' }) }
      if (!parsed || typeof parsed !== 'object') return send(400, { error: 'Invalid command' })
      const input = /** @type {{ command?: unknown, volume?: unknown }} */ (parsed)
      const command = input.command
      switch (command) {
        case 'volume': {
          const volume = input.volume
          if (typeof volume !== 'number' || !Number.isFinite(volume) || volume < 0 || volume > 1) return send(400, { error: 'Volume must be between 0 and 1' })
          const max = Number.isFinite(model.status.maxVolume) ? Math.max(0, Math.min(16, model.status.maxVolume)) : 16
          await setDeviceVolume(model, Math.min(max, Math.round(volume * 16)))
          break
        }
        case 'next':
        case 'previous': {
          const navigate = async () => {
            const playback = model.playback
            if (!playback.cardId) {
              pendingTracks.delete(model)
              return send(422, { error: 'No active card' })
            }
            let pending = pendingTracks.get(model)
            if (pending && (pending.cardId !== playback.cardId || pending.expires <= Date.now() ||
                (pending.chapterKey === playback.chapterKey && pending.trackKey === playback.trackKey))) {
              pendingTracks.delete(model)
              pending = undefined
            }
            const navigation = tracks(playback.cardId) ?? []
            const target = adjacentTrack(navigation, pending?.chapterKey ?? playback.chapterKey,
              pending?.trackKey ?? playback.trackKey, command === 'next' ? 1 : -1)
            if (!target) return send(422, { error: 'No adjacent track' })
            pendingTracks.set(model, { cardId: playback.cardId, ...target, expires: Date.now() + 10000 })
            try { await model.startCard({ cardId: playback.cardId, ...target }) } catch (error) {
              pendingTracks.delete(model)
              throw error
            }
          }
          const queued = (navigationQueue.get(model) ?? Promise.resolve()).catch(() => {}).then(navigate)
          navigationQueue.set(model, queued)
          await queued
          if (response.headersSent) return
          break
        }
        case 'play': await model.resumeCard(); break
        case 'pause': await model.pauseCard(); break
        case 'stop': await model.stopCard(); break
        case 'toggle':
          if (model.playback.playbackStatus === 'playing') await model.pauseCard()
          else await model.resumeCard()
          break
        default: return send(422, { error: 'Unsupported command' })
      }
      send(200, { accepted: true })
    }
    run().catch(error => {
      log.error('MediaRemote bridge request failed:', error instanceof Error ? error.message : 'Unknown error')
      if (!response.headersSent) send(502, { error: 'Yoto command failed' })
      else response.destroy()
    })
  })
  server.requestTimeout = 10000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve(undefined))
  })
  server.on('error', error => log.error('MediaRemote bridge server error:', error.message))
  log.info(`Experimental MediaRemote bridge listening on ${config.host ?? '127.0.0.1'}:${config.port}`)
  return server
}
