import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { config } from "./config.js";
import { getTelegramUser, getTraderConfig, hasNextEarlyPage, hasNextPage, hasNextUnboundedPage, listChatIds, listEarlyTokens, listOpenTradePositions, listTokens, listTopMentions, listUnboundedTokens, registerChat, registerTelegramUser, updateTraderConfig } from "./repository.js";
import { getSolBalance, sendSol } from "./wallet.js";
import type { EarlyTokenListItem, TokenListItem, UnboundedTokenListItem } from "./types.js";

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
bot.catch((error) => {
  console.error("Telegram update handling failed:", error);
});
bot.use(async (ctx, next) => {
  if (ctx.chat) {
    try {
      await registerChat(ctx.chat.id);
    } catch (error) {
      console.error("Gagal mendaftarkan chat:", error);
    }
  }
  if (ctx.from) {
    try {
      await registerTelegramUser(ctx.from.id, ctx.from.username);
    } catch (error) {
      console.error("Gagal mendaftarkan user Telegram:", error);
    }
  }
  await next();
});
const dateFormatter = new Intl.DateTimeFormat("id-ID", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
let latestScreeningStatus = "Screening belum berjalan.";
// Chat is waiting to type a minimum-volume number after tapping "Token terbaru" or "Good Unbounded Token".
const pendingVolumeInput = new Map<number, "latest" | "unbounded">();
const pendingWalletSend = new Set<number>();
type TraderConfigField = "solAmountTradePerPosition" | "maxTradePositions" | "takeProfit1SellPercent" | "takeProfit1TargetPercent" | "takeProfit2TargetPercent" | "heliusApiKey";
const pendingTraderConfig = new Map<number, TraderConfigField>();
const menuKeyboard = new Keyboard()
  .text("Token terbaru")
  .text("Semua token")
  .row()
  .text("Top mention X")
  .text("Status screening")
  .row()
  .text("Good Unbounded Token")
  .row()
  .text("Early Token")
  .row()
  .text("Wallet")
  .row()
  .text("Konfigurasi Trade")
  .row()
  .text("Open Trade Positions")
  .resized()
  .persistent();

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character);
}

