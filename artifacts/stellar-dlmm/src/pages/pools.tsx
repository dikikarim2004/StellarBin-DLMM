import { useMemo, useState } from "react";
import { useListPools, useGetProtocolSummary, getListPoolsQueryKey } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, TrendingUp, TrendingDown, Zap, Flame, Sparkles } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

type SortKey = "tvl" | "volume24h" | "apr" | "fees24h";
type Tab = "all" | "top" | "new";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "tvl", label: "TVL" },
  { key: "volume24h", label: "Volume" },
  { key: "apr", label: "APR" },
  { key: "fees24h", label: "Fees" },
];

const TABS: { key: Tab; label: string; icon: typeof Sparkles }[] = [
  { key: "all", label: "All Pools", icon: Sparkles },
  { key: "top", label: "Top Performers", icon: Flame },
  { key: "new", label: "Trending", icon: TrendingUp },
];

export default function PoolsPage() {
  const [search, setSearch] = useState("");
  const [sortBy, setSortBy] = useState<SortKey>("tvl");
  const [tab, setTab] = useState<Tab>("all");

  const { data: summary, isLoading: summaryLoading } = useGetProtocolSummary();
  const { data: pools, isLoading: poolsLoading } = useListPools(
    { search, sortBy },
    { query: { queryKey: getListPoolsQueryKey({ search, sortBy }) } }
  );

  const filteredPools = useMemo(() => {
    if (!pools) return pools;
    if (tab === "top") return [...pools].sort((a, b) => b.apr - a.apr).slice(0, Math.max(3, Math.ceil(pools.length / 2)));
    if (tab === "new") return [...pools].sort((a, b) => b.volume24h - a.volume24h);
    return pools;
  }, [pools, tab]);

  return (
    <div className="space-y-6">
      {/* Hero + stats */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Liquidity Pools</h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            Provide concentrated liquidity across discrete price bins and earn dynamic fees.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-3 lg:min-w-[420px]">
          <StatChip label="Total TVL" value={summary?.totalTvl} loading={summaryLoading} />
          <StatChip label="24h Volume" value={summary?.totalVolume24h} loading={summaryLoading} />
          <StatChip label="24h Fees" value={summary?.totalFees24h} loading={summaryLoading} />
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors shrink-0 ${
                active
                  ? "bg-primary text-primary-foreground"
                  : "bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary"
              }`}
              data-testid={`tab-${t.key}`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Search + sort controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Search by token or pair..."
            className="pl-9 bg-card border-border rounded-full h-10"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            data-testid="input-search-pools"
          />
        </div>

        <div className="flex gap-1.5 overflow-x-auto no-scrollbar">
          {SORT_OPTIONS.map((opt) => (
            <Button
              key={opt.key}
              variant={sortBy === opt.key ? "default" : "outline"}
              size="sm"
              className="rounded-full shrink-0"
              onClick={() => setSortBy(opt.key)}
              data-testid={`button-sort-${opt.key}`}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      </div>

      {/* Desktop dense table */}
      <div className="hidden md:block rounded-xl border border-border overflow-hidden bg-card">
        <table className="w-full text-sm">
          <thead className="bg-secondary/40 text-muted-foreground text-xs uppercase tracking-wider">
            <tr>
              <th className="px-4 py-3 text-left font-medium">Pool</th>
              <th className="px-4 py-3 text-right font-medium">Price</th>
              <th className="px-4 py-3 text-right font-medium">TVL</th>
              <th className="px-4 py-3 text-right font-medium">24h Vol</th>
              <th className="px-4 py-3 text-right font-medium">24h Fees</th>
              <th className="px-4 py-3 text-right font-medium">APR</th>
              <th className="px-4 py-3 text-right font-medium">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {poolsLoading ? (
              Array.from({ length: 6 }).map((_, i) => (
                <tr key={i}>
                  <td className="px-4 py-4"><Skeleton className="h-6 w-40" /></td>
                  <td className="px-4 py-4"><Skeleton className="h-6 w-16 ml-auto" /></td>
                  <td className="px-4 py-4"><Skeleton className="h-6 w-20 ml-auto" /></td>
                  <td className="px-4 py-4"><Skeleton className="h-6 w-20 ml-auto" /></td>
                  <td className="px-4 py-4"><Skeleton className="h-6 w-16 ml-auto" /></td>
                  <td className="px-4 py-4"><Skeleton className="h-6 w-16 ml-auto" /></td>
                  <td className="px-4 py-4"><Skeleton className="h-8 w-24 ml-auto" /></td>
                </tr>
              ))
            ) : filteredPools && filteredPools.length > 0 ? (
              filteredPools.map((pool) => {
                const change = pool.tokenX.priceChange24h ?? 0;
                const isUp = change >= 0;
                return (
                  <tr key={pool.id} className="hover:bg-muted/40 transition-colors" data-testid={`row-pool-${pool.id}`}>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="flex -space-x-2.5 shrink-0">
                          <img src={pool.tokenX.logoUrl} alt={pool.tokenX.symbol} className="w-7 h-7 rounded-full border-2 border-card bg-secondary object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                          <img src={pool.tokenY.logoUrl} alt={pool.tokenY.symbol} className="w-7 h-7 rounded-full border-2 border-card bg-secondary object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        </div>
                        <div className="min-w-0">
                          <div className="font-bold flex items-center gap-1.5 flex-wrap">
                            <span>{pool.tokenX.symbol}-{pool.tokenY.symbol}</span>
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-mono">{pool.fee}% fee</span>
                            <span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-mono">{pool.binStep} bps</span>
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <div className="font-mono tabular-nums">{pool.currentPrice?.toLocaleString("en", { maximumFractionDigits: 4 }) ?? "—"}</div>
                      <div className={`text-xs font-mono flex items-center justify-end gap-0.5 ${isUp ? "text-green-400" : "text-red-400"}`}>
                        {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                        {Math.abs(change).toFixed(2)}%
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums">${pool.tvl.toLocaleString("en", { maximumFractionDigits: 0 })}</td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums">${pool.volume24h.toLocaleString("en", { maximumFractionDigits: 0 })}</td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums">${pool.fees24h.toLocaleString("en", { maximumFractionDigits: 0 })}</td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-green-400 font-semibold">{pool.apr.toFixed(2)}%</td>
                    <td className="px-4 py-3.5 text-right">
                      <Link href={`/pools/${pool.id}`}>
                        <Button size="sm" className="rounded-full" data-testid={`button-manage-${pool.id}`}>
                          <Zap className="w-3.5 h-3.5 mr-1" />
                          Manage
                        </Button>
                      </Link>
                    </td>
                  </tr>
                );
              })
            ) : (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">No pools match your search.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked cards */}
      <div className="md:hidden space-y-3">
        {poolsLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-32 w-full rounded-xl" />)
        ) : filteredPools && filteredPools.length > 0 ? (
          filteredPools.map((pool) => {
            const change = pool.tokenX.priceChange24h ?? 0;
            const isUp = change >= 0;
            return (
              <Link key={pool.id} href={`/pools/${pool.id}`}>
                <div
                  className="rounded-xl border border-border bg-card p-4 active:bg-muted/40 transition-colors"
                  data-testid={`card-pool-${pool.id}`}
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="flex -space-x-2.5 shrink-0">
                        <img src={pool.tokenX.logoUrl} alt={pool.tokenX.symbol} className="w-8 h-8 rounded-full border-2 border-card bg-secondary object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                        <img src={pool.tokenY.logoUrl} alt={pool.tokenY.symbol} className="w-8 h-8 rounded-full border-2 border-card bg-secondary object-cover" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold truncate">{pool.tokenX.symbol}-{pool.tokenY.symbol}</div>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-mono">{pool.fee}% fee</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-mono">{pool.binStep} bps</span>
                        </div>
                      </div>
                    </div>
                    <div className={`text-xs font-mono flex items-center gap-0.5 shrink-0 ${isUp ? "text-green-400" : "text-red-400"}`}>
                      {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      {Math.abs(change).toFixed(2)}%
                    </div>
                  </div>

                  <div className="grid grid-cols-4 gap-2 text-center border-t border-border pt-3">
                    <MiniStat label="TVL" value={`$${abbreviate(pool.tvl)}`} />
                    <MiniStat label="Vol" value={`$${abbreviate(pool.volume24h)}`} />
                    <MiniStat label="Fees" value={`$${abbreviate(pool.fees24h)}`} />
                    <MiniStat label="APR" value={`${pool.apr.toFixed(1)}%`} valueCls="text-green-400" />
                  </div>
                </div>
              </Link>
            );
          })
        ) : (
          <div className="text-center text-muted-foreground py-12">No pools match your search.</div>
        )}
      </div>
    </div>
  );
}

function StatChip({ label, value, loading }: { label: string; value?: number; loading: boolean }) {
  return (
    <div className="px-3 py-2.5 rounded-xl border border-border bg-card">
      <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider truncate">{label}</p>
      {loading ? (
        <Skeleton className="h-6 w-full mt-1" />
      ) : (
        <p className="text-sm sm:text-lg font-mono font-bold mt-0.5 tabular-nums truncate">
          ${abbreviate(value ?? 0)}
        </p>
      )}
    </div>
  );
}

function MiniStat({ label, value, valueCls = "" }: { label: string; value: string; valueCls?: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className={`text-xs font-mono font-semibold tabular-nums mt-0.5 ${valueCls}`}>{value}</p>
    </div>
  );
}

function abbreviate(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en", { maximumFractionDigits: 2 });
}
