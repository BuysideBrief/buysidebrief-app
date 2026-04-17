#!/usr/bin/env node
/**
 * Audit the "form4Errors" count from the full run by re-fetching a sample
 * of Form 4 filings and classifying each result into one of 4 buckets:
 *   - ok_with_p    (parsed successfully, had P-transactions)
 *   - ok_no_p      (parsed successfully, no P-transactions — miscounted as "error" by the run)
 *   - http_error   (SEC returned non-2xx after retries)
 *   - other_error  (timeout, parse exception, etc.)
 *
 * Sampling: pick 4 non-weekend days across the year, re-run EFTS for each,
 * then fetch N random filings per day. Validates the inflation hypothesis
 * without re-running the whole pipeline.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env.local') });

const { searchForm4ForDate, parseForm4Xml } = require('./lib/edgar-form4');
const { fetchSec } = require('./lib/util');

const SAMPLE_DATES = ['2025-06-03', '2025-09-09', '2025-11-24', '2026-02-10'];
const PER_DAY = 25;

async function classifyOne(filing) {
  try {
    const xml = await fetchSec(filing.xmlUrl);
    const parsed = parseForm4Xml(xml, filing);
    if (parsed && parsed.transactions && parsed.transactions.length) {
      return { bucket: 'ok_with_p', ticker: parsed.ticker };
    }
    return { bucket: 'ok_no_p' };
  } catch (e) {
    const msg = e.message || String(e);
    const statusMatch = msg.match(/SEC (\d{3})/);
    if (statusMatch) return { bucket: 'http_error', status: statusMatch[1] };
    return { bucket: 'other_error', msg: msg.slice(0, 120) };
  }
}

function pickRandom(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}

async function main() {
  console.log(`\n=== FORM 4 ERROR CLASSIFICATION AUDIT ===`);
  console.log(`Sampling ${PER_DAY} filings each from: ${SAMPLE_DATES.join(', ')}\n`);

  const totals = { ok_with_p: 0, ok_no_p: 0, http_error: 0, other_error: 0 };
  const byStatus = {};
  const errorMessages = [];

  for (const date of SAMPLE_DATES) {
    console.log(`\n[${date}] searching EFTS...`);
    const filings = await searchForm4ForDate(date);
    console.log(`  total filings in EFTS: ${filings.length}`);
    const sample = pickRandom(filings, PER_DAY);
    console.log(`  sampling ${sample.length} at random...`);

    const local = { ok_with_p: 0, ok_no_p: 0, http_error: 0, other_error: 0 };
    for (const f of sample) {
      const r = await classifyOne(f);
      local[r.bucket]++;
      totals[r.bucket]++;
      if (r.bucket === 'http_error') {
        byStatus[r.status] = (byStatus[r.status] || 0) + 1;
      } else if (r.bucket === 'other_error') {
        errorMessages.push(r.msg);
      }
    }
    console.log(`  result: ${JSON.stringify(local)}`);
  }

  console.log(`\n=== TOTALS across ${SAMPLE_DATES.length} days × ${PER_DAY} = ${SAMPLE_DATES.length * PER_DAY} filings ===`);
  console.log(JSON.stringify(totals, null, 2));

  const total = Object.values(totals).reduce((a, b) => a + b, 0);
  const pctNoP = total ? (totals.ok_no_p / total * 100).toFixed(1) : 'n/a';
  const pctHttp = total ? (totals.http_error / total * 100).toFixed(1) : 'n/a';
  const pctOther = total ? (totals.other_error / total * 100).toFixed(1) : 'n/a';
  const pctWithP = total ? (totals.ok_with_p / total * 100).toFixed(1) : 'n/a';

  console.log(`\n"Error" bucket breakdown (what was being miscounted):`);
  console.log(`  ok_with_p  : ${pctWithP}%  (legit buys — went to cohort 1/2/3)`);
  console.log(`  ok_no_p    : ${pctNoP}%  (HTTP 200 + valid XML + no P-tx — wrongly labeled as errors)`);
  console.log(`  http_error : ${pctHttp}%  (real fetch failures after retries)`);
  console.log(`  other_error: ${pctOther}%  (timeout / parse throw)`);

  if (Object.keys(byStatus).length) {
    console.log(`\nHTTP status codes among real errors: ${JSON.stringify(byStatus)}`);
  }
  if (errorMessages.length) {
    console.log(`\nSample non-HTTP error messages:`);
    for (const m of errorMessages.slice(0, 5)) console.log(`  - ${m}`);
  }

  // Estimate what the full run's 54,413 count breaks into
  const nErrorBucket = totals.ok_no_p + totals.http_error + totals.other_error;
  if (nErrorBucket > 0) {
    const noPShare = totals.ok_no_p / nErrorBucket;
    const httpShare = totals.http_error / nErrorBucket;
    const otherShare = totals.other_error / nErrorBucket;
    const fullErrors = 54413;
    console.log(`\n=== EXTRAPOLATION to full-run "errors"=54,413 ===`);
    console.log(`  estimated non-P-tx (miscounted):    ${Math.round(fullErrors * noPShare).toLocaleString()} (${(noPShare * 100).toFixed(1)}%)`);
    console.log(`  estimated real HTTP errors:         ${Math.round(fullErrors * httpShare).toLocaleString()} (${(httpShare * 100).toFixed(1)}%)`);
    console.log(`  estimated other errors:             ${Math.round(fullErrors * otherShare).toLocaleString()} (${(otherShare * 100).toFixed(1)}%)`);
  }
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
