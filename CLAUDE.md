# CLAUDE.md

Homebridge platform plugin (`@mdjhnson/homebridge-yoto`) that exposes Yoto players to HomeKit. It is a maintained fork of `bcomnes/homebridge-yoto`, built on `yoto-nodejs-client` (also by bcomnes, and effectively unmaintained).

Code conventions (JSDoc types, `@import`, exhaustive switches, no `any`) are in @AGENTS.md. Feature and service status is tracked in `PLAN.md`.

## GitHub: work in the fork only

- All development happens in the fork `mdjhnson/homebridge-yoto` (`origin`). Don't check, open PRs on, comment on or push to the upstream `bcomnes/homebridge-yoto` (`upstream` remote).
- `gh` may resolve to upstream by default. Pass `--repo mdjhnson/homebridge-yoto` (or use `gh api repos/mdjhnson/homebridge-yoto/...`) on every `gh` command.

## Commands

```sh
npm install
npm test              # eslint + tsc + node:test with c8 coverage (run before every commit)
npx tsc               # typecheck only
npx eslint            # lint only
node --test lib/foo.test.js
```

- Plain ESM JavaScript. There is no build step, and `tsc` only type-checks.
- Node 22, 24 or 26 (the `engines` range). CI tests all three.
- Tests sit next to the source as `*.test.js` and are excluded from the package via `files` in `package.json`.

## Layout

- `index.js`: registers the `Yoto` platform.
- `lib/platform.js`: `YotoPlatform`.
  - Creates the `YotoAccount`, persists refreshed tokens and registers accessories.
  - External accessories (SmartSpeaker, TV) are published once per runtime; a handler is re-attached if the player reconnects.
  - `getCardTitle()` is a cached card-title lookup. `getLibraryCards()` returns the family library (which includes Make Your Own cards), cached for 10 minutes. It rejects on failure rather than returning `[]`, so the TV keeps its inputs, and a failure isn't cached.
- **One handler class per accessory type:**
  - `lib/accessory.js`: the bridged player, with most services.
  - `lib/speaker-accessory.js`: the external SmartSpeaker. It's a legacy option under **Advanced** in settings, because the Home app can't control non-AirPlay speakers; point users to the TV accessory.
  - `lib/television-accessory.js`: the external TV. Its inputs are "now playing", then card controls, shortcuts and library cards (capped at 90 inputs). `DisplayOrder` lists them alphabetically, and identifiers are hashed from the input subtype and kept by inputs that already exist, so scenes survive library changes. Until its first library load, a re-attached handler keeps the library inputs already published.
  - `lib/card-control-accessory.js`: "Play on All Yotos".
- **Config readers:**
  - `lib/card-controls.js`: card controls, plus the shared `PlayableCard` type.
  - `lib/service-config.js`: service toggles, plus the TV library toggle and the sleep timer minutes per 1%.
  - `lib/shortcuts.js`: parses device shortcuts, names the built-in ones, resolves date placeholders.
- `lib/utils/`: small pure helpers (volume and sleep timer maths, OAuth/PKCE, token config rewrite, listener tracking, status-scope fallback, family library fetch, TV input identifiers and display order, login status file, marking accessories unreachable). Put new testable logic here.
- `homebridge-ui/`: the custom settings UI.
  - `server.js` runs in the Homebridge UI process and handles the OAuth start/exchange. `/auth/status` reports a login the plugin found dead (below).
  - `public/client.js` and `public/index.html` run in the browser.
  - `public/logo.png` (256×256) is the only copy of the logo. The README links to it on GitHub. The icon on homebridge/plugins is a separate 100×100 upload.
- **Schema:**
  - `config.schema.json` holds the settings schema and layout.
  - `config.schema.cjs` just re-exports it for typed access (`serviceSchema`).
  - A new service toggle goes in both the schema `properties` and the `layout`.
  - Homebridge verification checks the schema: `required` must be an array on the object (`"required": ["label", "cardId"]`), never `true`/`false` on a property, and the `name` property must stay. `index.test.js` compiles the schema with AJV (as the checks do) and checks for `name`.

## Yoto API gotchas (verified on real players, Sept 2026)

