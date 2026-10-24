"""Finite browser verification; fake BLE/camera, recorded real controller packets.

Uses existing Chromium. Own HTTP process and browser are always closed.
"""

import json
import struct
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from datetime import datetime, timezone

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "research/design/training-v2"
FAKE_BLE = r"""
const characteristic=new EventTarget();
characteristic.startNotifications=async()=>characteristic;
const device=new EventTarget();device.id='qa-controller';device.name='ARGunGame';
device.gatt={connected:false,connect:async()=>{device.gatt.connected=true;return {getPrimaryService:async()=>({getCharacteristic:async()=>characteristic})};},disconnect:()=>{device.gatt.connected=false;device.dispatchEvent(new Event('gattserverdisconnected'));}};
window.fakeBLE={notify:(text)=>{const raw=typeof text==='string'?new TextEncoder().encode(text):new Uint8Array(text);const bytes=new Uint8Array(raw.length+7);bytes.set(raw,3);characteristic.value=new DataView(bytes.buffer,3,raw.length);characteristic.dispatchEvent(new Event('characteristicvaluechanged'));},disconnect:()=>device.gatt.disconnect()};
Object.defineProperty(navigator,'bluetooth',{configurable:true,value:{requestDevice:async()=>device}});
"""

LAUNCH_ORIENTATION = r"""
window.launchCalls=[];
Object.defineProperty(screen,'orientation',{configurable:true,value:{
 type:'portrait-primary',
 lock:async direction=>{launchCalls.push({direction,fullscreen:Boolean(document.fullscreenElement),settingsOpen:document.getElementById('settings').open});screen.orientation.type='landscape-primary';},
 unlock:()=>{window.unlockCount=(window.unlockCount||0)+1;screen.orientation.type='portrait-primary';}
}});
"""


def verify_launch(browser, origin):
    checks, errors = [], []
    for scenario in ("tab", "fullscreen_denied", "fullscreen_stalled", "installed"):
        context = browser.new_context(viewport={"width": 375, "height": 738})
        try:
            page = context.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.add_init_script(LAUNCH_ORIENTATION)
            if scenario == "fullscreen_denied":
                page.add_init_script("window.nativeFullscreen=Element.prototype.requestFullscreen;Element.prototype.requestFullscreen=()=>Promise.reject(new DOMException('Denied','NotAllowedError'));")
            if scenario == "fullscreen_stalled":
                page.add_init_script("window.nativeFullscreen=Element.prototype.requestFullscreen;Element.prototype.requestFullscreen=()=>new Promise(()=>{});")
            if scenario == "installed":
                page.add_init_script("const nativeMatchMedia=window.matchMedia.bind(window);window.matchMedia=query=>query.includes('display-mode')?{matches:true}:nativeMatchMedia(query);")
            page.goto(origin + "/?input=touch")
            page.wait_for_function("Boolean(window.ShootyTraining)")
            if scenario == "installed":
                page.wait_for_function("ShootyTraining.snapshot().display.orientationLocked")
                assert page.locator("#settings").is_visible() and not page.locator("#start-screen").is_visible()
                assert not page.evaluate("Boolean(document.fullscreenElement)")
                checks.append("Installed display mode opens preparation immediately and locks landscape without a start tap (mocked installed context)")
            else:
                assert page.locator("#start-screen").is_visible() and not page.locator("#settings").is_visible()
                assert page.evaluate("launchCalls.length") == 0
                if scenario == "tab":
                    for width, height in ((375, 738), (794, 279)):
                        page.set_viewport_size({"width": width, "height": height})
                        box = page.locator("#start-shooty").bounding_box()
                        assert box and box["x"] >= 0 and box["y"] >= 0 and box["x"] + box["width"] <= width and box["y"] + box["height"] <= height
                        page.screenshot(path=str(ARTIFACTS / f"startup-{'portrait' if height>width else 'landscape'}.png"))
                    page.set_viewport_size({"width": 375, "height": 738})
                page.locator("#start-shooty").click()
                page.wait_for_function("ShootyTraining.snapshot().started")
                assert page.locator("#settings").is_visible()
                assert not page.evaluate("ShootyTraining.snapshot().active")
                if scenario == "tab":
                    assert page.evaluate("launchCalls") == [{"direction": "landscape", "fullscreen": True, "settingsOpen": False}]
                    page.evaluate("document.exitFullscreen()")
                    page.wait_for_function("!ShootyTraining.snapshot().display.orientationLocked")
                    assert page.evaluate("unlockCount") >= 1
                    checks.append("Start tap requests real fullscreen, locks landscape before setup, and releases the orientation lock on fullscreen exit")
                else:
                    assert page.locator("#retry-landscape").is_visible()
                    assert page.evaluate("launchCalls.length") == 0
                    page.evaluate("()=>{Element.prototype.requestFullscreen=window.nativeFullscreen;}")
                    page.locator("#retry-landscape").click()
                    page.wait_for_function("ShootyTraining.snapshot().display.orientationLocked")
                    checks.append(f"{scenario}: preparation remains usable and Landscape can retry successfully")
        finally:
            context.close()
    assert not errors, errors
    response = browser.contexts[0].request.get(origin + "/manifest.webmanifest")
    assert response.ok and response.headers["content-type"] == "application/manifest+json"
    manifest = response.json()
    assert manifest["orientation"] == "landscape" and manifest["display"] == "standalone"
    for icon, size in zip(manifest["icons"], (192, 512)):
        response = browser.contexts[0].request.get(origin + icon["src"])
        assert response.ok and response.headers["content-type"] == "image/png"
        data = response.body()
        assert data[:8] == b"\x89PNG\r\n\x1a\n" and struct.unpack(">II", data[16:24]) == (size, size)
    checks.append("Landscape standalone manifest and both correctly sized PNG icons are served on the local allowlist")
    return checks


