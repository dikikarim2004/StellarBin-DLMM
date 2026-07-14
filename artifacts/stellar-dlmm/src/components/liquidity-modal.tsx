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
import { Loader2, ShieldAlert, Droplets } from "lucide-react";
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
  tokenXSymbol: string;
  tokenYSymbol: string;
  /** Numeric pool_id inside the DLMM registry contract. Defaults to the seeded Standard Pool. */
  poolId?: number;
  initialStrategy?: LiquidityStrategy;
  onSuccess?: () => void;
}

const STRATEGIES: { id: LiquidityStrategy; label: string; description: string }[] = [
  { id: "spot", label: "Spot", description: "Even liquidity across the whole range" },
  { id: "curve", label: "Curve", description: "Concentrated near the active bin" },
  { id: "bidask", label: "Bid-Ask", description: "Concentrated at the range edges" },
];

function rawStrategyWeight(strategy: LiquidityStrategy, offset: number, radius: number): number {
  if (strategy === "spot") return 1;
  if (strategy === "curve") return radius + 1 - Math.abs(offset);
  return Math.abs(offset) + 1; // bidask
}

/** Normalized per-offset weights (sum = 1) for a symmetric range of `radius` bins on each side.
 * Used only for the visual distribution preview — actual token amounts use `tokenSplitWeights`
 * below, since the contract only allows one-sided deposits for off-active bins. */
function strategyWeights(strategy: LiquidityStrategy, radius: number): number[] {
  const offsets: number[] = [];
  for (let o = -radius; o <= radius; o++) offsets.push(o);
  const raw = offsets.map((o) => rawStrategyWeight(strategy, o, radius));
  const sum = raw.reduce((a, b) => a + b, 0);
  return raw.map((w) => w / sum);
}

/**
 * The contract only allows one-sided deposits for off-active bins:
 * bins above the active bin (offset > 0) may only hold token X, bins below
 * (offset < 0) may only hold token Y, and the active bin (offset === 0) can
 * hold both. This computes per-bin weights for each token independently,
 * normalized within its own eligible subset, so `amount_x`/`amount_y` sent
 * to the contract never violate that rule.
 */
