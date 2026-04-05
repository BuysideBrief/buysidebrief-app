# Buyside Brief — Full Codebase Audit

_Audited March 30, 2026_

---

## 1. Architecture Overview

**What it does:** Daily email newsletter that scrapes SEC EDGAR for Form 4 insider trading filings, scores them by conviction strength, enriches top signals with price context and earnings data, formats an HTML email, and sends it via Resend. A weekly Saturday digest summarizes the week's best picks.

**Stack:** Plain Node.js (CommonJS, no build step), deployed as Vercel serverless functions. Upstash Redis for persistence. Finnhub (primary) and Alpha Vantage (fallback) for stock prices. Anthropic Claude API for editorial content generation. Resend for email delivery, optional Beehiiv sync.

**Dependencies (package.json):** `@upstash/redis`, `dotenv`, `resend` (runtime). `jest` (dev). Notably, `resend` is listed as a dependency but never imported — emails are sent via raw `fetch()` to the Resend REST API.

**Code organization:**
- `api/` — 6 Vercel serverless endpoints (fetch-and-send, send-weekly, subscribe, archive, scorecard, cleanup)
- `lib/` — 15 modules forming the pipeline core
- `scripts/` — backfill analysis and local test runner
- `tests/` — 11 Jest test files
- Static HTML: landing page, archive viewer, scorecard page, privacy policy, terms

**Data flow (daily pipeline — `api/fetch-and-send.js`):**

```
EDGAR EFTS/daily-index → sec-fetcher.js (fetch + parse XML)
    → signal-scorer.js (score + cluster detection)
    → earnings-helper.js (earnings calendar cross-ref)
    → contrarian-detector.js (drawdown analysis)
    → pick-filters.js (repeat dampening)
    → historical-store.js (persist all filings)
    → context-enricher.js (insider history + 52-week range + score boosts)
    → ai-content.js (Claude API blurbs)
    → recently-featured.js (headline rotation)
    → performance-tracker.js (record picks, update returns, scorecard)
    → email-formatter.js (HTML generation)
    → Resend API (send)
    → archive.js (persist issue HTML)
```

---

## 2. Issue Scan

### Tier Threshold Inconsistency (Bug)

**`context-enricher.js:59`** uses `>= 50` for the `feature` tier, but **every other file** in the codebase uses `>= 45`. This means filings with scores 45-49 that get the 52-week-low boost will be re-tiered to `mention` instead of `feature` after enrichment, silently dropping them from the featured section of the email.

```
// context-enricher.js:59
else if (enriched.score >= 50) enriched.tier = 'feature';  // WRONG

// signal-scorer.js:269 (canonical)
else if (score >= 45) tier = 'feature';  // CORRECT
```

### Missing `await` on `recordNewPicks` (Bug)

**`api/fetch-and-send.js:281`** calls `recordNewPicks(enriched)` without `await`. This function is `async` and does Redis writes. The returned promise is assigned to `newPicksCount`, which will be a Promise object, not a number. The `console.log` on line 282 will print `[object Promise]`. More importantly, the Redis writes may not complete before the response is sent, causing picks to silently fail to record.

### Duplicate Redis Client in `performance-tracker.js` (Design Issue)

**`lib/performance-tracker.js:17-44`** creates its own Redis client instance with its own fallback logic, completely independent of the shared `lib/redis.js` singleton. This means:
- Two Redis connections per request instead of one
- The no-op fallback in `performance-tracker.js` is missing `del`, `zrem`, and `pipeline` methods that `redis.js` has
- If Redis config changes, you'd need to update both files

### `resend` Package Installed But Never Used

**`package.json:16`** lists `resend: "^3.2.0"` as a dependency, but no file in the codebase imports or requires it. All email sending is done via raw `fetch()` calls to `https://api.resend.com`. Dead dependency — wastes install time and adds attack surface.

### `test-score` Script References Non-Existent File

**`package.json:11`** defines `"test-score": "node --experimental-modules scripts/test-score.js"` but `scripts/test-score.js` doesn't exist. Running `npm run test-score` will crash.

### Undocumented Environment Variables

The following env vars are used in the code but not listed in CLAUDE.md's "Environment Variables" section:
- `ANTHROPIC_API_KEY` (ai-content.js) — powers all AI editorial content
- `CRON_SECRET` (fetch-and-send.js) — cron authentication
- `SNIPPET_EMAIL` / `OWNER_EMAIL` (fetch-and-send.js) — social snippet delivery
- `REDIS_URL` / `REDIS_TOKEN` (redis.js, performance-tracker.js) — alternative Redis env vars

### Subscribe Endpoint: Open CORS + No Rate Limiting

