/**
 * @fileoverview Main platform implementation for Yoto Homebridge plugin
 */

/** @import { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service, Characteristic } from 'homebridge' */
/** @import { YotoDevice } from 'yoto-nodejs-client/lib/api-endpoints/devices.js' */
/** @import { YotoDeviceModel } from 'yoto-nodejs-client' */
/** @import { YotoAccountEventMap } from 'yoto-nodejs-client/lib/yoto-account.js' */
/** @import { PlaybackAccessoryConfig } from './service-config.js' */
/** @import { CardControlConfig } from './card-controls.js' */
/** @import { LibraryCard } from './utils/library.js' */
/** @import { RefreshSuccessEvent } from 'yoto-nodejs-client/lib/token.js' */

/**
 * Context stored in PlatformAccessory for Yoto devices
 * @typedef {Object} YotoAccessoryContext
 * @property {YotoDevice} device - Device metadata from Yoto API
 * @property {'device'} [type] - Accessory type marker
 */

/**
 * Context stored in PlatformAccessory for card control accessories
 * @typedef {Object} YotoCardAccessoryContext
 * @property {CardControlConfig} cardControl - Card control configuration
 * @property {'card-control'} type - Accessory type marker
 */

import { createCardTrackLookup } from './utils/card-tracks.js'
import { createCardArtworkLookup } from './utils/card-artwork.js'
import { NativeControls } from './native-controls.js'
import { startMediaRemoteBridge } from './mediaremote-bridge.js'
import { readFileSync } from 'node:fs'
import { readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { YotoAccount } from 'yoto-nodejs-client'
import { randomUUID } from 'node:crypto'
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  DEFAULT_CLIENT_ID,
  LOG_PREFIX,
} from './settings.js'
import { YotoPlayerAccessory } from './accessory.js'
import { YotoSpeakerAccessory } from './speaker-accessory.js'
import { YotoTelevisionAccessory } from './television-accessory.js'
import { YotoCardControlAccessory } from './card-control-accessory.js'
import { sanitizeName } from './utils/sanitize-name.js'
import { getPlaybackAccessoryConfig } from './service-config.js'
import { getCardControlConfigs } from './card-controls.js'
import { errorMessage, formatError, getStatusCode } from './utils/error-format.js'
import { ListenerGroup, logListenerError } from './utils/listener-group.js'
import { applyTokenUpdate, findNewerSavedTokens } from './utils/token-config.js'
import { tolerateMissingStatusScope } from './utils/status-scope-fallback.js'
import { getTokenClientId } from './utils/token-client-id.js'
import { fetchFamilyLibrary, fetchCardTracks, fetchCardDetails } from './utils/library.js'
import { clearLoginProblem, writeLoginProblem } from './utils/login-status.js'
import { markAccessoryUnreachable } from './utils/unreachable.js'

/** First retry delay when the Yoto API can't be reached at startup; doubles each attempt */
const START_RETRY_BASE_MS = 30 * 1000
/** Longest wait between startup retries */
const START_RETRY_MAX_MS = 10 * 60 * 1000
/** How long a fetched card library is reused (shared by all TV accessories) */
const LIBRARY_CACHE_MS = 10 * 60 * 1000

/**
 * Whether a failed account start could succeed if tried again. Network errors
 * and 5xx responses are transient; other 4xx responses won't change on retry.
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableStartError (error) {
  const statusCode = getStatusCode(error)
  if (statusCode === undefined) return true
  return statusCode >= 500 || statusCode === 408 || statusCode === 429
}

/**
 * Yoto Platform implementation
 * This class is the main constructor for your plugin, this is where you should
 * parse the user config and discover/register accessories with Homebridge.
 * @implements {DynamicPlatformPlugin}
 */
export class YotoPlatform {
  /** @type {Logger} */ log
  /** @type {PlatformConfig} */ config
  /** @type {API} */ api
  /** @type {typeof Service} */ Service
  /** @type {typeof Characteristic} */ Characteristic
  /** @type {PlaybackAccessoryConfig} */ playbackAccessoryConfig
  /** @type {Map<string, PlatformAccessory<YotoAccessoryContext>>} */ accessories = new Map()
  /** @type {Map<string, PlatformAccessory<YotoAccessoryContext>>} */ speakerAccessories = new Map()
  /** @type {Map<string, PlatformAccessory<YotoAccessoryContext>>} */ televisionAccessories = new Map()
  /** @type {Map<string, PlatformAccessory<YotoCardAccessoryContext>>} */ cardAccessories = new Map()
  /** @type {Map<string, YotoPlayerAccessory>} */ accessoryHandlers = new Map()
  /** @type {Map<string, YotoSpeakerAccessory>} */ speakerAccessoryHandlers = new Map()
  /** @type {Map<string, YotoTelevisionAccessory>} */ televisionAccessoryHandlers = new Map()
  /** @type {Map<string, YotoCardControlAccessory>} */ cardAccessoryHandlers = new Map()
  /** @type {YotoAccount | null} */ yotoAccount = null
  /** @type {ListenerGroup<YotoAccountEventMap> | null} */ accountListeners = null
  /** @type {string} */ sessionId = randomUUID()
  /** @type {Map<string, Promise<string | null>>} */ cardTitleCache = new Map()
  /** @type {{ fetchedAt: number, cards: Promise<LibraryCard[]> } | null} */ libraryCache = null
  /** @type {boolean} */ authInvalid = false
  /** @type {boolean} */ launched = false
  /** @type {boolean} */ markOnLaunch = false
  /** @type {number} */ startRetryCount = 0
  /** @type {ReturnType<typeof setTimeout> | null} */ startRetryTimer = null
  /** @type {boolean} */ shuttingDown = false
  /** @type {import("node:http").Server | null} */ mediaRemoteBridge = null
  /** @type {NativeControls | null} */ nativeControls = null
  /** @type {(cardId: string) => string | null} */ cardArtwork = () => null
  /** @type {(cardId: string) => import('./utils/card-tracks.js').CardTrack[] | null} */ cardTracks = () => null

