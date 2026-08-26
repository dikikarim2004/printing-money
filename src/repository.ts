import { Prisma, PrismaClient } from "@prisma/client";
import type { DiscoveredToken, TokenListItem, UnboundedDiscoveredToken, UnboundedTokenListItem } from "./types.js";
import type { SocialEnrichment } from "./enrichment.js";

export const prisma = new PrismaClient();
export const pumpUrl = (address: string) => `https://pump.fun/coin/${encodeURIComponent(address)}`;

export async function saveToken(token: DiscoveredToken, social: SocialEnrichment): Promise<{ isNew: boolean }> {
  const rawData = JSON.parse(JSON.stringify(token.rawData)) as Prisma.InputJsonValue;
  const existing = await prisma.token.findUnique({ where: { address: token.address }, select: { address: true } });
  await prisma.token.upsert({
    where: { address: token.address },
    create: { address: token.address, symbol: token.symbol, name: token.name, bondingAt: token.bondingAt, isOnCurve: token.isOnCurve, pumpUrl: pumpUrl(token.address), twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, rawData },
    update: { symbol: token.symbol, name: token.name, bondingAt: token.bondingAt, isOnCurve: token.isOnCurve, twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, rawData }
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

export async function listTokens(order: "time" | "mentions", page: number, pageSize = 10, withinHours?: number): Promise<TokenListItem[]> {
  const where = withinHours ? { bondingAt: { gte: new Date(Date.now() - withinHours * 60 * 60 * 1000) } } : undefined;
  const tokens = await prisma.token.findMany({
    where,
    orderBy: order === "mentions" ? [{ xMentionCount: "desc" }, { bondingAt: "desc" }] : { bondingAt: "desc" },
    skip: order === "time" ? Math.max(0, page - 1) * pageSize : 0,
    take: order === "time" ? pageSize : 10
  });
  return tokens.map((token) => ({ ...token, symbol: token.symbol ?? undefined, name: token.name ?? undefined, twitterUrl: token.twitterUrl ?? undefined, websiteUrl: token.websiteUrl ?? undefined }));
}

export function hasNextPage(page: number, pageSize = 10, withinHours?: number): Promise<boolean> {
  const where = withinHours ? { bondingAt: { gte: new Date(Date.now() - withinHours * 60 * 60 * 1000) } } : undefined;
  return prisma.token.count({ where }).then((count) => count > page * pageSize);
}

export async function saveUnboundedToken(token: UnboundedDiscoveredToken, social: SocialEnrichment): Promise<{ isNew: boolean }> {
  const rawData = JSON.parse(JSON.stringify(token.rawData)) as Prisma.InputJsonValue;
  const existing = await prisma.tokenUnboundedFilter.findUnique({ where: { address: token.address }, select: { address: true } });
  await prisma.tokenUnboundedFilter.upsert({
    where: { address: token.address },
    create: { address: token.address, symbol: token.symbol, name: token.name, progress: token.progress, rugRatio: token.rugRatio, pumpUrl: pumpUrl(token.address), twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, rawData },
    update: { symbol: token.symbol, name: token.name, progress: token.progress, rugRatio: token.rugRatio, twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, rawData }
  });
  return { isNew: !existing };
}

// Point 3: once a token's bonding curve reaches 100%, it no longer belongs in the unbounded (not-yet-100%) table.
export async function removeCompletedFromUnbounded(addresses: string[]): Promise<void> {
  if (!addresses.length) return;
  await prisma.tokenUnboundedFilter.deleteMany({ where: { address: { in: addresses } } });
}

// Filter fields (dex paid, bundler rate, wash trading) drift over time on GMGN's side; a row that stops
// appearing in the freshly-verified qualifying set no longer meets the criteria and must not linger with
// its stale (possibly now-inaccurate) snapshot still displayed as valid.
export async function pruneUnboundedTokens(currentAddresses: string[]): Promise<void> {
  await prisma.tokenUnboundedFilter.deleteMany({ where: { address: { notIn: currentAddresses } } });
}

export async function listUnboundedTokens(page: number, pageSize = 10): Promise<UnboundedTokenListItem[]> {
  const tokens = await prisma.tokenUnboundedFilter.findMany({
    orderBy: { createdAt: "desc" },
    skip: Math.max(0, page - 1) * pageSize,
    take: pageSize
  });
  return tokens.map((token) => ({ ...token, symbol: token.symbol ?? undefined, name: token.name ?? undefined, rugRatio: token.rugRatio ?? undefined, twitterUrl: token.twitterUrl ?? undefined, websiteUrl: token.websiteUrl ?? undefined }));
}

export function hasNextUnboundedPage(page: number, pageSize = 10): Promise<boolean> {
  return prisma.tokenUnboundedFilter.count().then((count) => count > page * pageSize);
}