**`api/subscribe.js:13`** sets `Access-Control-Allow-Origin: '*'`. Combined with no rate limiting, anyone can spam the endpoint to add thousands of fake emails to your Resend audience, running up your bill. Email validation (`isValidEmail` on line 99-101) only checks format, not deliverability.

### Archive & Scorecard Endpoints: Open CORS

**`api/archive.js:17`** and **`api/scorecard.js:14`** both set `Access-Control-Allow-Origin: '*'`. The archive endpoint serves full HTML of past newsletters — anyone can scrape your entire archive. Not a security issue per se, but worth being aware of.

### Cleanup Endpoint Has No Authentication

**`api/cleanup.js`** can delete Redis data when called with `?run=true`. There's no auth check — anyone who discovers the URL can wipe your picks data. This should at minimum check for `CRON_SECRET` or be removed from production.

### Hardcoded Affiliate Referral Code

**`lib/affiliate-links.js:18`** has `ref: process.env.TASTYTRADE_REF || '8K8P8N4D73'`. This hardcoded fallback means the referral code is in source control. Not a security issue (it's a public referral code), but it's a pattern that could become problematic if more sensitive defaults are added similarly.

### Deduplication Accesses `.summary` Before Scoring

**`api/fetch-and-send.js:96-98`** sorts parsed filings by `a.summary?.totalBuyValue` but `.summary` doesn't exist on raw parsed filings — it's only added by `scoreFiling()`. The optional chaining prevents a crash, but the sort is comparing `undefined` to `undefined`, making it a no-op. Deduplication still works (keeps first seen), but it's not keeping the "most significant" filing as intended.

### `strong_signal` Tier Not Handled in Email Formatter Tier Reassignment

After earnings boosts in **`api/fetch-and-send.js:140-142`**, scores are re-tiered but the `strong_signal` tier (≥100) is never assigned — only `top_pick` (≥75), `feature` (≥45), and `mention` (≥25). Same issue in contrarian boost block at lines 177-179. Filings that cross the 100 threshold from earnings/contrarian boosts won't get the gold "Strong Signal" label in the email.

### Performance: N+1 Redis Reads in `loadRecentPicks`, `generateScorecard`, `getAllCeoProfiles`

**`lib/performance-tracker.js`** has multiple functions that fetch a list of IDs from a sorted set, then loop through them one-by-one with individual `kv.get()` calls. With 100+ picks, this creates 100+ sequential HTTP requests to Upstash Redis. Should use `pipeline()` or `mget()`. This directly impacts Vercel function execution time and could contribute to the 60s timeout.

### Vercel Function Timeout Risk

**`vercel.json`** sets `maxDuration: 60` for both cron endpoints. The daily pipeline does:
- Up to 100 SEC fetches (100ms sleep each = 10s minimum)
- 20 earnings API calls (200ms each = 4s)
- 15 contrarian API calls (2 × 200ms each = 6s)
- Multiple Claude API calls for AI blurbs
- Sequential Redis reads for recent picks, scorecard, CEO profiles

This easily exceeds 60 seconds on a busy day. If the function times out, the email never sends and there's no retry mechanism.

### `dotenv` Never Called

**`package.json`** lists `dotenv` as a dependency, but no file in the codebase calls `require('dotenv').config()`. The test script (`scripts/test-fetch.js`) doesn't load it either, so running locally without Vercel dev won't pick up `.env` values.

### `deepDive` Content Injected Without HTML Escaping

**`api/send-weekly.js:180`** inserts the `deepDive` AI-generated string directly into HTML without escaping: `${deepDive || 'fallback...'}`. If the Claude API ever returns content with `<script>` tags or HTML entities, it'll be rendered raw in the email. Low risk since email clients strip scripts, but still a hygiene issue.

### `socialSnippet` Injected Without HTML Escaping

**`api/fetch-and-send.js:382`** — same issue. The AI-generated social snippet is inserted into an HTML email template without escaping.

---

## 3. Top 10 Priority Fixes

### 1. Missing `await` on `recordNewPicks` — Picks silently fail to save
- **File:** `api/fetch-and-send.js:281`
- **What's wrong:** `const newPicksCount = recordNewPicks(enriched)` — no `await`. This async function does Redis writes that may never complete.
- **Who it affects:** Every daily run. Picks may not be recorded, breaking the scorecard, CEO profiles, and repeat dampening.
- **Fix:** Add `await`: `const newPicksCount = await recordNewPicks(enriched);`
- **Effort:** 1 minute.

### 2. Tier threshold inconsistency — features getting dropped to mentions
- **File:** `context-enricher.js:59`
- **What's wrong:** Uses `>= 50` for `feature` tier, everywhere else uses `>= 45`.
- **Who it affects:** Filings scoring 45-49 that receive the 52-week-low boost get wrong tier assignment after enrichment.
- **Fix:** Change line 59 to `else if (enriched.score >= 45) enriched.tier = 'feature';`
- **Effort:** 1 minute.

### 3. `strong_signal` tier not assigned after earnings/contrarian boosts
- **File:** `api/fetch-and-send.js:140-142` and `177-179`
- **What's wrong:** Tier reassignment after boosts doesn't include `strong_signal` (≥100). High-scoring filings lose their gold badge.
- **Fix:** Add `if (f.score >= 100) f.tier = 'strong_signal';` before the existing tier checks at both locations.
- **Effort:** 2 minutes.

### 4. Cleanup endpoint has no authentication — data can be wiped
- **File:** `api/cleanup.js`
- **What's wrong:** No auth check. `GET /api/cleanup?run=true` deletes Redis data.
- **Who it affects:** You — anyone who finds the URL can nuke your picks.
- **Fix:** Add `CRON_SECRET` check: `if (req.headers['authorization'] !== 'Bearer ' + process.env.CRON_SECRET) return res.status(401)...`
- **Effort:** 5 minutes.

### 5. Subscribe endpoint needs rate limiting
- **File:** `api/subscribe.js`
- **What's wrong:** Wide-open CORS + no rate limiting = easy to spam. Fake signups cost money on Resend.
- **Fix:** Add Vercel Edge middleware or use Upstash Ratelimit (`@upstash/ratelimit`) to limit to e.g. 5 requests per IP per minute.
- **Effort:** 30 minutes.

### 6. Duplicate Redis client in performance-tracker.js
- **File:** `lib/performance-tracker.js:17-44`
- **What's wrong:** Creates its own Redis connection instead of using the shared `lib/redis.js` singleton. Two connections per request; inconsistent fallback behavior.
- **Fix:** Replace lines 17-44 with `const kv = require('./redis').getRedisOrNoop();`
- **Effort:** 10 minutes (plus testing).

### 7. N+1 Redis reads causing slow scorecard generation
- **File:** `lib/performance-tracker.js` — `generateScorecard()` (lines 186-277), `loadRecentPicks()` (568-586), `getAllCeoProfiles()` (381-396)
- **What's wrong:** Fetches IDs from a sorted set, then loops through with individual `get()` calls. 100+ picks = 100+ sequential HTTP roundtrips.
- **Fix:** Use Upstash pipeline: `const pipeline = kv.pipeline(); ids.forEach(id => pipeline.get(id)); const results = await pipeline.exec();`
- **Effort:** 1 hour.

### 8. Deduplication sort is a no-op
- **File:** `api/fetch-and-send.js:95-99`
- **What's wrong:** Sorts by `a.summary?.totalBuyValue` but `.summary` doesn't exist on parsed filings (only added by scorer). Sort compares `undefined` to `undefined`.
- **Fix:** Either move dedup after scoring, or sort by the raw transaction data: `a.transactions.reduce((s,t) => s + t.totalValue, 0)`.
- **Effort:** 15 minutes.

### 9. Vercel timeout risk on the daily pipeline
- **File:** `vercel.json`, `api/fetch-and-send.js`
- **What's wrong:** 60s `maxDuration` is tight for a pipeline that does 100+ SEC fetches, 35+ Finnhub calls, and multiple Claude API calls sequentially.
- **Fix:** Reduce batch sizes, parallelize price API calls, or increase `maxDuration` (Vercel Pro supports 300s). Could also pre-check if the function is close to timeout and skip optional steps (AI blurbs, contrarian, earnings).
- **Effort:** 2-4 hours.

### 10. Remove dead `resend` dependency + fix broken `test-score` script
- **File:** `package.json`
- **What's wrong:** `resend` package is installed but never imported. `test-score` script references a file that doesn't exist. `dotenv` is listed but never called.
- **Fix:** `npm uninstall resend`, remove the `test-score` script, and either add `require('dotenv').config()` to test scripts or remove `dotenv`.
- **Effort:** 5 minutes.

---

## 4. Overall Health Assessment

This is a **solid MVP codebase** — well-organized, consistent style, good separation of concerns, and graceful degradation everywhere. The pipeline design is thoughtful and the scoring engine is well-tuned. For a project of this scope, the code quality is above average.

**The single most important thing to fix:** The missing `await` on `recordNewPicks` (fix #1). This is a silent data loss bug — your scorecard, CEO profiles, and repeat dampening all depend on picks being reliably saved to Redis. It's a one-character fix (`await`) that protects the core value prop of the newsletter's performance tracking.

After that, the tier threshold inconsistency (#2) and the missing `strong_signal` tier reassignment (#3) are both quick wins that directly affect what your subscribers see.

The **biggest structural risk** is the Vercel timeout (#9). As your filing count grows and you add more enrichment steps, you'll hit the wall. Start monitoring elapsed time in production logs and consider a circuit-breaker pattern that skips optional enrichment when time is running short.
