# Duel 1v1: camera hits and synchronized rooms

Two independent browser sessions share a private room, self-enrolled face
references, countdown, server ammo, camera hit decisions, health and winner.
Camera duels are the default in the UI;
the optional **Uji input** room preserves the earlier input-only mode.
Pass `--chain` to enable wallet authentication, test USDC deposits and payouts
against the deployed Monad Testnet arena.

From the repository root:

```bash
.venv/bin/python gun_service.py --web-only --host 127.0.0.1 --http-port 8080
```

Runtime dependencies are pinned in `requirements.txt`. On a fresh checkout, create
a Python virtual environment and install that file before starting the service.

## Monad Testnet matches

Install the root and `contracts/` npm dependencies, then run `npm run build:wallet`
from the root. Start the same service with:

```bash
.venv/bin/python gun_service.py --web-only --host 127.0.0.1 --chain --chain-key-file .env
```

The private local key file must contain the deployed relayer and referee keys.
It can be the address/privateKey backup or a JSON wallet backup. Signing stays in
a local Node worker; neither the key file nor `.secrets/` is served over HTTP.
The relayer needs test MON. Players connect their own injected wallet in Mises,
sign in, and approve/deposit exactly 1 test USDC each. They also need test MON for
their own approval and deposit transactions. Free practice is still available.

Optional process environment overrides are `MONAD_TESTNET_RPC_URL`,
`SHOOTY_ARENA_ADDRESS`, `SHOOTY_TOKEN_ADDRESS`, `ROOM_CREATOR`, `REFEREE`, and
`SHOOTY_JOURNAL_DIR`. Contract addresses and role defaults come from
`contracts/deployment/addresses.json`. Set overrides in the process environment;
the private backup is not loaded as a shell script.

The sealed room waits for finalized deposits and a referee-authorized onchain
start before countdown. Paid matches use a 120-second wall-clock limit including
countdown and pauses. Server results create credits; separate `claimFor`
transactions send the winner 1.8 test USDC and treasury 0.2. Draws and expired
matches refund actual deposits. The UI distinguishes credits from verified token
payments and exposes wallet-based claim/expiry recovery.

Keep `.secrets/chain.sqlite3` and `.secrets/chain-transactions/` on persistent
storage across restarts: they retain financial jobs and signed transaction
retries, without saving camera frames or face references. Restarting loses the
live game room; unfinished matches follow contract expiry rather than inventing
a winner. Use only testnet funds; live Mises/device validation remains separate
from the local automated checks.

Local financial integration checks (Anvil required) run with:

```bash
npm run test:chain
.venv/bin/python -m unittest discover -s tests -p 'test_chain_game_flow.py'
```

HTTP, `/ws/duel` and the authenticated binary camera stream `/ws/vision` share
port 8080. YuNet/SFace and MediaPipe run on the laptop in a single inference worker; camera
frames are not sent to an external AI service or saved by the server. The existing
`?input=bridge` training adapter retains its separate port 8765. Multiplayer uses
direct browser Bluetooth or touch; the global legacy bridge isn't a room input.

For two Android phones connected over authorized USB debugging:

```bash
adb devices -l
adb -s FIRST_SERIAL reverse tcp:8080 tcp:8080
adb -s SECOND_SERIAL reverse tcp:8080 tcp:8080
```

Open `http://localhost:8080/?input=bluetooth` on the pistol phone and
`http://localhost:8080/?input=touch` on the touch phone. Both phones reach the same
laptop server through their own reverse mapping. This localhost route keeps the
browser camera/Bluetooth secure-context requirements satisfied. Plain HTTP over
a Wi-Fi IP doesn't provide those capabilities; this task creates no public tunnel.

1. Tap **Mulai** on each phone. Connect the first phone to ARGunGame; keep the
   second in Touch mode. Use the rear camera on both phones.
