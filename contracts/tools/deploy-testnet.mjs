// Local signer workflow requested by the owner. Keys never enter CLI arguments or public artifacts.
import { AbiCoder, Interface, Transaction, Wallet, getAddress, getCreate2Address, id, keccak256 } from 'ethers';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportVerification } from './export-verification.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
export const FACTORY = '0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed';
const CHAIN_ID = 10143n;
const abi = AbiCoder.defaultAbiCoder();
const factory = new Interface([
  'function deployCreate2(bytes32 salt,bytes initCode) payable returns(address)',
  'function computeCreate2Address(bytes32 salt,bytes32 initCodeHash) view returns(address)',
]);
const arena = new Interface([
  'function rewardToken() view returns(address)',
  'function defaultReferee() view returns(address)',
  'function defaultFeeRecipient() view returns(address)',
  'function hasRole(bytes32,address) view returns(bool)',
]);
const json = value => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
function save(path, value, exclusive = false, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, json(value), { flag: exclusive ? 'wx' : 'w', mode });
}

export function makePlan(env, artifact) {
  const addresses = ['REWARD_TOKEN', 'ARENA_ADMIN', 'ROOM_CREATOR', 'ARENA_PAUSER', 'REFEREE', 'FEE_RECIPIENT']
    .map(name => {
      const address = getAddress(env[name] || '');
      if (/^0x0{40}$/i.test(address)) throw new Error(`Missing nonzero ${name}`);
      return address;
    });
  const deployer = getAddress(env.DEPLOYER_ADDRESS || '');
  if (/^0x0{40}$/i.test(deployer)) throw new Error('Missing nonzero DEPLOYER_ADDRESS');
  const constructorArgs = abi.encode(Array(6).fill('address'), addresses);
  const initCode = artifact.bytecode.object + constructorArgs.slice(2);
  if (!/^0x[0-9a-f]+$/i.test(initCode)) throw new Error('Missing or unlinked creation bytecode');
  // CreateX permissioned + chain-bound salt: 20-byte deployer, flag 01, 11-byte version suffix.
  const salt = deployer + '01' + id('ShootyArena-v1').slice(2, 24);
  const guardedSalt = keccak256(abi.encode(['address', 'uint256', 'bytes32'], [deployer, CHAIN_ID, salt]));
  const initCodeHash = keccak256(initCode);
  return {
    chainId: Number(CHAIN_ID), deployer, factory: FACTORY, salt, guardedSalt, initCodeHash,
    predictedAddress: getCreate2Address(FACTORY, guardedSalt, initCodeHash),
    constructorArgs, initCode, addresses,
    data: factory.encodeFunctionData('deployCreate2', [salt, initCode]),
  };
}

