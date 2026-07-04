import { Router } from "express";
import {
  ListPoolsResponse,
  GetPoolResponse,
  GetPoolBinsResponse,
  GetPoolStatsResponse,
  GetProtocolSummaryResponse,
  GetUserPositionsResponse,
} from "@workspace/api-zod";
import { TOKENS } from "./tokens";

const router = Router();

const [XLM, USDC, yXLM, BTC, ETH, AQUA] = TOKENS;

export const POOLS = [
  {
    id: "pool-xlm-usdc-001",
    tokenX: XLM,
    tokenY: USDC,
    tvl: 4_821_340,
    volume24h: 1_203_500,
    fees24h: 3_610.5,
    apr: 27.34,
    binStep: 25,
    activeBinId: 8388608,
    currentPrice: 0.1142,
    fee: 0.003,
    reserveX: 21_203_500,
    reserveY: 2_421_340,
    totalBins: 200,
    contractAddress: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCN3",
  },
  {
    id: "pool-btc-usdc-002",
    tokenX: BTC,
    tokenY: USDC,
    tvl: 9_234_120,
    volume24h: 3_891_200,
    fees24h: 11_673.6,
    apr: 46.18,
    binStep: 10,
    activeBinId: 8392304,
    currentPrice: 67420.5,
    fee: 0.003,
    reserveX: 68.42,
    reserveY: 4_612_060,
    totalBins: 300,
    contractAddress: "CDBT2FC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHBTC",
  },
  {
    id: "pool-eth-usdc-003",
    tokenX: ETH,
    tokenY: USDC,
    tvl: 6_102_800,
    volume24h: 2_312_000,
    fees24h: 6_936,
    apr: 41.52,
    binStep: 15,
    activeBinId: 8391200,
    currentPrice: 3512.8,
    fee: 0.003,
    reserveX: 870.6,
    reserveY: 3_051_400,
    totalBins: 250,
    contractAddress: "CDETH3FC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHETH",
  },
  {
    id: "pool-xlm-yxlm-004",
    tokenX: XLM,
    tokenY: yXLM,
    tvl: 1_892_400,
    volume24h: 234_000,
    fees24h: 702,
    apr: 13.55,
    binStep: 5,
    activeBinId: 8388700,
    currentPrice: 0.9532,
    fee: 0.003,
    reserveX: 8_298_000,
    reserveY: 7_901_100,
    totalBins: 100,
    contractAddress: "CDYXLM3FC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHYX",
  },
  {
    id: "pool-xlm-aqua-005",
    tokenX: XLM,
    tokenY: AQUA,
    tvl: 892_100,
    volume24h: 412_300,
    fees24h: 1_236.9,
    apr: 50.64,
    binStep: 100,
    activeBinId: 8380000,
    currentPrice: 139.29,
    fee: 0.003,
    reserveX: 3_910_000,
    reserveY: 2_445_122_000,
    totalBins: 150,
    contractAddress: "CDAQUA3FC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHAQU",
  },
];

function generateBins(pool: (typeof POOLS)[0]) {
  const bins = [];
  const activeBin = pool.activeBinId;
  const binStep = pool.binStep;
  const totalBins = 40;
  const startBin = activeBin - Math.floor(totalBins / 2);

  for (let i = 0; i < totalBins; i++) {
    const binId = startBin + i;
    const distFromActive = i - Math.floor(totalBins / 2);
    const isActive = binId === activeBin;

    const price = pool.currentPrice * Math.pow(1 + binStep / 10000, distFromActive);

    let liquidityX = 0;
    let liquidityY = 0;

    if (distFromActive <= 0) {
      const falloff = Math.exp(-Math.abs(distFromActive) * 0.18);
      liquidityY = pool.reserveY * 0.05 * falloff * (0.7 + Math.random() * 0.6);
    }
    if (distFromActive >= 0) {
      const falloff = Math.exp(-Math.abs(distFromActive) * 0.18);
      liquidityX = pool.reserveX * 0.05 * falloff * (0.7 + Math.random() * 0.6);
    }
    if (isActive) {
      liquidityX = pool.reserveX * 0.08;
      liquidityY = pool.reserveY * 0.08;
    }

    bins.push({
      binId,
      price,
      liquidityX,
      liquidityY,
      isActive,
      totalLiquidity: liquidityX * pool.currentPrice + liquidityY,
    });
  }
  return bins;
}