- **Sign-in is Authorization Code + PKCE, not device code.** Yoto retired the `device_code` grant for new apps.
  - The redirect URI is `http://127.0.0.1:8787/callback`. Nothing listens there: the user pastes the resulting address back into the UI.
  - The PKCE verifier stays in `homebridge-ui/server.js`.
  - Old client ID `Y4HJ8BFq…` (upstream's app) is in `LEGACY_CLIENT_IDS` and is replaced with the default on sign-in.
- **Refresh with the client ID the tokens were issued to.** Yoto rejects a refresh token sent with another client ID (403 `invalid_grant`, "The client associated with this refresh token … is different"). The settings form can save a stale `clientId` back after signing in, so the platform reads the access token's `azp` claim (`lib/utils/token-client-id.js`) and uses that, falling back to `config.clientId`.
- **Child bridges can start with stale tokens.** Homebridge hands a child bridge the config it read at startup, and reuses it when the child restarts after its process exits (only a restart from the UI re-reads config.json). After a token refresh that copy holds a rotated refresh token, and Yoto answers `invalid_grant - Unknown or invalid refresh token`; reusing one may also revoke the newer tokens. `useNewerSavedTokens()` in the platform reads config.json at startup and takes newer tokens from it.
- **A dead login must be visible.** Saved tokens aren't proof that the login works. When Yoto rejects it (`invalid_grant` on refresh, 401/403 at start, or a malformed saved token), `handleLoginProblem()` in the platform does two things:
  - It writes `yoto-login-status.json` to the Homebridge storage folder (`lib/utils/login-status.js`), holding a fingerprint of the refresh token, never the token. The settings UI shows "Yoto login expired" when the fingerprint matches the refresh token it has; a new sign-in doesn't match, so it clears itself. A successful start deletes the file.
  - It replaces every accessory's get/set handlers with `SERVICE_COMMUNICATION_FAILURE` (`lib/utils/unreachable.js`), so Home shows "Not Responding" instead of stale tiles. Signed out (no tokens), cached accessories get the same treatment once Homebridge finishes launching.
- **Refreshes are logged at info** ("Refreshing the Yoto login...", then "...saved it to config.json"), so a refresh cut short or not saved shows in the normal log. Refresh tokens are single-use: an unsaved refresh is lost on the next restart.
- **The settings form keeps values the client deletes.** `delete config.clientId` in `client.js` didn't reach the saved config: the form saved back the value it loaded. Set values explicitly instead. Token saves (`applyTokenUpdate`) also replace a saved `clientId` that differs from the tokens' `azp`.
- **Scopes are per app.** `OAUTH_SCOPES` in `lib/settings.js` must match the scopes enabled on the Yoto developer app (`tpc_ot5BY24FLyZoCX9MnykipB`).
  - `openid` and `profile` are not offered.
  - Adding a scope means changing both the code and the dashboard, and existing users must sign in again.
- **`GET /device-v2/:id/status` needs `family:device-status:view`,** which the dashboard does not offer.
  - The client treats that 403 as fatal and never opens MQTT.
  - `lib/utils/status-scope-fallback.js` wraps `client.getDeviceStatus` to return an empty response on that error; status still arrives via the config endpoint and MQTT.
  - Don't remove it.
- **Volume:** players take a percentage over MQTT and **floor** it to a 0–16 step. The client's `setVolume(steps)` rounds to nearest, so steps 1, 5, 9 and 13 are unreachable. Always set volume through `setDeviceVolume()` in `lib/utils/set-device-volume.js`.
- **Built-in shortcuts** live on system card `3nC80`, with chapters `daily`, `radio-day` and `radio-night`.
  - The card's title lookup returns 403, so they get fixed names.
  - Yoto Daily's track is the placeholder `<yyyymmdd>`, which must be resolved when played (`resolveShortcutKey`).
- **Family library:** `GET /card/family/library` returns `{ cards: [{ cardId, inFamilyLibrary, reason, card: { title, … } }], subscriptions }` under the existing `family:library:view` scope. It already includes Make Your Own cards (`reason: 'myo-content-add'`). yoto-nodejs-client has no method for it, so `lib/utils/library.js` calls it with `client.token.getAccessToken()`, the client's `YOTO_API_URL` and headers, a 30-second timeout, and throws `YotoAPIError` on a bad status.
- **Sleep timer:** `setSleepTimer(seconds)` takes any length and works while nothing is playing. `playback.sleepTimerSeconds` is the time left; while a timer runs the player pushes it about every 5 seconds, then sends `sleepTimerActive: false` at 0.
  - A command takes 1–3 seconds to apply, and the player keeps reporting the old state until then. `syncSleepTimerFromPlayback()` ignores reports that don't match the last command for up to 10 seconds, so the tile doesn't flick back.
- **HomeKit names** are limited to 64 characters, and some card titles are longer. Card titles also use curly apostrophes (`’`). `sanitizeName()` shortens names at a word break and turns curly quotes into straight ones; route every name through it.
- **Newer Minis** report `deviceType: 'minie'`. The client marks them unsupported, but they behave like a Mini.
- **Shortcut changes** emit `configUpdate` with no field name in `changedFields`. Compare `getShortcutsSignature()` instead.
- **Shared device model:** several accessory handlers use one `YotoDeviceModel`. Register listeners through `ListenerGroup` and never call `removeAllListeners` on the model; that removed other handlers' `error` listeners and could crash Homebridge.
- **External accessories can't be unpublished** in Homebridge. When one goes away, log a warning instead.
- **Nothing may throw out of the plugin.** Homebridge doesn't catch errors from platform constructors, async event listeners or un-awaited promises; any of them crashes Homebridge (and fails verification). Keep the try/catch around `new YotoAccount()` (it throws on a malformed saved token) and in the `deviceAdded` listener, and register listeners on both the account and the device models through a `ListenerGroup` with an error callback (`logListenerError`).
- **Startup retries:** if `account.start()` fails with a network error, 5xx, 408 or 429, `connectAccount()` retries with backoff (30 s doubling to 10 min). An invalid login, a 401/403 or any other 4xx is logged once, with no retry. `shutdown()` sets `shuttingDown`; a `start()` that finishes after it is stopped again.

## Testing

- `lib/accessories.test.js` drives the real handler classes with real HAP-NodeJS services, a stand-in `PlatformAccessory` and a fake `EventEmitter` device model. Extend it for handler behaviour, using `characteristic.handleSetRequest()` and `handleGetRequest()`.
- **Real players:** only with the user's go-ahead.
  - Sign in with the same PKCE helpers as the UI, keep tokens in the session scratchpad (never in the repo), and run Homebridge sandboxed: `node node_modules/homebridge/bin/homebridge.js -D -U <scratch dir> -P .`
  - Homebridge renames its process, so stop it by PID, not with `pkill -f`.
  - **External accessories share the real ones' identity.** The TV and SmartSpeaker UUIDs (and so their HAP IDs) come from the device ID, so a sandbox with `television` on advertises the same accessories as the user's real Homebridge on the LAN. Keep those runs short, or turn the external accessories off unless you're testing them.
  - Start the sandbox with `-I` (insecure) to read and write characteristics over HTTP (`GET /accessories`, `PUT /characteristics` with an `Authorization: <pin>` header) without pairing.
- **Never send commands to a real player** (play, pause, volume, sleep timer, Bluetooth, nightlight) without asking first. Children may be asleep next to it. Reads are fine once the user has agreed to testing.

## Releases

- Don't edit `CHANGELOG.md` by hand; `npm version` regenerates it with auto-changelog.
- **Publishing:** GitHub Actions → **npm bump** (`.github/workflows/release.yml`).
  - It uses npm trusted publishing (OIDC, `id-token: write`), with no npm token.
  - It runs `npm version`, pushes the tag, runs `npm publish`, and creates a GitHub release.
- The default branch is `master`.
- `PLUGIN_NAME` in `lib/settings.js` must equal the `package.json` `name`. `PLATFORM_NAME` stays `Yoto` for config compatibility.

### Release notes

The workflow's release body is the raw auto-changelog section (merged PRs, then commits). After a release, rewrite it in the style of Mealie's releases (e.g. [v3.28.0](https://github.com/mealie-recipes/mealie/releases/tag/v3.28.0)). The Homebridge UI shows these notes to users when they update, so write for users, not developers.

- Draft the notes, show them to the user, and only then run `gh release edit vX.Y.Z --repo mdjhnson/homebridge-yoto --notes-file <file>`. Keep the draft in the scratchpad.
- Build it from the PR descriptions and commits since the previous tag (`git log vPrev..vX.Y.Z`), not just the changelog's PR titles.
- Leave out empty sections. A one-fix patch can be a sentence and a single section.

```md
One or two sentences on what this release is about.

## ⚠️ Before you update
- Anything the user must do: sign in again, re-add an accessory, a renamed setting. Omit if nothing.

## 🎉 Highlights
- A short paragraph per headline change: what it does, where to find it in settings or the Home app, and why it matters.

## ✨ New features
- Add sleep timer slider (#5)

## 🐛 Bug fixes
- Fix token refresh failing after a child bridge restart (#5)

## 🧰 Maintenance
<details>
<summary>3 changes</summary>

- Tests, CI, docs, CLAUDE.md, refactors

</details>

## ⬆️ Dependency updates
<details>
<summary>2 changes</summary>

- Bump yoto-nodejs-client to 1.2.3 (#NN)

</details>

**Full changelog:** https://github.com/mdjhnson/homebridge-yoto/compare/vPrev...vX.Y.Z
```

- One line per change, in the imperative ("Add", "Fix"), with the PR number when there is one; otherwise the short commit hash.
- Credit outside contributors with `@handle` and add a `## 🙏 New contributors` section for first-timers.
- Collapse Maintenance and Dependency updates in `<details>`, with the count in the summary.
