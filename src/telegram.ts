import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { config } from "./config.js";
import { hasNextPage, hasNextUnboundedPage, listChatIds, listTokens, listTopMentions, listUnboundedTokens, registerChat } from "./repository.js";
import type { TokenListItem, UnboundedTokenListItem } from "./types.js";

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
  await next();
});
const dateFormatter = new Intl.DateTimeFormat("id-ID", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
let latestScreeningStatus = "Screening belum berjalan.";
// Chat is waiting to type a minimum-volume number after tapping "Token terbaru" or "Good Unbounded Token".
const pendingVolumeInput = new Map<number, "latest" | "unbounded">();
const menuKeyboard = new Keyboard()
  .text("Token terbaru")
  .text("Semua token")
  .row()
  .text("Top mention X")
  .text("Status screening")
  .row()
  .text("Good Unbounded Token")
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
function renderUnboundedTokenRow(token: UnboundedTokenListItem, now: Date): string {
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

function renderUnbounded(tokens: UnboundedTokenListItem[], title: string): string {
  if (!tokens.length) return `${escapeHtml(title)}\n\nBelum ada token tersimpan.`;
  const now = new Date();
  return `${escapeHtml(title)}\n\n${tokens.map((token, index) => `${index + 1}. ${renderUnboundedTokenRow(token, now)}`).join("\n\n")}`;
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

const VOLUME_PROMPT = "Masukkan volume 24h minimal (angka, contoh: 100000). Ketik 0 jika tanpa filter minimum.";

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
bot.on("message:text", async (ctx, next) => {
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

export { bot };
