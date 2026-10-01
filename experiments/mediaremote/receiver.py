"""Experimental AirPlay remote-only receiver with optional Homebridge Yoto bridge."""
import os
import time
from urllib.parse import urlparse
import aiohttp
import argparse
import binascii
import struct
import zlib
import asyncio
import ipaddress
import logging
import plistlib
import signal
import socket
import uuid
from dataclasses import dataclass

from pyatv.auth.hap_tlv8 import TlvValue, ErrorCode, write_tlv
from pyatv.auth.hap_session import HAPSession
from pyatv.auth.hap_srp import hkdf_expand
from pyatv.protocols.airplay.server_auth import AirPlayServerAuth, generate_keys
from pyatv.protocols.airplay.channels import BaseEventChannel, DataStreamChannel, DataStreamMessage
from pyatv.protocols.mrp import messages, protobuf
from pyatv.protocols.mrp.protobuf import CommandInfo_pb2 as cmd
from pyatv.settings import InfoSettings
from pyatv.support.http import BasicHttpServer, HttpResponse, HttpRequest
from zeroconf import ServiceInfo
from zeroconf.asyncio import AsyncZeroconf

LOG = logging.getLogger("yoto-native-controls")
# Experimental discovery hints, encryption, unified media control and Hangdog.
# Audio-related discovery bits are hints only; audio SETUP is always rejected.
FEATURES = sum(1 << bit for bit in (9, 14, 15, 16, 17, 18, 19, 20, 21, 22, 30, 38, 40, 48, 50, 58))
CLIENT_ID = "org.yoto.prototype"
PLAYER_ID = "MediaRemote-DefaultPlayer"
def demo_artwork():
    """Small generated PNG: fictional card artwork, no external downloads."""
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    rows = b"".join(b"\0" + bytes((30 + y, 100, 180)) * 64 for y in range(64))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 64, 64, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


ARTWORK = demo_artwork()
COMMANDS = (cmd.Play, cmd.Pause, cmd.TogglePlayPause, cmd.Stop, cmd.NextTrack, cmd.PreviousTrack)


@dataclass
class Playback:
    playing: bool = True
    chapter: int = 1

    def apply(self, command: int) -> bool:
        if command not in COMMANDS:
            return False
        if command == cmd.Play:
            self.playing = True
        elif command in (cmd.Pause, cmd.Stop):
            self.playing = False
        elif command == cmd.TogglePlayPause:
            self.playing = not self.playing
        elif command == cmd.NextTrack:
            self.chapter += 1
        elif command == cmd.PreviousTrack:
            self.chapter = max(1, self.chapter - 1)
        return True

    @property
    def commands(self):
        return COMMANDS

    def snapshot(self):
        message = messages.create(protobuf.SET_STATE_MESSAGE)
        state = protobuf.extract_inner(message)
        state.displayName = "Yoto Prototype"
        state.playbackState = protobuf.PlaybackState.Playing if self.playing else protobuf.PlaybackState.Paused
        state.playerPath.client.bundleIdentifier = CLIENT_ID
        state.playerPath.client.displayName = "Simulated Yoto"
        state.playerPath.player.identifier = PLAYER_ID
        state.playerPath.player.displayName = "Card player"
        for command in self.commands:
            item = state.supportedCommands.supportedCommands.add()
            item.command = command
            item.enabled = True
        state.playbackQueue.location = 0
        item = state.playbackQueue.contentItems.add()
        item.identifier = f"fictional-chapter-{self.chapter}"
        item.metadata.title = f"Prototype story — Chapter {self.chapter}"
        item.metadata.albumName = "Fictional Yoto card"
        item.metadata.trackArtistName = "MediaRemote experiment"
        item.artworkData = ARTWORK
        item.metadata.artworkAvailable = True
        item.metadata.artworkMIMEType = "image/png"
        item.metadata.artworkIdentifier = "prototype-card"
        item.metadata.duration = 300
        item.metadata.elapsedTime = 0
        item.metadata.playbackRate = 1 if self.playing else 0
        return message


def playback_timestamp(previous, current, timestamp, now):
    """Keep a continuous timeline for small reporting/rounding corrections."""
    if previous == current:
        return timestamp
    if (previous and previous[:3] == current[:3]
            and previous[4:] == current[4:]
            and current[4] == "playing" and current[5] is True
            and isinstance(previous[3], (int, float))
            and isinstance(current[3], (int, float))
            and current[3] >= previous[3]):
        predicted = previous[3] + max(0, now - timestamp)
        if abs(current[3] - predicted) <= 1.5:
            return timestamp + current[3] - previous[3]
    return now


