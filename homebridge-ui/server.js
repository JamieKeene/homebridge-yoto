/**
 * @fileoverview Custom UI server for Yoto Homebridge plugin OAuth authentication
 *
 * Uses the OAuth 2.0 Authorization Code flow with PKCE. The user signs in on
 * Yoto's site, lands on the (unreachable) loopback redirect URI, and pastes that
 * address back into the plugin settings. The PKCE verifier never leaves this
 * server, so the pasted code is useless to anyone else.
 */

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils'
import { YotoClient } from 'yoto-nodejs-client'
import {
  DEFAULT_CLIENT_ID,
  DEFAULT_NAME,
  LEGACY_CLIENT_IDS,
  OAUTH_REDIRECT_URI,
  OAUTH_SCOPES,
} from '../lib/settings.js'
import { createOAuthState, createPkcePair, parseAuthorizationResponse } from '../lib/utils/oauth.js'
import { readLoginProblem } from '../lib/utils/login-status.js'

const AUDIENCE = 'https://api.yotoplay.com'
/** Sign-in attempts are discarded after this long */
const PENDING_AUTH_TTL_MS = 15 * 60 * 1000
/** Used when the token response has no expires_in; the plugin refreshes early anyway */
const DEFAULT_EXPIRES_IN_S = 60 * 60

/**
 * @typedef {Object} PendingAuth
 * @property {string} codeVerifier
 * @property {string} clientId
 * @property {number} createdAt
 */

/** @type {Map<string, PendingAuth>} */
const pendingAuths = new Map()

/**
 * Custom UI server for Yoto plugin OAuth authentication
 * @extends {HomebridgePluginUiServer}
 */
class YotoUiServer extends HomebridgePluginUiServer {
  constructor () {
    // super() MUST be called first
    super()

    // Register OAuth endpoints
    this.onRequest('/auth/config', getAuthConfig)
    this.onRequest('/auth/start', startAuthorization)
    this.onRequest('/auth/exchange', exchangeAuthorizationCode)
    this.onRequest('/auth/status', (/** @type {AuthStatusRequest} */ payload) => getLoginStatus(this.homebridgeStoragePath, payload))

    // this MUST be called when you are ready to accept requests
    this.ready()
  }
}

// Create and start the server
(() => new YotoUiServer())()

/**
 * Response from /auth/config endpoint
 * @typedef {Object} AuthConfigResponse
 * @property {string} defaultClientId - The default OAuth client ID
 * @property {string} defaultName - The default plugin name, filled into config blocks that have none
 * @property {string[]} legacyClientIds - Client IDs that no longer support sign-in
 * @property {string} redirectUri - Redirect URI to register on a custom Yoto app
 */

/**
 * Get authentication configuration
 * @returns {Promise<AuthConfigResponse>}
 */
async function getAuthConfig () {
  return {
    defaultClientId: DEFAULT_CLIENT_ID,
    defaultName: DEFAULT_NAME,
    legacyClientIds: LEGACY_CLIENT_IDS,
    redirectUri: OAUTH_REDIRECT_URI,
  }
}

/**
 * Request payload for /auth/status endpoint
 * @typedef {Object} AuthStatusRequest
 * @property {string} [refreshToken] - Refresh token in the settings being shown
 */

/**
 * Response from /auth/status endpoint
 * @typedef {Object} AuthStatusResponse
 * @property {boolean} expired - True when the plugin found this login no longer works
 * @property {string} [message] - What went wrong
 * @property {string} [at] - When it happened (ISO 8601)
 */

/**
 * Whether the plugin recorded that the saved login stopped working. The plugin
 * records the refresh token's fingerprint, so a login replaced by signing in
 * again isn't reported.
 * @param {string | undefined} storagePath - Homebridge storage folder
 * @param {AuthStatusRequest} payload
 * @returns {Promise<AuthStatusResponse>}
 */
async function getLoginStatus (storagePath, payload) {
  if (!storagePath) return { expired: false }
  const problem = await readLoginProblem(storagePath, payload?.refreshToken)
  return problem ? { expired: true, message: problem.message, at: problem.at } : { expired: false }
}

/**
 * Request payload for /auth/start endpoint
 * @typedef {Object} AuthStartRequest
 * @property {string} [clientId] - OAuth client ID from config (optional, falls back to DEFAULT_CLIENT_ID)
 */

/**
 * Response from /auth/start endpoint
 * @typedef {Object} AuthStartResponse
 * @property {string} authorizeUrl - Yoto sign-in URL to open in the browser
 * @property {string} state - Identifies this sign-in attempt
 * @property {string} clientId - OAuth client ID used for this attempt
 */

/**
 * Start an Authorization Code + PKCE sign-in
 * @param {AuthStartRequest} payload - Request with optional client ID
 * @returns {Promise<AuthStartResponse>}
 */
