/**
 * Backfill Script
 * 
 * Fetches historical Form 4 filings from SEC EDGAR, scores them,
 * fetches price data for returns, and stores everything in Redis
 * under a separate `backfill:` namespace.
 * 
 * This does NOT touch live data. Your scorecard, archive, and
 * daily emails continue reading from `pick:*` and `filing:*`.
 * 
 * Usage:
 *   node scripts/backfill.js --from=2025-09-01 --to=2026-03-20 --wipe
 *   node scripts/backfill.js --from=2025-09-01 --to=2026-03-20 --resume
 *   node scripts/backfill.js --from=2026-01-01 --to=2026-03-20 --dry
 *   node scripts/backfill.js --from=2026-03-01 --to=2026-03-20 --limit=50
 * 
 * Options:
 *   --from     Start date (ISO format, required)
 *   --to       End date (ISO format, defaults to today)
 *   --limit    Max filings per day to process (default: 50)
 *   --dry      Dry run — score and print but don't store to Redis
 *   --verbose  Show individual filing details
 *   --wipe     Delete all existing backfill:* keys before starting
 *   --resume   Skip days that already have data in Redis
 * 
 * Rate limits:
 *   SEC EDGAR: 10 req/sec (we do ~3/sec with 350ms sleeps + 500ms batch pauses)
 *   Finnhub: 60 req/min (we batch and pause between days)
 * 
 * Estimated time:
 *   ~3-5 minutes per trading day at 50 filings/day
 *   90 trading days ≈ 5-7 hours (run overnight)
 *   30 trading days ≈ 1.5-2.5 hours
 * 
 * Requires env vars:
 *   UPSTASH_REDIS_REST_URL (or KV_REST_API_URL)
 *   UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_TOKEN) 
 *   FINNHUB_API_KEY
 *   SEC_USER_AGENT
 */

// Load .env if present (for local runs)
try { require('dotenv').config(); } catch (e) {}

const { Redis } = require('@upstash/redis');
const { scoreAllFilings, categorizeForDigest, formatValue } = require('../lib/signal-scorer');
const { fetchAndParseForm4 } = require('../lib/sec-fetcher');

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'BuysideBrief hello@buysidebrief.com';
const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const SEC_RATE_MS = 500;   // Slower than live pipeline — backfill makes hundreds of requests
const FINNHUB_RATE_MS = 300;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Parse CLI args ──
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace('--', '').split('=');
    return [k, v || true];
  })
);

if (!args.from) {
  console.error('Usage: node scripts/backfill.js --from=2025-09-01 [--to=2026-03-20] [--limit=50] [--dry] [--verbose] [--wipe] [--resume]');
  process.exit(1);
}

const FROM_DATE = args.from;
const TO_DATE = args.to || new Date().toISOString().split('T')[0];
const LIMIT_PER_DAY = parseInt(args.limit) || 50;
const DRY_RUN = !!args.dry;
const VERBOSE = !!args.verbose;
const WIPE_FIRST = !!args.wipe;
const RESUME = !!args.resume;

// ── Redis ──
let redis = null;
function getRedis() {
  if (redis) return redis;
  if (DRY_RUN) return null;
  redis = Redis.fromEnv();
  return redis;
}

// ══════════════════════════════════════════
// SEC EDGAR Functions (date range query only — parsing uses lib/sec-fetcher.js)
// ══════════════════════════════════════════

async function fetchFilingsForDateRange(startDate, endDate, size = 50) {
  const url = `https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=${startDate}&enddt=${endDate}&from=0&size=${size}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'application/json' },
  });
  await sleep(SEC_RATE_MS);

  if (!res.ok) {
    console.error(`  EDGAR search failed: ${res.status}`);
    return [];
  }

  const data = await res.json();
  if (!data.hits || !data.hits.hits) return [];

  // Parse hits using the same _id splitting logic as sec-fetcher.js parseEftsHit
  return data.hits.hits.map(hit => {
    const src = hit._source || {};
    const ciks = src.ciks || [];
    const names = src.display_names || [];
    const hitId = hit._id || '';
    const [accPart, xmlFilename] = hitId.split(':');

    let accessionNumber = accPart || '';
    let cik = (ciks[0] || '').replace(/^0+/, '');

    // Build direct URL to the XML — same as sec-fetcher.js
    let fileUrl = '';
    if (accessionNumber && cik && xmlFilename) {
      const accClean = accessionNumber.replace(/-/g, '');
      fileUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/${xmlFilename}`;
    }

    return {
      accessionNumber,
      cik,
      filedAt: src.file_date || src.period_of_report,
      formType: src.form_type || '4',
      entityName: names[0] || src.entity_name || 'Unknown',
      fileUrl,
      xmlFilename: xmlFilename || '',
    };
  }).filter(Boolean);
}

