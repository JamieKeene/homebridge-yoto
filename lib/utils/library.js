/**
 * @fileoverview Family card library lookup for TV inputs.
 */

/** @import { YotoClient } from 'yoto-nodejs-client' */

import { parseCardTracks } from './card-tracks.js'
import { YOTO_API_URL } from 'yoto-nodejs-client/lib/api-endpoints/constants.js'
import { defaultAuthHeaders, YotoAPIError } from 'yoto-nodejs-client/lib/api-endpoints/helpers.js'

/**
 * @typedef {Object} LibraryCard
 * @property {string} cardId
 * @property {string} title
 * @property {string} [coverImageUrl]
 * @property {import('./card-tracks.js').CardTrack[]} [tracks]
 */

/** Give up on a library request that takes longer than this */
const LIBRARY_TIMEOUT_MS = 30_000

/**
 * Read `{ cards: [{ cardId, inFamilyLibrary, card: { title } }] }` from
 * GET /card/family/library. Entries without an ID or title, marked as not in
 * the library, or repeating a card already listed are skipped.
 * @param {unknown} body
 * @returns {LibraryCard[]}
 */
export function parseFamilyLibrary (body) {
  const cards = body && typeof body === 'object' && 'cards' in body && Array.isArray(body.cards)
    ? body.cards
    : []

  /** @type {Map<string, LibraryCard>} */
  const byId = new Map()
  for (const entry of cards) {
    if (!entry || typeof entry !== 'object') continue
    const record = /** @type {{ cardId?: unknown, inFamilyLibrary?: unknown, card?: { title?: unknown, content?: unknown, metadata?: { cover?: { imageL?: unknown } } } }} */ (entry)
    if (record.inFamilyLibrary === false) continue
    const cardId = typeof record.cardId === 'string' ? record.cardId.trim() : ''
    const title = typeof record.card?.title === 'string' ? record.card.title.trim() : ''
    if (cardId && title && !byId.has(cardId)) {
      const cover = record.card?.metadata?.cover?.imageL
      const coverImageUrl = typeof cover === 'string' && cover.trim() ? cover.trim() : undefined
      const tracks = parseCardTracks(record.card?.content)
      byId.set(cardId, { cardId, title, ...(coverImageUrl ? { coverImageUrl } : {}), ...(tracks.length ? { tracks } : {}) })
    }
  }
  return [...byId.values()]
}

/**
 * Fetch the family library (needs the `family:library:view` scope). It
 * includes Make Your Own cards. yoto-nodejs-client has no method for this
 * endpoint, so this uses its URL, headers and error type.
 * @param {YotoClient} client
 * @returns {Promise<LibraryCard[]>}
 */
export async function fetchFamilyLibrary (client) {
  const accessToken = await client.token.getAccessToken()
  const response = await fetch(new URL('/card/family/library', YOTO_API_URL), {
    headers: defaultAuthHeaders({ accessToken }),
    signal: AbortSignal.timeout(LIBRARY_TIMEOUT_MS),
  })
  if (!response.ok) {
    const textBody = await response.text()
    let jsonBody = null
    try {
      jsonBody = JSON.parse(textBody)
    } catch {
      jsonBody = null
    }
    // YotoAPIError only reads the status code from the response
    const responseData = /** @type {ConstructorParameters<typeof YotoAPIError>[0]} */ (/** @type {unknown} */ ({ statusCode: response.status }))
    throw new YotoAPIError(responseData, textBody, jsonBody)
  }
  return parseFamilyLibrary(await response.json())
}

/** Fetch playback track keys through the family card-detail endpoint.
 * @param {YotoClient} client
 * @param {string} cardId
 * @returns {Promise<import('./card-tracks.js').CardTrack[]>}
 */
export async function fetchCardTracks (client, cardId) {
  const body = await fetchCardDetails(client, cardId)
  return parseCardTracks(body.card?.content)
}

/** Read family card details.
 * @param {YotoClient} client
 * @param {string} cardId
 * @returns {Promise<{card?: {title?: string, content?: unknown, metadata?: {cover?: {imageL?: string}}}}>}
 */
export async function fetchCardDetails (client, cardId) {
  const accessToken = await client.token.getAccessToken()
  const response = await fetch(new URL(`/card/${encodeURIComponent(cardId)}`, YOTO_API_URL), {
    headers: defaultAuthHeaders({ accessToken }),
    signal: AbortSignal.timeout(LIBRARY_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Card detail returned HTTP ${response.status}`)
  return response.json()
}
