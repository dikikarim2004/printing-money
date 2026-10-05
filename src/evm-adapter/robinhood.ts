import { JsonRpcProvider, Wallet } from "ethers";
import { config } from "../config.js";
import { decryptPrivateKey } from "../wallet.js";

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_UNIVERSAL_ROUTER_2_1_1 = "0x8876789976decbfcbbbe364623c63652db8c0904";
const NATIVE_ETH = "0x0000000000000000000000000000000000000000";

type EvmTransaction = { to?: unknown; data?: unknown; value?: unknown; from?: unknown };
type JsonObject = Record<string, unknown>;

function assertRobinhoodChainId(chainId: number): void {
  if (chainId !== ROBINHOOD_CHAIN_ID) throw new Error(`Routing guard: Robinhood adapter requires chainId ${ROBINHOOD_CHAIN_ID}, received ${chainId}`);
}

function assertAddress(value: string, field: string): void {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error(`${field} must be a 20-byte EVM address`);
}

function jsonObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Uniswap ${field} response is not an object`);
  return value as JsonObject;
}

function transactionFrom(value: unknown, field: string): { to: string; data: string; value: bigint } | null {
  if (value === null || value === undefined) return null;
  const transaction = jsonObject(value, field) as EvmTransaction;
  if (typeof transaction.to !== "string" || typeof transaction.data !== "string") throw new Error(`Uniswap ${field} transaction is missing to/data`);
  assertAddress(transaction.to, `${field}.to`);
  if (!/^0x[0-9a-fA-F]*$/.test(transaction.data)) throw new Error(`Uniswap ${field}.data is not hex`);
  const rawValue = transaction.value === undefined ? "0" : String(transaction.value);
  return { to: transaction.to, data: transaction.data, value: BigInt(rawValue) };
}

function apiHeaders(): HeadersInit {
  if (!config.ROBINHOOD_UNISWAP_API_KEY) throw new Error("ROBINHOOD_UNISWAP_API_KEY is not configured");
  return {
    accept: "application/json",
    "content-type": "application/json",
    "x-api-key": config.ROBINHOOD_UNISWAP_API_KEY,
    "x-universal-router-version": "2.1.1",
    "x-permit2-disabled": "true"
  };
}

async function post(path: string, body: JsonObject): Promise<JsonObject> {
  const response = await fetch(`${config.UNISWAP_API_BASE_URL}${path}`, {
    method: "POST",
    headers: apiHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await response.text();
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`Uniswap ${path} returned non-JSON HTTP ${response.status}`); }
  if (!response.ok) throw new Error(`Uniswap ${path} failed (${response.status}): ${JSON.stringify(parsed).slice(0, 500)}`);
  return jsonObject(parsed, path);
}

function parseIntegratorFees(): unknown[] {
  const recipient = config.ROBINHOOD_UNISWAP_INTEGRATOR_FEE_RECIPIENT;
  if (!recipient) throw new Error("ROBINHOOD_UNISWAP_INTEGRATOR_FEE_RECIPIENT is not configured");
  if (!config.ROBINHOOD_UNISWAP_INTEGRATOR_FEES_JSON) throw new Error("ROBINHOOD_UNISWAP_INTEGRATOR_FEES_JSON is not configured");
  let parsed: unknown;
  try { parsed = JSON.parse(config.ROBINHOOD_UNISWAP_INTEGRATOR_FEES_JSON); } catch { throw new Error("ROBINHOOD_UNISWAP_INTEGRATOR_FEES_JSON is invalid JSON"); }
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("Uniswap currently supports exactly one integratorFees entry");
  const serialized = JSON.stringify(parsed[0]).toLowerCase();
  if (!serialized.includes(recipient.toLowerCase())) throw new Error("Configured integrator fee JSON does not contain ROBINHOOD_UNISWAP_INTEGRATOR_FEE_RECIPIENT");
  return parsed;
}

function privateKey(encryptedPrivateKey: string): string {
  const raw = Buffer.from(decryptPrivateKey(encryptedPrivateKey)).toString("utf8").trim();
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error("Robinhood wallet private key is not a 32-byte hex key");
  return normalized;
}

function assertLiveChecklist(dryRun: boolean): void {
  if (dryRun) return;
  if (!config.ROBINHOOD_UNISWAP_LIVE_ENABLED) throw new Error("Robinhood Uniswap live trading is disabled by checklist");
  if (!config.ROBINHOOD_UNISWAP_TESTED) throw new Error("Robinhood Uniswap live trading requires a completed dry-run/test check");
  if (config.ROBINHOOD_UNISWAP_UNIVERSAL_ROUTER.toLowerCase() !== ROBINHOOD_UNIVERSAL_ROUTER_2_1_1) throw new Error("Robinhood Universal Router does not match the officially documented 2.1.1 address");
}

export type RobinhoodSwapRequest = {
  inputToken: string;
  outputToken: string;
  amountBaseUnits: bigint;
  walletAddress: string;
  encryptedPrivateKey: string;
  dryRun: boolean;
};

export type RobinhoodSwapResult = { dryRun: boolean; signature?: string; requestId?: string; outputAmount?: string };

export async function executeRobinhoodSwap(request: RobinhoodSwapRequest): Promise<RobinhoodSwapResult> {
  assertRobinhoodChainId(config.ROBINHOOD_CHAIN_ID);
  assertAddress(request.walletAddress, "walletAddress");
  assertAddress(request.inputToken, "inputToken");
  assertAddress(request.outputToken, "outputToken");
  assertLiveChecklist(request.dryRun);
  if (!config.ROBINHOOD_RPC_URL) throw new Error("ROBINHOOD_RPC_URL is not configured");
  const provider = new JsonRpcProvider(config.ROBINHOOD_RPC_URL, ROBINHOOD_CHAIN_ID);
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== ROBINHOOD_CHAIN_ID) throw new Error(`Robinhood RPC returned chainId ${network.chainId}, expected ${ROBINHOOD_CHAIN_ID}`);
  const signer = new Wallet(privateKey(request.encryptedPrivateKey), provider);
  if (signer.address.toLowerCase() !== request.walletAddress.toLowerCase()) throw new Error("Robinhood wallet private key does not match wallet address");
  const nativeInput = request.inputToken.toLowerCase() === NATIVE_ETH;
  console.log(`[EVM:${ROBINHOOD_CHAIN_ID}:Uniswap] swap start | input=${request.inputToken} | output=${request.outputToken} | dryRun=${request.dryRun}`);

  if (!nativeInput) {
    const approval = await post("/check_approval", {
      walletAddress: request.walletAddress,
      token: request.inputToken,
      amount: request.amountBaseUnits.toString(),
      chainId: ROBINHOOD_CHAIN_ID,
      tokenOut: request.outputToken,
      tokenOutChainId: ROBINHOOD_CHAIN_ID
    });
    const cancel = transactionFrom(approval.cancel, "approval.cancel");
    const approvalTransaction = transactionFrom(approval.approval, "approval.approval");
    if (!request.dryRun && cancel) { const tx = await signer.sendTransaction(cancel); await tx.wait(); }
    if (!request.dryRun && approvalTransaction) { const tx = await signer.sendTransaction(approvalTransaction); await tx.wait(); }
  }

  const quote = await post("/quote", {
    type: "EXACT_INPUT",
    amount: request.amountBaseUnits.toString(),
    tokenInChainId: ROBINHOOD_CHAIN_ID,
    tokenOutChainId: ROBINHOOD_CHAIN_ID,
    tokenIn: request.inputToken,
    tokenOut: request.outputToken,
    swapper: request.walletAddress,
    routingPreference: "BEST_PRICE",
    protocols: ["V2", "V3", "V4"],
    integratorFees: parseIntegratorFees()
  });
  const swap = await post("/swap", { quote, simulateTransaction: true, refreshGasPrice: true });
  const transaction = transactionFrom(swap.swap, "swap.swap");
  if (!transaction) throw new Error("Uniswap /swap response did not include swap transaction calldata");
  if (transaction.to.toLowerCase() !== config.ROBINHOOD_UNISWAP_UNIVERSAL_ROUTER.toLowerCase()) throw new Error("Uniswap swap target is not the configured Robinhood Universal Router");
  const outputAmount = typeof (jsonObject(quote.quote, "quote.quote").output as JsonObject | undefined)?.amount === "string"
    ? String((jsonObject(quote.quote, "quote.quote").output as JsonObject).amount) : undefined;
  if (request.dryRun) return { dryRun: true, requestId: typeof swap.requestId === "string" ? swap.requestId : undefined, outputAmount };
  const sent = await signer.sendTransaction({ to: transaction.to, data: transaction.data, value: transaction.value });
  await sent.wait();
  console.log(`[EVM:${ROBINHOOD_CHAIN_ID}:Uniswap] swap confirmed | tx=${sent.hash}`);
  return { dryRun: false, signature: sent.hash, outputAmount };
}

export async function getRobinhoodTokenPriceInEth(token: string, decimals: number): Promise<number> {
  assertRobinhoodChainId(config.ROBINHOOD_CHAIN_ID);
  assertAddress(token, "token");
  const quote = await post("/quote", {
    type: "EXACT_INPUT",
    amount: (10n ** BigInt(decimals)).toString(),
    tokenInChainId: ROBINHOOD_CHAIN_ID,
    tokenOutChainId: ROBINHOOD_CHAIN_ID,
    tokenIn: token,
    tokenOut: NATIVE_ETH,
    swapper: config.ROBINHOOD_UNISWAP_INTEGRATOR_FEE_RECIPIENT ?? "0x0000000000000000000000000000000000000001",
    routingPreference: "BEST_PRICE",
    protocols: ["V2", "V3", "V4"],
    integratorFees: parseIntegratorFees()
  });
  const quoteBody = jsonObject(quote.quote ?? quote, "quote");
  const output = jsonObject(quoteBody.output, "quote.output");
  if (typeof output.amount !== "string") throw new Error("Uniswap quote output.amount is missing");
  return Number(output.amount) / 1e18;
}

export function assertRobinhoodAdapterChain(chainId: number): void { assertRobinhoodChainId(chainId); }
export { NATIVE_ETH };
