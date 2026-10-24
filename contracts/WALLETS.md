# Shooty testnet wallets

Local wallets were created at the project owner's request so their private keys can be backed up and imported. They are standard EVM accounts intended for the Shooty Monad Testnet demo (chain 10143); key generation itself does not fund accounts or deploy anything.

The public address list is `deployment/wallets.public.json`. The complete backup, including each raw private key, is `../.secrets/shooty-monad-testnet/wallets.json`. This is an owner-readable JSON backup, not an encrypted keystore import file. To import an individual account into a wallet application, use that role's `privateKey` value with the application's private-key import flow.

| Role | Purpose |
| --- | --- |
| deployer | Sends the arena deployment transaction |
| admin | Manages AccessControl roles and future official defaults |
| relayer | ROOM_CREATOR_ROLE; creates matches and submits start/result/claim jobs |
| pauser | PAUSER_ROLE; pauses or resumes admission and starts |
| referee | Signs EIP-712 start/result authorizations |
| treasury | Receives credited platform fees |
| player_one | First wallet for the two-player demo |
| player_two | Second wallet for the two-player demo |

The secret directory has mode `0700`; the backup has mode `0600`. `.secrets/` and `.env` are listed in the root `.gitignore`. `contracts/.env` contains public addresses and a reference to the backup path, without raw private keys. The public manifest contains no private keys. The generation command independently checks every private-key/address pair and refuses to overwrite an existing wallet set or configuration.

Private wallet backups, populated environment files, and signed transaction journals are local-only files and are excluded from the repository. A fresh checkout includes the public address manifest and `.env.example`; it does not include any private keys. For a separate deployment, generate a new local wallet set with `node tools/create-demo-wallets.mjs` rather than expecting the deployed instance's signing keys in Git.

The generated role addresses are already wired into `.env`. Deployment preparation can run without reading any private key:

```sh
node --env-file=.env tools/prepare-deployment.mjs
```

`deployment/prepared.json` created with `--offline` remains explicitly unverified. Live chain/token checks and funded signing accounts are required for an actual deployment. Deployer/relayer need test MON for their transactions; players need test MON plus test USDC for approve/join. No private key is embedded in the compiler input, ABI, public manifest, or deployment preparation artifact.
