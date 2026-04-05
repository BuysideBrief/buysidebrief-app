#!/usr/bin/env node
/**
 * Sector Heatmap Analysis
 *
 * Groups all insider filings and picks by sector to show where insider
 * money is flowing. Produces a full breakdown of filing volume, buy
 * dollar volume, win rates, and week-over-week rotation signals.
 *
 * Requires company profiles cached in Redis (run backfill-company-profiles.js first).
 *
 * Usage: node scripts/analyze-sector-heatmap.js
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

function fmtNum(n) {
  if (n == null) return 'n/a';
  return n.toLocaleString();
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

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  const r = getRedis();
  if (!r) {
    console.error('Redis not available. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
    process.exit(1);
  }

  console.log('═══════════════════════════════════════════════════════');
  console.log('  SECTOR HEATMAP ANALYSIS');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Step 1: SCAN all filing:* keys ─────────────────────────────────
  console.log('Scanning filing:* keys...');
  const filingKeys = [];
  let cursor = '0';
  do {
    const [nextCursor, keys] = await r.scan(cursor, { match: 'filing:*', count: 200 });
    cursor = nextCursor;
    filingKeys.push(...keys);
  } while (cursor !== '0' && cursor !== 0);
  console.log(`  Found ${filingKeys.length} filing keys\n`);

  if (!filingKeys.length) {
    console.log('No filings found. Run the pipeline first.');
    return;
  }

  // ── Step 2: Batch-fetch filing records ─────────────────────────────
  console.log('Loading filing records...');
  const BATCH = 100;
  const filings = [];

  for (let i = 0; i < filingKeys.length; i += BATCH) {
    const batch = filingKeys.slice(i, i + BATCH);
    const pipeline = r.pipeline();
    for (const key of batch) pipeline.get(key);
    const results = await pipeline.exec();

    for (let j = 0; j < results.length; j++) {
      let raw = results[j];
      if (!raw) continue;
      try {
        const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
        // Extract ticker from key as fallback
        if (!record.ticker) {
          const parts = batch[j].split(':');
          if (parts.length >= 3) record.ticker = parts[2].toUpperCase();
        }
        filings.push(record);
      } catch (e) {
        // skip unparseable
      }
    }

    if ((i + BATCH) % 500 === 0 || i + BATCH >= filingKeys.length) {
      console.log(`  ...loaded ${Math.min(i + BATCH, filingKeys.length)}/${filingKeys.length}`);
    }
  }
  console.log(`  Parsed ${filings.length} filing records\n`);

  // ── Step 3: Look up sectors for unique tickers ─────────────────────
  const uniqueTickers = [...new Set(filings.map(f => (f.ticker || '').toUpperCase()).filter(Boolean))];
  console.log(`Looking up sectors for ${uniqueTickers.length} unique tickers...`);

  const sectorMap = {}; // ticker → { sector, industry }
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
        sectorMap[batch[j]] = {
          sector: profile.sector || profile.finnhubIndustry || 'Unknown',
          industry: profile.finnhubIndustry || profile.industry || null,
        };
      } catch (e) {
        // skip
      }
    }
  }

  const mappedCount = Object.keys(sectorMap).length;
  console.log(`  Mapped ${mappedCount}/${uniqueTickers.length} tickers to sectors\n`);

  // ── Step 4: Group filings by sector ────────────────────────────────
  console.log('Grouping filings by sector...');
  const sectorFilings = {}; // sector → { filings, tickers, insiders, buyVolume, scoreSum, ... }
  const now = new Date();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const fourteenDaysAgo = new Date(now - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const unknownTickers = new Set();
  let dateMin = null;
  let dateMax = null;

  for (const f of filings) {
    const ticker = (f.ticker || '').toUpperCase();
    const lookup = sectorMap[ticker];
    const sector = lookup ? lookup.sector : 'Unknown';

    if (sector === 'Unknown') unknownTickers.add(ticker);

    if (!sectorFilings[sector]) {
      sectorFilings[sector] = {
        filingCount: 0,
        buyCount: 0,
        totalBuyVolume: 0,
        scoreSum: 0,
        tickers: new Set(),
        insiders: new Set(),
        last7: 0,
        prev7: 0,
      };
    }

    const s = sectorFilings[sector];
    s.filingCount++;
    s.scoreSum += f.score || 0;
    s.tickers.add(ticker);
    if (f.ownerCik) s.insiders.add(String(f.ownerCik));

    const buys = f.buyCount || f.buyShares || 0;
    if (buys > 0 || (f.buyValue && f.buyValue > 0)) {
      s.buyCount++;
      s.totalBuyVolume += f.buyValue || 0;
    }

    // Week-over-week filing counts
    const filingDate = f.date || '';
    if (filingDate >= sevenDaysAgo) s.last7++;
    else if (filingDate >= fourteenDaysAgo) s.prev7++;

    // Track date range
    if (filingDate && (!dateMin || filingDate < dateMin)) dateMin = filingDate;
    if (filingDate && (!dateMax || filingDate > dateMax)) dateMax = filingDate;
  }

  // ── Step 5: Load picks and group by sector ─────────────────────────
  console.log('Loading picks from picks:index...');
  const pickIds = await r.zrange('picks:index', 0, -1);
  console.log(`  Found ${pickIds.length} pick IDs`);

  const sectorPicks = {}; // sector → returns[]

  if (pickIds.length > 0) {
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
          const ticker = (pick.ticker || '').toUpperCase();
          const lookup = sectorMap[ticker];
          const sector = lookup ? lookup.sector : 'Unknown';

          if (!sectorPicks[sector]) sectorPicks[sector] = [];

          const ret = getUsableReturn(pick);
          if (ret !== null) {
            sectorPicks[sector].push(ret);
          }
        } catch (e) {
          // skip
        }
      }
    }
  }

  console.log('');

  // ── Step 6: Merge filing + pick data ───────────────────────────────
  console.log('Building sector summaries...');
  const sectors = [];

  for (const [sector, data] of Object.entries(sectorFilings)) {
    const avgScore = data.filingCount > 0 ? round2(data.scoreSum / data.filingCount) : 0;
    const uniqueTickerCount = data.tickers.size;
    const insiderIntensity = uniqueTickerCount > 0
      ? Math.round(data.totalBuyVolume / uniqueTickerCount)
      : 0;

    // Week-over-week change
    let weekOverWeekChange = null;
    if (data.prev7 > 0) {
      weekOverWeekChange = round2(((data.last7 - data.prev7) / data.prev7) * 100);
    } else if (data.last7 > 0) {
      weekOverWeekChange = 100; // new activity
    }

    // Pick stats for this sector
    const returns = sectorPicks[sector] || [];
    const pickCount = returns.length;
    let winRate = null;
    let avgReturn = null;
    let medianReturn = null;

    if (pickCount > 0) {
      const wins = returns.filter(r => r > 0).length;
      winRate = round2((wins / pickCount) * 100);
      avgReturn = round2(returns.reduce((s, v) => s + v, 0) / pickCount);
      medianReturn = round2(median(returns));
    }

    sectors.push({
      sector,
      filingCount: data.filingCount,
      buyCount: data.buyCount,
      totalBuyVolume: data.totalBuyVolume,
      avgScore,
      uniqueTickers: uniqueTickerCount,
      uniqueInsiders: data.insiders.size,
      pickCount,
      winRate,
      avgReturn,
      medianReturn,
      insiderIntensity,
      weekOverWeekChange: weekOverWeekChange !== null
        ? `${weekOverWeekChange > 0 ? '+' : ''}${weekOverWeekChange}%`
        : 'n/a',
    });
  }

  // Sort by total buy volume descending
  sectors.sort((a, b) => b.totalBuyVolume - a.totalBuyVolume);

  // ── Step 7: Industry breakdown for top 3 sectors by filing volume ──
  console.log('Computing industry breakdowns for top sectors...');
  const topByVolume = [...sectors]
    .filter(s => s.sector !== 'Unknown')
    .sort((a, b) => b.filingCount - a.filingCount)
    .slice(0, 3)
    .map(s => s.sector);

  const topIndustries = {};

  for (const targetSector of topByVolume) {
    const industryMap = {}; // industry → { count, volume }

    for (const f of filings) {
      const ticker = (f.ticker || '').toUpperCase();
      const lookup = sectorMap[ticker];
      if (!lookup || lookup.sector !== targetSector) continue;

      const industry = lookup.industry || 'Other';
      if (!industryMap[industry]) industryMap[industry] = { industry, count: 0, volume: 0 };
      industryMap[industry].count++;
      industryMap[industry].volume += f.buyValue || 0;
    }

    topIndustries[targetSector] = Object.values(industryMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
  }

  // ── Step 8: Unknown sector details ─────────────────────────────────
  const unknownSector = {
    count: unknownTickers.size,
    tickers: [...unknownTickers].sort(),
  };

  // ── Step 9: Output ─────────────────────────────────────────────────

  const result = {
    generated: new Date().toISOString(),
    period: { from: dateMin || 'unknown', to: dateMax || 'unknown' },
    bySector: sectors,
    topIndustries,
    unknownSector,
  };

  // Write JSON file
  const outputDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, 'sector-heatmap.json');
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${outputPath}`);

  // Store in Redis
  await r.set('meta:sector-heatmap', JSON.stringify(result));
  console.log('Stored meta:sector-heatmap in Redis\n');

  // ── Console table ──────────────────────────────────────────────────

  console.log('═══════════════════════════════════════════════════════════════════════════════════════════');
  console.log('  SECTOR HEATMAP — sorted by total buy volume');
  console.log(`  Period: ${dateMin || '?'} → ${dateMax || '?'}`);
  console.log('═══════════════════════════════════════════════════════════════════════════════════════════\n');

  const hdr = [
    'Sector'.padEnd(20),
    'Filings'.padStart(8),
    'Buys'.padStart(7),
    'Buy Volume'.padStart(12),
    'Avg Score'.padStart(10),
    'Tickers'.padStart(8),
    'Insiders'.padStart(9),
    'Picks'.padStart(6),
    'Win%'.padStart(6),
    'Avg Ret'.padStart(8),
    'Intensity'.padStart(12),
    'WoW'.padStart(8),
  ];
  console.log(hdr.join(' │ '));
  console.log('─'.repeat(hdr.join(' │ ').length));

  for (const s of sectors) {
    const row = [
      (s.sector || 'Unknown').slice(0, 20).padEnd(20),
      String(s.filingCount).padStart(8),
      String(s.buyCount).padStart(7),
      fmtDollar(s.totalBuyVolume).padStart(12),
      String(s.avgScore).padStart(10),
      String(s.uniqueTickers).padStart(8),
      String(s.uniqueInsiders).padStart(9),
      String(s.pickCount).padStart(6),
      (s.winRate !== null ? `${s.winRate}%` : 'n/a').padStart(6),
      (s.avgReturn !== null ? fmtPct(s.avgReturn) : 'n/a').padStart(8),
      fmtDollar(s.insiderIntensity).padStart(12),
      String(s.weekOverWeekChange).padStart(8),
    ];
    console.log(row.join(' │ '));
  }

  // Industry breakdown
  if (Object.keys(topIndustries).length > 0) {
    console.log('\n───────────────────────────────────────────────────────');
    console.log('  INDUSTRY BREAKDOWN (top 3 sectors by filing volume)');
    console.log('───────────────────────────────────────────────────────\n');

    for (const [sector, industries] of Object.entries(topIndustries)) {
      const totalCount = industries.reduce((s, i) => s + i.count, 0);
      console.log(`  ${sector}:`);
      for (const ind of industries) {
        const pct = totalCount > 0 ? round2((ind.count / totalCount) * 100) : 0;
        console.log(`    ${ind.industry.padEnd(30)} ${String(ind.count).padStart(5)} filings (${pct}%)  ${fmtDollar(ind.volume).padStart(10)} buy vol`);
      }
      console.log('');
    }
  }

  // Unknown sector
  if (unknownSector.count > 0) {
    console.log('───────────────────────────────────────────────────────');
    console.log(`  UNKNOWN SECTOR: ${unknownSector.count} tickers without profiles`);
    console.log('───────────────────────────────────────────────────────');
    // Show in chunks of 10 per line
    const tickers = unknownSector.tickers;
    for (let i = 0; i < tickers.length; i += 10) {
      console.log('  ' + tickers.slice(i, i + 10).join(', '));
    }
    console.log('');
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
