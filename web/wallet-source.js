import { BrowserProvider, Contract, AbiCoder, getAddress, id, keccak256 } from 'ethers';
import arenaAbi from '../contracts/abi/ShootyArena.json';
import { termsAbiTypes, TERMS_TAG } from '../contracts/integration/authorizations.mjs';

const ENTRY=1000000n, CHAIN=10143n;
const tokenAbi=['function allowance(address,address) view returns(uint256)','function approve(address,uint256) returns(bool)','function balanceOf(address) view returns(uint256)'];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const equal=(a,b)=>String(a).toLowerCase()===String(b).toLowerCase();
const errorCode=error=>error?.code===4001||error?.code==='ACTION_REJECTED'?'WALLET_REJECTED':/^[A-Z_]+$/.test(error?.message||'')?error.message:'WALLET_TRANSACTION_FAILED';

class WalletClient {
    constructor({session,onState=()=>{},onError=()=>{}}) {
        Object.assign(this,{session,onState,onError});this.providers=[];this.account=null;this.pending=null;this.balance=null;this.lastTransaction=null;this.recovery=[];
        this.announce=event=>{const {info,provider}=event.detail||{};if(provider?.request&&!this.providers.some(p=>p.provider===provider)){this.providers.push({name:String(info?.name||'Wallet'),provider});if(this.initialized)this.onState();}};
        window.addEventListener('eip6963:announceProvider',this.announce);
        queueMicrotask(()=>{window.dispatchEvent(new Event('eip6963:requestProvider'));if(window.ethereum?.request&&!this.providers.some(p=>p.provider===window.ethereum))this.providers.push({name:'Wallet browser / Mises',provider:window.ethereum});this.initialized=true;this.onState();});
    }
    get authenticated(){return Boolean(this.account&&this.session.walletAuthenticated&&equal(this.account,this.session.walletAddress));}
    async chain() {
        const chainId=BigInt(await this.injected.request({method:'eth_chainId'}));
        if(chainId!==CHAIN) {
            try{await this.injected.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x279f'}]});}
            catch(error){if((error?.code??error?.data?.originalError?.code)!==4902)throw error;await this.injected.request({method:'wallet_addEthereumChain',params:[{chainId:'0x279f',chainName:'Monad Testnet',nativeCurrency:{name:'Test MON',symbol:'MON',decimals:18},rpcUrls:[this.session.chainConfig.publicRpc],blockExplorerUrls:['https://testnet.monadscan.com']}]});}
        }
        if(BigInt(await this.injected.request({method:'eth_chainId'}))!==CHAIN)throw new Error('WRONG_CHAIN');
        this.provider=new BrowserProvider(this.injected,'any');this.signer=await this.provider.getSigner();
    }
    async connect(index=0) {
        if(this.pending)return;
        this.pending='connect';this.onState();
        try {
            if(!this.providers[index])throw new Error('WALLET_NOT_FOUND');
            const config=await this.session.request('CHAIN_INFO');if(!config.config.enabled)throw new Error('CHAIN_DISABLED');
            this.injected=this.providers[index].provider;
            const accounts=await this.injected.request({method:'eth_requestAccounts'});if(!accounts?.length)throw new Error('WALLET_NOT_FOUND');
            this.account=getAddress(accounts[0]);await this.chain();
            const challenge=await this.session.request('WALLET_CHALLENGE',{address:this.account});
            const signature=await this.signer.signMessage(challenge.message);
            await this.session.request('WALLET_AUTH',{challengeId:challenge.challengeId,signature});
            this.watch();await this.refreshBalance();
        }catch(error){this.onError(errorCode(error));}
        finally{this.pending=null;this.onState();}
    }
    watch() {
        if(this.watched===this.injected)return;this.watched=this.injected;
        const invalidate=()=>{this.account=null;this.balance=null;void this.session.request('WALLET_DISCONNECT').catch(()=>{});this.onState();};
        this.injected.on?.('accountsChanged',invalidate);this.injected.on?.('chainChanged',invalidate);this.injected.on?.('disconnect',invalidate);
    }
    async refreshBalance(){if(this.account&&this.session.chainConfig.token)this.balance=(await new Contract(this.session.chainConfig.token,tokenAbi,this.provider).balanceOf(this.account)).toString();}
    async finality(hash) {
        this.lastTransaction=hash;this.onState();
        for(let attempt=0;attempt<180;attempt++) {
            const receipt=await this.session.request('CHAIN_RECEIPT',{hash});
            if(receipt.finalized){if(receipt.status!==1)throw new Error('CHAIN_TX_REVERTED');return receipt;}
            await sleep(1000);
        }
        throw new Error('TRANSACTION_PENDING');
    }
    async terms(funding) {
        if(!this.authenticated)throw new Error('WALLET_REQUIRED');
        await this.chain();
        if(!equal(await this.signer.getAddress(),this.session.walletAddress))throw new Error('WALLET_ROSTER_FROZEN');
        if(!funding?.termsHash||!funding.roster.some(a=>equal(a,this.account)))throw new Error('INVALID_MATCH_TERMS');
        const arena=new Contract(this.session.chainConfig.arena,arenaAbi,this.signer);
        const [data,roster,token]=await Promise.all([arena.getMatch(funding.matchId),arena.getRoster(funding.matchId),arena.rewardToken()]);
        if(data.mode!==0n||!equal(token,this.session.chainConfig.token)||!equal(data.rulesHash,funding.rulesHash)||!equal(data.termsHash,funding.termsHash)||roster.length!==2||roster.some((a,i)=>!equal(a,funding.roster[i]))||data.joinDeadline!==BigInt(funding.joinDeadline)||data.startDeadline!==BigInt(funding.startDeadline))throw new Error('INVALID_MATCH_TERMS');
        const expected=keccak256(AbiCoder.defaultAbiCoder().encode(termsAbiTypes,[id(TERMS_TAG),10143,this.session.chainConfig.arena,funding.matchId,0,data.rosterHash,token,ENTRY,1000,data.feeRecipient,data.referee,data.rulesHash,data.joinDeadline,data.startDeadline,120,120]));
        if(!equal(expected,data.termsHash))throw new Error('INVALID_MATCH_TERMS');
        return {arena,data,slot:roster.findIndex(a=>equal(a,this.account))};
    }
    async deposit(funding) {
        if(this.pending)return;this.pending='deposit';this.onState();
        try {
            const {arena,data,slot}=await this.terms(funding);
            if(Number(data.depositMask)&(1<<slot)){await this.session.request('CHAIN_SYNC');return;}
            if(data.state!==1n)throw new Error('DEPOSIT_CLOSED');
            const token=new Contract(this.session.chainConfig.token,tokenAbi,this.signer);
            if(await token.balanceOf(this.account)<ENTRY)throw new Error('USDC_BALANCE_LOW');
            if(await token.allowance(this.account,this.session.chainConfig.arena)<ENTRY) {
                this.pending='approve';this.onState();const gas=await token.approve.estimateGas(this.session.chainConfig.arena,ENTRY);
                const tx=await token.approve(this.session.chainConfig.arena,ENTRY,{gasLimit:gas+gas/10n});await this.finality(tx.hash);
            }
            this.pending='deposit';this.onState();
            const gas=await arena.joinMatch.estimateGas(funding.matchId,funding.termsHash);
            const tx=await arena.joinMatch(funding.matchId,funding.termsHash,{gasLimit:gas+gas/10n});await this.finality(tx.hash);
            await this.session.request('CHAIN_SYNC');await this.refreshBalance();
        }catch(error){this.onError(errorCode(error));}
        finally{this.pending=null;this.onState();}
    }
    async claim(funding,expire=false) {
        if(this.pending)return;this.pending=expire?'expire':'claim';this.onState();
        try {
            const {arena}=await this.terms(funding);
            const method=expire?arena.expireMatch:arena.claimFor;
            const args=expire?[funding.matchId]:[funding.matchId,this.account];
            const gas=await method.estimateGas(...args);const tx=await method(...args,{gasLimit:gas+gas/10n});await this.finality(tx.hash);
            await this.session.request('CHAIN_SYNC');await this.recover();await this.refreshBalance();
        }catch(error){this.onError(errorCode(error));}
        finally{this.pending=null;this.onState();}
    }
    async recover(){try{this.recovery=(await this.session.request('CHAIN_RECOVERY')).matches;this.onState();}catch(error){this.onError(errorCode(error));}}
}
window.ShootyWallet={WalletClient};
