import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useListPools, useGetProtocolSummary, getListPoolsQueryKey } from "@workspace/api-client-react";
import type { Pool } from "@workspace/api-client-react";
import { ArrowDown, ArrowUpRight, Search, SlidersHorizontal, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

type CategoryFilter = "all" | "dlmm" | "amm";
type PoolSort = "tvl" | "price" | "pair";

const FILTERS: { key: CategoryFilter; label: string }[] = [
  { key: "all", label: "All pools" },
  { key: "dlmm", label: "DLMM" },
  { key: "amm", label: "Stellar DEX" },
];

export default function DiscoverPage() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [sort, setSort] = useState<PoolSort>("tvl");

  const { data: summary, isLoading: summaryLoading } = useGetProtocolSummary();
  const { data: pools, isLoading, isError } = useListPools(
    { search, sortBy: "tvl" },
    { query: { queryKey: getListPoolsQueryKey({ search, sortBy: "tvl" }) } }
  );

  const visiblePools = useMemo(() => {
    const filtered = (pools ?? []).filter((pool) =>
      category === "all" ? true : pool.category === category
    );
    return filtered.sort((left, right) => {
      if (sort === "price") return (left.currentPrice ?? Infinity) - (right.currentPrice ?? Infinity);
      if (sort === "pair") return pairName(left).localeCompare(pairName(right));
      return right.tvl - left.tvl;
    });
  }, [pools, category, sort]);

  function openPool(pool: Pool) {
    if (pool.category === "dlmm") {
      setLocation(`/pools/${pool.id}`);
    } else if (pool.externalUrl) {
      window.location.assign(pool.externalUrl);
    }
  }

  function onPoolKeyDown(event: React.KeyboardEvent<HTMLTableRowElement | HTMLDivElement>, pool: Pool) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openPool(pool);
    }
  }

  const displayedTvl = summaryLoading ? null : summary?.totalTvl ?? 0;

  return (
    <div className="w-full space-y-6 pb-8" data-testid="page-discover">
      <section className="flex flex-col gap-5 border-b border-border pb-6 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-sm bg-primary/10 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-primary">
              Stellar Testnet
            </span>
            <span className="text-xs text-muted-foreground">On-chain pools</span>
          </div>
          <h1 className="text-3xl font-bold tracking-tight">Discover</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Explore DLMM liquidity and native Stellar DEX pools.
          </p>
        </div>
        <div className="flex items-end gap-5">
          <div className="hidden border-l border-border pl-5 sm:block">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Total TVL</p>
            <div className="mt-1">
              {displayedTvl === null ? <Skeleton className="h-6 w-20" /> : <p className="font-mono text-lg font-semibold tabular-nums">{formatUsd(displayedTvl)}</p>}
            </div>
          </div>
          <div className="hidden border-l border-border pl-5 sm:block">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">24h volume</p>
            <p className="mt-1 font-mono text-lg font-semibold text-muted-foreground">—</p>
          </div>
          <Button asChild className="h-10 rounded-md px-4" data-testid="button-create-pool-cta">
            <a href="/create"><Plus className="mr-2 h-4 w-4" />Create pool</a>
          </Button>
        </div>
      </section>

      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-border xl:border-0">
          {FILTERS.map((filter) => {
            const selected = category === filter.key;
            const count = filter.key === "all"
              ? pools?.length
              : pools?.filter((pool) => pool.category === filter.key).length;
            return (
              <button
                key={filter.key}
                type="button"
                onClick={() => setCategory(filter.key)}
                className={`whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors ${selected ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                aria-pressed={selected}
                data-testid={`filter-${filter.key}`}
              >
                {filter.label}
                {count !== undefined && <span className="ml-2 font-mono text-xs text-muted-foreground">{count}</span>}
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="relative min-w-0 flex-1 sm:w-72 sm:flex-none">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search token or pool"
              className="h-10 rounded-md border-border bg-card pl-9"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              data-testid="input-search-pools"
            />
          </label>
          <label className="relative flex h-10 items-center gap-2 rounded-md border border-border bg-card px-3 text-sm text-muted-foreground">
            <SlidersHorizontal className="h-4 w-4 shrink-0" />
            <span className="sr-only">Sort pools</span>
            <select
              value={sort}
              onChange={(event) => setSort(event.target.value as PoolSort)}
              className="min-w-0 appearance-none bg-transparent pr-5 text-foreground outline-none"
              aria-label="Sort pools"
              data-testid="select-pool-sort"
            >
              <option value="tvl">TVL: high to low</option>
              <option value="price">Price: low to high</option>
              <option value="pair">Pair: A to Z</option>
            </select>
            <ArrowDown className="pointer-events-none absolute right-2 h-3.5 w-3.5" />
          </label>
        </div>
      </div>

      <div className="overflow-hidden rounded-md border border-border bg-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3 sm:px-5">
          <div>
            <h2 className="text-sm font-semibold">Liquidity pools</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">Prices and TVL are read from testnet.</p>
          </div>
          <span className="font-mono text-xs text-muted-foreground">
            {isLoading ? "Loading" : `${visiblePools.length} pools`}
          </span>
        </div>

        {isLoading ? (
          <div className="space-y-1 p-4">
            {Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-14 w-full" />)}
          </div>
        ) : isError ? (
          <div className="px-5 py-12 text-center text-sm text-destructive">Pool data could not be loaded.</div>
        ) : visiblePools.length === 0 ? (
          <div className="px-5 py-14 text-center">
            <p className="text-sm font-medium">No pools match this search.</p>
            <p className="mt-1 text-xs text-muted-foreground">Try another token symbol or pool type.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-212.5 border-collapse text-sm">
              <thead className="bg-secondary/35 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-5 py-3 text-left">Pool</th>
                  <th className="px-4 py-3 text-right">Price</th>
                  <th className="px-4 py-3 text-right">TVL</th>
                  <th className="px-4 py-3 text-right">Volume 24h</th>
                  <th className="px-4 py-3 text-right">Fees 24h</th>
                  <th className="px-4 py-3 text-right">APR</th>
                  <th className="px-4 py-3 text-right">Bin step</th>
                  <th className="w-10 px-4 py-3" aria-label="Open pool" />
                </tr>
              </thead>
              <tbody>
                {visiblePools.map((pool) => (
                  <tr
                    key={pool.id}
                    role="link"
                    tabIndex={0}
                    onClick={() => openPool(pool)}
                    onKeyDown={(event) => onPoolKeyDown(event, pool)}
                    className="group cursor-pointer border-t border-border/70 transition-colors hover:bg-secondary/45 focus-visible:bg-secondary/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                    aria-label={`Open ${pairName(pool)} pool`}
                    data-testid={`row-pool-${pool.id}`}
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="flex shrink-0 -space-x-2">
                          <TokenLogo url={pool.tokenX.logoUrl} symbol={pool.tokenX.symbol} />
                          <TokenLogo url={pool.tokenY.logoUrl} symbol={pool.tokenY.symbol} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-foreground">{pairName(pool)}</span>
                            {pool.isLaunchPool && <span className="rounded-sm bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-amber-300">Launch</span>}
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                            <span>{pool.category === "dlmm" ? "DLMM" : "Stellar DEX"}</span>
                            {pool.fee !== undefined && <span className="border-l border-border pl-2">{(pool.fee * 100).toFixed(2)}% fee</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums">
                      {pool.currentPrice == null ? "—" : `${pool.currentPrice.toLocaleString("en", { maximumFractionDigits: 6 })} ${pool.tokenY.symbol}`}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono font-medium tabular-nums">{formatUsd(pool.tvl)}</td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-muted-foreground">{pool.volumeAvailable ? formatUsd(pool.volume24h) : "—"}</td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-muted-foreground">{pool.volumeAvailable ? formatUsd(pool.fees24h) : "—"}</td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-muted-foreground">{pool.volumeAvailable ? `${pool.apr.toFixed(2)}%` : "—"}</td>
                    <td className="px-4 py-3.5 text-right font-mono tabular-nums text-muted-foreground">{pool.category === "dlmm" ? `${pool.binStep} bps` : "—"}</td>
                    <td className="px-4 py-3.5 text-right text-muted-foreground group-hover:text-primary">
                      <ArrowUpRight className="ml-auto h-4 w-4" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Testnet volume, fee history, and APR are not indexed; unavailable values are shown as —.
      </p>
    </div>
  );
}

function pairName(pool: Pool) {
  return `${pool.tokenX.symbol}-${pool.tokenY.symbol}`;
}

function formatUsd(value: number) {
  return `$${value.toLocaleString("en", { maximumFractionDigits: value < 100 ? 2 : 0 })}`;
}

function TokenLogo({ url, symbol }: { url?: string; symbol: string }) {
  const [failed, setFailed] = useState(false);
  if (!url || failed) {
    return (
      <span className="flex h-8 w-8 items-center justify-center rounded-full border-2 border-card bg-secondary text-[10px] font-bold text-muted-foreground" title={symbol}>
        {symbol.slice(0, 2)}
      </span>
    );
  }
  return <img src={url} alt={symbol} className="h-8 w-8 rounded-full border-2 border-card bg-secondary object-cover" onError={() => setFailed(true)} />;
}