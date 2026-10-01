import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCardArtworkLookup } from './card-artwork.js'
import { parseFamilyLibrary } from './library.js'
/** @import { Logger } from 'homebridge' */
const log = /** @type {Logger} */ (/** @type {unknown} */ ({ info () {} }))

test('cover fallback does not block playback, shares requests and falls back to family library', async () => {
  let calls = 0
  const library = parseFamilyLibrary({
    cards: [{
      cardId: 'card-one',
      card: {
        title: 'Story', metadata: { cover: { imageL: 'https://example.com/cover.png' } },
      }
    }]
  })
  const lookup = createCardArtworkLookup(async () => { calls++; throw new Error('Forbidden') }, async () => library, log)
  assert.equal(lookup('card-one'), null)
  assert.equal(lookup('card-one'), null)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lookup('card-one'), 'https://example.com/cover.png')
  assert.equal(calls, 1)
})

test('content artwork takes priority and missing covers are cached briefly', async () => {
  let libraryCalls = 0
  const lookup = createCardArtworkLookup(async id => id === 'cover' ? 'https://example.com/image.jpg' : null,
    async () => { libraryCalls++; return [] }, log)
  lookup('cover')
  lookup('missing')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(lookup('cover'), 'https://example.com/image.jpg')
  assert.equal(lookup('missing'), null)
  assert.equal(libraryCalls, 1)
})
