import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetUserPositions,
  useGetPoolBins,
  getGetUserPositionsQueryKey,
  getGetPoolBinsQueryKey,
} from "@workspace/api-client-react";
import type { Position } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  Wallet,
  ChevronRight,
  Coins,
  Layers,
  TrendingDown,
  TrendingUp,
  Minus,
  Info,
  Sparkles,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { useWallet } from "@/contexts/wallet";
import { WalletModal } from "@/components/wallet-modal";
import { LiquidityModal } from "@/components/liquidity-modal";
import { Link } from "wouter";

interface CloseTarget {
  binId: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  poolId?: number;
}

// ─── Bin price formula: same as the Soroban contract ─────────────────────────
// price(binId) = (1 + binStep/10000)^binId
function computeBinPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10_000, binId);
}

// ─── Position status relative to the active bin ───────────────────────────────
type BinStatus = "active" | "above" | "below";

function getBinStatus(binId: number, activeBinId: number): BinStatus {
  if (binId === activeBinId) return "active";
  if (binId > activeBinId) return "above";
  return "below";
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function PositionsPage() {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [selectedPos, setSelectedPos] = useState<Position | null>(null);
  const [closeTarget, setCloseTarget] = useState<CloseTarget | null>(null);

  const address = wallet.connected ? wallet.address ?? "" : "";

  const { data: positions, isLoading } = useGetUserPositions(address, {
    query: {
      queryKey: getGetUserPositionsQueryKey(address),
      enabled: wallet.connected && !!address,
    },
  });

  function refetchPositions() {
    if (address) {
      queryClient.invalidateQueries({ queryKey: getGetUserPositionsQueryKey(address) });
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Your Positions</h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">
            Live per-bin liquidity positions read directly from the DLMM contract on Stellar testnet.
          </p>
        </div>
        {wallet.connected ? (
          <button
            onClick={() => setWalletModalOpen(true)}
            className="flex items-center gap-2 bg-secondary hover:bg-secondary/80 border border-border px-3 py-2 rounded-md text-sm transition-colors self-start"
            data-testid="button-wallet-address"
          >
            <div className="w-2 h-2 rounded-full bg-green-400" />
            <span className="font-mono">{wallet.shortAddress}</span>
            {wallet.xlmBalance && (
              <span className="text-muted-foreground text-xs">· {wallet.xlmBalance} XLM</span>
            )}
          </button>
        ) : (
          <Button onClick={() => setWalletModalOpen(true)} className="self-start" data-testid="button-connect-positions">
            <Wallet className="w-4 h-4 mr-2" />
            Connect Wallet
          </Button>
        )}
      </div>

      {/* Not connected */}
      {!wallet.connected ? (
        <Card className="p-12 flex flex-col items-center justify-center text-center bg-card border-dashed">
          <div className="w-16 h-16 bg-secondary rounded-full flex items-center justify-center mb-4">
            <Wallet className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold mb-2">Connect your wallet</h3>
          <p className="text-muted-foreground mb-6 max-w-sm">
            Your positions are read live from the on-chain DLMM contract for your address. Connect a
            wallet to see them.
          </p>
          <Button onClick={() => setWalletModalOpen(true)} data-testid="button-connect-empty">
            <Wallet className="w-4 h-4 mr-2" />
            Connect Wallet
          </Button>
        </Card>
      ) : isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-52 w-full" />)}
        </div>
      ) : !positions || positions.length === 0 ? (
        <Card className="p-12 flex flex-col items-center justify-center text-center bg-card border-dashed">
          <div className="w-16 h-16 bg-secondary rounded-full flex items-center justify-center mb-4">
            <Coins className="w-8 h-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold mb-2">No active positions</h3>
          <p className="text-muted-foreground mb-6 max-w-xs">
            Provide liquidity to the DLMM pool to start earning a pro-rata share of every swap.
          </p>
          <Link href="/pools">
            <Button data-testid="button-explore-pools">
              Explore Pools <ChevronRight className="w-4 h-4 ml-1" />
            </Button>
          </Link>
        </Card>
      ) : (
        <>
          {/* Summary strip */}
          <div className="grid grid-cols-3 gap-3">
            <SummaryCard
              label="Total Value"
              value={`$${positions.reduce((s, p) => s + p.valueUsd, 0).toLocaleString("en", { maximumFractionDigits: 2 })}`}
            />
            <SummaryCard label="Bins" value={`${positions.length}`} />
            <SummaryCard
              label="Total Shares"
              value={positions.reduce((s, p) => s + (p.shares ?? 0), 0).toLocaleString("en", { maximumFractionDigits: 0 })}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            Click a position card to view details, bin distribution, and close the position.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {positions.map((pos) => {
              const binId = pos.binId ?? pos.binRangeLow;
              const tokenXSymbol = pos.pool?.tokenX.symbol ?? "X";
              const tokenYSymbol = pos.pool?.tokenY.symbol ?? "Y";
              const activeBinId = pos.pool?.activeBinId ?? binId;
              const status = getBinStatus(binId, activeBinId);

              return (
                <Card
                  key={pos.id}
                  className="p-5 bg-card border-border flex flex-col gap-4 cursor-pointer hover:border-primary/50 transition-colors group"
                  onClick={() => setSelectedPos(pos)}
                  data-testid={`card-position-${pos.id}`}
                >
                  {/* Pair header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="flex -space-x-2">
                        <img
                          src={pos.pool?.tokenX.logoUrl}
                          alt={tokenXSymbol}
                          className="w-8 h-8 rounded-full border-2 border-background bg-secondary object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                        <img
                          src={pos.pool?.tokenY.logoUrl}
                          alt={tokenYSymbol}
                          className="w-8 h-8 rounded-full border-2 border-background bg-secondary object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      </div>
                      <div>
                        <h3 className="font-bold text-sm leading-tight">
                          {tokenXSymbol}/{tokenYSymbol}
                        </h3>
                        <span className="text-xs px-1.5 py-0.5 rounded-sm font-semibold uppercase tracking-wider bg-primary/15 text-primary inline-flex items-center gap-1 mt-0.5">
                          <Layers className="w-3 h-3" /> Bin {binId}
                        </span>
                      </div>
                    </div>
                    <div className="text-right flex flex-col items-end gap-1">
                      <div className="text-lg font-mono font-bold tabular-nums">
                        ${pos.valueUsd.toLocaleString("en", { maximumFractionDigits: 2 })}
                      </div>
                      <BinStatusBadge status={status} />
                    </div>
                  </div>

                  {/* Reserves */}
                  <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
                    <ReserveStat symbol={tokenXSymbol} amount={pos.liquidityX} />
                    <ReserveStat symbol={tokenYSymbol} amount={pos.liquidityY} />
                  </div>

                  {/* Click affordance */}
                  <div className="flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Layers className="w-3 h-3" />
                      {(pos.shares ?? 0).toLocaleString("en", { maximumFractionDigits: 0 })} shares
                    </span>
                    <span className="flex items-center gap-1 group-hover:text-primary transition-colors">
                      View details <ChevronRight className="w-3 h-3" />
                    </span>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />

      {/* Position detail sheet */}
      {selectedPos && (
        <PositionDetailSheet
          pos={selectedPos}
          open={!!selectedPos}
          onOpenChange={(o) => { if (!o) setSelectedPos(null); }}
          onClose={(target) => {
            setSelectedPos(null);
            setCloseTarget(target);
          }}
        />
      )}

      {/* Close position → reuse existing remove modal */}
      {closeTarget && (
        <LiquidityModal
          open={!!closeTarget}
          onOpenChange={(o) => { if (!o) setCloseTarget(null); }}
          mode="remove"
          binId={closeTarget.binId}
          tokenXSymbol={closeTarget.tokenXSymbol}
          tokenYSymbol={closeTarget.tokenYSymbol}
          poolId={closeTarget.poolId}
          onSuccess={() => {
            setCloseTarget(null);
            refetchPositions();
          }}
        />
      )}
    </div>
  );
}

// ─── Position detail side sheet ───────────────────────────────────────────────
function PositionDetailSheet({
  pos,
  open,
  onOpenChange,
  onClose,
}: {
  pos: Position;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onClose: (target: CloseTarget) => void;
}) {
  const binId = pos.binId ?? pos.binRangeLow;
  const pool = pos.pool;
  const tokenXSymbol = pool?.tokenX.symbol ?? "X";
  const tokenYSymbol = pool?.tokenY.symbol ?? "Y";
  const binStep = pool?.binStep ?? 0;
  const activeBinId = pool?.activeBinId ?? binId;
  const status = getBinStatus(binId, activeBinId);
  const binPrice = binStep > 0 ? computeBinPrice(binId, binStep) : null;

  // Load bin distribution for the pool (real on-chain data)
  const { data: bins, isLoading: binsLoading } = useGetPoolBins(pos.poolId, {
    query: {
      queryKey: getGetPoolBinsQueryKey(pos.poolId),
      enabled: open && !!pos.poolId,
    },
  });

  function handleClose() {
    onClose({
      binId,
      tokenXSymbol,
      tokenYSymbol,
      poolId: pool?.dlmmPoolId,
    });
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg overflow-y-auto flex flex-col gap-0 p-0"
      >
        {/* Header */}
        <div className="px-6 pt-8 pb-4 border-b border-border">
          <SheetHeader>
            <div className="flex items-center gap-3 mb-2">
              <div className="flex -space-x-2">
                <img
                  src={pool?.tokenX.logoUrl}
                  alt={tokenXSymbol}
                  className="w-9 h-9 rounded-full border-2 border-background bg-secondary object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
                <img
                  src={pool?.tokenY.logoUrl}
                  alt={tokenYSymbol}
                  className="w-9 h-9 rounded-full border-2 border-background bg-secondary object-cover"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                />
              </div>
              <div>
                <SheetTitle className="text-xl">
                  {tokenXSymbol}/{tokenYSymbol}
                </SheetTitle>
                <SheetDescription className="text-xs mt-0.5">
                  Bin #{binId} · Pool {pos.poolId}
                </SheetDescription>
              </div>
              <div className="ml-auto">
                <BinStatusBadge status={status} large />
              </div>
            </div>
          </SheetHeader>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {/* Current value breakdown */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Current Position Value
            </h3>
            <div className="bg-secondary/30 border border-border rounded-lg overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <span className="text-sm text-muted-foreground">Total USD</span>
                <span className="text-xl font-mono font-bold tabular-nums">
                  ${pos.valueUsd.toLocaleString("en", { maximumFractionDigits: 2 })}
                </span>
              </div>
              <div className="grid grid-cols-2 divide-x divide-border">
                <div className="px-4 py-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {tokenXSymbol}
                  </p>
                  <p className="text-sm font-mono font-semibold tabular-nums mt-0.5">
                    {pos.liquidityX.toLocaleString("en", { maximumFractionDigits: 4 })}
                  </p>
                </div>
                <div className="px-4 py-3">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider">
                    {tokenYSymbol}
                  </p>
                  <p className="text-sm font-mono font-semibold tabular-nums mt-0.5">
                    {pos.liquidityY.toLocaleString("en", { maximumFractionDigits: 4 })}
                  </p>
                </div>
              </div>
              <div className="px-4 py-2.5 border-t border-border">
                <span className="text-xs text-muted-foreground">LP Shares: </span>
                <span className="text-xs font-mono font-semibold">
                  {(pos.shares ?? 0).toLocaleString("en", { maximumFractionDigits: 0 })}
                </span>
              </div>
            </div>
          </section>

          {/* Bin info */}
          {binStep > 0 && (
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Bin Details
              </h3>
              <div className="grid grid-cols-2 gap-2">
                <InfoTile label="Bin Price" value={binPrice !== null ? `${binPrice.toFixed(6)} ${tokenYSymbol}/${tokenXSymbol}` : "—"} />
                <InfoTile label="Current Active Bin" value={`#${activeBinId}`} />
                <InfoTile label="Bin Step" value={`${binStep} bps (${(binStep / 100).toFixed(2)}%)`} />
                <InfoTile label="Pool Fee" value={pool?.fee !== undefined ? `${pool.fee}%` : "—"} />
              </div>
              {binPrice !== null && pool?.currentPrice !== undefined && (
                <p className="text-[11px] text-muted-foreground mt-2 px-1">
                  Live pool price: <span className="font-mono font-medium text-foreground">{pool.currentPrice.toFixed(6)} {tokenYSymbol}/{tokenXSymbol}</span>.
                  {" "}
                  {status === "active"
                    ? "Your bin is the active bin — swap transactions currently pass through this bin and accumulate fees in your reserves."
                    : status === "above"
                    ? `Your bin is above the active bin — this position only holds ${tokenXSymbol} and will accumulate fees when the price rises through this bin.`
                    : `Your bin is below the active bin — this position only holds ${tokenYSymbol} and will accumulate fees when the price drops through this bin.`
                  }
                </p>
              )}
            </section>
          )}

          {/* Bin distribution chart */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              Pool Liquidity Distribution — Bin #{binId} Highlighted
            </h3>
            {binsLoading ? (
              <Skeleton className="h-[180px] w-full" />
            ) : bins && bins.length > 0 ? (
              <div className="h-[180px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={bins} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                    <XAxis
                      dataKey="price"
                      tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }}
                      tickFormatter={(v) => Number(v).toFixed(3)}
                      interval="preserveStartEnd"
                    />
                    <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 9 }} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "hsl(var(--card))",
                        borderColor: "hsl(var(--border))",
                        color: "hsl(var(--foreground))",
                        fontSize: 11,
                      }}
                      formatter={(value, name) => [
                        Number(value).toFixed(4),
                        name === "liquidityX" ? tokenXSymbol : tokenYSymbol,
                      ]}
                      labelFormatter={(label) => `Price: ${Number(label).toFixed(6)}`}
                    />
                    <Bar dataKey="liquidityX" stackId="a" name="liquidityX">
                      {bins.map((b) => (
                        <Cell
                          key={`x-${b.binId}`}
                          fill={
                            b.binId === binId
                              ? "hsl(var(--primary))"
                              : "hsl(var(--primary) / 0.25)"
                          }
                        />
                      ))}
                    </Bar>
                    <Bar dataKey="liquidityY" stackId="a" name="liquidityY">
                      {bins.map((b) => (
                        <Cell
                          key={`y-${b.binId}`}
                          fill={
                            b.binId === binId
                              ? "hsl(var(--accent))"
                              : "hsl(var(--accent) / 0.25)"
                          }
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            ) : (
              <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground border border-border rounded-lg">
                Bin distribution data unavailable
              </div>
            )}
            {bins && bins.length > 0 && (
              <div className="flex items-center gap-4 mt-1.5 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-primary inline-block" /> {tokenXSymbol} (your bin)
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-accent inline-block" /> {tokenYSymbol} (your bin)
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2 h-2 rounded-sm bg-primary/25 inline-block" /> Other bins
                </span>
              </div>
            )}
          </section>

          {/* LP / Protocol fee split */}
          {pool?.lpFeeBps !== undefined && pool?.protocolFeeBps !== undefined && (
            <section>
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
                Swap Fee Split
              </h3>
              <div className="bg-secondary/30 border border-border rounded-lg px-4 py-3 space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">LP (you &amp; other liquidity providers)</span>
                  <span className="font-semibold text-foreground">{(pool.lpFeeBps / 100).toFixed(1)}%</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden flex">
                  <div className="h-full bg-primary" style={{ width: `${pool.lpFeeBps / 100}%` }} />
                  <div className="h-full bg-amber-500/70" style={{ width: `${pool.protocolFeeBps / 100}%` }} />
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Protocol (treasury)</span>
                  <span className="font-semibold text-foreground">{(pool.protocolFeeBps / 100).toFixed(1)}%</span>
                </div>
              </div>
            </section>
          )}

          {/* Close position explanation */}
          <section>
            <div className="flex items-start gap-3 rounded-lg border border-primary/20 bg-primary/5 p-3">
              <Info className="w-4 h-4 text-primary mt-0.5 shrink-0" />
              <div className="space-y-1 text-xs">
                <p className="font-semibold text-foreground">About Closing a Position</p>
                <p className="text-muted-foreground leading-relaxed">
                  In DLMM, there is <strong className="text-foreground">no separate "claim fee" function</strong>.
                  Swap fees passing through this bin are directly added to the bin reserves — your LP share value
                  increases automatically. When you <strong className="text-foreground">close your position (remove liquidity)</strong>,
                  you receive back your full principal + all accumulated fees, proportional to your share count.
                </p>
                <p className="text-muted-foreground mt-1">
                  <strong className="text-amber-400">⚠ P&amp;L vs original deposit:</strong>{" "}
                  Cost basis is not stored on-chain — you need to compare the amount received on close against what you originally deposited.
                </p>
              </div>
            </div>
          </section>
        </div>

        {/* Action footer */}
        <div className="px-6 py-4 border-t border-border bg-background space-y-2">
          <Button
            className="w-full"
            variant="destructive"
            onClick={handleClose}
            data-testid="button-close-position"
          >
            <Sparkles className="w-4 h-4 mr-2" />
            Close Position &amp; Claim Fees
          </Button>
          <p className="text-[10px] text-center text-muted-foreground">
            Withdraw 100% liquidity from Bin #{binId} — principal + all accumulated fees will be returned
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function BinStatusBadge({ status, large = false }: { status: BinStatus; large?: boolean }) {
  const base = large ? "text-xs px-2 py-1 rounded-md" : "text-[10px] px-1.5 py-0.5 rounded-sm";
  if (status === "active") {
    return (
      <span className={`${base} bg-green-500/15 text-green-400 font-semibold inline-flex items-center gap-1`}>
        <Minus className="w-3 h-3" /> In Range
      </span>
    );
  }
  if (status === "above") {
    return (
      <span className={`${base} bg-blue-500/15 text-blue-400 font-semibold inline-flex items-center gap-1`}>
        <TrendingUp className="w-3 h-3" /> Above Active
      </span>
    );
  }
  return (
    <span className={`${base} bg-orange-500/15 text-orange-400 font-semibold inline-flex items-center gap-1`}>
      <TrendingDown className="w-3 h-3" /> Below Active
    </span>
  );
}

function ReserveStat({ symbol, amount }: { symbol: string; amount: number }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{symbol}</p>
      <p className="text-sm font-mono font-semibold tabular-nums mt-0.5">
        {amount.toLocaleString("en", { maximumFractionDigits: 4 })}
      </p>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-secondary/30 border border-border rounded-lg px-3 py-2.5">
      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className="text-xs font-mono font-semibold mt-0.5 break-all">{value}</p>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  valueClass = "text-foreground",
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-card border border-border rounded-lg px-4 py-3">
      <p className="text-xs text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-mono font-bold mt-0.5 tabular-nums ${valueClass}`}>{value}</p>
    </div>
  );
}
