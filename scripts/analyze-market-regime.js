/**
 * Market Regime Analysis
 *
 * Classifies each pick's entry date by S&P 500 trailing 20-trading-day
 * return and correlates with pick performance. Calculates excess returns
 * (pick return minus SPY return over same window) to isolate alpha.
 *
 * Usage: node scripts/analyze-market-regime.js
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

function pct(n, d) {
  return d === 0 ? 0 : Math.round((n / d) * 10000) / 100;
}

function daysBetween(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Get usable return for a pick — prefers return7d, falls back to
 * currentReturn if pick is at least 5 days old.
 */
function getUsableReturn(pick) {
  if (pick.return7d != null) return parseFloat(pick.return7d);
  if (pick.currentReturn != null && pick.entryDate) {
    const age = daysBetween(pick.entryDate);
    if (age >= 5) return parseFloat(pick.currentReturn);
  }
  return null;
}

/**
 * Classify regime based on trailing 20-trading-day return.
 */
function classifyRegime(trailingReturn) {
  if (trailingReturn > 3) return 'bull';
  if (trailingReturn >= -3) return 'flat';
  if (trailingReturn >= -10) return 'correction';
  return 'drawdown';
}

// ── SPY Data Loading ─────────────────────────────────

/**
 * Fetch SPY daily closes from Yahoo Finance (no API key needed).
 * Returns array of { date, close } sorted oldest-first.
 */
