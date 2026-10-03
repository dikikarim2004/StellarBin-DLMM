import { useEffect, useState } from "react";
import { getGetPoolRecentSwapsQueryKey, useGetPoolRecentSwaps } from "@workspace/api-client-react";
import type { RecentSwap } from "@workspace/api-client-react";
import { fetchXlmUsdcCandles, type MarketCandle } from "@/lib/market-chart";

const TIMEFRAMES = [
  { label: "1m", resolution: 60_000, count: 180 },
  { label: "5m", resolution: 300_000, count: 144 },
  { label: "15m", resolution: 900_000, count: 96 },
  { label: "1H", resolution: 3_600_000, count: 168 },
  { label: "1D", resolution: 86_400_000, count: 30 },
] as const;

interface MarketPriceChartProps {
  poolId: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  isXlmUsdcPair: boolean;
  poolPrice: number;
}

export function MarketPriceChart({
  poolId,
  tokenXSymbol,
  tokenYSymbol,
  isXlmUsdcPair,
  poolPrice,
}: MarketPriceChartProps) {
  const [timeframe, setTimeframe] = useState<(typeof TIMEFRAMES)[number]>(TIMEFRAMES[3]);
  const [marketCandles, setMarketCandles] = useState<MarketCandle[]>([]);
  const [loading, setLoading] = useState(isXlmUsdcPair);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const { data: recentSwaps } = useGetPoolRecentSwaps(poolId, {
    query: {
      enabled: !isXlmUsdcPair,
      refetchInterval: 15_000,
      staleTime: 15_000,
      queryKey: getGetPoolRecentSwapsQueryKey(poolId),
    },
  });

  useEffect(() => {
    if (!isXlmUsdcPair) {
      setLoading(false);
      setMarketCandles([]);
      setError(null);
      return;
    }

    let cancelled = false;
    const load = async (initial = false) => {
      if (initial) setLoading(true);
      try {
        const next = await fetchXlmUsdcCandles(timeframe.resolution, timeframe.count);
        if (cancelled) return;
        setMarketCandles(next);
        setError(null);
        setLastUpdated(Date.now());
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Unable to load Horizon trade data.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load(true);
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [isXlmUsdcPair, timeframe]);

  const executionCandles = isXlmUsdcPair ? [] : swapsToCandles(recentSwaps ?? []);
  const candles = isXlmUsdcPair ? marketCandles : executionCandles;
  const sourceLabel = isXlmUsdcPair ? "Horizon testnet · XLM/USDC market" : "DLMM swap executions";

  return (
    <section className="overflow-hidden rounded-md border border-border bg-card" data-testid="panel-price-chart">
      <div className="flex flex-col gap-3 border-b border-border px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold">Price Chart</h2>
            <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Testnet</span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {sourceLabel}{lastUpdated ? ` · updated ${new Date(lastUpdated).toLocaleTimeString()}` : ""}
          </p>
        </div>
        {isXlmUsdcPair ? (
          <div className="flex items-center gap-1 self-start rounded bg-secondary/55 p-1 sm:self-auto" role="group" aria-label="Chart timeframe">
            {TIMEFRAMES.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => setTimeframe(option)}
                className={`rounded px-2 py-1 text-[10px] font-medium ${timeframe.label === option.label ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                aria-pressed={timeframe.label === option.label}
                data-testid={`chart-timeframe-${option.label}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : <span className="rounded-sm bg-secondary px-2 py-1 text-[9px] uppercase text-muted-foreground">Recent swaps</span>}
      </div>

      {loading ? (
        <div className="flex h-65 items-center justify-center text-xs text-muted-foreground">Loading trade candles…</div>
      ) : error ? (
        <div className="flex h-65 items-center justify-center px-6 text-center text-xs text-muted-foreground">{error}</div>
      ) : candles.length === 0 ? (
        <div className="flex h-65 flex-col items-center justify-center px-6 text-center">
          <p className="text-sm font-medium">No trades in this interval</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {isXlmUsdcPair ? "Horizon has no XLM/USDC trades for the selected interval." : "No DLMM swap events are available in the RPC history window."}
          </p>
        </div>
      ) : (
        <div className="h-65 p-2 sm:h-90 sm:p-4">
          <OhlcChart
            candles={candles}
            interval={timeframe.label}
            tokenXSymbol={tokenXSymbol}
            tokenYSymbol={tokenYSymbol}
            poolPrice={poolPrice}
          />
        </div>
      )}
    </section>
  );
}

function swapsToCandles(swaps: RecentSwap[]): MarketCandle[] {
  return swaps
    .map((swap) => {
      const amountIn = Number(BigInt(swap.amountIn)) / 10_000_000;
      const amountOut = Number(BigInt(swap.amountOut)) / 10_000_000;
      const price = swap.xToY ? amountOut / amountIn : amountIn / amountOut;
      return {
        timestamp: Date.parse(swap.timestamp),
        open: price,
        high: price,
        low: price,
        close: price,
        trades: 1,
        baseVolume: swap.xToY ? amountIn : amountOut,
        quoteVolume: swap.xToY ? amountOut : amountIn,
      };
    })
    .filter((candle) => Number.isFinite(candle.timestamp) && Number.isFinite(candle.close) && candle.close > 0)
    .sort((left, right) => left.timestamp - right.timestamp);
}

function OhlcChart({
  candles,
  interval,
  tokenXSymbol,
  tokenYSymbol,
  poolPrice,
}: {
  candles: MarketCandle[];
  interval: string;
  tokenXSymbol: string;
  tokenYSymbol: string;
  poolPrice: number;
}) {
  const width = 1000;
  const height = 320;
  const left = 62;
  const right = 78;
  const top = 16;
  const bottom = 30;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const values = candles.flatMap((candle) => [candle.low, candle.high]);
  const minimum = Math.min(...values);
  const maximum = Math.max(...values);
  const padding = maximum === minimum ? Math.max(maximum * 0.01, 0.000001) : (maximum - minimum) * 0.12;
  const domainMin = minimum - padding;
  const domainMax = maximum + padding;
  const x = (index: number) => left + (candles.length < 2 ? plotWidth / 2 : (index / (candles.length - 1)) * plotWidth);
  const y = (value: number) => top + ((domainMax - value) / (domainMax - domainMin)) * plotHeight;
  const candleWidth = Math.max(2, Math.min(10, (plotWidth / Math.max(candles.length, 1)) * 0.58));
  const gridValues = Array.from({ length: 5 }, (_, index) => domainMax - ((domainMax - domainMin) * index) / 4);
  const labelTime = (timestamp: number) => new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  return (
    <svg className="h-full w-full" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={`${tokenXSymbol}/${tokenYSymbol} OHLC price chart`} data-testid="ohlc-chart">
      {gridValues.map((value) => (
        <g key={value}>
          <line x1={left} x2={width - right} y1={y(value)} y2={y(value)} stroke="hsl(var(--border))" strokeDasharray="3 5" />
          <text x={width - right + 7} y={y(value) + 4} fill="hsl(var(--muted-foreground))" fontSize="11" fontFamily="monospace">{value.toPrecision(5)}</text>
        </g>
      ))}
      {poolPrice > domainMin && poolPrice < domainMax && (
        <g>
          <line x1={left} x2={width - right} y1={y(poolPrice)} y2={y(poolPrice)} stroke="hsl(var(--primary))" strokeDasharray="5 4" opacity=".75" />
          <text x={left + 6} y={y(poolPrice) - 6} fill="hsl(var(--primary))" fontSize="10" fontFamily="sans-serif">DLMM bin price</text>
        </g>
      )}
      {candles.map((candle, index) => {
        const rising = candle.close >= candle.open;
        const color = rising ? "hsl(158 64% 48%)" : "hsl(350 80% 60%)";
        const bodyTop = Math.min(y(candle.open), y(candle.close));
        const bodyHeight = Math.max(1.5, Math.abs(y(candle.open) - y(candle.close)));
        return (
          <g key={`${candle.timestamp}-${index}`}>
            <title>{`${new Date(candle.timestamp).toLocaleString()} · O ${candle.open} H ${candle.high} L ${candle.low} C ${candle.close} · ${candle.trades} trade(s)`}</title>
            <line x1={x(index)} x2={x(index)} y1={y(candle.high)} y2={y(candle.low)} stroke={color} strokeWidth="1.2" />
            <rect x={x(index) - candleWidth / 2} y={bodyTop} width={candleWidth} height={bodyHeight} fill={color} />
          </g>
        );
      })}
      {[0, Math.floor((candles.length - 1) / 2), candles.length - 1].filter((value, index, all) => all.indexOf(value) === index).map((index) => (
        <text key={index} x={x(index)} y={height - 7} textAnchor="middle" fill="hsl(var(--muted-foreground))" fontSize="10" fontFamily="monospace">{interval === "1D" ? new Date(candles[index].timestamp).toLocaleDateString() : labelTime(candles[index].timestamp)}</text>
      ))}
    </svg>
  );
}