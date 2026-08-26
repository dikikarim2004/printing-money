import { config } from "./config.js";
import type { DiscoveredToken } from "./types.js";

export type SocialEnrichment = {
  twitterUrl?: string;
  xMentionCount?: number;
};

export async function enrichSocial(token: Pick<DiscoveredToken, "address" | "twitterUrl">): Promise<SocialEnrichment> {
  if (!config.X_ENRICHMENT_URL) return { twitterUrl: token.twitterUrl };
  const response = await fetch(config.X_ENRICHMENT_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(config.X_ENRICHMENT_TOKEN ? { authorization: `Bearer ${config.X_ENRICHMENT_TOKEN}` } : {})
    },
    body: JSON.stringify({ address: token.address, twitterUrl: token.twitterUrl })
  });
  if (!response.ok) throw new Error(`X enrichment failed with HTTP ${response.status}`);
  const body = await response.json() as { twitterUrl?: unknown; xMentionCount?: unknown; mentionCount?: unknown };
  const count = body.xMentionCount ?? body.mentionCount;
  return {
    twitterUrl: typeof body.twitterUrl === "string" ? body.twitterUrl : token.twitterUrl,
    xMentionCount: typeof count === "number" && Number.isFinite(count) ? count : undefined
  };
}
