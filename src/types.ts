export type DiscoveredToken = {
  address: string;
  symbol?: string;
  name?: string;
  bondingAt: Date;
  isOnCurve: boolean;
  twitterUrl?: string;
  // Raw GMGN `twitter` field (e.g. "username/status/12345?s=20") and `twitter_is_tweet` flag,
  // used to parse a real tweet reference for fxtwitter enrichment.
  twitterStatusPath?: string;
  twitterIsTweet?: boolean;
  websiteUrl?: string;
  volume24h?: number;
  rugRatio?: number;
  // GMGN `market_cap`: current USD market cap at discovery time.
  marketCap?: number;
  // GMGN `total_supply`: needed to convert the separately-fetched `ath_price` into an ATH market cap.
  totalSupply?: number;
  // GMGN `created_timestamp`: when the token contract itself was created (token age gate, max 1 hour).
  tokenCreatedAt: Date;
  rawData: unknown;
};

export type TokenListItem = DiscoveredToken & {
  pumpUrl: string;
  xMentionCount: number | null;
  jumlah_volume: number | null;
  // All-time-high USD market cap, fetched via a separate GMGN `token info` lookup (not part of discovery).
  athMarketCap: number | null;
};

// "Good Unbounded Token": bonding curve not yet at 100%, but dex paid, bundler <= 20%, organic (not likely rugged).
export type UnboundedDiscoveredToken = {
  address: string;
  symbol?: string;
  name?: string;
  progress: number;
  rugRatio?: number;
  twitterUrl?: string;
  twitterStatusPath?: string;
  twitterIsTweet?: boolean;
  websiteUrl?: string;
  volume24h?: number;
  // GMGN `market_cap`: current USD market cap at discovery time.
  marketCap?: number;
  // GMGN `total_supply`: needed to convert the separately-fetched `ath_price` into an ATH market cap.
  totalSupply?: number;
  // GMGN `created_timestamp`: when the token contract itself was created (token age gate, max 1 hour).
  tokenCreatedAt: Date;
  rawData: unknown;
};

export type UnboundedTokenListItem = UnboundedDiscoveredToken & {
  pumpUrl: string;
  xMentionCount: number | null;
  jumlah_volume: number | null;
  // All-time-high USD market cap, fetched via a separate GMGN `token info` lookup (not part of discovery).
  athMarketCap: number | null;
  createdAt: Date;
};
