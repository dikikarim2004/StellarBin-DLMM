import { useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { getListPoolsQueryKey } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Rocket, Layers, Info, ArrowLeft } from "lucide-react";
import { useWallet } from "@/contexts/wallet";
import { WalletModal } from "@/components/wallet-modal";
import { useToast } from "@/hooks/use-toast";
import { TOKEN_X, TOKEN_Y } from "@/lib/contracts";
import { buildCreatePoolTransaction, decodeCreatedPoolId, submitSignedTransaction } from "@/lib/dlmm-client";

type PoolType = "standard" | "launch";

const BIN_STEP_PRESETS = [10, 25, 50, 100];
const BASE_FEE_PRESETS = [10, 30, 100];
const PLATFORM_FEE_BPS = 2000; // 20% of every fee is routed to the protocol treasury
const LP_FEE_BPS = 10000 - PLATFORM_FEE_BPS;

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
  const [activeBinId, setActiveBinId] = useState("0");
  const [activationMinutes, setActivationMinutes] = useState("60");
  const [walletModalOpen, setWalletModalOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdPoolId, setCreatedPoolId] = useState<number | null>(null);

  const activeBinIdNum = Number.parseInt(activeBinId, 10) || 0;
  const activationTs =
    poolType === "launch"
      ? Math.floor(Date.now() / 1000) + Math.max(1, Number.parseInt(activationMinutes, 10) || 0) * 60
      : 0;

  const canSubmit =
    tokenXAddress.trim().length > 0 &&
    tokenYAddress.trim().length > 0 &&
    tokenXAddress.trim() !== tokenYAddress.trim() &&
    binStepBps > 0 &&
    baseFeeBps > 0 &&
    (poolType === "standard" || Number.parseInt(activationMinutes, 10) > 0);

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
        activeBinId: activeBinIdNum,
        activationTs,
      });
      const signedXdr = await wallet.signTransaction(prepared.toXDR());
      const returnValue = await submitSignedTransaction(signedXdr);
      const newPoolId = decodeCreatedPoolId(returnValue);
      setCreatedPoolId(newPoolId);
      await queryClient.invalidateQueries({ queryKey: getListPoolsQueryKey() });
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
          {poolType === "launch" ? <Rocket className="w-6 h-6 text-primary" /> : <Layers className="w-6 h-6 text-primary" />}
        </div>
        <div>
          <h1 className="text-xl font-bold">Pool created on-chain</h1>
          <p className="text-sm text-muted-foreground mt-1">
            {poolType === "launch" ? "DLMM Launch Pool" : "DLMM Standard Pool"} #{createdPoolId} was created via a real{" "}
            <span className="font-mono">create_pool</span> transaction.
          </p>
        </div>
        <div className="flex items-center justify-center gap-3">
          <Button variant="outline" onClick={() => { setCreatedPoolId(null); setActiveBinId("0"); }}>
            Create another
          </Button>
          <Button onClick={() => setLocation(`/pools/dlmm-${createdPoolId}`)} data-testid="button-view-created-pool">
            View pool
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <button
          onClick={() => setLocation("/pools")}
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground mb-3"
        >
          <ArrowLeft className="w-4 h-4 mr-2" /> Back to Pools
        </button>
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Create Pool</h1>
        <p className="text-muted-foreground mt-1 text-sm sm:text-base">
          Permissionlessly deploy a new bin-based liquidity pool into the DLMM registry contract.
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
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="token-x">Base token (Token X) address</Label>
            <Input
              id="token-x"
              value={tokenXAddress}
              onChange={(e) => setTokenXAddress(e.target.value)}
              className="font-mono text-xs"
              data-testid="input-token-x"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="token-y">Quote token (Token Y) address</Label>
            <Input
              id="token-y"
              value={tokenYAddress}
              onChange={(e) => setTokenYAddress(e.target.value)}
              className="font-mono text-xs"
              data-testid="input-token-y"
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Bin step</Label>
          <div className="flex gap-2 flex-wrap">
            {BIN_STEP_PRESETS.map((bps) => (
              <PresetButton key={bps} active={binStepBps === bps} onClick={() => setBinStepBps(bps)}>
                {(bps / 100).toFixed(2)}%
              </PresetButton>
            ))}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label>Base fee</Label>
          <div className="flex gap-2 flex-wrap">
            {BASE_FEE_PRESETS.map((bps) => (
              <PresetButton key={bps} active={baseFeeBps === bps} onClick={() => setBaseFeeBps(bps)}>
                {(bps / 100).toFixed(2)}%
              </PresetButton>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="active-bin">Initial active bin id</Label>
            <Input
              id="active-bin"
              type="number"
              value={activeBinId}
              onChange={(e) => setActiveBinId(e.target.value)}
              data-testid="input-active-bin"
            />
          </div>
          {poolType === "launch" && (
            <div className="space-y-1.5">
              <Label htmlFor="activation-minutes">Activate swaps in (minutes)</Label>
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
        <h2 className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Pool Preview</h2>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <PreviewStat label="Type" value={poolType === "launch" ? "Launch Pool" : "Standard Pool"} />
          <PreviewStat label="Bin step" value={`${(binStepBps / 100).toFixed(2)}%`} />
          <PreviewStat label="Base fee" value={`${(baseFeeBps / 100).toFixed(2)}%`} />
          <PreviewStat
            label="Activation"
            value={poolType === "launch" ? `In ${activationMinutes || 0} min` : "Immediate"}
          />
        </div>
        <div className="flex items-start gap-2 text-xs text-muted-foreground bg-secondary/40 border border-border rounded-lg px-3 py-2">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Every swap fee collected by this pool is split{" "}
            <span className="font-mono text-foreground">{LP_FEE_BPS / 100}% to LPs</span> /{" "}
            <span className="font-mono text-foreground">{PLATFORM_FEE_BPS / 100}% to the protocol treasury</span>,
            enforced on-chain by the DLMM contract's admin-adjustable fee split.
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
            <Loader2 className="w-4 h-4 mr-2 animate-spin" /> Creating pool on-chain...
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
        active ? "border-primary bg-primary/5" : "border-border bg-card hover:bg-secondary/40"
      }`}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <Icon className={`w-4 h-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
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
      <p className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-sm font-mono font-semibold mt-0.5">{value}</p>
    </div>
  );
}
