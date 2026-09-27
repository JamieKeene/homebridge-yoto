<p align="center">

<img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">

<img src="https://raw.githubusercontent.com/mdjhnson/homebridge-yoto/master/homebridge-ui/public/logo.png" width="100">

</p>

<span align="center">

# @mdjhnson/homebridge-yoto

</span>

<span align="center">

[![latest version](https://img.shields.io/npm/v/@mdjhnson/homebridge-yoto.svg)](https://www.npmjs.com/package/@mdjhnson/homebridge-yoto)
[![Actions Status](https://github.com/mdjhnson/homebridge-yoto/workflows/tests/badge.svg)](https://github.com/mdjhnson/homebridge-yoto/actions)
![Types in JS](https://img.shields.io/badge/types_in_js-yes-brightgreen)
[![neostandard javascript style](https://img.shields.io/badge/code_style-neostandard-7fffff?style=flat&labelColor=ff80ff)](https://github.com/neostandard/neostandard)

</span>

Homebridge plugin that exposes Yoto players to HomeKit: playback and volume, card and shortcut buttons, a TV-style remote with your card library as inputs, a sleep timer slider, battery, temperature, nightlights, and more. Updates arrive in real time over MQTT, with HTTP polling as a fallback.

This is a maintained fork of [bcomnes/homebridge-yoto](https://github.com/bcomnes/homebridge-yoto).

## Install

Search for `@mdjhnson/homebridge-yoto` in the Homebridge UI **Plugins** tab, or run:

```sh
npm install -g @mdjhnson/homebridge-yoto
```

Requires Node.js 22, 24 or 26 and Homebridge 1.8+ or 2.x.

## Sign in

1. Open the plugin's **Settings** in the Homebridge UI and click **Sign in with Yoto**. Yoto's sign-in page opens in a new tab.
2. Sign in and approve access.
3. Your browser then shows *"This site can't be reached"* at `127.0.0.1`. That's expected. Copy the full address from the address bar, paste it into the **Address from your browser** box on the sign-in screen, and click **Finish Sign-in**.
4. Restart Homebridge.

Using your own Yoto developer app? Make it a **Public Client**, add `http://127.0.0.1:8787/callback` as an allowed callback URL, enable the `family:devices:*`, `family:library:view`, `user:content:view` and `offline_access` scopes, and enter its client ID in the **Advanced Settings** panel on the sign-in screen before signing in. (That panel is only shown while you're signed out, and is separate from the **Advanced** section of the plugin settings.)

The plugin asks for access to view, configure and control your players, plus read-only access to your card library (used to name shortcut switches and to list your cards as TV inputs). If you signed in with an older version, sign in again so the new permissions apply.

The plugin refreshes its tokens on its own, about once a day, and logs each refresh. If the login ever expires or is revoked, the plugin settings show **Yoto login expired** and the Home app shows the players as **Not Responding**. Sign in again from the plugin settings, then restart the child bridge.

## Settings

Most options live under **Accessory Services** in the plugin settings. The settings form, including **Advanced**, appears once you've signed in.

**Playback**
- **Playback Controls**: Adds a play/pause switch and a volume dimmer to each player's bridged accessory. This is the simplest option and needs no extra pairing.
- **TV Playback Accessory**: Publishes a separate TV-style accessory. You control it with the iOS remote (play/pause, volume buttons), and its inputs play your library cards, card controls and shortcuts.
  - **TV Inputs for Library Cards** (on by default, shown once the TV accessory is on): lists every card in your Yoto library, including Make Your Own cards, as an input. Turn it off to list only card controls and shortcuts.

The TV accessory, and the legacy Smart Speaker below, are external accessories. External accessories must be added by hand in the Home app (**Add Accessory → More options**) using the setup code in the Homebridge log. Each one listens on its own port (logged as `... is running on port N`), so open those ports if Homebridge runs behind a firewall, or set a fixed port range under Homebridge **Settings → Network**.

**Card Controls** (`services.cardControls`)
- A switch on each player that plays the card ID you configure.
- Optional **Play on All Yotos**: a separate accessory that plays the card on every online player.

**Shortcuts** (`services.shortcuts`)
- A switch for each shortcut configured on the player in the Yoto app. Turning it on plays that shortcut's card, chapter and track.
- Switches are named after the card and update when you change the shortcuts in the Yoto app.

**Service toggles**
- **Battery**, **Temperature Sensor** (v3), **Nightlight** (v3), **Card Slot**, **Day Mode**, **Sleep Timer**, **Bluetooth**, **Volume Limits**.
  - **Sleep Timer Minutes per 1%** (shown once Sleep Timer is on): how many minutes each 1% on the sleep timer slider stands for. Defaults to 1, so the slider goes up to 100 minutes; 2 allows up to 200 minutes. Accepts 0.5 to 10.

**Advanced** (collapsed section at the bottom of the plugin settings)
- **HTTP Poll Interval**: How often to poll the Yoto API as a fallback to MQTT. Defaults to 60 seconds; the minimum is 10 seconds.
- **External Smart Speaker (Legacy)**: Kept for existing setups. It publishes a separate Smart Speaker accessory that only works in Home app scenes and automations. When you open it, the Home app shows *"Controls not available"* and can't show what's playing, because iOS only offers live controls for AirPlay speakers. It does not make the Yoto an AirPlay target. For more features, use the **TV Playback Accessory** instead. If you switch, remove the old Smart Speaker from the Home app by hand (Homebridge can't unpublish external accessories).

## HomeKit services

**Playback (bridged)**
- **Playback**: Switch. On resumes, Off pauses.
- **Volume**: Lightbulb. On unmutes, Off mutes, and Brightness maps 0–100% to the player's volume steps.

**Smart Speaker (external, legacy)**
- Current/Target Media State, Volume, Mute, and online status. Stop pauses, so playback can be resumed.

**TV Playback (external)**
- Active is on while the player is playing. Turning it off pauses.
- Inputs: **Now Playing**, then your card controls, shortcuts and library cards (including Make Your Own cards), listed alphabetically. Choosing an input plays its card.
- HomeKit allows about 90 inputs. Card controls and shortcuts always get one; library cards fill the rest in alphabetical order, and the log says how many were left out. Turn off **TV Inputs for Library Cards** to list only card controls and shortcuts.
- New library cards appear within about six hours, or after restarting Homebridge.
- Remote: Play/Pause and Select toggle playback. Volume buttons step the volume.

**Card Controls and Shortcuts**
- Momentary switches that start their card and then turn back off.

**Device status**
- **Online Status**: Contact sensor. Contact Not Detected means online.
- **Battery**: Battery level, charging state, and low battery.
- **Temperature**: Temperature sensor (v3).

**Nightlight** (v3)
- **Day Nightlight / Night Nightlight**: Lightbulbs with On/Off, Brightness, Hue, and Saturation.
- **Nightlight Active / Day Nightlight Active / Night Nightlight Active**: Contact sensors for the live nightlight state.

**Other controls**
- **Card Slot**: Contact sensor for card insertion.
- **Day Mode**: Contact sensor. Contact Not Detected means day mode.
- **Sleep Timer**: Lightbulb whose brightness is the time left on the sleep timer.
  - Each 1% is one minute by default, so 45% is a 45-minute timer. Change **Sleep Timer Minutes per 1%** for longer timers.
  - Turning it on without picking a time reuses the last time you set (30 minutes at first, and again after Homebridge restarts). Turning it off cancels the timer.
  - It counts down while the timer runs and follows timers started in the Yoto app.
  - Because it's a light, a "turn off all the lights" scene or Siri request also cancels the timer.
- **Bluetooth**: Switch that toggles Bluetooth.
- **Day/Night Max Volume**: Lightbulbs whose brightness sets the max volume limits.

## Notes

- **Switching from `homebridge-yoto`:** uninstall the original plugin first. Both register the `Yoto` platform and would conflict. Your existing `Yoto` config block keeps working, but bridged accessories are re-created, so you'll need to re-add them to rooms and automations.
- **Upgrading to the sleep timer slider:** the old on/off Sleep Timer switch is replaced by the slider, so add the slider back to any scenes or automations that used the switch.
- **Upgrading to library TV inputs:** existing TV inputs get new identifiers once, so scenes that choose a TV input need that input picked again. After that, identifiers stay the same when cards are added or removed.
- **Removed external accessories:** if you turn off the Smart Speaker or TV accessory, or a player leaves your account, remove the old accessory from the Home app by hand. Homebridge can't unpublish external accessories.
- **Yoto unreachable at startup:** if the network or Yoto's API is down when Homebridge starts, the plugin keeps retrying, waiting longer each time (up to 10 minutes between tries). You don't need to restart Homebridge. If Yoto rejects the saved login, the log asks you to sign in again instead of retrying.

## Privacy

The plugin only connects to Yoto's API and MQTT service, using your own sign-in. It has no analytics or tracking. The only file it changes is Homebridge's `config.json`, to save refreshed sign-in tokens. It writes a temporary copy next to `config.json` first and renames it into place, so an interrupted save can't corrupt the file.

## Development

```sh
npm install
npm test   # eslint + tsc + node:test with coverage
```

Releases are cut with the **npm bump** GitHub Action (Actions → npm bump → Run workflow). It publishes with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored in the repo.

## License

MIT © [Bret Comnes](https://bret.io) and mdjhnson

## Acknowledgments

- [Bret Comnes](https://github.com/bcomnes) wrote the original plugin and [yoto-nodejs-client](https://github.com/bcomnes/yoto-nodejs-client).
- Thanks to [Yoto](https://yoto.io) for their API.
- Built with [Homebridge](https://homebridge.io).
