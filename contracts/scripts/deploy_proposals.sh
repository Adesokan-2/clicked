#!/usr/bin/env bash
# Deploy proposals contract to a Stellar network (default: testnet).
#
# Network configuration:
#   NETWORK         Stellar CLI network name (default: testnet). Set to futurenet,
#                   a configured quickstart network, mainnet, or public as needed.
#   CONFIRM_MAINNET Must be "yes" when NETWORK is mainnet or public.
#
# Prerequisites:
#   - stellar CLI installed  (https://developers.stellar.org/docs/tools/stellar-cli)
#   - DEPLOYER_SECRET env var set (Stellar secret key of the deployer/admin account)
#   - TREASURY_CONTRACT_ID env var set
#   - MIN_VOTES env var set
#
# Usage:
#   DEPLOYER_SECRET=S... TREASURY_CONTRACT_ID=C... MIN_VOTES=100 ./scripts/deploy_proposals.sh
#   NETWORK=futurenet DEPLOYER_SECRET=S... TREASURY_CONTRACT_ID=C... MIN_VOTES=100 ./scripts/deploy_proposals.sh

set -euo pipefail

NETWORK="${NETWORK:-testnet}"
WASM_PATH="target/wasm32-unknown-unknown/release/proposals.wasm"

if [[ "$NETWORK" == "mainnet" || "$NETWORK" == "public" ]] && [[ "${CONFIRM_MAINNET:-}" != "yes" ]]; then
  echo "Error: refusing to deploy to $NETWORK without CONFIRM_MAINNET=yes" >&2
  exit 1
fi

if [[ -z "${DEPLOYER_SECRET:-}" ]]; then
  echo "Error: DEPLOYER_SECRET is not set" >&2
  exit 1
fi

if [[ -z "${TREASURY_CONTRACT_ID:-}" ]]; then
  echo "Error: TREASURY_CONTRACT_ID is not set" >&2
  exit 1
fi

if [[ -z "${MIN_VOTES:-}" ]]; then
  echo "Error: MIN_VOTES is not set" >&2
  exit 1
fi

echo "==> Target network: $NETWORK"

echo "==> Building contract..."
cargo build -p proposals --target wasm32-unknown-unknown --release

echo "==> Uploading WASM to $NETWORK..."
WASM_HASH=$(stellar contract upload \
  --network "$NETWORK" \
  --source "$DEPLOYER_SECRET" \
  --wasm "$WASM_PATH")

echo "    WASM hash: $WASM_HASH"

echo "==> Deploying contract instance..."
CONTRACT_ID=$(stellar contract deploy \
  --network "$NETWORK" \
  --source "$DEPLOYER_SECRET" \
  --wasm-hash "$WASM_HASH")

echo "    Contract ID: $CONTRACT_ID"

ADMIN_PUBLIC=$(stellar keys public-key --secret-key "$DEPLOYER_SECRET")

echo "==> Initialising contract..."
stellar contract invoke \
  --network "$NETWORK" \
  --source "$DEPLOYER_SECRET" \
  --id "$CONTRACT_ID" \
  -- initialize \
  --admin "$ADMIN_PUBLIC"

echo ""
echo "✓ proposals deployed and initialised"
echo "  Contract ID         : $CONTRACT_ID"
echo "  Treasury Contract   : $TREASURY_CONTRACT_ID"
echo "  Min Votes           : $MIN_VOTES"
echo "  Admin               : $ADMIN_PUBLIC"
echo ""
echo "Add to your .env:"
echo "  PROPOSALS_CONTRACT_ID=$CONTRACT_ID"