function generateStats(poolId: string) {
  const now = Date.now();
  const data = [];
  for (let i = 29; i >= 0; i--) {
    const ts = new Date(now - i * 86_400_000);
    const base = 4_000_000 + Math.random() * 1_000_000;
    data.push({
      timestamp: ts.toISOString(),
      tvl: base,
      volume: 800_000 + Math.random() * 600_000,
      fees: 2_400 + Math.random() * 1_800,
    });
  }
  return { poolId, period: "30d", data };
}

function generatePositions(address: string) {
  return POOLS.slice(0, 3).map((pool, i) => ({
    id: `pos-${address.slice(0, 8)}-${i}`,
    poolId: pool.id,
    pool,
    address,
    binRangeLow: pool.activeBinId - 10 - i * 3,
    binRangeHigh: pool.activeBinId + 10 + i * 3,
    liquidityX: pool.reserveX * 0.02 * (i + 1),
    liquidityY: pool.reserveY * 0.02 * (i + 1),
    valueUsd: 8_400 + i * 3_200,
    unrealizedFees: 124.5 + i * 47.2,
    strategy: (["spot", "curve", "bid_ask"] as const)[i % 3],
  }));
}

// GET /pools
router.get("/pools", (req, res) => {
  const { sortBy, search } = req.query as Record<string, string>;
  let pools = [...POOLS];

  if (search) {
    const q = search.toLowerCase();
    pools = pools.filter(
      (p) =>
        p.tokenX.symbol.toLowerCase().includes(q) ||
        p.tokenY.symbol.toLowerCase().includes(q)
    );
  }

  if (sortBy) {
    pools.sort((a, b) => {
      const ak = a[sortBy as keyof typeof a] as number;
      const bk = b[sortBy as keyof typeof b] as number;
      return bk - ak;
    });
  }

  const parsed = ListPoolsResponse.safeParse(pools);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Pool list validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  res.json(parsed.data);
});

// GET /pools/summary
router.get("/pools/summary", (_req, res) => {
  const summary = {
    totalTvl: POOLS.reduce((s, p) => s + p.tvl, 0),
    totalVolume24h: POOLS.reduce((s, p) => s + p.volume24h, 0),
    totalFees24h: POOLS.reduce((s, p) => s + p.fees24h, 0),
    totalPools: POOLS.length,
    totalTransactions24h: 4_821,
    tvlChange24h: 3.12,
    volumeChange24h: -1.87,
  };
  const parsed = GetProtocolSummaryResponse.safeParse(summary);
  if (!parsed.success) {
    return res.status(500).json({ error: "Internal server error" });
  }
  res.json(parsed.data);
});

// GET /pools/:poolId
router.get("/pools/:poolId", (req, res) => {
  const pool = POOLS.find((p) => p.id === req.params.poolId);
  if (!pool) {
    return res.status(404).json({ error: "Pool not found" });
  }
  const parsed = GetPoolResponse.safeParse(pool);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Pool validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  res.json(parsed.data);
});

// GET /pools/:poolId/bins
router.get("/pools/:poolId/bins", (req, res) => {
  const pool = POOLS.find((p) => p.id === req.params.poolId);
  if (!pool) {
    return res.status(404).json({ error: "Pool not found" });
  }
  const bins = generateBins(pool);
  const parsed = GetPoolBinsResponse.safeParse(bins);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Bins validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  res.json(parsed.data);
});

// GET /pools/:poolId/stats
router.get("/pools/:poolId/stats", (req, res) => {
  const pool = POOLS.find((p) => p.id === req.params.poolId);
  if (!pool) {
    return res.status(404).json({ error: "Pool not found" });
  }
  const stats = generateStats(pool.id);
  const parsed = GetPoolStatsResponse.safeParse(stats);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Stats validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  res.json(parsed.data);
});

// GET /positions/:address
router.get("/positions/:address", (req, res) => {
  const positions = generatePositions(req.params.address);
  const parsed = GetUserPositionsResponse.safeParse(positions);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Positions validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  res.json(parsed.data);
});

export default router;
