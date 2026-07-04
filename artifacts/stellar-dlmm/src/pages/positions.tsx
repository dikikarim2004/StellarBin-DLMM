import { useState } from "react";
import { useGetUserPositions, getGetUserPositionsQueryKey } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Wallet, TrendingUp, ChevronRight, Coins } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { WalletModal } from "@/components/wallet-modal";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";

const STRATEGY_LABELS: Record<string, { label: string; cls: string }> = {
  spot: { label: "Spot", cls: "bg-blue-500/15 text-blue-400" },
  curve: { label: "Curve", cls: "bg-violet-500/15 text-violet-400" },
  bid_ask: { label: "Bid-Ask", cls: "bg-amber-500/15 text-amber-400" },
};

export default function PositionsPage() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [walletModalOpen, setWalletModalOpen] = useState(false);

  // Use real wallet address when connected, else a demo address for preview
  const demoAddress = "GAHTJHVFHJKD4567DEMOADDRESS12345678901234";
  const queryAddress = wallet.connected ? wallet.address! : demoAddress;

  const { data: positions, isLoading } = useGetUserPositions(queryAddress, {
    query: { queryKey: getGetUserPositionsQueryKey(queryAddress) },
  });

  function handleClaimFees(posId: string) {
    if (!wallet.connected) { setWalletModalOpen(true); return; }
    toast({ title: "Claim Fees", description: `Signing claim for position ${posId}…` });
  }

  function handleRemove(posId: string) {
    if (!wallet.connected) { setWalletModalOpen(true); return; }
    toast({ title: "Remove Liquidity", description: `Signing removal for position ${posId}…` });
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Your Positions</h1>
          <p className="text-muted-foreground mt-1 text-sm sm:text-base">Manage your DLMM liquidity positions</p>
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

      {/* Connect prompt (shown as info, not blocker) */}
      {!wallet.connected && (
        <div className="flex items-center gap-3 bg-primary/5 border border-primary/20 rounded-lg px-4 py-3 text-sm">
          <Wallet className="w-4 h-4 text-primary shrink-0" />
          <span className="text-muted-foreground">
            Connect your wallet to see your real positions.{" "}
            <span className="text-foreground">Showing demo data below.</span>
          </span>
          <Button size="sm" variant="outline" className="ml-auto shrink-0" onClick={() => setWalletModalOpen(true)}>
            Connect
          </Button>
        </div>
      )}

      {/* Positions grid */}
      {isLoading ? (
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
            Provide liquidity to a DLMM pool to start earning dynamic fees on every swap.
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
              value={`$${positions.reduce((s, p) => s + p.valueUsd, 0).toLocaleString("en", { maximumFractionDigits: 0 })}`}
            />
            <SummaryCard
              label="Unclaimed Fees"
              value={`$${positions.reduce((s, p) => s + p.unrealizedFees, 0).toLocaleString("en", { maximumFractionDigits: 2 })}`}
              valueClass="text-green-400"
            />
            <SummaryCard
              label="Active Pools"
              value={`${positions.length}`}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {positions.map((pos) => {
              const strategy = STRATEGY_LABELS[pos.strategy ?? "spot"] ?? STRATEGY_LABELS.spot;
              const rangeWidth = pos.binRangeHigh - pos.binRangeLow;
              const activeFraction = Math.min(1, 1 / Math.max(1, rangeWidth / 5));

              return (
                <Card
                  key={pos.id}
                  className="p-5 bg-card border-border flex flex-col gap-4"
                  data-testid={`card-position-${pos.id}`}
                >
                  {/* Pair header */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-2">
                      <div className="flex -space-x-2">
                        <img
                          src={pos.pool?.tokenX.logoUrl}
                          alt={pos.pool?.tokenX.symbol}
                          className="w-8 h-8 rounded-full border-2 border-background bg-secondary object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                        <img
                          src={pos.pool?.tokenY.logoUrl}
                          alt={pos.pool?.tokenY.symbol}
                          className="w-8 h-8 rounded-full border-2 border-background bg-secondary object-cover"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                        />
                      </div>
                      <div>
                        <h3 className="font-bold text-sm leading-tight">
                          {pos.pool?.tokenX.symbol}/{pos.pool?.tokenY.symbol}
                        </h3>
                        <span className={`text-xs px-1.5 py-0.5 rounded-sm font-semibold uppercase tracking-wider ${strategy.cls}`}>
                          {strategy.label}
                        </span>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-lg font-mono font-bold tabular-nums">
                        ${pos.valueUsd.toLocaleString("en", { maximumFractionDigits: 0 })}
                      </div>
                      <div className="text-xs text-green-400 font-mono tabular-nums flex items-center gap-1 justify-end">
                        <TrendingUp className="w-3 h-3" />
                        +${pos.unrealizedFees.toFixed(2)} fees
                      </div>
                    </div>
                  </div>

                  {/* Bin range visualization */}
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-muted-foreground font-mono">
                      <span>Bin {pos.binRangeLow}</span>
                      <span className="text-xs text-foreground">Active range</span>
                      <span>Bin {pos.binRangeHigh}</span>
                    </div>
                    <div className="h-2 bg-secondary rounded-full overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-primary to-primary/60 rounded-full"
                        style={{ width: `${Math.max(8, activeFraction * 100)}%`, marginLeft: "10%" }}
                      />
                    </div>
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{pos.liquidityX.toLocaleString("en", { maximumFractionDigits: 2 })} {pos.pool?.tokenX.symbol}</span>
                      <span>{pos.liquidityY.toLocaleString("en", { maximumFractionDigits: 2 })} {pos.pool?.tokenY.symbol}</span>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 mt-auto pt-1 border-t border-border">
                    <Button
                      className="flex-1 h-8 text-xs"
                      variant="outline"
                      onClick={() => handleRemove(pos.id)}
                      data-testid={`button-remove-${pos.id}`}
                    >
                      Remove
                    </Button>
                    <Button
                      className="flex-1 h-8 text-xs"
                      onClick={() => handleClaimFees(pos.id)}
                      data-testid={`button-claim-${pos.id}`}
                    >
                      Claim ${pos.unrealizedFees.toFixed(2)}
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
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
