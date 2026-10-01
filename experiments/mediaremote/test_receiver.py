"""Loopback tests: real transient pairing and encrypted remote-only transport."""
import asyncio
import unittest

from receiver import ControlProtocol, Playback, Receiver, playback_timestamp
from pyatv.auth.hap_pairing import TRANSIENT_CREDENTIALS
from pyatv.protocols.airplay.ap2_session import AP2Session
from pyatv.protocols.mrp import messages, protobuf
from pyatv.protocols.mrp.protobuf import CommandInfo_pb2 as cmd
from pyatv.settings import InfoSettings


class Inbox:
    def __init__(self):
        self.queue = asyncio.Queue()

    def handle_protobuf(self, message):
        self.queue.put_nowait(message)

    def handle_connection_lost(self, exc):
        pass

    async def until(self, message_type):
        async with asyncio.timeout(5):
            while True:
                message = await self.queue.get()
                if message.type == message_type:
                    return message


class RemoteSessionTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.owners = []
        self.playback = Playback()
        def factory():
            owner = Receiver("127.0.0.1", "Test receiver", "YotoPrototype",
                "02:00:00:00:00:01", bytes(range(32)), self.playback)
            self.owners.append(owner)
            return ControlProtocol(owner)
        self.server = await asyncio.get_running_loop().create_server(factory, "127.0.0.1", 0)
        self.session = AP2Session("127.0.0.1", self.server.sockets[0].getsockname()[1],
            TRANSIENT_CREDENTIALS, InfoSettings())
        await self.session.connect()
        await self.session.setup_remote_control()
        self.inbox = Inbox()
        self.session.data_channel.listener = self.inbox

    async def asyncTearDown(self):
        self.session.stop()
        self.server.close()
        await self.server.wait_closed()
        for owner in self.owners:
            owner.close()
            if owner.control.transport:
                owner.control.transport.close()
        await asyncio.sleep(0)

    async def test_iphone_http_info_probe_with_query(self):
        import plistlib
        from pyatv.support.http import http_connect
        connection = await http_connect("127.0.0.1", self.server.sockets[0].getsockname()[1])
        try:
            for path in ("/info", "/info?txtAirPlay", "/info?txtAirPlay&txtRAOP"):
                response = await connection.get(path)
                self.assertEqual(response.code, 200)
                self.assertEqual(response.protocol, "HTTP")
                info = plistlib.loads(response.body)
                self.assertEqual(info["name"], "Test receiver")
                self.assertEqual(info["model"], "YotoPrototype")
                self.assertIn(b"model=YotoPrototype", info["txtAirPlay"])
                self.assertIn(b"am=YotoPrototype", info["txtRAOP"])
                self.assertEqual(info["supportedFormats"]["audioStream"], 0x40000)
        finally:
            connection.close()

    async def test_state_and_transport_commands(self):
        self.session.data_channel.send_protobuf(messages.device_information(InfoSettings(), "client"))
        device = await self.inbox.until(protobuf.DEVICE_INFO_MESSAGE)
        self.assertEqual(protobuf.extract_inner(device).name, "Test receiver")
        self.session.data_channel.send_protobuf(messages.client_updates_config())
        state = protobuf.extract_inner(await self.inbox.until(protobuf.SET_STATE_MESSAGE))
        self.assertEqual(state.playbackState, protobuf.PlaybackState.Playing)
        self.assertIn("Chapter 1", state.playbackQueue.contentItems[0].metadata.title)
        self.assertTrue(state.playbackQueue.contentItems[0].artworkData.startswith(b"\x89PNG"))
        self.session.data_channel.send_protobuf(messages.command(cmd.Pause))
        reply = protobuf.extract_inner(await self.inbox.until(protobuf.SEND_COMMAND_RESULT_MESSAGE))
        self.assertEqual(reply.sendError, protobuf.SendError.NoError)
        state = protobuf.extract_inner(await self.inbox.until(protobuf.SET_STATE_MESSAGE))
        self.assertEqual(state.playbackState, protobuf.PlaybackState.Paused)
        self.session.data_channel.send_protobuf(messages.command(cmd.NextTrack))
        await self.inbox.until(protobuf.SEND_COMMAND_RESULT_MESSAGE)
        state = protobuf.extract_inner(await self.inbox.until(protobuf.SET_STATE_MESSAGE))
        self.assertIn("Chapter 2", state.playbackQueue.contentItems[0].metadata.title)
        self.session.data_channel.send_protobuf(messages.command(cmd.TogglePlayPause))
        await self.inbox.until(protobuf.SEND_COMMAND_RESULT_MESSAGE)
        state = protobuf.extract_inner(await self.inbox.until(protobuf.SET_STATE_MESSAGE))
        self.assertEqual(state.playbackState, protobuf.PlaybackState.Playing)

    async def test_live_bridge_metadata_and_commands(self):
        import aiohttp
        from aiohttp import web
        from receiver import BridgePlayback
        state = {"name": "Bedroom Yoto", "online": True, "playbackStatus": "playing",
            "cardId": "card-one", "cardTitle": "Actual card", "trackTitle": "Real chapter",
            "position": 42, "trackLength": 180, "volume": 0.5, "supportsNext": True}
        calls = []
        async def get_state(request):
            self.assertEqual(request.headers["Authorization"], "Bearer test-token")
            self.assertEqual(request.query["deviceId"], "device-one")
            return web.json_response(state)
        async def command(request):
            body = await request.json()
            calls.append(body["command"])
            if body["command"] == "volume":
                state["volume"] = body["volume"]
            else:
                state["playbackStatus"] = "paused"
            return web.json_response({"accepted": True})
        app = web.Application()
        app.router.add_get("/state", get_state)
        app.router.add_post("/command", command)
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, "127.0.0.1", 0)
        await site.start()
        port = site._server.sockets[0].getsockname()[1]
        try:
            async with aiohttp.ClientSession(headers={"Authorization": "Bearer test-token"}) as http:
                playback = BridgePlayback(http, f"http://127.0.0.1:{port}", "device-one")
                await playback.refresh()
                for owner in self.owners:
                    owner.playback = playback
                self.session.data_channel.send_protobuf(messages.client_updates_config())
                result = protobuf.extract_inner(await self.inbox.until(protobuf.SET_STATE_MESSAGE))
                item = result.playbackQueue.contentItems[0]
                self.assertEqual(item.metadata.title, "Real chapter")
                self.assertEqual(item.metadata.albumName, "Actual card")
                self.assertEqual(item.metadata.elapsedTime, 42)
                self.assertGreater(item.metadata.elapsedTimeTimestamp, 0)
                signature = playback.state_signature()
                timestamp = playback.position_timestamp
                await playback.refresh()
                self.assertEqual(playback.state_signature(), signature)
                self.assertEqual(playback.position_timestamp, timestamp)
                self.assertFalse(item.metadata.artworkAvailable)
                self.assertIn(cmd.NextTrack, [c.command for c in result.supportedCommands.supportedCommands])
                output = protobuf.extract_inner(await self.inbox.until(protobuf.UPDATE_OUTPUT_DEVICE_MESSAGE))
                self.assertEqual(output.endpointUID, self.owners[0].uid)
                self.assertTrue(output.outputDevices[0].isVolumeControlAvailable)
                self.assertEqual(output.outputDevices[0].uniqueIdentifier, self.owners[0].uid)
                self.assertEqual(output.outputDevices[0].volume, 0.5)
                availability = protobuf.extract_inner(await self.inbox.until(protobuf.VOLUME_CONTROL_AVAILABILITY_MESSAGE))
                self.assertTrue(availability.volumeControlAvailable)
                volume = protobuf.extract_inner(await self.inbox.until(protobuf.VOLUME_DID_CHANGE_MESSAGE))
                self.assertEqual(volume.volume, 0.5)
                volume_command = messages.set_volume(self.owners[0].uid, 0.25)
                volume_command.identifier = "volume-test"
                self.session.data_channel.send_protobuf(volume_command)
                reply = protobuf.extract_inner(await self.inbox.until(protobuf.SEND_COMMAND_RESULT_MESSAGE))
                self.assertEqual(reply.sendError, protobuf.SendError.NoError)
                self.assertEqual(state["volume"], 0.25)
                self.session.data_channel.send_protobuf(messages.command(cmd.NextTrack))
                await self.inbox.until(protobuf.SEND_COMMAND_RESULT_MESSAGE)
                self.assertEqual(calls, ["volume", "next"])
                self.session.data_channel.send_protobuf(messages.command(cmd.Pause))
                reply = protobuf.extract_inner(await self.inbox.until(protobuf.SEND_COMMAND_RESULT_MESSAGE))
                self.assertEqual(reply.sendError, protobuf.SendError.NoError)
                self.assertEqual(calls, ["volume", "next", "pause"])
                await playback.refresh()
                self.assertFalse(playback.playing)
                response = await self.session.connection.send_and_receive("SET_PARAMETER", "/test", protocol="RTSP/1.0",
                    body=b"volume: -15.0\r\n", allow_error=True)
                self.assertEqual(response.code, 200)
                self.assertEqual(state["volume"], 0.5)
                await playback.refresh()
                response = await self.session.connection.send_and_receive("GET_PARAMETER", "/test", protocol="RTSP/1.0",
                    body=b"volume\r\n", allow_error=True)
                self.assertIn(b"-15.000000", response.body if isinstance(response.body, bytes) else response.body.encode())
                state["online"] = False
                await playback.refresh()
                self.assertFalse(await playback.apply_async(cmd.Play))
                self.assertEqual(calls, ["volume", "next", "pause", "volume"])
        finally:
            await runner.cleanup()

    async def test_pairing_response_format_and_server_proof(self):
        import binascii
        import hashlib
        from pyatv.auth.hap_tlv8 import TlvValue, read_tlv, write_tlv
        from pyatv.auth.hap_srp import SRPAuthHandler
        from pyatv.support.http import http_connect
        connection = await http_connect("127.0.0.1", self.server.sockets[0].getsockname()[1])
        try:
            headers = {"X-Apple-HKP": "4", "Content-Type": "application/octet-stream"}
            response = await connection.post("/pair-setup", headers=headers,
                body=write_tlv({TlvValue.SeqNo: b"\x01", TlvValue.Method: b"\0"}))
            self.assertEqual(response.headers["Content-Type"], "application/octet-stream")
            values = read_tlv(response.body)
            self.assertEqual(values[TlvValue.SeqNo], b"\x02")
            srp = SRPAuthHandler()
            srp.initialize()
            srp.step1(3939)
            public_key, proof = srp.step2(values[TlvValue.PublicKey], values[TlvValue.Salt])
            response = await connection.post("/pair-setup", headers=headers,
                body=write_tlv({TlvValue.SeqNo: b"\x03", TlvValue.PublicKey: public_key,
                    TlvValue.Proof: proof}))
            self.assertEqual(response.headers["Content-Type"], "application/octet-stream")
            values = read_tlv(response.body)
            self.assertEqual(values[TlvValue.SeqNo], b"\x04")
            self.assertEqual(len(values[TlvValue.Proof]), 64)
            # Verify RFC 5054's H(A | M1 | K) independently of the server's helper.
            expected = hashlib.sha512(public_key + proof + binascii.unhexlify(srp.shared_key)).digest()
            self.assertEqual(values[TlvValue.Proof], expected)
        finally:
            connection.close()

    async def test_invalid_pairing_proof_does_not_enable_encryption(self):
        from pyatv.auth.hap_tlv8 import TlvValue, read_tlv, write_tlv
        from pyatv.auth.hap_srp import SRPAuthHandler
        from pyatv.support.http import http_connect
        connection = await http_connect("127.0.0.1", self.server.sockets[0].getsockname()[1])
        try:
            headers = {"X-Apple-HKP": "4"}
            response = await connection.post("/pair-setup", headers=headers,
                body=write_tlv({TlvValue.SeqNo: b"\x01", TlvValue.Method: b"\0"}))
            values = read_tlv(response.body)
            srp = SRPAuthHandler()
            srp.initialize()
            srp.step1(3939)
            public_key, _ = srp.step2(values[TlvValue.PublicKey], values[TlvValue.Salt])
            response = await connection.post("/pair-setup", headers=headers,
                body=write_tlv({TlvValue.SeqNo: b"\x03", TlvValue.PublicKey: public_key,
                    TlvValue.Proof: bytes(64)}))
            self.assertIn(TlvValue.Error, read_tlv(response.body))
            owner = self.owners[-1]
            self.assertIsNone(owner.shared_key)
            self.assertIsNone(owner.control.crypto.chacha20)
        finally:
            connection.close()

    async def test_unsupported_command_and_audio_are_rejected(self):
        self.session.data_channel.send_protobuf(messages.command(cmd.SeekToPlaybackPosition))
        reply = protobuf.extract_inner(await self.inbox.until(protobuf.SEND_COMMAND_RESULT_MESSAGE))
        self.assertEqual(reply.sendError, protobuf.SendError.NotSupported)
        import plistlib
        response = await self.session.connection.send_and_receive("SETUP", "/test", protocol="RTSP/1.0",
            body=plistlib.dumps({"streams": [{"type": 96}]}, fmt=plistlib.FMT_BINARY), allow_error=True)
        self.assertEqual(response.code, 501)


if __name__ == "__main__":
    unittest.main()


class PlaybackTimingTest(unittest.TestCase):
    def test_small_corrections_keep_timeline_but_transitions_reset(self):
        previous = ("card", "chapter", "track", 42, "playing", True)
        current = ("card", "chapter", "track", 47, "playing", True)
        self.assertEqual(playback_timestamp(previous, current, 100, 106), 105)
        self.assertEqual(playback_timestamp(previous, previous, 100, 106), 100)
        self.assertEqual(playback_timestamp(previous, current, 100, 115), 115)
        self.assertEqual(playback_timestamp(previous, ("card", "chapter", "track", 10, "playing", True), 100, 106), 106)
        self.assertEqual(playback_timestamp(previous, ("card", "chapter", "other", 0, "playing", True), 100, 106), 106)
        self.assertEqual(playback_timestamp(previous, ("card", "chapter", "track", 47, "paused", True), 100, 106), 106)
