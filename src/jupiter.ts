import { Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { config } from "./config.js";
import { solanaConnection } from "./wallet.js";

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

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await response.text();
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
  } catch {}
  throw new Error(`Jupiter returned non-JSON response (${response.status}): ${body.slice(0, 200)}`);
}

async function referralSolTokenAccount(): Promise<string> {
  const accounts = await Promise.race([
    solanaConnection.getParsedTokenAccountsByOwner(new PublicKey(config.JUPITER_REFERRAL_ACCOUNT), { mint: new PublicKey(SOL_MINT) }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Jupiter referral SOL account lookup timed out")), 5000))
  ]);
  const account = accounts.value.find((item) => {
    const info = item.account.data.parsed.info as { mint?: string; isNative?: boolean };
    return info.mint === SOL_MINT && info.isNative === true;
  });
  if (!account) throw new Error("Jupiter referral SOL token account was not found");
  return account.pubkey.toBase58();
}

export async function getJupiterOrder(inputMint: string, outputMint: string, amountBaseUnits: bigint, taker: string): Promise<JupiterOrder> {
  const isSellToSol = outputMint === SOL_MINT;
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amountBaseUnits.toString(),
    slippageBps: "100",
    instructionVersion: "V2"
  });
  if (isSellToSol) params.set("platformFeeBps", String(config.JUPITER_REFERRAL_FEE_BPS));
  const response = await fetch(`${config.JUPITER_SWAP_V2_API}/quote?${params}`, { headers: jupiterHeaders(), signal: AbortSignal.timeout(10000) });
  const quote = await readJsonResponse(response) as Record<string, unknown> & { error?: string; message?: string };
  if (!response.ok) throw new Error(`Jupiter quote failed (${response.status}): ${String(quote.error ?? quote.message ?? "unknown error")}`);
  const swapResponse = await fetch(`${config.JUPITER_SWAP_V2_API}/swap`, {
    method: "POST",
    headers: { ...jupiterHeaders(), "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote,
      taker,
      userPublicKey: taker,
      instructionVersion: "V2",
      ...(isSellToSol ? { feeAccount: await referralSolTokenAccount() } : {}),
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto"
    }),
    signal: AbortSignal.timeout(15000)
  });
  const built = await readJsonResponse(swapResponse) as { swapTransaction?: string; error?: string; message?: string };
  if (!swapResponse.ok || !built.swapTransaction) throw new Error(`Jupiter swap build failed (${swapResponse.status}): ${String(built.error ?? built.message ?? "unknown error")}`);
  return { transaction: built.swapTransaction, inputAmount: String(quote.inAmount ?? amountBaseUnits), outputAmount: String(quote.outAmount ?? ""), feeBps: isSellToSol ? config.JUPITER_REFERRAL_FEE_BPS : 0, feeMint: isSellToSol ? config.JUPITER_REFERRAL_ACCOUNT : undefined };
}

export async function executeJupiterSwap(encryptedPrivateKey: string, inputMint: string, outputMint: string, amountBaseUnits: bigint, dryRun: boolean): Promise<{ dryRun: boolean; requestId?: string; signature?: string; order: JupiterOrder }> {
  const wallet = Keypair.fromSecretKey(await decryptForSwap(encryptedPrivateKey));
  const order = await getJupiterOrder(inputMint, outputMint, amountBaseUnits, wallet.publicKey.toBase58());
  if (dryRun) return { dryRun: true, requestId: order.requestId, order };
  if (!order.transaction) throw new Error("Jupiter returned no executable transaction");
  const transactionBytes = Uint8Array.from(atob(order.transaction), (character) => character.charCodeAt(0));
  const transaction = VersionedTransaction.deserialize(transactionBytes);
  transaction.sign([wallet]);
  const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), { skipPreflight: false, maxRetries: 3 });
  await solanaConnection.confirmTransaction(signature, "confirmed");
  return { dryRun: false, signature, order };
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