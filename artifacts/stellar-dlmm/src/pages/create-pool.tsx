import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getListPoolsQueryKey } from "@workspace/api-client-react";
import { Horizon } from "@stellar/stellar-sdk";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  Loader2,
  Rocket,
  Layers,
  Info,
  ArrowLeft,
  ChevronsUpDown,
  Check,
} from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { WalletModal } from "@/components/wallet-modal";
import { useToast } from "@/hooks/use-toast";
import { TOKEN_X, TOKEN_Y } from "@/lib/contracts";
import {
  buildCreatePoolTransaction,
  decodeCreatedPoolId,
  submitSignedTransaction,
} from "@/lib/dlmm-client";
import { cn } from "@/lib/utils";

type PoolType = "standard" | "launch";

const HORIZON_URL = "https://horizon-testnet.stellar.org";

const BIN_STEP_PRESETS = [10, 25, 50, 100];
const BASE_FEE_PRESETS = [10, 30, 100];
const PLATFORM_FEE_BPS = 2000;
const LP_FEE_BPS = 10000 - PLATFORM_FEE_BPS;

interface KnownToken {
  symbol: string;
  address: string;
}

const KNOWN_TOKENS: KnownToken[] = [
  { symbol: TOKEN_X.symbol, address: TOKEN_X.address },
  { symbol: TOKEN_Y.symbol, address: TOKEN_Y.address },
];

function priceToActiveBinId(price: number, binStepBps: number): number {
  if (price <= 0 || binStepBps <= 0) return 0;
  return Math.round(Math.log(price) / Math.log(1 + binStepBps / 10_000));
}

function activeBinIdToPrice(binId: number, binStepBps: number): number {
  return Math.pow(1 + binStepBps / 10_000, binId);
}

