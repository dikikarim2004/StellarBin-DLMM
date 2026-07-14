import { useMemo, useState } from "react";
import { useListPools, useGetProtocolSummary, getListPoolsQueryKey } from "@workspace/api-client-react";
import type { Pool } from "@workspace/api-client-react";
import { Link } from "wouter";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search, Zap, ExternalLink, Boxes, Waves, Info, PlusCircle, Rocket } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

type CategoryFilter = "all" | "dlmm" | "amm";

const FILTERS: { key: CategoryFilter; label: string; icon: typeof Boxes }[] = [
  { key: "all", label: "All", icon: Boxes },
  { key: "dlmm", label: "DLMM", icon: Zap },
  { key: "amm", label: "AMM", icon: Waves },
];

export default function PoolsPage() {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");

  const { data: summary, isLoading: summaryLoading } = useGetProtocolSummary();
  const { data: pools, isLoading: poolsLoading } = useListPools(
    { search, sortBy: "tvl" },
    { query: { queryKey: getListPoolsQueryKey({ search, sortBy: "tvl" }) } }
  );

  const dlmmPools = useMemo(() => (pools ?? []).filter((p) => p.category === "dlmm"), [pools]);
  const ammPools = useMemo(() => (pools ?? []).filter((p) => p.category === "amm"), [pools]);

  const showDlmm = category === "all" || category === "dlmm";
  const showAmm = category === "all" || category === "amm";

  return (
    <div className="space-y-6">
      {/* Hero + stats */}
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Liquidity Pools</h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            DLMM pools plus live native-XLM pools aggregated from the Stellar DEX.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="grid grid-cols-3 gap-3 lg:min-w-[420px]">
            <StatChip label="Total TVL" value={summary?.totalTvl} loading={summaryLoading} isCurrency />
            <StatChip label="24h Volume" value={undefined} loading={summaryLoading} unavailable />
            <StatChip label="24h Fees" value={undefined} loading={summaryLoading} unavailable />
          </div>
          <Link href="/create">
            <Button className="rounded-full h-full shrink-0" data-testid="button-create-pool-cta">
              <PlusCircle className="w-4 h-4 mr-1.5" />
              Create
            </Button>
          </Link>
        </div>
      </div>

      {/* Honesty note */}
      <div className="flex items-start gap-2 text-xs text-muted-foreground bg-secondary/40 border border-border rounded-lg px-3 py-2">
        <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
        <span>
          TVL and price are read live from-chain. 24h volume, fees and APR are not indexed on testnet,
          so they are shown as <span className="font-mono text-foreground">—</span> rather than estimated.
        </span>
      </div>

      {/* Category filter + search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex gap-1.5">
          {FILTERS.map((f) => {
            const Icon = f.icon;
            const active = category === f.key;
            return (
              <button
                key={f.key}
                onClick={() => setCategory(f.key)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium whitespace-nowrap transition-colors shrink-0 ${
                  active
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary"
                }`}
                data-testid={`filter-${f.key}`}
              >
                <Icon className="w-3.5 h-3.5" />
                {f.label}
              </button>
            );
          })}
        </div>

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
      </div>

      {poolsLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
        </div>
      ) : (
        <div className="space-y-8">
          {showDlmm && (
            <PoolGroup
              title="DLMM Pools"
              subtitle="Powered by our on-chain Dynamic Liquidity Market Maker contract"
              icon={Zap}
              badge="On-chain"
              pools={dlmmPools}
            />
          )}
          {showAmm && (
            <PoolGroup
              title="AMM from Stellar DEX"
              subtitle="Native-XLM constant-product pools aggregated live from Horizon"
              icon={Waves}
              badge="Aggregated"
              pools={ammPools}
            />
          )}
        </div>
      )}
    </div>
  );
}

function PoolGroup({
  title,
  subtitle,
  icon: Icon,
  badge,
  pools,
}: {
  title: string;
  subtitle: string;
  icon: typeof Zap;
  badge: string;
  pools: Pool[];
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-bold tracking-tight">{title}</h2>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-secondary text-muted-foreground font-medium uppercase tracking-wider">
              {badge}
            </span>
            <span className="text-xs text-muted-foreground">({pools.length})</span>
          </div>
          <p className="text-xs text-muted-foreground truncate">{subtitle}</p>
        </div>
      </div>

      {pools.length === 0 ? (
        <div className="text-sm text-muted-foreground border border-dashed border-border rounded-xl py-8 text-center">
          No pools found.
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block rounded-xl border border-border overflow-hidden bg-card">
            <table className="w-full text-sm">
              <thead className="bg-secondary/40 text-muted-foreground text-xs uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Pool</th>
                  <th className="px-4 py-3 text-right font-medium">Price</th>
                  <th className="px-4 py-3 text-right font-medium">TVL</th>
                  <th className="px-4 py-3 text-right font-medium">24h Vol</th>
                  <th className="px-4 py-3 text-right font-medium">APR</th>
                  <th className="px-4 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pools.map((pool) => (
                  <tr key={pool.id} className="hover:bg-muted/40 transition-colors" data-testid={`row-pool-${pool.id}`}>
                    <td className="px-4 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="flex -space-x-2.5 shrink-0">
                          <TokenLogo url={pool.tokenX.logoUrl} symbol={pool.tokenX.symbol} />
                          <TokenLogo url={pool.tokenY.logoUrl} symbol={pool.tokenY.symbol} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold">{pool.tokenX.symbol}-{pool.tokenY.symbol}</span>
                            {pool.isLaunchPool && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium uppercase tracking-wide">
                                Launch
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            {typeof pool.fee === "number" && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-mono">
                                {(pool.fee * 100).toFixed(2)}% fee
                              </span>
                            )}
                            {pool.category === "dlmm" && (
                              <span className="text-[11px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-mono">
                                {pool.binStep} bps
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums">
                      {pool.currentPrice != null
                        ? pool.currentPrice.toLocaleString("en", { maximumFractionDigits: 6 })
                        : "—"}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums">
                      ${pool.tvl.toLocaleString("en", { maximumFractionDigits: 0 })}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-muted-foreground">
                      {pool.volumeAvailable
                        ? `$${pool.volume24h.toLocaleString("en", { maximumFractionDigits: 0 })}`
                        : "—"}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-muted-foreground">
                      {pool.volumeAvailable ? `${pool.apr.toFixed(2)}%` : "—"}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <PoolAction pool={pool} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-3">
            {pools.map((pool) => (
              <div
                key={pool.id}
                className="rounded-xl border border-border bg-card p-4"
                data-testid={`card-pool-${pool.id}`}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="flex -space-x-2.5 shrink-0">
                      <TokenLogo url={pool.tokenX.logoUrl} symbol={pool.tokenX.symbol} size={32} />
                      <TokenLogo url={pool.tokenY.logoUrl} symbol={pool.tokenY.symbol} size={32} />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold truncate">{pool.tokenX.symbol}-{pool.tokenY.symbol}</span>
                        {pool.isLaunchPool && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-400 font-medium uppercase tracking-wide shrink-0">
                            Launch
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground font-mono">
                        {pool.currentPrice != null
                          ? pool.currentPrice.toLocaleString("en", { maximumFractionDigits: 6 })
                          : "—"}
                      </div>
                    </div>
                  </div>
                  <PoolAction pool={pool} />
                </div>
                <div className="grid grid-cols-3 gap-2 text-center border-t border-border pt-3">
                  <MiniStat label="TVL" value={`$${abbreviate(pool.tvl)}`} />
                  <MiniStat label="Vol" value={pool.volumeAvailable ? `$${abbreviate(pool.volume24h)}` : "—"} />
                  <MiniStat label="APR" value={pool.volumeAvailable ? `${pool.apr.toFixed(1)}%` : "—"} />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function PoolAction({ pool }: { pool: Pool }) {
  if (pool.category === "dlmm") {
    return (
      <Link href={`/pools/${pool.id}`}>
        <Button size="sm" className="rounded-full" data-testid={`button-manage-${pool.id}`}>
          <Zap className="w-3.5 h-3.5 mr-1" />
          Manage
        </Button>
      </Link>
    );
  }
  return (
    <a href={pool.externalUrl} target="_blank" rel="noopener noreferrer">
      <Button size="sm" variant="outline" className="rounded-full" data-testid={`button-view-${pool.id}`}>
        <ExternalLink className="w-3.5 h-3.5 mr-1" />
        View
      </Button>
    </a>
  );
}

function TokenLogo({ url, symbol, size = 28 }: { url?: string; symbol: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <div
        style={{ width: size, height: size }}
        className="rounded-full border-2 border-card bg-secondary flex items-center justify-center text-[10px] font-bold text-muted-foreground uppercase"
        title={symbol}
      >
        {symbol.slice(0, 2)}
      </div>
    );
  }
  return (
    <img
      src={url}
      alt={symbol}
      style={{ width: size, height: size }}
      className="rounded-full border-2 border-card bg-secondary object-cover"
      onError={() => setFailed(true)}
    />
  );
}

function StatChip({
  label,
  value,
  loading,
  isCurrency = false,
  unavailable = false,
}: {
  label: string;
  value?: number;
  loading: boolean;
  isCurrency?: boolean;
  unavailable?: boolean;
}) {
  return (
    <div className="px-3 py-2.5 rounded-xl border border-border bg-card">
      <p className="text-[10px] sm:text-xs text-muted-foreground uppercase tracking-wider truncate">{label}</p>
      {loading ? (
        <Skeleton className="h-6 w-full mt-1" />
      ) : unavailable ? (
        <p className="text-sm sm:text-lg font-mono font-bold mt-0.5 tabular-nums text-muted-foreground">—</p>
      ) : (
        <p className="text-sm sm:text-lg font-mono font-bold mt-0.5 tabular-nums truncate">
          {isCurrency ? "$" : ""}{abbreviate(value ?? 0)}
        </p>
      )}
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-xs font-mono font-semibold tabular-nums mt-0.5">{value}</p>
    </div>
  );
}

function abbreviate(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en", { maximumFractionDigits: 2 });
}
