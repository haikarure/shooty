# iPega controller input

The Android game connects directly to ARGunGame through Web Bluetooth. Use a
secure context (HTTPS or localhost) and a browser that exposes Web Bluetooth.
Select **Hubungkan pistol**, choose the controller, and register Reload using two
clean press/release cycles. Trigger remains dedicated to shooting; touch controls
are available on the second phone.

The measured service is `fff0` and input characteristic is `fff3`. Trigger press
is the exact ASCII payload `ARGun KeyPressed`; release is 16 zero bytes. Auxiliary
buttons use `B2DOWN`/`B2UP` through `B9` and `BA`. Repeated held packets are
ignored. Unknown packets and `fff1` telemetry never authorize a shot.

`ipega_protocol.py` handles the legacy laptop bridge. Set `SHOOTY_GUN_MAC` when
using that bridge; it is not the multiplayer input path. Multiplayer uses each
phone's own browser controller/touch session and the same authoritative server.
No device-specific MAC address or phone session is distributed in this repo.

[Game/server setup](../server/README.md). Packet-only regression fixtures are in
`tests/fixtures/controller/`; physical recordings and device diagnostics are not
included in source control.