function tokenSplitWeights(
  strategy: LiquidityStrategy,
  radius: number
): { offset: number; wX: number; wY: number }[] {
  const offsets: number[] = [];
  for (let o = -radius; o <= radius; o++) offsets.push(o);

  const xOffsets = offsets.filter((o) => o >= 0);
  const yOffsets = offsets.filter((o) => o <= 0);
  const xSum = xOffsets.reduce((a, o) => a + rawStrategyWeight(strategy, o, radius), 0);
  const ySum = yOffsets.reduce((a, o) => a + rawStrategyWeight(strategy, o, radius), 0);

  return offsets.map((o) => ({
    offset: o,
    wX: o >= 0 ? rawStrategyWeight(strategy, o, radius) / xSum : 0,
    wY: o <= 0 ? rawStrategyWeight(strategy, o, radius) / ySum : 0,
  }));
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
  const faucet = useRequestTestusdFaucet();

  const [amountX, setAmountX] = useState("");
  const [amountY, setAmountY] = useState("");
  const [strategy, setStrategy] = useState<LiquidityStrategy>(initialStrategy);
  const [radius, setRadius] = useState(3);
  const [submitting, setSubmitting] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  const involvesTestusd = tokenXSymbol === TOKEN_Y.symbol || tokenYSymbol === TOKEN_Y.symbol;
  const [trustlineChecked, setTrustlineChecked] = useState(false);
  const [hasTrustline, setHasTrustline] = useState(true);
  const [establishingTrustline, setEstablishingTrustline] = useState(false);
  const [requestingFaucet, setRequestingFaucet] = useState(false);

  useEffect(() => {
    if (!open) {
      setTrustlineChecked(false);
      setStrategy(initialStrategy);
      return;
    }
    if (mode !== "add" || !involvesTestusd || !wallet.address) {
      setTrustlineChecked(true);
      setHasTrustline(true);
      return;
    }
    setTrustlineChecked(false);
    hasTestusdTrustline(wallet.address).then((ok) => {
      setHasTrustline(ok);
      setTrustlineChecked(true);
    });
  }, [open, mode, involvesTestusd, wallet.address, initialStrategy]);

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
        if (!amountX || !amountY || parseFloat(amountX) <= 0 || parseFloat(amountY) <= 0) {
          throw new Error(`Enter both ${tokenXSymbol} and ${tokenYSymbol} amounts`);
        }
        const splits = tokenSplitWeights(strategy, radius);
        const totalX = displayToStroops(amountX);
        const totalY = displayToStroops(amountY);

        setProgress({ done: 0, total: splits.length });
        for (let i = 0; i < splits.length; i++) {
          const { offset, wX, wY } = splits[i];
          const amtX = BigInt(Math.floor(Number(totalX) * wX));
          const amtY = BigInt(Math.floor(Number(totalY) * wY));
          if (amtX <= 0n && amtY <= 0n) {
            setProgress({ done: i + 1, total: splits.length });
            continue;
          }
          const prepared = await buildAddLiquidityTransaction(
            wallet.address,
            binId + offset,
            amtX,
            amtY,
            poolId
          );
          const signedXdr = await wallet.signTransaction(prepared.toXDR());
          await submitSignedTransaction(signedXdr);
          setProgress({ done: i + 1, total: weights.length });
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
            ? `Deposited across ${radius * 2 + 1} bins using the ${strategy} strategy.`
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
        title: mode === "add" ? "Add liquidity failed" : "Remove liquidity failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
      setProgress(null);
    }
  }

  const needsTrustlineGate =
    mode === "add" && involvesTestusd && trustlineChecked && !hasTrustline;

  const weights = strategyWeights(strategy, radius);
  const totalXNum = parseFloat(amountX || "0");
  const totalYNum = parseFloat(amountY || "0");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="dialog-liquidity">
        <DialogHeader>
          <DialogTitle>
            {mode === "add" ? "Add Liquidity" : "Remove Liquidity"} (active bin {binId})
          </DialogTitle>
        </DialogHeader>

        {mode === "add" && involvesTestusd && !trustlineChecked && (
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
                  {TOKEN_Y.symbol} is a classic-asset-backed token. Your wallet needs a one-time
                  trustline before it can hold or receive it — this is why "Add Liquidity" failed
                  before.
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
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Waiting for signature…</>
              ) : (
                "Establish TESTUSD trustline"
              )}
            </Button>
          </div>
        ) : mode === "add" && trustlineChecked ? (
          <div className="space-y-4 py-2">
            {involvesTestusd && (
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={handleFaucet}
                disabled={requestingFaucet || faucet.isPending}
                data-testid="button-faucet-testusd"
              >
                {requestingFaucet ? (
                  <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Requesting…</>
                ) : (
                  <><Droplets className="w-4 h-4 mr-2" />Get 500 TESTUSD (testnet faucet)</>
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
                  {radius * 2 + 1} bins (±{radius})
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
              <div className="flex h-6 items-end gap-[2px]" data-testid="bin-distribution-preview">
                {weights.map((w, i) => (
                  <div
                    key={i}
                    className="flex-1 rounded-t bg-primary/70"
                    style={{ height: `${Math.max(8, w * weights.length * 40)}%` }}
                    title={`bin ${binId + i - radius}`}
                  />
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Total {tokenXSymbol}
                </label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={amountX}
                  onChange={(e) => setAmountX(e.target.value)}
                  data-testid="input-liquidity-amount-x"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  Total {tokenYSymbol}
                </label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={amountY}
                  onChange={(e) => setAmountY(e.target.value)}
                  data-testid="input-liquidity-amount-y"
                />
              </div>
            </div>

            {(totalXNum > 0 || totalYNum > 0) && (
              <p className="text-[11px] text-muted-foreground">
                Deposits will be split across {radius * 2 + 1} bins per the {strategy} weighting
                and submitted as {radius * 2 + 1} sequential transactions (Soroban allows one
                contract call per transaction).
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
              (mode === "add" && (needsTrustlineGate || !trustlineChecked))
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
              `Confirm Add Liquidity (${radius * 2 + 1} bin${radius > 0 ? "s" : ""})`
            ) : (
              "Confirm Remove Liquidity"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Re-export for display helpers used elsewhere (e.g. estimated per-bin amounts).
export { stroopsToDisplay };
