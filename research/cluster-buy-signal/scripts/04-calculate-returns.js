#!/usr/bin/env node
/**
 * 04-calculate-returns.js — merge filings + cohorts + prices into one
 * record per filing, with excess returns at 30/60/90 trading days.
 *
 * Output: data/returns.json — array of:
 *   {
 *     accessionNo, ticker, ownerCik, role, filingDate,
 *     buyValue, marketCap,
 *     cohort: { 3, 7, 14, 30 },
 *     composition: { 3, 7, 14, 30 },
 *     owner_involved: { 3, 7, 14, 30 },
 *     groupSize: { 3, 7, 14, 30 },
 *     ret30, spy30, exc30, ret60, spy60, exc60, ret90, spy90, exc90,
 *   }
 */

const fs = require('fs');
const path = require('path');
const { readJson, writeJson, ensureDir } = require('../lib/util');

const ROOT = path.resolve(__dirname, '..');
const FILINGS = path.join(ROOT, 'data', 'filings.json');
const COHORTS = path.join(ROOT, 'data', 'cohorts.json');
const PRICES = path.join(ROOT, 'data', 'prices.json');
const OUT_PATH = path.join(ROOT, 'data', 'returns.json');

const WINDOWS = [3, 7, 14, 30];
const FORCE = process.argv.includes('--force');

function main() {
  ensureDir(path.join(ROOT, 'data'));
  if (fs.existsSync(OUT_PATH) && !FORCE) {
    const cached = readJson(OUT_PATH);
    console.log(`[04-returns] Skipping — ${OUT_PATH} has ${cached?.length || 0} records (--force to rebuild)`);
    return;
  }

  const filings = readJson(FILINGS);
  const cohorts = readJson(COHORTS);
  const prices = readJson(PRICES);
  if (!filings || !cohorts || !prices) {
    throw new Error('Missing inputs — run 01/02/03 first');
  }
  console.log(`[04-returns] Inputs: ${filings.length} filings, ${Object.keys(prices).length} priced, cohorts for windows ${Object.keys(cohorts).join(',')}`);

  // Index cohorts by accession per window
  const cohortIdx = {};
  for (const N of WINDOWS) {
    cohortIdx[N] = new Map(cohorts[N].map(r => [r.accessionNo, r]));
  }

  const out = [];
  let dropMissingPrice = 0, dropMissingCohort = 0;
  for (const f of filings) {
    const px = prices[f.accessionNo];
    if (!px) { dropMissingPrice++; continue; }

    const cohort = {};
    const composition = {};
    const ownerInv = {};
    const groupSize = {};
    let missing = false;
    for (const N of WINDOWS) {
      const c = cohortIdx[N].get(f.accessionNo);
      if (!c) { missing = true; break; }
      cohort[N] = c.cohort;
      composition[N] = c.composition;
      ownerInv[N] = c.owner_involved;
      groupSize[N] = c.groupSize;
    }
    if (missing) { dropMissingCohort++; continue; }

    const entry = px.entry?.close;
    const spyEntry = px.spy_entry?.close;
    if (!entry || !spyEntry) { dropMissingPrice++; continue; }

    const rec = {
      accessionNo: f.accessionNo,
      ticker: f.ticker,
      ownerCik: f.ownerCik,
      ownerName: f.ownerName,
      role: f.role,
      filingDate: f.filingDate,
      buyValue: f.buyValue,
      marketCap: px.marketCap,
      cohort,
      composition,
      owner_involved: ownerInv,
      groupSize,
    };

    for (const n of [30, 60, 90]) {
      const exit = px[`d${n}`]?.close;
      const spyExit = px[`spy_d${n}`]?.close;
      if (exit && spyExit) {
        const r = exit / entry - 1;
        const s = spyExit / spyEntry - 1;
        rec[`ret${n}`] = r;
        rec[`spy${n}`] = s;
        rec[`exc${n}`] = r - s;
      } else {
        rec[`ret${n}`] = null;
        rec[`spy${n}`] = null;
        rec[`exc${n}`] = null;
      }
    }

    out.push(rec);
  }

  console.log(`[04-returns] Output: ${out.length} records`);
  console.log(`  drop missing prices : ${dropMissingPrice}`);
  console.log(`  drop missing cohort : ${dropMissingCohort}`);

  // Sanity: at each horizon, count how many have valid excess returns
  for (const n of [30, 60, 90]) {
    const valid = out.filter(r => r[`exc${n}`] != null && isFinite(r[`exc${n}`])).length;
    console.log(`  valid exc${n} : ${valid}/${out.length}`);
  }

  writeJson(OUT_PATH, out);
  console.log(`[04-returns] Wrote → ${OUT_PATH}`);
}

main();
