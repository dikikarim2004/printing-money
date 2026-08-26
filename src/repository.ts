import { Prisma, PrismaClient } from "@prisma/client";
import type { DiscoveredToken, TokenListItem, UnboundedDiscoveredToken, UnboundedTokenListItem } from "./types.js";
import type { SocialEnrichment } from "./enrichment.js";

export const prisma = new PrismaClient();
export const pumpUrl = (address: string) => `https://pump.fun/coin/${encodeURIComponent(address)}`;

export async function getUnboundedVolumes(addresses: string[]): Promise<Map<string, number | null>> {
  if (!addresses.length) return new Map();
  const rows = await prisma.tokenUnboundedFilter.findMany({ where: { address: { in: addresses } }, select: { address: true, jumlah_volume: true } });
  return new Map(rows.map((row) => [row.address, row.jumlah_volume]));
}

export async function saveToken(token: DiscoveredToken, social: SocialEnrichment, preCompletionVolume?: number | null, athMarketCap?: number | null): Promise<{ isNew: boolean }> {
  const rawData = JSON.parse(JSON.stringify(token.rawData)) as Prisma.InputJsonValue;
  const existing = await prisma.token.findUnique({ where: { address: token.address }, select: { address: true } });
  // Volume must reflect the value while the bonding curve was still <100% (verified: the "completed" category's
  // volume_24h keeps rising after migration to a DEX, e.g. 197845.82 -> 197853.46 within 2 minutes on a live
  // token), so it is only set on first creation and never overwritten by later re-scans of the same token.
  const initialVolume = preCompletionVolume ?? token.volume24h ?? null;
  await prisma.token.upsert({
    where: { address: token.address },
    // marketCap is frozen at the 100%-completion snapshot (same rationale as jumlah_volume above); athMarketCap
    // is refreshed every scan since it is a genuine all-time-high that can only grow, never regress.
    create: { address: token.address, symbol: token.symbol, name: token.name, bondingAt: token.bondingAt, isOnCurve: token.isOnCurve, pumpUrl: pumpUrl(token.address), twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, jumlah_volume: initialVolume, rugRatio: token.rugRatio, marketCap: token.marketCap ?? null, athMarketCap: athMarketCap ?? null, tokenCreatedAt: token.tokenCreatedAt, rawData },
    update: { symbol: token.symbol, name: token.name, bondingAt: token.bondingAt, isOnCurve: token.isOnCurve, twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, rugRatio: token.rugRatio, athMarketCap: athMarketCap ?? null, rawData }
  });
  return { isNew: !existing };
}

export async function registerChat(chatId: number): Promise<void> {
  await prisma.chat.upsert({ where: { chatId: BigInt(chatId) }, create: { chatId: BigInt(chatId) }, update: {} });
}

export async function listChatIds(): Promise<number[]> {
  const chats = await prisma.chat.findMany({ select: { chatId: true } });
  return chats.map((chat) => Number(chat.chatId));
}

export async function listTokens(order: "time" | "mentions", page: number, pageSize = 10, withinHours?: number, minVolume?: number): Promise<TokenListItem[]> {
  const where = {
    ...(withinHours ? { bondingAt: { gte: new Date(Date.now() - withinHours * 60 * 60 * 1000) } } : {}),
    ...(minVolume ? { jumlah_volume: { gte: minVolume } } : {})
  };
  const tokens = await prisma.token.findMany({
    where,
    orderBy: order === "mentions" ? [{ xMentionCount: "desc" }, { bondingAt: "desc" }] : { bondingAt: "desc" },
    skip: order === "time" ? Math.max(0, page - 1) * pageSize : 0,
    take: order === "time" ? pageSize : 10
  });
  return tokens.map((token) => ({ ...token, symbol: token.symbol ?? undefined, name: token.name ?? undefined, rugRatio: token.rugRatio ?? undefined, marketCap: token.marketCap ?? undefined, twitterUrl: token.twitterUrl ?? undefined, websiteUrl: token.websiteUrl ?? undefined }));
}

export function hasNextPage(page: number, pageSize = 10, withinHours?: number, minVolume?: number): Promise<boolean> {
  const where = {
    ...(withinHours ? { bondingAt: { gte: new Date(Date.now() - withinHours * 60 * 60 * 1000) } } : {}),
    ...(minVolume ? { jumlah_volume: { gte: minVolume } } : {})
  };
  return prisma.token.count({ where }).then((count) => count > page * pageSize);
}

