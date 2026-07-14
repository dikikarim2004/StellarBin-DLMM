/**
 * Classic-asset trustline helpers.
 *
 * TESTUSD is a classic-asset-backed Stellar Asset Contract (SAC) — any wallet
 * that has never held TESTUSD needs a classic `changeTrust` trustline before
 * it can receive/hold the asset. Without one, both the faucet payment and the
 * DLMM contract's internal token transfer for the TESTUSD leg fail with a
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

// Classic issuer of the TESTUSD SAC (same underlying asset as VITE_TOKEN_Y_ADDRESS,
// addressed here in its classic G... issuer form since trustlines are a classic-ledger concept).
export const TESTUSD_ISSUER =
  import.meta.env.VITE_TESTUSD_ISSUER ?? "GD3HFFCVSBBQSHHXJGJLSRCAFTGRT5XFHSGCC2U7BDKBFPQWZWITDWQ2";

export const TESTUSD_ASSET = new Asset(TOKEN_Y.symbol, TESTUSD_ISSUER);

function horizonServer(): Horizon.Server {
  return new Horizon.Server(HORIZON_URL);
}

/** Returns true if `address` already has a trustline (or is the issuer itself) for TESTUSD. */
export async function hasTestusdTrustline(address: string): Promise<boolean> {
  try {
    const server = horizonServer();
    const account = await server.loadAccount(address);
    if (address === TESTUSD_ISSUER) return true;
    return account.balances.some(
      (b) =>
        (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
        "asset_code" in b &&
        b.asset_code === TOKEN_Y.symbol &&
        "asset_issuer" in b &&
        b.asset_issuer === TESTUSD_ISSUER
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
    .addOperation(Operation.changeTrust({ asset: TESTUSD_ASSET }))
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
