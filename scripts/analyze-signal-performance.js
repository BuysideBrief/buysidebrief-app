/**
 * Signal Performance Analyzer
 *
 * Reads all pick records from Redis and calculates win rate
 * by scoring dimension (signal category). Outputs results to
 * JSON file, Redis, and console.
 *
 * Usage: node scripts/analyze-signal-performance.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs');
const path = require('path');
const { getRedis } = require('../lib/redis');

// ── Signal normalization map ──────────────────────────────────

const SIGNAL_PATTERNS = [
  { pattern: /^C-suite purchase/i,       category: 'c_suite' },
  { pattern: /^Senior officer purchase/i, category: 'c_suite' },
  { pattern: /^Cluster buying/i,         category: 'cluster' },
  { pattern: /^Paired buying/i,          category: 'paired' },
  { pattern: /^Mega purchase/i,          category: 'large_purchase' },
  { pattern: /^Major purchase/i,         category: 'large_purchase' },
  { pattern: /^Large purchase/i,         category: 'large_purchase' },
  { pattern: /^Large fund purchase/i,    category: 'large_purchase' },
  { pattern: /^Notable purchase/i,       category: 'medium_purchase' },
  { pattern: /^Fund purchase/i,          category: 'medium_purchase' },
  { pattern: /^Director purchase/i,      category: 'director' },
  { pattern: /^10%\+ owner/i,           category: 'ten_pct_owner' },
  { pattern: /^Institutional purchase/i, category: 'institutional' },
  { pattern: /^Discretionary/i,          category: 'discretionary' },
  { pattern: /^Open market purchase/i,   category: 'baseline' },
  { pattern: /^Officer purchase/i,       category: 'officer' },
  { pattern: /^Purchase:/i,              category: 'small_purchase' },
];

function normalizeSignal(signalStr) {
  for (const { pattern, category } of SIGNAL_PATTERNS) {
    if (pattern.test(signalStr)) return category;
  }
  return null; // unknown signal — skip
}

// ── Stats helpers ─────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildCategoryStats(picks, returnField) {
  const cats = {};

  for (const pick of picks) {
    const ret = pick[returnField];
    if (ret == null) continue;

    const signals = pick.signals || [];
    const seen = new Set();

    for (const sig of signals) {
      const sigStr = typeof sig === 'string' ? sig : (sig.reason || sig.label || String(sig));
      const cat = normalizeSignal(sigStr);
      if (!cat || seen.has(cat)) continue;
      seen.add(cat);

      if (!cats[cat]) {
        cats[cat] = { count: 0, wins: 0, sumReturn: 0, returns: [], best: null, worst: null };
      }
      const c = cats[cat];
      c.count++;
      if (ret > 0) c.wins++;
      c.sumReturn += ret;
      c.returns.push(ret);

      const pickRef = { ticker: pick.ticker, return: ret };
      if (!c.best || ret > c.best.return) c.best = pickRef;
      if (!c.worst || ret < c.worst.return) c.worst = pickRef;
    }
  }

  // Build sorted results
  return Object.entries(cats)
    .map(([category, c]) => ({
      category,
      pickCount: c.count,
      winRate: +(c.wins / c.count * 100).toFixed(1),
      avgReturn: +(c.sumReturn / c.count).toFixed(2),
      medianReturn: +median(c.returns).toFixed(2),
      bestPick: c.best,
      worstPick: c.worst,
    }))
    .sort((a, b) => b.winRate - a.winRate || b.avgReturn - a.avgReturn);
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const kv = getRedis();
  if (!kv) {
    console.error('Redis connection failed — check env vars.');
    process.exit(1);
  }

  // 1. Load all pick IDs
  console.log('Loading pick IDs from picks:index...');
  const pickIds = await kv.zrange('picks:index', 0, -1);
  console.log(`Found ${pickIds.length} pick IDs in index.`);

  if (!pickIds.length) {
    console.log('No picks found. Exiting.');
    process.exit(0);
  }

  // 2. Batch-fetch with pipeline
  console.log('Batch-fetching pick records...');
  const pipeline = kv.pipeline();
  for (const id of pickIds) {
    pipeline.get(id);
  }
  const results = await pipeline.exec();

  const picks = results.filter(Boolean);
  console.log(`Loaded ${picks.length} pick records (${pickIds.length - picks.length} missing/null).`);

  const with30d = picks.filter(p => p.return30d != null);
  const with90d = picks.filter(p => p.return90d != null);
  console.log(`${with30d.length} picks have 30d returns, ${with90d.length} have 90d returns.`);

  // 3. Build stats
  const stats30d = buildCategoryStats(picks, 'return30d');
  const stats90d = buildCategoryStats(picks, 'return90d');

  const report = {
    generatedAt: new Date().toISOString(),
    totalPicks: picks.length,
    picksWith30dReturn: with30d.length,
    picksWith90dReturn: with90d.length,
    bySignal30d: stats30d,
    bySignal90d: stats90d,
  };

  // 4. Write to file
  const outDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'signal-performance.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);

  // 5. Write to Redis
  await kv.set('meta:signal-report-card', JSON.stringify(report));
  console.log('Wrote meta:signal-report-card to Redis.');

  // 6. Console table
  console.log('\n═══ 30-Day Signal Performance ═══\n');
  printTable(stats30d);

  if (stats90d.length) {
    console.log('\n═══ 90-Day Signal Performance ═══\n');
    printTable(stats90d);
  }

  console.log('\nDone.');
}

function printTable(stats) {
  if (!stats.length) {
    console.log('  (no data)');
    return;
  }

  console.log(
    'Category'.padEnd(18) +
    'Picks'.padStart(7) +
    'Win%'.padStart(8) +
    'AvgRet'.padStart(9) +
    'MedRet'.padStart(9) +
    '  Best'.padEnd(20) +
    '  Worst'
  );
  console.log('─'.repeat(85));

  for (const s of stats) {
    const best = s.bestPick ? `${s.bestPick.ticker} ${s.bestPick.return > 0 ? '+' : ''}${s.bestPick.return.toFixed(1)}%` : '—';
    const worst = s.worstPick ? `${s.worstPick.ticker} ${s.worstPick.return > 0 ? '+' : ''}${s.worstPick.return.toFixed(1)}%` : '—';

    console.log(
      s.category.padEnd(18) +
      String(s.pickCount).padStart(7) +
      `${s.winRate}%`.padStart(8) +
      `${s.avgReturn}%`.padStart(9) +
      `${s.medianReturn}%`.padStart(9) +
      `  ${best}`.padEnd(20) +
      `  ${worst}`
    );
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
