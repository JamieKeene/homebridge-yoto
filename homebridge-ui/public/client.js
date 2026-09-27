/// <reference lib="dom" />

/**
 * @fileoverview Client-side UI logic for Yoto Homebridge plugin OAuth authentication
 */

/** @import {IHomebridgePluginUi} from '@homebridge/plugin-ui-utils/ui.interface' */
/** @import { AuthConfigResponse, AuthStartResponse, AuthExchangeResponse, AuthStatusResponse } from '../server.js' */

/**
 * @global
 * @type {IHomebridgePluginUi}
 */
const homebridge = window.homebridge

/**
 * @typedef {Object} YotoConfig
 * @property {string} [platform] - Platform alias (always "Yoto")
 * @property {string} [name] - Name used in the Homebridge log
 * @property {string} [clientId] - OAuth client ID (only stored when not the default)
 * @property {string} [refreshToken] - Stored refresh token
 * @property {string} [accessToken] - Stored access token
 * @property {number} [tokenExpiresAt] - Token expiration timestamp
 */

// State variables
/** @type {string | null} */
let pendingState = null
/** @type {string | null} */
let authorizeUrl = null
/** @type {YotoConfig[]} */
let pluginConfig = []
/** @type {string | null} */
let defaultClientId = null
/** @type {string | null} */
let defaultName = null
/** @type {string[]} */
let legacyClientIds = []

/**
 * @param {string} id
 * @returns {HTMLInputElement | null}
 */
function getInput (id) {
  return /** @type {HTMLInputElement | null} */ (document.getElementById(id))
}

/**
 * Initialize UI when ready
 */
async function initializeUI () {
  document.getElementById('startAuthButton')?.addEventListener('click', startAuthorization)
  document.getElementById('openAuthorizeButton')?.addEventListener('click', openAuthorizeUrl)
  document.getElementById('finishAuthButton')?.addEventListener('click', finishAuthorization)
  document.getElementById('cancelAuthButton')?.addEventListener('click', showAuthRequired)
  document.getElementById('retryButton')?.addEventListener('click', showAuthRequired)
  document.getElementById('logoutButton')?.addEventListener('click', logout)
  document.getElementById('reauthButton')?.addEventListener('click', startAuthorization)
  getInput('callbackInput')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finishAuthorization()
  })

  homebridge.hideSchemaForm()

  // Load auth config and check authentication status
  await loadAuthConfig()
  await checkAuthStatus()
}

// Initialize on ready
homebridge.addEventListener('ready', initializeUI)

/**
 * Show a specific UI section and hide all others
 * @param {string} sectionToShow - ID of section to show
 * @param {Object} [options] - Optional parameters
 * @param {string} [options.errorMessage] - Error message to display (for errorSection)
 */
function showSection (sectionToShow, options = {}) {
  const sections = [
    'statusMessage',
    'authRequired',
    'authCodeSection',
    'authSuccess',
    'authExpired',
    'errorSection'
  ]

  for (const sectionId of sections) {
    const el = document.getElementById(sectionId)
    if (el) {
      el.style.display = sectionId === sectionToShow ? 'block' : 'none'
    }
  }

  if (options.errorMessage) {
    const errorMessageEl = document.getElementById('errorMessage')
    if (errorMessageEl) errorMessageEl.textContent = options.errorMessage
  }

  if (sectionToShow === 'authSuccess') {
    homebridge.showSchemaForm()
  } else {
    homebridge.hideSchemaForm()
  }
}

/**
 * Show authentication required section
 */
function showAuthRequired () {
  pendingState = null
  authorizeUrl = null
  showSection('authRequired')
}

/**
 * Show error message
 * @param {string} message - Error message to display
 */
function showError (message) {
  showSection('errorSection', { errorMessage: message })
}

/**
 * The details a server RequestError sends as its payload
 * (homebridge.request rejects with `{ message, error: payload }`)
 * @param {unknown} error
 * @returns {Record<string, unknown> | undefined}
 */