async function startAuthorization (payload) {
  prunePendingAuths()

  const requested = typeof payload?.clientId === 'string' ? payload.clientId.trim() : ''
  const clientId = requested && !LEGACY_CLIENT_IDS.includes(requested) ? requested : DEFAULT_CLIENT_ID
  const { codeVerifier, codeChallenge } = createPkcePair()
  const state = createOAuthState()

  pendingAuths.set(state, { codeVerifier, clientId, createdAt: Date.now() })

  const authorizeUrl = YotoClient.getAuthorizeUrl({
    audience: AUDIENCE,
    scope: OAUTH_SCOPES,
    responseType: 'code',
    clientId,
    redirectUri: OAUTH_REDIRECT_URI,
    state,
    codeChallenge,
    codeChallengeMethod: 'S256',
  })

  console.log('[Server] Started sign-in with clientId:', clientId)
  return { authorizeUrl, state, clientId }
}

/**
 * Error payload for /auth/exchange failures
 * @typedef {Object} AuthExchangeError
 * @property {string} message - Message to show the user
 * @property {boolean} restart - True when this sign-in attempt can't continue and a new one must be started
 */

/**
 * Throw an /auth/exchange error
 * @param {string} title
 * @param {string} message
 * @param {boolean} restart - Whether the user must start a new sign-in
 * @returns {never}
 */
function throwExchangeError (title, message, restart) {
  /** @type {AuthExchangeError} */
  const body = { message, restart }
  throw new RequestError(title, body)
}

/**
 * Request payload for /auth/exchange endpoint
 * @typedef {Object} AuthExchangeRequest
 * @property {string} state - State returned by /auth/start
 * @property {string} response - Pasted redirect address (or bare code)
 */

/**
 * Response from /auth/exchange endpoint
 * @typedef {Object} AuthExchangeResponse
 * @property {string} refreshToken - OAuth refresh token (long-lived)
 * @property {string} accessToken - OAuth access token (short-lived)
 * @property {number} tokenExpiresAt - Unix timestamp in ms when the access token expires
 * @property {string} clientId - OAuth client ID the tokens belong to
 */

/**
 * Exchange the pasted authorization response for tokens
 * @param {AuthExchangeRequest} payload
 * @returns {Promise<AuthExchangeResponse>}
 */
async function exchangeAuthorizationCode (payload) {
  prunePendingAuths()

  const pending = payload?.state ? pendingAuths.get(payload.state) : undefined
  if (!pending) {
    throwExchangeError('Sign-in expired', 'This sign-in attempt has expired. Click "Sign in with Yoto" to start again.', true)
  }

  const parsed = parseAuthorizationResponse(typeof payload.response === 'string' ? payload.response : '')

  // Check state first, so an address from another attempt can't cancel this one.
  // A bare pasted code has no state; PKCE still ties it to this attempt's verifier.
  if (parsed.state && parsed.state !== payload.state) {
    throwExchangeError(
      'Sign-in mismatch',
      'That address is from a different sign-in attempt. Use the link from your most recent "Sign in with Yoto" click.',
      false
    )
  }

  if (parsed.error) {
    pendingAuths.delete(payload.state)
    const message = parsed.error === 'access_denied'
      ? 'Access was denied. Click "Sign in with Yoto" to try again.'
      : `Yoto returned an error: ${parsed.errorDescription || parsed.error}`
    throwExchangeError('Sign-in failed', message, true)
  }

  if (!parsed.code) {
    throwExchangeError(
      'Missing code',
      'Paste the full address from your browser after signing in. It starts with http://127.0.0.1:8787/callback?code=',
      false
    )
  }

  try {
    const tokens = await YotoClient.exchangeToken({
      grantType: 'authorization_code',
      code: parsed.code,
      redirectUri: OAUTH_REDIRECT_URI,
      codeVerifier: pending.codeVerifier,
      clientId: pending.clientId,
      audience: AUDIENCE,
    })

    if (!tokens.refresh_token || !tokens.access_token) {
      throw new Error('Token response missing required fields. Make sure offline_access is enabled on the Yoto app.')
    }

    pendingAuths.delete(payload.state)
    console.log('[Server] Token exchange successful')

    const expiresIn = Number(tokens.expires_in)
    return {
      refreshToken: tokens.refresh_token,
      accessToken: tokens.access_token,
      tokenExpiresAt: Date.now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN_S) * 1000,
      clientId: pending.clientId,
    }
  } catch (error) {
    const err = /** @type {{ jsonBody?: { error?: string, error_description?: string }, textBody?: string }} */ (error)
    const description = err.jsonBody?.error_description || err.jsonBody?.error || err.textBody
    const message = description || (error instanceof Error ? error.message : String(error))
    console.error('[Server] Token exchange failed:', message)
    if (err.jsonBody?.error === 'invalid_grant') {
      throwExchangeError(
        'Token exchange failed',
        'That sign-in code was already used or has expired. Click "Sign in with Yoto" to start again.',
        true
      )
    }
    throwExchangeError('Token exchange failed', message, false)
  }
}

/**
 * Drop sign-in attempts older than PENDING_AUTH_TTL_MS
 */
function prunePendingAuths () {
  const cutoff = Date.now() - PENDING_AUTH_TTL_MS
  for (const [state, pending] of pendingAuths) {
    if (pending.createdAt < cutoff) pendingAuths.delete(state)
  }
}