/** Fetch classic Horizon balances for a wallet address. Returns map of SAC address → balance string. */
async function fetchWalletBalances(
  walletAddress: string
): Promise<Record<string, string>> {
  try {
    const server = new Horizon.Server(HORIZON_URL);
    const account = await server.loadAccount(walletAddress);
    const result: Record<string, string> = {};
    for (const b of account.balances) {
      if (b.asset_type === "native") {
        result[TOKEN_X.address] = `${Number(b.balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${TOKEN_X.symbol}`;
      } else if (
        (b.asset_type === "credit_alphanum4" ||
          b.asset_type === "credit_alphanum12") &&
        "asset_code" in b &&
        b.asset_code === TOKEN_Y.symbol
      ) {
        result[TOKEN_Y.address] = `${Number(b.balance).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${TOKEN_Y.symbol}`;
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Token Picker combobox
// ---------------------------------------------------------------------------

function TokenPicker({
  value,
  onChange,
  walletBalances,
  label,
  testId,
  disabledAddress,
}: {
  value: string;
  onChange: (address: string) => void;
  walletBalances: Record<string, string>;
  label: string;
  testId: string;
  disabledAddress?: string;
}) {
  const [open, setOpen] = useState(false);
  const [customInput, setCustomInput] = useState("");

  const selectedToken = KNOWN_TOKENS.find((t) => t.address === value);
  const isCustom = !selectedToken && value.length > 0;
  const displayLabel = selectedToken
    ? selectedToken.symbol
    : isCustom
    ? `Custom (${value.slice(0, 8)}…)`
    : "Select token";

  function handleSelectKnown(address: string) {
    setCustomInput("");
    onChange(address);
    setOpen(false);
  }

  function handleCustomChange(raw: string) {
    setCustomInput(raw);
    onChange(raw.trim());
  }

  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-normal h-10"
            data-testid={testId}
          >
            <span className="font-semibold tracking-wide">{displayLabel}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-0" align="start">
          <Command>
            <CommandInput placeholder="Search token…" />
            <CommandList>
              <CommandEmpty>No token found.</CommandEmpty>
              <CommandGroup heading="Available tokens">
                {KNOWN_TOKENS.map((token) => {
                  const isDisabled = token.address === disabledAddress;
                  const bal = walletBalances[token.address];
                  return (
                    <CommandItem
                      key={token.address}
                      value={token.symbol}
                      disabled={isDisabled}
                      onSelect={() => !isDisabled && handleSelectKnown(token.address)}
                      className={isDisabled ? "opacity-40 cursor-not-allowed" : ""}
                    >
                      <Check
                        className={cn(
                          "mr-2 h-4 w-4 shrink-0",
                          value === token.address ? "opacity-100" : "opacity-0"
                        )}
                      />
                      <span className="font-semibold">{token.symbol}</span>
                      {isDisabled && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          (already selected)
                        </span>
                      )}
                      {bal && !isDisabled && (
                        <span className="ml-auto text-xs text-muted-foreground">
                          {bal}
                        </span>
                      )}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>

          {/* Custom address input — always visible inside the popover */}
          <div className="border-t border-border p-3 space-y-1.5">
            <p className="text-xs text-muted-foreground font-medium">
              Or paste a custom contract address
            </p>
            <Input
              placeholder="C… SAC address"
              value={customInput}
              onChange={(e) => handleCustomChange(e.target.value)}
              className="font-mono text-xs h-8"
              data-testid={`${testId}-custom`}
              onKeyDown={(e) => {
                if (e.key === "Enter" && customInput.trim().length > 0) {
                  setOpen(false);
                }
              }}
            />
            {customInput.trim().length > 0 && (
              <Button
                size="sm"
                className="w-full h-7 text-xs"
                onClick={() => {
                  onChange(customInput.trim());
                  setOpen(false);
                }}
              >
                Use this address
              </Button>
            )}
          </div>
        </PopoverContent>
      </Popover>

      {value && (
        <p className="text-[10px] font-mono text-muted-foreground truncate">
          {value}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CreatePoolPage() {
  const [, setLocation] = useLocation();
  const wallet = useWallet();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [poolType, setPoolType] = useState<PoolType>("standard");
  const [tokenXAddress, setTokenXAddress] = useState(TOKEN_X.address);
  const [tokenYAddress, setTokenYAddress] = useState(TOKEN_Y.address);
  const [binStepBps, setBinStepBps] = useState(25);
  const [baseFeeBps, setBaseFeeBps] = useState(30);

  // Initial price (user-facing). Converted to bin ID internally.
  const [initialPrice, setInitialPrice] = useState("1.00");
  const [activationMinutes, setActivationMinutes] = useState("60");
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdPoolId, setCreatedPoolId] = useState<number | null>(null);
  const [walletBalances, setWalletBalances] = useState<Record<string, string>>({});

  // Compute bin ID from price each render
  const parsedPrice = Number.parseFloat(initialPrice);
  const activeBinId = Number.isFinite(parsedPrice) && parsedPrice > 0
    ? priceToActiveBinId(parsedPrice, binStepBps)
    : 0;
  // Round-trip: what price does this bin ID actually represent?
  const actualPrice = activeBinIdToPrice(activeBinId, binStepBps);

  const activationTs =
    poolType === "launch"
      ? Math.floor(Date.now() / 1000) +
        Math.max(1, Number.parseInt(activationMinutes, 10) || 0) * 60
      : 0;

  const canSubmit =
    tokenXAddress.trim().length > 0 &&
    tokenYAddress.trim().length > 0 &&
    tokenXAddress.trim() !== tokenYAddress.trim() &&
    binStepBps > 0 &&
    baseFeeBps > 0 &&
    Number.isFinite(parsedPrice) &&
    parsedPrice > 0 &&
    (poolType === "standard" ||
      Number.parseInt(activationMinutes, 10) > 0);

  // Fetch wallet balances whenever wallet connects
  useEffect(() => {
    if (wallet.connected && wallet.address) {
      fetchWalletBalances(wallet.address).then(setWalletBalances);
    } else {
      setWalletBalances({});
    }
  }, [wallet.connected, wallet.address]);

  async function handleCreate() {
    if (!wallet.connected || !wallet.address) {
      setWalletModalOpen(true);
      return;
    }
    setCreating(true);
    try {
      const prepared = await buildCreatePoolTransaction({
        creatorAddress: wallet.address,
        tokenX: tokenXAddress.trim(),
        tokenY: tokenYAddress.trim(),
        binStepBps,
        baseFeeBps,
        activeBinId,
        activationTs,
      });
      const signedXdr = await wallet.signTransaction(prepared.toXDR());
      const returnValue = await submitSignedTransaction(signedXdr);
      const newPoolId = decodeCreatedPoolId(returnValue);
      setCreatedPoolId(newPoolId);
      await queryClient.invalidateQueries({
        queryKey: getListPoolsQueryKey(),
      });
      toast({
        title: "Pool created",
        description: `${poolType === "launch" ? "DLMM Launch Pool" : "DLMM Standard Pool"} #${newPoolId} is live on-chain.`,
      });
    } catch (err) {
      toast({
        title: "Failed to create pool",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  }

  if (createdPoolId !== null) {
    return (
      <div className="max-w-lg mx-auto text-center space-y-5 py-12">
        <div className="w-14 h-14 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
          {poolType === "launch" ? (
            <Rocket className="w-6 h-6 text-primary" />
          ) : (
            <Layers className="w-6 h-6 text-primary" />
          )}
        </div>
        <div>
          <h1 className="text-xl font-bold">Pool created on-chain</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {poolType === "launch" ? "DLMM Launch Pool" : "DLMM Standard Pool"}{" "}
            #{createdPoolId} was created via a real{" "}
            <span className="font-mono">create_pool</span> transaction.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3">
          <Button
            variant="outline"
            onClick={() => {
              setCreatedPoolId(null);
              setInitialPrice("1.00");
            }}
          >
            Create another
          </Button>
          <Button
            onClick={() => setLocation(`/pools/dlmm-${createdPoolId}`)}
            data-testid="button-view-created-pool"
          >
            View pool
          </Button>
        </div>
      </div>
    );
  }

  const tokenXLabel =
    KNOWN_TOKENS.find((t) => t.address === tokenXAddress)?.symbol ?? "Token X";
  const tokenYLabel =
    KNOWN_TOKENS.find((t) => t.address === tokenYAddress)?.symbol ?? "Token Y";

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <button
          onClick={() => setLocation("/pools")}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Pools
        </button>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">
          Create Pool
        </h1>
        <p className="text-muted-foreground mt-1 text-sm sm:text-base">
          Permissionlessly deploy a new bin-based liquidity pool into the DLMM
          registry contract.
        </p>
      </div>

      {/* Pool type selector */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <PoolTypeCard
          active={poolType === "standard"}
          onClick={() => setPoolType("standard")}
          icon={Layers}
          title="DLMM Standard Pool"
          description="Active immediately. Anyone can swap and provide liquidity as soon as the pool is created."
          testId="button-pooltype-standard"
        />
        <PoolTypeCard
          active={poolType === "launch"}
          onClick={() => setPoolType("launch")}
          icon={Rocket}
          title="DLMM Launch Pool"
          description="Liquidity can be added right away, but swaps are gated until your chosen activation time (anti-snipe)."
          testId="button-pooltype-launch"
        />
      </div>

      <Card className="p-5 bg-card border-border space-y-5">
        {/* Token pickers */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <TokenPicker
            label="Base token (Token X)"
            value={tokenXAddress}
            onChange={setTokenXAddress}
            walletBalances={walletBalances}
            testId="input-token-x"
            disabledAddress={tokenYAddress}
          />
          <TokenPicker
            label="Quote token (Token Y)"
            value={tokenYAddress}
            onChange={setTokenYAddress}
            walletBalances={walletBalances}
            testId="input-token-y"
            disabledAddress={tokenXAddress}
          />
        </div>

        {/* Info: custom tokens */}
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-secondary/40 border border-border rounded-lg px-3 py-2">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Any token with a Stellar Asset Contract (SAC) address can be used —
            not just XLM and TESTUSD. To get a SAC address for a new token, run:{" "}
            <span className="font-mono text-foreground">
              stellar contract asset deploy --asset CODE:ISSUER --network testnet
            </span>
          </span>
        </div>

        {/* Bin step */}
        <div className="space-y-1.5">
          <Label>Bin step</Label>
          <div className="flex gap-2 flex-wrap">
            {BIN_STEP_PRESETS.map((bps) => (
              <PresetButton
                key={bps}
                active={binStepBps === bps}
                onClick={() => {
                  setBinStepBps(bps);
                  // Keep the same price; bin ID recomputes automatically
                }}
              >
                {(bps / 100).toFixed(2)}%
              </PresetButton>
            ))}
          </div>
        </div>

        {/* Base fee */}
        <div className="space-y-1.5">
          <Label>Base fee</Label>
          <div className="flex gap-2 flex-wrap">
            {BASE_FEE_PRESETS.map((bps) => (
              <PresetButton
                key={bps}
                active={baseFeeBps === bps}
                onClick={() => setBaseFeeBps(bps)}
              >
                {(bps / 100).toFixed(2)}%
              </PresetButton>
            ))}
          </div>
        </div>

        {/* Initial price + activation time */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="initial-price">
              Initial price ({tokenYLabel} per {tokenXLabel})
            </Label>
            <Input
              id="initial-price"
              type="number"
              min="0.000001"
              step="any"
              value={initialPrice}
              onChange={(e) => setInitialPrice(e.target.value)}
              placeholder="1.00"
              data-testid="input-active-bin"
            />
            <p className="text-[10px] text-muted-foreground">
              Bin ID:{" "}
              <span className="font-mono text-foreground">{activeBinId}</span>
              {"  ·  "}Actual price:{" "}
              <span className="font-mono text-foreground">
                {actualPrice.toPrecision(6)}
              </span>{" "}
              {tokenYLabel}/{tokenXLabel}
              {"  ·  "}Formula: (1 + binStep)^binId
            </p>
          </div>

          {poolType === "launch" && (
            <div className="space-y-1.5">
              <Label htmlFor="activation-minutes">
                Activate swaps in (minutes)
              </Label>
              <Input
                id="activation-minutes"
                type="number"
                min={1}
                value={activationMinutes}
                onChange={(e) => setActivationMinutes(e.target.value)}
                data-testid="input-activation-minutes"
              />
            </div>
          )}
        </div>
      </Card>

      {/* Pool Preview */}
      <Card className="p-5 bg-card border-border space-y-3">
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">
          Pool Preview
        </h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <PreviewStat
            label="Type"
            value={poolType === "launch" ? "Launch Pool" : "Standard Pool"}
          />
          <PreviewStat
            label="Bin step"
            value={`${(binStepBps / 100).toFixed(2)}%`}
          />
          <PreviewStat
            label="Base fee"
            value={`${(baseFeeBps / 100).toFixed(2)}%`}
          />
          <PreviewStat
            label="Initial price"
            value={
              Number.isFinite(parsedPrice) && parsedPrice > 0
                ? `${actualPrice.toPrecision(5)} ${tokenYLabel}/${tokenXLabel}`
                : "—"
            }
          />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <PreviewStat label="Pair" value={`${tokenXLabel} / ${tokenYLabel}`} />
          <PreviewStat
            label="Active bin ID"
            value={String(activeBinId)}
          />
          <PreviewStat
            label="Activation"
            value={
              poolType === "launch"
                ? `In ${activationMinutes || 0} min`
                : "Immediate"
            }
          />
          <PreviewStat label="LP / Protocol fee" value={`80% / 20%`} />
        </div>
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-secondary/40 border border-border rounded-lg px-3 py-2">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Every swap fee collected by this pool is split{" "}
            <span className="font-mono text-foreground">
              {LP_FEE_BPS / 100}% to LPs
            </span>{" "}
            /{" "}
            <span className="font-mono text-foreground">
              {PLATFORM_FEE_BPS / 100}% to the protocol treasury
            </span>
            , enforced on-chain by the DLMM contract's admin-adjustable fee
            split.
          </span>
        </div>
      </Card>

      <Button
        className="w-full h-11"
        disabled={!canSubmit || creating}
        onClick={handleCreate}
        data-testid="button-create-pool"
      >
        {creating ? (
          <>
            <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating pool
            on-chain…
          </>
        ) : !wallet.connected ? (
          "Connect wallet to create"
        ) : (
          `Create ${poolType === "launch" ? "Launch" : "Standard"} Pool`
        )}
      </Button>

      <WalletModal open={walletModalOpen} onOpenChange={setWalletModalOpen} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function PoolTypeCard({
  active,
  onClick,
  icon: Icon,
  title,
  description,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Layers;
  title: string;
  description: string;
  testId: string;
}) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`text-left p-4 rounded-xl border transition-colors ${
        active
          ? "border-primary bg-primary/5"
          : "border-border bg-card hover:bg-secondary/40"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Icon
          className={`w-4 h-4 ${active ? "text-primary" : "text-muted-foreground"}`}
        />
        <span className="font-bold text-sm">{title}</span>
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
    </button>
  );
}

function PresetButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-secondary/60 text-muted-foreground hover:text-foreground hover:bg-secondary"
      }`}
    >
      {children}
    </button>
  );
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">
        {label}
      </p>
      <p className="text-sm font-mono font-semibold mt-0.5">{value}</p>
    </div>
  );
}
