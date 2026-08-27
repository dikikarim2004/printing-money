import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(5),
  GMGN_CLI_BIN: z.string().default("gmgn-cli"),
  GMGN_API_KEY: z.string().optional(),
  GMGN_CHAIN: z.string().default("sol"),
  GMGN_LAUNCHPAD: z.string().default("Pump.fun"),
  SOLANA_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
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
