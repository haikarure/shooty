import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Transaction, Wallet } from 'ethers';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FACTORY, deployTestnet, makePlan, preflight } from '../tools/deploy-testnet.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = JSON.parse(readFileSync(join(root, 'out/ShootyArena.sol/ShootyArena.json'), 'utf8'));
// Public, well-known fixture key 1; never use it for a provisioned or funded wallet.
const fixture = new Wallet('0x' + '0'.repeat(63) + '1');
const env = Object.fromEntries(['DEPLOYER_ADDRESS', 'REWARD_TOKEN', 'ARENA_ADMIN', 'ROOM_CREATOR', 'ARENA_PAUSER', 'REFEREE', 'FEE_RECIPIENT']
  .map(name => [name, fixture.address]));
const factory = new Interface([
  'function computeCreate2Address(bytes32,bytes32) view returns(address)',
  'function deployCreate2(bytes32,bytes) payable returns(address)',
]);

function mockedRpc(plan, { chain = '0x279f', balance = '0xde0b6b3a7640000', simulationFails = false } = {}) {
  const calls = [];
  const rpc = async (method, params = []) => {
    calls.push(method);
    if (method === 'eth_chainId') return chain;
    if (method === 'eth_getBlockByNumber') return { number: '0x100', hash: '0x' + 'ab'.repeat(32), baseFeePerGas: '0x174876e800' };
    if (method === 'eth_getBalance') return balance;
    if (method === 'eth_getCode') return params[0] === plan.predictedAddress ? '0x' : '0x6000';
    if (method === 'eth_gasPrice') return '0x174876e800';
    if (method === 'eth_maxPriorityFeePerGas') return '0x0';
    if (method === 'eth_getTransactionCount') return '0x0';
    if (method === 'eth_estimateGas') return '0x2dc6c0';
    if (method === 'eth_call') {
      const call = params[0];
      if (call.data === '0x313ce567') return '0x' + '6'.padStart(64, '0');
      const parsed = factory.parseTransaction(call);
      if (parsed.name === 'deployCreate2' && simulationFails) throw new Error('execution reverted');
      return factory.encodeFunctionResult(parsed.name, [plan.predictedAddress]);
    }
    throw new Error(`Unexpected RPC method: ${method}`);
  };
  return { rpc, calls };
}

test('deployment preflight checks chain, simulates CreateX, and adds a ten percent gas buffer', async () => {
  const plan = makePlan(env, artifact);
  const { rpc, calls } = mockedRpc(plan);
  const quote = await preflight(plan, rpc);
  assert.equal(plan.factory, FACTORY);
  assert.equal(plan.salt.slice(0, 42), fixture.address);
  assert.equal(plan.salt.slice(42, 44), '01');
  assert.equal(quote.estimate, 3_000_000n);
  assert.equal(quote.gasLimit, 3_300_000n);
  assert(quote.balance >= quote.gasLimit * quote.maxFeePerGas);
  assert.equal(calls.includes('eth_sendRawTransaction'), false);
});

test('wrong-chain RPC is rejected before balance reads, simulation, or signing', async () => {
  const plan = makePlan(env, artifact);
  const { rpc, calls } = mockedRpc(plan, { chain: '0x8f' });
  await assert.rejects(preflight(plan, rpc), /Wrong chain/);
  assert.deepEqual(calls, ['eth_chainId']);
});

test('failed simulation is never replaced with an inflated gas limit', async () => {
  const plan = makePlan(env, artifact);
  const { rpc, calls } = mockedRpc(plan, { simulationFails: true });
  await assert.rejects(preflight(plan, rpc), /execution reverted/);
  assert.equal(calls.includes('eth_estimateGas'), false);
  assert.equal(calls.includes('eth_sendRawTransaction'), false);
});

test('insufficient finalized balance aborts deployment preflight', async () => {
  const plan = makePlan(env, artifact);
  const { rpc, calls } = mockedRpc(plan, { balance: '0x1' });
  await assert.rejects(preflight(plan, rpc), /balance is below/);
  assert.equal(calls.includes('eth_sendRawTransaction'), false);
});