// ══════════════════════════════════════════
// Price Functions (for return calculation)
// ══════════════════════════════════════════

async function getQuote(ticker) {
  if (!FINNHUB_KEY) return null;
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
    );
    await sleep(FINNHUB_RATE_MS);
    if (!res.ok) return null;
    const d = await res.json();
    if (d.c && d.c > 0) return { price: d.c };
  } catch (e) {}
  return null;
}

// ══════════════════════════════════════════
// Redis Storage (backfill namespace)
// ══════════════════════════════════════════

async function storeBackfillDay(date, scoredFilings) {
  const r = getRedis();
  if (!r) return 0;

  const pipeline = r.pipeline();
  let stored = 0;

  const summary = {
    date,
    totalFilings: scoredFilings.length,
    totalBuyValue: 0,
    totalSellValue: 0,
    buyFilings: 0,
    sellFilings: 0,
    topPicks: 0,
    featured: 0,
    mentions: 0,
    avgScore: 0,
    uniqueTickers: 0,
  };

  const tickers = new Set();
  let scoreSum = 0;

  for (const f of scoredFilings) {
    if (!f.ticker) continue;

    const ownerKey = f.ownerCik || f.ownerName || 'unknown';
    const filingKey = `backfill:filing:${date}:${f.ticker}:${ownerKey}`;

    const record = {
      ticker: f.ticker,
      issuerName: f.issuerName || null,
      ownerName: f.ownerName || null,
      ownerCik: f.ownerCik || null,
      officerTitle: f.officerTitle || null,
      isDirector: f.isDirector || false,
      isOfficer: f.isOfficer || false,
      isTenPercentOwner: f.isTenPercentOwner || false,
      score: f.score,
      tier: f.tier,
      signals: f.signals || [],
      warnings: f.warnings || [],
      buyValue: f.summary?.totalBuyValue || 0,
      sellValue: f.summary?.totalSellValue || 0,
      buyShares: f.summary?.totalBuyShares || 0,
      buyCount: f.summary?.buyCount || 0,
      sellCount: f.summary?.sellCount || 0,
      has10b51Plan: f.has10b51Plan || false,
      isInstitutional: f.isInstitutional || false,
      date,
      entryPrice: f.transactions?.[0]?.pricePerShare || null,
    };

    pipeline.set(filingKey, JSON.stringify(record));
    pipeline.zadd(`backfill:index:${date}`, { score: f.score, member: filingKey });
    pipeline.zadd(`backfill:ticker:${f.ticker.toUpperCase()}`, {
      score: new Date(date).getTime(),
      member: filingKey,
    });

    // Track picks for return calculation
    if (f.tier === 'top_pick' || f.tier === 'feature') {
      const pickKey = `backfill:pick:${date}:${f.ticker}:${ownerKey}`;
      pipeline.set(pickKey, JSON.stringify({
        ...record,
        currentPrice: null,
        currentReturn: null,
        return7d: null,
        return30d: null,
      }));
      pipeline.zadd('backfill:picks:index', {
        score: new Date(date).getTime(),
        member: pickKey,
      });
    }

    scoreSum += f.score;
    summary.totalBuyValue += record.buyValue;
    summary.totalSellValue += record.sellValue;
    if (record.buyCount > 0) summary.buyFilings++;
    if (record.sellCount > 0) summary.sellFilings++;
    if (f.tier === 'top_pick') summary.topPicks++;
    else if (f.tier === 'feature') summary.featured++;
    else if (f.tier === 'mention') summary.mentions++;
    tickers.add(f.ticker);
    stored++;
  }

  summary.avgScore = stored > 0 ? Math.round((scoreSum / stored) * 100) / 100 : 0;
  summary.uniqueTickers = tickers.size;

  pipeline.set(`backfill:daily:${date}`, JSON.stringify(summary));
  pipeline.zadd('backfill:daily:index', { score: new Date(date).getTime(), member: date });

  try {
    await pipeline.exec();
  } catch (e) {
    console.error(`  Redis store failed for ${date}:`, e.message);
    return 0;
  }

  return stored;
}

