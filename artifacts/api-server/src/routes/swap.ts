import { Router } from "express";
import { GetSwapQuoteBody, GetSwapQuoteResponse, GetSwapRouteBody, GetSwapRouteResponse } from "@workspace/api-zod";
import { TOKENS } from "./tokens";

const router = Router();

function findToken(address: string) {
  return TOKENS.find((t) => t.address === address);
}

// POST /swap/quote
router.post("/swap/quote", (req, res) => {
  const body = GetSwapQuoteBody.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  const { tokenInAddress, tokenOutAddress, amountIn, slippageTolerance = 0.5 } = body.data;

  const tokenIn = findToken(tokenInAddress);
  const tokenOut = findToken(tokenOutAddress);

  if (!tokenIn || !tokenOut) {
    return res.status(400).json({ error: "Token not supported" });
  }

  const priceImpact = Math.min(amountIn * 0.00002, 5.0);
  const effectiveRate = (tokenIn.price / tokenOut.price) * (1 - priceImpact / 100);
  const amountOut = amountIn * effectiveRate;
  const fee = amountIn * 0.003;
  const minimumReceived = amountOut * (1 - slippageTolerance / 100);

  const quote = {
    tokenIn,
    tokenOut,
    amountIn,
    amountOut,
    priceImpact,
    minimumReceived,
    fee,
    route: [`${tokenIn.symbol}-${tokenOut.symbol}`],
    executionPrice: amountOut / amountIn,
    binsTraversed: Math.max(1, Math.floor(priceImpact * 3)),
  };

  const parsed = GetSwapQuoteResponse.safeParse(quote);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Quote validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  return res.json(parsed.data);
});

// POST /swap/route
router.post("/swap/route", (req, res) => {
  const body = GetSwapRouteBody.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  const { tokenInAddress, tokenOutAddress, amountIn } = body.data;
  const tokenIn = findToken(tokenInAddress);
  const tokenOut = findToken(tokenOutAddress);

  if (!tokenIn || !tokenOut) {
    return res.status(400).json({ error: "Token not supported" });
  }

  const amountOut = amountIn * (tokenIn.price / tokenOut.price) * 0.997;
  const route = {
    hops: [
      {
        poolId: `${tokenIn.symbol}-${tokenOut.symbol}`,
        tokenIn,
        tokenOut,
        amountIn,
        amountOut,
      },
    ],
    totalAmountOut: amountOut,
    totalPriceImpact: 0.12,
    totalFee: amountIn * 0.003,
  };

  const parsed = GetSwapRouteResponse.safeParse(route);
  if (!parsed.success) {
    req.log.error({ error: parsed.error }, "Route validation failed");
    return res.status(500).json({ error: "Internal server error" });
  }
  return res.json(parsed.data);
});

export default router;
