#!/usr/bin/env node
/**
 * Analyze Seasonality
 *
 * Finds day-of-week, monthly, and week-of-month patterns in pick
 * performance. Flags statistically notable deviations from the
 * overall average win rate.
 *
 * Usage: node scripts/analyze-seasonality.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getRedis } = require('../lib/redis');

// ── Constants ───────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ── Helpers ─────────────────────────────────────────────────────────

function round2(n) {
  return Math.round(n * 100) / 100;
}

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function weekOfMonth(date) {
  const d = new Date(date);
  const firstDay = new Date(d.getFullYear(), d.getMonth(), 1).getDay();
  return Math.ceil((d.getDate() + firstDay) / 7);
}

function computeGroupStats(returns) {
  if (!returns.length) return null;
  const avg = returns.reduce((s, v) => s + v, 0) / returns.length;
  const wins = returns.filter(v => v > 0).length;
  return {
    count: returns.length,
    winRate: round2((wins / returns.length) * 100),
    avgReturn: round2(avg),
    medianReturn: round2(median(returns)),
  };
}

function printTable(label, rows, keyField) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 56 - label.length))}`);
  console.log(
    `  ${keyField.padEnd(12)} ${'Count'.padStart(6)} ${'WinRate'.padStart(8)} ${'AvgRet'.padStart(8)} ${'MedRet'.padStart(8)}`
  );
  console.log('  ' + '─'.repeat(44));
  for (const row of rows) {
    if (!row.stats) continue;
    const s = row.stats;
    console.log(
      `  ${row.name.padEnd(12)} ${String(s.count).padStart(6)} ${(s.winRate + '%').padStart(8)} ` +
      `${((s.avgReturn >= 0 ? '+' : '') + s.avgReturn + '%').padStart(8)} ` +
      `${((s.medianReturn >= 0 ? '+' : '') + s.medianReturn + '%').padStart(8)}`
    );
  }
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const r = getRedis();
  if (!r) {
    console.error('Redis not available. Check env vars.');
    process.exit(1);
  }

  // 1. Load all pick IDs
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

  console.log(`Loaded ${picks.length} valid picks`);

  // 3. Filter to picks with return30d and valid entryDate
  const eligible = picks.filter(p => {
    if (p.return30d === null || p.return30d === undefined) return false;
    if (!p.entryDate) return false;
    const d = new Date(p.entryDate);
    return !isNaN(d.getTime());
  });

  console.log(`${eligible.length} picks have return30d + valid entryDate\n`);

  if (!eligible.length) {
    console.log('No eligible picks. Exiting.');
    process.exit(0);
  }

  // 4. Overall baseline
  const allReturns = eligible.map(p => p.return30d);
  const overallStats = computeGroupStats(allReturns);
  console.log(`Overall: ${overallStats.count} picks, win rate ${overallStats.winRate}%, ` +
    `avg return ${overallStats.avgReturn > 0 ? '+' : ''}${overallStats.avgReturn}%`);

  // 5. Group by day-of-week
  const byDay = {};
  for (let d = 0; d < 7; d++) byDay[d] = [];

  for (const pick of eligible) {
    const day = new Date(pick.entryDate).getDay();
    byDay[day].push(pick.return30d);
  }

  const dayRows = DAY_NAMES.map((name, i) => ({
    name,
    index: i,
    stats: computeGroupStats(byDay[i]),
  }));

  printTable('Day of Week', dayRows, 'Day');

  // 6. Group by month
  const byMonth = {};
  for (let m = 0; m < 12; m++) byMonth[m] = [];

  for (const pick of eligible) {
    const month = new Date(pick.entryDate).getMonth();
    byMonth[month].push(pick.return30d);
  }

  const monthRows = MONTH_NAMES.map((name, i) => ({
    name,
    index: i,
    stats: computeGroupStats(byMonth[i]),
  })).filter(r => r.stats);

  printTable('Month', monthRows, 'Month');

  // 7. Group by week-of-month
  const byWeek = {};
  for (let w = 1; w <= 5; w++) byWeek[w] = [];

  for (const pick of eligible) {
    const w = weekOfMonth(pick.entryDate);
    byWeek[w].push(pick.return30d);
  }

  const weekRows = [1, 2, 3, 4, 5].map(w => ({
    name: `Week ${w}`,
    index: w,
    stats: computeGroupStats(byWeek[w]),
  })).filter(r => r.stats);

  printTable('Week of Month', weekRows, 'Week');

  // 8. Find notable patterns
  const THRESHOLD = 10; // percentage points above/below overall
  const notable = [];

  function checkNotable(groupName, label, stats) {
    if (!stats) return;
    const diff = stats.winRate - overallStats.winRate;
    if (Math.abs(diff) >= THRESHOLD) {
      notable.push({
        group: groupName,
        label,
        winRate: stats.winRate,
        overallWinRate: overallStats.winRate,
        diff: round2(diff),
        count: stats.count,
        confidence: stats.count >= 20 ? 'high' : stats.count >= 10 ? 'medium' : 'low',
      });
    }
  }

  for (const row of dayRows) checkNotable('dayOfWeek', row.name, row.stats);
  for (const row of monthRows) checkNotable('month', row.name, row.stats);
  for (const row of weekRows) checkNotable('weekOfMonth', row.name, row.stats);

  console.log('\n── Notable Patterns ────────────────────────────────────');
  if (!notable.length) {
    console.log('  No day/month/week deviates >=10pp from overall win rate.');
  } else {
    for (const n of notable) {
      const arrow = n.diff > 0 ? 'ABOVE' : 'BELOW';
      console.log(
        `  ${n.label} (${n.group}): win rate ${n.winRate}% — ` +
        `${Math.abs(n.diff)}pp ${arrow} avg (n=${n.count}, confidence: ${n.confidence})`
      );
    }
  }

  // 9. Build output
  const dayOfWeek = {};
  for (const row of dayRows) {
    if (row.stats) dayOfWeek[row.name] = row.stats;
  }

  const monthly = {};
  for (const row of monthRows) {
    monthly[row.name] = row.stats;
  }

  const weekOfMonthOut = {};
  for (const row of weekRows) {
    weekOfMonthOut[row.name] = row.stats;
  }

  const output = {
    generatedAt: new Date().toISOString(),
    totalPicks: picks.length,
    eligiblePicks: eligible.length,
    overall: overallStats,
    dayOfWeek,
    monthly,
    weekOfMonth: weekOfMonthOut,
    notablePatterns: notable,
  };

  // Write to file
  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'seasonality.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);

  // Write to Redis
  await r.set('meta:seasonality', JSON.stringify(output));
  console.log('Wrote meta:seasonality to Redis');

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