export function makeRpc(url, fetchImpl = fetch) {
  let nextId = 0;
  return async (method, params = []) => {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }), signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      throw new Error(`RPC unavailable (${error.cause?.code || error.name}); no assumption about transaction outcome`);
    }
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message || 'missing RPC result'}`);
    return body.result;
  };
}

export async function preflight(plan, rpc, { resuming = false } = {}) {
  if (BigInt(await rpc('eth_chainId')) !== CHAIN_ID) throw new Error('Wrong chain; only Monad Testnet 10143 is allowed');
  const block = await rpc('eth_getBlockByNumber', ['finalized', false]);
  if (!block?.number || !block.hash) throw new Error('Finalized block unavailable');
  const balance = BigInt(await rpc('eth_getBalance', [plan.deployer, block.number]));
  for (const address of [plan.addresses[0], FACTORY]) {
    if (await rpc('eth_getCode', [address, block.number]) === '0x') throw new Error('Reward token or canonical CreateX has no code');
  }
  const decimals = await rpc('eth_call', [{ to: plan.addresses[0], data: '0x313ce567' }, block.number]);
  if (BigInt(decimals) !== 6n) throw new Error('Reward token must have six decimals');
  const prediction = await rpc('eth_call', [{
    to: FACTORY, data: factory.encodeFunctionData('computeCreate2Address', [plan.guardedSalt, plan.initCodeHash]),
  }, block.number]);
  if (factory.decodeFunctionResult('computeCreate2Address', prediction)[0] !== plan.predictedAddress) {
    throw new Error('CreateX address prediction mismatch');
  }
  const existing = await rpc('eth_getCode', [plan.predictedAddress, 'latest']);
  if (existing !== '0x') return { block, balance, existing: true };
  if (resuming) return { block, balance, existing: false };
  const call = { from: plan.deployer, to: FACTORY, data: plan.data, value: '0x0' };
  const simulated = await rpc('eth_call', [call, 'latest']);
  if (factory.decodeFunctionResult('deployCreate2', simulated)[0] !== plan.predictedAddress) {
    throw new Error('Deployment simulation returned an unexpected address');
  }
  const estimate = BigInt(await rpc('eth_estimateGas', [call]));
  const gasLimit = estimate + estimate / 10n;
  if (estimate <= 0n || gasLimit > 30_000_000n) throw new Error('Invalid deployment gas estimate');
  const gasPrice = BigInt(await rpc('eth_gasPrice'));
  let tip = 0n;
  try { tip = BigInt(await rpc('eth_maxPriorityFeePerGas')); } catch {}
  const current = await rpc('eth_getBlockByNumber', ['latest', false]);
  const cap = BigInt(current.baseFeePerGas || '0x0') * 2n + tip;
  const maxFeePerGas = cap > gasPrice ? cap : gasPrice;
  if (maxFeePerGas <= 0n || tip < 0n) throw new Error('Invalid fee quote');
  if (balance < gasLimit * maxFeePerGas) throw new Error('Finalized deployer balance is below estimated maximum deployment cost');
  const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [plan.deployer, 'pending'])));
  if (!Number.isSafeInteger(nonce)) throw new Error('Invalid deployer nonce');
  return { block, balance, existing: false, estimate, gasLimit, maxFeePerGas, maxPriorityFeePerGas: tip, nonce };
}

async function validateArena(plan, rpc, blockTag = 'finalized') {
  if (await rpc('eth_getCode', [plan.predictedAddress, blockTag]) === '0x') throw new Error('Arena code not available');
  for (const [method, expected] of [
    ['rewardToken', plan.addresses[0]], ['defaultReferee', plan.addresses[4]], ['defaultFeeRecipient', plan.addresses[5]],
  ]) {
    const result = await rpc('eth_call', [{ to: plan.predictedAddress, data: arena.encodeFunctionData(method) }, blockTag]);
    if (arena.decodeFunctionResult(method, result)[0] !== expected) throw new Error(`Post-deployment ${method} mismatch`);
  }
  for (const [role, address] of [
    ['0x' + '00'.repeat(32), plan.addresses[1]], [id('ROOM_CREATOR_ROLE'), plan.addresses[2]], [id('PAUSER_ROLE'), plan.addresses[3]],
  ]) {
    const result = await rpc('eth_call', [{ to: plan.predictedAddress, data: arena.encodeFunctionData('hasRole', [role, address]) }, blockTag]);
    if (!arena.decodeFunctionResult('hasRole', result)[0]) throw new Error('Post-deployment role mismatch');
  }
}

export async function deployTestnet({
  projectRoot = root, env = process.env, broadcast = false,
  rpc = makeRpc(env.MONAD_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz'),
  verifySources = exportVerification, fetchImpl = fetch,
} = {}) {
  const artifact = readJson(resolve(projectRoot, 'out/ShootyArena.sol/ShootyArena.json'));
  const plan = makePlan(env, artifact);
  const journalPath = resolve(projectRoot, '../.secrets/shooty-monad-testnet/deployment-tx.json');
  let journal = existsSync(journalPath) ? readJson(journalPath) : null;
  if (journal) {
    const tx = Transaction.from(journal.signedTransaction);
    if (tx.hash !== journal.transactionHash || tx.from !== plan.deployer || tx.chainId !== CHAIN_ID
      || tx.to !== FACTORY || tx.data !== plan.data || tx.value !== 0n) throw new Error('Existing deployment journal does not match this deployment');
  }
  const quote = await preflight(plan, rpc, { resuming: Boolean(journal) });
  const summary = { chainId: plan.chainId, deployer: plan.deployer, factory: FACTORY, predictedAddress: plan.predictedAddress,
    initCodeHash: plan.initCodeHash, salt: plan.salt, balanceWei: quote.balance, gas: quote, broadcast: false };
  save(resolve(projectRoot, 'deployment/plan.json'), summary);
  if (!broadcast) return summary;
  const verificationDir = resolve(projectRoot, 'deployment/verification');
  await verifySources({ projectRoot, outputDir: verificationDir });
  if (!quote.existing && !journal) {
    let signer;
    try {
      const backup = readJson(resolve(projectRoot, env.SHOOTY_WALLET_BACKUP || '../.secrets/shooty-monad-testnet/wallets.json'));
      signer = new Wallet(backup.wallets.deployer.privateKey);
    } catch { throw new Error('Cannot load the local deployer backup; secret details suppressed'); }
    if (signer.address !== plan.deployer) throw new Error('Deployer signer/address mismatch');
    const signedTransaction = await signer.signTransaction({
      type: 2, chainId: CHAIN_ID, to: FACTORY, data: plan.data, value: 0n,
      nonce: quote.nonce, gasLimit: quote.gasLimit, maxFeePerGas: quote.maxFeePerGas, maxPriorityFeePerGas: quote.maxPriorityFeePerGas,
    });
    journal = { transactionHash: keccak256(signedTransaction), signedTransaction, predictedAddress: plan.predictedAddress };
    save(journalPath, journal, true);
  }
  let receipt = journal ? await rpc('eth_getTransactionReceipt', [journal.transactionHash]) : null;
  if (journal && !receipt && !(await rpc('eth_getTransactionByHash', [journal.transactionHash]))) {
    const hash = await rpc('eth_sendRawTransaction', [journal.signedTransaction]);
    if (hash !== journal.transactionHash) throw new Error('RPC returned an unexpected transaction hash');
  }
  const deadline = Date.now() + 120_000;
  while (journal) {
    receipt = await rpc('eth_getTransactionReceipt', [journal.transactionHash]);
    if (receipt && BigInt(receipt.status) !== 1n) throw new Error(`Deployment reverted: ${journal.transactionHash}`);
    const finalized = await rpc('eth_getBlockByNumber', ['finalized', false]);
    if (receipt && BigInt(finalized.number) >= BigInt(receipt.blockNumber)) {
      const canonical = await rpc('eth_getBlockByNumber', [receipt.blockNumber, false]);
      if (canonical.hash !== receipt.blockHash) throw new Error('Deployment receipt is not canonical');
      break;
    }
    if (Date.now() >= deadline) throw new Error(`Deployment pending: ${journal.transactionHash}; rerun to reconcile the same transaction`);
    await new Promise(done => setTimeout(done, 2000));
  }
  await validateArena(plan, rpc);
  const result = { chainId: plan.chainId, contractAddress: plan.predictedAddress, transactionHash: journal?.transactionHash || null,
    receipt, status: 'FINALIZED', broadcast: Boolean(journal), verifiedRolesAndToken: true, explorerVerification: { submitted: false } };
  const resultPath = resolve(projectRoot, 'deployment/testnet.json');
  save(resultPath, result);
  const payload = { chainId: plan.chainId, contractAddress: plan.predictedAddress, contractName: 'src/ShootyArena.sol:ShootyArena',
    compilerVersion: 'v' + artifact.metadata.compiler.version, constructorArgs: plan.constructorArgs.slice(2),
    standardJsonInput: readJson(resolve(verificationDir, 'standard-input.json')), foundryMetadata: artifact.metadata };
  try {
    const response = await fetchImpl('https://agents.devnads.com/v1/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
    });
    result.explorerVerification = { submitted: response.ok, httpStatus: response.status, response: await response.text() };
  } catch { result.explorerVerification = { submitted: false, error: 'Verifier unavailable; deployment receipt is preserved' }; }
  save(resultPath, result);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await deployTestnet({ broadcast: process.argv.includes('--broadcast') });
    console.log(json(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