class BridgePlayback(Playback):
    """Read live state and forward commands using Homebridge's existing account."""
    command_names = {cmd.Play: "play", cmd.Pause: "pause", cmd.Stop: "stop",
        cmd.TogglePlayPause: "toggle", cmd.NextTrack: "next", cmd.PreviousTrack: "previous"}

    def __init__(self, session, url, device_id):
        super().__init__(playing=False)
        self.session, self.url, self.device_id = session, url.rstrip("/"), device_id
        self.state = {"online": False}
        self.artwork = b""
        self.artwork_type = "image/png"
        self.artwork_url = None
        self.artwork_state = object()
        self.artwork_retry_at = 0
        self.channels = set()
        self.position_signature = None
        self.position_timestamp = time.time() - 978307200

    @property
    def commands(self):
        if not self.state.get("online"):
            return ()
        return tuple(command for command in self.command_names
            if command not in (cmd.NextTrack, cmd.PreviousTrack)
            or self.state.get("supportsNext" if command == cmd.NextTrack else "supportsPrevious"))

    @property
    def volume(self):
        value = self.state.get("volume")
        return max(0.0, min(1.0, value)) if isinstance(value, (int, float)) else 0.0

    async def set_volume(self, volume):
        if not self.state.get("online") or not 0 <= volume <= 1:
            return False
        async with self.session.post(self.url + "/command", params={"deviceId": self.device_id},
                json={"command": "volume", "volume": volume}) as response:
            response.raise_for_status()
        return True

    async def refresh(self):
        async with self.session.get(self.url + "/state", params={"deviceId": self.device_id}) as response:
            response.raise_for_status()
            state = await response.json()
        if not isinstance(state, dict):
            raise ValueError("Invalid bridge state")
        signature = tuple(state.get(key) for key in ("cardId", "chapterKey", "trackKey", "position", "playbackStatus", "online"))
        self.position_timestamp = playback_timestamp(self.position_signature, signature,
            self.position_timestamp, time.time() - 978307200)
        self.position_signature = signature
        self.state = state
        self.playing = state.get("online") is True and state.get("playbackStatus") == "playing"
        artwork_url = state.get("cardCoverImageUrl")
        artwork_state = (state.get("cardId"), artwork_url)
        changed = artwork_state != self.artwork_state
        if changed:
            self.artwork_state = artwork_state
            self.artwork_url, self.artwork = artwork_url, b""
            self.artwork_retry_at = 0
            if not artwork_url:
                LOG.info("ARTWORK no cover URL in Yoto playback metadata")
            elif not isinstance(artwork_url, str) or urlparse(artwork_url).scheme != "https":
                LOG.info("ARTWORK cover URL has unsupported scheme (HTTPS required)")
        now = asyncio.get_running_loop().time()
        if (not self.artwork and isinstance(artwork_url, str)
                and urlparse(artwork_url).scheme == "https" and now >= self.artwork_retry_at):
            self.artwork_retry_at = now + 30
            # A separate session keeps the bridge's bearer token off artwork requests.
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as images:
                    async with images.get(artwork_url) as image:
                        image.raise_for_status()
                        kind = image.headers.get("Content-Type", "").split(";", 1)[0].lower()
                        data = bytearray()
                        async for chunk in image.content.iter_chunked(65536):
                            data.extend(chunk)
                            if len(data) > 2 * 1024 * 1024:
                                raise ValueError("Artwork too large")
                        # Some CDNs return octet-stream for otherwise valid image data.
                        if data.startswith(b"\x89PNG\r\n\x1a\n"):
                            kind = "image/png"
                        elif data.startswith(b"\xff\xd8\xff"):
                            kind = "image/jpeg"
                        if kind in ("image/png", "image/jpeg") and data:
                            self.artwork, self.artwork_type = bytes(data), kind
                            LOG.info("ARTWORK loaded format=%s bytes=%d", kind, len(data))
                        else:
                            LOG.info("ARTWORK unsupported image format=%s bytes=%d", kind or "missing", len(data))
            except Exception as error:
                LOG.info("ARTWORK download failed error=%s; retrying in 30 seconds", type(error).__name__)

    def snapshot(self):
        message = super().snapshot()
        state = protobuf.extract_inner(message)
        state.displayName = self.state.get("name") or "Yoto"
        state.playerPath.client.displayName = "Yoto"
        if not self.state.get("online") or self.state.get("playbackStatus") == "stopped":
            state.playbackState = protobuf.PlaybackState.Stopped
        item = state.playbackQueue.contentItems[0]
        item.identifier = ":".join(str(self.state.get(key) or "") for key in ("cardId", "chapterKey", "trackKey")) or "yoto-idle"
        metadata = item.metadata
        metadata.title = (self.state.get("trackTitle") or self.state.get("chapterTitle")
            or self.state.get("cardTitle") or ("Yoto" if self.state.get("online") else "Yoto offline"))
        metadata.albumName = self.state.get("cardTitle") or ""
        metadata.trackArtistName = self.state.get("cardReadBy") or self.state.get("cardAuthor") or ""
        metadata.duration = max(0, self.state.get("trackLength") or 0)
        metadata.elapsedTime = max(0, self.state.get("position") or 0)
        metadata.elapsedTimeTimestamp = self.position_timestamp
        item.artworkData = self.artwork
        metadata.artworkAvailable = bool(self.artwork)
        metadata.artworkMIMEType = self.artwork_type
        metadata.artworkIdentifier = self.artwork_url or ""
        return message

    async def apply_async(self, command):
        if command not in self.commands:
            return False
        async with self.session.post(self.url + "/command", params={"deviceId": self.device_id},
                json={"command": self.command_names[command]}) as response:
            response.raise_for_status()
        return True

    def state_signature(self):
        message = self.snapshot()
        # Transport IDs are random even when playback has not changed.
        message.ClearField("uniqueIdentifier")
        return message.SerializeToString(), self.volume

    async def poll(self):
        while True:
            before = self.state_signature()
            try:
                await self.refresh()
            except Exception:
                if self.state.get("online"):
                    LOG.warning("BRIDGE unavailable; marking player offline")
                self.state = {"name": self.state.get("name"), "online": False}
                self.playing = False
            if self.state_signature() != before:
                for channel in tuple(self.channels):
                    channel.publish()
            await asyncio.sleep(1)


