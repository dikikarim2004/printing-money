import { Prisma, PrismaClient } from "@prisma/client";
import type { DiscoveredToken, TokenListItem } from "./types.js";
import type { SocialEnrichment } from "./enrichment.js";

export const prisma = new PrismaClient();
const pumpUrl = (address: string) => `https://pump.fun/coin/${encodeURIComponent(address)}`;

export async function saveToken(token: DiscoveredToken, social: SocialEnrichment): Promise<void> {
  const rawData = JSON.parse(JSON.stringify(token.rawData)) as Prisma.InputJsonValue;
  await prisma.token.upsert({
    where: { address: token.address },
    create: { address: token.address, symbol: token.symbol, name: token.name, bondingAt: token.bondingAt, isOnCurve: token.isOnCurve, pumpUrl: pumpUrl(token.address), twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, rawData },
    update: { symbol: token.symbol, name: token.name, bondingAt: token.bondingAt, isOnCurve: token.isOnCurve, twitterUrl: social.twitterUrl ?? token.twitterUrl, xMentionCount: social.xMentionCount, rawData }
  });
}

export async function listTokens(order: "time" | "mentions", page: number, pageSize = 10): Promise<TokenListItem[]> {
  const tokens = await prisma.token.findMany({
    orderBy: order === "mentions" ? [{ xMentionCount: "desc" }, { bondingAt: "desc" }] : { bondingAt: "desc" },
    skip: order === "time" ? Math.max(0, page - 1) * pageSize : 0,
    take: order === "time" ? pageSize : 10
  });
  return tokens.map((token) => ({ ...token, symbol: token.symbol ?? undefined, name: token.name ?? undefined, twitterUrl: token.twitterUrl ?? undefined, websiteUrl: token.websiteUrl ?? undefined }));
}

export function hasNextPage(page: number, pageSize = 10): Promise<boolean> {
  return prisma.token.count().then((count) => count > page * pageSize);
}
