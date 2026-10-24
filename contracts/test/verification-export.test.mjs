import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { exportVerification } from '../tools/export-verification.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));

test('verification export reproduces compiled bytecode and keeps deployment unset', async () => {
  const outputDir = mkdtempSync(join(tmpdir(), 'shooty-verification-'));
  try {
    const manifest = await exportVerification({ outputDir });
    assert.equal(manifest.sourceBytecodeReproduced, true);
    assert.equal(manifest.contractAddress, null);
    assert.equal(manifest.broadcast, false);
    assert.equal(manifest.chainId, 10143);
    const input = JSON.parse(readFileSync(join(outputDir, 'standard-input.json'), 'utf8'));
    assert.equal(manifest.sourceCount, Object.keys(input.sources).length);
    assert(input.sources['src/ShootyArena.sol'].content.includes('contract ShootyArena'));
    assert.equal(input.settings.viaIR, true);
    assert.equal(input.settings.optimizer.runs, 200);
    assert.equal(input.settings.compilationTarget, undefined);
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
});

test('verification export rejects source changes after compilation before writing a bundle', async () => {
  const projectRoot = mkdtempSync(join(tmpdir(), 'shooty-stale-verification-'));
  try {
    cpSync(join(root, 'src'), join(projectRoot, 'src'), { recursive: true });
    mkdirSync(join(projectRoot, 'out/ShootyArena.sol'), { recursive: true });
    cpSync(join(root, 'out/ShootyArena.sol/ShootyArena.json'), join(projectRoot, 'out/ShootyArena.sol/ShootyArena.json'));
    symlinkSync(join(root, 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
    const path = join(projectRoot, 'src/ShootyArena.sol');
    writeFileSync(path, readFileSync(path, 'utf8') + '\n// edited after compilation\n');
    await assert.rejects(
      exportVerification({ projectRoot, outputDir: join(projectRoot, 'verification') }),
      /Stale artifact: src\/ShootyArena.sol/,
    );
    assert.throws(() => readFileSync(join(projectRoot, 'verification/manifest.json')));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
