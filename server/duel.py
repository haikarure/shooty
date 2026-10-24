"""Authoritative input and camera-demo health. Wallets and payouts are separate."""

from dataclasses import dataclass, field
import re
import secrets
import time

RULES = {"version": "duel-input-v1", "capacity": 30, "reloadMs": 1200,
         "cooldownMs": 200, "countdownMs": 3000, "durationMs": 120000}
VISION_RULES = {**RULES, "version": "duel-selfie-v2", "cooldownMs": 400,
                "health": 100, "bodyDamage": 25, "headDamage": 50,
                "shotEvidenceMs": 1500, "tradeWindowMs": 100}


class RuleError(Exception):
    pass


@dataclass
class Player:
    token: str
    id: str = field(default_factory=lambda: secrets.token_hex(8))
    name: str = ""
    room: str | None = None
    connected: bool = True
    visible: bool = False
    controller_ready: bool = False
    input_kind: str = "touch"
    ready: bool = False
    ammo: int = 30
    shots: int = 0
    reload_at: int | None = None
    last_shot: int = -1000000
    last_sequence: int = 0
    touched: int = 0
    disconnected_at: int | None = None
    health: int = 100
    hits: int = 0
    headshots: int = 0
    camera_at: int | None = None
    target_id: str | None = None
    target_locked: bool = False
    target_generation: int = 0
    face_enrolled: bool = False
    wallet: str | None = None
    wallet_active: bool = False
    wallet_expires_at: int = 0


@dataclass
class Shot:
    id: str
    owner: str
    target: str | None
    code: str
    match_id: str
    epoch: int
    sequence: int
    accepted_at: int
    expires_at: int
    target_generation: int = 0
    claimed: bool = False
    settled: bool = False
    decision: str | None = None
    reason: str | None = None


@dataclass
class Room:
    code: str
    players: list = field(default_factory=list)
    phase: str = "LOBBY"
    revision: int = 0
    match_id: str | None = None
    starts_at: int | None = None
    ends_at: int | None = None
    remaining_ms: int = RULES["durationMs"]
    reason: str | None = None
    touched: int = 0
    mode: str = "INPUT"
    live_epoch: int = 0
    pending: list = field(default_factory=list)
    lethal_at: int | None = None
    winner_id: str | None = None
    outcome: str | None = None
    funding: dict | None = None


