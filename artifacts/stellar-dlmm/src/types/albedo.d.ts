/**
 * Type declarations for @albedo-link/intent
 * The library exports a single default instance (albedo) that opens a popup
 * to albedo.link/confirm and communicates via postMessage.
 */
declare module "@albedo-link/intent" {
  export interface PublicKeyResult {
    pubkey: string;
    signed_message: string;
    signature: string;
  }

  export interface TxResult {
    xdr: string;
    tx_hash: string;
    signed_envelope_xdr: string;
    network: string;
  }

  export interface AlbedoIntent {
    publicKey(params?: { token?: string; require_existing?: boolean }): Promise<PublicKeyResult>;
    tx(params: {
      xdr: string;
      network?: string;
      pubkey?: string;
      description?: string;
      submit?: boolean;
    }): Promise<TxResult>;
    pay(params: {
      amount: string;
      destination: string;
      asset_code?: string;
      asset_issuer?: string;
      network?: string;
    }): Promise<TxResult>;
  }

  const albedo: AlbedoIntent & { default: AlbedoIntent };
  export default albedo;
}
