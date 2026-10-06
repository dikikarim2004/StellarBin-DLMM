import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetPoolBinsQueryKey,
  getGetPoolPositionEventsQueryKey,
  getGetPoolQueryKey,
  getGetUserPositionsQueryKey,
  useGetPool,
  useGetPoolBins,
  useGetPoolPositionEvents,
  useGetUserPositions,
} from "@workspace/api-client-react";
import type { Bin, Position, PositionEvent } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft, ExternalLink, Wallet } from "lucide-react";
import { Link } from "wouter";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine, Cell } from "recharts";
import { LiquidityModal, type LiquidityStrategy } from "@/components/liquidity-modal";
import { MarketPriceChart } from "@/components/market-price-chart";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WalletModal } from "@/components/wallet-modal";
import { useWallet } from "@/contexts/wallet";
import { TOKEN_X, TOKEN_Y } from "@/lib/contracts";

export default function PoolDetailPage() {
  const queryClient = useQueryClient();
  const [, params] = useRoute("/pools/:poolId");
  const poolId = params?.poolId || "";
  const [liquidityModal, setLiquidityModal] = useState<"add" | "remove" | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<LiquidityStrategy>("spot");
  const [liquidityBinId, setLiquidityBinId] = useState<number | null>(null);
  const [selectedTab, setSelectedTab] = useState<"positions" | "bins" | "history">("positions");
  const [selectedPosition, setSelectedPosition] = useState<Position | null>(null);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const wallet = useWallet();

  const { data: pool, isLoading: poolLoading } = useGetPool(poolId, { query: { enabled: !!poolId, queryKey: getGetPoolQueryKey(poolId) } });
  const { data: bins, isLoading: binsLoading, refetch: refetchBins } = useGetPoolBins(poolId, { query: { enabled: !!poolId, queryKey: getGetPoolBinsQueryKey(poolId) } });
  const walletAddress = wallet.address ?? "";
  const { data: walletPositions, isLoading: positionsLoading } = useGetUserPositions(walletAddress, {
    query: {
      enabled: wallet.connected && !!wallet.address,
      queryKey: getGetUserPositionsQueryKey(walletAddress),
      refetchInterval: 15_000,
    },
  });
  const { data: positionEvents, isLoading: eventsLoading, isError: eventsError } = useGetPoolPositionEvents(poolId, walletAddress, {
    query: {
      enabled: wallet.connected && !!wallet.address && poolId.startsWith("dlmm-"),
      queryKey: getGetPoolPositionEventsQueryKey(poolId, walletAddress),
      refetchInterval: 30_000,
    },
  });

  if (poolLoading) {
    return <div className="space-y-6"><Skeleton className="h-12 w-64" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (!pool) return <div>Pool not found</div>;

  const isLivePool = pool.category === "dlmm" && pool.dlmmPoolId !== undefined;
  const isXlmUsdcPair =
    pool.tokenX.symbol === TOKEN_X.symbol &&
    (pool.tokenX.address === "native" || pool.tokenX.address === TOKEN_X.address) &&
    pool.tokenY.symbol === TOKEN_Y.symbol &&
    pool.tokenY.address === TOKEN_Y.address;
  const binsForChart = bins ?? [];
  const positionsForPool = (walletPositions ?? []).filter((position) => position.poolId === pool.id);
  const activeBinPosition = positionsForPool.find((position) => (position.binId ?? position.binRangeLow) === pool.activeBinId);
  const closedEvents = (positionEvents ?? []).filter((event) => event.action === "close");
  const feePercent = ((pool.fee ?? 0) * 100).toFixed(2);

  function openLiquidity(mode: "add" | "remove", binId?: number) {
    setLiquidityBinId(binId ?? pool?.activeBinId ?? 0);
    setLiquidityModal(mode);
  }

  return (
    <div className="w-full space-y-5 pb-8" data-testid="page-pool-detail">
      <Link href="/pools" className="inline-flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Discover
      </Link>

      <header className="flex flex-col gap-4 border-b border-border pb-5 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <div className="mb-2 flex items-center gap-3">
            <div className="flex -space-x-2">
              <TokenIcon url={pool.tokenX.logoUrl} symbol={pool.tokenX.symbol} />
              <TokenIcon url={pool.tokenY.logoUrl} symbol={pool.tokenY.symbol} />
            </div>
            <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">{pool.tokenX.symbol} / {pool.tokenY.symbol}</h1>
            <span className="rounded-sm bg-primary/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary">{pool.category === "dlmm" ? "DLMM" : "Stellar DEX"}</span>
            <span className="rounded-sm bg-secondary px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Testnet</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span>Pool {pool.dlmmPoolId ?? pool.id}</span>
            <span>{feePercent}% fee</span>
            {pool.category === "dlmm" && <span>Bin step {pool.binStep} bps</span>}
            {pool.isLaunchPool && <span className="text-amber-300">Launch pool</span>}
          </div>
        </div>
        <div className="flex items-end justify-between gap-5 lg:justify-end">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pool price</p>
            <p className="mt-1 font-mono text-lg font-semibold tabular-nums">1 {pool.tokenX.symbol} = {pool.currentPrice.toLocaleString("en", { maximumFractionDigits: 6 })} {pool.tokenY.symbol}</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" disabled={!isLivePool || !activeBinPosition} onClick={() => activeBinPosition && setSelectedPosition(activeBinPosition)} data-testid="button-close-position">Close position</Button>
            <Button disabled={!isLivePool} onClick={() => openLiquidity("add")} data-testid="button-create-position">Create position</Button>
          </div>
        </div>
      </header>

      {!isLivePool && <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">This listing is read-only; liquidity actions are available only for StellarBin DLMM pools.</div>}
      {isLivePool && pool.isLaunchPool && pool.activationTs !== undefined && <LaunchCountdown activationTs={pool.activationTs} />}

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[250px_minmax(0,1fr)_310px]">
        <aside className="space-y-4">
          <section className="border-b border-border pb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pool overview</h2>
            <div className="mt-3 space-y-3">
              <DetailStat label="Total value locked" value={formatUsd(pool.tvl)} prominent />
              <DetailStat label="24h volume" value={pool.volumeAvailable ? formatUsd(pool.volume24h) : "—"} />
              <DetailStat label="24h fees" value={pool.volumeAvailable ? formatUsd(pool.fees24h) : "—"} />
              <DetailStat label="APR" value={pool.volumeAvailable ? `${pool.apr.toFixed(2)}%` : "—"} />
            </div>
          </section>

          <section className="border-b border-border pb-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pool reserves</h2>
            <div className="mt-3 space-y-3">
              <DetailStat label={pool.tokenX.symbol} value={formatTokenAmount(pool.reserveX)} />
              <DetailStat label={pool.tokenY.symbol} value={formatTokenAmount(pool.reserveY)} />
              <div className="flex h-1.5 overflow-hidden rounded-full bg-secondary" aria-label="Reserve composition">
                <span className="bg-primary" style={{ width: `${reserveShare(pool.reserveX * pool.currentPrice, pool.reserveY)}%` }} />
                <span className="bg-accent" style={{ width: `${100 - reserveShare(pool.reserveX * pool.currentPrice, pool.reserveY)}%` }} />
              </div>
            </div>
          </section>

          <section>
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Pool parameters</h2>
            <dl className="mt-3 space-y-2 text-xs">
              <DetailRow label="Active bin" value={`#${pool.activeBinId}`} />
              <DetailRow label="Bin step" value={`${pool.binStep} bps`} />
              <DetailRow label="Swap fee" value={`${feePercent}%`} />
              {pool.lpFeeBps !== undefined && <DetailRow label="LP fee share" value={`${(pool.lpFeeBps / 100).toFixed(1)}%`} />}
              {pool.protocolFeeBps !== undefined && <DetailRow label="Protocol share" value={`${(pool.protocolFeeBps / 100).toFixed(1)}%`} />}
            </dl>
          </section>
        </aside>

        <main className="min-w-0 space-y-4">
          <MarketPriceChart
            poolId={pool.id}
            tokenXSymbol={pool.tokenX.symbol}
            tokenYSymbol={pool.tokenY.symbol}
            isXlmUsdcPair={isXlmUsdcPair}
            poolPrice={pool.currentPrice}
          />

          <section className="overflow-hidden rounded-md border border-border bg-card" data-testid="pool-detail-tabs">
            <div className="flex items-center gap-1 overflow-x-auto border-b border-border px-3 sm:px-4" role="tablist" aria-label="Pool detail views">
              <DetailTab selected={selectedTab === "positions"} onClick={() => setSelectedTab("positions")} label="Positions" count={positionsForPool.length} />
              <DetailTab selected={selectedTab === "bins"} onClick={() => setSelectedTab("bins")} label="Bin liquidity" count={binsForChart.length} />
              <DetailTab selected={selectedTab === "history"} onClick={() => setSelectedTab("history")} label="History" count={closedEvents.length} />
            </div>

            {selectedTab === "positions" && (
              <div>
                {!wallet.connected ? (
                  <div className="flex flex-col items-center justify-center px-5 py-12 text-center">
                    <Wallet className="mb-3 h-7 w-7 text-muted-foreground" />
                    <p className="text-sm font-medium">Connect a wallet to view positions</p>
                    <p className="mt-1 text-xs text-muted-foreground">Positions are read from the DLMM contract for your address.</p>
                    <Button className="mt-4" size="sm" onClick={() => setWalletModalOpen(true)}>Connect wallet</Button>
                  </div>
                ) : positionsLoading ? (
                  <div className="space-y-2 p-4"><Skeleton className="h-14 w-full" /><Skeleton className="h-14 w-full" /></div>
                ) : positionsForPool.length === 0 ? (
                  <div className="px-5 py-12 text-center">
                    <p className="text-sm font-medium">No open positions in this pool</p>
                    <p className="mt-1 text-xs text-muted-foreground">Create a position to provide liquidity to selected bins.</p>
                    <Button className="mt-4" size="sm" disabled={!isLivePool} onClick={() => openLiquidity("add")}>Create position</Button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-162.5 text-xs">
                      <thead className="bg-secondary/25 text-[10px] uppercase tracking-wide text-muted-foreground">
                        <tr><th className="px-4 py-3 text-left">Position</th><th className="px-3 py-3 text-right">Value</th><th className="px-3 py-3 text-right">{pool.tokenX.symbol}</th><th className="px-3 py-3 text-right">{pool.tokenY.symbol}</th><th className="px-3 py-3 text-right">Shares</th><th className="px-4 py-3" /></tr>
                      </thead>
                      <tbody>
                        {positionsForPool.map((position) => (
                          <tr key={position.id} className="border-t border-border/70 hover:bg-secondary/30">
                            <td className="px-4 py-3">
                              <button type="button" className="font-semibold text-left hover:text-primary" onClick={() => setSelectedPosition(position)} data-testid={`button-position-detail-${position.binId}`}>
                                {pool.tokenX.symbol}/{pool.tokenY.symbol} · Bin #{position.binId ?? position.binRangeLow}
                              </button>
                              <p className="mt-0.5 text-[10px] text-muted-foreground">{getBinStatus(position.binId ?? position.binRangeLow, pool.activeBinId)} active</p>
                            </td>
                            <td className="px-3 py-3 text-right font-mono tabular-nums">{formatUsd(position.valueUsd)}</td>
                            <td className="px-3 py-3 text-right font-mono tabular-nums">{formatTokenAmount(position.liquidityX)}</td>
                            <td className="px-3 py-3 text-right font-mono tabular-nums">{formatTokenAmount(position.liquidityY)}</td>
                            <td className="px-3 py-3 text-right font-mono tabular-nums">{formatTokenAmount(position.shares ?? 0)}</td>
                            <td className="px-4 py-3 text-right"><Button size="sm" variant="outline" onClick={() => setSelectedPosition(position)}>Details</Button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {selectedTab === "bins" && (
              <div>
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <h3 className="text-sm font-semibold">Liquidity by bin</h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">Live reserves read from the DLMM contract.</p>
                  </div>
                  <span className="font-mono text-[10px] text-muted-foreground">{pool.tokenX.symbol} / {pool.tokenY.symbol}</span>
                </div>
                <div className="h-52 w-full px-2 sm:h-64 sm:px-4">
                  {binsLoading ? <Skeleton className="h-full w-full" /> : binsForChart.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">No bin liquidity in this pool.</div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={binsForChart} margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
                        <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 5" />
                        <XAxis dataKey="price" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(value) => Number(value).toFixed(3)} />
                        <YAxis hide />
                        <Tooltip formatter={(value: number | string, name: string) => [formatTokenAmount(Number(value)), name === "liquidityX" ? pool.tokenX.symbol : pool.tokenY.symbol]} />
                        <ReferenceLine x={binsForChart.find((bin) => bin.isActive)?.price} stroke="hsl(var(--foreground) / .55)" strokeDasharray="4 4" />
                        <Bar dataKey="liquidityX" stackId="reserves" fill="hsl(var(--primary))" maxBarSize={36} />
                        <Bar dataKey="liquidityY" stackId="reserves" fill="hsl(var(--accent))" maxBarSize={36} radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
                <div className="overflow-x-auto border-t border-border">
                  <table className="w-full min-w-130 text-xs">
                    <thead className="bg-secondary/25 text-[10px] uppercase tracking-wide text-muted-foreground"><tr><th className="px-4 py-2 text-left">Bin</th><th className="px-3 py-2 text-right">Price</th><th className="px-3 py-2 text-right">{pool.tokenX.symbol}</th><th className="px-4 py-2 text-right">{pool.tokenY.symbol}</th></tr></thead>
                    <tbody>{binsForChart.map((bin) => <tr key={bin.binId} className="border-t border-border/70"><td className="px-4 py-2 font-mono">#{bin.binId}{bin.isActive && <span className="ml-2 text-[9px] font-semibold uppercase text-primary">Active</span>}</td><td className="px-3 py-2 text-right font-mono">{bin.price.toFixed(6)}</td><td className="px-3 py-2 text-right font-mono">{formatTokenAmount(bin.liquidityX)}</td><td className="px-4 py-2 text-right font-mono">{formatTokenAmount(bin.liquidityY)}</td></tr>)}</tbody>
                  </table>
                </div>
              </div>
            )}

            {selectedTab === "history" && (
              <div>
                <div className="border-b border-border px-4 py-3">
                  <h3 className="text-sm font-semibold">Closed positions</h3>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">Recent `REM_LIQ` events for this wallet. Availability is limited by testnet RPC event retention.</p>
                </div>
                {!wallet.connected ? (
                  <div className="px-5 py-10 text-center text-xs text-muted-foreground">Connect a wallet to view its close events.</div>
                ) : eventsError ? (
                  <div className="px-5 py-10 text-center text-xs text-muted-foreground">Position history could not be loaded. Restart the API server to load the latest endpoint.</div>
                ) : eventsLoading ? (
                  <div className="space-y-2 p-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
                ) : closedEvents.length === 0 ? (
                  <div className="px-5 py-10 text-center text-xs text-muted-foreground">No recent close events found for this wallet and pool.</div>
                ) : (
                  <div className="divide-y divide-border">
                    {closedEvents.map((event) => (
                      <a key={`${event.txHash}-${event.binId}`} href={`https://stellar.expert/explorer/testnet/tx/${event.txHash}`} target="_blank" rel="noreferrer" className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 hover:bg-secondary/30">
                        <div><p className="text-xs font-semibold">Closed bin #{event.binId}</p><p className="mt-1 text-[10px] text-muted-foreground">{new Date(event.timestamp).toLocaleString()}</p></div>
                        <div className="text-right text-[10px] font-mono tabular-nums"><p>{formatStroops(event.amountX)} {pool.tokenX.symbol} · {formatStroops(event.amountY)} {pool.tokenY.symbol}</p><p className="mt-1 text-muted-foreground">{formatStroops(event.shares)} shares</p></div>
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </main>

        <aside className="space-y-4">
          <section className="rounded-md border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <h2 className="text-sm font-semibold">Create position</h2>
              <p className="mt-0.5 text-[11px] text-muted-foreground">Choose a bin distribution strategy.</p>
            </div>
            <div className="space-y-4 p-4">
              <div className="grid grid-cols-3 gap-1 rounded-md bg-secondary/50 p-1">
                {STRATEGIES.map((strategy) => (
                  <button
                    key={strategy.id}
                    type="button"
                    onClick={() => setSelectedStrategy(strategy.id)}
                    className={`rounded px-2 py-2 text-[11px] font-medium transition-colors ${selectedStrategy === strategy.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    aria-pressed={selectedStrategy === strategy.id}
                    data-testid={`detail-strategy-${strategy.id}`}
                  >
                    {strategy.label}
                  </button>
                ))}
              </div>
              <div className="space-y-2 border-y border-border py-3 text-xs">
                <DetailRow label="Active bin" value={`#${pool.activeBinId}`} />
                <DetailRow label="Range" value="Set in position form" />
                <DetailRow label="Assets" value={`${pool.tokenX.symbol} + ${pool.tokenY.symbol}`} />
              </div>
              {isXlmUsdcPair && (
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Deposit XLM only. The quote side is acquired through a Stellar testnet DEX path; the rate can change before confirmation.
                </p>
              )}
              <Button className="w-full" disabled={!isLivePool} onClick={() => openLiquidity("add")} data-testid="button-create-position">
                Create position
              </Button>
              <Button variant="outline" className="w-full" disabled={!isLivePool || positionsForPool.length === 0} onClick={() => setSelectedTab("positions")} data-testid="button-detail-view-positions">
                View open positions
              </Button>
            </div>
          </section>

          <section className="border-t border-border pt-4">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Testnet activity</h2>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">Historical volume, fee, and APR data are not indexed for this testnet pool.</p>
          </section>
        </aside>
      </div>

      {isLivePool && liquidityModal && (
        <LiquidityModal
          open={!!liquidityModal}
          onOpenChange={(o) => {
            if (!o) setLiquidityBinId(null);
            setLiquidityModal(o ? liquidityModal : null);
          }}
          mode={liquidityModal}
          binId={liquidityBinId ?? pool.activeBinId}
          binStep={pool.binStep}
          tokenXSymbol={pool.tokenX.symbol}
          tokenYSymbol={pool.tokenY.symbol}
          tokenXAddress={pool.tokenX.address}
          tokenYAddress={pool.tokenY.address}
          poolId={pool.dlmmPoolId}
          initialStrategy={selectedStrategy}
          onSuccess={() => {
            void refetchBins();
            if (walletAddress) {
              void queryClient.invalidateQueries({ queryKey: getGetUserPositionsQueryKey(walletAddress) });
              void queryClient.invalidateQueries({ queryKey: getGetPoolPositionEventsQueryKey(pool.id, walletAddress) });
            }
          }}
        />
      )}

      {selectedPosition && (
        <PositionInspectorSheet
          position={selectedPosition}
          pool={pool}
          bins={binsForChart}
          open={!!selectedPosition}
          onOpenChange={(open) => { if (!open) setSelectedPosition(null); }}
          onClose={() => {
            const binId = selectedPosition.binId ?? selectedPosition.binRangeLow;
            setSelectedPosition(null);
            openLiquidity("remove", binId);
          }}
        />
      )}

      <WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
    </div>
  );
}

const STRATEGIES: { id: LiquidityStrategy; label: string }[] = [
  { id: "spot", label: "Spot" },
  { id: "curve", label: "Curve" },
  { id: "bidask", label: "Bid-Ask" },
];

function PositionInspectorSheet({
  position,
  pool,
  bins,
  open,
  onOpenChange,
  onClose,
}: {
  position: Position;
  pool: NonNullable<Position["pool"]>;
  bins: Bin[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
}) {
  const binId = position.binId ?? position.binRangeLow;
  const status = getBinStatus(binId, pool.activeBinId);
  const price = Math.pow(1 + pool.binStep / 10_000, binId);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-xl">
        <div className="border-b border-border px-5 pb-4 pt-7 sm:px-6">
          <SheetHeader>
            <div className="flex items-center gap-3">
              <div className="flex -space-x-2">
                <TokenIcon url={pool.tokenX.logoUrl} symbol={pool.tokenX.symbol} />
                <TokenIcon url={pool.tokenY.logoUrl} symbol={pool.tokenY.symbol} />
              </div>
              <div className="min-w-0">
                <SheetTitle className="text-lg">{pool.tokenX.symbol}/{pool.tokenY.symbol}</SheetTitle>
                <SheetDescription className="text-xs">Bin #{binId} · Pool {position.poolId}</SheetDescription>
              </div>
              <span className="ml-auto rounded-sm bg-secondary px-2 py-1 text-[10px] font-semibold uppercase text-muted-foreground">{status}</span>
            </div>
          </SheetHeader>
        </div>

        <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4 sm:px-6">
          <section>
            <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Current position value</h3>
            <div className="overflow-hidden rounded-md border border-border">
              <div className="flex items-center justify-between border-b border-border px-4 py-3">
                <span className="text-xs text-muted-foreground">Total value</span>
                <span className="font-mono text-lg font-semibold">{formatUsd(position.valueUsd)}</span>
              </div>
              <div className="grid grid-cols-2 divide-x divide-border">
                <div className="px-4 py-3"><p className="text-[10px] uppercase text-muted-foreground">{pool.tokenX.symbol}</p><p className="mt-1 font-mono text-sm">{formatTokenAmount(position.liquidityX)}</p></div>
                <div className="px-4 py-3"><p className="text-[10px] uppercase text-muted-foreground">{pool.tokenY.symbol}</p><p className="mt-1 font-mono text-sm">{formatTokenAmount(position.liquidityY)}</p></div>
              </div>
              <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">LP shares: <span className="font-mono text-foreground">{formatTokenAmount(position.shares ?? 0)}</span></div>
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Bin details</h3>
            <div className="grid grid-cols-2 gap-2">
              <InfoTile label="Bin price" value={`${price.toFixed(6)} ${pool.tokenY.symbol}/${pool.tokenX.symbol}`} />
              <InfoTile label="Current active bin" value={`#${pool.activeBinId}`} />
              <InfoTile label="Bin step" value={`${pool.binStep} bps`} />
              <InfoTile label="Pool fee" value={`${((pool.fee ?? 0) * 100).toFixed(2)}%`} />
            </div>
            <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">Pool price: <span className="font-mono text-foreground">{pool.currentPrice?.toFixed(6)} {pool.tokenY.symbol}/{pool.tokenX.symbol}</span>. {status === "Active" ? "This position is in the active bin." : `This bin is ${status.toLowerCase()} the active bin.`}</p>
          </section>

          <section>
            <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Pool liquidity distribution · bin #{binId} highlighted</h3>
            {bins.length === 0 ? (
              <div className="flex h-40 items-center justify-center rounded-md border border-border text-xs text-muted-foreground">No bin distribution data.</div>
            ) : (
              <div className="h-44 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={bins} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis dataKey="price" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }} tickFormatter={(value) => Number(value).toFixed(3)} interval="preserveStartEnd" />
                    <YAxis hide />
                    <Tooltip formatter={(value: number | string, name: string) => [formatTokenAmount(Number(value)), name === "liquidityX" ? pool.tokenX.symbol : pool.tokenY.symbol]} />
                    <Bar dataKey="liquidityX" stackId="reserves">{bins.map((bin) => <Cell key={`x-${bin.binId}`} fill={bin.binId === binId ? "hsl(var(--primary))" : "hsl(var(--primary) / .25)"} />)}</Bar>
                    <Bar dataKey="liquidityY" stackId="reserves">{bins.map((bin) => <Cell key={`y-${bin.binId}`} fill={bin.binId === binId ? "hsl(var(--accent))" : "hsl(var(--accent) / .25)"} />)}</Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>

          {(pool.lpFeeBps !== undefined && pool.protocolFeeBps !== undefined) && (
            <section>
              <h3 className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Swap fee split</h3>
              <div className="space-y-2 rounded-md border border-border p-3 text-[10px]">
                <DetailRow label="LPs" value={`${(pool.lpFeeBps / 100).toFixed(1)}%`} />
                <div className="h-1.5 overflow-hidden rounded bg-secondary"><div className="h-full bg-primary" style={{ width: `${pool.lpFeeBps / 100}%` }} /></div>
                <DetailRow label="Protocol" value={`${(pool.protocolFeeBps / 100).toFixed(1)}%`} />
              </div>
            </section>
          )}

          <p className="rounded-md border border-primary/20 bg-primary/5 p-3 text-[11px] leading-relaxed text-muted-foreground">Swap fees accrue directly to bin reserves. The contract does not store cost basis or a separate claimable-fee balance.</p>
        </div>

        <div className="border-t border-border bg-background px-5 py-4 sm:px-6">
          <Button className="w-full" variant="destructive" onClick={onClose} data-testid="button-inspector-close-position">Close position</Button>
          <p className="mt-2 text-center text-[10px] text-muted-foreground">Withdraw this bin’s current pro-rata reserves.</p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function DetailTab({
  selected,
  onClick,
  label,
  count,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`whitespace-nowrap border-b-2 px-4 py-3 text-xs font-medium ${selected ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
    >
      {label}<span className="ml-2 font-mono text-[10px] text-muted-foreground">{count}</span>
    </button>
  );
}

function getBinStatus(binId: number, activeBin: number) {
  if (binId === activeBin) return "Active";
  return binId < activeBin ? "Below active" : "Above active";
}

function DetailStat({ label, value, prominent = false }: { label: string; value: string; prominent?: boolean }) {
  return (
    <div className="flex items-end justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`font-mono tabular-nums ${prominent ? "text-lg font-semibold text-foreground" : "text-sm font-medium text-foreground"}`}>{value}</span>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd className="font-mono text-right tabular-nums text-foreground">{value}</dd></div>;
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-secondary/20 p-3">
      <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 wrap-break-word font-mono text-xs font-medium tabular-nums">{value}</p>
    </div>
  );
}

function formatUsd(value: number) {
  return `$${value.toLocaleString("en", { maximumFractionDigits: value < 100 ? 2 : 0 })}`;
}

function formatTokenAmount(value: number) {
  return value.toLocaleString("en", { maximumFractionDigits: 4 });
}

function formatStroops(value: string) {
  const amount = BigInt(value);
  const whole = amount / 10_000_000n;
  const fraction = (amount % 10_000_000n).toString().padStart(7, "0").slice(0, 4);
  return `${whole}.${fraction}`;
}

function reserveShare(reserveX: number, reserveY: number) {
  const total = reserveX + reserveY;
  return total > 0 ? (reserveX / total) * 100 : 50;
}

function TokenIcon({ url, symbol }: { url: string; symbol: string }) {
  return <img src={url} alt={symbol} className="h-8 w-8 rounded-full border-2 border-background bg-secondary object-cover" />;
}

function LaunchCountdown({ activationTs }: { activationTs: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const interval = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(interval);
  }, []);

  const remaining = Math.max(0, activationTs - now);
  const hh = Math.floor(remaining / 3600);
  const mm = Math.floor((remaining % 3600) / 60);
  const ss = remaining % 60;
  const pad = (n: number) => n.toString().padStart(2, "0");

  return (
    <div className="text-xs text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2 flex items-center justify-between">
      <span>Launch Pool — swaps are gated until activation (anti-snipe). Liquidity can be added now.</span>
      <span className="font-mono font-semibold shrink-0 ml-3">
        {remaining > 0 ? `${pad(hh)}:${pad(mm)}:${pad(ss)}` : "Activating…"}
      </span>
    </div>
  );
}
