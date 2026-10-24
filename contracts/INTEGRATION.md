# Shooty arena integration

The source of truth is `src/ShootyArena.sol` and `abi/ShootyArena.json`. Chain ID is 10143 and token units are six-decimal integers. Login (ERC-4361), room presence, controllers, gameplay, and result validation belong to the server. Allowance alone cannot deposit a player: `joinMatch` debits only `msg.sender`.

## Lifecycle

1. Authenticate wallets, seal an ordered roster, display rules, and generate a unique `bytes32 matchId` and `rulesHash`.
2. The creator relayer calls `createMatch({matchId, mode, roster, rulesHash, joinDeadline, startDeadline})`. Read and compare stored terms with the room before requesting entry.
3. Each player approves exactly ENTRY when needed, then submits `joinMatch(matchId, expectedTermsHash)`. `PlayerDeposited` records entry; `MatchFunded` means all roster slots paid. Finalize these receipts before start.
4. Confirm clients returned from mobile wallets and controllers are ready. The stored referee signs `StartAuthorization`; anyone submits `startMatch`. Begin countdown after its receipt reaches required finality.
5. Validate gameplay on the server. The referee signs `ResultAuthorization`; anyone submits `resolveMatch`. `MatchResolved` and `PaymentCredited` record the result/credits; no token is sent by resolution.
6. Submit separate `claimFor(matchId, beneficiary)` transactions for winners/treasury or refunds. A blocked recipient does not prevent other payments. Reconcile remaining credits and retry failures.

Before expiry, a disconnected/losing player cannot cancel unilaterally. After a phase deadline, anyone calls `expireMatch` to create full depositor refund credits without fee.

## Typed messages

Domain:

```js
{ name: 'ShootyArena', version: '1', chainId: 10143, verifyingContract: arenaAddress }
```

Exact EIP-712 type strings:

```text
StartAuthorization(bytes32 matchId,bytes32 termsHash,uint64 validUntil)
ResultAuthorization(bytes32 matchId,bytes32 termsHash,uint8 outcome,uint8 winner,bytes32 resultsHash,uint64 validUntil)
```

WIN = 0; DRAW = 1. Team Duel winner is 0/1 for Alpha/Bravo, while Duel/Rumble use a roster slot. Draw requires winner 0. `validUntil` is seconds, inclusive, bounded also by the phase deadline. `resultsHash` commits to server logs; validation and retention of those logs remain offchain.

Example with a signer supporting `signTypedData`:

```js
import { startTypedData, resultTypedData } from './integration/authorizations.mjs';

const start = startTypedData(arenaAddress, {
  matchId,
  termsHash: onchainMatch.termsHash,
  validUntil: BigInt(onchainMatch.startDeadline),
});
const startSignature = await refereeSigner.signTypedData(start);

const result = resultTypedData(arenaAddress, Number(onchainMatch.mode), {
  matchId,
  termsHash: onchainMatch.termsHash,
  outcome: 0,
  winner: 1,
  resultsHash,
  validUntil: BigInt(onchainMatch.resultDeadline),
});
const resultSignature = await refereeSigner.signTypedData(result);
```

Pass `start.message`/`result.message` and signature to the arena. Referee keys stay on the server or authorized signing service. `hashStartAuthorization` / `hashResultAuthorization` expose the contract digest for debugging. Node and Solidity tests check the same independent digest vectors.

## Terms commitment

Use standard ABI encoding with roster order preserved, never packed encoding:

```text
rosterHash = keccak256(abi.encode(address[] roster))
TERMS_VERSION = keccak256(bytes("SHOOTY_TERMS_V1"))

termsHash = keccak256(abi.encode(
  bytes32 TERMS_VERSION,
  uint256 chainId,
  address arena,
  bytes32 matchId,
  uint8 mode,
  bytes32 rosterHash,
  address rewardToken,
  uint256 ENTRY,                    // 1_000_000
  uint256 FEE_BPS,                  // 1_000
  address feeRecipient,
  address referee,
  bytes32 rulesHash,
  uint64 joinDeadline,
  uint64 startDeadline,
  uint64 MAX_PLAY_SECONDS,          // 120
  uint64 RESULT_GRACE_SECONDS       // 120
))
```

`termsAbiTypes` exports that ordered type list. Read authoritative values from `getMatch` and `getRoster`. Officials are snapshotted at creation; global default rotation does not change existing rooms.

## Reconciliation and UI

| State | Value | Meaning |
| --- | --- | --- |
| NONE | 0 | No record; getMatch rejects unknown IDs |
| OPEN | 1 | Roster sealed; some/no deposits |
| FUNDED | 2 | All deposits; awaiting start |
| LIVE | 3 | Start accepted; awaiting result |
| RESOLVED | 4 | Result accepted; credits may remain unpaid |
| CANCELED | 5 | Timeout accepted; refunds may remain unpaid |

`depositMask` retains the slots that paid. `locked` becomes zero upon allocation. `creditOf` is the remaining payment. `totalDeposited(matchId)` and `totalPaid(matchId)` aid reconciliation. `PaymentCredited.amount` is incremental; a winning treasury address can receive two credit events and one combined payment.

`MatchCreated` indexes both match ID and mode: `topics[1]` is match ID, `topics[2]` is mode, and log data is `(termsHash, rosterHash)`. Use the current implementation ABI; the original blueprint's non-indexed-mode event layout is historical. Player deposit events index player, while credit/payment events index beneficiary.

Distinguish **hasil diverifikasi**, **payout diproses**, and **hadiah terkirim**. For refunds distinguish **pengembalian tersedia** and **refund terkirim**. Confirm payment only after a successful finalized receipt and the expected `PaymentSent(matchId, beneficiary, amount)` emitted by this arena with matching token movement. A terminal state/result signature alone is not payment confirmation.

Persist relayer jobs by `(chainId, arena, matchId, action, beneficiary)`. An RPC timeout does not prove failure. Read the receipt/state before retrying. `claimFor` is safe to retry: zero credit is a no-op, receiver is fixed, and failed transfers restore credit. Another relayer or player can submit claims/expiry if the first relayer stops.

Monad executes asynchronously. Wait for funding and allowances to be visible before dependent writes. Estimate the exact transaction immediately before sending and keep gas-limit buffers small: Monad charges against the submitted limit. Do not replace a reverted simulation with a huge limit. Forge gas figures are not Monad gas measurements. References: [gas rules](https://docs.monad.xyz/developer-essentials/gas-pricing), [block states](https://docs.monad.xyz/monad-arch/consensus/block-states), [async execution](https://docs.monad.xyz/monad-arch/consensus/asynchronous-execution).
