"""Wallet-bound room funding and durable referee/claim jobs.

Only the private child worker reads signing keys. Game/vision event loops never
wait for an RPC while holding the arena lock. Financial records contain no photos.
"""
import asyncio
from contextlib import suppress
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import sqlite3
import time

from .duel import RuleError, VISION_RULES


class Worker:
    def __init__(self, root, env=None):
        self.root, self.env = root, env or {}
        self.process = None
        self.lock = asyncio.Lock()
        self.sequence = 0

    async def call(self, method, **params):
        async with self.lock:
            if self.process is None or self.process.returncode is not None:
                self.process = await asyncio.create_subprocess_exec('node', str(self.root/'server/chain-worker.mjs'),
                    cwd=self.root, env={**os.environ, **self.env}, stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=2**20)
            self.sequence += 1
            request = {'id': self.sequence, 'method': method, 'params': params}
            try:
                self.process.stdin.write((json.dumps(request)+'\n').encode())
                await self.process.stdin.drain()
                response = json.loads(await asyncio.wait_for(self.process.stdout.readline(), 50))
                if response.get('id') != self.sequence:
                    raise ValueError('Worker response mismatch')
                if response.get('error'):
                    raise RuleError(response['error'])
                return response['result']
            except (TimeoutError, ValueError, BrokenPipeError):
                await self.close()
                raise RuleError('CHAIN_RPC_UNAVAILABLE')

    async def close(self):
        process, self.process = self.process, None
        if process and process.returncode is None:
            process.stdin.close()
            try: await asyncio.wait_for(process.wait(), 3)
            except TimeoutError:
                process.terminate()
                try: await asyncio.wait_for(process.wait(), 2)
                except TimeoutError: process.kill(); await process.wait()


