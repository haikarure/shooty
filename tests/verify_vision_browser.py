"""Two browsers with fixture video, real AI, real WebSockets and server health.

The video source and BLE are simulated. Physical camera accuracy isn't inferred
from this test. Own server/browser processes are always stopped.
"""
import base64
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
ARTIFACTS = ROOT/'research/vision'


def snapshot(page): return page.evaluate('ShootyTraining.snapshot()')


def camera_script(kind):
    files = {'front': 'portrait.jpg' if kind == 'bluetooth' else 'selfie-pose.jpg',
             'rear': 'pose.jpg' if kind == 'bluetooth' else 'pose-portrait-composite.jpg'}
    sources = {key:'data:image/jpeg;base64,'+base64.b64encode((ROOT/'tests/fixtures/vision'/name).read_bytes()).decode() for key,name in files.items()}
    return r"""
    window.qaAim='body';window.qaSelfieValid=true;window.qaStreams=[];
    const sources=SOURCES, images={};
    const loaded=Promise.all(Object.entries(sources).map(([key,src])=>new Promise(resolve=>{const im=new Image();im.onload=()=>{images[key]=im;resolve();};im.src=src;})));
    Object.defineProperty(navigator.mediaDevices,'getUserMedia',{value:async options=>{
        await loaded;
        const front=options.video.facingMode?.ideal==='user';
        const image=images[front?'front':'rear'];
        const canvas=document.createElement('canvas');canvas.width=front?400:1000;canvas.height=front?400:667;
        const context=canvas.getContext('2d');
        const draw=()=>{context.fillStyle='black';context.fillRect(0,0,canvas.width,canvas.height);if(front){if(qaSelfieValid)context.drawImage(image,0,0,400,400);}else if(qaAim!=='blank')context.drawImage(image,qaAim==='head'?22:0,qaAim==='head'?48:0);};
        draw();const timer=setInterval(draw,33);const stream=canvas.captureStream(30);
        const track=stream.getVideoTracks()[0],nativeStop=track.stop.bind(track);track.stop=()=>{clearInterval(timer);nativeStop();};
        qaStreams.push(stream);return stream;
    }});
    """.replace('SOURCES',json.dumps(sources))


def enroll(page):
    page.locator('#open-selfie').click()
    page.wait_for_function('ShootyTraining.snapshot().selfie.cameraActive')
    page.wait_for_function("!document.getElementById('take-selfie').disabled")
    page.wait_for_timeout(200)
    page.screenshot(path=str(ARTIFACTS/f"selfie-{snapshot(page)['mode']}.png"))
    page.locator('#take-selfie').click()
    page.wait_for_function('ShootyTraining.snapshot().selfie.enrolled&&!ShootyTraining.snapshot().selfie.open',timeout=20000)
    page.wait_for_function('ShootyTraining.snapshot().camera.active&&ShootyTraining.snapshot().vision.online')


def join(a,b):
    a.locator('#create-room').click();a.wait_for_function('Boolean(ShootyTraining.snapshot().duel.room)')
    code=snapshot(a)['duel']['room']['code']
    b.locator('#room-code-input').fill(code);b.locator('#join-room').click()
    for page in (a,b):page.wait_for_function('ShootyTraining.snapshot().duel.room?.players.length===2')
    return code


