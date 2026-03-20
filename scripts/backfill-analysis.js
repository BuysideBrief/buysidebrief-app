/**
 * Backfill Analysis — Stock Price Threshold Investigation
 * 
 * Digs into the backfill data to answer:
 * 1. Do sub-$5 stocks perform differently than $5+ stocks?
 * 2. What's driving the 75+ bracket underperformance?
 * 3. Is there a stock price threshold that separates winners from losers?
 * 4. How much does repeat insider noise (RCG) affect the numbers?
 * 
 * Usage: node scripts/backfill-analysis.js
 */

try { require('dotenv').config(); } catch (e) {}

const { Redis } = require('@upstash/redis');
const redis = Redis.fromEnv();

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   BACKFILL ANALYSIS — Price Thresholds       ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log();

  // Load all picks
  const pickKeys = await redis.zrange('backfill:picks:index', 0, -1);
  const picks = [];
  for (const key of (pickKeys || [])) {
    const raw = await redis.get(key);
    if (raw) {
      const pick = typeof raw === 'string' ? JSON.parse(raw) : raw;
      picks.push(pick);
    }
  }

  const withReturns = picks.filter(p => 
    p.currentReturn !== null && p.currentReturn !== undefined && 
    p.entryPrice && p.entryPrice > 0
  );

  console.log(`  Total picks: ${picks.length}`);
  console.log(`  Picks with returns: ${withReturns.length}`);
  console.log();

  // ══════════════════════════════════════════
  // 1. ENTRY PRICE BRACKETS
  // ══════════════════════════════════════════

  console.log('═══════════════════════════════════════════════');
  console.log('  1. PERFORMANCE BY ENTRY PRICE BRACKET');
  console.log('═══════════════════════════════════════════════');
  console.log();

  const priceBrackets = [
    { label: 'Sub-$1 (penny stocks)',    min: 0,    max: 1 },
    { label: '$1 — $5 (micro-cap)',      min: 1,    max: 5 },
    { label: '$5 — $10 (small-cap)',     min: 5,    max: 10 },
    { label: '$10 — $25',                min: 10,   max: 25 },
    { label: '$25 — $50',                min: 25,   max: 50 },
    { label: '$50 — $100',               min: 50,   max: 100 },
    { label: '$100+',                    min: 100,  max: 99999 },
  ];

  for (const b of priceBrackets) {
    const inBracket = withReturns.filter(p => p.entryPrice >= b.min && p.entryPrice < b.max);
    if (inBracket.length === 0) {
      console.log(`  ${b.label.padEnd(28)} — no picks`);
      continue;
    }
    const wins = inBracket.filter(p => p.currentReturn > 0).length;
    const avg = inBracket.reduce((s, p) => s + p.currentReturn, 0) / inBracket.length;
    const median = [...inBracket].sort((a, b) => a.currentReturn - b.currentReturn)[Math.floor(inBracket.length / 2)].currentReturn;
    
    const winRate = Math.round((wins / inBracket.length) * 100);
    console.log(`  ${b.label.padEnd(28)} ${String(inBracket.length).padStart(3)} picks | ${String(winRate).padStart(2)}% win | avg ${avg >= 0 ? '+' : ''}${avg.toFixed(1).padStart(7)}% | med ${median >= 0 ? '+' : ''}${median.toFixed(1).padStart(7)}%`);
  }
  console.log();

  // ══════════════════════════════════════════
  // 2. ENTRY PRICE vs SCORE BRACKET (cross-tab)
  // ══════════════════════════════════════════

  console.log('═══════════════════════════════════════════════');
  console.log('  2. PRICE × SCORE CROSS-TAB (win rate)');
  console.log('═══════════════════════════════════════════════');
  console.log();
  console.log('                         Score 75+     Score 45-74');
  console.log('                         ---------     -----------');

  const priceThresholds = [
    { label: 'Sub-$5',    min: 0,  max: 5 },
    { label: '$5 — $20',  min: 5,  max: 20 },
    { label: '$20+',      min: 20, max: 99999 },
  ];

  for (const pt of priceThresholds) {
    const top = withReturns.filter(p => p.score >= 75 && p.entryPrice >= pt.min && p.entryPrice < pt.max);
    const feat = withReturns.filter(p => p.score >= 45 && p.score < 75 && p.entryPrice >= pt.min && p.entryPrice < pt.max);

    const topStr = top.length > 0 
      ? `${Math.round((top.filter(p => p.currentReturn > 0).length / top.length) * 100)}% (n=${top.length})`
      : 'n/a';
    const featStr = feat.length > 0
      ? `${Math.round((feat.filter(p => p.currentReturn > 0).length / feat.length) * 100)}% (n=${feat.length})`
      : 'n/a';

    console.log(`  ${pt.label.padEnd(22)} ${topStr.padStart(12)}     ${featStr.padStart(12)}`);
  }
  console.log();

  // ══════════════════════════════════════════
  // 3. THE 75+ BRACKET — WHO'S DRAGGING IT DOWN?
  // ══════════════════════════════════════════

  console.log('═══════════════════════════════════════════════');
  console.log('  3. ALL 75+ PICKS (detailed breakdown)');
  console.log('═══════════════════════════════════════════════');
  console.log();

  const topPicks = withReturns.filter(p => p.score >= 75);
  const topSorted = [...topPicks].sort((a, b) => a.currentReturn - b.currentReturn);

  for (const p of topSorted) {
    const priceTag = p.entryPrice < 5 ? ' ⚠️ <$5' : '';
    const instTag = p.isInstitutional ? ' 🏦 INST' : '';
    const returnStr = `${p.currentReturn >= 0 ? '+' : ''}${p.currentReturn.toFixed(1)}%`;
    console.log(`  $${(p.ticker || '???').padEnd(6)} Score:${String(p.score).padStart(3)} | $${p.entryPrice?.toFixed(2).padStart(8)} → $${p.currentPrice?.toFixed(2).padStart(8)} | ${returnStr.padStart(8)} | ${p.ownerName || '?'}${priceTag}${instTag}`);
  }
  console.log();

  // Stats
  const topWins = topPicks.filter(p => p.currentReturn > 0);
  const topLosses = topPicks.filter(p => p.currentReturn <= 0);
  const topSubFive = topPicks.filter(p => p.entryPrice < 5);
  const topAboveFive = topPicks.filter(p => p.entryPrice >= 5);

  console.log(`  75+ Total: ${topPicks.length} picks, ${Math.round((topWins.length / topPicks.length) * 100)}% win rate`);
  console.log(`  75+ Sub-$5: ${topSubFive.length} picks, ${topSubFive.length > 0 ? Math.round((topSubFive.filter(p => p.currentReturn > 0).length / topSubFive.length) * 100) : 0}% win rate, avg ${topSubFive.length > 0 ? (topSubFive.reduce((s,p) => s + p.currentReturn, 0) / topSubFive.length).toFixed(1) : 0}%`);
  console.log(`  75+ $5+: ${topAboveFive.length} picks, ${topAboveFive.length > 0 ? Math.round((topAboveFive.filter(p => p.currentReturn > 0).length / topAboveFive.length) * 100) : 0}% win rate, avg ${topAboveFive.length > 0 ? (topAboveFive.reduce((s,p) => s + p.currentReturn, 0) / topAboveFive.length).toFixed(1) : 0}%`);
  console.log();

  // ══════════════════════════════════════════
  // 4. REPEAT INSIDER IMPACT
  // ══════════════════════════════════════════

  console.log('═══════════════════════════════════════════════');
  console.log('  4. REPEAT INSIDER IMPACT');
  console.log('═══════════════════════════════════════════════');
  console.log();

  // Group by insider+ticker
  const insiderMap = new Map();
  for (const p of picks) {
    const key = `${p.ticker}:${p.ownerCik || p.ownerName}`;
    if (!insiderMap.has(key)) insiderMap.set(key, []);
    insiderMap.get(key).push(p);
  }

  const repeats = [...insiderMap.entries()]
    .filter(([_, picks]) => picks.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);

  console.log('  Insider+Ticker combos appearing 3+ times:');
  console.log();
  for (const [key, rPicks] of repeats.slice(0, 15)) {
    const rWithReturns = rPicks.filter(p => p.currentReturn !== null && p.currentReturn !== undefined);
    const avgRet = rWithReturns.length > 0 
      ? rWithReturns.reduce((s, p) => s + p.currentReturn, 0) / rWithReturns.length 
      : null;
    const retStr = avgRet !== null ? `avg ${avgRet >= 0 ? '+' : ''}${avgRet.toFixed(1)}%` : 'no returns';
    const name = rPicks[0].ownerName || '?';
    const ticker = rPicks[0].ticker || '?';
    console.log(`  $${ticker.padEnd(6)} × ${name.padEnd(25).substring(0, 25)} — ${rPicks.length} picks (${retStr})`);
  }

  // Impact of removing top repeaters
  console.log();
  const topRepeaterKeys = new Set(repeats.slice(0, 5).flatMap(([_, rp]) => rp.map(p => `${p.ticker}:${p.date}:${p.ownerCik || p.ownerName}`)));
  
  const withoutRepeats = withReturns.filter(p => {
    const key = `${p.ticker}:${p.date}:${p.ownerCik || p.ownerName}`;
    return !topRepeaterKeys.has(key);
  });

  if (withoutRepeats.length > 0 && withoutRepeats.length !== withReturns.length) {
    const wrWins = withoutRepeats.filter(p => p.currentReturn > 0);
    const wrAvg = withoutRepeats.reduce((s, p) => s + p.currentReturn, 0) / withoutRepeats.length;
    console.log(`  If we removed top 5 repeat insiders:`);
    console.log(`    Picks: ${withReturns.length} → ${withoutRepeats.length}`);
    console.log(`    Win rate: ${Math.round((withReturns.filter(p => p.currentReturn > 0).length / withReturns.length) * 100)}% → ${Math.round((wrWins.length / withoutRepeats.length) * 100)}%`);
    console.log(`    Avg return: ${(withReturns.reduce((s, p) => s + p.currentReturn, 0) / withReturns.length).toFixed(2)}% → ${wrAvg.toFixed(2)}%`);
  }
  console.log();

  // ══════════════════════════════════════════
  // 5. SUSPICIOUS ENTRY PRICES
  // ══════════════════════════════════════════

  console.log('═══════════════════════════════════════════════');
  console.log('  5. SUSPICIOUS ENTRY PRICES (|return| > 200%)');
  console.log('═══════════════════════════════════════════════');
  console.log();

  const suspicious = withReturns.filter(p => Math.abs(p.currentReturn) > 200);
  if (suspicious.length === 0) {
    console.log('  None found.');
  } else {
    for (const p of suspicious.sort((a, b) => b.currentReturn - a.currentReturn)) {
      console.log(`  $${(p.ticker || '?').padEnd(6)} Entry: $${p.entryPrice?.toFixed(2).padStart(8)} → Current: $${p.currentPrice?.toFixed(2).padStart(8)} | ${p.currentReturn >= 0 ? '+' : ''}${p.currentReturn.toFixed(1)}% | ${p.ownerName || '?'}`);
    }
  }
  console.log();

  // ══════════════════════════════════════════
  // 6. RECOMMENDATION
  // ══════════════════════════════════════════

  console.log('═══════════════════════════════════════════════');
  console.log('  6. RECOMMENDED FILTERS');
  console.log('═══════════════════════════════════════════════');
  console.log();

  // Calculate what happens if we exclude sub-$5 from top picks
  const topNoSubFive = topPicks.filter(p => p.entryPrice >= 5);
  if (topNoSubFive.length > 0) {
    const tnsfWins = topNoSubFive.filter(p => p.currentReturn > 0);
    const tnsfAvg = topNoSubFive.reduce((s, p) => s + p.currentReturn, 0) / topNoSubFive.length;
    console.log(`  If 75+ excluded sub-$5 stocks:`);
    console.log(`    Picks: ${topPicks.length} → ${topNoSubFive.length}`);
    console.log(`    Win rate: ${Math.round((topWins.length / topPicks.length) * 100)}% → ${Math.round((tnsfWins.length / topNoSubFive.length) * 100)}%`);
    console.log(`    Avg return: ${(topPicks.reduce((s,p) => s + p.currentReturn, 0) / topPicks.length).toFixed(1)}% → ${tnsfAvg.toFixed(1)}%`);
  }
  console.log();

  // What about $10 threshold?
  const topNoSubTen = topPicks.filter(p => p.entryPrice >= 10);
  if (topNoSubTen.length > 0) {
    const tnstWins = topNoSubTen.filter(p => p.currentReturn > 0);
    const tnstAvg = topNoSubTen.reduce((s, p) => s + p.currentReturn, 0) / topNoSubTen.length;
    console.log(`  If 75+ excluded sub-$10 stocks:`);
    console.log(`    Picks: ${topPicks.length} → ${topNoSubTen.length}`);
    console.log(`    Win rate: ${Math.round((topWins.length / topPicks.length) * 100)}% → ${Math.round((tnstWins.length / topNoSubTen.length) * 100)}%`);
    console.log(`    Avg return: ${(topPicks.reduce((s,p) => s + p.currentReturn, 0) / topPicks.length).toFixed(1)}% → ${tnstAvg.toFixed(1)}%`);
  }
  console.log();

  // Cap outlier returns
  const capped = withReturns.map(p => ({
    ...p,
    cappedReturn: Math.max(-100, Math.min(200, p.currentReturn)),
  }));
  const cappedAvg = capped.reduce((s, p) => s + p.cappedReturn, 0) / capped.length;
  const cappedWins = capped.filter(p => p.cappedReturn > 0);
  console.log(`  If returns capped at ±200% (removes entry price errors):`);
  console.log(`    Avg return: ${(withReturns.reduce((s,p) => s + p.currentReturn, 0) / withReturns.length).toFixed(2)}% → ${cappedAvg.toFixed(2)}%`);
  console.log(`    (${withReturns.filter(p => Math.abs(p.currentReturn) > 200).length} outliers capped)`);
  console.log();

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
