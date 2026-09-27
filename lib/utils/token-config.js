/**
 * @typedef {Object} TokenConfigUpdate
 * @property {string} platform - Platform name to match (e.g. 'Yoto')
 * @property {string} accessToken - New access token
 * @property {string} refreshToken - New refresh token (may be rotated)
 * @property {number} tokenExpiresAt - Expiry as a unix timestamp in milliseconds
 * @property {string} [prevAccessToken] - Previous access token, used to pick the right block
 * @property {string} [prevRefreshToken] - Previous refresh token, used to pick the right block
 * @property {string} [clientId] - Client ID the tokens were issued to. Replaces a different saved one.
 */

/**
 * Apply refreshed tokens to the contents of a Homebridge config.json.
 *
 * Returns the updated file contents, or null when no matching platform block exists
 * or the file cannot be parsed. When previous tokens are given, only the block that
 * still holds them is updated: if none does, the tokens were changed elsewhere (a new
 * sign-in or a logout in the UI) and must not be overwritten.
 *
 * @param {string} configContents - Raw config.json contents
 * @param {TokenConfigUpdate} update
 * @returns {string | null}
 */
export function applyTokenUpdate (configContents, update) {
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(configContents)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== 'object') return null
  const platforms = /** @type {Record<string, unknown>} */ (parsed)['platforms']
  if (!Array.isArray(platforms)) return null

  /** @type {Record<string, unknown>[]} */
  const candidates = platforms.filter(
    entry => entry && typeof entry === 'object' && entry.platform === update.platform
  )
  if (candidates.length === 0) return null

  // Update the block holding the tokens being replaced. Only fall back to the single
  // block when there are no previous tokens to match against.
  const hasPrevTokens = Boolean(update.prevRefreshToken || update.prevAccessToken)
  const block = hasPrevTokens
    ? candidates.find(entry =>
      (update.prevRefreshToken && entry['refreshToken'] === update.prevRefreshToken) ||
      (update.prevAccessToken && entry['accessToken'] === update.prevAccessToken)
    )
    : (candidates.length === 1 ? candidates[0] : undefined)
  if (!block) return null

  block['accessToken'] = update.accessToken
  block['refreshToken'] = update.refreshToken
  block['tokenExpiresAt'] = update.tokenExpiresAt
  // The settings form can save a stale client ID back; keep it matching the tokens.
  // A missing one means the default, and is left out.
  if (update.clientId && block['clientId'] !== undefined && block['clientId'] !== update.clientId) {
    block['clientId'] = update.clientId
  }

  // Homebridge writes config.json with 4-space indentation
  return JSON.stringify(parsed, null, 4)
}

/**
 * @typedef {Object} SavedTokens
 * @property {string} accessToken
 * @property {string} refreshToken
 * @property {number} tokenExpiresAt
 */

/**
 * Tokens in config.json that are newer than the ones Homebridge handed the plugin.
 *
 * Homebridge gives a child bridge the config it read when Homebridge started, and
 * reuses it when the child bridge restarts after its process exits. After a token
 * refresh that copy holds a refresh token Yoto has already rotated away, and using
 * it again fails with invalid_grant. The file on disk has the current ones.
 *
 * @param {string} configContents - Raw config.json contents
 * @param {Object} options
 * @param {string} options.platform - Platform name to match (e.g. 'Yoto')
 * @param {string} [options.bridgeUsername] - Child bridge username, to pick the block when there are several
 * @param {unknown} options.refreshToken - Refresh token Homebridge passed in
 * @param {unknown} options.tokenExpiresAt - Its expiry (ms)
 * @returns {SavedTokens | null}
 */
export function findNewerSavedTokens (configContents, { platform, bridgeUsername, refreshToken, tokenExpiresAt }) {
  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(configContents)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const platforms = /** @type {Record<string, unknown>} */ (parsed)['platforms']
  if (!Array.isArray(platforms)) return null

  /** @type {Record<string, unknown>[]} */
  const candidates = platforms.filter(entry => entry && typeof entry === 'object' && entry.platform === platform)
  const block = bridgeUsername
    ? candidates.find(entry => {
      const bridge = entry['_bridge']
      return bridge && typeof bridge === 'object' && /** @type {Record<string, unknown>} */ (bridge)['username'] === bridgeUsername
    })
    : (candidates.length === 1 ? candidates[0] : undefined)
  if (!block) return null

  const savedAccess = block['accessToken']
  const savedRefresh = block['refreshToken']
  const savedExpiresAt = block['tokenExpiresAt']
  if (typeof savedAccess !== 'string' || typeof savedRefresh !== 'string' || typeof savedExpiresAt !== 'number') return null
  if (savedRefresh === refreshToken) return null

  const currentExpiresAt = typeof tokenExpiresAt === 'number' ? tokenExpiresAt : 0
  if (savedExpiresAt <= currentExpiresAt) return null

  return { accessToken: savedAccess, refreshToken: savedRefresh, tokenExpiresAt: savedExpiresAt }
}
