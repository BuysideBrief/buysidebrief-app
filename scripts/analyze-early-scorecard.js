/**
 * Early Scorecard Analysis — Unified Phase 1
 *
 * Runs all 5 analyses using return7d data (falling back to currentReturn
 * for picks 5+ days old when return7d is absent).
 *
 * Usage: node scripts/analyze-early-scorecard.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { getRedis } = require('../lib/redis');

// ── Helpers ──────────────────────────────────────────

function median(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function pct(n, d) {
  return d === 0 ? 0 : Math.round((n / d) * 10000) / 100;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function daysBetween(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function dayName(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', { weekday: 'long' });
}

/**
 * Get usable return for a pick — prefers return7d, falls back to
 * currentReturn if pick is at least 5 days old.
 */
function getUsableReturn(pick) {
  if (pick.return7d != null) return pick.return7d;
  if (pick.currentReturn != null && pick.entryDate) {
    const age = daysBetween(pick.entryDate);
    if (age >= 5) return pick.currentReturn;
  }
  return null;
}

/**
 * Normalize a signal string to a category key.
 */
function normalizeSignal(sig) {
  if (sig.startsWith('C-suite'))            return 'c_suite';
  if (sig.startsWith('Cluster'))            return 'cluster';
  if (sig.startsWith('Paired'))             return 'paired';
  if (sig.startsWith('Mega purchase'))      return 'large_purchase';
  if (sig.startsWith('Major purchase'))     return 'large_purchase';
  if (sig.startsWith('Large purchase'))     return 'large_purchase';
  if (sig.startsWith('Large fund'))         return 'large_purchase';
  if (sig.startsWith('Notable purchase'))   return 'medium_purchase';
  if (sig.startsWith('Purchase:'))          return 'medium_purchase';
  if (sig.startsWith('Director'))           return 'director';
  if (sig.startsWith('Officer'))            return 'director';
  if (sig.startsWith('10%+'))               return 'ten_pct_owner';
  if (sig.startsWith('Institutional'))      return 'ten_pct_owner';
  if (sig.startsWith('Discretionary'))      return 'discretionary';
  if (sig.startsWith('Open market'))        return 'baseline';
  if (sig.startsWith('Post-earnings'))      return 'post_earnings';
  if (sig.startsWith('Contrarian'))         return 'contrarian';
  if (sig.includes('contrarian'))           return 'contrarian';
  return null; // caller handles "other"
}

function bucketPrice(price) {
  if (price == null || price <= 0) return null;
  if (price <= 5)  return 'micro';
  if (price <= 20) return 'small';
  if (price <= 50) return 'mid';
  return 'large';
}

const PRICE_BUCKET_LABELS = {
  micro: '$0.01–$5.00',
  small: '$5.01–$20.00',
  mid:   '$20.01–$50.00',
  large: '$50.01+',
};

