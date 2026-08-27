import { config } from "./config.js";
import type { DiscoveredToken } from "./types.js";

export type SocialEnrichment = {
  twitterUrl?: string;
  xMentionCount?: number;
  // true only when GMGN gave a real tweet reference but fxtwitter could not be verified (network/HTTP error),
  // as opposed to genuinely having no tweet link at all. Callers must not treat this the same as "no mentions"
  // when deciding whether to prune already-stored, previously-valid rows (mirrors the DexScreener checked/paid fix).
  mentionCheckFailed?: boolean;
};

// GMGN's raw `twitter` field looks like "username/status/12345?s=20"; only treat it as a real tweet
// reference (not a bare profile/community link) when GMGN's own `twitter_is_tweet` flag is true.
const TWEET_PATH_PATTERN = /^([A-Za-z0-9_]{1,15})\/status\/(\d+)/;

type FxTwitterResponse = {
  code?: unknown;
  tweet?: { url?: unknown; replies?: unknown; retweets?: unknown; likes?: unknown };
};

// Distinguishes a definitive "this tweet does not exist" (fxtwitter's own 404, e.g. a deleted/fake tweet link -
// common for scam tokens) from a transient network/HTTP failure. The former is a permanent fact (zero mentions,
// never worth retrying); the latter must not be treated as "no mentions" (see mentionCheckFailed).
type FxTwitterResult =
  | { kind: "success"; data: SocialEnrichment }
  | { kind: "not_found" }
  | { kind: "error" };

async function fetchFxTwitterEngagement(username: string, tweetId: string): Promise<FxTwitterResult> {
  const response = await fetch(`https://api.fxtwitter.com/${username}/status/${tweetId}`, {
    headers: { "user-agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(8000)
  });
  // Verified live: a deleted/fake tweet returns actual HTTP 404 (not HTTP 200), body {code:404,message:"NOT_FOUND",tweet:null}.
  // This must be checked before the generic !response.ok branch, otherwise it is wrongly treated as a transient failure.
  if (response.status === 404) return { kind: "not_found" };
  if (!response.ok) return { kind: "error" };
  const body = await response.json() as FxTwitterResponse;
  if (body.code === 404) return { kind: "not_found" };
  const tweet = body.tweet;
  if (body.code !== 200 || !tweet) return { kind: "error" };
  const { replies, retweets, likes, url } = tweet;
  if (typeof replies !== "number" || typeof retweets !== "number" || typeof likes !== "number") return { kind: "error" };
  return { kind: "success", data: { twitterUrl: typeof url === "string" ? url : undefined, xMentionCount: replies + retweets + likes } };
}

export async function enrichSocial(token: Pick<DiscoveredToken, "address" | "twitterUrl" | "twitterStatusPath" | "twitterIsTweet">): Promise<SocialEnrichment> {
  if (token.twitterIsTweet && token.twitterStatusPath) {
    const match = token.twitterStatusPath.match(TWEET_PATH_PATTERN);
    if (match) {
      try {
        const result = await fetchFxTwitterEngagement(match[1], match[2]);
        if (result.kind === "success") return result.data;
        if (result.kind === "not_found") return { twitterUrl: token.twitterUrl, xMentionCount: 0 };
        return { twitterUrl: token.twitterUrl, mentionCheckFailed: true };
      } catch (error) {
        console.error(`fxtwitter enrichment failed for ${token.address}:`, error);
        return { twitterUrl: token.twitterUrl, mentionCheckFailed: true };
      }
    }
  }
  // No usable tweet link from GMGN: per spec, ignore this point rather than guessing at a mention count.
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
