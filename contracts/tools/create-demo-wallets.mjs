// Generates local EVM wallets at the owner's request; secrets go only into an ignored backup.
import { execFile } from 'node:child_process';
import { createECDH } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../../', import.meta.url));
export const walletRoles = ['deployer', 'admin', 'relayer', 'pauser', 'referee', 'treasury', 'player_one', 'player_two'];

function cast(args, input = '') {
  return new Promise((done, fail) => {
    const child = execFile('cast', args, { maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      // Child output can contain generated private keys. Never include it in errors/logs.
      if (error) fail(new Error('Local wallet tool failed; sensitive output was suppressed'));
      else done(stdout);
    });
    child.stdin.on('error', error => {
      if (error.code !== 'EPIPE') fail(new Error('Local wallet tool input failed'));
    });
    child.stdin.end(input);
  });
}

function privateDirectory(path) {
  if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
    throw new Error('Secret directory must be a real local directory');
  }
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function exclusiveWrite(path, content, mode) {
  const descriptor = openSync(path, 'wx', mode);
  try {
    writeFileSync(descriptor, content, 'utf8');
  } finally {
    closeSync(descriptor);
  }
  chmodSync(path, mode);
}

export async function createDemoWallets({ workspaceRoot = project } = {}) {
  const secrets = resolve(workspaceRoot, '.secrets');
  const secretDir = resolve(secrets, 'shooty-monad-testnet');
  const backupPath = resolve(secretDir, 'wallets.json');
  const publicPath = resolve(workspaceRoot, 'contracts/deployment/wallets.public.json');
  const envPath = resolve(workspaceRoot, 'contracts/.env');
  if ([backupPath, publicPath, envPath].some(path => existsSync(path))) {
    throw new Error('Wallet backup or configuration already exists; refusing to replace wallets');
  }

  let generated;
  try {
    generated = JSON.parse(await cast(['wallet', 'new', '--json', '--number', String(walletRoles.length)]));
    if (!Array.isArray(generated)) {
      if (generated.success !== true) throw new Error('Wallet command reported failure');
      generated = generated.data;
    }
  } catch {
    throw new Error('Wallet generation failed; sensitive output was suppressed');
  }
  if (!Array.isArray(generated) || generated.length !== walletRoles.length) {
    throw new Error('Unexpected wallet tool response; no files written');
  }
  const wallets = {};
  for (let i = 0; i < walletRoles.length; ++i) {
    const address = generated[i].address;
    const privateKey = generated[i].private_key ?? generated[i].privateKey;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address || '') || !/^0x[0-9a-fA-F]{64}$/.test(privateKey || '')) {
      throw new Error('Unexpected wallet key format; no files written');
    }
    // Independent public-address check with Node/OpenSSL secp256k1 and Keccak of the public key.
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(privateKey.slice(2), 'hex'));
    const publicKey = ecdh.getPublicKey(undefined, 'uncompressed').subarray(1);
    const digest = (await cast(['keccak'], '0x' + publicKey.toString('hex'))).trim();
    if ('0x' + digest.slice(-40) !== address.toLowerCase()) {
      throw new Error('Generated key/address verification failed; no files written');
    }
    wallets[walletRoles[i]] = { address, privateKey };
  }
  if (new Set(Object.values(wallets).map(wallet => wallet.address.toLowerCase())).size !== walletRoles.length) {
    throw new Error('Duplicate generated wallet; no files written');
  }

  const createdAt = new Date().toISOString();
  const backup = { formatVersion: 1, intendedNetwork: 'Monad Testnet', chainId: 10143, createdAt, wallets };
  const manifest = {
    formatVersion: 1,
    network: 'Monad Testnet',
    chainId: 10143,
    createdAt,
    fundingStatus: 'not_checked',
    broadcast: false,
    wallets: Object.fromEntries(Object.entries(wallets).map(([role, wallet]) => [role, { address: wallet.address }])),
  };
  privateDirectory(secrets);
  privateDirectory(secretDir);
  mkdirSync(dirname(publicPath), { recursive: true });
  exclusiveWrite(backupPath, JSON.stringify(backup, null, 2) + '\n', 0o600);
  exclusiveWrite(publicPath, JSON.stringify(manifest, null, 2) + '\n', 0o644);
  const env = [
    'MONAD_TESTNET_RPC_URL=https://testnet-rpc.monad.xyz',
    'REWARD_TOKEN=0x534b2f3A21130d7a60830c2Df862319e593943A3',
    `ARENA_ADMIN=${wallets.admin.address}`,
    `ROOM_CREATOR=${wallets.relayer.address}`,
    `ARENA_PAUSER=${wallets.pauser.address}`,
    `REFEREE=${wallets.referee.address}`,
    `FEE_RECIPIENT=${wallets.treasury.address}`,
    `DEPLOYER_ADDRESS=${wallets.deployer.address}`,
    `PLAYER_ONE_ADDRESS=${wallets.player_one.address}`,
    `PLAYER_TWO_ADDRESS=${wallets.player_two.address}`,
    'SHOOTY_WALLET_BACKUP=../.secrets/shooty-monad-testnet/wallets.json',
    '',
  ].join('\n');
  exclusiveWrite(envPath, env, 0o600);
  return { backupPath, publicPath, envPath, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await createDemoWallets();
    console.log(`Created ${walletRoles.length} wallets; all key/address pairs verified`);
    console.log(`Private backup (0600): ${result.backupPath}`);
    console.log(`Public manifest: ${result.publicPath}`);
    console.log(`Role configuration: ${result.envPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
