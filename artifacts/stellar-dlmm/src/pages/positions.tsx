import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { scValToNative } from "@stellar/stellar-sdk";
import {
  useGetUserPositions,
  useGetPoolBins,
  getGetUserPositionsQueryKey,
  getGetPoolBinsQueryKey,
  useGetPortfolioSummary,
  getGetPortfolioSummaryQueryKey,
} from "@workspace/api-client-react";
import type { Position, PortfolioClosedPosition } from "@workspace/api-client-react";
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
  CalendarDays,
  ChevronLeft,
  ExternalLink,
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
import { useToast } from "@/hooks/use-toast";
import { buildClaimFeeTransaction, submitSignedTransaction } from "@/lib/dlmm-client";
import { stroopsToDisplay } from "@/lib/stellar";
import { Link } from "wouter";
import { DLMM_V2_CONTRACT_ID } from "@/lib/contracts";

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
  const [portfolioTab, setPortfolioTab] = useState<"live" | "historical">("live");
  const [calendarMonth, setCalendarMonth] = useState(
    () => new Date(new Date().getFullYear(), new Date().getMonth(), 1),
  );

  const address = wallet.connected ? wallet.address ?? "" : "";

  const { data: positions, isLoading } = useGetUserPositions(address, {
    query: {
      queryKey: getGetUserPositionsQueryKey(address),
      enabled: wallet.connected && !!address,
    },
  });
  const {
    data: portfolio,
    isLoading: portfolioLoading,
    isError: portfolioError,
  } = useGetPortfolioSummary(address, {
    query: {
      queryKey: getGetPortfolioSummaryQueryKey(address),
      enabled: wallet.connected && !!address,
    },
  });

  const calendarCells = useMemo(() => getCalendarCells(calendarMonth), [calendarMonth]);
  const dailyPnl = useMemo(
    () => new Map((portfolio?.dailyPnl ?? []).map((entry) => [entry.date, entry])),
    [portfolio?.dailyPnl],
  );
  const pnlUnit = portfolio?.pnlUnit ?? "USD";
  const monthlyPnl = portfolio?.dailyPnl
    .filter((entry) => entry.date.startsWith(monthKey(calendarMonth)))
    .reduce((sum, entry) => sum + entry.pnl, 0) ?? 0;
  const closedPositions = portfolio?.closedPositions ?? [];
  const wins = closedPositions.filter((position) => position.pnl > 0);
  const winRate = closedPositions.length > 0 ? (wins.length / closedPositions.length) * 100 : null;
  const biggestWin = closedPositions.reduce(
    (best, position) => Math.max(best, position.pnl),
    0,
  );

  function refetchPositions() {
    if (address) {
      queryClient.invalidateQueries({ queryKey: getGetUserPositionsQueryKey(address) });
      queryClient.invalidateQueries({ queryKey: getGetPortfolioSummaryQueryKey(address) });
    }
  }

  return (
    <div className="space-y-5" data-testid="page-portfolio">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Portfolio</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Current DLMM positions and PnL from available on-chain events.
          </p>
        </div>
      </header>

      {/* Not connected */}
      {!wallet.connected ? (
        <Card className="flex flex-col items-center justify-center border-dashed bg-card px-6 py-16 text-center">
          <Wallet className="mb-4 h-10 w-10 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Connect your wallet</h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">
            Portfolio positions and available PnL history are read for the connected Stellar account.
          </p>
          <Button className="mt-5" onClick={() => setWalletModalOpen(true)} data-testid="button-connect-empty">
            <Wallet className="mr-2 h-4 w-4" />Connect Wallet
          </Button>
        </Card>
      ) : isLoading || portfolioLoading ? (
        <Skeleton className="h-105 w-full" />
      ) : (
        <>
          <section className="overflow-hidden rounded-md border border-border bg-card" data-testid="portfolio-summary">
            <div className="grid lg:grid-cols-[320px_minmax(0,1fr)]">
              <div className="space-y-5 border-b border-border p-5 lg:border-b-0 lg:border-r">
                <div>
                  <MetricLabel>Total Portfolio Value ({pnlUnit})</MetricLabel>
                  <p className="mt-1 font-mono text-3xl font-bold tabular-nums">{formatPortfolioValue(portfolio?.totalValue, pnlUnit)}</p>
                </div>
                <div className="grid grid-cols-2 gap-4 border-b border-border pb-5">
                  <PortfolioMetric label={`Deposits · window (${pnlUnit})`} value={formatPortfolioValue(portfolio?.deposits, pnlUnit)} />
                  <PortfolioMetric label={`Fees Claimed (${pnlUnit})`} value={formatPortfolioValue(portfolio?.feesClaimed, pnlUnit)} />
                  <PortfolioMetric label={`Claimable Fees (${pnlUnit})`} value={formatPortfolioValue(portfolio?.claimableFees, pnlUnit)} />
                  <PortfolioMetric label="Active Bins" value={(positions?.length ?? 0).toLocaleString("en-US")} />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <MetricLabel>Total PnL · {pnlUnit} equivalent</MetricLabel>
                    <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">RPC window</span>
                  </div>
                  <p className={`mt-2 font-mono text-2xl font-bold tabular-nums ${portfolio && portfolio.totalPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                    {formatSignedPortfolioValue(portfolio?.totalPnl, pnlUnit)}
                  </p>
                  <div className="mt-4 grid grid-cols-2 gap-4">
                    <PortfolioMetric label="Win Rate" value={winRate === null ? "—" : `${winRate.toFixed(2)}%`} />
                    <PortfolioMetric label={`Biggest Realized Win (${pnlUnit})`} value={biggestWin > 0 ? formatPortfolioValue(biggestWin, pnlUnit) : "—"} />
                  </div>
                </div>
              </div>

              <div className="min-w-0 p-4 sm:p-5">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <CalendarDays className="h-4 w-4 text-primary" />
                    <h2 className="font-semibold">Realized PnL Calendar</h2>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setCalendarMonth((month) => new Date(month.getFullYear(), month.getMonth() - 1, 1))}
                      aria-label="Previous month"
                      className="flex h-8 w-8 items-center justify-center rounded border border-border hover:bg-secondary"
                    ><ChevronLeft className="h-4 w-4" /></button>
                    <span className="min-w-32 text-center text-sm font-medium">{calendarMonth.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
                    <button
                      type="button"
                      onClick={() => setCalendarMonth((month) => new Date(month.getFullYear(), month.getMonth() + 1, 1))}
                      aria-label="Next month"
                      className="flex h-8 w-8 items-center justify-center rounded border border-border hover:bg-secondary"
                    ><ChevronRight className="h-4 w-4" /></button>
                    <Button variant="secondary" size="sm" className="ml-1 h-8" onClick={() => setCalendarMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Today</Button>
                  </div>
                </div>
                <div className="mb-3 flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Daily closed-position PnL + claimed fees</span>
                  <span className={`font-mono font-semibold ${monthlyPnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>Monthly: {formatSignedPortfolioValue(monthlyPnl, pnlUnit)}</span>
                </div>
                <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium text-muted-foreground">
                  {WEEKDAYS.map((day) => <div key={day} className="py-1">{day}</div>)}
                </div>
                <div className="grid grid-cols-7 gap-1" data-testid="portfolio-pnl-calendar">
                  {calendarCells.map((date) => {
                    const key = calendarDateKey(date);
                    const pnl = dailyPnl.get(key);
                    const currentMonth = date.getMonth() === calendarMonth.getMonth();
                    return (
                      <div
                        key={key}
                        className={`flex min-h-14 flex-col border-t border-border/70 px-1.5 py-1 text-left sm:min-h-15.5 ${!currentMonth ? "opacity-30" : ""} ${pnl ? pnl.pnl > 0 ? "border-l-2 border-l-emerald-400 bg-emerald-400/10" : pnl.pnl < 0 ? "border-l-2 border-l-rose-400 bg-rose-400/10" : "bg-secondary/30" : "bg-background/30"}`}
                        data-testid={`portfolio-pnl-day-${key}`}
                      >
                        <span className="text-[10px] text-muted-foreground">{date.getDate()}</span>
                        {currentMonth && pnl ? (
                          <>
                            <span className={`mt-auto truncate font-mono text-[10px] font-semibold ${pnl.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                              {formatSignedPortfolioValue(pnl.pnl, pnlUnit)}
                            </span>
                            <span className="truncate text-[9px] text-muted-foreground">{pnl.eventCount} event{pnl.eventCount === 1 ? "" : "s"}</span>
                          </>
                        ) : currentMonth ? <span className="mt-auto text-[10px] text-muted-foreground">—</span> : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </section>

          {portfolioError && (
            <p className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">
              Portfolio event data could not be loaded. Current positions are still shown when available.
            </p>
          )}
          {portfolio && (portfolio.historyTruncated || portfolio.basisMissingCount > 0 || portfolio.historicalPriceGapCount > 0 || portfolio.unpricedPoolCount > 0) && (
            <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-xs leading-relaxed text-amber-200" role="status">
              PnL can be partial{portfolio.basisMissingCount > 0 ? `; ${portfolio.basisMissingCount} position(s) have no matching deposit event in the available window` : ""}{portfolio.historicalPriceGapCount > 0 ? `; ${portfolio.historicalPriceGapCount} event cashflow(s) cannot be converted to ${portfolio.pnlUnit}` : ""}{portfolio.unpricedPoolCount > 0 ? `; no ${portfolio.pnlUnit} conversion is available for ${portfolio.unpricedPoolCount} pool(s)` : ""}{portfolio.historyTruncated ? "; event pagination reached its safety limit" : ""}.
            </p>
          )}
          {portfolio && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {portfolio.historyWindow}. PnL is shown in {portfolio.pnlUnit}; XLM amounts are equivalent values, while on-chain fee claims still transfer the pool&apos;s actual token X and token Y. Cashflows without a supported conversion are excluded rather than estimated.
            </p>
          )}

          <div className="flex items-center gap-5 border-b border-border" role="tablist" aria-label="Portfolio positions">
            <button type="button" role="tab" aria-selected={portfolioTab === "live"} onClick={() => setPortfolioTab("live")} className={`border-b-2 px-1 py-3 text-sm font-medium ${portfolioTab === "live" ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}>Live Positions</button>
            <button type="button" role="tab" aria-selected={portfolioTab === "historical"} onClick={() => setPortfolioTab("historical")} className={`border-b-2 px-1 py-3 text-sm font-medium ${portfolioTab === "historical" ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}>Historical</button>
          </div>

          {portfolioTab === "live" ? (
            <PortfolioLivePositions
              positions={positions ?? []}
              pnlUnit={pnlUnit}
              onSelect={setSelectedPos}
              onExplore={() => { window.location.href = "/pools"; }}
            />
          ) : (
            <PortfolioHistory positions={portfolio?.closedPositions ?? []} pnlUnit={pnlUnit} />
          )}
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
          onClaimed={refetchPositions}
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

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function getCalendarCells(month: Date): Date[] {
  const firstDay = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = firstDay.getDay();
  const dayCount = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
  const cellCount = Math.ceil((offset + dayCount) / 7) * 7;
  return Array.from({ length: cellCount }, (_, index) =>
    new Date(month.getFullYear(), month.getMonth(), index - offset + 1),
  );
}

function calendarDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function formatPortfolioValue(value: number | undefined, unit: "USD" | "XLM"): string {
  return value === undefined || !Number.isFinite(value)
    ? "—"
    : unit === "USD"
    ? `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 4 })} XLM`;
}

function formatSignedPortfolioValue(value: number | undefined, unit: "USD" | "XLM"): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatPortfolioValue(Math.abs(value), unit)}`;
}

function MetricLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{children}</p>;
}

function PortfolioMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <MetricLabel>{label}</MetricLabel>
      <p className="mt-1 truncate font-mono text-sm font-semibold tabular-nums" title={value}>{value}</p>
    </div>
  );
}

function PortfolioLivePositions({
  positions,
  pnlUnit,
  onSelect,
  onExplore,
}: {
  positions: Position[];
  pnlUnit: "USD" | "XLM";
  onSelect: (position: Position) => void;
  onExplore: () => void;
}) {
  if (positions.length === 0) {
    return (
      <div className="border-y border-border py-12 text-center">
        <p className="text-sm font-medium">No active positions</p>
        <p className="mt-1 text-xs text-muted-foreground">Closed positions, when available, are listed under Historical.</p>
        <Button className="mt-4" size="sm" onClick={onExplore} data-testid="button-explore-pools">
          Explore pools <ChevronRight className="ml-1 h-4 w-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full min-w-190 text-sm">
        <thead className="bg-secondary/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Pool / Bin</th>
            <th className="px-4 py-3 text-right font-medium">Current Value ({pnlUnit})</th>
            <th className="px-4 py-3 text-right font-medium">Claimable Fees ({pnlUnit})</th>
            <th className="px-4 py-3 text-right font-medium">Token X</th>
            <th className="px-4 py-3 text-right font-medium">Token Y</th>
            <th className="px-4 py-3 text-right font-medium">Shares</th>
            <th className="w-8 px-3 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {positions.map((position) => {
            const binId = position.binId ?? position.binRangeLow;
            const tokenX = position.pool?.tokenX.symbol ?? "X";
            const tokenY = position.pool?.tokenY.symbol ?? "Y";
            return (
              <tr
                key={position.id}
                tabIndex={0}
                role="button"
                onClick={() => onSelect(position)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(position);
                  }
                }}
                className="cursor-pointer hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
                data-testid={`portfolio-live-${position.id}`}
              >
                <td className="px-4 py-3">
                  <p className="font-semibold">{tokenX}/{tokenY}</p>
                  <p className="mt-0.5 text-[10px] text-muted-foreground">DLMM · Bin #{binId}</p>
                </td>
                <td className="px-4 py-3 text-right font-mono tabular-nums">{pnlUnit === "USD" ? formatPortfolioValue(position.valueUsd, pnlUnit) : formatPortfolioValue(position.valueXlm, pnlUnit)}</td>
                <td className="px-4 py-3 text-right font-mono tabular-nums text-emerald-400">{pnlUnit === "USD" ? formatPortfolioValue(position.unrealizedFees, pnlUnit) : formatPortfolioValue(position.claimableFeesXlm, pnlUnit)}</td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">{position.liquidityX.toLocaleString("en-US", { maximumFractionDigits: 4 })} {tokenX}</td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">{position.liquidityY.toLocaleString("en-US", { maximumFractionDigits: 4 })} {tokenY}</td>
                <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">{(position.shares ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                <td className="px-3 py-3 text-muted-foreground"><ChevronRight className="h-4 w-4" /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PortfolioHistory({ positions, pnlUnit }: { positions: PortfolioClosedPosition[]; pnlUnit: "USD" | "XLM" }) {
  if (positions.length === 0) {
    return <div className="border-y border-border py-12 text-center text-sm text-muted-foreground">No closed positions in the available RPC event window.</div>;
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border bg-card">
      <table className="w-full min-w-235 text-sm">
        <thead className="bg-secondary/40 text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-medium">Pool / Bin</th>
            <th className="px-4 py-3 font-medium">Opened / Closed</th>
            <th className="px-4 py-3 text-right font-medium">Deposits ({pnlUnit})</th>
            <th className="px-4 py-3 text-right font-medium">Withdrawn ({pnlUnit})</th>
            <th className="px-4 py-3 text-right font-medium">Fees Claimed ({pnlUnit})</th>
            <th className="px-4 py-3 text-right font-medium">Realized PnL ({pnlUnit})</th>
            <th className="w-10 px-3 py-3" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {positions.map((position) => (
            <tr key={position.id} data-testid={`portfolio-history-${position.id}`}>
              <td className="px-4 py-3">
                <p className="font-semibold">{position.poolName}</p>
                <p className="mt-0.5 text-[10px] text-muted-foreground">Bin #{position.binId}</p>
              </td>
              <td className="px-4 py-3 text-xs text-muted-foreground">
                <p>{new Date(position.openedAt).toLocaleString()}</p>
                <p className="mt-1">{new Date(position.closedAt).toLocaleString()}</p>
              </td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">{formatPortfolioValue(position.deposits, pnlUnit)}</td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">{formatPortfolioValue(position.withdrawn, pnlUnit)}</td>
              <td className="px-4 py-3 text-right font-mono tabular-nums">{formatPortfolioValue(position.feesClaimed, pnlUnit)}</td>
              <td className={`px-4 py-3 text-right font-mono font-semibold tabular-nums ${position.pnl >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
                {formatSignedPortfolioValue(position.pnl, pnlUnit)}
              </td>
              <td className="px-3 py-3 text-right">
                <a href={`https://stellar.expert/explorer/testnet/tx/${position.txHash}`} target="_blank" rel="noreferrer" aria-label={`View close transaction ${position.txHash}`} className="inline-flex text-muted-foreground hover:text-primary">
                  <ExternalLink className="h-4 w-4" />
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Position detail side sheet ───────────────────────────────────────────────
function PositionDetailSheet({
  pos,
  open,
  onOpenChange,
  onClose,
  onClaimed,
}: {
  pos: Position;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onClose: (target: CloseTarget) => void;
  onClaimed: () => void;
}) {
  const wallet = useWallet();
  const { toast } = useToast();
  const [claimingFees, setClaimingFees] = useState(false);
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

  async function handleClaimFees() {
    const poolId = pool?.dlmmPoolId;
    if (!wallet.address || poolId === undefined) return;
    setClaimingFees(true);
    try {
      const prepared = await buildClaimFeeTransaction(wallet.address, binId, poolId);
      const signedXdr = await wallet.signTransaction(prepared.toXDR());
      const returnValue = await submitSignedTransaction(signedXdr);
      const claimed = scValToNative(returnValue as any) as [bigint, bigint];
      toast({
        title: "LP fees claimed",
        description: `${stroopsToDisplay(claimed[0])} ${tokenXSymbol} and ${stroopsToDisplay(claimed[1])} ${tokenYSymbol}`,
      });
      await wallet.refreshBalance();
      onClaimed();
    } catch (error) {
      toast({
        title: "Fee claim failed",
        description: error instanceof Error ? error.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setClaimingFees(false);
    }
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
              <div className="px-4 py-2.5 border-t border-border flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Claimable swap fees</span>
                <span className="text-xs font-mono font-semibold">
                  ${(pos.unrealizedFees ?? 0).toLocaleString("en", { maximumFractionDigits: 4 })}
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
              <Skeleton className="h-45 w-full" />
            ) : bins && bins.length > 0 ? (
              <div className="h-45 w-full">
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
              <div className="h-45 flex items-center justify-center text-xs text-muted-foreground border border-border rounded-lg">
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
                  Swap fees are tracked separately from bin principal and can be claimed without removing liquidity.
                  Closing a position withdraws its pro-rata bin reserves; claimable fees remain a separate action.
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
            variant="outline"
            onClick={handleClaimFees}
            disabled={claimingFees || pool?.dlmmPoolId === undefined || !DLMM_V2_CONTRACT_ID}
            data-testid="button-claim-position-fees"
          >
            {claimingFees ? "Claiming fees…" : DLMM_V2_CONTRACT_ID ? "Claim fees" : "Claim fees (V2 required)"}
          </Button>
          <Button
            className="w-full"
            variant="destructive"
            onClick={handleClose}
            data-testid="button-close-position"
          >
            <Sparkles className="w-4 h-4 mr-2" />
            Close Position
          </Button>
          <p className="text-[10px] text-center text-muted-foreground">
            Withdraw 100% liquidity from Bin #{binId}; claimable swap fees are separate
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
