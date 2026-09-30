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
import { Loader2, ShieldAlert, Droplets, Info } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { useToast } from "@/hooks/use-toast";
import { displayToStroops, stroopsToDisplay } from "@/lib/stellar";
import {
  buildAddLiquidityTransaction,
  buildRemoveLiquidityTransaction,
  submitSignedTransaction,
} from "@/lib/dlmm-client";
import {
  hasTestusdTrustline,
  buildEstablishTrustlineTransaction,
  submitSignedClassicTransaction,
} from "@/lib/trustline";
import { useRequestTestusdFaucet } from "@workspace/api-client-react";
import { DEFAULT_POOL_ID, TOKEN_Y } from "@/lib/contracts";

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
  /** Numeric pool_id inside the DLMM registry contract. Defaults to the seeded Standard Pool. */
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

/** Weights for bins strictly below active bin (offsets -radius..-1) — receive token Y (TESTUSD). */
function yOnlyWeights(
  strategy: LiquidityStrategy,
  radius: number
): { offset: number; weight: number }[] {
  if (radius === 0) return [];
  const offsets = Array.from({ length: radius }, (_, i) => -(i + 1)); // -1, -2, …, -radius
  // distance from active bin = |offset|; use same weight formula
  const raw = offsets.map((o) => rawWeight(strategy, -o, radius));
  const sum = raw.reduce((a, b) => a + b, 0);
  return offsets.map((o, i) => ({ offset: o, weight: sum > 0 ? raw[i] / sum : 1 / radius }));
}

/** Price of token X in terms of token Y at a given bin: (1 + binStep/10000)^binId */
function computeBinPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10_000, binId);
}

