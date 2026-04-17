#!/usr/bin/env node
/**
 * Sanity test + sample-size gate for the Congressional Overlay Test.
 *
 * 1. Pull Form 4 P-buys for 2025-04-16 → 2025-04-29 (2 weeks)
 * 2. Pull House PTR filings from 2024FD.zip + 2025FD.zip, filter to filings
 *    where filingDate falls in a window wide enough to cover tx dates in
 *    [Jan 16, 2025 → Apr 29, 2025] (90-day lookback from form4 window)
 * 3. Parse each PTR PDF → build ticker-indexed trade list
 * 4. Classify each Form 4 buy: overlap / placebo / neither
 * 5. Report counts + project 12-month N + decision gate
 * 6. If gate passes, continue with universe + price + returns for end-to-end proof
 *
 * Writes sanity-check.json and sanity-results.json to output/.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env.local') });

const path = require('path');
const fs = require('fs');
const form4 = require('./lib/edgar-form4');
const houseFd = require('./lib/house-fd');
const ptrParser = require('./lib/house-ptr-parser');
const { classify, buildCongressIndex } = require('./lib/match');
const { normalize } = require('./lib/ticker-normalize');
const { loadUsListedUniverse, getDailyBars, isInUniverse } = require('./lib/prices');
const { computeForwardReturns } = require('./lib/returns');
const { summarize, welchTTest } = require('./lib/stats');
const { writeJson, ensureDir, runConcurrent, parseUsDate } = require('./lib/util');

const OUT = path.join(__dirname, 'output');
const FORM4_START = '2025-04-16';
const FORM4_END = '2025-04-29';
const PTR_LOOKBACK_FROM = '2025-01-16';  // 90d before FORM4_START

function log(label, msg) { console.log(`[${label}] ${msg}`); }

async function main() {
  ensureDir(OUT);
  console.log('\n=== CONGRESSIONAL OVERLAY — SANITY + SAMPLE-SIZE GATE ===');
  console.log(`Form 4 window: ${FORM4_START} → ${FORM4_END}`);
  console.log(`Congressional lookback: ${PTR_LOOKBACK_FROM} → ${FORM4_END}\n`);

  // Step 1: Form 4 buys
  log('step1', 'Pulling Form 4 P-buys...');
  const buys = await form4.pullRange(FORM4_START, FORM4_END, { concurrency: 6 });
  const clean = buys.filter(b => !b.error && !b.__error && b.ticker && b.transactions?.length);
  const priced = clean.filter(b => b.transactions[0].price >= 2);
  log('step1', `${buys.length} filings → ${clean.length} clean → ${priced.length} after $2 floor`);

  // Step 2: House PTR filings index (2024 + 2025 FDs)
  log('step2', 'Loading House PTR filing metadata (2024 + 2025)...');
  const allFilings = await houseFd.loadHousePtrsForYears([2024, 2025]);
  // Filter to filings whose filingDate is within our window + some lookback for late-filed tx.
  // Tx dates can be up to ~45d before filing. We want tx in [PTR_LOOKBACK_FROM, FORM4_END].
  // So filings filed in [PTR_LOOKBACK_FROM - 45d, FORM4_END + 45d] could have relevant tx.
  const lowerBound = '2024-12-01';  // conservative
  const upperBound = '2025-06-15';
  const relevantFilings = allFilings.filter(f => {
    const fd = parseUsDate(f.filingDate);
    return fd && fd >= lowerBound && fd <= upperBound;
  });
  log('step2', `${allFilings.length} total PTR filings → ${relevantFilings.length} in window [${lowerBound}, ${upperBound}]`);

  // Step 3: Parse each PTR PDF
  log('step3', `Downloading + parsing ${relevantFilings.length} PTR PDFs (concurrency=4)...`);
  const parseTasks = relevantFilings.map(f => async () => {
    const year = f.sourceYear;
    const parsed = await ptrParser.fetchAndParse(year, f.docId);
    return { filing: f, parsed };
  });
  let doneCount = 0;
  const parsedResults = await runConcurrent(parseTasks, 4, () => {
    doneCount++;
    if (doneCount % 50 === 0) process.stdout.write(`    ...${doneCount}/${relevantFilings.length}\r`);
  });
  console.log();

  // Collect congressional trades in our tx-date window
  const congressTrades = [];
  const pdfErrors = [];
  let rowsAllTypes = 0;
  let rowsInWindow = 0;
  for (const r of parsedResults) {
    if (!r || r.__error) { pdfErrors.push(r?.__error || 'unknown'); continue; }
    const { filing, parsed } = r;
    if (parsed.error) pdfErrors.push(parsed.error);
    for (const row of (parsed.rows || [])) {
      rowsAllTypes++;
      if (!row.txDate) continue;
      if (row.txDate < PTR_LOOKBACK_FROM || row.txDate > FORM4_END) continue;
      rowsInWindow++;
      congressTrades.push({
        ticker: row.ticker,
        txType: row.txType,
        txDate: row.txDate,
        notificationDate: row.notificationDate,
        ownerCode: row.ownerCode,
        amountMidpoint: row.amountMidpoint,
        chamber: 'House',
        filerLast: filing.last,
        filerFirst: filing.first,
        stateDst: filing.stateDst,
        filingDate: filing.filingDate,
        docId: filing.docId,
      });
    }
  }
  log('step3', `Parsed: ${rowsAllTypes} total rows, ${rowsInWindow} in tx window, ${pdfErrors.length} PDF errors`);

  // Purchases only, stocks only (assetType=ST already filtered by parser)
  const congressBuys = congressTrades.filter(t => t.txType === 'P');
  log('step3', `Congressional stock BUYS in window: ${congressBuys.length} (of ${congressTrades.length} total stock txs)`);

  // Step 4: Classify each Form 4 buy
  log('step4', 'Classifying Form 4 buys against congressional index...');
  const congressIdx = buildCongressIndex(congressTrades);
  console.log(`    congress index: ${congressIdx.size} unique tickers`);

  let cohortCounts = { overlap: 0, placebo: 0, neither: 0 };
  let directionCounts = { 'politician-first': 0, 'insider-first': 0, 'simultaneous': 0 };
  const windowBucketCounts = { '0-30': 0, '31-60': 0, '61-90': 0 };
  const overlapSamples = [];
  const classified = priced.map(b => {
    const c = classify(b, congressIdx);
    cohortCounts[c.cohort]++;
    if (c.cohort === 'overlap') {
      directionCounts[c.direction]++;
      windowBucketCounts[c.windowBucket] = (windowBucketCounts[c.windowBucket] || 0) + 1;
      if (overlapSamples.length < 12) overlapSamples.push({ form4: b, classification: c });
    }
    return { buy: b, c };
  });

  console.log();
  log('step4', `Cohorts: overlap=${cohortCounts.overlap} | placebo=${cohortCounts.placebo} | neither=${cohortCounts.neither}`);
  log('step4', `Direction: ${JSON.stringify(directionCounts)}`);
  log('step4', `Window bucket: ${JSON.stringify(windowBucketCounts)}`);

  if (overlapSamples.length) {
    console.log('\n--- Overlap spot-checks (up to 12) ---');
    for (const s of overlapSamples) {
      const b = s.form4;
      const c = s.classification;
      const nc = c.nearestCongress;
      console.log(`  ${b.ticker} | F4 ${b.transactions[0].txDate} ${b.ownerName} ${b.officerTitle || '(no title)'} → ${c.direction} (gap=${c.gapDays}d, bucket=${c.windowBucket}) | congress: ${nc.filerFirst} ${nc.filerLast} (${nc.stateDst}) ${nc.txType} ${nc.txDate} ${nc.ownerCode}`);
    }
  }

  // Step 5: Decision gate
  const weeks = 2;
  const projected12mo = Math.round(cohortCounts.overlap * (52 / weeks));
  let decision, expandedCohort = null;
  if (projected12mo >= 100) {
    decision = 'PROCEED — projected 12-month overlap N ≥ 100 clears the gate';
  } else if (projected12mo >= 50) {
    decision = 'EXPAND — projected 50-99, consider widening overlap window to 180d before full run';
  } else {
    decision = 'STOP — projected <50, too rare to power a headline comparison';
  }

  console.log('\n=== SAMPLE-SIZE DECISION GATE ===');
  console.log(`  2-week overlap count:           ${cohortCounts.overlap}`);
  console.log(`  Linear projection to 12 months: ${projected12mo}`);
  console.log(`  Decision:                       ${decision}`);

  const sanityCheck = {
    generatedAt: new Date().toISOString(),
    windows: { form4: { start: FORM4_START, end: FORM4_END }, ptrTxRange: { start: PTR_LOOKBACK_FROM, end: FORM4_END } },
    counts: {
      form4Filings: buys.length,
      form4Clean: clean.length,
      form4AfterPriceFloor: priced.length,
      housePtrFilingsTotal: allFilings.length,
      housePtrFilingsInWindow: relevantFilings.length,
      pdfParseErrors: pdfErrors.length,
      congressStockRowsTotal: rowsAllTypes,
      congressStockRowsInWindow: rowsInWindow,
      congressBuysInWindow: congressBuys.length,
      uniqueTickersInCongress: congressIdx.size,
    },
    cohorts: cohortCounts,
    direction: directionCounts,
    windowBucket: windowBucketCounts,
    decisionGate: {
      projected12moOverlap: projected12mo,
      decision,
    },
    spotChecks: overlapSamples.map(s => ({
      ticker: s.form4.ticker,
      form4Date: s.form4.transactions[0].txDate,
      form4Owner: s.form4.ownerName,
      form4Title: s.form4.officerTitle,
      direction: s.classification.direction,
      gapDays: s.classification.gapDays,
      windowBucket: s.classification.windowBucket,
      congressFiler: `${s.classification.nearestCongress.filerFirst} ${s.classification.nearestCongress.filerLast}`,
      congressState: s.classification.nearestCongress.stateDst,
      congressDate: s.classification.nearestCongress.txDate,
      congressOwner: s.classification.nearestCongress.ownerCode,
    })),
  };
  writeJson(path.join(OUT, 'sanity-check.json'), sanityCheck);
  console.log(`\nWrote ${path.join(OUT, 'sanity-check.json')}`);

  // If gate says STOP, don't spend time on prices.
  if (projected12mo < 50) {
    console.log('\nGate says STOP — skipping end-to-end price/return verification.');
    return;
  }

  // Step 6: End-to-end proof — universe + prices + returns on a tiny sample
  log('step6', 'End-to-end verification: universe + prices + returns on overlap + placebo samples...');
  const universe = await loadUsListedUniverse();
  const overlapBuys = classified.filter(c => c.c.cohort === 'overlap').map(c => c.buy).filter(b => isInUniverse(universe, b.ticker));
  const placeboBuys = classified.filter(c => c.c.cohort === 'placebo').map(c => c.buy).filter(b => isInUniverse(universe, b.ticker));
  // Cap sample sizes for price pulls (we're just verifying the pipeline, not the stats)
  const sampleOverlap = overlapBuys.slice(0, Math.min(10, overlapBuys.length));
  const samplePlacebo = placeboBuys.slice(0, Math.min(10, placeboBuys.length));
  const needTickers = new Set(['SPY']);
  for (const b of [...sampleOverlap, ...samplePlacebo]) needTickers.add(b.ticker);
  log('step6', `${needTickers.size} unique tickers to price-pull (capped sample)...`);

  const barsByTicker = new Map();
  for (const t of needTickers) {
    try { barsByTicker.set(t, await getDailyBars(t, FORM4_START, '2025-08-31')); }
    catch (e) { barsByTicker.set(t, { notFound: true, bars: [] }); }
  }
  const spyBars = barsByTicker.get('SPY')?.bars || [];
  log('step6', `SPY bars: ${spyBars.length}`);

  function returnsFor(sample) {
    const out = [];
    for (const b of sample) {
      const bars = barsByTicker.get(b.ticker)?.bars || [];
      if (!bars.length) continue;
      const r = computeForwardReturns(bars, spyBars, b.transactions[0].txDate);
      if (r.error) continue;
      for (const n of [30, 60, 90]) if (r[`r${n}`]) out.push({ ticker: b.ticker, horizon: n, return: r[`r${n}`].return, excess: r[`r${n}`].excess });
    }
    return out;
  }
  const overlapRet = returnsFor(sampleOverlap);
  const placeboRet = returnsFor(samplePlacebo);
  function bucket(rows, h) { return rows.filter(r => r.horizon === h); }

  const preview = {
    note: 'End-to-end verification on a CAPPED sample. NOT representative of final stats — the full-run stats come from run-full.js.',
    sampleSizes: { overlap: sampleOverlap.length, placebo: samplePlacebo.length },
    overlap: { 30: summarize(bucket(overlapRet, 30)), 60: summarize(bucket(overlapRet, 60)), 90: summarize(bucket(overlapRet, 90)) },
    placebo: { 30: summarize(bucket(placeboRet, 30)), 60: summarize(bucket(placeboRet, 60)), 90: summarize(bucket(placeboRet, 90)) },
  };
  writeJson(path.join(OUT, 'sanity-results.json'), preview);
  console.log('\n=== END-TO-END PREVIEW (capped sample) ===');
  console.log(JSON.stringify(preview, null, 2));
  console.log(`\nWrote ${path.join(OUT, 'sanity-results.json')}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