// "sampai detik ini" means the elapsed time must be computed live at render time, not stored.
function formatElapsed(from: Date, now: Date): string {
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} hari`);
  if (days > 0 || hours > 0) parts.push(`${hours} jam`);
  parts.push(`${minutes} menit`);
  return `${parts.join(" ")} yang lalu`;
}

function formatVolume(volume: number | null | undefined): string {
  return volume === null || volume === undefined ? "-" : volume.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

// Telegram's HTML subset has no <table>; a <pre> block of aligned "label : value" lines is the closest table-like rendering.
// Address is kept in its own <code> span (outside the <pre> table) so tap-to-copy copies only the full contract address.
function renderTokenRow(token: TokenListItem, now: Date): string {
  const label = token.symbol ?? token.name ?? token.address.slice(0, 8);
  const fields: [string, string][] = [
    ["Symbol", label],
    ["100% pada", `${dateFormatter.format(token.bondingAt)} UTC`],
    ["Sudah berjalan", formatElapsed(token.bondingAt, now)],
    ["Rug ratio", token.rugRatio !== undefined ? token.rugRatio.toFixed(3) : "-"],
    ["Market Cap (USD)", formatVolume(token.marketCap)],
    ["ATH Market Cap (USD)", formatVolume(token.athMarketCap)],
    ["Volume 24h (USD)", formatVolume(token.jumlah_volume)],
    ["X mentions", String(token.xMentionCount ?? "-")]
  ];
  const labelWidth = Math.max(...fields.map(([key]) => key.length));
  const table = fields.map(([key, value]) => `${key.padEnd(labelWidth)} : ${value}`).join("\n");
  return `<pre>${escapeHtml(table)}</pre>\nAddress: <code>${escapeHtml(token.address)}</code>\n<a href="${escapeHtml(token.pumpUrl)}">Buka di Pump.fun</a>`;
}

function render(tokens: TokenListItem[], title: string): string {
  if (!tokens.length) return `${escapeHtml(title)}\n\nBelum ada token tersimpan.`;
  const now = new Date();
  return `${escapeHtml(title)}\n\n${tokens.map((token, index) => `${index + 1}. ${renderTokenRow(token, now)}`).join("\n\n")}`;
}

// Good Unbounded Token: bonding curve not yet 100%, but dex paid, bundler <= 20%, organic, low rug risk.
function renderUnboundedTokenRow(token: UnboundedTokenListItem | EarlyTokenListItem, now: Date): string {
  const label = token.symbol ?? token.name ?? token.address.slice(0, 8);
  const fields: [string, string][] = [
    ["Symbol", label],
    ["Progress", `${(token.progress * 100).toFixed(1)}%`],
    ["Rug ratio", token.rugRatio !== undefined ? token.rugRatio.toFixed(3) : "-"],
    ["Market Cap (USD)", formatVolume(token.marketCap)],
    ["ATH Market Cap (USD)", formatVolume(token.athMarketCap)],
    ["Terdeteksi pada", `${dateFormatter.format(token.createdAt)} UTC`],
    ["Sudah berjalan", formatElapsed(token.createdAt, now)],
    ["Volume 24h (USD)", formatVolume(token.jumlah_volume)],
    ["X mentions", String(token.xMentionCount ?? "-")]
  ];
  const labelWidth = Math.max(...fields.map(([key]) => key.length));
  const table = fields.map(([key, value]) => `${key.padEnd(labelWidth)} : ${value}`).join("\n");
  return `<pre>${escapeHtml(table)}</pre>\nAddress: <code>${escapeHtml(token.address)}</code>\n<a href="${escapeHtml(token.pumpUrl)}">Buka di Pump.fun</a>`;
}

function renderUnbounded(tokens: Array<UnboundedTokenListItem | EarlyTokenListItem>, title: string): string {
  if (!tokens.length) return `${escapeHtml(title)}\n\nBelum ada token tersimpan.`;
  const now = new Date();
  return `${escapeHtml(title)}\n\n${tokens.map((token, index) => `${index + 1}. ${renderUnboundedTokenRow(token, now)}`).join("\n\n")}`;
}

function renderEarlyTokenRow(token: EarlyTokenListItem, now: Date): string {
  const label = token.symbol ?? token.name ?? token.address.slice(0, 8);
  const fields: [string, string][] = [
    ["Symbol", label],
    ["Progress", `${(token.progress * 100).toFixed(1)}%`],
    ["Market Cap (USD)", formatVolume(token.marketCap)],
    ["ATH Market Cap (USD)", formatVolume(token.athMarketCap)],
    ["Terdeteksi pada", `${dateFormatter.format(token.createdAt)} UTC`],
    ["Sudah berjalan", formatElapsed(token.createdAt, now)],
    ["Volume 24h (USD)", formatVolume(token.jumlah_volume)],
    ["X mentions", String(token.xMentionCount ?? "-")]
  ];
  const labelWidth = Math.max(...fields.map(([key]) => key.length));
  const table = fields.map(([key, value]) => `${key.padEnd(labelWidth)} : ${value}`).join("\n");
  return `<pre>${escapeHtml(table)}</pre>\nAddress: <code>${escapeHtml(token.address)}</code>\n<a href="${escapeHtml(token.pumpUrl)}">Buka di Pump.fun</a>`;
}

function renderEarlyTokens(tokens: EarlyTokenListItem[], title: string): string {
  if (!tokens.length) return `${escapeHtml(title)}\n\nBelum ada token tersimpan.`;
  const now = new Date();
  return `${escapeHtml(title)}\n\n${tokens.map((token, index) => `${index + 1}. ${renderEarlyTokenRow(token, now)}`).join("\n\n")}`;
}

function isCompletedToken(item: TokenListItem | UnboundedTokenListItem): item is TokenListItem {
  return "bondingAt" in item;
}

// Point 2: renders the combined Token + TokenUnboundedFilter "Top mention X" list, dispatching per item type.
function renderTopMentions(items: Array<TokenListItem | UnboundedTokenListItem>, title: string): string {
  if (!items.length) return `${escapeHtml(title)}\n\nBelum ada token tersimpan.`;
  const now = new Date();
  return `${escapeHtml(title)}\n\n${items.map((item, index) => `${index + 1}. ${isCompletedToken(item) ? renderTokenRow(item, now) : renderUnboundedTokenRow(item, now)}`).join("\n\n")}`;
}

async function sendTimeList(ctx: Context, page: number, windowHours?: number, minVolume?: number): Promise<void> {
  const tokens = await listTokens("time", page, 10, windowHours, minVolume);
  const keyboard = new InlineKeyboard();
  const windowToken = windowHours ? String(windowHours) : "all";
  const volumeToken = minVolume ?? 0;
  if (page > 1) keyboard.text("Previous", `tokens:time:${windowToken}:${page - 1}:${volumeToken}`);
  if (await hasNextPage(page, 10, windowHours, minVolume)) keyboard.text("Continue", `tokens:time:${windowToken}:${page + 1}:${volumeToken}`);
  const volumeSuffix = minVolume ? ` (volume >= ${minVolume.toLocaleString("en-US")})` : "";
  const title = windowHours ? `Token terbaru (24 jam terakhir)${volumeSuffix}, halaman ${page}` : `Semua token bonding curve, halaman ${page}`;
  await ctx.reply(render(tokens, title), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
}

async function sendUnboundedList(ctx: Context, page: number, minVolume?: number): Promise<void> {
  const tokens = await listUnboundedTokens(page, 10, minVolume);
  const keyboard = new InlineKeyboard();
  const volumeToken = minVolume ?? 0;
  if (page > 1) keyboard.text("Previous", `unbounded:${page - 1}:${volumeToken}`);
  if (await hasNextUnboundedPage(page, 10, minVolume)) keyboard.text("Continue", `unbounded:${page + 1}:${volumeToken}`);
  const volumeSuffix = minVolume ? ` (volume >= ${minVolume.toLocaleString("en-US")})` : "";
  const title = `Good Unbounded Token (belum 100%, dex paid, bundler <= 20%, organik)${volumeSuffix}, halaman ${page}`;
  await ctx.reply(renderUnbounded(tokens, title), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
}

async function sendEarlyList(ctx: Context, page: number): Promise<void> {
  const tokens = await listEarlyTokens(page);
  const keyboard = new InlineKeyboard();
  if (page > 1) keyboard.text("Previous", `early:${page - 1}`);
  if (await hasNextEarlyPage(page)) keyboard.text("Continue", `early:${page + 1}`);
  await ctx.reply(renderEarlyTokens(tokens, `Early Token (MCAP 2.000-<3.000 USD, belum ATH, volume >= 20.000 USD), halaman ${page}`), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
}

async function sendOpenTradePositions(ctx: Context): Promise<void> {
  if (!ctx.from) throw new Error("Telegram user tidak tersedia");
  const positions = await listOpenTradePositions(ctx.from.id);
  if (!positions.length) {
    await ctx.reply("Open Trade Positions\n\nTidak ada posisi OPEN untuk Telegram ID Anda.", { reply_markup: menuKeyboard });
    return;
  }
  const fields = positions.map((position, index) => {
    const rows = [
      ["ID transaksi", position.id],
      ["Hash transaksi", position.txHash ?? "-"],
      ["Telegram ID", position.telegramId.toString()],
      ["Amount SOL", formatVolume(position.amountSol)],
      ["Price token", formatVolume(position.tokenPrice)],
      ["Token", position.tokenSymbol ?? "-"],
      ["Contract address", position.tokenAddress],
      ["Amount token", formatVolume(position.tokenAmount)],
      ["TP1 SOL", formatVolume(position.takeProfit1Sol)],
      ["TP2 SOL", formatVolume(position.takeProfit2Sol)],
      ["Status", position.status],
      ["Dibuat", dateFormatter.format(position.createdAt)]
    ];
    const width = Math.max(...rows.map(([key]) => key.length));
    return `${index + 1}.\n<pre>${escapeHtml(rows.map(([key, value]) => `${key.padEnd(width)} : ${value}`).join("\n"))}</pre>`;
  }).join("\n\n");
  await ctx.reply(`Open Trade Positions\n\n${fields}`, { parse_mode: "HTML", reply_markup: menuKeyboard });
}

const VOLUME_PROMPT = "Masukkan volume 24h minimal (angka, contoh: 100000). Ketik 0 jika tanpa filter minimum.";
const walletKeyboard = new InlineKeyboard()
  .text("Balance", "wallet:balance")
  .text("Receive", "wallet:receive")
  .row()
  .text("Send", "wallet:send");
const traderConfigKeyboard = new InlineKeyboard()
  .text("SOL/posisi", "tradecfg:solAmountTradePerPosition")
  .text("Max posisi", "tradecfg:maxTradePositions")
  .row()
  .text("TP1 jual %", "tradecfg:takeProfit1SellPercent")
  .text("TP1 target %", "tradecfg:takeProfit1TargetPercent")
  .row()
  .text("TP2 target %", "tradecfg:takeProfit2TargetPercent")
  .text("Helius API key", "tradecfg:heliusApiKey")
  .row()
  .text("Auto ON/OFF", "tradecfg:statusAutoTradeBot")
  .text("Dry-run ON/OFF", "tradecfg:statusDryRun");

function formatTraderConfig(configValue: Awaited<ReturnType<typeof getTraderConfig>>): string {
  return `Konfigurasi trader\n\nSOL per posisi: ${configValue.solAmountTradePerPosition}\nMaksimal posisi: ${configValue.maxTradePositions}\nTP1 jual: ${configValue.takeProfit1SellPercent}%\nTP1 target: ${configValue.takeProfit1TargetPercent}%\nTP2 target: ${configValue.takeProfit2TargetPercent}%\nHelius RPC: ${configValue.heliusRpcUrl}${configValue.heliusApiKey ? " (API key tersimpan)" : ""}\nAuto-trade: ${configValue.statusAutoTradeBot ? "ON" : "OFF"}\nDry-run: ${configValue.statusDryRun ? "ON" : "OFF"}`;
}

async function replyTraderConfig(ctx: Context): Promise<void> {
  if (!ctx.from) throw new Error("Telegram user tidak tersedia");
  const configValue = await getTraderConfig(ctx.from.id);
  await ctx.reply(formatTraderConfig(configValue), { reply_markup: traderConfigKeyboard });
}

function walletMenuText(walletAddress: string): string {
  return `Wallet SOL\nAddress: <code>${escapeHtml(walletAddress)}</code>\n\nPrivate key disimpan terenkripsi dan tidak ditampilkan oleh bot.`;
}

async function ensureTelegramUser(ctx: Context) {
  if (!ctx.from) throw new Error("Telegram user tidak tersedia");
  const user = await getTelegramUser(ctx.from.id);
  if (!user) throw new Error("Wallet user belum terdaftar");
  return user;
}

async function replyWalletMenu(ctx: Context): Promise<void> {
  const user = await ensureTelegramUser(ctx);
  await ctx.reply(walletMenuText(user.walletAddress), { parse_mode: "HTML", reply_markup: walletKeyboard });
}

const menuText = "Pump.fun bonding curve monitor aktif. Pilih menu:";
bot.command("start", (ctx) => ctx.reply(menuText, { reply_markup: menuKeyboard }));
bot.command("menu", (ctx) => ctx.reply(menuText, { reply_markup: menuKeyboard }));
bot.command("status", (ctx) => ctx.reply(latestScreeningStatus, { reply_markup: menuKeyboard }));
bot.command("latest", (ctx) => {
  pendingVolumeInput.set(ctx.chat.id, "latest");
  return ctx.reply(VOLUME_PROMPT);
});
bot.command("all", (ctx) => sendTimeList(ctx, 1));
bot.command("unbounded", (ctx) => {
  pendingVolumeInput.set(ctx.chat.id, "unbounded");
  return ctx.reply(VOLUME_PROMPT);
});
bot.command("topmentions", async (ctx) => {
  const items = await listTopMentions();
  await ctx.reply(renderTopMentions(items, "Top mention X (Token + Good Unbounded Token)"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});
bot.command("wallet", (ctx) => replyWalletMenu(ctx));
bot.command("configtrade", (ctx) => replyTraderConfig(ctx));
bot.command("early", (ctx) => sendEarlyList(ctx, 1));
bot.command("tradepositions", (ctx) => sendOpenTradePositions(ctx));
bot.on("message:text", async (ctx, next) => {
  if (ctx.from && pendingWalletSend.has(ctx.from.id)) {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length !== 2) {
      await ctx.reply("Format salah. Kirim: alamat_wallet jumlah_SOL");
      return;
    }
    pendingWalletSend.delete(ctx.from.id);
    try {
      const user = await ensureTelegramUser(ctx);
      const signature = await sendSol(user.encryptedPrivateKey, parts[0], Number(parts[1]));
      await ctx.reply(`Transaksi berhasil dikirim.\nSignature: <code>${escapeHtml(signature)}</code>`, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: walletKeyboard });
    } catch (error) {
      await ctx.reply(`Transaksi gagal: ${error instanceof Error ? error.message : "kesalahan tidak diketahui"}`, { reply_markup: walletKeyboard });
    }
    return;
  }
  if (ctx.from && pendingTraderConfig.has(ctx.from.id)) {
    const field = pendingTraderConfig.get(ctx.from.id)!;
    const value = ctx.message.text.trim();
    try {
      if (field === "heliusApiKey") {
        if (!value) throw new Error("API key tidak boleh kosong");
        await updateTraderConfig(ctx.from.id, { heliusApiKey: value, heliusRpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(value)}` });
      } else {
        const numericValue = Number(value.replace(",", "."));
        if (!Number.isFinite(numericValue) || numericValue < 0) throw new Error("Nilai harus berupa angka >= 0");
        if (field === "maxTradePositions" && (!Number.isInteger(numericValue) || numericValue < 1)) throw new Error("Maksimal posisi harus bilangan bulat >= 1");
        await updateTraderConfig(ctx.from.id, { [field]: numericValue });
      }
      pendingTraderConfig.delete(ctx.from.id);
      await replyTraderConfig(ctx);
    } catch (error) {
      await ctx.reply(`Konfigurasi gagal: ${error instanceof Error ? error.message : "kesalahan tidak diketahui"}`, { reply_markup: traderConfigKeyboard });
    }
    return;
  }
  const pending = pendingVolumeInput.get(ctx.chat.id);
  if (!pending) return next();
  const normalized = ctx.message.text.trim().replace(/[.,\s]/g, "");
  if (!/^\d+$/.test(normalized)) return next();
  pendingVolumeInput.delete(ctx.chat.id);
  const minVolume = Number(normalized) || undefined;
  if (pending === "latest") {
    await sendTimeList(ctx, 1, 24, minVolume);
  } else {
    await sendUnboundedList(ctx, 1, minVolume);
  }
});
bot.callbackQuery(/^tokens:time:(24|all):(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const minVolume = Number(ctx.match[3]) || undefined;
  await sendTimeList(ctx, Number(ctx.match[2]), ctx.match[1] === "24" ? 24 : undefined, minVolume);
});
bot.callbackQuery(/^unbounded:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const minVolume = Number(ctx.match[2]) || undefined;
  await sendUnboundedList(ctx, Number(ctx.match[1]), minVolume);
});