class ReceiverDataChannel(DataStreamChannel):
    def __init__(self, output_key, input_key, owner):
        super().__init__(output_key, input_key)
        self.owner = owner
        self.listener = self

    def connection_made(self, transport):
        super().connection_made(transport)
        self.owner.data_channels.add(self)
        if isinstance(self.owner.playback, BridgePlayback):
            self.owner.playback.channels.add(self)
        LOG.info("DATA connected: encrypted MediaRemote channel ready")

    def connection_lost(self, exc):
        self.owner.data_channels.discard(self)
        if isinstance(self.owner.playback, BridgePlayback):
            self.owner.playback.channels.discard(self)
        LOG.info("DATA disconnected")

    def handle_connection_lost(self, exc):
        pass

    def send_protobuf(self, message):
        self.send(self.encode_message(DataStreamMessage(
            b"sync" + 8 * b"\0", b"cmnd", self.send_seqno, 0,
            self.encode_payload({"params": {"data": self.encode_protobufs([message])}}))))
        self.send_seqno += 1

    def handle_received(self):
        # Bound lengths and ignore empty transport acknowledgements before decoding.
        try:
            while len(self.buffer) >= 32:
                size = int.from_bytes(self.buffer[:4], "big")
                if not 32 <= size <= 2 * 1024 * 1024:
                    raise ValueError("Invalid MediaRemote frame length")
                message, _, rest = self.decode_message(self.buffer)
                if message is None:
                    return
                self.buffer = rest
                if message.payload:
                    payload = self.decode_payload(message.payload)
                    if payload:
                        self._process_payload(payload)
                if message.message_type.startswith(b"sync"):
                    self.send(self.encode_reply(message.seqno))
        except Exception:
            LOG.exception("DATA decoding failed; closing channel")
            self.close()

    def encode_reply(self, seqno):
        return self.encode_message(DataStreamMessage(b"rply" + 8 * b"\0", 4 * b"\0",
            seqno, 0, self.encode_payload({})))

    def publish_volume(self, identifier=None):
        playback = self.owner.playback
        if not isinstance(playback, BridgePlayback):
            return
        available = bool(playback.state.get("online"))
        message = messages.create(protobuf.UPDATE_OUTPUT_DEVICE_MESSAGE)
        inner = protobuf.extract_inner(message)
        inner.endpointUID = self.owner.uid
        for devices in (inner.outputDevices, inner.clusterAwareOutputDevices):
            device = devices.add()
            device.name = self.owner.name
            device.uniqueIdentifier = self.owner.uid
            device.modelID = self.owner.model
            device.isRemoteControllable = True
            device.isGroupLeader = True
            device.isVolumeControlAvailable = available
            device.volumeCapabilities = protobuf.VolumeCapabilities.Absolute
            device.volume = playback.volume
        self.send_protobuf(message)
        message = messages.create(protobuf.VOLUME_CONTROL_AVAILABILITY_MESSAGE, identifier=identifier)
        inner = protobuf.extract_inner(message)
        inner.volumeControlAvailable = available
        inner.volumeCapabilities = protobuf.VolumeCapabilities.Absolute
        self.send_protobuf(message)
        message = messages.create(protobuf.VOLUME_CONTROL_CAPABILITIES_DID_CHANGE_MESSAGE)
        inner = protobuf.extract_inner(message)
        inner.outputDeviceUID = self.owner.uid
        inner.capabilities.volumeControlAvailable = available
        inner.capabilities.volumeCapabilities = protobuf.VolumeCapabilities.Absolute
        self.send_protobuf(message)
        message = messages.create(protobuf.VOLUME_DID_CHANGE_MESSAGE)
        inner = protobuf.extract_inner(message)
        inner.outputDeviceUID = self.owner.uid
        inner.volume = playback.volume
        self.send_protobuf(message)

    async def handle_bridge_volume(self, message):
        try:
            volume = protobuf.extract_inner(message).volume
            accepted = await self.owner.playback.set_volume(volume)
            LOG.info("VOLUME forwarded=%s", accepted)
        except Exception:
            LOG.warning("VOLUME forwarding failed")
            accepted = False
        if self in self.owner.data_channels and message.identifier:
            self.send_protobuf(messages.command_result(message.identifier,
                send_error=protobuf.SendError.NoError if accepted else protobuf.SendError.NotSupported))

    def publish(self, identifier=None):
        state = self.owner.playback.snapshot()
        if identifier:
            state.identifier = identifier
        self.send_protobuf(state)
        active = messages.create(protobuf.SET_NOW_PLAYING_CLIENT_MESSAGE)
        protobuf.extract_inner(active).client.bundleIdentifier = CLIENT_ID
        self.send_protobuf(active)
        self.publish_volume()
        LOG.info("STATE chapter=%d playing=%s", self.owner.playback.chapter, self.owner.playback.playing)

    async def handle_bridge_command(self, message, command):
        error = protobuf.SendError.NotSupported
        try:
            if await self.owner.playback.apply_async(command):
                error = protobuf.SendError.NoError
                LOG.info("COMMAND %s forwarded to Yoto", cmd.Command.Name(command))
        except Exception:
            LOG.warning("BRIDGE command failed")
            error = protobuf.SendError.ApplicationNotFound
        if self in self.owner.data_channels:
            self.send_protobuf(messages.command_result(message.identifier, send_error=error))

    def handle_protobuf(self, message):
        LOG.info("MRP %s", protobuf.ProtocolMessage.Type.Name(message.type))
        if isinstance(self.owner.playback, BridgePlayback) and message.type == protobuf.SET_VOLUME_MESSAGE:
            asyncio.create_task(self.handle_bridge_volume(message))
        elif isinstance(self.owner.playback, BridgePlayback) and message.type == protobuf.GET_VOLUME_MESSAGE:
            reply = messages.create(protobuf.GET_VOLUME_RESULT_MESSAGE, identifier=message.identifier)
            protobuf.extract_inner(reply).volume = self.owner.playback.volume
            self.send_protobuf(reply)
        elif isinstance(self.owner.playback, BridgePlayback) and message.type == protobuf.ProtocolMessage.GET_VOLUME_CONTROL_CAPABILITIES_MESSAGE:
            self.publish_volume(message.identifier)
        elif message.type == protobuf.DEVICE_INFO_MESSAGE:
            info = InfoSettings()
            info.name = self.owner.name
            reply = messages.device_information(info, self.owner.uid)
            reply.identifier = message.identifier
            inner = protobuf.extract_inner(reply)
            inner.modelID = self.owner.model
            inner.deviceUID = self.owner.uid
            inner.logicalDeviceCount = 1
            inner.isGroupLeader = True
            inner.isAirplayActive = False
            self.send_protobuf(reply)
        elif message.type in (protobuf.CLIENT_UPDATES_CONFIG_MESSAGE, protobuf.PLAYBACK_QUEUE_REQUEST_MESSAGE):
            self.publish(message.identifier if message.type == protobuf.PLAYBACK_QUEUE_REQUEST_MESSAGE else None)
            if message.identifier and message.type != protobuf.PLAYBACK_QUEUE_REQUEST_MESSAGE:
                self.send_protobuf(messages.create(0, identifier=message.identifier))
        elif message.type == protobuf.SEND_COMMAND_MESSAGE:
            command = protobuf.extract_inner(message).command
            if isinstance(self.owner.playback, BridgePlayback):
                asyncio.create_task(self.handle_bridge_command(message, command))
                return
            supported = self.owner.playback.apply(command)
            LOG.info("COMMAND %s supported=%s (simulated only)", cmd.Command.Name(command), supported)
            self.send_protobuf(messages.command_result(message.identifier,
                send_error=protobuf.SendError.NoError if supported else protobuf.SendError.NotSupported))
            if supported:
                for channel in tuple(self.owner.data_channels):
                    channel.publish()
        elif message.identifier:
            # Acknowledge configuration messages; unsupported commands above fail explicitly.
            self.send_protobuf(messages.create(0, identifier=message.identifier))


