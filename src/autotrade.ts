import type { EarlyDiscoveredToken } from "./types.js";
import { executeJupiterSwap, getTokenPriceInSol, SOL_MINT } from "./jupiter.js";
import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { createTradePosition, countOpenTradePositions, findOpenTradePosition, getTelegramUser, getTraderConfig, listAutoTradeConfigs, listOpenTradePositions, updateTradePosition } from "./repository.js";
import { notifyAutoTradeFailure } from "./telegram.js";
import { solanaConnection } from "./wallet.js";

const SOL_DECIMALS = 9;
const POSITION_POLL_MS = 2000;
const tokenLocks = new Set<string>();
const notifiedTradeFailures = new Set<string>();
const blockedAutomaticSells = new Set<string>();
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

export function formatAutoTradeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const details = error as Error & { signature?: unknown; transactionLogs?: unknown; logs?: unknown };
  const lines = [error.message];
  if (typeof details.signature === "string" && details.signature) lines.push(`Signature: ${details.signature}`);
  const transactionLogs = Array.isArray(details.transactionLogs) ? details.transactionLogs : Array.isArray(details.logs) ? details.logs : [];
  if (transactionLogs.length) lines.push(`Simulation logs:\n${transactionLogs.join("\n")}`);
  return lines.join("\n");
}

export function formatUserTradeError(operation: "BUY" | "SELL", error: unknown): string {
  const detail = formatAutoTradeError(error);
  if (/Posisi OPEN untuk token ini sudah ada/i.test(detail)) return `${operation} tidak dijalankan: posisi OPEN untuk token ini sudah ada.`;
  if (/Maksimal posisi OPEN/i.test(detail)) return `${operation} tidak dijalankan: batas maksimal posisi OPEN sudah tercapai.`;
  if (/insufficient lamports|insufficient funds|insufficient balance/i.test(detail)) return `${operation} gagal: saldo wallet tidak cukup untuk modal dan biaya transaksi.`;
  if (/IncorrectProgramId|InvalidAccountData|invalid account data/i.test(detail)) return `${operation} gagal: rute token tidak kompatibel dengan Token-2022 pada Jupiter. Transaksi tidak dikonfirmasi.`;
  if (/Jupiter quote failed|Failed to get quotes|no route|route not found/i.test(detail)) return `${operation} gagal: Jupiter tidak menemukan rute likuiditas untuk token tersebut.`;
  if (/Jupiter swap build failed/i.test(detail)) return `${operation} gagal: Jupiter tidak dapat membangun transaksi.`;
  if (/Simulation failed|simulation failed/i.test(detail)) return `${operation} gagal: transaksi ditolak saat simulasi blockchain. Tidak ada posisi yang diubah.`;
  if (/timed out|timeout|fetch failed|network/i.test(detail)) return `${operation} gagal: layanan blockchain/Jupiter tidak merespons tepat waktu.`;
  return `${operation} gagal: transaksi tidak berhasil diproses. Silakan hubungi operator.`;
}

async function notifyTradeFailureOnce(key: string, operation: "BUY" | "SELL", telegramId: bigint, tokenAddress: string, error: unknown): Promise<void> {
  if (notifiedTradeFailures.has(key)) return;
  notifiedTradeFailures.add(key);
  await notifyAutoTradeFailure(telegramId, operation, tokenAddress, formatUserTradeError(operation, error));
}

async function openForUser(token: EarlyDiscoveredToken, trader: Awaited<ReturnType<typeof listAutoTradeConfigs>>[number], throwOnFailure = false): Promise<Awaited<ReturnType<typeof executeJupiterSwap>> | undefined> {
  const telegramId = trader.telegramId;
  const lockKey = `${telegramId}:${token.address}`;
  if (tokenLocks.has(lockKey)) return;
  tokenLocks.add(lockKey);
  try {
    if (await findOpenTradePosition(telegramId, token.address)) {
      if (throwOnFailure) throw new Error("Posisi OPEN untuk token ini sudah ada");
      return;
    }
    if (await countOpenTradePositions(telegramId) >= trader.maxTradePositions) {
      if (throwOnFailure) throw new Error(`Maksimal posisi OPEN (${trader.maxTradePositions}) sudah tercapai`);
      return;
    }
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
    return buy;
  } catch (error) {
    console.error(`Auto-trade BUY failed | user=${telegramId} | token=${token.address}:`, error);
    if (!throwOnFailure) await notifyTradeFailureOnce(`BUY:${telegramId}:${token.address}`, "BUY", telegramId, token.address, error);
    if (throwOnFailure) throw error;
  } finally {
    tokenLocks.delete(lockKey);
  }
}

export async function handleEarlyTokenForAutoTrade(token: EarlyDiscoveredToken): Promise<void> {
  const traders = await listAutoTradeConfigs();
  for (const trader of traders) await openForUser(token, trader);
}