2. In **Duel 1v1**, the first player creates a room and shares its six-character
   code or invitation. The second enters the code and taps **Gabung**.
3. On each phone, tap **Daftar selfie**, show your own face in the front camera,
   and tap **Simpan selfie**. The server binds the reference to that socket's
   player; a client-supplied player ID cannot enroll another session. The app
   stops the front camera and restores the rear camera
   automatically. Both players need distinct usable face references.
   A blank, distant, low-quality or ambiguous selfie can be retaken in place.
   A usable centered foreground face can be enrolled despite a smaller face in
   the background. Equally prominent competing faces are rejected. Retaking a
   selfie never deletes the earlier accepted reference on an error; **Pakai
   selfie tersimpan** returns directly to the game camera.
4. Each taps **Siap Duel**. The server starts one shared countdown when both
   sessions are connected, visible, enrolled and have a ready input device and
   rear-camera stream. **Continuous target visibility is not a readiness gate.**
   The game camera automatically identifies the opponent during play. There is
   no opponent-photo capture, target-selection step, or separate body photo.
5. Camera rules: **100 HP; body/limbs 25; confirmed headshot 50; cooldown 400 ms;
   30 rounds; reload 1,200 ms; duration 120 s**. Aim with the center crosshair.
   Four body hits or two headshots eliminate the opponent. Reload B8 remains a
   per-controller mapping. Uji input keeps its 200 ms cooldown and has no damage.
6. Opening settings, hiding the page or losing the device/connection pauses the
   session, clears readiness and cancels unfinished reloads. Both players must
   become ready again; ammo and accepted shots persist through a fresh countdown.
7. Refresh reconnects with a per-tab opaque resume token in `sessionStorage`.
   Reconnect BLE and activate rear-camera detection before readying. A same-room
   refresh retains the in-memory face reference. A new room needs a new selfie.
   Leaving or a prolonged disconnect cancels the match without a forfeit winner.

Two consistent face matches associate the opponent with their detected body.
Short-term body tracking can continue while the face is hidden. After a tracking
gap over 1.5 seconds, face confirmation is required again; clothing alone cannot
reacquire a lost identity. A visible unmatched face cannot inherit the target's
body track. Missing or ambiguous targets award no damage. Camera-stream loss
over 2 seconds pauses the room. Use a controlled two-person demo with clear
lighting: matching is probabilistic, and similarly dressed people crossing can
still confuse body tracking. There is no GPS, IR or phone direction-finding.

Raw selfies are decoded for feature extraction and are not written to disk.
Private face vectors stay only in backend RAM, scoped to the room. Leave, match
end, room expiry or server shutdown removes them. Public room/camera messages
contain enrollment/confirmation flags and geometry, never face vectors or photos.
Capture is self-enrollment, not a liveness check or proof of photo ownership.

When disconnected, the room panel has **Sambungkan server** for retrying without
a refresh. Automatic reconnect is bounded; returning to the page or going online
also retries. If a USB cable is removed/reconnected, restore `adb reverse` for that
device first. That mapping is tied to the USB connection. Disconnects longer than
the 30-second room grace require a fresh room. The pause banner reports whether a
player disconnected, changed devices, or opened settings.

The loaded training page can work without the laptop. Room mode requires the
server to stay running. Stopping it disconnects/pauses room clients; this isn't
offline multiplayer. After a manual test, stop the HTTP process and remove only
the USB mappings made for that test; stop ADB if the test started it and no other
ADB tasks are in use.

## State and trust boundary

`LOBBY → COUNTDOWN → LIVE → RESOLVING → ENDED`; readiness loss transitions countdown/live to
`PAUSED`, followed by a fresh countdown when both players are ready. A disconnected
player keeps their seat for 30 seconds; that timeout ends the input session with
no winner. Idle rooms expire after 15 minutes. Active input lasts 120 seconds.

