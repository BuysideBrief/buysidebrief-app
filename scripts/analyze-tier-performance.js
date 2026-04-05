#!/usr/bin/env node
/**
 * Cross-tabulates pick performance by tier and price bucket.
 * Writes results to output/tier-price-matrix.json, Redis meta:tier-performance, and console.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getRedis } = require('../lib/redis');

const PRICE_BUCKETS = [
  { key: 'micro', label: '$0.01–$5', min: 0.01, max: 5 },
  { key: 'small', label: '$5.01–$20', min: 5.01, max: 20 },
  { key: 'mid', label: '$20.01–$50', min: 20.01, max: 50 },
  { key: 'large', label: '$50.01+', min: 50.01, max: Infinity },
];

const MAIN_TIERS = ['strong_signal', 'top_pick', 'feature'];
const ALL_TIERS = [...MAIN_TIERS, 'mention'];

function assignBucket(price) {
  for (const b of PRICE_BUCKETS) {
    if (price >= b.min && price <= b.max) return b.key;
  }
  return null;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcStats(picks) {
  if (!picks.length) return { count: 0, winRate: 0, avgReturn: 0, medianReturn: 0 };
  const returns = picks.map(p => p.return30d);
  const wins = returns.filter(r => r > 0).length;
  return {
    count: picks.length,
    winRate: Math.round((wins / picks.length) * 10000) / 100,
    avgReturn: Math.round(returns.reduce((s, r) => s + r, 0) / returns.length * 100) / 100,
    medianReturn: Math.round(median(returns) * 100) / 100,
  };
}

async function main() {
  const kv = getRedis();
  if (!kv) { console.error('Redis not available'); process.exit(1); }

  // 1. Load all pick IDs
  console.log('Loading picks:index...');
  const pickIds = await kv.zrange('picks:index', 0, -1);
  console.log(`Found ${pickIds.length} pick IDs`);

  // 2. Pipeline-fetch all pick records
  console.log('Fetching pick records via pipeline...');
  const BATCH = 100;
  const allPicks = [];
  for (let i = 0; i < pickIds.length; i += BATCH) {
    const batch = pickIds.slice(i, i + BATCH);
    const pipe = kv.pipeline();
    for (const id of batch) pipe.get(id);
    const results = await pipe.exec();
    for (const r of results) {
      if (r) allPicks.push(r);
    }
    if (i % 500 === 0 && i > 0) console.log(`  ...loaded ${i}/${pickIds.length}`);
  }
  console.log(`Loaded ${allPicks.length} pick records`);

  // 3. Filter to picks with valid return30d and entryPrice
  const valid = allPicks.filter(p => {
    const ret = parseFloat(p.return30d);
    const price = parseFloat(p.entryPrice);
    return !isNaN(ret) && !isNaN(price) && price > 0;
  }).map(p => ({
    ...p,
    return30d: parseFloat(p.return30d),
    entryPrice: parseFloat(p.entryPrice),
  }));
  console.log(`${valid.length} picks have valid return30d + entryPrice`);

  // 4. Assign price buckets
  for (const p of valid) {
    p.priceBucket = assignBucket(p.entryPrice);
  }
  const bucketed = valid.filter(p => p.priceBucket);

  // 5. Build 2D matrix: tier × price_bucket
  const matrix = {};
  const tierTotals = {};
  const bucketTotals = {};

  for (const tier of ALL_TIERS) {
    matrix[tier] = {};
    for (const b of PRICE_BUCKETS) {
      matrix[tier][b.key] = [];
    }
    tierTotals[tier] = [];
  }
  for (const b of PRICE_BUCKETS) {
    bucketTotals[b.key] = [];
  }
  const grandTotal = [];

  for (const p of bucketed) {
    const tier = ALL_TIERS.includes(p.tier) ? p.tier : null;
    if (!tier) continue;
    matrix[tier][p.priceBucket].push(p);
    tierTotals[tier].push(p);
    bucketTotals[p.priceBucket].push(p);
    grandTotal.push(p);
  }

  // 6. Calculate stats for each cell
  const result = {
    generatedAt: new Date().toISOString(),
    totalPicks: bucketed.length,
    matrix: {},
    tierTotals: {},
    bucketTotals: {},
    grandTotal: calcStats(grandTotal),
  };

  for (const tier of ALL_TIERS) {
    result.matrix[tier] = {};
    for (const b of PRICE_BUCKETS) {
      result.matrix[tier][b.key] = calcStats(matrix[tier][b.key]);
    }
    result.tierTotals[tier] = calcStats(tierTotals[tier]);
  }
  for (const b of PRICE_BUCKETS) {
    result.bucketTotals[b.key] = calcStats(bucketTotals[b.key]);
  }

  // 7a. Write JSON file
  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'tier-price-matrix.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${outPath}`);

  // 7b. Write to Redis
  await kv.set('meta:tier-performance', JSON.stringify(result));
  console.log('Wrote Redis key meta:tier-performance');

  // 7c. Console table
  printTable(result);
}

function printTable(result) {
  const bucketKeys = PRICE_BUCKETS.map(b => b.key);
  const bucketLabels = PRICE_BUCKETS.map(b => b.label);
  const tiers = ALL_TIERS.filter(t => result.tierTotals[t].count > 0);

  const colW = 18;
  const tierW = 16;
  const pad = (s, w) => String(s).padEnd(w);
  const rpad = (s, w) => String(s).padStart(w);
  const sep = '-'.repeat(tierW + (colW * (bucketKeys.length + 1)) + 4);

  console.log('\n=== Tier × Price Bucket Performance Matrix ===\n');

  // Header
  let header = pad('Tier', tierW) + '| ';
  for (const label of bucketLabels) header += rpad(label, colW);
  header += rpad('TOTAL', colW);
  console.log(header);
  console.log(sep);

  for (const tier of tiers) {
    // Count row
    let line1 = pad(tier, tierW) + '| ';
    for (const bk of bucketKeys) {
      const c = result.matrix[tier][bk];
      line1 += rpad(`n=${c.count}`, colW);
    }
    line1 += rpad(`n=${result.tierTotals[tier].count}`, colW);
    console.log(line1);

    // Win rate row
    let line2 = pad('', tierW) + '| ';
    for (const bk of bucketKeys) {
      const c = result.matrix[tier][bk];
      line2 += rpad(c.count ? `win=${c.winRate}%` : '', colW);
    }
    line2 += rpad(`win=${result.tierTotals[tier].winRate}%`, colW);
    console.log(line2);

    // Avg return row
    let line3 = pad('', tierW) + '| ';
    for (const bk of bucketKeys) {
      const c = result.matrix[tier][bk];
      line3 += rpad(c.count ? `avg=${c.avgReturn}%` : '', colW);
    }
    line3 += rpad(`avg=${result.tierTotals[tier].avgReturn}%`, colW);
    console.log(line3);

    // Median return row
    let line4 = pad('', tierW) + '| ';
    for (const bk of bucketKeys) {
      const c = result.matrix[tier][bk];
      line4 += rpad(c.count ? `med=${c.medianReturn}%` : '', colW);
    }
    line4 += rpad(`med=${result.tierTotals[tier].medianReturn}%`, colW);
    console.log(line4);

    console.log(sep);
  }

  // Bucket totals row
  let totLine = pad('ALL TIERS', tierW) + '| ';
  for (const bk of bucketKeys) {
    const c = result.bucketTotals[bk];
    totLine += rpad(`n=${c.count} w=${c.winRate}%`, colW);
  }
  totLine += rpad(`n=${result.grandTotal.count} w=${result.grandTotal.winRate}%`, colW);
  console.log(totLine);

  let avgLine = pad('', tierW) + '| ';
  for (const bk of bucketKeys) {
    const c = result.bucketTotals[bk];
    avgLine += rpad(`avg=${c.avgReturn}%`, colW);
  }
  avgLine += rpad(`avg=${result.grandTotal.avgReturn}%`, colW);
  console.log(avgLine);
  console.log('');
}

main().catch(err => { console.error(err); process.exit(1); });
