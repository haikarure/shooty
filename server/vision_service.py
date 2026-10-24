"""Authenticated binary camera stream; inference stays off the room event loop."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
import copy
import json
import struct

from websockets.exceptions import ConnectionClosed

from .duel import RuleError


@dataclass
class Stream:
    peer: object
    tracker: object
    control_peer: object
    target_id: str | None = None
    room_code: str | None = None
    last_preview: int = 0


class VisionService:
    def __init__(self, application):
        self.app = application
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="shooty-vision")
        self.engine = None
        self.load_task = None
        self.streams = {}
        self.enrollments = {}  # player ID -> (player, room code, private feature)

    def load(self):
        from .vision_engine import VisionEngine, FaceTargetTracker
        return VisionEngine(self.app.root/"web/models"), FaceTargetTracker

    def prune(self):
        for player_id, (player, code, _) in list(self.enrollments.items()):
            room = self.app.arena.rooms.get(code)
            if player.room != code or room is None or room.phase == 'ENDED':
                del self.enrollments[player_id]
                player.face_enrolled = False

    def references(self, player):
        self.prune()
        opponent = self.opponent(player)
        own = self.enrollments.get(player.id)
        other = self.enrollments.get(opponent.id) if opponent else None
        return own[2] if own else None, other[2] if other else None

    def enrollment_state(self, player):
        own, other = self.references(player)
        return {'selfEnrolled': own is not None, 'opponentEnrolled': other is not None}

    async def ensure_engine(self):
        if self.load_task is None:
            self.load_task = asyncio.get_running_loop().run_in_executor(self.executor, self.load)
        self.engine, self.Tracker = await asyncio.shield(self.load_task)

    @staticmethod
    def unpack(raw):
        if not isinstance(raw, bytes) or len(raw) < 8 or len(raw) > 264192:
            raise ValueError("INVALID_FRAME_PACKET")
        length = struct.unpack(">I", raw[:4])[0]
        if not 1 <= length <= 1024 or length+4 >= len(raw):
            raise ValueError("INVALID_FRAME_PACKET")
        header = json.loads(raw[4:4+length].decode())
        if not isinstance(header, dict) or header.get("kind") not in ("PREVIEW", "SHOT", "ENROLL") or type(header.get("frameId")) is not int:
            raise ValueError("INVALID_FRAME_HEADER")
        if not 1 <= header["frameId"] <= 2**31-1:
            raise ValueError("INVALID_FRAME_HEADER")
        return header, raw[4+length:]

    def opponent(self, player):
        room = self.app.arena.rooms.get(player.room)
        return next((p for p in self.app.arena._members(room) if p.id != player.id), None) if room else None

    async def handler(self, peer):
        player, stream = None, None
        try:
            hello = self.app.decode(await asyncio.wait_for(peer.recv(), timeout=10))
            token = hello.get("token")
            player = self.app.arena.players.get(token) if isinstance(token, str) else None
            if hello.get("type") != "HELLO" or player is None or not player.connected or player.id not in self.app.peers:
                await peer.close(1008, "Room session required")
                return
            if player.id not in self.streams and len(self.streams) >= 4:
                await peer.close(1013, "Vision server busy")
                return
            await asyncio.wait_for(self.ensure_engine(), timeout=15)
            stream = Stream(peer, self.Tracker(), self.app.peers[player.id])
            previous = self.streams.get(player.id)
            self.streams[player.id] = stream
            if previous:
                await previous.peer.close(1008, "Vision resumed elsewhere")
            await peer.send(json.dumps({"type": "VISION_READY", "engine": "yunet+sface+mediapipe-pose-lite", "fpsLimit": 5, **self.enrollment_state(player)}))
            window, count = self.app.arena.clock(), 0
            async for raw in peer:
                if self.streams.get(player.id) is not stream or not player.connected or self.app.peers.get(player.id) is not stream.control_peer:
                    break
                now = self.app.arena.clock()
                if now-window >= 1000:
                    window, count = now, 0
                count += 1
                if count > 20:
                    await peer.close(1008, "Too many frames")
                    break
                try:
                    if isinstance(raw, str):
                        await self.control(player, stream, self.app.decode(raw))
                    else:
                        await self.frame(player, stream, raw)
                except (ValueError, RuleError) as error:
                    await peer.send(json.dumps({"type": "VISION_ERROR", "code": str(error)}))
        except (ConnectionClosed, TimeoutError):
            pass
        except Exception:
            # No camera data or credentials are included in error messages.
            try:
                await peer.send(json.dumps({"type": "VISION_ERROR", "code": "ENGINE_UNAVAILABLE"}))
                await peer.close(1011, "Vision engine unavailable")
            except ConnectionClosed:
                pass
        finally:
            if player is not None and stream is not None and self.streams.get(player.id) is stream:
                del self.streams[player.id]
                async with self.app.lock:
                    await self.app.emit(self.app.arena.update_vision(player, False))

    async def control(self, player, stream, message):
        if message.get("type") == "UNLOCK":
            stream.tracker.invalid = True
            stream.target_id = None
            player.target_generation += 1
            async with self.app.lock:
                await self.app.emit(self.app.arena.update_vision(player, True))
            await stream.peer.send(json.dumps({"type": "TARGET_LOCK", "locked": False}))
            return
        raise ValueError("INVALID_VISION_COMMAND")

    async def enroll(self, player, stream, image):
        code = player.room
        room = self.app.arena.rooms.get(code)
        if room is None or room.mode != 'VISION':
            raise RuleError('SELFIE_ROOM_REQUIRED')
        if room.phase not in ('LOBBY', 'PAUSED'):
            raise RuleError('PAUSE_TO_ENROLL')
        feature = await asyncio.get_running_loop().run_in_executor(self.executor, self.engine.enroll, image)
        from .face_identity import similarity
        async with self.app.lock:
            if self.streams.get(player.id) is not stream or self.app.peers.get(player.id) is not stream.control_peer or player.room != code or room.phase not in ('LOBBY', 'PAUSED'):
                raise RuleError('STALE_ENROLLMENT')
            _, other = self.references(player)
            if other is not None and similarity(feature, other) >= .65:
                raise ValueError('SELFIE_SAME_AS_OPPONENT')
            self.enrollments[player.id] = (player, code, feature)
            for member in self.app.arena._members(room):
                member.target_generation += 1
                member.target_locked = False
                camera = self.streams.get(member.id)
                if camera:
                    camera.tracker = self.Tracker()
            await self.app.emit(self.app.arena.set_enrollment(player, True))
        await stream.peer.send(json.dumps({'type': 'ENROLLMENT_RESULT', 'accepted': True, **self.enrollment_state(player)}))
        opponent = self.opponent(player)
        other_stream = self.streams.get(opponent.id) if opponent else None
        if other_stream:
            try:
                await other_stream.peer.send(json.dumps({'type': 'ENROLLMENT_STATE', **self.enrollment_state(opponent)}))
            except ConnectionClosed:
                pass

    async def frame(self, player, stream, raw):
        header, image = self.unpack(raw)
        if header['kind'] == 'ENROLL':
            await self.enroll(player, stream, image)
            return
        now, shot = self.app.arena.clock(), None
        if header["kind"] == "SHOT":
            async with self.app.lock:
                shot = self.app.arena.claim_shot(player, header.get("shotId"))
        elif header["frameId"] <= stream.last_preview:
            raise ValueError("STALE_FRAME")
        else:
            stream.last_preview = header["frameId"]
        try:
            analysis = await asyncio.get_running_loop().run_in_executor(self.executor, self.engine.analyze, image)
        except Exception:
            if shot:
                async with self.app.lock:
                    await self.app.emit(self.app.arena.resolve_shot(shot, "MISS", "INVALID_EVIDENCE"))
            raise ValueError("INVALID_FRAME")
        if self.streams.get(player.id) is not stream or self.app.peers.get(player.id) is not stream.control_peer:
            return
        opponent = self.opponent(player)
        if player.room != stream.room_code or opponent is None or opponent.id != stream.target_id:
            stream.tracker = self.Tracker()
            stream.room_code, stream.target_id = player.room, opponent.id if opponent else None
        own_reference, opponent_reference = self.references(player)
        for candidate in analysis.candidates:
            candidate.face_matches = self.engine.identity.matches(candidate.face_feature, opponent_reference, own_reference)
        # A shot image may arrive after a newer preview. Don't rewind the live track.
        tracker = copy.copy(stream.tracker) if shot else stream.tracker
        selected = tracker.select(analysis.candidates, now)
        if shot:
            valid = shot.target_generation == player.target_generation and shot.target == stream.target_id
            decision = selected.hit((.5, .5), analysis.width, analysis.height) if selected is not None and valid else "MISS"
            reason = None if selected is not None and valid else "TARGET_NOT_CONFIRMED"
            async with self.app.lock:
                await self.app.emit(self.app.arena.resolve_shot(shot, decision, reason))
            await stream.peer.send(json.dumps({"type": "FRAME_RECEIVED", "kind": "SHOT", "frameId": header["frameId"]}))
        else:
            # Preview masks aren't retained; lock needs geometry and descriptors only.
            for candidate in analysis.candidates:
                candidate.mask = None
            locked = not stream.tracker.invalid and stream.target_id is not None
            async with self.app.lock:
                await self.app.emit(self.app.arena.update_vision(player, True, locked, stream.target_id))
            await stream.peer.send(json.dumps({"type": "VISION_FRAME", "frameId": header["frameId"],
                "serverNow": now, "width": analysis.width, "height": analysis.height,
                "inferenceMs": analysis.elapsed_ms, "locked": locked, "targetVisible": selected is not None,
                "targetId": stream.target_id if locked else None,
                **self.enrollment_state(player),
                "candidates": [{**c.public, "selected": c is selected} for c in analysis.candidates]}))

    async def close(self):
        for player, _, _ in self.enrollments.values():
            player.face_enrolled = False
        self.enrollments.clear()
        if self.load_task is not None:
            try:
                engine, _ = await self.load_task
                await asyncio.get_running_loop().run_in_executor(self.executor, engine.close)
            except Exception:
                pass
        await asyncio.to_thread(self.executor.shutdown, wait=True, cancel_futures=True)
