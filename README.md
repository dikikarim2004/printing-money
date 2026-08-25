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

Each screening cycle writes a backend console log. `/status` returns the latest screening result only to the chat that requested it; it is never broadcast to other users. Successful backend logs include the number of verified results and each detected token includes its address, bonding timestamp, and the GMGN `is_on_curve` value. Errors are logged separately.

`X_ENRICHMENT_URL` is intentionally an adapter boundary. Configure a compliant X data provider that accepts a token address and returns `twitterUrl` and/or `xMentionCount`; without it, social fields remain empty.

This tool only screens and links to Pump.fun. It does not execute trades or hold wallet keys.
