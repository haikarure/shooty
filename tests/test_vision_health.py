"""Health decisions use server-owned shot tickets, not client hit claims."""
import unittest
from server.duel import Arena, RuleError


class VisionHealthTests(unittest.TestCase):
    def setUp(self):
        self.now = 10000
        self.arena = Arena(clock=lambda: self.now)
        self.a = self.arena.connect()[0]
        self.b = self.arena.connect()[0]
        for player in (self.a, self.b):
            self.command(player, "AVAILABLE", visible=True, controllerReady=True, inputKind="touch")
        self.command(self.a, "CREATE_ROOM", mode="VISION")
        self.room = self.arena.rooms[self.a.room]
        self.command(self.b, "JOIN_ROOM", code=self.room.code)

    def command(self, player, kind, **fields):
        return self.arena.handle(player, {"type": kind, **fields})

    def cameras(self):
        self.a.face_enrolled = self.b.face_enrolled = True
        self.arena.update_vision(self.a, True, True, self.b.id)
        self.arena.update_vision(self.b, True, True, self.a.id)

    def live(self):
        self.cameras()
        self.command(self.a, "READY", ready=True)
        self.command(self.b, "READY", ready=True)
        self.now = self.room.starts_at
        self.cameras()
        self.arena.tick()
        self.assertEqual(self.room.phase, "LIVE")

    def shot(self, player):
        self.cameras()
        events = self.command(player, "INPUT", matchId=self.room.match_id, action="FIRE", seq=player.last_sequence+1)
        result = events[-1][1]
        self.assertTrue(result["accepted"], result)
        return self.arena.claim_shot(player, result["shotId"])

    def test_selfies_and_camera_required_but_continuous_target_visibility_is_not(self):
        self.assertEqual(self.command(self.a, "READY", ready=True)[-1][1]["code"], "SELFIE_REQUIRED")
        self.arena.set_enrollment(self.a, True)
        self.assertEqual(self.command(self.a, "READY", ready=True)[-1][1]["code"], "OPPONENT_SELFIE_REQUIRED")
        self.cameras()
        self.arena.update_vision(self.a, True, False, self.b.id)
        self.arena.update_vision(self.b, True, False, self.a.id)
        self.command(self.a, "READY", ready=True)
        self.command(self.b, "READY", ready=True)
        self.assertEqual(self.room.phase, "COUNTDOWN")
        self.assertEqual(self.arena.state(self.room)["rules"]["cooldownMs"], 400)

    def test_four_body_hits_end_with_an_authoritative_winner(self):
        self.live()
        for health in (75, 50, 25, 0):
            shot = self.shot(self.a)
            self.arena.resolve_shot(shot, "BODY")
            self.assertEqual(self.b.health, health)
            self.now += 400
        self.arena.tick()
        self.assertEqual((self.room.phase, self.room.outcome, self.room.winner_id), ("ENDED", "WIN", self.a.id))
        self.assertEqual((self.a.hits, self.a.headshots, self.a.ammo), (4, 0, 26))

    def test_headshot_damage_is_fifty_and_not_double_applied(self):
        self.live()
        first = self.shot(self.a)
        self.arena.resolve_shot(first, "HEAD")
        self.arena.resolve_shot(first, "HEAD")
        self.assertEqual((self.b.health, self.a.headshots), (50, 1))
        with self.assertRaises(RuleError): self.arena.claim_shot(self.a, first.id)
        self.now += 400
        self.arena.resolve_shot(self.shot(self.a), "HEAD")
        self.now += 101; self.arena.tick()
        self.assertEqual(self.room.winner_id, self.a.id)

    def test_wrong_owner_forged_hit_and_late_evidence_do_not_damage(self):
        self.live()
        result = self.command(self.a, "HIT", playerId=self.b.id, damage=100)[-1][1]
        self.assertEqual(result["code"], "INVALID_COMMAND")
        shot = self.shot(self.a)
        with self.assertRaises(RuleError): self.arena.claim_shot(self.b, shot.id)
        self.now = shot.expires_at+1
        self.arena.resolve_shot(shot, "HEAD")
        self.assertEqual(self.b.health, 100)

    def test_pause_invalidates_pending_frame_across_resume(self):
        self.live()
        shot = self.shot(self.a)
        self.command(self.b, "READY", ready=False)
        self.arena.resolve_shot(shot, "HEAD")
        self.assertEqual(self.b.health, 100)
        self.assertTrue(shot.settled)

    def test_close_lethal_shots_trade_even_when_inference_completes_backwards(self):
        self.live()
        self.a.health = self.b.health = 50
        first = self.shot(self.a)
        self.now += 40
        second = self.shot(self.b)
        self.arena.resolve_shot(second, "HEAD")
        self.assertEqual((self.a.health, self.b.health), (50, 50))
        self.arena.resolve_shot(first, "HEAD")
        self.assertEqual((self.a.health, self.b.health), (0, 0))
        self.now += 101; self.arena.tick()
        self.assertEqual((self.room.phase, self.room.outcome, self.room.winner_id), ("ENDED", "DRAW", None))

    def test_camera_stream_timeout_pauses_without_manufacturing_a_winner(self):
        self.live()
        self.now += 2100; self.arena.tick()
        self.assertEqual((self.room.phase, self.room.reason), ("PAUSED", "CAMERA_UNAVAILABLE"))
        self.assertIsNone(self.room.winner_id)


if __name__ == "__main__": unittest.main()
