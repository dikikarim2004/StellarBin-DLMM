import { useState, useEffect, useRef } from "react";
import { useGetSwapQuote, useListTokens, useListTransactions } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowDownUp, Settings, AlertTriangle, CheckCircle2, ChevronDown, Loader2 } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { WalletModal } from "@/components/wallet-modal";
import { useToast } from "@/hooks/use-toast";

const SLIPPAGE_PRESETS = ["0.1", "0.5", "1.0"];

export default function SwapPage() {
  const { data: tokens = [], isLoading: tokensLoading } = useListTokens();
  const { data: transactions, isLoading: txLoading } = useListTransactions({ type: "swap", limit: 8 });
  const wallet = useWallet();
  const { toast } = useToast();

  const [tokenInId, setTokenInId] = useState("");
  const [tokenOutId, setTokenOutId] = useState("");
  const [amountIn, setAmountIn] = useState("");
  const [slippage, setSlippage] = useState("0.5");
  const [customSlippage, setCustomSlippage] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [signing, setSigning] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swapQuote = useGetSwapQuote();

  const tokenIn = tokens.find((t) => t.address === tokenInId);
  const tokenOut = tokens.find((t) => t.address === tokenOutId);
  const effectiveSlippage = customSlippage || slippage;

  // Auto-populate defaults once tokens load
  useEffect(() => {
    if (tokens.length >= 2 && !tokenInId && !tokenOutId) {
      setTokenInId(tokens[0].address);
      setTokenOutId(tokens[1].address);
    }
  }, [tokens, tokenInId, tokenOutId]);

  // Debounced quote
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!tokenInId || !tokenOutId || !amountIn || parseFloat(amountIn) <= 0) return;
    debounceRef.current = setTimeout(() => {
      swapQuote.mutate({
        data: {
          tokenInAddress: tokenInId,
          tokenOutAddress: tokenOutId,
          amountIn: parseFloat(amountIn),
          slippageTolerance: parseFloat(effectiveSlippage),
        },
      });
    }, 400);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [tokenInId, tokenOutId, amountIn, effectiveSlippage]);

  function handleFlip() {
    setTokenInId(tokenOutId);
    setTokenOutId(tokenInId);
    setAmountIn(swapQuote.data?.amountOut?.toFixed(6) ?? "");
    swapQuote.reset();
  }

  async function handleConfirmSwap() {
    if (!wallet.connected) { setWalletModalOpen(true); return; }
    if (!swapQuote.data) return;
    setSigning(true);
    try {
      // Build a placeholder XDR (real builds use buildContractInvocation from stellar.ts).
      // In production this XDR comes from the backend /api/swap/build endpoint.
      const placeholderXdr = btoa(`swap:${tokenInId}:${tokenOutId}:${amountIn}`);
      const signed = await wallet.signTransaction(placeholderXdr);
      toast({
        title: "Transaction signed",
        description: `Signed: ${signed.slice(0, 24)}…`,
      });
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Signing failed",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setSigning(false);
    }
  }

  const priceImpact = swapQuote.data?.priceImpact ?? 0;
  const impactCls =
    priceImpact > 3 ? "text-red-400" : priceImpact > 1 ? "text-yellow-400" : "text-green-400";
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
            {tokensLoading ? (
              <Skeleton className="w-32 h-9" />
            ) : (
              <TokenSelect
                tokens={tokens}
                value={tokenInId}
                exclude={tokenOutId}
                onChange={setTokenInId}
                testId="select-token-in"
              />
            )}
          </div>
          {tokenIn && amountIn && (
            <p className="text-xs text-muted-foreground font-mono pl-0.5">
              ≈ ${(parseFloat(amountIn) * tokenIn.price).toLocaleString("en", { maximumFractionDigits: 2 })}
            </p>
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
                value={swapQuote.data?.amountOut?.toFixed(6) ?? ""}
                data-testid="input-amount-out"
              />
              {swapQuote.isPending && (
                <Loader2 className="absolute right-0 top-3 w-5 h-5 animate-spin text-muted-foreground" />
              )}
            </div>
            {tokensLoading ? (
              <Skeleton className="w-32 h-9" />
            ) : (
              <TokenSelect
                tokens={tokens}
                value={tokenOutId}
                exclude={tokenInId}
                onChange={setTokenOutId}
                testId="select-token-out"
              />
            )}
          </div>
          {swapQuote.data && tokenOut && (
            <p className="text-xs text-muted-foreground font-mono pl-0.5">
              ≈ ${(swapQuote.data.amountOut * tokenOut.price).toLocaleString("en", { maximumFractionDigits: 2 })}
            </p>
          )}
        </div>

        {/* Quote breakdown */}
        {swapQuote.data && (
          <div className="border border-border rounded-md p-3 space-y-2 text-sm mb-4 bg-secondary/30">
            <QuoteRow label="Price impact" value={`${priceImpact.toFixed(3)}%`} valueCls={impactCls} />
            <QuoteRow label="Minimum received" value={`${swapQuote.data.minimumReceived.toFixed(6)} ${tokenOut?.symbol ?? ""}`} />
            <QuoteRow label="Swap fee" value={`${swapQuote.data.fee.toFixed(6)} ${tokenIn?.symbol ?? ""}`} />
            <QuoteRow label="Bins traversed" value={`${swapQuote.data.binsTraversed}`} />
            {swapQuote.data.route.length > 0 && (
              <div className="flex items-center gap-1 pt-1">
                <span className="text-muted-foreground text-xs">Route</span>
                <div className="flex items-center gap-1 flex-wrap ml-auto text-xs font-mono">
                  <span>{tokenIn?.symbol}</span>
                  {swapQuote.data.route.map((r) => (
                    <span key={r} className="text-muted-foreground">→ {r.split("-").slice(1).join("-").toUpperCase() || r}</span>
                  ))}
                  <span>→ {tokenOut?.symbol}</span>
                </div>
              </div>
            )}
          </div>
        )}

        {priceImpact > 3 && swapQuote.data && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-md p-2 mb-4">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            High price impact ({priceImpact.toFixed(2)}%). Consider splitting your order.
          </div>
        )}

        {/* Swap / Connect button */}
        {wallet.connected ? (
          <Button
            className="w-full h-12 text-base font-semibold"
            onClick={handleConfirmSwap}
            disabled={!canSwap || swapQuote.isPending || signing}
            data-testid="button-confirm-swap"
          >
            {signing ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Waiting for signature…</>
            ) : swapQuote.isPending ? (
              <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Getting quote…</>
            ) : swapQuote.data ? (
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

      {/* Connected wallet banner */}
      {wallet.connected && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground bg-green-500/5 border border-green-500/20 rounded-md px-3 py-2">
          <div className="w-2 h-2 rounded-full bg-green-400" />
          <span className="font-mono">{wallet.address}</span>
          {wallet.xlmBalance && <span className="ml-auto tabular-nums">{wallet.xlmBalance} XLM</span>}
        </div>
      )}

      {/* Recent Transactions */}
      <div className="space-y-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">Recent Swaps</h3>
        {txLoading ? (
          <div className="space-y-2">
            {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-11 w-full" />)}
          </div>
        ) : (
          <div className="space-y-1.5">
            {transactions?.map((tx) => (
              <div
                key={tx.id}
                className="flex justify-between items-center px-3 py-2.5 rounded-md bg-card border border-border text-sm"
                data-testid={`row-tx-${tx.id}`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">{tx.txHash.slice(0, 8)}…</span>
                  <span className="text-xs bg-secondary px-1.5 py-0.5 rounded text-muted-foreground">SWAP</span>
                </div>
                <span className="font-mono text-green-400 tabular-nums">
                  +${tx.valueUsd?.toLocaleString("en", { maximumFractionDigits: 2 })}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  tokens: Array<{ address: string; symbol: string; logoUrl: string }>;
  value: string;
  exclude: string;
  onChange: (v: string) => void;
  testId: string;
}) {
  const selected = tokens.find((t) => t.address === value);
  return (
    <div className="relative">
      <select
        className="appearance-none bg-secondary border border-border rounded-lg pl-9 pr-7 py-2 font-semibold text-sm cursor-pointer focus:outline-none focus:ring-1 focus:ring-primary"
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
      {selected && (
        <img
          src={selected.logoUrl}
          alt={selected.symbol}
          className="absolute left-2 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full pointer-events-none"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
        />
      )}
      <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
    </div>
  );
}
