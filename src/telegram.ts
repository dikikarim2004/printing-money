import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { config } from "./config.js";
import { hasNextPage, listChatIds, listTokens, registerChat } from "./repository.js";
import type { TokenListItem } from "./types.js";

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
const menuKeyboard = new Keyboard()
  .text("Token terbaru")
  .text("Semua token")
  .row()
  .text("Top mention X")
  .text("Status screening")
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

// Telegram's HTML subset has no <table>; a <pre> block of aligned "label : value" lines is the closest table-like rendering.
// Address is kept in its own <code> span (outside the <pre> table) so tap-to-copy copies only the full contract address.
function renderTokenRow(token: TokenListItem, now: Date): string {
  const label = token.symbol ?? token.name ?? token.address.slice(0, 8);
  const fields: [string, string][] = [
    ["Symbol", label],
    ["100% pada", `${dateFormatter.format(token.bondingAt)} UTC`],
    ["Sudah berjalan", formatElapsed(token.bondingAt, now)],
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

async function sendTimeList(ctx: Context, page: number, windowHours?: number): Promise<void> {
  const tokens = await listTokens("time", page, 10, windowHours);
  const keyboard = new InlineKeyboard();
  const windowToken = windowHours ? String(windowHours) : "all";
  if (page > 1) keyboard.text("Previous", `tokens:time:${windowToken}:${page - 1}`);
  if (await hasNextPage(page, 10, windowHours)) keyboard.text("Continue", `tokens:time:${windowToken}:${page + 1}`);
  const title = windowHours ? `Token terbaru (24 jam terakhir), halaman ${page}` : `Semua token bonding curve, halaman ${page}`;
  await ctx.reply(render(tokens, title), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
}

const menuText = "Pump.fun bonding curve monitor aktif. Pilih menu:";
bot.command("start", (ctx) => ctx.reply(menuText, { reply_markup: menuKeyboard }));
bot.command("menu", (ctx) => ctx.reply(menuText, { reply_markup: menuKeyboard }));
bot.command("status", (ctx) => ctx.reply(latestScreeningStatus, { reply_markup: menuKeyboard }));
bot.command("latest", (ctx) => sendTimeList(ctx, 1, 24));
bot.command("all", (ctx) => sendTimeList(ctx, 1));
bot.command("topmentions", async (ctx) => {
  const tokens = await listTokens("mentions", 1);
  await ctx.reply(render(tokens, "Top 10 berdasarkan mention X"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});
bot.callbackQuery(/^tokens:time:(24|all):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendTimeList(ctx, Number(ctx.match[2]), ctx.match[1] === "24" ? 24 : undefined);
});

bot.hears("Token terbaru", (ctx) => sendTimeList(ctx, 1, 24));
bot.hears("Semua token", (ctx) => sendTimeList(ctx, 1));
bot.hears("Top mention X", async (ctx) => {
  const tokens = await listTokens("mentions", 1);
  await ctx.reply(render(tokens, "Top 10 berdasarkan mention X"), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: menuKeyboard });
});
bot.hears("Status screening", (ctx) => ctx.reply(latestScreeningStatus, { reply_markup: menuKeyboard }));

export function setLatestScreeningStatus(message: string): void {
  latestScreeningStatus = message;
}

export async function notifyNewToken(token: TokenListItem): Promise<void> {
  const chatIds = await listChatIds();
  if (!chatIds.length) return;
  const message = `Token baru 100% bonding curve (bundler <= 20%, dex paid)!\n\n${renderTokenRow(token, new Date())}`;
  for (const chatId of chatIds) {
    try {
      await bot.api.sendMessage(chatId, message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
      console.error(`Gagal mengirim notifikasi ke chat ${chatId}:`, error);
    }
  }
}

export { bot };
