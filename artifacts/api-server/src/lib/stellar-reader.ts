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
  Asset,
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
  process.env["DLMM_CONTRACT_ID"] ?? "CBDH7LWCS4JOTA5EWXQISZGFE3CIUUYILYTPLS7Y5L3JDPV7MSLSTAKP";
const NATIVE_XLM_SAC =
  process.env["TOKEN_X_ADDRESS"] ?? "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC_SAC =
  process.env["TOKEN_Y_ADDRESS"] ?? "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const LEGACY_USDC_SAC = "CCTKVL3VAWCBY64NVXSQI7AMESCWXOWGGICYNZUTBSIKYXVEWFIBPD7N";

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
  valueXlm?: number;
  claimableFeesXlm?: number;
  claimableFeeX: number;
  claimableFeeY: number;
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

async function getLatestLedgerSequence(): Promise<number> {
  const response = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" }),
  });
  if (!response.ok) {
    throw new Error(`Soroban RPC getLatestLedger failed: HTTP ${response.status}`);
  }

  const result = (await response.json()) as {
    result?: { sequence?: number };
    error?: { message?: string };
  };
  if (result.error) {
    throw new Error(result.error.message ?? "Soroban RPC getLatestLedger failed");
  }

  const sequence = result.result?.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence)) {
    throw new Error("Soroban RPC returned an invalid latest ledger sequence");
  }
  return sequence;
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
  creator?: string;
  token_x: string;
  token_y: string;
  bin_step_bps: bigint | number;
  base_factor?: bigint | number;
  base_fee_power_factor?: bigint | number;
  base_fee_bps?: bigint | number;
  protocol_share_bps?: bigint | number;
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
  claimable_fee_x?: bigint;
  claimable_fee_y?: bigint;
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

function usdcToken(address = USDC_SAC): Token {
  return {
    symbol: "USDC",
    name: address === LEGACY_USDC_SAC ? "USDC (legacy Testnet)" : "USDC (Soroban Testnet)",
    address,
    decimals: 7,
    price: 1,
    priceChange24h: 0,
    logoUrl: USD_LOGO,
  };
}

// ---------------------------------------------------------------------------
// SEP-41 token metadata resolution (symbol / name via on-chain call)
// ---------------------------------------------------------------------------

/** In-memory cache: contract address → { symbol, name } */
const tokenMetaCache = new Map<string, { symbol: string; name: string }>();

/**
 * Calls the SEP-41 `symbol()` (and optionally `name()`) function on any
 * Soroban token contract. All SAC contracts implement these, so XLM/USDC
 * and any custom token created via `stellar contract asset deploy` will work.
 * Results are cached permanently for the lifetime of the server process.
 */
async function fetchTokenMeta(contractAddress: string): Promise<{ symbol: string; name: string }> {
  const cached = tokenMetaCache.get(contractAddress);
  if (cached) return cached;

  async function callStringFn(fn: string): Promise<string | null> {
    try {
      const server = getRpc();
      const account = await server.getAccount(SOURCE_ACCOUNT);
      const contract = new Contract(contractAddress);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call(fn))
        .setTimeout(30)
        .build();
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim) || !sim.result) return null;
      const val = scValToNative(sim.result.retval);
      return typeof val === "string" && val.length > 0 ? val : null;
    } catch {
      return null;
    }
  }

  const [symbol, name] = await Promise.all([
    callStringFn("symbol"),
    callStringFn("name"),
  ]);

  const shortAddr = `${contractAddress.slice(0, 4)}…${contractAddress.slice(-4)}`;
  const meta = {
    symbol: symbol ?? shortAddr,
    name: name ?? symbol ?? "Custom token",
  };
  tokenMetaCache.set(contractAddress, meta);
  return meta;
}

/** Resolves a contract token address to a display Token.
 * For known tokens (XLM, USDC) returns immediately.
 * For custom tokens calls symbol()/name() on-chain (cached). */
