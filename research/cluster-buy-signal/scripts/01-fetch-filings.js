#!/usr/bin/env node
/**
 * 01-fetch-filings.js — pull qualifying Form 4 P-transactions over the
 * pre-registered window. Filters to NYSE/Nasdaq listed individual insiders,
 * buyValue >= $10K, price >= $1.
 *
 * Output: data/filings.json
 *
 * Idempotent: per-day cache lives in cache/form4/. Pass --force to rebuild.
 */

const fs = require('fs');
const path = require('path');
const { pullForm4Range } = require('../lib/edgar-form4');
const { loadUsListedUniverse } = require('../lib/prices');
const { isInstitutionalBuyer } = require('../lib/institutional-filter');
const { writeJson, ensureDir } = require('../lib/util');

const ROOT = path.resolve(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'data', 'filings.json');

// Pre-registered scope
const START_DATE = '2025-04-01';
const END_DATE = '2026-04-01';
const MIN_BUY_VALUE = 10_000;
const MIN_PRICE = 1.0;

const FORCE = process.argv.includes('--force');

function aggregateBuy(buys) {
  let totalShares = 0;
  let totalValue = 0;
  let weightedPrice = 0;
  for (const t of buys) {
    totalShares += t.shares;
    totalValue += t.value;
  }
  weightedPrice = totalShares ? totalValue / totalShares : 0;
  return { totalShares, totalValue, weightedPrice };
}

async function main() {
  ensureDir(path.join(ROOT, 'data'));
  ensureDir(path.join(ROOT, 'results'));

  if (fs.existsSync(OUT_PATH) && !FORCE) {
    const cached = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
    console.log(`[01-fetch] Skipping — ${OUT_PATH} already has ${cached.length} filings (pass --force to rebuild)`);
    return;
  }

  console.log(`[01-fetch] Loading NYSE/Nasdaq/NYSE-American universe...`);
  const universe = await loadUsListedUniverse();
  console.log(`[01-fetch] Universe size: ${universe.size} tickers`);

  console.log(`[01-fetch] Pulling Form 4 P-transactions ${START_DATE} → ${END_DATE}...`);
  const all = await pullForm4Range(START_DATE, END_DATE, { concurrency: 6 });
  console.log(`[01-fetch] Pulled ${all.length} raw P-transaction filings`);

  // Apply filters
  const out = [];
  let dropExchange = 0, dropInstitutional = 0, dropPrice = 0, dropValue = 0, dropMissing = 0;
  for (const f of all) {
    if (!f.ticker || !f.ownerCik) { dropMissing++; continue; }
    const tickerU = f.ticker.toUpperCase();
    if (!universe.has(tickerU)) { dropExchange++; continue; }
    if (isInstitutionalBuyer(f.ownerName)) { dropInstitutional++; continue; }

    const agg = aggregateBuy(f.transactions);
    if (agg.weightedPrice < MIN_PRICE) { dropPrice++; continue; }
    if (agg.totalValue < MIN_BUY_VALUE) { dropValue++; continue; }

    // Pick the earliest transaction date in the filing as the "transaction date"
    const txDates = f.transactions.map(t => t.txDate).filter(Boolean).sort();

    out.push({
      accessionNo: f.accession,
      ticker: tickerU,
      issuerCik: f.issuerCik,
      issuerName: f.issuerName,
      ownerCik: f.ownerCik,
      ownerName: f.ownerName,
      isDirector: f.isDirector,
      isOfficer: f.isOfficer,
      isTenPercent: f.isTenPercent,
      officerTitle: f.officerTitle,
      role: f.role,
      filingDate: f.filedAt,
      transactionDate: txDates[0] || f.filedAt,
      buyValue: agg.totalValue,
      sharesAcquired: agg.totalShares,
      pricePerShare: agg.weightedPrice,
    });
  }

  out.sort((a, b) => (a.filingDate + a.ticker + a.ownerCik).localeCompare(b.filingDate + b.ticker + b.ownerCik));

  console.log(`[01-fetch] Filter funnel:`);
  console.log(`  raw P-buys              : ${all.length}`);
  console.log(`  drop missing tkr/cik    : -${dropMissing}`);
  console.log(`  drop off-exchange       : -${dropExchange}`);
  console.log(`  drop institutional      : -${dropInstitutional}`);
  console.log(`  drop price < $1         : -${dropPrice}`);
  console.log(`  drop buyValue < $10K    : -${dropValue}`);
  console.log(`  qualifying              : ${out.length}`);

  writeJson(OUT_PATH, out);
  console.log(`[01-fetch] Wrote ${out.length} filings → ${OUT_PATH}`);

  // Plain-assertion sanity
  const uniqueTickers = new Set(out.map(r => r.ticker));
  const uniqueOwners = new Set(out.map(r => r.ownerCik));
  console.log(`[01-fetch] Unique tickers=${uniqueTickers.size}, unique owners=${uniqueOwners.size}`);
  if (out.length === 0) throw new Error('Filter produced ZERO filings — bad upstream pull');
}

main().catch(e => { console.error('[01-fetch] FATAL', e); process.exit(1); });
