import { Router } from "express";
import {
  ListPoolsResponse,
  GetPoolResponse,
  GetPoolBinsResponse,
  GetPoolStatsResponse,
  GetProtocolSummaryResponse,
  GetUserPositionsResponse,
  GetPoolRecentSwapsResponse,
} from "@workspace/api-zod";
import {
  getAllPools,
  getPoolById,
  getPoolBins,
  getProtocolSummary,
  getUserPositions,
  getRecentSwaps,
} from "../lib/stellar-reader";

const router = Router();

// GET /pools — real DLMM contract pool + native Stellar DEX (AMM) pools
router.get("/pools", async (req, res) => {
  const { sortBy, search } = req.query as Record<string, string>;
  try {
    let pools = await getAllPools();

    if (search) {
      const q = search.toLowerCase();
      pools = pools.filter(
        (p) =>
          p.tokenX.symbol.toLowerCase().includes(q) ||
          p.tokenY.symbol.toLowerCase().includes(q),
      );
    }

    if (sortBy) {
      pools = [...pools].sort((a, b) => {
        const ak = a[sortBy as keyof typeof a] as number;
        const bk = b[sortBy as keyof typeof b] as number;
        return (bk ?? 0) - (ak ?? 0);
      });
    }

    const parsed = ListPoolsResponse.safeParse(pools);
    if (!parsed.success) {
      req.log.error({ error: parsed.error }, "Pool list validation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json(parsed.data);
  } catch (err) {
    req.log.error({ err }, "Failed to load pools");
    return res.status(502).json({ error: "Failed to load on-chain pool data" });
  }
});

// GET /pools/summary — protocol-wide totals from live pool data
router.get("/pools/summary", async (req, res) => {
  try {
    const summary = await getProtocolSummary();
    const parsed = GetProtocolSummaryResponse.safeParse(summary);
    if (!parsed.success) {
      req.log.error({ error: parsed.error }, "Summary validation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json(parsed.data);
  } catch (err) {
    req.log.error({ err }, "Failed to load protocol summary");
    return res.status(502).json({ error: "Failed to load on-chain summary" });
  }
});

// GET /pools/:poolId
router.get("/pools/:poolId", async (req, res) => {
  try {
    const pool = await getPoolById(req.params.poolId);
    if (!pool) {
      return res.status(404).json({ error: "Pool not found" });
    }
    const parsed = GetPoolResponse.safeParse(pool);
    if (!parsed.success) {
      req.log.error({ error: parsed.error }, "Pool validation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json(parsed.data);
  } catch (err) {
    req.log.error({ err }, "Failed to load pool");
    return res.status(502).json({ error: "Failed to load on-chain pool data" });
  }
});

// GET /pools/:poolId/bins — real on-chain bin distribution (DLMM only)
router.get("/pools/:poolId/bins", async (req, res) => {
  try {
    const bins = await getPoolBins(req.params.poolId);
    if (bins === null) {
      // AMM (Horizon) pools have no discrete bins; return an empty set.
      return res.json([]);
    }
    const parsed = GetPoolBinsResponse.safeParse(bins);
    if (!parsed.success) {
      req.log.error({ error: parsed.error }, "Bins validation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json(parsed.data);
  } catch (err) {
    req.log.error({ err }, "Failed to load bins");
    return res.status(502).json({ error: "Failed to load on-chain bin data" });
  }
});

// GET /pools/:poolId/swaps — real SWAP events read live from the DLMM
// contract via RPC getEvents (DLMM pools only; not realtime, briefly cached)
router.get("/pools/:poolId/swaps", async (req, res) => {
  try {
    const swaps = await getRecentSwaps(req.params.poolId);
    if (swaps === null) {
      return res.status(404).json({ error: "Pool not found or not a DLMM registry pool" });
    }
    const parsed = GetPoolRecentSwapsResponse.safeParse(swaps);
    if (!parsed.success) {
      req.log.error({ error: parsed.error }, "Recent swaps validation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json(parsed.data);
  } catch (err) {
    req.log.error({ err }, "Failed to load recent swaps");
    return res.status(502).json({ error: "Failed to load on-chain swap events" });
  }
});

// GET /pools/:poolId/stats — historical TVL/volume is not indexed on-chain,
// so we return an empty series rather than fabricated history.
router.get("/pools/:poolId/stats", (req, res) => {
  const stats = { poolId: req.params.poolId, period: "live", data: [] };
  const parsed = GetPoolStatsResponse.safeParse(stats);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Stats validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  return res.json(parsed.data);
});

// GET /positions/:address — real per-user LP positions from the DLMM contract
router.get("/positions/:address", async (req, res) => {
  try {
    const positions = await getUserPositions(req.params.address);
    const parsed = GetUserPositionsResponse.safeParse(positions);
    if (!parsed.success) {
      req.log.error({ error: parsed.error }, "Positions validation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json(parsed.data);
  } catch (err) {
    req.log.error({ err }, "Failed to load positions");
    return res.status(502).json({ error: "Failed to load on-chain positions" });
  }
});

export default router;