  /**
   * @param {Logger} log - Homebridge logger
   * @param {PlatformConfig} config - Platform configuration
   * @param {API} api - Homebridge API
   */
  constructor (log, config, api) {
    this.log = log
    this.config = config
    this.api = api
    this.Service = api.hap.Service
    this.Characteristic = api.hap.Characteristic
    this.playbackAccessoryConfig = getPlaybackAccessoryConfig(config)
    this.cardTracks = createCardTrackLookup(async cardId => {
      const client = this.yotoAccount?.client
      if (!client || this.authInvalid) return []
      const tracks = await fetchCardTracks(client, cardId)
      log.debug(`Native controls card detail loaded ${tracks.length} track keys`)
      return tracks
    }, () => this.getLibraryCards(), log)
    this.cardArtwork = createCardArtworkLookup(async cardId => {
      const client = this.yotoAccount?.client
      if (!client || this.authInvalid) return null
      const response = await fetchCardDetails(client, cardId)
      return response.card?.metadata?.cover?.imageL || null
    }, () => this.getLibraryCards(), log)

    log.debug('Finished initializing platform:', config.name)

    // A child bridge restarted after its process exits gets the config Homebridge
    // read at startup, which can hold tokens already rotated by a refresh
    this.useNewerSavedTokens(config)

    // Extract auth tokens once
    const refreshToken = config['refreshToken']
    const accessToken = config['accessToken']
    // Refreshing needs the client ID the tokens were issued to. The saved
    // clientId can be stale: the settings form can save an old value back
    // after signing in with another app.
    const configuredClientId = config['clientId'] || DEFAULT_CLIENT_ID
    const tokenClientId = getTokenClientId(accessToken)
    const clientId = tokenClientId || configuredClientId
    if (tokenClientId && tokenClientId !== configuredClientId) {
      log.info(`Using the client ID your Yoto login was issued to (${tokenClientId}) instead of the one in the settings (${configuredClientId}).`)
    }

    // Debug: Log what we found (redacted)
    log.debug('Config check - Has refreshToken:', !!refreshToken)
    log.debug('Config check - Has accessToken:', !!accessToken)
    log.debug('Config check - ClientId:', clientId ? 'present' : 'missing')

    // Check if we have authentication tokens
    if (!refreshToken || !accessToken) {
      log.warn('No authentication tokens found. Please configure the plugin through the Homebridge UI.')
      // Cached accessories would otherwise show their last state and ignore taps
      this.markAccessoriesUnreachable()
      return
    }

    log.debug('Authentication tokens found, initializing Yoto account...')

    const { sessionId } = this

    // Initialize YotoAccount with client and device options. It decodes the saved
    // access token, which throws if config.json holds a malformed one; Homebridge
    // doesn't catch errors from platform constructors, so it would crash on every start.
    /** @type {YotoAccount} */
    let account
    try {
      account = new YotoAccount({
        clientOptions: {
          clientId,
          refreshToken,
          accessToken,
          onTokenRefresh: (event) => this.saveRefreshedTokens(event),
          onRefreshStart: () => {
            // Logged at info, so a refresh cut short (e.g. by a restart) shows in the log
            log.info('Refreshing the Yoto login...')
          },
          onRefreshError: (error) => {
            log.warn('Yoto token refresh failed, will retry:', error.message)
            log.debug('Token refresh error details:', formatError(error))
          },
          onInvalid: (error) => {
            log.error(
              'Yoto login has expired or been revoked. Open the plugin settings in the Homebridge UI and sign in again.',
              error.message
            )
            this.handleLoginProblem(`Yoto rejected the saved login: ${error.message}`)
          },
        },
        deviceOptions: {
          httpPollIntervalMs: Math.max(10000, Number(config['httpPollIntervalMs']) || 60000),
          yotoDeviceMqttOptions: {
            sessionId
          }
        }
      })
    } catch (error) {
      log.error(
        'Could not load the saved Yoto login. Open the plugin settings in the Homebridge UI and sign in again.',
        errorMessage(error)
      )
      this.handleLoginProblem(`The saved login could not be read: ${errorMessage(error)}`)
      return
    }
    this.yotoAccount = account
    // The account re-emits device events from MQTT and timer callbacks, so a
    // throwing listener would be an uncaught exception that stops Homebridge
    this.accountListeners = new ListenerGroup(account, logListenerError(log, LOG_PREFIX.PLATFORM))

    // The status endpoint needs a scope the Yoto dashboard doesn't offer yet
    tolerateMissingStatusScope(this.yotoAccount.client, (message) => log.debug(message))

    // Listen to account-level events
    this.accountListeners.on('error', ({ error, context }) => {
      const details = formatError(error)
      if (context.deviceId) {
        const label = this.formatDeviceLabel(context.deviceId)
        log.error(`Device error [${label} ${context.operation} ${context.source}]:`, details)
        log.debug('Device error context:', context)
      } else if (context.operation === 'start') {
        // connectAccount() logs the failure and schedules a retry
        log.debug('Account start error:', details)
      } else {
        log.error('Account error:', details)
        log.debug('Account error context:', context)
      }
    })

    // When this event is fired it means Homebridge has restored all cached accessories from disk.
    // Dynamic Platform plugins should only register new accessories after this event was fired,
    // in order to ensure they weren't added to homebridge already. This event can also be used
    // to start discovery of new accessories.
    api.on('didFinishLaunching', async () => {
      log.debug('Executed didFinishLaunching callback')
      this.launched = true
      // Start the YotoAccount which will discover and start all devices
      await this.startAccount()
      if (this.config['services']?.nativeControls === true && !this.shuttingDown) {
        try {
          const storage = this.getStoragePath()
          if (!storage) throw new Error('Homebridge storage path unavailable')
          this.nativeControls = new NativeControls(config['nativeControls'], storage,
            () => this.shuttingDown || this.authInvalid ? undefined : this.yotoAccount?.devices, log, { artwork: this.cardArtwork, tracks: this.cardTracks })
          await this.nativeControls.start()
        } catch (error) {
          await this.nativeControls?.stop()
          this.nativeControls = null
          log.error('Native iPhone controls could not start. Check Python/venv/pip and Git availability, and the LAN address setting:', errorMessage(error))
        }
      }
      try {
        this.mediaRemoteBridge = await startMediaRemoteBridge(config['mediaRemoteBridge'],
          () => this.shuttingDown || this.authInvalid ? undefined : this.yotoAccount?.devices, log, this.cardArtwork, this.cardTracks)
        if (this.shuttingDown) this.mediaRemoteBridge?.close()
      } catch (error) {
        log.error('Failed to start MediaRemote bridge:', formatError(error))
      }
    })

    // When homebridge shuts down, cleanup all handlers and MQTT connections
    api.on('shutdown', () => {
      log.debug('Homebridge shutting down, cleaning up accessories...')
      this.shutdown().catch(error => {
        log.error('Error while shutting down:', formatError(error))
      })
    })
  }