// ── Main ─────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║   EARLY SCORECARD ANALYSIS — Phase 1 (7d returns)   ║');
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log();

  // ── Step 1: Connect & load ────────────────────────

  console.log('Loading picks from Redis...');
  const kv = getRedis();
  if (!kv) {
    console.error('Redis not available. Set UPSTASH_REDIS_REST_URL + TOKEN.');
    process.exit(1);
  }

  const pickIds = await kv.zrange('picks:index', 0, -1);
  if (!pickIds || pickIds.length === 0) {
    console.log('No picks found in picks:index. Nothing to analyze.');
    process.exit(0);
  }

  console.log(`  Found ${pickIds.length} pick IDs in index. Fetching records...`);

  // Pipeline fetch — critical for Upstash performance
  const pipeline = kv.pipeline();
  for (const id of pickIds) pipeline.get(id);
  const rawResults = await pipeline.exec();
  const allPicks = rawResults.filter(Boolean);

  // Summary counts
  const with7d = allPicks.filter(p => p.return7d != null).length;
  const with30d = allPicks.filter(p => p.return30d != null).length;
  const withCurrent = allPicks.filter(p => p.currentReturn != null).length;
  const withUsable = allPicks.filter(p => getUsableReturn(p) != null).length;

  console.log();
  console.log('═══ DATA SUMMARY ═══');
  console.log(`  Total picks loaded:    ${allPicks.length}`);
  console.log(`  With return7d:         ${with7d}`);
  console.log(`  With return30d:        ${with30d}`);
  console.log(`  With currentReturn:    ${withCurrent}`);
  console.log(`  Usable for analysis:   ${withUsable} (return7d or currentReturn with age >= 5d)`);
  console.log();

  // Build analysis set — picks with usable returns and an entryPrice
  const analysisPicks = allPicks
    .map(p => ({ ...p, _return: getUsableReturn(p) }))
    .filter(p => p._return != null && p.entryPrice != null && p.entryPrice > 0);

  if (analysisPicks.length === 0) {
    console.log('No picks with usable returns. Too early to analyze.');
    process.exit(0);
  }

  console.log(`  Picks entering analysis (with price + return): ${analysisPicks.length}`);
  console.log();

  // ══════════════════════════════════════════════════
  //  ANALYSIS 1: Win Rate by Scoring Dimension
  // ══════════════════════════════════════════════════

  console.log('Running signal analysis...');
  console.log();
  console.log('═══ ANALYSIS 1: WIN RATE BY SCORING DIMENSION ═══');
  console.log();

  const signalBuckets = {};
  const unmatchedSignals = new Set();

  for (const pick of analysisPicks) {
    if (!Array.isArray(pick.signals) || pick.signals.length === 0) continue;

    for (const sig of pick.signals) {
      let cat = normalizeSignal(sig);
      if (cat === null) {
        unmatchedSignals.add(sig);
        cat = 'other';
      }
      if (!signalBuckets[cat]) {
        signalBuckets[cat] = { count: 0, winners: 0, sum: 0, returns: [] };
      }
      signalBuckets[cat].count++;
      if (pick._return > 0) signalBuckets[cat].winners++;
      signalBuckets[cat].sum += pick._return;
      signalBuckets[cat].returns.push(pick._return);
    }
  }

  if (unmatchedSignals.size > 0) {
    console.log('  Unmatched signals (bucketed as "other"):');
    for (const s of unmatchedSignals) console.log(`    - "${s}"`);
    console.log();
  }

  const signalPerformance = Object.entries(signalBuckets)
    .map(([signal, b]) => ({
      signal,
      count: b.count,
      winRate: pct(b.winners, b.count),
      avgReturn: round2(b.sum / b.count),
      medianReturn: round2(median(b.returns)),
    }))
    .sort((a, b) => b.avgReturn - a.avgReturn);

  console.table(signalPerformance);

  // ══════════════════════════════════════════════════
  //  ANALYSIS 2: Win Rate by Tier
  // ══════════════════════════════════════════════════

  console.log('Running tier analysis...');
  console.log();
  console.log('═══ ANALYSIS 2: WIN RATE BY TIER ═══');
  console.log();

  const tierBuckets = {};
  for (const pick of analysisPicks) {
    const tier = pick.tier || 'unknown';
    if (!tierBuckets[tier]) {
      tierBuckets[tier] = { count: 0, winners: 0, sum: 0, returns: [] };
    }
    tierBuckets[tier].count++;
    if (pick._return > 0) tierBuckets[tier].winners++;
    tierBuckets[tier].sum += pick._return;
    tierBuckets[tier].returns.push(pick._return);
  }

  const tierPerformance = Object.entries(tierBuckets)
    .map(([tier, b]) => ({
      tier,
      count: b.count,
      winRate: pct(b.winners, b.count),
      avgReturn: round2(b.sum / b.count),
      medianReturn: round2(median(b.returns)),
    }))
    .sort((a, b) => b.avgReturn - a.avgReturn);

  console.table(tierPerformance);

  // Check tier inversion
  const topPickTier = tierPerformance.find(t => t.tier === 'top_pick');
  const featureTier = tierPerformance.find(t => t.tier === 'feature');
  const tierInversion = topPickTier && featureTier && topPickTier.winRate < featureTier.winRate;
  if (tierInversion) {
    console.log('  ⚠️  TIER INVERSION DETECTED: top_pick win rate < feature win rate');
    console.log(`      top_pick: ${topPickTier.winRate}%  |  feature: ${featureTier.winRate}%`);
    console.log();
  }

  // ══════════════════════════════════════════════════
  //  ANALYSIS 3: Win Rate by Price Bucket
  // ══════════════════════════════════════════════════

  console.log('Running price bucket analysis...');
  console.log();
  console.log('═══ ANALYSIS 3: WIN RATE BY PRICE BUCKET ═══');
  console.log();

  const priceBucketData = {};
  for (const pick of analysisPicks) {
    const bucket = bucketPrice(pick.entryPrice);
    if (!bucket) continue;
    if (!priceBucketData[bucket]) {
      priceBucketData[bucket] = { count: 0, winners: 0, sum: 0, returns: [] };
    }
    priceBucketData[bucket].count++;
    if (pick._return > 0) priceBucketData[bucket].winners++;
    priceBucketData[bucket].sum += pick._return;
    priceBucketData[bucket].returns.push(pick._return);
  }

  const priceBuckets = ['micro', 'small', 'mid', 'large']
    .filter(b => priceBucketData[b])
    .map(bucket => ({
      bucket,
      label: PRICE_BUCKET_LABELS[bucket],
      count: priceBucketData[bucket].count,
      winRate: pct(priceBucketData[bucket].winners, priceBucketData[bucket].count),
      avgReturn: round2(priceBucketData[bucket].sum / priceBucketData[bucket].count),
      medianReturn: round2(median(priceBucketData[bucket].returns)),
    }));

  console.table(priceBuckets);

  // Cross-tab: tier × price bucket
  console.log('  Tier × Price cross-tab (min 3 picks):');
  console.log();

  const tierPriceMatrix = {};
  for (const pick of analysisPicks) {
    const tier = pick.tier || 'unknown';
    const bucket = bucketPrice(pick.entryPrice);
    if (!bucket) continue;

    if (!tierPriceMatrix[tier]) tierPriceMatrix[tier] = {};
    if (!tierPriceMatrix[tier][bucket]) {
      tierPriceMatrix[tier][bucket] = { count: 0, winners: 0, sum: 0, returns: [] };
    }
    tierPriceMatrix[tier][bucket].count++;
    if (pick._return > 0) tierPriceMatrix[tier][bucket].winners++;
    tierPriceMatrix[tier][bucket].sum += pick._return;
    tierPriceMatrix[tier][bucket].returns.push(pick._return);
  }

  // Build printable cross-tab (only cells with n >= 3)
  const tiers = Object.keys(tierPriceMatrix).sort();
  const bucketNames = ['micro', 'small', 'mid', 'large'];

  const crossTabRows = [];
  for (const tier of tiers) {
    const row = { tier };
    for (const b of bucketNames) {
      const cell = tierPriceMatrix[tier]?.[b];
      if (cell && cell.count >= 3) {
        row[PRICE_BUCKET_LABELS[b]] = `${pct(cell.winners, cell.count)}% win (n=${cell.count}, avg ${round2(cell.sum / cell.count)}%)`;
      } else {
        row[PRICE_BUCKET_LABELS[b]] = cell ? `n=${cell.count} (too few)` : '—';
      }
    }
    crossTabRows.push(row);
  }
  console.table(crossTabRows);

  // Serialize cross-tab for JSON output
  const tierPriceJson = {};
  for (const tier of tiers) {
    tierPriceJson[tier] = {};
    for (const b of bucketNames) {
      const cell = tierPriceMatrix[tier]?.[b];
      if (cell && cell.count >= 3) {
        tierPriceJson[tier][b] = {
          count: cell.count,
          winRate: pct(cell.winners, cell.count),
          avgReturn: round2(cell.sum / cell.count),
          medianReturn: round2(median(cell.returns)),
        };
      }
    }
  }

  // ══════════════════════════════════════════════════
  //  ANALYSIS 4: Decay Curve (7d snapshot)
  // ══════════════════════════════════════════════════

  console.log('Running decay curve analysis...');
  console.log();
  console.log('═══ ANALYSIS 4: DECAY CURVE (7d snapshot) ═══');
  console.log();

  // 7d stats
  const picks7d = analysisPicks; // all usable picks approximate 7d
  const returns7d = picks7d.map(p => p._return);

  const decay7d = {
    count: returns7d.length,
    avgReturn: round2(returns7d.reduce((s, v) => s + v, 0) / returns7d.length),
    medianReturn: round2(median(returns7d)),
    winRate: pct(returns7d.filter(r => r > 0).length, returns7d.length),
    stddev: round2(stddev(returns7d)),
  };

  console.log('  7d Aggregate:');
  console.table([decay7d]);

  // 7d by tier
  console.log('  7d By Tier:');
  const decay7dByTier = {};
  for (const pick of picks7d) {
    const tier = pick.tier || 'unknown';
    if (!decay7dByTier[tier]) decay7dByTier[tier] = [];
    decay7dByTier[tier].push(pick._return);
  }
  const decay7dTierTable = Object.entries(decay7dByTier).map(([tier, rets]) => ({
    tier,
    count: rets.length,
    avgReturn: round2(rets.reduce((s, v) => s + v, 0) / rets.length),
    medianReturn: round2(median(rets)),
    winRate: pct(rets.filter(r => r > 0).length, rets.length),
    stddev: round2(stddev(rets)),
  }));
  console.table(decay7dTierTable);

  // Current return stats for ALL picks (live view)
  const allWithCurrent = allPicks.filter(p => p.currentReturn != null && p.entryPrice != null && p.entryPrice > 0);
  const currentReturns = allWithCurrent.map(p => p.currentReturn);
  const decayCurrent = currentReturns.length > 0 ? {
    count: currentReturns.length,
    avgReturn: round2(currentReturns.reduce((s, v) => s + v, 0) / currentReturns.length),
    medianReturn: round2(median(currentReturns)),
    winRate: pct(currentReturns.filter(r => r > 0).length, currentReturns.length),
    stddev: round2(stddev(currentReturns)),
  } : { count: 0, avgReturn: 0, medianReturn: 0, winRate: 0, stddev: 0 };

  console.log('  Current (live) Aggregate:');
  console.table([decayCurrent]);

  // Calculate earliest pick date for 30d projection
  const entryDates = allPicks
    .filter(p => p.entryDate)
    .map(p => new Date(p.entryDate).getTime())
    .filter(t => !isNaN(t));
  const earliestEntry = entryDates.length > 0 ? new Date(Math.min(...entryDates)) : null;
  let first30dDate = null;
  if (earliestEntry) {
    first30dDate = new Date(earliestEntry.getTime() + 30 * 24 * 60 * 60 * 1000)
      .toISOString().split('T')[0];
  }

  console.log(`  30d and 90d checkpoints not yet available —`);
  console.log(`  First 30d returns expected around ${first30dDate || 'unknown'}`);
  console.log();

  // ══════════════════════════════════════════════════
  //  ANALYSIS 5: Day-of-Week Patterns
  // ══════════════════════════════════════════════════

  console.log('Running day-of-week analysis...');
  console.log();
  console.log('═══ ANALYSIS 5: DAY-OF-WEEK PATTERNS ═══');
  console.log();

  const dowBuckets = {};
  for (const pick of analysisPicks) {
    if (!pick.entryDate) continue;
    const day = dayName(pick.entryDate);
    if (day === 'Saturday' || day === 'Sunday') continue;
    if (!dowBuckets[day]) {
      dowBuckets[day] = { count: 0, winners: 0, sum: 0 };
    }
    dowBuckets[day].count++;
    if (pick._return > 0) dowBuckets[day].winners++;
    dowBuckets[day].sum += pick._return;
  }

  const dayOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];
  const dayOfWeek = dayOrder
    .filter(d => dowBuckets[d])
    .map(day => ({
      day,
      count: dowBuckets[day].count,
      winRate: pct(dowBuckets[day].winners, dowBuckets[day].count),
      avgReturn: round2(dowBuckets[day].sum / dowBuckets[day].count),
    }));

  console.table(dayOfWeek);

  // Flag outliers
  const avgWinRateAllDays = dayOfWeek.length > 0
    ? dayOfWeek.reduce((s, d) => s + d.winRate, 0) / dayOfWeek.length
    : 0;
  for (const d of dayOfWeek) {
    const diff = d.winRate - avgWinRateAllDays;
    if (Math.abs(diff) > 10) {
      console.log(`  ⚠️  ${d.day} is ${diff > 0 ? '+' : ''}${round2(diff)}pp vs average (${round2(avgWinRateAllDays)}%)`);
    }
  }
  console.log();

  // ══════════════════════════════════════════════════
  //  KEY FINDINGS
  // ══════════════════════════════════════════════════

  console.log('═══ KEY FINDINGS ═══');
  console.log();

  const findings = [];

  // Overall stats
  const overallWinRate = pct(returns7d.filter(r => r > 0).length, returns7d.length);
  const overallAvg = round2(returns7d.reduce((s, v) => s + v, 0) / returns7d.length);
  findings.push(`Overall 7d performance: ${overallWinRate}% win rate, ${overallAvg}% avg return (n=${returns7d.length})`);

  // Best/worst signal
  if (signalPerformance.length > 0) {
    const bestSig = signalPerformance[0];
    const worstSig = signalPerformance[signalPerformance.length - 1];
    findings.push(`Best signal: "${bestSig.signal}" — ${bestSig.winRate}% win, ${bestSig.avgReturn}% avg (n=${bestSig.count})`);
    findings.push(`Worst signal: "${worstSig.signal}" — ${worstSig.winRate}% win, ${worstSig.avgReturn}% avg (n=${worstSig.count})`);
  }

  // Tier inversion
  if (tierInversion) {
    findings.push(`Tier inversion confirmed in 7d data: top_pick ${topPickTier.winRate}% win vs feature ${featureTier.winRate}% win`);
  } else {
    findings.push('No tier inversion detected — higher tiers are outperforming as expected');
  }

  // Best/worst day
  if (dayOfWeek.length > 0) {
    const bestDay = [...dayOfWeek].sort((a, b) => b.winRate - a.winRate)[0];
    const worstDay = [...dayOfWeek].sort((a, b) => a.winRate - b.winRate)[0];
    findings.push(`Best day: ${bestDay.day} — ${bestDay.winRate}% win, ${bestDay.avgReturn}% avg (n=${bestDay.count})`);
    findings.push(`Worst day: ${worstDay.day} — ${worstDay.winRate}% win, ${worstDay.avgReturn}% avg (n=${worstDay.count})`);
  }

  // Best/worst price bucket
  if (priceBuckets.length > 0) {
    const bestBucket = [...priceBuckets].sort((a, b) => b.winRate - a.winRate)[0];
    const worstBucket = [...priceBuckets].sort((a, b) => a.winRate - b.winRate)[0];
    findings.push(`Best price bucket: ${bestBucket.label} — ${bestBucket.winRate}% win, ${bestBucket.avgReturn}% avg (n=${bestBucket.count})`);
    findings.push(`Worst price bucket: ${worstBucket.label} — ${worstBucket.winRate}% win, ${worstBucket.avgReturn}% avg (n=${worstBucket.count})`);
  }

  for (const f of findings) {
    console.log(`  • ${f}`);
  }
  console.log();

  // ══════════════════════════════════════════════════
  //  OUTPUT
  // ══════════════════════════════════════════════════

  const result = {
    generated: new Date().toISOString().split('T')[0],
    dataNote: `Using 7d returns (${daysBetween(earliestEntry ? earliestEntry.toISOString() : new Date().toISOString())} days of data). 30d analysis pending.`,
    picksSummary: {
      total: allPicks.length,
      with7dReturn: with7d,
      with30dReturn: with30d,
      withCurrentReturn: withCurrent,
      usableForAnalysis: analysisPicks.length,
    },
    signalPerformance,
    tierPerformance,
    priceBuckets,
    tierPriceMatrix: tierPriceJson,
    decayCurve: {
      '7d': decay7d,
      '7dByTier': decay7dTierTable,
      current: decayCurrent,
      first30dExpected: first30dDate,
    },
    dayOfWeek,
    keyFindings: findings,
  };

  // Write JSON
  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const outputPath = path.join(outputDir, 'early-scorecard-analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`Wrote ${outputPath}`);

  // Write to Redis
  console.log('Saving to Redis key meta:early-scorecard...');
  await kv.set('meta:early-scorecard', result);
  console.log('Done.');
  console.log();

  if (first30dDate) {
    console.log(`Run this script again after ${first30dDate} for 30-day return data.`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
