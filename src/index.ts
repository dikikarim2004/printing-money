import { config } from "./config.js";
import { discoverBondingCurveTokens } from "./gmgn.js";
import { enrichSocial } from "./enrichment.js";
import { prisma, saveToken } from "./repository.js";
import { bot } from "./telegram.js";

let polling = false;
async function scan(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const tokens = await discoverBondingCurveTokens();
    for (const token of tokens) {
      try {
        await saveToken(token, await enrichSocial(token));
      } catch (error) {
        console.error(`Could not save ${token.address}:`, error);
      }
    }
    console.log(`Scan complete: ${tokens.length} verified bonding-curve token(s)`);
  } catch (error) {
    console.error("Scan failed:", error);
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