class ReceiverEventChannel(BaseEventChannel):
    def __init__(self, output_key, input_key, owner):
        super().__init__(output_key, input_key)
        self.owner = owner

    def connection_made(self, transport):
        super().connection_made(transport)
        self.owner.events.add(self)
        LOG.info("EVENT connected")

    def connection_lost(self, exc):
        self.owner.events.discard(self)

    def update_info(self):
        body = plistlib.dumps({"type": "updateInfo", "value": self.owner.info()}, fmt=plistlib.FMT_BINARY)
        self.send(self.format_request(HttpRequest("POST", "/command", "RTSP", "1.0",
            {"CSeq": "0", "Content-Type": "application/x-apple-binary-plist"}, body)))

    def handle_received(self):
        while self.buffer:
            if self.buffer.startswith((b"RTSP", b"HTTP")):
                response, _, rest = self.parse_response(self.buffer)
                if response is None:
                    return
                LOG.info("EVENT acknowledgement %d", response.code)
            else:
                request, _, rest = self.parse_request(self.buffer)
                if request is None:
                    return
                self.send(self.format_response(HttpResponse("RTSP", "1.0", 200, "OK",
                    {"CSeq": request.headers.get("CSeq", "0")}, b"")))
            self.buffer = rest


class ControlProtocol(BasicHttpServer):
    def __init__(self, owner):
        self.crypto = HAPSession()
        self.pending_keys = None
        self.owner = owner
        self.peer = "unknown"
        self.received_bytes = 0
        super().__init__(owner)
        owner.control = self

    def connection_made(self, transport):
        super().connection_made(transport)
        self.peer = transport.get_extra_info("peername")
        LOG.info("CONTROL connected peer=%s", self.peer)

    def process_received(self, data):
        self.received_bytes += len(data)
        return self.crypto.decrypt(data)

    def _send_response(self, response):
        LOG.info("RESPONSE peer=%s status=%s cseq=%s", self.peer, response.code,
            response.headers.get("CSeq", "-"))
        super()._send_response(response)

    def process_sent(self, data):
        # The final pairing response is plaintext; encryption begins afterwards.
        result = self.crypto.encrypt(data)
        if self.pending_keys:
            self.crypto.enable(*self.pending_keys)
            self.pending_keys = None
            LOG.info("AUTH control encryption enabled; awaiting encrypted peer request")
        return result

    def connection_lost(self, exc):
        LOG.info("CONTROL disconnected peer=%s bytes=%d encrypted=%s pending=%d error=%s",
            self.peer, self.received_bytes, self.crypto.chacha20 is not None,
            len(self._request_buffer), type(exc).__name__ if exc else "none")
        self.owner.close()

    def data_received(self, data):
        try:
            super().data_received(data)
        except Exception:
            LOG.exception("CONTROL decoding failed; closing session")
            self.transport.close()