async function resolveToken(address: string, xlmPrice: number): Promise<Token> {
  if (address === NATIVE_XLM_SAC) return xlmToken(xlmPrice);
  if (address === USDC_SAC || address === LEGACY_USDC_SAC) return usdcToken(address);
  const meta = await fetchTokenMeta(address);
  return {
    symbol: meta.symbol,
    name: meta.name,
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

const getDlmmPoolIds = memoize(15_000, async (): Promise<number[]> => {
  const raw = (await simRead("list_pools")) as (bigint | number)[];
  return raw.map((id) => Number(id));
});

const getLegacyProtocolFeeBps = memoize(60_000, async (): Promise<number> => {
  const raw = (await simRead("get_protocol_fee_bps")) as bigint | number;
  return Number(raw);
});

async function readDlmmPool(poolId: number): Promise<PoolRecord> {
  const [config, activeBinRaw, binsRaw, xlmPrice] = await Promise.all([
    simRead("get_config", [poolIdArg(poolId)]) as Promise<RawConfig>,
    simRead("get_active_bin", [poolIdArg(poolId)]) as Promise<number>,
    simRead("get_bins", [poolIdArg(poolId)]) as Promise<RawBin[]>,
    getXlmPrice(),
  ]);

  const binStep = Number(config.bin_step_bps);
  const baseFeeRate = config.base_factor !== undefined
    ? Math.min(
        Number(config.base_factor) * binStep * 10 * 10 ** Number(config.base_fee_power_factor ?? 0),
        100_000_000,
      )
    : Number(config.base_fee_bps ?? 0) * 100_000;
  const protocolFeeBps = config.protocol_share_bps !== undefined
    ? Number(config.protocol_share_bps)
    : await getLegacyProtocolFeeBps();
  const activeBinId = Number(activeBinRaw);
  const activationTs = Number(config.activation_ts ?? 0);
  const nowSec = Math.floor(Date.now() / 1000);
  const isLaunchPool = activationTs > 0;

  const [tokenX, tokenY] = await Promise.all([
    resolveToken(config.token_x, xlmPrice),
    resolveToken(config.token_y, xlmPrice),
  ]);

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
    fee: baseFeeRate / 1_000_000_000,
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
  const [tokenX, tokenY] = await Promise.all([
    resolveToken(config.token_x, xlmPrice),
    resolveToken(config.token_y, xlmPrice),
  ]);

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
        const claimableFeeX = fromStroops(p.claimable_fee_x ?? 0n);
        const claimableFeeY = fromStroops(p.claimable_fee_y ?? 0n);
        const binPrice = Math.pow(1 + pool.binStep / 10_000, binId);
        const xlmUsdPrice = pool.tokenX.symbol === "XLM"
          ? pool.tokenX.price
          : pool.tokenY.symbol === "XLM"
          ? pool.tokenY.price
          : 0;
        let valueXlm: number | undefined;
        let claimableFeesXlm: number | undefined;
        if (pool.tokenX.address === "native") {
          valueXlm = liquidityX + liquidityY / binPrice;
          claimableFeesXlm = claimableFeeX + claimableFeeY / binPrice;
        } else if (pool.tokenY.address === "native") {
          valueXlm = liquidityY + liquidityX * binPrice;
          claimableFeesXlm = claimableFeeY + claimableFeeX * binPrice;
        } else if (xlmUsdPrice > 0) {
          const valueUsd = liquidityX * pool.tokenX.price + liquidityY * pool.tokenY.price;
          const claimableUsd = claimableFeeX * pool.tokenX.price + claimableFeeY * pool.tokenY.price;
          if (valueUsd > 0) valueXlm = valueUsd / xlmUsdPrice;
          if (claimableUsd > 0) claimableFeesXlm = claimableUsd / xlmUsdPrice;
        }
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
          unrealizedFees:
            claimableFeeX * pool.tokenX.price + claimableFeeY * pool.tokenY.price,
          valueXlm,
          claimableFeesXlm,
          claimableFeeX,
          claimableFeeY,
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
  const latestSequence = await getLatestLedgerSequence();
  const startLedger = Math.max(1, latestSequence - RECENT_SWAP_LOOKBACK_LEDGERS);
  const swapTopic = xdr.ScVal.scvSymbol("SWAP").toXDR("base64");
  const swapOutTopic = xdr.ScVal.scvSymbol("SWAP_OUT").toXDR("base64");

  const response = await server.getEvents({
    startLedger,
    filters: [
      {
        type: "contract",
        contractIds: [DLMM_CONTRACT_ID],
        topics: [
          [swapTopic, "*", "*"],
          [swapOutTopic, "*", "*"],
        ],
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

export interface MarketFlowSourceRecord {
  status: "available" | "unavailable";
  window: string;
  records: number;
  truncated: boolean;
  error: string | null;
}

export interface MarketFlowAssetRecord {
  address: string;
  symbol: string;
  decimals: number;
  dlmmBuy: string;
  dlmmSell: string;
  dlmmTrades: number;
  dexBuy: string;
  dexSell: string;
  dexTrades: number;
  dlmmReserve: string;
}

export interface MarketFlowRecord {
  asOf: string;
  network: "testnet";
  dlmm: MarketFlowSourceRecord;
  dex: MarketFlowSourceRecord;
  assets: MarketFlowAssetRecord[];
}

interface MutableMarketFlowAsset {
  address: string;
  symbol: string;
  dlmmBuy: bigint;
  dlmmSell: bigint;
  dlmmTrades: number;
  dexBuy: bigint;
  dexSell: bigint;
  dexTrades: number;
  dlmmReserve: bigint;
}

interface HorizonTradeRecord {
  ledger_close_time: string;
  base_amount: string;
  base_asset_type: string;
  base_asset_code?: string;
  base_asset_issuer?: string;
  counter_amount: string;
  counter_asset_type: string;
  counter_asset_code?: string;
  counter_asset_issuer?: string;
  base_is_seller: boolean;
}

interface HorizonTradesPage {
  _embedded?: { records?: HorizonTradeRecord[] };
  _links?: { next?: { href?: string } };
}

const MARKET_FLOW_PAGE_SIZE = 200;
const MARKET_FLOW_MAX_PAGES = 20;
const MARKET_FLOW_DEX_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MARKET_FLOW_RAW_SCALE = 10_000_000n;

function amountToRawUnits(amount: string | number): bigint {
  const [whole = "0", fraction = ""] = String(amount).split(".");
  const scaledFraction = fraction.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * MARKET_FLOW_RAW_SCALE + BigInt(scaledFraction || "0");
}

function canonicalPoolTokenAddress(address: string, symbol: string): string {
  if (address === "native" || address === NATIVE_XLM_SAC) return "native";
  if (address.startsWith("G")) {
    try {
      return new Asset(symbol, address).contractId(NETWORK_PASSPHRASE);
    } catch {
      return address;
    }
  }
  return address;
}

function horizonTradeAsset(
  type: string,
  code?: string,
  issuer?: string,
): { address: string; symbol: string } | null {
  if (type === "native") return { address: "native", symbol: "XLM" };
  if (!code || !issuer) return null;
  try {
    return {
      address: new Asset(code, issuer).contractId(NETWORK_PASSPHRASE),
      symbol: code,
    };
  } catch {
    return null;
  }
}

async function readMarketFlowDlmmEvents(): Promise<{
  events: rpc.Api.EventResponse[];
  truncated: boolean;
}> {
  const latestSequence = await getLatestLedgerSequence();
  const startLedger = Math.max(1, latestSequence - RECENT_SWAP_LOOKBACK_LEDGERS);
  const swapTopics = ["SWAP", "SWAP_OUT"].map((name) =>
    xdr.ScVal.scvSymbol(name).toXDR("base64"),
  );
  const filters: rpc.Api.EventFilter[] = [
    {
      type: "contract",
      contractIds: [DLMM_CONTRACT_ID],
      topics: swapTopics.map((topic) => [topic, "*", "*"]),
    },
  ];

  const events: rpc.Api.EventResponse[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < MARKET_FLOW_MAX_PAGES; page++) {
    const response = cursor
      ? await getRpc().getEvents({ filters, cursor, limit: MARKET_FLOW_PAGE_SIZE })
      : await getRpc().getEvents({ filters, startLedger, limit: MARKET_FLOW_PAGE_SIZE });
    events.push(...response.events);
    if (response.events.length < MARKET_FLOW_PAGE_SIZE) break;
    if (page === MARKET_FLOW_MAX_PAGES - 1) {
      truncated = true;
      break;
    }
    if (!response.cursor || response.cursor === cursor) break;
    cursor = response.cursor;
  }
  return { events, truncated };
}

async function readMarketFlowDexTrades(since: number): Promise<{
  trades: HorizonTradeRecord[];
  truncated: boolean;
}> {
  const horizonOrigin = new URL(HORIZON_URL).origin;
  let url = new URL("/trades", HORIZON_URL);
  url.searchParams.set("trade_type", "all");
  url.searchParams.set("order", "desc");
  url.searchParams.set("limit", String(MARKET_FLOW_PAGE_SIZE));

  const trades: HorizonTradeRecord[] = [];
  let truncated = false;
  for (let page = 0; page < MARKET_FLOW_MAX_PAGES; page++) {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Horizon trades request failed: HTTP ${response.status}`);
    const data = (await response.json()) as HorizonTradesPage;
    const records = data._embedded?.records ?? [];
    let reachedWindowStart = false;
    for (const trade of records) {
      const timestamp = Date.parse(trade.ledger_close_time);
      if (!Number.isFinite(timestamp)) continue;
      if (timestamp < since) {
        reachedWindowStart = true;
        break;
      }
      trades.push(trade);
    }
    if (reachedWindowStart || records.length === 0) break;
    if (page === MARKET_FLOW_MAX_PAGES - 1) {
      truncated = true;
      break;
    }

    const nextHref = data._links?.next?.href;
    if (!nextHref) break;
    const nextUrl = new URL(nextHref, HORIZON_URL);
    if (nextUrl.origin !== horizonOrigin) {
      throw new Error("Horizon returned a pagination link for a different host");
    }
    url = nextUrl;
  }
  return { trades, truncated };
}

const getMarketFlowCached = memoize(30_000, async (): Promise<MarketFlowRecord> => {
  const asOf = new Date();
  const dexSince = asOf.getTime() - MARKET_FLOW_DEX_LOOKBACK_MS;
  const dlmm: MarketFlowSourceRecord = {
    status: "available",
    window: "Latest 9,000 ledgers; limited by Soroban RPC retention",
    records: 0,
    truncated: false,
    error: null,
  };
  const dex: MarketFlowSourceRecord = {
    status: "available",
    window: "Last 24 hours of Horizon network trades",
    records: 0,
    truncated: false,
    error: null,
  };
  const assets = new Map<string, MutableMarketFlowAsset>();
  const ensureAsset = (address: string, symbol: string): MutableMarketFlowAsset => {
    let asset = assets.get(address);
    if (!asset) {
      asset = {
        address,
        symbol,
        dlmmBuy: 0n,
        dlmmSell: 0n,
        dlmmTrades: 0,
        dexBuy: 0n,
        dexSell: 0n,
        dexTrades: 0,
        dlmmReserve: 0n,
      };
      assets.set(address, asset);
    }
    return asset;
  };

  try {
    const pools = await getAllDlmmPools();
    const poolsById = new Map(pools.map((pool) => [pool.dlmmPoolId!, pool]));
    for (const pool of pools) {
      const tokenXAddress = canonicalPoolTokenAddress(pool.tokenX.address, pool.tokenX.symbol);
      const tokenYAddress = canonicalPoolTokenAddress(pool.tokenY.address, pool.tokenY.symbol);
      ensureAsset(tokenXAddress, pool.tokenX.symbol).dlmmReserve += amountToRawUnits(pool.reserveX ?? 0);
      ensureAsset(tokenYAddress, pool.tokenY.symbol).dlmmReserve += amountToRawUnits(pool.reserveY ?? 0);
    }

    const { events, truncated } = await readMarketFlowDlmmEvents();
    dlmm.truncated = truncated;
    for (const event of events) {
      try {
        const [eventName, rawPoolId, rawDirection] = event.topic.map((topic) => scValToNative(topic)) as [
          string,
          bigint | number,
          boolean,
        ];
        const pool = poolsById.get(Number(rawPoolId));
        if (!pool || (eventName !== "SWAP" && eventName !== "SWAP_OUT")) continue;
        const [, amountIn, amountOut] = scValToNative(event.value) as [
          string,
          bigint,
          bigint,
          bigint,
          bigint,
        ];
        const tokenIn = rawDirection ? pool.tokenX : pool.tokenY;
        const tokenOut = rawDirection ? pool.tokenY : pool.tokenX;
        const tokenInFlow = ensureAsset(canonicalPoolTokenAddress(tokenIn.address, tokenIn.symbol), tokenIn.symbol);
        const tokenOutFlow = ensureAsset(canonicalPoolTokenAddress(tokenOut.address, tokenOut.symbol), tokenOut.symbol);
        tokenInFlow.dlmmSell += amountIn;
        tokenInFlow.dlmmTrades++;
        tokenOutFlow.dlmmBuy += amountOut;
        tokenOutFlow.dlmmTrades++;
        dlmm.records++;
      } catch {
        // Ignore malformed event payloads while keeping other on-chain records.
      }
    }
  } catch (error) {
    dlmm.status = "unavailable";
    dlmm.error = error instanceof Error ? error.message : "Unable to read DLMM swap events";
  }

  try {
    const { trades, truncated } = await readMarketFlowDexTrades(dexSince);
    dex.truncated = truncated;
    for (const trade of trades) {
      const base = horizonTradeAsset(
        trade.base_asset_type,
        trade.base_asset_code,
        trade.base_asset_issuer,
      );
      const counter = horizonTradeAsset(
        trade.counter_asset_type,
        trade.counter_asset_code,
        trade.counter_asset_issuer,
      );
      if (!base || !counter || typeof trade.base_is_seller !== "boolean") continue;

      const baseFlow = ensureAsset(base.address, base.symbol);
      const counterFlow = ensureAsset(counter.address, counter.symbol);
      const baseAmount = amountToRawUnits(trade.base_amount);
      const counterAmount = amountToRawUnits(trade.counter_amount);
      if (trade.base_is_seller) {
        baseFlow.dexSell += baseAmount;
        counterFlow.dexBuy += counterAmount;
      } else {
        baseFlow.dexBuy += baseAmount;
        counterFlow.dexSell += counterAmount;
      }
      baseFlow.dexTrades++;
      counterFlow.dexTrades++;
      dex.records++;
    }
  } catch (error) {
    dex.status = "unavailable";
    dex.error = error instanceof Error ? error.message : "Unable to read Horizon trades";
  }

  return {
    asOf: asOf.toISOString(),
    network: "testnet",
    dlmm,
    dex,
    assets: [...assets.values()]
      .filter((asset) => asset.dlmmTrades + asset.dexTrades > 0)
      .sort((first, second) => second.dlmmTrades + second.dexTrades - (first.dlmmTrades + first.dexTrades))
      .map((asset) => ({
        address: asset.address,
        symbol: asset.symbol,
        decimals: 7,
        dlmmBuy: String(asset.dlmmBuy),
        dlmmSell: String(asset.dlmmSell),
        dlmmTrades: asset.dlmmTrades,
        dexBuy: String(asset.dexBuy),
        dexSell: String(asset.dexSell),
        dexTrades: asset.dexTrades,
        dlmmReserve: String(asset.dlmmReserve),
      })),
  };
});

export function getMarketFlow(): Promise<MarketFlowRecord> {
  return getMarketFlowCached();
}

export interface PositionEventRecord {
  txHash: string;
  timestamp: string;
  address: string;
  action: "add" | "close" | "claim";
  binId: number;
  amountX: string;
  amountY: string;
  shares: string;
}

const positionEventsCache = new Map<string, ReturnType<typeof memoize<PositionEventRecord[]>>>();

async function readPositionEvents(poolId: number, address: string): Promise<PositionEventRecord[]> {
  const server = getRpc();
  const latest = await server.getLatestLedger();
  const startLedger = Math.max(1, latest.sequence - RECENT_SWAP_LOOKBACK_LEDGERS);
  const eventTypes = [
    { name: "ADD_LIQ", action: "add" as const },
    { name: "REM_LIQ", action: "close" as const },
  ];
  const response = await server.getEvents({
    startLedger,
    filters: eventTypes.map(({ name }) => ({
      type: "contract" as const,
      contractIds: [DLMM_CONTRACT_ID],
      topics: [[xdr.ScVal.scvSymbol(name).toXDR("base64"), "*", "*"]],
    })),
    limit: 200,
  });

  const result: PositionEventRecord[] = [];
  for (const event of response.events) {
    try {
      const [eventName, eventPoolId, eventBinId] = event.topic.map((topic) => scValToNative(topic)) as [
        string,
        bigint | number,
        bigint | number,
      ];
      if (Number(eventPoolId) !== poolId) continue;
      const eventType = eventTypes.find(({ name }) => name === eventName);
      if (!eventType) continue;

      const [eventAddress, amountX, amountY, shares] = scValToNative(event.value) as [
        string,
        bigint,
        bigint,
        bigint,
      ];
      if (eventAddress !== address) continue;

      result.push({
        txHash: event.txHash,
        timestamp: event.ledgerClosedAt,
        address: eventAddress,
        action: eventType.action,
        binId: Number(eventBinId),
        amountX: String(amountX),
        amountY: String(amountY),
        shares: String(shares),
      });
    } catch {
      // Ignore events with an unexpected schema instead of failing history.
    }
  }

  result.sort((left, right) => new Date(right.timestamp).getTime() - new Date(left.timestamp).getTime());
  return result.slice(0, 50);
}

/** Recent add/close events within the testnet RPC retention window. */
export async function getPoolPositionEvents(
  poolId: string,
  address: string
): Promise<PositionEventRecord[] | null> {
  const dlmmId = parseDlmmPoolRecordId(poolId);
  if (dlmmId === null) return null;
  const key = `${dlmmId}:${address}`;
  let cached = positionEventsCache.get(key);
  if (!cached) {
    cached = memoize(30_000, () => readPositionEvents(dlmmId, address));
    positionEventsCache.set(key, cached);
  }
  return cached();
}

export interface PortfolioDailyPnlRecord {
  date: string;
  pnlUsd: number;
  eventCount: number;
}

export interface PortfolioClosedPositionRecord {
  id: string;
  poolId: string;
  poolName: string;
  binId: number;
  openedAt: string;
  closedAt: string;
  deposits: number;
  withdrawn: number;
  feesClaimed: number;
  pnl: number;
  txHash: string;
}

export interface PortfolioSummaryRecord {
  address: string;
  asOf: string;
  historyWindow: string;
  historyTruncated: boolean;
  basisMissingCount: number;
  historicalPriceGapCount: number;
  unpricedPoolCount: number;
  pnlUnit: "USD" | "XLM";
  totalValue: number;
  deposits: number;
  feesClaimed: number;
  claimableFees: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  dailyPnl: PortfolioDailyPnlRecord[];
  closedPositions: PortfolioClosedPositionRecord[];
}

interface PortfolioChainEvent extends PositionEventRecord {
  poolId: number;
  ledger: number;
}

const PORTFOLIO_EVENT_PAGE_SIZE = 200;
const PORTFOLIO_EVENT_MAX_PAGES = 20;

async function readPortfolioEvents(
  poolId: number,
  address: string,
  startLedger: number,
): Promise<{ events: PortfolioChainEvent[]; truncated: boolean }> {
  const eventTypes = [
    { name: "ADD_LIQ", action: "add" as const },
    { name: "REM_LIQ", action: "close" as const },
    { name: "CLAIM_FEE", action: "claim" as const },
  ];
  const poolTopic = poolIdArg(poolId).toXDR("base64");
  const filters: rpc.Api.EventFilter[] = eventTypes.map(({ name }) => ({
    type: "contract",
    contractIds: [DLMM_CONTRACT_ID],
    topics: [[xdr.ScVal.scvSymbol(name).toXDR("base64"), poolTopic, "*"]],
  }));

  const events: PortfolioChainEvent[] = [];
  let cursor: string | undefined;
  let truncated = false;
  for (let page = 0; page < PORTFOLIO_EVENT_MAX_PAGES; page++) {
    const response = cursor
      ? await getRpc().getEvents({ filters, cursor, limit: PORTFOLIO_EVENT_PAGE_SIZE })
      : await getRpc().getEvents({ filters, startLedger, limit: PORTFOLIO_EVENT_PAGE_SIZE });
    for (const event of response.events) {
      try {
        const [eventName, rawPoolId, rawBinId] = event.topic.map((topic) => scValToNative(topic)) as [
          string,
          bigint | number,
          bigint | number,
        ];
        if (Number(rawPoolId) !== poolId) continue;
        const payload = scValToNative(event.value) as [string, bigint, bigint, bigint?];
        const [eventAddress, amountX, amountY, shares = 0n] = payload;
        if (eventAddress !== address) continue;
        const eventType = eventTypes.find((candidate) => candidate.name === eventName);
        if (!eventType) continue;
        events.push({
          poolId,
          ledger: event.ledger,
          txHash: event.txHash,
          timestamp: event.ledgerClosedAt,
          address: eventAddress,
          action: eventType.action,
          binId: Number(rawBinId),
          amountX: String(amountX),
          amountY: String(amountY),
          shares: String(shares),
        });
      } catch {
        // Ignore malformed user events without discarding other portfolio history.
      }
    }
    if (response.events.length < PORTFOLIO_EVENT_PAGE_SIZE) break;
    if (page === PORTFOLIO_EVENT_MAX_PAGES - 1) {
      truncated = true;
      break;
    }
    if (!response.cursor || response.cursor === cursor) {
      truncated = true;
      break;
    }
    cursor = response.cursor;
  }
  events.sort((first, second) => first.ledger - second.ledger);
  return { events, truncated };
}

function rawAmount(value: string): number {
  return Number(BigInt(value)) / 10 ** SCALAR;
}

export async function getPortfolioSummary(address: string): Promise<PortfolioSummaryRecord> {
  const poolRecords = await getAllDlmmPools();
  const poolsById = new Map(poolRecords.map((pool) => [pool.dlmmPoolId!, pool]));
  const positions = await getUserPositions(address);
  const activePoolIds = new Set(positions.map((position) => position.pool.dlmmPoolId));
  const latestLedger = await getLatestLedgerSequence();
  const startLedger = Math.max(1, latestLedger - RECENT_SWAP_LOOKBACK_LEDGERS);
  const poolEvents = await Promise.all(
    poolRecords.map(async (pool) => {
      const { events, truncated } = await readPortfolioEvents(
        pool.dlmmPoolId!,
        address,
        startLedger,
      );
      return { poolId: pool.dlmmPoolId!, events, truncated };
    }),
  );

  const historyTruncated = poolEvents.some((result) => result.truncated);
  const unpricedQuotePoolIds = new Set(
    poolEvents
      .filter((result) => result.events.length > 0 && (poolsById.get(result.poolId)?.tokenY.price ?? 0) <= 0)
      .map((result) => result.poolId),
  );
  for (const poolId of activePoolIds) {
    if (poolId !== undefined && (poolsById.get(poolId)?.tokenY.price ?? 0) <= 0) {
      unpricedQuotePoolIds.add(poolId);
    }
  }
  const pnlUnit: "USD" | "XLM" = unpricedQuotePoolIds.size > 0 ? "XLM" : "USD";
  const xlmUsdPrice = await getXlmPrice();
  const dailyPnl = new Map<string, { pnlUsd: number; eventCount: number }>();
  const closedPositions: PortfolioClosedPositionRecord[] = [];
  const openCycles = new Map<string, {
    pool: PoolRecord;
    binId: number;
    openedAt: string;
    deposits: number;
    feesClaimed: number;
    priced: boolean;
  }>();
  let deposits = 0;
  let feesClaimed = 0;
  let realizedPnl = 0;
  let unpricedPoolCount = 0;
  let basisMissingCount = 0;
  let historicalPriceGapCount = 0;
  const unpricedPoolIds = new Set<number>();

  function valueInPnlUnit(pool: PoolRecord, binId: number, amountX: number, amountY: number): number | null {
    const binPrice = Math.pow(1 + pool.binStep / 10_000, binId);
    if (!(binPrice > 0) || !Number.isFinite(binPrice)) return null;
    if (pnlUnit === "USD") {
      return pool.tokenY.price > 0
        ? (amountX * binPrice + amountY) * pool.tokenY.price
        : null;
    }
    if (pool.tokenX.address === "native" || pool.tokenX.symbol === "XLM") {
      return amountX + amountY / binPrice;
    }
    if (pool.tokenY.address === "native" || pool.tokenY.symbol === "XLM") {
      return amountY + amountX * binPrice;
    }
    if (pool.tokenY.price > 0) {
      return ((amountX * binPrice + amountY) * pool.tokenY.price) / xlmUsdPrice;
    }
    if (pool.tokenX.price > 0) {
      return ((amountX + amountY / binPrice) * pool.tokenX.price) / xlmUsdPrice;
    }
    return null;
  }

  function addDailyPnl(timestamp: string, pnl: number) {
    const date = timestamp.slice(0, 10);
    const day = dailyPnl.get(date) ?? { pnlUsd: 0, eventCount: 0 };
    day.pnlUsd += pnl;
    day.eventCount++;
    dailyPnl.set(date, day);
  }

  for (const result of poolEvents) {
    const pool = poolsById.get(result.poolId);
    if (!pool) continue;
    for (const event of result.events) {
      const key = `${result.poolId}:${event.binId}`;
      const amountX = rawAmount(event.amountX);
      const amountY = rawAmount(event.amountY);
      const eventValue = valueInPnlUnit(pool, event.binId, amountX, amountY);
      let cycle = openCycles.get(key);

      if (event.action === "add") {
        if (!cycle) {
          cycle = {
            pool,
            binId: event.binId,
            openedAt: event.timestamp,
            deposits: 0,
            feesClaimed: 0,
            priced: eventValue !== null,
          };
          openCycles.set(key, cycle);
        }
        if (eventValue === null) {
          cycle.priced = false;
          historicalPriceGapCount++;
          unpricedPoolIds.add(result.poolId);
        } else {
          cycle.deposits += eventValue;
          deposits += eventValue;
        }
      } else if (event.action === "claim") {
        if (eventValue === null) {
          historicalPriceGapCount++;
          unpricedPoolIds.add(result.poolId);
          if (cycle) cycle.priced = false;
          continue;
        }
        feesClaimed += eventValue;
        realizedPnl += eventValue;
        addDailyPnl(event.timestamp, eventValue);
        if (cycle) {
          cycle.feesClaimed += eventValue;
        }
      } else {
        if (!cycle) {
          basisMissingCount++;
          continue;
        }
        if (!cycle.priced) {
          openCycles.delete(key);
          continue;
        }
        if (eventValue === null) {
          historicalPriceGapCount++;
          unpricedPoolIds.add(result.poolId);
          openCycles.delete(key);
          continue;
        }
        const pnl = eventValue - cycle.deposits;
        realizedPnl += pnl;
        addDailyPnl(event.timestamp, pnl);
        closedPositions.push({
          id: `${event.txHash}-${event.poolId}-${event.binId}`,
          poolId: dlmmPoolRecordId(event.poolId),
          poolName: `${pool.tokenX.symbol}/${pool.tokenY.symbol}`,
          binId: event.binId,
          openedAt: cycle.openedAt,
          closedAt: event.timestamp,
          deposits: cycle.deposits,
          withdrawn: eventValue,
          feesClaimed: cycle.feesClaimed,
          pnl: pnl + cycle.feesClaimed,
          txHash: event.txHash,
        });
        openCycles.delete(key);
      }
    }
  }

  let claimableFees = 0;
  let totalValue = 0;
  let unrealizedPnl = 0;
  const activePositionKeys = new Set<string>();
  for (const position of positions) {
    const poolId = position.pool.dlmmPoolId;
    if (poolId === undefined) continue;
    const binId = position.binId;
    const key = `${poolId}:${binId}`;
    activePositionKeys.add(key);
    const binPrice = Math.pow(1 + position.pool.binStep / 10_000, binId);
    const positionValue = pnlUnit === "USD"
      ? position.valueUsd + position.unrealizedFees
      : valueInPnlUnit(
          position.pool,
          binId,
          position.liquidityX + position.claimableFeeX,
          position.liquidityY + position.claimableFeeY,
        );
    const feeValue = pnlUnit === "USD"
      ? position.unrealizedFees
      : valueInPnlUnit(position.pool, binId, position.claimableFeeX, position.claimableFeeY);
    if (positionValue === null || feeValue === null) {
      unpricedPoolIds.add(poolId);
    } else {
      totalValue += positionValue;
      claimableFees += feeValue;
    }
    const cycle = openCycles.get(key);
    if (!cycle) {
      basisMissingCount++;
      continue;
    }
    if (!cycle.priced) {
      unpricedPoolIds.add(poolId);
      continue;
    }
    if (positionValue === null) continue;
    unrealizedPnl += positionValue - cycle.deposits;
  }

  for (const key of openCycles.keys()) {
    if (!activePositionKeys.has(key)) {
      openCycles.delete(key);
    }
  }

  unpricedPoolCount = unpricedPoolIds.size;
  const asOf = new Date().toISOString();
  return {
    address,
    asOf,
    historyWindow: "Latest 9,000 ledgers; limited by Soroban RPC retention, not all-time",
    historyTruncated,
    basisMissingCount,
    historicalPriceGapCount,
    unpricedPoolCount,
    pnlUnit,
    totalValue,
    deposits,
    feesClaimed,
    claimableFees,
    realizedPnl,
    unrealizedPnl,
    totalPnl: realizedPnl + unrealizedPnl,
    dailyPnl: [...dailyPnl.entries()]
      .map(([date, value]) => ({ date, ...value }))
      .sort((first, second) => first.date.localeCompare(second.date)),
    closedPositions: closedPositions.slice(-100).reverse(),
  };
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
