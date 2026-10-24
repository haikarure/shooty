import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDemoWallets, walletRoles } from '../tools/create-demo-wallets.mjs';

test('wallet provisioning verifies distinct keys, restricts backups, and keeps public config secret-free', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'shooty-wallet-test-'));
  try {
    const result = await createDemoWallets({ workspaceRoot });
    const privateData = JSON.parse(readFileSync(result.backupPath, 'utf8'));
    const publicText = readFileSync(result.publicPath, 'utf8');
    const envText = readFileSync(result.envPath, 'utf8');
    assert.deepEqual(Object.keys(privateData.wallets), walletRoles);
    assert.equal(new Set(Object.values(privateData.wallets).map(wallet => wallet.address)).size, 8);
    for (const wallet of Object.values(privateData.wallets)) {
      assert.equal(publicText.includes(wallet.privateKey), false);
      assert.equal(envText.includes(wallet.privateKey), false);
    }
    assert.equal(statSync(result.backupPath).mode & 0o777, 0o600);
    assert.equal(statSync(join(workspaceRoot, '.secrets')).mode & 0o777, 0o700);
    assert.equal(statSync(join(workspaceRoot, '.secrets/shooty-monad-testnet')).mode & 0o777, 0o700);
    assert.equal(statSync(result.envPath).mode & 0o777, 0o600);
    assert(envText.includes(`ROOM_CREATOR=${privateData.wallets.relayer.address}`));
    assert.equal(result.manifest.broadcast, false);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});

test('wallet provisioning refuses to overwrite an existing wallet set', async () => {
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'shooty-wallet-overwrite-test-'));
  try {
    const result = await createDemoWallets({ workspaceRoot });
    const original = readFileSync(result.backupPath);
    await assert.rejects(createDemoWallets({ workspaceRoot }), /refusing to replace wallets/);
    // Compare a boolean only so a failing assertion never prints the backup's private data.
    assert.equal(readFileSync(result.backupPath).equals(original), true);
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
