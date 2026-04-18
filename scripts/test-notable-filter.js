#!/usr/bin/env node
/**
 * Notable-filter assertion script. Plain-Node — no test framework, matching
 * the project's existing test-fetch.js pattern.
 *
 * Run:  node scripts/test-notable-filter.js
 * Exit 0 on all pass; exit 1 on any failure.
 *
 * Covers the 7 cases from the spec:
 *   1. Small-cap → NOT notable
 *   2. Buy value below $100K → NOT notable
 *   3. Entity buyer at large-cap → NOT notable
 *   4. Grant/award at large-cap (no buys) → NOT notable (defensive)
 *   5. Open-market purchase ≥ $100K at ≥ $2B, individual, below-feature → IS notable
 *   6. Notable entries never touch picks:index (key-namespace isolation)
 *   7. Scorecard win-rate calculation doesn't include notable entries
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env.local') });

const { isNotable, buildNotableRecord } = require('../lib/notable');

let passed = 0;
let failed = 0;
const failures = [];

function assert(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Minimal mock filing matching the shape produced by lib/signal-scorer.js
// + the marketCap attached in step 3f of fetch-and-send.js (value in millions).
function mockScoredFiling(overrides = {}) {
  return {
    ticker: 'NKE',
    issuerName: 'NIKE Inc',
    issuerCik: '0000320187',
    ownerName: 'SMITH JANE',
    ownerCik: '0001234567',
    officerTitle: 'Director',
    isDirector: true,
    isOfficer: false,
    isTenPercentOwner: false,
    score: 30,            // mention tier (< 50 feature cutoff)
    tier: 'mention',
    summary: {
      totalBuyValue: 500_000,
      totalBuyShares: 5_000,
      buyCount: 1,
      totalSellValue: 0,
      sellCount: 0,
    },
    marketCap: 180_000,   // $180B in millions (Nike)
    sector: 'Consumer',
    filedAt: '2026-04-14',
    accessionNumber: '0000000000-26-000001',
    ...overrides,
  };
}

console.log('\n=== notable-filter assertions ===\n');

// ───────── Case 1: small-cap
console.log('[1] Small-cap → NOT notable');
{
  const f = mockScoredFiling({ marketCap: 500 }); // $500M = small-cap
  const r = isNotable(f);
  assert('small-cap ($500M) rejected', !r.qualified, `reason=${r.reason}`);
  assert('reason is below-market-cap', r.reason === 'below-market-cap', r.reason);
}

// ───────── Case 2: below-buy-value
console.log('\n[2] Buy value below $100K → NOT notable');
{
  const f = mockScoredFiling({ summary: { ...mockScoredFiling().summary, totalBuyValue: 50_000 } });
  const r = isNotable(f);
  assert('$50K buy rejected', !r.qualified);
  assert('reason is below-buy-value', r.reason === 'below-buy-value', r.reason);
}

// ───────── Case 3: entity buyer at large-cap
console.log('\n[3] Entity buyer at large-cap → NOT notable');
{
  const f = mockScoredFiling({ ownerName: 'Kennedy Lewis Investment Holdings II LLC' });
  const r = isNotable(f);
  assert('LLC entity rejected despite large-cap + $500K buy', !r.qualified);
  assert('reason is entity-buyer', r.reason === 'entity-buyer', r.reason);
}
{
  const f = mockScoredFiling({ ownerName: 'Vanguard Group Inc' });
  const r = isNotable(f);
  assert('"Group Inc" entity rejected', !r.qualified);
  assert('reason is entity-buyer', r.reason === 'entity-buyer', r.reason);
}

// ───────── Case 4: grant/award at large-cap (defensive — upstream should already reject)
console.log('\n[4] Grant/award at large-cap (zero buys) → NOT notable (defensive)');
{
  // Mirror the shape of the $LW grant-only filing we saw in the scorecard audit.
  const f = mockScoredFiling({
    score: -20,
    tier: 'skip',
    summary: { totalBuyValue: 0, totalBuyShares: 0, buyCount: 0, totalSellValue: 0, sellCount: 0 },
  });
  const r = isNotable(f);
  assert('zero-buy grant-only rejected', !r.qualified);
  assert('reason is no-buys', r.reason === 'no-buys', r.reason);
}

// ───────── Case 5: the happy path
console.log('\n[5] Open-market ≥$100K at ≥$2B, individual, below-feature → IS notable');
{
  const f = mockScoredFiling();  // defaults = happy path
  const r = isNotable(f);
  assert('happy path qualifies', r.qualified, `reason=${r.reason}`);
  assert('reason is qualified', r.reason === 'qualified', r.reason);
}
{
  // Edge: exactly at the floor
  const f = mockScoredFiling({
    summary: { totalBuyValue: 100_000, totalBuyShares: 1_000, buyCount: 1, totalSellValue: 0, sellCount: 0 },
    marketCap: 2000,
  });
  const r = isNotable(f);
  assert('exactly at $100K / $2B floor qualifies', r.qualified, `reason=${r.reason}`);
}
{
  // Edge: 1 cent below floor
  const f = mockScoredFiling({ marketCap: 1999 });
  const r = isNotable(f);
  assert('$1.999B rejected (just below $2B)', !r.qualified, `reason=${r.reason}`);
}
{
  // Edge: score exactly at feature cutoff → NOT notable
  const f = mockScoredFiling({ score: 50 });
  const r = isNotable(f);
  assert('score=50 (feature boundary) rejected', !r.qualified, `reason=${r.reason}`);
  assert('reason is made-feature-tier', r.reason === 'made-feature-tier', r.reason);
}
{
  // Edge: score 49 — still eligible
  const f = mockScoredFiling({ score: 49 });
  const r = isNotable(f);
  assert('score=49 qualifies', r.qualified, `reason=${r.reason}`);
}

// ───────── Case 6: namespace isolation (the record's key must start with `notable:filing:`, never `pick:` or `filing:`)
console.log('\n[6] Notable records live in the notable:* namespace (no picks:/filing: leakage)');
{
  const rec = buildNotableRecord(mockScoredFiling(), '2026-04-14');
  assert('key starts with notable:filing:', rec.key.startsWith('notable:filing:'), rec.key);
  assert('key does NOT start with pick:', !rec.key.startsWith('pick:'), rec.key);
  assert('key does NOT start with filing:', !/^filing:/.test(rec.key), rec.key);
  assert('date present in record', rec.date === '2026-04-14');
  assert('buyValue copied through', rec.buyValue === 500_000);
}

// ───────── Case 7: scorecard win-rate math uses picks:index only — verified by source inspection.
// This assertion confirms the contract: no code path in lib/notable.js writes to picks:index.
console.log('\n[7] lib/notable.js never writes to picks:index (scorecard win-rate safety)');
{
  // Strip block comments so we're scanning executable code, not doc-comment warnings.
  const rawSrc = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'notable.js'), 'utf8');
  const codeSrc = rawSrc
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/.*$/gm, '');           // line comments

  // The dangerous ops are any Redis write whose key matches pick*: — zadd, set, sadd, hset, hmset, etc.
  const pickWriteRe = /\.(set|zadd|sadd|hset|hmset|rpush|lpush|xadd)\s*\(\s*[`'"]picks?:/i;
  const hitsPickWrite = pickWriteRe.test(codeSrc);
  assert('notable.js never writes to pick: / picks: keys', !hitsPickWrite, 'found Redis write to pick(s):* key');

  // And the mirror: performance-tracker must not read the notable namespace.
  const ptRaw = require('fs').readFileSync(path.join(__dirname, '..', 'lib', 'performance-tracker.js'), 'utf8');
  const ptCode = ptRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert('performance-tracker.js never references notable:* in code', !ptCode.includes('notable:'), 'found notable: reference in code');
}

// ───────── Done
console.log(`\n─────────────`);
console.log(`passed: ${passed}`);
console.log(`failed: ${failed}`);
if (failed) {
  console.log('\nFAILURES:');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('\nAll notable-filter assertions passed.');