  /**
   * This function is invoked when homebridge restores cached accessories from disk at startup.
   * It should be used to set up event handlers for characteristics and update respective values.
   * In practice, it never is. It simply collects previously created devices into an accessories map
   * that is then used to setup devices after didFinishLaunching fires.
   * @param {PlatformAccessory} accessory - Cached accessory
   */
  configureAccessory (accessory) {
    const { log, accessories, cardAccessories } = this
    log.debug('Loading accessory from cache:', accessory.displayName, accessory.UUID)

    const context = accessory.context
    const record = context && typeof context === 'object'
      ? /** @type {Record<string, unknown>} */ (context)
      : null
    const accessoryType = record && typeof record['type'] === 'string'
      ? record['type']
      : undefined
    log.debug('Cached accessory context type:', accessory.displayName, accessoryType ?? 'device')

    if (accessoryType === 'card-control' || record?.['cardControl']) {
      cardAccessories.set(accessory.UUID, /** @type {PlatformAccessory<YotoCardAccessoryContext>} */ (accessory))
      return
    }

    // Add to our tracking map (cast to our typed version)
    accessories.set(accessory.UUID, /** @type {PlatformAccessory<YotoAccessoryContext>} */ (accessory))
  }

  /**
   * Start YotoAccount - discovers devices and creates device models
   */
  async startAccount () {
    const listeners = this.accountListeners
    if (!this.yotoAccount || !listeners) {
      this.log.error('Cannot start account - YotoAccount not initialized')
      return
    }

    try {
      this.log.debug('Starting Yoto account...')
      this.log.debug(
        'Playback controls config:',
        `playback=${this.playbackAccessoryConfig.playbackEnabled}`,
        `volume=${this.playbackAccessoryConfig.volumeEnabled}`,
        `smartSpeaker=${this.playbackAccessoryConfig.smartSpeakerEnabled}`,
        `tvPlayback=${this.playbackAccessoryConfig.televisionEnabled}`
      )
      if (this.playbackAccessoryConfig.smartSpeakerEnabled && !this.playbackAccessoryConfig.televisionEnabled) {
        this.log.info('The External Smart Speaker is a legacy option: the Home app shows "Controls not available" for it. For the iPhone remote, volume buttons, and inputs for card controls and shortcuts, turn on the TV Playback Accessory instead.')
      }

      // Listen for devices being added
      listeners.on('deviceAdded', async ({ deviceId }) => {
        // The account doesn't await this listener, so errors must not escape it
        try {
          // Homebridge may shut down while the account is still starting. With a dead
          // login, a new handler would bring back tiles that show stale state.
          if (this.shuttingDown || this.authInvalid || !this.yotoAccount) return
          const deviceModel = this.yotoAccount.getDevice(deviceId)
          if (!deviceModel) {
            const label = this.formatDeviceLabel(deviceId)
            this.log.warn(`Device added but no model found for ${label}`)
            return
          }

          const device = deviceModel.device
          this.log.info(`Device discovered: ${device.name} (${deviceId})`)
          this.log.debug('Registering device from account discovery:', device.name, deviceId)
          await this.registerDevice(device, deviceModel)
          this.nativeControls?.sync()
        } catch (error) {
          this.log.error(`Failed to set up ${this.formatDeviceLabel(deviceId)}:`, formatError(error))
        }
      })

      listeners.on('deviceRemoved', ({ deviceId }) => {
        const label = this.formatDeviceLabel(deviceId)
        this.log.debug(`Device removed: ${label}`)
        this.removeStaleAccessories()
        this.nativeControls?.sync()
      })

      listeners.on('online', ({ deviceId, metadata }) => {
        const label = this.formatDeviceLabel(deviceId)
        const reason = metadata?.reason ? ` (${metadata.reason})` : ''
        this.log.info(`Device online: ${label}${reason}`)
      })

      listeners.on('offline', ({ deviceId, metadata }) => {
        const label = this.formatDeviceLabel(deviceId)
        const reason = metadata?.reason ? ` (${metadata.reason})` : ''
        this.log.info(`Device offline: ${label}${reason}`)
      })

      /**
       * @param {{ status?: Record<string, unknown> } | null | undefined} message
       * @returns {string}
       */
      const formatLegacyStatusFields = (message) => {
        const status = message?.status
        if (!status || typeof status !== 'object') return ''
        const fields = Object.keys(status)
        if (!fields.length) return ''
        const preview = fields.slice(0, 8).join(', ')
        const suffix = fields.length > 8 ? `, +${fields.length - 8} more` : ''
        return ` fields: ${preview}${suffix}`
      }

      listeners.on('statusUpdate', ({ deviceId, source, changedFields }) => {
        const label = this.formatDeviceLabel(deviceId)
        const fields = Array.from(changedFields).join(', ')
        this.log.debug(`Status update [${label} ${source}]: ${fields}`)
      })

      listeners.on('configUpdate', ({ deviceId, changedFields }) => {
        const label = this.formatDeviceLabel(deviceId)
        const fields = Array.from(changedFields).join(', ')
        this.log.debug(`Config update [${label}]: ${fields}`)
      })

      listeners.on('playbackUpdate', ({ deviceId, changedFields }) => {
        const label = this.formatDeviceLabel(deviceId)
        const fields = Array.from(changedFields).join(', ')
        this.log.debug(`Playback update [${label}]: ${fields}`)
      })

      listeners.on('mqttConnect', ({ deviceId }) => {
        const label = this.formatDeviceLabel(deviceId)
        this.log.debug(`MQTT connected: ${label}`)
      })

      listeners.on('mqttDisconnect', ({ deviceId, metadata }) => {
        const label = this.formatDeviceLabel(deviceId)
        const reasonCode = metadata?.packet?.reasonCode
        const reason = typeof reasonCode === 'number' ? ` (code ${reasonCode})` : ''
        this.log.warn(`MQTT disconnected: ${label}${reason}`)
      })

      listeners.on('mqttClose', ({ deviceId, metadata }) => {
        const label = this.formatDeviceLabel(deviceId)
        const reason = metadata?.reason ? ` (${metadata.reason})` : ''
        this.log.debug(`MQTT closed: ${label}${reason}`)
      })

      listeners.on('mqttReconnect', ({ deviceId }) => {
        const label = this.formatDeviceLabel(deviceId)
        this.log.debug(`MQTT reconnecting: ${label}`)
      })

      listeners.on('mqttOffline', ({ deviceId }) => {
        const label = this.formatDeviceLabel(deviceId)
        this.log.debug(`MQTT offline: ${label}`)
      })

      listeners.on('mqttEnd', ({ deviceId }) => {
        const label = this.formatDeviceLabel(deviceId)
        this.log.debug(`MQTT ended: ${label}`)
      })

      listeners.on('mqttStatus', ({ deviceId, topic }) => {
        const label = this.formatDeviceLabel(deviceId)
        this.log.debug(`MQTT status [${label}]: ${topic}`)
      })

      listeners.on('mqttEvents', ({ deviceId, topic }) => {
        const label = this.formatDeviceLabel(deviceId)
        this.log.debug(`MQTT events [${label}]: ${topic}`)
      })

      listeners.on('mqttStatusLegacy', ({ deviceId, topic, message }) => {
        const label = this.formatDeviceLabel(deviceId)
        const fields = formatLegacyStatusFields(message)
        this.log.debug(`MQTT legacy status [${label}]: ${topic}${fields}`)
      })

      listeners.on('mqttResponse', ({ deviceId, topic, message }) => {
        const label = this.formatDeviceLabel(deviceId)
        let payload = ''
        try {
          payload = message ? ` ${JSON.stringify(message)}` : ''
        } catch {
          payload = ' [unserializable message]'
        }
        this.log.debug(`MQTT response [${label}]: ${topic}${payload}`)
      })

      listeners.on('mqttUnknown', ({ deviceId, topic }) => {
        const label = this.formatDeviceLabel(deviceId)
        this.log.debug(`MQTT unknown [${label}]: ${topic}`)
      })

      await this.connectAccount()
    } catch (error) {
      this.log.error('Failed to start account:', errorMessage(error))
    }
  }

