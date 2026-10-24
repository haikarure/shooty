// JSON EIP-712 schemas; amount/time values are integer units, never floating point.
export const CHAIN_ID = 10143;
export const ENTRY = 1_000_000n;
export const FEE_BPS = 1_000n;
export const TERMS_TAG = 'SHOOTY_TERMS_V1';

export const startTypes = {
  StartAuthorization: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint64' },
  ],
};

export const resultTypes = {
  ResultAuthorization: [
    { name: 'matchId', type: 'bytes32' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'outcome', type: 'uint8' },
    { name: 'winner', type: 'uint8' },
    { name: 'resultsHash', type: 'bytes32' },
    { name: 'validUntil', type: 'uint64' },
  ],
};

export function domain(arena) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(arena) || /^0x0{40}$/.test(arena)) {
    throw new TypeError('Expected a deployed arena address');
  }
  return { name: 'ShootyArena', version: '1', chainId: CHAIN_ID, verifyingContract: arena };
}

function bytes32(value, name) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new TypeError(`${name} must be bytes32`);
  return value;
}

function uint64(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new TypeError('Unsafe timestamp');
  if (!['bigint', 'number', 'string'].includes(typeof value)) throw new TypeError('Invalid timestamp');
  const result = BigInt(value);
  if (result < 0n || result > 0xffffffffffffffffn) throw new RangeError('Timestamp outside uint64');
  return result;
}

export function startTypedData(arena, { matchId, termsHash, validUntil }) {
  return {
    domain: domain(arena),
    types: startTypes,
    primaryType: 'StartAuthorization',
    message: {
      matchId: bytes32(matchId, 'matchId'),
      termsHash: bytes32(termsHash, 'termsHash'),
      validUntil: uint64(validUntil),
    },
  };
}

// Mode is supplied by the backend from getMatch, not accepted from a player payload.
export function resultTypedData(arena, mode, { matchId, termsHash, outcome, winner, resultsHash, validUntil }) {
  if (![0, 1, 2].includes(mode)) throw new RangeError('Invalid mode');
  if (![0, 1].includes(outcome)) throw new RangeError('Invalid outcome');
  const maxWinner = [2, 2, 4][mode];
  if (!Number.isInteger(winner) || winner < 0 || winner >= maxWinner || (outcome === 1 && winner !== 0)) {
    throw new RangeError('Invalid winner');
  }
  const start = startTypedData(arena, { matchId, termsHash, validUntil });
  return {
    domain: start.domain,
    types: resultTypes,
    primaryType: 'ResultAuthorization',
    message: { ...start.message, outcome, winner, resultsHash: bytes32(resultsHash, 'resultsHash') },
  };
}

// viem encodeAbiParameters / Solidity abi.encode types for the frozen terms commitment.
// First value is keccak256(toBytes(TERMS_TAG)); rosterHash is keccak256(abi.encode(address[])).
export const termsAbiTypes = [
  'bytes32', 'uint256', 'address', 'bytes32', 'uint8', 'bytes32', 'address', 'uint256',
  'uint256', 'address', 'address', 'bytes32', 'uint64', 'uint64', 'uint64', 'uint64',
];
