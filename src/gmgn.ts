import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { DiscoveredToken, UnboundedDiscoveredToken } from "./types.js";

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
  const records: Record<string, unknown>[] = [];
  for (const category of categories) {
    const value = root[category];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      const record = asRecord(item);
      if (record) records.push(record);
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

function normalizeToken(record: Record<string, unknown>): DiscoveredToken | null {
  const address = firstString(record, ["address", "token_address", "tokenAddress", "ca"]);
  // launchpad_status 1 + complete_timestamp > 0 is the verified, authoritative 100%-completed signal;
  // the `progress` field can lag (a few completed tokens report progress < 1), so it is not used here.
  const completeTimestamp = record.complete_timestamp;
  const reachedFullBondingCurve = record.launchpad_status === 1 && typeof completeTimestamp === "number" && completeTimestamp > 0;
  const bondingValue = reachedFullBondingCurve ? completeTimestamp : (record.created_timestamp ?? record.bonding_at ?? record.bondingAt ?? record.bonding_curve_at ?? record.created_at ?? record.createdAt);
  const bondingAt = parseDate(bondingValue);
  const withinLast24Hours = bondingAt !== null && Date.now() - bondingAt.getTime() <= 24 * 60 * 60 * 1000;
  // dexscr_update_link (confirmed via `token info`'s dev.dexscr_update_link) marks a paid DexScreener info update.
  const isDexPaid = record.dexscr_update_link === true;
  const isOnCurve = reachedFullBondingCurve && withinLast24Hours && isDexPaid;
  if (!address || !bondingAt || !isOnCurve) return null;

  return {
    address,
    symbol: firstString(record, ["symbol", "token_symbol"]),
    name: firstString(record, ["name", "token_name"]),
    bondingAt,
    isOnCurve,
    twitterUrl: firstString(record, ["twitter", "twitter_username", "twitter_url"]),
    websiteUrl: firstString(record, ["website", "website_url"]),
    rawData: record
  };
}

export async function discoverBondingCurveTokens(): Promise<DiscoveredToken[]> {
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
  return recordsFromPayload(payload, ON_CURVE_CATEGORIES).map(normalizeToken).filter((token): token is DiscoveredToken => token !== null);
}

// "Good Unbounded Token": still progressing on the bonding curve (verified progress always < 1, complete_timestamp
// always 0 for near_completion), but already dex paid + bundler <= 20% + organic + low rug risk.
const UNBOUNDED_CATEGORIES = ["near_completion"] as const;

function normalizeUnboundedToken(record: Record<string, unknown>): UnboundedDiscoveredToken | null {
  const address = firstString(record, ["address", "token_address", "tokenAddress", "ca"]);
  const completeTimestamp = record.complete_timestamp;
  const notYetCompleted = record.launchpad_status === 0 && typeof completeTimestamp === "number" && completeTimestamp === 0;
  const isDexPaid = record.dexscr_update_link === true;
  // is_wash_trading is the CLI's own explicit "organic trading" signal; rug_ratio <= 0.3 and bundler <= 20%
  // are already enforced server-side via --max-rug-ratio/--max-bundler-rate.
  const isOrganic = record.is_wash_trading === false;
  if (!address || !notYetCompleted || !isDexPaid || !isOrganic) return null;
  const progress = typeof record.progress === "number" ? record.progress : 0;
  const rugRatio = typeof record.rug_ratio === "number" ? record.rug_ratio : undefined;

  return {
    address,
    symbol: firstString(record, ["symbol", "token_symbol"]),
    name: firstString(record, ["name", "token_name"]),
    progress,
    rugRatio,
    twitterUrl: firstString(record, ["twitter", "twitter_username", "twitter_url"]),
    websiteUrl: firstString(record, ["website", "website_url"]),
    rawData: record
  };
}

export async function discoverUnboundedTokens(): Promise<UnboundedDiscoveredToken[]> {
  // --max-rug-ratio 0.3 is the CLI's own documented example threshold for excluding rug-pull risk.
  const args = ["market", "trenches", "--chain", config.GMGN_CHAIN, "--type", ...UNBOUNDED_CATEGORIES, "--launchpad-platform", config.GMGN_LAUNCHPAD, "--limit", "80", "--max-bundler-rate", "0.2", "--max-rug-ratio", "0.3", "--raw"];
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
  return recordsFromPayload(payload, UNBOUNDED_CATEGORIES).map(normalizeUnboundedToken).filter((token): token is UnboundedDiscoveredToken => token !== null);
}
