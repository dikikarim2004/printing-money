import { Bot, Context, InlineKeyboard } from "grammy";
import { config } from "./config.js";
import { hasNextPage, listTokens } from "./repository.js";
import type { TokenListItem } from "./types.js";

const bot = new Bot(config.TELEGRAM_BOT_TOKEN);
const dateFormatter = new Intl.DateTimeFormat("id-ID", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });

function render(tokens: TokenListItem[], title: string): string {
  if (!tokens.length) return `${title}\n\nBelum ada token tersimpan.`;
  return `${title}\n\n${tokens.map((token, index) => `${index + 1}. <a href="${token.pumpUrl}">${token.symbol ?? token.name ?? token.address.slice(0, 8)}</a>\n   <code>${token.address}</code>\n   Bonding: ${dateFormatter.format(token.bondingAt)} UTC | X mentions: ${token.xMentionCount ?? "-"}`).join("\n\n")}`;
}

async function sendTimeList(ctx: Context, page: number): Promise<void> {
  const tokens = await listTokens("time", page);
  const keyboard = new InlineKeyboard();
  if (page > 1) keyboard.text("Previous", `tokens:time:${page - 1}`);
  if (await hasNextPage(page)) keyboard.text("Continue", `tokens:time:${page + 1}`);
  await ctx.reply(render(tokens, `Token bonding curve, halaman ${page}`), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
}

bot.command("start", (ctx) => ctx.reply("Pump.fun bonding curve monitor aktif.\n\n/latest - 10 terbaru\n/all - semua token per halaman\n/topmentions - 10 mention X terbanyak"));
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

export { bot };
