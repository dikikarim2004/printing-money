import { config } from "./config.js";
import { discoverBondingCurveTokens, discoverEarlyTokens, discoverUnboundedTokens, fetchAthMarketCap } from "./gmgn.js";
import { enrichSocial } from "./enrichment.js";
import { prisma, pumpUrl, pruneExpiredUnboundedTokens, removeCompletedFromUnbounded, getUnboundedVolumes, saveEarlyToken, saveToken, saveUnboundedToken } from "./repository.js";
import { bot, notifyNewEarlyToken, notifyNewToken, notifyNewUnboundedToken, setLatestScreeningStatus } from "./telegram.js";
import { handleEarlyTokenForAutoTrade, startAutoTradeWorker } from "./autotrade.js";

let polling = false;
async function scan(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const { tokens } = await discoverBondingCurveTokens();
    const status = `Screening selesai | ${new Date().toISOString()} | ${tokens.length} token bonding curve terverifikasi oleh GMGN`;
    setLatestScreeningStatus(status);
    console.log(status);
    // Must be read before removeCompletedFromUnbounded deletes these rows: it holds the volume while the
    // bonding curve was still <100%, which is what jumlah_volume should be frozen to (point 1 revision).
    const preCompletionVolumes = await getUnboundedVolumes(tokens.map((token) => token.address));
    for (const token of tokens) {
      try {
        const social = await enrichSocial(token);
        // Point 1a: no X mentions means we skip saving/notifying entirely, not just hiding the count.
        if (!social.xMentionCount || social.xMentionCount < 1) continue;
        const preCompletionVolume = preCompletionVolumes.get(token.address);
        // Fetched only now (after every other filter already passed) to avoid wasting GMGN calls on candidates
        // that end up skipped anyway.
        const athMarketCap = await fetchAthMarketCap(config.GMGN_CHAIN, token.address, token.totalSupply);
        const { isNew } = await saveToken(token, social, preCompletionVolume, athMarketCap);
        console.log(`Bonding curve detected by GMGN | ${token.symbol ?? token.name ?? "Unknown token"} | ${token.address} | ${token.bondingAt.toISOString()} | is_on_curve=${String(token.isOnCurve)}`);
        if (isNew) {
          await notifyNewToken({ ...token, pumpUrl: pumpUrl(token.address), xMentionCount: social.xMentionCount ?? null, jumlah_volume: preCompletionVolume ?? token.volume24h ?? null, athMarketCap: athMarketCap ?? null });
        }
      } catch (error) {
        console.error(`Could not save ${token.address}:`, error);
      }
    }
    // Point 3: a token that just reached 100% no longer belongs in the not-yet-100% unbounded table.
    // Safe unconditionally: removeCompletedFromUnbounded only deletes addresses explicitly IN this list.
    // Uses the full completed-curve list regardless of the X-mentions gate above (curve status, not notification eligibility).
    await removeCompletedFromUnbounded(tokens.map((token) => token.address));
    console.log(`Scan complete: ${tokens.length} verified bonding-curve token(s)`);

    const { tokens: unboundedTokens } = await discoverUnboundedTokens();
    for (const token of unboundedTokens) {
      try {
        const social = await enrichSocial(token);
        // A transient fxtwitter failure (had a real tweet link, but couldn't verify it right now): skip saving
        // this cycle rather than guessing, but do not treat it as a disqualification signal.
        if (social.mentionCheckFailed) continue;
        // Point 1a: no X mentions means we skip saving/notifying entirely, not just hiding the count.
        if (!social.xMentionCount || social.xMentionCount < 1) continue;
        const athMarketCap = await fetchAthMarketCap(config.GMGN_CHAIN, token.address, token.totalSupply);
        const { isNew } = await saveUnboundedToken(token, social, athMarketCap);
        if (isNew) {
          console.log(`Good Unbounded Token detected by GMGN | ${token.symbol ?? token.name ?? "Unknown token"} | ${token.address} | progress=${token.progress}`);
          await notifyNewUnboundedToken({ ...token, pumpUrl: pumpUrl(token.address), xMentionCount: social.xMentionCount ?? null, jumlah_volume: token.volume24h ?? null, athMarketCap: athMarketCap ?? null, createdAt: new Date() });
        }
      } catch (error) {
        console.error(`Could not save unbounded ${token.address}:`, error);
      }
    }
    // A saved unbounded row is removed only for the two explicit criteria the user specified: reaching 100%
    // (removeCompletedFromUnbounded above) or exceeding the 1-hour token-age limit. It is deliberately NOT
    // re-pruned just because a volatile field (bundler rate, dex paid) drifted on a later live re-check -
    // that previously caused just-notified tokens to disappear within minutes (verified: bundler_trader_amount_rate
    // rose from <=20% at capture to 22.92% nine minutes later for the same token).
    await pruneExpiredUnboundedTokens(60 * 60 * 1000);

    const earlyTokens = await discoverEarlyTokens();
    for (const token of earlyTokens) {
      try {
        const social = await enrichSocial(token);
        if (social.mentionCheckFailed || !social.xMentionCount || social.xMentionCount < 1) continue;
        const { isNew } = await saveEarlyToken(token, social);
        if (isNew) {
          await handleEarlyTokenForAutoTrade(token);
          await notifyNewEarlyToken({ ...token, pumpUrl: pumpUrl(token.address), xMentionCount: social.xMentionCount, jumlah_volume: token.volume24h ?? null, athMarketCap: null, createdAt: new Date() });
        }
      } catch (error) {
        console.error(`Could not save early token ${token.address}:`, error);
      }
    }
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
  { command: "topmentions", description: "Top mention X" },
  { command: "early", description: "Early Token" },
  { command: "wallet", description: "Wallet SOL" },
  { command: "configtrade", description: "Konfigurasi auto-trade" },
  { command: "tradepositions", description: "Open trade positions" }
]);
await bot.api.setChatMenuButton({ menu_button: { type: "commands" } });
void bot.start({ onStart: () => console.log("Telegram bot started") }).catch((error) => {
  console.error("Telegram polling failed:", error);
  process.exit(1);
});
await scan();
setInterval(() => void scan(), config.POLL_INTERVAL_SECONDS * 1000);
startAutoTradeWorker();

const shutdown = async () => {
  await bot.stop();
  await prisma.$disconnect();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
