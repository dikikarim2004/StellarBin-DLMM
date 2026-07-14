/**
 * Real on-chain client for the deployed DLMM Soroban contract.
 *
 * The contract hosts a MULTI-POOL registry: every function below takes a
 * `poolId` (the numeric pool_id returned by `create_pool` / `list_pools`)
 * so the same contract instance serves every pool ever created — Standard
 * Pools and Launch Pools alike.
 *
 * Quotes are obtained via read-only simulation (no wallet required).
 * Mutating calls are built, simulated+assembled with `prepareTransaction`,
 * signed by the connected wallet (Freighter/Albedo), and submitted to the
 * network — no mocked data anywhere in this path.
 */

import {
  Address,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import {
  createRpcServer,
  addressToScVal,
  i32ToScVal,
  i128ToScVal,
  u64ToScVal,
  boolToScVal,
  NETWORK_CONFIG,
  decodeSwapResult,
  type SwapResultDecoded,
} from "./stellar";
import { DLMM_CONTRACT_ID, STELLAR_NETWORK, DEFAULT_POOL_ID } from "./contracts";

// A funded, publicly-known testnet account used only to satisfy Soroban's
// requirement for a transaction source account when simulating read-only
// calls (e.g. quotes) before a wallet is connected. No funds move and no
// signature is required for read-only invocations.
const QUOTE_SOURCE_ACCOUNT =
  import.meta.env.VITE_QUOTE_SOURCE_ACCOUNT ??
  "GD3HFFCVSBBQSHHXJGJLSRCAFTGRT5XFHSGCC2U7BDKBFPQWZWITDWQ2";

export interface SwapQuote {
  amountOut: bigint;
  feePaid: bigint;
  binsCrossed: number;
  finalBin: number;
}

/**
 * Read-only quote via `simulate_swap` — a real contract call against live
 * on-chain bin reserves, not a client-side estimate.
 */
export async function getOnChainSwapQuote(
  xToY: boolean,
  amountIn: bigint,
  poolId: number = DEFAULT_POOL_ID
): Promise<SwapQuote> {
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(QUOTE_SOURCE_ACCOUNT);
  const contract = new Contract(DLMM_CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(
      contract.call(
        "simulate_swap",
        u64ToScVal(poolId),
        boolToScVal(xToY),
        i128ToScVal(amountIn)
      )
    )
    .setTimeout(30)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Quote simulation failed: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error("Quote simulation returned no result");
  }

  const decoded = decodeSwapResult(sim.result.retval);
  return decoded;
}

/**
 * Builds, prepares (simulate + assemble footprint/auth), and returns an
 * unsigned transaction for `swap_exact_in_bin`. Caller must sign via wallet
 * and submit with `submitSignedSwap`.
 */
export async function buildSwapTransaction(
  callerAddress: string,
  xToY: boolean,
  amountIn: bigint,
  minAmountOut: bigint,
  poolId: number = DEFAULT_POOL_ID
) {
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(callerAddress);
  const contract = new Contract(DLMM_CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(
      contract.call(
        "swap_exact_in_bin",
        u64ToScVal(poolId),
        addressToScVal(callerAddress),
        boolToScVal(xToY),
        i128ToScVal(amountIn),
        i128ToScVal(minAmountOut)
      )
    )
    .setTimeout(60)
    .build();

  const prepared = await rpcServer.prepareTransaction(tx);
  return prepared;
}

/**
 * Submits a wallet-signed transaction XDR and polls until it lands
 * (SUCCESS/FAILED), returning the decoded SwapResult on success.
 */
export async function submitSignedSwap(signedXdr: string): Promise<SwapResultDecoded> {
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const networkPassphrase = NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase;
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

  const sendResult = await rpcServer.sendTransaction(tx);
  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction rejected: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const hash = sendResult.hash;
  let getResult = await rpcServer.getTransaction(hash);
  const start = Date.now();
  while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    if (Date.now() - start > 30_000) {
      throw new Error(`Timed out waiting for transaction ${hash} to confirm`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    getResult = await rpcServer.getTransaction(hash);
  }

  if (getResult.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction failed: ${JSON.stringify(getResult)}`);
  }

  if (!getResult.returnValue) {
    throw new Error("Transaction succeeded but returned no value");
  }

  return decodeSwapResult(getResult.returnValue);
}

export function toAddressScVal(address: string) {
  return Address.fromString(address).toScVal();
}

export function decodeI128(val: unknown): bigint {
  return scValToNative(val as any) as bigint;
}

/** Builds a prepared (simulated + assembled) `add_liquidity_bin` transaction. */
export async function buildAddLiquidityTransaction(
  callerAddress: string,
  binId: number,
  amountX: bigint,
  amountY: bigint,
  poolId: number = DEFAULT_POOL_ID
) {
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(callerAddress);
  const contract = new Contract(DLMM_CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(
      contract.call(
        "add_liquidity_bin",
        u64ToScVal(poolId),
        addressToScVal(callerAddress),
        i32ToScVal(binId),
        i128ToScVal(amountX),
        i128ToScVal(amountY)
      )
    )
    .setTimeout(60)
    .build();

  return rpcServer.prepareTransaction(tx);
}

/** Builds a prepared (simulated + assembled) `remove_liquidity_bin` transaction. */
export async function buildRemoveLiquidityTransaction(
  callerAddress: string,
  binId: number,
  poolId: number = DEFAULT_POOL_ID
) {
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(callerAddress);
  const contract = new Contract(DLMM_CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(
      contract.call(
        "remove_liquidity_bin",
        u64ToScVal(poolId),
        addressToScVal(callerAddress),
        i32ToScVal(binId)
      )
    )
    .setTimeout(60)
    .build();

  return rpcServer.prepareTransaction(tx);
}

export interface CreatePoolParams {
  creatorAddress: string;
  tokenX: string;
  tokenY: string;
  binStepBps: number;
  baseFeeBps: number;
  activeBinId: number;
  /** Unix seconds. 0 = Standard Pool (active immediately). Future = Launch Pool (anti-snipe). */
  activationTs: number;
}

/**
 * Builds a prepared (simulated + assembled) `create_pool` transaction.
 * Permissionless — any connected wallet can create a Standard Pool
 * (activationTs=0) or a Launch Pool (activationTs in the future).
 * The new pool_id is returned by `submitSignedTransaction`'s decoded result.
 */
export async function buildCreatePoolTransaction(params: CreatePoolParams) {
  const {
    creatorAddress,
    tokenX,
    tokenY,
    binStepBps,
    baseFeeBps,
    activeBinId,
    activationTs,
  } = params;
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(creatorAddress);
  const contract = new Contract(DLMM_CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(
      contract.call(
        "create_pool",
        addressToScVal(creatorAddress),
        addressToScVal(tokenX),
        addressToScVal(tokenY),
        i128ToScVal(BigInt(binStepBps)),
        i128ToScVal(BigInt(baseFeeBps)),
        i32ToScVal(activeBinId),
        u64ToScVal(activationTs)
      )
    )
    .setTimeout(60)
    .build();

  return rpcServer.prepareTransaction(tx);
}

/** Decodes the u64 pool_id returned by a confirmed `create_pool` transaction. */
export function decodeCreatedPoolId(returnValue: unknown): number {
  return Number(scValToNative(returnValue as any) as bigint);
}

/** Submits a wallet-signed XDR and waits for confirmation. Returns the raw ScVal return value. */
export async function submitSignedTransaction(signedXdr: string) {
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const networkPassphrase = NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase;
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);

  const sendResult = await rpcServer.sendTransaction(tx);
  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction rejected: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const hash = sendResult.hash;
  let getResult = await rpcServer.getTransaction(hash);
  const start = Date.now();
  while (getResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
    if (Date.now() - start > 30_000) {
      throw new Error(`Timed out waiting for transaction ${hash} to confirm`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    getResult = await rpcServer.getTransaction(hash);
  }

  if (getResult.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction failed: ${JSON.stringify(getResult)}`);
  }

  return getResult.returnValue;
}
