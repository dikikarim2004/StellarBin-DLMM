import { useState, useEffect, useRef } from "react";
import { listPools, useGetPoolRecentSwaps } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ArrowDownUp,
  Settings,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Loader2,
  ArrowDownRight,
  ArrowUpRight,
  Route,
} from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { WalletModal } from "@/components/wallet-modal";
import { useToast } from "@/hooks/use-toast";
import { DEMO_POOL_TOKENS, DEFAULT_POOL_ID, TOKEN_X } from "@/lib/contracts";
import { DLMM_V2_CONTRACT_ID } from "@/lib/contracts";
import { USDC_ISSUER } from "@/lib/trustline";
import { displayToStroops, stroopsToDisplay } from "@/lib/stellar";
import {
  getOnChainSwapQuote,
  getOnChainExactOutQuote,
  buildSwapTransaction,
  buildExactOutSwapTransaction,
  submitSignedSwap,
  submitSignedExactOutSwap,
  type SwapQuote,
} from "@/lib/dlmm-client";

const SLIPPAGE_PRESETS = ["0.1", "0.5", "1.0"];
const DEFAULT_POOL_RECORD_ID = `dlmm-${DEFAULT_POOL_ID}`;
type SwapMode = "exact-in" | "exact-out";

export default function SwapPage() {
  const tokens = DEMO_POOL_TOKENS;
  const wallet = useWallet();
  const { toast } = useToast();

  const [tokenInId, setTokenInId] = useState(tokens[0].address);
  const [tokenOutId, setTokenOutId] = useState(tokens[1].address);
  const [swapMode, setSwapMode] = useState<SwapMode>("exact-in");
  const [amountIn, setAmountIn] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [customSlippage, setCustomSlippage] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quotePending, setQuotePending] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [bestPoolId, setBestPoolId] = useState<number | null>(null);
  const [poolsTriedCount, setPoolsTriedCount] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tokenIn = tokens.find((t) => t.address === tokenInId);
  const tokenOut = tokens.find((t) => t.address === tokenOutId);
  const effectiveSlippage = customSlippage || slippage;
  const xToY = tokenInId === tokens[0].address;

  const tokenInBalance = tokenIn ? getWalletTokenBalance(wallet, tokenIn) : null;

  const recentSwapsPoolId = bestPoolId !== null ? `dlmm-${bestPoolId}` : DEFAULT_POOL_RECORD_ID;
  const { data: recentSwaps, isLoading: swapsLoading } = useGetPoolRecentSwaps(recentSwapsPoolId);

  // Debounced REAL on-chain quote — fetches fresh pool list then tries all DLMM pools in parallel
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuote(null);
    setQuoteError(null);
    setBestPoolId(null);
    setPoolsTriedCount(0);
    if (!tokenInId || !tokenOutId || !amountIn || parseFloat(amountIn) <= 0) return;

    debounceRef.current = setTimeout(async () => {
      setQuotePending(true);
      try {
        const amountSpecified = displayToStroops(amountIn);

        // Fetch fresh pool list inside the effect so routing never uses stale cache
        const allPools = await listPools();
        const candidatePoolIds = allPools
          .filter(
            (p) =>
              p.category === "dlmm" &&
              p.dlmmPoolId !== undefined &&
              // For x→y (sell XLM, get USDC) we need USDC in pool (reserveY)
              // For y→x (sell USDC, get XLM) we need XLM in pool (reserveX)
              (xToY ? (p.reserveY ?? 0) > 0.0001 : (p.reserveX ?? 0) > 0.0001)
          )
          .map((p) => p.dlmmPoolId as number);

        // If no pool has the required reserve, still try DEFAULT_POOL_ID for a meaningful error
        const poolsToTry = candidatePoolIds.length > 0 ? candidatePoolIds : [DEFAULT_POOL_ID];
        setPoolsTriedCount(poolsToTry.length);

        // Try all candidate pools in parallel and optimize for the selected mode.
        const results = await Promise.allSettled(
          poolsToTry.map(async (poolId) => {
            if (swapMode === "exact-in") {
              const q = await getOnChainSwapQuote(xToY, amountSpecified, poolId);
              return { poolId, quote: q };
            }
            const q = await getOnChainExactOutQuote(xToY, amountSpecified, poolId);
            return {
              poolId,
              quote: {
                amountIn: q.amountIn,
                amountOut: q.amountOut,
                feePaid: q.feePaid,
                binsCrossed: q.binsCrossed,
                finalBin: q.finalBin,
              },
            };
          })
        );

        let best: { poolId: number; quote: SwapQuote } | null = null;
        const rejectedReasons: string[] = [];
        for (const r of results) {
          if (r.status === "fulfilled" && r.value.quote.amountOut > 0n) {
            const isBetter = swapMode === "exact-in"
              ? r.value.quote.amountOut > best?.quote.amountOut!
              : r.value.quote.amountIn < best?.quote.amountIn!;
            if (!best || isBetter) {
              best = r.value;
            }
          } else if (r.status === "rejected") {
            rejectedReasons.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
          }
        }

        if (best) {
          setQuote(best.quote);
          setBestPoolId(best.poolId);
        } else {
          setQuote(null);
          setBestPoolId(null);
          const hasOutputReserve = candidatePoolIds.length > 0;
          setQuoteError(
            hasOutputReserve
              ? (rejectedReasons.length > 0
                ? `Quote failed: ${rejectedReasons.join("; ")}`
                : "Quote failed for the configured pool.")
              : `No ${tokenOut?.symbol ?? "output token"} reserve is available for this direction. Use Create Position to add the other side or try the opposite swap.`
          );
        }
      } catch (err) {
        setQuoteError(err instanceof Error ? err.message : "Quote failed");
      } finally {
        setQuotePending(false);
      }
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [tokenInId, tokenOutId, amountIn, xToY, swapMode]);

  function handleMaxAmount() {
    if (!tokenInBalance) return;
    setAmountIn(tokenInBalance);
  }

  function handleFlip() {
    setTokenInId(tokenOutId);
    setTokenOutId(tokenInId);
    setAmountIn(
      quote
        ? stroopsToDisplay(swapMode === "exact-in" ? quote.amountOut : quote.amountIn)
        : ""
    );
    setQuote(null);
    setBestPoolId(null);
  }

  async function handleConfirmSwap() {
    if (!wallet.connected || !wallet.address) {
      setWalletModalOpen(true);
      return;
    }
    if (!quote) return;
    setSigning(true);
    try {
      const slippageBps = BigInt(Math.round(parseFloat(effectiveSlippage) * 100));
      const routedPoolId = bestPoolId ?? DEFAULT_POOL_ID;
      let received: bigint;
      let feePaid: bigint;
      if (swapMode === "exact-in") {
        const amountInStroops = displayToStroops(amountIn);
        const minAmountOut = quote.amountOut - (quote.amountOut * slippageBps) / 10_000n;
        const prepared = await buildSwapTransaction(
          wallet.address, xToY, amountInStroops, minAmountOut, routedPoolId
        );
        const signedXdr = await wallet.signTransaction(prepared.toXDR());
        const result = await submitSignedSwap(signedXdr);
        received = result.amountOut;
        feePaid = result.feePaid;
      } else {
        const amountOutStroops = displayToStroops(amountIn);
        const maxAmountIn = quote.amountIn + (quote.amountIn * slippageBps) / 10_000n;
        const prepared = await buildExactOutSwapTransaction(
          wallet.address, xToY, amountOutStroops, maxAmountIn, routedPoolId
        );
        const signedXdr = await wallet.signTransaction(prepared.toXDR());
        const result = await submitSignedExactOutSwap(signedXdr);
        received = result.amountOut;
        feePaid = result.feePaid;
      }

      toast({
        title: "Swap confirmed on-chain",
        description: `Received ${stroopsToDisplay(received)} ${tokenOut?.symbol} (fee: ${stroopsToDisplay(feePaid)}) via Pool #${routedPoolId}`,
      });
      setAmountIn("");
      setQuote(null);
      setBestPoolId(null);
      await wallet.refreshBalance();
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Swap failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSigning(false);
    }
  }

  const canSwap = !!tokenInId && !!tokenOutId && !!amountIn && parseFloat(amountIn) > 0;

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">Swap</h1>
        <Button
          variant="ghost"
          size="icon"
          className="text-muted-foreground"
          onClick={() => setShowSettings((s) => !s)}
          data-testid="button-swap-settings"
        >
          <Settings className="w-5 h-5" />
        </Button>
      </div>

      {/* Slippage settings panel */}
      {showSettings && (
        <Card className="p-4 border-border bg-card space-y-3" data-testid="panel-slippage">
          <p className="text-sm font-medium">Slippage Tolerance</p>
          <div className="flex gap-2">
            {SLIPPAGE_PRESETS.map((p) => (
              <button
                key={p}
                onClick={() => {
                  setSlippage(p);
                  setCustomSlippage("");
                }}
                className={`px-3 py-1.5 rounded-md text-sm font-mono transition-colors ${
                  slippage === p && !customSlippage
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-secondary-foreground hover:bg-secondary/80"
                }`}
                data-testid={`button-slippage-${p}`}
              >
                {p}%
              </button>
            ))}
            <div className="relative flex-1">
              <Input
                type="number"
                placeholder="Custom"
                className="h-8 text-sm font-mono pr-6"
                value={customSlippage}
                onChange={(e) => setCustomSlippage(e.target.value)}
                data-testid="input-slippage-custom"
              />
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                %
              </span>
            </div>
          </div>
        </Card>
      )}

      <div className="inline-flex border border-border rounded-md p-1" role="group" aria-label="Swap mode">
        {(["exact-in", "exact-out"] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            onClick={() => setSwapMode(mode)}
            disabled={mode === "exact-out" && !DLMM_V2_CONTRACT_ID}
            className={`px-3 py-1.5 text-sm rounded-sm ${swapMode === mode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            aria-pressed={swapMode === mode}
          >
            {mode === "exact-in" ? "Exact In" : `Exact Out${DLMM_V2_CONTRACT_ID ? "" : " (V2 required)"}`}
          </button>
        ))}
      </div>

      {/* Swap card */}
      <Card className="p-4 border-border bg-card" data-testid="card-swap">
        {/* User-specified side */}
        <div className="space-y-1 pb-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {swapMode === "exact-in" ? "You pay" : "You receive"}
          </label>
          <div className="flex gap-2 items-center">
            <Input
              type="number"
              placeholder="0.00"
              className="text-2xl font-mono bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-12 tabular-nums"
              value={amountIn}
              onChange={(e) => setAmountIn(e.target.value)}
              data-testid="input-amount-in"
            />
            <TokenSelect
              tokens={tokens}
              value={swapMode === "exact-in" ? tokenInId : tokenOutId}
              exclude={swapMode === "exact-in" ? tokenOutId : tokenInId}
              onChange={swapMode === "exact-in" ? setTokenInId : setTokenOutId}
              testId={swapMode === "exact-in" ? "select-token-in" : "select-token-out"}
            />
          </div>
          {swapMode === "exact-in" && wallet.connected && (
            <div className="flex items-center justify-end gap-1.5 text-xs text-muted-foreground pt-0.5">
              <span className="font-mono tabular-nums" data-testid="text-balance-in">
                Balance: {tokenInBalance ?? "0.0000"} {tokenIn?.symbol ?? ""}
              </span>
              <button
                type="button"
                onClick={handleMaxAmount}
                disabled={!tokenInBalance || parseFloat(tokenInBalance) <= 0}
                className="font-semibold text-primary hover:underline disabled:opacity-40 disabled:cursor-not-allowed disabled:no-underline"
                data-testid="button-max-amount"
              >
                Max
              </button>
            </div>
          )}
        </div>

        {/* Flip */}
        <div className="flex justify-center my-1 relative z-10">
          <Button
            variant="secondary"
            size="icon"
            className="rounded-full h-9 w-9 border-2 border-background"
            onClick={handleFlip}
            data-testid="button-flip-tokens"
          >
            <ArrowDownUp className="w-4 h-4" />
          </Button>
        </div>

        {/* Quoted side */}
        <div className="space-y-1 pb-4">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {swapMode === "exact-in" ? "You receive" : "You pay (estimated)"}
          </label>
          <div className="flex gap-2 items-center">
            <div className="flex-1 relative">
              <Input
                type="number"
                placeholder="0.00"
                readOnly
                className="text-2xl font-mono bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-12 tabular-nums"
                value={quote
                  ? stroopsToDisplay(swapMode === "exact-in" ? quote.amountOut : quote.amountIn)
                  : ""}
                data-testid="input-amount-out"
              />
              {quotePending && (
                <Loader2 className="absolute right-0 top-3 w-5 h-5 animate-spin text-muted-foreground" />
              )}
            </div>
            <TokenSelect
              tokens={tokens}
              value={swapMode === "exact-in" ? tokenOutId : tokenInId}
              exclude={swapMode === "exact-in" ? tokenInId : tokenOutId}
              onChange={swapMode === "exact-in" ? setTokenOutId : setTokenInId}
              testId={swapMode === "exact-in" ? "select-token-out" : "select-token-in"}
            />
          </div>
        </div>

        {/* Quote breakdown (real on-chain simulate_swap result) */}
        {quote && (
          <div className="border border-border rounded-md p-3 space-y-2 text-sm mb-4 bg-secondary/30">
            <QuoteRow
              label={swapMode === "exact-in" ? "Quoted output" : "Exact output"}
              value={`${stroopsToDisplay(quote.amountOut)} ${tokenOut?.symbol ?? ""}`}
            />
            {swapMode === "exact-out" && (
              <QuoteRow
                label="Maximum input"
                value={`${stroopsToDisplay(quote.amountIn + (quote.amountIn * BigInt(Math.round(parseFloat(effectiveSlippage) * 100))) / 10_000n)} ${tokenIn?.symbol ?? ""}`}
              />
            )}
            <QuoteRow
              label="Estimated fee (token units)"
              value={stroopsToDisplay(quote.feePaid)}
            />
            <QuoteRow label="Bins crossed" value={`${quote.binsCrossed}`} />
            <QuoteRow label="Final bin" value={`${quote.finalBin}`} />
            {bestPoolId !== null && (
              <div className="flex justify-between items-center pt-1 border-t border-border/50">
                <span className="text-muted-foreground flex items-center gap-1">
                  <Route className="w-3 h-3" />
                  Route
                </span>
                <span className="font-mono tabular-nums text-primary font-medium">
                  Pool #{bestPoolId}
                  {poolsTriedCount > 1 && (
                    <span className="text-muted-foreground font-normal ml-1">
                      (best of {poolsTriedCount})
                    </span>
                  )}
                </span>
              </div>
            )}
          </div>
        )}

        {quoteError && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-md p-2 mb-4">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            {quoteError}
          </div>
        )}

        {/* Swap / Connect button */}
        {wallet.connected ? (
          <Button
            className="w-full h-12 text-base font-semibold"
            onClick={handleConfirmSwap}
            disabled={!canSwap || quotePending || signing || !quote}
            data-testid="button-confirm-swap"
          >
            {signing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Waiting for signature…
              </>
            ) : quotePending ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Finding best route…
              </>
            ) : quote ? (
              <>
                <CheckCircle2 className="w-4 h-4 mr-2" />
                Confirm Swap
              </>
            ) : (
              "Swap"
            )}
          </Button>
        ) : (
          <Button
            className="w-full h-12 text-base font-semibold"
            onClick={() => setWalletModalOpen(true)}
            data-testid="button-connect-to-swap"
          >
            Connect Wallet to Swap
          </Button>
        )}
      </Card>

      {/* Recent Swaps — real SWAP events from the best routed pool */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">
          Recent Swaps
          {bestPoolId !== null && (
            <span className="ml-2 normal-case font-normal text-primary">
              · Pool #{bestPoolId}
            </span>
          )}
        </h3>
        {swapsLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-11 w-full" />
            ))}
          </div>
        ) : recentSwaps && recentSwaps.length > 0 ? (
          <div className="space-y-1.5">
            {recentSwaps.map((swap) => {
              const inSymbol = swap.xToY ? tokens[0].symbol : tokens[1].symbol;
              const outSymbol = swap.xToY ? tokens[1].symbol : tokens[0].symbol;
              return (
                <div
                  key={swap.txHash}
                  className="flex justify-between items-center px-3 py-2.5 rounded-md bg-card border border-border text-sm"
                  data-testid={`row-swap-${swap.txHash}`}
                >
                  <div className="flex items-center gap-2">
                    {swap.xToY ? (
                      <ArrowUpRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <ArrowDownRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="font-mono text-xs text-muted-foreground">
                      {swap.txHash.slice(0, 8)}…
                    </span>
                  </div>
                  <span className="font-mono tabular-nums text-xs text-right">
                    {stroopsToDisplay(BigInt(swap.amountIn))} {inSymbol}
                    <span className="text-muted-foreground"> → </span>
                    {stroopsToDisplay(BigInt(swap.amountOut))} {outSymbol}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground px-1">
            No recent on-chain swaps found for this pool.
          </p>
        )}
      </div>

      <WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getWalletTokenBalance(
  wallet: { xlmBalance: string | null; tokenBalances: Array<{ asset: string; issuer: string | null; balance: string }> },
  token: { address: string; symbol: string }
): string | null {
  if (token.address === TOKEN_X.address || token.address === "native") return wallet.xlmBalance;
  // Classic-backed SAC balances expose asset code + issuer on Horizon; match both
  // so a same-symbol token from another issuer is never mistaken for the pool asset.
  const match = wallet.tokenBalances.find(
    (b) => b.asset === token.symbol && b.issuer === USDC_ISSUER
  );
  return match ? match.balance : null;
}

function QuoteRow({
  label,
  value,
  valueCls = "",
}: {
  label: string;
  value: string;
  valueCls?: string;
}) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-mono tabular-nums ${valueCls}`}>{value}</span>
    </div>
  );
}

function TokenSelect({
  tokens,
  value,
  exclude,
  onChange,
  testId,
}: {
  tokens: Array<{ address: string; symbol: string }>;
  value: string;
  exclude: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <div className="relative">
      <select
        className="appearance-none bg-secondary border border-border rounded-lg pl-3 pr-7 py-2 font-semibold text-sm cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      >
        <option value="">Select</option>
        {tokens
          .filter((t) => t.address !== exclude)
          .map((t) => (
            <option key={t.address} value={t.address}>
              {t.symbol}
            </option>
          ))}
      </select>
      <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
    </div>
  );
}
