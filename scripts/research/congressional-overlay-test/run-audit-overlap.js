#!/usr/bin/env node
/**
 * Sanity-check the 0-overlap result. Is it real signal rarity or a bug?
 *
 * Checks:
 *   1. What are the top Form 4 tickers vs top congressional tickers?
 *   2. Is there ANY ticker intersection in the raw data?
 *   3. Is the normalization consistent?
 *   4. Print any near-matches (same ticker, different date window)
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { normalize } = require('./lib/ticker-normalize');
const { readJson } = require('./lib/util');
const form4CacheDir = path.join(__dirname, 'cache', 'form4');
const ptrParsedDir = path.join(__dirname, 'cache', 'house-ptr-parsed');

function loadForm4Buys() {
  const out = [];
  for (const f of fs.readdirSync(form4CacheDir)) {
    if (!f.endsWith('.json')) continue;
    const data = readJson(path.join(form4CacheDir, f));
    if (data?.buys) for (const b of data.buys) {
      if (!b.error && b.ticker && b.transactions?.length && b.transactions[0].price >= 2) out.push(b);
    }
  }
  return out;
}

function loadCongressRows() {
  const out = [];
  for (const f of fs.readdirSync(ptrParsedDir)) {
    if (!f.endsWith('.json')) continue;
    const data = readJson(path.join(ptrParsedDir, f));
    for (const r of (data.rows || [])) if (r.ticker) out.push(r);
  }
  return out;
}

function main() {
  const form4Buys = loadForm4Buys();
  const congRows = loadCongressRows();
  const congBuys = congRows.filter(r => r.txType === 'P');

  console.log(`Form 4 buys: ${form4Buys.length}`);
  console.log(`Congressional stock rows: ${congRows.length}`);
  console.log(`Congressional purchases: ${congBuys.length}`);

  // Unique ticker sets
  const f4Tickers = new Map();
  for (const b of form4Buys) {
    const k = normalize(b.ticker);
    f4Tickers.set(k, (f4Tickers.get(k) || 0) + 1);
  }
  const cTickers = new Map();
  for (const r of congRows) {
    const k = normalize(r.ticker);
    cTickers.set(k, (cTickers.get(k) || 0) + 1);
  }
  const cBuyTickers = new Map();
  for (const r of congBuys) {
    const k = normalize(r.ticker);
    cBuyTickers.set(k, (cBuyTickers.get(k) || 0) + 1);
  }

  console.log(`\nUnique F4 tickers: ${f4Tickers.size}`);
  console.log(`Unique congress tickers (all txs): ${cTickers.size}`);
  console.log(`Unique congress buy tickers: ${cBuyTickers.size}`);

  // Intersection
  const f4Set = new Set(f4Tickers.keys());
  const cSet = new Set(cTickers.keys());
  const cBuySet = new Set(cBuyTickers.keys());
  const intersectAnyDirection = [...f4Set].filter(t => cSet.has(t));
  const intersectBuyOnly = [...f4Set].filter(t => cBuySet.has(t));

  console.log(`\nF4 ∩ Congress (any direction): ${intersectAnyDirection.length} tickers`);
  console.log(`F4 ∩ Congress (buys only):     ${intersectBuyOnly.length} tickers`);

  console.log('\n--- Top 15 Form 4 tickers ---');
  for (const [t, n] of [...f4Tickers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${t}: ${n} buys`);

  console.log('\n--- Top 15 congressional buy tickers ---');
  for (const [t, n] of [...cBuyTickers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${t}: ${n} buys`);

  if (intersectBuyOnly.length) {
    console.log('\n--- INTERSECTION (F4 buy ticker == Congress buy ticker) ---');
    for (const t of intersectBuyOnly) {
      const f4Dates = form4Buys.filter(b => normalize(b.ticker) === t).map(b => b.transactions[0].txDate);
      const cDates = congBuys.filter(r => normalize(r.ticker) === t).map(r => r.txDate);
      console.log(`  ${t} — F4 dates: ${f4Dates.join(', ')} | congress dates: ${cDates.join(', ')}`);
    }
  }

  if (intersectAnyDirection.length && !intersectBuyOnly.length) {
    console.log('\n--- TICKER OVERLAP (F4 buy vs Congress SELL only — no overlap buy) ---');
    for (const t of intersectAnyDirection.slice(0, 20)) {
      console.log(`  ${t}`);
    }
  }
}

main();
