#!/usr/bin/env node
/**
 * Analyze Conviction Intensity
 *
 * Tests whether conviction intensity (buyValue / marketCap) correlates
 * with returns better than raw purchase size.
 *
 * Requires company profiles cached in Redis (run backfill-company-profiles.js first).
 *
 * Usage: node scripts/analyze-conviction-intensity.js
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

function bucketStats(values) {
  if (!values.length) return { count: 0, winRate: null, avgReturn: null, medianReturn: null };
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const wins = values.filter(v => v > 0).length;
  return {
    count: values.length,
    winRate: round2((wins / values.length) * 100),
    avgReturn: round2(avg),
    medianReturn: round2(median(values)),
  };
}

/**
 * Pearson correlation coefficient with two-tailed p-value approximation.
 */
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return { r: null, pValue: null, n };

  let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i];
    sumY += ys[i];
    sumXY += xs[i] * ys[i];
    sumX2 += xs[i] * xs[i];
    sumY2 += ys[i] * ys[i];
  }

  const num = n * sumXY - sumX * sumY;
  const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));
  if (den === 0) return { r: 0, pValue: 1, n };

  const r = num / den;

  // t-statistic for significance
  const t = r * Math.sqrt((n - 2) / (1 - r * r));
  const df = n - 2;
  // Approximate two-tailed p-value using t-distribution via beta incomplete function approx
  const pValue = approxPValue(Math.abs(t), df);

  return { r: round2(r), pValue: round2(pValue), n };
}

/**
 * Rough p-value approximation for t-distribution.
 * Uses the normal approximation for large df, exact-ish for small df.
 */
function approxPValue(t, df) {
  // For large df, use normal approximation
  if (df > 100) {
    const z = t;
    // Standard normal CDF approximation (Abramowitz & Stegun 26.2.17)
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
    const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
    const x = Math.abs(z) / Math.SQRT2;
    const tt = 1 / (1 + p * x);
    const phi = 1 - (((((a5 * tt + a4) * tt) + a3) * tt + a2) * tt + a1) * tt * Math.exp(-x * x);
    return 2 * (1 - phi);
  }
  // For smaller df, use incomplete beta regularized approximation
  const x = df / (df + t * t);
  return betaIncomplete(x, df / 2, 0.5);
}

/**
 * Regularized incomplete beta function (simple continued fraction).
 */
function betaIncomplete(x, a, b) {
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;
  // Lentz's continued fraction
  let f = 1, c = 1, d = 1 - (a + b) * x / (a + 1);
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d; f = d;
  for (let m = 1; m <= 200; m++) {
    let num = m * (b - m) * x / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    f *= d * c;
    num = -(a + m) * (a + b + m) * x / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d; if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d;
    c = 1 + num / c; if (Math.abs(c) < 1e-30) c = 1e-30;
    const delta = d * c;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-10) break;
  }
  return front * f;
}

function lnGamma(z) {
  // Lanczos approximation
  const g = 7;
  const coef = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z);
  z -= 1;
  let x = coef[0];
  for (let i = 1; i < g + 2; i++) x += coef[i] / (z + i);
  const t = z + g + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// ── Intensity buckets ────────────────────────────────────────────────

function intensityBucket(pct) {
  if (pct >= 0.1)   return 'high';    // >= 0.1% of market cap
  if (pct >= 0.01)  return 'medium';  // 0.01% - 0.099%
  if (pct >= 0.001) return 'low';     // 0.001% - 0.0099%
  return 'noise';                     // < 0.001%
}

function dollarBucket(val) {
  if (val >= 500000) return 'large';   // >= $500K
  if (val >= 100000) return 'medium';  // $100K - $499K
  if (val >= 10000)  return 'small';   // $10K - $99K
  return 'tiny';                       // < $10K
}

