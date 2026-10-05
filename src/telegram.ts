import { Bot, Context, InlineKeyboard, Keyboard } from "grammy";
import { config } from "./config.js";
import { addWallet, getActiveWallet, getTelegramUser, getTraderConfig, getUserFeedConfig, getWallet, hasNextEarlyPage, hasNextPage, hasNextUnboundedPage, listEarlyTokens, listOpenTradePositions, listTelegramUserIds, listTokens, listTopMentions, listUnboundedTokens, listWallets, registerChat, registerTelegramUser, setActiveWallet, updateTraderConfig, updateUserFeedConfig } from "./repository.js";
import { exportPrivateKey, getRobinhoodBalance, getSolBalance, importWalletForChain, sendSol } from "./wallet.js";
import { formatUserTradeError, manualBuyForUser, manualSellForUser } from "./autotrade.js";
import { SUPPORTED_CHAINS, type EarlyTokenListItem, type TokenListItem, type UnboundedTokenListItem } from "./types.js";

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
const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "short", timeStyle: "short", timeZone: "UTC" });
let latestScreeningStatus = "Screening has not started yet.";
// Chat is waiting to type a minimum-volume number after tapping "Token terbaru" or "Good Unbounded Token".
const pendingVolumeInput = new Map<number, "latest" | "unbounded">();
const pendingWalletSend = new Set<number>();
const pendingWalletImport = new Map<number, "SOLANA" | "ROBINHOOD">();
const pendingWalletSendSelection = new Map<number, string>();
type TraderConfigField = "solAmountTradePerPosition" | "ethAmountTradePerPosition" | "maxTradePositions" | "takeProfit1SellPercent" | "takeProfit1TargetPercent" | "takeProfit2TargetPercent" | "heliusApiKey";
const pendingTraderConfig = new Map<number, TraderConfigField>();
const feedConfigFields = ["completedTypes", "completedLimit", "completedMaxBundlerRate", "completedMaxBondingAgeHours", "completedMaxTokenAgeHours", "completedMinXMentions", "unboundedTypes", "unboundedLimit", "unboundedMaxBundlerRate", "unboundedMaxRugRatio", "unboundedMinVolume24h", "unboundedMaxTokenAgeHours", "unboundedMinXMentions", "earlyTypes", "earlyLimit", "earlyMinMarketCap", "earlyMaxMarketCap", "earlyMinVolume24h", "earlyMaxTokenAgeMinutes", "earlyMinXMentions"] as const;
type FeedConfigField = typeof feedConfigFields[number];
const pendingFeedConfig = new Map<number, FeedConfigField>();
const menuKeyboard = new Keyboard()
  .text("📡 Latest Tokens")
  .text("📚 All Tokens")
  .row()
  .text("🔥 Top X Mentions")
  .text("📊 Screening Status")
  .row()
  .text("🚀 Unbounded Feed")
  .row()
  .text("🌱 Early Feed")
  .row()
  .text("👛 Wallets")
  .row()
  .text("⚙️ Trade Config")
  .row()
  .text("📈 Open Positions")
  .row()
  .text("🧩 Feed Config")
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
  if (days > 0) parts.push(`${days} day${days === 1 ? "" : "s"}`);
  if (days > 0 || hours > 0) parts.push(`${hours} hour${hours === 1 ? "" : "s"}`);
  parts.push(`${minutes} minute${minutes === 1 ? "" : "s"}`);
  return `${parts.join(" ")} ago`;
}

