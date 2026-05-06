#!/usr/bin/env node
/**
 * 03-fetch-prices.js — fetch Polygon daily closes for every unique ticker
 * appearing in data/filings.json, plus SPY for the full window. Pulls a
 * range generous enough to compute +90 trading-day forward returns from any
 * filing date in the dataset. Per-ticker bars are cached, so the next run
 * is a no-op.
 *
 * Also pulls point-in-time market cap (Polygon ticker reference, ?date=)
 * for each (ticker, filingMonth) pair — used for bucket assignment in 04.
 *
 * Output: data/prices.json — keyed by accessionNo:
 *   { entry, d30, d60, d90, spy_entry, spy_d30, spy_d60, spy_d90, marketCap }
 *
 * Idempotent. Pass --force to refetch.
 */

const fs = require('fs');
const path = require('path');
const { writeJson, readJson, ensureDir, addDays, sleep } = require('../lib/util');
const { getDailyBars, findCloseAt, findCloseTradingDaysOut, getMarketCapAt } = require('../lib/prices');

const ROOT = path.resolve(__dirname, '..');
const FILINGS_PATH = path.join(ROOT, 'data', 'filings.json');
const OUT_PATH = path.join(ROOT, 'data', 'prices.json');

// Buffer dates: pull from earliest filingDate-7d to latest+150d (90 trading days ≈ 130 cal)
const FETCH_BUFFER_BEFORE = 14;
const FETCH_BUFFER_AFTER = 150;

const FORCE = process.argv.includes('--force');

async function main() {
  ensureDir(path.join(ROOT, 'data'));
  const filings = readJson(FILINGS_PATH);
  if (!filings) throw new Error(`Missing ${FILINGS_PATH}`);

  const dates = filings.map(f => f.filingDate).filter(Boolean).sort();
  const minDate = addDays(dates[0], -FETCH_BUFFER_BEFORE);
  const maxDate = addDays(dates[dates.length - 1], FETCH_BUFFER_AFTER);
  console.log(`[03-prices] Filing window: ${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`[03-prices] Fetch window:  ${minDate} → ${maxDate}`);

  const tickers = [...new Set(filings.map(f => f.ticker))].sort();
  console.log(`[03-prices] ${tickers.length} unique tickers + SPY`);

  // Always pull SPY first
  console.log(`[03-prices] Fetching SPY...`);
  const spy = await getDailyBars('SPY', minDate, maxDate);
  if (!spy.bars?.length) throw new Error('SPY pull returned no bars');
  console.log(`[03-prices] SPY: ${spy.bars.length} bars`);

  // Per-ticker bars (cached)
  const tickerBars = {};
  let i = 0;
  for (const t of tickers) {
    i++;
    try {
      const data = await getDailyBars(t, minDate, maxDate);
      tickerBars[t] = data;
      if (i % 25 === 0) console.log(`  [progress] ${i}/${tickers.length} tickers (${t}: ${data.bars?.length || 0} bars)`);
    } catch (e) {
      console.error(`  [error] ${t}: ${e.message}`);
      tickerBars[t] = { ticker: t, notFound: true, bars: [] };
    }
  }
  console.log(`[03-prices] Bars fetched for ${Object.keys(tickerBars).length} tickers`);

  // Market cap point-in-time per filing
  const mcapNeeded = new Map(); // ticker:YYYY-MM → null
  for (const f of filings) {
    const ym = f.filingDate.slice(0, 7);
    mcapNeeded.set(`${f.ticker}|${ym}`, { ticker: f.ticker, asOf: f.filingDate });
  }
  console.log(`[03-prices] Fetching market cap for ${mcapNeeded.size} (ticker, month) pairs...`);
  const mcaps = {};
  let m = 0;
  for (const [key, { ticker, asOf }] of mcapNeeded.entries()) {
    m++;
    try {
      const mc = await getMarketCapAt(ticker, asOf);
      mcaps[key] = mc;
      if (m % 100 === 0) console.log(`  [mcap progress] ${m}/${mcapNeeded.size}`);
    } catch (e) {
      console.error(`  [mcap error] ${ticker} ${asOf}: ${e.message}`);
      mcaps[key] = null;
    }
  }

  // Resolve forward closes per filing
  const out = {};
  let dropNoEntry = 0, dropNoSpyEntry = 0, dropNotFound = 0;
  for (const f of filings) {
    const tBars = tickerBars[f.ticker]?.bars || [];
    if (!tBars.length) { dropNotFound++; continue; }

    const entry = findCloseAt(tBars, f.filingDate, 'next', 7);
    if (!entry) { dropNoEntry++; continue; }
    const spyEntry = findCloseAt(spy.bars, f.filingDate, 'next', 7);
    if (!spyEntry) { dropNoSpyEntry++; continue; }

    const ymKey = `${f.ticker}|${f.filingDate.slice(0, 7)}`;
    const marketCap = mcaps[ymKey] || null;

    const result = {
      entry: { date: entry.date, close: entry.close },
      spy_entry: { date: spyEntry.date, close: spyEntry.close },
      marketCap,
    };

    for (const n of [30, 60, 90]) {
      const tExit = findCloseTradingDaysOut(tBars, entry.date, n);
      const spyExit = findCloseTradingDaysOut(spy.bars, spyEntry.date, n);
      result[`d${n}`] = tExit ? { date: tExit.date, close: tExit.close } : null;
      result[`spy_d${n}`] = spyExit ? { date: spyExit.date, close: spyExit.close } : null;
    }

    out[f.accessionNo] = result;
  }

  console.log(`[03-prices] Resolved ${Object.keys(out).length}/${filings.length} filings`);
  console.log(`  drop missing bars   : ${dropNotFound}`);
  console.log(`  drop no entry close : ${dropNoEntry}`);
  console.log(`  drop no SPY entry   : ${dropNoSpyEntry}`);

  writeJson(OUT_PATH, out);
  console.log(`[03-prices] Wrote prices → ${OUT_PATH}`);
}

main().catch(e => { console.error('[03-prices] FATAL', e); process.exit(1); });
