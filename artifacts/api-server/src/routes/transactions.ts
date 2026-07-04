import { Router } from "express";
import { ListTransactionsResponse } from "@workspace/api-zod";
import { POOLS } from "./pools";

const router = Router();

const TX_TYPES = ["swap", "add_liquidity", "remove_liquidity"] as const;

function generateTransactions(count = 50) {
  const txs = [];
  const now = Date.now();

  for (let i = 0; i < count; i++) {
    const pool = POOLS[Math.floor(Math.random() * POOLS.length)];
    const type = TX_TYPES[Math.floor(Math.random() * TX_TYPES.length)];
    const ts = new Date(now - i * 4 * 60 * 1000);
    const tokenXAmount = Math.random() * 1000 + 10;
    const tokenYAmount = tokenXAmount * pool.currentPrice * (0.95 + Math.random() * 0.1);

    txs.push({
      id: `tx-${i}-${pool.id.slice(5, 8)}`,
      type,
      poolId: pool.id,
      address: `G${Math.random().toString(36).slice(2, 8).toUpperCase()}${Math.random().toString(36).slice(2, 46).toUpperCase()}`.slice(0, 56),
      timestamp: ts.toISOString(),
      txHash: `${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`.slice(0, 64),
      tokenXAmount,
      tokenYAmount,
      valueUsd: tokenYAmount,
      binsAffected: [pool.activeBinId - 1, pool.activeBinId, pool.activeBinId + 1],
    });
  }
  return txs;
}

router.get("/transactions", (req, res) => {
  const { poolId, address, type, limit } = req.query as Record<string, string>;
  let txs = generateTransactions(100);

  if (poolId) txs = txs.filter((t) => t.poolId === poolId);
  if (address) txs = txs.filter((t) => t.address === address);
  if (type && TX_TYPES.includes(type as (typeof TX_TYPES)[number])) {
    txs = txs.filter((t) => t.type === type);
  }
  const n = limit ? parseInt(limit, 10) : 50;
  txs = txs.slice(0, isNaN(n) ? 50 : n);

  const parsed = ListTransactionsResponse.safeParse(txs);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Transaction validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  res.json(parsed.data);
});

export default router;
