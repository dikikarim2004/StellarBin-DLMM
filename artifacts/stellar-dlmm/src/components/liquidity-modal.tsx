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
  buildAddLiquidityBinsTransaction,
  buildRemoveLiquidityTransaction,
  submitSignedTransaction,
} from "@/lib/dlmm-client";
import { DEFAULT_POOL_ID } from "@/lib/contracts";

export type LiquidityStrategy = "spot" | "curve" | "bidask";

type DepositMode = "x-only" | "y-only" | "both";

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

const DEPOSIT_MODES: { id: DepositMode; label: string }[] = [
  { id: "x-only", label: "X only" },
  { id: "y-only", label: "Y only" },
  { id: "both", label: "Both" },
];

function rawWeight(strategy: LiquidityStrategy, distance: number, radius: number): number {
  if (strategy === "spot") return 1;
  if (strategy === "curve") return radius + 1 - distance; // heavier near active bin
  return distance + 1; // bid-ask: heavier at range edges
}

interface BinAllocation {
  binId: number;
  amountX: bigint;
  amountY: bigint;
}

/**
 * Build a per-bin deposit plan. Contract side rules are enforced here:
 * bin > active → token X only; bin < active → token Y only; active bin → both.
 * Strategy only shapes the per-bin weights, never the allowed token side.
 */
