// Stellar native DEX swap panel: XLM → USDC via Horizon strict-send paths.
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { useToast } from "@/hooks/use-toast";
import { USDC_ISSUER } from "@/lib/trustline";
import {
  getDexQuote,
  buildDexSwapTransaction,
  submitDexTransaction,
  xlmAsset,
  usdcAsset,
} from "@/lib/sdex";

export function DexSwapPanel() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [amountIn, setAmountIn] = useState("");
  const [quote, setQuote] = useState<string | null>(null);
  const [pathInfo, setPathInfo] = useState<number | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleQuote() {
    const amt = amountIn.trim();
    if (!amt || Number(amt) <= 0) return;
    setQuoting(true);
    setQuote(null);
    setPathInfo(null);
    try {
      const q = await getDexQuote(xlmAsset(), amt, usdcAsset(USDC_ISSUER));
      if (!q) {
        toast({ variant: "destructive", title: "No path found on Stellar DEX" });
        return;
      }
      setQuote(q.destinationAmount);
      setPathInfo(q.path.length);
      // Stash for submit
      (window as any).__dexQuote = q;
    } catch (e) {
      toast({
        variant: "destructive",
        title: "Quote failed",
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setQuoting(false);
    }
  }

  async function handleSwap() {
    if (!wallet.connected || !wallet.address) {
      toast({ variant: "destructive", title: "Connect a wallet first" });
      return;
    }
    const q = (window as any).__dexQuote;
    if (!q || !quote) return;
    setSubmitting(true);
    try {
      const xdr = await buildDexSwapTransaction(
        wallet.address,
        xlmAsset(),
        amountIn.trim(),
        usdcAsset(USDC_ISSUER),
        quote,
        q.path
      );
      const signed = await wallet.signTransaction(xdr);
      const hash = await submitDexTransaction(signed);
      toast({ title: "DEX swap confirmed", description: `tx ${hash.slice(0, 12)}…` });
      setAmountIn("");
      setQuote(null);
      await wallet.refreshBalance();
    } catch (e) {
      toast({
        variant: "destructive",
        title: "DEX swap failed",
        description: e instanceof Error ? e.message : "Unknown error",
      });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card className="p-4 border-border bg-card space-y-3" data-testid="card-dex-swap">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          You pay (XLM)
        </label>
        <Input
          type="number"
          placeholder="0.00"
          className="text-2xl font-mono bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-12"
          value={amountIn}
          onChange={(e) => {
            setAmountIn(e.target.value);
            setQuote(null);
          }}
          data-testid="input-dex-amount"
        />
      </div>
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          You receive (USDC, via Stellar DEX)
        </label>
        <div className="text-2xl font-mono h-12 flex items-center" data-testid="text-dex-quote">
          {quote ?? "0.00"}
        </div>
        {pathInfo !== null && (
          <p className="text-xs text-muted-foreground">path hops: {pathInfo}</p>
        )}
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={handleQuote}
          disabled={quoting || !amountIn || Number(amountIn) <= 0}
          data-testid="button-dex-quote"
        >
          {quoting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Get quote"}
        </Button>
        <Button
          onClick={handleSwap}
          disabled={submitting || !quote || !wallet.connected}
          data-testid="button-dex-swap"
        >
          {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : "Swap on Stellar DEX"}
        </Button>
      </div>
    </Card>
  );
}
