import { useState, useEffect, useRef } from "react";
import { useGetPoolRecentSwaps } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowDownUp, Settings, AlertTriangle, CheckCircle2, ChevronDown, Loader2, ArrowDownRight, ArrowUpRight } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { WalletModal } from "@/components/wallet-modal";
import { useToast } from "@/hooks/use-toast";
import { DEMO_POOL_TOKENS, DEFAULT_POOL_ID } from "@/lib/contracts";
import { displayToStroops, stroopsToDisplay } from "@/lib/stellar";
import {
  getOnChainSwapQuote,
  buildSwapTransaction,
  submitSignedSwap,
  type SwapQuote,
} from "@/lib/dlmm-client";

const SLIPPAGE_PRESETS = ["0.1", "0.5", "1.0"];
const DEFAULT_POOL_RECORD_ID = `dlmm-${DEFAULT_POOL_ID}`;

export default function SwapPage() {
  const tokens = DEMO_POOL_TOKENS;
  const { data: recentSwaps, isLoading: swapsLoading } = useGetPoolRecentSwaps(DEFAULT_POOL_RECORD_ID);
  const wallet = useWallet();
  const { toast } = useToast();

  const [tokenInId, setTokenInId] = useState(tokens[0].address);
  const [tokenOutId, setTokenOutId] = useState(tokens[1].address);
  const [amountIn, setAmountIn] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [customSlippage, setCustomSlippage] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [signing, setSigning] = useState(false);
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [quotePending, setQuotePending] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const tokenIn = tokens.find((t) => t.address === tokenInId);
  const tokenOut = tokens.find((t) => t.address === tokenOutId);
  const effectiveSlippage = customSlippage || slippage;
  const xToY = tokenInId === tokens[0].address;

  const tokenInBalance = tokenIn ? getWalletTokenBalance(wallet, tokenIn.symbol) : null;

  // Debounced REAL on-chain quote via simulate_swap (read-only contract call)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuote(null);
    setQuoteError(null);
    if (!tokenInId || !tokenOutId || !amountIn || parseFloat(amountIn) <= 0) return;
    debounceRef.current = setTimeout(async () => {
      setQuotePending(true);
      try {
        const amountInStroops = displayToStroops(amountIn);
        const result = await getOnChainSwapQuote(xToY, amountInStroops);
        setQuote(result);
      } catch (err) {
        setQuoteError(err instanceof Error ? err.message : "Quote failed");
      } finally {
        setQuotePending(false);
      }
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [tokenInId, tokenOutId, amountIn, xToY]);

  function handleMaxAmount() {
    if (!tokenInBalance) return;
    setAmountIn(tokenInBalance);
  }

  function handleFlip() {
    setTokenInId(tokenOutId);
    setTokenOutId(tokenInId);
    setAmountIn(quote ? stroopsToDisplay(quote.amountOut) : "");
    setQuote(null);
  }

  async function handleConfirmSwap() {
    if (!wallet.connected || !wallet.address) { setWalletModalOpen(true); return; }
    if (!quote) return;
    setSigning(true);
    try {
      const amountInStroops = displayToStroops(amountIn);
      const slippageBps = BigInt(Math.round(parseFloat(effectiveSlippage) * 100));
      const minAmountOut = quote.amountOut - (quote.amountOut * slippageBps) / 10_000n;

      const prepared = await buildSwapTransaction(
        wallet.address,
        xToY,
        amountInStroops,
        minAmountOut
      );
      const signedXdr = await wallet.signTransaction(prepared.toXDR());
      const result = await submitSignedSwap(signedXdr);

      toast({
        title: "Swap confirmed on-chain",
        description: `Received ${stroopsToDisplay(result.amountOut)} ${tokenOut?.symbol} (fee: ${stroopsToDisplay(result.feePaid)})`,
      });
      setAmountIn("");
      setQuote(null);
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
    <div className="max-w-md mx-auto space-y-6">
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
                onClick={() => { setSlippage(p); setCustomSlippage(""); }}
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
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
            </div>
          </div>
        </Card>
      )}

      {/* Swap card */}
      <Card className="p-4 border-border bg-card" data-testid="card-swap">
        {/* You pay */}
        <div className="space-y-1 pb-2">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">You pay</label>
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
              value={tokenInId}
              exclude={tokenOutId}
              onChange={setTokenInId}
              testId="select-token-in"
            />
          </div>
          {wallet.connected && (
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

        {/* You receive */}
        <div className="space-y-1 pb-4">
          <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">You receive</label>
          <div className="flex gap-2 items-center">
            <div className="flex-1 relative">
              <Input
                type="number"
                placeholder="0.00"
                readOnly
                className="text-2xl font-mono bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-12 tabular-nums"
                value={quote ? stroopsToDisplay(quote.amountOut) : ""}
                data-testid="input-amount-out"
              />
              {quotePending && (
                <Loader2 className="absolute right-0 top-3 w-5 h-5 animate-spin text-muted-foreground" />
              )}
            </div>
            <TokenSelect
              tokens={tokens}
              value={tokenOutId}
              exclude={tokenInId}
              onChange={setTokenOutId}
              testId="select-token-out"
            />
          </div>
        </div>

        {/* Quote breakdown (real on-chain simulate_swap result) */}
        {quote && (
          <div className="border border-border rounded-md p-3 space-y-2 text-sm mb-4 bg-secondary/30">
            <QuoteRow label="Minimum received" value={`${stroopsToDisplay(quote.amountOut)} ${tokenOut?.symbol ?? ""}`} />
            <QuoteRow label="Swap fee" value={`${stroopsToDisplay(quote.feePaid)} ${tokenIn?.symbol ?? ""}`} />
            <QuoteRow label="Bins crossed" value={`${quote.binsCrossed}`} />
            <QuoteRow label="Final bin" value={`${quote.finalBin}`} />
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
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Waiting for signature…</>
            ) : quotePending ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Getting quote…</>
            ) : quote ? (
              <><CheckCircle2 className="w-4 h-4 mr-2" />Confirm Swap</>
            ) : "Swap"}
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

      {/* Recent Swaps — real SWAP events read from the DLMM contract (not realtime) */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Recent Swaps</h3>
        {swapsLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
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
                    <span className="font-mono text-xs text-muted-foreground">{swap.txHash.slice(0, 8)}…</span>
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
          <p className="text-xs text-muted-foreground px-1">No recent on-chain swaps found for this pool.</p>
        )}
      </div>

      <WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Looks up the connected wallet's balance for a token symbol (XLM is tracked
 * separately from Horizon's non-native balance list). Returns null if the
 * wallet isn't connected or holds no trustline/balance for that asset. */
function getWalletTokenBalance(
  wallet: { xlmBalance: string | null; tokenBalances: Array<{ asset: string; balance: string }> },
  symbol: string
): string | null {
  if (symbol === "XLM") return wallet.xlmBalance;
  const match = wallet.tokenBalances.find((b) => b.asset === symbol);
  return match ? match.balance : null;
}

function QuoteRow({ label, value, valueCls = "" }: { label: string; value: string; valueCls?: string }) {
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
            <option key={t.address} value={t.address}>{t.symbol}</option>
          ))}
      </select>
      <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
    </div>
  );
}
