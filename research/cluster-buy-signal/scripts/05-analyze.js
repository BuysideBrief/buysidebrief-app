#!/usr/bin/env node
/**
 * 05-analyze.js — bucketed cluster vs. solo analysis with t-tests, plus a
 * mechanical decision recommendation per the pre-registered rules.
 *
 * Output:
 *   results/results.json         — structured results for downstream rendering
 *   results/cohort-assignments.csv — flat per-filing dump for spot-checking
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, ensureDir } = require('../lib/util');
const { mean, median, welchTTest, summarize, olsRegression } = require('../lib/stats');

const ROOT = path.resolve(__dirname, '..');
const RETURNS = path.join(ROOT, 'data', 'returns.json');
const RESULTS = path.join(ROOT, 'results', 'results.json');
const CSV_PATH = path.join(ROOT, 'results', 'cohort-assignments.csv');

const WINDOWS = [3, 7, 14, 30];
const HORIZONS = [30, 60, 90];
const PRODUCTION_WINDOW = 7;
const MIN_OBS_PER_BUCKET = 10;
const MIN_OBS_PER_COHORT_FOR_TTEST = 30;

const MARKET_CAP_BUCKETS = [
  ['micro', 0, 300_000_000],
  ['small', 300_000_000, 2_000_000_000],
  ['mid', 2_000_000_000, 10_000_000_000],
  ['large', 10_000_000_000, Infinity],
];

const BUY_VALUE_BUCKETS = [
  ['small', 10_000, 100_000],
  ['medium', 100_000, 500_000],
  ['large', 500_000, 2_000_000],
  ['mega', 2_000_000, Infinity],
];

function bucketize(value, table) {
  if (value == null || !isFinite(value)) return 'unknown';
  for (const [label, lo, hi] of table) {
    if (value >= lo && value < hi) return label;
  }
  return 'unknown';
}

function naiveCompare(records, N) {
  const result = {};
  const cohorts = ['solo', 'paired', 'cluster', 'mega_cluster'];
  for (const horizon of HORIZONS) {
    const byCohort = {};
    for (const c of cohorts) {
      const vals = records.filter(r => r.cohort[N] === c).map(r => r[`exc${horizon}`]).filter(x => x != null && isFinite(x));
      byCohort[c] = summarize(vals);
    }
    const ttests = {};
    const soloVals = records.filter(r => r.cohort[N] === 'solo').map(r => r[`exc${horizon}`]).filter(x => x != null && isFinite(x));
    for (const c of ['paired', 'cluster', 'mega_cluster']) {
      const vals = records.filter(r => r.cohort[N] === c).map(r => r[`exc${horizon}`]).filter(x => x != null && isFinite(x));
      ttests[`${c}_vs_solo`] = welchTTest(vals, soloVals);
    }
    result[`d${horizon}`] = { byCohort, ttests };
  }
  return result;
}

function bucketedCompare(records, N) {
  const cells = {};
  const out = {};
  for (const horizon of HORIZONS) {
    const byCell = [];
    let aggregateClusterVals = [];
    let aggregateSoloVals = [];
    for (const [mcLabel] of MARKET_CAP_BUCKETS) {
      for (const [bvLabel] of BUY_VALUE_BUCKETS) {
        const inCell = records.filter(r => bucketize(r.marketCap, MARKET_CAP_BUCKETS) === mcLabel && bucketize(r.buyValue, BUY_VALUE_BUCKETS) === bvLabel);
        const solo = inCell.filter(r => r.cohort[N] === 'solo').map(r => r[`exc${horizon}`]).filter(x => x != null && isFinite(x));
        const cluster = inCell.filter(r => r.cohort[N] === 'cluster' || r.cohort[N] === 'mega_cluster').map(r => r[`exc${horizon}`]).filter(x => x != null && isFinite(x));
        const cell = {
          marketCap: mcLabel,
          buyValue: bvLabel,
          n_solo: solo.length,
          n_cluster: cluster.length,
          mean_solo: mean(solo),
          mean_cluster: mean(cluster),
          spread: cluster.length && solo.length ? mean(cluster) - mean(solo) : null,
        };
        if (solo.length >= MIN_OBS_PER_BUCKET && cluster.length >= MIN_OBS_PER_BUCKET) {
          cell.ttest = welchTTest(cluster, solo);
          aggregateClusterVals.push(...cluster);
          aggregateSoloVals.push(...solo);
        }
        byCell.push(cell);
      }
    }
    // Pooled bucketed estimate: mean of within-cell spreads, weighted by min(n_solo, n_cluster)
    const usable = byCell.filter(c => c.ttest);
    let weightedSpread = null, totalWeight = 0;
    for (const c of usable) {
      const w = Math.min(c.n_solo, c.n_cluster);
      weightedSpread = (weightedSpread || 0) + c.spread * w;
      totalWeight += w;
    }
    if (totalWeight) weightedSpread /= totalWeight;
    out[`d${horizon}`] = {
      cells: byCell,
      usableCells: usable.length,
      weightedSpread,
      pooledTTest: aggregateClusterVals.length && aggregateSoloVals.length
        ? welchTTest(aggregateClusterVals, aggregateSoloVals)
        : { reason: 'no-pooled-sample' },
    };
  }
  return out;
}

function compositionBreakdown(records, N) {
  const out = {};
  for (const horizon of HORIZONS) {
    const inCohort = records.filter(r => r.cohort[N] === 'cluster' || r.cohort[N] === 'mega_cluster');
    const byComposition = {};
    for (const comp of ['officer_only', 'director_only', 'mixed']) {
      const vals = inCohort.filter(r => r.composition[N] === comp).map(r => r[`exc${horizon}`]).filter(x => x != null && isFinite(x));
      byComposition[comp] = summarize(vals);
    }
    const ownerInvolved = inCohort.filter(r => r.owner_involved[N]).map(r => r[`exc${horizon}`]).filter(x => x != null && isFinite(x));
    const ownerNot = inCohort.filter(r => !r.owner_involved[N]).map(r => r[`exc${horizon}`]).filter(x => x != null && isFinite(x));
    out[`d${horizon}`] = {
      byComposition,
      ownerInvolved: summarize(ownerInvolved),
      ownerNotInvolved: summarize(ownerNot),
      ownerTTest: welchTTest(ownerInvolved, ownerNot),
    };
  }
  return out;
}

function regressionFallback(records, N) {
  const rows = records.filter(r => r.exc90 != null && isFinite(r.exc90) && r.marketCap > 0 && r.buyValue > 0);
  if (rows.length < 50) return { reason: 'insufficient-data', n: rows.length };
  const X = [];
  const y = [];
  for (const r of rows) {
    const isPaired = r.cohort[N] === 'paired' ? 1 : 0;
    const isCluster = r.cohort[N] === 'cluster' ? 1 : 0;
    const isMega = r.cohort[N] === 'mega_cluster' ? 1 : 0;
    const microDummy = r.marketCap < 300_000_000 ? 1 : 0;
    const logMcap = Math.log(r.marketCap);
    const logBv = Math.log(r.buyValue);
    X.push([isPaired, isCluster, isMega, logMcap, logBv, microDummy]);
    y.push(r.exc90);
  }
  return olsRegression(X, y, ['paired', 'cluster', 'mega_cluster', 'log_marketCap', 'log_buyValue', 'micro_cap']);
}

function decideAction(perWindow) {
  // Primary criterion: bucketed cluster vs solo at production window, 90d
  const prod = perWindow[PRODUCTION_WINDOW];
  const prodBucketed90 = prod.bucketed.d90;
  const spread = prodBucketed90.weightedSpread;
  const p = prodBucketed90.pooledTTest?.p;

  let baseAction;
  if (spread == null) baseAction = { action: 'inconclusive', reason: 'no-usable-buckets' };
  else if (p != null && p < 0.05 && spread >= 0.05) baseAction = { action: 'increase_weights', reason: `bucketed spread ${(spread * 100).toFixed(2)}pp at p=${p.toFixed(4)} ≥ +5pp threshold` };
  else if (p != null && p < 0.05 && spread >= 0.03) baseAction = { action: 'keep_weights', reason: `bucketed spread ${(spread * 100).toFixed(2)}pp at p=${p.toFixed(4)} validates current weighting` };
  else if (spread < 0.01 || p == null || p >= 0.05) baseAction = { action: 'reduce_or_kill', reason: `bucketed spread ${(spread * 100).toFixed(2)}pp${p != null ? ` at p=${p.toFixed(4)}` : ''} below validation threshold` };
  else baseAction = { action: 'keep_weights_marginal', reason: `bucketed spread ${(spread * 100).toFixed(2)}pp${p != null ? ` p=${p.toFixed(4)}` : ''} — marginal` };

  // Window switch check: if any other N has materially better spread (>=2pp larger)
  let switchTo = null;
  let bestExtra = 0;
  for (const N of WINDOWS) {
    if (N === PRODUCTION_WINDOW) continue;
    const altSpread = perWindow[N].bucketed.d90.weightedSpread;
    if (altSpread != null && spread != null && altSpread - spread >= 0.02 && altSpread - spread > bestExtra) {
      bestExtra = altSpread - spread;
      switchTo = N;
    }
  }
  if (switchTo) {
    baseAction.recommend_window_switch = {
      from: PRODUCTION_WINDOW,
      to: switchTo,
      improvement: `${(bestExtra * 100).toFixed(2)}pp better at d90`,
    };
  }
  return baseAction;
}

function writeCsv(records) {
  const headers = [
    'accessionNo', 'ticker', 'ownerCik', 'ownerName', 'role', 'filingDate',
    'buyValue', 'marketCap',
    'cohort_3', 'cohort_7', 'cohort_14', 'cohort_30',
    'composition_3', 'composition_7', 'composition_14', 'composition_30',
    'owner_involved_3', 'owner_involved_7', 'owner_involved_14', 'owner_involved_30',
    'groupSize_3', 'groupSize_7', 'groupSize_14', 'groupSize_30',
    'exc30', 'exc60', 'exc90',
  ];
  const lines = [headers.join(',')];
  for (const r of records) {
    const row = [
      r.accessionNo, r.ticker, r.ownerCik, csvSafe(r.ownerName), r.role, r.filingDate,
      r.buyValue, r.marketCap ?? '',
      r.cohort[3], r.cohort[7], r.cohort[14], r.cohort[30],
      r.composition[3] || '', r.composition[7] || '', r.composition[14] || '', r.composition[30] || '',
      r.owner_involved[3], r.owner_involved[7], r.owner_involved[14], r.owner_involved[30],
      r.groupSize[3], r.groupSize[7], r.groupSize[14], r.groupSize[30],
      r.exc30 ?? '', r.exc60 ?? '', r.exc90 ?? '',
    ];
    lines.push(row.join(','));
  }
  fs.writeFileSync(CSV_PATH, lines.join('\n'));
  console.log(`[05-analyze] Wrote CSV → ${CSV_PATH}`);
}

function csvSafe(s) {
  if (s == null) return '';
  const str = String(s).replace(/"/g, '""');
  return /[,"\n]/.test(str) ? `"${str}"` : str;
}

function main() {
  ensureDir(path.join(ROOT, 'results'));
  const records = readJson(RETURNS);
  if (!records) throw new Error(`Missing ${RETURNS}`);
  console.log(`[05-analyze] ${records.length} records`);

  const perWindow = {};
  for (const N of WINDOWS) {
    console.log(`[05-analyze] Window N=${N}...`);
    const naive = naiveCompare(records, N);
    const bucketed = bucketedCompare(records, N);
    const composition = compositionBreakdown(records, N);
    const regression = regressionFallback(records, N);
    perWindow[N] = { naive, bucketed, composition, regression };
  }

  const recommendation = decideAction(perWindow);

  // Top-level summary for quick scanning
  const summary = {};
  for (const N of WINDOWS) {
    const cohortCounts = { solo: 0, paired: 0, cluster: 0, mega_cluster: 0 };
    for (const r of records) cohortCounts[r.cohort[N]]++;
    summary[N] = {
      cohortCounts,
      naive_d90_cluster_vs_solo_meanDiff: perWindow[N].naive.d90.ttests.cluster_vs_solo.meanDiff,
      naive_d90_cluster_vs_solo_p: perWindow[N].naive.d90.ttests.cluster_vs_solo.p,
      bucketed_d90_weightedSpread: perWindow[N].bucketed.d90.weightedSpread,
      bucketed_d90_usableCells: perWindow[N].bucketed.d90.usableCells,
      bucketed_d90_pooled_p: perWindow[N].bucketed.d90.pooledTTest?.p ?? null,
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    nRecords: records.length,
    windows: WINDOWS,
    horizons: HORIZONS,
    productionWindow: PRODUCTION_WINDOW,
    minObsPerBucket: MIN_OBS_PER_BUCKET,
    summary,
    perWindow,
    recommendation,
  };

  writeJson(RESULTS, out);
  console.log(`[05-analyze] Wrote results → ${RESULTS}`);
  console.log(`[05-analyze] Recommendation: ${recommendation.action} — ${recommendation.reason}`);
  if (recommendation.recommend_window_switch) {
    console.log(`  window switch: N=${recommendation.recommend_window_switch.from} → N=${recommendation.recommend_window_switch.to} (${recommendation.recommend_window_switch.improvement})`);
  }

  writeCsv(records);
}

main();
