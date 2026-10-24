"""Real arena/USDC contracts and wallet signatures; camera presence is simulated."""
import asyncio
from contextlib import AsyncExitStack, suppress
import json
import unittest
from websockets.asyncio.client import connect
from gun_service import APP_ROOT, WEB_FILES
from server.transport import serve_application


class ChainGameFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fixture=await asyncio.create_subprocess_exec('node','tests/chain-fixture.mjs','--serve',cwd=APP_ROOT,
            stdin=asyncio.subprocess.PIPE,stdout=asyncio.subprocess.PIPE,stderr=asyncio.subprocess.DEVNULL)
        self.fixture_config=json.loads(await asyncio.wait_for(self.fixture.stdout.readline(),15))
        self.fixture_lock=asyncio.Lock();self.stack=AsyncExitStack();self.camera_task=None
        self.app,server=await self.stack.enter_async_context(serve_application(APP_ROOT,WEB_FILES,'127.0.0.1',0,chain=True,chain_settings=self.fixture_config['env']))
        self.port=server.sockets[0].getsockname()[1];self.origin=f'http://127.0.0.1:{self.port}'

    async def asyncTearDown(self):
        if self.camera_task:
            self.camera_task.cancel()
            with suppress(asyncio.CancelledError):await self.camera_task
        await self.stack.aclose()
        self.fixture.stdin.close()
        try:await asyncio.wait_for(self.fixture.wait(),5)
        except TimeoutError:self.fixture.terminate();await self.fixture.wait()

    async def command(self,**message):
        async with self.fixture_lock:
            self.fixture.stdin.write((json.dumps(message)+'\n').encode());await self.fixture.stdin.drain()
            result=json.loads(await asyncio.wait_for(self.fixture.stdout.readline(),10))
            self.assertNotIn('error',result);return result['result']

    async def until(self,peer,kind,predicate=lambda m:True):
        async with asyncio.timeout(15):
            while True:
                message=json.loads(await peer.recv())
                if message['type']==kind and predicate(message):return message

    async def send(self,peer,kind,**fields):await peer.send(json.dumps({'type':kind,**fields}))

    async def player(self,index):
        peer=await self.stack.enter_async_context(connect(f'ws://127.0.0.1:{self.port}/ws/duel',origin=self.origin))
        await self.send(peer,'HELLO');session=await self.until(peer,'SESSION')
        await self.send(peer,'AVAILABLE',visible=True,controllerReady=True,inputKind='touch')
        await self.send(peer,'WALLET_CHALLENGE',address=self.fixture_config['players'][index])
        challenge=await self.until(peer,'WALLET_CHALLENGE')
        signature=(await self.command(type='sign',player=index,message=challenge['message']))['signature']
        await self.send(peer,'WALLET_AUTH',challengeId=challenge['challengeId'],signature=signature)
        authenticated=await self.until(peer,'WALLET_AUTHENTICATED');self.assertTrue(authenticated['authenticated'])
        await self.send(peer,'WALLET_AUTH',challengeId=challenge['challengeId'],signature=signature)
        self.assertEqual((await self.until(peer,'ERROR'))['code'],'WALLET_CHALLENGE_EXPIRED')
        return peer,self.app.arena.players[session['token']]

    async def wait(self,predicate,seconds=30):
        async with asyncio.timeout(seconds):
            while not predicate():await self.command(type='mine');await asyncio.sleep(.15)

    async def test_room_requires_real_funding_start_then_pays_exact_prize_and_fee(self):
        a,pa=await self.player(0);b,pb=await self.player(1)
        await self.send(a,'CREATE_ROOM',mode='VISION',funding='TEST_USDC')
        created=await self.until(a,'ROOM_STATE');code=created['room']['code']
        await self.send(b,'JOIN_ROOM',code=code);await self.until(b,'ROOM_STATE')
        room=self.app.arena.rooms[code]
        await self.wait(lambda:bool(room.funding.get('termsHash')))
        self.assertEqual(room.funding['onchainState'],1)
        await self.send(a,'READY',ready=True)
        self.assertEqual((await self.until(a,'ERROR'))['code'],'MATCH_NOT_FUNDED')
        await self.send(a,'CHAIN_SYNC',paid=True,depositMask=3,requestId='fake-payment')
        await self.until(a,'CHAIN_SYNCED');self.assertEqual(room.funding['depositMask'],0)
        for index in (0,1):await self.command(type='deposit',player=index,matchId=room.match_id,termsHash=room.funding['termsHash'])
        await self.wait(lambda:room.funding['onchainState']==2)
        async def cameras():
            while True:
                async with self.app.lock:
                    for player,opponent in ((pa,pb),(pb,pa)):
                        player.face_enrolled=True
                        await self.app.emit(self.app.arena.update_vision(player,True,False,opponent.id))
                await asyncio.sleep(.2)
        self.camera_task=asyncio.create_task(cameras());await asyncio.sleep(.25)
        await self.send(a,'READY',ready=True);await self.send(b,'READY',ready=True)
        await self.until(a,'ROOM_STATE',lambda m:m['room']['phase']=='CHAIN_STARTING')
        await self.wait(lambda:room.phase=='LIVE')
        self.assertTrue(room.funding['started']);self.assertEqual(room.funding['onchainState'],3)
        for sequence in range(1,5):
            await self.send(a,'INPUT',seq=sequence,matchId=room.match_id,action='FIRE')
            accepted=await self.until(a,'INPUT_RESULT');self.assertTrue(accepted['accepted'])
            async with self.app.lock:
                shot=self.app.arena.claim_shot(pa,accepted['shotId'])
                await self.app.emit(self.app.arena.resolve_shot(shot,'BODY'))
            await asyncio.sleep(.41)
        await self.wait(lambda:room.funding['stage']=='PAID')
        balances=await self.command(type='balances')
        self.assertEqual(balances,{'players':['2800000','1000000'],'treasury':'200000'})
        self.assertEqual(room.funding['payments'][pa.wallet.lower()],'1800000')
        self.assertEqual(room.outcome,'WIN');self.assertEqual(room.winner_id,pa.id)
        record=self.app.chain.records[room.match_id];self.assertIsNotNone(record['result'])
        self.assertTrue(any(e['type']=='PaymentSent' and e.get('transferVerified') for e in record['events'].values()))