function getErrorPayload (error) {
  if (error && typeof error === 'object' && 'error' in error && error.error && typeof error.error === 'object') {
    return /** @type {Record<string, unknown>} */ (error.error)
  }
  return undefined
}

/**
 * Extract a readable message from a homebridge.request error
 * @param {unknown} error
 * @param {string} fallback
 * @returns {string}
 */
function getErrorMessage (error, fallback) {
  const payloadMessage = getErrorPayload(error)?.['message']
  if (payloadMessage) return String(payloadMessage)
  if (error && typeof error === 'object') {
    if ('message' in error && error.message) return String(error.message)
    if ('error' in error && error.error) return String(error.error)
  }
  return error ? String(error) : fallback
}

/**
 * Load authentication configuration from server
 * @returns {Promise<void>}
 */
async function loadAuthConfig () {
  try {
    pluginConfig = await homebridge.getPluginConfig()

    /** @type {AuthConfigResponse} */
    const config = await homebridge.request('/auth/config')
    defaultClientId = config.defaultClientId
    defaultName = config.defaultName
    legacyClientIds = config.legacyClientIds
    getPlatformBlock()

    const redirectUriDisplay = document.getElementById('redirectUriDisplay')
    if (redirectUriDisplay) redirectUriDisplay.textContent = config.redirectUri

    const defaultClientIdDisplay = document.getElementById('defaultClientIdDisplay')
    if (defaultClientIdDisplay) defaultClientIdDisplay.textContent = defaultClientId

    const clientIdInput = getInput('clientIdInput')
    if (clientIdInput) {
      clientIdInput.value = getConfiguredClientId() || defaultClientId
      clientIdInput.placeholder = defaultClientId
    }
  } catch (error) {
    console.error('Failed to load auth config:', error)
  }
}

/**
 * The plugin's config block, created if missing. Also fills in the name,
 * which blocks saved by older versions don't have.
 * @returns {YotoConfig}
 */
function getPlatformBlock () {
  if (!pluginConfig[0]) pluginConfig[0] = { platform: 'Yoto' }
  const config = pluginConfig[0]
  if (!config.name && defaultName) config.name = defaultName
  return config
}

/**
 * The client ID saved in config, ignoring retired ones
 * @returns {string | undefined}
 */
function getConfiguredClientId () {
  const clientId = pluginConfig[0]?.clientId
  return clientId && !legacyClientIds.includes(clientId) ? clientId : undefined
}

/**
 * Start the sign-in: get an authorize URL and open it
 * @returns {Promise<void>}
 */
async function startAuthorization () {
  // Open the tab now, while we still have the click; opening it after the
  // request below would be blocked as a popup (notably by Safari).
  const signInWindow = window.open('', '_blank')
  if (signInWindow) signInWindow.opener = null

  try {
    homebridge.showSpinner()

    const clientIdInput = getInput('clientIdInput')
    const typedClientId = clientIdInput?.value.trim()
    const clientIdToUse = typedClientId && !legacyClientIds.includes(typedClientId)
      ? typedClientId
      : defaultClientId || undefined

    /** @type {AuthStartResponse} */
    const response = await homebridge.request('/auth/start', { clientId: clientIdToUse })
    pendingState = response.state
    authorizeUrl = response.authorizeUrl

    const callbackInput = getInput('callbackInput')
    if (callbackInput) callbackInput.value = ''

    showSection('authCodeSection')
    homebridge.hideSpinner()
    if (signInWindow && !signInWindow.closed) {
      signInWindow.location.href = response.authorizeUrl
    } else {
      openAuthorizeUrl()
    }
  } catch (error) {
    signInWindow?.close()
    homebridge.hideSpinner()
    const errorMessage = getErrorMessage(error, 'Failed to start sign-in')
    homebridge.toast.error('Failed to start sign-in', errorMessage)
    showError(errorMessage)
  }
}

