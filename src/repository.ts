import { Prisma, PrismaClient } from "@prisma/client";
import type { DiscoveredToken, TokenListItem } from "./types.js";
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
