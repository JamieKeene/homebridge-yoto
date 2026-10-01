import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCardTracks, adjacentTrack, createCardTrackLookup } from './card-tracks.js'
/** @import { Logger } from 'homebridge' */
const log = /** @type {Logger} */ (/** @type {unknown} */ ({ debug () {} }))

test('navigation follows real keys across chapters and rejects unknown positions and ends', () => {
  const tracks = parseCardTracks({
    chapters: [
      { key: 'chapter-a', tracks: [{ key: 'one' }, { key: 'two' }] },
      { key: 'chapter-b', tracks: [{ key: 'three' }] },
    ]
  })
  assert.deepEqual(adjacentTrack(tracks, 'chapter-a', 'two', 1), { chapterKey: 'chapter-b', trackKey: 'three' })
  assert.deepEqual(adjacentTrack(tracks, 'chapter-b', 'three', -1), { chapterKey: 'chapter-a', trackKey: 'two' })
  assert.equal(adjacentTrack(tracks, 'chapter-a', 'one', -1), null)
  assert.equal(adjacentTrack(tracks, 'chapter-b', 'three', 1), null)
  assert.equal(adjacentTrack(tracks, 'chapter-a', 'missing', 1), null)
  assert.deepEqual(parseCardTracks({ playbackType: 'interactive', chapters: [{ key: 'a', tracks: [{ key: 'b' }] }] }), [])
})

test('track lookup falls back to the library and shares in-flight requests', async () => {
  let calls = 0
  const tracks = [{ chapterKey: 'a', trackKey: 'b' }]
  const lookup = createCardTrackLookup(async () => { calls++; throw new Error('Forbidden') },
    async () => [{ cardId: 'card', title: 'Story', tracks }], log)
  assert.equal(lookup('card'), null)
  assert.equal(lookup('card'), null)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(lookup('card'), tracks)
  assert.equal(calls, 1)
})