/**
 * Open the Yoto sign-in page in a new tab
 */
function openAuthorizeUrl () {
  if (authorizeUrl) {
    window.open(authorizeUrl, '_blank', 'noopener')
  }
}

/**
 * Exchange the pasted redirect address for tokens and save them
 * @returns {Promise<void>}
 */
async function finishAuthorization () {
  const callbackInput = getInput('callbackInput')
  const pasted = callbackInput?.value.trim() || ''
  if (!pasted) {
    homebridge.toast.warning('Paste the address from your browser first', 'Nothing to submit')
    return
  }

  if (!pendingState) {
    showError('This sign-in attempt has expired. Click "Try Again" to start over.')
    return
  }

  try {
    homebridge.showSpinner()

    /** @type {AuthExchangeResponse} */
    const result = await homebridge.request('/auth/exchange', {
      state: pendingState,
      response: pasted,
    })

    const config = getPlatformBlock()
    config.refreshToken = result.refreshToken
    config.accessToken = result.accessToken
    config.tokenExpiresAt = result.tokenExpiresAt

    // Always set the client ID. Deleting it isn't enough: the settings form
    // keeps the value it loaded (e.g. a retired client ID) and saves it back.
    // If the default ever changes, add the old one to LEGACY_CLIENT_IDS.
    config.clientId = result.clientId

    await homebridge.updatePluginConfig(pluginConfig)
    await homebridge.savePluginConfig()

    pendingState = null
    authorizeUrl = null
    homebridge.hideSpinner()
    homebridge.toast.success('Signed in to Yoto!')
    homebridge.toast.info('Restart Homebridge for changes to take effect', 'Restart Required')
    showSection('authSuccess')
  } catch (error) {
    homebridge.hideSpinner()
    const errorMessage = getErrorMessage(error, 'Sign-in failed')
    homebridge.toast.error('Sign-in failed', errorMessage)
    // Keep the paste box open for recoverable problems (e.g. pasted the wrong thing)
    if (getErrorPayload(error)?.['restart'] === true) {
      showError(errorMessage)
    }
  }
}

/**
 * Logout - clear tokens and restart auth flow
 */
async function logout () {
  try {
    homebridge.showSpinner()

    // Blank the tokens rather than deleting them: the settings form keeps
    // values the client deletes and would save the old login back
    const config = getPlatformBlock()
    config.refreshToken = ''
    config.accessToken = ''
    delete config.tokenExpiresAt

    await homebridge.updatePluginConfig(pluginConfig)
    await homebridge.savePluginConfig()

    homebridge.hideSpinner()
    homebridge.toast.success('Logged out successfully')
    homebridge.toast.info('Restart Homebridge to disconnect from your Yoto account', 'Restart Required')

    showAuthRequired()
  } catch (error) {
    homebridge.hideSpinner()
    homebridge.toast.error('Logout failed', getErrorMessage(error, 'Logout failed'))
  }
}

/**
 * Check initial authentication status. Saved tokens aren't proof of a working
 * login, so ask whether the plugin found that Yoto rejected them.
 * @returns {Promise<void>}
 */
async function checkAuthStatus () {
  const config = pluginConfig[0]
  if (!config?.refreshToken || !config?.accessToken) {
    showAuthRequired()
    return
  }

  try {
    /** @type {AuthStatusResponse} */
    const status = await homebridge.request('/auth/status', { refreshToken: config.refreshToken })
    if (status.expired) {
      const detail = document.getElementById('authExpiredMessage')
      if (detail) {
        const when = status.at ? new Date(status.at).toLocaleString() : ''
        detail.textContent = [when && `Since ${when}.`, status.message].filter(Boolean).join(' ')
      }
      showSection('authExpired')
      return
    }
  } catch (error) {
    // Older Homebridge UI versions or a read error: fall back to the saved tokens
    console.error('Failed to check the login status:', error)
  }
  showSection('authSuccess')
}
