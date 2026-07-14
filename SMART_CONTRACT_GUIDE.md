# StellarBin — Panduan Integrasi Smart Contract

Panduan lengkap mulai dari instalasi dependensi Rust/Soroban, kompilasi kontrak, deploy ke setiap jaringan, hingga integrasi ke frontend DApp.

---

## Daftar Isi

1. [Arsitektur Kontrak](#1-arsitektur-kontrak)
2. [Instalasi Dependensi](#2-instalasi-dependensi)
3. [Struktur Direktori Kontrak](#3-struktur-direktori-kontrak)
4. [Kompilasi Smart Contract](#4-kompilasi-smart-contract)
5. [Menjalankan Unit Test](#5-menjalankan-unit-test)
6. [Deploy ke Testnet](#6-deploy-ke-testnet)
7. [Deploy ke Devnet (Futurenet)](#7-deploy-ke-devnet-futurenet)
8. [Deploy ke Mainnet](#8-deploy-ke-mainnet)
9. [Inisialisasi Pool Setelah Deploy](#9-inisialisasi-pool-setelah-deploy)
10. [Integrasi ke Frontend DApp](#10-integrasi-ke-frontend-dapp)
11. [Integrasi ke API Server](#11-integrasi-ke-api-server)
12. [Referensi Fungsi Kontrak](#12-referensi-fungsi-kontrak)
13. [Troubleshooting](#13-troubleshooting)

---

## 1. Arsitektur Kontrak

Proyek ini memiliki tiga kontrak Soroban yang saling terhubung:

```
contracts/
├── math/          stellar-dlmm-math    — library fixed-point i128, bin price, dynamic fee
├── dlmm/          stellar-dlmm         — kontrak utama DLMM pool (add/remove liquiditas, swap)
└── vault/         stellar-dlmm-vault   — vault yield-bearing ERC-4626 (Blend stub)
```

**Alur dependency:**
```
dlmm  ──depends on──▶  math
vault ──standalone──▶  (tidak bergantung math/dlmm, bisa di-deploy terpisah)
math  ──standalone──▶  (library murni, bisa di-deploy sebagai on-chain utility)
```

**Storage layout kontrak DLMM:**
| Key | Tipe | Keterangan |
|---|---|---|
| `POOL_CFG` | `PoolConfig` | Konfigurasi pool (token, fee, admin) |
| `ACTIVE` | `i32` | Bin aktif saat ini |
| `LAST_TS` | `u64` | Timestamp trade terakhir |
| `("BIN", bin_id)` | `BinReserves` | Reserve token per bin |

---

## 2. Instalasi Dependensi

### 2.1 Install Rust

```bash
# Install rustup (jika belum ada)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Verifikasi
rustc --version   # Minimal: rustc 1.74.0
cargo --version
```

### 2.2 Install Rust Nightly + Target WASM

Soroban memerlukan target `wasm32-unknown-unknown`:

```bash
# Tambah target WASM
rustup target add wasm32-unknown-unknown

# Kontrak ini menggunakan stable, tapi jika butuh nightly:
rustup toolchain install nightly
rustup target add wasm32-unknown-unknown --toolchain nightly
```

### 2.3 Install Stellar CLI

Stellar CLI digunakan untuk deploy, invoke fungsi kontrak, dan manajemen akun di semua jaringan.

```bash
# Via cargo (direkomendasikan, selalu versi terbaru)
cargo install --locked stellar-cli --features opt

# Verifikasi
stellar --version   # Minimal: stellar 21.x.x

# Atau via brew (macOS)
brew install stellar/tap/stellar-cli
```

### 2.4 Install soroban-cli (Alternatif Lama)

> Sejak Stellar CLI v21+, `stellar contract` sudah menggantikan `soroban` CLI. Gunakan `stellar` saja.

### 2.5 Verifikasi Semua Dependensi

```bash
rustc --version
cargo --version
rustup target list --installed | grep wasm32
stellar --version
```

---

## 3. Struktur Direktori Kontrak

```
contracts/
├── Cargo.toml              # Workspace Cargo — daftarkan semua member
├── math/
│   ├── Cargo.toml          # Package: stellar-dlmm-math
│   └── src/
│       └── lib.rs          # bin_price(), dynamic_fee(), compute_x_from_y(), SCALAR
├── dlmm/
│   ├── Cargo.toml          # Package: stellar-dlmm (depends on math)
│   └── src/
│       └── lib.rs          # initialize(), add_liquidity_bin(), swap_exact_in_bin()
└── vault/
    ├── Cargo.toml          # Package: stellar-dlmm-vault
    └── src/
        └── lib.rs          # initialize(), deposit(), withdraw(), nav_per_share()
```

**contracts/Cargo.toml** (workspace root):
```toml
[workspace]
resolver = "2"
members = ["math", "dlmm", "vault"]

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
panic = "abort"
codegen-units = 1
lto = true
```

---

## 4. Kompilasi Smart Contract

Semua perintah dijalankan dari direktori `contracts/`.

```bash
cd contracts
```

### 4.1 Build semua kontrak sekaligus

```bash
cargo build --target wasm32-unknown-unknown --release
```

Output WASM akan ada di:
```
contracts/target/wasm32-unknown-unknown/release/
├── stellar_dlmm_math.wasm      # ~20–40 KB
├── stellar_dlmm.wasm           # ~40–80 KB (kontrak utama)
└── stellar_dlmm_vault.wasm     # ~30–60 KB
```

### 4.2 Build per kontrak

```bash
# Hanya math library
cargo build -p stellar-dlmm-math --target wasm32-unknown-unknown --release

# Hanya DLMM utama
cargo build -p stellar-dlmm --target wasm32-unknown-unknown --release

# Hanya vault
cargo build -p stellar-dlmm-vault --target wasm32-unknown-unknown --release
```

### 4.3 Optimasi ukuran WASM (opsional)

Gunakan `wasm-opt` dari Binaryen untuk mereduksi ukuran lebih jauh:

```bash
# Install wasm-opt
cargo install wasm-opt --locked

# Optimasi
wasm-opt -Oz \
  target/wasm32-unknown-unknown/release/stellar_dlmm.wasm \
  -o target/wasm32-unknown-unknown/release/stellar_dlmm_opt.wasm
```

> Profil release sudah dikonfigurasi dengan `opt-level = "z"` dan `lto = true` — ukuran WASM sudah minimal tanpa langkah tambahan.

---

## 5. Menjalankan Unit Test

Test dijalankan di lingkungan host (bukan WASM) menggunakan `soroban-sdk/testutils`.

```bash
cd contracts

# Jalankan semua test
cargo test

# Test hanya math library (termasuk bin price, dynamic fee)
cargo test -p stellar-dlmm-math

# Test verbose dengan output println!
cargo test -p stellar-dlmm-math -- --nocapture

# Test spesifik
cargo test test_bin_price_active
cargo test test_dynamic_fee_no_activity
```

**Test yang tersedia di `math/src/lib.rs`:**
| Test | Cek |
|---|---|
| `test_bin_price_active` | offset=0 → price = 1.0 (SCALAR) |
| `test_bin_price_positive` | offset=1, step=10000 → price = 2.0 |
| `test_bin_price_negative` | offset=-1 → price ≈ 0.5 |
| `test_dynamic_fee_no_activity` | 0 detik → 2x base fee |
| `test_dynamic_fee_stale` | 300+ detik → base fee saja |
| `test_compute_y_from_x` | x=1, price=2 → y=2 |

---

## 6. Deploy ke Testnet

Testnet adalah jaringan publik untuk testing — XLM gratis via Friendbot, tidak ada nilai nyata.

### 6.1 Konfigurasi Network

```bash
# Tambah network testnet ke Stellar CLI
stellar network add testnet \
  --rpc-url https://soroban-testnet.stellar.org \
  --network-passphrase "Test SDF Network ; September 2015"
```

### 6.2 Buat Akun Admin

```bash
# Generate keypair baru untuk admin
stellar keys generate admin --network testnet

# Tampilkan public key
stellar keys address admin

# Fund akun via Friendbot (gratis, testnet only)
stellar keys fund admin --network testnet
```

### 6.3 Upload dan Deploy Kontrak Math

```bash
cd contracts

# Upload WASM ke chain (dapat contract WASM hash)
MATH_HASH=$(stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/stellar_dlmm_math.wasm \
  --source admin \
  --network testnet)

echo "Math WASM hash: $MATH_HASH"

# Deploy instance kontrak math
MATH_CONTRACT=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_dlmm_math.wasm \
  --source admin \
  --network testnet)

echo "Math Contract ID: $MATH_CONTRACT"
```

### 6.4 Deploy Kontrak DLMM Utama

```bash
DLMM_CONTRACT=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_dlmm.wasm \
  --source admin \
  --network testnet)

echo "DLMM Contract ID: $DLMM_CONTRACT"
```

### 6.5 Deploy Kontrak Vault

```bash
VAULT_CONTRACT=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_dlmm_vault.wasm \
  --source admin \
  --network testnet)

echo "Vault Contract ID: $VAULT_CONTRACT"
```

### 6.6 Simpan Contract IDs

Buat file `.env.testnet` di root proyek:

```bash
cat > .env.testnet << EOF
NETWORK=testnet
ADMIN_ADDRESS=$(stellar keys address admin)
MATH_CONTRACT_ID=$MATH_CONTRACT
DLMM_CONTRACT_ID=$DLMM_CONTRACT
VAULT_CONTRACT_ID=$VAULT_CONTRACT
RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
EOF
```

---

## 7. Deploy ke Devnet (Futurenet)

Futurenet adalah jaringan cutting-edge dengan fitur terbaru Stellar, sering dipakai untuk pengembangan sebelum testnet.

### 7.1 Konfigurasi Futurenet

```bash
stellar network add futurenet \
  --rpc-url https://rpc-futurenet.stellar.org \
  --network-passphrase "Test SDF Future Network ; October 2022"
```

### 7.2 Buat dan Fund Akun di Futurenet

```bash
stellar keys generate admin-futurenet --network futurenet
stellar keys fund admin-futurenet --network futurenet
```

> Jika Friendbot futurenet tidak tersedia, gunakan: `curl https://friendbot-futurenet.stellar.org/?addr=$(stellar keys address admin-futurenet)`

### 7.3 Deploy ke Futurenet

Proses sama dengan testnet, ganti `--network testnet` → `--network futurenet`:

```bash
cd contracts

DLMM_CONTRACT_FN=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_dlmm.wasm \
  --source admin-futurenet \
  --network futurenet)

echo "DLMM (Futurenet): $DLMM_CONTRACT_FN"
```

---

## 8. Deploy ke Mainnet

> **Peringatan:** Deploy ke mainnet memerlukan XLM nyata untuk biaya ledger. Pastikan kontrak sudah diaudit dan diuji secara menyeluruh di testnet.

### 8.1 Konfigurasi Mainnet

```bash
stellar network add mainnet \
  --rpc-url https://mainnet.stellar.validationcloud.io/v1/<API_KEY> \
  --network-passphrase "Public Global Stellar Network ; September 2015"

# Alternatif RPC mainnet publik:
# https://rpc.stellar.org
# https://horizon.stellar.org (Horizon, bukan Soroban RPC)
```

### 8.2 Persiapan Akun Admin Mainnet

```bash
# Import private key yang sudah ada dengan XLM
stellar keys add mainnet-admin --secret-key

# Cek saldo
stellar account balance mainnet-admin --network mainnet
```

### 8.3 Deploy ke Mainnet

```bash
cd contracts

# Build ulang untuk memastikan versi release terbaru
cargo build --target wasm32-unknown-unknown --release

# Deploy DLMM (memerlukan ~10-50 XLM untuk storage deposit)
DLMM_MAINNET=$(stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/stellar_dlmm.wasm \
  --source mainnet-admin \
  --network mainnet \
  --fee 1000000)   # 0.1 XLM fee — sesuaikan jika perlu

echo "DLMM Mainnet ID: $DLMM_MAINNET"
```

### 8.4 Verifikasi Deploy di Stellar Expert

Buka: `https://stellar.expert/explorer/public/contract/<DLMM_MAINNET>`

---

## 9. Inisialisasi Pool Setelah Deploy

Setelah kontrak di-deploy, jalankan fungsi `initialize` untuk mengaktifkan pool.

### 9.1 Dapatkan Alamat SAC Token

Token di Stellar menggunakan **Stellar Asset Contract (SAC)**. Contoh untuk XLM dan USDC:

```bash
# Wrap native XLM sebagai SAC (jika belum ada)
stellar contract asset deploy \
  --asset native \
  --source admin \
  --network testnet

# USDC Testnet (biasanya sudah ada — cari di stellar.expert)
# USDC Issuer testnet: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
```

### 9.2 Inisialisasi DLMM Pool

```bash
# Contoh: pool XLM/USDC, bin_step=25bps, base_fee=30bps, active_bin=0
stellar contract invoke \
  --id $DLMM_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- \
  initialize \
  --admin $(stellar keys address admin) \
  --token_x <XLM_SAC_ADDRESS> \
  --token_y <USDC_SAC_ADDRESS> \
  --bin_step_bps 25 \
  --base_fee_bps 30 \
  --active_bin_id 0
```

### 9.3 Inisialisasi Vault

```bash
stellar contract invoke \
  --id $VAULT_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- \
  initialize \
  --admin $(stellar keys address admin) \
  --asset <USDC_SAC_ADDRESS> \
  --deposit_cap 1000000000000 \
  --performance_fee_bps 500
```

### 9.4 Verifikasi Pool

```bash
# Cek active bin
stellar contract invoke \
  --id $DLMM_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- \
  get_active_bin

# Cek konfigurasi pool
stellar contract invoke \
  --id $DLMM_CONTRACT_ID \
  --source admin \
  --network testnet \
  -- \
  get_config
```

---

## 10. Integrasi ke Frontend DApp

Frontend menggunakan `src/lib/stellar.ts` sebagai layer XDR encoding antara React dan kontrak.

### 10.1 Set Contract IDs di Frontend

Buat file `artifacts/stellar-dlmm/src/lib/contracts.ts`:

```typescript
// Contract IDs — ganti dengan hasil deploy Anda
export const CONTRACTS = {
  testnet: {
    dlmm:  "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    vault: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    math:  "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  },
  mainnet: {
    dlmm:  "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    vault: "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    math:  "CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  },
} as const;

export type NetworkId = "testnet" | "mainnet";
```

### 10.2 Melakukan Swap dari Komponen React

```typescript
import { useWallet } from "@/contexts/wallet";
import {
  buildContractInvocation,
  encodeSwapExactIn,
  displayToStroops,
  createRpcServer,
} from "@/lib/stellar";
import { assembleTransaction } from "@stellar/stellar-sdk";
import { CONTRACTS } from "@/lib/contracts";

function useSwap() {
  const wallet = useWallet();

  async function executeSwap(
    amountInDisplay: string,
    xToY: boolean,
    slippagePct: number = 0.5
  ) {
    if (!wallet.address) throw new Error("Wallet tidak terhubung");

    const network = wallet.network; // "testnet" | "mainnet"
    const contractId = CONTRACTS[network].dlmm;

    // 1. Encode argumen kontrak
    const amountIn = displayToStroops(amountInDisplay);
    const minAmountOut = (amountIn * BigInt(Math.floor((1 - slippagePct / 100) * 10000))) / 10000n;

    const args = encodeSwapExactIn(wallet.address, xToY, amountIn, minAmountOut);

    // 2. Build transaksi unsigned
    const tx = await buildContractInvocation({
      callerAddress: wallet.address,
      contractId,
      functionName: "swap_exact_in_bin",
      args,
      network,
    });

    // 3. Simulasi untuk mendapatkan fee & auth yang tepat
    const rpcServer = createRpcServer(network);
    const sim = await rpcServer.simulateTransaction(tx);
    if ("error" in sim) throw new Error(`Simulasi gagal: ${sim.error}`);

    // 4. Assemble transaksi dengan hasil simulasi
    const assembled = assembleTransaction(tx, sim).build();

    // 5. Minta tanda tangan dari wallet (Freighter/Albedo)
    const signedXdr = await wallet.signTransaction(assembled.toXDR());

    // 6. Submit ke jaringan
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const signedTx = TransactionBuilder.fromXDR(signedXdr, sim.latestLedger.toString());
    const result = await rpcServer.sendTransaction(signedTx);

    return result; // { hash, status }
  }

  return { executeSwap };
}
```

### 10.3 Menambah Likuiditas ke Bin

```typescript
import { encodeAddLiquidityBin, buildContractInvocation } from "@/lib/stellar";

async function addLiquidity(
  callerAddress: string,
  binId: number,
  amountXDisplay: string,
  amountYDisplay: string,
  network: "testnet" | "mainnet",
  contractId: string
) {
  const amountX = displayToStroops(amountXDisplay);
  const amountY = displayToStroops(amountYDisplay);

  const args = encodeAddLiquidityBin(callerAddress, binId, amountX, amountY);

  const tx = await buildContractInvocation({
    callerAddress,
    contractId,
    functionName: "add_liquidity_bin",
    args,
    network,
  });

  return tx;
}
```

### 10.4 Read-only: Simulasi Swap

```typescript
import { simulateAndDecode, decodeSwapResult } from "@/lib/stellar";

async function getSwapQuote(
  contractId: string,
  xToY: boolean,
  amountIn: bigint,
  network: "testnet" | "mainnet"
) {
  const args = encodeSwapExactIn("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", xToY, amountIn, 0n);

  const tx = await buildContractInvocation({
    callerAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF", // dummy, view only
    contractId,
    functionName: "simulate_swap",
    args: [xdr.ScVal.scvBool(xToY), nativeToScVal(amountIn, { type: "i128" })],
    network,
  });

  const result = await simulateAndDecode(tx, network);
  if (!result) throw new Error("Simulasi gagal");

  return decodeSwapResult(result as xdr.ScVal);
}
```

### 10.5 Set VITE Environment Variables

Buat `artifacts/stellar-dlmm/.env.local`:

```env
VITE_NETWORK=testnet
VITE_DLMM_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_VAULT_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
VITE_SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
```

Akses di kode:
```typescript
const contractId = import.meta.env.VITE_DLMM_CONTRACT_ID;
const network = import.meta.env.VITE_NETWORK as "testnet" | "mainnet";
```

---

## 11. Integrasi ke API Server

API Server Express (`artifacts/api-server`) saat ini menyajikan data terhitung (computed). Untuk menghubungkan ke kontrak on-chain:

### 11.1 Install Stellar SDK di API Server

```bash
pnpm --filter @workspace/api-server add @stellar/stellar-sdk
```

### 11.2 Contoh Route: Fetch Data On-chain

Buat `artifacts/api-server/src/lib/soroban.ts`:

```typescript
import {
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  nativeToScVal,
  BASE_FEE,
} from "@stellar/stellar-sdk";

const RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";
const PASSPHRASE = process.env.NETWORK_PASSPHRASE ?? Networks.TESTNET;
const DLMM_ID = process.env.DLMM_CONTRACT_ID!;

const server = new rpc.Server(RPC_URL);

/** Invoke read-only (simulate only, no signing) */
export async function viewCall(functionName: string, args: unknown[] = []) {
  // Gunakan dummy account untuk view calls
  const dummyAccount = await server.getAccount(
    "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN"
  ).catch(() => null);

  if (!dummyAccount) throw new Error("Tidak bisa fetch dummy account dari RPC");

  const contract = new Contract(DLMM_ID);
  const tx = new TransactionBuilder(dummyAccount, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(contract.call(functionName, ...args.map((a) => nativeToScVal(a))))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(sim.error);
  if (!sim.result) throw new Error("Tidak ada return value");

  return scValToNative(sim.result.retval);
}
```

### 11.3 Gunakan di Route Handler

```typescript
// artifacts/api-server/src/routes/pools.ts
import { viewCall } from "../lib/soroban.js";

router.get("/pools/:poolId/active-bin", async (req, res) => {
  try {
    const activeBin = await viewCall("get_active_bin");
    res.json({ activeBin });
  } catch (err) {
    req.log.error(err, "Failed to fetch active bin");
    res.status(503).json({ error: "RPC tidak tersedia" });
  }
});
```

### 11.4 Environment Variables API Server

Tambahkan ke `artifacts/api-server/.env`:

```env
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
NETWORK_PASSPHRASE=Test SDF Network ; September 2015
DLMM_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
VAULT_CONTRACT_ID=CXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
```

---

## 12. Referensi Fungsi Kontrak

### DLMM (`stellar-dlmm`)

| Fungsi | Parameter | Return | Keterangan |
|---|---|---|---|
| `initialize` | `admin, token_x, token_y, bin_step_bps, base_fee_bps, active_bin_id` | — | Inisialisasi pool, sekali saja |
| `add_liquidity_bin` | `caller, bin_id, amount_x, amount_y` | — | Tambah likuiditas ke bin tertentu |
| `remove_liquidity_bin` | `caller, bin_id` | — | Tarik semua likuiditas dari bin |
| `swap_exact_in_bin` | `caller, x_to_y, amount_in, min_amount_out` | `SwapResult` | Swap dengan slippage guard |
| `simulate_swap` | `x_to_y, amount_in` | `SwapResult` | Read-only quote, tanpa state change |
| `get_active_bin` | — | `i32` | ID bin aktif saat ini |
| `get_bin_reserves` | `bin_id` | `BinReserves` | Reserve token X & Y di bin |
| `get_config` | — | `PoolConfig` | Konfigurasi pool lengkap |

### Math (`stellar-dlmm-math`)

| Fungsi | Parameter | Return | Keterangan |
|---|---|---|---|
| `get_bin_price` | `bin_step_bps, offset` | `i128` | Harga bin dalam fixed-point 10^18 |
| `get_dynamic_fee` | `base_fee_bps, seconds_since_last_trade` | `i128` | Fee efektif dalam bps |

### Vault (`stellar-dlmm-vault`)

| Fungsi | Parameter | Return | Keterangan |
|---|---|---|---|
| `initialize` | `admin, asset, deposit_cap, performance_fee_bps` | — | Setup vault |
| `deposit` | `depositor, amount` | `i128` (shares) | Deposit aset, terima shares |
| `withdraw` | `caller, shares` | `i128` (assets) | Tukar shares → aset |
| `allocate_to_yield` | `amount` | — | Admin: alokasi ke yield integration |
| `nav_per_share` | — | `i128` | NAV per share (7-decimal fixed) |
| `balance_of` | `addr` | `i128` | Share balance suatu address |
| `total_assets` | — | `i128` | Total aset di vault |

### Tipe Data

```rust
// SwapResult — dikembalikan oleh swap_exact_in_bin & simulate_swap
struct SwapResult {
  amount_out:   i128,  // Output token diterima (stroops, 7 decimal)
  fee_paid:     i128,  // Total fee dipotong (stroops)
  bins_crossed: u32,   // Jumlah bin yang dilintasi
  final_bin:    i32,   // Active bin setelah swap
}

// BinReserves — reserve per bin
struct BinReserves {
  reserve_x: i128,  // Token X di bin ini (SCALAR 10^18)
  reserve_y: i128,  // Token Y di bin ini (SCALAR 10^18)
}

// PoolConfig — konfigurasi pool
struct PoolConfig {
  token_x:       Address,  // SAC address token base
  token_y:       Address,  // SAC address token quote
  bin_step_bps:  i128,     // Jarak harga antar bin (bps)
  base_fee_bps:  i128,     // Fee dasar sebelum volatility adjustment
  admin:         Address,  // Admin pool
}
```

### Unit Angka

| Konteks | Satuan | Contoh |
|---|---|---|
| Token amounts di kontrak | Stroops (10^7) | `1 XLM = 10_000_000` |
| Fixed-point math (SCALAR) | 10^18 | `1.0 = 1_000_000_000_000_000_000` |
| Fee | Basis points (bps) | `25 bps = 0.25%` |
| Bin prices | SCALAR-scaled i128 | `bin_price(25, 0) = SCALAR` |

---

## 13. Troubleshooting

### Error: `wasm32-unknown-unknown target not found`
```bash
rustup target add wasm32-unknown-unknown
```

### Error: `error[E0463]: can't find crate for 'std'`
Pastikan `#![no_std]` ada di `lib.rs` dan dependency soroban-sdk sudah benar.

### Error: `Host function not enabled` saat invoke
Pastikan menggunakan Soroban RPC endpoint, bukan Horizon:
- **Benar:** `https://soroban-testnet.stellar.org`
- **Salah:** `https://horizon-testnet.stellar.org`

### Error: `account not found` saat simulasi di frontend
Account perlu minimal 1 XLM sebagai base reserve dan ada di ledger:
```bash
stellar keys fund <address> --network testnet
```

### Error: `already initialized` saat `initialize`
Kontrak sudah di-initialize sebelumnya. Deploy instance kontrak baru:
```bash
stellar contract deploy --wasm ... --source admin --network testnet
```

### Error: `bin offset exceeds maximum` (MAX_BIN_OFFSET = 500)
Jaga `bin_id` dalam range `[active_bin - 500, active_bin + 500]`.

### Error: `slippage: insufficient output`
Output aktual lebih kecil dari `min_amount_out`. Kurangi parameter slippage atau perbesar toleransi.

### Build WASM terlalu besar (>300 KB)
Pastikan profil release menggunakan konfigurasi di `contracts/Cargo.toml`:
```toml
[profile.release]
opt-level = "z"
lto = true
codegen-units = 1
strip = "symbols"
```

### Freighter tidak terdeteksi di browser
Extension harus diinstall dan diizinkan untuk domain yang diakses. Cek dengan:
```javascript
console.log(typeof window.freighter); // harus "object"
```

### Transaksi gagal dengan `tx_bad_seq`
Nonce/sequence number account sudah kadaluarsa. Fetch ulang account sebelum build transaksi — `buildContractInvocation()` sudah menangani ini otomatis via `rpcServer.getAccount()`.

---

## Checklist Deploy

### Testnet / Devnet
- [ ] `rustup target add wasm32-unknown-unknown`
- [ ] `cargo build --target wasm32-unknown-unknown --release` sukses
- [ ] `cargo test` semua lulus
- [ ] Akun admin sudah difund via Friendbot
- [ ] `stellar contract deploy` DLMM berhasil → simpan Contract ID
- [ ] `stellar contract deploy` Vault berhasil → simpan Contract ID
- [ ] `initialize` pool berhasil (cek `get_config`)
- [ ] Contract IDs diset di `.env.local` frontend dan `.env` api-server

### Mainnet (Tambahan)
- [ ] Audit keamanan kontrak selesai
- [ ] Akun admin mainnet punya cukup XLM (minimal 50 XLM untuk storage deposit)
- [ ] Deploy di testnet sudah berjalan stabil minimal 1 minggu
- [ ] Contract IDs mainnet diset terpisah dari testnet
- [ ] Monitoring event SWAP, ADD_LIQ, REM_LIQ aktif
