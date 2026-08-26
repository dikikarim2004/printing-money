import { config } from "./config.js";
import { discoverBondingCurveTokens, discoverUnboundedTokens } from "./gmgn.js";
import { enrichSocial } from "./enrichment.js";
import { prisma, pumpUrl, pruneUnboundedTokens, removeCompletedFromUnbounded, saveToken, saveUnboundedToken } from "./repository.js";
import { bot, notifyNewToken, notifyNewUnboundedToken, setLatestScreeningStatus } from "./telegram.js";

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
    // Point 3: a token that just reached 100% no longer belongs in the not-yet-100% unbounded table.
    await removeCompletedFromUnbounded(tokens.map((token) => token.address));
    console.log(`Scan complete: ${tokens.length} verified bonding-curve token(s)`);

    const unboundedTokens = await discoverUnboundedTokens();
    for (const token of unboundedTokens) {
      try {
        const social = await enrichSocial(token);
        const { isNew } = await saveUnboundedToken(token, social);
        if (isNew) {
          console.log(`Good Unbounded Token detected by GMGN | ${token.symbol ?? token.name ?? "Unknown token"} | ${token.address} | progress=${token.progress}`);
          await notifyNewUnboundedToken({ ...token, pumpUrl: pumpUrl(token.address), xMentionCount: social.xMentionCount ?? null, createdAt: new Date() });
        }
      } catch (error) {
        console.error(`Could not save unbounded ${token.address}:`, error);
      }
    }
    // A row whose address is missing from this scan's fresh results no longer qualifies (dex paid reverted,
    // bundler rose, wash trading, or it aged out of GMGN's window) and must be pruned, not left stale.
    await pruneUnboundedTokens(unboundedTokens.map((token) => token.address));
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
await bot.api.setMyCommands([
  { command: "start", description: "Tampilkan menu utama" },
  { command: "menu", description: "Tampilkan menu utama" },
  { command: "status", description: "Lihat status screening" },
  { command: "latest", description: "Token terbaru" },
  { command: "all", description: "Semua token" },
  { command: "unbounded", description: "Good Unbounded Token" },
  { command: "topmentions", description: "Top mention X" }
]);
await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
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
