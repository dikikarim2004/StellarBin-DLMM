/**
 * Stellar / Soroban XDR encoding-decoding utilities for the DLMM protocol.
 *
 * These helpers translate between JavaScript-friendly types and the XDR binary
 * format Soroban contracts expect.  Import them in any component that needs to
 * build or parse contract invocations.
 *
 * Requires: @stellar/stellar-sdk  (add via: pnpm add @stellar/stellar-sdk)
 */

import {
  Address,
  Contract,
  Networks,
  rpc,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  xdr,
  BASE_FEE,
} from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Network configuration
// ---------------------------------------------------------------------------

export type NetworkId = "testnet" | "mainnet";

export const NETWORK_CONFIG: Record<
  NetworkId,
  { rpcUrl: string; networkPassphrase: string }
> = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: Networks.TESTNET,
  },
  mainnet: {
    rpcUrl: "https://mainnet.stellar.validationcloud.io/v1/",
    networkPassphrase: Networks.PUBLIC,
  },
};

// ---------------------------------------------------------------------------
// RPC client factory
// ---------------------------------------------------------------------------

export function createRpcServer(network: NetworkId): rpc.Server {
  const { rpcUrl } = NETWORK_CONFIG[network];
  return new rpc.Server(rpcUrl, { allowHttp: false });
}

// ---------------------------------------------------------------------------
// XDR helpers: JavaScript → ScVal
// ---------------------------------------------------------------------------

/** Convert a Stellar address string to an Address ScVal. */
export function addressToScVal(address: string): xdr.ScVal {
  return Address.fromString(address).toScVal();
}

/** Convert a JavaScript integer to an i128 ScVal. */
export function i128ToScVal(value: bigint): xdr.ScVal {
  return nativeToScVal(value, { type: "i128" });
}

/** Convert a JavaScript integer to an i32 ScVal (used for bin IDs). */
export function i32ToScVal(value: number): xdr.ScVal {
  return xdr.ScVal.scvI32(value);
}

/** Convert a boolean to a ScVal. */
export function boolToScVal(value: boolean): xdr.ScVal {
  return xdr.ScVal.scvBool(value);
}

// ---------------------------------------------------------------------------
// XDR helpers: ScVal → JavaScript
// ---------------------------------------------------------------------------

/** Parse a ScVal into its native JavaScript equivalent. */
export function scValToJs<T = unknown>(val: xdr.ScVal): T {
  return scValToNative(val) as T;
}

/** Parse an i128 ScVal to a BigInt. */
export function scValToI128(val: xdr.ScVal): bigint {
  return scValToNative(val) as bigint;
}

// ---------------------------------------------------------------------------
// Contract invocation builders
// ---------------------------------------------------------------------------

export interface InvokeParams {
  /** Caller's public key (G…) */
  callerAddress: string;
  /** DLMM contract ID */
  contractId: string;
  /** Soroban function name */
  functionName: string;
  /** Ordered ScVal arguments */
  args: xdr.ScVal[];
  /** Which network to use */
  network: NetworkId;
}

/**
 * Build an unsigned Soroban transaction for a contract invocation.
 *
 * The returned transaction must be:
 * 1. Simulated via `rpcServer.simulateTransaction(tx)` to set the fee & auth.
 * 2. Signed by the caller's wallet (Freighter / Albedo).
 * 3. Submitted via `rpcServer.sendTransaction(signedTx)`.
 */
export async function buildContractInvocation(
  params: InvokeParams
): Promise<Transaction> {
  const { callerAddress, contractId, functionName, args, network } = params;
  const { networkPassphrase } = NETWORK_CONFIG[network];

  const rpcServer = createRpcServer(network);
  const account = await rpcServer.getAccount(callerAddress);

  const contract = new Contract(contractId);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(contract.call(functionName, ...args))
    .setTimeout(30)
    .build();

  return tx;
}

/**
 * Simulate a transaction and extract the returned ScVal.
 *
 * Returns `null` if simulation fails.
 */
