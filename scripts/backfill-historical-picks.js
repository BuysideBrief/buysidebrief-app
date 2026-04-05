/**
 * Backfill Historical Picks — Out-of-Sample Validation
 *
 * Fetches Form 4 filings from BEFORE our live tracking started (2026-03-18),
 * scores them with our existing pipeline, looks up actual 30-day returns,
 * and stores results separately from live picks for comparison analysis.
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config scripts/backfill-historical-picks.js
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config scripts/backfill-historical-picks.js --start=2026-02-15 --end=2026-03-15
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config scripts/backfill-historical-picks.js --dry
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config scripts/backfill-historical-picks.js --max-per-day=30
 *
 * Options:
 *   --start         Start date (default: 2026-02-10)
 *   --end           End date (default: 2026-03-17)
 *   --max-per-day   Max filings to process per day (default: 50)
 *   --dry           Dry run — show what would be fetched, don't process
 *
 * Rate limits:
 *   SEC EDGAR: 150ms between requests
 *   Finnhub: 200ms between requests, 5s cooldown every 50 calls
 *
 * Estimated time: 10-15 minutes for 25 trading days
 */

const fs = require('fs');
const path = require('path');
const { fetchAndParseForm4 } = require('../lib/sec-fetcher');
const { scoreAllFilings } = require('../lib/signal-scorer');
const { getCompanyProfile, getSectorLabel } = require('../lib/company-profile');
const { getPriceAtDate, getHistoricalPrices } = require('../lib/price-helper');
const { getRedis } = require('../lib/redis');

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'BuysideBrief hello@buysidebrief.com';
const SEC_RATE_MS = 150;
const FINNHUB_RATE_MS = 200;
const FINNHUB_COOLDOWN_EVERY = 50;
const FINNHUB_COOLDOWN_MS = 5000;
const DAY_PAUSE_MS = 1000;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── CLI args ──

const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v || true];
  })
);

const START_DATE = args.start || '2026-02-10';
const END_DATE = args.end || '2026-03-17';
const MAX_PER_DAY = parseInt(args['max-per-day']) || 50;
const DRY_RUN = !!args.dry;

// ── Date helpers ──

function isWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay();
  return day !== 0 && day !== 6;
}

function generateWeekdays(start, end) {
  const days = [];
  const current = new Date(start + 'T12:00:00Z');
  const endDt = new Date(end + 'T12:00:00Z');

  while (current <= endDt) {
    const dateStr = current.toISOString().split('T')[0];
    if (isWeekday(dateStr)) days.push(dateStr);
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return days;
}

function addCalendarDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
}

// ── EDGAR EFTS search for a single date ──

