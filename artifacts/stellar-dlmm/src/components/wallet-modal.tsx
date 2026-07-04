/**
 * WalletModal — wallet selection dialog + connected state display
 *
 * Shows two connection options:
 *   • Freighter (browser extension)
 *   • Albedo (web-based non-custodial)
 *
 * When connected, shows address, XLM balance, token balances, and
 * a disconnect button.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Wallet, Copy, ExternalLink, LogOut, RefreshCw, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { useWallet, type WalletType } from "@/contexts/wallet";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Wallet option descriptors
// ---------------------------------------------------------------------------

const WALLETS: {
  id: WalletType;
  name: string;
  description: string;
  icon: string;
  installUrl?: string;
}[] = [
  {
    id: "freighter",
    name: "Freighter",
    description: "Browser extension — best for frequent traders",
    icon: "🚀",
    installUrl: "https://www.freighter.app/",
  },
  {
    id: "albedo",
    name: "Albedo",
    description: "Web wallet — no install required",
    icon: "🌐",
  },
];

// ---------------------------------------------------------------------------
// WalletModal
// ---------------------------------------------------------------------------

interface WalletModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function WalletModal({ open, onOpenChange }: WalletModalProps) {
  const wallet = useWallet();
  const { toast } = useToast();
  const [refreshing, setRefreshing] = useState(false);

  async function handleConnect(walletType: WalletType) {
    await wallet.connect(walletType);
    if (!wallet.error) {
      onOpenChange(false);
      toast({ title: "Wallet connected", description: wallet.shortAddress ?? "" });
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await wallet.refreshBalance();
    setRefreshing(false);
  }

  function handleCopy() {
    if (!wallet.address) return;
    navigator.clipboard.writeText(wallet.address).then(() => {
      toast({ title: "Address copied" });
    });
  }

  function handleDisconnect() {
    wallet.disconnect();
    onOpenChange(false);
    toast({ title: "Wallet disconnected" });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md bg-card border-border" data-testid="wallet-modal">
        {wallet.connected ? (
          <ConnectedView
            wallet={wallet}
            refreshing={refreshing}
            onCopy={handleCopy}
            onRefresh={handleRefresh}
            onDisconnect={handleDisconnect}
          />
        ) : (
          <SelectWalletView wallet={wallet} onConnect={handleConnect} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function ConnectedView({
  wallet,
  refreshing,
  onCopy,
  onRefresh,
  onDisconnect,
}: {
  wallet: ReturnType<typeof useWallet>;
  refreshing: boolean;
  onCopy: () => void;
  onRefresh: () => void;
  onDisconnect: () => void;
}) {
  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-400" />
          Wallet Connected
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4 mt-2">
        <div className="flex items-center justify-between bg-secondary/60 border border-border rounded-lg p-3">
          <div>
            <p className="text-xs text-muted-foreground mb-0.5 capitalize">{wallet.walletType}</p>
            <p className="font-mono text-sm font-medium">{wallet.shortAddress}</p>
          </div>
          <div className="flex gap-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onCopy} data-testid="button-copy-address">
              <Copy className="w-4 h-4" />
            </Button>
            <a
              href={`https://stellar.expert/explorer/testnet/account/${wallet.address}`}
              target="_blank"
              rel="noreferrer"
            >
              <Button variant="ghost" size="icon" className="h-8 w-8" data-testid="button-explorer-link">
                <ExternalLink className="w-4 h-4" />
              </Button>
            </a>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-sm font-medium">Balances</p>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onRefresh} data-testid="button-refresh-balance">
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} />
            </Button>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-md bg-secondary/40">
            <span className="text-sm font-medium">XLM</span>
            <span className="font-mono text-sm tabular-nums">{wallet.xlmBalance ?? "—"}</span>
          </div>
          {wallet.tokenBalances.map((t) => (
            <div key={t.asset} className="flex items-center justify-between px-3 py-2 rounded-md bg-secondary/40">
              <span className="text-sm font-medium">{t.asset}</span>
              <span className="font-mono text-sm tabular-nums">{parseFloat(t.balance).toFixed(4)}</span>
            </div>
          ))}
        </div>

        <Button
          variant="outline"
          className="w-full text-destructive hover:text-destructive"
          onClick={onDisconnect}
          data-testid="button-disconnect-wallet"
        >
          <LogOut className="w-4 h-4 mr-2" />
          Disconnect
        </Button>
      </div>
    </>
  );
}

function SelectWalletView({
  wallet,
  onConnect,
}: {
  wallet: ReturnType<typeof useWallet>;
  onConnect: (w: WalletType) => void;
}) {
  const [selected, setSelected] = useState<WalletType | null>(null);
  const freighterInstalled = wallet.isFreighterInstalled;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Wallet className="w-5 h-5" />
          Connect Wallet
        </DialogTitle>
        <p className="text-sm text-muted-foreground mt-1">
          Connect a Stellar wallet to swap, add liquidity, and manage positions.
        </p>
      </DialogHeader>

      {wallet.error && (
        <div className="flex items-start gap-2 bg-destructive/10 border border-destructive/30 text-destructive rounded-md p-3 text-sm mt-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{wallet.error}</span>
        </div>
      )}

      <div className="space-y-3 mt-2">
        {WALLETS.map((w) => {
          const isFreighter = w.id === "freighter";
          const notInstalled = isFreighter && !freighterInstalled;
          const isConnecting = wallet.connecting && selected === w.id;

          return (
            <button
              key={w.id}
              onClick={() => {
                setSelected(w.id);
                onConnect(w.id);
              }}
              disabled={wallet.connecting}
              className="w-full flex items-center gap-4 p-4 rounded-lg border border-border bg-secondary/40 hover:bg-secondary/70 hover:border-primary/40 transition-colors text-left disabled:opacity-60"
              data-testid={`button-connect-${w.id}`}
            >
              <span className="text-2xl">{w.icon}</span>
              <div className="flex-1 min-w-0">
                <p className="font-semibold flex items-center gap-2">{w.name}</p>
                <p className="text-xs text-muted-foreground truncate">{w.description}</p>
              </div>
              {isConnecting ? (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground shrink-0" />
              ) : isFreighter ? (
                <span
                  className={`text-xs px-2 py-1 rounded-full shrink-0 ${
                    freighterInstalled
                      ? "bg-green-500/15 text-green-400"
                      : "bg-secondary text-muted-foreground"
                  }`}
                >
                  {freighterInstalled ? "Detected" : "Not installed"}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground text-center pb-1">
        Connected to Stellar <span className="text-yellow-400 font-medium">Testnet</span>.
        Your private keys never leave your device.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Sidebar wallet button — standalone export for use in App.tsx sidebar
// ---------------------------------------------------------------------------

export function SidebarWalletButton({ onOpen }: { onOpen: () => void }) {
  const { connected, shortAddress, xlmBalance, connecting } = useWallet();

  if (connecting) {
    return (
      <button className="w-full flex items-center justify-center gap-2 bg-secondary text-secondary-foreground py-2.5 rounded-md font-medium transition-colors opacity-70">
        <Loader2 className="w-4 h-4 animate-spin" />
        Connecting…
      </button>
    );
  }

  if (connected) {
    return (
      <button
        onClick={onOpen}
        className="w-full flex flex-col items-start gap-0.5 bg-secondary/60 hover:bg-secondary border border-border px-3 py-2.5 rounded-md transition-colors"
        data-testid="button-wallet-connected"
      >
        <div className="flex items-center gap-2 w-full">
          <div className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
          <span className="font-mono text-sm font-medium truncate">{shortAddress}</span>
        </div>
        {xlmBalance !== null && (
          <span className="text-xs text-muted-foreground font-mono pl-4">
            {xlmBalance} XLM
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={onOpen}
      className="w-full flex items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90 py-2.5 rounded-md font-medium transition-colors"
      data-testid="button-connect-wallet"
    >
      <Wallet className="w-4 h-4" />
      Connect Wallet
    </button>
  );
}

// ---------------------------------------------------------------------------
// Header wallet button — compact pill for the top navbar (desktop + mobile)
// ---------------------------------------------------------------------------

export function HeaderWalletButton({ onOpen }: { onOpen: () => void }) {
  const { connected, shortAddress, xlmBalance, connecting } = useWallet();

  if (connecting) {
    return (
      <button
        className="flex items-center gap-2 bg-secondary text-secondary-foreground px-3 sm:px-4 h-9 rounded-full font-medium text-sm opacity-70"
        disabled
        data-testid="button-wallet-connecting"
      >
        <Loader2 className="w-4 h-4 animate-spin" />
        <span className="hidden sm:inline">Connecting…</span>
      </button>
    );
  }

  if (connected) {
    return (
      <button
        onClick={onOpen}
        className="flex items-center gap-2 bg-secondary/70 hover:bg-secondary border border-border px-3 sm:px-4 h-9 rounded-full transition-colors"
        data-testid="button-wallet-connected"
      >
        <div className="w-2 h-2 rounded-full bg-green-400 shrink-0" />
        <span className="font-mono text-xs sm:text-sm font-medium">{shortAddress}</span>
        {xlmBalance !== null && (
          <span className="hidden sm:inline text-xs text-muted-foreground font-mono border-l border-border pl-2 ml-0.5">
            {xlmBalance} XLM
          </span>
        )}
      </button>
    );
  }

  return (
    <button
      onClick={onOpen}
      className="flex items-center gap-1.5 sm:gap-2 bg-primary text-primary-foreground hover:bg-primary/90 px-3 sm:px-4 h-9 rounded-full font-semibold text-sm transition-colors whitespace-nowrap"
      data-testid="button-connect-wallet"
    >
      <Wallet className="w-4 h-4" />
      <span>Connect</span>
    </button>
  );
}
