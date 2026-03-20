/**
 * Backfill Report
 * 
 * Reads backfill:* data from Redis and generates a comprehensive
 * metrics report. Use this to evaluate the scoring model before
 * promoting any data to the live scorecard.
 * 
 * Usage:
 *   node scripts/backfill-report.js
 *   node scripts/backfill-report.js --html    (also saves an HTML report)
 * 
 * Reports on:
 *   - Overall pick performance (win rate, avg return, vs S&P)
 *   - Best and worst picks
 *   - Score distribution
 *   - Daily signal volume
 *   - Insider sentiment over time
 *   - Top performing tickers
 *   - Tier accuracy (do higher scores = better returns?)
 */

try { require('dotenv').config(); } catch (e) {}

const { Redis } = require('@upstash/redis');
const fs = require('fs');
const path = require('path');

const redis = Redis.fromEnv();

// ── Parse CLI args ──
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, v] = a.replace('--', '').split('=');
    return [k, v || true];
  })
);

const SAVE_HTML = !!args.html;

function formatValue(num) {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(0)}K`;
  return Math.round(num).toString();
}

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   BUYSIDE BRIEF — Backfill Report           ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log();

  // ── Load daily summaries ──
  const dailyDates = await redis.zrange('backfill:daily:index', 0, -1);

  if (!dailyDates || dailyDates.length === 0) {
    console.log('No backfill data found. Run backfill.js first.');
    return;
  }

  console.log(`  Days with data: ${dailyDates.length}`);
  console.log(`  Date range: ${dailyDates[0]} to ${dailyDates[dailyDates.length - 1]}`);
  console.log();

  const dailySummaries = [];
  for (const date of dailyDates) {
    const raw = await redis.get(`backfill:daily:${date}`);
    if (raw) {
      const summary = typeof raw === 'string' ? JSON.parse(raw) : raw;
      dailySummaries.push(summary);
    }
  }

  // ── Aggregate daily stats ──
  let totalFilings = 0;
  let totalBuyValue = 0;
  let totalSellValue = 0;
  let totalBuyFilings = 0;
  let totalSellFilings = 0;
  let totalTopPicks = 0;
  let totalFeatured = 0;
  let totalMentions = 0;

  for (const s of dailySummaries) {
    totalFilings += s.totalFilings || 0;
    totalBuyValue += s.totalBuyValue || 0;
    totalSellValue += s.totalSellValue || 0;
    totalBuyFilings += s.buyFilings || 0;
    totalSellFilings += s.sellFilings || 0;
    totalTopPicks += s.topPicks || 0;
    totalFeatured += s.featured || 0;
    totalMentions += s.mentions || 0;
  }

  console.log('── VOLUME ──');
  console.log(`  Total filings scored:  ${totalFilings}`);
  console.log(`  Total buy filings:     ${totalBuyFilings}`);
  console.log(`  Total sell filings:    ${totalSellFilings}`);
  console.log(`  Total buy value:       $${formatValue(totalBuyValue)}`);
  console.log(`  Total sell value:      $${formatValue(totalSellValue)}`);
  console.log(`  Top picks generated:   ${totalTopPicks}`);
  console.log(`  Featured generated:    ${totalFeatured}`);
  console.log(`  Mentions generated:    ${totalMentions}`);
  console.log(`  Avg filings/day:       ${Math.round(totalFilings / dailySummaries.length)}`);
  console.log(`  Avg picks/day:         ${((totalTopPicks + totalFeatured) / dailySummaries.length).toFixed(1)}`);
  console.log();

  // ── Load picks with returns ──
  const pickKeys = await redis.zrange('backfill:picks:index', 0, -1);
  console.log(`  Total picks tracked: ${pickKeys?.length || 0}`);

  const picks = [];
  for (const key of (pickKeys || [])) {
    const raw = await redis.get(key);
    if (raw) {
      const pick = typeof raw === 'string' ? JSON.parse(raw) : raw;
      picks.push(pick);
    }
  }

  const withReturns = picks.filter(p => p.currentReturn !== null && p.currentReturn !== undefined);
  const withEntryPrice = picks.filter(p => p.entryPrice && p.entryPrice > 0);

  console.log(`  Picks with entry price: ${withEntryPrice.length}`);
  console.log(`  Picks with returns:     ${withReturns.length}`);
  console.log();

  if (withReturns.length > 0) {
    // ── Performance ──
    const winners = withReturns.filter(p => p.currentReturn > 0);
    const losers = withReturns.filter(p => p.currentReturn <= 0);
    const avgReturn = withReturns.reduce((s, p) => s + p.currentReturn, 0) / withReturns.length;

    const sorted = [...withReturns].sort((a, b) => b.currentReturn - a.currentReturn);
    const best = sorted[0];
    const worst = sorted[sorted.length - 1];

    console.log('── PERFORMANCE ──');
    console.log(`  Win rate:       ${Math.round((winners.length / withReturns.length) * 100)}% (${winners.length}W / ${losers.length}L)`);
    console.log(`  Avg return:     ${avgReturn > 0 ? '+' : ''}${avgReturn.toFixed(2)}%`);
    console.log(`  Median return:  ${sorted[Math.floor(sorted.length / 2)].currentReturn.toFixed(2)}%`);
    console.log();
    console.log(`  Best pick:      $${best.ticker} (${best.date}) → ${best.currentReturn > 0 ? '+' : ''}${best.currentReturn.toFixed(2)}%`);
    console.log(`  Worst pick:     $${worst.ticker} (${worst.date}) → ${worst.currentReturn > 0 ? '+' : ''}${worst.currentReturn.toFixed(2)}%`);
    console.log();

    // ── Score vs Return correlation ──
    console.log('── SCORE vs RETURN (does higher score = better performance?) ──');

    const brackets = [
      { label: 'Score 75+  (Top Picks)', min: 75, max: 999 },
      { label: 'Score 45-74 (Featured)', min: 45, max: 74 },
      { label: 'Score 25-44 (Mentions)', min: 25, max: 44 },
    ];

    for (const b of brackets) {
      const inBracket = withReturns.filter(p => p.score >= b.min && p.score <= b.max);
      if (inBracket.length === 0) {
        console.log(`  ${b.label}: no picks`);
        continue;
      }
      const bracketWins = inBracket.filter(p => p.currentReturn > 0);
      const bracketAvg = inBracket.reduce((s, p) => s + p.currentReturn, 0) / inBracket.length;
      console.log(`  ${b.label}: ${inBracket.length} picks, ${Math.round((bracketWins.length / inBracket.length) * 100)}% win rate, avg ${bracketAvg > 0 ? '+' : ''}${bracketAvg.toFixed(2)}%`);
    }
    console.log();

    // ── Top 10 picks ──
    console.log('── TOP 10 PICKS (by return) ──');
    for (const p of sorted.slice(0, 10)) {
      console.log(`  $${p.ticker.padEnd(6)} ${p.date} | Score: ${String(p.score).padStart(3)} | Entry: $${p.entryPrice?.toFixed(2) || '?'} → $${p.currentPrice?.toFixed(2) || '?'} | ${p.currentReturn > 0 ? '+' : ''}${p.currentReturn.toFixed(2)}%`);
    }
    console.log();

    // ── Bottom 10 picks ──
    console.log('── BOTTOM 10 PICKS (by return) ──');
    for (const p of sorted.slice(-10).reverse()) {
      console.log(`  $${p.ticker.padEnd(6)} ${p.date} | Score: ${String(p.score).padStart(3)} | Entry: $${p.entryPrice?.toFixed(2) || '?'} → $${p.currentPrice?.toFixed(2) || '?'} | ${p.currentReturn > 0 ? '+' : ''}${p.currentReturn.toFixed(2)}%`);
    }
    console.log();
  }

  // ── Insider Sentiment Over Time ──
  console.log('── DAILY SENTIMENT (buy/sell ratio) ──');
  const recentDays = dailySummaries.slice(-14);
  for (const s of recentDays) {
    const total = (s.buyFilings || 0) + (s.sellFilings || 0);
    const ratio = total > 0 ? Math.round(((s.buyFilings || 0) / total) * 100) : 0;
    const bar = '█'.repeat(Math.round(ratio / 5)) + '░'.repeat(20 - Math.round(ratio / 5));
    console.log(`  ${s.date} ${bar} ${ratio}% buy (${s.buyFilings || 0}B/${s.sellFilings || 0}S) ${s.topPicks || 0}★`);
  }
  console.log();

  // ── Ticker frequency ──
  const tickerCounts = {};
  for (const p of picks) {
    tickerCounts[p.ticker] = (tickerCounts[p.ticker] || 0) + 1;
  }
  const topTickers = Object.entries(tickerCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  if (topTickers.length > 0) {
    console.log('── MOST FEATURED TICKERS ──');
    for (const [ticker, count] of topTickers) {
      const tickerPicks = withReturns.filter(p => p.ticker === ticker);
      const avgRet = tickerPicks.length > 0
        ? tickerPicks.reduce((s, p) => s + p.currentReturn, 0) / tickerPicks.length
        : null;
      const retStr = avgRet !== null ? `avg ${avgRet > 0 ? '+' : ''}${avgRet.toFixed(2)}%` : 'no return data';
      console.log(`  $${ticker.padEnd(6)} — ${count} picks (${retStr})`);
    }
    console.log();
  }

  // ── Save HTML report ──
  if (SAVE_HTML && withReturns.length > 0) {
    const winners = withReturns.filter(p => p.currentReturn > 0);
    const avgReturn = withReturns.reduce((s, p) => s + p.currentReturn, 0) / withReturns.length;
    const sorted = [...withReturns].sort((a, b) => b.currentReturn - a.currentReturn);
    const winRate = Math.round((winners.length / withReturns.length) * 100);

    const pickRows = sorted.slice(0, 30).map(p => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e0dbd3;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:13px;">
          <strong>$${p.ticker}</strong>
        </td>
        <td style="padding:8px;border-bottom:1px solid #e0dbd3;font-size:13px;">${p.date}</td>
        <td style="padding:8px;border-bottom:1px solid #e0dbd3;font-size:13px;">${p.score}</td>
        <td style="padding:8px;border-bottom:1px solid #e0dbd3;font-size:13px;">$${p.entryPrice?.toFixed(2) || '?'}</td>
        <td style="padding:8px;border-bottom:1px solid #e0dbd3;font-size:13px;">$${p.currentPrice?.toFixed(2) || '?'}</td>
        <td style="padding:8px;border-bottom:1px solid #e0dbd3;font-size:13px;color:${p.currentReturn > 0 ? '#1a7a4c' : '#c0392b'};font-weight:600;">
          ${p.currentReturn > 0 ? '+' : ''}${p.currentReturn.toFixed(2)}%
        </td>
      </tr>`).join('');

    const sentimentRows = dailySummaries.map(s => {
      const total = (s.buyFilings || 0) + (s.sellFilings || 0);
      const ratio = total > 0 ? Math.round(((s.buyFilings || 0) / total) * 100) : 0;
      return `{ date: '${s.date}', ratio: ${ratio}, buys: ${s.buyFilings || 0}, sells: ${s.sellFilings || 0}, picks: ${(s.topPicks || 0) + (s.featured || 0)} }`;
    }).join(',\n      ');

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Buyside Brief — Backfill Report</title>
<style>
  body { background: #faf8f4; color: #1a1a1a; font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 0; padding: 24px; }
  .container { max-width: 800px; margin: 0 auto; }
  h1 { font-family: Georgia, serif; font-size: 28px; font-weight: normal; }
  h2 { font-family: Georgia, serif; font-size: 20px; font-weight: normal; margin-top: 32px; border-bottom: 1px solid #e0dbd3; padding-bottom: 8px; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin: 16px 0; }
  .stat { background: #fff; border: 1px solid #e0dbd3; border-radius: 12px; padding: 16px; }
  .stat-label { font-size: 12px; color: #7a7a7a; margin-bottom: 4px; }
  .stat-value { font-size: 24px; font-weight: 600; font-family: Georgia, serif; }
  .green { color: #1a7a4c; } .red { color: #c0392b; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px; border-bottom: 2px solid #1a1a1a; font-size: 12px; color: #7a7a7a; text-transform: uppercase; letter-spacing: 1px; }
  .note { font-size: 12px; color: #7a7a7a; margin-top: 8px; }
</style>
</head><body>
<div class="container">
  <h1>Buyside Brief — Backfill Report</h1>
  <p style="color:#7a7a7a;">${dailyDates[0]} to ${dailyDates[dailyDates.length - 1]} · ${dailySummaries.length} trading days · ${totalFilings} filings scored</p>

  <div class="stat-grid">
    <div class="stat"><div class="stat-label">Win Rate</div><div class="stat-value ${winRate >= 50 ? 'green' : 'red'}">${winRate}%</div></div>
    <div class="stat"><div class="stat-label">Avg Return</div><div class="stat-value ${avgReturn >= 0 ? 'green' : 'red'}">${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%</div></div>
    <div class="stat"><div class="stat-label">Total Picks</div><div class="stat-value">${withReturns.length}</div></div>
    <div class="stat"><div class="stat-label">Picks/Day</div><div class="stat-value">${((totalTopPicks + totalFeatured) / dailySummaries.length).toFixed(1)}</div></div>
  </div>

  <h2>All Picks (sorted by return)</h2>
  <table>
    <tr><th>Ticker</th><th>Date</th><th>Score</th><th>Entry</th><th>Current</th><th>Return</th></tr>
    ${pickRows}
  </table>
  <p class="note">${withReturns.length} picks with return data shown. ${picks.length - withReturns.length} picks without return data omitted.</p>

  <h2>Daily Insider Sentiment</h2>
  <p class="note">Buy/sell filing ratio by day. Higher = more bullish insider activity.</p>
  <canvas id="sentimentChart" width="800" height="300"></canvas>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
  <script>
    const data = [${sentimentRows}];
    new Chart(document.getElementById('sentimentChart'), {
      type: 'bar',
      data: {
        labels: data.map(d => d.date.slice(5)),
        datasets: [{
          label: 'Buy %',
          data: data.map(d => d.ratio),
          backgroundColor: data.map(d => d.ratio >= 50 ? '#1a7a4c44' : '#c0392b44'),
          borderColor: data.map(d => d.ratio >= 50 ? '#1a7a4c' : '#c0392b'),
          borderWidth: 1,
        }]
      },
      options: {
        scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } } },
        plugins: { legend: { display: false } },
      }
    });
  </script>

  <p style="margin-top:32px;font-size:11px;color:#b0a99f;">Backfill data stored in backfill:* Redis keys. Not shown on public scorecard.</p>
</div>
</body></html>`;

    const outPath = path.join(__dirname, '..', 'backfill-report.html');
    fs.writeFileSync(outPath, html);
    console.log(`  HTML report saved to ${outPath}`);
  }

  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
