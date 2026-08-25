import { config } from "./config.js";
import { discoverBondingCurveTokens } from "./gmgn.js";
import { enrichSocial } from "./enrichment.js";
import { prisma, pumpUrl, saveToken } from "./repository.js";
import { bot, notifyNewToken, setLatestScreeningStatus } from "./telegram.js";

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
        const social = await enrichSocial(token);
        const { isNew } = await saveToken(token, social);
        console.log(`Bonding curve detected by GMGN | ${token.symbol ?? token.name ?? "Unknown token"} | ${token.address} | ${token.bondingAt.toISOString()} | is_on_curve=${String(token.isOnCurve)}`);
        if (isNew) {
          await notifyNewToken({ ...token, pumpUrl: pumpUrl(token.address), xMentionCount: social.xMentionCount ?? null });
        }
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
void bot.start({ onStart: () => console.log("Telegram bot started") }).catch((error) => {
  console.error("Telegram polling failed:", error);
  process.exit(1);
});
await scan();
setInterval(() => void scan(), config.POLL_INTERVAL_SECONDS * 1000);

const shutdown = async () => {
  await bot.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
