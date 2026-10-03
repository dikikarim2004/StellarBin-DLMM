import { Asset, Horizon } from "@stellar/stellar-sdk";
import { USDC_ISSUER } from "./trustline";

export interface MarketCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  trades: number;
  baseVolume: number;
  quoteVolume: number;
}

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const horizon = new Horizon.Server(HORIZON_URL);
const usdc = new Asset("USDC", USDC_ISSUER);

export async function fetchXlmUsdcCandles(
  resolutionMs: number,
  candleCount: number
): Promise<MarketCandle[]> {
  const endTime = Math.floor(Date.now() / resolutionMs) * resolutionMs;
  const startTime = endTime - resolutionMs * candleCount;
  const page = await horizon
    .tradeAggregation(Asset.native(), usdc, startTime, endTime, resolutionMs, 0)
    .call();

  return page.records
    .map((record) => ({
      timestamp: Number(record.timestamp),
      open: Number(record.open),
      high: Number(record.high),
      low: Number(record.low),
      close: Number(record.close),
      trades: Number(record.trade_count),
      baseVolume: Number(record.base_volume),
      quoteVolume: Number(record.counter_volume),
    }))
    .filter((candle) =>
      [candle.timestamp, candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)
    );
}