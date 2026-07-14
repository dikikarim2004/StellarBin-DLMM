/**
 * Real on-chain / on-network data reader for the Pools & Positions pages.
 *
 * Two live sources, no mock data:
 *   1. Our deployed DLMM Soroban contract — read via read-only RPC simulation
 *      (list_pools / get_config / get_active_bin / get_bins / get_positions /
 *      get_protocol_fee_bps). No signing. The contract hosts a MULTI-POOL
 *      registry: `list_pools()` returns every pool_id ever created via
 *      `create_pool`, and every other view takes a `pool_id` argument.
 *   2. Native Stellar DEX liquidity pools — read from Horizon /liquidity_pools
 *      (the "AMM from Stellar DEX" aggregator category).
 *
 * USD valuation uses the real XLM spot price from CoinGecko. Any figure we do
 * not actually index on-chain (24h volume / fees / APR) is reported as
 * unavailable (volumeAvailable=false) rather than fabricated.
 */

import {
  Address,
  BASE_FEE,
  Contract,
  Networks,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Config (public testnet values; overridable via env)
// ---------------------------------------------------------------------------

const RPC_URL = process.env["STELLAR_RPC_URL"] ?? "https://soroban-testnet.stellar.org";
const HORIZON_URL = process.env["STELLAR_HORIZON_URL"] ?? "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

const DLMM_CONTRACT_ID =
  process.env["DLMM_CONTRACT_ID"] ?? "CCW5MVYJFJPBJNJY7GN6BHC5BQR47RXVIM2T2X4F3YSQC7MQ7J4GNESH";
const NATIVE_XLM_SAC =
  process.env["TOKEN_X_ADDRESS"] ?? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const TESTUSD_SAC =
  process.env["TOKEN_Y_ADDRESS"] ?? "CCA733ILFGI7SESYWNBYTKHUJTJTSU2ORRT6SFNSDZWHYSE4WDLLDUND";

// A funded, publicly-known testnet account used only to satisfy Soroban's
// requirement for a source account when simulating read-only calls. No funds
// move and no signature is required for read-only invocations.
const SOURCE_ACCOUNT =
  process.env["QUOTE_SOURCE_ACCOUNT"] ?? "GD3HFFCVSBBQSHHXJGJLSRCAFTGRT5XFHSGCC2U7BDKBFPQWZWITDWQ2";

/** Builds the string pool id used across the API/frontend for a DLMM registry pool_id. */
export function dlmmPoolRecordId(poolId: number): string {
  return `dlmm-${poolId}`;
}

/** Parses a `dlmm-<n>` string id back into the numeric registry pool_id, or null. */
function parseDlmmPoolRecordId(id: string): number | null {
  const m = /^dlmm-(\d+)$/.exec(id);
  return m ? Number(m[1]) : null;
}

const SCALAR = 7; // token decimals (stroops → display units = 10^7)
const XLM_LOGO =
  "https://assets.coingecko.com/coins/images/100/small/Stellar_symbol_black_RGB.png";
const USD_LOGO = "https://assets.coingecko.com/coins/images/6319/small/USD_Coin_icon.png";

// ---------------------------------------------------------------------------
// Types mirroring the OpenAPI schemas we produce
// ---------------------------------------------------------------------------

interface Token {
  symbol: string;
  name: string;
  address: string;
  decimals: number;
  price: number;
  priceChange24h?: number;
  logoUrl: string;
}

export interface PoolRecord {
  id: string;
  category: "dlmm" | "amm";
  tokenX: Token;
  tokenY: Token;
  tvl: number;
  volume24h: number;
  fees24h: number;
  apr: number;
  binStep: number;
  activeBinId: number;
  currentPrice?: number;
  fee?: number;
  reserveX?: number;
  reserveY?: number;
  totalShares?: number;
  externalUrl?: string;
  volumeAvailable: boolean;
  contractAddress?: string;
  totalBins?: number;
  dlmmPoolId?: number;
  isLaunchPool?: boolean;
  activationTs?: number;
  protocolFeeBps?: number;
  lpFeeBps?: number;
}

export interface BinRecord {
  binId: number;
  price: number;
  liquidityX: number;
  liquidityY: number;
  isActive: boolean;
  totalLiquidity: number;
}

export interface PositionRecord {
  id: string;
  poolId: string;
  pool: PoolRecord;
  address: string;
  binId: number;
  binRangeLow: number;
  binRangeHigh: number;
  shares: number;
  liquidityX: number;
  liquidityY: number;
  valueUsd: number;
  unrealizedFees: number;
}

// ---------------------------------------------------------------------------
// Small TTL caches
// ---------------------------------------------------------------------------

function memoize<T>(ttlMs: number, fn: () => Promise<T>): () => Promise<T> {
  let value: T | undefined;
  let expiresAt = 0;
  let inflight: Promise<T> | null = null;
  return async () => {
    if (value !== undefined && Date.now() < expiresAt) return value;
    if (inflight) return inflight;
    inflight = fn()
      .then((v) => {
        value = v;
        expiresAt = Date.now() + ttlMs;
        inflight = null;
        return v;
      })
      .catch((err) => {
        inflight = null;
        throw err;
      });
    return inflight;
  };
}

// ---------------------------------------------------------------------------
// Numeric helpers
// ---------------------------------------------------------------------------

function fromStroops(v: bigint | number): number {
  return Number(v) / 10 ** SCALAR;
}

/** DLMM bin price: (1 + binStep/10000)^binId, matching the contract's curve. */
function binPrice(binStepBps: number, binId: number): number {
  return Math.pow(1 + binStepBps / 10_000, binId);
}

// ---------------------------------------------------------------------------
// Soroban RPC (read-only simulation)
// ---------------------------------------------------------------------------

let rpcServer: rpc.Server | null = null;
function getRpc(): rpc.Server {
  if (!rpcServer) rpcServer = new rpc.Server(RPC_URL, { allowHttp: false });
  return rpcServer;
}

async function simRead(fn: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const server = getRpc();
  const account = await server.getAccount(SOURCE_ACCOUNT);
  const contract = new Contract(DLMM_CONTRACT_ID);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(fn, ...args))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`DLMM ${fn} simulation failed: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error(`DLMM ${fn} simulation returned no result`);
  }
  return scValToNative(sim.result.retval);
}

function poolIdArg(poolId: number): xdr.ScVal {
  return xdr.ScVal.scvU64(xdr.Uint64.fromString(String(poolId)));
}

interface RawConfig {
  admin: string;
  token_x: string;
  token_y: string;
  bin_step_bps: bigint | number;
  base_fee_bps: bigint | number;
  activation_ts: bigint | number;
}
interface RawBin {
  bin_id: number;
  reserve_x: bigint;
  reserve_y: bigint;
}
interface RawPosition {
  bin_id: number;
  shares: bigint;
  total_shares: bigint;
  amount_x: bigint;
  amount_y: bigint;
}

// ---------------------------------------------------------------------------
// XLM spot price (CoinGecko), cached
// ---------------------------------------------------------------------------

const getXlmPrice = memoize(60_000, async (): Promise<number> => {
  const res = await fetch(
    "https://api.coingecko.com/api/v3/simple/price?ids=stellar&vs_currencies=usd",
    { signal: AbortSignal.timeout(8_000) },
  );
  if (!res.ok) throw new Error(`CoinGecko price fetch failed: ${res.status}`);
  const json = (await res.json()) as { stellar?: { usd?: number } };
  const price = json.stellar?.usd;
  if (typeof price !== "number" || !(price > 0)) {
    throw new Error("CoinGecko returned no usable XLM price");
  }
  return price;
});

// ---------------------------------------------------------------------------
// Token builders
// ---------------------------------------------------------------------------

function xlmToken(price: number): Token {
  return {
    symbol: "XLM",
    name: "Stellar Lumens",
    address: "native",
    decimals: 7,
    price,
    priceChange24h: 0,
    logoUrl: XLM_LOGO,
  };
}

function testUsdToken(): Token {
  return {
    symbol: "TESTUSD",
    name: "Test USD (testnet SAC)",
    address: TESTUSD_SAC,
    decimals: 7,
    price: 1,
    priceChange24h: 0,
    logoUrl: USD_LOGO,
  };
}

/** Resolves a contract token address to a display Token. Falls back to a
 * generic entry (no reliable USD price) for tokens created via `create_pool`
 * that aren't one of the two seeded testnet assets. */
function tokenFromAddress(address: string, xlmPrice: number): Token {
  if (address === NATIVE_XLM_SAC) return xlmToken(xlmPrice);
  if (address === TESTUSD_SAC) return testUsdToken();
  return {
    symbol: `${address.slice(0, 4)}…${address.slice(-4)}`,
    name: "Custom token",
    address,
    decimals: 7,
    price: 0,
    priceChange24h: 0,
    logoUrl: "",
  };
}

// ---------------------------------------------------------------------------
// DLMM registry (our contract) — real on-chain reads, multi-pool
// ---------------------------------------------------------------------------

const getProtocolFeeBps = memoize(60_000, async (): Promise<number> => {
  const raw = (await simRead("get_protocol_fee_bps")) as bigint | number;
  return Number(raw);
});

const getDlmmPoolIds = memoize(15_000, async (): Promise<number[]> => {
  const raw = (await simRead("list_pools")) as (bigint | number)[];
  return raw.map((id) => Number(id));
});

async function readDlmmPool(poolId: number): Promise<PoolRecord> {
  const [config, activeBinRaw, binsRaw, xlmPrice, protocolFeeBps] = await Promise.all([
    simRead("get_config", [poolIdArg(poolId)]) as Promise<RawConfig>,
    simRead("get_active_bin", [poolIdArg(poolId)]) as Promise<number>,
    simRead("get_bins", [poolIdArg(poolId)]) as Promise<RawBin[]>,
    getXlmPrice(),
    getProtocolFeeBps(),
  ]);

  const binStep = Number(config.bin_step_bps);
  const baseFeeBps = Number(config.base_fee_bps);
  const activeBinId = Number(activeBinRaw);
  const activationTs = Number(config.activation_ts ?? 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const isLaunchPool = activationTs > 0;

  const tokenX = tokenFromAddress(config.token_x, xlmPrice);
  const tokenY = tokenFromAddress(config.token_y, xlmPrice);

  let reserveX = 0;
  let reserveY = 0;
  for (const b of binsRaw) {
    reserveX += fromStroops(b.reserve_x);
    reserveY += fromStroops(b.reserve_y);
  }

  const tvl = reserveX * tokenX.price + reserveY * tokenY.price;

  return {
    id: dlmmPoolRecordId(poolId),
    category: "dlmm",
    tokenX,
    tokenY,
    tvl,
    volume24h: 0,
    fees24h: 0,
    apr: 0,
    binStep,
    activeBinId,
    currentPrice: binPrice(binStep, activeBinId),
    fee: baseFeeBps / 10_000,
    reserveX,
    reserveY,
    volumeAvailable: false,
    contractAddress: DLMM_CONTRACT_ID,
    totalBins: binsRaw.length,
    dlmmPoolId: poolId,
    isLaunchPool: isLaunchPool && nowSec < activationTs,
    activationTs,
    protocolFeeBps,
    lpFeeBps: 10_000 - protocolFeeBps,
  };
}

const dlmmPoolCache = new Map<number, ReturnType<typeof memoize<PoolRecord>>>();
function getDlmmPool(poolId: number): Promise<PoolRecord> {
  let cached = dlmmPoolCache.get(poolId);
  if (!cached) {
    cached = memoize(15_000, () => readDlmmPool(poolId));
    dlmmPoolCache.set(poolId, cached);
  }
  return cached();
}

async function getAllDlmmPools(): Promise<PoolRecord[]> {
  const ids = await getDlmmPoolIds();
  return Promise.all(ids.map((id) => getDlmmPool(id)));
}

/** Real bin distribution for a DLMM pool from get_bins. */
async function readDlmmBins(poolId: number): Promise<BinRecord[]> {
  const [config, activeBinRaw, binsRaw, xlmPrice] = await Promise.all([
    simRead("get_config", [poolIdArg(poolId)]) as Promise<RawConfig>,
    simRead("get_active_bin", [poolIdArg(poolId)]) as Promise<number>,
    simRead("get_bins", [poolIdArg(poolId)]) as Promise<RawBin[]>,
    getXlmPrice(),
  ]);
  const binStep = Number(config.bin_step_bps);
  const activeBinId = Number(activeBinRaw);
  const tokenX = tokenFromAddress(config.token_x, xlmPrice);
  const tokenY = tokenFromAddress(config.token_y, xlmPrice);

  return binsRaw
    .map((b) => {
      const binId = Number(b.bin_id);
      const liquidityX = fromStroops(b.reserve_x);
      const liquidityY = fromStroops(b.reserve_y);
      const price = binPrice(binStep, binId);
      return {
        binId,
        price,
        liquidityX,
        liquidityY,
        isActive: binId === activeBinId,
        totalLiquidity: liquidityX * tokenX.price + liquidityY * tokenY.price,
      };
    })
    .sort((a, b) => a.binId - b.binId);
}

const dlmmBinsCache = new Map<number, ReturnType<typeof memoize<BinRecord[]>>>();
function getDlmmBins(poolId: number): Promise<BinRecord[]> {
  let cached = dlmmBinsCache.get(poolId);
  if (!cached) {
    cached = memoize(15_000, () => readDlmmBins(poolId));
    dlmmBinsCache.set(poolId, cached);
  }
  return cached();
}

/** Real per-user LP positions across every DLMM registry pool. Empty array if none. */
export async function getUserPositions(address: string): Promise<PositionRecord[]> {
  let addressScVal: xdr.ScVal;
  try {
    addressScVal = Address.fromString(address).toScVal();
  } catch {
    return [];
  }

  const poolIds = await getDlmmPoolIds();
  const perPool = await Promise.all(
    poolIds.map(async (poolId) => {
      const [positionsRaw, pool] = await Promise.all([
        simRead("get_positions", [poolIdArg(poolId), addressScVal]) as Promise<RawPosition[]>,
        getDlmmPool(poolId),
      ]);

      return positionsRaw.map((p) => {
        const binId = Number(p.bin_id);
        const liquidityX = fromStroops(p.amount_x);
        const liquidityY = fromStroops(p.amount_y);
        return {
          id: `${address.slice(0, 6)}-pool${poolId}-bin${binId}`,
          poolId: dlmmPoolRecordId(poolId),
          pool,
          address,
          binId,
          binRangeLow: binId,
          binRangeHigh: binId,
          shares: fromStroops(p.shares),
          liquidityX,
          liquidityY,
          valueUsd: liquidityX * pool.tokenX.price + liquidityY * pool.tokenY.price,
          // Trading fees auto-compound into a bin's reserves in this model, so a
          // position's claimable amount already includes accrued fees — there is
          // no separately-tracked "unrealized fee" balance to report.
          unrealizedFees: 0,
        };
      });
    }),
  );

  return perPool.flat().sort((a, b) => a.binId - b.binId);
}

// ---------------------------------------------------------------------------
// Recent swaps — real SWAP events published by swap_exact_in_bin, read via
// Soroban RPC getEvents. Not realtime: cached briefly and fetched on demand.
// ---------------------------------------------------------------------------

export interface RecentSwapRecord {
  txHash: string;
  timestamp: string;
  address: string;
  xToY: boolean;
  amountIn: string;
  amountOut: string;
  feePaid: string;
}

// Public testnet RPC providers only retain getEvents history for roughly a
// day; stay comfortably inside that window rather than requesting the full
// ledger range.
const RECENT_SWAP_LOOKBACK_LEDGERS = 9_000;

async function readRecentSwaps(poolId: number): Promise<RecentSwapRecord[]> {
  const server = getRpc();
  const latest = await server.getLatestLedger();
  const startLedger = Math.max(1, latest.sequence - RECENT_SWAP_LOOKBACK_LEDGERS);
  const swapTopic = xdr.ScVal.scvSymbol("SWAP").toXDR("base64");

  const response = await server.getEvents({
    startLedger,
    filters: [
      {
        type: "contract",
        contractIds: [DLMM_CONTRACT_ID],
        topics: [[swapTopic, "*", "*"]],
      },
    ],
    limit: 200,
  });

  const targetPoolId = String(poolId);
  const swaps: RecentSwapRecord[] = [];
  for (const evt of response.events) {
    try {
      const topics = evt.topic.map((t) => scValToNative(t)) as [unknown, bigint | number, boolean];
      if (String(topics[1]) !== targetPoolId) continue;
      const xToY = Boolean(topics[2]);
      const [address, spent, totalOut, totalFee] = scValToNative(evt.value) as [
        string,
        bigint,
        bigint,
        bigint,
        bigint,
      ];
      swaps.push({
        txHash: evt.txHash,
        timestamp: evt.ledgerClosedAt,
        address,
        xToY,
        amountIn: String(spent),
        amountOut: String(totalOut),
        feePaid: String(totalFee),
      });
    } catch {
      // Skip any event we can't decode rather than fail the whole request.
    }
  }

  swaps.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
  return swaps.slice(0, 20);
}

const recentSwapsCache = new Map<number, ReturnType<typeof memoize<RecentSwapRecord[]>>>();
function getRecentSwapsForPool(poolId: number): Promise<RecentSwapRecord[]> {
  let cached = recentSwapsCache.get(poolId);
  if (!cached) {
    cached = memoize(30_000, () => readRecentSwaps(poolId));
    recentSwapsCache.set(poolId, cached);
  }
  return cached();
}

/** Recent on-chain swaps for a `dlmm-<n>` pool record id, or null if it isn't a DLMM pool. */
export async function getRecentSwaps(poolId: string): Promise<RecentSwapRecord[] | null> {
  const dlmmId = parseDlmmPoolRecordId(poolId);
  if (dlmmId === null) return null;
  return getRecentSwapsForPool(dlmmId);
}

// ---------------------------------------------------------------------------
// AMM pools (native Stellar DEX) — Horizon aggregator
// ---------------------------------------------------------------------------

interface HorizonReserve {
  asset: string;
  amount: string;
}
interface HorizonPool {
  id: string;
  fee_bp: number;
  total_shares: string;
  reserves: HorizonReserve[];
}

function parseAsset(asset: string, xlmPrice: number): Token {
  if (asset === "native") return xlmToken(xlmPrice);
  const [code, issuer] = asset.split(":");
  return {
    symbol: code ?? asset,
    name: code ?? asset,
    address: issuer ?? asset,
    decimals: 7,
    price: 0, // arbitrary testnet asset — no reliable USD price
    priceChange24h: 0,
    logoUrl: "",
  };
}

async function readAmmPools(): Promise<PoolRecord[]> {
  const xlmPrice = await getXlmPrice();
  const res = await fetch(`${HORIZON_URL}/liquidity_pools?limit=200&order=desc`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Horizon liquidity_pools fetch failed: ${res.status}`);
  const json = (await res.json()) as { _embedded?: { records?: HorizonPool[] } };
  const records = json._embedded?.records ?? [];

  const pools: PoolRecord[] = [];
  for (const r of records) {
    if (!Array.isArray(r.reserves) || r.reserves.length !== 2) continue;
    const nativeIdx = r.reserves.findIndex((x) => x.asset === "native");
    if (nativeIdx === -1) continue; // only pools we can value in USD (contain XLM)

    const nativeAmt = parseFloat(r.reserves[nativeIdx]!.amount);
    const other = r.reserves[1 - nativeIdx]!;
    const otherAmt = parseFloat(other.amount);
    if (!(nativeAmt > 0) || !(otherAmt > 0)) continue;

    // Constant-product pools hold equal value on both sides, so TVL ≈ 2× the
    // XLM side valued at spot. This is a real figure, not a fabricated one.
    const tvl = 2 * nativeAmt * xlmPrice;

    pools.push({
      id: r.id,
      category: "amm",
      tokenX: xlmToken(xlmPrice),
      tokenY: parseAsset(other.asset, xlmPrice),
      tvl,
      volume24h: 0,
      fees24h: 0,
      apr: 0,
      binStep: 0,
      activeBinId: 0,
      currentPrice: otherAmt / nativeAmt,
      fee: (r.fee_bp ?? 30) / 10_000,
      reserveX: nativeAmt,
      reserveY: otherAmt,
      totalShares: parseFloat(r.total_shares),
      externalUrl: `https://stellar.expert/explorer/testnet/liquidity-pool/${r.id}`,
      volumeAvailable: false,
    });
  }

  pools.sort((a, b) => b.tvl - a.tvl);
  return pools.slice(0, 12);
}

