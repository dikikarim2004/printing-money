import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "./config.js";
import type { DiscoveredToken } from "./types.js";

const execFileAsync = promisify(execFile);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

function recordsFromPayload(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.reduce<Record<string, unknown>[]>((records, item) => {
    const record = asRecord(item);
    if (record) records.push(record);
    return records;
  }, []);
  const root = asRecord(payload);
  for (const key of ["data", "tokens", "list", "rows", "result"]) {
    const value = root?.[key];
    if (Array.isArray(value)) return value.reduce<Record<string, unknown>[]>((records, item) => {
      const record = asRecord(item);
      if (record) records.push(record);
      return records;
    }, []);
    const nested = asRecord(value);
    if (Array.isArray(nested?.data)) return nested.data.reduce<Record<string, unknown>[]>((records, item) => {
      const record = asRecord(item);
      if (record) records.push(record);
      return records;
    }, []);
  }
  return [];
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
  const bondingValue = record.bonding_at ?? record.bondingAt ?? record.bonding_curve_at ?? record.created_at ?? record.createdAt;
  const bondingAt = parseDate(bondingValue);
  const isOnCurve = record.is_on_curve ?? record.isOnCurve;
  if (!address || !bondingAt || typeof isOnCurve !== "boolean" || !isOnCurve) return null;

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
  const args = ["market", "trenches", "--chain", config.GMGN_CHAIN, "--type", "near_completion", "--launchpad-platform", config.GMGN_LAUNCHPAD, "--limit", "80", "--raw"];
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
  return recordsFromPayload(payload).map(normalizeToken).filter((token): token is DiscoveredToken => token !== null);
}
