// Produces constructor args + init code for a session signer. Never sends a transaction.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const offline = process.argv.includes('--offline');
const outputIndex = process.argv.indexOf('--output');
if (outputIndex !== -1 && !process.argv[outputIndex + 1]) throw new Error('--output requires a file path');
const outputPath = outputIndex === -1 ? `${root}deployment/prepared.json` : resolve(process.argv[outputIndex + 1]);
const address = (name, fallback) => {
  const value = process.env[name] || fallback;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value || '') || /^0x0{40}$/.test(value)) {
    throw new Error(`${name} must be a nonzero EVM address`);
  }
  return value;
};

try {
  const token = address('REWARD_TOKEN', '0x534b2f3A21130d7a60830c2Df862319e593943A3');
  const args = [token, ...['ARENA_ADMIN', 'ROOM_CREATOR', 'ARENA_PAUSER', 'REFEREE', 'FEE_RECIPIENT'].map(n => address(n))];
  const rpc = process.env.MONAD_TESTNET_RPC_URL || 'https://testnet-rpc.monad.xyz';
  let nextId = 0;
  async function call(method, params) {
    const response = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.json();
    if (body.error || body.result === undefined) throw new Error(body.error?.message || 'Missing RPC result');
    return body.result;
  }

  let checkedAt = null;
  let block = null;
  if (!offline) {
    if (BigInt(await call('eth_chainId', [])) !== 10143n) throw new Error('RPC must point to Monad Testnet 10143');
    // Bind all token reads to the same finalized block; the Foundation endpoint does not accept batches.
    block = await call('eth_getBlockByNumber', ['finalized', false]);
    if (!block?.hash || !block?.number) throw new Error('RPC did not return a finalized block');
    const code = await call('eth_getCode', [token, block.number]);
    if (code === '0x' || !code) throw new Error('Reward token has no code');
    const decimals = await call('eth_call', [{ to: token, data: '0x313ce567' }, block.number]);
    if (BigInt(decimals) !== 6n) throw new Error('Reward token must have six decimals');
    checkedAt = new Date().toISOString();
  }

  const artifact = JSON.parse(readFileSync(`${root}out/ShootyArena.sol/ShootyArena.json`, 'utf8'));
  const constructor = artifact.abi.find(item => item.type === 'constructor');
  if (constructor.inputs.length !== 6 || constructor.inputs.some(input => input.type !== 'address')) {
    throw new Error('Constructor ABI changed; update deployment preparation');
  }
  const constructorArgs = '0x' + args.map(arg => arg.slice(2).toLowerCase().padStart(64, '0')).join('');
  const bytecode = artifact.bytecode.object;
  if (!/^0x[0-9a-f]+$/i.test(bytecode || '')) throw new Error('Missing or unlinked creation bytecode');
  const output = {
    chainId: 10143,
    contract: 'src/ShootyArena.sol:ShootyArena',
    compiler: artifact.metadata.compiler.version,
    evmVersion: artifact.metadata.settings.evmVersion,
    tokenVerification: { status: offline ? 'UNVERIFIED_OFFLINE' : 'RPC_CHECKED', checkedAt, blockHash: block?.hash || null },
    constructor: Object.fromEntries(constructor.inputs.map((input, i) => [input.name, args[i]])),
    constructorArgs,
    initCode: bytecode + constructorArgs.slice(2),
    deployedAddress: null,
    broadcast: false,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n');
  console.log(`Prepared ${outputPath} (${output.tokenVerification.status}); no transaction sent`);
} catch (error) {
  console.error(`Deployment preparation failed: ${error.message}`);
  process.exitCode = 1;
}
