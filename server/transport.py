"""Same-port HTTP assets and room WebSocket, using installed websockets 17.x."""

import asyncio
from contextlib import asynccontextmanager, suppress
from http import HTTPStatus
import json
import os
from urllib.parse import urlsplit

from websockets.asyncio.server import serve
from websockets.datastructures import Headers
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Response

from .duel import Arena, RuleError


class Application:
    def __init__(self, root, files, arena=None, chain=False, chain_settings=None):
        self.root, self.files = root, files
        self.arena = arena or Arena()
        self.peers = {}
        self.lock = asyncio.Lock()
        self.vision = None
        self.allowed_origins = {value.strip().rstrip('/') for value in os.environ.get('SHOOTY_ALLOWED_ORIGINS', '').split(',') if value.strip()}
        from .chain_service import ChainService
        self.chain = ChainService(self,enabled=chain,settings=chain_settings)

    def http(self, connection, request):
        path = urlsplit(request.path).path
        if request.headers.get("Upgrade", "").lower() == "websocket":
            if path not in ("/ws/duel", "/ws/vision"):
                return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
            origin = request.headers.get("Origin")
            if origin:
                parsed = urlsplit(origin)
                if parsed.scheme not in ("http", "https") or (parsed.netloc != request.headers.get("Host") and origin not in self.allowed_origins):
                    return connection.respond(HTTPStatus.FORBIDDEN, "Origin rejected\n")
            return None
        entry = self.files.get(path)
        if entry is None:
            return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
        relative, mime = entry
        body = (self.root / relative).read_bytes()
        return Response(200, "OK", Headers({"Content-Type": mime, "Content-Length": str(len(body)),
                                            "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"}), body)

    async def emit(self, events):
        self.chain.audit(events)
        if self.vision is not None:
            self.vision.prune()
        # No await between room mutations; each WebSocket preserves its send order.
        for player_id, payload in events:
            peer = self.peers.get(player_id)
            if peer is not None:
                try:
                    await asyncio.wait_for(peer.send(json.dumps(payload, separators=(",", ":"))), timeout=2)
                except (ConnectionClosed, TimeoutError):
                    pass

    async def handler(self, peer):
        if urlsplit(peer.request.path).path == "/ws/vision":
            if self.vision is None:
                from .vision_service import VisionService
                self.vision = VisionService(self)
            await self.vision.handler(peer)
            return
        await self.duel_handler(peer)

    async def duel_handler(self, peer):
        player = None
        try:
            raw = await asyncio.wait_for(peer.recv(), timeout=10)
            hello = self.decode(raw)
            if hello.get("type") != "HELLO":
                await peer.close(1008, "HELLO required")
                return
            async with self.lock:
                token = hello.get("token")
                previous_vision = self.vision.streams.get(self.arena.players[token].id) if self.vision and isinstance(token, str) and token in self.arena.players else None
                player, events = self.arena.connect(token)
                previous = self.peers.get(player.id)
                self.peers[player.id] = peer
                await self.emit(events)
            if previous is not None and previous is not peer:
                await previous.close(1008, "Session resumed elsewhere")
            if previous_vision is not None:
                await previous_vision.peer.close(1008, "Room session resumed")
            await peer.send(json.dumps(self.chain.wallet_state(player)))
            await peer.send(json.dumps({'type':'CHAIN_CONFIG','config':self.chain.config}))
            window, count = self.arena.clock(), 0
            async for raw in peer:
                if self.peers.get(player.id) is not peer:
                    break
                now = self.arena.clock()
                if now-window >= 1000:
                    window, count = now, 0
                count += 1
                if count > 80:
                    await peer.close(1008, "Too many commands")
                    break
                try:
                    if not isinstance(raw, str) or len(raw) > 4096:
                        raise ValueError("Control message too large")
                    message = self.decode(raw)
                except ValueError:
                    await peer.send(json.dumps({"type": "ERROR", "code": "INVALID_MESSAGE"}))
                    continue
                if await self.chain.handle(peer,player,message):
                    continue
                if message.get('type') in ('CREATE_ROOM','JOIN_ROOM'):
                    try: await self.chain.admit(player,message)
                    except RuleError as error:
                        await peer.send(json.dumps({'type':'ERROR','code':str(error)}));continue
                async with self.lock:
                    if self.peers.get(player.id) is peer:
                        await self.emit(self.arena.handle(player, message))
        except (ConnectionClosed, TimeoutError):
            pass
        except (ValueError, RuleError):
            await peer.close(1008, "Invalid session")
        finally:
            orphaned_vision = None
            async with self.lock:
                if player is not None and self.peers.get(player.id) is peer:
                    orphaned_vision = self.vision.streams.get(player.id) if self.vision else None
                    del self.peers[player.id]
                    await self.emit(self.arena.disconnect(player))
            if orphaned_vision is not None:
                await orphaned_vision.peer.close(1001, "Room connection closed")


    @staticmethod
    def decode(raw):
        if not isinstance(raw, str):
            raise ValueError("Text JSON required")
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError("Object required")
        return value

    async def ticker(self):
        while True:
            await asyncio.sleep(.05)
            async with self.lock:
                await self.emit(self.arena.tick())


@asynccontextmanager
async def serve_application(root, files, host, port, chain=False, chain_settings=None):
    application = Application(root, files,chain=chain,chain_settings=chain_settings)
    async with serve(application.handler, host, port, process_request=application.http,
                     max_size=264192, max_queue=4, ping_interval=10, ping_timeout=10,
                     close_timeout=2, server_header=None) as service:
        ticker = asyncio.create_task(application.ticker())
        if chain:
            application.chain.task=asyncio.create_task(application.chain.run())
        try:
            yield application, service
        finally:
            ticker.cancel()
            with suppress(asyncio.CancelledError):
                await ticker
            service.close()
            await service.wait_closed()
            if application.vision is not None:
                await application.vision.close()
            await application.chain.close()
