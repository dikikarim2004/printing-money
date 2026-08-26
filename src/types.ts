export type DiscoveredToken = {
  address: string;
  symbol?: string;
  name?: string;
  bondingAt: Date;
  isOnCurve: boolean;
  twitterUrl?: string;
  websiteUrl?: string;
  rawData: unknown;
};

export type TokenListItem = DiscoveredToken & {
  pumpUrl: string;
  xMentionCount: number | null;
};

// "Good Unbounded Token": bonding curve not yet at 100%, but dex paid, bundler <= 20%, organic (not likely rugged).
export type UnboundedDiscoveredToken = {
  address: string;
  symbol?: string;
  name?: string;
  progress: number;
  rugRatio?: number;
  twitterUrl?: string;
  websiteUrl?: string;
  rawData: unknown;
};

export type UnboundedTokenListItem = UnboundedDiscoveredToken & {
  pumpUrl: string;
  xMentionCount: number | null;
  createdAt: Date;
};