function formatVolume(volume: number | null | undefined): string {
  return volume === null || volume === undefined ? "-" : volume.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function selectedGmgnChain(feedChain: string): string {
  return feedChain === "ROBINHOOD" ? config.ROBINHOOD_GMGN_CHAIN : config.GMGN_CHAIN;
}

function displayChain(chain?: string): string {
  return chain === config.ROBINHOOD_GMGN_CHAIN ? "ROBINHOOD" : "SOLANA";
}

function tokenLinkLabel(chain?: string): string {
  return "Open on Pump.fun";
}

// Telegram's HTML subset has no <table>; a <pre> block of aligned "label : value" lines is the closest table-like rendering.
// Address is kept in its own <code> span (outside the <pre> table) so tap-to-copy copies only the full contract address.
function renderTokenRow(token: TokenListItem, now: Date): string {
  const label = token.symbol ?? token.name ?? token.address.slice(0, 8);
  const fields: [string, string][] = [
    ["Chain", displayChain(token.chain)],
    ["Symbol", label],
    ["Reached 100%", `${dateFormatter.format(token.bondingAt)} UTC`],
    ["Elapsed", formatElapsed(token.bondingAt, now)],
    ["Rug ratio", token.rugRatio !== undefined ? token.rugRatio.toFixed(3) : "-"],
    ["Market Cap (USD)", formatVolume(token.marketCap)],
    ["ATH Market Cap (USD)", formatVolume(token.athMarketCap)],
    ["Volume 24h (USD)", formatVolume(token.jumlah_volume)],
    ["X mentions", String(token.xMentionCount ?? "-")]
  ];
  const labelWidth = Math.max(...fields.map(([key]) => key.length));
  const table = fields.map(([key, value]) => `${key.padEnd(labelWidth)} : ${value}`).join("\n");
  return `<pre>${escapeHtml(table)}</pre>\nAddress: <code>${escapeHtml(token.address)}</code>\n<a href="${escapeHtml(token.pumpUrl)}">${tokenLinkLabel(token.chain)}</a>`;
}

function render(tokens: TokenListItem[], title: string): string {
  if (!tokens.length) return `${escapeHtml(title)}\n\nNo tokens stored.`;
  const now = new Date();
  return `${escapeHtml(title)}\n\n${tokens.map((token, index) => `${index + 1}. ${renderTokenRow(token, now)}`).join("\n\n")}`;
}

// Good Unbounded Token: bonding curve not yet 100%, but dex paid, bundler <= 20%, organic, low rug risk.
function renderUnboundedTokenRow(token: UnboundedTokenListItem | EarlyTokenListItem, now: Date): string {
  const label = token.symbol ?? token.name ?? token.address.slice(0, 8);
  const fields: [string, string][] = [
    ["Chain", displayChain(token.chain)],
    ["Symbol", label],
    ["Progress", `${(token.progress * 100).toFixed(1)}%`],
    ["Rug ratio", token.rugRatio !== undefined ? token.rugRatio.toFixed(3) : "-"],
    ["Market Cap (USD)", formatVolume(token.marketCap)],
    ["ATH Market Cap (USD)", formatVolume(token.athMarketCap)],
    ["Detected at", `${dateFormatter.format(token.createdAt)} UTC`],
    ["Elapsed", formatElapsed(token.createdAt, now)],
    ["Volume 24h (USD)", formatVolume(token.jumlah_volume)],
    ["X mentions", String(token.xMentionCount ?? "-")]
  ];
  const labelWidth = Math.max(...fields.map(([key]) => key.length));
  const table = fields.map(([key, value]) => `${key.padEnd(labelWidth)} : ${value}`).join("\n");
  return `<pre>${escapeHtml(table)}</pre>\nAddress: <code>${escapeHtml(token.address)}</code>\n<a href="${escapeHtml(token.pumpUrl)}">${tokenLinkLabel(token.chain)}</a>`;
}

function renderUnbounded(tokens: Array<UnboundedTokenListItem | EarlyTokenListItem>, title: string): string {
  if (!tokens.length) return `${escapeHtml(title)}\n\nNo tokens stored.`;
  const now = new Date();
  return `${escapeHtml(title)}\n\n${tokens.map((token, index) => `${index + 1}. ${renderUnboundedTokenRow(token, now)}`).join("\n\n")}`;
}

function renderEarlyTokenRow(token: EarlyTokenListItem, now: Date): string {
  const label = token.symbol ?? token.name ?? token.address.slice(0, 8);
  const fields: [string, string][] = [
    ["Chain", displayChain(token.chain)],
    ["Symbol", label],
    ["Progress", `${(token.progress * 100).toFixed(1)}%`],
    ["Market Cap (USD)", formatVolume(token.marketCap)],
    ["ATH Market Cap (USD)", formatVolume(token.athMarketCap)],
    ["Detected at", `${dateFormatter.format(token.createdAt)} UTC`],
    ["Elapsed", formatElapsed(token.createdAt, now)],
    ["Volume 24h (USD)", formatVolume(token.jumlah_volume)],
    ["X mentions", String(token.xMentionCount ?? "-")]
  ];
  const labelWidth = Math.max(...fields.map(([key]) => key.length));
  const table = fields.map(([key, value]) => `${key.padEnd(labelWidth)} : ${value}`).join("\n");
  return `<pre>${escapeHtml(table)}</pre>\nAddress: <code>${escapeHtml(token.address)}</code>\n<a href="${escapeHtml(token.pumpUrl)}">${tokenLinkLabel(token.chain)}</a>`;
}

function renderEarlyTokens(tokens: EarlyTokenListItem[], title: string): string {
  if (!tokens.length) return `${escapeHtml(title)}\n\nNo tokens stored.`;
  const now = new Date();
  return `${escapeHtml(title)}\n\n${tokens.map((token, index) => `${index + 1}. ${renderEarlyTokenRow(token, now)}`).join("\n\n")}`;
}

function isCompletedToken(item: TokenListItem | UnboundedTokenListItem): item is TokenListItem {
  return "bondingAt" in item;
}

// Point 2: renders the combined Token + TokenUnboundedFilter "Top mention X" list, dispatching per item type.
function renderTopMentions(items: Array<TokenListItem | UnboundedTokenListItem>, title: string): string {
  if (!items.length) return `${escapeHtml(title)}\n\nNo tokens stored.`;
  const now = new Date();
  return `${escapeHtml(title)}\n\n${items.map((item, index) => `${index + 1}. ${isCompletedToken(item) ? renderTokenRow(item, now) : renderUnboundedTokenRow(item, now)}`).join("\n\n")}`;
}

async function sendTimeList(ctx: Context, page: number, windowHours?: number, minVolume?: number): Promise<void> {
  const feed = ctx.from ? await getUserFeedConfig(ctx.from.id) : undefined;
  const chain = feed ? selectedGmgnChain(feed.chain) : config.GMGN_CHAIN;
  const tokens = await listTokens("time", page, 10, windowHours, minVolume, chain);
  const keyboard = new InlineKeyboard();
  const windowToken = windowHours ? String(windowHours) : "all";
  const volumeToken = minVolume ?? 0;
  if (page > 1) keyboard.text("Previous", `tokens:time:${windowToken}:${page - 1}:${volumeToken}`);
  if (await hasNextPage(page, 10, windowHours, minVolume, chain)) keyboard.text("Continue", `tokens:time:${windowToken}:${page + 1}:${volumeToken}`);
  const volumeSuffix = minVolume ? ` (volume >= ${minVolume.toLocaleString("en-US")})` : "";
  const title = windowHours ? `📡 Latest ${displayChain(chain)} tokens (last 24 hours)${volumeSuffix}, page ${page}` : `📚 All ${displayChain(chain)} bonding-curve tokens, page ${page}`;
  await ctx.reply(render(tokens, title), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
}

async function sendUnboundedList(ctx: Context, page: number, minVolume?: number): Promise<void> {
  const feed = ctx.from ? await getUserFeedConfig(ctx.from.id) : undefined;
  const chain = feed ? selectedGmgnChain(feed.chain) : config.GMGN_CHAIN;
  if (minVolume === undefined && feed) minVolume = feed.unboundedMinVolume24h;
  const tokens = await listUnboundedTokens(page, 10, minVolume, chain);
  const keyboard = new InlineKeyboard();
  const volumeToken = minVolume ?? 0;
  if (page > 1) keyboard.text("Previous", `unbounded:${page - 1}:${volumeToken}`);
  if (await hasNextUnboundedPage(page, 10, minVolume, chain)) keyboard.text("Continue", `unbounded:${page + 1}:${volumeToken}`);
  const volumeSuffix = minVolume ? ` (volume >= ${minVolume.toLocaleString("en-US")})` : "";
  const title = `🚀 ${displayChain(chain)} unbounded tokens (below 100%, DEX paid, organic)${volumeSuffix}, page ${page}`;
  await ctx.reply(renderUnbounded(tokens, title), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
}

async function sendEarlyList(ctx: Context, page: number): Promise<void> {
  const feed = ctx.from ? await getUserFeedConfig(ctx.from.id) : undefined;
  const chain = feed ? selectedGmgnChain(feed.chain) : config.GMGN_CHAIN;
  const tokens = await listEarlyTokens(page, 10, feed?.earlyMinVolume24h, feed?.earlyMinMarketCap, feed?.earlyMaxMarketCap, chain);
  const keyboard = new InlineKeyboard();
  if (page > 1) keyboard.text("Previous", `early:${page - 1}`);
  if (await hasNextEarlyPage(page, 10, feed?.earlyMinVolume24h, feed?.earlyMinMarketCap, feed?.earlyMaxMarketCap, chain)) keyboard.text("Continue", `early:${page + 1}`);
  await ctx.reply(renderEarlyTokens(tokens, `🌱 ${displayChain(chain)} early tokens (configured market cap and volume filters), page ${page}`), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: keyboard });
}

async function sendOpenTradePositions(ctx: Context): Promise<void> {
  if (!ctx.from) throw new Error("Telegram user tidak tersedia");
  const positions = await listOpenTradePositions(ctx.from.id);
  if (!positions.length) {
    await ctx.reply("📈 Open Trade Positions\n\nYou have no open positions.", { reply_markup: menuKeyboard });
    return;
  }
  const fields = positions.map((position, index) => {
    const rows = [
      ["Chain", displayChain(position.chain)],
      ["Trade ID", position.id],
      ["Transaction hash", position.txHash ?? "-"],
      ["Telegram ID", position.telegramId.toString()],
      ["Amount SOL", formatVolume(position.amountSol)],
      ["Price token", formatVolume(position.tokenPrice)],
      ["Token", position.tokenSymbol ?? "-"],
      ["Contract address", position.tokenAddress],
      ["Amount token", formatVolume(position.tokenAmount)],
      ["TP1 SOL", formatVolume(position.takeProfit1Sol)],
      ["TP2 SOL", formatVolume(position.takeProfit2Sol)],
      ["Status", position.status],
      ["Created", dateFormatter.format(position.createdAt)]
    ];
    const width = Math.max(...rows.map(([key]) => key.length));
    return `${index + 1}.\n<pre>${escapeHtml(rows.map(([key, value]) => `${key.padEnd(width)} : ${value}`).join("\n"))}</pre>`;
  }).join("\n\n");
  await ctx.reply(`Open Trade Positions\n\n${fields}`, { parse_mode: "HTML", reply_markup: menuKeyboard });
}

const VOLUME_PROMPT = "Enter the minimum 24h volume (for example: 100000). Enter 0 for no minimum.";
const walletKeyboard = new InlineKeyboard()
  .text("💰 Balance", "wallet:balance")
  .text("📥 Receive", "wallet:receive")
  .row()
  .text("📤 Send", "wallet:send")
  .row()
  .text("➕ Import wallet", "wallet:import:choose");
const feedConfigKeyboard = new InlineKeyboard()
  .text("⛓️ Chain", "feedcfg:chain")
  .row()
  .text("✅ Completed filters", "feedcfg:group:completed")
  .text("🚀 Unbounded filters", "feedcfg:group:unbounded")
  .row()
  .text("🌱 Early filters", "feedcfg:group:early");
const traderConfigKeyboard = new InlineKeyboard()
  .text("SOL / position", "tradecfg:solAmountTradePerPosition")
  .text("ETH / position", "tradecfg:ethAmountTradePerPosition")
  .text("Max positions", "tradecfg:maxTradePositions")
  .row()
  .text("TP1 sell %", "tradecfg:takeProfit1SellPercent")
  .text("TP1 target %", "tradecfg:takeProfit1TargetPercent")
  .row()
  .text("TP2 target %", "tradecfg:takeProfit2TargetPercent")
  .text("Helius API key", "tradecfg:heliusApiKey")
  .row()
  .text("Auto-trade feed", "tradecfg:autoTradeFeed")
  .text("Auto ON/OFF", "tradecfg:statusAutoTradeBot")
  .text("Dry-run ON/OFF", "tradecfg:statusDryRun");

function formatTraderConfig(configValue: Awaited<ReturnType<typeof getTraderConfig>>): string {
  return `⚙️ Trade configuration\n\nSOL per position: ${configValue.solAmountTradePerPosition}\nETH per position: ${configValue.ethAmountTradePerPosition}\nAuto-trade feed: ${configValue.autoTradeFeed}\nMaximum positions per chain: ${configValue.maxTradePositions}\nTP1 sell: ${configValue.takeProfit1SellPercent}%\nTP1 target: ${configValue.takeProfit1TargetPercent}%\nTP2 target: ${configValue.takeProfit2TargetPercent}%\nHelius RPC: ${configValue.heliusRpcUrl}${configValue.heliusApiKey ? " (API key saved)" : ""}\nAuto-trade: ${configValue.statusAutoTradeBot ? "ON" : "OFF"}\nDry-run: ${configValue.statusDryRun ? "ON" : "OFF"}`;
}

function formatFeedConfig(value: Awaited<ReturnType<typeof getUserFeedConfig>>): string {
  return `🧩 Feed configuration\n\nChain: ${value.chain}\nCompleted: ${value.completedTypes}, max age ${value.completedMaxBondingAgeHours}h, X mentions >= ${value.completedMinXMentions}\nUnbounded: ${value.unboundedTypes}, volume >= ${value.unboundedMinVolume24h}, X mentions >= ${value.unboundedMinXMentions}\nEarly: ${value.earlyTypes}, market cap ${value.earlyMinMarketCap}-${value.earlyMaxMarketCap}, volume >= ${value.earlyMinVolume24h}, X mentions >= ${value.earlyMinXMentions}`;
}

function feedFieldValue(value: Awaited<ReturnType<typeof getUserFeedConfig>>, field: FeedConfigField): string {
  return String(value[field]);
}

function feedFieldExample(field: FeedConfigField): string {
  if (field.endsWith("Types")) return "completed";
  if (field.endsWith("Limit")) return "80";
  if (field.includes("Volume")) return "20000";
  if (field.includes("MarketCap")) return field.includes("Max") ? "3000" : "2000";
  if (field.includes("Mentions")) return "1";
  if (field.includes("BundlerRate") || field.includes("RugRatio")) return "0.2";
  if (field.includes("Age")) return field.includes("Minutes") ? "15" : "24";
  return "0";
}

async function replyFeedConfig(ctx: Context): Promise<void> {
  if (!ctx.from) throw new Error("Telegram user is unavailable");
  const value = await getUserFeedConfig(ctx.from.id);
  await ctx.reply(formatFeedConfig(value), { reply_markup: feedConfigKeyboard });
}

async function replyTraderConfig(ctx: Context): Promise<void> {
  if (!ctx.from) throw new Error("Telegram user is unavailable");
  const configValue = await getTraderConfig(ctx.from.id);
  await ctx.reply(formatTraderConfig(configValue), { reply_markup: traderConfigKeyboard });
}

function walletMenuText(walletAddress: string): string {
  return `👛 Multichain wallets\nLegacy SOL wallet: <code>${escapeHtml(walletAddress)}</code>\n\nPrivate keys are encrypted and never displayed.`;
}

async function ensureTelegramUser(ctx: Context) {
  if (!ctx.from) throw new Error("Telegram user tidak tersedia");
  const user = await getTelegramUser(ctx.from.id);
  if (!user) throw new Error("User wallet is not registered");
  return user;
}

async function replyWalletMenu(ctx: Context): Promise<void> {
  const user = await ensureTelegramUser(ctx);
  const wallets = await listWallets(Number(user.telegramId));
  const activeSolana = await getActiveWallet(Number(user.telegramId), "SOLANA");
  const activeRobinhood = await getActiveWallet(Number(user.telegramId), "ROBINHOOD");
  const walletLines = wallets.length ? wallets.map((wallet) => {
    const active = wallet.id === activeSolana?.id || wallet.id === activeRobinhood?.id;
    return `${active ? "✅" : "▫️"} ${wallet.label ?? "Wallet"} [${wallet.chain}] <code>${escapeHtml(wallet.walletAddress)}</code>`;
  }).join("\n") : "No imported wallets yet.";
  const walletActions = new InlineKeyboard();
  for (const wallet of wallets) {
    const active = wallet.id === activeSolana?.id || wallet.id === activeRobinhood?.id;
    walletActions.text(active ? `✅ ${wallet.chain} active` : `Use ${wallet.chain}`, `wallet:active:${wallet.id}`).row();
    walletActions.text(`💰 ${wallet.chain} balance`, `wallet:balance:${wallet.id}`).row();
    walletActions.text(`📤 ${wallet.chain} send`, `wallet:send:${wallet.id}`).row();
    if (active) walletActions.text(`🔐 Export ${wallet.chain} private key`, `wallet:export:${wallet.id}`).row();
  }
  walletActions.text("➕ Import wallet", "wallet:import:choose");
  await ctx.reply(`${walletMenuText(user.walletAddress)}\n\n✅ = wallet aktif untuk chain tersebut.\n\nWallets:\n${walletLines}`, { parse_mode: "HTML", reply_markup: walletActions });
}

const menuText = "🚦 Memecoin monitor is online. Choose an action:";
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
  const feed = ctx.from ? await getUserFeedConfig(ctx.from.id) : undefined;
  const items = await listTopMentions(10, feed ? selectedGmgnChain(feed.chain) : config.GMGN_CHAIN);
  await ctx.reply(renderTopMentions(items, `🔥 ${feed ? displayChain(feed.chain) : "SOLANA"} top X mentions`), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});
bot.command("wallet", (ctx) => replyWalletMenu(ctx));
bot.command("wallets", (ctx) => replyWalletMenu(ctx));
bot.command("configtrade", (ctx) => replyTraderConfig(ctx));
bot.command("configsystem", (ctx) => replyFeedConfig(ctx));
bot.command("cancel", async (ctx) => {
  if (ctx.from) {
    pendingFeedConfig.delete(ctx.from.id);
    pendingWalletImport.delete(ctx.from.id);
    pendingWalletSendSelection.delete(ctx.from.id);
  }
  await ctx.reply("Cancelled. No changes were made.", { reply_markup: menuKeyboard });
});
bot.command("early", (ctx) => sendEarlyList(ctx, 1));
bot.command("tradepositions", (ctx) => sendOpenTradePositions(ctx));
bot.command("buy", async (ctx) => {
  if (!ctx.from) throw new Error("Telegram user tidak tersedia");
  const tokenAddress = ctx.match.trim();
  if (!tokenAddress) {
    await ctx.reply("Usage: /buy contract-address", { reply_markup: menuKeyboard });
    return;
  }
  try {
    const result = await manualBuyForUser(tokenAddress, ctx.from.id);
    const mode = result.dryRun ? "DRY-RUN" : "BUY";
    const reference = result.signature ?? result.requestId ?? "no signature";
    await ctx.reply(`Manual ${mode} succeeded\nToken: <code>${escapeHtml(tokenAddress)}</code>\nReference: <code>${escapeHtml(reference)}</code>`, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: menuKeyboard });
  } catch (error) {
    await ctx.reply(`Manual BUY failed: ${escapeHtml(formatUserTradeError("BUY", error))}`, { parse_mode: "HTML", reply_markup: menuKeyboard });
  }
});
bot.command("sell", async (ctx) => {
  if (!ctx.from) throw new Error("Telegram user tidak tersedia");
  const tokenAddress = ctx.match.trim();
  if (!tokenAddress) {
    await ctx.reply("Usage: /sell contract-address", { reply_markup: menuKeyboard });
    return;
  }
  try {
    const result = await manualSellForUser(tokenAddress, ctx.from.id);
    const mode = result.dryRun ? "DRY-RUN" : "SELL";
    const reference = result.signature ?? result.requestId ?? "no signature";
    const positionStatus = result.dryRun ? "Trade position was not changed because dry-run is enabled." : "Related trade positions were marked CLOSED.";
    await ctx.reply(`Manual ${mode} succeeded\nToken: <code>${escapeHtml(tokenAddress)}</code>\nReference: <code>${escapeHtml(reference)}</code>\n${positionStatus}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: menuKeyboard });
  } catch (error) {
    await ctx.reply(`Manual SELL failed: ${escapeHtml(formatUserTradeError("SELL", error))}`, { parse_mode: "HTML", reply_markup: menuKeyboard });
  }
});
bot.on("message:text", async (ctx, next) => {
  if (ctx.from && pendingWalletImport.has(ctx.from.id)) {
    const chain = pendingWalletImport.get(ctx.from.id)!;
    pendingWalletImport.delete(ctx.from.id);
    try {
      const wallet = importWalletForChain(chain, ctx.message.text);
      await addWallet(ctx.from.id, chain, wallet.address, wallet.encryptedPrivateKey);
      await ctx.reply(`Wallet imported successfully.\nChain: ${chain}\nAddress: <code>${escapeHtml(wallet.address)}</code>`, { parse_mode: "HTML", reply_markup: walletKeyboard });
    } catch (error) {
      await ctx.reply(`Wallet import failed: ${error instanceof Error ? error.message : "unknown error"}`, { reply_markup: walletKeyboard });
    }
    return;
  }
  if (ctx.from && pendingWalletSendSelection.has(ctx.from.id)) {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length !== 2) {
      await ctx.reply("Invalid format. Send: wallet_address amount_SOL");
      return;
    }
    const walletId = pendingWalletSendSelection.get(ctx.from.id)!;
    pendingWalletSendSelection.delete(ctx.from.id);
    try {
      const wallet = await getWallet(ctx.from.id, walletId);
      if (!wallet || wallet.chain !== "SOLANA") throw new Error("Selected wallet is not available for Solana transfers");
      const signature = await sendSol(wallet.encryptedPrivateKey, parts[0], Number(parts[1]));
      await ctx.reply(`Transaction sent successfully.\nSignature: <code>${escapeHtml(signature)}</code>`, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: walletKeyboard });
    } catch (error) {
      await ctx.reply(`Transaction failed: ${error instanceof Error ? error.message : "unknown error"}`, { reply_markup: walletKeyboard });
    }
    return;
  }
  if (ctx.from && pendingFeedConfig.has(ctx.from.id)) {
    const field = pendingFeedConfig.get(ctx.from.id)!;
    const value = ctx.message.text.trim();
    try {
      const textFields: FeedConfigField[] = ["completedTypes", "unboundedTypes", "earlyTypes"];
      const update = textFields.includes(field) ? { [field]: value } : { [field]: Number(value.replace(",", ".")) };
      if (!textFields.includes(field) && (!Number.isFinite(update[field]) || Number(update[field]) < 0)) throw new Error("Value must be a number greater than or equal to 0");
      await getUserFeedConfig(ctx.from.id);
      await updateUserFeedConfig(ctx.from.id, update);
      pendingFeedConfig.delete(ctx.from.id);
      await replyFeedConfig(ctx);
    } catch (error) {
      await ctx.reply(`Feed configuration failed: ${error instanceof Error ? error.message : "unknown error"}`, { reply_markup: feedConfigKeyboard });
    }
    return;
  }
  if (ctx.from && pendingTraderConfig.has(ctx.from.id)) {
    const field = pendingTraderConfig.get(ctx.from.id)!;
    const value = ctx.message.text.trim();
    try {
      if (field === "heliusApiKey") {
        if (!value) throw new Error("API key cannot be empty");
        await updateTraderConfig(ctx.from.id, { heliusApiKey: value, heliusRpcUrl: `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(value)}` });
      } else {
        const numericValue = Number(value.replace(",", "."));
        if (!Number.isFinite(numericValue) || numericValue < 0) throw new Error("Value must be a number >= 0");
        if (field === "maxTradePositions" && (!Number.isInteger(numericValue) || numericValue < 1)) throw new Error("Maximum positions must be an integer >= 1");
        await updateTraderConfig(ctx.from.id, { [field]: numericValue });
      }
      pendingTraderConfig.delete(ctx.from.id);
      await replyTraderConfig(ctx);
    } catch (error) {
      await ctx.reply(`Configuration failed: ${error instanceof Error ? error.message : "unknown error"}`, { reply_markup: traderConfigKeyboard });
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

bot.hears("📡 Latest Tokens", (ctx) => {
  pendingVolumeInput.set(ctx.chat.id, "latest");
  return ctx.reply(VOLUME_PROMPT);
});
bot.hears("📚 All Tokens", (ctx) => sendTimeList(ctx, 1));
bot.hears("🔥 Top X Mentions", async (ctx) => {
  const feed = ctx.from ? await getUserFeedConfig(ctx.from.id) : undefined;
  const items = await listTopMentions(10, feed ? selectedGmgnChain(feed.chain) : config.GMGN_CHAIN);
  await ctx.reply(renderTopMentions(items, `🔥 ${feed ? displayChain(feed.chain) : "SOLANA"} top X mentions`), { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: menuKeyboard });
});
bot.hears("🚀 Unbounded Feed", (ctx) => {
  pendingVolumeInput.set(ctx.chat.id, "unbounded");
  return ctx.reply(VOLUME_PROMPT);
});
bot.hears("📊 Screening Status", (ctx) => ctx.reply(latestScreeningStatus, { reply_markup: menuKeyboard }));
bot.hears("👛 Wallets", (ctx) => replyWalletMenu(ctx));
bot.hears("⚙️ Trade Config", (ctx) => replyTraderConfig(ctx));
bot.hears("🧩 Feed Config", (ctx) => replyFeedConfig(ctx));
bot.hears("🌱 Early Feed", (ctx) => sendEarlyList(ctx, 1));
bot.hears("📈 Open Positions", (ctx) => sendOpenTradePositions(ctx));
bot.callbackQuery(/^early:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendEarlyList(ctx, Number(ctx.match[1]));
});
for (const field of ["solAmountTradePerPosition", "ethAmountTradePerPosition", "maxTradePositions", "takeProfit1SellPercent", "takeProfit1TargetPercent", "takeProfit2TargetPercent", "heliusApiKey"] as const) {
  bot.callbackQuery(`tradecfg:${field}`, async (ctx) => {
    await ctx.answerCallbackQuery();
    if (!ctx.from) return;
    pendingTraderConfig.set(ctx.from.id, field);
    await ctx.reply(field === "heliusApiKey" ? "Kirim API key Helius:" : `Kirim nilai untuk ${field}:`, { reply_markup: traderConfigKeyboard });
  });
}
bot.callbackQuery("tradecfg:autoTradeFeed", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const current = await getTraderConfig(ctx.from.id);
  await updateTraderConfig(ctx.from.id, { autoTradeFeed: current.autoTradeFeed === "EARLY" ? "UNBOUNDED" : "EARLY" });
  await replyTraderConfig(ctx);
});
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
bot.callbackQuery(/^wallet:balance:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    if (!ctx.from) throw new Error("Telegram user is unavailable");
    const wallet = await getWallet(ctx.from.id, ctx.match[1]);
    if (!wallet) throw new Error("Wallet not found for this Telegram user");
    if (wallet.chain === "SOLANA") {
      const balance = await getSolBalance(wallet.walletAddress);
      await ctx.reply(`Balance [${wallet.chain}]: <code>${balance.toFixed(9)} SOL</code>`, { parse_mode: "HTML", reply_markup: walletKeyboard });
    } else if (wallet.chain === "ROBINHOOD") {
      const balance = await getRobinhoodBalance(wallet.walletAddress);
      await ctx.reply(`Balance [${wallet.chain}]: <code>${balance.toFixed(9)} ${escapeHtml(config.ROBINHOOD_NATIVE_SYMBOL)}</code>`, { parse_mode: "HTML", reply_markup: walletKeyboard });
    } else {
      throw new Error(`Balance lookup is not available for ${wallet.chain}`);
    }
  } catch (error) {
    await ctx.reply(`Could not read balance: ${error instanceof Error ? error.message : "unknown error"}`, { reply_markup: walletKeyboard });
  }
});
bot.callbackQuery(/^wallet:active:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    if (!ctx.from) throw new Error("Telegram user is unavailable");
    await setActiveWallet(ctx.from.id, ctx.match[1]);
    await ctx.reply("Wallet aktif berhasil diperbarui.", { reply_markup: walletKeyboard });
    await replyWalletMenu(ctx);
  } catch (error) {
    await ctx.reply(`Could not set active wallet: ${error instanceof Error ? error.message : "unknown error"}`, { reply_markup: walletKeyboard });
  }
});
bot.callbackQuery(/^wallet:export:(?!confirm:)(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  if (ctx.chat?.type !== "private") {
    await ctx.reply("Export private key hanya tersedia di private chat Telegram demi keamanan.", { reply_markup: walletKeyboard });
    return;
  }
  const wallet = await getWallet(ctx.from.id, ctx.match[1]);
  if (!wallet) {
    await ctx.reply("Wallet not found for this Telegram user.", { reply_markup: walletKeyboard });
    return;
  }
  const active = await getActiveWallet(ctx.from.id, wallet.chain as "SOLANA" | "ROBINHOOD");
  if (!active || active.id !== wallet.id) {
    await ctx.reply("Wallet ini bukan wallet aktif. Buka /wallets lalu pilih wallet aktif terlebih dahulu.", { reply_markup: walletKeyboard });
    return;
  }
  await ctx.reply("PERINGATAN: private key akan dikirim ke chat ini. Pastikan chat privat dan hapus pesan setelah disimpan. Tekan konfirmasi hanya jika benar-benar yakin.", {
    reply_markup: new InlineKeyboard().text("⚠️ Konfirmasi export private key", `wallet:export:confirm:${wallet.id}`).row().text("Batal", "wallet:cancel")
  });
});
bot.callbackQuery(/^wallet:export:confirm:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  try {
    if (!ctx.from) throw new Error("Telegram user is unavailable");
    if (ctx.chat?.type !== "private") throw new Error("Export private key hanya tersedia di private chat Telegram");
    const wallet = await getWallet(ctx.from.id, ctx.match[1]);
    if (!wallet) throw new Error("Wallet not found for this Telegram user");
    const active = await getActiveWallet(ctx.from.id, wallet.chain as "SOLANA" | "ROBINHOOD");
    if (!active || active.id !== wallet.id) throw new Error("Wallet is no longer active");
    const privateKey = exportPrivateKey(wallet.encryptedPrivateKey, wallet.chain as "SOLANA" | "ROBINHOOD");
    await ctx.reply(`Private key ${wallet.chain} untuk address <code>${escapeHtml(wallet.walletAddress)}</code>:\n\n<pre>${escapeHtml(privateKey)}</pre>\n\nHapus pesan ini setelah private key diamankan.`, { parse_mode: "HTML", reply_markup: walletKeyboard });
  } catch (error) {
    await ctx.reply(`Private key export failed: ${error instanceof Error ? error.message : "unknown error"}`, { reply_markup: walletKeyboard });
  }
});
bot.callbackQuery("wallet:balance", async (ctx) => {
  await ctx.answerCallbackQuery();
  await replyWalletMenu(ctx);
});
bot.callbackQuery("wallet:receive", async (ctx) => {
  await ctx.answerCallbackQuery();
  await replyWalletMenu(ctx);
});
bot.callbackQuery(/^wallet:send:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const wallet = await getWallet(ctx.from.id, ctx.match[1]);
  if (!wallet) {
    await ctx.reply("Wallet not found for this Telegram user.", { reply_markup: walletKeyboard });
    return;
  }
  if (wallet.chain !== "SOLANA") {
    await ctx.reply(`Sending is not available for ${wallet.chain} until its official transaction adapter is configured.`, { reply_markup: walletKeyboard });
    return;
  }
  pendingWalletSendSelection.set(ctx.from.id, wallet.id);
  await ctx.reply("Send one message in this format: recipient_address amount_SOL\nExample: 9x... 0.01", { reply_markup: walletKeyboard });
});
bot.callbackQuery("wallet:send", async (ctx) => {
  await ctx.answerCallbackQuery();
  await replyWalletMenu(ctx);
});
bot.callbackQuery("wallet:import:choose", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const keyboard = new InlineKeyboard()
    .text("◎ Import Solana wallet", "wallet:import:SOLANA")
    .row()
    .text("🪙 Import Robinhood wallet", "wallet:import:ROBINHOOD")
    .row()
    .text("Cancel", "wallet:cancel");
  await ctx.reply("Choose the wallet chain before entering credentials:", { reply_markup: keyboard });
});
bot.callbackQuery(/^wallet:import:(SOLANA|ROBINHOOD)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const chain = ctx.match[1] as "SOLANA" | "ROBINHOOD";
  pendingWalletImport.set(ctx.from.id, chain);
  const prompt = chain === "SOLANA"
    ? "Send a Solana private key as base58, a JSON byte array, or hex. It will be encrypted immediately. Never share it anywhere else."
    : "Send Robinhood wallet credentials in one line: wallet_address private_key. The key will be encrypted immediately.";
  await ctx.reply(prompt, { reply_markup: walletKeyboard });
});
bot.callbackQuery("wallet:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from) {
    pendingWalletImport.delete(ctx.from.id);
    pendingWalletSendSelection.delete(ctx.from.id);
  }
  await replyWalletMenu(ctx);
});
bot.callbackQuery("feedcfg:chain", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const current = await getUserFeedConfig(ctx.from.id);
  const keyboard = new InlineKeyboard()
    .text("✏️ Update", "feedcfg:chain:edit")
    .text("✖ Cancel", "feedcfg:cancel");
  await ctx.reply(`⛓️ Feed chain\n\nCurrent value: <code>${escapeHtml(current.chain)}</code>\nAvailable values: <code>SOLANA</code> or <code>ROBINHOOD</code>\n\nChoose Update to select another chain, or Cancel to keep the current value.`, { parse_mode: "HTML", reply_markup: keyboard });
});
bot.callbackQuery("feedcfg:chain:edit", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const keyboard = new InlineKeyboard();
  for (const chain of SUPPORTED_CHAINS) keyboard.text(chain === "SOLANA" ? "◎ Solana" : "🪙 Robinhood", `feedcfg:setchain:${chain}`).row();
  keyboard.text("✖ Cancel", "feedcfg:cancel");
  await ctx.reply("Choose the new GMGN chain for your feed:", { reply_markup: keyboard });
});
bot.callbackQuery(/^feedcfg:setchain:(SOLANA|ROBINHOOD)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  await updateUserFeedConfig(ctx.from.id, { chain: ctx.match[1] });
  await replyFeedConfig(ctx);
});
bot.callbackQuery(/^feedcfg:group:(completed|unbounded|early)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const group = ctx.match[1];
  const keyboard = new InlineKeyboard();
  const fields = feedConfigFields.filter((field) => field.toLowerCase().startsWith(group));
  for (const field of fields) keyboard.text(field, `feedcfg:field:${field}`).row();
  await ctx.reply(`Choose a ${group} filter to edit:`, { reply_markup: keyboard });
});
bot.callbackQuery(/^feedcfg:field:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const field = ctx.match[1] as FeedConfigField;
  if (!feedConfigFields.includes(field)) return;
  const current = await getUserFeedConfig(ctx.from.id);
  const keyboard = new InlineKeyboard()
    .text("✏️ Update", `feedcfg:edit:${field}`)
    .text("✖ Cancel", "feedcfg:cancel");
  await ctx.reply(`⚙️ ${field}\n\nCurrent value: <code>${escapeHtml(feedFieldValue(current, field))}</code>\nExample input: <code>${escapeHtml(feedFieldExample(field))}</code>\n\nChoose Update to enter a new value, or Cancel to leave it unchanged.`, { parse_mode: "HTML", reply_markup: keyboard });
});
bot.callbackQuery(/^feedcfg:edit:(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!ctx.from) return;
  const field = ctx.match[1] as FeedConfigField;
  if (!feedConfigFields.includes(field)) return;
  const current = await getUserFeedConfig(ctx.from.id);
  pendingFeedConfig.set(ctx.from.id, field);
  await ctx.reply(`Enter the new value for ${field}.\nCurrent value: ${feedFieldValue(current, field)}\nExample: ${feedFieldExample(field)}\n\nSend /cancel to stop.`, { reply_markup: feedConfigKeyboard });
});
bot.callbackQuery("feedcfg:cancel", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.from) pendingFeedConfig.delete(ctx.from.id);
  await replyFeedConfig(ctx);
});

export function setLatestScreeningStatus(message: string): void {
  latestScreeningStatus = message;
}

export async function notifyNewToken(token: TokenListItem): Promise<void> {
  const userIds = await listTelegramUserIds();
  // The literal "<=" in the header must be HTML-escaped, otherwise Telegram's HTML parser
  // treats "<" as a tag start and rejects the whole message (verified via GrammyError 400 in logs).
  const header = escapeHtml(`✅ ${displayChain(token.chain)} token reached 100% bonding curve (bundler <= 20%, DEX paid)!`);
  const message = `${header}\n\n${renderTokenRow(token, new Date())}`;
  for (const userId of userIds) {
    try {
        const feed = await getUserFeedConfig(userId);
        if ((token as TokenListItem & { chain?: string }).chain !== selectedGmgnChain(feed.chain) || (token.xMentionCount ?? 0) < feed.completedMinXMentions) continue;
        await bot.api.sendMessage(userId, message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
        console.error(`Gagal mengirim notifikasi ke Telegram user ${userId}:`, error);
    }
  }
}

export async function notifyNewUnboundedToken(token: UnboundedTokenListItem): Promise<void> {
  const userIds = await listTelegramUserIds();
  const header = escapeHtml(`🚀 ${displayChain(token.chain)} unbounded token detected (bonding curve below 100%, DEX paid, organic)!`);
  const message = `${header}\n\n${renderUnboundedTokenRow(token, new Date())}`;
  for (const userId of userIds) {
    try {
      const feed = await getUserFeedConfig(userId);
      if ((token as UnboundedTokenListItem & { chain?: string }).chain !== selectedGmgnChain(feed.chain) || (token.xMentionCount ?? 0) < feed.unboundedMinXMentions || (token.jumlah_volume ?? 0) < feed.unboundedMinVolume24h) continue;
      await bot.api.sendMessage(userId, message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
        console.error(`Gagal mengirim notifikasi unbounded ke Telegram user ${userId}:`, error);
    }
  }
}

export async function notifyNewEarlyToken(token: EarlyTokenListItem): Promise<void> {
  const userIds = await listTelegramUserIds();
  const header = escapeHtml(`🌱 ${displayChain(token.chain)} early token detected (new creation, no ATH)!`);
  const message = `${header}\n\n${renderEarlyTokenRow(token, new Date())}`;
  for (const userId of userIds) {
    try {
      const feed = await getUserFeedConfig(userId);
      if ((token as EarlyTokenListItem & { chain?: string }).chain !== selectedGmgnChain(feed.chain) || (token.xMentionCount ?? 0) < feed.earlyMinXMentions || (token.jumlah_volume ?? 0) < feed.earlyMinVolume24h || (token.marketCap ?? 0) < feed.earlyMinMarketCap || (token.marketCap ?? 0) >= feed.earlyMaxMarketCap) continue;
      await bot.api.sendMessage(userId, message, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (error) {
        console.error(`Gagal mengirim notifikasi early token ke Telegram user ${userId}:`, error);
    }
  }
}

export async function notifyAutoTradeFailure(telegramId: bigint, operation: "BUY" | "SELL", tokenAddress: string, detail: string): Promise<void> {
  try {
    await bot.api.sendMessage(telegramId.toString(), `Auto-trade ${operation} gagal\nToken: <code>${escapeHtml(tokenAddress)}</code>\nKeterangan: ${escapeHtml(detail)}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, reply_markup: menuKeyboard });
  } catch (notificationError) {
    console.error(`Gagal mengirim notifikasi auto-trade ke Telegram ID ${telegramId}:`, notificationError);
  }
}

export { bot };
