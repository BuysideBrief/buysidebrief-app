#!/usr/bin/env node
/**
 * Analyze Filing Volume vs. S&P 500 Performance
 *
 * Correlates daily insider-buy filing volume with SPY returns
 * (same-day, forward 5-day, forward 20-day). Uses SCAN for
 * production-safe key discovery.
 *
 * Usage: node scripts/analyze-filing-volume.js
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getRedis } = require('../lib/redis');

const MIN_DATAPOINTS = 30;

// ── Math helpers ────────────────────────────────────────────────────

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

function round4(n) {
  return n === null ? null : Math.round(n * 10000) / 10000;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function quartileSplit(series, field) {
  const sorted = [...series].sort((a, b) => a[field] - b[field]);
  const q1 = Math.floor(sorted.length * 0.25);
  const q3 = Math.floor(sorted.length * 0.75);
  return {
    bottom: sorted.slice(0, q1),
    top: sorted.slice(q3),
  };
}

function rollingAvg(series, window) {
  const out = [];
  for (let i = 0; i < series.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = series.slice(start, i + 1).map(d => d.filingCount);
    out.push({ ...series[i], smoothedCount: avg(slice) });
  }
  return out;
}

// ── SCAN helper ─────────────────────────────────────────────────────

async function scanKeys(r, pattern) {
  const keys = [];
  let cursor = 0;
  do {
    const result = await r.scan(cursor, { match: pattern, count: 200 });
    cursor = result[0];
    if (result[1].length) keys.push(...result[1]);
  } while (cursor !== 0 && cursor !== '0');
  return keys;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const r = getRedis();
  if (!r) {
    console.error('Redis not available. Check env vars.');
    process.exit(1);
  }

  // 1. Discover filing index keys via SCAN
  console.log('Scanning for filings:index:* keys...');
  const indexKeys = await scanKeys(r, 'filings:index:*');
  console.log(`Found ${indexKeys.length} daily filing index keys`);

  if (!indexKeys.length) {
    console.log('No filing index keys found. Exiting.');
    process.exit(0);
  }

  // 2. Extract dates and get filing counts + SPY prices
  const dateMap = {};
  for (const key of indexKeys) {
    const date = key.replace('filings:index:', '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    dateMap[date] = { key };
  }

  const dates = Object.keys(dateMap).sort();
  console.log(`Processing ${dates.length} dates from ${dates[0]} to ${dates[dates.length - 1]}`);

  // Batch fetch filing counts via ZCARD
  console.log('Fetching filing counts...');
  const BATCH = 50;
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const pipeline = r.pipeline();
    for (const d of batch) pipeline.zcard(dateMap[d].key);
    const counts = await pipeline.exec();
    batch.forEach((d, j) => {
      dateMap[d].filingCount = counts[j] || 0;
    });
    if (i + BATCH < dates.length) {
      console.log(`  ...counted ${Math.min(i + BATCH, dates.length)}/${dates.length}`);
    }
  }

  // Batch fetch SPY prices
  console.log('Fetching SPY prices...');
  for (let i = 0; i < dates.length; i += BATCH) {
    const batch = dates.slice(i, i + BATCH);
    const pipeline = r.pipeline();
    for (const d of batch) pipeline.get(`meta:sp500:${d}`);
    const prices = await pipeline.exec();
    batch.forEach((d, j) => {
      const raw = prices[j];
      if (raw !== null && raw !== undefined) {
        const val = typeof raw === 'string' ? JSON.parse(raw) : raw;
        dateMap[d].spyClose = typeof val === 'number' ? val : (val && val.close) || null;
      } else {
        dateMap[d].spyClose = null;
      }
    });
  }

  // 3. Build time series
  const series = [];
  let prevClose = null;

  for (const date of dates) {
    const d = dateMap[date];
    const spyClose = d.spyClose;
    let spyReturn = null;
    if (spyClose !== null && prevClose !== null && prevClose !== 0) {
      spyReturn = ((spyClose - prevClose) / prevClose) * 100;
    }
    series.push({
      date,
      filingCount: d.filingCount,
      spyClose,
      spyReturn: spyReturn !== null ? round4(spyReturn) : null,
    });
    if (spyClose !== null) prevClose = spyClose;
  }

  // Add forward returns (5-day and 20-day)
  for (let i = 0; i < series.length; i++) {
    const cur = series[i];
    if (cur.spyClose === null) {
      cur.fwd5dReturn = null;
      cur.fwd20dReturn = null;
      continue;
    }

    // Find the next trading day at offset N with a valid close
    const findFwd = (offset) => {
      let found = 0;
      for (let j = i + 1; j < series.length && found < offset; j++) {
        if (series[j].spyClose !== null) found++;
        if (found === offset) return series[j].spyClose;
      }
      return null;
    };

    const fwd5 = findFwd(5);
    const fwd20 = findFwd(20);
    cur.fwd5dReturn = fwd5 !== null ? round4(((fwd5 - cur.spyClose) / cur.spyClose) * 100) : null;
    cur.fwd20dReturn = fwd20 !== null ? round4(((fwd20 - cur.spyClose) / cur.spyClose) * 100) : null;
  }

  // Filter to rows with valid data for each analysis
  const withReturn = series.filter(d => d.spyReturn !== null);
  const withFwd5 = series.filter(d => d.fwd5dReturn !== null);
  const withFwd20 = series.filter(d => d.fwd20dReturn !== null);

  console.log(`\nTime series built: ${series.length} total, ${withReturn.length} with same-day return, ` +
    `${withFwd5.length} with fwd-5d, ${withFwd20.length} with fwd-20d`);

  if (withReturn.length < MIN_DATAPOINTS) {
    console.warn(`\nWARNING: Only ${withReturn.length} data points available. ` +
      `Minimum recommended: ${MIN_DATAPOINTS}. Correlations may not be statistically meaningful.`);
  }

  // 4. Correlations
  console.log('\n=== Correlation Analysis ===\n');

  const corrSameDay = pearson(
    withReturn.map(d => d.filingCount),
    withReturn.map(d => d.spyReturn)
  );
  console.log(`Filing count vs. same-day SPY return:   r = ${round4(corrSameDay)} (n=${withReturn.length})`);

  const corrFwd5 = pearson(
    withFwd5.map(d => d.filingCount),
    withFwd5.map(d => d.fwd5dReturn)
  );
  console.log(`Filing count vs. fwd 5-day SPY return:  r = ${round4(corrFwd5)} (n=${withFwd5.length})`);

  const corrFwd20 = pearson(
    withFwd20.map(d => d.filingCount),
    withFwd20.map(d => d.fwd20dReturn)
  );
  console.log(`Filing count vs. fwd 20-day SPY return: r = ${round4(corrFwd20)} (n=${withFwd20.length})`);

  // 5. Up-day vs. down-day filing count
  const upDays = withReturn.filter(d => d.spyReturn > 0);
  const downDays = withReturn.filter(d => d.spyReturn <= 0);
  const avgFilingsUp = round2(avg(upDays.map(d => d.filingCount)));
  const avgFilingsDown = round2(avg(downDays.map(d => d.filingCount)));

  console.log(`\nAvg filings on SPY up-days:   ${avgFilingsUp} (n=${upDays.length})`);
  console.log(`Avg filings on SPY down-days: ${avgFilingsDown} (n=${downDays.length})`);

  // 6. High-volume vs. low-volume forward returns
  let highVolFwd5 = null, lowVolFwd5 = null;
  if (withFwd5.length >= 8) {
    const { top, bottom } = quartileSplit(withFwd5, 'filingCount');
    highVolFwd5 = round4(avg(top.map(d => d.fwd5dReturn)));
    lowVolFwd5 = round4(avg(bottom.map(d => d.fwd5dReturn)));
    console.log(`\nAvg fwd-5d return after HIGH-volume days (top quartile): ${highVolFwd5}% (n=${top.length})`);
    console.log(`Avg fwd-5d return after LOW-volume days (bottom quartile): ${lowVolFwd5}% (n=${bottom.length})`);
  }

  // 7. Rolling 5-day smoothed filing count correlations
  console.log('\n=== Smoothed (5-day rolling avg) ===\n');
  const smoothed = rollingAvg(series, 5);
  const smoothedWithFwd5 = smoothed.filter(d => d.fwd5dReturn !== null);
  const smoothedWithFwd20 = smoothed.filter(d => d.fwd20dReturn !== null);

  const corrSmoothedFwd5 = pearson(
    smoothedWithFwd5.map(d => d.smoothedCount),
    smoothedWithFwd5.map(d => d.fwd5dReturn)
  );
  console.log(`Smoothed filing count vs. fwd 5-day SPY:  r = ${round4(corrSmoothedFwd5)} (n=${smoothedWithFwd5.length})`);

  const corrSmoothedFwd20 = pearson(
    smoothedWithFwd20.map(d => d.smoothedCount),
    smoothedWithFwd20.map(d => d.fwd20dReturn)
  );
  console.log(`Smoothed filing count vs. fwd 20-day SPY: r = ${round4(corrSmoothedFwd20)} (n=${smoothedWithFwd20.length})`);

  // 8. Build output
  const output = {
    generatedAt: new Date().toISOString(),
    dataPoints: series.length,
    dateRange: { from: dates[0], to: dates[dates.length - 1] },
    belowMinimumSampleSize: withReturn.length < MIN_DATAPOINTS,
    correlations: {
      sameDaySPY: { r: round4(corrSameDay), n: withReturn.length },
      fwd5dSPY: { r: round4(corrFwd5), n: withFwd5.length },
      fwd20dSPY: { r: round4(corrFwd20), n: withFwd20.length },
      smoothed5dFwd5dSPY: { r: round4(corrSmoothedFwd5), n: smoothedWithFwd5.length },
      smoothed5dFwd20dSPY: { r: round4(corrSmoothedFwd20), n: smoothedWithFwd20.length },
    },
    filingsByMarketDirection: {
      avgFilingsOnUpDays: avgFilingsUp,
      upDayCount: upDays.length,
      avgFilingsOnDownDays: avgFilingsDown,
      downDayCount: downDays.length,
    },
    quartileAnalysis: {
      highVolumeFwd5dReturn: highVolFwd5,
      lowVolumeFwd5dReturn: lowVolFwd5,
    },
    timeSeries: series,
  };

  // Write to file
  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outPath = path.join(outDir, 'filing-volume-analysis.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);

  // Write to Redis (without the full time series to keep it lean)
  const redisSummary = { ...output };
  delete redisSummary.timeSeries;
  await r.set('meta:filing-volume', JSON.stringify(redisSummary));
  console.log('Wrote meta:filing-volume to Redis');

  // Summary
  console.log('\n=== Key Findings ===');
  const interpret = (r) => {
    if (r === null) return 'insufficient data';
    const abs = Math.abs(r);
    if (abs < 0.1) return 'negligible';
    if (abs < 0.3) return 'weak';
    if (abs < 0.5) return 'moderate';
    return 'strong';
  };
  console.log(`Same-day correlation:  ${interpret(corrSameDay)} (${round4(corrSameDay)})`);
  console.log(`Fwd 5-day correlation: ${interpret(corrFwd5)} (${round4(corrFwd5)})`);
  console.log(`Fwd 20-day correlation: ${interpret(corrFwd20)} (${round4(corrFwd20)})`);
  if (highVolFwd5 !== null && lowVolFwd5 !== null) {
    const spread = round4(highVolFwd5 - lowVolFwd5);
    console.log(`High-vs-low volume 5-day return spread: ${spread > 0 ? '+' : ''}${spread}%`);
  }

  console.log('\nDone.');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