test('broadcast mode still aborts on an unreachable RPC before loading any private key', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'shooty-deploy-unavailable-'));
  const projectRoot = join(temp, 'contracts');
  try {
    mkdirSync(join(projectRoot, 'out/ShootyArena.sol'), { recursive: true });
    writeFileSync(join(projectRoot, 'out/ShootyArena.sol/ShootyArena.json'), JSON.stringify(artifact));
    await assert.rejects(deployTestnet({
      projectRoot, env, broadcast: true,
      rpc: async () => { throw new Error('RPC unavailable'); },
      verifySources: async () => { throw new Error('Should not reach compilation or signer'); },
    }), /RPC unavailable/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('a timeout after submission resumes the same signed transaction and preserves finalized deployment', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'shooty-deploy-resume-'));
  const projectRoot = join(temp, 'contracts');
  const secretDir = join(temp, '.secrets/shooty-monad-testnet');
  const plan = makePlan(env, artifact);
  const basic = mockedRpc(plan).rpc;
  const deployedAbi = new Interface([
    'function rewardToken() view returns(address)', 'function defaultReferee() view returns(address)',
    'function defaultFeeRecipient() view returns(address)', 'function hasRole(bytes32,address) view returns(bool)',
  ]);
  let sends = 0;
  let transactionHash;
  let verificationRequests = 0;
  const rpc = async (method, params = []) => {
    if (method === 'eth_getTransactionReceipt') return sends ? {
      transactionHash, status: '0x1', blockNumber: '0x100', blockHash: '0x' + 'ab'.repeat(32),
    } : null;
    if (method === 'eth_getTransactionByHash') return null;
    if (method === 'eth_sendRawTransaction') {
      ++sends;
      const signed = Transaction.from(params[0]);
      assert.equal(signed.from, fixture.address);
      assert.equal(signed.to, FACTORY);
      assert.equal(signed.chainId, 10143n);
      assert.equal(signed.value, 0n);
      assert.equal(signed.gasLimit, 3_300_000n);
      assert.equal(signed.data, plan.data);
      transactionHash = signed.hash;
      throw new Error('RPC timeout after accepting transaction');
    }
    if (method === 'eth_getCode' && params[0] === plan.predictedAddress) return sends ? '0x6000' : '0x';
    if (method === 'eth_call' && params[0].to === plan.predictedAddress) {
      const parsed = deployedAbi.parseTransaction(params[0]);
      return deployedAbi.encodeFunctionResult(parsed.name, [parsed.name === 'hasRole' ? true : fixture.address]);
    }
    return basic(method, params);
  };
  const verifySources = async ({ outputDir }) => {
    mkdirSync(outputDir, { recursive: true });
    // The source exporter is exercised separately against the real compiler.
    writeFileSync(join(outputDir, 'standard-input.json'), JSON.stringify({ language: 'Solidity', sources: {}, settings: {} }));
  };
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://agents.devnads.com/v1/verify');
    const body = JSON.parse(options.body);
    assert.equal(body.contractAddress, plan.predictedAddress);
    assert.equal(body.constructorArgs, plan.constructorArgs.slice(2));
    ++verificationRequests;
    return { ok: true, status: 200, text: async () => '{"status":"submitted"}' };
  };
  try {
    mkdirSync(join(projectRoot, 'out/ShootyArena.sol'), { recursive: true });
    writeFileSync(join(projectRoot, 'out/ShootyArena.sol/ShootyArena.json'), JSON.stringify(artifact));
    mkdirSync(secretDir, { recursive: true, mode: 0o700 });
    const keyPath = join(secretDir, 'wallets.json');
    writeFileSync(keyPath, JSON.stringify({ wallets: { deployer: { privateKey: fixture.privateKey } } }), { mode: 0o600 });
    const args = { projectRoot, env, broadcast: true, rpc, verifySources, fetchImpl };
    await assert.rejects(deployTestnet(args), /timeout after accepting/);
    assert.equal(statSync(join(secretDir, 'deployment-tx.json')).mode & 0o777, 0o600);
    // Completion must use the saved transaction even if the original signing backup is absent.
    rmSync(keyPath);
    const result = await deployTestnet(args);
    assert.equal(result.status, 'FINALIZED');
    assert.equal(result.transactionHash, transactionHash);
    assert.equal(result.contractAddress, plan.predictedAddress);
    assert.equal(result.verifiedRolesAndToken, true);
    assert.equal(result.explorerVerification.submitted, true);
    assert.equal(sends, 1);
    assert.equal(verificationRequests, 1);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