  /**
   * Start the account (discovers devices, creates device models, starts MQTT).
   * If the Yoto API can't be reached, e.g. because the network isn't up yet
   * when Homebridge boots, retry with backoff instead of giving up. Errors that
   * a retry won't fix (an invalid login, other 4xx responses) are logged once.
   * @returns {Promise<void>}
   */
  async connectAccount () {
    const account = this.yotoAccount
    if (!account || this.shuttingDown) return

    try {
      await account.start()
    } catch (error) {
      // Homebridge shut down while the account was starting
      if (this.shuttingDown) return
      if (this.authInvalid) {
        this.log.error('Failed to start account:', errorMessage(error))
        return
      }
      const statusCode = getStatusCode(error)
      if (statusCode === 401 || statusCode === 403) {
        this.log.error(
          `Yoto rejected the saved login (HTTP ${statusCode}). Open the plugin settings in the Homebridge UI and sign in again.`,
          formatError(error)
        )
        this.handleLoginProblem(`Yoto rejected the saved login (HTTP ${statusCode}): ${errorMessage(error)}`)
        return
      }
      if (!isRetryableStartError(error)) {
        this.log.error('Failed to start account:', formatError(error))
        return
      }
      const delayMs = Math.min(START_RETRY_MAX_MS, START_RETRY_BASE_MS * 2 ** this.startRetryCount)
      this.startRetryCount++
      this.log.warn(`Could not connect to Yoto (${errorMessage(error)}). Retrying in ${Math.round(delayMs / 1000)} seconds.`)
      this.startRetryTimer = setTimeout(() => {
        this.startRetryTimer = null
        this.connectAccount().catch(retryError => {
          this.log.error('Failed to start account:', formatError(retryError))
        })
      }, delayMs)
      return
    }

    // Homebridge shut down while the account was starting. shutdown()'s stop() ran
    // before start() finished, so stop the device models and MQTT start() just opened.
    if (this.shuttingDown) {
      await account.stop()
      return
    }

    this.startRetryCount = 0

    // YotoAccount.start() swallows device start errors, so the login can be
    // rejected during a start that still resolves
    if (this.authInvalid) {
      await account.stop()
      this.markAccessoriesUnreachable()
      return
    }

    this.log.info(`✓ Yoto account started with ${account.devices.size} device(s)`)
    const storagePath = this.getStoragePath()
    if (storagePath) {
      clearLoginProblem(storagePath, this.config['refreshToken']).catch(error => {
        this.log.debug('Could not clear the recorded login problem:', errorMessage(error))
      })
    }
    this.log.debug(
      'Account devices:',
      Array.from(account.devices.keys()).join(', ') || 'none'
    )

    // Remove stale accessories after all devices are registered
    this.removeStaleAccessories()

    this.log.debug('Registering card control accessories (playOnAll).')
    await this.registerCardControlAccessories()
  }

  /**
   * @param {string} deviceId
   * @returns {string}
   */
  formatDeviceLabel (deviceId) {
    const deviceName = this.yotoAccount?.getDevice(deviceId)?.device?.name
    if (deviceName && deviceName !== deviceId) {
      return `${deviceName} (${deviceId})`
    }
    return deviceId
  }

  /**
   * Look up a card's title from the Yoto content API (cached per runtime).
   * Resolves to null when the title can't be fetched.
   * @param {string} cardId
   * @returns {Promise<string | null>}
   */
  getCardTitle (cardId) {
    const cached = this.cardTitleCache.get(cardId)
    if (cached) return cached

    const client = this.yotoAccount?.client
    if (!client) return Promise.resolve(null)

    const lookup = fetchCardDetails(client, cardId)
      .then(response => response.card?.title?.trim() || null)
      .catch(error => {
        const statusCode = error && typeof error === 'object' && 'statusCode' in error ? error.statusCode : undefined
        this.log.debug(`Could not look up title for card ${cardId}${statusCode ? ` (HTTP ${statusCode})` : ''}`)
        // Forbidden cards (e.g. Yoto system cards) stay unresolved; retry anything else later
        if (statusCode !== 403) this.cardTitleCache.delete(cardId)
        return null
      })
    this.cardTitleCache.set(cardId, lookup)
    return lookup
  }

  /**
   * Cards in the family library (Make Your Own cards included), for TV inputs.
   * Cached briefly. Rejects if the library can't be read, so callers keep the
   * inputs they have; a failure isn't cached.
   * @returns {Promise<LibraryCard[]>}
   */
  getLibraryCards () {
    const now = Date.now()
    if (this.libraryCache && now - this.libraryCache.fetchedAt < LIBRARY_CACHE_MS) {
      return this.libraryCache.cards
    }

    const client = this.yotoAccount?.client
    if (!client) return Promise.reject(new Error('Not signed in to Yoto'))

    const cards = fetchFamilyLibrary(client).then(cards => {
      for (const card of cards) {
        if (!this.cardTitleCache.has(card.cardId)) {
          this.cardTitleCache.set(card.cardId, Promise.resolve(card.title))
        }
      }
      this.log.debug(`Loaded ${cards.length} library card(s) for TV inputs`)
      return cards
    })
    cards.catch(error => {
      if (this.libraryCache?.cards === cards) this.libraryCache = null
      this.log.warn(`Could not load the Yoto card library for TV inputs (${errorMessage(error)}).`)
    })
    this.libraryCache = { fetchedAt: now, cards }
    return cards
  }

