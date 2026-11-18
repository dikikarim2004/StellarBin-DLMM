import { Router } from "express";
import { GetPortfolioSummaryResponse } from "@workspace/api-zod";
import { getPortfolioSummary } from "../lib/stellar-reader";

const router = Router();

router.get("/portfolio/:address", async (req, res) => {
  try {
    const portfolio = await getPortfolioSummary(req.params.address);
    const parsed = GetPortfolioSummaryResponse.safeParse(portfolio);
    if (!parsed.success) {
      req.log.error({ error: parsed.error }, "Portfolio summary validation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json(parsed.data);
  } catch (error) {
    req.log.error({ err: error }, "Failed to load portfolio summary");
    return res.status(502).json({ error: "Failed to load portfolio data" });
  }
});

export default router;