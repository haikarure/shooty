"""Two independent browser players against the real room server, with mock BLE.

HTTP, WebSocket, server clock, rendering, and AudioContext are real. Only the
controller/camera are virtual; this isn't a claim of a two-physical-phone test.
"""
from datetime import datetime, timezone
import json
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright
from verify_training_browser import FAKE_BLE

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "research/multiplayer"


def state(page):
    return page.evaluate("ShootyTraining.snapshot()")


def press(page, value):
    page.evaluate("value=>fakeBLE.notify(value)", value)


def setup(page, origin, kind):
    page.goto(origin + "/?input=" + kind)
    page.locator("#start-shooty").click()
    page.wait_for_function("ShootyTraining.snapshot().started")
    page.evaluate("document.fullscreenElement&&document.exitFullscreen()")
    page.wait_for_function("ShootyTraining.snapshot().audio.reloadStatus==='ready'")
    page.locator('#duel-rules').select_option('INPUT')


def ready(page):
    page.locator("#enter-arena").click()
    page.evaluate("document.fullscreenElement&&document.exitFullscreen()")


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    checks, errors = [], []
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0)); port = reserve.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryFile(mode="w+") as logs:
        server = subprocess.Popen([str(ROOT / ".venv/bin/python"), "-u", "gun_service.py", "--web-only", "--host", "127.0.0.1", "--http-port", str(port), "--duration", "180"], cwd=ROOT, stdout=logs, stderr=logs)
        try:
            for _ in range(50):
                try:
                    with urllib.request.urlopen(origin, timeout=1): break
                except OSError: time.sleep(.1)
            else: raise RuntimeError("Server did not start")
            chromium = sorted((Path.home()/".cache/ms-playwright").glob("chromium-*/chrome-linux64/chrome"))[-1]
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=str(chromium), headless=True, args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
                try:
                    contexts = [browser.new_context(viewport={"width": 844, "height": 390}) for _ in range(3)]
                    a, b, c = [context.new_page() for context in contexts]
                    for page in (a, b): page.add_init_script("let duelNamespace;Object.defineProperty(window,'ShootyDuel',{configurable:true,get:()=>duelNamespace,set:value=>{class CapturedClient extends value.DuelClient{constructor(...args){super(...args);window.qaDuel=this;}}duelNamespace={DuelClient:CapturedClient};}});")
                    for page in (a, b, c): page.on("pageerror", lambda error: errors.append(str(error)))
                    a.add_init_script(FAKE_BLE)
                    setup(a, origin, "bluetooth"); setup(b, origin, "touch"); setup(c, origin, "touch")
                    a.locator("#connect-gun").click()
                    a.wait_for_function("ShootyTraining.snapshot().connected")
                    a.locator('[data-bind="reload"]').click()
                    for value in ("B8DOWN", "B8UP", "B8DOWN", "B8UP"): press(a, value)
                    a.locator("#player-name").fill("Alpha")
                    a.locator("#create-room").click()
                    a.wait_for_function("Boolean(ShootyTraining.snapshot().duel.room)")
                    code = state(a)["duel"]["room"]["code"]
                    b.locator("#player-name").fill("Bravo")
                    b.locator("#room-code-input").fill(code)
                    b.locator("#join-room").click()
                    b.wait_for_function("ShootyTraining.snapshot().duel.room?.players.length===2")
                    a.wait_for_function("ShootyTraining.snapshot().duel.room?.players.length===2")
                    a_id, b_id = state(a)["duel"]["playerId"], state(b)["duel"]["playerId"]
                    assert a_id != b_id
                    checks.append("Two independent sessions create and join one room with separate gun/touch identities")

                    c.locator("#room-code-input").fill(code); c.locator("#join-room").click()
                    c.wait_for_function("document.getElementById('room-feedback').textContent.includes('dua pemain')")
                    assert state(c)["duel"]["room"] is None
                    c.locator("#create-room").click()
                    c.wait_for_function("Boolean(ShootyTraining.snapshot().duel.room)")
                    other_code = state(c)["duel"]["room"]["code"]
                    assert code != other_code
                    checks.append("Third player cannot join a full room and can create an isolated second room")

                    ready(a)
                    a.wait_for_function("ShootyTraining.snapshot().duel.room?.players.some(p=>p.id===ShootyTraining.snapshot().duel.playerId&&p.ready)")
                    press(a, "ARGun KeyPressed"); press(a, [0]*16)
                    assert state(a)["ammo"] == 30
                    ready(b)
                    for page in (a, b): page.wait_for_function("ShootyTraining.snapshot().duel.room?.phase==='COUNTDOWN'")
                    starts = [state(page)["duel"]["room"]["startsAt"] for page in (a, b)]
                    assert starts[0] == starts[1]
                    assert a.locator("#touch-fire").is_disabled() and b.locator("#touch-fire").is_disabled()
                    a.screenshot(path=str(ARTIFACTS/"countdown.png"))
                    for page in (a, b): page.wait_for_function("ShootyTraining.snapshot().duel.room?.phase==='LIVE'", timeout=6000)
                    checks.append("Both ready flags produce one shared countdown deadline; inputs stay blocked until the server goes live")

                    press(a, "ARGun KeyPressed"); press(a, "ARGun KeyPressed"); press(a, [0]*16)
                    a.wait_for_function("ShootyTraining.snapshot().ammo===29")
                    b.wait_for_function("ShootyTraining.snapshot().duel.room.players.some(p=>p.id!==ShootyTraining.snapshot().duel.playerId&&p.ammo===29)")
                    assert state(b)["ammo"] == 30
                    b.locator("#touch-fire").click()
                    b.wait_for_function("ShootyTraining.snapshot().ammo===29")
                    a.wait_for_function("ShootyTraining.snapshot().duel.room.players.every(p=>p.ammo===29)")
                    assert state(a)["audio"]["playCounts"]["shot"] == 1
                    assert state(b)["audio"]["playCounts"]["shot"] == 1
                    assert state(c)["duel"]["room"]["code"] == other_code
                    assert len(state(c)["duel"]["room"]["players"]) == 1
                    checks.append("Gun and touch each consume only their owner's server ammo; a held trigger and other rooms do not duplicate shots")

                    press(a, "B8DOWN"); press(a, "B8UP")
                    a.wait_for_function("ShootyTraining.snapshot().reloading")
                    deadline = state(a)["reloadAt"]
                    press(a, "B8DOWN"); press(a, "B8UP"); press(a, "ARGun KeyPressed"); press(a, [0]*16)
                    assert state(a)["reloadAt"] == deadline
                    a.wait_for_function("!ShootyTraining.snapshot().reloading&&ShootyTraining.snapshot().ammo===30")
                    a.wait_for_function("ShootyTraining.snapshot().audio.playCounts['reload-complete']===1")
                    assert state(a)["audio"]["playCounts"]["reload-start"] == 1
                    assert state(b)["ammo"] == 29
                    checks.append("Mapped B8 reload uses one server deadline, rejects shots/spam, and plays recorded start/complete once")

                    a.screenshot(path=str(ARTIFACTS/"gun-live.png")); b.screenshot(path=str(ARTIFACTS/"touch-live.png"))
                    press(a, "ARGun KeyPressed"); press(a, [0]*16)
                    a.wait_for_function("ShootyTraining.snapshot().ammo===29")
                    press(a, "B8DOWN"); press(a, "B8UP")
                    a.wait_for_function("ShootyTraining.snapshot().reloading")
                    a.locator("#open-settings").click()
                    for page in (a, b): page.wait_for_function("ShootyTraining.snapshot().duel.room?.phase==='PAUSED'")
                    assert not any(player["ready"] for player in state(b)["duel"]["room"]["players"])
                    assert state(a)["audio"]["activeReloadVoices"] == 0
                    a.wait_for_timeout(1300)
                    assert state(a)["ammo"] == 29 and state(a)["audio"]["playCounts"]["reload-complete"] == 1
                    assert b.locator("#touch-fire").is_disabled()
                    checks.append("Opening settings pauses both players, clears ready flags, cancels reload audio and prevents a delayed free refill")

                    ready(a); b.locator("#open-settings").click(); ready(b)
                    for page in (a, b): page.wait_for_function("ShootyTraining.snapshot().duel.room?.phase==='LIVE'", timeout=6000)
                    assert state(a)["ammo"] == 29
                    a.reload(); a.wait_for_function("Boolean(window.ShootyTraining)")
                    b.wait_for_function("ShootyTraining.snapshot().duel.room?.phase==='PAUSED'")
                    a.locator("#start-shooty").click()
                    a.wait_for_function("ShootyTraining.snapshot().started&&Boolean(ShootyTraining.snapshot().duel.room)")
                    a.evaluate("document.fullscreenElement&&document.exitFullscreen()")
                    a.locator("#connect-gun").click()
                    a.wait_for_function("ShootyTraining.snapshot().connected")
                    assert state(a)["duel"]["playerId"] == a_id and state(a)["ammo"] == 29
                    assert state(a)["bindings"]["reload"] == "8"
                    assert state(a)["duel"]["room"]["phase"] == "PAUSED"
                    checks.append("Refreshing resumes the same room identity and ammo, restores B8 after BLE reconnect, and requires readiness again")

                    for width, height in ((794, 279), (844, 390), (390, 844), (360, 800)):
                        a.set_viewport_size({"width": width, "height": height})
                        assert not a.evaluate("document.documentElement.scrollWidth>innerWidth")
                        assert not a.locator("#settings").evaluate("element=>element.scrollWidth>element.clientWidth")
                    a.set_viewport_size({"width": 844, "height": 390})
                    a.locator("#room-code-value").scroll_into_view_if_needed()
                    a.screenshot(path=str(ARTIFACTS/"room-lobby.png"))
                    checks.append("Room controls fit short landscape and narrow portrait layouts")

                    b.evaluate("()=>{qaDuel.wantConnection=false;qaDuel.socket.close();}")
                    b.wait_for_function("!ShootyTraining.snapshot().duel.online")
                    b.locator("#open-settings").click()
                    b.locator("#reconnect-duel").click()
                    b.wait_for_function("ShootyTraining.snapshot().duel.online")
                    assert state(b)["duel"]["playerId"] == b_id and state(b)["ammo"] == 29
                    checks.append("A manual reconnect recovers the existing session after automatic retries stop without refreshing or resetting ammo")

                    b.locator("#leave-room").click()
                    b.wait_for_function("ShootyTraining.snapshot().duel.room===null")
                    a.wait_for_function("ShootyTraining.snapshot().duel.room?.phase==='ENDED'")
                    assert state(a)["duel"]["room"]["reason"] == "PLAYER_LEFT"
                    assert "winner" not in state(a)["duel"]["room"]
                    a.evaluate("()=>{qaDuel.wantConnection=false;qaDuel.socket.close();}")
                    a.wait_for_function("!ShootyTraining.snapshot().duel.online")
                    assert a.locator("#duel-countdown").inner_text() == "SELESAI"
                    checks.append("Leaving ends the input session without inventing a winner or payout; a completed session stays completed when the server disconnects")
                    assert not errors, errors
                    checks.append("Zero JavaScript errors across three isolated player contexts")
                finally:
                    browser.close()
        except Exception:
            logs.seek(0)
            print(logs.read()[-5000:])
            raise
        finally:
            if server.poll() is None:
                server.terminate()
                try: server.wait(timeout=6)
                except subprocess.TimeoutExpired: server.kill(); server.wait(timeout=3)
    report = {"verified_at": datetime.now(timezone.utc).isoformat(), "checks": checks, "check_count": len(checks), "browser_errors": errors, "server_and_browser_stopped": True, "real_http_and_websocket": True, "ble": "mock using measured controller packet format", "physical_two_phone_test": False}
    (ARTIFACTS/"browser-verification.json").write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__": main()
