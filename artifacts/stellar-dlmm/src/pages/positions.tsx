import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetUserPositions, getGetUserPositionsQueryKey } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Wallet, ChevronRight, Coins, Layers } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { WalletModal } from "@/components/wallet-modal";
import { LiquidityModal } from "@/components/liquidity-modal";
import { Link } from "wouter";

interface RemoveTarget {
  binId: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  poolId?: number;
}

export default function PositionsPage() {
  const wallet = useWallet();
  const queryClient = useQueryClient();
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);

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

      {/* Not connected — real data requires a wallet, no mock fallback */}
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
          {/* Summary strip — only honest, on-chain totals */}
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

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {positions.map((pos) => {
              const binId = pos.binId ?? pos.binRangeLow;
              const tokenXSymbol = pos.pool?.tokenX.symbol ?? "X";
              const tokenYSymbol = pos.pool?.tokenY.symbol ?? "Y";

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
                    <div className="text-right">
                      <div className="text-lg font-mono font-bold tabular-nums">
                        ${pos.valueUsd.toLocaleString("en", { maximumFractionDigits: 2 })}
                      </div>
                      <div className="text-xs text-muted-foreground font-mono tabular-nums">
                        {(pos.shares ?? 0).toLocaleString("en", { maximumFractionDigits: 0 })} shares
                      </div>
                    </div>
                  </div>

                  {/* Reserves */}
                  <div className="grid grid-cols-2 gap-2 border-t border-border pt-3">
                    <ReserveStat
                      symbol={tokenXSymbol}
                      amount={pos.liquidityX}
                    />
                    <ReserveStat
                      symbol={tokenYSymbol}
                      amount={pos.liquidityY}
                    />
                  </div>

                  {/* Action — real on-chain withdrawal */}
                  <div className="flex gap-2 mt-auto pt-1 border-t border-border">
                    <Button
                      className="flex-1 h-8 text-xs"
                      variant="outline"
                      onClick={() => setRemoveTarget({ binId, tokenXSymbol, tokenYSymbol, poolId: pos.pool?.dlmmPoolId })}
                      data-testid={`button-remove-${pos.id}`}
                    >
                      Remove Liquidity
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        </>
      )}

      <WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />

      {removeTarget && (
        <LiquidityModal
          open={!!removeTarget}
          onOpenChange={(o) => { if (!o) setRemoveTarget(null); }}
          mode="remove"
          binId={removeTarget.binId}
          tokenXSymbol={removeTarget.tokenXSymbol}
          tokenYSymbol={removeTarget.tokenYSymbol}
          poolId={removeTarget.poolId}
          onSuccess={refetchPositions}
        />
      )}
    </div>
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
