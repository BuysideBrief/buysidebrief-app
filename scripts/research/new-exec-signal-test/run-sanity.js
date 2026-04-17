#!/usr/bin/env node
/**
 * Sanity test — 2-week end-to-end pipeline run.
 * Verifies: Form 4 pull+parse, 8-K 5.02 pull+parse, name matching,
 * Polygon price pull, forward return calculation.
 *
 * Window: Apr 16 – Apr 29, 2025 (2 weeks from the start of the full test window).
 * 8-K lookback: Jan 16 – Apr 29, 2025 (90 days — placebo 180-day lookback only
 *   matters for the full run and can be layered in without re-pulling cohort 1 data).
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env.local') });

const path = require('path');
const fs = require('fs');
const { pullForm4Range } = require('./lib/edgar-form4');
const { pull8K502Range } = require('./lib/edgar-8k-502');
const { findBestApptMatch } = require('./lib/name-match');
const { getDailyBars, getTickerMeta, isNyseOrNasdaq } = require('./lib/prices');
const { computeForwardReturns } = require('./lib/returns');
const { summarize, welchTTest } = require('./lib/stats');
const { writeJson, ensureDir } = require('./lib/util');

const OUT_DIR = path.join(__dirname, 'output');

// Narrower window for speed during sanity. Full 2 weeks: Apr 16 – Apr 29.
const FORM4_START = process.env.SANITY_START || '2025-04-16';
const FORM4_END = process.env.SANITY_END || '2025-04-29';
const K8_START = '2025-01-16';
const K8_END = FORM4_END;
const PRICE_MAX = '2025-08-31'; // enough for 90-day forward returns from Apr 29

function log(label, msg) { console.log(`[${label}] ${msg}`); }

async function main() {
  ensureDir(OUT_DIR);
  console.log('\n=== NEW EXEC SIGNAL SANITY TEST ===');
  console.log(`Form 4 window: ${FORM4_START} → ${FORM4_END}`);
  console.log(`8-K 5.02 window: ${K8_START} → ${K8_END}`);
  console.log(`API key: ${process.env.MASSIVE_API_KEY ? 'loaded' : 'MISSING'}\n`);

  // 1. Pull Form 4 P-buys
  log('step1', 'Pulling Form 4 P-transactions...');
  const form4Buys = await pullForm4Range(FORM4_START, FORM4_END);
  log('step1', `Total Form 4 buy filings: ${form4Buys.length}`);
  const withError = form4Buys.filter(f => f.error);
  if (withError.length) log('step1', `  (${withError.length} had parse errors)`);

  const cleanBuys = form4Buys.filter(f => !f.error && f.ticker && f.transactions?.length);
  log('step1', `  Clean buys with ticker + transactions: ${cleanBuys.length}`);

  // 2. Pull 8-K Item 5.02 appointments
  log('step2', 'Pulling 8-K Item 5.02 filings...');
  const appointments = await pull8K502Range(K8_START, K8_END);
  log('step2', `Total appointments extracted: ${appointments.length}`);
  const ambiguous = appointments.filter(a => a.ambiguous);
  if (ambiguous.length) log('step2', `  (${ambiguous.length} flagged as role=Unknown)`);

  // 3. Apply $2 price floor + cohort classification
  log('step3', 'Classifying cohorts...');
  const priced = cleanBuys.filter(f => {
    const tx = f.transactions[0];
    return tx && tx.price >= 2;
  });
  log('step3', `After $2 price floor: ${priced.length}`);

  const cohort1 = []; // new exec buy
  const cohort2 = []; // placebo (stable C-suite)
  const cohort3 = priced; // baseline: all qualifying buys

  // Index appointments by CIK for fast lookup
  const apptByCik = new Map();
  for (const a of appointments) {
    if (!apptByCik.has(a.cik)) apptByCik.set(a.cik, []);
    apptByCik.get(a.cik).push(a);
  }

  const cSuitePattern = /chief\s+(executive|financial|operating|operations)\s+officer|president\b|\bCEO\b|\bCFO\b|\bCOO\b/i;

  for (const buy of priced) {
    const cikAppts = apptByCik.get(buy.issuerCik) || [];
    const matchEntry = findBestApptMatch(buy, appointments);

    if (matchEntry && matchEntry.tenureDays <= 90) {
      cohort1.push({ buy, match: matchEntry });
    }

    // Cohort 2: C-suite, no 8-K 5.02 at this CIK within 180 days prior
    const isCsuite = buy.isOfficer && (cSuitePattern.test(buy.officerTitle || ''));
    if (isCsuite) {
      const txDate = buy.transactions[0].txDate;
      const within180 = cikAppts.some(a => {
        const gap = (new Date(txDate) - new Date(a.effectiveDate)) / 86400000;
        return gap >= 0 && gap <= 180;
      });
      if (!within180) cohort2.push({ buy });
    }
  }

  log('step3', `Cohort 1 (new exec, ≤90d): ${cohort1.length}`);
  log('step3', `Cohort 2 (stable C-suite placebo): ${cohort2.length}`);
  log('step3', `Cohort 3 (baseline all buys): ${cohort3.length}`);

  // Print spot-checks for cohort 1 matches
  if (cohort1.length > 0) {
    console.log('\n--- Cohort 1 sample matches ---');
    for (const c of cohort1.slice(0, 10)) {
      console.log(`  ${c.buy.ticker} | ${c.buy.ownerName} → matched "${c.match.appt.name}" (${c.match.appt.role}, ${c.match.match.confidence}, tenure ${c.match.tenureDays}d)`);
    }
  }

  // 4. Exchange filter + price pulls
  // For sanity, sample up to 40 from cohort 1 + 60 from cohort 2 to cap API calls.
  const sampleC1 = cohort1.slice(0, 40);
  const sampleC2Pool = cohort2.slice().sort(() => 0.5 - Math.random()).slice(0, 60);

  const allTickers = new Set();
  for (const c of [...sampleC1, ...sampleC2Pool]) allTickers.add(c.buy.ticker);
  allTickers.add('SPY');

  log('step4', `Pulling exchange metadata + price bars for ${allTickers.size} tickers...`);
  const exchangeCache = new Map();
  for (const ticker of allTickers) {
    if (ticker === 'SPY') { exchangeCache.set(ticker, { exchange: 'XNYS' }); continue; }
    try {
      const meta = await getTickerMeta(ticker);
      exchangeCache.set(ticker, meta);
    } catch (e) {
      log('step4', `  meta fail ${ticker}: ${e.message}`);
      exchangeCache.set(ticker, { notFound: true });
    }
  }

  // Filter samples to NYSE/Nasdaq
  const c1Filtered = sampleC1.filter(c => isNyseOrNasdaq(exchangeCache.get(c.buy.ticker)));
  const c2Filtered = sampleC2Pool.filter(c => isNyseOrNasdaq(exchangeCache.get(c.buy.ticker)));
  log('step4', `After exchange filter: C1=${c1Filtered.length}, C2=${c2Filtered.length}`);

  // Pull price bars for each unique ticker needed + SPY
  const neededTickers = new Set(['SPY']);
  for (const c of [...c1Filtered, ...c2Filtered]) neededTickers.add(c.buy.ticker);

  const barsByTicker = new Map();
  for (const ticker of neededTickers) {
    try {
      const b = await getDailyBars(ticker, FORM4_START, PRICE_MAX);
      barsByTicker.set(ticker, b);
    } catch (e) {
      log('step4', `  bars fail ${ticker}: ${e.message}`);
      barsByTicker.set(ticker, { notFound: true, bars: [] });
    }
  }
  const spyBars = barsByTicker.get('SPY')?.bars || [];
  log('step4', `SPY bars: ${spyBars.length}`);

  // 5. Compute returns
  log('step5', 'Computing forward returns...');
  function returnsFor(sample) {
    const out = [];
    for (const c of sample) {
      const t = c.buy.ticker;
      const bars = barsByTicker.get(t)?.bars || [];
      if (!bars.length) continue;
      const entryDate = c.buy.transactions[0].txDate;
      const r = computeForwardReturns(bars, spyBars, entryDate);
      if (r.error) continue;
      for (const n of [30, 60, 90]) {
        if (r[`r${n}`]) {
          out.push({
            ticker: t,
            ownerName: c.buy.ownerName,
            role: c.match?.appt?.role,
            horizon: n,
            return: r[`r${n}`].return,
            excess: r[`r${n}`].excess,
          });
        }
      }
    }
    return out;
  }

  const c1Returns = returnsFor(c1Filtered);
  const c2Returns = returnsFor(c2Filtered);

  function bucket(rows, horizon) {
    return rows.filter(r => r.horizon === horizon);
  }

  const summary = {
    meta: {
      window: { form4Start: FORM4_START, form4End: FORM4_END, k8Start: K8_START, k8End: K8_END },
      sampleSizes: {
        form4Total: form4Buys.length,
        form4Clean: cleanBuys.length,
        pricedBuys: priced.length,
        appointmentsExtracted: appointments.length,
        cohort1Total: cohort1.length,
        cohort2Total: cohort2.length,
        cohort1Filtered: c1Filtered.length,
        cohort2Filtered: c2Filtered.length,
      },
    },
    cohort1: {
      30: summarize(bucket(c1Returns, 30)),
      60: summarize(bucket(c1Returns, 60)),
      90: summarize(bucket(c1Returns, 90)),
    },
    cohort2: {
      30: summarize(bucket(c2Returns, 30)),
      60: summarize(bucket(c2Returns, 60)),
      90: summarize(bucket(c2Returns, 90)),
    },
    tTests: {
      30: welchTTest(bucket(c1Returns, 30).map(r => r.excess), bucket(c2Returns, 30).map(r => r.excess)),
      60: welchTTest(bucket(c1Returns, 60).map(r => r.excess), bucket(c2Returns, 60).map(r => r.excess)),
      90: welchTTest(bucket(c1Returns, 90).map(r => r.excess), bucket(c2Returns, 90).map(r => r.excess)),
    },
    spotChecks: cohort1.slice(0, 10).map(c => ({
      ticker: c.buy.ticker,
      ownerName: c.buy.ownerName,
      officerTitle: c.buy.officerTitle,
      matchedName: c.match.appt.name,
      role: c.match.appt.role,
      confidence: c.match.match.confidence,
      tenureDays: c.match.tenureDays,
      effectiveDate: c.match.appt.effectiveDate,
      txDate: c.buy.transactions[0].txDate,
      txPrice: c.buy.transactions[0].price,
      txShares: c.buy.transactions[0].shares,
    })),
  };

  writeJson(path.join(OUT_DIR, 'sanity-results.json'), summary);
  writeJson(path.join(OUT_DIR, 'sanity-cohort1-raw.json'), cohort1);
  writeJson(path.join(OUT_DIR, 'sanity-cohort2-sample.json'), c2Filtered.map(c => c.buy));

  console.log('\n=== SANITY RESULTS ===');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nWrote: ${path.join(OUT_DIR, 'sanity-results.json')}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
