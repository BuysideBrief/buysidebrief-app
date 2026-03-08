# Buyside Brief

**What insiders are buying — before you hear about it on CNBC.**

Free daily email newsletter that monitors SEC EDGAR Form 4 filings and surfaces the most actionable insider trading signals in plain English.

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/BuysideBrief/buysidebrief.git
cd buysidebrief
npm install

# 2. Copy env template and fill in your keys
cp .env.example .env

# 3. Test the data pipeline (no email sent)
node scripts/test-fetch.js

# 4. Preview the landing page
npx vercel dev

# 5. Deploy
npx vercel --prod
```

## Project Structure

```
├── index.html                  ← Landing page + email capture
├── vercel.json                 ← Cron config (daily 11pm ET + weekly Sat 10am ET)
├── api/
│   ├── fetch-and-send.js       ← Daily cron: fetch → score → enrich → send
│   ├── send-weekly.js          ← Weekly "best of" digest with full scorecard
│   └── subscribe.js            ← Email signup handler
├── lib/
│   ├── sec-fetcher.js          ← SEC EDGAR Form 4 fetcher + XML parser
│   ├── signal-scorer.js        ← Signal scoring engine
│   ├── context-enricher.js     ← "Why it matters" blurbs + insider history
│   ├── price-helper.js         ← Stock price lookups (Finnhub/Alpha Vantage)
│   ├── performance-tracker.js  ← Scorecard: tracks past picks vs. market
│   └── email-formatter.js      ← HTML email digest generator
├── data/
│   └── picks.json              ← Performance tracking data (auto-generated)
└── scripts/
    └── test-fetch.js           ← Local pipeline test (dry run)
```

## Key Features

### Signal Scoring
Every Form 4 filing gets a score. See scoring table below.

### "Why It Matters" Context
Top picks get a plain English blurb explaining the signal. Not just "CEO bought $2M" but *why* a CEO buying $2M of their own stock at these levels is significant.

### Insider Track Record
When we feature an insider, we look up their past filings at the same company. "First purchase in 14 months" or "3rd buy this year" adds crucial context.

### Performance Scorecard
We track every Top Pick and update returns at 7, 30, and 90 days. The scorecard shows win rate, average return, best/worst picks. This is what builds credibility and makes the newsletter shareable.

### Weekly Digest
A Saturday morning "best of the week" email for subscribers who don't want daily. Includes the full scorecard and top signals, all in one read.

## How Scoring Works

Each Form 4 filing gets a score based on:

| Signal | Points | Rationale |
|--------|--------|-----------|
| Cluster buying (3+ insiders) | +40 | Strongest conviction signal |
| C-suite purchase | +30 | CEO/CFO putting their own money in |
| Large purchase (>$500K) | +25 | Meaningful skin in the game |
| 10%+ owner buying | +20 | Major shareholders adding |
| Medium purchase (>$100K) | +15 | Notable commitment |
| Paired buying (2 insiders) | +15 | Emerging cluster |
| Director purchase | +15 | Board-level conviction |
| Discretionary (no 10b5-1) | +10 | Not pre-scheduled |
| Option exercise only | -20 | Usually mechanical |
| Gift/transfer | -30 | Not market signal |
| Tiny purchase (<$10K) | -15 | Minimal conviction |
| Pre-scheduled sale | -15 | Not discretionary |

**Thresholds:** Score ≥75 = Top Pick | ≥50 = Featured | ≥25 = Mention | <25 = Omit

## Environment Variables

| Key | Required | Description |
|-----|----------|-------------|
| `SEC_USER_AGENT` | Yes | SEC requires identification (e.g. `BuysideBrief email@domain.com`) |
| `RESEND_API_KEY` | Yes | From [resend.com](https://resend.com) |
| `RESEND_AUDIENCE_ID` | For broadcast | Create in Resend dashboard → Audiences |
| `FINNHUB_API_KEY` | For scorecard | Free at [finnhub.io](https://finnhub.io) (60 req/min) |
| `ALPHA_VANTAGE_KEY` | Fallback | Free at [alphavantage.co](https://alphavantage.co) (25 req/day) |
| `BEEHIIV_API_KEY` | Optional | For dual subscriber management |
| `BEEHIIV_PUB_ID` | Optional | Beehiiv publication ID |
| `TEST_EMAIL` | For testing | Where dry-run digests get sent |

## Setup Checklist

- [ ] Register `buysidebrief.com` on GoDaddy
- [ ] Create GitHub repo and push code
- [ ] Create Vercel project, connect to repo
- [ ] Add environment variables in Vercel dashboard
- [ ] Verify domain in Resend (for `hello@buysidebrief.com`)
- [ ] Create Resend audience for subscribers
- [ ] Run `node scripts/test-fetch.js` to validate pipeline
- [ ] Test with `?dry=true`: `https://buysidebrief.com/api/fetch-and-send?dry=true`
- [ ] Send test digest to yourself
- [ ] Go live: enable Vercel cron

## Legal

SEC EDGAR data is 100% public domain. This project republishes factual public records. Not investment advice. Past insider buying patterns do not predict future performance.

## License

MIT
