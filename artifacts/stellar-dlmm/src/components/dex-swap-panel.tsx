// Stellar native DEX swap panel: pick a destination token, auto-quote, then swap.
import { useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowDown, Loader2 } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { useToast } from "@/hooks/use-toast";
import { USDC_ISSUER } from "@/lib/trustline";
import { TOKEN_Y } from "@/lib/contracts";
import {
  getDexQuote,
  buildDexSwapTransaction,
  submitDexTransaction,
  xlmAsset,
  usdcAsset,
  type DexQuote,
} from "@/lib/sdex";

// Classic Stellar DEX destination assets available for XLM path payments.
const DEX_DEST_TOKENS = [{ code: TOKEN_Y.symbol, issuer: USDC_ISSUER }];

export function DexSwapPanel() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [amountIn, setAmountIn] = useState("");
  const [destCode, setDestCode] = useState(DEX_DEST_TOKENS[0].code);
  const [quote, setQuote] = useState<DexQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dest = DEX_DEST_TOKENS.find((t) => t.code === destCode) ?? DEX_DEST_TOKENS[0];

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuote(null);
    setQuoteError(null);
    const amt = amountIn.trim();
    if (!amt || Number(amt) <= 0) return;
    debounceRef.current = setTimeout(async () => {
      setQuoting(true);
      try {
        const q = await getDexQuote(xlmAsset(), amt, usdcAsset(dest.issuer));
        if (!q) {
          setQuoteError("No path found on Stellar DEX");
        } else {
          setQuote(q);
        }
      } catch (e) {
        setQuoteError(e instanceof Error ? e.message : "Quote failed");
      } finally {
        setQuoting(false);
      }
    }, 500);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [amountIn, dest.issuer]);

  async function handleSwap() {
    if (!wallet.connected || !wallet.address) {
      toast({ variant: "destructive", title: "Connect a wallet first" });
      return;
    }
    if (!quote) return;
    setSubmitting(true);
    try {
      const xdr = await buildDexSwapTransaction(
        wallet.address,
        xlmAsset(),
        amountIn.trim(),
        usdcAsset(dest.issuer),
        quote.destinationAmount,
        quote.path
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

  const rate =
    quote && Number(amountIn) > 0
      ? Number(quote.destinationAmount) / Number(amountIn)
      : null;

  return (
    <Card className="p-4 border-border bg-card space-y-3" data-testid="card-dex-swap">
      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          You pay
        </label>
        <div className="flex gap-2 items-center">
          <Input
            type="number"
            placeholder="0.00"
            className="text-2xl font-mono bg-transparent border-none shadow-none focus-visible:ring-0 px-0 h-12"
            value={amountIn}
            onChange={(e) => setAmountIn(e.target.value)}
            data-testid="input-dex-amount"
          />
          <span className="font-semibold text-sm px-3 py-2 rounded-md bg-muted">XLM</span>
        </div>
      </div>

      <div className="flex justify-center">
        <ArrowDown className="w-4 h-4 text-muted-foreground" />
      </div>

      <div className="space-y-1">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          You receive (via Stellar DEX)
        </label>
        <div className="flex gap-2 items-center">
          <div className="text-2xl font-mono h-12 flex items-center flex-1" data-testid="text-dex-quote">
            {quoting ? (
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            ) : (
              quote?.destinationAmount ?? "0.00"
            )}
          </div>
          <Select value={destCode} onValueChange={setDestCode}>
            <SelectTrigger className="w-28" data-testid="select-dex-dest-token">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DEX_DEST_TOKENS.map((t) => (
                <SelectItem key={t.code} value={t.code}>
                  {t.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {rate !== null && (
          <p className="text-xs text-muted-foreground">
            1 XLM ≈ {rate.toFixed(6)} {dest.code}
          </p>
        )}
        {quoteError && <p className="text-xs text-destructive">{quoteError}</p>}
      </div>

      <Button
        className="w-full h-11"
        onClick={handleSwap}
        disabled={submitting || !quote || !wallet.connected}
        data-testid="button-dex-swap"
      >
        {submitting ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : !wallet.connected ? (
          "Connect wallet to continue"
        ) : (
          `Swap XLM for ${dest.code}`
        )}
      </Button>
    </Card>
  );
}
