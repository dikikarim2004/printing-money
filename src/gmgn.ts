import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { DiscoveredToken, EarlyDiscoveredToken, UnboundedDiscoveredToken } from "./types.js";

const execFileAsync = promisify(execFile);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

// GMGN CLI `market trenches --raw` returns { new_creation: [...], near_completion: [...], completed: [...] },
// not a generic data/tokens/list/rows/result envelope. near_completion progress is always < 1 (verified 0.49-0.92);
// only completed holds tokens that reached 100% bonding curve progress (launchpad_status 1, complete_timestamp > 0).
const ON_CURVE_CATEGORIES = ["completed"] as const;

function recordsFromPayload(payload: unknown, categories: readonly string[]): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.reduce<Record<string, unknown>[]>((records, item) => {
    const record = asRecord(item);
    if (record) records.push(record);
    return records;
  }, []);
  const root = asRecord(payload);
  if (!root) return [];
  // A token can legitimately appear in more than one category simultaneously (verified live: the same address
  // listed in both new_creation and near_completion at once), so records are deduplicated by address to avoid
  // redundant downstream DexScreener/fxtwitter/GMGN-token-info calls for the same token.
  const seenAddresses = new Set<string>();
  const records: Record<string, unknown>[] = [];
  for (const category of categories) {
    const value = root[category];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const record = asRecord(item);
      if (!record) continue;
      const address = record.address;
      if (typeof address === "string") {
        if (seenAddresses.has(address)) continue;
        seenAddresses.add(address);
      }
      records.push(record);
    }
  }
  return records;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function parseDate(value: unknown): Date | null {
  if (typeof value === "number") {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(milliseconds);
    return Number.isNaN(date.valueOf()) ? null : date;
  }
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date;
  }
  return null;
}

// GMGN's chain slugs (sol, eth, bsc, base) differ from DexScreener's chainId slugs; only "sol" -> "solana"
// is verified against this app's actual GMGN_CHAIN config, others pass through best-effort.
const DEXSCREENER_CHAIN_IDS: Record<string, string> = { sol: "solana", eth: "ethereum", bsc: "bsc", base: "base" };

type DexScreenerOrder = { type?: unknown; status?: unknown };
type DexScreenerOrdersResponse = { orders?: DexScreenerOrder[] };
// `checked=false` means the API call failed/was rate-limited (HTTP not-ok or network error) and paid status
// could not actually be verified; callers must not treat that as "confirmed not paid".
type DexPaidCheck = { paid: boolean; checked: boolean };

