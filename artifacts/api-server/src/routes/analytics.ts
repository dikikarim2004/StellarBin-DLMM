import { Router } from "express";
import { GetMarketFlowResponse } from "@workspace/api-zod";
import { getMarketFlow } from "../lib/stellar-reader";

const router = Router();

router.get("/analytics/market-flow", async (req, res) => {
  try {
    const flow = await getMarketFlow();
    const parsed = GetMarketFlowResponse.safeParse(flow);
    if (!parsed.success) {
      req.log.error({ error: parsed.error }, "Market flow validation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json(parsed.data);
  } catch (error) {
    req.log.error({ err: error }, "Failed to load market flow");
    return res.status(502).json({ error: "Failed to load market flow" });
  }
});

export default router;