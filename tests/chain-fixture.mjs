// Local-only test accounts. No owner credentials or remote chain writes.
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInterface} from 'node:readline';
import {ContractFactory,JsonRpcProvider,Wallet,parseEther,toBeHex} from 'ethers';

const artifact=name=>JSON.parse(readFileSync(new URL('../contracts/out/'+name,import.meta.url)));
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function fixture() {
  const directory=mkdtempSync(join(tmpdir(),'shooty-chain-test-'));
  const port=await new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const child=spawn('anvil',['--silent','--host','127.0.0.1','--port',String(port),'--chain-id','10143','--slots-in-an-epoch','1'],{stdio:'ignore'});
  const provider=new JsonRpcProvider(`http://127.0.0.1:${port}`,{chainId:10143,name:'local-test'},{staticNetwork:true,cacheTimeout:0,batchMaxCount:1});
  const wallets=Array.from({length:5},(_,i)=>new Wallet('0x'+String(i+1).padStart(64,'0'),provider));
  const close=async()=>{provider.destroy();if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(3000)]);if(child.exitCode===null)child.kill('SIGKILL');}rmSync(directory,{recursive:true,force:true});};
  try {
    for(let i=0;;i++){try{await provider.send('eth_chainId',[]);break;}catch(error){if(i>30)throw error;await wait(100);}}
    for(const wallet of wallets)await provider.send('anvil_setBalance',[wallet.address,toBeHex(parseEther('100'))]);
    const deployer=await provider.getSigner(0),tokenArtifact=artifact('TestBase.sol/TestToken.json'),arenaArtifact=artifact('ShootyArena.sol/ShootyArena.json');
    const token=await new ContractFactory(tokenArtifact.abi,tokenArtifact.bytecode.object,deployer).deploy();await token.waitForDeployment();
    const arena=await new ContractFactory(arenaArtifact.abi,arenaArtifact.bytecode.object,deployer).deploy(await token.getAddress(),await deployer.getAddress(),wallets[0].address,await deployer.getAddress(),wallets[1].address,wallets[2].address);await arena.waitForDeployment();
    for(const wallet of wallets.slice(3))await (await token.mint(wallet.address,2000000n)).wait();
    await provider.send('anvil_mine',['0x3']);
    const keyFile=join(directory,'roles.json');writeFileSync(keyFile,JSON.stringify({wallets:{relayer:{privateKey:wallets[0].privateKey},referee:{privateKey:wallets[1].privateKey}}}),{mode:0o600});
    const env={MONAD_TESTNET_RPC_URL:`http://127.0.0.1:${port}`,SHOOTY_ARENA_ADDRESS:await arena.getAddress(),SHOOTY_TOKEN_ADDRESS:await token.getAddress(),ROOM_CREATOR:wallets[0].address,REFEREE:wallets[1].address,SHOOTY_KEY_FILE:keyFile,SHOOTY_JOURNAL_DIR:join(directory,'journal'),SHOOTY_CHAIN_DB:join(directory,'chain.sqlite3')};
    return {directory,provider,wallets,token,arena,env,close};
  }catch(error){await close();throw error;}
}

if(process.argv.includes('--serve')) {
  const f=await fixture();
  console.log(JSON.stringify({env:f.env,players:f.wallets.slice(3).map(w=>w.address),treasury:f.wallets[2].address}));
  try {
    for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})) {
      const command=JSON.parse(line);
      try {
        let result={};
        if(command.type==='sign')result={signature:await f.wallets[command.player+3].signMessage(command.message)};
        if(command.type==='mine')await f.provider.send('anvil_mine',['0x3','0x0']);
        if(command.type==='deposit'){
          const wallet=f.wallets[command.player+3];await(await f.token.connect(wallet).approve(await f.arena.getAddress(),1000000n)).wait();
          await(await f.arena.connect(wallet).joinMatch(command.matchId,command.termsHash)).wait();await f.provider.send('anvil_mine',['0x3','0x0']);
        }
        if(command.type==='balances')result={players:await Promise.all(f.wallets.slice(3).map(async w=>(await f.token.balanceOf(w.address)).toString())),treasury:(await f.token.balanceOf(f.wallets[2].address)).toString()};
        console.log(JSON.stringify({result}));
      }catch{console.log(JSON.stringify({error:'FIXTURE_COMMAND_FAILED'}));}
    }
  }finally{await f.close();}
}
