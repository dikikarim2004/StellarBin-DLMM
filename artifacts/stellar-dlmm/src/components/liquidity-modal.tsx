import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Loader2 } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { useToast } from "@/hooks/use-toast";
import { displayToStroops, stroopsToDisplay } from "@/lib/stellar";
import {
  buildAddLiquidityTransaction,
  buildRemoveLiquidityTransaction,
  submitSignedTransaction,
} from "@/lib/dlmm-client";
import { DEFAULT_POOL_ID } from "@/lib/contracts";

export type LiquidityStrategy = "spot" | "curve" | "bidask";

interface LiquidityModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "add" | "remove";
  binId: number;
  /** Pool bin step in bps (e.g. 25 = 0.25%). Used to compute the token price ratio. */
  binStep?: number;
  tokenXSymbol: string;
  tokenYSymbol: string;
  tokenXAddress?: string;
  tokenYAddress?: string;
  /** Numeric pool_id inside the DLMM registry contract. Defaults to the configured XLM/USDC pool. */
  poolId?: number;
  initialStrategy?: LiquidityStrategy;
  onSuccess?: () => void;
}

const STRATEGIES: { id: LiquidityStrategy; label: string; description: string }[] = [
  { id: "spot", label: "Spot", description: "Even distribution across all bins" },
  { id: "curve", label: "Curve", description: "Concentrated near the active bin" },
  { id: "bidask", label: "Bid-Ask", description: "Concentrated at the range edges" },
];

function rawWeight(strategy: LiquidityStrategy, distance: number, radius: number): number {
  if (strategy === "spot") return 1;
  if (strategy === "curve") return radius + 1 - distance; // heavier near active bin
  return distance + 1; // bid-ask: heavier at range edges
}

/** Weights for bins at/above active bin (offsets 0..+radius) — receive token X (XLM). */
function xOnlyWeights(
  strategy: LiquidityStrategy,
  radius: number
): { offset: number; weight: number }[] {
  const offsets = Array.from({ length: radius + 1 }, (_, i) => i);
  const raw = offsets.map((o) => rawWeight(strategy, o, radius));
  const sum = raw.reduce((a, b) => a + b, 0);
  return offsets.map((o, i) => ({ offset: o, weight: sum > 0 ? raw[i] / sum : 1 / (radius + 1) }));
}