export async function saveUnboundedToken(token: UnboundedDiscoveredToken, social: SocialEnrichment, athMarketCap?: number | null): Promise<{ isNew: boolean }> {
  const rawData = JSON.parse(JSON.stringify(token.rawData)) as Prisma.InputJsonValue;
  const existing = await prisma.tokenUnboundedFilter.findUnique({ where: { address: token.address }, select: { address: true } });
  await prisma.tokenUnboundedFilter.upsert({
    where: { address: token.address },
    create: { address: token.address, symbol: token.symbol, name: token.name, progress: token.progress, rugRatio: token.rugRatio, marketCap: token.marketCap ?? null, athMarketCap: athMarketCap ?? null, pumpUrl: pumpUrl(token.address), twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, jumlah_volume: token.volume24h, tokenCreatedAt: token.tokenCreatedAt, rawData },
    update: { symbol: token.symbol, name: token.name, progress: token.progress, rugRatio: token.rugRatio, marketCap: token.marketCap ?? null, athMarketCap: athMarketCap ?? null, twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, jumlah_volume: token.volume24h, rawData }
  });
  return { isNew: !existing };
}

// Point 3: once a token's bonding curve reaches 100%, it no longer belongs in the unbounded (not-yet-100%) table.
export async function removeCompletedFromUnbounded(addresses: string[]): Promise<void> {
  if (!addresses.length) return;
  await prisma.tokenUnboundedFilter.deleteMany({ where: { address: { in: addresses } } });
}

// Volatile fields (bundler rate, dex paid, rug ratio) drift live on GMGN's side within minutes of capture
// (verified: a token's bundler_trader_amount_rate rose from <=20% at detection to 22.92% nine minutes later),
// so re-requiring a row to still appear in the freshly-filtered candidate list caused notified tokens to
// vanish almost immediately. Expiry is now the explicit, deterministic criteria the user actually specified:
// removed only on reaching 100% (removeCompletedFromUnbounded) or exceeding the 1-hour token-age limit.
export async function pruneExpiredUnboundedTokens(maxAgeMs: number): Promise<void> {
  await prisma.tokenUnboundedFilter.deleteMany({ where: { tokenCreatedAt: { lt: new Date(Date.now() - maxAgeMs) } } });
}

export async function listUnboundedTokens(page: number, pageSize = 10, minVolume?: number): Promise<UnboundedTokenListItem[]> {
  const where = minVolume ? { jumlah_volume: { gte: minVolume } } : undefined;
  const tokens = await prisma.tokenUnboundedFilter.findMany({
    where,
    orderBy: { createdAt: "desc" },
    skip: Math.max(0, page - 1) * pageSize,
    take: pageSize
  });
  return tokens.map((token) => ({ ...token, symbol: token.symbol ?? undefined, name: token.name ?? undefined, rugRatio: token.rugRatio ?? undefined, marketCap: token.marketCap ?? undefined, twitterUrl: token.twitterUrl ?? undefined, websiteUrl: token.websiteUrl ?? undefined }));
}

export function hasNextUnboundedPage(page: number, pageSize = 10, minVolume?: number): Promise<boolean> {
  const where = minVolume ? { jumlah_volume: { gte: minVolume } } : undefined;
  return prisma.tokenUnboundedFilter.count({ where }).then((count) => count > page * pageSize);
}

// Point 2: "Top mention X" now combines both the 100%-completed Token table and the not-yet-100%
// TokenUnboundedFilter table, sorted DESC by xMentionCount across both.
export async function listTopMentions(limit = 10): Promise<Array<TokenListItem | UnboundedTokenListItem>> {
  const [tokens, unboundedTokens] = await Promise.all([
    prisma.token.findMany({ where: { xMentionCount: { not: null } }, orderBy: { xMentionCount: "desc" }, take: limit }),
    prisma.tokenUnboundedFilter.findMany({ where: { xMentionCount: { not: null } }, orderBy: { xMentionCount: "desc" }, take: limit })
  ]);
  const mappedTokens: TokenListItem[] = tokens.map((token) => ({ ...token, symbol: token.symbol ?? undefined, name: token.name ?? undefined, rugRatio: token.rugRatio ?? undefined, marketCap: token.marketCap ?? undefined, twitterUrl: token.twitterUrl ?? undefined, websiteUrl: token.websiteUrl ?? undefined }));
  const mappedUnbounded: UnboundedTokenListItem[] = unboundedTokens.map((token) => ({ ...token, symbol: token.symbol ?? undefined, name: token.name ?? undefined, rugRatio: token.rugRatio ?? undefined, marketCap: token.marketCap ?? undefined, twitterUrl: token.twitterUrl ?? undefined, websiteUrl: token.websiteUrl ?? undefined }));
  return [...mappedTokens, ...mappedUnbounded]
    .sort((a, b) => (b.xMentionCount ?? 0) - (a.xMentionCount ?? 0))
    .slice(0, limit);
}
