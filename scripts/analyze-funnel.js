/**
 * Signal-to-Outcome Funnel Analysis
 *
 * Calculates conversion rates through the full pipeline:
 *   filings scanned → above threshold → featured → tracked picks → winners
 *
 * Usage: node scripts/analyze-funnel.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const fs = require('fs');
const path = require('path');
const { getRedis } = require('../lib/redis');

const DAY_MS = 1000 * 60 * 60 * 24;

function dateRange(days) {
  const dates = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now.getTime() - i * DAY_MS);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function analyzePeriod(kv, days) {
  const dates = dateRange(days);
  const label = `${days}d`;

  let totalScanned = 0;
  let aboveThreshold = 0; // score >= 25
  let featured = 0;       // feature + top_pick + strong_signal
  const pickedTickerDates = []; // {ticker, date} combos that were featured

  // Batch: read filings:index:{date} for each date
  const batchSize = 20;
  for (let i = 0; i < dates.length; i += batchSize) {
    const batch = dates.slice(i, i + batchSize);
    const pipeline = kv.pipeline();
    for (const d of batch) {
      pipeline.zcard(`filings:index:${d}`);
    }
    const counts = await pipeline.exec();

    // Now get the actual filings for dates that have data
    const datesWithData = [];
    for (let j = 0; j < batch.length; j++) {
      const count = counts[j] || 0;
      totalScanned += count;
      if (count > 0) datesWithData.push(batch[j]);
    }

    if (datesWithData.length === 0) continue;

    const pipeline2 = kv.pipeline();
    for (const d of datesWithData) {
      pipeline2.zrange(`filings:index:${d}`, 0, -1, { withScores: true });
    }
    const results = await pipeline2.exec();

    for (let j = 0; j < datesWithData.length; j++) {
      const entries = results[j] || [];
      // Upstash returns flat array: [member, score, member, score, ...]
      for (let k = 0; k < entries.length; k += 2) {
        const member = entries[k];
        const score = Number(entries[k + 1]);

        if (score >= 25) aboveThreshold++;
        if (score >= 45) {
          featured++;
          // member format: "filing:{date}:{ticker}:{cik}"
          if (typeof member === 'string') {
            const parts = member.replace(/^filing:/, '').split(':');
            if (parts.length >= 2) {
              pickedTickerDates.push({ ticker: parts[1], date: parts[0] });
            }
          }
        }
      }
    }
  }

  // Check which featured filings became tracked picks
  // picks:index contains pick IDs like "pick:{ticker}:{date}:{cik}"
  const allPickIds = await kv.zrange('picks:index', 0, -1);
  const dateSet = new Set(dates);

  // Filter picks to this date range
  const picksInRange = allPickIds.filter(id => {
    // pick:{ticker}:{date}:{cik}
    const parts = id.replace(/^pick:/, '').split(':');
    return parts.length >= 2 && dateSet.has(parts[1]);
  });

  // Fetch pick data via pipeline
  let winners = 0;
  let losers = 0;
  let totalReturn = 0;
  let returnsCount = 0;

  if (picksInRange.length > 0) {
    const pipeline3 = kv.pipeline();
    for (const id of picksInRange) pipeline3.get(id);
    const pickData = (await pipeline3.exec()).filter(Boolean);

    for (const pick of pickData) {
      if (pick.return30d != null) {
        returnsCount++;
        totalReturn += pick.return30d;
        if (pick.return30d > 0) winners++;
        else losers++;
      }
    }
  }

  const winRate = returnsCount > 0 ? Math.round((winners / returnsCount) * 100) : null;
  const avgReturn = returnsCount > 0 ? parseFloat((totalReturn / returnsCount).toFixed(1)) : null;

  return {
    period: label,
    totalScanned,
    aboveThreshold,
    featured,
    trackedPicks: picksInRange.length,
    withReturn30d: returnsCount,
    winners,
    losers,
    winRate,
    avgReturn,
  };
}

async function main() {
  const kv = getRedis();
  if (!kv) { console.error('No Redis connection'); process.exit(1); }

  console.log('Analyzing signal-to-outcome funnel...\n');

  const [funnel30, funnel90] = await Promise.all([
    analyzePeriod(kv, 30),
    analyzePeriod(kv, 90),
  ]);

  const result = { generatedAt: new Date().toISOString(), funnel30, funnel90 };

  // Write to output/funnel.json
  const outDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'funnel.json'), JSON.stringify(result, null, 2));

  // Write to Redis
  await kv.set('meta:funnel', JSON.stringify(result));

  // Console summary
  for (const f of [funnel30, funnel90]) {
    console.log(`═══ ${f.period} Funnel ═══`);
    console.log(`  Filings scanned:    ${f.totalScanned.toLocaleString()}`);
    console.log(`  Above threshold:    ${f.aboveThreshold} (${pct(f.aboveThreshold, f.totalScanned)})`);
    console.log(`  Featured (≥45):     ${f.featured} (${pct(f.featured, f.totalScanned)})`);
    console.log(`  Tracked picks:      ${f.trackedPicks}`);
    if (f.withReturn30d > 0) {
      console.log(`  With 30d returns:   ${f.withReturn30d}`);
      console.log(`  Winners:            ${f.winners} / ${f.withReturn30d} (${f.winRate}%)`);
      console.log(`  Avg return (30d):   ${f.avgReturn > 0 ? '+' : ''}${f.avgReturn}%`);
    } else {
      console.log(`  (no 30d return data yet)`);
    }
    console.log();
  }

  console.log('Wrote output/funnel.json + meta:funnel');
}

function pct(part, whole) {
  if (!whole) return '0%';
  return (part / whole * 100).toFixed(1) + '%';
}

main().catch(err => { console.error(err); process.exit(1); });
