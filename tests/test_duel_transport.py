"""Real same-port HTTP/WebSocket integration, including session replacement."""
import asyncio
from contextlib import AsyncExitStack
import json
import unittest
import urllib.error
import urllib.request

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from gun_service import APP_ROOT, WEB_FILES
from server.transport import serve_application


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = AsyncExitStack()
        self.application, server = await self.stack.enter_async_context(serve_application(APP_ROOT, WEB_FILES, "127.0.0.1", 0))
        self.port = server.sockets[0].getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        self.url = f"ws://127.0.0.1:{self.port}/ws/duel"
        self.now = 10000
        self.application.arena.clock = lambda: self.now

    async def asyncTearDown(self):
        await self.stack.aclose()

    async def peer(self, token=None):
        peer = await self.stack.enter_async_context(connect(self.url, origin=self.origin))
        await peer.send(json.dumps({"type": "HELLO", "token": token}))
        session = await self.until(peer, "SESSION")
        await peer.send(json.dumps({"type": "AVAILABLE", "visible": True, "controllerReady": True, "inputKind": "touch"}))
        return peer, session

    async def until(self, peer, kind, predicate=lambda value: True):
        async with asyncio.timeout(3):
            while True:
                message = json.loads(await peer.recv())
                if message["type"] == kind and predicate(message):
                    return message

    async def test_two_sessions_countdown_input_isolation_and_resume(self):
        a, sa = await self.peer()
        b, sb = await self.peer()
        outsider, _ = await self.peer()
        await a.send(json.dumps({"type": "CREATE_ROOM", "name": "Alpha"}))
        room = (await self.until(a, "ROOM_STATE"))["room"]
        await b.send(json.dumps({"type": "JOIN_ROOM", "code": room["code"], "name": "Bravo"}))
        await self.until(b, "ROOM_STATE")
        await a.send(json.dumps({"type": "READY", "ready": True}))
        await b.send(json.dumps({"type": "READY", "ready": True}))
        first = (await self.until(a, "ROOM_STATE", lambda p: p["room"]["phase"] == "COUNTDOWN"))["room"]
        second = (await self.until(b, "ROOM_STATE", lambda p: p["room"]["phase"] == "COUNTDOWN"))["room"]
        self.assertEqual(first["startsAt"], second["startsAt"])
        self.now = first["startsAt"]
        await a.send(json.dumps({"type": "INPUT", "matchId": first["matchId"], "seq": 1, "action": "FIRE", "playerId": sb["playerId"]}))
        self.assertTrue((await self.until(a, "INPUT_RESULT"))["accepted"])
        state = (await self.until(b, "ROOM_STATE", lambda p: any(player["ammo"] == 29 for player in p["room"]["players"])))["room"]
        self.assertEqual({p["id"]: p["ammo"] for p in state["players"]}, {sa["playerId"]: 29, sb["playerId"]: 30})
        await outsider.send(json.dumps({"type": "INPUT", "matchId": first["matchId"], "seq": 1, "action": "FIRE"}))
        self.assertEqual((await self.until(outsider, "ERROR"))["code"], "NOT_IN_ROOM")
        replacement, sr = await self.peer(sa["token"])
        self.assertEqual(sr["playerId"], sa["playerId"])
        self.assertEqual(sr["nextSequence"], 2)
        resumed = (await self.until(replacement, "ROOM_STATE"))["room"]
        self.assertEqual(resumed["phase"], "PAUSED")
        self.assertEqual(resumed["players"][0]["ammo"], 29)
        await asyncio.wait_for(a.wait_closed(), timeout=3)
        self.assertEqual(a.close_code, 1008)
        self.assertTrue(self.application.arena.players[sa["token"]].connected)

    async def test_http_allowlist_origin_and_malformed_message(self):
        def read(path):
            with urllib.request.urlopen(self.origin+path, timeout=2) as response:
                return response.headers["Content-Type"], response.read()
        mime, body = await asyncio.to_thread(read, "/?input=touch")
        self.assertIn("text/html", mime)
        self.assertIn(b"create-room", body)
        with self.assertRaises(urllib.error.HTTPError) as error:
            await asyncio.to_thread(read, "/research/design/training-v2/phone-session.json")
        self.assertEqual(error.exception.code, 404)
        error.exception.close()
        with self.assertRaises(InvalidStatus) as error:
            async with connect(self.url, origin="https://unrelated.invalid"):
                pass
        self.assertEqual(error.exception.response.status_code, 403)
        peer, _ = await self.peer()
        await peer.send("{broken")
        self.assertEqual((await self.until(peer, "ERROR"))["code"], "INVALID_MESSAGE")
        await peer.send(json.dumps({"type": "PING", "nonce": "still-alive"}))
        self.assertEqual((await self.until(peer, "PONG"))["nonce"], "still-alive")


if __name__ == "__main__":
    unittest.main()
