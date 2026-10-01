/** Cached cover fallback without delaying playback-state responses. */
/** @import { Logger } from 'homebridge' */
/** @import { LibraryCard } from './library.js' */

/**
 * @param {(cardId: string) => Promise<string | null>} contentCover
 * @param {() => Promise<LibraryCard[]>} library
 * @param {Logger} log
 * @returns {(cardId: string) => string | null}
 */
export function createCardArtworkLookup (contentCover, library, log) {
  /** @type {Map<string, { url: string | null, expires: number }>} */
  const cache = new Map()
  return cardId => {
    const cached = cache.get(cardId)
    if (cached && cached.expires > Date.now()) return cached.url
    if (cache.size >= 100) {
      const oldest = cache.keys().next().value
      if (oldest) cache.delete(oldest)
    }
    const entry = { url: /** @type {string | null} */ (null), expires: Infinity }
    cache.set(cardId, entry)
    const lookup = async () => {
      try { entry.url = await contentCover(cardId) } catch { /* Try the family library too. */ }
      if (!entry.url) {
        try { entry.url = (await library()).find(card => card.cardId === cardId)?.coverImageUrl ?? null } catch { /* Retry later. */ }
      }
      entry.expires = Date.now() + (entry.url ? 10 * 60 * 1000 : 60 * 1000)
      log.info(entry.url ? 'ARTWORK fallback found a card cover' : 'ARTWORK no cover found in card content or family library')
    }
    lookup().catch(() => { entry.expires = Date.now() + 60 * 1000 })
    return null
  }
}
