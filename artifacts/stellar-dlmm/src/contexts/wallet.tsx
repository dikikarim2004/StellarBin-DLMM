/**
 * WalletContext — Stellar wallet connection layer
 *
 * Wallets supported:
 *  1. Freighter  — browser extension via @stellar/freighter-api (official SDK)
 *  2. Albedo     — web popup wallet via @albedo-link/intent (official SDK)
 *
 * Balances fetched from Stellar Horizon Testnet REST API (no extra packages).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  getAddress,
  isConnected as freighterIsConnected,
  requestAccess,
  signTransaction as freighterSignTransaction,
} from "@stellar/freighter-api";
import albedo from "@albedo-link/intent";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WalletType = "freighter" | "albedo";

export interface TokenBalance {
  asset: string;
  balance: string;
}

export interface WalletState {
  connected: boolean;
  connecting: boolean;
  address: string | null;
  shortAddress: string | null;
  walletType: WalletType | null;
  xlmBalance: string | null;
  tokenBalances: TokenBalance[];
  network: "testnet" | "mainnet";
  error: string | null;
}

export interface WalletContextValue extends WalletState {
  connect: (wallet: WalletType) => Promise<void>;
  disconnect: () => void;
  signTransaction: (xdr: string) => Promise<string>;
  refreshBalance: () => Promise<void>;
  isFreighterInstalled: boolean;
}

// ---------------------------------------------------------------------------
// Horizon balance fetch
// ---------------------------------------------------------------------------

const HORIZON = {
  testnet: "https://horizon-testnet.stellar.org",
  mainnet: "https://horizon.stellar.org",
};

async function fetchBalances(
  address: string,
  network: "testnet" | "mainnet"
): Promise<{ xlm: string; tokens: TokenBalance[] }> {
  try {
    const resp = await fetch(`${HORIZON[network]}/accounts/${address}`);
    if (!resp.ok) return { xlm: "0.0000", tokens: [] };
    const data = await resp.json();
    const balances: Array<{
      asset_type: string;
      asset_code?: string;
      balance: string;
    }> = data.balances ?? [];
    const native = balances.find((b) => b.asset_type === "native");
    const xlm = native ? parseFloat(native.balance).toFixed(4) : "0.0000";
    const tokens: TokenBalance[] = balances
      .filter((b) => b.asset_type !== "native")
      .map((b) => ({ asset: b.asset_code ?? "UNKNOWN", balance: b.balance }));
    return { xlm, tokens };
  } catch {
    return { xlm: "—", tokens: [] };
  }
}

function shorten(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const WalletContext = createContext<WalletContextValue | null>(null);

const STORAGE_KEY = "stellar_dlmm_wallet";

interface PersistedWallet {
  address: string;
  walletType: WalletType;
}

const NETWORK_PASSPHRASE = {
  testnet: "Test SDF Network ; September 2015",
  mainnet: "Public Global Stellar Network ; September 2015",
};

export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletState>({
    connected: false,
    connecting: false,
    address: null,
    shortAddress: null,
    walletType: null,
    xlmBalance: null,
    tokenBalances: [],
    network: "testnet",
    error: null,
  });
  const [isFreighterInstalled, setIsFreighterInstalled] = useState(false);

  // Detect Freighter on mount
  useEffect(() => {
    freighterIsConnected().then((res) => {
      setIsFreighterInstalled(res.isConnected);
    });
  }, []);

  const applyConnected = useCallback(
    async (address: string, walletType: WalletType) => {
      const network: "testnet" = "testnet"; // always testnet for now
      const { xlm, tokens } = await fetchBalances(address, network);
      setState((s) => ({
        ...s,
        connected: true,
        connecting: false,
        address,
        shortAddress: shorten(address),
        walletType,
        xlmBalance: xlm,
        tokenBalances: tokens,
        network,
        error: null,
      }));
      try {
        localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ address, walletType } satisfies PersistedWallet)
        );
      } catch {}
    },
    []
  );

  // Restore session on mount
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const { address, walletType } = JSON.parse(raw) as PersistedWallet;
      if (!address || !walletType) return;

      if (walletType === "freighter") {
        // Re-verify Freighter still has permission before restoring.
        getAddress().then((res) => {
          if (res.address && !res.error) {
            applyConnected(res.address, "freighter");
          }
        });
      } else {
        // Albedo: restore from storage (no re-verification needed).
        applyConnected(address, walletType);
      }
    } catch {}
  }, [applyConnected]);

  const connect = useCallback(
    async (walletType: WalletType) => {
      setState((s) => ({ ...s, connecting: true, error: null }));
      try {
        let address: string;

        if (walletType === "freighter") {
          // requestAccess shows the Freighter permission dialog if needed.
          const res = await requestAccess();
          if (res.error) {
            throw new Error(
              typeof res.error === "string" ? res.error : "Freighter: access denied"
            );
          }
          if (!res.address) {
            throw new Error("Freighter: no address returned. Make sure the extension is unlocked.");
          }
          address = res.address;
        } else {
          // Albedo opens its confirmation popup at albedo.link/confirm
          const res = await albedo.publicKey({});
          address = res.pubkey;
        }

        await applyConnected(address, walletType);
      } catch (err: unknown) {
        const msg =
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "message" in err
            ? String((err as { message: unknown }).message)
            : "Connection failed";
        setState((s) => ({
          ...s,
          connecting: false,
          error: msg,
        }));
      }
    },
    [applyConnected]
  );

  const disconnect = useCallback(() => {
    setState({
      connected: false,
      connecting: false,
      address: null,
      shortAddress: null,
      walletType: null,
      xlmBalance: null,
      tokenBalances: [],
      network: "testnet",
      error: null,
    });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {}
  }, []);

  const signTransaction = useCallback(
    async (xdr: string): Promise<string> => {
      const { address, walletType, network } = state;
      if (!address || !walletType) throw new Error("Wallet not connected");

      if (walletType === "freighter") {
        const res = await freighterSignTransaction(xdr, {
          networkPassphrase: NETWORK_PASSPHRASE[network],
          address,
        });
        if (res.error) {
          throw new Error(
            typeof res.error === "string" ? res.error : "Freighter: signing failed"
          );
        }
        return res.signedTxXdr;
      } else {
        const res = await albedo.tx({
          xdr,
          network: network === "testnet" ? "testnet" : "public",
          pubkey: address,
          description: "StellarBin transaction",
        });
        return res.signed_envelope_xdr;
      }
    },
    [state]
  );

  const refreshBalance = useCallback(async () => {
    if (!state.address) return;
    const { xlm, tokens } = await fetchBalances(state.address, state.network);
    setState((s) => ({ ...s, xlmBalance: xlm, tokenBalances: tokens }));
  }, [state.address, state.network]);

  return (
    <WalletContext.Provider
      value={{
        ...state,
        connect,
        disconnect,
        signTransaction,
        refreshBalance,
        isFreighterInstalled,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used inside WalletProvider");
  return ctx;
}