export async function manualBuyForUser(tokenAddress: string, telegramId: number): Promise<Awaited<ReturnType<typeof executeJupiterSwap>>> {
  const trader = await getTraderConfig(telegramId);
  const token: EarlyDiscoveredToken = {
    address: tokenAddress,
    progress: 0,
    tokenCreatedAt: new Date(),
    rawData: {}
  };
  const result = await openForUser(token, trader, true);
  if (!result) throw new Error("Manual BUY tidak menghasilkan transaksi");
  return result;
}

async function sellPosition(position: Awaited<ReturnType<typeof listOpenTradePositions>>[number], trader: Awaited<ReturnType<typeof listAutoTradeConfigs>>[number], user: NonNullable<Awaited<ReturnType<typeof getTelegramUser>>> , amountTokens: number, stage: 1 | 2): Promise<void> {
  if (!Number.isFinite(amountTokens) || amountTokens <= 0) throw new Error("Jumlah token untuk SELL tidak valid");
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

async function attemptAutomaticSell(position: Awaited<ReturnType<typeof listOpenTradePositions>>[number], trader: Awaited<ReturnType<typeof listAutoTradeConfigs>>[number], user: NonNullable<Awaited<ReturnType<typeof getTelegramUser>>>, amountTokens: number, stage: 1 | 2): Promise<void> {
  if (blockedAutomaticSells.has(position.id)) return;
  try {
    await sellPosition(position, trader, user, amountTokens, stage);
  } catch (error) {
    blockedAutomaticSells.add(position.id);
    throw error;
  }
}

export async function manualSellForUser(tokenAddress: string, telegramId: number): Promise<Awaited<ReturnType<typeof executeJupiterSwap>>> {
  const user = await getTelegramUser(telegramId);
  if (!user) throw new Error("Wallet user belum terdaftar");
  const positions = (await listOpenTradePositions(telegramId)).filter((position) => position.tokenAddress === tokenAddress);
  if (!positions.length) throw new Error("Tidak ada posisi OPEN untuk contract address tersebut");
  const mint = new PublicKey(tokenAddress);
  const accounts = await solanaConnection.getParsedTokenAccountsByOwner(new PublicKey(user.walletAddress), { mint });
  const balance = accounts.value.reduce((total, account) => {
    const info = account.account.data.parsed.info as { tokenAmount?: { amount?: string; decimals?: number } };
    return total + BigInt(info.tokenAmount?.amount ?? "0");
  }, 0n);
  if (balance <= 0n) throw new Error("Saldo memecoin pada wallet adalah 0");
  const decimals = accounts.value[0]?.account.data.parsed.info.tokenAmount.decimals;
  if (typeof decimals !== "number") throw new Error("Decimal token tidak tersedia");
  const trader = await getTraderConfig(telegramId);
  const sell = await executeJupiterSwap(user.encryptedPrivateKey, tokenAddress, SOL_MINT, balance, trader.statusDryRun);
  const proceeds = orderAmount(sell.order) / 10 ** SOL_DECIMALS;
  const txHash = sell.signature ?? (sell.requestId ? `DRY_RUN:${sell.requestId}` : undefined);
  if (!trader.statusDryRun) {
    for (const position of positions) {
      await updateTradePosition(position.id, { tokenAmount: 0, takeProfit2Sol: proceeds, takeProfit2Executed: true, takeProfit2TxHash: txHash, lastPriceAt: new Date(), status: "CLOSE" });
    }
  }
  console.log(`Manual SELL ${trader.statusDryRun ? "DRY-RUN" : "SUCCESS"} | user=${telegramId} | token=${tokenAddress} | amountBaseUnits=${balance.toString()}`);
  return sell;
}

async function monitorPosition(position: Awaited<ReturnType<typeof listOpenTradePositions>>[number], trader: Awaited<ReturnType<typeof listAutoTradeConfigs>>[number], user: NonNullable<Awaited<ReturnType<typeof getTelegramUser>>>): Promise<void> {
  const price = await getTokenPriceInSol(position.tokenAddress);
  const currentValue = position.tokenAmount * price;
  await updateTradePosition(position.id, { currentPriceSol: price, lastPriceAt: new Date() });
  if (!position.takeProfit1Executed) {
    const targetSol = position.amountSol * trader.takeProfit1TargetPercent / 100;
    if (currentValue >= targetSol) {
      const desiredProceeds = targetSol * trader.takeProfit1SellPercent / 100;
      await attemptAutomaticSell(position, trader, user, Math.min(position.tokenAmount, desiredProceeds / price), 1);
    }
    return;
  }
  if (!position.takeProfit2Executed) {
    const totalTargetSol = position.amountSol * (1 + trader.takeProfit2TargetPercent / 100);
    const remainingTargetSol = Math.max(0, totalTargetSol - (position.takeProfit1Sol ?? 0));
    if (currentValue >= remainingTargetSol) await attemptAutomaticSell(position, trader, user, position.tokenAmount, 2);
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
          await notifyTradeFailureOnce(`SELL:${position.telegramId}:${position.id}`, "SELL", position.telegramId, position.tokenAddress, error);
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