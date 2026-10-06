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
  nativeToScVal,
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
  decodeSwapExactOutResult,
  type SwapExactOutResultDecoded,
} from "./stellar";
import {
  DLMM_CONTRACT_ID,
  DLMM_V2_CONTRACT_ID,
  STELLAR_NETWORK,
  DEFAULT_POOL_ID,
} from "./contracts";

// A funded, publicly-known testnet account used only to satisfy Soroban's
// requirement for a transaction source account when simulating read-only
// calls (e.g. quotes) before a wallet is connected. No funds move and no
// signature is required for read-only invocations.
const QUOTE_SOURCE_ACCOUNT =
  import.meta.env.VITE_QUOTE_SOURCE_ACCOUNT ??
  "GD3HFFCVSBBQSHHXJGJLSRCAFTGRT5XFHSGCC2U7BDKBFPQWZWITDWQ2";

export interface SorobanTokenMetadata {
  symbol: string;
  name: string;
}

const tokenMetadataCache = new Map<string, Promise<SorobanTokenMetadata>>();

export function getSorobanTokenMetadata(address: string): Promise<SorobanTokenMetadata> {
  const contractId = address.trim();
  if (!/^C[A-Z2-7]{55}$/.test(contractId)) {
    return Promise.reject(
      new Error("Enter a Soroban token contract address (C...). G... addresses are accounts or classic issuers.")
    );
  }

  const cached = tokenMetadataCache.get(contractId);
  if (cached) return cached;

  const lookup = (async () => {
    const server = createRpcServer(STELLAR_NETWORK);
    const account = await server.getAccount(QUOTE_SOURCE_ACCOUNT);
    const contract = new Contract(contractId);

    async function callString(method: "symbol" | "name"): Promise<string | null> {
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
      })
        .addOperation(contract.call(method))
        .setTimeout(30)
        .build();
      const simulation = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(simulation) || !simulation.result) return null;
      const value = scValToNative(simulation.result.retval);
      return typeof value === "string" && value.length > 0 ? value : null;
    }

    const symbol = await callString("symbol");
    if (!symbol) throw new Error("Address is not a SEP-41 token contract or does not expose symbol().");
    const name = await callString("name");
    return { symbol, name: name ?? symbol };
  })();

  tokenMetadataCache.set(contractId, lookup);
  lookup.catch(() => tokenMetadataCache.delete(contractId));
  return lookup;
}

export interface SwapQuote {
  amountIn: bigint;
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
  return { ...decoded, amountIn };
}

export async function getOnChainExactOutQuote(
  xToY: boolean,
  amountOut: bigint,
  poolId: number = DEFAULT_POOL_ID
): Promise<SwapExactOutResultDecoded> {
  if (!DLMM_V2_CONTRACT_ID) {
    throw new Error("Exact-output swaps require V2. Set VITE_DLMM_V2_CONTRACT_ID after deployment.");
  }
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(QUOTE_SOURCE_ACCOUNT);
  const contract = new Contract(DLMM_V2_CONTRACT_ID);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(
      contract.call(
        "simulate_swap_exact_out",
        u64ToScVal(poolId),
        boolToScVal(xToY),
        i128ToScVal(amountOut)
      )
    )
    .setTimeout(30)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Exact-output quote simulation failed: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error("Exact-output quote returned no result");
  }
  return decodeSwapExactOutResult(sim.result.retval);
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

export async function buildExactOutSwapTransaction(
  callerAddress: string,
  xToY: boolean,
  amountOut: bigint,
  maxAmountIn: bigint,
  poolId: number = DEFAULT_POOL_ID
) {
  if (!DLMM_V2_CONTRACT_ID) {
    throw new Error("Exact-output swaps require V2. Set VITE_DLMM_V2_CONTRACT_ID after deployment.");
  }
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(callerAddress);
  const contract = new Contract(DLMM_V2_CONTRACT_ID);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(
      contract.call(
        "swap_exact_out_bin",
        u64ToScVal(poolId),
        addressToScVal(callerAddress),
        boolToScVal(xToY),
        i128ToScVal(amountOut),
        i128ToScVal(maxAmountIn)
      )
    )
    .setTimeout(60)
    .build();
  return rpcServer.prepareTransaction(tx);
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

export async function submitSignedExactOutSwap(
  signedXdr: string
): Promise<SwapExactOutResultDecoded> {
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
    await new Promise((resolve) => setTimeout(resolve, 1500));
    getResult = await rpcServer.getTransaction(hash);
  }
  if (getResult.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`Transaction failed: ${JSON.stringify(getResult)}`);
  }
  if (!getResult.returnValue) {
    throw new Error("Transaction succeeded but returned no value");
  }
  return decodeSwapExactOutResult(getResult.returnValue);
}