class Arena:
    def __init__(self, clock=None):
        self.clock = clock or (lambda: int(time.monotonic() * 1000))
        self.players = {}  # Opaque resume credentials never enter public snapshots.
        self.rooms = {}
        self.shots = {}

    def rules(self, room):
        return VISION_RULES if room.mode == "VISION" else RULES

    def camera_ready(self, player):
        return player.camera_at is not None and self.clock()-player.camera_at < 2000

    def set_enrollment(self, player, enrolled):
        player.face_enrolled = enrolled
        player.ready = False
        if player.room:
            room = self._room(player)
            self._pause(room, "SELFIE_CHANGED")
            return self._publish(room)
        return []

    def update_vision(self, player, stream, locked=False, target_id=None):
        changed = (player.target_locked, player.target_id) != (locked, target_id)
        player.camera_at = self.clock() if stream else None
        player.target_locked, player.target_id = locked, target_id
        if player.room:
            room = self._room(player)
            if not stream and room.mode == "VISION":
                self._pause(room, "CAMERA_UNAVAILABLE")
                changed = True
            if changed:
                return self._publish(room)
        return []

    def _cancel_shots(self, room):
        for shot_id in room.pending:
            self.shots[shot_id].settled = True
        room.pending.clear()
        room.live_epoch += 1

    def connect(self, token=None):
        now = self.clock()
        player = self.players.get(token) if isinstance(token, str) else None
        resumed = player is not None
        if player is None:
            if len(self.players) >= 1024:
                raise RuleError("SERVER_FULL")
            player = Player(token=secrets.token_urlsafe(32), touched=now)
            self.players[player.token] = player
        player.connected = True
        player.disconnected_at = None
        player.visible = player.controller_ready = player.ready = False
        player.camera_at, player.target_id, player.target_locked = None, None, False
        player.target_generation += 1
        player.touched = now
        events = [(player.id, {"type": "SESSION", "token": player.token,
                              "playerId": player.id, "resumed": resumed,
                              "nextSequence": player.last_sequence + 1, "serverNow": now})]
        if player.room:
            room = self.rooms[player.room]
            self._pause(room, "PLAYER_RECONNECTED")
            events += self._publish(room)
        return player, events

    def disconnect(self, player):
        player.connected = player.visible = player.controller_ready = player.ready = False
        player.disconnected_at = player.touched = self.clock()
        if player.room:
            room = self.rooms[player.room]
            self._pause(room, "PLAYER_DISCONNECTED")
            return self._publish(room)
        return []

    def _members(self, room):
        return [self.players[token] for token in room.players]

    def _pause(self, room, reason):
        if room.phase not in ("COUNTDOWN", "LIVE", "CHAIN_STARTING"):
            return
        if room.ends_at is not None:
            room.remaining_ms = max(0, room.ends_at - self.clock())
        room.phase = "PAUSED"
        self._cancel_shots(room)
        room.starts_at = room.ends_at = None
        room.reason = reason
        for member in self._members(room):
            member.ready = False
            member.reload_at = None

    def state(self, room):
        state = {"code": room.code, "revision": room.revision, "phase": room.phase, "mode": room.mode,
                "matchId": room.match_id, "startsAt": room.starts_at, "endsAt": room.ends_at,
                "reason": room.reason, "serverNow": self.clock(), "rules": dict(self.rules(room)),
                "players": [{"id": p.id, "name": p.name or f"Pemain {index+1}",
                             "connected": p.connected, "available": p.visible and p.controller_ready,
                             "inputKind": p.input_kind, "ready": p.ready, "ammo": p.ammo,
                             "shots": p.shots, "reloadAt": p.reload_at}
                            for index, p in enumerate(self._members(room))]}
        if room.mode == "VISION":
            state.update(winnerId=room.winner_id, outcome=room.outcome)
            for public, player in zip(state["players"], self._members(room)):
                public.update(health=player.health, hits=player.hits, headshots=player.headshots,
                              cameraReady=self.camera_ready(player), targetLocked=player.target_locked, faceEnrolled=player.face_enrolled)
        if room.funding:
            state['funding'] = dict(room.funding)
            for public, player in zip(state['players'],self._members(room)):
                public.update(wallet=player.wallet, walletAuthenticated=player.wallet_active and player.wallet_expires_at>self.clock())
        return state

    def _publish(self, room, action=None, actor=None, details=None):
        room.revision += 1
        room.touched = self.clock()
        payload = {"type": "ROOM_STATE", "room": self.state(room)}
        events = [(p.id, payload) for p in self._members(room) if p.connected]
        if action:
            notification = {"type": "ROOM_EVENT", "code": room.code, "matchId": room.match_id,
                            "action": action, "playerId": actor, "revision": room.revision, "serverNow": self.clock()}
            if details:
                notification.update(details)
            events += [(p.id, notification) for p in self._members(room) if p.connected]
        return events

    def _room(self, player):
        if not player.room or player.room not in self.rooms:
            raise RuleError("NOT_IN_ROOM")
        return self.rooms[player.room]

    def handle(self, player, message):
        events = self.tick()
        now = self.clock()
        player.touched = now
        kind = message.get("type")
        try:
            if kind == "PING":
                return events + [(player.id, {"type": "PONG", "nonce": message.get("nonce"), "serverNow": now})]
            if kind == "AVAILABLE":
                if not isinstance(message.get("visible"), bool) or not isinstance(message.get("controllerReady"), bool) or message.get("inputKind") not in ("gun", "touch"):
                    raise RuleError("INVALID_AVAILABILITY")
                changed = (player.visible, player.controller_ready, player.input_kind) != (message["visible"], message["controllerReady"], message["inputKind"])
                player.visible, player.controller_ready, player.input_kind = message["visible"], message["controllerReady"], message["inputKind"]
                if changed and player.room:
                    room = self._room(player)
                    player.ready = False
                    self._pause(room, "DEVICE_CHANGED")
                    events += self._publish(room)
                return events
            if kind in ("CREATE_ROOM", "JOIN_ROOM"):
                if player.room:
                    raise RuleError("ALREADY_IN_ROOM")
                name = message.get("name", "")
                if not isinstance(name, str):
                    raise RuleError("INVALID_NAME")
                player.name = "".join(c for c in name if c.isprintable()).strip()[:18]
                if kind == "CREATE_ROOM":
                    if len(self.rooms) >= 128:
                        raise RuleError("SERVER_FULL")
                    while True:
                        code = "".join(secrets.choice("ABCDEFGHJKLMNPQRSTUVWXYZ23456789") for _ in range(6))
                        if code not in self.rooms:
                            break
                    mode = message.get("mode", "INPUT")
                    if mode not in ("INPUT", "VISION"):
                        raise RuleError("INVALID_MODE")
                    room = Room(code=code, touched=now, mode=mode)
                    if message.get('funding') == 'TEST_USDC':
                        room.funding = {'stage':'WAITING_ROSTER','sealed':False,'started':False,'entry':'1000000','roster':[],'depositMask':0}
                    self.rooms[code] = room
                else:
                    code = message.get("code")
                    if not isinstance(code, str) or not re.fullmatch(r"[A-Z2-9]{6}", code.strip().upper()):
                        raise RuleError("INVALID_ROOM_CODE")
                    room = self.rooms.get(code.strip().upper())
                    if room is None:
                        raise RuleError("ROOM_NOT_FOUND")
                    if len(room.players) >= 2:
                        raise RuleError("ROOM_FULL")
                    if room.match_id is not None:
                        raise RuleError("ROOM_ALREADY_STARTED")
                player.room = room.code
                player.ready = False
                player.health, player.hits, player.headshots = 100, 0, 0
                player.target_id, player.target_locked = None, False
                player.face_enrolled = False
                player.ammo, player.shots, player.reload_at, player.last_shot = RULES["capacity"], 0, None, -1000000
                room.players.append(player.token)
                return events + self._publish(room)
            if kind == "LEAVE_ROOM":
                room = self._room(player)
                if room.funding and room.funding.get('sealed') and int(room.funding.get('onchainState',0)) not in (4,5):
                    raise RuleError('FUNDED_ROOM_LOCKED')
                if room.match_id:
                    self._cancel_shots(room)
                    room.phase, room.reason = "ENDED", "PLAYER_LEFT"
                    if room.mode == "VISION":
                        room.outcome, room.winner_id = "CANCELLED", None
                    room.starts_at = room.ends_at = None
                    for member in self._members(room):
                        member.ready = False
                        member.reload_at = None
                room.players.remove(player.token)
                player.room, player.ready, player.reload_at = None, False, None
                player.face_enrolled = False
                events.append((player.id, {"type": "ROOM_LEFT"}))
                if room.players:
                    events += self._publish(room)
                else:
                    del self.rooms[room.code]
                return events
            if kind == "READY":
                room = self._room(player)
                ready = message.get("ready")
                if not isinstance(ready, bool):
                    raise RuleError("INVALID_READY")
                if room.phase == "ENDED":
                    raise RuleError("ROOM_ENDED")
                if room.phase == "RESOLVING":
                    raise RuleError("RESULT_PENDING")
                if ready and not (player.connected and player.visible and player.controller_ready):
                    raise RuleError("DEVICE_NOT_READY")
                if ready and room.funding:
                    if not player.wallet_active or player.wallet_expires_at <= now: raise RuleError('WALLET_REQUIRED')
                    if int(room.funding.get('onchainState',0)) not in (2,3): raise RuleError('MATCH_NOT_FUNDED')
                if ready and room.mode == "VISION":
                    opponent = next((p for p in self._members(room) if p.id != player.id), None)
                    if not player.face_enrolled:
                        raise RuleError("SELFIE_REQUIRED")
                    if opponent is None or not opponent.face_enrolled:
                        raise RuleError("OPPONENT_SELFIE_REQUIRED")
                    if not self.camera_ready(player):
                        raise RuleError("VISION_NOT_READY")
                    player.target_id = opponent.id
                if not ready:
                    self._pause(room, "PLAYER_NOT_READY")
                player.ready = ready
                members=self._members(room)
                all_ready=all(p.ready and p.connected and p.visible and p.controller_ready for p in members)
                if room.mode=='VISION':all_ready=all_ready and all(p.face_enrolled and self.camera_ready(p) for p in members)
                if room.funding:all_ready=all_ready and all(p.wallet_active and p.wallet_expires_at>now for p in members)
                if room.phase in ("LOBBY", "PAUSED") and len(room.players) == 2 and all_ready:
                    room.match_id = room.match_id or secrets.token_hex(16)
                    room.reason = None
                    if room.funding and not room.funding.get('started'):
                        room.phase='CHAIN_STARTING';room.starts_at=None
                    else:
                        room.phase="COUNTDOWN";room.starts_at=now+RULES['countdownMs']
                return events + self._publish(room)
            if kind == "INPUT":
                room = self._room(player)
                sequence = message.get("seq")
                if type(sequence) is not int or not 1 <= sequence <= 2**31-1 or sequence <= player.last_sequence:
                    raise RuleError("STALE_SEQUENCE")
                player.last_sequence = sequence
                reason = None
                action = message.get("action")
                rules = self.rules(room)
                trade = room.phase == "RESOLVING" and action == "FIRE" and now <= room.lethal_at+rules.get("tradeWindowMs", 0)
                if message.get("matchId") != room.match_id or room.match_id is None:
                    reason = "STALE_MATCH"
                elif (room.phase != "LIVE" and not trade) or not (player.ready and player.connected and player.visible and player.controller_ready):
                    reason = "NOT_LIVE"
                elif room.mode == "VISION" and not self.camera_ready(player):
                    reason = "CAMERA_NOT_READY"
                elif action not in ("FIRE", "RELOAD"):
                    reason = "INVALID_ACTION"
                elif player.reload_at is not None:
                    reason = "RELOADING"
                elif action == "FIRE":
                    if now - player.last_shot < rules["cooldownMs"]:
                        reason = "COOLDOWN"
                    else:
                        player.last_shot = now
                        if player.ammo == 0:
                            reason = "EMPTY"
                        else:
                            player.ammo -= 1
                            player.shots += 1
                elif player.ammo == rules["capacity"]:
                    reason = "FULL"
                else:
                    player.reload_at = now + rules["reloadMs"]
                shot_id = None
                if reason is None and action == "FIRE" and room.mode == "VISION":
                    shot_id = secrets.token_urlsafe(20)
                    self.shots[shot_id] = Shot(shot_id, player.id, player.target_id, room.code,
                        room.match_id, room.live_epoch, sequence, now, now+rules["shotEvidenceMs"], player.target_generation)
                    room.pending.append(shot_id)
                if reason is None:
                    events += self._publish(room, action, player.id)
                return events + [(player.id, {"type": "INPUT_RESULT", "code": room.code, "matchId": room.match_id,
                                              "seq": sequence, "action": action, "accepted": reason is None,
                                              "reason": reason, "serverNow": now, **({"shotId": shot_id} if shot_id else {})})]
            raise RuleError("INVALID_COMMAND")
        except RuleError as error:
            return events + [(player.id, {"type": "ERROR", "code": str(error)})]

    def claim_shot(self, player, shot_id):
        shot = self.shots.get(shot_id) if isinstance(shot_id, str) else None
        if not shot or shot.owner != player.id or shot.claimed or shot.settled or self.clock() > shot.expires_at:
            raise RuleError("INVALID_SHOT")
        room = self.rooms.get(shot.code)
        if not room or room.match_id != shot.match_id or room.live_epoch != shot.epoch or room.phase not in ("LIVE", "RESOLVING"):
            raise RuleError("STALE_SHOT")
        shot.claimed = True
        return shot

    def resolve_shot(self, shot, decision, reason=None):
        if shot.settled:
            return []
        room = self.rooms.get(shot.code)
        if not room or room.live_epoch != shot.epoch or room.match_id != shot.match_id:
            shot.settled = True
            return []
        shot.decision = decision if decision in ("HEAD", "BODY", "MISS") else "MISS"
        shot.reason = reason
        if self.clock() > shot.expires_at:
            shot.decision, shot.reason = "MISS", "EVIDENCE_TIMEOUT"
        return self._settle(room)

    def _settle(self, room):
        events, now = [], self.clock()
        rules = self.rules(room)
        while room.pending:
            shot = self.shots[room.pending[0]]
            if shot.decision is None and now <= shot.expires_at:
                break
            room.pending.pop(0)
            shot.settled = True
            if shot.decision is None:
                shot.decision, shot.reason = "MISS", "EVIDENCE_TIMEOUT"
            if room.lethal_at is not None and shot.accepted_at > room.lethal_at+rules["tradeWindowMs"]:
                shot.decision, shot.reason = "MISS", "AFTER_ELIMINATION"
            attacker = next((p for p in self._members(room) if p.id == shot.owner), None)
            target = next((p for p in self._members(room) if p.id == shot.target and p.id != shot.owner), None)
            damage = 0
            if target is not None and target.health > 0 and attacker is not None and shot.decision in ("HEAD", "BODY"):
                damage = min(target.health, rules["headDamage"] if shot.decision == "HEAD" else rules["bodyDamage"])
                target.health -= damage
                attacker.hits += 1
                attacker.headshots += shot.decision == "HEAD"
                if target.health == 0 and room.lethal_at is None:
                    room.lethal_at, room.phase = shot.accepted_at, "RESOLVING"
                events += self._publish(room, "HIT", shot.owner, {"shotId": shot.id, "targetId": target.id, "zone": shot.decision, "damage": damage, "health": target.health})
            result = {"type": "SHOT_RESULT", "code": room.code, "matchId": room.match_id,
                      "shotId": shot.id, "seq": shot.sequence, "status": "HIT" if damage else "MISS",
                      "zone": shot.decision, "damage": damage, "reason": shot.reason}
            events.append((shot.owner, result))
        if room.lethal_at is not None and now >= room.lethal_at+rules["tradeWindowMs"] and not room.pending:
            alive = [p for p in self._members(room) if p.health > 0]
            room.outcome, room.winner_id = ("WIN", alive[0].id) if len(alive) == 1 else ("DRAW", None)
            room.phase, room.reason = "ENDED", "ELIMINATION"
            room.starts_at = room.ends_at = None
            for member in self._members(room):
                member.ready, member.reload_at = False, None
            events += self._publish(room)
        return events

    def tick(self):
        now = self.clock()
        events = []
        for room in list(self.rooms.values()):
            if room.funding and room.funding.get('wallDeadline') is not None and now >= room.funding['wallDeadline'] and room.phase not in ('ENDED','RESOLVING'):
                self._cancel_shots(room)
                room.phase, room.reason, room.outcome, room.winner_id = 'ENDED','TIME_LIMIT','DRAW',None
                room.starts_at=room.ends_at=None
                for member in self._members(room):member.ready=False;member.reload_at=None
                events+=self._publish(room)
                continue
            if room.phase == "COUNTDOWN" and now >= room.starts_at:
                room.phase = "LIVE"
                room.live_epoch += 1
                room.ends_at = min(room.starts_at + room.remaining_ms,room.funding['wallDeadline']) if room.funding else room.starts_at + room.remaining_ms
                room.starts_at = None
                events += self._publish(room)
            if room.phase == "LIVE":
                if room.mode == "VISION" and any(not self.camera_ready(p) for p in self._members(room)):
                    self._pause(room, "CAMERA_UNAVAILABLE")
                    events += self._publish(room)
                    continue
                if now >= room.ends_at:
                    room.phase, room.reason = "ENDED", "TIME_LIMIT"
                    room.ends_at = None
                    if room.mode == "VISION":
                        room.outcome, room.winner_id = "DRAW", None
                        self._cancel_shots(room)
                    for member in self._members(room):
                        member.reload_at, member.ready = None, False
                    events += self._publish(room)
                else:
                    for member in self._members(room):
                        if member.reload_at is not None and now >= member.reload_at:
                            member.reload_at = None
                            member.ammo = RULES["capacity"]
                            events += self._publish(room, "RELOAD_COMPLETE", member.id)
            if room.mode == "VISION" and room.phase in ("LIVE", "RESOLVING"):
                events += self._settle(room)
            if room.phase == "PAUSED" and any(p.disconnected_at is not None and now-p.disconnected_at >= 30000 for p in self._members(room)):
                room.phase, room.reason = "ENDED", "DISCONNECT_TIMEOUT"
                if room.mode == "VISION":
                    room.outcome, room.winner_id = "CANCELLED", None
                events += self._publish(room)
            if room.phase in ("LOBBY", "ENDED", "PAUSED") and now-room.touched > 900000:
                for member in self._members(room):
                    member.room, member.ready, member.reload_at = None, False, None
                    if member.connected:
                        events.append((member.id, {"type": "ROOM_LEFT", "reason": "EXPIRED"}))
                del self.rooms[room.code]
        for token, player in list(self.players.items()):
            if not player.connected and player.room is None and now-player.touched > 1800000:
                del self.players[token]
        for shot_id, shot in list(self.shots.items()):
            if shot.settled and now-shot.expires_at > 5000:
                del self.shots[shot_id]
        return events
