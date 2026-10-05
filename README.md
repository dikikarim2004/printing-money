# Pump.fun Bonding Curve Telegram Bot

Phase 1 service for screening Solana Pump.fun tokens through the official GMGN CLI, storing verified bonding-curve observations in PostgreSQL, and presenting them in Telegram.

## Verified integration boundary

GMGN's current public documentation lists `market trenches` with `new_creation`, `near_completion`, and `completed` token types, supports `--launchpad-platform Pump.fun`, and documents `is_on_curve` as the bonding-curve status. The service calls the official CLI with `--raw`; it does not scrape undocumented `gmgn.ai` web endpoints.

The public docs also state a default rate limit of 1 request/second. The default 5-second poll interval is configurable but never permits less than 5 seconds.

## Setup

1. Install Node.js 22+ and PostgreSQL, or run `docker compose up -d`.
2. Install the official CLI and configure a personal API key as documented at https://github.com/GMGNAI/gmgn-skills.
3. Copy `.env.example` to `.env`, then fill `TELEGRAM_BOT_TOKEN`, `DATABASE_URL`, and `GMGN_API_KEY`. No Telegram chat ID is required: Telegram replies use the `chat.id` from the incoming request.
4. Run `npm run db:generate` and `npm run db:push`.
5. Run `npm run dev`.

The persistent Telegram menu exposes the same actions as buttons: latest tokens, all tokens, top X mentions, and screening status. Commands `/latest`, `/all`, `/topmentions`, and `/menu` remain available. Every token links to its Pump.fun page.

GMGN screening is serialized globally with a configurable minimum request interval (`GMGN_REQUEST_DELAY_MS`, default 1100 ms). A rate-limit response pauses all screening for `GMGN_RATE_LIMIT_COOLDOWN_MS` and does not retry during that pause. Feed configurations using the same chain are deduplicated into one screening request per stage.

Robinhood native balance checks use `ROBINHOOD_RPC_URL` and the EVM `eth_getBalance` method. The native unit display is configured by `ROBINHOOD_NATIVE_SYMBOL` and `ROBINHOOD_NATIVE_DECIMALS`. Token links currently use the same Pump.fun URL shape as Solana (`https://pump.fun/coin/{address}`); the URL template is used only after it is changed to a verified official endpoint. Robinhood swap execution is intentionally blocked until a verified swap adapter exists; it must never route an EVM key through Jupiter/Solana.

`/wallet` and `/wallets` show the active wallet with `✅` for each chain. Selecting a wallet stores the active wallet pointer in the feed configuration; existing users without a pointer temporarily fall back to their oldest wallet for that chain. Export is available only for the active wallet, requires a second confirmation, and is allowed only in a private Telegram chat. The private key is decrypted only for that response and is never logged.

Auto-trade source is selected in Trade Config as `EARLY` or `UNBOUNDED`, and is evaluated together with each user's Feed Config chain. Open-position limits and monitoring are chain-specific. Solana SELLs use the configured `JUPITER_REFERRAL_ACCOUNT` fee account; its referral fee-account lookup is cached and transient failures are retried after a cooldown. Robinhood ETH amount configuration is stored, but Robinhood swap execution remains disabled until a verified EVM swap adapter is available.

Robinhood swaps are implemented in `src/evm-adapter/robinhood.ts` and are restricted to chain ID 4663. The adapter uses Uniswap Trading API `/check_approval`, `/quote`, and `/swap`, verifies RPC chain ID and the documented Universal Router 2.1.1 address, and requires `ROBINHOOD_UNISWAP_LIVE_ENABLED=true`, `ROBINHOOD_UNISWAP_TESTED=true`, an API key, an integrator fee recipient, and exact `ROBINHOOD_UNISWAP_INTEGRATOR_FEES_JSON` before live broadcast. The fee JSON is passed through unchanged because Uniswap documents it as an `object[]` but does not publish its nested sub-field schema on the API reference page.

Each screening cycle writes a backend console log. `/status` returns the latest screening result only to the chat that requested it; it is never broadcast to other users. Successful backend logs include the number of verified results and each detected token includes its address, bonding timestamp, and the GMGN `is_on_curve` value. Errors are logged separately.

`X_ENRICHMENT_URL` is intentionally an adapter boundary. Configure a compliant X data provider that accepts a token address and returns `twitterUrl` and/or `xMentionCount`; without it, social fields remain empty.

This tool only screens and links to Pump.fun. It does not execute trades or hold wallet keys.
