import { z } from "zod";

const schema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  POLL_INTERVAL_SECONDS: z.coerce.number().int().min(5).default(5),
  GMGN_CLI_BIN: z.string().default("gmgn-cli"),
  GMGN_API_KEY: z.string().optional(),
  GMGN_CHAIN: z.string().default("sol"),
  GMGN_LAUNCHPAD: z.string().default("Pump.fun"),
  X_ENRICHMENT_URL: z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional()),
  X_ENRICHMENT_TOKEN: z.preprocess((value) => value === "" ? undefined : value, z.string().optional())
});

export const config = schema.parse(process.env);
