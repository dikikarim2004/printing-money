import { config } from "./config.js";
import { discoverBondingCurveTokens } from "./gmgn.js";
import { enrichSocial } from "./enrichment.js";
import { prisma, saveToken } from "./repository.js";
import { bot, setLatestScreeningStatus } from "./telegram.js";

let polling = false;
async function scan(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const tokens = await discoverBondingCurveTokens();
    const status = `Screening selesai | ${new Date().toISOString()} | ${tokens.length} token bonding curve terverifikasi oleh GMGN`;
    setLatestScreeningStatus(status);
    console.log(status);
    for (const token of tokens) {
      try {
        await saveToken(token, await enrichSocial(token));
        console.log(`Bonding curve detected by GMGN | ${token.symbol ?? token.name ?? "Unknown token"} | ${token.address} | ${token.bondingAt.toISOString()} | is_on_curve=${String(token.isOnCurve)}`);
      } catch (error) {
        console.error(`Could not save ${token.address}:`, error);
      }
    }
    console.log(`Scan complete: ${tokens.length} verified bonding-curve token(s)`);
  } catch (error) {
    console.error("Scan failed:", error);
    const message = `Screening gagal: ${error instanceof Error ? error.message : "unknown error"}`;
    setLatestScreeningStatus(message);
    console.error(message);
  } finally {
    polling = false;
  }
}

await prisma.$connect();
await bot.start({ onStart: () => console.log("Telegram bot started") });
await scan();
setInterval(() => void scan(), config.POLL_INTERVAL_SECONDS * 1000);

const shutdown = async () => {
  await bot.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