The server derives player identity from the socket's opaque session. INPUT includes
`matchId`, an increasing `seq`, and FIRE/RELOAD; player ID, ammo, client timestamps,
hits and winner claims aren't trusted. Public snapshots never contain resume tokens.
Third players cannot enter a full room; messages are scoped to room membership.
Session replacement closes the older socket. Same-origin browser WebSockets are
checked against the request Host, message size and command frequency are bounded,
and HTTP serves only explicit application assets.

In camera mode, FIRE issues a one-use shot ticket owned by that session. The
browser captures the full camera image at trigger time, before waiting for the
ticket, then uploads a JPEG tied to it. The server checks the face-confirmed opponent,
body segmentation and fixed image center. Full body geometry uses shoulders and
hips; closer upper-body views use a conservative chest strip clipped to the
segmentation mask. Independently detected close faces can be recognized without
hips in view; a face-only observation has a head zone and no body damage zone.
Ambiguous face/body pairings never bind an identity to an arbitrary torso.
SFace face similarity must reach .45 and exceed the shooter's own reference
score by .12. Those are demo tuning values, not calibrated accuracy percentages.
An unconfirmed head region does not award head damage. Object-fit crop
transforms keep the overlay aligned with the source camera image.

Evidence expires after 1,500 ms. Duplicate tickets, another player's ticket,
stale match epochs and client HIT/damage claims cannot change health. Decisions
settle in shot acceptance order, with a 100 ms server-clock trade window after
the first lethal shot. Two lethal shots within it can draw. The 120-second limit
also draws; HP advantage is not a tiebreaker. No result moves money.

Preview/shot JPEGs preserve up to 960 pixels on the long side for face detail;
pose inference resizes internally to 640. Each JPEG is bounded to 256 KiB, with
compression retry from the same captured canvas. Previews run normally at most
five per second per client.
Models are loaded lazily from `web/models/`; they are not downloadable through
the HTTP allowlist. See [model provenance](../web/models/CREDITS.md).

The client uses ping round trips to estimate server clock offset and renders the
shared `startsAt`, reload and end deadlines. Only server acceptance decrements ammo
and triggers local shot audio. The same recorded audio is preloaded for training
and room mode. Only a separate server hit decision changes health and plays the
body/head confirmation cue. The approved shot/reload recordings are unchanged.

Rooms and sessions live in memory; a server restart clears them. The anonymous
session is suitable for this demo, not the wallet authentication/referee authority
needed by the paid-match blueprint. Client-reported visibility and controller state
are presence hints. Server inference rejects arbitrary hit claims, but a modified
client can still submit a forged camera image. This controlled demo is not
trustless physical evidence and is not authorization for paid settlement.

## Verification

```bash
PYTHONDONTWRITEBYTECODE=1 .venv/bin/python -m unittest discover -s tests -v
node --test tests/training-core.test.cjs
python3 tests/verify_training_browser.py
python3 tests/verify_duel_browser.py
python3 tests/verify_vision_browser.py
```

The last script uses independent Chromium contexts and real HTTP/WebSockets, with
measured controller packets delivered through mock BLE. It checks room capacity,
countdown, ownership, reload cancellation, refresh/reconnect, isolation and layout.
Each script closes its own server/browser. Evidence is in
`research/multiplayer/browser-verification.json`; physical phone evidence is
recorded separately. The vision script uses actual pretrained inference on video
rendered from Google's public test image, with gun and touch players. It checks
health synchronization, body/head damage and winner UI. Native transport tests
also cover misses, duplicate/foreign tickets and control-session replacement.
Vision evidence is in `research/vision/browser-verification.json`. The two players
enroll different public test faces; an explicitly labeled engineering composite
provides a second full-body fixture. Checks include selfie rejection/retry,
camera switching, cancellation, automatic identity association, readiness without
target visibility, wrong-face misses, expired references and no public embeddings.
Fixture tests
do not measure real two-phone camera accuracy, movement, clothing confusion or
paid settlement; those require separate physical validation.
