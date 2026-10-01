/** Ordered track keys used for native transport navigation. */
/** @import { Logger } from 'homebridge' */
/** @import { LibraryCard } from './library.js' */
/** @typedef {{ chapterKey: string, trackKey: string }} CardTrack */

/** @param {unknown} content @returns {CardTrack[]} */
export function parseCardTracks (content) {
  if (!content || typeof content !== 'object') return []
  const value = /** @type {{ chapters?: unknown, playbackType?: unknown }} */ (content)
  if (value.playbackType === 'interactive' || !Array.isArray(value.chapters)) return []
  /** @type {CardTrack[]} */ const result = []
  for (const chapter of value.chapters) {
    if (!chapter || typeof chapter !== 'object' || typeof chapter.key !== 'string' || !Array.isArray(chapter.tracks)) continue
    for (const track of chapter.tracks) {
      if (track && typeof track === 'object' && typeof track.key === 'string') result.push({ chapterKey: chapter.key, trackKey: track.key })
    }
  }
  return result
}

/**
 * @param {CardTrack[]} tracks
 * @param {string | null} chapterKey
 * @param {string | null} trackKey
 * @param {number} direction
 * @returns {CardTrack | null}
 */
export function adjacentTrack (tracks, chapterKey, trackKey, direction) {
  const index = tracks.findIndex(track => track.chapterKey === chapterKey && track.trackKey === trackKey)
  if (index < 0) return null
  return tracks[index + direction] ?? null
}

/**
 * @param {(cardId: string) => Promise<CardTrack[]>} content
 * @param {() => Promise<LibraryCard[]>} library
 * @param {Logger} log
 * @returns {(cardId: string) => CardTrack[] | null}
 */
export function createCardTrackLookup (content, library, log) {
  /** @type {Map<string, { tracks: CardTrack[] | null, expires: number }>} */ const cache = new Map()
  return cardId => {
    const cached = cache.get(cardId)
    if (cached && cached.expires > Date.now()) return cached.tracks
    if (cache.size >= 100) {
      const oldest = cache.keys().next().value
      if (oldest) cache.delete(oldest)
    }
    const entry = { tracks: /** @type {CardTrack[] | null} */ (null), expires: Infinity }
    cache.set(cardId, entry)
    const lookup = async () => {
      try { entry.tracks = await content(cardId) } catch {
        log.debug('Native controls card detail lookup failed; trying library metadata')
      }
      if (!entry.tracks?.length) {
        try { entry.tracks = (await library()).find(card => card.cardId === cardId)?.tracks ?? [] } catch { entry.tracks = [] }
      }
      entry.expires = Date.now() + (entry.tracks.length ? 10 * 60 * 1000 : 60 * 1000)
      log.debug(`Native controls loaded ${entry.tracks.length} track keys for a card`)
    }
    lookup().catch(() => { entry.expires = Date.now() + 60 * 1000 })
    return null
  }
}