async function fetchSpyFromYahoo() {
  const now = Math.floor(Date.now() / 1000);
  const oneYearAgo = now - 365 * 24 * 60 * 60;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/SPY?period1=${oneYearAgo}&period2=${now}&interval=1d`;

  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);
  const data = await res.json();

  const result = data?.chart?.result?.[0];
  if (!result) throw new Error('No chart data in Yahoo response');

  const timestamps = result.timestamp || [];
  const closes = result.indicators?.quote?.[0]?.close || [];

  const entries = [];
  for (let i = 0; i < timestamps.length; i++) {
    const close = closes[i];
    if (close == null || close <= 0) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    entries.push({ date, close: Math.round(close * 100) / 100 });
  }

  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

/**
 * SCAN for meta:sp500:* keys and build sorted array of { date, close }.
 * Values may be objects { price, date } or plain numbers — handle both.
 */
async function loadSpyDataFromRedis(kv) {
  const entries = [];
  let cursor = '0';

  do {
    const [nextCursor, keys] = await kv.scan(cursor, { match: 'meta:sp500:*', count: 200 });
    cursor = String(nextCursor);

    if (keys.length) {
      const pipeline = kv.pipeline();
      for (const key of keys) pipeline.get(key);
      const values = await pipeline.exec();

      for (let i = 0; i < keys.length; i++) {
        const date = keys[i].replace('meta:sp500:', '');
        const raw = values[i];
        let close;

        if (raw && typeof raw === 'object' && raw.price != null) {
          close = parseFloat(raw.price);
        } else {
          close = parseFloat(raw);
        }

        if (!isNaN(close) && close > 0) {
          entries.push({ date, close });
        }
      }
    }
  } while (cursor !== '0');

  entries.sort((a, b) => a.date.localeCompare(b.date));
  return entries;
}

/**
 * Load SPY data: try Redis first, backfill from Finnhub if sparse.
 * Caches fetched prices to Redis for future runs.
 */
async function loadSpyData(kv) {
  let entries = await loadSpyDataFromRedis(kv);
  console.log(`  From Redis: ${entries.length} SPY data points`);

  if (entries.length < 25) {
    console.log('  Backfilling from Yahoo Finance (requesting ~1 year of SPY data)...');
    try {
      const prices = await fetchSpyFromYahoo();
      if (prices && prices.length > 0) {
        console.log(`  Fetched ${prices.length} candles from Yahoo Finance`);

        // Merge: API prices fill gaps, existing Redis values take precedence
        const existingDates = new Set(entries.map(e => e.date));
        const newEntries = [];

        for (const p of prices) {
          if (!existingDates.has(p.date) && p.close > 0) {
            newEntries.push({ date: p.date, close: p.close });
          }
        }

        // Cache new entries to Redis
        if (newEntries.length > 0) {
          console.log(`  Caching ${newEntries.length} new SPY prices to Redis...`);
          const BATCH = 50;
          for (let i = 0; i < newEntries.length; i += BATCH) {
            const batch = newEntries.slice(i, i + BATCH);
            const pipeline = kv.pipeline();
            for (const e of batch) {
              pipeline.set(`meta:sp500:${e.date}`, { price: e.close, date: e.date });
            }
            await pipeline.exec();
          }
        }

        entries = [...entries, ...newEntries].sort((a, b) => a.date.localeCompare(b.date));
      }
    } catch (err) {
      console.warn('  Backfill failed:', err.message);
    }
  }

  return entries;
}

/**
 * For each SPY data point, calculate trailing 20-trading-day return
 * and assign a regime classification.
 */
function buildRegimeSeries(spyData) {
  const series = [];

  for (let i = 0; i < spyData.length; i++) {
    const entry = { date: spyData[i].date, close: spyData[i].close };

    if (i >= 20) {
      const pastClose = spyData[i - 20].close;
      entry.trailing20dReturn = round2(((entry.close - pastClose) / pastClose) * 100);
      entry.regime = classifyRegime(entry.trailing20dReturn);
    } else {
      entry.trailing20dReturn = null;
      entry.regime = null;
    }

    series.push(entry);
  }

  return series;
}

/**
 * Find the most recent trading day on or before a given date.
 */
function findNearestRegime(regimeSeries, targetDate) {
  let best = null;
  for (const entry of regimeSeries) {
    if (entry.date <= targetDate && entry.regime != null) {
      best = entry;
    }
    if (entry.date > targetDate) break;
  }
  return best;
}

/**
 * Find SPY close on or before a given date.
 */
function findSpyClose(spyData, targetDate) {
  let best = null;
  for (const entry of spyData) {
    if (entry.date <= targetDate) {
      best = entry;
    }
    if (entry.date > targetDate) break;
  }
  return best;
}

/**
 * Calculate SPY return over approximately 7 calendar days from entryDate.
 * Finds the SPY close nearest to entryDate and nearest to entryDate + 7 days.
 */
function calcSpyReturn7d(spyData, entryDate) {
  const entryClose = findSpyClose(spyData, entryDate);
  if (!entryClose) return null;

  // Target date: 7 calendar days later
  const dt = new Date(entryDate);
  dt.setDate(dt.getDate() + 7);
  const targetDate = dt.toISOString().slice(0, 10);

  const exitClose = findSpyClose(spyData, targetDate);
  if (!exitClose || exitClose.date === entryClose.date) return null;

  return round2(((exitClose.close - entryClose.close) / entryClose.close) * 100);
}

// ── Pick Loading ─────────────────────────────────────

async function loadPicks(kv) {
  const pickIds = await kv.zrange('picks:index', 0, -1);
  if (!pickIds || !pickIds.length) return [];

  const pipeline = kv.pipeline();
  for (const id of pickIds) pipeline.get(id);
  const results = await pipeline.exec();

  return results.filter(Boolean).map(p => {
    if (typeof p === 'string') p = JSON.parse(p);
    return p;
  });
}

// ── Stats Calculation ────────────────────────────────

function calcStats(returns) {
  if (!returns.length) return { count: 0, winRate: 0, avgReturn: 0, medianReturn: 0, stdDev: 0 };

  const wins = returns.filter(r => r > 0).length;
  const avg = returns.reduce((s, v) => s + v, 0) / returns.length;

  return {
    count: returns.length,
    winRate: round2(pct(wins, returns.length)),
    avgReturn: round2(avg),
    medianReturn: round2(median(returns)),
    stdDev: round2(stddev(returns)),
  };
}

// ── Main ─────────────────────────────────────────────

async function main() {
  console.log('═══ MARKET REGIME ANALYSIS ═══\n');

  const kv = getRedis();

  // Step 1–2: Load SPY data
  console.log('Loading SPY daily closes...');
  const spyData = await loadSpyData(kv);
  console.log(`  SPY data points: ${spyData.length}`);

  if (spyData.length < 25) {
    console.warn('  ⚠ Fewer than 25 SPY data points — regime classification may be unreliable');
  }

  if (spyData.length < 2) {
    console.error('  Not enough SPY data to proceed.');
    process.exit(1);
  }

  console.log(`  Date range: ${spyData[0].date} to ${spyData[spyData.length - 1].date}`);

  // Step 3: Build regime series
  const regimeSeries = buildRegimeSeries(spyData);
  const withRegime = regimeSeries.filter(e => e.regime != null);
  console.log(`  Regime-classified trading days: ${withRegime.length}`);

  // Regime distribution in SPY data
  const regimeCounts = {};
  for (const e of withRegime) {
    regimeCounts[e.regime] = (regimeCounts[e.regime] || 0) + 1;
  }
  console.log('  Regime distribution (trading days):');
  for (const [regime, count] of Object.entries(regimeCounts)) {
    console.log(`    ${regime}: ${count} (${round2(pct(count, withRegime.length))}%)`);
  }
  console.log();

  // Step 4: Load picks
  console.log('Loading picks...');
  const allPicks = await loadPicks(kv);
  console.log(`  Total picks: ${allPicks.length}`);

  // Step 5–6: Match picks to regimes and calculate returns
  const REGIME_ORDER = ['bull', 'flat', 'correction', 'drawdown'];
  const regimeGroups = {};
  for (const r of REGIME_ORDER) regimeGroups[r] = [];

  const regimeByTier = {};
  for (const r of REGIME_ORDER) regimeByTier[r] = {};

  let matched = 0;
  let usable = 0;

  for (const pick of allPicks) {
    if (!pick.entryDate) continue;

    const regimeEntry = findNearestRegime(regimeSeries, pick.entryDate);
    if (!regimeEntry) continue;
    matched++;

    const ret = getUsableReturn(pick);
    if (ret == null) continue;
    usable++;

    const regime = regimeEntry.regime;
    const spyReturn = calcSpyReturn7d(spyData, pick.entryDate);
    const excessReturn = spyReturn != null ? round2(ret - spyReturn) : null;

    const enriched = {
      ticker: pick.ticker,
      tier: pick.tier,
      entryDate: pick.entryDate,
      pickReturn: ret,
      spyReturn,
      excessReturn,
      regime,
      trailing20d: regimeEntry.trailing20dReturn,
    };

    regimeGroups[regime].push(enriched);

    // Cross-tabulate by tier
    const tier = pick.tier || 'unknown';
    if (!regimeByTier[regime][tier]) regimeByTier[regime][tier] = [];
    regimeByTier[regime][tier].push(enriched);
  }

  console.log(`  Matched to regime: ${matched}`);
  console.log(`  With usable returns: ${usable}`);
  console.log();

  // Step 7: Regime stats
  console.log('═══ REGIME PERFORMANCE ═══\n');

  const regimeStats = [];
  for (const regime of REGIME_ORDER) {
    const picks = regimeGroups[regime];
    const returns = picks.map(p => p.pickReturn);
    const stats = calcStats(returns);

    // Excess return stats
    const excessReturns = picks.map(p => p.excessReturn).filter(r => r != null);
    const excessStats = calcStats(excessReturns);

    const row = {
      regime,
      count: stats.count,
      winRate: stats.winRate,
      avgReturn: stats.avgReturn,
      medianReturn: stats.medianReturn,
      stdDev: stats.stdDev,
      avgExcessReturn: excessStats.avgReturn,
      excessWinRate: excessStats.winRate,
      medianExcessReturn: excessStats.medianReturn,
    };

    regimeStats.push(row);

    console.log(`  ${regime.toUpperCase().padEnd(12)} | ${String(stats.count).padStart(4)} picks | WR ${String(stats.winRate).padStart(6)}% | Avg ${String(stats.avgReturn).padStart(7)}% | Med ${String(stats.medianReturn).padStart(7)}% | σ ${String(stats.stdDev).padStart(6)}%`);
    console.log(`  ${''.padEnd(12)} | Excess: WR ${String(excessStats.winRate).padStart(6)}% | Avg ${String(excessStats.avgReturn).padStart(7)}% | Med ${String(excessStats.medianReturn).padStart(7)}%`);
  }
  console.log();

  // Step 9: Cross-tabulation — regime × tier
  console.log('═══ REGIME × TIER CROSS-TAB ═══\n');

  const tierSet = new Set();
  for (const regime of REGIME_ORDER) {
    for (const tier of Object.keys(regimeByTier[regime])) {
      tierSet.add(tier);
    }
  }
  const tiers = [...tierSet].sort();

  // Header
  const hdr = '  ' + 'Regime'.padEnd(12) + tiers.map(t => t.padStart(20)).join('');
  console.log(hdr);
  console.log('  ' + '─'.repeat(12 + tiers.length * 20));

  const regimeByTierStats = {};
  for (const regime of REGIME_ORDER) {
    regimeByTierStats[regime] = {};
    const cells = [];

    for (const tier of tiers) {
      const picks = regimeByTier[regime][tier] || [];
      const returns = picks.map(p => p.pickReturn);
      const stats = calcStats(returns);
      regimeByTierStats[regime][tier] = stats;
      cells.push(`${stats.count}p WR${stats.winRate}%`.padStart(20));
    }

    console.log(`  ${regime.padEnd(12)}${cells.join('')}`);
  }
  console.log();

  // Step 11: Key findings
  const findings = [];

  // Insider buys during corrections vs bulls
  const bullStats = regimeStats.find(r => r.regime === 'bull');
  const corrStats = regimeStats.find(r => r.regime === 'correction');
  const drawStats = regimeStats.find(r => r.regime === 'drawdown');
  const flatStats = regimeStats.find(r => r.regime === 'flat');

  if (corrStats && corrStats.count >= 3 && bullStats && bullStats.count >= 3) {
    findings.push(
      `Insider buys during corrections have ${corrStats.winRate}% win rate vs ${bullStats.winRate}% in bulls (${corrStats.count} vs ${bullStats.count} picks)`
    );
  }

  if (drawStats && drawStats.count >= 3 && bullStats && bullStats.count >= 3) {
    findings.push(
      `Drawdown regime: ${drawStats.winRate}% win rate, avg return ${drawStats.avgReturn}% (${drawStats.count} picks)`
    );
  }

  // Excess return direction
  const allExcessReturns = REGIME_ORDER.flatMap(r =>
    regimeGroups[r].map(p => p.excessReturn).filter(r => r != null)
  );
  if (allExcessReturns.length > 0) {
    const avgExcess = round2(allExcessReturns.reduce((s, v) => s + v, 0) / allExcessReturns.length);
    const excessWins = allExcessReturns.filter(r => r > 0).length;
    const excessWR = round2(pct(excessWins, allExcessReturns.length));
    const direction = avgExcess >= 0 ? 'positive' : 'negative';
    findings.push(
      `Excess return (vs SPY) is ${direction} across all regimes: avg ${avgExcess}%, win rate ${excessWR}%`
    );
  }

  // Scoring inversion check: do top_pick and feature perform differently by regime?
  for (const regime of REGIME_ORDER) {
    const tp = regimeByTierStats[regime]['top_pick'];
    const ft = regimeByTierStats[regime]['feature'];
    if (tp && ft && tp.count >= 3 && ft.count >= 3) {
      if (ft.winRate > tp.winRate + 5) {
        findings.push(
          `Scoring inversion persists in ${regime}: feature WR ${ft.winRate}% > top_pick WR ${tp.winRate}%`
        );
      } else if (tp.winRate > ft.winRate + 5) {
        findings.push(
          `Scoring inversion reverses in ${regime}: top_pick WR ${tp.winRate}% > feature WR ${ft.winRate}%`
        );
      }
    }
  }

  // Best regime for insider signals
  const bestRegime = [...regimeStats].filter(r => r.count >= 3).sort((a, b) => b.avgExcessReturn - a.avgExcessReturn)[0];
  if (bestRegime) {
    findings.push(
      `Best regime for insider alpha: ${bestRegime.regime} (avg excess return ${bestRegime.avgExcessReturn}%, ${bestRegime.count} picks)`
    );
  }

  console.log('═══ KEY FINDINGS ═══\n');
  for (const f of findings) {
    console.log(`  • ${f}`);
  }
  console.log();

  // Step 10: Write output
  const report = {
    generated: new Date().toISOString().slice(0, 10),
    regimes: regimeStats,
    regimeByTier: regimeByTierStats,
    spyDataPoints: spyData.length,
    totalPicks: allPicks.length,
    matchedPicks: matched,
    usablePicks: usable,
    keyFindings: findings,
  };

  // Write JSON
  const outDir = path.join(__dirname, '../output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'market-regime.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote ${outPath}`);

  // Write to Redis
  try {
    await kv.set('meta:market-regime', JSON.stringify(report));
    console.log('Wrote meta:market-regime to Redis');
  } catch (err) {
    console.warn('Failed to write to Redis:', err.message);
  }

  console.log('\nDone.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
