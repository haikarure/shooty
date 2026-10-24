// Private stdio worker: no listening port, no browser-visible keys or signing API.
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { Contract, Interface, JsonRpcProvider, FetchRequest, Wallet, Transaction, AbiCoder, getAddress, id, keccak256, toUtf8Bytes, verifyMessage, hashMessage } from 'ethers';
import { startTypedData, resultTypedData, termsAbiTypes, TERMS_TAG } from '../contracts/integration/authorizations.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYED = JSON.parse(readFileSync(resolve(ROOT,'contracts/deployment/addresses.json')));
const ARENA_ABI = JSON.parse(readFileSync(resolve(ROOT,'contracts/abi/ShootyArena.json')));
const TOKEN_ABI = ['function decimals() view returns(uint8)','function balanceOf(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','event Transfer(address indexed from,address indexed to,uint256 value)'];
const arenaInterface = new Interface(ARENA_ABI), tokenInterface = new Interface(TOKEN_ABI);
const abi = AbiCoder.defaultAbiCoder();
const json = value => JSON.stringify(value,(_,v)=>typeof v==='bigint'?v.toString():v);
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const stable = value => JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):typeof v==='bigint'?v.toString():v);
const fail = code => { throw new Error(code); };
const bytes32 = value => /^0x[\da-f]{64}$/i.test(value||'')?value:fail('INVALID_MATCH_ID');

export function loadRoleWallets(path, expected) {
  let text=''; if(path&&existsSync(path)) text=readFileSync(path,'utf8');
  const candidates=[process.env.RELAYER_PRIVATE_KEY,process.env.REFEREE_PRIVATE_KEY,
    ...[...text.matchAll(/(?<![A-Za-z0-9])(?:0x)?([0-9a-fA-F]{64})(?![A-Za-z0-9])/g)].map(m=>'0x'+m[1])].filter(Boolean);
  const found={};
  for(const key of candidates) {
    try { const wallet=new Wallet(key); for(const [role,address] of Object.entries(expected)) if(wallet.address.toLowerCase()===address.toLowerCase()) found[role]=wallet; } catch {}
  }
  return found;
}

