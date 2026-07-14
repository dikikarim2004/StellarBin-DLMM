# StellarBin — Dynamic Liquidity Market Maker on Stellar


StellarBin is a full-stack **DLMM (Dynamic Liquidity Market Maker)** protocol built on the [Stellar](https://stellar.org) network using **Soroban** smart contracts. Inspired by Meteora on Solana, it enables concentrated liquidity across discrete price bins, dynamic fees that respond to market volatility, and permissionless pool creation — all on-chain.

** Demo link :** https://stellarbin-dlmm.vercel.app/ 

> **⚠️ Testnet Notice:** StellarBin is currently deployed on **Stellar Testnet**. All tokens, transactions, and balances are test assets with no real value. Do not use mainnet wallets or real funds.

---

## Features

- **Discrete-bin AMM** — Liquidity is concentrated in specific price bins instead of spread across an infinite curve, enabling higher capital efficiency.
- **Dynamic fees** — Fee rates automatically increase during high-volatility periods and decay back to the base rate as trading activity normalizes, protecting LPs from toxic flow.
- **Permissionless pool creation** — Anyone can create a Standard Pool (active immediately) or a Launch Pool (swaps gated until a specified activation time, anti-snipe protection).
- **Real on-chain execution** — Swap quotes, liquidity operations, and pool creation all submit real signed transactions to the Stellar testnet via Soroban RPC.
- **Wallet support** — Connect via Freighter or Albedo browser extensions to sign and submit transactions.

---

## Smart Contract Addresses (Stellar Testnet)

| Contract | Address |
|---|---|
| **DLMM** (main protocol) | `CCW5MVYJFJPBJNJY7GN6BHC5BQR47RXVIM2T2X4F3YSQC7MQ7J4GNESH` |
| **Vault** | `CCDVBRMT3BI65JV2C7AQJOSIGT76MNNTXSVYDKGXKPBSOKVWQRGKU7VI` |
| **Math library** | `CB7U2EL6L4AR2IWANOSXDYVHWL3D3PD3XOZU6PUA4MDAVWCOT3AAVX4Z` |
| **Native XLM (SAC)** | `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| **TESTUSD (SAC)** | `CCA733ILFGI7SESYWNBYTKHUJTJTSU2ORRT6SFNSDZWHYSE4WDLLDUND` |

Pool `0` is the default seeded Standard Pool (XLM / TESTUSD, bin step 25 bps, base fee 10 bps).

---

## Tech Stack

| Layer | Technology |
|---|---|
| Monorepo | pnpm workspaces |
| Runtime | Node.js 24 |
| Language | TypeScript 5.9 |
| Frontend | React + Vite, TailwindCSS, shadcn/ui, Recharts, wouter |
| Backend API | Express 5 |
| Database | PostgreSQL + Drizzle ORM |
| Validation | Zod v4, drizzle-zod |
| API contract | OpenAPI 3 + Orval codegen |
| Smart contracts | Rust + Soroban (Stellar) |

---

## Prerequisites

Before cloning, make sure you have the following installed:

- **Node.js 24+** — [nodejs.org](https://nodejs.org)
- **pnpm 9+** — Install via `npm install -g pnpm`
- **Rust + wasm32 target** *(only needed if you want to build/modify smart contracts)*
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **Stellar CLI** *(only needed for contract deployment/seeding)*
  ```bash
  cargo install --locked stellar-cli --features opt
  ```
- **PostgreSQL** *(optional — pool data is computed, DB is not required for basic dev)*

---

## Installation

```bash
# Clone the repository
git clone https://github.com/your-org/stellarbin.git
cd stellarbin

# Install all workspace dependencies
pnpm install
```

---

## Environment Setup

Copy the example env files and fill in values:

```bash
cp artifacts/stellar-dlmm/.env.example artifacts/stellar-dlmm/.env
cp artifacts/api-server/.env.example artifacts/api-server/.env
```

Key environment variables in `artifacts/stellar-dlmm/.env`:

```env
VITE_STELLAR_NETWORK=testnet
VITE_STELLAR_RPC_URL=https://soroban-testnet.stellar.org
VITE_STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
VITE_DLMM_CONTRACT_ID=CCW5MVYJFJPBJNJY7GN6BHC5BQR47RXVIM2T2X4F3YSQC7MQ7J4GNESH
VITE_VAULT_CONTRACT_ID=CCDVBRMT3BI65JV2C7AQJOSIGT76MNNTXSVYDKGXKPBSOKVWQRGKU7VI
VITE_TOKEN_X_ADDRESS=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC
VITE_TOKEN_Y_ADDRESS=CCA733ILFGI7SESYWNBYTKHUJTJTSU2ORRT6SFNSDZWHYSE4WDLLDUND
VITE_DEFAULT_POOL_ID=0
```

For `artifacts/api-server/.env`:

```env
PORT=5000
DATABASE_URL=postgresql://localhost:5432/stellarbin   # optional
```

---

## Running in Development Mode

Open **two terminal windows** and run each service separately:

**Terminal 1 — API server:**
```bash
pnpm --filter @workspace/api-server run dev
```
The API will be available at `http://localhost:5000`.

**Terminal 2 — Frontend:**
```bash
pnpm --filter @workspace/stellar-dlmm run dev
```
The frontend will be available at the port printed in the terminal (usually `http://localhost:5173`).

---

## Other Useful Commands

```bash
# Full typecheck across all packages
pnpm run typecheck

# Build all packages
pnpm run build

# Regenerate API hooks and Zod schemas from the OpenAPI spec
pnpm --filter @workspace/api-spec run codegen
```

---

## Smart Contract Development

Contracts live in `contracts/`. To build:

```bash
cd contracts
RUSTFLAGS="--sysroot=/path/to/sysroot -C target-cpu=mvp" \
  cargo build --target wasm32-unknown-unknown --release
```

After building, optimize before deploying (raw wasm is rejected by the network):

```bash
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/<contract_name>.wasm
```

Deploy to testnet:

```bash
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/<contract_name>.optimized.wasm \
  --network testnet \
  --source <your-identity>
```

To seed a fresh pool after deployment, use `contracts/scripts/seed_pool.sh`.

---

## Project Structure

```
stellarbin/
├── artifacts/
│   ├── stellar-dlmm/          # React + Vite frontend
│   │   └── src/
│   │       ├── pages/         # Swap, Pools, Pool Detail, Positions, Analytics, Create
│   │       ├── components/    # UI components
│   │       └── lib/           # stellar.ts, dlmm-client.ts, contracts.ts
│   └── api-server/            # Express 5 REST API
│       └── src/routes/        # pools, tokens, swap, transactions
├── contracts/
│   ├── dlmm/                  # Main DLMM Soroban contract
│   ├── math/                  # Fixed-point math library
│   └── vault/                 # Dynamic vault contract
├── lib/
│   ├── api-spec/              # OpenAPI 3 specification (source of truth)
│   ├── api-client-react/      # Generated React Query hooks
│   └── api-zod/               # Generated Zod validators
└── scripts/                   # Shared utility scripts
```

---

## Wallet Setup (Testnet)

1. Install the [Freighter wallet extension](https://freighter.app) in your browser.
2. Switch Freighter to **Testnet** mode.
3. Fund your wallet using the [Stellar Testnet Friendbot](https://friendbot.stellar.org/?addr=YOUR_ADDRESS).
4. For TESTUSD, use the in-app faucet button in the Add Liquidity modal.

---

## License

MIT
