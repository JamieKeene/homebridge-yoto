import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFamilyLibrary, fetchCardTracks } from './library.js'

test('parseFamilyLibrary reads card IDs and titles and skips incomplete entries', () => {
  const cards = parseFamilyLibrary({
    cards: [
      { cardId: 'abc', card: { title: ' The Gruffalo ' } },
      { cardId: 'def', card: {} },
      { card: { title: 'No ID' } },
      null,
      { cardId: 'ghi', inFamilyLibrary: true, card: { title: 'Peter Rabbit' } },
      { cardId: 'jkl', inFamilyLibrary: false, card: { title: 'Removed' } },
      { cardId: 'abc', card: { title: 'Repeated' } },
    ],
  })
  assert.deepStrictEqual(cards, [
    { cardId: 'abc', title: 'The Gruffalo' },
    { cardId: 'ghi', title: 'Peter Rabbit' },
  ])
  assert.deepStrictEqual(parseFamilyLibrary({}), [])
  assert.deepStrictEqual(parseFamilyLibrary(null), [])
})

/** @import { YotoClient } from 'yoto-nodejs-client' */
test('card detail uses the card endpoint and returns playback keys', async () => {
  const original = globalThis.fetch
  const client = /** @type {YotoClient} */ (/** @type {unknown} */ ({ token: { async getAccessToken () { return 'test-token' } } }))
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(String(url)).pathname, '/card/card123')
    assert.equal(new Headers(options?.headers).get('authorization'), 'Bearer test-token')
    return new Response(JSON.stringify({ card: { content: { chapters: [{ key: 'chapter', tracks: [{ key: 'track' }] }] } } }))
  }
  try {
    assert.deepEqual(await fetchCardTracks(client, 'card123'), [{ chapterKey: 'chapter', trackKey: 'track' }])
    globalThis.fetch = async () => new Response('', { status: 403 })
    await assert.rejects(fetchCardTracks(client, 'card123'), /HTTP 403/)
  } finally { globalThis.fetch = original }
})
