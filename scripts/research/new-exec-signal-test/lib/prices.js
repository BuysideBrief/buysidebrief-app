const fs = require('fs');
const path = require('path');
const { readJson, writeJson, ensureDir, sleep, appendLog } = require('./util');

const API_KEY = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY || '';
const BASE = 'https://api.polygon.io'; // spec confirms backward-compat; keeps us safe
const CACHE_DIR = path.join(__dirname, '..', 'cache', 'prices');
const META_DIR = path.join(__dirname, '..', 'cache', 'ticker-meta');
const RATE_LOG = path.join(__dirname, '..', 'output', 'rate-limit.log');

// 5 req/min free tier → one call every 12.5s is safe. We use 13s for buffer.
const MIN_INTERVAL_MS = 13000;
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
      appendLog(RATE_LOG, `429 on ${url.replace(API_KEY, 'XXX')} — backoff ${backoff / 1000}s (attempt ${attempt + 1})`);
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

/**
 * Pull daily bars for a ticker covering [from, to]. Cached indefinitely.
 * Returns { ticker, bars: [{ date, o, h, l, c, v }], exchange, notFound }
 */
async function getDailyBars(ticker, from, to, opts = {}) {
  ensureDir(CACHE_DIR);
  const p = cachePath(ticker);
  let cached = readJson(p);
  if (cached && !opts.force) {
    if (cached.notFound) return cached;
    // If cache covers the window, use it
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
 * Get primary exchange for a ticker. Cached per ticker.
 * Returns { ticker, exchange, name, notFound }.
 */
async function getTickerMeta(ticker) {
  ensureDir(META_DIR);
  const p = path.join(META_DIR, `${ticker.toUpperCase()}.json`);
  const cached = readJson(p);
  if (cached) return cached;

  if (!API_KEY) throw new Error('MASSIVE_API_KEY / POLYGON_API_KEY not set');

  const url = `${BASE}/v3/reference/tickers/${encodeURIComponent(ticker)}?apiKey=${API_KEY}`;
  const { status, data } = await throttledFetch(url);
  if (status === 404 || !data?.results) {
    const out = { ticker, notFound: true };
    writeJson(p, out);
    return out;
  }
  const r = data.results;
  const out = {
    ticker: r.ticker,
    exchange: r.primary_exchange || null,
    name: r.name,
    type: r.type,
    active: r.active,
  };
  writeJson(p, out);
  return out;
}

function isNyseOrNasdaq(meta) {
  if (!meta || meta.notFound) return false;
  const ex = (meta.exchange || '').toUpperCase();
  return ex === 'XNYS' || ex === 'XNAS' || ex === 'XASE' || ex === 'ARCX' || ex === 'BATS';
}

/**
 * Bulk-load the set of active US stock tickers on NYSE (XNYS), Nasdaq (XNAS),
 * and NYSE American (XASE). One-time call (~5 paginated requests total) —
 * replaces the per-ticker meta lookup entirely for exchange filtering.
 * Cached to cache/ticker-meta/_universe.json so repeat runs are instant.
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
 * Find the close price on a given date, or the next trading day if that date
 * falls on a weekend/holiday. `direction` = 'next' or 'prev'.
 */
function findCloseAt(bars, targetDate, direction = 'next', maxSkipDays = 7) {
  if (!bars || !bars.length) return null;
  // bars are sorted asc; binary search would be nicer but linear is fine for daily data
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

module.exports = { getDailyBars, getTickerMeta, isNyseOrNasdaq, findCloseAt, loadUsListedUniverse };
