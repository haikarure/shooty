# Shooty

Shooty is a quickdraw game for phones using BLE pistols or touch input, with test USDC entries and settlement on Monad Testnet. The server runs gameplay and a trusted referee signs start/results; the arena contract handles deposits, credits, refunds, and token payments.

`shooty-smartcontract-handoff.html` is the original blueprint/simulation. Its 25 embedded files were extracted into `blueprint/` and verified against their embedded SHA-256 hashes. Those original files retain their historical status statements. The implementation lives in **[contracts/](contracts/README.md)**.

- [ShootyArena](contracts/src/ShootyArena.sol): Duel 1vs1, Team Duel 3vs3, Rumble 4 players, EIP-712/1271 authorization, timeout refunds, fixed-beneficiary claims.
- [Backend integration](contracts/INTEGRATION.md): ABI, signed payloads, terms commitment, events, and relayer behavior.
- [Foundry tests](contracts/test/ShootyArena.t.sol) and [stateful invariants](contracts/test/ShootyArena.invariant.t.sol).

Entry is 1 test USDC per player. Wins distribute the pool less a 10% fee; draws/timeouts refund paid entries in full. The arena is deployed on Monad Testnet at `0xb2877AcE468df80B6e137776d0A60D7ec4431BaF`, with a finalized receipt and successful source verification on MonadVision and Monadscan. See [deployment addresses](contracts/deployment/addresses.json) and the [deployment record](contracts/deployment/testnet.json). Wallet integration, multiplayer/BLE behavior, and automatic relayer operation still require the application/backend; the HTML preview remains a simulation.

Built using monskills guidance for Monad Testnet. [contracts/README.md](contracts/README.md) contains build steps, deployment preparation, verification, and trust assumptions.
