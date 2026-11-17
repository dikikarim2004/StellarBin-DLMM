import { useMemo, useState } from "react";
import { useGetMarketFlow, type MarketFlowAsset } from "@workspace/api-client-react";
import { RefreshCw } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

type VenueFilter = "all" | "dlmm" | "dex";
type FlowSource = "dlmm" | "dex";

interface FlowRow {
  asset: MarketFlowAsset;
  source: FlowSource;
  records: number;
  buy: bigint;
  sell: bigint;
}

const VENUES: { id: VenueFilter; label: string }[] = [
  { id: "all", label: "All sources" },
  { id: "dlmm", label: "StellarBin" },
  { id: "dex", label: "Stellar DEX" },
];

export default function AnalyticsPage() {
  const [venue, setVenue] = useState<VenueFilter>("all");
  const [search, setSearch] = useState("");
  const {
    data: marketFlow,
    isLoading,
    isError,
    isFetching,
    refetch,
  } = useGetMarketFlow();

  const rows = useMemo(() => {
    if (!marketFlow) return [];
    const result: FlowRow[] = [];
    const query = search.trim().toLowerCase();
    for (const asset of marketFlow.assets) {
      if (query && !`${asset.symbol} ${asset.address}`.toLowerCase().includes(query)) continue;
      if (venue !== "dex" && asset.dlmmTrades > 0) {
        result.push({
          asset,
          source: "dlmm",
          records: asset.dlmmTrades,
          buy: BigInt(asset.dlmmBuy),
          sell: BigInt(asset.dlmmSell),
        });
      }
      if (venue !== "dlmm" && asset.dexTrades > 0) {
        result.push({
          asset,
          source: "dex",
          records: asset.dexTrades,
          buy: BigInt(asset.dexBuy),
          sell: BigInt(asset.dexSell),
        });
      }
    }
    return result.sort((first, second) => second.records - first.records || first.asset.symbol.localeCompare(second.asset.symbol));
  }, [marketFlow, search, venue]);

  const activeTokenCount = marketFlow?.assets.length ?? 0;
  const sourceRecords = (source: FlowSource) =>
    marketFlow?.[source].records.toLocaleString("en-US") ?? "0";

  return (
    <div className="space-y-6" data-testid="page-analytics">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Market Analytics</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Observed buy and sell flow by token, plus current StellarBin liquidity.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          aria-label="Refresh market analytics"
          title="Refresh market analytics"
          className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50"
          data-testid="button-refresh-analytics"
        >
          <RefreshCw className={`h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
        </button>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Metric label="Tokens with observed trades" value={activeTokenCount.toLocaleString("en-US")} loading={isLoading} />
        <Metric label="StellarBin swap events" value={sourceRecords("dlmm")} loading={isLoading} />
        <Metric label="Stellar DEX trade records" value={sourceRecords("dex")} loading={isLoading} />
      </div>

      {marketFlow && (
        <div className="flex flex-col gap-1 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <span>{marketFlow.network === "mainnet" ? "Stellar Mainnet" : "Stellar Testnet"}</span>
          <span>Updated {new Date(marketFlow.asOf).toLocaleString()}</span>
        </div>
      )}

      {isError && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
          Market analytics could not be loaded. Refresh to try again.
        </p>
      )}

      {marketFlow && (marketFlow.dlmm.status === "unavailable" || marketFlow.dex.status === "unavailable") && (
        <div className="space-y-1 rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-sm text-yellow-200" role="status">
          {marketFlow.dlmm.status === "unavailable" && (
            <p>StellarBin data unavailable: {marketFlow.dlmm.error}</p>
          )}
          {marketFlow.dex.status === "unavailable" && (
            <p>Stellar DEX data unavailable: {marketFlow.dex.error}</p>
          )}
        </div>
      )}

      {marketFlow && (marketFlow.dlmm.truncated || marketFlow.dex.truncated) && (
        <p className="rounded-md border border-yellow-500/30 bg-yellow-500/10 p-3 text-xs text-yellow-200" role="status">
          The source record cap was reached. Results may not include every trade in the displayed window.
        </p>
      )}

      <section className="space-y-4" aria-label="Token supply and demand">
        <div className="flex flex-col gap-3 border-b border-border pb-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-semibold">Token supply &amp; demand</h2>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter token or address"
              aria-label="Filter market flow by token or address"
              className="h-9 w-full sm:w-56"
              data-testid="input-market-flow-search"
            />
            <div className="inline-flex w-fit rounded-md border border-border p-1" role="group" aria-label="Market source">
              {VENUES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => setVenue(option.id)}
                  aria-pressed={venue === option.id}
                  className={`rounded-sm px-3 py-1.5 text-xs font-medium transition-colors ${venue === option.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  data-testid={`filter-venue-${option.id}`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
          <p>StellarBin: {marketFlow?.dlmm.window ?? "Loading source window..."}</p>
          <p>Stellar DEX: {marketFlow?.dex.window ?? "Loading source window..."}</p>
        </div>

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : rows.length > 0 ? (
          <Card className="overflow-hidden border-border bg-card">
            <div className="overflow-x-auto">
              <table className="w-full min-w-212.5 text-sm">
                <thead className="bg-secondary/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="px-4 py-3 font-medium">Token</th>
                    <th className="px-4 py-3 font-medium">Venue</th>
                    <th className="px-4 py-3 text-right font-medium">Trade records</th>
                    <th className="px-4 py-3 text-right font-medium">Observed flow</th>
                    <th className="px-4 py-3 text-right font-medium">Net / buy share</th>
                    <th className="px-4 py-3 text-right font-medium">DLMM reserves</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((row) => {
                    const net = row.buy - row.sell;
                    const total = row.buy + row.sell;
                    const buyShare = total > 0n ? Number((row.buy * 10_000n) / total) / 100 : 0;
                    return (
                      <tr key={`${row.asset.address}-${row.source}`} data-testid={`row-flow-${row.source}-${row.asset.address}`}>
                        <td className="px-4 py-3">
                          <div className="font-semibold">{row.asset.symbol}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-muted-foreground" title={row.asset.address}>
                            {shortAddress(row.asset.address)}
                          </div>
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap">
                          {row.source === "dlmm" ? "StellarBin DLMM" : "Stellar DEX"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums">{row.records.toLocaleString("en-US")}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">
                          <div className="text-emerald-400">Buy {formatRawUnits(row.buy, row.asset.decimals)} {row.asset.symbol}</div>
                          <div className="mt-1 text-rose-400">Sell {formatRawUnits(row.sell, row.asset.decimals)} {row.asset.symbol}</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">
                          <div className={net >= 0n ? "text-emerald-400" : "text-rose-400"}>
                            {net > 0n ? "+" : ""}{formatRawUnits(net, row.asset.decimals)} {row.asset.symbol}
                          </div>
                          <div className="mt-1 text-muted-foreground">{buyShare.toFixed(2)}% buy</div>
                        </td>
                        <td className="px-4 py-3 text-right font-mono tabular-nums text-muted-foreground">
                          {row.asset.dlmmReserve === "0" ? "-" : `${formatRawUnits(BigInt(row.asset.dlmmReserve), row.asset.decimals)} ${row.asset.symbol}`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        ) : marketFlow && marketFlow.dlmm.status === "available" && marketFlow.dex.status === "available" ? (
          <div className="border-y border-border py-12 text-center text-sm text-muted-foreground">
            No swap trades were reported within the available source windows.
          </div>
        ) : null}
      </section>

      <p className="max-w-4xl text-xs leading-relaxed text-muted-foreground">
        Buy and sell flow classifies observed taker-side trades; it is not total circulating supply or a price prediction. Amounts are shown in each token&apos;s units, not USD. Stellar DEX records are network-wide Horizon trades, while StellarBin history is limited by the active Soroban RPC&apos;s retention and record cap.
      </p>
    </div>
  );
}

function Metric({ label, value, loading }: { label: string; value: string; loading: boolean }) {
  return (
    <Card className="border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      {loading ? <Skeleton className="mt-2 h-7 w-24" /> : (
        <div className="mt-2 font-mono text-xl font-semibold tabular-nums">{value}</div>
      )}
    </Card>
  );
}

function formatRawUnits(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const magnitude = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = (magnitude / scale).toLocaleString("en-US");
  const fraction = (magnitude % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

function shortAddress(address: string): string {
  if (address === "native") return "Native asset";
  return `${address.slice(0, 5)}...${address.slice(-5)}`;
}
