# StellarBin — Decentralized Liquidity Protocol

StellarBin is a full-stack DeFi boilerplate for a Dynamic Liquidity Market Maker (DLMM) on the Stellar network. This project combines a React frontend, an Express backend, and Soroban/Rust smart contracts to deliver swap, liquidity pool, LP position, and analytics experiences.

## What is included in this project

- `artifacts/stellar-dlmm/` — DeFi frontend application built with React + Vite.
- `artifacts/api-server/` — Express API server providing pool data, swap quotes, and transactions.
- `contracts/` — Soroban/Rust smart contracts:
  - `contracts/math/` — fixed-point math library for bin pricing and dynamic fees.
  - `contracts/dlmm/` — main DLMM contract with a bin-based AMM.
  - `contracts/vault/` — vault contract supporting deposit/withdraw behavior.
- `lib/api-spec/` — OpenAPI specification and Orval configuration.
- `lib/api-client-react/` — generated React Query API client.
- `lib/api-zod/` — generated Zod validators.
- `lib/db/` — Drizzle/Postgres configuration and schema.

## Key features

- Token swap with live quotes, price impact, and slippage controls.
- Liquidity pool listing with statistics and filtering.
- Pool detail pages with bin distribution, TVL, volume, and fee history.
- Add/remove liquidity flows with preset strategies.
- LP position page displaying bin range and unrealized fees.
- Protocol analytics pages with TVL, volume, top pools, and transaction feed.
- Soroban smart contracts for DLMM, vault, and on-chain math.
- Computed pool data model so the UI can work without on-chain deployment.

## Architecture overview

- Discrete bin-based AMM model: each bin maintains a constant price, and swaps move through multiple bins sequentially.
- Prices and fees are computed using fixed-point `i128` scaled by `10^18` to avoid floating-point operations in Soroban.
- Backend API generates pool/bin statistics while the frontend constructs unsigned Soroban transactions.
- Wallet signing is handled in the UI layer with Freighter/Albedo.

## Stack

- Package manager: pnpm workspaces
- Languages: TypeScript, Rust
- Frontend: React + Vite + TailwindCSS + shadcn/ui
- Backend: Express 5
- Smart contract: Stellar Soroban (WASM)
- API validation: Zod
- API codegen: Orval
- DB: PostgreSQL + Drizzle ORM (optional; pool data is currently computed)

## Run the project

1. Install workspace dependencies:

```bash
pnpm install
```

2. Start the API server:

```bash
pnpm --filter @workspace/api-server run dev
```

3. Start the DeFi frontend:

```bash
pnpm --filter @workspace/stellar-dlmm run dev
```

4. Optional: typecheck the workspace:

```bash
pnpm run typecheck
```

5. Optional: build the full project:

```bash
pnpm run build
```

## Environment

- `DATABASE_URL` — Postgres connection string. The backend can run without a database because pool data is computed.

## Smart contracts and deployment

Soroban contracts in `contracts/` can be built with:

```bash
cd contracts
cargo build --target wasm32-unknown-unknown --release
```

The main DLMM contract is in `contracts/dlmm/`, the math library is in `contracts/math/`, and the vault contract is in `contracts/vault/`.

## Important notes

- After changing the OpenAPI spec, run codegen before modifying routes or frontend hooks.
- `artifacts/stellar-dlmm` uses `@stellar/stellar-sdk` for Soroban integration.
- Soroban contracts use `i128` fixed-point arithmetic and target `wasm32-unknown-unknown`.

## Direct references

- `replit.md` — project summary and stack.
- `SMART_CONTRACT_GUIDE.md` — smart contract integration, build, and deployment guide.
