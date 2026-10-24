import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {id} from 'ethers';
import {fixture} from './chain-fixture.mjs';
import {ChainWorker} from '../server/chain-worker.mjs';

test('exact deployed arena lifecycle: two deposits, referee start/result, independent claims and durable retry',async()=>{
  const f=await fixture();let worker=new ChainWorker(f.env);
  try {
    const execute=async args=>{const r=await worker.execute(args);await f.provider.send('anvil_mine',['0x3']);return r;};
    const config=await worker.check();assert.equal(config.ready,true);assert.equal(config.chainId,10143);
    const block=await f.provider.getBlock('latest');
    const base={matchId:id('shooty-test-duel'),rulesHash:id('server-owned-rules'),roster:f.wallets.slice(3).map(w=>w.address),joinDeadline:block.timestamp+300,startDeadline:block.timestamp+600};
    const created=await execute({...base,action:'create'});assert.match(created.transactionHash,/^0x[\da-f]{64}$/);
    await worker.finalizedReceipt(created.transactionHash);
    const retry=await worker.execute({...base,action:'create'});assert.equal(retry.transactionHash,created.transactionHash);
    let snapshot=await worker.snapshot({matchId:base.matchId});assert.equal(Number(snapshot.state),1);
    await assert.rejects(worker.execute({...base,rulesHash:id('tampered'),action:'create'}),/CHAIN_TERMS_MISMATCH/);
    for(const wallet of f.wallets.slice(3)){
      await (await f.token.connect(wallet).approve(await f.arena.getAddress(),1000000n)).wait();
      await (await f.arena.connect(wallet).joinMatch(base.matchId,snapshot.termsHash)).wait();
    }
    await f.provider.send('anvil_mine',['0x3']);
    snapshot=await worker.snapshot({matchId:base.matchId});assert.equal(Number(snapshot.state),2);assert.equal(snapshot.totalDeposited,'2000000');
    await execute({...base,action:'start'});
    snapshot=await worker.snapshot({matchId:base.matchId});assert.equal(Number(snapshot.state),3);
    const result={...base,action:'resolve',outcome:0,winner:0,resultsHash:id('server-validated-transcript')};
    await execute(result);
    snapshot=await worker.snapshot({matchId:base.matchId});assert.equal(Number(snapshot.state),4);
    assert.equal(snapshot.credits.find(c=>c.address===f.wallets[3].address).amount,'1800000');
    assert.equal(snapshot.credits.find(c=>c.address===f.wallets[2].address).amount,'200000');
    assert.equal(await f.token.balanceOf(f.wallets[3].address),1000000n);
    await execute({...base,action:'claim',beneficiary:f.wallets[3].address});
    await execute({...base,action:'claim',beneficiary:f.wallets[2].address});
    snapshot=await worker.snapshot({matchId:base.matchId});assert.equal(snapshot.totalPaid,'2000000');
    assert.equal(await f.token.balanceOf(f.wallets[3].address),2800000n);assert.equal(await f.token.balanceOf(f.wallets[2].address),200000n);
    assert.equal(snapshot.events.filter(e=>e.type==='PaymentSent'&&e.transferVerified).length,2);
    const journal=readdirSync(f.env.SHOOTY_JOURNAL_DIR).find(n=>JSON.parse(readFileSync(join(f.env.SHOOTY_JOURNAL_DIR,n))).action==='create');
    assert.equal(statSync(join(f.env.SHOOTY_JOURNAL_DIR,journal)).mode&0o777,0o600);
    worker.close();worker=new ChainWorker(f.env);
    const resumed=await worker.execute({...base,action:'create'});assert.equal(resumed.transactionHash,created.transactionHash);
    assert.equal((await worker.snapshot({matchId:base.matchId})).totalPaid,'2000000');
  }finally{worker.close();await f.close();}
});

test('partial funding expires into exactly the depositor refund',async()=>{
  const f=await fixture(),worker=new ChainWorker(f.env);
  try{
    const execute=async args=>{const r=await worker.execute(args);await f.provider.send('anvil_mine',['0x3']);return r;};
    const block=await f.provider.getBlock('latest');const base={matchId:id('refund-fixture'),rulesHash:id('rules'),roster:f.wallets.slice(3).map(w=>w.address),joinDeadline:block.timestamp+20,startDeadline:block.timestamp+40};
    await execute({...base,action:'create'});let snapshot=await worker.snapshot({matchId:base.matchId});
    const player=f.wallets[3];await(await f.token.connect(player).approve(await f.arena.getAddress(),1000000n)).wait();await(await f.arena.connect(player).joinMatch(base.matchId,snapshot.termsHash)).wait();
    await f.provider.send('evm_increaseTime',[25]);await f.provider.send('evm_mine',[]);
    await execute({...base,action:'expire'});snapshot=await worker.snapshot({matchId:base.matchId});assert.equal(Number(snapshot.state),5);
    assert.equal(snapshot.credits.find(c=>c.address===player.address).amount,'1000000');assert.equal(snapshot.credits.find(c=>c.address===f.wallets[4].address).amount,'0');
    await execute({...base,action:'claim',beneficiary:player.address});assert.equal(await f.token.balanceOf(player.address),2000000n);
  }finally{worker.close();await f.close();}
});
