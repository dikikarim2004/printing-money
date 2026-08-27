import { Keypair, VersionedTransaction } from "@solana/web3.js";
import { config } from "./config.js";

const JUPITER_ULTRA_URL = "https://api.jup.ag/ultra/v1";
const SOL_MINT = "So11111111111111111111111111111111111111112";

type JupiterOrder = {
  transaction?: string;
  requestId?: string;
  inputAmount?: string;
  outputAmount?: string;
  feeBps?: number;
  feeMint?: string;
  [key: string]: unknown;
};

function jupiterHeaders(): HeadersInit {
  if (!config.JUPITER_API_KEY) throw new Error("JUPITER_API_KEY belum dikonfigurasi");
  return { accept: "application/json", "x-api-key": config.JUPITER_API_KEY };
}

export async function getJupiterOrder(inputMint: string, outputMint: string, amountBaseUnits: bigint, taker: string): Promise<JupiterOrder> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountBaseUnits.toString(),
    taker,
    referralAccount: config.JUPITER_REFERRAL_ACCOUNT,
    referralFee: String(config.JUPITER_REFERRAL_FEE_BPS)
  });
  const response = await fetch(`${JUPITER_ULTRA_URL}/order?${params}`, { headers: jupiterHeaders(), signal: AbortSignal.timeout(10000) });
  const body = await response.json() as JupiterOrder & { error?: string; message?: string };
  if (!response.ok) throw new Error(`Jupiter order failed (${response.status}): ${body.error ?? body.message ?? "unknown error"}`);
  if (body.feeBps !== undefined && body.feeBps !== config.JUPITER_REFERRAL_FEE_BPS) throw new Error(`Jupiter returned feeBps=${body.feeBps}, expected ${config.JUPITER_REFERRAL_FEE_BPS}`);
  return body;
}

export async function executeJupiterSwap(encryptedPrivateKey: string, inputMint: string, outputMint: string, amountBaseUnits: bigint, dryRun: boolean): Promise<{ dryRun: boolean; requestId?: string; signature?: string; order: JupiterOrder }> {
  const wallet = Keypair.fromSecretKey(await decryptForSwap(encryptedPrivateKey));
  const order = await getJupiterOrder(inputMint, outputMint, amountBaseUnits, wallet.publicKey.toBase58());
  if (dryRun) return { dryRun: true, requestId: order.requestId, order };
  if (!order.transaction || !order.requestId) throw new Error("Jupiter returned no executable transaction");
  const transaction = VersionedTransaction.deserialize(Buffer.from(order.transaction, "base64"));
  transaction.sign([wallet]);
  const signedTransaction = Buffer.from(transaction.serialize()).toString("base64");
  const response = await fetch(`${JUPITER_ULTRA_URL}/execute`, {
    method: "POST",
    headers: { ...jupiterHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ signedTransaction, requestId: order.requestId }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.json() as { status?: string; signature?: string; error?: string; message?: string };
  if (!response.ok || body.status !== "Success") throw new Error(`Jupiter execute failed (${response.status}): ${body.error ?? body.message ?? body.status ?? "unknown error"}`);
  return { dryRun: false, requestId: order.requestId, signature: body.signature, order };
}

export async function getTokenPriceInSol(tokenMint: string): Promise<number> {
  const params = new URLSearchParams({ ids: `${tokenMint},${SOL_MINT}` });
  const response = await fetch(`${config.JUPITER_PRICE_API}?${params}`, { headers: { ...jupiterHeaders(), accept: "application/json" }, signal: AbortSignal.timeout(5000) });
  const body = await response.json() as Record<string, { usdPrice?: number }>;
  if (!response.ok) throw new Error(`Jupiter price failed (${response.status})`);
  const tokenUsd = body[tokenMint]?.usdPrice;
  const solUsd = body[SOL_MINT]?.usdPrice;
  if (typeof tokenUsd !== "number" || typeof solUsd !== "number" || !Number.isFinite(tokenUsd) || !Number.isFinite(solUsd) || solUsd <= 0 || tokenUsd <= 0) throw new Error("Jupiter price response is incomplete");
  return tokenUsd / solUsd;
}

async function decryptForSwap(encryptedPrivateKey: string): Promise<Uint8Array> {
  const { decryptPrivateKey } = await import("./wallet.js");
  return decryptPrivateKey(encryptedPrivateKey);
}

export { SOL_MINT };