import { Router } from "express";
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { RequestTestusdFaucetBody, RequestTestusdFaucetResponse } from "@workspace/api-zod";

const router = Router();

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;

const TESTUSD_ISSUER =
  process.env["TESTUSD_ISSUER"] ?? "GD3HFFCVSBBQSHHXJGJLSRCAFTGRT5XFHSGCC2U7BDKBFPQWZWITDWQ2";
const TESTUSD_ASSET = new Asset("TESTUSD", TESTUSD_ISSUER);
const FAUCET_AMOUNT = "500";

// POST /faucet/testusd — sends 500 TESTUSD from the holder account to a wallet
// that already has a trustline to the asset. This is a testnet-only convenience
// route; it does not touch the DLMM contract.
router.post("/faucet/testusd", async (req, res) => {
  const body = RequestTestusdFaucetBody.safeParse(req.body);
  if (!body.success) {
    return res.status(400).json({ error: "Invalid request body" });
  }

  const holderSecret = process.env["HOLDER_SECRET_KEY"];
  if (!holderSecret) {
    req.log.error("HOLDER_SECRET_KEY is not configured");
    return res.status(502).json({ error: "Faucet is not configured on the server" });
  }

  const { address } = body.data;

  try {
    Keypair.fromPublicKey(address);
  } catch {
    return res.status(400).json({ error: "Invalid Stellar address" });
  }

  const server = new Horizon.Server(HORIZON_URL);

  try {
    const destinationAccount = await server.loadAccount(address);
    const hasTrustline = destinationAccount.balances.some(
      (b) =>
        (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
        "asset_code" in b &&
        b.asset_code === "TESTUSD" &&
        "asset_issuer" in b &&
        b.asset_issuer === TESTUSD_ISSUER
    );
    if (!hasTrustline) {
      return res.status(400).json({
        error: "This wallet has no TESTUSD trustline yet. Establish a trustline first.",
      });
    }
  } catch (err) {
    req.log.error({ err }, "Failed to load destination account from Horizon");
    return res.status(400).json({ error: "Destination account not found on the network" });
  }

  try {
    const holderKeypair = Keypair.fromSecret(holderSecret);
    const holderAccount = await server.loadAccount(holderKeypair.publicKey());

    const tx = new TransactionBuilder(holderAccount, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Operation.payment({
          destination: address,
          asset: TESTUSD_ASSET,
          amount: FAUCET_AMOUNT,
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(holderKeypair);
    const result = await server.submitTransaction(tx);

    const parsed = RequestTestusdFaucetResponse.safeParse({
      txHash: result.hash,
      amount: FAUCET_AMOUNT,
    });
    if (!parsed.success) {
      req.log.error({ error: parsed.error }, "Faucet response validation failed");
      return res.status(500).json({ error: "Internal server error" });
    }
    return res.json(parsed.data);
  } catch (err) {
    req.log.error({ err }, "Faucet payment failed");
    return res.status(502).json({ error: "Faucet payment failed. Please try again." });
  }
});

export default router;
