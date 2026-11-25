# Soroban Project

## Project Structure

This repository uses the recommended structure for a Soroban project:

```text
.
├── contracts
│   └── hello_world
│       ├── src
│       │   ├── lib.rs
│       │   └── test.rs
│       └── Cargo.toml
├── Cargo.toml
└── README.md
```

- New Soroban contracts can be put in `contracts`, each in their own directory. There is already a `hello_world` contract in there to get you started.
- If you initialized this project with any other example contracts via `--with-example`, those contracts will be in the `contracts` directory as well.
- Contracts should have their own `Cargo.toml` files that rely on the top-level `Cargo.toml` workspace for their dependencies.
- Frontend libraries can be added to the top-level directory as well. If you initialized this project with a frontend template via `--frontend-template` you will have those files already included.

## Deploying contracts

The scripts in `scripts/` accept a `NETWORK` environment variable, which is passed to `stellar --network`. It defaults to `testnet`; set it to `futurenet`, a network name configured for a local Stellar quickstart instance, or any other CLI-configured network:

```bash
cd contracts
NETWORK=futurenet DEPLOYER_SECRET=S... TOKEN_CONTRACT_ID=C... ./scripts/deploy_token_transfer.sh
```

Deployments to `mainnet` or `public` are blocked unless you also set `CONFIRM_MAINNET=yes`:

```bash
NETWORK=mainnet CONFIRM_MAINNET=yes DEPLOYER_SECRET=S... TOKEN_CONTRACT_ID=C... \
  ./scripts/deploy_group_treasury.sh
```

Each script documents its required variables in its header comments.