export async function simulateAndDecode<T = unknown>(
  tx: Transaction,
  network: NetworkId
): Promise<T | null> {
  const rpcServer = createRpcServer(network);
  const sim = await rpcServer.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    console.error("[stellar] simulation error:", sim.error);
    return null;
  }
  if (!sim.result) return null;

  return scValToJs<T>(sim.result.retval);
}

// ---------------------------------------------------------------------------
// Typed DLMM helpers
// ---------------------------------------------------------------------------

/**
 * Build the XDR arguments for `add_liquidity_bin`.
 *
 * @param caller     - Caller's Stellar address (G…)
 * @param binId      - Target bin ID (i32)
 * @param amountX    - Amount of token X in stroops (7 decimals) as bigint
 * @param amountY    - Amount of token Y in stroops (7 decimals) as bigint
 */
export function encodeAddLiquidityBin(
  caller: string,
  binId: number,
  amountX: bigint,
  amountY: bigint
): xdr.ScVal[] {
  return [
    addressToScVal(caller),
    i32ToScVal(binId),
    i128ToScVal(amountX),
    i128ToScVal(amountY),
  ];
}

/**
 * Build the XDR arguments for `swap_exact_in_bin`.
 *
 * @param caller       - Caller's Stellar address (G…)
 * @param xToY         - true = sell X for Y; false = sell Y for X
 * @param amountIn     - Exact input amount in stroops as bigint
 * @param minAmountOut - Minimum output (slippage guard) in stroops as bigint
 */
export function encodeSwapExactIn(
  caller: string,
  xToY: boolean,
  amountIn: bigint,
  minAmountOut: bigint
): xdr.ScVal[] {
  return [
    addressToScVal(caller),
    boolToScVal(xToY),
    i128ToScVal(amountIn),
    i128ToScVal(minAmountOut),
  ];
}

/** Decode a `SwapResult` struct returned by `swap_exact_in_bin`. */
export interface SwapResultDecoded {
  amountOut: bigint;
  feePaid: bigint;
  binsCrossed: number;
  finalBin: number;
}

export function decodeSwapResult(val: xdr.ScVal): SwapResultDecoded {
  // Soroban struct ScVals are maps of symbol → value.
  const map = val.map()!;
  const get = (key: string): xdr.ScVal => {
    const entry = map.find(
      (e) => e.key().sym().toString() === key
    );
    if (!entry) throw new Error(`missing field: ${key}`);
    return entry.val();
  };

  return {
    amountOut: scValToI128(get("amount_out")),
    feePaid: scValToI128(get("fee_paid")),
    binsCrossed: scValToNative(get("bins_crossed")) as number,
    finalBin: scValToNative(get("final_bin")) as number,
  };
}

// ---------------------------------------------------------------------------
// Formatting utilities
// ---------------------------------------------------------------------------

const STROOP = 10_000_000n; // 10^7

/** Convert a stroop amount (bigint) to a human-readable decimal string. */
export function stroopsToDisplay(stroops: bigint, decimals = 4): string {
  const whole = stroops / STROOP;
  const frac = stroops % STROOP;
  const fracStr = frac.toString().padStart(7, "0").slice(0, decimals);
  return `${whole}.${fracStr}`;
}

/** Convert a display amount (string) to stroops (bigint). */
export function displayToStroops(display: string): bigint {
  const [whole, frac = ""] = display.split(".");
  const fracPadded = frac.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * STROOP + BigInt(fracPadded);
}

/** Format a USD value with appropriate suffix (K, M, B). */
export function formatUsd(value: number): string {
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
  return `$${value.toFixed(2)}`;
}

/** Format a percentage with sign and colour class. */
export function formatPct(value: number): { text: string; cls: string } {
  const sign = value >= 0 ? "+" : "";
  return {
    text: `${sign}${value.toFixed(2)}%`,
    cls: value >= 0 ? "text-green-400" : "text-red-400",
  };
}
