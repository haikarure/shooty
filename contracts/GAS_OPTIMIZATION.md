# Measured gas optimizations

The accepted changes reduce repeated storage reads and the overflow checks on bounded `uint8` loop counters. Financial arithmetic remains checked. Roster validation, six-decimal exact-transfer checks, signatures, roles, pause behavior, and liability accounting remain intact. No assembly or storage-layout changes were added.

## Changes

- `joinMatch` caches the immutable roster length, updated deposit mask, and locked pool. The participant search receives that length, and the final funded check reuses these values after the guarded token transfer.
- Participant/refund loops increment only their counters in `unchecked` blocks. Validated rosters have at most six members. Refunds cache the deposit mask and roster length outside the loop.
- `MatchCreated.mode` is indexed so event consumers can filter Duel, Team Duel, or Rumble. Match IDs, player addresses, and beneficiary addresses were already indexed.

The `uint256` loops in roster validation and winner allocation retain their readable increment syntax. Solidity has optimized eligible loop increments automatically since [0.8.22](https://www.soliditylang.org/blog/2023/10/25/solidity-0.8.22-release-announcement/). Manual unchecked blocks do not provide a universal fixed saving.

## Results

These are isolated arena-call execution measurements using local Cancun EVM costs, Solidity 0.8.37, via IR, optimization with 200 runs, and Foundry 1.8.1. The same local test token and inputs are used before/after. Each top-level call is a separate transaction context (`--isolate`), avoiding warm storage from preceding test setup. Snapshots exclude intrinsic transaction gas, signing, and test setup; they are not live Monad fees or gas limits.

| Operation | Before | After | Saved |
| --- | ---: | ---: | ---: |
| First deposit, any mode | 157,004 | 156,813 | 191 |
| Final Duel deposit | 95,630 | 95,287 | 343 |
| Final Rumble deposit | 100,580 | 100,133 | 447 |
| Final Team deposit | 105,530 | 104,979 | 551 |
| Team draw allocation | 213,221 | 211,871 | 1,350 |
| Team expiry, five deposits | 172,045 | 170,675 | 1,370 |
| Create Duel | 262,728 | 262,780 | -52 |
| Create Team | 366,367 | 366,418 | -51 |

The create increase pays for mode filtering. Start, winning resolution, and individual claim execution costs are unchanged. The total winning lifecycle includes create, all participant joins, start, resolution, and each winner/treasury claim:

| Lifecycle | Before | After | Saved |
| --- | ---: | ---: | ---: |
| Duel | 827,849 | 827,367 | 482 |
| Team Duel | 1,502,963 | 1,500,988 | 1,975 |
| Rumble | 1,067,914 | 1,066,790 | 1,124 |

`benchmarks/gas-variants.json` records the bounded search: baseline, unchecked counters, cached reads, then the indexed-mode event. `gas-baseline.json` preserves the original measurements/source hashes and `gas-comparison.json` contains every operation delta. Both the baseline and accepted version were repeated against the same benchmark harness.

## Reproduce

```sh
# From contracts/; optionally set FOUNDRY_SOLC=/absolute/path/to/solc.
forge test --isolate --match-contract ShootyArenaGasTest --json > /tmp/shooty-gas-current.json
python3 tools/compare-gas.py benchmarks/gas-baseline.json /tmp/shooty-gas-current.json

# Correctness and backend interop:
forge test --no-match-contract ShootyArenaGasTest
npm run test:integration
```

To reproduce the original baseline, copy `src`, `test`, `foundry.toml`, and `node_modules` into a temporary project, then reverse `benchmarks/optimization.patch` inside that copy (`patch -R -p0 < /path/to/optimization.patch`). Run the same isolated benchmark there. Reverse the patch only in the temporary copy; its two source files are the complete production-code delta.

The benchmark uses a local token rather than the testnet USDC proxy, so token-specific costs and Monad's opcode schedule are outside its scope. Monad bills the submitted gas limit; deployment/frontend integration must estimate each actual call with a small buffer and fail when simulation reverts. See [Monad gas pricing](https://docs.monad.xyz/developer-essentials/gas-pricing).

## Event integration

Regenerate consumers from `abi/ShootyArena.json`. The `MatchCreated` signature/topic zero and argument types are unchanged, but `mode` moves from log data to `topics[2]`. `topics[1]` remains match ID; log data contains `(termsHash, rosterHash)`. Decode this event using the new ABI. Every function selector and all other event formats remain unchanged.

The workspace has no running frontend/relayer. Parallel claim submission can reduce waiting time but does not itself lower per-claim gas. One signer still needs coordinated transaction nonces. A batch transaction also needs an explicit failure policy so a blocked recipient cannot prevent other beneficiaries from getting paid; individual permissionless claims retain that isolation.
