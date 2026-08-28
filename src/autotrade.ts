import type { EarlyDiscoveredToken } from "./types.js";
import { executeJupiterSwap, getTokenPriceInSol, SOL_MINT } from "./jupiter.js";
import { config } from "./config.js";
import { createTradePosition, countOpenTradePositions, findOpenTradePosition, getTelegramUser, listAutoTradeConfigs, listOpenTradePositions, updateTradePosition } from "./repository.js";
import { notifyAutoTradeFailure } from "./telegram.js";

const SOL_DECIMALS = 9;
const POSITION_POLL_MS = 2000;
const tokenLocks = new Set<string>();
let pollInProgress = false;

function tokenDecimals(token: EarlyDiscoveredToken): number {
  const raw = token.rawData;
  if (raw && typeof raw === "object" && typeof (raw as { decimals?: unknown }).decimals === "number") return (raw as { decimals: number }).decimals;
  return 6;
}

function baseUnits(value: number, decimals: number): bigint {
  return BigInt(Math.max(1, Math.round(value * 10 ** decimals)));
}

function orderAmount(order: { outputAmount?: string }): number {
  if (!order.outputAmount || !/^\d+$/.test(order.outputAmount)) throw new Error("Jupiter order has no valid outputAmount");
  return Number(order.outputAmount);
}

function formatAutoTradeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { signature?: unknown; transactionLogs?: unknown; logs?: unknown };
  const lines = [error.message];
  if (typeof details.signature === "string" && details.signature) lines.push(`Signature: ${details.signature}`);
  const transactionLogs = Array.isArray(details.transactionLogs) ? details.transactionLogs : Array.isArray(details.logs) ? details.logs : [];
  if (transactionLogs.length) lines.push(`Simulation logs:\n${transactionLogs.join("\n")}`);
  return lines.join("\n");
}

async function openForUser(token: EarlyDiscoveredToken, trader: Awaited<ReturnType<typeof listAutoTradeConfigs>>[number]): Promise<void> {
  const telegramId = trader.telegramId;
  const lockKey = `${telegramId}:${token.address}`;
  if (tokenLocks.has(lockKey)) return;
  tokenLocks.add(lockKey);
  try {
    if (await findOpenTradePosition(telegramId, token.address)) return;
    if (await countOpenTradePositions(telegramId) >= trader.maxTradePositions) return;
    const user = await getTelegramUser(Number(telegramId));
    if (!user) throw new Error(`Telegram wallet not found for ${telegramId}`);
    const decimals = tokenDecimals(token);
    const buy = await executeJupiterSwap(user.encryptedPrivateKey, SOL_MINT, token.address, baseUnits(trader.solAmountTradePerPosition, SOL_DECIMALS), trader.statusDryRun);
    const receivedBaseUnits = orderAmount(buy.order);
    const receivedTokens = receivedBaseUnits / 10 ** decimals;
    if (!Number.isFinite(receivedTokens) || receivedTokens <= 0) throw new Error("Jupiter returned zero token amount");
    const tokenPrice = trader.solAmountTradePerPosition / receivedTokens;
    const txHash = buy.signature ?? (buy.requestId ? `DRY_RUN:${buy.requestId}` : undefined);
    await createTradePosition({
      txHash,
      telegramId,
      amountSol: trader.solAmountTradePerPosition,
      tokenPrice,
      tokenSymbol: token.symbol,
      tokenAddress: token.address,
      tokenAmount: receivedTokens,
      tokenDecimals: decimals
    });
    console.log(`Auto-trade ${trader.statusDryRun ? "DRY-RUN" : "BUY"} | user=${telegramId} | token=${token.symbol ?? token.address} | amount=${trader.solAmountTradePerPosition} SOL`);
  } catch (error) {
    console.error(`Auto-trade BUY failed | user=${telegramId} | token=${token.address}:`, error);
    await notifyAutoTradeFailure(telegramId, token.address, formatAutoTradeError(error));
  } finally {
    tokenLocks.delete(lockKey);
  }
}