bot.hears("Token terbaru", (ctx) => {
  pendingVolumeInput.set(ctx.chat.id, "latest");
  return ctx.reply(VOLUME_PROMPT);
});
bot.hears("Semua token", (ctx) => sendTimeList(ctx, 1));
bot.hears("Top mention X", async (ctx) => {
  const items = await listTopMentions();
  await ctx.reply(renderTopMentions(items, "Top mention X (Token + Good Unbounded Token)"), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: menuKeyboard });
});
bot.hears("Good Unbounded Token", (ctx) => {
  pendingVolumeInput.set(ctx.chat.id, "unbounded");
  return ctx.reply(VOLUME_PROMPT);
});
bot.hears("Status screening", (ctx) => ctx.reply(latestScreeningStatus, { reply_markup: menuKeyboard }));
bot.hears("Wallet", (ctx) => replyWalletMenu(ctx));
bot.hears("Konfigurasi Trade", (ctx) => replyTraderConfig(ctx));
bot.hears("Early Token", (ctx) => sendEarlyList(ctx, 1));
bot.hears("Open Trade Positions", (ctx) => sendOpenTradePositions(ctx));
bot.callbackQuery(/^early:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendEarlyList(ctx, Number(ctx.match[1]));
});
for (const field of ["solAmountTradePerPosition", "maxTradePositions", "takeProfit1SellPercent", "takeProfit1TargetPercent", "takeProfit2TargetPercent", "heliusApiKey"] as const) {
  bot.callbackQuery(`tradecfg:${field}`, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    pendingTraderConfig.set(ctx.from.id, field);
    await ctx.reply(field === "heliusApiKey" ? "Kirim API key Helius:" : `Kirim nilai untuk ${field}:`, { reply_markup: traderConfigKeyboard });
  });
}
bot.callbackQuery("tradecfg:statusAutoTradeBot", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const current = await getTraderConfig(ctx.from.id);
  await updateTraderConfig(ctx.from.id, { statusAutoTradeBot: !current.statusAutoTradeBot });
  await replyTraderConfig(ctx);
});
bot.callbackQuery("tradecfg:statusDryRun", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const current = await getTraderConfig(ctx.from.id);
  await updateTraderConfig(ctx.from.id, { statusDryRun: !current.statusDryRun });
  await replyTraderConfig(ctx);
});
bot.callbackQuery("wallet:balance", async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    const user = await ensureTelegramUser(ctx);
    const balance = await getSolBalance(user.walletAddress);
    await ctx.reply(`Balance: <code>${balance.toFixed(9)} SOL</code>`, { parse_mode: "HTML", reply_markup: walletKeyboard });
  } catch (error) {
    await ctx.reply(`Balance gagal dibaca: ${error instanceof Error ? error.message : "kesalahan tidak diketahui"}`, { reply_markup: walletKeyboard });
  }
});
bot.callbackQuery("wallet:receive", async (ctx) => {
  await ctx.answerCallbackQuery();
  await replyWalletMenu(ctx);
});
bot.callbackQuery("wallet:send", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  pendingWalletSend.add(ctx.from.id);
  await ctx.reply("Kirim dalam satu pesan: alamat_wallet jumlah_SOL\nContoh: 9x... 0.01", { reply_markup: walletKeyboard });
});

