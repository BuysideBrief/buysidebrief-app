#!/usr/bin/env node
/**
 * Market Cap Bucket Analysis
 *
 * Groups picks by market cap and calculates performance by size category.
 * Cross-tabulates with tier and signal type to answer whether small-cap
 * insider purchases are more informative (Lakonishok & Lee 2001, Seyhun 1998).
 *
 * Requires company profiles cached in Redis (run backfill-company-profiles.js first).
 *
 * Usage: node scripts/analyze-market-cap-buckets.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { getRedis } = require('../lib/redis');

// ── Helpers ──────────────────────────────────────────────────────────

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function daysBetween(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function getUsableReturn(pick) {
  if (pick.return7d != null) return pick.return7d;
  if (pick.currentReturn != null && pick.entryDate) {
    const age = daysBetween(pick.entryDate);
    if (age >= 5) return pick.currentReturn;
  }
  return null;
}

function fmtPct(n) {
  if (n == null) return 'n/a';
  return `${n > 0 ? '+' : ''}${round2(n)}%`;
}

function fmtDollar(n) {
  if (n == null) return 'n/a';
  if (n >= 1e9) return `$${round2(n / 1e9)}B`;
  if (n >= 1e6) return `$${round2(n / 1e6)}M`;
  if (n >= 1e3) return `$${round2(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

// Finnhub returns marketCap in millions
const BUCKETS = [
  { name: 'micro',  label: 'Micro (<$300M)',    min: 0,     max: 300 },
  { name: 'small',  label: 'Small ($300M-$2B)', min: 300,   max: 2000 },
  { name: 'mid',    label: 'Mid ($2B-$10B)',     min: 2000,  max: 10000 },
  { name: 'large',  label: 'Large ($10B+)',      min: 10000, max: Infinity },
];

function getBucket(marketCap) {
  if (marketCap == null || marketCap <= 0) return 'unknown';
  for (const b of BUCKETS) {
    if (marketCap >= b.min && marketCap < b.max) return b.name;
  }
  return 'unknown';
}

function getBucketLabel(name) {
  if (name === 'unknown') return 'Unknown';
  const b = BUCKETS.find(b => b.name === name);
  return b ? b.label : name;
}

// ── Signal normalization (same as analyze-signal-performance.js) ─────

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
  return null;
}

function getPickSignals(pick) {
  const signals = pick.signals || [];
  const seen = new Set();
  for (const sig of signals) {
    const sigStr = typeof sig === 'string' ? sig : (sig.reason || sig.label || String(sig));
    const cat = normalizeSignal(sigStr);
    if (cat && !seen.has(cat)) seen.add(cat);
  }
  return [...seen];
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const r = getRedis();
  if (!r) {
    console.error('Redis not available. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  MARKET CAP BUCKET ANALYSIS');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Step 1: Load all picks from picks:index ───────────────────────
  console.log('Loading picks from picks:index...');
  const pickIds = await r.zrange('picks:index', 0, -1);
  console.log(`  Found ${pickIds.length} pick IDs`);

  if (!pickIds.length) {
    console.log('No picks found. Run the pipeline first.');
    process.exit(0);
  }

  const BATCH = 100;
  const picks = [];

  for (let i = 0; i < pickIds.length; i += BATCH) {
    const batch = pickIds.slice(i, i + BATCH);
    const pipeline = r.pipeline();
    for (const id of batch) pipeline.get(id);
    const results = await pipeline.exec();

    for (let j = 0; j < results.length; j++) {
      let raw = results[j];
      if (!raw) continue;
      try {
        const pick = typeof raw === 'string' ? JSON.parse(raw) : raw;
        picks.push(pick);
      } catch (e) {
        // skip unparseable
      }
    }

    if ((i + BATCH) % 500 === 0 || i + BATCH >= pickIds.length) {
      console.log(`  ...loaded ${Math.min(i + BATCH, pickIds.length)}/${pickIds.length}`);
    }
  }
  console.log(`  Parsed ${picks.length} pick records\n`);

  // ── Step 2: Look up company profiles for market cap ───────────────
  const uniqueTickers = [...new Set(picks.map(p => (p.ticker || '').toUpperCase()).filter(Boolean))];
  console.log(`Looking up company profiles for ${uniqueTickers.length} unique tickers...`);

  const profileMap = {}; // ticker → { marketCap, ... }
  for (let i = 0; i < uniqueTickers.length; i += BATCH) {
    const batch = uniqueTickers.slice(i, i + BATCH);
    const pipeline = r.pipeline();
    for (const ticker of batch) pipeline.get(`company:${ticker}`);
    const results = await pipeline.exec();

    for (let j = 0; j < results.length; j++) {
      let raw = results[j];
      if (!raw) continue;
      try {
        const profile = typeof raw === 'string' ? JSON.parse(raw) : raw;
        profileMap[batch[j]] = profile;
      } catch (e) {
        // skip
      }
    }
  }

  const mappedCount = Object.keys(profileMap).length;
  console.log(`  Mapped ${mappedCount}/${uniqueTickers.length} tickers to profiles\n`);

  // ── Step 3: Assign picks to market cap buckets ────────────────────
  console.log('Assigning picks to market cap buckets...');

  // Enriched pick records with bucket, return, etc.
  const enriched = [];
  for (const pick of picks) {
    const ticker = (pick.ticker || '').toUpperCase();
    const profile = profileMap[ticker];
    const marketCap = profile ? (profile.marketCapitalization || profile.marketCap || null) : null;
    const bucket = getBucket(marketCap);
    const ret = getUsableReturn(pick);
    const tier = pick.tier || 'unknown';
    const signals = getPickSignals(pick);
    const buyValue = pick.buyValue || pick.totalBuyValue || null;
    const convictionIntensity = (buyValue && marketCap && marketCap > 0)
      ? (buyValue / (marketCap * 1e6)) * 100 // as percentage
      : null;

    enriched.push({ ticker, bucket, marketCap, ret, tier, signals, buyValue, convictionIntensity });
  }

  const bucketCounts = {};
  for (const e of enriched) {
    bucketCounts[e.bucket] = (bucketCounts[e.bucket] || 0) + 1;
  }
  for (const [b, c] of Object.entries(bucketCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${getBucketLabel(b)}: ${c} picks`);
  }
  console.log('');

  // ── Step 4: Calculate per-bucket stats ────────────────────────────
  console.log('Calculating per-bucket stats...');

  const bucketOrder = ['micro', 'small', 'mid', 'large', 'unknown'];
  const bucketStats = {};

  for (const bName of bucketOrder) {
    const bPicks = enriched.filter(e => e.bucket === bName);
    const withReturns = bPicks.filter(e => e.ret !== null);
    const returns = withReturns.map(e => e.ret);
    const wins = returns.filter(r => r > 0).length;
    const convictions = bPicks.map(e => e.convictionIntensity).filter(c => c != null);

    let best = null, worst = null;
    for (const e of withReturns) {
      if (!best || e.ret > best.return) best = { ticker: e.ticker, return: round2(e.ret) };
      if (!worst || e.ret < worst.return) worst = { ticker: e.ticker, return: round2(e.ret) };
    }

    bucketStats[bName] = {
      label: getBucketLabel(bName),
      pickCount: bPicks.length,
      withReturns: returns.length,
      winRate: returns.length ? round2((wins / returns.length) * 100) : null,
      avgReturn: returns.length ? round2(returns.reduce((s, v) => s + v, 0) / returns.length) : null,
      medianReturn: returns.length ? round2(median(returns)) : null,
      bestPick: best,
      worstPick: worst,
      avgConvictionIntensity: convictions.length
        ? round2(convictions.reduce((s, v) => s + v, 0) / convictions.length)
        : null,
    };
  }

  // Console output: bucket table
  console.log('\n┌─────────────────────┬───────┬──────────┬───────────┬────────────┬──────────────────────────────────┐');
  console.log('│ Bucket              │ Picks │ Win Rate │ Avg Ret   │ Med Ret    │ Best / Worst                     │');
  console.log('├─────────────────────┼───────┼──────────┼───────────┼────────────┼──────────────────────────────────┤');
  for (const bName of bucketOrder) {
    const s = bucketStats[bName];
    if (!s.pickCount) continue;
    const best = s.bestPick ? `${s.bestPick.ticker} ${fmtPct(s.bestPick.return)}` : 'n/a';
    const worst = s.worstPick ? `${s.worstPick.ticker} ${fmtPct(s.worstPick.return)}` : 'n/a';
    console.log(
      `│ ${s.label.padEnd(19)} │ ${String(s.pickCount).padStart(5)} │ ${(s.winRate != null ? fmtPct(s.winRate).replace('%','') + '%' : 'n/a').padStart(8)} │ ${(fmtPct(s.avgReturn)).padStart(9)} │ ${(fmtPct(s.medianReturn)).padStart(10)} │ ${(best + ' / ' + worst).padEnd(32)} │`
    );
  }
  console.log('└─────────────────────┴───────┴──────────┴───────────┴────────────┴──────────────────────────────────┘\n');

  // ── Step 5: Cross-tabulate: market cap bucket × tier ──────────────
  console.log('Cross-tabulating: Market Cap × Tier...\n');

  const tiers = ['top_pick', 'feature', 'mention'];
  const crossTier = {};

  for (const bName of bucketOrder) {
    crossTier[bName] = {};
    for (const tier of tiers) {
      const subset = enriched.filter(e => e.bucket === bName && e.tier === tier && e.ret !== null);
      const returns = subset.map(e => e.ret);
      const wins = returns.filter(r => r > 0).length;
      crossTier[bName][tier] = {
        count: returns.length,
        winRate: returns.length >= 3 ? round2((wins / returns.length) * 100) : null,
        avgReturn: returns.length >= 3 ? round2(returns.reduce((s, v) => s + v, 0) / returns.length) : null,
      };
    }
  }

  // Print cross-tab matrix
  const tierLabels = { top_pick: 'Top Pick', feature: 'Featured', mention: 'Mention' };
  console.log('  Win Rate (avg return) by Market Cap × Tier [min 3 picks]:\n');
  const header = '  ' + ''.padEnd(20) + tiers.map(t => tierLabels[t].padStart(18)).join('');
  console.log(header);
  console.log('  ' + '─'.repeat(20 + tiers.length * 18));

  for (const bName of bucketOrder) {
    if (!bucketStats[bName].pickCount) continue;
    let row = '  ' + getBucketLabel(bName).padEnd(20);
    for (const tier of tiers) {
      const cell = crossTier[bName][tier];
      if (cell.winRate != null) {
        row += `${cell.winRate}% (${fmtPct(cell.avgReturn)})`.padStart(18);
      } else {
        const n = cell.count;
        row += `(n=${n})`.padStart(18);
      }
    }
    console.log(row);
  }
  console.log('');

  // ── Step 6: Cross-tabulate: market cap bucket × signal type ───────
  console.log('Cross-tabulating: Market Cap × Signal Type (top 4 signals)...\n');

  // Count signals across all picks to find top 4
  const signalCounts = {};
  for (const e of enriched) {
    for (const sig of e.signals) {
      signalCounts[sig] = (signalCounts[sig] || 0) + 1;
    }
  }
  const topSignals = Object.entries(signalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([sig]) => sig);

  console.log(`  Top 4 signals: ${topSignals.join(', ')}\n`);

  const crossSignal = {};
  for (const bName of bucketOrder) {
    crossSignal[bName] = {};
    for (const sig of topSignals) {
      const subset = enriched.filter(
        e => e.bucket === bName && e.signals.includes(sig) && e.ret !== null
      );
      const returns = subset.map(e => e.ret);
      const wins = returns.filter(r => r > 0).length;
      crossSignal[bName][sig] = {
        count: returns.length,
        winRate: returns.length >= 3 ? round2((wins / returns.length) * 100) : null,
        avgReturn: returns.length >= 3 ? round2(returns.reduce((s, v) => s + v, 0) / returns.length) : null,
      };
    }
  }

  // Print signal cross-tab
  console.log('  Win Rate (avg return) by Market Cap × Signal [min 3 picks]:\n');
  const sigHeader = '  ' + ''.padEnd(20) + topSignals.map(s => s.padStart(18)).join('');
  console.log(sigHeader);
  console.log('  ' + '─'.repeat(20 + topSignals.length * 18));

  for (const bName of bucketOrder) {
    if (!bucketStats[bName].pickCount) continue;
    let row = '  ' + getBucketLabel(bName).padEnd(20);
    for (const sig of topSignals) {
      const cell = crossSignal[bName][sig];
      if (cell.winRate != null) {
        row += `${cell.winRate}% (${fmtPct(cell.avgReturn)})`.padStart(18);
      } else {
        const n = cell.count;
        row += `(n=${n})`.padStart(18);
      }
    }
    console.log(row);
  }
  console.log('');

  // ── Step 7: Key findings ──────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════════');
  console.log('  KEY FINDINGS');
  console.log('═══════════════════════════════════════════════════════\n');

  // Highest win rate bucket (excluding unknown and buckets with < 3 picks)
  const ranked = bucketOrder
    .filter(b => b !== 'unknown' && bucketStats[b].withReturns >= 3)
    .sort((a, b) => (bucketStats[b].winRate || 0) - (bucketStats[a].winRate || 0));

  if (ranked.length) {
    const best = ranked[0];
    const worst = ranked[ranked.length - 1];
    console.log(`  1. Highest win rate bucket: ${getBucketLabel(best)} at ${fmtPct(bucketStats[best].winRate)}`);
    console.log(`     Lowest win rate bucket:  ${getBucketLabel(worst)} at ${fmtPct(bucketStats[worst].winRate)}`);

    const spread = (bucketStats[best].winRate || 0) - (bucketStats[worst].winRate || 0);
    if (spread > 10) {
      console.log(`     → ${round2(spread)}pp spread — statistically notable difference between buckets.`);
    } else {
      console.log(`     → ${round2(spread)}pp spread — modest difference, no strong size effect.`);
    }
  } else {
    console.log('  1. Insufficient data to compare buckets.');
  }

  // Check tier inversion across buckets
  console.log('');
  console.log('  2. Tier inversion by market cap:');
  for (const bName of bucketOrder) {
    if (!bucketStats[bName].pickCount) continue;
    const tp = crossTier[bName].top_pick;
    const ft = crossTier[bName].feature;
    if (tp.winRate != null && ft.winRate != null) {
      const inverted = ft.winRate > tp.winRate;
      console.log(`     ${getBucketLabel(bName)}: Top Pick ${fmtPct(tp.winRate)} vs Featured ${fmtPct(ft.winRate)} ${inverted ? '← INVERTED' : '(normal)'}`);
    } else {
      console.log(`     ${getBucketLabel(bName)}: insufficient data for tier comparison`);
    }
  }

  // Lakonishok & Lee reference
  console.log('');
  const microStat = bucketStats.micro;
  const largeStat = bucketStats.large;
  if (microStat.winRate != null && largeStat.winRate != null) {
    const microBetter = microStat.winRate > largeStat.winRate;
    console.log(`  3. Lakonishok & Lee (2001) test: small-cap insider buys more informative?`);
    console.log(`     Micro-cap: ${fmtPct(microStat.winRate)} win rate, ${fmtPct(microStat.avgReturn)} avg`);
    console.log(`     Large-cap: ${fmtPct(largeStat.winRate)} win rate, ${fmtPct(largeStat.avgReturn)} avg`);
    console.log(`     → ${microBetter ? 'CONFIRMED: micro-cap picks outperform large-cap.' : 'CHALLENGED: large-cap picks outperform or match micro-cap.'}`);
  } else {
    console.log('  3. Insufficient data to test Lakonishok & Lee hypothesis.');
  }

  console.log('');

  // ── Step 8: Write output ──────────────────────────────────────────
  const output = {
    generatedAt: new Date().toISOString(),
    totalPicks: picks.length,
    mappedTickers: mappedCount,
    buckets: bucketStats,
    crossTabTier: crossTier,
    crossTabSignal: crossSignal,
    topSignals,
    findings: {
      bestBucket: ranked.length ? ranked[0] : null,
      worstBucket: ranked.length ? ranked[ranked.length - 1] : null,
    },
  };

  // Write JSON file
  const outDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'market-cap-analysis.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}`);

  // Write to Redis
  await r.set('meta:market-cap-analysis', JSON.stringify(output));
  console.log('Wrote meta:market-cap-analysis to Redis');

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
