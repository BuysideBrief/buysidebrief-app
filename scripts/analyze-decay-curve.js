#!/usr/bin/env node
/**
 * Analyze Decay Curve
 *
 * Loads all picks from Redis, calculates average returns at each
 * checkpoint (30d, 60d, 90d), broken down by tier, plus a real-time
 * "current return" snapshot. Writes results to output/decay-curve.json
 * and Redis key meta:decay-curve.
 *
 * Usage: node scripts/analyze-decay-curve.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getRedis } = require('../lib/redis');

// ── Helpers ──────────────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function stdDev(arr, avg) {
  if (arr.length < 2) return 0;
  const variance = arr.reduce((sum, v) => sum + (v - avg) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeStats(values) {
  if (!values.length) return null;
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const wins = values.filter(v => v > 0).length;
  return {
    avgReturn: round2(avg),
    medianReturn: round2(median(values)),
    winRate: round2((wins / values.length) * 100),
    count: values.length,
    stdDev: round2(stdDev(values, avg)),
    p25: round2(percentile(values, 25)),
    p75: round2(percentile(values, 75)),
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const r = getRedis();
  if (!r) {
    console.error('Redis not available. Check env vars.');
    process.exit(1);
  }

  // 1. Load all pick IDs from sorted set
  console.log('Loading picks:index...');
  const pickIds = await r.zrange('picks:index', 0, -1);
  console.log(`Found ${pickIds.length} pick IDs`);

  if (!pickIds.length) {
    console.log('No picks found. Exiting.');
    process.exit(0);
  }

  // 2. Pipeline-fetch all pick objects
  console.log('Fetching pick data via pipeline...');
  const BATCH = 100;
  const picks = [];

  for (let i = 0; i < pickIds.length; i += BATCH) {
    const batch = pickIds.slice(i, i + BATCH);
    const pipeline = r.pipeline();
    for (const id of batch) pipeline.get(id);
    const results = await pipeline.exec();

    for (const result of results) {
      if (!result) continue;
      const pick = typeof result === 'string' ? JSON.parse(result) : result;
      if (pick && pick.ticker) picks.push(pick);
    }

    if (i + BATCH < pickIds.length) {
      console.log(`  ...loaded ${Math.min(i + BATCH, pickIds.length)}/${pickIds.length}`);
    }
  }

  console.log(`Loaded ${picks.length} valid picks\n`);

  // 3. Compute checkpoint stats
  const checkpoints = [
    { days: 30, field: 'return30d' },
    { days: 60, field: 'return60d' },
    { days: 90, field: 'return90d' },
  ];

  const checkpointResults = [];
  for (const cp of checkpoints) {
    const values = picks
      .filter(p => p[cp.field] !== null && p[cp.field] !== undefined)
      .map(p => p[cp.field]);

    const stats = computeStats(values);
    if (stats) {
      checkpointResults.push({ days: cp.days, ...stats });
      console.log(`${cp.days}d: avg ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}%, ` +
        `win rate ${stats.winRate}%, n=${stats.count}`);
    } else {
      console.log(`${cp.days}d: no data`);
    }
  }

  // 4. Break down by tier at each checkpoint
  const tiers = [...new Set(picks.map(p => p.tier).filter(Boolean))];
  const byTier = {};

  for (const tier of tiers) {
    byTier[tier] = {};
    const tierPicks = picks.filter(p => p.tier === tier);

    for (const cp of checkpoints) {
      const values = tierPicks
        .filter(p => p[cp.field] !== null && p[cp.field] !== undefined)
        .map(p => p[cp.field]);

      const stats = computeStats(values);
      if (stats) {
        const label = `${cp.days}d`;
        byTier[tier][label] = stats;
        console.log(`  ${tier} @ ${label}: avg ${stats.avgReturn > 0 ? '+' : ''}${stats.avgReturn}%, ` +
          `win rate ${stats.winRate}%, n=${stats.count}`);
      }
    }
  }

  // 5. Current return snapshot (all picks with a currentReturn)
  const currentValues = picks
    .filter(p => p.currentReturn !== null && p.currentReturn !== undefined)
    .map(p => p.currentReturn);

  const currentSnapshot = computeStats(currentValues) || {
    avgReturn: 0, medianReturn: 0, winRate: 0, count: 0,
    stdDev: 0, p25: 0, p75: 0,
  };

  console.log(`\nCurrent snapshot: avg ${currentSnapshot.avgReturn > 0 ? '+' : ''}${currentSnapshot.avgReturn}%, ` +
    `win rate ${currentSnapshot.winRate}%, n=${currentSnapshot.count}`);

  // 6. Build output
  const output = {
    generatedAt: new Date().toISOString(),
    totalPicks: picks.length,
    checkpoints: checkpointResults,
    byTier,
    currentSnapshot,
  };

  // Write to file
  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'decay-curve.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);

  // Write to Redis
  await r.set('meta:decay-curve', JSON.stringify(output));
  console.log('Wrote meta:decay-curve to Redis');

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
