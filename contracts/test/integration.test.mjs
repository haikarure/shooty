import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTypedData, resultTypedData } from '../integration/authorizations.mjs';

const arena = '0x0000000000000000000000000000000000001234';
const matchId = '0x' + '11'.repeat(32);
const termsHash = '0x' + '22'.repeat(32);
const resultsHash = '0x' + '33'.repeat(32);
const message = { matchId, termsHash, validUntil: 1_800_000_240n };
const root = fileURLToPath(new URL('../', import.meta.url));
const exec = promisify(execFile);

test('start and result schemas match the frozen Solidity digests independently', async () => {
  const start = startTypedData(arena, message);
  const result = resultTypedData(arena, 0, { ...message, outcome: 0, winner: 1, resultsHash });
  const cast = async (...args) => (await exec('cast', args)).stdout.trim();
  const hash = async data => {
    const fields = data.types[data.primaryType];
    const type = data.primaryType + '(' + fields.map(x => `${x.type} ${x.name}`).join(',') + ')';
    const domainType = await cast('keccak', 'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
    const nameHash = await cast('keccak', data.domain.name);
    const versionHash = await cast('keccak', data.domain.version);
    const domainHash = await cast('keccak', await cast('abi-encode', 'f(bytes32,bytes32,bytes32,uint256,address)', domainType, nameHash, versionHash, String(data.domain.chainId), data.domain.verifyingContract));
    const typeHash = await cast('keccak', type);
    const structHash = await cast('keccak', await cast('abi-encode', `f(bytes32,${fields.map(x => x.type).join(',')})`, typeHash, ...fields.map(x => String(data.message[x.name]))));
    return cast('keccak', '0x1901' + domainHash.slice(2) + structHash.slice(2));
  };
  // Constants are also checked by Solidity tests, with an independently constructed domain.
  assert.equal(await hash(start), '0x8039e7e74b5dfe3f1147ea365cd814bded3638a31a879722b542d4da64a894d3');
  assert.equal(await hash(result), '0xf67396174f247ef3caabda5560f973fb1d50363e322d1a792d270740966378e5');
});

test('typed data rejects invalid recipients, outcomes and integer timestamps', () => {
  assert.throws(() => startTypedData('0x' + '0'.repeat(40), message));
  assert.throws(() => startTypedData(arena, { ...message, validUntil: Number.MAX_SAFE_INTEGER + 1 }));
  assert.throws(() => startTypedData(arena, { ...message, validUntil: -1 }));
  assert.throws(() => startTypedData(arena, { ...message, validUntil: 2n ** 64n }));
  assert.throws(() => startTypedData(arena, { ...message, termsHash: '0x01' }));
  assert.throws(() => resultTypedData(arena, 1, { ...message, outcome: 0, winner: 2, resultsHash }));
  assert.throws(() => resultTypedData(arena, 0, { ...message, outcome: 1, winner: 1, resultsHash }));
  assert.throws(() => resultTypedData(arena, 0, { ...message, outcome: 2, winner: 0, resultsHash }));
});

test('preparation encodes six constructor addresses without a signer or broadcast', async () => {
  const env = {
    ...process.env,
    ARENA_ADMIN: arena,
    ROOM_CREATOR: arena,
    ARENA_PAUSER: arena,
    REFEREE: arena,
    FEE_RECIPIENT: arena,
  };
  const temp = mkdtempSync(join(tmpdir(), 'shooty-prepare-'));
  const path = join(temp, 'prepared.json');
  try {
    await exec(process.execPath, ['tools/prepare-deployment.mjs', '--offline', '--output', path], { cwd: root, env });
    const prepared = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(prepared.chainId, 10143);
    assert.equal(prepared.broadcast, false);
    assert.equal(prepared.deployedAddress, null);
    assert.equal(prepared.tokenVerification.status, 'UNVERIFIED_OFFLINE');
    assert.equal(prepared.constructorArgs.length, 2 + 6 * 64);
    assert(prepared.initCode.endsWith(prepared.constructorArgs.slice(2)));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