class Receiver(AirPlayServerAuth):
    def __init__(self, address, name, model, uid, seed, playback):
        super().__init__(name, uid)
        self.keys = generate_keys(seed)
        self.address, self.model, self.uid = address, model, uid
        self.playback = playback
        self.control = None
        self.servers = []
        self.events, self.data_channels = set(), set()
        self.closed = False
        self.on_close = lambda: None
        self.add_route("GET_PARAMETER", ".*", self.get_parameter)
        self.add_route("SET_PARAMETER", ".*", self.set_parameter)
        self.add_route("SETUP", ".*", self.setup)
        self.add_route("RECORD", ".*", self.record)
        self.add_route("POST", "^/feedback$", self.feedback)
        self.add_route("TEARDOWN", ".*", self.teardown)
        self.add_route("GET", "^/info$", self.handle_info)
        self.add_route("POST", "^/info$", self.handle_info)

    def handle_request(self, request):
        # No bodies, credential headers, or URL query strings are logged.
        LOG.info("REQUEST peer=%s method=%s path=%s query=%s hkp=%s agent=%s",
            self.control.peer, request.method, request.path.split("?", 1)[0], "?" in request.path,
            request.headers.get("X-Apple-HKP", "-"),
            request.headers.get("User-Agent", "-")[:100])
        self.last_request = request
        response = super().handle_request(request._replace(path=request.path.split("?", 1)[0]))
        if response is None:
            LOG.info("UNHANDLED method=%s path=%s", request.method, request.path.split("?", 1)[0])
        return response

    def reply(self, request, body=None, code=200):
        headers = {"CSeq": request.headers.get("CSeq", "0"), "Server": "AirTunes/550.10"}
        if body is not None:
            headers["Content-Type"] = "application/x-apple-binary-plist"
        return HttpResponse(request.protocol, request.version, code, "OK" if code == 200 else "Unsupported",
            headers, plistlib.dumps(body, fmt=plistlib.FMT_BINARY) if body is not None else b"")

    def discovery_properties(self):
        features = f"0x{FEATURES & 0xffffffff:X},0x{FEATURES >> 32:X}"
        return {"deviceid": self.uid, "model": self.model, "features": features,
            "acl": "0", "gid": str(uuid.uuid5(uuid.NAMESPACE_OID, self.uid)),
            "psi": str(uuid.uuid5(uuid.NAMESPACE_DNS, self.uid)), "igl": "1", "gcgl": "1",
            "pk": self.keys.auth_pub.hex(), "pi": str(uuid.uuid5(uuid.NAMESPACE_OID, self.uid)),
            "osvers": "14.7", "flags": "0x4", "srcvers": "550.10", "protovers": "1.1", "vv": "2"}

    def raop_properties(self):
        properties = self.discovery_properties()
        return {"am": self.model, "cn": "0,1", "da": "true", "et": "0,1", "pw": "false",
            "ft": properties["features"], "sf": properties["flags"], "pk": properties["pk"],
            "tp": "UDP", "vn": "65537", "vs": "550.10", "md": "0,1,2", "ch": "2",
            "ss": "16", "sr": "44100", "txtvers": "1"}

    @staticmethod
    def encode_txt(properties):
        records = [f"{key}={value}".encode() for key, value in properties.items()]
        return b"".join(bytes([len(record)]) + record for record in records)

    def info(self):
        txt = self.encode_txt(self.discovery_properties())
        return {"name": self.name, "model": self.model, "deviceID": self.uid,
            "macAddress": self.uid, "pi": str(uuid.uuid5(uuid.NAMESPACE_OID, self.uid)),
            "psi": str(uuid.uuid5(uuid.NAMESPACE_DNS, self.uid)),
            "pk": self.keys.auth_pub, "txtAirPlay": txt, "txtRAOP": self.encode_txt(self.raop_properties()), "features": FEATURES, "statusFlags": 4,
            "sourceVersion": "550.10", "protocolVersion": "1.1", "vv": 2,
            "volumeControlType": 3 if isinstance(self.playback, BridgePlayback) else 0, "keepAliveSendStatsAsBody": True, "keepAliveLowPower": True,
            "nameIsFactoryDefault": False, "manufacturer": "Yoto MediaRemote experiment",
            "initialVolume": self.airplay_volume() if isinstance(self.playback, BridgePlayback) else -20.0, "canRecordScreenStream": False,
            "playbackCapabilities": {"supportsUIForAudioOnlyContent": True},
            "supportedFormats": {"audioStream": 0x40000, "bufferStream": 0x40000 | 0x400000},
            "audioLatencies": [{"type": 100, "audioType": "default", "inputLatencyMicros": 0,
                "outputLatencyMicros": 0}, {"type": 101, "audioType": "default",
                "inputLatencyMicros": 0, "outputLatencyMicros": 0}]}

    def handle_info(self, request):
        # Only log recognised non-secret discovery qualifiers.
        query = self.last_request.path.partition("?")[2]
        qualifiers = [key for key in ("txtAirPlay", "txtRAOP") if key in query.split("&")]
        LOG.info("INFO requested, model=%s qualifiers=%s", self.model, qualifiers)
        # The router strips query parameters for dispatch. Preserve them for this log
        # by using the original request saved in handle_request.

        return self.reply(request, self.info())

    def handle_pair_setup(self, request):
        # Reuse SRP transient pairing only. pyatv's test-only persistent pairing
        # implementation does not validate controller signatures or store trust.
        if request.headers.get("X-Apple-HKP") != "4":
            LOG.info("AUTH persistent pairing requested but not implemented")
            return self.reply(request, code=501)
        response = super().handle_pair_setup(request)
        headers = dict(response.headers)
        headers["Content-Type"] = "application/octet-stream"
        # Pairing bodies are TLV8, not property lists. Keep M4 plaintext;
        # ControlProtocol enables encryption only after sending this response.
        return response._replace(protocol=request.protocol, version=request.version, headers=headers)

    def _m3_setup(self, pairing_data, transient):
        # Unlike pyatv's test receiver, never enable encryption after a bad proof.
        self.session.process(binascii.hexlify(pairing_data[TlvValue.PublicKey]).decode(), self.salt)
        if not self.session.verify_proof(binascii.hexlify(pairing_data[TlvValue.Proof])):
            return write_tlv({TlvValue.Error: bytes([ErrorCode.Authentication]), TlvValue.SeqNo: b"\x04"})
        self.shared_key = binascii.unhexlify(self.session.key)
        self.enable_encryption(
            hkdf_expand("Control-Salt", "Control-Read-Encryption-Key", self.shared_key),
            hkdf_expand("Control-Salt", "Control-Write-Encryption-Key", self.shared_key))
        LOG.info("AUTH client proof verified; sending 64-byte server proof")
        return write_tlv({TlvValue.Proof: binascii.unhexlify(self.session.key_proof_hash),
            TlvValue.SeqNo: b"\x04"})

    def handle_pair_verify(self, request):
        return self.reply(request, code=501)

    def enable_encryption(self, output_key, input_key):
        self.control.pending_keys = (output_key, input_key)

    async def make_channel(self, factory):
        server = await asyncio.get_running_loop().create_server(factory, self.address, 0)
        if self.closed:
            server.close()
            await server.wait_closed()
            raise ConnectionError("Control session closed during setup")
        self.servers.append(server)
        return server.sockets[0].getsockname()[1]

    def setup(self, request):
        return asyncio.create_task(self.setup_async(request))

    async def setup_async(self, request):
        if not self.shared_key:
            return self.reply(request, code=470)
        body = plistlib.loads(request.body)
        if body.get("isRemoteControlOnly"):
            out_key = hkdf_expand("Events-Salt", "Events-Write-Encryption-Key", self.shared_key)
            in_key = hkdf_expand("Events-Salt", "Events-Read-Encryption-Key", self.shared_key)
            port = await self.make_channel(lambda: ReceiverEventChannel(out_key, in_key, self))
            LOG.info("SETUP remote-only eventPort=%d", port)
            return self.reply(request, {"eventPort": port})
        streams = body.get("streams", [])
        if len(streams) == 1 and streams[0].get("type") == 130:
            salt = "DataStream-Salt" + str(int(streams[0]["seed"]) & ((1 << 64) - 1))
            out_key = hkdf_expand(salt, "DataStream-Input-Encryption-Key", self.shared_key)
            in_key = hkdf_expand(salt, "DataStream-Output-Encryption-Key", self.shared_key)
            port = await self.make_channel(lambda: ReceiverDataChannel(out_key, in_key, self))
            LOG.info("SETUP MediaRemote dataPort=%d", port)
            return self.reply(request, {"streams": [{"type": 130, "streamID": 1, "dataPort": port}]})
        LOG.info("SETUP audio/unsupported stream rejected")
        return self.reply(request, code=501)

    def airplay_volume(self):
        value = self.playback.volume if isinstance(self.playback, BridgePlayback) else 0.5
        return -144.0 if value == 0 else -30.0 + 30.0 * value

    def get_parameter(self, request):
        if not self.shared_key:
            return self.reply(request, code=470)
        body = request.body.decode() if isinstance(request.body, bytes) else request.body
        if not isinstance(self.playback, BridgePlayback) or str(body).strip() != "volume":
            return self.reply(request, code=501)
        return HttpResponse(request.protocol, request.version, 200, "OK",
            {"CSeq": request.headers.get("CSeq", "0"), "Content-Type": "text/parameters"},
            f"volume: {self.airplay_volume():.6f}\r\n".encode())

    def set_parameter(self, request):
        return asyncio.create_task(self.set_parameter_async(request))

    async def set_parameter_async(self, request):
        if not self.shared_key:
            return self.reply(request, code=470)
        if not isinstance(self.playback, BridgePlayback):
            return self.reply(request, code=501)
        try:
            body = request.body.decode() if isinstance(request.body, bytes) else request.body
            name, value = str(body).strip().split(":", 1)
            if name.strip() != "volume":
                return self.reply(request, code=501)
            decibels = float(value)
            if not (decibels == -144 or -30 <= decibels <= 0):
                return self.reply(request, code=400)
            volume = 0.0 if decibels == -144 else (decibels + 30) / 30
            accepted = await self.playback.set_volume(volume)
            LOG.info("VOLUME RTSP forwarded=%s", accepted)
            return self.reply(request, code=200 if accepted else 503)
        except (ValueError, UnicodeDecodeError):
            return self.reply(request, code=400)
        except Exception:
            LOG.warning("VOLUME RTSP forwarding failed")
            return self.reply(request, code=503)

    def record(self, request):
        for event in tuple(self.events):
            event.update_info()
        return self.reply(request)

    def feedback(self, request):
        return self.reply(request, {"streams": []})

    def teardown(self, request):
        self.close()
        return self.reply(request)

    def close(self):
        self.closed = True
        self.on_close()
        for server in self.servers:
            server.close()
        for channel in tuple(self.events | self.data_channels):
            channel.close()