// ── Main ─────────────────────────────────────────────────────────────

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

  console.log(`Loaded ${picks.length} valid picks\n`);

  // 3. Load company profiles for market cap
  const tickers = [...new Set(picks.map(p => p.ticker))];
  console.log(`Loading company profiles for ${tickers.length} unique tickers...`);

  const companyMap = {};
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    const pipeline = r.pipeline();
    for (const ticker of batch) pipeline.get(`company:${ticker}`);
    const results = await pipeline.exec();

    for (let j = 0; j < batch.length; j++) {
      const data = results[j];
      if (!data) continue;
      const profile = typeof data === 'string' ? JSON.parse(data) : data;
      if (profile && profile.marketCap) {
        companyMap[batch[j]] = profile.marketCap;
      }
    }
  }

  const foundCount = Object.keys(companyMap).length;
  const missingTickers = tickers.filter(t => !companyMap[t]);
  console.log(`Found market cap for ${foundCount}/${tickers.length} tickers`);
  if (missingTickers.length) {
    console.log(`Missing market cap (${missingTickers.length}): ${missingTickers.slice(0, 20).join(', ')}${missingTickers.length > 20 ? '...' : ''}`);
  }
  console.log();

  // 4. Calculate conviction intensity for each pick
  const enriched = [];
  let skippedNoBuy = 0, skippedNoCap = 0, skippedNoReturn = 0;

  for (const pick of picks) {
    const buyValue = pick.buyValue;
    const ret = getUsableReturn(pick);

    if (!buyValue || buyValue <= 0) { skippedNoBuy++; continue; }

    const marketCap = companyMap[pick.ticker]; // in millions from Finnhub
    if (!marketCap || marketCap <= 0) { skippedNoCap++; continue; }

    // convictionIntensity as % of market cap
    // marketCap from Finnhub is in millions, buyValue is in dollars
    const intensity = (buyValue / (marketCap * 1_000_000)) * 100;

    if (ret === null) { skippedNoReturn++; continue; }

    enriched.push({
      id: pick.id,
      ticker: pick.ticker,
      ownerName: pick.ownerName,
      buyValue,
      marketCap,
      convictionIntensity: intensity,
      return: ret,
      tier: pick.tier,
      entryDate: pick.entryDate,
      score: pick.score,
    });
  }

  console.log(`Enriched ${enriched.length} picks with conviction intensity`);
  console.log(`Skipped: ${skippedNoBuy} no buyValue, ${skippedNoCap} no marketCap, ${skippedNoReturn} no return\n`);

  if (!enriched.length) {
    console.log('No picks with all required data. Exiting.');
    process.exit(0);
  }

  // 5. Intensity bucket analysis
  const intensityBuckets = { high: [], medium: [], low: [], noise: [] };
  for (const p of enriched) {
    intensityBuckets[intensityBucket(p.convictionIntensity)].push(p.return);
  }

  const intensityResults = ['high', 'medium', 'low', 'noise'].map(bucket => ({
    bucket,
    label: bucket === 'high' ? '>= 0.1%' : bucket === 'medium' ? '0.01-0.099%' :
           bucket === 'low' ? '0.001-0.0099%' : '< 0.001%',
    ...bucketStats(intensityBuckets[bucket]),
  }));

  // 6. Dollar bucket analysis (comparison)
  const dollarBuckets = { large: [], medium: [], small: [], tiny: [] };
  for (const p of enriched) {
    dollarBuckets[dollarBucket(p.buyValue)].push(p.return);
  }

  const dollarResults = ['large', 'medium', 'small', 'tiny'].map(bucket => ({
    bucket,
    label: bucket === 'large' ? '>= $500K' : bucket === 'medium' ? '$100K-$499K' :
           bucket === 'small' ? '$10K-$99K' : '< $10K',
    ...bucketStats(dollarBuckets[bucket]),
  }));

  // 7. Pearson correlations
  const xs_intensity = enriched.map(p => p.convictionIntensity);
  const xs_dollar = enriched.map(p => p.buyValue);
  const ys = enriched.map(p => p.return);

  const corrIntensity = pearson(xs_intensity, ys);
  const corrDollar = pearson(xs_dollar, ys);

  // 8. Top conviction picks
  const topConviction = [...enriched]
    .sort((a, b) => b.convictionIntensity - a.convictionIntensity)
    .slice(0, 10)
    .map(p => ({
      ticker: p.ticker,
      ownerName: p.ownerName,
      buyValue: p.buyValue,
      marketCapM: p.marketCap,
      convictionIntensity: round2(p.convictionIntensity),
      return: round2(p.return),
      entryDate: p.entryDate,
      tier: p.tier,
    }));

  // 9. Recommendation
  const absR_intensity = Math.abs(corrIntensity.r || 0);
  const absR_dollar = Math.abs(corrDollar.r || 0);
  const better = absR_intensity > absR_dollar ? 'better' : 'worse';
  const recommend = absR_intensity > absR_dollar && absR_intensity > 0.1;

  const recommendation =
    `Conviction intensity correlates ${better} with returns than raw dollar amount ` +
    `(r=${corrIntensity.r} vs r=${corrDollar.r}). ` +
    `${recommend ? 'Recommend' : 'Do not recommend'} adding as a scoring dimension.`;

  // ── Console report ──────────────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════════');
  console.log('  CONVICTION INTENSITY ANALYSIS');
  console.log('═══════════════════════════════════════════════════════\n');

  console.log('Intensity Buckets (buyValue / marketCap):');
  console.log('─────────────────────────────────────────────────────');
  console.log('Bucket         │ Count │ Win Rate │ Avg Return │ Median');
  console.log('───────────────┼───────┼──────────┼────────────┼───────');
  for (const b of intensityResults) {
    const cnt = String(b.count).padStart(5);
    const wr = b.winRate !== null ? `${b.winRate}%`.padStart(7) : '   n/a';
    const ar = b.avgReturn !== null ? `${b.avgReturn > 0 ? '+' : ''}${b.avgReturn}%`.padStart(9) : '      n/a';
    const mr = b.medianReturn !== null ? `${b.medianReturn > 0 ? '+' : ''}${b.medianReturn}%`.padStart(7) : '   n/a';
    console.log(`${(b.bucket + ' (' + b.label + ')').padEnd(15)}│${cnt} │${wr}  │${ar}  │${mr}`);
  }

  console.log('\nDollar Buckets (raw purchase size):');
  console.log('─────────────────────────────────────────────────────');
  console.log('Bucket         │ Count │ Win Rate │ Avg Return │ Median');
  console.log('───────────────┼───────┼──────────┼────────────┼───────');
  for (const b of dollarResults) {
    const cnt = String(b.count).padStart(5);
    const wr = b.winRate !== null ? `${b.winRate}%`.padStart(7) : '   n/a';
    const ar = b.avgReturn !== null ? `${b.avgReturn > 0 ? '+' : ''}${b.avgReturn}%`.padStart(9) : '      n/a';
    const mr = b.medianReturn !== null ? `${b.medianReturn > 0 ? '+' : ''}${b.medianReturn}%`.padStart(7) : '   n/a';
    console.log(`${(b.bucket + ' (' + b.label + ')').padEnd(15)}│${cnt} │${wr}  │${ar}  │${mr}`);
  }

  console.log('\nCorrelation Analysis:');
  console.log('─────────────────────────────────────────────────────');
  console.log(`Conviction intensity vs return: r=${corrIntensity.r}, p=${corrIntensity.pValue}, n=${corrIntensity.n}`);
  console.log(`Raw dollar value vs return:     r=${corrDollar.r}, p=${corrDollar.pValue}, n=${corrDollar.n}`);

  console.log('\nTop 10 Picks by Conviction Intensity:');
  console.log('─────────────────────────────────────────────────────');
  for (const p of topConviction) {
    const retStr = p.return > 0 ? `+${p.return}%` : `${p.return}%`;
    console.log(`  ${p.ticker.padEnd(6)} ${p.convictionIntensity}% of mktcap | $${(p.buyValue / 1000).toFixed(0)}K buy, $${p.marketCapM.toFixed(0)}M cap | ${retStr} | ${p.ownerName}`);
  }

  console.log('\n' + recommendation);
  console.log();

  // 10. Write results
  const output = {
    generated: new Date().toISOString(),
    totalPicks: picks.length,
    analyzedPicks: enriched.length,
    intensityBuckets: intensityResults,
    dollarBuckets: dollarResults,
    correlations: {
      intensityVsReturn: corrIntensity,
      dollarVsReturn: corrDollar,
    },
    recommendation,
    topConvictionPicks: topConviction,
  };

  // Write to file
  const outDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'conviction-intensity.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Written to ${outPath}`);

  // Write to Redis
  await r.set('meta:conviction-intensity', JSON.stringify(output));
  console.log('Written to Redis key meta:conviction-intensity');

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