class ChainService:
    def __init__(self, application, enabled=False, settings=None):
        self.app, self.enabled = application, enabled
        settings = {**os.environ, **(settings or {})}
        self.worker = Worker(application.root, settings)
        self.config = {'enabled': enabled, 'ready': False, 'chainId': 10143,
            'publicRpc': 'https://testnet-rpc.monad.xyz', 'explorer': 'https://testnet.monadscan.com',
            'entry': '1000000', 'winnerAmount': '1800000'}
        self.challenges, self.records = {}, {}
        self.task = None
        self.db = None
        self.config_at = 0
        self.info_lock=asyncio.Lock()
        if enabled:
            path = Path(settings.get('SHOOTY_CHAIN_DB', application.root/'.secrets/chain.sqlite3'))
            path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600); os.close(fd)
            self.db = sqlite3.connect(path)
            self.db.execute('CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, document TEXT NOT NULL)')
            self.db.commit()
            self.records = {key: json.loads(document) for key, document in self.db.execute('SELECT id, document FROM matches')}

    def save(self, record):
        self.records[record['matchId']] = record
        self.db.execute('INSERT INTO matches VALUES (?,?) ON CONFLICT(id) DO UPDATE SET document=excluded.document',
                        (record['matchId'], json.dumps(record, separators=(',', ':'))))
        self.db.commit()

    async def info(self, force=False):
        if not self.enabled:
            return self.config
        async with self.info_lock:
            if force or time.monotonic()-self.config_at > 30:
                try:
                    self.config.update(await self.worker.call('config'))
                    self.config['error'] = None
                except RuleError as error:
                    self.config.update(ready=False, error=str(error))
                self.config_at = time.monotonic()
        if self.task is None:
            self.task = asyncio.create_task(self.run())
        return self.config

    def authenticated(self, player):
        return bool(player.wallet and player.wallet_active and player.wallet_expires_at > self.app.arena.clock())

    def wallet_state(self, player):
        return {'type': 'WALLET_STATE', 'address': player.wallet, 'authenticated': self.authenticated(player)}

    def paid_room(self, player):
        room = self.app.arena.rooms.get(player.room)
        return room if room and room.funding else None

    async def handle(self, peer, player, message):
        kind, request_id = message.get('type'), message.get('requestId')
        if kind not in ('CHAIN_INFO', 'WALLET_CHALLENGE', 'WALLET_AUTH', 'WALLET_DISCONNECT', 'CHAIN_SYNC', 'CHAIN_RECOVERY','CHAIN_RECEIPT'):
            return False
        async def reply(kind, **fields):
            await peer.send(json.dumps({'type': kind, 'requestId': request_id, **fields}))
        try:
            if kind == 'CHAIN_INFO':
                await reply('CHAIN_CONFIG', config=await self.info())
            elif kind == 'WALLET_CHALLENGE':
                if not self.enabled: raise RuleError('CHAIN_DISABLED')
                address = message.get('address')
                if not isinstance(address, str) or not re.fullmatch('0x[0-9a-fA-F]{40}', address): raise RuleError('INVALID_WALLET')
                address = (await self.worker.call('normalize', address=address))['address']
                if self.paid_room(player) and player.wallet and player.wallet.lower() != address.lower(): raise RuleError('WALLET_ROSTER_FROZEN')
                origin = peer.request.headers.get('Origin') or 'http://'+peer.request.headers['Host']
                domain = origin.split('://', 1)[1]
                nonce, challenge_id = secrets.token_hex(16), secrets.token_hex(12)
                issued = datetime.now(timezone.utc)
                text = (f'{domain} wants you to sign in with your Ethereum account:\n{address}\n\n'
                    'Sign in to Shooty. This signature does not transfer tokens.\n\n'
                    f'URI: {origin}/\nVersion: 1\nChain ID: 10143\nNonce: {nonce}\n'
                    f'Issued At: {issued.isoformat()}\nExpiration Time: {(issued+timedelta(minutes=5)).isoformat()}')
                self.challenges[player.id] = {'id': challenge_id, 'message': text, 'address': address,
                    'peer': peer, 'expires': time.monotonic()+300}
                await reply('WALLET_CHALLENGE', challengeId=challenge_id, message=text)
            elif kind == 'WALLET_AUTH':
                challenge = self.challenges.pop(player.id, None)
                signature = message.get('signature')
                if not challenge or challenge['id'] != message.get('challengeId') or challenge['peer'] is not peer or challenge['expires'] < time.monotonic(): raise RuleError('WALLET_CHALLENGE_EXPIRED')
                if not isinstance(signature, str) or not re.fullmatch('0x(?:[0-9a-fA-F]{2}){1,2048}', signature): raise RuleError('INVALID_WALLET_SIGNATURE')
                result = await self.worker.call('verify', address=challenge['address'], message=challenge['message'], signature=signature)
                if not result['valid']: raise RuleError('INVALID_WALLET_SIGNATURE')
                async with self.app.lock:
                    if self.app.peers.get(player.id) is not peer: raise RuleError('STALE_SESSION')
                    if self.paid_room(player) and player.wallet and player.wallet.lower() != result['address'].lower(): raise RuleError('WALLET_ROSTER_FROZEN')
                    player.wallet, player.wallet_active = result['address'], True
                    player.wallet_expires_at = self.app.arena.clock()+3600000
                    await self.app.emit(self.app.arena._publish(self.app.arena.rooms[player.room]) if player.room else [])
                await reply('WALLET_AUTHENTICATED', address=player.wallet, authenticated=True)
            elif kind == 'WALLET_DISCONNECT':
                async with self.app.lock:
                    player.wallet_active = False
                    room = self.paid_room(player)
                    if room:
                        self.app.arena._pause(room, 'WALLET_CHANGED')
                        await self.app.emit(self.app.arena._publish(room))
                await reply('WALLET_STATE', address=player.wallet, authenticated=False)
            elif kind == 'CHAIN_RECOVERY':
                if not self.authenticated(player): raise RuleError('WALLET_REQUIRED')
                matches = [self.public(r) for r in self.records.values() if r.get('arena')==self.config.get('arena') and player.wallet.lower() in [a.lower() for a in r['roster']]]
                await reply('CHAIN_RECOVERY', matches=matches[-20:])
            elif kind == 'CHAIN_RECEIPT':
                if not self.authenticated(player): raise RuleError('WALLET_REQUIRED')
                transaction_hash=message.get('hash')
                if not isinstance(transaction_hash,str) or not re.fullmatch('0x[0-9a-fA-F]{64}',transaction_hash):raise RuleError('INVALID_TX_HASH')
                await reply('CHAIN_RECEIPT',**await self.worker.call('receipt',hash=transaction_hash))
            else:
                # Sync requests only wake the reconciler. Client transaction
                # hashes, payment flags, winners and balances are never trusted.
                if not self.authenticated(player): raise RuleError('WALLET_REQUIRED')
                await self.info()
                await reply('CHAIN_SYNCED', accepted=True)
        except RuleError as error:
            await reply('ERROR', code=str(error))
        return True

    async def admit(self, player, message):
        room = self.app.arena.rooms.get(message.get('code', '').strip().upper()) if isinstance(message.get('code'), str) else None
        paid = message.get('type') == 'CREATE_ROOM' and message.get('funding') == 'TEST_USDC' or room and room.funding
        if not paid: return
        if not self.authenticated(player): raise RuleError('WALLET_REQUIRED')
        config = await self.info()
        if not config.get('ready'): raise RuleError(config.get('error') or 'SIGNERS_UNAVAILABLE')
        if message.get('type') == 'CREATE_ROOM' and message.get('mode') != 'VISION': raise RuleError('PAID_VISION_REQUIRED')
        if room and any(p.wallet and p.wallet.lower() == player.wallet.lower() for p in self.app.arena._members(room)):
            raise RuleError('DUPLICATE_WALLET')

    def observe(self):
        if not self.enabled: return
        for room in self.app.arena.rooms.values():
            if not room.funding: continue
            members = self.app.arena._members(room)
            if len(members) == 2 and not room.funding.get('sealed'):
                if not all(self.authenticated(p) for p in members): continue
                now = int(time.time())
                match_id = '0x'+secrets.token_hex(32)
                roster = [p.wallet for p in members]
                rules = {**VISION_RULES, 'pausePolicy': 'wall-clock-120-seconds-including-countdown', 'settlement': 'referee-authorized-duel-v1'}
                # SHA-256 produces a nonzero bytes32 commitment. The exact JSON
                # and its hash are kept in the durable match record.
                rules_json = json.dumps(rules,sort_keys=True,separators=(',', ':'))
                record = {'matchId': match_id, 'roomCode': room.code, 'roster': roster, 'playerIds': [p.id for p in members],
                    'arena':self.config['arena'],'token':self.config['token'],'chainId':10143,
                    'rulesHash': '0x'+hashlib.sha256(rules_json.encode()).hexdigest(), 'rules': rules,
                    'joinDeadline': now+300, 'startDeadline': now+600, 'stage': 'CREATING', 'jobs': {},
                    'events': {}, 'snapshot': None, 'result': None, 'audit': [], 'error': None}
                self.save(record)
                room.match_id = match_id
                room.funding.update(sealed=True, matchId=match_id, stage='CREATING', roster=roster)
            record = self.records.get(room.funding.get('matchId'))
            if not record: continue
            if room.phase == 'ENDED' and record.get('result') is None and room.outcome in ('WIN','DRAW'):
                winner = record['playerIds'].index(room.winner_id) if room.outcome == 'WIN' else 0
                transcript = {'matchId':record['matchId'], 'rulesHash':record['rulesHash'], 'outcome':room.outcome,
                    'winner':winner, 'players':[{'id':p.id,'health':p.health,'shots':p.shots,'hits':p.hits,'headshots':p.headshots} for p in members], 'events':record['audit']}
                record['result'] = {'outcome':0 if room.outcome=='WIN' else 1, 'winner':winner,
                    'resultsHash':'0x'+hashlib.sha256(json.dumps(transcript,sort_keys=True,separators=(',',':')).encode()).hexdigest(), 'transcript':transcript}
                self.save(record)

    def audit(self, events):
        if not self.enabled: return
        for _, event in events:
            if event.get('type') != 'ROOM_EVENT': continue
            room = self.app.arena.rooms.get(event.get('code'))
            record = self.records.get(room.funding.get('matchId')) if room and room.funding else None
            if record:
                key = str(event['revision'])+':'+event['action']
                if not any(e['key']==key for e in record['audit']):
                    record['audit'].append({'key':key, **event})
                    self.save(record)
        self.observe()

    def public(self, record):
        snapshot = record.get('snapshot') or {}
        paid = {}
        for event in record['events'].values():
            if event['type']=='PaymentSent' and event.get('transferVerified'):
                key=event['beneficiary'].lower(); paid[key]=str(int(paid.get(key,'0'))+int(event['amount']))
        return {'matchId':record['matchId'], 'chainId':10143, 'arena':record.get('arena'), 'token':record.get('token'),
            'roster':record['roster'],'rulesHash':record['rulesHash'],'termsHash':snapshot.get('termsHash'),
            'joinDeadline':record['joinDeadline'],'startDeadline':record['startDeadline'],'resultDeadline':snapshot.get('resultDeadline'),
            'stage':record['stage'],'onchainState':int(snapshot.get('state',0)),'depositMask':int(snapshot.get('depositMask',0)),
            'credits':snapshot.get('credits',[]),'payments':paid,'totalDeposited':snapshot.get('totalDeposited','0'),
            'totalPaid':snapshot.get('totalPaid','0'),'transactions':record['jobs'],'error':record.get('error')}

    async def job(self, record, action, **extra):
        params={k:record[k] for k in ('matchId','roster','rulesHash','joinDeadline','startDeadline')}
        params.update(action=action, **extra)
        name=action+(':'+extra['beneficiary'].lower() if 'beneficiary' in extra else '')
        result=await self.worker.call('execute', **params)
        record['jobs'][name]=result
        self.save(record)
        return result

    async def reconcile(self, record):
        if record.get('arena')!=self.config.get('arena') or record.get('token')!=self.config.get('token'):return
        room = self.app.arena.rooms.get(record['roomCode'])
        if room and (not room.funding or room.funding.get('matchId') != record['matchId']): room=None
        if record['stage']=='CREATING': await self.job(record,'create')
        snapshot=await self.worker.call('snapshot', matchId=record['matchId'], fromBlock=record.get('nextBlock'))
        if not snapshot['exists']: return
        if [a.lower() for a in snapshot['roster']] != [a.lower() for a in record['roster']] or snapshot['rulesHash'] != record['rulesHash']:
            raise RuleError('CHAIN_TERMS_MISMATCH')
        record['snapshot']=snapshot
        record['nextBlock']=snapshot['nextBlock']
        for event in snapshot['events']:
            record['events'][event['transactionHash']+':'+str(event['logIndex'])]=event
        state=int(snapshot['state']); deadline=int(snapshot[{1:'joinDeadline',2:'startDeadline',3:'resultDeadline'}.get(state,'joinDeadline')])
        now=snapshot['chainTimestamp']
        if state in (1,2,3) and now>deadline:
            record['stage']='REFUND_PENDING'; await self.job(record,'expire')
        elif state==1:record['stage']='OPEN'
        elif state==2:
            record['stage']='FUNDED'
            if room and room.phase=='CHAIN_STARTING':
                record['stage']='STARTING'; await self.job(record,'start')
        elif state==3:
            record['stage']='LIVE'
            if room and not room.funding.get('started'):
                async with self.app.lock:
                    room.funding['started']=True
                    room.funding['wallDeadline']=self.app.arena.clock()+120000
                    if all(p.ready and p.connected and p.visible and p.controller_ready and p.face_enrolled and self.app.arena.camera_ready(p) and self.authenticated(p) for p in self.app.arena._members(room)):
                        room.phase='COUNTDOWN';room.starts_at=self.app.arena.clock()+3000
                    else:
                        self.app.arena._pause(room,'PLAYER_NOT_READY')
                        room.phase='PAUSED';room.reason='PLAYER_NOT_READY'
            if record.get('result'):
                record['stage']='SETTLING'
                await self.job(record,'resolve',**{k:record['result'][k] for k in ('outcome','winner','resultsHash')})
        elif state in (4,5):
            record['stage']='CREDITED' if state==4 else 'REFUND_AVAILABLE'
            record['claimErrors']={}
            for credit in snapshot['credits']:
                if int(credit['amount'])>0:
                    try: await self.job(record,'claim',beneficiary=credit['address'])
                    except RuleError as error: record['claimErrors'][credit['address']]=str(error)
                    record['stage']='PAYING' if state==4 else 'REFUNDING'
            verified=sum(int(e['amount']) for e in record['events'].values() if e['type']=='PaymentSent' and e.get('transferVerified'))
            if int(snapshot['totalDeposited'])==int(snapshot['totalPaid'])==verified:
                record['stage']='PAID' if state==4 else 'REFUNDED'
        record['error']='CLAIM_RETRY' if record.get('claimErrors') else None
        self.save(record)
        if room:
            public=self.public(record)
            async with self.app.lock:
                if any(room.funding.get(k)!=v for k,v in public.items()):
                    room.funding.update(public)
                    await self.app.emit(self.app.arena._publish(room))

    async def run(self):
        await self.info()
        while True:
            try:
                async with self.app.lock: self.observe()
                for record in list(self.records.values()):
                    if record['stage'] in ('PAID','REFUNDED'): continue
                    try: await self.reconcile(record)
                    except RuleError as error:
                        record['error']=str(error);self.save(record)
                        room=self.app.arena.rooms.get(record['roomCode'])
                        if room and room.funding and room.funding.get('matchId')==record['matchId']:
                            async with self.app.lock:
                                room.funding.update(self.public(record));await self.app.emit(self.app.arena._publish(room))
            except asyncio.CancelledError: raise
            await asyncio.sleep(3)

    async def close(self):
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError): await self.task
        await self.worker.close()
        if self.db: self.db.close()
