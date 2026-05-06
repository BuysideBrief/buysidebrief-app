const fs = require('fs');
const path = require('path');
const { readJson, writeJson, ensureDir, sleep, appendLog } = require('./util');

const API_KEY = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY || '';
const BASE = 'https://api.polygon.io';
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'prices');
const META_DIR = path.join(__dirname, '..', 'cache', 'ticker-meta');
const MCAP_DIR = path.join(__dirname, '..', 'cache', 'mcap');
const RATE_LOG = path.join(__dirname, '..', 'run.log');

// Free tier is 5 req/min; paid is much higher. Default to safe pace, override via env.
const MIN_INTERVAL_MS = parseInt(process.env.POLYGON_MIN_INTERVAL_MS || '13000', 10);
let lastRequestAt = 0;

async function throttledFetch(url) {
  const now = Date.now();
  const wait = Math.max(0, lastRequestAt + MIN_INTERVAL_MS - now);
  if (wait) await sleep(wait);

  let backoff = 30000;
  for (let attempt = 0; attempt < 6; attempt++) {
    lastRequestAt = Date.now();
    const res = await fetch(url);
    if (res.status === 429) {
      appendLog(RATE_LOG, `polygon 429 — backoff ${backoff / 1000}s (attempt ${attempt + 1})`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 300000);
      continue;
    }
    if (!res.ok) {
      if (res.status === 404) return { status: 404, data: null };
      throw new Error(`Polygon ${res.status} for ${url.replace(API_KEY, 'XXX')}`);
    }
    return { status: res.status, data: await res.json() };
  }
  throw new Error(`Polygon rate-limit retries exhausted: ${url.replace(API_KEY, 'XXX')}`);
}

function cachePath(ticker) { return path.join(CACHE_DIR, `${ticker.toUpperCase()}.json`); }

async function getDailyBars(ticker, from, to, opts = {}) {
  ensureDir(CACHE_DIR);
  const p = cachePath(ticker);
  let cached = readJson(p);
  if (cached && !opts.force) {
    if (cached.notFound) return cached;
    if (cached.from <= from && cached.to >= to) return cached;
  }

  if (!API_KEY) throw new Error('MASSIVE_API_KEY / POLYGON_API_KEY not set');

  const url = `${BASE}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${API_KEY}`;
  const { status, data } = await throttledFetch(url);
  if (status === 404 || !data || data.status === 'NOT_FOUND' || data.resultsCount === 0) {
    const out = { ticker, notFound: true, from, to, bars: [] };
    writeJson(p, out);
    return out;
  }

  const bars = (data.results || []).map(r => ({
    date: new Date(r.t).toISOString().slice(0, 10),
    o: r.o, h: r.h, l: r.l, c: r.c, v: r.v,
  }));
  const out = { ticker, from, to, bars, fetchedAt: new Date().toISOString() };
  writeJson(p, out);
  return out;
}

/**
 * Pull active US-listed tickers on NYSE/Nasdaq/NYSE-American, paginated.
 * Returns Set<string> of uppercase symbols. Cached to ticker-meta/_universe.json.
 */
async function loadUsListedUniverse(opts = {}) {
  ensureDir(META_DIR);
  const universePath = path.join(META_DIR, '_universe.json');
  const cached = readJson(universePath);
  if (cached && !opts.force) return new Set(cached.tickers);

  if (!API_KEY) throw new Error('MASSIVE_API_KEY / POLYGON_API_KEY not set');

  const tickers = new Set();
  const tickerInfo = {};
  for (const exchange of ['XNYS', 'XNAS', 'XASE']) {
    let cursorUrl = `${BASE}/v3/reference/tickers?market=stocks&active=true&exchange=${exchange}&limit=1000&apiKey=${API_KEY}`;
    let pages = 0;
    while (cursorUrl && pages < 50) {
      const { status, data } = await throttledFetch(cursorUrl);
      if (status === 404 || !data) break;
      for (const r of (data.results || [])) {
        const sym = String(r.ticker || '').toUpperCase();
        if (!sym) continue;
        tickers.add(sym);
        tickerInfo[sym] = { exchange: r.primary_exchange, name: r.name, type: r.type };
      }
      pages++;
      cursorUrl = data.next_url ? `${data.next_url}&apiKey=${API_KEY}` : null;
    }
    console.log(`  [universe] ${exchange}: cumulative ${tickers.size} tickers`);
  }

  writeJson(universePath, { fetchedAt: new Date().toISOString(), count: tickers.size, tickers: [...tickers], info: tickerInfo });
  return tickers;
}

/**
 * Point-in-time market cap from Polygon ticker reference, snapshot-as-of-date.
 * Falls back to the current snapshot if the dated query yields no value.
 * Cached per (ticker, asOfYearMonth) so we don't re-hit for nearby dates.
 */
async function getMarketCapAt(ticker, asOfDate) {
  if (!API_KEY) return null;
  ensureDir(MCAP_DIR);
  const ymKey = asOfDate.slice(0, 7); // YYYY-MM granularity is plenty for bucketing
  const p = path.join(MCAP_DIR, `${ticker.toUpperCase()}_${ymKey}.json`);
  const cached = readJson(p);
  if (cached) return cached.marketCap;

  const url = `${BASE}/v3/reference/tickers/${encodeURIComponent(ticker)}?date=${asOfDate}&apiKey=${API_KEY}`;
  const { status, data } = await throttledFetch(url);
  let marketCap = null;
  if (status !== 404 && data?.results) {
    const r = data.results;
    if (r.market_cap && Number.isFinite(r.market_cap)) marketCap = r.market_cap;
    if (!marketCap && r.weighted_shares_outstanding && r.share_class_shares_outstanding) {
      // best-effort fallback — share count alone (no price) isn't market cap, leave null
    }
  }
  writeJson(p, { ticker, asOf: asOfDate, marketCap, fetchedAt: new Date().toISOString() });
  return marketCap;
}

function findCloseAt(bars, targetDate, direction = 'next', maxSkipDays = 7) {
  if (!bars || !bars.length) return null;
  if (direction === 'next') {
    for (const b of bars) {
      if (b.date >= targetDate) {
        const skip = Math.round((new Date(b.date) - new Date(targetDate)) / 86400000);
        if (skip > maxSkipDays) return null;
        return { date: b.date, close: b.c, skipDays: skip };
      }
    }
    return null;
  } else {
    for (let i = bars.length - 1; i >= 0; i--) {
      const b = bars[i];
      if (b.date <= targetDate) {
        const skip = Math.round((new Date(targetDate) - new Date(b.date)) / 86400000);
        if (skip > maxSkipDays) return null;
        return { date: b.date, close: b.c, skipDays: skip };
      }
    }
    return null;
  }
}

/**
 * Find the close N TRADING days after entryDate. Trading-day stepping keeps
 * the "30 / 60 / 90 trading days" horizon honest regardless of weekends/holidays.
 */
function findCloseTradingDaysOut(bars, entryDate, n) {
  if (!bars || !bars.length) return null;
  let entryIdx = -1;
  for (let i = 0; i < bars.length; i++) {
    if (bars[i].date >= entryDate) { entryIdx = i; break; }
  }
  if (entryIdx === -1) return null;
  const exitIdx = entryIdx + n;
  if (exitIdx >= bars.length) return null;
  const b = bars[exitIdx];
  return { date: b.date, close: b.c, idx: exitIdx };
}

module.exports = {
  getDailyBars,
  loadUsListedUniverse,
  getMarketCapAt,
  findCloseAt,
  findCloseTradingDaysOut,
};
