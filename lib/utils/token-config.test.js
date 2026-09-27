import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyTokenUpdate, findNewerSavedTokens } from './token-config.js'

const baseUpdate = {
  platform: 'Yoto',
  accessToken: 'new-access',
  refreshToken: 'new-refresh',
  tokenExpiresAt: 1700000000000,
}

test('updates tokens in the matching platform block', () => {
  const config = JSON.stringify({
    bridge: { name: 'Homebridge' },
    platforms: [
      { platform: 'Other', accessToken: 'old-access' },
      { platform: 'Yoto', accessToken: 'old-access', refreshToken: 'old-refresh', services: { battery: true } },
    ],
  })

  const result = applyTokenUpdate(config, { ...baseUpdate, prevAccessToken: 'old-access', prevRefreshToken: 'old-refresh' })
  assert.ok(result)
  const parsed = JSON.parse(result)
  assert.equal(parsed.platforms[0].accessToken, 'old-access', 'other platforms untouched')
  assert.deepEqual(parsed.platforms[1], {
    platform: 'Yoto',
    accessToken: 'new-access',
    refreshToken: 'new-refresh',
    tokenExpiresAt: 1700000000000,
    services: { battery: true },
  })
})

test('falls back to the single Yoto block when no previous tokens are given', () => {
  const config = JSON.stringify({ platforms: [{ platform: 'Yoto', accessToken: 'old-access' }] })
  const result = applyTokenUpdate(config, baseUpdate)
  assert.ok(result)
  assert.equal(JSON.parse(result).platforms[0].accessToken, 'new-access')
})

test('leaves tokens alone when they were replaced by a new sign-in', () => {
  const config = JSON.stringify({ platforms: [{ platform: 'Yoto', accessToken: 'edited-by-ui', refreshToken: 'ui-refresh' }] })
  const result = applyTokenUpdate(config, { ...baseUpdate, prevAccessToken: 'stale', prevRefreshToken: 'stale-refresh' })
  assert.equal(result, null)
})

test('does not restore tokens after a logout', () => {
  const config = JSON.stringify({ platforms: [{ platform: 'Yoto', services: { battery: true } }] })
  const result = applyTokenUpdate(config, { ...baseUpdate, prevAccessToken: 'old-access', prevRefreshToken: 'old-refresh' })
  assert.equal(result, null)
})

test('picks the block holding the previous refresh token when several exist', () => {
  const config = JSON.stringify({
    platforms: [
      { platform: 'Yoto', refreshToken: 'a' },
      { platform: 'Yoto', refreshToken: 'b' },
    ],
  })
  const result = applyTokenUpdate(config, { ...baseUpdate, prevRefreshToken: 'b' })
  assert.ok(result)
  const parsed = JSON.parse(result)
  assert.equal(parsed.platforms[0].refreshToken, 'a')
  assert.equal(parsed.platforms[1].refreshToken, 'new-refresh')
})

test('returns null when no block can be identified', () => {
  assert.equal(applyTokenUpdate('not json', baseUpdate), null)
  assert.equal(applyTokenUpdate(JSON.stringify({}), baseUpdate), null)
  assert.equal(applyTokenUpdate(JSON.stringify({ platforms: [{ platform: 'Other' }] }), baseUpdate), null)
  const ambiguous = JSON.stringify({ platforms: [{ platform: 'Yoto' }, { platform: 'Yoto' }] })
  assert.equal(applyTokenUpdate(ambiguous, baseUpdate), null)
})

test('writes 4-space indented JSON', () => {
  const result = applyTokenUpdate(JSON.stringify({ platforms: [{ platform: 'Yoto' }] }), baseUpdate)
  assert.ok(result?.includes('\n    "platforms"'))
})

test('findNewerSavedTokens returns tokens saved after the ones passed in', () => {
  const contents = JSON.stringify({
    platforms: [
      { platform: 'Yoto', accessToken: 'a2', refreshToken: 'r2', tokenExpiresAt: 2000, _bridge: { username: 'AA' } },
    ],
  })
  assert.deepEqual(
    findNewerSavedTokens(contents, { platform: 'Yoto', bridgeUsername: 'AA', refreshToken: 'r1', tokenExpiresAt: 1000 }),
    { accessToken: 'a2', refreshToken: 'r2', tokenExpiresAt: 2000 }
  )
  // Without a child bridge username, a single block is used
  assert.ok(findNewerSavedTokens(contents, { platform: 'Yoto', refreshToken: 'r1', tokenExpiresAt: 1000 }))
})

test('findNewerSavedTokens keeps the passed-in tokens when disk is not newer', () => {
  const block = { platform: 'Yoto', accessToken: 'a2', refreshToken: 'r2', tokenExpiresAt: 2000 }
  const contents = JSON.stringify({ platforms: [block] })
  const options = { platform: 'Yoto', refreshToken: 'r1', tokenExpiresAt: 3000 }
  assert.equal(findNewerSavedTokens(contents, options), null, 'older on disk')
  assert.equal(findNewerSavedTokens(contents, { ...options, refreshToken: 'r2', tokenExpiresAt: 1000 }), null, 'same refresh token')
  assert.equal(findNewerSavedTokens(JSON.stringify({ platforms: [{ platform: 'Yoto' }] }), options), null, 'logged out')
  assert.equal(findNewerSavedTokens('not json', options), null)
  assert.equal(findNewerSavedTokens(JSON.stringify({ platforms: [block, block] }), options), null, 'ambiguous blocks')
})

test('replaces a saved client ID that differs from the tokens\' one', () => {
  const config = JSON.stringify({ platforms: [{ platform: 'Yoto', clientId: 'legacy-id', refreshToken: 'old-refresh' }] })
  const result = applyTokenUpdate(config, { ...baseUpdate, prevRefreshToken: 'old-refresh', clientId: 'token-client' })
  assert.ok(result)
  assert.equal(JSON.parse(result).platforms[0].clientId, 'token-client')
})

test('does not add a client ID when none is saved', () => {
  const config = JSON.stringify({ platforms: [{ platform: 'Yoto', refreshToken: 'old-refresh' }] })
  const result = applyTokenUpdate(config, { ...baseUpdate, prevRefreshToken: 'old-refresh', clientId: 'token-client' })
  assert.ok(result)
  assert.equal('clientId' in JSON.parse(result).platforms[0], false)
})
