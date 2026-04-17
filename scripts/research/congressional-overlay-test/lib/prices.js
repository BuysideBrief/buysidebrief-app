/**
 * Polygon/Massive price client. 5 req/min free tier with 30s→5min exp backoff on 429.
 * Per-ticker JSON cache. Universe loader pulls XNYS + XNAS + XASE active stocks.
 */
const fs = require('fs');
const path = require('path');
const { readJson, writeJson, ensureDir, sleep, appendLog } = require('./util');

const API_KEY = process.env.MASSIVE_API_KEY || process.env.POLYGON_API_KEY || '';
const BASE = 'https://api.polygon.io';
const CACHE = path.join(__dirname, '..', 'cache', 'prices');
const META = path.join(__dirname, '..', 'cache', 'ticker-meta');
const RATE_LOG = path.join(__dirname, '..', 'output', 'rate-limit.log');

const MIN_INTERVAL_MS = 13000;
let lastAt = 0;

async function throttledFetch(url) {
  const wait = Math.max(0, lastAt + MIN_INTERVAL_MS - Date.now());
  if (wait) await sleep(wait);
  let backoff = 30000;
  for (let attempt = 0; attempt < 6; attempt++) {
    lastAt = Date.now();
    const res = await fetch(url);
    if (res.status === 429) {
      appendLog(RATE_LOG, `429 backoff ${backoff / 1000}s (attempt ${attempt + 1})`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 300000);
      continue;
    }
    if (!res.ok) {
      if (res.status === 404) return { status: 404, data: null };
      throw new Error(`polygon ${res.status} ${url.replace(API_KEY, 'XXX')}`);
    }
    return { status: res.status, data: await res.json() };
  }
  throw new Error(`polygon rate-limit retries exhausted`);
}

async function getDailyBars(ticker, from, to, opts = {}) {
  ensureDir(CACHE);
  const p = path.join(CACHE, `${ticker.toUpperCase()}.json`);
  const cached = readJson(p);
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

async function loadUsListedUniverse(opts = {}) {
  ensureDir(META);
  const uP = path.join(META, '_universe.json');
  const cached = readJson(uP);
  if (cached && !opts.force) return new Set(cached.tickers);
  if (!API_KEY) throw new Error('MASSIVE_API_KEY / POLYGON_API_KEY not set');
  const tickers = new Set();
  for (const ex of ['XNYS', 'XNAS', 'XASE']) {
    let url = `${BASE}/v3/reference/tickers?market=stocks&active=true&exchange=${ex}&limit=1000&apiKey=${API_KEY}`;
    let pages = 0;
    while (url && pages < 50) {
      const { data } = await throttledFetch(url);
      if (!data) break;
      for (const r of (data.results || [])) {
        const sym = String(r.ticker || '').toUpperCase();
        if (sym) tickers.add(sym);
      }
      pages++;
      url = data.next_url ? `${data.next_url}&apiKey=${API_KEY}` : null;
    }
    console.log(`  [universe] ${ex}: cumulative ${tickers.size}`);
  }
  writeJson(uP, { fetchedAt: new Date().toISOString(), count: tickers.size, tickers: [...tickers] });
  return tickers;
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
  }
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

function isInUniverse(universe, ticker) {
  return universe.has(String(ticker || '').toUpperCase());
}

module.exports = { getDailyBars, loadUsListedUniverse, findCloseAt, isInUniverse };
