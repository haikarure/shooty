# Deploy Shooty on Monad Testnet

The owner requested a local deployer with an exportable private key. `tools/deploy-testnet.mjs` follows that signer choice while retaining the Monad deployment checks and the canonical CreateX CREATE2 path. It uses the protected wallet backup directly; no raw private key is passed through command arguments or written into public deployment artifacts.

## Commands

From `contracts/`, after `npm ci --ignore-scripts --no-audit --no-fund` and a successful build:

```sh
# Read chain, finalized deployer balance, token/factory code, and simulate the exact deployment.
npm run deploy:testnet

# Sign locally, send the deployment, wait for finality, and submit explorer verification.
npm run deploy:testnet -- --broadcast
```

The commands load `contracts/.env`. The local compiler must be Solidity 0.8.37; use `FOUNDRY_SOLC=/absolute/path/to/solc` if needed. Actual execution requires network access to the configured testnet RPC and the monskills verification API. No transaction is signed if the preflight fails.

## Checks and recovery

- Require chain ID 10143, token/factory code at a finalized block, and a six-decimal reward token.
- Use a permissioned, chain-bound salt: the deployer's 20-byte address, flag `01`, and an 11-byte version suffix. Compute the guarded salt using the CreateX rules, and compare its predicted address with the factory's read method. See [CreateX source](https://github.com/pcaversaccio/createx/blob/main/src/CreateX.sol).
- Simulate `deployCreate2`, then estimate the exact call and add 10% to its gas limit. A reverted simulation aborts; it is never replaced with a guessed high limit. Require enough finalized balance for the fee cap.
- Recompile the exported verification sources and reproduce the existing creation/runtime artifacts before signing.
- Save the signed transaction/hash in `../.secrets/shooty-monad-testnet/deployment-tx.json`, mode `0600`, before any network submission. On a timeout, rerun the same command: it validates/reconciles that saved transaction instead of signing a fresh nonce.
- Wait for a successful, canonical, finalized receipt. Check arena code, token, referee, treasury, and the assigned admin/creator/pauser roles.
- Preserve the actual receipt/address in `deployment/testnet.json`, then submit compiler input/metadata and constructor arguments to `https://agents.devnads.com/v1/verify`. The API response is recorded as submitted/pending; HTTP acceptance alone is not treated as completed explorer verification.

`deployment/plan.json` contains public preflight results and a **predicted** address. Only `deployment/testnet.json` with status `FINALIZED` is evidence of a completed deployment. An offline prepared init-code file is not evidence of funding or deployment.

The deployment script is covered by tests for wrong chain, insufficient balance, failed simulation, unavailable RPC, and a timeout after transaction acceptance. These tests mock RPC responses; live token/factory checks and a real deployment remain separate requirements.
