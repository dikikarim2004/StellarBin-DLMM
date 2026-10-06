/**
 * Deployed contract / network configuration, read from Vite env vars.
 *
 * All values here point at REAL contracts deployed to Stellar testnet.
 * See ../../.env for the actual addresses.
 */

import type { NetworkId } from "./stellar";

function requireEnv(key: string): string {
  const val = import.meta.env[key];
  if (!val) {
    throw new Error(`Missing required env var: ${key}. Check artifacts/stellar-dlmm/.env`);
  }
  return val;
}

export const STELLAR_NETWORK = (import.meta.env.VITE_STELLAR_NETWORK ?? "testnet") as NetworkId;

export const LEGACY_DLMM_CONTRACT_ID = requireEnv("VITE_DLMM_CONTRACT_ID");
export const DLMM_V2_CONTRACT_ID = import.meta.env.VITE_DLMM_V2_CONTRACT_ID as string | undefined;
export const DLMM_CONTRACT_ID = DLMM_V2_CONTRACT_ID || LEGACY_DLMM_CONTRACT_ID;
export const VAULT_CONTRACT_ID = requireEnv("VITE_VAULT_CONTRACT_ID");
export const MATH_CONTRACT_ID = requireEnv("VITE_MATH_CONTRACT_ID");

/** The default XLM/USDC pool_id in the active DLMM registry. */
export const DEFAULT_POOL_ID = Number(import.meta.env.VITE_DEFAULT_POOL_ID ?? "0");

export const TOKEN_X = {
  address: requireEnv("VITE_TOKEN_X_ADDRESS"),
  symbol: import.meta.env.VITE_TOKEN_X_SYMBOL ?? "XLM",
};

export const TOKEN_Y = {
  address: requireEnv("VITE_TOKEN_Y_ADDRESS"),
  symbol: import.meta.env.VITE_TOKEN_Y_SYMBOL ?? "USDC",
};

export const DEMO_POOL_TOKENS = [TOKEN_X, TOKEN_Y];
