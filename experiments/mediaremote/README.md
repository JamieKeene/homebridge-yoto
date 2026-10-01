# MediaRemote receiver experiment

This is an experimental remote-only AirPlay/MediaRemote receiver. Native iPhone
Now Playing and transport controls have been verified with fictional playback
using `AudioAccessory5,1` and authentication feature bit 14. It receives no audio.

By default it uses fictional playback. The opt-in Homebridge adapter below reads
real Yoto metadata and forwards transport commands through the plugin's existing
account. This integration is covered by simulated-device tests; physical Yoto
operation has not yet been verified.

## Run on a Mac or Linux machine

Use Python 3.12 with `venv` and `pip`. Connect the machine and iPhone to the same LAN. Replace
`192.168.1.100` below with the machine's LAN IPv4 address (on a Wi-Fi Mac,
`ipconfig getifaddr en0` usually shows it).

```sh
git clone --branch research/ios-now-playing https://github.com/JamieKeene/homebridge-yoto.git
cd homebridge-yoto/experiments/mediaremote
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python receiver.py --address 192.168.1.100
```

Allow Python incoming LAN connections if macOS asks. Stop with Ctrl-C. The service
uses TCP 7000, ephemeral TCP ports for event/data channels, and multicast DNS on
UDP 5353. Port 7000 can be changed with `--port`. Identity is regenerated on each
restart to avoid retaining experimental pairing state.

## Run on Unraid with Docker

From the repository root:

```sh
docker build -t yoto-mediaremote-prototype experiments/mediaremote
docker run --rm --name yoto-mediaremote-prototype --network host \
  yoto-mediaremote-prototype --address 192.168.1.100
```

Use the Unraid LAN IP. Host networking is required for multicast discovery and
session ports. There are no Yoto settings or volumes to configure. The Dockerfile
runs as an unprivileged user. The image build has not been tested in this workspace.
For desktop macOS use native Python rather than Docker's virtual network.

## Managed plugin mode

The plugin now manages receivers directly. Enable **Native iPhone Now Playing**
in its settings and restart Homebridge. See the [main README](../../README.md#native-iphone-now-playing-experimental)
for prerequisites and optional LAN/player settings. The manual bridge below is
retained for development; it is no longer the normal setup path.

## Connect a real Yoto through Homebridge

Install this research branch of the Homebridge plugin as well as rebuilding the
receiver image. Pulling/rebuilding only the receiver does not install the adapter.
For a local Homebridge plugin install, use the repository root:

```sh
npm install
npm link
```

Run `npm link` in the Homebridge environment, where its global plugins are installed.
Keep that checkout on a persistent Unraid volume if Homebridge runs in Docker.

Generate a bridge token locally with `openssl rand -hex 32`. Add this object to
**the Yoto platform entry** in Homebridge's JSON configuration (alongside its
existing `platform`, login and accessory settings):

```json
"mediaRemoteBridge": {
  "host": "0.0.0.0",
  "port": 9220,
  "token": "PASTE_YOUR_GENERATED_TOKEN_HERE"
}
```

This experimental setting is edited in JSON; there is no settings-form toggle.
Restart Homebridge. Its log should report `Experimental MediaRemote bridge
listening`. The adapter is disabled when this object is absent. The default bind
address is loopback; the explicit address above allows a separate container to
connect. With Docker bridge networking, publish TCP 9220 on the Homebridge
container; with host networking no port mapping is needed. Keep it on your trusted
LAN. The bearer token grants metadata access and playback control of your Yotos.
The plain HTTP example does not encrypt traffic; use only your trusted network.

Set the same token in your terminal and list device IDs (this is read-only):

```sh
read -r -s -p "Bridge token: " YOTO_MEDIAREMOTE_TOKEN
echo
export YOTO_MEDIAREMOTE_TOKEN
curl --fail --silent --show-error \
  -H "Authorization: Bearer $YOTO_MEDIAREMOTE_TOKEN" \
  http://192.0.2.10:9220/devices
```

Replace the IP with the Homebridge host. Copy the selected Yoto's `id` from that
response. Stop the fictional receiver, then start bridge mode:

```sh
docker run --rm --name yoto-mediaremote-prototype --network host \
  -e YOTO_MEDIAREMOTE_TOKEN \
  yoto-mediaremote-prototype --address 192.0.2.10 \
  --model AudioAccessory5,1 --bridge-url http://192.0.2.10:9220 \
  --device-id YOUR_YOTO_DEVICE_ID
```

