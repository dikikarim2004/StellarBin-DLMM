// Stellar native DEX swap panel: pick a destination token, auto-quote, then swap.
import { useEffect, useRef, useState } from "react";
import { Asset, Horizon } from "@stellar/stellar-sdk";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { ArrowDown, Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { useToast } from "@/hooks/use-toast";
import { USDC_ISSUER } from "@/lib/trustline";
import { STELLAR_NETWORK } from "@/lib/contracts";
import { listPools } from "@workspace/api-client-react";
import { getClassicAssetContractId } from "@/lib/classic-asset";
import {
  getDexQuote,
  buildDexSwapTransaction,
  submitDexTransaction,
  xlmAsset,
  type DexQuote,
} from "@/lib/sdex";

interface DexDestinationToken {
  code: string;
  issuer: string;
  sacAddress?: string;
}

const HORIZON_URL =
  STELLAR_NETWORK === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";
const DEFAULT_DEST_TOKENS: DexDestinationToken[] = [
  { code: "USDC", issuer: USDC_ISSUER },
];

function tokenKey(token: DexDestinationToken): string {
  return `${token.code}:${token.issuer}`;
}

function mergeDestinationTokens(tokens: DexDestinationToken[]): DexDestinationToken[] {
  const uniqueTokens = new Map<string, DexDestinationToken>();
  for (const token of tokens) {
    const key = tokenKey(token);
    const current = uniqueTokens.get(key);
    if (!current || (!current.sacAddress && token.sacAddress)) {
      uniqueTokens.set(key, token);
    }
  }
  return [...uniqueTokens.values()];
}

export function DexSwapPanel() {
  const wallet = useWallet();
  const { toast } = useToast();
  const [amountIn, setAmountIn] = useState("");
  const [dest, setDest] = useState(DEFAULT_DEST_TOKENS[0]);
  const [destPickerOpen, setDestPickerOpen] = useState(false);
  const [destSearch, setDestSearch] = useState("");
  const [destResults, setDestResults] = useState<DexDestinationToken[]>([]);
  const [destSearching, setDestSearching] = useState(false);
  const [destSearchError, setDestSearchError] = useState<string | null>(null);
  const [quote, setQuote] = useState<DexQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const query = destSearch.trim();
    setDestResults([]);
    setDestSearchError(null);
    if (query.length < 2) {
      setDestSearching(false);
      return;
    }

    let cancelled = false;
    setDestSearching(true);
    const timer = setTimeout(async () => {
      try {
        const server = new Horizon.Server(HORIZON_URL);
        const [response, pools] = await Promise.all([
          server.assets().forCode(query.toUpperCase()).limit(200).call(),
          listPools(),
        ]);
        if (cancelled) return;
        const found = response.records
          .filter((record) => record.asset_issuer && record.asset_code)
          .map((record) => ({
            code: record.asset_code,
            issuer: record.asset_issuer,
            sacAddress: pools
              .flatMap((pool) => [pool.tokenX, pool.tokenY])
              .find(
                (token) =>
                  token.symbol.toUpperCase() === record.asset_code.toUpperCase() &&
                  token.address ===
                    getClassicAssetContractId(record.asset_code, record.asset_issuer)
              )?.address,
          }));
        setDestResults(
          found.sort((first, second) => Number(!!second.sacAddress) - Number(!!first.sacAddress))
        );
      } catch (error) {
        if (!cancelled) {
          setDestSearchError(
            error instanceof Error ? error.message : "Unable to search Stellar DEX assets."
          );
        }
      } finally {
        if (!cancelled) setDestSearching(false);
      }
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [destSearch]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setQuoting(false);
    setQuote(null);
    setQuoteError(null);
    const amt = amountIn.trim();
    if (!amt || Number(amt) <= 0) return;
    let cancelled = false;
    debounceRef.current = setTimeout(async () => {
      setQuoting(true);
      try {
        const q = await getDexQuote(xlmAsset(), amt, new Asset(dest.code, dest.issuer));
        if (cancelled) return;
        if (!q) {
          setQuoteError("No path found on Stellar DEX");
        } else {
          setQuote(q);
        }
      } catch (e) {
        if (cancelled) return;
        setQuoteError(e instanceof Error ? e.message : "Quote failed");
      } finally {
        if (!cancelled) setQuoting(false);
      }
    }, 500);
    return () => {
      cancelled = true;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [amountIn, dest.code, dest.issuer]);

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
        new Asset(dest.code, dest.issuer),
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
          <Popover open={destPickerOpen} onOpenChange={setDestPickerOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                role="combobox"
                aria-expanded={destPickerOpen}
                className="w-28 justify-between"
                data-testid="select-dex-dest-token"
              >
                <span className="truncate">{dest.code}</span>
                <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80 p-0">
              <Command shouldFilter={false}>
                <CommandInput
                  placeholder="Search Stellar DEX ticker…"
                  onValueChange={setDestSearch}
                />
                <CommandList>
                  {destSearch.trim().length < 2 && (
                    <div className="px-3 py-2 text-xs text-muted-foreground">
                      Enter at least 2 characters to search.
                    </div>
                  )}
                  {destSearching && (
                    <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Searching Stellar DEX…
                    </div>
                  )}
                  {destSearchError && (
                    <div className="px-3 py-2 text-xs text-destructive">{destSearchError}</div>
                  )}
                  {destSearch.trim().length >= 2 &&
                    !destSearching &&
                    !destSearchError &&
                    destResults.length === 0 && (
                      <div className="px-3 py-2 text-xs text-muted-foreground">
                        No assets found.
                      </div>
                    )}
                  <CommandGroup heading="Stellar DEX assets">
                    {mergeDestinationTokens([...DEFAULT_DEST_TOKENS, dest, ...destResults])
                      .map((token) => (
                        <CommandItem
                          key={tokenKey(token)}
                          value={`${token.code} ${token.issuer} ${token.sacAddress ?? ""}`}
                          onSelect={() => {
                            setDest(token);
                            setDestSearch("");
                            setDestPickerOpen(false);
                          }}
                        >
                          <Check
                            className={`mr-2 h-4 w-4 ${
                              tokenKey(dest) === tokenKey(token) ? "opacity-100" : "opacity-0"
                            }`}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-2">
                              <span className="font-mono text-xs">{token.code}</span>
                              <span className="text-[10px] text-muted-foreground">
                                {token.issuer.slice(0, 4)}…{token.issuer.slice(-4)}
                              </span>
                            </span>
                            {token.sacAddress && (
                              <span className="mt-0.5 block break-all font-mono text-[9px] leading-3 text-muted-foreground">
                                SAC: {token.sacAddress}
                              </span>
                            )}
                          </span>
                        </CommandItem>
                      ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
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
