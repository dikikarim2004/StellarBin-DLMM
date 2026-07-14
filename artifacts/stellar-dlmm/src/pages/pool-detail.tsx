import { useState, useEffect } from "react";
import { useRoute } from "wouter";
import { useGetPool, useGetPoolBins, useGetPoolStats, getGetPoolQueryKey, getGetPoolBinsQueryKey, getGetPoolStatsQueryKey } from "@workspace/api-client-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ArrowLeft } from "lucide-react";
import { Link } from "wouter";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { LiquidityModal, type LiquidityStrategy } from "@/components/liquidity-modal";

export default function PoolDetailPage() {
  const [, params] = useRoute("/pools/:poolId");
  const poolId = params?.poolId || "";
  const [liquidityModal, setLiquidityModal] = useState<"add" | "remove" | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<LiquidityStrategy>("spot");

  const { data: pool, isLoading: poolLoading } = useGetPool(poolId, { query: { enabled: !!poolId, queryKey: getGetPoolQueryKey(poolId) } });
  const { data: bins, isLoading: binsLoading, refetch: refetchBins } = useGetPoolBins(poolId, { query: { enabled: !!poolId, queryKey: getGetPoolBinsQueryKey(poolId) } });
  const { data: stats, isLoading: statsLoading } = useGetPoolStats(poolId, { query: { enabled: !!poolId, queryKey: getGetPoolStatsQueryKey(poolId) } });

  if (poolLoading) {
    return <div className="space-y-6"><Skeleton className="h-12 w-64" /><Skeleton className="h-64 w-full" /></div>;
  }

  if (!pool) return <div>Pool not found</div>;

  const isLivePool = pool.category === "dlmm" && pool.dlmmPoolId !== undefined;

  return (
    <div className="space-y-6">
      <Link href="/pools" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back to Pools
      </Link>

      <div className="flex justify-between items-end">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="flex -space-x-2">
              <img src={pool.tokenX.logoUrl} alt={pool.tokenX.symbol} className="w-8 h-8 rounded-full border-2 border-background bg-secondary" />
              <img src={pool.tokenY.logoUrl} alt={pool.tokenY.symbol} className="w-8 h-8 rounded-full border-2 border-background bg-secondary" />
            </div>
            <h1 className="text-3xl font-bold">{pool.tokenX.symbol} / {pool.tokenY.symbol}</h1>
            <span className="px-2 py-1 bg-secondary text-sm rounded-md font-medium">{pool.fee}% Fee</span>
          </div>
          <div className="text-xl font-mono">1 {pool.tokenX.symbol} = {pool.currentPrice} {pool.tokenY.symbol}</div>
        </div>
        <div className="flex gap-3">
          <Button
            variant="outline"
            disabled={!isLivePool}
            onClick={() => setLiquidityModal("remove")}
            data-testid="button-remove-liquidity"
          >
            Remove Liquidity
          </Button>
          <Button
            disabled={!isLivePool}
            onClick={() => setLiquidityModal("add")}
            data-testid="button-add-liquidity"
          >
            Add Liquidity
          </Button>
        </div>
      </div>

      {!isLivePool && (
        <div className="text-xs text-muted-foreground bg-secondary/30 border border-border rounded-md px-3 py-2">
          This pool's data is illustrative. Real on-chain liquidity actions are only wired to DLMM registry pools.
        </div>
      )}

      {isLivePool && pool.isLaunchPool && pool.activationTs !== undefined && (
        <LaunchCountdown activationTs={pool.activationTs} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-4 bg-card border-border">
          <div className="text-sm text-muted-foreground">TVL</div>
          <div className="text-2xl font-mono font-bold">${pool.tvl.toLocaleString()}</div>
        </Card>
        <Card className="p-4 bg-card border-border">
          <div className="text-sm text-muted-foreground">24h Volume</div>
          <div className="text-2xl font-mono font-bold">
            {pool.volumeAvailable ? `$${pool.volume24h.toLocaleString()}` : <span className="text-muted-foreground">—</span>}
          </div>
        </Card>
        <Card className="p-4 bg-card border-border">
          <div className="text-sm text-muted-foreground">24h Fees</div>
          <div className="text-2xl font-mono font-bold">
            {pool.volumeAvailable ? `$${pool.fees24h.toLocaleString()}` : <span className="text-muted-foreground">—</span>}
          </div>
        </Card>
        <Card className="p-4 bg-card border-border">
          <div className="text-sm text-muted-foreground">APR</div>
          <div className="text-2xl font-mono font-bold text-green-500">
            {pool.volumeAvailable ? `${pool.apr.toFixed(2)}%` : <span className="text-muted-foreground">—</span>}
          </div>
        </Card>
      </div>

      {pool.category === "dlmm" && pool.lpFeeBps !== undefined && pool.protocolFeeBps !== undefined && (
        <Card className="p-4 bg-card border-border">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Fee split</span>
            <span className="font-mono">
              <span className="text-foreground font-semibold">{(pool.lpFeeBps / 100).toFixed(1)}% LPs</span>
              <span className="text-muted-foreground mx-1.5">/</span>
              <span className="text-foreground font-semibold">{(pool.protocolFeeBps / 100).toFixed(1)}% Protocol</span>
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-secondary overflow-hidden mt-2 flex">
            <div className="h-full bg-primary" style={{ width: `${pool.lpFeeBps / 100}%` }} />
            <div className="h-full bg-amber-500/70" style={{ width: `${pool.protocolFeeBps / 100}%` }} />
          </div>
        </Card>
      )}

      <Card className="p-6 bg-card border-border">
        <h3 className="text-lg font-bold mb-4">Liquidity Distribution</h3>
        <div className="h-[300px] w-full">
          {binsLoading ? <Skeleton className="w-full h-full" /> : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bins || []}>
                <XAxis dataKey="price" tick={{ fill: 'hsl(var(--muted-foreground))', fontSize: 12 }} tickFormatter={(val) => val.toFixed(2)} />
                <Tooltip 
                  contentStyle={{ backgroundColor: 'hsl(var(--card))', borderColor: 'hsl(var(--border))', color: 'hsl(var(--foreground))' }}
                  itemStyle={{ color: 'hsl(var(--foreground))' }}
                />
                <Bar dataKey="liquidityX" stackId="a" fill="hsl(var(--primary))" />
                <Bar dataKey="liquidityY" stackId="a" fill="hsl(var(--accent))" />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
        
        <div className="flex gap-4 mt-6">
          <Button
            variant="secondary"
            className="flex-1"
            disabled={!isLivePool}
            onClick={() => {
              setSelectedStrategy("spot");
              setLiquidityModal("add");
            }}
            data-testid="button-strategy-spot"
          >
            Spot Strategy
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={!isLivePool}
            onClick={() => {
              setSelectedStrategy("curve");
              setLiquidityModal("add");
            }}
            data-testid="button-strategy-curve"
          >
            Curve Strategy
          </Button>
          <Button
            variant="secondary"
            className="flex-1"
            disabled={!isLivePool}
            onClick={() => {
              setSelectedStrategy("bidask");
              setLiquidityModal("add");
            }}
            data-testid="button-strategy-bidask"
          >
            Bid-Ask Strategy
          </Button>
        </div>
      </Card>

      {isLivePool && liquidityModal && (
        <LiquidityModal
          open={!!liquidityModal}
          onOpenChange={(o) => setLiquidityModal(o ? liquidityModal : null)}
          mode={liquidityModal}
          binId={pool.activeBinId}
          tokenXSymbol={pool.tokenX.symbol}
          tokenYSymbol={pool.tokenY.symbol}
          poolId={pool.dlmmPoolId}
          initialStrategy={selectedStrategy}
          onSuccess={() => refetchBins()}
        />
      )}
    </div>
  );
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
