"""Real binary WebSocket frames through the pretrained model to health updates."""
import asyncio
from contextlib import AsyncExitStack
import json
import struct
import unittest

import cv2
import numpy as np
from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

from gun_service import APP_ROOT, WEB_FILES
from server.transport import serve_application


class VisionTransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.stack = AsyncExitStack()
        self.app, server = await self.stack.enter_async_context(serve_application(APP_ROOT, WEB_FILES, '127.0.0.1', 0))
        port = server.sockets[0].getsockname()[1]
        self.origin, self.url = f'http://127.0.0.1:{port}', f'ws://127.0.0.1:{port}'
        self.now, self.frame_id = 10000, 0
        self.app.arena.clock = lambda: self.now
        image = cv2.imread(str(APP_ROOT/'tests/fixtures/vision/pose.jpg'))
        self.body = cv2.imencode('.jpg', image)[1].tobytes()
        translated = cv2.warpAffine(image, np.float32([[1, 0, 22], [0, 1, 48]]), (image.shape[1], image.shape[0]))
        self.head = cv2.imencode('.jpg', translated, [cv2.IMWRITE_JPEG_QUALITY, 85])[1].tobytes()
        self.selfie_a = (APP_ROOT/'tests/fixtures/vision/portrait.jpg').read_bytes()
        self.selfie_b = (APP_ROOT/'tests/fixtures/vision/selfie-pose.jpg').read_bytes()
        self.other_body = (APP_ROOT/'tests/fixtures/vision/pose-portrait-composite.jpg').read_bytes()

    async def asyncTearDown(self):
        await self.stack.aclose()

    async def until(self, peer, kind, predicate=lambda m: True):
        async with asyncio.timeout(15):
            while True:
                message = json.loads(await peer.recv())
                if message['type'] == kind and predicate(message): return message

    async def send(self, peer, kind, **fields):
        await peer.send(json.dumps({'type': kind, **fields}))

    async def player(self):
        control = await self.stack.enter_async_context(connect(self.url+'/ws/duel', origin=self.origin))
        await self.send(control, 'HELLO')
        session = await self.until(control, 'SESSION')
        await self.send(control, 'AVAILABLE', visible=True, controllerReady=True, inputKind='touch')
        return control, session

    async def camera(self, session):
        peer = await self.stack.enter_async_context(connect(self.url+'/ws/vision', origin=self.origin))
        await self.send(peer, 'HELLO', token=session['token'])
        await self.until(peer, 'VISION_READY')
        return peer

    async def frame(self, peer, kind='PREVIEW', image=None, **fields):
        self.frame_id += 1
        header = json.dumps({'kind': kind, 'frameId': self.frame_id, **fields}).encode()
        await peer.send(struct.pack('>I', len(header))+header+(self.body if image is None else image))
        return await self.until(peer, {'PREVIEW':'VISION_FRAME','SHOT':'FRAME_RECEIVED','ENROLL':'ENROLLMENT_RESULT'}[kind])

    async def test_camera_lock_shot_evidence_head_body_miss_duplicate_and_winner(self):
        a, sa = await self.player(); b, sb = await self.player()
        await self.send(a, 'CREATE_ROOM', mode='VISION')
        room = (await self.until(a, 'ROOM_STATE'))['room']
        await self.send(b, 'JOIN_ROOM', code=room['code'])
        await self.until(b, 'ROOM_STATE')
        va, vb = await self.camera(sa), await self.camera(sb)
        await self.frame(va, 'ENROLL', image=self.selfie_a, playerId=sb['playerId'])
        self.assertFalse(self.app.arena.players[sb['token']].face_enrolled)
        await self.frame(vb, 'ENROLL', image=self.selfie_b)
        for peer in (va, vb):
            observed = await self.frame(peer)
            self.assertEqual(len(observed['candidates']), 1)
        # Moving the camera into the setup menu must not erase enrollment or
        # prevent Ready. Blank frames still cannot produce a visible target.
        self.now += 2000
        blank = cv2.imencode('.jpg', np.zeros((360,640,3),np.uint8))[1].tobytes()
        for peer in (va, vb):
            observed = await self.frame(peer, image=blank)
            self.assertTrue(observed['selfEnrolled'])
            self.assertTrue(observed['opponentEnrolled'])
            self.assertFalse(observed['targetVisible'])
        await self.send(a, 'READY', ready=True); await self.send(b, 'READY', ready=True)
        started = (await self.until(a, 'ROOM_STATE', lambda m: m['room']['phase'] == 'COUNTDOWN'))['room']
        # Keep real frame observations fresh through the shared countdown.
        for _ in range(3):
            self.now += 1000
            await self.frame(va); await self.frame(vb, image=self.other_body)
        await self.until(a, 'ROOM_STATE', lambda m: m['room']['phase'] == 'LIVE')
        expected_health = [75, 75, 75, 25, 0]
        # The same torso with the shooter's own face must not inherit the target.
        images = [self.body, cv2.imencode('.jpg', np.zeros((360,640,3),np.uint8))[1].tobytes(), self.other_body, self.head, self.body]
        for sequence, (image, health) in enumerate(zip(images, expected_health), 1):
            await self.frame(va); await self.frame(vb, image=self.other_body)
            await self.send(a, 'INPUT', matchId=started['matchId'], seq=sequence, action='FIRE')
            ticket = await self.until(a, 'INPUT_RESULT')
            self.assertTrue(ticket['accepted'])
            if sequence == 1:
                header = json.dumps({'kind':'SHOT','frameId':99,'shotId':ticket['shotId']}).encode()
                await vb.send(struct.pack('>I',len(header))+header+self.body)
                self.assertEqual((await self.until(vb,'VISION_ERROR'))['code'], 'INVALID_SHOT')
            await self.frame(va, 'SHOT', image=image, shotId=ticket['shotId'])
            result = await self.until(a, 'SHOT_RESULT')
            self.assertEqual(result['zone'], ['BODY','MISS','MISS','HEAD','BODY'][sequence-1])
            self.assertEqual(result['damage'], [25,0,0,50,25][sequence-1])
            self.assertEqual(self.app.arena.players[sb['token']].health, health)
            if sequence == 1:
                header = json.dumps({'kind':'SHOT','frameId':100,'shotId':ticket['shotId']}).encode()
                await va.send(struct.pack('>I',len(header))+header+self.body)
                self.assertEqual((await self.until(va,'VISION_ERROR'))['code'], 'INVALID_SHOT')
            self.now += 450
        final = (await self.until(b, 'ROOM_STATE', lambda m:m['room']['phase']=='ENDED'))['room']
        self.assertEqual((final['winnerId'],final['outcome']), (sa['playerId'],'WIN'))
        self.assertEqual([p['health'] for p in final['players']], [100,0])
        self.assertEqual(self.app.vision.enrollments, {})

    async def test_selfie_rejects_blank_duplicate_opponent_and_live_replacement(self):
        a, sa = await self.player(); b, sb = await self.player()
        await self.send(a,'CREATE_ROOM',mode='VISION')
        room=(await self.until(a,'ROOM_STATE'))['room']
        await self.send(b,'JOIN_ROOM',code=room['code']);await self.until(b,'ROOM_STATE')
        va, vb = await self.camera(sa), await self.camera(sb)
        async def invalid(peer, image):
            header=json.dumps({'kind':'ENROLL','frameId':100}).encode()
            await peer.send(struct.pack('>I',len(header))+header+image)
            return (await self.until(peer,'VISION_ERROR'))['code']
        blank=cv2.imencode('.jpg',np.zeros((360,640,3),np.uint8))[1].tobytes()
        self.assertEqual(await invalid(va,blank),'SELFIE_FACE_NOT_FOUND')
        await self.frame(va,'ENROLL',image=self.selfie_a)
        self.assertEqual(await invalid(vb,self.selfie_a),'SELFIE_SAME_AS_OPPONENT')
        await self.frame(vb,'ENROLL',image=self.selfie_b)
        for peer in (va,vb):await self.frame(peer,image=blank)
        await self.send(a,'READY',ready=True);await self.send(b,'READY',ready=True)
        await self.until(a,'ROOM_STATE',lambda m:m['room']['phase']=='COUNTDOWN')
        self.assertEqual(await invalid(va,self.selfie_a),'PAUSE_TO_ENROLL')
        await self.send(a,'LEAVE_ROOM');await self.until(a,'ROOM_LEFT')
        self.assertEqual(self.app.vision.enrollments,{})

    async def test_vision_requires_existing_control_session_and_replacement_closes_stream(self):
        invalid = await self.stack.enter_async_context(connect(self.url+'/ws/vision', origin=self.origin))
        await self.send(invalid, 'HELLO', token=[])
        with self.assertRaises(ConnectionClosed): await invalid.recv()
        self.assertEqual(invalid.close_code, 1008)
        control, session = await self.player()
        camera = await self.camera(session)
        replacement = await self.stack.enter_async_context(connect(self.url+'/ws/duel', origin=self.origin))
        await self.send(replacement, 'HELLO', token=session['token'])
        resumed = await self.until(replacement,'SESSION')
        self.assertEqual(resumed['playerId'],session['playerId'])
        await asyncio.wait_for(camera.wait_closed(),3)
        self.assertEqual(camera.close_code,1008)


if __name__ == '__main__': unittest.main()
