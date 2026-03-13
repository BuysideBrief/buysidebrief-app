# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Buyside Brief is a daily email newsletter that monitors SEC EDGAR Form 4 filings and surfaces actionable insider trading signals. Deployed on Vercel as serverless functions with Upstash Redis for persistence.

## Commands

```bash
npm install                          # Install dependencies
npx vercel dev                       # Run local dev server
node scripts/test-fetch.js           # Full pipeline dry run (fetch → score → format, no email)
node scripts/test-fetch.js --count=20  # Limit to 20 filings
```

Manual trigger URLs (deployed):
- `/api/fetch-and-send?dry=true` — dry run, returns JSON with scored filings
- `/api/fetch-and-send?send=true` — force live send
- `/api/fetch-and-send?debug=true` — returns raw filing index data
- `/api/send-weekly?dry=true` — weekly digest dry run

## Architecture

### Daily Pipeline (`api/fetch-and-send.js`)

The core pipeline runs as a Vercel cron (weekdays 11am UTC) and executes sequentially:

1. **Fetch** (`lib/sec-fetcher.js`) — Queries EDGAR full-text search API (efts.sec.gov) for recent Form 4 filings, falls back to daily index. Parses XML ownership documents with custom regex-based XML extraction (no XML parser library). Processes in batches of 5 with 200ms delays to respect SEC's 10 req/sec limit.

2. **Score** (`lib/signal-scorer.js`) — Two-pass scoring: individual filing scores, then cluster detection across same-ticker filings. Tiers: top_pick (≥75), feature (≥50), mention (≥25), skip (<25). See README for full scoring table.

3. **Enrich** (`lib/context-enricher.js`) — Only enriches top_pick and feature tiers (to conserve API calls). Adds insider filing history from EDGAR, 52-week price range from Finnhub/Alpha Vantage, and generates "Why it matters" blurbs. Applies a +20 score boost for buying near 52-week low.

4. **Track** (`lib/performance-tracker.js`) — Records picks in Upstash Redis, updates returns for all past picks. Maintains CEO profiles with win rates. KV key schema: `pick:{ticker}:{date}:{ownerCik}`, `ceo:{ownerCik}`, `archive:{date}`.

5. **Format** (`lib/email-formatter.js`) — Generates HTML email with market overview, top picks, featured signals, mentions, sells, scorecard, and CEO spotlight. Uses `lib/affiliate-links.js` for ticker links (TradingView) and broker CTAs (tastytrade/IBKR).

6. **Send** — Uses Resend API directly (not the SDK). Sends to TEST_EMAIL if set, otherwise broadcasts to RESEND_AUDIENCE_ID.

### Weekly Digest (`api/send-weekly.js`)

Runs Saturday 2pm UTC. Pulls week's picks from Redis, formats a "best of the week" email with full scorecard.

### Other Endpoints

- `api/subscribe.js` — POST endpoint for email signups, adds to Resend audience + optional Beehiiv
- `api/archive.js` — GET endpoint serving past issues from Redis, also exports `storeIssue()` used by daily pipeline
- `api/scorecard.js` — Scorecard page endpoint

### Price Data (`lib/price-helper.js`)

Two-tier price API: Finnhub primary (60 req/min), Alpha Vantage fallback (25 req/day). Provides quotes, historical candles, 52-week ranges, and return calculations.

### Static Pages

- `index.html` — Landing page with email capture form
- `archive.html` — Past issues viewer
- `scorecard.html` — Performance scorecard page

## Key Patterns

- **CommonJS throughout** — all files use `require()`/`module.exports`, no ESM
- **No test framework** — testing is done via `scripts/test-fetch.js` dry runs and `?dry=true` query params
- **No build step** — plain JS files deployed directly to Vercel
- **Graceful degradation** — Redis, price APIs, and enrichment all have no-op fallbacks so the pipeline doesn't crash if services are unavailable
- **SEC rate limiting** — 100ms sleep between individual requests, 200ms between batches of 5. User-Agent header required (`SEC_USER_AGENT` env var)
- **Safe defaults** — hitting `/api/fetch-and-send` without params defaults to dry run; live sends require cron header or explicit `?send=true`

## Environment Variables

Required: `SEC_USER_AGENT`, `RESEND_API_KEY`
For broadcasts: `RESEND_AUDIENCE_ID`
For price data/scorecard: `FINNHUB_API_KEY` (primary), `ALPHA_VANTAGE_KEY` (fallback)
For Redis persistence: `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` (or Vercel KV equivalents)
Optional: `BEEHIIV_API_KEY`, `BEEHIIV_PUB_ID`, `TEST_EMAIL`, `TASTYTRADE_REF`, `IBKR_REF`, `TRADINGVIEW_REF`
