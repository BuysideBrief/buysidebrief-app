#!/usr/bin/env node
/**
 * FULL 12-MONTH BACKTEST: New Executive Buy Signal
 *
 * Window: 2025-04-16 → 2026-04-16 (Form 4 transactions)
 * 8-K lookback: 2024-10-18 → 2026-04-16 (180 days before Form 4 window start)
 *
 * Cohorts:
 *   1. New exec buy — Form 4 buyer appointed per 8-K Item 5.02 within prior 90 days
 *      - Variant A: "all matches"        (headline)
 *      - Variant B: "role-confirmed only" (robustness check, excludes role=Unknown / low-confidence)
 *      - Sub-buckets: tenure (0-30, 31-90, 91-180); role (CEO, CFO, other C-suite, Director)
 *   2. Placebo (stable C-suite) — C-suite buyer, NO 8-K 5.02 at this CIK in prior 180 days
 *   3. Baseline — all qualifying Form 4 P-buys
 *
 * Checkpointing: per-day JSON caches (cache/form4/, cache/8k/, cache/prices/).
 *   Re-runs skip already-pulled days. A crash mid-run can resume by re-invoking.
 *
 * Progress: appends to output/run-progress.log every 1,000 Form 4 records.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env.local') });

const path = require('path');
const fs = require('fs');
const { pullForm4Range } = require('./lib/edgar-form4');
const { pull8K502Range } = require('./lib/edgar-8k-502');
const { findBestApptMatch, matchNames } = require('./lib/name-match');
const { getDailyBars, isNyseOrNasdaq, loadUsListedUniverse } = require('./lib/prices');
const { computeForwardReturns } = require('./lib/returns');
const { summarize, welchTTest } = require('./lib/stats');
const { writeJson, ensureDir, makeProgress, appendLog } = require('./lib/util');

const OUT_DIR = path.join(__dirname, 'output');
const PROGRESS_LOG = path.join(OUT_DIR, 'run-progress.log');

const FORM4_START = process.env.RUN_START || '2025-04-16';
const FORM4_END = process.env.RUN_END || '2026-04-16';
// 180 days before Form 4 start (for placebo cohort 180-day lookback).
const K8_START = '2024-10-18';
const K8_END = FORM4_END;
// Forward returns extend ~90d past FORM4_END; cap at ~Jul 31, 2026.
const PRICE_MAX = '2026-07-31';

const C_SUITE_PATTERN = /chief\s+(executive|financial|operating|operations)\s+officer|president\b|\bCEO\b|\bCFO\b|\bCOO\b/i;

function log(label, msg) {
  console.log(`[${label}] ${msg}`);
}

function classifyRoleCategory(role, officerTitle, isDirector) {
  const r = (role || '').toLowerCase();
  const t = (officerTitle || '').toLowerCase();
  if (r === 'ceo' || /chief\s+executive/.test(t)) return 'CEO';
  if (r === 'cfo' || /chief\s+financial/.test(t)) return 'CFO';
  if (r === 'coo' || /chief\s+operating/.test(t)) return 'Other C-suite';
  if (r === 'president' || /\bpresident\b/.test(t)) return 'Other C-suite';
  if (r === 'other c-suite' || /\bchief\s+\w+\s+officer/.test(t)) return 'Other C-suite';
  if (r === 'director' || isDirector) return 'Director';
  return 'Unknown';
}

function tenureBucket(days) {
  if (days <= 30) return '0-30';
  if (days <= 90) return '31-90';
  if (days <= 180) return '91-180';
  return '>180';
}

async function main() {
  ensureDir(OUT_DIR);
  appendLog(PROGRESS_LOG, `=== FULL RUN START form4=${FORM4_START}..${FORM4_END} 8k=${K8_START}..${K8_END} ===`);
  console.log('\n=== NEW EXEC SIGNAL — FULL 12-MONTH RUN ===');
  console.log(`Form 4 window: ${FORM4_START} → ${FORM4_END}`);
  console.log(`8-K 5.02 window: ${K8_START} → ${K8_END}`);
  console.log(`Price window: up to ${PRICE_MAX}`);
  console.log(`API key: ${process.env.MASSIVE_API_KEY ? 'loaded' : 'MISSING'}\n`);

  // Step 0: preload ticker universe (one-time, ~5 Polygon calls)
  log('step0', 'Loading NYSE/Nasdaq ticker universe...');
  const universe = await loadUsListedUniverse();
  log('step0', `Universe: ${universe.size} tickers`);

  // Step 1: Form 4 pull with concurrency + progress
  log('step1', 'Pulling Form 4 P-transactions (concurrency=6)...');
  let totalProcessed = 0;
  let runningErrors = 0;
  const progressTick = makeProgress(PROGRESS_LOG, 1000);
  const form4Buys = await pullForm4Range(FORM4_START, FORM4_END, {
    concurrency: 6,
    onProgress: (n, info) => {
      totalProcessed += n;
      if (info?.errors != null) runningErrors = info.errors;
      progressTick(totalProcessed, { errors: runningErrors });
    },
  });
  log('step1', `Total Form 4 buy filings: ${form4Buys.length} (${runningErrors} errors)`);

  const cleanBuys = form4Buys.filter(f => !f.error && !f.__error && f.ticker && f.transactions?.length);
  const priced = cleanBuys.filter(f => f.transactions[0].price >= 2);
  const exchangeFiltered = priced.filter(f => universe.has(String(f.ticker).toUpperCase()));
  log('step1', `Clean: ${cleanBuys.length} | After $2 floor: ${priced.length} | After NYSE/Nasdaq: ${exchangeFiltered.length}`);
  appendLog(PROGRESS_LOG, `step1 done: form4=${form4Buys.length} clean=${cleanBuys.length} priced=${priced.length} filtered=${exchangeFiltered.length}`);

  // Step 2: 8-K 5.02 pull
  log('step2', 'Pulling 8-K Item 5.02 filings (concurrency=6)...');
  const appointments = await pull8K502Range(K8_START, K8_END, { concurrency: 6 });
  log('step2', `Total appointments extracted: ${appointments.length}`);
  appendLog(PROGRESS_LOG, `step2 done: appointments=${appointments.length}`);

  // Step 3: cohort classification
  log('step3', 'Classifying cohorts...');
  const apptByCik = new Map();
  for (const a of appointments) {
    if (!apptByCik.has(a.cik)) apptByCik.set(a.cik, []);
    apptByCik.get(a.cik).push(a);
  }

  const cohort1All = [];
  const cohort1RoleConfirmed = [];
  const cohort2 = [];
  const ambiguousMatches = [];

  for (const buy of exchangeFiltered) {
    const txDate = buy.transactions[0].txDate;
    const best = findBestApptMatch(buy, appointments);

    if (best && best.tenureDays <= 90) {
      const roleCat = classifyRoleCategory(best.appt.role, buy.officerTitle, buy.isDirector);
      const rec = {
        buy,
        match: best,
        roleCategory: roleCat,
        tenureBucketName: tenureBucket(best.tenureDays),
      };
      cohort1All.push(rec);
      if (roleCat !== 'Unknown' && best.match.confidence === 'high') {
        cohort1RoleConfirmed.push(rec);
      } else {
        ambiguousMatches.push({
          ticker: buy.ticker,
          issuerCik: buy.issuerCik,
          ownerName: buy.ownerName,
          officerTitle: buy.officerTitle,
          isDirector: buy.isDirector,
          matchedName: best.appt.name,
          matchedRole: best.appt.role,
          matchConfidence: best.match.confidence,
          tenureDays: best.tenureDays,
          txDate,
          effectiveDate: best.appt.effectiveDate,
          reason: roleCat === 'Unknown' ? 'role=Unknown' : `confidence=${best.match.confidence}`,
        });
      }
    }

    const isCsuite = buy.isOfficer && C_SUITE_PATTERN.test(buy.officerTitle || '');
    if (isCsuite) {
      const cikAppts = apptByCik.get(buy.issuerCik) || [];
      const within180 = cikAppts.some(a => {
        const gap = (new Date(txDate) - new Date(a.effectiveDate)) / 86400000;
        return gap >= 0 && gap <= 180;
      });
      if (!within180) cohort2.push({ buy });
    }
  }

  log('step3', `Cohort 1 (new exec, all): ${cohort1All.length}`);
  log('step3', `Cohort 1 (role-confirmed): ${cohort1RoleConfirmed.length}`);
  log('step3', `Cohort 2 (stable C-suite): ${cohort2.length}`);
  log('step3', `Cohort 3 (baseline): ${exchangeFiltered.length}`);
  log('step3', `Ambiguous match audit: ${ambiguousMatches.length}`);
  appendLog(PROGRESS_LOG, `step3 done: c1_all=${cohort1All.length} c1_rc=${cohort1RoleConfirmed.length} c2=${cohort2.length} c3=${exchangeFiltered.length} ambiguous=${ambiguousMatches.length}`);

  writeJson(path.join(OUT_DIR, 'ambiguous-matches.json'), ambiguousMatches);

  // Step 4: price pulls
  log('step4', 'Pulling price bars (Polygon 5 req/min, ~13s each)...');
  const neededTickers = new Set(['SPY']);
  for (const c of [...cohort1All, ...cohort2]) neededTickers.add(c.buy.ticker);
  // Cap cohort 3 sample to keep price pulls reasonable for baseline reporting
  const cohort3Sample = exchangeFiltered.length > 500
    ? exchangeFiltered.slice(0, 500)  // deterministic head — reproducible
    : exchangeFiltered;
  for (const c of cohort3Sample) neededTickers.add(c.ticker);
  log('step4', `Unique tickers needed: ${neededTickers.size}`);

  const barsByTicker = new Map();
  let priceProgress = 0;
  for (const ticker of neededTickers) {
    try {
      const b = await getDailyBars(ticker, FORM4_START, PRICE_MAX);
      barsByTicker.set(ticker, b);
    } catch (e) {
      barsByTicker.set(ticker, { notFound: true, bars: [] });
      appendLog(PROGRESS_LOG, `price-err ${ticker}: ${e.message}`);
    }
    priceProgress++;
    if (priceProgress % 50 === 0) {
      appendLog(PROGRESS_LOG, `prices: ${priceProgress}/${neededTickers.size}`);
    }
  }
  const spyBars = barsByTicker.get('SPY')?.bars || [];
  log('step4', `SPY bars: ${spyBars.length} | other tickers loaded: ${barsByTicker.size - 1}`);
  appendLog(PROGRESS_LOG, `step4 done: tickers=${barsByTicker.size} spyBars=${spyBars.length}`);

  // Step 5: forward returns
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
            officerTitle: c.buy.officerTitle,
            isDirector: c.buy.isDirector,
            roleCategory: c.roleCategory,
            tenureBucket: c.tenureBucketName,
            tenureDays: c.match?.tenureDays,
            confidence: c.match?.match?.confidence,
            txDate: entryDate,
            horizon: n,
            return: r[`r${n}`].return,
            excess: r[`r${n}`].excess,
          });
        }
      }
    }
    return out;
  }

  const c1AllRet = returnsFor(cohort1All);
  const c1RCRet = returnsFor(cohort1RoleConfirmed);
  const c2Ret = returnsFor(cohort2);
  const c3Ret = returnsFor(cohort3Sample.map(b => ({ buy: b })));

  function bucket(rows, horizon) { return rows.filter(r => r.horizon === horizon); }

  function cohortStats(rows) {
    return {
      30: summarize(bucket(rows, 30)),
      60: summarize(bucket(rows, 60)),
      90: summarize(bucket(rows, 90)),
    };
  }

  function subBucketStats(rows, key) {
    const out = {};
    const vals = new Set(rows.map(r => r[key]).filter(Boolean));
    for (const v of vals) {
      out[v] = cohortStats(rows.filter(r => r[key] === v));
    }
    return out;
  }

  const results = {
    meta: {
      generatedAt: new Date().toISOString(),
      windows: {
        form4: { start: FORM4_START, end: FORM4_END },
        k8: { start: K8_START, end: K8_END },
        priceMax: PRICE_MAX,
      },
      cohortDefinitions: {
        cohort1_all: 'Form 4 P-buy at issuer with 8-K 5.02 naming this person as appointee/promotion within prior 90 days (any match confidence, any role)',
        cohort1_roleConfirmed: 'Same as cohort1_all but restricted to role≠Unknown AND match confidence=high',
        cohort2: 'C-suite buyer (officer, title matches CEO/CFO/COO/President) with NO 8-K 5.02 at the same CIK in the prior 180 days',
        cohort3: 'All qualifying Form 4 P-buys (NYSE/Nasdaq, price ≥ $2) — baseline',
      },
      filters: {
        transactionCode: 'P (purchase, Acquired)',
        priceFloor: 2,
        exchanges: ['XNYS', 'XNAS', 'XASE'],
        universeSize: universe.size,
      },
      sampleSizes: {
        form4Total: form4Buys.length,
        form4Clean: cleanBuys.length,
        afterPriceFloor: priced.length,
        afterExchangeFilter: exchangeFiltered.length,
        appointmentsExtracted: appointments.length,
        cohort1_all: cohort1All.length,
        cohort1_roleConfirmed: cohort1RoleConfirmed.length,
        cohort2: cohort2.length,
        cohort3_sampled: cohort3Sample.length,
        cohort3_full: exchangeFiltered.length,
        ambiguousMatches: ambiguousMatches.length,
        form4Errors: runningErrors,
      },
    },
    cohort1_all: cohortStats(c1AllRet),
    cohort1_roleConfirmed: cohortStats(c1RCRet),
    cohort2: cohortStats(c2Ret),
    cohort3: cohortStats(c3Ret),
    subBuckets: {
      cohort1_byRole: subBucketStats(c1AllRet, 'roleCategory'),
      cohort1_byTenureBucket: subBucketStats(c1AllRet, 'tenureBucket'),
    },
    tTests: {
      cohort1_all_vs_cohort2: {
        30: welchTTest(bucket(c1AllRet, 30).map(r => r.excess), bucket(c2Ret, 30).map(r => r.excess)),
        60: welchTTest(bucket(c1AllRet, 60).map(r => r.excess), bucket(c2Ret, 60).map(r => r.excess)),
        90: welchTTest(bucket(c1AllRet, 90).map(r => r.excess), bucket(c2Ret, 90).map(r => r.excess)),
      },
      cohort1_roleConfirmed_vs_cohort2: {
        30: welchTTest(bucket(c1RCRet, 30).map(r => r.excess), bucket(c2Ret, 30).map(r => r.excess)),
        60: welchTTest(bucket(c1RCRet, 60).map(r => r.excess), bucket(c2Ret, 60).map(r => r.excess)),
        90: welchTTest(bucket(c1RCRet, 90).map(r => r.excess), bucket(c2Ret, 90).map(r => r.excess)),
      },
    },
    spotChecks: cohort1All.slice(0, 20).map(c => ({
      ticker: c.buy.ticker,
      ownerName: c.buy.ownerName,
      officerTitle: c.buy.officerTitle,
      roleCategory: c.roleCategory,
      matchedName: c.match.appt.name,
      matchedRole: c.match.appt.role,
      confidence: c.match.match.confidence,
      tenureDays: c.match.tenureDays,
      tenureBucket: c.tenureBucketName,
      effectiveDate: c.match.appt.effectiveDate,
      txDate: c.buy.transactions[0].txDate,
      txPrice: c.buy.transactions[0].price,
      txShares: c.buy.transactions[0].shares,
    })),
  };

  writeJson(path.join(OUT_DIR, 'results.json'), results);
  writeJson(path.join(OUT_DIR, 'cohort1-full.json'), cohort1All.map(c => ({
    ticker: c.buy.ticker,
    ownerName: c.buy.ownerName,
    officerTitle: c.buy.officerTitle,
    roleCategory: c.roleCategory,
    matchedName: c.match.appt.name,
    matchedRole: c.match.appt.role,
    confidence: c.match.match.confidence,
    tenureDays: c.match.tenureDays,
    txDate: c.buy.transactions[0].txDate,
    txPrice: c.buy.transactions[0].price,
  })));

  log('done', `Wrote output/results.json (${cohort1All.length} c1 / ${cohort2.length} c2 / ${exchangeFiltered.length} c3)`);
  appendLog(PROGRESS_LOG, `=== FULL RUN COMPLETE ===`);
}

main().catch(e => {
  console.error('FATAL', e);
  appendLog(PROGRESS_LOG, `FATAL ${e.message}`);
  process.exit(1);
});
