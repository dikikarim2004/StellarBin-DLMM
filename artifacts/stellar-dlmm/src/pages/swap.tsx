import { useState, useEffect, useRef } from "react";
import { listPools, useGetPoolRecentSwaps } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  ArrowDownUp,
  Settings,
  AlertTriangle,
  CheckCircle2,
  Check,
  ChevronsUpDown,
  Loader2,
  ArrowDownRight,
  ArrowUpRight,
  Route,
} from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { WalletModal } from "@/components/wallet-modal";
import { DexSwapPanel } from "@/components/dex-swap-panel";
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

  const [poolCatalog, setPoolCatalog] = useState<Awaited<ReturnType<typeof listPools>>>([]);
  const [poolCatalogError, setPoolCatalogError] = useState<string | null>(null);
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
  const [bestXToY, setBestXToY] = useState<boolean | null>(null);
  const [poolsTriedCount, setPoolsTriedCount] = useState(0);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    listPools()
      .then((pools) => {
        if (!cancelled) {
          setPoolCatalog(pools.filter((pool) => pool.category === "dlmm"));
          setPoolCatalogError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setPoolCatalogError(
            error instanceof Error ? error.message : "Unable to load DLMM token list."
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tokensByAddress = new Map<string, (typeof tokens)[number]>();
  for (const token of tokens) tokensByAddress.set(token.address, token);
  for (const pool of poolCatalog) {
    for (const token of [pool.tokenX, pool.tokenY]) {
      const existing = [...tokensByAddress.values()].find((candidate) =>
        sameTokenAddress(candidate.address, token.address)
      );
      if (!existing) tokensByAddress.set(token.address, token);
    }
  }
  const allTokens = [...tokensByAddress.values()];
  const tokenIn = allTokens.find((t) => sameTokenAddress(t.address, tokenInId));
  const tokenOut = allTokens.find((t) => sameTokenAddress(t.address, tokenOutId));
  const tokenInChoices = getPairedTokens(poolCatalog, tokenOutId, allTokens);
  const tokenOutChoices = getPairedTokens(poolCatalog, tokenInId, allTokens);
  const effectiveSlippage = customSlippage || slippage;

  const tokenInBalance = tokenIn ? getWalletTokenBalance(wallet, tokenIn) : null;

  const recentSwapsPoolId = bestPoolId !== null ? `dlmm-${bestPoolId}` : DEFAULT_POOL_RECORD_ID;
  const recentSwapsPool = poolCatalog.find(
    (pool) => pool.dlmmPoolId === (bestPoolId ?? DEFAULT_POOL_ID)
  );
  const { data: recentSwaps, isLoading: swapsLoading } = useGetPoolRecentSwaps(recentSwapsPoolId);

  // Debounced REAL on-chain quote — fetches fresh pool list then tries all DLMM pools in parallel
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuote(null);
    setQuoteError(null);
    setBestPoolId(null);
    setBestXToY(null);
    setPoolsTriedCount(0);
    if (!tokenInId || !tokenOutId || !amountIn || parseFloat(amountIn) <= 0) return;

    debounceRef.current = setTimeout(async () => {
      setQuotePending(true);
      try {
        const amountSpecified = displayToStroops(amountIn);

        // Fetch fresh pool list inside the effect so routing never uses stale cache
        const allPools = await listPools();
        const candidatePools = allPools
          .filter(
            (p) =>
              p.category === "dlmm" &&
              p.dlmmPoolId !== undefined &&
              (
                (sameTokenAddress(p.tokenX.address, tokenInId) &&
                  sameTokenAddress(p.tokenY.address, tokenOutId) &&
                  (p.reserveY ?? 0) > 0.0001) ||
                (sameTokenAddress(p.tokenY.address, tokenInId) &&
                  sameTokenAddress(p.tokenX.address, tokenOutId) &&
                  (p.reserveX ?? 0) > 0.0001)
              )
          )
          .map((pool) => ({
            poolId: pool.dlmmPoolId as number,
            xToY: sameTokenAddress(pool.tokenX.address, tokenInId),
          }));
        setPoolsTriedCount(candidatePools.length);
        if (candidatePools.length === 0) {
          setQuoteError(`No DLMM pool is available for ${tokenIn?.symbol ?? "input token"} / ${tokenOut?.symbol ?? "output token"}.`);
          return;
        }

        // Try all candidate pools in parallel and optimize for the selected mode.
        const results = await Promise.allSettled(
          candidatePools.map(async ({ poolId, xToY: poolDirection }) => {
            if (swapMode === "exact-in") {
              const q = await getOnChainSwapQuote(poolDirection, amountSpecified, poolId);
              return { poolId, xToY: poolDirection, quote: q };
            }
            const q = await getOnChainExactOutQuote(poolDirection, amountSpecified, poolId);
            return {
              poolId,
              xToY: poolDirection,
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

        let best: { poolId: number; xToY: boolean; quote: SwapQuote } | null = null;
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
          setBestXToY(best.xToY);
        } else {
          setQuote(null);
          setBestPoolId(null);
          setBestXToY(null);
          setQuoteError(
            rejectedReasons.length > 0
              ? `Quote failed: ${rejectedReasons.join("; ")}`
              : "Quote failed for the selected DLMM pool pair."
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
  }, [tokenInId, tokenOutId, amountIn, swapMode]);

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
    setBestXToY(null);
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
          wallet.address, bestXToY ?? true, amountInStroops, minAmountOut, routedPoolId
        );
        const signedXdr = await wallet.signTransaction(prepared.toXDR());
        const result = await submitSignedSwap(signedXdr);
        received = result.amountOut;
        feePaid = result.feePaid;
      } else {
        const amountOutStroops = displayToStroops(amountIn);
        const maxAmountIn = quote.amountIn + (quote.amountIn * slippageBps) / 10_000n;
        const prepared = await buildExactOutSwapTransaction(
          wallet.address, bestXToY ?? true, amountOutStroops, maxAmountIn, routedPoolId
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

  const [swapVenue, setSwapVenue] = useState<"dlmm" | "dex">("dlmm");

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

      <div className="flex w-fit border border-border rounded-md p-1" role="group" aria-label="Swap venue">
        {(["dlmm", "dex"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setSwapVenue(v)}
            className={`px-3 py-1.5 text-sm rounded-sm ${swapVenue === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            aria-pressed={swapVenue === v}
            data-testid={`tab-venue-${v}`}
          >
            {v === "dlmm" ? "StellarBin DLMM" : "Stellar DEX"}
          </button>
        ))}
      </div>

      {swapVenue === "dlmm" && poolCatalogError && (
        <p className="text-xs text-destructive" role="alert">
          Unable to load additional DLMM tokens: {poolCatalogError}
        </p>
      )}

      {swapVenue === "dex" && <DexSwapPanel />}

      {swapVenue === "dlmm" && (
      <>
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
              tokens={swapMode === "exact-in" ? tokenInChoices : tokenOutChoices}
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
              tokens={swapMode === "exact-in" ? tokenOutChoices : tokenInChoices}
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
      </>
      )}

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
              const inSymbol = swap.xToY
                ? recentSwapsPool?.tokenX.symbol ?? tokens[0].symbol
                : recentSwapsPool?.tokenY.symbol ?? tokens[1].symbol;
              const outSymbol = swap.xToY
                ? recentSwapsPool?.tokenY.symbol ?? tokens[1].symbol
                : recentSwapsPool?.tokenX.symbol ?? tokens[0].symbol;
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
  const [open, setOpen] = useState(false);
  const selected = tokens.find((token) => sameTokenAddress(token.address, value));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="secondary"
          role="combobox"
          aria-expanded={open}
          aria-label={`Select ${testId === "select-token-in" ? "input" : "output"} token`}
          className="h-auto min-h-10 max-w-56 justify-between gap-3 px-3 py-2 text-left"
          data-testid={testId}
        >
          <span className="min-w-0">
            <span className="block truncate font-semibold text-sm">
              {selected?.symbol ?? "Select"}
            </span>
            {selected && (
              <span className="block max-w-40 truncate font-mono text-[10px] leading-3 text-muted-foreground">
                {selected.address}
              </span>
            )}
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Search ticker or contract address…" />
          <CommandList>
            <CommandEmpty>No paired DLMM tokens found.</CommandEmpty>
            <CommandGroup heading="DLMM pool tokens">
              {tokens
                .filter((token) => !sameTokenAddress(token.address, exclude))
                .map((token) => (
                  <CommandItem
                    key={token.address}
                    value={`${token.symbol} ${token.address}`}
                    onSelect={() => {
                      onChange(token.address);
                      setOpen(false);
                    }}
                  >
                    <Check
                      className={`mr-2 h-4 w-4 shrink-0 ${
                        sameTokenAddress(token.address, value) ? "opacity-100" : "opacity-0"
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{token.symbol}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {token.address}
                      </span>
                    </span>
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function sameTokenAddress(first: string, second: string): boolean {
  if (first === second) return true;
  const firstIsNative = first === "native" || first === TOKEN_X.address;
  const secondIsNative = second === "native" || second === TOKEN_X.address;
  return firstIsNative && secondIsNative;
}

function getPairedTokens(
  pools: Awaited<ReturnType<typeof listPools>>,
  pairedAddress: string,
  allTokens: Array<{ address: string; symbol: string }>
): Array<{ address: string; symbol: string }> {
  if (pools.length === 0) {
    return allTokens.filter((token) => !sameTokenAddress(token.address, pairedAddress));
  }
  const pairAddresses = pools
    .filter(
      (pool) =>
        sameTokenAddress(pool.tokenX.address, pairedAddress) ||
        sameTokenAddress(pool.tokenY.address, pairedAddress)
    )
    .map((pool) =>
      sameTokenAddress(pool.tokenX.address, pairedAddress)
        ? pool.tokenY.address
        : pool.tokenX.address
    );
  return allTokens.filter(
    (token, index, tokens) =>
      pairAddresses.some((address) => sameTokenAddress(address, token.address)) &&
      !sameTokenAddress(token.address, pairedAddress) &&
      tokens.findIndex((candidate) => sameTokenAddress(candidate.address, token.address)) === index
  );
}
