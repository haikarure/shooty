"""Normalize the iPega ARGunGame packets observed on the user's controller.

Only the measured fff3 protocol authorizes input. Unknown fff1 data is telemetry.
This decoder determines button edges, not hits, game results, or financial state.
"""

import re


INPUT_UUID = "0000fff3-0000-1000-8000-00805f9b34fb"
TRIGGER_PRESS = b"ARGun KeyPressed"
TRIGGER_RELEASE = bytes(16)
BUTTON_PACKET = re.compile(rb"B([2-9A])(DOWN|UP)")


class IpegaDecoder:
    def __init__(self):
        self.sequence = 0
        self.reset()

    def reset(self):
        """Forget held inputs on disconnect/reconnect; keep event IDs increasing."""
        self.trigger_pressed = False
        self.buttons_pressed = set()

    def decode(self, characteristic, data):
        payload = bytes(data)
        metadata = {
            "channel": characteristic[4:8],
            "raw_hex": payload.hex(),
            "bytes": list(payload),
        }
        if characteristic.lower() != INPUT_UUID:
            return {"event": "CONTROLLER_DATA", **metadata}

        if payload == TRIGGER_PRESS:
            if self.trigger_pressed:
                return None
            self.trigger_pressed = True
            event = {"event": "TRIGGER_FIRE", "pressed": True}
        elif payload == TRIGGER_RELEASE:
            if not self.trigger_pressed:
                return None
            self.trigger_pressed = False
            event = {"event": "TRIGGER_RELEASE", "pressed": False}
        else:
            match = BUTTON_PACKET.fullmatch(payload)
            if not match:
                return {"event": "CONTROLLER_DATA", **metadata}
            button = match[1].decode("ascii")
            pressed = match[2] == b"DOWN"
            if pressed == (button in self.buttons_pressed):
                return None
            if pressed:
                self.buttons_pressed.add(button)
            else:
                self.buttons_pressed.discard(button)
            event = {"event": "AUX_BUTTON", "button": button, "pressed": pressed}

        self.sequence += 1
        return {**event, **metadata, "sequence": self.sequence}