// https://docs.dexscreener.com/api/reference#get-orders-v1-chainid-tokenaddress
// Verified live: a dex-paid token returns orders:[{type:"tokenProfile",status:"approved",...}];
// an unpaid token returns orders:[] (and boosts:[]).
async function isDexScreenerPaid(chain: string, address: string): Promise<DexPaidCheck> {
  const chainId = DEXSCREENER_CHAIN_IDS[chain] ?? chain;
  try {
    const response = await fetch(`https://api.dexscreener.com/orders/v1/${chainId}/${address}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) {
      console.error(`DexScreener orders check returned HTTP ${response.status} for ${address}`);
      return { paid: false, checked: false };
    }
    const body = await response.json() as DexScreenerOrdersResponse;
    const paid = Array.isArray(body.orders) && body.orders.some((order) => order.type === "tokenProfile" && order.status === "approved");
    return { paid, checked: true };
  } catch (error) {
    console.error(`DexScreener orders check failed for ${address}:`, error);
    return { paid: false, checked: false };
  }
}

// Concurrency=5 still triggered sustained HTTP 429s from DexScreener (observed live), so requests are now
// issued strictly one at a time with spacing, targeting DexScreener's documented ~60 req/min public API limit.
async function mapSequentialWithDelay<T, R>(items: T[], delayMs: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (const item of items) {
    results.push(await fn(item));
    if (results.length < items.length) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return results;
}

// GMGN `token info --raw` exposes `ath_price` (all-time-high PRICE for this specific token), which is not
// present in the `market trenches` payload used for discovery. Verified live: 5 rapid successive calls all
// succeeded with no rate limiting. `ath_price * totalSupply` (from the trenches record) gives the ATH market cap.
export async function fetchAthMarketCap(chain: string, address: string, totalSupply?: number): Promise<number | undefined> {
  if (!totalSupply) return undefined;
  try {
    const { stdout } = await execFileAsync(config.GMGN_CLI_BIN, ["token", "info", "--chain", chain, "--address", address, "--raw"], {
      env: { ...process.env, ...(config.GMGN_API_KEY ? { GMGN_API_KEY: config.GMGN_API_KEY } : {}) },
      maxBuffer: 10 * 1024 * 1024
    });
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    const athPrice = payload.ath_price;
    if (typeof athPrice !== "number") return undefined;
    return athPrice * totalSupply;
  } catch (error) {
    console.error(`GMGN token info (ATH) lookup failed for ${address}:`, error);
    return undefined;
  }
}

function normalizeToken(record: Record<string, unknown>): DiscoveredToken | null {
  const address = firstString(record, ["address", "token_address", "tokenAddress", "ca"]);
  // launchpad_status 1 + complete_timestamp > 0 is the verified, authoritative 100%-completed signal;
  // the `progress` field can lag (a few completed tokens report progress < 1), so it is not used here.
  const completeTimestamp = record.complete_timestamp;
  const reachedFullBondingCurve = record.launchpad_status === 1 && typeof completeTimestamp === "number" && completeTimestamp > 0;
  const bondingValue = reachedFullBondingCurve ? completeTimestamp : (record.created_timestamp ?? record.bonding_at ?? record.bondingAt ?? record.bonding_curve_at ?? record.created_at ?? record.createdAt);
  const bondingAt = parseDate(bondingValue);
  const withinLast24Hours = bondingAt !== null && Date.now() - bondingAt.getTime() <= 24 * 60 * 60 * 1000;
  // Token age gate: `created_timestamp` is when the token contract itself was created; must be <= 1 hour old.
  const tokenCreatedAt = parseDate(record.created_timestamp);
  const isYoungEnough = tokenCreatedAt !== null && Date.now() - tokenCreatedAt.getTime() <= 60 * 60 * 1000;
  // Dex-paid status is now verified live via DexScreener's /orders/v1 endpoint (see discoverBondingCurveTokens),
  // not GMGN's own dexscr_update_link field.
  const isOnCurve = reachedFullBondingCurve && withinLast24Hours && isYoungEnough;
  if (!address || !bondingAt || !tokenCreatedAt || !isOnCurve) return null;

  return {
    address,
    symbol: firstString(record, ["symbol", "token_symbol"]),
    name: firstString(record, ["name", "token_name"]),
    bondingAt,
    isOnCurve,
    twitterUrl: firstString(record, ["twitter", "twitter_username", "twitter_url"]),
    twitterStatusPath: firstString(record, ["twitter"]),
    twitterIsTweet: record.twitter_is_tweet === true,
    websiteUrl: firstString(record, ["website", "website_url"]),
    volume24h: typeof record.volume_24h === "number" ? record.volume_24h : undefined,
    rugRatio: typeof record.rug_ratio === "number" ? record.rug_ratio : undefined,
    marketCap: typeof record.market_cap === "number" ? record.market_cap : undefined,
    totalSupply: typeof record.total_supply === "number" ? record.total_supply : undefined,
    tokenCreatedAt,
    rawData: record
  };
}

export type DiscoveryResult<T> = { tokens: T[]; reliable: boolean };

export async function discoverBondingCurveTokens(): Promise<DiscoveryResult<DiscoveredToken>> {
  // --max-bundler-rate 0.2 is GMGN's native filter for developer/bundler-held supply <= 20%,
  // confirmed empirically to constrain the bundler_trader_amount_rate field.
  const args = ["market", "trenches", "--chain", config.GMGN_CHAIN, "--type", ...ON_CURVE_CATEGORIES, "--launchpad-platform", config.GMGN_LAUNCHPAD, "--limit", "80", "--max-bundler-rate", "0.2", "--raw"];
  const { stdout } = await execFileAsync(config.GMGN_CLI_BIN, args, {
    env: { ...process.env, ...(config.GMGN_API_KEY ? { GMGN_API_KEY: config.GMGN_API_KEY } : {}) },
    maxBuffer: 10 * 1024 * 1024
  });
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("GMGN CLI returned non-JSON output");
  }
  const candidates = recordsFromPayload(payload, ON_CURVE_CATEGORIES).map(normalizeToken).filter((token): token is DiscoveredToken => token !== null);
  const dexPaidChecks = await mapSequentialWithDelay(candidates, 1100, (token) => isDexScreenerPaid(config.GMGN_CHAIN, token.address));
  const tokens = candidates.filter((_, index) => dexPaidChecks[index].paid && dexPaidChecks[index].checked);
  // "reliable" means every DexScreener check actually completed; a caller must not use an unreliable
  // (rate-limited/failed) result set to prune previously-stored, still-valid data.
  const reliable = dexPaidChecks.every((check) => check.checked);
  return { tokens, reliable };
}

// "Good Unbounded Token": bonding curve can be at ANY stage (early/new_creation included, not just near
// completion - verified new_creation records use the same launchpad_status=0/complete_timestamp=0 schema),
// but already dex paid + bundler <= 20% + organic + low rug risk + volume >= 50000.
const UNBOUNDED_CATEGORIES = ["new_creation", "near_completion"] as const;

function normalizeUnboundedToken(record: Record<string, unknown>): UnboundedDiscoveredToken | null {
  const address = firstString(record, ["address", "token_address", "tokenAddress", "ca"]);
  const completeTimestamp = record.complete_timestamp;
  const notYetCompleted = record.launchpad_status === 0 && typeof completeTimestamp === "number" && completeTimestamp === 0;
  // is_wash_trading is the CLI's own explicit "organic trading" signal; rug_ratio <= 0.3 and bundler <= 20%
  // are already enforced server-side via --max-rug-ratio/--max-bundler-rate. Dex-paid status is verified live
  // via DexScreener's /orders/v1 endpoint in discoverUnboundedTokens, not GMGN's dexscr_update_link field.
  const isOrganic = record.is_wash_trading === false;
  // Token age gate: `created_timestamp` is when the token contract itself was created; must be <= 1 hour old.
  const tokenCreatedAt = parseDate(record.created_timestamp);
  const isYoungEnough = tokenCreatedAt !== null && Date.now() - tokenCreatedAt.getTime() <= 60 * 60 * 1000;
  if (!address || !notYetCompleted || !isOrganic || !tokenCreatedAt || !isYoungEnough) return null;
  const progress = typeof record.progress === "number" ? record.progress : 0;
  const rugRatio = typeof record.rug_ratio === "number" ? record.rug_ratio : undefined;

  return {
    address,
    symbol: firstString(record, ["symbol", "token_symbol"]),
    name: firstString(record, ["name", "token_name"]),
    progress,
    rugRatio,
    twitterUrl: firstString(record, ["twitter", "twitter_username", "twitter_url"]),
    twitterStatusPath: firstString(record, ["twitter"]),
    twitterIsTweet: record.twitter_is_tweet === true,
    websiteUrl: firstString(record, ["website", "website_url"]),
    volume24h: typeof record.volume_24h === "number" ? record.volume_24h : undefined,
    marketCap: typeof record.market_cap === "number" ? record.market_cap : undefined,
    totalSupply: typeof record.total_supply === "number" ? record.total_supply : undefined,
    tokenCreatedAt,
    rawData: record
  };
}

export async function discoverUnboundedTokens(): Promise<DiscoveryResult<UnboundedDiscoveredToken>> {
  // --max-rug-ratio 0.3 is the CLI's own documented example threshold for excluding rug-pull risk.
  // --min-volume-24h 50000 is the user-specified hard volume floor for a "Good Unbounded Token".
  const args = ["market", "trenches", "--chain", config.GMGN_CHAIN, "--type", ...UNBOUNDED_CATEGORIES, "--launchpad-platform", config.GMGN_LAUNCHPAD, "--limit", "80", "--max-bundler-rate", "0.2", "--max-rug-ratio", "0.3", "--min-volume-24h", "20000", "--raw"];
  const { stdout } = await execFileAsync(config.GMGN_CLI_BIN, args, {
    env: { ...process.env, ...(config.GMGN_API_KEY ? { GMGN_API_KEY: config.GMGN_API_KEY } : {}) },
    maxBuffer: 10 * 1024 * 1024
  });
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("GMGN CLI returned non-JSON output");
  }
  const candidates = recordsFromPayload(payload, UNBOUNDED_CATEGORIES).map(normalizeUnboundedToken).filter((token): token is UnboundedDiscoveredToken => token !== null);
  const dexPaidChecks = await mapSequentialWithDelay(candidates, 1100, (token) => isDexScreenerPaid(config.GMGN_CHAIN, token.address));
  const tokens = candidates.filter((_, index) => dexPaidChecks[index].paid && dexPaidChecks[index].checked);
  const reliable = dexPaidChecks.every((check) => check.checked);
  return { tokens, reliable };
}

export async function discoverEarlyTokens(): Promise<EarlyDiscoveredToken[]> {
  const args = ["market", "trenches", "--chain", config.GMGN_CHAIN, "--type", "new_creation", "--launchpad-platform", config.GMGN_LAUNCHPAD, "--limit", "80", "--raw"];
  const { stdout } = await execFileAsync(config.GMGN_CLI_BIN, args, {
    env: { ...process.env, ...(config.GMGN_API_KEY ? { GMGN_API_KEY: config.GMGN_API_KEY } : {}) },
    maxBuffer: 10 * 1024 * 1024
  });
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error("GMGN CLI returned non-JSON output");
  }
  return recordsFromPayload(payload, ["new_creation"])
    .filter((record) => typeof record.market_cap === "number" && record.market_cap >= 2000 && record.market_cap < 3000 && typeof record.ath_price !== "number" && typeof record.volume_24h === "number" && record.volume_24h >= 20000)
    .map(normalizeEarlyToken)
    .filter((token): token is EarlyDiscoveredToken => token !== null);
}

function normalizeEarlyToken(record: Record<string, unknown>): EarlyDiscoveredToken | null {
  const address = firstString(record, ["address", "token_address", "tokenAddress", "ca"]);
  const tokenCreatedAt = parseDate(record.created_timestamp);
  if (!address || !tokenCreatedAt) return null;
  return {
    address,
    symbol: firstString(record, ["symbol", "token_symbol"]),
    name: firstString(record, ["name", "token_name"]),
    progress: typeof record.progress === "number" ? record.progress : 0,
    rugRatio: typeof record.rug_ratio === "number" ? record.rug_ratio : undefined,
    twitterUrl: firstString(record, ["twitter", "twitter_username", "twitter_url"]),
    twitterStatusPath: firstString(record, ["twitter"]),
    twitterIsTweet: record.twitter_is_tweet === true,
    websiteUrl: firstString(record, ["website", "website_url"]),
    volume24h: typeof record.volume_24h === "number" ? record.volume_24h : undefined,
    marketCap: typeof record.market_cap === "number" ? record.market_cap : undefined,
    totalSupply: typeof record.total_supply === "number" ? record.total_supply : undefined,
    tokenCreatedAt,
    rawData: record
  };
}