async function updateBackfillReturns() {
  const r = getRedis();
  if (!r) return 0;

  console.log('\n── Updating returns for backfill picks ──');

  // Get all pick keys
  const pickKeys = await r.zrange('backfill:picks:index', 0, -1);
  if (!pickKeys || pickKeys.length === 0) {
    console.log('  No picks to update');
    return 0;
  }

  console.log(`  Found ${pickKeys.length} picks to update`);
  let updated = 0;
  const tickerCache = new Map();

  for (const key of pickKeys) {
    try {
      const raw = await r.get(key);
      if (!raw) continue;
      const pick = typeof raw === 'string' ? JSON.parse(raw) : raw;

      if (!pick.ticker || !pick.entryPrice || pick.entryPrice <= 0) continue;

      // Cache quotes by ticker to avoid duplicate API calls
      let quote = tickerCache.get(pick.ticker);
      if (!quote) {
        quote = await getQuote(pick.ticker);
        if (quote) tickerCache.set(pick.ticker, quote);
      }
      if (!quote) continue;

      const returnPct = ((quote.price - pick.entryPrice) / pick.entryPrice) * 100;
      pick.currentPrice = quote.price;
      pick.currentReturn = Math.round(returnPct * 100) / 100;

      const daysSince = Math.floor((Date.now() - new Date(pick.date).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince >= 7 && pick.return7d === null) pick.return7d = pick.currentReturn;
      if (daysSince >= 30 && pick.return30d === null) pick.return30d = pick.currentReturn;

      await r.set(key, JSON.stringify(pick));
      updated++;
    } catch (e) {
      // Skip
    }
  }

  console.log(`  Updated returns for ${updated} picks (${tickerCache.size} unique tickers)`);
  return updated;
}

// ══════════════════════════════════════════
// Generate Trading Days
// ══════════════════════════════════════════

function getTradingDays(from, to) {
  const days = [];
  const start = new Date(from);
  const end = new Date(to);

  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) { // Skip weekends
      days.push(d.toISOString().split('T')[0]);
    }
  }

  return days;
}