export function LiquidityModal({
  open,
  onOpenChange,
  mode,
  binId,
  binStep = 25,
  tokenXSymbol,
  tokenYSymbol,
  poolId = DEFAULT_POOL_ID,
  initialStrategy = "spot",
  onSuccess,
}: LiquidityModalProps) {
  const wallet = useWallet();
  const { toast } = useToast();
  const faucet = useRequestTestusdFaucet();

  const [amountX, setAmountX] = useState("");
  const [strategy, setStrategy] = useState<LiquidityStrategy>(initialStrategy);
  const [radius, setRadius] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const involvesTestusd = tokenXSymbol === TOKEN_Y.symbol || tokenYSymbol === TOKEN_Y.symbol;
  const [trustlineChecked, setTrustlineChecked] = useState(false);
  const [hasTrustline, setHasTrustline] = useState(true);
  const [establishingTrustline, setEstablishingTrustline] = useState(false);
  const [requestingFaucet, setRequestingFaucet] = useState(false);

  // Derived: price and auto-computed TESTUSD amount
  const binPrice = computeBinPrice(binId, binStep);
  const amountXNum = parseFloat(amountX || "0");
  // When radius > 0, also deposit Y into bins below active bin.
  // amountY = amountX * price (equal dollar value on both sides).
  const amountYNum = radius > 0 ? amountXNum * binPrice : 0;
  const computedAmountY = amountYNum > 0 ? amountYNum.toFixed(6) : "";

  const needsYDeposit = radius > 0 && involvesTestusd;

  useEffect(() => {
    if (!open) {
      setTrustlineChecked(false);
      setStrategy(initialStrategy);
      setAmountX("");
      return;
    }
    // Only check trustline for add mode when depositing TESTUSD (radius > 0)
    if (mode !== "add" || !needsYDeposit || !wallet.address) {
      setTrustlineChecked(true);
      setHasTrustline(true);
      return;
    }
    setTrustlineChecked(false);
    hasTestusdTrustline(wallet.address).then((ok) => {
      setHasTrustline(ok);
      setTrustlineChecked(true);
    });
  }, [open, mode, needsYDeposit, wallet.address, initialStrategy]);

  // Re-check trustline when radius changes (may go from 0 → needsYDeposit)
  useEffect(() => {
    if (!open || mode !== "add" || !involvesTestusd || !wallet.address) return;
    if (!needsYDeposit) {
      setTrustlineChecked(true);
      setHasTrustline(true);
      return;
    }
    setTrustlineChecked(false);
    hasTestusdTrustline(wallet.address).then((ok) => {
      setHasTrustline(ok);
      setTrustlineChecked(true);
    });
  }, [radius]);

  async function handleEstablishTrustline() {
    if (!wallet.address) return;
    setEstablishingTrustline(true);
    try {
      const tx = await buildEstablishTrustlineTransaction(wallet.address);
      const signedXdr = await wallet.signTransaction(tx.toXDR());
      await submitSignedClassicTransaction(signedXdr);
      toast({ title: "TESTUSD trustline established" });
      setHasTrustline(true);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Failed to establish trustline",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setEstablishingTrustline(false);
    }
  }

  async function handleFaucet() {
    if (!wallet.address) return;
    setRequestingFaucet(true);
    try {
      await faucet.mutateAsync({ data: { address: wallet.address } });
      toast({ title: "500 TESTUSD sent to your wallet" });
      await wallet.refreshBalance();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Faucet request failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRequestingFaucet(false);
    }
  }

  async function handleSubmit() {
    if (!wallet.connected || !wallet.address) {
      toast({ variant: "destructive", title: "Connect a wallet first" });
      return;
    }
    setSubmitting(true);
    try {
      if (mode === "add") {
        if (!amountX || amountXNum <= 0) {
          throw new Error(`Enter an ${tokenXSymbol} amount to deposit`);
        }

        const xSplits = xOnlyWeights(strategy, radius);
        const ySplits = needsYDeposit ? yOnlyWeights(strategy, radius) : [];
        const totalSteps = xSplits.length + ySplits.length;
        setProgress({ done: 0, total: totalSteps });

        const totalX = displayToStroops(amountX);
        let done = 0;

        // Deposit token X into bins at/above active bin (offsets 0..+radius)
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

        // Deposit token Y into bins below active bin (offsets -radius..-1)
        if (ySplits.length > 0 && amountYNum > 0) {
          const totalY = displayToStroops(computedAmountY);
          for (const { offset, weight } of ySplits) {
            const amtY = BigInt(Math.floor(Number(totalY) * weight));
            if (amtY > 0n) {
              const prepared = await buildAddLiquidityTransaction(
                wallet.address,
                binId + offset,
                0n,
                amtY,
                poolId
              );
              const signedXdr = await wallet.signTransaction(prepared.toXDR());
              await submitSignedTransaction(signedXdr);
            }
            done++;
            setProgress({ done, total: totalSteps });
          }
        }
      } else {
        const prepared = await buildRemoveLiquidityTransaction(wallet.address, binId, poolId);
        const signedXdr = await wallet.signTransaction(prepared.toXDR());
        await submitSignedTransaction(signedXdr);
      }

      toast({
        title: mode === "add" ? "Liquidity added on-chain" : "Liquidity removed on-chain",
        description:
          mode === "add"
            ? `Deposited ${amountX} ${tokenXSymbol}${needsYDeposit && computedAmountY ? ` + ${parseFloat(computedAmountY).toFixed(4)} ${tokenYSymbol}` : ""} across ${radius * 2 + 1} bins.`
            : "Transaction confirmed on Stellar testnet.",
      });
      setAmountX("");
      await wallet.refreshBalance();
      onSuccess?.();
      onOpenChange(false);
    } catch (err) {
      toast({
        variant: "destructive",
        title: mode === "add" ? "Add liquidity failed" : "Remove liquidity failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  const needsTrustlineGate =
    mode === "add" && needsYDeposit && trustlineChecked && !hasTrustline;

  const xWeights = xOnlyWeights(strategy, radius);
  const yWeights = yOnlyWeights(strategy, radius);
  const totalBins = xWeights.length + yWeights.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-liquidity">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "Add Liquidity" : "Remove Liquidity"} (active bin {binId})
          </DialogTitle>
        </DialogHeader>

        {mode === "add" && needsYDeposit && !trustlineChecked && (
          <div className="py-6 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {needsTrustlineGate ? (
          <div className="space-y-4 py-2">
            <div className="flex items-start gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
              <ShieldAlert className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium text-amber-300">TESTUSD trustline required</p>
                <p className="text-muted-foreground text-xs">
                  Providing balanced liquidity also deposits {tokenYSymbol} into bins below the
                  active bin. Your wallet needs a one-time trustline to hold it.
                </p>
              </div>
            </div>
            <Button
              className="w-full"
              onClick={handleEstablishTrustline}
              disabled={establishingTrustline}
              data-testid="button-establish-trustline"
            >
              {establishingTrustline ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Waiting for signature…
                </>
              ) : (
                "Establish TESTUSD trustline"
              )}
            </Button>
          </div>
        ) : mode === "add" && (trustlineChecked || !needsYDeposit) ? (
          <div className="space-y-4 py-2">
            {needsYDeposit && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={handleFaucet}
                disabled={requestingFaucet || faucet.isPending}
                data-testid="button-faucet-testusd"
              >
                {requestingFaucet ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Requesting…
                  </>
                ) : (
                  <>
                    <Droplets className="w-4 h-4 mr-2" />
                    Get 500 TESTUSD (testnet faucet)
                  </>
                )}
              </Button>
            )}

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
                  {totalBins} bin{totalBins !== 1 ? "s" : ""} (±{radius})
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
              {/* Bin distribution preview: Y-side (left, dimmer) + X-side (right, primary) */}
              <div className="flex h-6 items-end gap-[2px]" data-testid="bin-distribution-preview">
                {yWeights
                  .slice()
                  .reverse()
                  .map(({ offset, weight }) => (
                    <div
                      key={offset}
                      className="flex-1 rounded-t bg-cyan-500/40"
                      style={{ height: `${Math.max(8, weight * radius * 40)}%` }}
                      title={`bin ${binId + offset} (${tokenYSymbol})`}
                    />
                  ))}
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
                  <span className="text-cyan-400/70">← {tokenYSymbol} bins</span>
                  <span className="font-mono">active ({binId})</span>
                  <span className="text-primary/70">{tokenXSymbol} bins →</span>
                </div>
              )}
            </div>

            {/* Amount input: only base token (XLM) */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                You deposit
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

            {/* Auto-computed quote token amount (shown read-only when radius > 0) */}
            {needsYDeposit && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    Auto-paired
                  </label>
                  <Info className="w-3 h-3 text-muted-foreground" />
                </div>
                <div className="relative">
                  <Input
                    type="number"
                    readOnly
                    placeholder="0.00"
                    value={computedAmountY}
                    className="pr-16 bg-secondary/50 text-muted-foreground cursor-default"
                    data-testid="input-liquidity-amount-y"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-muted-foreground pointer-events-none">
                    {tokenYSymbol}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Info className="w-3 h-3 shrink-0" />
                  Calculated at current price ({binPrice.toFixed(4)} {tokenYSymbol}/{tokenXSymbol}).
                  {tokenYSymbol} goes into bins below the active bin, enabling{" "}
                  {tokenXSymbol}→{tokenYSymbol} swaps.
                </p>
              </div>
            )}

            {radius === 0 && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Info className="w-3 h-3 shrink-0" />
                At range ±0 only the active bin is used — deposit is {tokenXSymbol}-only. Increase
                the range to also provide {tokenYSymbol} liquidity.
              </p>
            )}
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
              (mode === "add" && (needsTrustlineGate || (needsYDeposit && !trustlineChecked)))
            }
            data-testid="button-confirm-liquidity"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {progress
                  ? `Confirming bin ${progress.done}/${progress.total}…`
                  : "Waiting for signature…"}
              </>
            ) : !wallet.connected ? (
              "Connect wallet to continue"
            ) : mode === "add" ? (
              `Add liquidity (${totalBins} bin${totalBins !== 1 ? "s" : ""})`
            ) : (
              "Confirm Remove Liquidity"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export { stroopsToDisplay };