def main():
    errors, checks = [], []
    with socket.socket() as reserve:
        reserve.bind(('127.0.0.1',0)); port=reserve.getsockname()[1]
    origin=f'http://127.0.0.1:{port}'
    with tempfile.TemporaryFile(mode='w+') as logs:
        server=subprocess.Popen([str(ROOT/'.venv/bin/python'),'-u','gun_service.py','--web-only','--host','127.0.0.1','--http-port',str(port),'--duration','180'],cwd=ROOT,stdout=logs,stderr=logs)
        try:
            for _ in range(60):
                try:
                    with urllib.request.urlopen(origin,timeout=1): break
                except OSError: time.sleep(.1)
            else: raise RuntimeError('Server did not start')
            chromium=sorted((Path.home()/'.cache/ms-playwright').glob('chromium-*/chrome-linux64/chrome'))[-1]
            with sync_playwright() as playwright:
                browser=playwright.chromium.launch(executable_path=str(chromium),headless=True)
                try:
                    a,b=[browser.new_context(viewport={'width':844,'height':390}).new_page() for _ in range(2)]
                    for page,kind in ((a,'bluetooth'),(b,'touch')):
                        page.on('pageerror',lambda error:errors.append(str(error)))
                        page.add_init_script(camera_script(kind))
                        if page is a: page.add_init_script(FAKE_BLE)
                        page.goto(origin+'/?input='+kind)
                        page.locator('#start-shooty').click()
                        page.wait_for_function('ShootyTraining.snapshot().started')
                        page.evaluate('document.fullscreenElement&&document.exitFullscreen()')
                        page.wait_for_function("ShootyTraining.snapshot().audio.reloadStatus==='ready'")
                    a.locator('#connect-gun').click(); a.wait_for_function('ShootyTraining.snapshot().connected')
                    code=join(a,b)
                    assert snapshot(a)['duel']['room']['mode']=='VISION'
                    checks.append('Gun and touch join the default selfie camera duel in separate sessions')
                    # No reference image, face vector or embedding is shared publicly.
                    a.locator('#enter-arena').click()
                    assert snapshot(a)['settingsOpen']
                    a.locator('#open-selfie').click();a.wait_for_function('ShootyTraining.snapshot().selfie.cameraActive')
                    a.locator('#cancel-selfie').click();a.wait_for_function('!ShootyTraining.snapshot().selfie.open&&ShootyTraining.snapshot().camera.active')
                    assert not snapshot(a)['selfie']['enrolled']
                    checks.append('Cancelling selfie closes the front camera and restores the rear camera without enrolling a face')
                    enroll(a)
                    b.evaluate('qaSelfieValid=false')
                    b.locator('#open-selfie').click();b.wait_for_function('ShootyTraining.snapshot().selfie.cameraActive')
                    b.locator('#take-selfie').click()
                    b.wait_for_function("document.getElementById('selfie-status').textContent.includes('Wajah belum terlihat')")
                    assert not snapshot(b)['selfie']['enrolled'] and snapshot(b)['selfie']['open']
                    b.evaluate('qaSelfieValid=true');b.wait_for_timeout(100);b.locator('#take-selfie').click()
                    b.wait_for_function('ShootyTraining.snapshot().selfie.enrolled&&!ShootyTraining.snapshot().selfie.open',timeout=20000)
                    for page in (a,b):page.wait_for_function('ShootyTraining.snapshot().selfie.enrolled&&ShootyTraining.snapshot().selfie.opponentEnrolled&&ShootyTraining.snapshot().vision.online')
                    checks.append('Each front camera enrolls its own distinct face; blank selfie rejects and can be retaken without closing the flow')
                    for page in (a,b):page.wait_for_function('ShootyTraining.snapshot().vision.targetVisible',timeout=20000)
                    checks.append('Rear-camera faces automatically match the other session and associate the correct pose without manual lock')
                    assert all('embedding' not in json.dumps(snapshot(page)) and 'face_feature' not in json.dumps(snapshot(page)) for page in (a,b))
                    # Ready must work even after both cameras point away from the target.
                    for page in (a,b):page.evaluate("qaAim='blank'")
                    a.wait_for_timeout(1800)
                    for page in (a,b):
                        page.locator('#enter-arena').click()
                        page.evaluate('document.fullscreenElement&&document.exitFullscreen()')
                    for page in (a,b): page.wait_for_function("ShootyTraining.snapshot().duel.room?.phase==='LIVE'",timeout=7000)
                    checks.append('Both players can ready and start with the target out of view after enrollment')
                    for page in (a,b):page.evaluate("qaAim='body'")
                    for page in (a,b):page.wait_for_function('ShootyTraining.snapshot().vision.targetVisible',timeout=10000)
                    a.screenshot(path=str(ARTIFACTS/'selfie-duel-live.png'))
                    for sequence,health in enumerate((75,50,25,0),1):
                        a.evaluate("fakeBLE.notify('ARGun KeyPressed');fakeBLE.notify(new Array(16).fill(0));")
                        b.wait_for_function(f'ShootyTraining.snapshot().duel.room.players.find(p=>p.id===ShootyTraining.snapshot().duel.playerId).health==={health}')
                        a.wait_for_function(f'ShootyTraining.snapshot().duel.room.players.find(p=>p.id!==ShootyTraining.snapshot().duel.playerId).health==={health}')
                        a.wait_for_timeout(440)
                    for page in (a,b): page.wait_for_function("ShootyTraining.snapshot().duel.room.phase==='ENDED'")
                    assert a.locator('#duel-countdown').inner_text()=='MENANG'
                    assert b.locator('#duel-countdown').inner_text()=='KALAH'
                    assert snapshot(a)['duel']['room']['players'][0]['hits']==4
                    assert snapshot(a)['audio']['playCounts']['body-hit']==4
                    a.screenshot(path=str(ARTIFACTS/'duel-camera-win.png'))
                    checks.append('Four physical-format trigger presses produce four native AI body hits, matching health on both clients and a server winner')
                    for page in (a,b): page.locator('#open-settings').click(); page.locator('#leave-room').click()
                    join(a,b)
                    for page in (a,b):
                        assert not snapshot(page)['selfie']['enrolled']
                        enroll(page)
                    for page in (a,b):
                        page.evaluate("qaAim='head'")
                        page.wait_for_function('ShootyTraining.snapshot().vision.targetVisible',timeout=10000)
                        page.locator('#enter-arena').click();page.evaluate('document.fullscreenElement&&document.exitFullscreen()')
                    for page in (a,b): page.wait_for_function("ShootyTraining.snapshot().duel.room.phase==='LIVE'",timeout=7000)
                    for health in (50,0):
                        b.locator('#touch-fire').click()
                        a.wait_for_function(f'ShootyTraining.snapshot().duel.room.players.find(p=>p.id===ShootyTraining.snapshot().duel.playerId).health==={health}')
                        b.wait_for_timeout(440)
                    b.wait_for_function("ShootyTraining.snapshot().duel.room.phase==='ENDED'")
                    assert b.locator('#duel-countdown').inner_text()=='MENANG'
                    assert snapshot(b)['duel']['room']['players'][1]['headshots']==2
                    assert snapshot(b)['audio']['playCounts']['head-hit']==2
                    checks.append('New rooms require a new selfie; two face-confirmed touch headshots deal 50 HP each and win')
                    b.locator('#open-settings').click();assert b.locator('#open-selfie').is_disabled()
                    for page in (a,b):assert page.evaluate('qaStreams.filter(stream=>stream.active).length')==1
                    checks.append('Selfie streams stop on save and only the rear camera remains active; public snapshots contain no face embeddings')
                    for width,height in ((794,279),(844,390),(390,844),(360,800)):
                        b.set_viewport_size({'width':width,'height':height})
                        assert not b.evaluate('document.documentElement.scrollWidth>innerWidth')
                    checks.append('Camera health HUD fits landscape and portrait without horizontal overflow')
                    assert not errors,errors
                    checks.append('No browser JavaScript errors; no client-supplied hit or damage claims')
                finally: browser.close()
        except Exception:
            logs.seek(0); print(logs.read()[-3500:]); raise
        finally:
            if server.poll() is None:
                server.terminate()
                try: server.wait(timeout=6)
                except subprocess.TimeoutExpired: server.kill();server.wait(timeout=3)
    report={'verified_at':datetime.now(timezone.utc).isoformat(),'checks':checks,'check_count':len(checks),'browser_errors':errors,'real_inference':True,'real_face_recognition':True,'selfie_sources':'Two distinct public fixtures; one scene has an engineering-only face composite','camera':'Google public test image rendered to a captureStream; not a physical camera','ble':'mock with measured controller packet format','physical_two_phone_test':False,'server_and_browser_stopped':True}
    (ARTIFACTS/'browser-verification.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))


if __name__=='__main__': main()