  /**
   * @param {string} deviceId
   * @returns {string}
   */
  getSpeakerAccessoryUuid (deviceId) {
    return this.api.hap.uuid.generate(`${deviceId}:speaker`)
  }

  /**
   * @param {YotoDevice} device
   * @returns {string}
   */
  getSpeakerAccessoryName (device) {
    const rawName = `${device.name} Speaker`
    return sanitizeName(rawName) || `${device.deviceId} Speaker`
  }

  /**
   * @param {string} deviceId
   * @returns {string}
   */
  getTelevisionAccessoryUuid (deviceId) {
    return this.api.hap.uuid.generate(`${deviceId}:playback`)
  }

  /**
   * @param {YotoDevice} device
   * @returns {string}
   */
  getTelevisionAccessoryName (device) {
    const rawName = `${device.name} Playback`
    return sanitizeName(rawName) || `${device.deviceId} Playback`
  }

  /**
   * @param {CardControlConfig} control
   * @returns {string}
   */
  getCardControlAccessoryUuid (control) {
    return this.api.hap.uuid.generate(`card-control:${control.id}`)
  }

  /**
   * @param {CardControlConfig} control
   * @returns {string}
   */
  getCardControlAccessoryName (control) {
    const rawName = `${control.label} (All Yotos)`
    return sanitizeName(rawName) || `${control.cardId} (All Yotos)`
  }

  /**
   * Register a device as a platform accessory
   * @param {YotoDevice} device - Device to register
   * @param {YotoDeviceModel} deviceModel - Device model instance
   * @returns {Promise<{ success: boolean }>} Object indicating if registration succeeded
   */
  async registerDevice (device, deviceModel) {
    // Generate UUID for this device
    const uuid = this.api.hap.uuid.generate(device.deviceId)
    const sanitizedDeviceName = sanitizeName(device.name)
    const accessoryCategory = this.api.hap.Categories.SPEAKER
    this.log.debug(
      'Register device:',
      `${device.name} (${device.deviceId})`,
      `uuid=${uuid}`,
      `category=${accessoryCategory}`
    )

    // Stop any handler left over from a previous registration of this device
    await this.stopHandler(this.accessoryHandlers, uuid, 'device')

    // Check if accessory already exists
    const existingAccessory = this.accessories.get(uuid)

    if (existingAccessory) {
      // Accessory exists - update it
      this.log.debug('Restoring existing accessory from cache:', device.name, existingAccessory.UUID)

      // Update display name if it has changed
      if (existingAccessory.displayName !== sanitizedDeviceName) {
        this.log.debug('Updating accessory display name:', existingAccessory.displayName, '->', sanitizedDeviceName)
        existingAccessory.updateDisplayName(sanitizedDeviceName)
      }

      // Update context with fresh device data
      existingAccessory.context = {
        ...existingAccessory.context,
        type: 'device',
        device,
      }

      // Ensure category matches our current service model
      if (existingAccessory.category !== accessoryCategory) {
        existingAccessory.category = accessoryCategory
      }

      // Create handler for this accessory with device model
      const handler = new YotoPlayerAccessory({
        platform: this,
        accessory: existingAccessory,
        deviceModel,
      })

      // Track handler
      this.accessoryHandlers.set(uuid, handler)
      this.log.debug('Created accessory handler:', existingAccessory.displayName, uuid)

      // Initialize accessory (setup services and event listeners)
      await handler.setup()
      this.log.debug('Accessory setup complete:', existingAccessory.displayName)

      // Save the cache after setup, so services it added or removed (e.g. the
      // old sleep timer Switch) are kept on the next start
      this.api.updatePlatformAccessories([existingAccessory])
      this.log.debug('Updated accessory cache entry:', existingAccessory.displayName, existingAccessory.UUID)

      if (this.playbackAccessoryConfig.smartSpeakerEnabled) {
        await this.registerSpeakerAccessory(device, deviceModel)
      }

      if (this.playbackAccessoryConfig.televisionEnabled) {
        await this.registerTelevisionAccessory(device, deviceModel)
      }

      return { success: true }
    } else {
      // Create new accessory
      this.log.debug('Adding new accessory:', device.name, uuid)

      // Create platform accessory
      /** @type {PlatformAccessory<YotoAccessoryContext>} */
      // eslint-disable-next-line new-cap
      const accessory = new this.api.platformAccessory(sanitizedDeviceName, uuid, accessoryCategory)

      // Set accessory context
      accessory.context = {
        type: 'device',
        device,
      }

      // Create handler for this accessory with device model
      const handler = new YotoPlayerAccessory({
        platform: this,
        accessory,
        deviceModel,
      })

      // Track handler
      this.accessoryHandlers.set(uuid, handler)
      this.log.debug('Created accessory handler:', device.name, uuid)

      // Initialize accessory (setup services and event listeners)
      await handler.setup()
      this.log.debug('Accessory setup complete:', device.name)

      // Register as a platform accessory (bridged).
      this.log.debug(`Registering new accessory: ${device.name}`)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.log.debug('Registered platform accessory:', device.name, uuid)

      if (this.playbackAccessoryConfig.smartSpeakerEnabled) {
        await this.registerSpeakerAccessory(device, deviceModel)
      }

      if (this.playbackAccessoryConfig.televisionEnabled) {
        await this.registerTelevisionAccessory(device, deviceModel)
      }

      // Add to our tracking map (cast to typed version)
      this.accessories.set(uuid, accessory)
      this.log.debug('Tracked new accessory:', device.name, uuid)

      return { success: true }
    }
  }