For native Python, pass those same flags to `receiver.py`. The receiver uses the
selected Yoto's name unless overridden with `--name`. One receiver process serves
one selected Yoto; additional processes need distinct `--port` values.

Open **Control Other Speakers & TVs**. It should show card/track title, author or
narrator, available cover artwork, duration and reported position. State is polled
from Homebridge every second and published to every connected control session.
Play, pause, toggle and stop forward to Yoto. Commands are acknowledged as sent;
actual playback status follows MQTT updates rather than an optimistic local edit.
Offline devices and disconnected accounts reject commands and show offline state.
Previous/next use ordered chapter and track keys fetched from `/card/{cardId}` or
the family library. Buttons are enabled only when an adjacent track exists.
Volume uses the Yoto 0–16 scale and respects its active maximum volume limit.
Seeking is not implemented.

Turning off bridge mode requires stopping the receiver and removing the
`mediaRemoteBridge` setting, then restarting Homebridge. The existing HomeKit
accessories continue using the same account.

## iPhone experiment

1. Start with the default identity, `YotoPrototype`. Look for **Yoto Prototype**
   in expanded Control Centre media controls / the AirPlay menu, including
   **Control Other Speakers & TVs** if your iOS version offers it.
2. If absent, stop the process and repeat with an experimental identity:

   ```sh
   .venv/bin/python receiver.py --address 192.168.1.100 --model AudioAccessory5,1
   ```

   Then try `--model AppleTV6,2` separately. In Docker append `--model ...` to
   the run command. These are discovery/classification experiments, not genuine
   HomePods or Apple TVs. They may be hidden or request pairing we do not support.
3. Do not send iPhone audio to the prototype. Selecting an audio output alone
   is not success. We need an independently controllable session showing
   **Prototype story — Chapter 1**, fictional card artwork, and transport controls.
4. Try pause, play, and next. Watch the terminal: `COMMAND ... (simulated only)`
   must appear, and the state should update. Next changes the title to Chapter 2.
5. Record the iOS version, identity tested, what appears on screen, and terminal
   logs from `READY` onwards. Stop the prototype after testing.

## What is implemented

- `_airplay._tcp` and `_raop._tcp` discovery and `/info` with matching TXT data
  and experimental receiver-format/capability hints. Audio remains rejected.
- Transient SRP pairing and encrypted control/event/data channels.
- Remote-only RTSP SETUP, RECORD, feedback, and teardown.
- Stream type 130 carrying length-prefixed MediaRemote protobuf messages.
- Device information, subscription response, playback queue, generated fictional
  PNG artwork, play/pause/stop/toggle, and chapter next/previous.
- State publication to channels in the commanding session after a command.

## Limits

No persistent HomeKit/AirPlay pairing, companion-link service, audio output,
or seeking. Volume control is available in live mode. Timeline values follow Yoto updates; they are not
interpolated locally. Do not add it as a replacement Homebridge accessory. It rejects audio stream setup and
persistent pairing. The advertised audio-related feature bits are experimental
discovery hints; they do not signify working audio reception. An iPhone insisting
on persistent pairing is a useful negative result, not something this implements.

Transient pairing allows any client on the trusted LAN to control the selected player (fictional by default, real in bridge mode);
there is no user access-control list. It is a short-lived protocol experiment,
not a production server. Do not expose it beyond your LAN. No pairing secrets are
logged at the configured INFO level.

## Validate locally

```sh
.venv/bin/python -m unittest -v test_receiver.py
```

The bridge tests also check authentication, live metadata, command forwarding,
and offline rejection with fake Yoto devices. No physical-player commands run.

The tests use loopback and real pyatv transient pairing to establish encrypted
remote-only channels, inspect metadata/artwork, pause/toggle/advance chapters,
reject unsupported commands/audio, and reject an invalid pairing proof.

## References and dependency

- [pyatv remote-only protocol notes](https://pyatv.dev/documentation/protocols/#airplay-2)
- [pyatv data/event channels](https://github.com/postlund/pyatv/blob/b277a4c8222ecdcbaab8a24e3e713ca44765adb4/pyatv/protocols/airplay/channels.py)
- [pyatv simulated MRP receiver](https://github.com/postlund/pyatv/blob/b277a4c8222ecdcbaab8a24e3e713ca44765adb4/tests/fake_device/mrp.py)

The pyatv dependency is installed from an archive pinned to the inspected revision because this uses
internal protocol APIs. Its MIT license is supplied by the installed dependency.