/** Read-only `get_config` for a pool — returns its on-chain token addresses. */
export async function getPoolConfig(
  poolId: number = DEFAULT_POOL_ID
): Promise<{ tokenX: string; tokenY: string }> {
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(QUOTE_SOURCE_ACCOUNT);
  const contract = new Contract(DLMM_CONTRACT_ID);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(contract.call("get_config", u64ToScVal(poolId)))
    .setTimeout(30)
    .build();

  const sim = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`get_config simulation failed: ${sim.error}`);
  }
  if (!sim.result) {
    throw new Error("get_config returned no result");
  }
  const config = scValToNative(sim.result.retval) as { token_x: string; token_y: string };
  return { tokenX: config.token_x, tokenY: config.token_y };
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

/**
 * Builds a prepared batch `add_liquidity_bins` transaction covering multiple
 * bins in a single contract call (one wallet signature, one fee).
 */
export async function buildAddLiquidityBinsTransaction(
  callerAddress: string,
  binIds: number[],
  amountsX: bigint[],
  amountsY: bigint[],
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
        "add_liquidity_bins",
        u64ToScVal(poolId),
        addressToScVal(callerAddress),
        nativeToScVal(binIds, { type: "i32" }),
        nativeToScVal(
          amountsX.map((v) => v.toString()),
          { type: "i128" }
        ),
        nativeToScVal(
          amountsY.map((v) => v.toString()),
          { type: "i128" }
        )
      )
    )
    .setTimeout(120)
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

export async function buildClaimFeeTransaction(
  callerAddress: string,
  binId: number,
  poolId: number = DEFAULT_POOL_ID
) {
  if (!DLMM_V2_CONTRACT_ID) {
    throw new Error("LP fee claims require V2. Set VITE_DLMM_V2_CONTRACT_ID after deployment.");
  }
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(callerAddress);
  const contract = new Contract(DLMM_V2_CONTRACT_ID);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_CONFIG[STELLAR_NETWORK].networkPassphrase,
  })
    .addOperation(
      contract.call(
        "claim_fee",
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
  baseFactor: bigint;
  baseFeePowerFactor: number;
  filterPeriod: number;
  decayPeriod: number;
  reductionFactor: number;
  variableFeeControl: bigint;
  maxVolatilityAccumulator: bigint;
  protocolShareBps: number;
  functionType: number;
  collectFeeMode: number;
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
  if (!DLMM_V2_CONTRACT_ID) {
    throw new Error("Pool creation with PoolFeeConfig requires V2. Set VITE_DLMM_V2_CONTRACT_ID after deployment.");
  }
  const {
    creatorAddress,
    tokenX,
    tokenY,
    binStepBps,
    baseFactor,
    baseFeePowerFactor,
    filterPeriod,
    decayPeriod,
    reductionFactor,
    variableFeeControl,
    maxVolatilityAccumulator,
    protocolShareBps,
    functionType,
    collectFeeMode,
    activeBinId,
    activationTs,
  } = params;
  const rpcServer = createRpcServer(STELLAR_NETWORK);
  const account = await rpcServer.getAccount(creatorAddress);
  const contract = new Contract(DLMM_V2_CONTRACT_ID);

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
        nativeToScVal(
          {
            base_factor: baseFactor,
            base_fee_power_factor: BigInt(baseFeePowerFactor),
            filter_period: BigInt(filterPeriod),
            decay_period: BigInt(decayPeriod),
            reduction_factor: BigInt(reductionFactor),
            variable_fee_control: variableFeeControl,
            max_volatility_accumulator: maxVolatilityAccumulator,
            protocol_share_bps: BigInt(protocolShareBps),
            function_type: BigInt(functionType),
            collect_fee_mode: BigInt(collectFeeMode),
          },
          {
            type: {
              base_factor: ["symbol", "i128"],
              base_fee_power_factor: ["symbol", "i128"],
              filter_period: ["symbol", "u64"],
              decay_period: ["symbol", "u64"],
              reduction_factor: ["symbol", "i128"],
              variable_fee_control: ["symbol", "i128"],
              max_volatility_accumulator: ["symbol", "i128"],
              protocol_share_bps: ["symbol", "i128"],
              function_type: ["symbol", "i128"],
              collect_fee_mode: ["symbol", "i128"],
            },
          }
        ),
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