async function fetchFilingsForDate(date, size = 50) {
  const url = `https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=${date}&enddt=${date}&from=0&size=${size}`;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    await sleep(SEC_RATE_MS);

    if (!res.ok) {
      console.error(`  EDGAR search failed for ${date}: ${res.status}`);
      return [];
    }

    const data = await res.json();
    const hits = data.hits?.hits || [];

    return hits.map(hit => {
      const src = hit._source || {};
      const ciks = src.ciks || [];
      const names = src.display_names || [];
      const hitId = hit._id || '';
      const [accPart, xmlFilename] = hitId.split(':');

      let accessionNumber = accPart || '';
      let cik = (ciks[0] || '').replace(/^0+/, '');

      let fileUrl = '';
      if (accessionNumber && cik && xmlFilename) {
        const accClean = accessionNumber.replace(/-/g, '');
        fileUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/${xmlFilename}`;
      }

      return {
        accessionNumber,
        cik,
        filedAt: src.file_date || src.period_of_report || date,
        formType: src.form_type || '4',
        entityName: names[0] || src.entity_name || 'Unknown',
        fileUrl,
        xmlFilename: xmlFilename || '',
      };
    }).filter(Boolean);
  } catch (e) {
    console.error(`  EDGAR fetch error for ${date}: ${e.message}`);
    return [];
  }
}

// ── SPY data loading / backfill ──

async function loadOrFetchSpyData(kv) {
  const entries = [];

  // Try loading from Redis
  if (kv) {
    let cursor = '0';
    do {
      const [nextCursor, keys] = await kv.scan(cursor, { match: 'meta:sp500:*', count: 200 });
      cursor = String(nextCursor);
      if (keys.length) {
        const pipeline = kv.pipeline();
        for (const k of keys) pipeline.get(k);
        const values = await pipeline.exec();
        for (let i = 0; i < keys.length; i++) {
          const date = keys[i].replace('meta:sp500:', '');
          const raw = values[i];
          let close;
          if (raw && typeof raw === 'object' && raw.price) close = Number(raw.price);
          else if (raw != null) close = Number(raw);
          if (close && close > 0) entries.push({ date, close });
        }
      }
    } while (cursor !== '0');
  }

  console.log(`  SPY from Redis: ${entries.length} data points`);

  if (entries.length < 25) {
    console.log('  Backfilling SPY from Yahoo Finance...');
    try {
      const now = Math.floor(Date.now() / 1000);
      const oneYearAgo = now - 365 * 24 * 60 * 60;
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=${oneYearAgo}&period2=${now}&interval=1d`;
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        const data = await res.json();
        const ts = data.chart?.result?.[0]?.timestamp || [];
        const closes = data.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
        const newEntries = [];

        for (let i = 0; i < ts.length; i++) {
          if (closes[i] != null) {
            const d = new Date(ts[i] * 1000).toISOString().split('T')[0];
            newEntries.push({ date: d, close: closes[i] });
          }
        }

        // Merge and dedupe
        const dateSet = new Set(entries.map(e => e.date));
        const toStore = [];
        for (const e of newEntries) {
          if (!dateSet.has(e.date)) {
            entries.push(e);
            dateSet.add(e.date);
            toStore.push(e);
          }
        }

        // Cache to Redis
        if (kv && toStore.length > 0) {
          const BATCH = 50;
          for (let i = 0; i < toStore.length; i += BATCH) {
            const batch = toStore.slice(i, i + BATCH);
            const pipeline = kv.pipeline();
            for (const e of batch) {
              pipeline.set(`meta:sp500:${e.date}`, { price: e.close, date: e.date });
            }
            await pipeline.exec();
          }
          console.log(`  Cached ${toStore.length} SPY data points to Redis`);
        }
      }
    } catch (e) {
      console.error('  Yahoo Finance SPY fetch failed:', e.message);
    }
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

function classifyRegime(trailing20dReturn) {
  if (trailing20dReturn == null) return null;
  if (trailing20dReturn > 3) return 'bull';
  if (trailing20dReturn >= -3) return 'flat';
  return 'correction';
}

function getRegimeForDate(spyData, targetDate) {
  // Find the closest SPY entry on or before targetDate
  let closest = null;
  for (const entry of spyData) {
    if (entry.date <= targetDate) closest = entry;
    else break;
  }
  if (!closest) return null;

  // Find entry ~20 trading days before
  const idx = spyData.indexOf(closest);
  const lookback = Math.max(0, idx - 20);
  const oldEntry = spyData[lookback];

  if (!oldEntry || !closest.close || !oldEntry.close) return null;
  const trailing = ((closest.close - oldEntry.close) / oldEntry.close) * 100;
  return classifyRegime(trailing);
}

// ── Analysis helpers ──

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function pct(n, d) {
  return d === 0 ? 0 : Math.round((n / d) * 10000) / 100;
}

function round2(n) {
  return n == null ? null : Math.round(n * 100) / 100;
}

function normalizeSignal(sig) {
  if (sig.startsWith('C-suite'))            return 'c_suite';
  if (sig.startsWith('Cluster'))            return 'cluster';
  if (sig.startsWith('Paired'))             return 'paired';
  if (sig.includes('Mega') || sig.includes('Large'))  return 'large_purchase';
  if (sig.includes('Medium') || sig.includes('Solid'))return 'medium_purchase';
  if (sig.includes('Director'))             return 'director';
  if (sig.includes('10%'))                  return 'ten_pct_owner';
  if (sig.includes('Discretionary'))        return 'discretionary';
  if (sig.includes('Baseline'))             return 'baseline';
  if (sig.includes('Post-earnings'))        return 'post_earnings';
  if (sig.includes('Contrarian'))           return 'contrarian';
  return 'other';
}

function bucketPrice(price) {
  if (price == null || price <= 0) return null;
  if (price <= 5)  return 'micro';
  if (price <= 20) return 'small';
  if (price <= 50) return 'mid';
  return 'large';
}

function bucketMarketCap(mcap) {
  if (mcap == null || mcap <= 0) return null;
  if (mcap < 300)   return 'nano';
  if (mcap < 2000)  return 'micro';
  if (mcap < 10000) return 'small';
  if (mcap < 50000) return 'mid';
  return 'large';
}

// ══════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════

async function main() {
  const tradingDays = generateWeekdays(START_DATE, END_DATE);
  console.log(`\n═══ BACKFILL HISTORICAL PICKS ═══`);
  console.log(`Backfill range: ${START_DATE} → ${END_DATE} (${tradingDays.length} trading days)`);
  console.log(`Max filings per day: ${MAX_PER_DAY}`);
  if (DRY_RUN) console.log(`DRY RUN — will only show what would be fetched\n`);

  if (DRY_RUN) {
    for (const day of tradingDays) console.log(`  Would process: ${day}`);
    console.log(`\nTotal: ${tradingDays.length} days × up to ${MAX_PER_DAY} filings = ${tradingDays.length * MAX_PER_DAY} max SEC requests`);
    return;
  }

  const kv = getRedis();
  if (!kv) {
    console.error('Redis not available — cannot store results. Check env vars.');
    process.exit(1);
  }

  // ── Phase 1: Fetch and score all filings ──
  console.log('\n── Phase 1: Fetch & Score ──');

  let totalFilingsScanned = 0;
  let totalParsed = 0;
  const allScoredByDay = {};

  for (let i = 0; i < tradingDays.length; i++) {
    const date = tradingDays[i];
    console.log(`[${i + 1}/${tradingDays.length}] ${date}...`);

    const filingHits = await fetchFilingsForDate(date, MAX_PER_DAY);
    totalFilingsScanned += filingHits.length;

    if (!filingHits.length) {
      console.log(`  ${date}: 0 filings found`);
      if (i < tradingDays.length - 1) await sleep(DAY_PAUSE_MS);
      continue;
    }

    // Parse each filing
    const parsed = [];
    for (const filing of filingHits) {
      try {
        const result = await fetchAndParseForm4(filing);
        if (result) parsed.push(result);
        await sleep(SEC_RATE_MS);
      } catch (e) {
        // Skip individual parse failures silently
      }
    }
    totalParsed += parsed.length;

    // Score
    const scored = scoreAllFilings(parsed);
    allScoredByDay[date] = scored;

    console.log(`  ${date}: fetched ${filingHits.length}, parsed ${parsed.length}, scored ${scored.length}`);

    if (i < tradingDays.length - 1) await sleep(DAY_PAUSE_MS);
  }

  console.log(`\nPhase 1 complete: ${totalFilingsScanned} filings scanned, ${totalParsed} parsed`);

  // ── Phase 2: Filter to picks ──
  console.log('\n── Phase 2: Filter to Picks ──');

  const allPicks = [];
  for (const [date, scored] of Object.entries(allScoredByDay)) {
    for (const filing of scored) {
      const tier = filing.tier;
      if (tier === 'top_pick' || tier === 'strong_signal' || tier === 'feature') {
        if (filing.summary?.buyCount > 0) {
          allPicks.push({ ...filing, backtestDate: date });
        }
      }
    }
  }

  console.log(`Qualifying picks: ${allPicks.length}`);

  if (!allPicks.length) {
    console.log('No picks found in date range. Exiting.');
    return;
  }

  // ── Phase 3: Price lookups (entry + 30-day) ──
  console.log('\n── Phase 3: Price Lookups ──');

  let finnhubCalls = 0;
  let priceFails = [];

  for (let i = 0; i < allPicks.length; i++) {
    const pick = allPicks[i];
    const ticker = pick.issuerTicker || pick.ticker;
    const filingDate = pick.backtestDate;

    // Entry price: prefer transaction price
    let entryPrice = null;
    if (pick.transactions?.length && pick.transactions[0].pricePerShare > 0) {
      entryPrice = pick.transactions[0].pricePerShare;
    }

    if (!entryPrice) {
      try {
        const priceData = await getPriceAtDate(ticker, filingDate);
        if (priceData?.close) entryPrice = priceData.close;
        finnhubCalls++;
        await sleep(FINNHUB_RATE_MS);
      } catch (e) { /* skip */ }
    }

    // 30-day price
    const date30 = addCalendarDays(filingDate, 30);
    let price30d = null;
    try {
      const priceData = await getPriceAtDate(ticker, date30);
      if (priceData?.close) price30d = priceData.close;
      finnhubCalls++;
      await sleep(FINNHUB_RATE_MS);
    } catch (e) { /* skip */ }

    // Rate limit cooldown
    if (finnhubCalls > 0 && finnhubCalls % FINNHUB_COOLDOWN_EVERY === 0) {
      console.log(`  Finnhub cooldown after ${finnhubCalls} calls...`);
      await sleep(FINNHUB_COOLDOWN_MS);
    }

    // Calculate return
    let return30d = null;
    if (entryPrice && entryPrice > 0 && price30d && price30d > 0) {
      return30d = ((price30d - entryPrice) / entryPrice) * 100;
    } else {
      priceFails.push(ticker);
    }

    pick._entryPrice = entryPrice;
    pick._price30d = price30d;
    pick._return30d = return30d;

    if ((i + 1) % 10 === 0) {
      console.log(`  Priced ${i + 1}/${allPicks.length} picks (${finnhubCalls} API calls)`);
    }
  }

  console.log(`Price lookups done: ${finnhubCalls} Finnhub calls, ${priceFails.length} failures`);
  if (priceFails.length) {
    const unique = [...new Set(priceFails)];
    console.log(`  Failed tickers: ${unique.slice(0, 20).join(', ')}${unique.length > 20 ? '...' : ''}`);
  }

  // ── Phase 4: Company profile enrichment ──
  console.log('\n── Phase 4: Company Profile Enrichment ──');

  const uniqueTickers = [...new Set(allPicks.map(p => p.issuerTicker || p.ticker).filter(Boolean))];
  const profileCache = {};

  for (let i = 0; i < uniqueTickers.length; i++) {
    const ticker = uniqueTickers[i];
    try {
      const profile = await getCompanyProfile(ticker);
      if (profile) profileCache[ticker] = profile;
    } catch (e) { /* skip */ }

    if ((i + 1) % 20 === 0) {
      console.log(`  Profiles: ${i + 1}/${uniqueTickers.length}`);
    }
  }

  console.log(`Profiles fetched: ${Object.keys(profileCache).length}/${uniqueTickers.length}`);

  // ── Phase 5: Market regime classification ──
  console.log('\n── Phase 5: Market Regime Classification ──');

  const spyData = await loadOrFetchSpyData(kv);
  console.log(`  SPY data points: ${spyData.length}`);

  // ── Phase 6: Build pick records ──
  console.log('\n── Phase 6: Building Pick Records ──');

  const pickRecords = [];
  for (const pick of allPicks) {
    const ticker = pick.issuerTicker || pick.ticker;
    const filingDate = pick.backtestDate;
    const ownerCik = pick.ownerCik || '';
    const profile = profileCache[ticker] || null;
    const sector = profile ? getSectorLabel(profile.sector) : null;
    const marketCap = profile?.marketCap || null;
    const buyValue = pick.summary?.totalBuyValue || 0;
    const entryPrice = pick._entryPrice;

    let convictionIntensity = null;
    if (buyValue > 0 && marketCap && marketCap > 0) {
      convictionIntensity = round2((buyValue / (marketCap * 1_000_000)) * 100);
    }

    const regime = getRegimeForDate(spyData, filingDate);

    pickRecords.push({
      id: `backtest-${ticker}-${filingDate}-${ownerCik}`,
      ticker,
      companyName: pick.issuerName || pick.entityName || '',
      ownerName: pick.ownerName || '',
      officerTitle: pick.officerTitle || '',
      score: pick.score || 0,
      tier: pick.tier || 'unknown',
      signals: pick.signals || [],
      buyValue,
      entryDate: filingDate,
      entryPrice: round2(entryPrice),
      price30d: round2(pick._price30d),
      return30d: round2(pick._return30d),
      sector,
      marketCap,
      convictionIntensity,
      marketRegime: regime,
      isBacktest: true,
    });
  }

  console.log(`Built ${pickRecords.length} pick records`);

  // ── Phase 7: Storage ──
  console.log('\n── Phase 7: Storage ──');

  // Ensure output directory
  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // Write JSON file
  const outputData = {
    generated: new Date().toISOString().split('T')[0],
    period: { start: START_DATE, end: END_DATE },
    tradingDays: tradingDays.length,
    totalFilingsScanned,
    totalPicks: pickRecords.length,
    picks: pickRecords,
  };

  const jsonPath = path.join(outputDir, 'backtest-picks.json');
  fs.writeFileSync(jsonPath, JSON.stringify(outputData, null, 2));
  console.log(`  Written: ${jsonPath}`);

  // Store in Redis (backtest namespace)
  const BATCH = 50;
  for (let i = 0; i < pickRecords.length; i += BATCH) {
    const batch = pickRecords.slice(i, i + BATCH);
    const pipeline = kv.pipeline();
    for (const pick of batch) {
      const key = `backtest:pick:${pick.ticker}:${pick.entryDate}:${pick.id.split('-').pop()}`;
      pipeline.set(key, pick);
      // Score for sorted set = date as YYYYMMDD number
      const dateScore = parseInt(pick.entryDate.replace(/-/g, ''));
      pipeline.zadd('backtest:picks:index', { score: dateScore, member: key });
    }
    await pipeline.exec();
  }
  console.log(`  Stored ${pickRecords.length} picks in Redis (backtest:pick:* namespace)`);

  // ── Phase 8: Analysis ──
  console.log('\n── Phase 8: Analysis ──');

  const withReturns = pickRecords.filter(p => p.return30d != null && p.entryPrice > 0);
  const returns = withReturns.map(p => p.return30d);
  const winners = withReturns.filter(p => p.return30d > 0);

  const overallStats = {
    totalPicks: pickRecords.length,
    withReturns: withReturns.length,
    winRate: pct(winners.length, withReturns.length),
    avgReturn: round2(returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0),
    medianReturn: round2(median(returns)),
    bestPick: withReturns.length ? withReturns.reduce((best, p) => p.return30d > best.return30d ? p : best) : null,
    worstPick: withReturns.length ? withReturns.reduce((worst, p) => p.return30d < worst.return30d ? p : worst) : null,
  };

  // By signal type
  const bySignal = {};
  for (const pick of withReturns) {
    for (const sig of pick.signals) {
      const cat = normalizeSignal(sig);
      if (!bySignal[cat]) bySignal[cat] = { wins: 0, total: 0, returns: [] };
      bySignal[cat].total++;
      if (pick.return30d > 0) bySignal[cat].wins++;
      bySignal[cat].returns.push(pick.return30d);
    }
  }

  const signalStats = {};
  for (const [cat, data] of Object.entries(bySignal)) {
    signalStats[cat] = {
      n: data.total,
      winRate: pct(data.wins, data.total),
      avgReturn: round2(data.returns.reduce((s, v) => s + v, 0) / data.returns.length),
    };
  }

  // By tier
  const byTier = {};
  for (const pick of withReturns) {
    const tier = pick.tier;
    if (!byTier[tier]) byTier[tier] = { wins: 0, total: 0, returns: [] };
    byTier[tier].total++;
    if (pick.return30d > 0) byTier[tier].wins++;
    byTier[tier].returns.push(pick.return30d);
  }

  const tierStats = {};
  for (const [tier, data] of Object.entries(byTier)) {
    tierStats[tier] = {
      n: data.total,
      winRate: pct(data.wins, data.total),
      avgReturn: round2(data.returns.reduce((s, v) => s + v, 0) / data.returns.length),
    };
  }

  // By price bucket
  const byPriceBucket = {};
  for (const pick of withReturns) {
    const bucket = bucketPrice(pick.entryPrice);
    if (!bucket) continue;
    if (!byPriceBucket[bucket]) byPriceBucket[bucket] = { wins: 0, total: 0, returns: [] };
    byPriceBucket[bucket].total++;
    if (pick.return30d > 0) byPriceBucket[bucket].wins++;
    byPriceBucket[bucket].returns.push(pick.return30d);
  }

  const priceBucketStats = {};
  for (const [bucket, data] of Object.entries(byPriceBucket)) {
    priceBucketStats[bucket] = {
      n: data.total,
      winRate: pct(data.wins, data.total),
      avgReturn: round2(data.returns.reduce((s, v) => s + v, 0) / data.returns.length),
    };
  }

  // By market cap bucket
  const byMarketCap = {};
  for (const pick of withReturns) {
    const bucket = bucketMarketCap(pick.marketCap);
    if (!bucket) continue;
    if (!byMarketCap[bucket]) byMarketCap[bucket] = { wins: 0, total: 0, returns: [] };
    byMarketCap[bucket].total++;
    if (pick.return30d > 0) byMarketCap[bucket].wins++;
    byMarketCap[bucket].returns.push(pick.return30d);
  }

  const marketCapStats = {};
  for (const [bucket, data] of Object.entries(byMarketCap)) {
    marketCapStats[bucket] = {
      n: data.total,
      winRate: pct(data.wins, data.total),
      avgReturn: round2(data.returns.reduce((s, v) => s + v, 0) / data.returns.length),
    };
  }

  // By sector
  const bySector = {};
  for (const pick of withReturns) {
    const sector = pick.sector || 'Unknown';
    if (!bySector[sector]) bySector[sector] = { wins: 0, total: 0, returns: [] };
    bySector[sector].total++;
    if (pick.return30d > 0) bySector[sector].wins++;
    bySector[sector].returns.push(pick.return30d);
  }

  const sectorStats = {};
  for (const [sector, data] of Object.entries(bySector)) {
    sectorStats[sector] = {
      n: data.total,
      winRate: pct(data.wins, data.total),
      avgReturn: round2(data.returns.reduce((s, v) => s + v, 0) / data.returns.length),
    };
  }

  // By market regime
  const byRegime = {};
  for (const pick of withReturns) {
    const regime = pick.marketRegime || 'unknown';
    if (!byRegime[regime]) byRegime[regime] = { wins: 0, total: 0, returns: [] };
    byRegime[regime].total++;
    if (pick.return30d > 0) byRegime[regime].wins++;
    byRegime[regime].returns.push(pick.return30d);
  }

  const regimeStats = {};
  for (const [regime, data] of Object.entries(byRegime)) {
    regimeStats[regime] = {
      n: data.total,
      winRate: pct(data.wins, data.total),
      avgReturn: round2(data.returns.reduce((s, v) => s + v, 0) / data.returns.length),
    };
  }

  // Load live comparison data
  let liveComparison = null;
  try {
    const liveData = await kv.get('meta:early-scorecard');
    if (liveData) {
      liveComparison = typeof liveData === 'string' ? JSON.parse(liveData) : liveData;
    }
  } catch (e) { /* no live data available */ }

  const analysis = {
    generated: new Date().toISOString(),
    period: { start: START_DATE, end: END_DATE },
    overall: overallStats,
    bySignal: signalStats,
    byTier: tierStats,
    byPriceBucket: priceBucketStats,
    byMarketCap: marketCapStats,
    bySector: sectorStats,
    byRegime: regimeStats,
    liveComparison,
  };

  // Save analysis
  const analysisPath = path.join(outputDir, 'backtest-analysis.json');
  fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2));
  console.log(`  Written: ${analysisPath}`);

  await kv.set('meta:backtest-analysis', analysis);
  await kv.set('meta:backtest-summary', {
    generated: analysis.generated,
    period: analysis.period,
    totalPicks: overallStats.totalPicks,
    withReturns: overallStats.withReturns,
    winRate: overallStats.winRate,
    avgReturn: overallStats.avgReturn,
    medianReturn: overallStats.medianReturn,
  });
  console.log(`  Stored analysis in Redis (meta:backtest-analysis, meta:backtest-summary)`);

  // ── Phase 9: Console Report ──

  console.log(`\n═══ BACKTEST RESULTS ═══`);
  console.log(`Period: ${START_DATE} → ${END_DATE} (${tradingDays.length} trading days)`);
  console.log(`Filings scanned: ${totalFilingsScanned}`);
  console.log(`Picks generated: ${pickRecords.length}`);
  console.log(`With 30d returns: ${withReturns.length}`);

  console.log(`\n═══ PERFORMANCE ═══`);
  console.log(`Win rate (30d): ${overallStats.winRate}%`);
  console.log(`Avg return: ${overallStats.avgReturn > 0 ? '+' : ''}${overallStats.avgReturn}%`);
  console.log(`Median return: ${overallStats.medianReturn > 0 ? '+' : ''}${overallStats.medianReturn}%`);
  if (overallStats.bestPick) {
    console.log(`Best pick: $${overallStats.bestPick.ticker} +${round2(overallStats.bestPick.return30d)}%`);
  }
  if (overallStats.worstPick) {
    console.log(`Worst pick: $${overallStats.worstPick.ticker} ${round2(overallStats.worstPick.return30d)}%`);
  }

  // Signal table
  console.log(`\n═══ BY SIGNAL TYPE ═══`);
  console.log(`${'Signal'.padEnd(20)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'Avg Ret'.padStart(9)}`);
  console.log('─'.repeat(43));
  for (const [sig, stats] of Object.entries(signalStats).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${sig.padEnd(20)} ${String(stats.n).padStart(5)} ${(stats.winRate + '%').padStart(7)} ${((stats.avgReturn > 0 ? '+' : '') + stats.avgReturn + '%').padStart(9)}`);
  }

  // Tier table
  console.log(`\n═══ BY TIER ═══`);
  console.log(`${'Tier'.padEnd(16)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'Avg Ret'.padStart(9)}`);
  console.log('─'.repeat(39));
  for (const [tier, stats] of Object.entries(tierStats).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${tier.padEnd(16)} ${String(stats.n).padStart(5)} ${(stats.winRate + '%').padStart(7)} ${((stats.avgReturn > 0 ? '+' : '') + stats.avgReturn + '%').padStart(9)}`);
  }

  // Sector table
  console.log(`\n═══ BY SECTOR ═══`);
  console.log(`${'Sector'.padEnd(22)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'Avg Ret'.padStart(9)}`);
  console.log('─'.repeat(45));
  for (const [sector, stats] of Object.entries(sectorStats).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${sector.slice(0, 22).padEnd(22)} ${String(stats.n).padStart(5)} ${(stats.winRate + '%').padStart(7)} ${((stats.avgReturn > 0 ? '+' : '') + stats.avgReturn + '%').padStart(9)}`);
  }

  // Market regime table
  console.log(`\n═══ BY MARKET REGIME ═══`);
  console.log(`${'Regime'.padEnd(14)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'Avg Ret'.padStart(9)}`);
  console.log('─'.repeat(37));
  for (const [regime, stats] of Object.entries(regimeStats).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`${regime.padEnd(14)} ${String(stats.n).padStart(5)} ${(stats.winRate + '%').padStart(7)} ${((stats.avgReturn > 0 ? '+' : '') + stats.avgReturn + '%').padStart(9)}`);
  }

  // Price bucket table
  console.log(`\n═══ BY PRICE BUCKET ═══`);
  console.log(`${'Bucket'.padEnd(10)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'Avg Ret'.padStart(9)}`);
  console.log('─'.repeat(33));
  for (const bucket of ['micro', 'small', 'mid', 'large']) {
    const stats = priceBucketStats[bucket];
    if (!stats) continue;
    console.log(`${bucket.padEnd(10)} ${String(stats.n).padStart(5)} ${(stats.winRate + '%').padStart(7)} ${((stats.avgReturn > 0 ? '+' : '') + stats.avgReturn + '%').padStart(9)}`);
  }

  // Market cap table
  if (Object.keys(marketCapStats).length) {
    console.log(`\n═══ BY MARKET CAP ═══`);
    console.log(`${'Bucket'.padEnd(10)} ${'N'.padStart(5)} ${'Win%'.padStart(7)} ${'Avg Ret'.padStart(9)}`);
    console.log('─'.repeat(33));
    for (const bucket of ['nano', 'micro', 'small', 'mid', 'large']) {
      const stats = marketCapStats[bucket];
      if (!stats) continue;
      console.log(`${bucket.padEnd(10)} ${String(stats.n).padStart(5)} ${(stats.winRate + '%').padStart(7)} ${((stats.avgReturn > 0 ? '+' : '') + stats.avgReturn + '%').padStart(9)}`);
    }
  }

  // Live comparison
  console.log(`\n═══ BACKTEST vs. LIVE COMPARISON ═══`);
  if (liveComparison) {
    const liveWinRate = liveComparison.overall?.winRate ?? liveComparison.winRate ?? 'N/A';
    const liveAvgReturn = liveComparison.overall?.avgReturn ?? liveComparison.avgReturn ?? 'N/A';
    const liveN = liveComparison.overall?.withReturns ?? liveComparison.totalPicks ?? 'N/A';
    console.log(`${'Metric'.padEnd(20)} ${'Backtest (30d)'.padStart(16)} ${'Live'.padStart(16)}`);
    console.log('─'.repeat(54));
    console.log(`${'Win rate'.padEnd(20)} ${(overallStats.winRate + '%').padStart(16)} ${(liveWinRate + '%').padStart(16)}`);
    console.log(`${'Avg return'.padEnd(20)} ${(overallStats.avgReturn + '%').padStart(16)} ${(liveAvgReturn + '%').padStart(16)}`);
    console.log(`${'Sample size'.padEnd(20)} ${String(withReturns.length).padStart(16)} ${String(liveN).padStart(16)}`);
  } else {
    console.log('No live scorecard data found (meta:early-scorecard). Skipping comparison.');
  }

  // Key findings
  console.log(`\n═══ KEY FINDINGS ═══`);

  // Best/worst signal
  const sortedSignals = Object.entries(signalStats).filter(([, s]) => s.n >= 3).sort((a, b) => b[1].winRate - a[1].winRate);
  if (sortedSignals.length >= 2) {
    const best = sortedSignals[0];
    const worst = sortedSignals[sortedSignals.length - 1];
    console.log(`- Best signal: ${best[0]} (${best[1].winRate}% win rate, n=${best[1].n})`);
    console.log(`- Worst signal: ${worst[0]} (${worst[1].winRate}% win rate, n=${worst[1].n})`);
  }

  // Best tier
  const sortedTiers = Object.entries(tierStats).sort((a, b) => b[1].avgReturn - a[1].avgReturn);
  if (sortedTiers.length) {
    const best = sortedTiers[0];
    console.log(`- Top tier by avg return: ${best[0]} (${best[1].avgReturn > 0 ? '+' : ''}${best[1].avgReturn}%, n=${best[1].n})`);
  }

  // Regime insight
  const sortedRegimes = Object.entries(regimeStats).filter(([, s]) => s.n >= 3).sort((a, b) => b[1].avgReturn - a[1].avgReturn);
  if (sortedRegimes.length) {
    const best = sortedRegimes[0];
    console.log(`- Best regime for insider picks: ${best[0]} (${best[1].avgReturn > 0 ? '+' : ''}${best[1].avgReturn}% avg, n=${best[1].n})`);
  }

  // Sector insight
  const sortedSectors = Object.entries(sectorStats).filter(([, s]) => s.n >= 3).sort((a, b) => b[1].avgReturn - a[1].avgReturn);
  if (sortedSectors.length) {
    const best = sortedSectors[0];
    console.log(`- Best sector: ${best[0]} (${best[1].avgReturn > 0 ? '+' : ''}${best[1].avgReturn}% avg, n=${best[1].n})`);
  }

  console.log(`\nDone. Output: ${jsonPath}, ${analysisPath}`);
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