export class ChainWorker {
  constructor(env=process.env) {
    this.env=env;
    this.address=getAddress(env.SHOOTY_ARENA_ADDRESS||DEPLOYED.arena);
    this.tokenAddress=getAddress(env.SHOOTY_TOKEN_ADDRESS||DEPLOYED.rewardToken);
    this.rpc=env.MONAD_TESTNET_RPC_URL||'https://testnet-rpc.monad.xyz';
    const request=new FetchRequest(this.rpc);request.timeout=10000;
    this.provider=new JsonRpcProvider(request,{chainId:10143,name:'monad-testnet'},{staticNetwork:true,batchMaxCount:1,cacheTimeout:0});
    this.arena=new Contract(this.address,ARENA_ABI,this.provider);
    this.token=new Contract(this.tokenAddress,TOKEN_ABI,this.provider);
    this.journal=resolve(env.SHOOTY_JOURNAL_DIR||resolve(ROOT,'.secrets/chain-transactions'));
    const expected={relayer:env.ROOM_CREATOR||DEPLOYED.roles.creator,referee:env.REFEREE||DEPLOYED.roles.referee};
    this.wallets=loadRoleWallets(resolve(env.SHOOTY_KEY_FILE||resolve(ROOT,'.env')),expected);
    this.receipts=new Map();
    this.nextNonce=0;
    if(existsSync(this.journal))for(const name of readdirSync(this.journal).filter(n=>n.endsWith('.json'))) {
      try { const saved=JSON.parse(readFileSync(resolve(this.journal,name),'utf8')),tx=Transaction.from(saved.raw);
        if(tx.from===this.wallets.relayer?.address&&tx.chainId===10143n&&tx.to===this.address)this.nextNonce=Math.max(this.nextNonce,tx.nonce+1);
      }catch{}
    }
  }
  async read(fn) {
    for(let attempt=0;;attempt++) {
      try{return await fn();}catch(error) {
        const code=error?.error?.code??error?.info?.error?.code;
        if(attempt>=3||![429,-32007,-32005].includes(code)&&!String(error?.message).includes('429')) throw error;
        await sleep(500*2**attempt);
      }
    }
  }
  async block() { return this.read(()=>this.provider.getBlock('finalized')); }
  async check() {
    if(BigInt(await this.read(()=>this.provider.send('eth_chainId',[])))!==10143n) fail('WRONG_CHAIN');
    const block=await this.block();
    const override={blockTag:block.number};
    if(await this.read(()=>this.provider.getCode(this.address,block.number))==='0x')fail('ARENA_NOT_DEPLOYED');
    const [token,entry,fee,seconds,decimals,referee,paused]=await Promise.all([
      this.read(()=>this.arena.rewardToken(override)),this.read(()=>this.arena.ENTRY(override)),this.read(()=>this.arena.FEE_BPS(override)),
      this.read(()=>this.arena.MAX_PLAY_SECONDS(override)),this.read(()=>this.token.decimals(override)),this.read(()=>this.arena.defaultReferee(override)),this.read(()=>this.arena.paused(override)),
    ]);
    if(token.toLowerCase()!==this.tokenAddress.toLowerCase()||entry!==1000000n||fee!==1000n||seconds!==120n||decimals!==6n)fail('CONTRACT_CONFIG_MISMATCH');
    const relayer=this.wallets.relayer, official=this.wallets.referee;
    const rolesReady=Boolean(relayer&&official&&official.address.toLowerCase()===referee.toLowerCase()&&await this.read(()=>this.arena.hasRole(id('ROOM_CREATOR_ROLE'),relayer.address,override)));
    const balance=relayer?await this.read(()=>this.provider.getBalance(relayer.address,block.number)):0n;
    return {chainId:10143,arena:this.address,token:this.tokenAddress,entry:'1000000',feeBps:1000,referee,relayer:relayer?.address||null,signersReady:rolesReady,ready:rolesReady&&balance>0n&&!paused,paused,relayerBalanceWei:balance.toString(),finalizedBlock:block.number};
  }
  async verify({address,message,signature}) {
    address=getAddress(address);
    try{if(verifyMessage(message,signature)===address)return {valid:true,address};}catch{}
    try {
      const block=await this.block();
      if(await this.read(()=>this.provider.getCode(address,block.number))!=='0x') {
        const c=new Contract(address,['function isValidSignature(bytes32,bytes) view returns(bytes4)'],this.provider);
        return {valid:(await this.read(()=>c.isValidSignature(hashMessage(message),signature,{blockTag:block.number})))==='0x1626ba7e',address};
      }
    }catch{}
    return {valid:false,address};
  }
  async match(matchId,blockTag='finalized') {
    try { const d=await this.read(()=>this.arena.getMatch(bytes32(matchId),{blockTag}));return Object.fromEntries(['mode','state','rosterHash','rulesHash','termsHash','referee','feeRecipient','joinDeadline','startDeadline','resultDeadline','depositMask','locked'].map(k=>[k,typeof d[k]==='bigint'?d[k].toString():d[k]])); }
    catch(error){if(error.data===arenaInterface.getError('UnknownMatch').selector)return null;throw error;}
  }
  async finalizedReceipt(hash) {
    if(this.receipts.has(hash))return this.receipts.get(hash);
    const receipt=await this.read(()=>this.provider.getTransactionReceipt(hash));if(!receipt)return null;
    const block=await this.block();if(receipt.blockNumber>block.number)return null;
    const canonical=await this.read(()=>this.provider.getBlock(receipt.blockNumber));
    if(canonical?.hash!==receipt.blockHash)return null;
    const result={hash:receipt.hash,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash,status:receipt.status,logs:receipt.logs.map(l=>({address:l.address,topics:l.topics,data:l.data,index:l.index,transactionHash:l.transactionHash}))};
    if(this.receipts.size>256)this.receipts.delete(this.receipts.keys().next().value);
    this.receipts.set(hash,result);return result;
  }
  async snapshot({matchId,fromBlock}) {
    const block=await this.block();const data=await this.match(matchId,block.number);if(!data)return {exists:false,finalizedBlock:block.number,chainTimestamp:block.timestamp};
    const roster=Array.from(await this.read(()=>this.arena.getRoster(matchId,{blockTag:block.number})));
    const [credits,deposited,paid]=await Promise.all([
      Promise.all(roster.concat([data.feeRecipient]).map(async address=>({address,amount:(await this.read(()=>this.arena.creditOf(matchId,address,{blockTag:block.number}))).toString()}))),
      this.read(()=>this.arena.totalDeposited(matchId,{blockTag:block.number})),this.read(()=>this.arena.totalPaid(matchId,{blockTag:block.number})),
    ]);
    const first=Number.isSafeInteger(fromBlock)?fromBlock:Math.max(0,block.number-999),last=Math.min(block.number,first+999);
    const logs=first<=last?await this.read(()=>this.provider.getLogs({address:this.address,topics:[null,matchId],fromBlock:first,toBlock:last})):[];
    const events=[];
    for(const log of logs) {
      let parsed;try{parsed=arenaInterface.parseLog(log);}catch{continue;}if(!parsed)continue;
      const event={type:parsed.name,transactionHash:log.transactionHash,logIndex:log.index,blockNumber:log.blockNumber};
      if(parsed.name==='MatchResolved')Object.assign(event,{outcome:Number(parsed.args.outcome),winner:Number(parsed.args.winner),resultsHash:parsed.args.resultsHash});
      if(parsed.name==='PlayerDeposited')Object.assign(event,{beneficiary:parsed.args.player,amount:parsed.args.amount.toString()});
      if(['PaymentCredited','PaymentSent'].includes(parsed.name))Object.assign(event,{beneficiary:parsed.args.beneficiary,amount:parsed.args.amount.toString()});
      if(parsed.name==='PaymentSent') {
        const receipt=await this.finalizedReceipt(log.transactionHash);
        let transferred=0n;
        for(const tokenLog of receipt?.logs||[])if(tokenLog.address.toLowerCase()===this.tokenAddress.toLowerCase()) {
          try { const t=tokenInterface.parseLog(tokenLog);if(t?.name==='Transfer'&&t.args.from.toLowerCase()===this.address.toLowerCase()&&t.args.to.toLowerCase()===event.beneficiary.toLowerCase())transferred+=t.args.value; }catch{}
        }
        event.transferVerified=Boolean(receipt?.status===1&&transferred>=BigInt(event.amount));
      }
      events.push(event);
    }
    return {exists:true,...data,roster,credits,totalDeposited:deposited.toString(),totalPaid:paid.toString(),finalizedBlock:block.number,chainTimestamp:block.timestamp,events,nextBlock:last+1};
  }
  validateTerms(data,params,roster) {
    if(Number(data.mode)!==0||data.rulesHash.toLowerCase()!==params.rulesHash.toLowerCase()||data.joinDeadline!==String(params.joinDeadline)||data.startDeadline!==String(params.startDeadline)||roster.length!==2||roster.some((a,i)=>a.toLowerCase()!==params.roster[i].toLowerCase()))fail('CHAIN_TERMS_MISMATCH');
    const expected=keccak256(abi.encode(termsAbiTypes,[id(TERMS_TAG),10143,this.address,params.matchId,0,data.rosterHash,this.tokenAddress,1000000,1000,data.feeRecipient,data.referee,data.rulesHash,data.joinDeadline,data.startDeadline,120,120]));
    if(expected!==data.termsHash)fail('CHAIN_TERMS_MISMATCH');
  }
  async execute(params) {
    const {action,matchId}=params;bytes32(matchId);
    if(!['create','start','resolve','expire','claim'].includes(action))fail('INVALID_CHAIN_ACTION');
    if(BigInt(await this.read(()=>this.provider.send('eth_chainId',[])))!==10143n)fail('WRONG_CHAIN');
    const signer=this.wallets.relayer;if(!signer)fail('SIGNERS_UNAVAILABLE');
    const data=await this.match(matchId);
    if(data) {
      const roster=Array.from(await this.read(()=>this.arena.getRoster(matchId,{blockTag:'finalized'})));
      this.validateTerms(data,params,roster);
    }
    const identity=keccak256(toUtf8Bytes(`${10143}:${this.address}:${matchId}:${action}:${params.beneficiary||''}`));
    const path=resolve(this.journal,identity+'.json'),fingerprint=keccak256(toUtf8Bytes(stable(params)));
    let saved=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):null;
    if(saved&&saved.fingerprint!==fingerprint)fail('CHAIN_JOB_CONFLICT');
    if(saved) {
      const tx=Transaction.from(saved.raw);
      if(tx.hash!==saved.hash||tx.from!==signer.address||tx.chainId!==10143n||tx.to!==this.address||tx.value!==0n)fail('INVALID_TX_JOURNAL');
      const receipt=await this.finalizedReceipt(saved.hash);
      if(receipt) {
        if(receipt.status===1)return {status:'CONFIRMED',transactionHash:saved.hash,blockNumber:receipt.blockNumber};
        renameSync(path,path+'.failed-'+saved.hash+'.json');saved=null;
      }
      if(saved) {
        try{await this.read(()=>this.provider.broadcastTransaction(saved.raw));}catch(error){if(!String(error?.shortMessage||error?.message).match(/already known|nonce.*low/i))return {status:'PENDING',transactionHash:saved.hash};}
        return {status:'PENDING',transactionHash:saved.hash};
      }
    }
    const state=Number(data?.state||0);
    if(action==='create'&&state!==0||action==='start'&&state>=3||action==='resolve'&&state===4||action==='expire'&&state===5)return {status:'ALREADY_APPLIED'};
    let callData;
    if(action==='create') {
      if(params.roster?.length!==2||new Set(params.roster.map(a=>getAddress(a).toLowerCase())).size!==2)fail('INVALID_ROSTER');
      callData=arenaInterface.encodeFunctionData('createMatch',[{matchId,mode:0,roster:params.roster,rulesHash:bytes32(params.rulesHash),joinDeadline:params.joinDeadline,startDeadline:params.startDeadline}]);
    }else if(action==='start'||action==='resolve') {
      const referee=this.wallets.referee;
      if(!referee||referee.address.toLowerCase()!==data?.referee.toLowerCase())fail('REFEREE_UNAVAILABLE');
      if(action==='start') {
        if(state!==2)fail('MATCH_NOT_FUNDED');
        const typed=startTypedData(this.address,{matchId,termsHash:data.termsHash,validUntil:data.startDeadline});
        callData=arenaInterface.encodeFunctionData('startMatch',[typed.message,await referee.signTypedData(typed.domain,typed.types,typed.message)]);
      }else {
        if(state!==3)fail('MATCH_NOT_LIVE');
        const typed=resultTypedData(this.address,0,{matchId,termsHash:data.termsHash,outcome:params.outcome,winner:params.winner,resultsHash:bytes32(params.resultsHash),validUntil:data.resultDeadline});
        callData=arenaInterface.encodeFunctionData('resolveMatch',[typed.message,await referee.signTypedData(typed.domain,typed.types,typed.message)]);
      }
    }else if(action==='expire')callData=arenaInterface.encodeFunctionData('expireMatch',[matchId]);
    else callData=arenaInterface.encodeFunctionData('claimFor',[matchId,getAddress(params.beneficiary)]);
    const transaction={from:signer.address,to:this.address,data:callData,value:0n};
    await this.read(()=>this.provider.call(transaction));
    const gas=await this.read(()=>this.provider.estimateGas(transaction));
    if(gas<=0n||gas>2000000n)fail('INVALID_GAS_ESTIMATE');
    const fees=await this.read(()=>this.provider.getFeeData());
    const nonce=Math.max(this.nextNonce,await this.read(()=>this.provider.getTransactionCount(signer.address,'pending')));
    const raw=await signer.signTransaction({...transaction,chainId:10143,nonce,gasLimit:gas+gas/10n,...(fees.maxFeePerGas?{type:2,maxFeePerGas:fees.maxFeePerGas,maxPriorityFeePerGas:fees.maxPriorityFeePerGas||0n}:{gasPrice:fees.gasPrice})});
    saved={fingerprint,raw,hash:Transaction.from(raw).hash,action,matchId};
    mkdirSync(this.journal,{recursive:true,mode:0o700});
    const temporary=path+'.tmp';writeFileSync(temporary,json(saved),{mode:0o600});renameSync(temporary,path);
    this.nextNonce=nonce+1;
    // Persist exact signed bytes before submission. Ambiguous RPC errors retain
    // the same hash and nonce; a retry never signs a duplicate transaction.
    try{await this.read(()=>this.provider.broadcastTransaction(raw));}catch{}
    return {status:'PENDING',transactionHash:saved.hash};
  }
  async dispatch(method,params={}) {
    if(method==='config')return this.check();
    if(method==='verify')return this.verify(params);
    if(method==='snapshot')return this.snapshot(params);
    if(method==='receipt') {
      if(!/^0x[\da-f]{64}$/i.test(params.hash||''))fail('INVALID_TX_HASH');
      const receipt=await this.finalizedReceipt(params.hash);
      return {finalized:Boolean(receipt),status:receipt?.status??null,transactionHash:params.hash,blockNumber:receipt?.blockNumber??null};
    }
    if(method==='execute')return this.execute(params);
    if(method==='normalize')return {address:getAddress(params.address)};
    fail('INVALID_WORKER_METHOD');
  }
  close(){this.provider.destroy();this.wallets={};}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const worker=new ChainWorker();
  try {
    for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
      let request;
      try {
        if(line.length>32768)fail('WORKER_REQUEST_TOO_LARGE');request=JSON.parse(line);
        const result=await worker.dispatch(request.method,request.params);
        process.stdout.write(json({id:request.id,result})+'\n');
      }catch(error) {
        const known=/^[A-Z][A-Z0-9_]+$/.test(error?.message||'')?error.message:'CHAIN_RPC_UNAVAILABLE';
        process.stdout.write(json({id:request?.id,error:known})+'\n');
      }
    }
  }finally{worker.close();}
}