export function setLatestScreeningStatus(message: string): void {
  latestScreeningStatus = message;
}

export async function notifyNewToken(token: TokenListItem): Promise<void> {
  const chatIds = await listChatIds();
  if (!chatIds.length) return;
  // The literal "<=" in the header must be HTML-escaped, otherwise Telegram's HTML parser
  // treats "<" as a tag start and rejects the whole message (verified via GrammyError 400 in logs).
  const header = escapeHtml("Token baru 100% bonding curve (bundler <= 20%, dex paid)!");
  const message = `${header}\n\n${renderTokenRow(token, new Date())}`;
  for (const chatId of chatIds) {
    try {
      await bot.api.sendMessage(chatId, message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
      console.error(`Gagal mengirim notifikasi ke chat ${chatId}:`, error);
    }
  }
}

export async function notifyNewUnboundedToken(token: UnboundedTokenListItem): Promise<void> {
  const chatIds = await listChatIds();
  if (!chatIds.length) return;
  const header = escapeHtml("Good Unbounded Token terdeteksi (bonding curve belum 100%, dex paid, bundler <= 20%, organik, rug risk rendah, volume >= 20000)!");
  const message = `${header}\n\n${renderUnboundedTokenRow(token, new Date())}`;
  for (const chatId of chatIds) {
    try {
      await bot.api.sendMessage(chatId, message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
      console.error(`Gagal mengirim notifikasi unbounded ke chat ${chatId}:`, error);
    }
  }
}

export async function notifyNewEarlyToken(token: EarlyTokenListItem): Promise<void> {
  const chatIds = await listChatIds();
  if (!chatIds.length) return;
  const header = escapeHtml("Early token terdeteksi (MCAP 2.000-<3.000 USD, belum ada ATH, volume >= 20.000 USD, X mentions >= 1)!");
  const message = `${header}\n\n${renderEarlyTokenRow(token, new Date())}`;
  for (const chatId of chatIds) {
    try {
      await bot.api.sendMessage(chatId, message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
      console.error(`Gagal mengirim notifikasi early token ke chat ${chatId}:`, error);
    }
  }
}

export { bot };