  /**
   * Register a device as an external SmartSpeaker accessory
   * @param {YotoDevice} device - Device to register
   * @param {YotoDeviceModel} deviceModel - Device model instance
   * @returns {Promise<{ success: boolean }>} Object indicating if registration succeeded
   */
  async registerSpeakerAccessory (device, deviceModel) {
    const uuid = this.getSpeakerAccessoryUuid(device.deviceId)
    const speakerName = this.getSpeakerAccessoryName(device)
    const publishedAccessory = this.speakerAccessories.get(uuid)
    if (publishedAccessory) {
      // External accessories can only be published once per runtime, so
      // re-attach a fresh handler for the (possibly new) device model.
      this.log.debug('SmartSpeaker accessory already published, re-attaching handler:', speakerName, uuid)
      await this.stopHandler(this.speakerAccessoryHandlers, uuid, 'SmartSpeaker')
      publishedAccessory.context = { device }
      const handler = new YotoSpeakerAccessory({
        platform: this,
        accessory: publishedAccessory,
        deviceModel,
      })
      this.speakerAccessoryHandlers.set(uuid, handler)
      await handler.setup()
      return { success: true }
    }

    this.log.info('Adding new SmartSpeaker accessory:', speakerName)
    this.log.debug('Creating SmartSpeaker accessory:', speakerName, uuid)

    /** @type {PlatformAccessory<YotoAccessoryContext>} */
    // eslint-disable-next-line new-cap
    const accessory = new this.api.platformAccessory(
      speakerName,
      uuid,
      this.api.hap.Categories.SPEAKER
    )

    accessory.context = {
      device,
    }

    const handler = new YotoSpeakerAccessory({
      platform: this,
      accessory,
      deviceModel,
    })

    this.speakerAccessoryHandlers.set(uuid, handler)
    this.log.debug('Created SmartSpeaker handler:', speakerName, uuid)

    await handler.setup()
    this.log.debug('SmartSpeaker setup complete:', speakerName)

    this.log.info(`Publishing external SmartSpeaker accessory: ${speakerName}`)
    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory])
    this.log.debug('Published external SmartSpeaker accessory:', speakerName, uuid)

    this.speakerAccessories.set(uuid, accessory)

    return { success: true }
  }

  /**
   * Register a device as an external Television accessory
   * @param {YotoDevice} device - Device to register
   * @param {YotoDeviceModel} deviceModel - Device model instance
   * @returns {Promise<{ success: boolean }>} Object indicating if registration succeeded
   */
  async registerTelevisionAccessory (device, deviceModel) {
    const uuid = this.getTelevisionAccessoryUuid(device.deviceId)
    const playbackName = this.getTelevisionAccessoryName(device)
    const publishedAccessory = this.televisionAccessories.get(uuid)
    if (publishedAccessory) {
      // External accessories can only be published once per runtime, so
      // re-attach a fresh handler for the (possibly new) device model.
      this.log.debug('Television playback accessory already published, re-attaching handler:', playbackName, uuid)
      await this.stopHandler(this.televisionAccessoryHandlers, uuid, 'Television playback')
      publishedAccessory.context = { device }
      const handler = new YotoTelevisionAccessory({
        platform: this,
        accessory: publishedAccessory,
        deviceModel,
      })
      this.televisionAccessoryHandlers.set(uuid, handler)
      await handler.setup()
      return { success: true }
    }

    this.log.info('Adding new Television playback accessory:', playbackName)
    this.log.debug('Creating Television playback accessory:', playbackName, uuid)

    /** @type {PlatformAccessory<YotoAccessoryContext>} */
    // eslint-disable-next-line new-cap
    const accessory = new this.api.platformAccessory(
      playbackName,
      uuid,
      this.api.hap.Categories.TELEVISION
    )

    accessory.context = {
      device,
    }

    const handler = new YotoTelevisionAccessory({
      platform: this,
      accessory,
      deviceModel,
    })

    this.televisionAccessoryHandlers.set(uuid, handler)
    this.log.debug('Created Television playback handler:', playbackName, uuid)

    await handler.setup()
    this.log.debug('Television playback setup complete:', playbackName)

    this.log.info(`Publishing external Television playback accessory: ${playbackName}`)
    this.api.publishExternalAccessories(PLUGIN_NAME, [accessory])
    this.log.debug('Published external Television playback accessory:', playbackName, uuid)

    this.televisionAccessories.set(uuid, accessory)

    return { success: true }
  }

  /**
   * Register or update card control accessories that target all devices.
   * @returns {Promise<void>}
   */
  async registerCardControlAccessories () {
    const cardControls = getCardControlConfigs(this.config).filter(control => control.playOnAll)
    const desiredUuids = new Set()
    this.log.debug('Card control configs (playOnAll):', cardControls.length)

    for (const control of cardControls) {
      const uuid = this.getCardControlAccessoryUuid(control)
      const accessoryName = this.getCardControlAccessoryName(control)
      desiredUuids.add(uuid)
      this.log.debug('Ensuring card control accessory:', accessoryName, uuid)

      const existingAccessory = this.cardAccessories.get(uuid)
      if (existingAccessory) {
        this.log.debug('Restoring existing card control accessory from cache:', accessoryName, uuid)

        if (existingAccessory.displayName !== accessoryName) {
          this.log.debug('Updating card control display name:', existingAccessory.displayName, '->', accessoryName)
          existingAccessory.updateDisplayName(accessoryName)
        }

        existingAccessory.context = {
          type: 'card-control',
          cardControl: control,
        }

        this.api.updatePlatformAccessories([existingAccessory])
        this.log.debug('Updated card control cache entry:', existingAccessory.displayName, uuid)

        const existingHandler = this.cardAccessoryHandlers.get(uuid)
        if (existingHandler) {
          await existingHandler.stop().catch(error => {
            this.log.error(`Failed to stop card control handler for ${existingAccessory.displayName}:`, error)
          })
          this.cardAccessoryHandlers.delete(uuid)
        }

        const handler = new YotoCardControlAccessory({
          platform: this,
          accessory: existingAccessory,
          cardControl: control,
        })

        this.cardAccessoryHandlers.set(uuid, handler)
        await handler.setup()
        this.log.debug('Card control setup complete:', accessoryName)
        continue
      }

      this.log.debug('Adding new card control accessory:', accessoryName, uuid)

      /** @type {PlatformAccessory<YotoCardAccessoryContext>} */
      // eslint-disable-next-line new-cap
      const accessory = new this.api.platformAccessory(
        accessoryName,
        uuid,
        this.api.hap.Categories.SWITCH
      )

      accessory.context = {
        type: 'card-control',
        cardControl: control,
      }

      const handler = new YotoCardControlAccessory({
        platform: this,
        accessory,
        cardControl: control,
      })

      this.cardAccessoryHandlers.set(uuid, handler)
      await handler.setup()
      this.log.debug('Card control setup complete:', accessoryName)

      this.log.debug(`Registering card control accessory: ${accessoryName}`)
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.log.debug('Registered card control accessory:', accessoryName, uuid)

      this.cardAccessories.set(uuid, accessory)
      this.log.debug('Tracked card control accessory:', accessoryName, uuid)
    }

    for (const [uuid, accessory] of this.cardAccessories) {
      if (desiredUuids.has(uuid)) {
        continue
      }

      this.log.debug('Removing card control accessory from cache:', accessory.displayName, uuid)

      const handler = this.cardAccessoryHandlers.get(uuid)
      if (handler) {
        await handler.stop().catch(error => {
          this.log.error(`Failed to stop card control handler for ${accessory.displayName}:`, error)
        })
        this.cardAccessoryHandlers.delete(uuid)
      }

      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      this.cardAccessories.delete(uuid)
      this.log.debug('Removed card control accessory:', accessory.displayName, uuid)
    }
  }

  /**
   * Remove accessories that are no longer present in the account
   */
  removeStaleAccessories () {
    if (!this.yotoAccount) {
      return
    }

    // Get current device IDs from account
    const currentDeviceIds = this.yotoAccount.getDeviceIds()
    const currentUUIDs = currentDeviceIds.map(id => this.api.hap.uuid.generate(id))
    this.log.debug(
      'Evaluating stale accessories:',
      `accountDevices=${currentDeviceIds.length}`,
      `cachedAccessories=${this.accessories.size}`,
      `externalSpeakers=${this.speakerAccessories.size}`,
      `externalPlayback=${this.televisionAccessories.size}`
    )

    for (const [uuid, accessory] of this.accessories) {
      if (!currentUUIDs.includes(uuid)) {
        this.log.debug('Removing existing accessory from cache:', accessory.displayName, uuid)

        // Stop handler if it exists
        const handler = this.accessoryHandlers.get(uuid)
        if (handler) {
          handler.stop().catch(error => {
            this.log.error(`Failed to stop handler for ${accessory.displayName}:`, error)
          })
          this.accessoryHandlers.delete(uuid)
        }

        // Unregister from Homebridge
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
        this.log.debug('Unregistered accessory from Homebridge:', accessory.displayName, uuid)

        // Remove from our tracking map
        this.accessories.delete(uuid)
        this.log.debug('Removed accessory from tracking map:', accessory.displayName, uuid)
      }
    }

    for (const [uuid, accessory] of this.speakerAccessories) {
      const deviceId = accessory.context.device?.deviceId
      if (!deviceId || !currentDeviceIds.includes(deviceId)) {
        const handler = this.speakerAccessoryHandlers.get(uuid)
        if (handler) {
          handler.stop().catch(error => {
            this.log.error(`Failed to stop SmartSpeaker handler for ${accessory.displayName}:`, error)
          })
          this.speakerAccessoryHandlers.delete(uuid)
          // Homebridge has no API to unpublish external accessories. Keep it tracked so
          // it is re-used if the device comes back; it disappears after a restart.
          this.log.warn(`${accessory.displayName} is no longer in your Yoto account. Remove it from the Home app manually.`)
        }
      }
    }

    for (const [uuid, accessory] of this.televisionAccessories) {
      const deviceId = accessory.context.device?.deviceId
      if (!deviceId || !currentDeviceIds.includes(deviceId)) {
        const handler = this.televisionAccessoryHandlers.get(uuid)
        if (handler) {
          handler.stop().catch(error => {
            this.log.error(`Failed to stop Television playback handler for ${accessory.displayName}:`, error)
          })
          this.televisionAccessoryHandlers.delete(uuid)
          // Homebridge has no API to unpublish external accessories. Keep it tracked so
          // it is re-used if the device comes back; it disappears after a restart.
          this.log.warn(`${accessory.displayName} is no longer in your Yoto account. Remove it from the Home app manually.`)
        }
      }
    }
  }

  /**
   * Stop and forget a tracked handler, if one exists.
   * @param {Map<string, { stop: () => Promise<void> }>} handlers
   * @param {string} uuid
   * @param {string} label
   * @returns {Promise<void>}
   */
  async stopHandler (handlers, uuid, label) {
    const handler = handlers.get(uuid)
    if (!handler) return
    handlers.delete(uuid)
    await handler.stop().catch(error => {
      this.log.error(`Failed to stop ${label} handler for ${uuid}:`, error)
    })
  }

  /**
   * Shutdown platform - cleanup all handlers and stop account
   */
  async shutdown () {
    this.log.debug('Shutting down Yoto platform...')
    this.shuttingDown = true
    await this.nativeControls?.stop()
    this.nativeControls = null
    this.mediaRemoteBridge?.close()
    this.mediaRemoteBridge?.closeAllConnections()
    this.mediaRemoteBridge = null
    if (this.startRetryTimer) {
      clearTimeout(this.startRetryTimer)
      this.startRetryTimer = null
    }
    this.log.debug(
      'Handlers to stop:',
      `devices=${this.accessoryHandlers.size}`,
      `speakers=${this.speakerAccessoryHandlers.size}`,
      `televisions=${this.televisionAccessoryHandlers.size}`,
      `cardControls=${this.cardAccessoryHandlers.size}`
    )

    // Stop all accessory handlers
    const stopPromises = []
    for (const [uuid, handler] of this.accessoryHandlers) {
      stopPromises.push(
        handler.stop().catch(error => {
          this.log.error(`Failed to stop handler for ${uuid}:`, error)
        })
      )
    }
    for (const [uuid, handler] of this.speakerAccessoryHandlers) {
      stopPromises.push(
        handler.stop().catch(error => {
          this.log.error(`Failed to stop SmartSpeaker handler for ${uuid}:`, error)
        })
      )
    }
    for (const [uuid, handler] of this.televisionAccessoryHandlers) {
      stopPromises.push(
        handler.stop().catch(error => {
          this.log.error(`Failed to stop Television playback handler for ${uuid}:`, error)
        })
      )
    }
    for (const [uuid, handler] of this.cardAccessoryHandlers) {
      stopPromises.push(
        handler.stop().catch(error => {
          this.log.error(`Failed to stop card control handler for ${uuid}:`, error)
        })
      )
    }

    // Wait for all handlers to cleanup
    await Promise.all(stopPromises)
    this.accessoryHandlers.clear()
    this.speakerAccessoryHandlers.clear()
    this.televisionAccessoryHandlers.clear()
    this.cardAccessoryHandlers.clear()
    this.speakerAccessories.clear()
    this.televisionAccessories.clear()
    this.cardAccessories.clear()

    // Stop the YotoAccount (disconnects all device models and MQTT)
    if (this.yotoAccount) {
      await this.yotoAccount.stop()
      this.yotoAccount = null
    }

    this.log.debug('✓ Yoto platform shutdown complete')
  }

  /**
   * Save tokens the client just refreshed. Yoto's refresh tokens are single-use,
   * so a refreshed login that isn't saved is lost on the next restart.
   * @param {RefreshSuccessEvent} event
   * @returns {Promise<void>}
   */
  async saveRefreshedTokens ({ clientId, updatedAccessToken, updatedRefreshToken, updatedExpiresAt, prevAccessToken, prevRefreshToken }) {
    // Client reports expiry in seconds; config.json stores milliseconds (matches the UI)
    const tokenExpiresAt = updatedExpiresAt * 1000
    this.log.debug('Access token refreshed, expires at:', new Date(tokenExpiresAt).toISOString())

    // Keep the in-memory config in sync so later reads see current tokens
    this.config['accessToken'] = updatedAccessToken
    this.config['refreshToken'] = updatedRefreshToken
    this.config['tokenExpiresAt'] = tokenExpiresAt

    const saved = await this.updateHomebridgeConfig((configContents) => applyTokenUpdate(configContents, {
      platform: PLATFORM_NAME,
      accessToken: updatedAccessToken,
      refreshToken: updatedRefreshToken,
      tokenExpiresAt,
      prevAccessToken,
      prevRefreshToken,
      clientId,
    }))
    if (saved) {
      this.log.info(`Refreshed the Yoto login and saved it to config.json. It's valid until ${new Date(tokenExpiresAt).toLocaleString()} and is refreshed shortly before then.`)
    }
  }

  /**
   * The saved Yoto login no longer works. Record it for the settings UI, and make
   * the accessories show "Not Responding" instead of their last known state.
   * @param {string} message - What went wrong, shown in the settings UI
   */
  handleLoginProblem (message) {
    this.authInvalid = true
    this.markAccessoriesUnreachable()
    // Stop polling and MQTT: every call would fail until a restart, and pushed
    // updates would refresh tiles that should read Not Responding
    this.yotoAccount?.stop().catch(error => {
      this.log.debug('Could not stop the Yoto account:', errorMessage(error))
    })

    const storagePath = this.getStoragePath()
    if (!storagePath) return
    writeLoginProblem(storagePath, { message, refreshToken: this.config['refreshToken'] }).catch(error => {
      this.log.debug('Could not record the login problem for the settings UI:', errorMessage(error))
    })
  }

  /**
   * Show every accessory this platform knows of as "Not Responding" in HomeKit.
   * Cached accessories are only known once Homebridge has finished launching,
   * so before then this waits for it.
   */
  markAccessoriesUnreachable () {
    if (!this.launched) {
      if (!this.markOnLaunch) {
        this.markOnLaunch = true
        this.api.on('didFinishLaunching', () => {
          this.launched = true
          this.markAccessoriesUnreachable()
        })
      }
      return
    }

    const accessories = [
      ...this.accessories.values(),
      ...this.cardAccessories.values(),
      ...this.speakerAccessories.values(),
      ...this.televisionAccessories.values(),
    ]
    if (!accessories.length) return
    for (const accessory of accessories) {
      markAccessoryUnreachable(accessory, this.api.hap)
    }
    this.log.warn(`The Home app will show ${accessories.length} Yoto accessory(s) as Not Responding until you sign in again and restart the child bridge.`)
  }

  /**
   * Homebridge's storage folder, or null if it isn't known
   * @returns {string | null}
   */
  getStoragePath () {
    try {
      return this.api.user.storagePath()
    } catch {
      return null
    }
  }

  /**
   * Replace the tokens in `config` with newer ones saved in config.json, if any.
   * @param {PlatformConfig} config
   */
  useNewerSavedTokens (config) {
    try {
      const bridge = config['_bridge']
      const bridgeUsername = bridge && typeof bridge === 'object' && typeof bridge.username === 'string'
        ? bridge.username
        : undefined
      const saved = findNewerSavedTokens(readFileSync(this.api.user.configPath(), 'utf8'), {
        platform: PLATFORM_NAME,
        ...(bridgeUsername && { bridgeUsername }),
        refreshToken: config['refreshToken'],
        tokenExpiresAt: config['tokenExpiresAt'],
      })
      if (!saved) return
      this.log.debug('Using the newer tokens saved in config.json')
      Object.assign(config, saved)
    } catch (error) {
      this.log.debug('Could not read saved tokens from config.json:', errorMessage(error))
    }
  }

  /**
   * Update Homebridge config.json file
   * @param {(configContents: string) => string | null} updateFn - Returns updated contents, or null if it could not apply the update
   * @returns {Promise<boolean>} Whether config.json was updated
   */
  async updateHomebridgeConfig (updateFn) {
    const configPath = this.api.user.configPath()

    try {
      const configContents = await readFile(configPath, 'utf8')
      const updatedContents = updateFn(configContents)
      if (updatedContents === null) {
        this.log.warn(`Did not save refreshed tokens: no ${PLATFORM_NAME} platform block in ${configPath} holds the current tokens. If you signed in again or logged out in the plugin settings, restart Homebridge to use the new settings.`)
        return false
      }
      // Write to a temp file and rename so a crash mid-write cannot corrupt config.json.
      // Keep the original file mode, since config.json holds tokens.
      const { mode } = await stat(configPath)
      const tmpPath = `${configPath}.${process.pid}.tmp`
      try {
        await writeFile(tmpPath, updatedContents, { encoding: 'utf8', mode: mode & 0o777 })
      } catch (writeError) {
        // Don't leave a partial copy of the tokens next to config.json
        await unlink(tmpPath).catch(() => {})
        throw writeError
      }
      try {
        await rename(tmpPath, configPath)
      } catch (renameError) {
        // e.g. config.json is a single-file bind mount (EBUSY); write it in place instead
        await unlink(tmpPath).catch(() => {})
        this.log.debug('Could not replace config.json atomically, writing in place:', formatError(renameError))
        await writeFile(configPath, updatedContents, 'utf8')
      }
      this.log.debug('Updated config.json with new tokens')
      return true
    } catch (error) {
      this.log.error(`Failed to update config.json at ${configPath}. Refreshed tokens may not persist:`, errorMessage(error))
      return false
    }
  }
}