async def run(args):
    address = str(ipaddress.IPv4Address(args.address))
    uid = "02:" + ":".join(f"{b:02X}" for b in uuid.uuid4().bytes[:5])
    seed = uuid.uuid4().bytes + uuid.uuid4().bytes
    playback = Playback()
    bridge_session, poll_task = None, None
    if args.bridge_url:
        token = os.environ.get("YOTO_MEDIAREMOTE_TOKEN", "")
        if len(token) < 32 or not args.device_id:
            raise ValueError("Bridge mode requires --device-id and YOTO_MEDIAREMOTE_TOKEN (32+ characters)")
        parsed = urlparse(args.bridge_url)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
            raise ValueError("Invalid bridge URL")
        bridge_session = aiohttp.ClientSession(headers={"Authorization": "Bearer " + token},
            timeout=aiohttp.ClientTimeout(total=10))
        playback = BridgePlayback(bridge_session, args.bridge_url, args.device_id)
        try:
            await playback.refresh()
        except Exception:
            await bridge_session.close()
            raise
        args.name = args.name or playback.state.get("name") or "Yoto"
        poll_task = asyncio.create_task(playback.poll())
    args.name = args.name or "Yoto Prototype"
    owners = set()

    def factory():
        owner = Receiver(address, args.name, args.model, uid, seed, playback)
        owners.add(owner)
        owner.on_close = lambda: owners.discard(owner)
        return ControlProtocol(owner)

    server = await asyncio.get_running_loop().create_server(factory, address, args.port)
    port = server.sockets[0].getsockname()[1]
    zc = AsyncZeroconf(interfaces=[address])
    identity = Receiver(address, args.name, args.model, uid, seed, playback)
    hostname = "yoto-prototype-" + uid.replace(":", "").lower() + ".local."
    services = [ServiceInfo("_airplay._tcp.local.", args.name + "._airplay._tcp.local.",
        addresses=[socket.inet_aton(address)], port=port,
        properties=identity.discovery_properties(), server=hostname),
        ServiceInfo("_raop._tcp.local.", uid.replace(":", "") + "@" + args.name + "._raop._tcp.local.",
        addresses=[socket.inet_aton(address)], port=port,
        properties=identity.raop_properties(), server=hostname)]
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        for service in services:
            await zc.async_register_service(service)
        LOG.info("READY %s %s:%d model=%s services=airplay,raop mode=%s", args.name, address, port, args.model, "Yoto bridge" if args.bridge_url else "fictional playback")
        await stop.wait()
    finally:
        if poll_task:
            poll_task.cancel()
            await asyncio.gather(poll_task, return_exceptions=True)
        if bridge_session:
            await bridge_session.close()
        await zc.async_unregister_all_services()
        await zc.async_close()
        server.close()
        await server.wait_closed()
        for owner in tuple(owners):
            owner.close()
            if owner.control.transport:
                owner.control.transport.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--address", required=True, help="LAN IPv4 address of this machine")
    parser.add_argument("--port", type=int, default=7000)
    parser.add_argument("--name", help="Display name (defaults to selected Yoto name in bridge mode)")
    parser.add_argument("--bridge-url", help="Opt-in Homebridge MediaRemote bridge URL")
    parser.add_argument("--device-id", help="Yoto device ID selected from the bridge")
    parser.add_argument("--model", default="YotoPrototype", help="Experimental identity: YotoPrototype, AudioAccessory5,1 or AppleTV6,2")
    arguments = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    asyncio.run(run(arguments))