// ══════════════════════════════════════════
// Main
// ══════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   BUYSIDE BRIEF — Historical Backfill       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log();
  console.log(`  From: ${FROM_DATE}`);
  console.log(`  To:   ${TO_DATE}`);
  console.log(`  Limit: ${LIMIT_PER_DAY} filings/day`);
  console.log(`  Mode: ${DRY_RUN ? 'DRY RUN (no Redis writes)' : 'LIVE (writing to backfill:* keys)'}`);
  console.log(`  Wipe: ${WIPE_FIRST ? 'YES — clearing old backfill data first' : 'no'}`);
  console.log(`  Resume: ${RESUME ? 'YES — skipping already-processed days' : 'no'}`);
  console.log(`  Finnhub: ${FINNHUB_KEY ? 'configured' : 'NOT SET — no return data'}`);
  console.log();

  // ── Wipe old backfill data if requested ──
  if (WIPE_FIRST && !DRY_RUN) {
    console.log('  Wiping old backfill:* keys...');
    const r = getRedis();
    let wiped = 0;
    
    // Delete known index keys
    const indexKeys = ['backfill:picks:index', 'backfill:daily:index'];
    for (const key of indexKeys) {
      try { await r.del(key); wiped++; } catch (e) {}
    }

    // Scan for all backfill:* keys and delete in batches
    let cursor = 0;
    do {
      const result = await r.scan(cursor, { match: 'backfill:*', count: 100 });
      cursor = result[0];
      const keys = result[1];
      if (keys.length > 0) {
        const pipeline = r.pipeline();
        for (const key of keys) {
          pipeline.del(key);
        }
        await pipeline.exec();
        wiped += keys.length;
      }
    } while (cursor !== 0 && cursor !== '0');

    console.log(`  Wiped ${wiped} keys\n`);
  }

  // ── Get already-processed days for resume mode ──
  let processedDays = new Set();
  if (RESUME && !DRY_RUN) {
    const r = getRedis();
    try {
      const existing = await r.zrange('backfill:daily:index', 0, -1);
      if (existing && existing.length > 0) {
        processedDays = new Set(existing);
        console.log(`  Resume mode: ${processedDays.size} days already processed\n`);
      }
    } catch (e) {}
  }

  const tradingDays = getTradingDays(FROM_DATE, TO_DATE);
  console.log(`  Trading days to process: ${tradingDays.length}`);
  if (RESUME && processedDays.size > 0) {
    const remaining = tradingDays.filter(d => !processedDays.has(d));
    console.log(`  After resume filter: ${remaining.length} days remaining`);
  }
  console.log();

  // Totals
  let totalFilings = 0;
  let totalParsed = 0;
  let totalStored = 0;
  let totalTopPicks = 0;
  let totalFeatured = 0;
  let totalBuyValue = 0;
  let totalSellValue = 0;
  const allPicks = [];

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    const progress = `[${i + 1}/${tradingDays.length}]`;

    // Skip already-processed days in resume mode
    if (RESUME && processedDays.has(date)) {
      if (VERBOSE) console.log(`${progress} ${date} — already processed, skipping`);
      continue;
    }

    process.stdout.write(`${progress} ${date} — fetching...`);

    try {
    // Fetch filings for this single day
    const filings = await fetchFilingsForDateRange(date, date, LIMIT_PER_DAY);
    totalFilings += filings.length;

    if (filings.length === 0) {
      console.log(` no filings (holiday?)`);
      continue;
    }

    process.stdout.write(` ${filings.length} found, parsing...`);

    // Parse individual Form 4 XMLs — batch of 3, slower to avoid SEC rate limits
    const parsed = [];
    const BATCH_SIZE = 3;
    for (let j = 0; j < filings.length; j += BATCH_SIZE) {
      const batch = filings.slice(j, j + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(f => fetchAndParseForm4(f).catch(() => null))
      );
      for (const result of results) {
        if (result && result.transactions.length > 0) {
          parsed.push(result);
        }
      }
      // Pause between batches to stay well under SEC 10 req/sec limit
      await sleep(1000);
    }
    totalParsed += parsed.length;

    if (parsed.length === 0) {
      console.log(` 0 with transactions`);
      continue;
    }

    // Deduplicate
    const deduped = [];
    const seen = new Set();
    parsed.sort((a, b) => {
      const aVal = a.transactions.reduce((s, t) => s + t.totalValue, 0);
      const bVal = b.transactions.reduce((s, t) => s + t.totalValue, 0);
      return bVal - aVal;
    });
    for (const filing of parsed) {
      const key = `${filing.ticker || 'UNK'}:${filing.ownerCik || filing.ownerName || 'UNK'}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(filing);
      }
    }

    // Score
    const scored = scoreAllFilings(deduped);
    const categorized = categorizeForDigest(scored);

    totalTopPicks += categorized.topPicks.length;
    totalFeatured += categorized.featured.length;

    for (const f of scored) {
      totalBuyValue += f.summary?.totalBuyValue || 0;
      totalSellValue += f.summary?.totalSellValue || 0;
    }

    // Track picks for summary
    const dayPicks = scored.filter(f => f.tier === 'top_pick' || f.tier === 'feature');
    for (const p of dayPicks) {
      allPicks.push({
        date,
        ticker: p.ticker,
        owner: p.ownerName,
        title: p.officerTitle,
        score: p.score,
        tier: p.tier,
        buyValue: p.summary?.totalBuyValue || 0,
        entryPrice: p.transactions?.[0]?.pricePerShare || null,
      });
    }

    // Store to Redis
    let stored = 0;
    if (!DRY_RUN) {
      stored = await storeBackfillDay(date, scored);
      totalStored += stored;
    }

    const picks = dayPicks.length;
    const pickStr = picks > 0 ? ` ★ ${picks} picks` : '';
    console.log(` ${deduped.length} scored, ${stored || deduped.length} stored${pickStr}`);

    if (VERBOSE && dayPicks.length > 0) {
      for (const p of dayPicks) {
        console.log(`    → $${p.ticker} | ${p.ownerName} | Score: ${p.score} | $${formatValue(p.summary.totalBuyValue)}`);
      }
    }

    } catch (dayErr) {
      console.log(` ERROR: ${dayErr.message} — skipping day`);
    }

    // Pause between days to be nice to SEC and Finnhub
    if (i < tradingDays.length - 1) {
      await sleep(2000);
    }
  }

  // Update returns for all picks
  if (!DRY_RUN && FINNHUB_KEY) {
    await updateBackfillReturns();
  }

  // ── Summary ──
  console.log();
  console.log('══════════════════════════════════════════════');
  console.log('  BACKFILL COMPLETE');
  console.log('══════════════════════════════════════════════');
  console.log(`  Days processed:    ${tradingDays.length}`);
  console.log(`  Filings fetched:   ${totalFilings}`);
  console.log(`  Filings parsed:    ${totalParsed}`);
  console.log(`  Filings stored:    ${DRY_RUN ? '(dry run)' : totalStored}`);
  console.log(`  Top picks:         ${totalTopPicks}`);
  console.log(`  Featured:          ${totalFeatured}`);
  console.log(`  Total buy value:   $${formatValue(totalBuyValue)}`);
  console.log(`  Total sell value:  $${formatValue(totalSellValue)}`);
  console.log();

  if (allPicks.length > 0) {
    console.log('── TOP PICKS FOUND ──');
    console.log();
    const sorted = allPicks.sort((a, b) => b.score - a.score).slice(0, 20);
    for (const p of sorted) {
      console.log(`  ${p.date} | $${p.ticker} | ${p.owner} | Score: ${p.score} | $${formatValue(p.buyValue)}`);
    }
    console.log();
  }

  if (!DRY_RUN) {
    console.log('  Data stored in backfill:* Redis keys.');
    console.log('  Run: node scripts/backfill-report.js to see metrics.');
  } else {
    console.log('  DRY RUN — nothing stored. Remove --dry to write to Redis.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