def main():
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    with socket.socket() as reserve:
        reserve.bind(("127.0.0.1", 0))
        port = reserve.getsockname()[1]
    origin = f"http://127.0.0.1:{port}"
    checks, errors, requests, shot_requests, reload_requests = [], [], [], [], []
    with tempfile.TemporaryFile(mode="w+") as logs:
        server = subprocess.Popen([str(ROOT / ".venv/bin/python"), "gun_service.py", "--web-only", "--host", "127.0.0.1", "--http-port", str(port), "--duration", "180"], cwd=ROOT, stdout=logs, stderr=logs)
        try:
            for _ in range(50):
                try:
                    with urllib.request.urlopen(origin, timeout=1):
                        break
                except OSError:
                    time.sleep(.1)
            else:
                raise RuntimeError("Local server did not start")
            chromium = sorted((Path.home() / ".cache/ms-playwright").glob("chromium-*/chrome-linux64/chrome"))[-1]
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=str(chromium), headless=True, args=["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"])
                try:
                    context = browser.new_context(viewport={"width": 794, "height": 279})
                    page = context.new_page()
                    page.on("pageerror", lambda error: errors.append(str(error)))
                    page.on("request", lambda request: requests.append(request.url) if request.url.startswith(("http://", "https://")) and not request.url.startswith(origin) else None)
                    page.on("request", lambda request: shot_requests.append(request.url) if request.url.endswith("/web/audio/pistol-1911.wav") else None)
                    page.on("request", lambda request: reload_requests.append(request.url) if "/web/audio/pistol-reload-" in request.url else None)
                    page.add_init_script(FAKE_BLE)
                    page.goto(origin + "/?input=bluetooth")
                    page.wait_for_function("Boolean(window.ShootyTraining)")
                    assert page.locator("#start-screen").is_visible()
                    assert not page.locator("#settings").is_visible()
                    page.locator("#start-shooty").click()
                    page.wait_for_function("ShootyTraining.snapshot().started")
                    assert page.locator("#settings").is_visible()
                    page.evaluate("document.fullscreenElement&&document.exitFullscreen()")
                    checks.append("First tap opens fullscreen and requests landscape before showing controller setup")
                    page.locator("#connect-gun").click()
                    page.wait_for_function("ShootyTraining.snapshot().connected")
                    page.locator("#start-camera").click()
                    page.wait_for_function("ShootyTraining.snapshot().camera.active")
                    page.locator("#test-audio").click()
                    page.wait_for_function("ShootyTraining.snapshot().audio.state==='running'&&ShootyTraining.snapshot().audio.shotStatus==='ready'&&ShootyTraining.snapshot().audio.reloadStatus==='ready'")
                    assert page.evaluate("ShootyTraining.snapshot().audio.shotSource") == "recorded-1911"
                    assert abs(page.evaluate("ShootyTraining.snapshot().audio.shotDuration") - 1.8) < .001
                    assert page.evaluate("ShootyTraining.snapshot().audio.reloadSource") == "recorded-airsoft-mechanics"
                    durations = page.evaluate("ShootyTraining.snapshot().audio.reloadDurations")
                    assert abs(durations["reload-start"] - 1.03) < .001 and abs(durations["reload-complete"] - .3) < .001
                    page.locator("#test-reload").click()
                    checks.append("Device setup decodes the existing pistol shot and both recorded mechanical reload phases in real Web Audio")

                    page.locator('[data-bind="reload"]').click()
                    page.evaluate("fakeBLE.notify('ARGun KeyPressed');fakeBLE.notify(Array(16).fill(0))")
                    assert "Pelatuk" in page.locator("#learning-instruction").inner_text()
                    for value in ("B7DOWN", "B8DOWN", "B7UP", "B8UP"):
                        page.evaluate("value=>fakeBLE.notify(value)", value)
                    assert "bersamaan" in page.locator("#learning-instruction").inner_text()
                    for value in ("B7DOWN", "B7UP", "B7DOWN", "B7UP"):
                        page.evaluate("value=>fakeBLE.notify(value)", value)
                    assert page.evaluate("ShootyTraining.snapshot().bindings.reload") == "7"
                    assert page.evaluate("ShootyTraining.snapshot().ammo") == 30
                    checks.append("Reload calibration rejects trigger and chords, requires confirmation, and consumes input without shots")

                    page.locator('[data-bind="aim"]').click()
                    for value in ("B7DOWN", "B7UP", "B7DOWN", "B7UP"):
                        page.evaluate("value=>fakeBLE.notify(value)", value)
                    assert "sudah dipakai" in page.locator("#binding-feedback").inner_text()
                    assert page.evaluate("ShootyTraining.snapshot().bindings.aim") is None
                    page.locator('[data-bind="aim"]').click()
                    for value in ("B8DOWN", "B8UP", "B8DOWN", "B8UP"):
                        page.evaluate("value=>fakeBLE.notify(value)", value)
                    checks.append("Conflicting mapping is rejected; a different aim button can be saved")

                    page.locator("#enter-arena").click()
                    page.wait_for_function("!ShootyTraining.snapshot().settingsOpen")
                    # Screenshot the exact effective landscape size independently of fullscreen.
                    page.evaluate("document.fullscreenElement&&document.exitFullscreen()")
                    page.evaluate("fakeBLE.notify('ARGun KeyPressed');fakeBLE.notify('ARGun KeyPressed')")
                    assert page.locator("#ammo-count").inner_text() == "29"
                    page.evaluate("fakeBLE.notify(Array(16).fill(0));fakeBLE.notify('B7DOWN');fakeBLE.notify('B7UP')")
                    deadline = page.evaluate("ShootyTraining.snapshot().reloadAt")
                    assert page.evaluate("ShootyTraining.snapshot().reloading")
                    page.evaluate("fakeBLE.notify('B7DOWN');fakeBLE.notify('B7UP');fakeBLE.notify('ARGun KeyPressed');fakeBLE.notify(Array(16).fill(0))")
                    assert page.evaluate("ShootyTraining.snapshot().reloadAt") == deadline
                    assert page.locator("#ammo-count").inner_text() == "29"
                    page.wait_for_function("!ShootyTraining.snapshot().reloading")
                    assert page.locator("#ammo-count").inner_text() == "30"
                    counts = page.evaluate("ShootyTraining.snapshot().audio.playCounts")
                    assert counts["reload-start"] == 2 and counts["reload-complete"] == 2  # Includes one sound-test sequence.
                    checks.append("Gun trigger fires once; physical reload blocks shots and spam, completes once with matching audio")
                    assert len(shot_requests) == 1 and len(reload_requests) == 2 and len(set(reload_requests)) == 2, (shot_requests, reload_requests)
                    checks.append("Sound previews, gun trigger, and reload reuse three preloaded recordings without extra audio requests")

                    page.evaluate("fakeBLE.notify('B8DOWN')")
                    assert page.locator("body").get_attribute("data-aim") == "true"
                    page.evaluate("fakeBLE.notify('B8UP')")
                    assert page.locator("body").get_attribute("data-aim") == "false"
                    checks.append("Mapped aim follows down/up rather than toggling or sticking")

                    page.locator("#open-settings").click()
                    before = page.evaluate("ShootyTraining.snapshot().ammo")
                    page.evaluate("fakeBLE.notify('ARGun KeyPressed');fakeBLE.notify(Array(16).fill(0))")
                    assert page.evaluate("ShootyTraining.snapshot().ammo") == before
                    page.locator("#mute").click()
                    assert page.evaluate("ShootyTraining.snapshot().audio.muted")
                    page.locator("#show-touch").check()
                    page.locator("#enter-arena").click()
                    page.evaluate("document.fullscreenElement&&document.exitFullscreen()")
                    page.locator("#touch-fire").click()
                    assert page.locator("#ammo-count").inner_text() == "29"
                    assert page.evaluate("ShootyTraining.snapshot().audio.muted")
                    checks.append("Settings block gameplay input; mute and touch fallback preserve game behavior")

                    page.evaluate("fakeBLE.disconnect()")
                    assert not page.evaluate("ShootyTraining.snapshot().connected")
                    assert page.locator("#touch-fire").is_visible()
                    page.reload()
                    page.wait_for_function("Boolean(window.ShootyTraining)")
                    page.locator("#start-shooty").click()
                    page.wait_for_function("ShootyTraining.snapshot().started")
                    page.evaluate("document.fullscreenElement&&document.exitFullscreen()")
                    page.locator("#connect-gun").click()
                    page.wait_for_function("ShootyTraining.snapshot().connected")
                    assert page.evaluate("ShootyTraining.snapshot().bindings.reload") == "7"
                    assert page.evaluate("ShootyTraining.snapshot().bindings.aim") == "8"
                    assert page.evaluate("ShootyTraining.snapshot().audio.muted")
                    checks.append("Disconnect exposes touch fallback; bindings and mute persist after page reload for the same controller")

                    energy = page.evaluate("""async()=>{const context=new OfflineAudioContext(1,86400,48000);const response=await fetch(ShootyAudio.SHOT_URL);const buffer=await context.decodeAudioData(await response.arrayBuffer());const source=context.createBufferSource();source.buffer=buffer;const gain=context.createGain();gain.gain.value=.45;source.connect(gain);gain.connect(context.destination);source.start();const result=await context.startRendering();const channel=result.getChannelData(0);return channel.reduce((sum,value)=>sum+value*value,0)/channel.length;}""")
                    muted_energy = page.evaluate("""async()=>{const context=new OfflineAudioContext(1,86400,48000);const response=await fetch(ShootyAudio.SHOT_URL);const buffer=await context.decodeAudioData(await response.arrayBuffer());const source=context.createBufferSource();source.buffer=buffer;const gain=context.createGain();gain.gain.value=0;source.connect(gain);gain.connect(context.destination);source.start();const result=await context.startRendering();return result.getChannelData(0).reduce((sum,value)=>sum+value*value,0);}""")
                    assert energy > .00001 and muted_energy == 0
                    checks.append("Offline rendering of the real recording produces nonzero audio and exactly zero output at mute gain")

                    page.route("**/web/audio/pistol-1911.wav", lambda route: route.fulfill(status=503, body="unavailable"))
                    failure = page.evaluate("""async()=>{window.audioRetryCheck=new ShootyAudio.AudioEngine();const ok=await audioRetryCheck.unlock();return {ok,status:audioRetryCheck.shotStatus,error:audioRetryCheck.shotError};}""")
                    assert failure == {"ok": False, "status": "error", "error": "HTTP 503"}, failure
                    page.unroute("**/web/audio/pistol-1911.wav")
                    retry = page.evaluate("""async()=>{const ok=await audioRetryCheck.unlock();const result={ok,status:audioRetryCheck.shotStatus,duration:audioRetryCheck.shotDuration};await audioRetryCheck.context.close();return result;}""")
                    assert retry["ok"] and retry["status"] == "ready" and abs(retry["duration"] - 1.8) < .001, retry
                    checks.append("Failed recording loads report an error and can retry successfully without a synthetic shot substitution")

                    page.route("**/web/audio/pistol-reload-complete.wav", lambda route: route.fulfill(status=503, body="unavailable"))
                    reload_failure = page.evaluate("""async()=>{window.reloadRetryCheck=new ShootyAudio.AudioEngine();const ok=await reloadRetryCheck.unlock();return {ok,status:reloadRetryCheck.reloadStatus,error:reloadRetryCheck.reloadError,shot:reloadRetryCheck.shotStatus};}""")
                    assert reload_failure == {"ok": False, "status": "error", "error": "HTTP 503", "shot": "ready"}, reload_failure
                    shot_count = len(shot_requests)
                    page.unroute("**/web/audio/pistol-reload-complete.wav")
                    reload_retry = page.evaluate("""async()=>{const ok=await reloadRetryCheck.unlock();const source=reloadRetryCheck.buffers.get('shot');reloadRetryCheck.play('shot');reloadRetryCheck.play('reload-start');reloadRetryCheck.play('reload-complete',1.2);const before=reloadRetryCheck.reloadVoices.size;reloadRetryCheck.stopReload();const result={ok,status:reloadRetryCheck.reloadStatus,before,after:reloadRetryCheck.reloadVoices.size,shotRetained:reloadRetryCheck.buffers.get('shot')===source,remainingVoices:reloadRetryCheck.voices.size};reloadRetryCheck.stop();await reloadRetryCheck.context.close();return result;}""")
                    assert reload_retry == {"ok": True, "status": "ready", "before": 2, "after": 0, "shotRetained": True, "remainingVoices": 1}, reload_retry
                    assert len(shot_requests) == shot_count
                    checks.append("Reload download failure retries independently; cancel stops current and scheduled reload voices while retaining the shot buffer and voice")

                    reload_signals = page.evaluate("""async()=>{const result={};for(const [name,url] of Object.entries(ShootyAudio.RELOAD_URLS)){const context=new OfflineAudioContext(1,96000,48000);const response=await fetch(url);const buffer=await context.decodeAudioData(await response.arrayBuffer());const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);source.start();const rendered=await context.startRendering();const data=rendered.getChannelData(0);result[name]={energy:data.reduce((sum,value)=>sum+value*value,0)/data.length,peak:data.reduce((peak,value)=>Math.max(peak,Math.abs(value)),0)};}return result;}""")
                    for name, signal in reload_signals.items():
                        assert signal["energy"] > .00001 and 0 < signal["peak"] < .95, (name, signal)
                    checks.append("Both recorded reload phases render nonzero audio without clipped peaks")

                    page.locator("#mode-touch").click()
                    page.locator("#enter-arena").click()
                    page.evaluate("document.fullscreenElement&&document.exitFullscreen()")
                    for width, height in ((794, 279), (844, 390), (915, 412), (390, 844), (360, 800), (1440, 900)):
                        page.set_viewport_size({"width": width, "height": height})
                        assert not page.evaluate("document.documentElement.scrollWidth>innerWidth"), (width, height)
                        for selector in ("#open-settings", "#touch-fire", "#reload"):
                            box = page.locator(selector).bounding_box()
                            assert box and box["x"] >= 0 and box["y"] >= 0 and box["x"] + box["width"] <= width + 1 and box["y"] + box["height"] <= height + 1, (width, height, selector, box)
                        page.locator("#open-settings").click()
                        assert not page.locator("#settings").evaluate("element=>element.scrollWidth>element.clientWidth"), (width, height)
                        page.locator("#enter-arena").click()
                        page.evaluate("document.fullscreenElement&&document.exitFullscreen()")
                    checks.append("Arena controls and settings fit six viewport sizes including the phone's measured 794x279 landscape viewport")
                    page.set_viewport_size({"width": 844, "height": 390})
                    page.screenshot(path=str(ARTIFACTS / "landscape-touch.png"))
                    page.locator("#open-settings").click()
                    page.screenshot(path=str(ARTIFACTS / "landscape-setup.png"))
                    page.set_viewport_size({"width": 390, "height": 844})
                    page.screenshot(path=str(ARTIFACTS / "portrait-setup.png"))
                    assert not errors, errors
                    assert not requests, requests
                    checks.append("Zero JavaScript errors or external HTTP requests")
                    checks.extend(verify_launch(browser, origin))
                finally:
                    browser.close()
        finally:
            if server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=3)
    report = {"recorded_at": datetime.now(timezone.utc).isoformat(), "checks": checks, "check_count": len(checks), "browser_errors": errors, "external_requests": requests, "browser_closed": True, "task_http_process_stopped": True, "physical_phone_test": False, "audio_audibility_confirmed_by_human": False}
    (ARTIFACTS / "browser-verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
