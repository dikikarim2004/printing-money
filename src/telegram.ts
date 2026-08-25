import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { config } from "./config.js";
import { hasNextPage, listTokens } from "./repository.js";
import type { TokenListItem } from "./types.js";

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
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

function render(tokens: TokenListItem[], title: string): string {
  if (!tokens.length) return `${title}\n\nBelum ada token tersimpan.`;
  return `${escapeHtml(title)}\n\n${tokens.map((token, index) => `${index + 1}. <a href="${escapeHtml(token.pumpUrl)}">${escapeHtml(token.symbol ?? token.name ?? token.address.slice(0, 8))}</a>\n   <code>${escapeHtml(token.address)}</code>\n   Bonding: ${dateFormatter.format(token.bondingAt)} UTC | X mentions: ${token.xMentionCount ?? "-"}`).join("\n\n")}`;
}

async function sendTimeList(ctx: Context, page: number): Promise<void> {
  const tokens = await listTokens("time", page);
  const keyboard = new InlineKeyboard();
  if (page > 1) keyboard.text("Previous", `tokens:time:${page - 1}`);
  if (await hasNextPage(page)) keyboard.text("Continue", `tokens:time:${page + 1}`);
  await ctx.reply(render(tokens, `Token bonding curve, halaman ${page}`), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
}

const menuText = "Pump.fun bonding curve monitor aktif. Pilih menu:";
bot.command("start", (ctx) => ctx.reply(menuText, { reply_markup: menuKeyboard }));
bot.command("menu", (ctx) => ctx.reply(menuText, { reply_markup: menuKeyboard }));
bot.command("status", (ctx) => ctx.reply(latestScreeningStatus, { reply_markup: menuKeyboard }));
bot.command("latest", (ctx) => sendTimeList(ctx, 1));
bot.command("all", (ctx) => sendTimeList(ctx, 1));
bot.command("topmentions", async (ctx) => {
  const tokens = await listTokens("mentions", 1);
  await ctx.reply(render(tokens, "Top 10 berdasarkan mention X"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});
bot.callbackQuery(/^tokens:time:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendTimeList(ctx, Number(ctx.match[1]));
});

bot.hears("Token terbaru", (ctx) => sendTimeList(ctx, 1));
bot.hears("Semua token", (ctx) => sendTimeList(ctx, 1));
bot.hears("Top mention X", async (ctx) => {
  const tokens = await listTokens("mentions", 1);
  await ctx.reply(render(tokens, "Top 10 berdasarkan mention X"), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: menuKeyboard });
});
bot.hears("Status screening", (ctx) => ctx.reply(latestScreeningStatus, { reply_markup: menuKeyboard }));

export function setLatestScreeningStatus(message: string): void {
  latestScreeningStatus = message;
}

export { bot };
