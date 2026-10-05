import { config } from "./config.js";
import { discoverBondingCurveTokens, discoverEarlyTokens, discoverUnboundedTokens, fetchAthMarketCap, isGmgnCoolingDown } from "./gmgn.js";
import { enrichSocial } from "./enrichment.js";
import { ensureAllUserChainWallets, getUserFeedConfig, prisma, tokenUrl, pruneExpiredUnboundedTokens, removeCompletedFromUnbounded, getUnboundedVolumes, listUserFeedConfigs, saveEarlyToken, saveToken, saveUnboundedToken } from "./repository.js";
import { bot, notifyNewEarlyToken, notifyNewToken, notifyNewUnboundedToken, setLatestScreeningStatus } from "./telegram.js";
import { handleTokenForAutoTrade, startAutoTradeWorker } from "./autotrade.js";

let polling = false;
async function scan(): Promise<void> {
  if (polling) return;
  if (isGmgnCoolingDown()) {
    const message = "GMGN screening paused during rate-limit cooldown; no requests are being sent.";
    setLatestScreeningStatus(message);
    return;
  }
  polling = true;
  try {
    const feedConfigs = await listUserFeedConfigs();
    const runtimeOptions = feedConfigs.length ? feedConfigs.map((feed) => ({
      chain: feed.chain === "SOLANA" ? config.GMGN_CHAIN : config.ROBINHOOD_GMGN_CHAIN,
      completedTypes: feed.completedTypes,
      completedLimit: feed.completedLimit,
      unboundedTypes: feed.unboundedTypes,
      unboundedLimit: feed.unboundedLimit,
      unboundedMinVolume24h: feed.unboundedMinVolume24h,
      earlyTypes: feed.earlyTypes,
      earlyLimit: feed.earlyLimit,
      earlyMinVolume24h: feed.earlyMinVolume24h,
      earlyMaxTokenAgeMinutes: feed.earlyMaxTokenAgeMinutes
    })) : [undefined];
    const uniqueRuntimeOptions = [...new Map(runtimeOptions.map((options) => [options?.chain ?? config.GMGN_CHAIN, options])).values()];
    const completedResults = [];
    for (const options of uniqueRuntimeOptions) {
      try {
        const result = await discoverBondingCurveTokens(options);
        completedResults.push(result);
        console.log(`GMGN completed screening | chain=${options?.chain ?? config.GMGN_CHAIN} | candidates=${result.tokens.length}`);
      } catch (error) {
        console.error(`GMGN completed screening failed | chain=${options?.chain ?? config.GMGN_CHAIN}:`, error);
        completedResults.push({ tokens: [], reliable: false });
      }
    }
    const tokens = [...new Map(completedResults.flatMap((result, index) => result.tokens.map((token) => ({ ...token, chain: uniqueRuntimeOptions[index]?.chain ?? config.GMGN_CHAIN }))).map((token) => [`${token.chain}:${token.address}`, token])).values()];
    const status = `Screening complete | ${new Date().toISOString()} | ${tokens.length} GMGN-verified bonding-curve token(s)`;
    setLatestScreeningStatus(status);
    console.log(status);
    // Must be read before removeCompletedFromUnbounded deletes these rows: it holds the volume while the
    // bonding curve was still <100%, which is what jumlah_volume should be frozen to (point 1 revision).
    const preCompletionVolumes = await getUnboundedVolumes(tokens.map((token) => ({ address: token.address, chain: token.chain ?? config.GMGN_CHAIN })));
    for (const token of tokens) {
      try {
        const social = await enrichSocial(token);
        const tokenChain = token.chain ?? config.GMGN_CHAIN;
        const preCompletionVolume = preCompletionVolumes.get(`${tokenChain}:${token.address}`);
        // Fetched only now (after every other filter already passed) to avoid wasting GMGN calls on candidates
        // that end up skipped anyway.
        const athMarketCap = await fetchAthMarketCap(tokenChain, token.address, token.totalSupply);
        const { isNew } = await saveToken(token, social, preCompletionVolume, athMarketCap);
        console.log(`Bonding curve detected by GMGN | ${token.symbol ?? token.name ?? "Unknown token"} | ${token.address} | ${token.bondingAt.toISOString()} | is_on_curve=${String(token.isOnCurve)}`);
        if (isNew) {
          await notifyNewToken({ ...token, pumpUrl: tokenUrl(tokenChain, token.address), xMentionCount: social.xMentionCount ?? null, jumlah_volume: preCompletionVolume ?? token.volume24h ?? null, athMarketCap: athMarketCap ?? null });
        }
      } catch (error) {
        console.error(`Could not save ${token.address}:`, error);
      }
    }
    // Point 3: a token that just reached 100% no longer belongs in the not-yet-100% unbounded table.
    // Safe unconditionally: removeCompletedFromUnbounded only deletes addresses explicitly IN this list.
    // Uses the full completed-curve list regardless of the X-mentions gate above (curve status, not notification eligibility).
    await removeCompletedFromUnbounded(tokens.map((token) => ({ address: token.address, chain: token.chain ?? config.GMGN_CHAIN })));
    console.log(`Scan complete: ${tokens.length} verified bonding-curve token(s)`);

    const unboundedResults = [];
    for (const options of uniqueRuntimeOptions) {
      if (isGmgnCoolingDown()) break;
      try {
        const result = await discoverUnboundedTokens(options);
        unboundedResults.push(result);
        console.log(`GMGN unbounded screening | chain=${options?.chain ?? config.GMGN_CHAIN} | candidates=${result.tokens.length}`);
      } catch (error) {
        console.error(`GMGN unbounded screening failed | chain=${options?.chain ?? config.GMGN_CHAIN}:`, error);
        unboundedResults.push({ tokens: [], reliable: false });
      }
    }
    const unboundedTokens = [...new Map(unboundedResults.flatMap((result, index) => result.tokens.map((token) => ({ ...token, chain: uniqueRuntimeOptions[index]?.chain ?? config.GMGN_CHAIN }))).map((token) => [`${token.chain}:${token.address}`, token])).values()];
    for (const token of unboundedTokens) {
      try {
        const social = await enrichSocial(token);
        // A transient fxtwitter failure (had a real tweet link, but couldn't verify it right now): skip saving
        // this cycle rather than guessing, but do not treat it as a disqualification signal.
        if (social.mentionCheckFailed) continue;
        const tokenChain = token.chain ?? config.GMGN_CHAIN;
        const athMarketCap = await fetchAthMarketCap(tokenChain, token.address, token.totalSupply);
        const { isNew } = await saveUnboundedToken(token, social, athMarketCap);
        if (isNew) {
          await handleTokenForAutoTrade(token, "UNBOUNDED");
          console.log(`Good Unbounded Token detected by GMGN | ${token.symbol ?? token.name ?? "Unknown token"} | ${token.address} | progress=${token.progress}`);
          await notifyNewUnboundedToken({ ...token, pumpUrl: tokenUrl(tokenChain, token.address), xMentionCount: social.xMentionCount ?? null, jumlah_volume: token.volume24h ?? null, athMarketCap: athMarketCap ?? null, createdAt: new Date() });
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

    const earlyResults = [];
    for (const options of uniqueRuntimeOptions) {
      if (isGmgnCoolingDown()) break;
      try {
        const result = await discoverEarlyTokens(options);
        earlyResults.push(result);
        console.log(`GMGN early screening | chain=${options?.chain ?? config.GMGN_CHAIN} | candidates=${result.length}`);
      } catch (error) {
        console.error(`GMGN early screening failed | chain=${options?.chain ?? config.GMGN_CHAIN}:`, error);
        earlyResults.push([]);
      }
    }
    const earlyTokens = [...new Map(earlyResults.flatMap((result, index) => result.map((token) => ({ ...token, chain: uniqueRuntimeOptions[index]?.chain ?? config.GMGN_CHAIN }))).map((token) => [`${token.chain}:${token.address}`, token])).values()];
    for (const token of earlyTokens) {
      try {
        const social = await enrichSocial(token);
        if (social.mentionCheckFailed) continue;
        const { isNew } = await saveEarlyToken(token, social);
        if (isNew) {
          await handleTokenForAutoTrade(token, "EARLY");
          await notifyNewEarlyToken({ ...token, pumpUrl: tokenUrl(token.chain ?? config.GMGN_CHAIN, token.address), xMentionCount: social.xMentionCount ?? null, jumlah_volume: token.volume24h ?? null, athMarketCap: null, createdAt: new Date() });
        }
      } catch (error) {
        console.error(`Could not save early token ${token.address}:`, error);
      }
    }
  } catch (error) {
    console.error("Scan failed:", error);
    const message = `Screening failed: ${error instanceof Error ? error.message : "unknown error"}`;
    setLatestScreeningStatus(message);
    console.error(message);
  } finally {
    polling = false;
  }
}

await prisma.$connect();
await ensureAllUserChainWallets();
await bot.api.setMyCommands([
  { command: "start", description: "Show the main menu" },
  { command: "menu", description: "Show the main menu" },
  { command: "status", description: "Show screening status" },
  { command: "latest", description: "Show latest tokens" },
  { command: "all", description: "Show all tokens" },
  { command: "unbounded", description: "Show unbounded feed" },
  { command: "topmentions", description: "Show top X mentions" },
  { command: "early", description: "Show early feed" },
  { command: "wallet", description: "Manage wallets" },
  { command: "wallets", description: "Manage wallets" },
  { command: "configsystem", description: "Configure your feed and chain" },
  { command: "configtrade", description: "Configure auto-trade" },
  { command: "tradepositions", description: "Show open trade positions" }
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