const getAmmPools = memoize(60_000, readAmmPools);

// ---------------------------------------------------------------------------
// Public aggregation API
// ---------------------------------------------------------------------------

export async function getAllPools(): Promise<PoolRecord[]> {
  const [dlmm, amm] = await Promise.all([getAllDlmmPools(), getAmmPools()]);
  return [...dlmm, ...amm];
}

export async function getPoolById(poolId: string): Promise<PoolRecord | null> {
  const dlmmId = parseDlmmPoolRecordId(poolId);
  if (dlmmId !== null) {
    const ids = await getDlmmPoolIds();
    if (!ids.includes(dlmmId)) return null;
    return getDlmmPool(dlmmId);
  }
  const amm = await getAmmPools();
  return amm.find((p) => p.id === poolId) ?? null;
}

export async function getPoolBins(poolId: string): Promise<BinRecord[] | null> {
  const dlmmId = parseDlmmPoolRecordId(poolId);
  if (dlmmId === null) return null; // only DLMM pools have discrete bins
  return getDlmmBins(dlmmId);
}

export async function getProtocolSummary() {
  const pools = await getAllPools();
  return {
    totalTvl: pools.reduce((s, p) => s + p.tvl, 0),
    totalVolume24h: 0,
    totalFees24h: 0,
    totalPools: pools.length,
    totalTransactions24h: 0,
  };
}
