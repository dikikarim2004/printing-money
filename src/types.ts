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
