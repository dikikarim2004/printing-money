import { z } from "zod";

const envBoolean = (defaultValue: boolean) => z.preprocess((value) => {
  if (value === undefined) return defaultValue;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return value;
}, z.boolean());

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(5),
  GMGN_CLI_BIN: z.string().default("gmgn-cli"),
  GMGN_API_KEY: z.string().optional(),
  GMGN_REQUEST_DELAY_MS: z.coerce.number().int().min(1000).default(1100),
  GMGN_RATE_LIMIT_COOLDOWN_MS: z.coerce.number().int().min(1000).default(5 * 60 * 1000),
  GMGN_CHAIN: z.string().default("sol"),
  ROBINHOOD_GMGN_CHAIN: z.string().default("robinhood"),
  GMGN_LAUNCHPAD: z.string().default("Pump.fun"),
  GMGN_COMPLETED_TYPES: z.string().default("completed"),
  GMGN_COMPLETED_LIMIT: z.coerce.number().int().positive().default(80),
  GMGN_COMPLETED_MAX_BUNDLER_RATE: z.coerce.number().min(0).max(1).default(0.2),
  GMGN_COMPLETED_MAX_BONDING_AGE_HOURS: z.coerce.number().positive().default(24),
  GMGN_COMPLETED_MAX_TOKEN_AGE_HOURS: z.coerce.number().positive().default(1),
  GMGN_COMPLETED_MIN_X_MENTIONS: z.coerce.number().int().nonnegative().default(1),
  GMGN_UNBOUNDED_TYPES: z.string().default("new_creation,near_completion"),
  GMGN_UNBOUNDED_LIMIT: z.coerce.number().int().positive().default(80),
  GMGN_UNBOUNDED_MAX_BUNDLER_RATE: z.coerce.number().min(0).max(1).default(0.2),
  GMGN_UNBOUNDED_MAX_RUG_RATIO: z.coerce.number().min(0).max(1).default(0.3),
  GMGN_UNBOUNDED_MIN_VOLUME_24H: z.coerce.number().nonnegative().default(50000),
  GMGN_UNBOUNDED_MAX_TOKEN_AGE_HOURS: z.coerce.number().positive().default(1),
  GMGN_UNBOUNDED_MIN_X_MENTIONS: z.coerce.number().int().nonnegative().default(1),
  GMGN_EARLY_TYPES: z.string().default("new_creation"),
  GMGN_EARLY_LIMIT: z.coerce.number().int().positive().default(80),
  GMGN_EARLY_MIN_MARKET_CAP: z.coerce.number().nonnegative().default(2000),
  GMGN_EARLY_MAX_MARKET_CAP: z.coerce.number().positive().default(3000),
  GMGN_EARLY_MIN_VOLUME_24H: z.coerce.number().nonnegative().default(20000),
  GMGN_EARLY_MAX_TOKEN_AGE_MINUTES: z.coerce.number().positive().default(15),
  GMGN_EARLY_MIN_X_MENTIONS: z.coerce.number().int().nonnegative().default(1),
  GMGN_DEXSCREENER_REQUEST_DELAY_MS: z.coerce.number().int().nonnegative().default(1100),
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  ROBINHOOD_RPC_URL: z.string().default(""),
  ROBINHOOD_TOKEN_URL_TEMPLATE: z.string().default("https://pump.fun/coin/{address}"),
  ROBINHOOD_NATIVE_DECIMALS: z.coerce.number().int().min(0).max(36).default(18),
  ROBINHOOD_NATIVE_SYMBOL: z.string().default("ETH"),
  ROBINHOOD_CHAIN_ID: z.coerce.number().int().refine((value) => value === 4663, "Robinhood chain ID must be 4663").default(4663),
  ROBINHOOD_UNISWAP_API_KEY: z.string().default(""),
  ROBINHOOD_UNISWAP_INTEGRATOR_FEE_RECIPIENT: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  ROBINHOOD_UNISWAP_INTEGRATOR_FEES_JSON: z.string().default(""),
  ROBINHOOD_UNISWAP_UNIVERSAL_ROUTER: z.string().default("0x8876789976decbfcbbbe364623c63652db8c0904"),
  ROBINHOOD_UNISWAP_LIVE_ENABLED: envBoolean(false),
  ROBINHOOD_UNISWAP_TESTED: envBoolean(false),
  UNISWAP_API_BASE_URL: z.string().url().default("https://trade-api.gateway.uniswap.org/v1"),
  WALLET_ENCRYPTION_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, "WALLET_ENCRYPTION_KEY must be 32 bytes in hex"),
  JUPITER_API_KEY: z.string().default(""),
  JUPITER_PRICE_API: z.string().url().default("https://api.jup.ag/price/v3"),
  JUPITER_SWAP_V2_API: z.string().url().default("https://api.jup.ag/swap/v2"),
  JUPITER_REFERRAL_ACCOUNT: z.string().default("BRbthXbSFKbndyVnRicDz91wUiH113p62sipFfd47ZVt"),
  JUPITER_REFERRAL_FEE_BPS: z.coerce.number().int().min(50).max(255).default(50),
  X_ENRICHMENT_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  X_ENRICHMENT_TOKEN: z.preprocess((value) => value === "" ? undefined : value, z.string().optional())
});

export const config = schema.parse(process.env);