function allocateBins(
  strategy: LiquidityStrategy,
  mode: DepositMode,
  activeBinId: number,
  radius: number,
  totalX: bigint,
  totalY: bigint
): BinAllocation[] {
  const offsets: number[] =
    mode === "x-only"
      ? Array.from({ length: radius + 1 }, (_, i) => i)
      : mode === "y-only"
        ? Array.from({ length: radius + 1 }, (_, i) => -i)
        : Array.from({ length: radius * 2 + 1 }, (_, i) => i - radius);
  const weights = offsets.map((offset) => rawWeight(strategy, Math.abs(offset), radius));
  const sum = weights.reduce((a, b) => a + b, 0);

  let usedX = 0n;
  let usedY = 0n;
  return offsets.map((offset, i) => {
    const targetBin = activeBinId + offset;
    const isLast = i === offsets.length - 1;
    let amountX = 0n;
    let amountY = 0n;
    if ((mode === "x-only" || mode === "both") && targetBin >= activeBinId && totalX > 0n) {
      amountX = isLast ? totalX - usedX : (totalX * BigInt(weights[i])) / BigInt(sum);
      usedX += amountX;
    }
    if ((mode === "y-only" || mode === "both") && targetBin <= activeBinId && totalY > 0n) {
      amountY = isLast ? totalY - usedY : (totalY * BigInt(weights[i])) / BigInt(sum);
      usedY += amountY;
    }
    return { binId: targetBin, amountX, amountY };
  });
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
  const [amountY, setAmountY] = useState("");
  const [strategy, setStrategy] = useState<LiquidityStrategy>(initialStrategy);
  const [depositMode, setDepositMode] = useState<DepositMode>("both");
  const [radius, setRadius] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const amountXNum = Number.parseFloat(amountX || "0");
  const amountYNum = Number.parseFloat(amountY || "0");

  useEffect(() => {
    if (!open) {
      setStrategy(initialStrategy);
      setAmountX("");
      setAmountY("");
      setDepositMode("both");
    }
  }, [open, initialStrategy]);

  const needsX = depositMode === "x-only" || depositMode === "both";
  const needsY = depositMode === "y-only" || depositMode === "both";

  const allocations =
    mode === "add"
      ? allocateBins(
          strategy,
          depositMode,
          binId,
          radius,
          needsX && amountX && Number.isFinite(amountXNum) && amountXNum > 0
            ? displayToStroops(amountX)
            : 0n,
          needsY && amountY && Number.isFinite(amountYNum) && amountYNum > 0
            ? displayToStroops(amountY)
            : 0n
        ).filter((a) => a.amountX > 0n || a.amountY > 0n)
      : [];

  async function handleSubmit() {
    if (!wallet.connected || !wallet.address) {
      toast({ variant: "destructive", title: "Connect a wallet first" });
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "add") {
        if (needsX && (!amountX || !Number.isFinite(amountXNum) || amountXNum <= 0)) {
          throw new Error(`Enter an ${tokenXSymbol} amount to deposit`);
        }
        if (needsY && (!amountY || !Number.isFinite(amountYNum) || amountYNum <= 0)) {
          throw new Error(`Enter an ${tokenYSymbol} amount to deposit`);
        }
        if (allocations.length === 0) {
          throw new Error("Distribution is empty");
        }

        // Contract exposes add_liquidity_bins (batch): one wallet signature covers all bins.
        setProgress({ done: 0, total: 1 });
        const prepared = await buildAddLiquidityBinsTransaction(
          wallet.address,
          allocations.map((a) => a.binId),
          allocations.map((a) => a.amountX),
          allocations.map((a) => a.amountY),
          poolId
        );
        const signedXdr = await wallet.signTransaction(prepared.toXDR());
        await submitSignedTransaction(signedXdr);
        setProgress({ done: 1, total: 1 });
      } else {
        const prepared = await buildRemoveLiquidityTransaction(wallet.address, binId, poolId);
        const signedXdr = await wallet.signTransaction(prepared.toXDR());
        await submitSignedTransaction(signedXdr);
      }

      toast({
        title: mode === "add" ? "Position created on-chain" : "Position closed on-chain",
        description:
          mode === "add"
            ? `Deposited ${allocations.length} bin${allocations.length !== 1 ? "s" : ""}: ${needsX && amountXNum > 0 ? `${amountX} ${tokenXSymbol}` : ""}${needsX && needsY ? " + " : ""}${needsY && amountYNum > 0 ? `${amountY} ${tokenYSymbol}` : ""}.`
            : "Transaction confirmed on Stellar testnet.",
      });
      setAmountX("");
      setAmountY("");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-liquidity">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "Create Position" : "Close Position"} (active bin {binId})
          </DialogTitle>
        </DialogHeader>

        {mode === "add" ? (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Deposit side
              </label>
              <ToggleGroup
                type="single"
                value={depositMode}
                onValueChange={(v) => v && setDepositMode(v as DepositMode)}
                className="grid grid-cols-3 gap-2"
              >
                {DEPOSIT_MODES.map((m) => (
                  <ToggleGroupItem
                    key={m.id}
                    value={m.id}
                    className="text-xs data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                    data-testid={`deposit-mode-${m.id}`}
                  >
                    {m.id === "x-only"
                      ? `${tokenXSymbol} only`
                      : m.id === "y-only"
                        ? `${tokenYSymbol} only`
                        : "Both"}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
              <p className="text-[11px] text-muted-foreground">
                {depositMode === "x-only"
                  ? `${tokenXSymbol} goes to the active bin and bins above it.`
                  : depositMode === "y-only"
                    ? `${tokenYSymbol} goes to the active bin and bins below it.`
                    : `${tokenXSymbol} is distributed to bins at/above active; ${tokenYSymbol} to bins at/below active.`}
              </p>
            </div>

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
                  {allocations.length || (depositMode === "both" ? radius * 2 + 1 : radius + 1)} bin
                  {(allocations.length || (depositMode === "both" ? radius * 2 + 1 : radius + 1)) !== 1 ? "s" : ""}
                  {depositMode === "both" ? ` (±${radius})` : depositMode === "x-only" ? ` (+${radius})` : ` (−${radius})`}
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
            </div>

            {needsX && (
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
            )}

            {needsY && (
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {tokenYSymbol} deposit
                </label>
                <div className="relative">
                  <Input
                    type="number"
                    placeholder="0.00"
                    value={amountY}
                    onChange={(e) => setAmountY(e.target.value)}
                    className="pr-16"
                    data-testid="input-liquidity-amount-y"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground pointer-events-none">
                    {tokenYSymbol}
                  </span>
                </div>
              </div>
            )}

            {allocations.length > 0 && (
              <div className="rounded border border-border bg-secondary/30 p-3">
                <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Per-bin allocation
                </p>
                <div className="max-h-32 space-y-1 overflow-y-auto font-mono text-[11px]">
                  {allocations.map((a) => (
                    <div key={a.binId} className="flex justify-between gap-3">
                      <span className={a.binId === binId ? "text-primary" : "text-muted-foreground"}>
                        bin {a.binId}
                        {a.binId === binId ? " (active)" : ""}
                      </span>
                      <span>
                        {a.amountX > 0n ? `${stroopsToDisplay(a.amountX)} ${tokenXSymbol}` : ""}
                        {a.amountX > 0n && a.amountY > 0n ? " + " : ""}
                        {a.amountY > 0n ? `${stroopsToDisplay(a.amountY)} ${tokenYSymbol}` : ""}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <p className="rounded border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              Each bin gets only the token side the contract allows: {tokenXSymbol} at/above the active bin, {tokenYSymbol} at/below it. No conversion between tokens is performed.
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
              !wallet.connected ||
              (mode === "add" && allocations.length === 0)
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
              `Create position (${allocations.length} bin${allocations.length !== 1 ? "s" : ""})`
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