export async function handleEarlyTokenForAutoTrade(token: EarlyDiscoveredToken): Promise<void> {
  const traders = await listAutoTradeConfigs();
  for (const trader of traders) await openForUser(token, trader);
}

async function sellPosition(position: Awaited<ReturnType<typeof listOpenTradePositions>>[number], trader: Awaited<ReturnType<typeof listAutoTradeConfigs>>[number], user: NonNullable<Awaited<ReturnType<typeof getTelegramUser>>> , amountTokens: number, stage: 1 | 2): Promise<void> {
  const sell = await executeJupiterSwap(user.encryptedPrivateKey, position.tokenAddress, SOL_MINT, baseUnits(amountTokens, position.tokenDecimals), trader.statusDryRun);
  const proceeds = orderAmount(sell.order) / 10 ** SOL_DECIMALS;
  const txHash = sell.signature ?? (sell.requestId ? `DRY_RUN:${sell.requestId}` : undefined);
  if (stage === 1) {
    await updateTradePosition(position.id, { tokenAmount: Math.max(0, position.tokenAmount - amountTokens), takeProfit1Sol: proceeds, takeProfit1Executed: true, takeProfit1TxHash: txHash, currentPriceSol: position.currentPriceSol ?? undefined, lastPriceAt: new Date(), status: position.tokenAmount - amountTokens <= 0 ? "CLOSE" : "OPEN" });
  } else {
    await updateTradePosition(position.id, { tokenAmount: 0, takeProfit2Sol: proceeds, takeProfit2Executed: true, takeProfit2TxHash: txHash, currentPriceSol: position.currentPriceSol ?? undefined, lastPriceAt: new Date(), status: "CLOSE" });
  }
  console.log(`Auto-trade ${trader.statusDryRun ? "DRY-RUN" : "SELL"} TP${stage} | user=${position.telegramId} | token=${position.tokenAddress} | proceeds=${proceeds} SOL`);
}

async function monitorPosition(position: Awaited<ReturnType<typeof listOpenTradePositions>>[number], trader: Awaited<ReturnType<typeof listAutoTradeConfigs>>[number], user: NonNullable<Awaited<ReturnType<typeof getTelegramUser>>>): Promise<void> {
  const price = await getTokenPriceInSol(position.tokenAddress);
  const currentValue = position.tokenAmount * price;
  await updateTradePosition(position.id, { currentPriceSol: price, lastPriceAt: new Date() });
  if (!position.takeProfit1Executed) {
    const targetSol = position.amountSol * trader.takeProfit1TargetPercent / 100;
    if (currentValue >= targetSol) {
      const desiredProceeds = targetSol * trader.takeProfit1SellPercent / 100;
      await sellPosition(position, trader, user, Math.min(position.tokenAmount, desiredProceeds / price), 1);
    }
    return;
  }
  if (!position.takeProfit2Executed) {
    const totalTargetSol = position.amountSol * (1 + trader.takeProfit2TargetPercent / 100);
    const remainingTargetSol = Math.max(0, totalTargetSol - (position.takeProfit1Sol ?? 0));
    if (currentValue >= remainingTargetSol) await sellPosition(position, trader, user, position.tokenAmount, 2);
  }
}

async function pollOpenPositions(): Promise<void> {
  if (pollInProgress) return;
  pollInProgress = true;
  try {
    const traders = await listAutoTradeConfigs();
    for (const trader of traders) {
      const user = await getTelegramUser(Number(trader.telegramId));
      if (!user) continue;
      const positions = await listOpenTradePositions(Number(trader.telegramId));
      for (const position of positions) {
        try { await monitorPosition(position, trader, user); }
        catch (error) {
          console.error(`Auto-trade monitor failed | user=${trader.telegramId} | position=${position.id}:`, error);
          await notifyAutoTradeFailure(position.telegramId, position.tokenAddress, formatAutoTradeError(error));
        }
      }
    }
  } finally {
    pollInProgress = false;
  }
}

export function startAutoTradeWorker(): NodeJS.Timeout {
  return setInterval(() => void pollOpenPositions(), POSITION_POLL_MS);
}