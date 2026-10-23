import { Asset, Networks } from "@stellar/stellar-sdk";
import { STELLAR_NETWORK } from "@/lib/contracts";

export function getClassicAssetContractId(code: string, issuer: string): string {
  return new Asset(code, issuer).contractId(
    STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET
  );
}
