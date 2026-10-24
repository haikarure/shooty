"""Regression checks against packets captured from the user's real controller."""

import json
from pathlib import Path
import unittest

from hardware.ipega_protocol import IpegaDecoder, INPUT_UUID, TRIGGER_PRESS, TRIGGER_RELEASE


ROOT = Path(__file__).resolve().parents[1]


class IpegaProtocolTests(unittest.TestCase):
    def test_actual_trigger_capture_has_twelve_shots_and_twelve_releases(self):
        capture = ROOT / "tests/fixtures/controller/gun-probe-20261024T041902528662Z.json"
        decoder = IpegaDecoder()
        events = [decoder.decode(packet["uuid"], bytes.fromhex(packet["hex"])) for packet in json.loads(capture.read_text())["notifications"]]
        self.assertEqual(sum(event is not None and event["event"] == "TRIGGER_FIRE" for event in events), 12)
        self.assertEqual(sum(event is not None and event["event"] == "TRIGGER_RELEASE" for event in events), 12)

    def test_all_captured_button_edges_are_separate_from_shots(self):
        capture = ROOT / "tests/fixtures/controller/gun-probe-20261024T041708282838Z.json"
        decoder = IpegaDecoder()
        buttons = set()
        for packet in json.loads(capture.read_text())["notifications"]:
            payload = bytes.fromhex(packet["hex"])
            event = decoder.decode(packet["uuid"], payload)
            if payload.startswith(b"B") and event is not None:
                self.assertEqual(event["event"], "AUX_BUTTON")
                buttons.add(event["button"])
            if payload == bytes(16) and event is not None:
                self.assertEqual(event["event"], "TRIGGER_RELEASE")
        self.assertEqual(buttons, set("23456789A"))

    def test_repeated_pressed_notification_does_not_repeat_shot(self):
        decoder = IpegaDecoder()
        self.assertEqual(decoder.decode(INPUT_UUID, TRIGGER_PRESS)["event"], "TRIGGER_FIRE")
        self.assertIsNone(decoder.decode(INPUT_UUID, TRIGGER_PRESS))
        self.assertEqual(decoder.decode(INPUT_UUID, TRIGGER_RELEASE)["event"], "TRIGGER_RELEASE")
        self.assertIsNone(decoder.decode(INPUT_UUID, TRIGGER_RELEASE))
        self.assertEqual(decoder.decode(INPUT_UUID, TRIGGER_PRESS)["event"], "TRIGGER_FIRE")

    def test_telemetry_and_unknown_packets_never_authorize_shots(self):
        decoder = IpegaDecoder()
        for characteristic, payload in ((INPUT_UUID.replace("fff3", "fff1"), TRIGGER_PRESS), (INPUT_UUID, b"ARGun KeyPressed\x00"), (INPUT_UUID, b"B1DOWN"), (INPUT_UUID, b"\xff\xfe"), (INPUT_UUID, b"")):
            with self.subTest(characteristic=characteristic, payload=payload):
                self.assertEqual(decoder.decode(characteristic, payload)["event"], "CONTROLLER_DATA")

    def test_buttons_do_not_release_held_trigger_and_reset_rearms_input(self):
        decoder = IpegaDecoder()
        first = decoder.decode(INPUT_UUID, TRIGGER_PRESS)
        self.assertEqual(decoder.decode(INPUT_UUID, b"B7DOWN")["event"], "AUX_BUTTON")
        self.assertIsNone(decoder.decode(INPUT_UUID, b"B7DOWN"))
        self.assertEqual(decoder.decode(INPUT_UUID, b"B7UP")["event"], "AUX_BUTTON")
        self.assertIsNone(decoder.decode(INPUT_UUID, TRIGGER_PRESS))
        decoder.reset()
        next_event = decoder.decode(INPUT_UUID, TRIGGER_PRESS)
        self.assertEqual(next_event["event"], "TRIGGER_FIRE")
        self.assertGreater(next_event["sequence"], first["sequence"])


if __name__ == "__main__":
    unittest.main()
