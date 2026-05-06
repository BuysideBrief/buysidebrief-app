#!/usr/bin/env node
/**
 * 02-assign-cohorts.js — for each window N in {3,7,14,30}, assign every
 * qualifying filing to a cohort (solo / paired / cluster / mega_cluster)
 * by counting distinct ownerCiks at the same ticker within ±N CALENDAR days
 * of the filing's transactionDate. Tags composition (officer_only,
 * director_only, mixed) and a non-exclusive owner_involved flag.
 *
 * HARD STOP: if cluster cohort at N=3 < 50 obs, exits non-zero so run-all.sh
 * does not proceed to the (expensive) price pull.
 *
 * Output:
 *   data/cohorts.json          — { N: [{ accessionNo, cohort, composition, owner_involved, groupSize }] }
 *   results/sanity-check.txt   — cohort sizes per window
 */

const fs = require('fs');
const path = require('path');
const { writeJson, readJson, ensureDir } = require('../lib/util');
const { OFFICER_BUCKETS } = require('../lib/role-bucket');

const ROOT = path.resolve(__dirname, '..');
const FILINGS = path.join(ROOT, 'data', 'filings.json');
const OUT_PATH = path.join(ROOT, 'data', 'cohorts.json');
const SANITY_PATH = path.join(ROOT, 'results', 'sanity-check.txt');

const WINDOWS = [3, 7, 14, 30];
const HARD_STOP_MIN_CLUSTER = 50;
const FORCE = process.argv.includes('--force');

function dateMs(s) { return new Date(s).getTime(); }

/**
 * For a single filing, return the set of distinct ownerCiks who filed a
 * qualifying P-buy at the same ticker within ±N days, INCLUDING the filing
 * itself.
 */
function distinctOwnersInWindow(filing, allByTicker, N) {
  const center = dateMs(filing.transactionDate);
  const windowMs = N * 86400000;
  const peers = allByTicker.get(filing.ticker) || [];
  const distinct = new Set();
  for (const p of peers) {
    const t = dateMs(p.transactionDate);
    if (Math.abs(t - center) <= windowMs) distinct.add(p.ownerCik);
  }
  return distinct;
}

/**
 * Same as distinctOwnersInWindow but returns full peer filings (one per CIK,
 * the closest-in-time one to the center).
 */
function peerFilingsInWindow(filing, allByTicker, N) {
  const center = dateMs(filing.transactionDate);
  const windowMs = N * 86400000;
  const peers = allByTicker.get(filing.ticker) || [];
  const byCik = new Map();
  for (const p of peers) {
    const t = dateMs(p.transactionDate);
    const dist = Math.abs(t - center);
    if (dist > windowMs) continue;
    const existing = byCik.get(p.ownerCik);
    if (!existing || dist < existing.__dist) {
      byCik.set(p.ownerCik, { ...p, __dist: dist });
    }
  }
  return [...byCik.values()];
}

function classifyCohort(distinctCount) {
  if (distinctCount <= 1) return 'solo';
  if (distinctCount === 2) return 'paired';
  if (distinctCount <= 4) return 'cluster';
  return 'mega_cluster';
}

function classifyComposition(peers) {
  const roles = peers.map(p => p.role);
  const allOfficer = roles.every(r => OFFICER_BUCKETS.has(r));
  const allDirector = roles.every(r => r === 'director');
  if (allOfficer) return 'officer_only';
  if (allDirector) return 'director_only';
  return 'mixed';
}