export function LiquidityModal({
  open,
  onOpenChange,
  mode,
  binId,
  tokenXSymbol,
  tokenYSymbol,
  poolId = DEFAULT_POOL_ID,
  initialStrategy = "spot",
  onSuccess,
}: LiquidityModalProps) {
  const wallet = useWallet();
  const { toast } = useToast();

  const [amountX, setAmountX] = useState("");
  const [strategy, setStrategy] = useState<LiquidityStrategy>(initialStrategy);
  const [radius, setRadius] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const amountXNum = Number.parseFloat(amountX || "0");

  useEffect(() => {
    if (!open) {
      setStrategy(initialStrategy);
      setAmountX("");
    }
  }, [open, initialStrategy]);

  async function handleSubmit() {
    if (!wallet.connected || !wallet.address) {
      toast({ variant: "destructive", title: "Connect a wallet first" });
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "add") {
        if (!amountX || !Number.isFinite(amountXNum) || amountXNum <= 0) {
          throw new Error(`Enter an ${tokenXSymbol} amount to deposit`);
        }

        const xSplits = xOnlyWeights(strategy, radius);
        const totalSteps = xSplits.length;
        setProgress({ done: 0, total: totalSteps });

        const totalX = displayToStroops(amountX);
        let done = 0;

        // Open a one-sided position in the active bin and bins above it.
        for (const { offset, weight } of xSplits) {
          const amtX = BigInt(Math.floor(Number(totalX) * weight));
          if (amtX > 0n) {
            const prepared = await buildAddLiquidityTransaction(
              wallet.address,
              binId + offset,
              amtX,
              0n,
              poolId
            );
            const signedXdr = await wallet.signTransaction(prepared.toXDR());
            await submitSignedTransaction(signedXdr);
          }
          done++;
          setProgress({ done, total: totalSteps });
        }
      } else {
        const prepared = await buildRemoveLiquidityTransaction(wallet.address, binId, poolId);
        const signedXdr = await wallet.signTransaction(prepared.toXDR());
        await submitSignedTransaction(signedXdr);
      }

      toast({
        title: mode === "add" ? "Position created on-chain" : "Position closed on-chain",
        description:
          mode === "add"
            ? `Opened a one-sided ${tokenXSymbol} position across ${radius + 1} bins.`
            : "Transaction confirmed on Stellar testnet.",
      });
      setAmountX("");
      await wallet.refreshBalance();
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      toast({
        variant: "destructive",
        title: mode === "add" ? "Create position failed" : "Close position failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  const xWeights = xOnlyWeights(strategy, radius);
  const totalBins = xWeights.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-liquidity">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "Create Position" : "Close Position"} (bin {binId})
          </DialogTitle>
        </DialogHeader>

        {mode === "add" ? (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Strategy
              </label>
              <ToggleGroup
                type="single"
                value={strategy}
                onValueChange={(v) => v && setStrategy(v as LiquidityStrategy)}
                className="grid grid-cols-3 gap-2"
              >
                {STRATEGIES.map((s) => (
                  <ToggleGroupItem
                    key={s.id}
                    value={s.id}
                    className="flex-col h-auto py-2 gap-0.5 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                    data-testid={`strategy-${s.id}`}
                  >
                    <span className="text-sm font-semibold">{s.label}</span>
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="text-[11px] text-muted-foreground">
                {STRATEGIES.find((s) => s.id === strategy)?.description}
              </p>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Bin range
                </label>
                <span className="text-xs font-mono">
                  {totalBins} bin{totalBins !== 1 ? "s" : ""} (+{radius})
                </span>
              </div>
              <Slider
                min={0}
                max={10}
                step={1}
                value={[radius]}
                onValueChange={([v]) => setRadius(v)}
                data-testid="slider-bin-range"
              />
              {/* The one-sided position only occupies the active bin and bins above it. */}
              <div className="flex h-6 items-end gap-0.5" data-testid="bin-distribution-preview">
                {xWeights.map(({ offset, weight }) => (
                  <div
                    key={offset}
                    className="flex-1 rounded-t bg-primary/70"
                    style={{ height: `${Math.max(8, weight * (radius + 1) * 40)}%` }}
                    title={`bin ${binId + offset} (${tokenXSymbol})`}
                  />
                ))}
              </div>
              {radius > 0 && (
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span className="font-mono">active ({binId})</span>
                  <span className="text-primary/70">{tokenXSymbol} bins → +{radius}</span>
                </div>
              )}
            </div>

            {/* Amount input: only base token (XLM) */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {tokenXSymbol} deposit
              </label>
              <div className="relative">
                <Input
                  type="number"
                  placeholder="0.00"
                  value={amountX}
                  onChange={(e) => setAmountX(e.target.value)}
                  className="pr-16"
                  data-testid="input-liquidity-amount-x"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground pointer-events-none">
                  {tokenXSymbol}
                </span>
              </div>
            </div>
            <p className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              Single-sided {tokenXSymbol} opens a directional position and adds only {tokenXSymbol} reserves. It does not create {tokenYSymbol}; swaps to {tokenYSymbol} need real {tokenYSymbol} liquidity or an executable conversion route.
            </p>

          </div>
        ) : mode === "remove" ? (
          <p className="text-sm text-muted-foreground py-2">
            This withdraws your entire position from bin {binId} back to your wallet.
          </p>
        ) : null}

        <DialogFooter>
          <Button
            className="w-full"
            onClick={handleSubmit}
            disabled={
              submitting ||
              !wallet.connected
            }
            data-testid="button-confirm-liquidity"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {progress
                  ? `Confirming transaction ${progress.done}/${progress.total}…`
                  : "Waiting for signature…"}
              </>
            ) : !wallet.connected ? (
              "Connect wallet to continue"
            ) : mode === "add" ? (
              `Create position (${totalBins} bin${totalBins !== 1 ? "s" : ""})`
            ) : (
              "Confirm Close Position"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { stroopsToDisplay };
