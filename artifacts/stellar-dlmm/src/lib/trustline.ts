/**
 * Classic-asset trustline helpers.
 *
 * USDC is a classic-asset-backed Stellar Asset Contract (SAC) — any wallet
 * that has never held USDC needs a classic `changeTrust` trustline before
 * it can receive/hold the asset. Without one, both the faucet payment and the
 * DLMM contract's internal token transfer for the USDC leg fail with a
 * "trustline" HostError. These helpers detect and fix that up front.
 */

import {
  Asset,
  Horizon,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { TOKEN_Y } from "./contracts";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

// Classic issuer of the USDC SAC; trustlines use the issuer's G... address.
export const USDC_ISSUER =
  import.meta.env.VITE_USDC_ISSUER ?? "GABZWK2YLPOGBEOZT6VOCID6ROSSZGPSLAEPCTWIBGAJDHISO6DFKYYZ";

export const USDC_ASSET = new Asset(TOKEN_Y.symbol, USDC_ISSUER);

function horizonServer(): Horizon.Server {
  return new Horizon.Server(HORIZON_URL);
}

export async function getUsdcBalance(address: string): Promise<string> {
  const account = await horizonServer().loadAccount(address);
  const balance = account.balances.find(
    (item) =>
      (item.asset_type === "credit_alphanum4" || item.asset_type === "credit_alphanum12") &&
      "asset_code" in item &&
      item.asset_code === TOKEN_Y.symbol &&
      "asset_issuer" in item &&
      item.asset_issuer === USDC_ISSUER
  );
  return balance && "balance" in balance ? balance.balance : "0";
}

/** Returns true if `address` already has a trustline (or is the issuer itself) for USDC. */
export async function hasUsdcTrustline(address: string): Promise<boolean> {
  try {
    const server = horizonServer();
    const account = await server.loadAccount(address);
    if (address === USDC_ISSUER) return true;
    return account.balances.some(
      (b) =>
        (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
        "asset_code" in b &&
        b.asset_code === TOKEN_Y.symbol &&
        "asset_issuer" in b &&
        b.asset_issuer === USDC_ISSUER
    );
  } catch {
    // Account not found / network hiccup — treat as "no trustline" so the UI
    // offers to establish one rather than silently failing later.
    return false;
  }
}

/** Builds an unsigned classic `changeTrust` transaction for the connected wallet to sign. */
export async function buildEstablishTrustlineTransaction(address: string) {
  const server = horizonServer();
  const account = await server.loadAccount(address);

  return new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: USDC_ASSET }))
    .setTimeout(30)
    .build();
}

/** Submits a wallet-signed classic transaction XDR (e.g. changeTrust) via Horizon. */
export async function submitSignedClassicTransaction(signedXdr: string): Promise<string> {
  const server = horizonServer();
  const tx = TransactionBuilder.fromXDR(signedXdr, NETWORK_PASSPHRASE);
  const result = await server.submitTransaction(tx);
  return result.hash;
}