function main() {
  ensureDir(path.join(ROOT, 'data'));
  ensureDir(path.join(ROOT, 'results'));

  if (fs.existsSync(OUT_PATH) && !FORCE) {
    console.log(`[02-cohorts] Skipping — ${OUT_PATH} exists (pass --force to rebuild)`);
    // Still re-emit sanity-check so the user can eyeball
    const cached = readJson(OUT_PATH);
    if (cached) emitSanity(cached);
    return;
  }

  const filings = readJson(FILINGS);
  if (!filings) throw new Error(`Missing ${FILINGS} — run 01-fetch-filings.js first`);
  console.log(`[02-cohorts] Loaded ${filings.length} filings`);

  // Index by ticker (one-time cost)
  const byTicker = new Map();
  for (const f of filings) {
    if (!byTicker.has(f.ticker)) byTicker.set(f.ticker, []);
    byTicker.get(f.ticker).push(f);
  }
  console.log(`[02-cohorts] Indexed ${byTicker.size} tickers`);

  const out = {};
  for (const N of WINDOWS) {
    const records = [];
    for (const f of filings) {
      const peers = peerFilingsInWindow(f, byTicker, N);
      const distinctCount = new Set(peers.map(p => p.ownerCik)).size;
      const cohort = classifyCohort(distinctCount);
      let composition = null;
      let ownerInvolved = false;
      if (cohort !== 'solo') {
        composition = classifyComposition(peers);
        ownerInvolved = peers.some(p => p.isTenPercent || p.role === 'ten_percent_owner');
      }
      records.push({
        accessionNo: f.accessionNo,
        ticker: f.ticker,
        ownerCik: f.ownerCik,
        role: f.role,
        cohort,
        composition,
        owner_involved: ownerInvolved,
        groupSize: distinctCount,
      });
    }
    out[N] = records;
  }

  writeJson(OUT_PATH, out);
  console.log(`[02-cohorts] Wrote cohorts → ${OUT_PATH}`);

  emitSanity(out);

  // Hard-stop gate
  const clusterAt3 = out['3'].filter(r => r.cohort === 'cluster').length;
  if (clusterAt3 < HARD_STOP_MIN_CLUSTER) {
    const msg = `[02-cohorts] HARD STOP: cluster cohort at N=3 has only ${clusterAt3} obs (< ${HARD_STOP_MIN_CLUSTER}). Halting before price pull.`;
    console.error(msg);
    fs.appendFileSync(SANITY_PATH, `\nHARD-STOP: cluster@N=3 = ${clusterAt3} (< ${HARD_STOP_MIN_CLUSTER})\n`);
    process.exit(2);
  }
  console.log(`[02-cohorts] cluster@N=3 = ${clusterAt3} ≥ ${HARD_STOP_MIN_CLUSTER} — proceeding`);
}

function emitSanity(out) {
  const lines = [];
  lines.push(`Cluster Buy Signal Backtest — Cohort Sanity (run at ${new Date().toISOString()})`);
  lines.push('');
  for (const N of WINDOWS) {
    const records = out[N];
    const counts = { solo: 0, paired: 0, cluster: 0, mega_cluster: 0 };
    const compCounts = { officer_only: 0, director_only: 0, mixed: 0 };
    let ownerInvolved = 0;
    for (const r of records) {
      counts[r.cohort]++;
      if (r.composition) compCounts[r.composition]++;
      if (r.owner_involved) ownerInvolved++;
    }
    lines.push(`Window: ${N} days`);
    lines.push(`  solo:         ${counts.solo}`);
    lines.push(`  paired:       ${counts.paired}`);
    lines.push(`  cluster:      ${counts.cluster}`);
    lines.push(`  mega_cluster: ${counts.mega_cluster}`);
    lines.push(`  composition (paired+cluster+mega):`);
    lines.push(`    officer_only:  ${compCounts.officer_only}`);
    lines.push(`    director_only: ${compCounts.director_only}`);
    lines.push(`    mixed:         ${compCounts.mixed}`);
    lines.push(`    owner_involved (cross-cut): ${ownerInvolved}`);
    lines.push('');
  }
  fs.writeFileSync(SANITY_PATH, lines.join('\n'));
  console.log(`[02-cohorts] Wrote sanity-check → ${SANITY_PATH}`);
  for (const line of lines) console.log('  ' + line);
}

main();
