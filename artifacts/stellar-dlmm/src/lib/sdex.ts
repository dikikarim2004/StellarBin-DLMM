// Minimal Stellar native DEX (SDEX) integration via Horizon strict-send paths.
// Lets users acquire USDC (or other classic assets) with XLM before depositing
// single-sided into a DLMM pool.
import {
  Asset,
  TransactionBuilder,
  Operation,
  Horizon,
  Memo,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { STELLAR_NETWORK } from "@/lib/contracts";
import { NETWORK_CONFIG } from "@/lib/stellar";

const HORIZON_URL =
  STELLAR_NETWORK === "mainnet"
    ? "https://horizon.stellar.org"
    : "https://horizon-testnet.stellar.org";

export interface DexQuote {
  destinationAmount: string;
  path: Array<{ asset_code?: string; asset_issuer?: string; asset_type: string }>;
}

export function xlmAsset(): Asset {
  return Asset.native();
}

export function usdcAsset(issuer: string): Asset {
  return new Asset("USDC", issuer);
}

/** Quote a strict-send path on the SDEX. Returns null if no path found. */
export async function getDexQuote(
  sourceAsset: Asset,
  sourceAmount: string,
  destinationAsset: Asset
): Promise<DexQuote | null> {
  const server = new Horizon.Server(HORIZON_URL);
  let call = server.strictSendPaths(sourceAsset, sourceAmount, [destinationAsset]);
  const res = await call.call();
  const best = res.records[0];
  if (!best) return null;
  return {
    destinationAmount: best.destination_amount,
    path: best.path as DexQuote["path"],
  };
}

/** Build a pathPaymentStrictSend transaction ready for wallet signing. */
export async function buildDexSwapTransaction(
  sourceAddress: string,
  sendAsset: Asset,
  sendAmount: string,
  destAsset: Asset,
  destMin: string,
  path: DexQuote["path"]
): Promise<string> {
  const server = new Horizon.Server(HORIZON_URL);
  const account = await server.loadAccount(sourceAddress);
  const pathAssets = path.map((p) =>
    p.asset_type === "native"
      ? Asset.native()
      : new Asset(p.asset_code!, p.asset_issuer!)
  );
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset,
        sendAmount,
        destination: sourceAddress,
        destAsset,
        destMin,
        path: pathAssets,
      })
    )
    .addMemo(Memo.none())
    .setTimeout(60)
    .build();
  return tx.toXDR();
}

/** Submit a wallet-signed classic transaction XDR to the network. */
export async function submitDexTransaction(signedXdr: string): Promise<string> {
  const server = new Horizon.Server(HORIZON_URL);
  const tx = TransactionBuilder.fromXDR(
    signedXdr,
    NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase
  );
  const res = await server.submitTransaction(tx);
  return res.hash;
}
