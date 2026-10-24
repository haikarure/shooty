"""Domain regression checks with a controlled server clock."""
import json
import unittest

from server.duel import Arena, RULES


class DuelTests(unittest.TestCase):
    def setUp(self):
        self.now = 0
        self.arena = Arena(clock=lambda: self.now)
        self.a = self.player("gun")
        self.b = self.player("touch")

    def player(self, kind="touch"):
        player, _ = self.arena.connect()
        self.arena.handle(player, {"type": "AVAILABLE", "visible": True, "controllerReady": True, "inputKind": kind})
        return player

    def command(self, player, kind, **fields):
        return self.arena.handle(player, {"type": kind, **fields})

    def room(self):
        self.command(self.a, "CREATE_ROOM", name="Alpha")
        room = self.arena.rooms[self.a.room]
        self.command(self.b, "JOIN_ROOM", code=room.code, name="Bravo")
        return room

    def live(self):
        room = self.room()
        self.command(self.a, "READY", ready=True)
        self.command(self.b, "READY", ready=True)
        self.now = room.starts_at
        self.arena.tick()
        self.assertEqual(room.phase, "LIVE")
        return room

    def fire(self, player, room, seq, **extra):
        return self.command(player, "INPUT", matchId=room.match_id, seq=seq, action="FIRE", **extra)

    def test_seats_room_isolation_and_server_bound_identity(self):
        room = self.live()
        c = self.player()
        errors = self.command(c, "JOIN_ROOM", code=room.code)
        self.assertEqual(errors[-1][1]["code"], "ROOM_FULL")
        self.command(c, "CREATE_ROOM")
        events = self.fire(self.a, room, 1, playerId=self.b.id, ammo=999, winner=self.a.id)
        self.assertEqual((self.a.ammo, self.a.shots, self.b.ammo), (29, 1, 30))
        self.assertEqual({target for target, _ in events}, {self.a.id, self.b.id})
        public = json.dumps(self.arena.state(room))
        self.assertNotIn(self.a.token, public)
        self.assertNotIn(self.b.token, public)
        self.assertNotIn('"winner"', public)

    def test_countdown_needs_two_ready_devices_and_rejects_early_fire(self):
        room = self.room()
        self.command(self.a, "READY", ready=True)
        self.assertEqual(room.phase, "LOBBY")
        self.command(self.b, "AVAILABLE", visible=True, controllerReady=False, inputKind="touch")
        self.assertEqual(self.command(self.b, "READY", ready=True)[-1][1]["code"], "DEVICE_NOT_READY")
        self.command(self.b, "AVAILABLE", visible=True, controllerReady=True, inputKind="touch")
        events = self.command(self.b, "READY", ready=True)
        snapshots = [payload["room"] for _, payload in events if payload["type"] == "ROOM_STATE"]
        self.assertEqual(snapshots[0], snapshots[1])
        self.assertEqual(room.starts_at, RULES["countdownMs"])
        self.now = room.starts_at-1
        self.assertEqual(self.fire(self.a, room, 1)[-1][1]["reason"], "NOT_LIVE")
        self.assertEqual(self.a.ammo, 30)
        self.now += 1
        self.assertTrue(self.fire(self.a, room, 2)[-1][1]["accepted"])
        self.assertEqual(self.a.ammo, 29)

    def test_duplicate_old_match_and_cooldown_never_consume_extra_ammo(self):
        room = self.live()
        self.fire(self.a, room, 1)
        self.assertEqual(self.fire(self.a, room, 1)[-1][1]["code"], "STALE_SEQUENCE")
        self.assertEqual(self.fire(self.a, room, 2)[-1][1]["reason"], "COOLDOWN")
        self.now += 200
        event = self.command(self.a, "INPUT", matchId="old-match", seq=3, action="FIRE")[-1][1]
        self.assertEqual(event["reason"], "STALE_MATCH")
        self.assertTrue(self.fire(self.a, room, 4)[-1][1]["accepted"])
        self.assertEqual((self.a.ammo, self.a.shots), (28, 2))
        self.assertEqual(self.fire(self.a, room, True)[-1][1]["code"], "STALE_SEQUENCE")

    def test_reload_is_once_at_server_deadline_and_blocks_spam(self):
        room = self.live()
        self.fire(self.a, room, 1)
        self.command(self.a, "INPUT", matchId=room.match_id, seq=2, action="RELOAD")
        deadline = self.a.reload_at
        self.now += 100
        result = self.command(self.a, "INPUT", matchId=room.match_id, seq=3, action="RELOAD")
        self.assertEqual(result[-1][1]["reason"], "RELOADING")
        self.assertEqual(self.a.reload_at, deadline)
        self.assertEqual(self.fire(self.a, room, 4)[-1][1]["reason"], "RELOADING")
        self.now = deadline-1
        self.arena.tick()
        self.assertEqual(self.a.ammo, 29)
        self.now = deadline
        events = self.fire(self.a, room, 5)
        completed = [event for _, event in events if event.get("action") == "RELOAD_COMPLETE"]
        self.assertEqual(len(completed), 2)  # One notification per player, one refill.
        self.assertEqual((self.a.ammo, self.a.shots), (29, 2))
        self.assertFalse(self.arena.tick())

    def test_menu_or_background_pauses_everyone_and_cancels_reload(self):
        room = self.live()
        self.fire(self.a, room, 1)
        self.command(self.a, "INPUT", matchId=room.match_id, seq=2, action="RELOAD")
        self.command(self.b, "READY", ready=False)
        self.assertEqual(room.phase, "PAUSED")
        self.assertFalse(self.a.ready or self.b.ready)
        self.assertIsNone(self.a.reload_at)
        self.now += 5000
        self.assertEqual(self.a.ammo, 29)
        self.command(self.a, "READY", ready=True)
        self.command(self.b, "READY", ready=True)
        self.assertEqual(room.phase, "COUNTDOWN")
        self.now = room.starts_at
        self.arena.tick()
        self.assertEqual(self.a.ammo, 29)
        self.command(self.b, "AVAILABLE", visible=False, controllerReady=True, inputKind="touch")
        self.assertEqual(room.phase, "PAUSED")

    def test_resume_keeps_identity_ammo_and_sequence_but_requires_ready_again(self):
        room = self.live()
        self.fire(self.a, room, 1)
        self.arena.disconnect(self.a)
        self.assertEqual(room.phase, "PAUSED")
        resumed, events = self.arena.connect(self.a.token)
        self.assertIs(resumed, self.a)
        self.assertEqual(events[0][1]["nextSequence"], 2)
        self.assertEqual(self.a.ammo, 29)
        self.assertFalse(self.a.ready or self.b.ready)
        self.assertEqual(self.command(self.a, "READY", ready=True)[-1][1]["code"], "DEVICE_NOT_READY")
        self.command(self.a, "AVAILABLE", visible=True, controllerReady=True, inputKind="gun")
        self.command(self.a, "READY", ready=True)
        self.assertEqual(room.phase, "PAUSED")
        self.command(self.b, "READY", ready=True)
        self.assertEqual(room.phase, "COUNTDOWN")

    def test_timeout_and_leaving_end_input_without_fabricating_a_winner(self):
        room = self.live()
        self.now = room.ends_at
        self.arena.tick()
        self.assertEqual((room.phase, room.reason), ("ENDED", "TIME_LIMIT"))
        self.assertNotIn("winner", self.arena.state(room))
        self.assertEqual(self.fire(self.a, room, 1)[-1][1]["reason"], "NOT_LIVE")
        self.command(self.a, "LEAVE_ROOM")
        self.assertIsNone(self.a.room)
        self.assertEqual(room.reason, "PLAYER_LEFT")
        self.command(self.b, "LEAVE_ROOM")
        self.assertNotIn(room.code, self.arena.rooms)

    def test_disconnected_session_expires_without_a_forfeit_payout(self):
        room = self.live()
        self.arena.disconnect(self.b)
        self.now += 30000
        self.arena.tick()
        self.assertEqual((room.phase, room.reason), ("ENDED", "DISCONNECT_TIMEOUT"))
        self.assertNotIn("winner", self.arena.state(room))

    def test_empty_magazine_stays_empty_and_full_reload_is_a_noop(self):
        room = self.live()
        self.assertEqual(self.command(self.a, "INPUT", matchId=room.match_id, seq=1, action="RELOAD")[-1][1]["reason"], "FULL")
        for seq in range(2, 32):
            self.fire(self.a, room, seq)
            self.now += 200
        self.assertEqual((self.a.ammo, self.a.shots), (0, 30))
        self.assertEqual(self.fire(self.a, room, 32)[-1][1]["reason"], "EMPTY")
        self.assertEqual(self.a.ammo, 0)


if __name__ == "__main__":
    unittest.main()
