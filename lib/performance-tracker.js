/**
 * Performance Tracker
 * 
 * Stores Top Picks and tracks their returns over time.
 * Powers the "Scorecard" feature — proving the scoring model works.
 * 
 * Storage: JSON file on disk (MVP). Upgrade to Vercel KV or
 * a database when it outgrows a flat file.
 * 
 * This module:
 * 1. Records new Top Picks when the digest runs
 * 2. Updates returns for past picks (7d, 30d, 90d)
 * 3. Generates a scorecard summary for the newsletter/website
 */

const fs = require('fs');
const path = require('path');
const { calculateReturn, getQuote } = require('./price-helper');

const DATA_DIR = process.env.DATA_DIR || '/tmp/buysidebrief';
const PICKS_FILE = path.join(DATA_DIR, 'picks.json');

// Ensure data directory exists
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

/**
 * Load all tracked picks from storage.
 */
function loadPicks() {
  ensureDataDir();
  if (!fs.existsSync(PICKS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(PICKS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Save picks to storage.
 */
function savePicks(picks) {
  ensureDataDir();
  fs.writeFileSync(PICKS_FILE, JSON.stringify(picks, null, 2));
}

/**
 * Record new Top Picks from today's digest.
 * Called by the cron job after scoring.
 */
function recordNewPicks(scoredFilings) {
  const picks = loadPicks();
  const today = new Date().toISOString().split('T')[0];

  const newPicks = scoredFilings
    .filter(f => f.tier === 'top_pick' || (f.tier === 'feature' && f.score >= 60))
    .map(f => ({
      id: `${f.ticker}-${today}-${f.ownerCik || ''}`,
      ticker: f.ticker,
      companyName: f.issuerName,
      ownerName: f.ownerName,
      officerTitle: f.officerTitle,
      score: f.score,
      tier: f.tier,
      signals: f.signals,
      buyValue: f.summary.totalBuyValue,
      buyShares: f.summary.totalBuyShares,

      // Price at time of pick
      entryDate: today,
      entryPrice: f.transactions?.[0]?.pricePerShare || null,

      // Performance tracking (updated later)
      return7d: null,
      return30d: null,
      return90d: null,
      currentPrice: null,
      lastUpdated: null,
    }));

  // Avoid duplicates
  const existingIds = new Set(picks.map(p => p.id));
  const toAdd = newPicks.filter(p => !existingIds.has(p.id));

  picks.push(...toAdd);
  savePicks(picks);

  return toAdd.length;
}

/**
 * Update returns for all tracked picks.
 * Called periodically (daily) to refresh performance data.
 */
async function updateAllReturns() {
  const picks = loadPicks();
  const now = Date.now();
  let updated = 0;

  for (const pick of picks) {
    if (!pick.ticker || !pick.entryDate) continue;

    const daysSince = Math.floor((now - new Date(pick.entryDate).getTime()) / (1000 * 60 * 60 * 24));

    try {
      const quote = await getQuote(pick.ticker);
      if (!quote) continue;

      pick.currentPrice = quote.price;
      pick.lastUpdated = new Date().toISOString();

      if (pick.entryPrice && pick.entryPrice > 0) {
        const returnPct = ((quote.price - pick.entryPrice) / pick.entryPrice) * 100;
        const rounded = Math.round(returnPct * 100) / 100;

        // Update the appropriate time bucket
        if (daysSince >= 7 && pick.return7d === null) {
          pick.return7d = rounded;
        }
        if (daysSince >= 30 && pick.return30d === null) {
          pick.return30d = rounded;
        }
        if (daysSince >= 90 && pick.return90d === null) {
          pick.return90d = rounded;
        }

        // Always update current return
        pick.currentReturn = rounded;
      }

      updated++;
    } catch (e) {
      console.error(`Failed to update ${pick.ticker}:`, e.message);
    }
  }

  savePicks(picks);
  return updated;
}

/**
 * Generate a scorecard summary.
 * This powers both the newsletter "Scorecard" section and the website page.
 */
function generateScorecard() {
  const picks = loadPicks();
  const now = Date.now();

  // Only include picks with entry prices
  const withPrices = picks.filter(p => p.entryPrice && p.entryPrice > 0 && p.currentReturn !== undefined);

  if (withPrices.length === 0) {
    return {
      totalPicks: 0,
      message: 'No picks tracked yet. Check back after our first week!',
    };
  }

  // Calculate stats
  const winners = withPrices.filter(p => p.currentReturn > 0);
  const losers = withPrices.filter(p => p.currentReturn <= 0);
  const avgReturn = withPrices.reduce((sum, p) => sum + p.currentReturn, 0) / withPrices.length;

  // Best and worst
  const sorted = [...withPrices].sort((a, b) => b.currentReturn - a.currentReturn);
  const best = sorted[0];
  const worst = sorted[sorted.length - 1];

  // 30-day picks with 30d returns
  const with30d = withPrices.filter(p => p.return30d !== null);
  const avg30d = with30d.length > 0
    ? with30d.reduce((sum, p) => sum + p.return30d, 0) / with30d.length
    : null;

  // Recent picks (last 10)
  const recent = [...withPrices]
    .sort((a, b) => new Date(b.entryDate) - new Date(a.entryDate))
    .slice(0, 10);

  return {
    totalPicks: withPrices.length,
    winRate: Math.round((winners.length / withPrices.length) * 100),
    avgReturn: Math.round(avgReturn * 100) / 100,
    avg30dReturn: avg30d !== null ? Math.round(avg30d * 100) / 100 : null,
    winners: winners.length,
    losers: losers.length,
    bestPick: best ? {
      ticker: best.ticker,
      entryDate: best.entryDate,
      returnPct: best.currentReturn,
      score: best.score,
    } : null,
    worstPick: worst ? {
      ticker: worst.ticker,
      entryDate: worst.entryDate,
      returnPct: worst.currentReturn,
      score: worst.score,
    } : null,
    recentPicks: recent.map(p => ({
      ticker: p.ticker,
      companyName: p.companyName,
      entryDate: p.entryDate,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      currentReturn: p.currentReturn,
      return30d: p.return30d,
      score: p.score,
      ownerName: p.ownerName,
      officerTitle: p.officerTitle,
    })),
  };
}

/**
 * Format scorecard as an HTML section for the newsletter.
 */
function formatScorecardForEmail(scorecard) {
  if (scorecard.totalPicks === 0) return '';

  const rows = scorecard.recentPicks.slice(0, 5).map(p => {
    const color = p.currentReturn > 0 ? '#1a7a4c' : '#c0392b';
    const arrow = p.currentReturn > 0 ? '↑' : '↓';
    return `
      <tr>
        <td style="padding:8px 0;border-bottom:1px solid #e0dbd3;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;">
          <strong>$${p.ticker}</strong>
          <span style="color:#7a7a7a;"> — picked ${p.entryDate}</span>
          <span style="color:${color};font-weight:600;"> ${arrow} ${p.currentReturn > 0 ? '+' : ''}${p.currentReturn}%</span>
        </td>
      </tr>`;
  }).join('');

  return `
<tr><td style="padding:24px 20px;">
  <div style="background:#ffffff;border:1px solid #e0dbd3;border-radius:12px;padding:24px;">
    <p style="margin:0 0 4px;font-size:11px;color:#d4a853;text-transform:uppercase;letter-spacing:1.5px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      Scorecard
    </p>
    <h3 style="margin:0 0 16px;font-size:20px;color:#1a1a1a;font-family:Georgia,serif;font-weight:normal;">
      How our picks are doing
    </h3>
    <p style="margin:0 0 16px;font-size:14px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      <strong>${scorecard.winRate}%</strong> win rate across ${scorecard.totalPicks} picks
      &middot; Avg return: <strong style="color:${scorecard.avgReturn > 0 ? '#1a7a4c' : '#c0392b'};">${scorecard.avgReturn > 0 ? '+' : ''}${scorecard.avgReturn}%</strong>
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </div>
</td></tr>`;
}

/**
 * Format scorecard as an HTML section for the weekly digest.
 * More detailed than the daily version.
 */
function formatScorecardForWeekly(scorecard) {
  if (scorecard.totalPicks === 0) return '';

  // Weekly gets the full treatment — all recent picks with more detail
  const rows = scorecard.recentPicks.map(p => {
    const color = p.currentReturn > 0 ? '#1a7a4c' : '#c0392b';
    const arrow = p.currentReturn > 0 ? '↑' : '↓';
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e0dbd3;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          <strong style="font-size:15px;">$${p.ticker}</strong>
          <span style="color:#7a7a7a;font-size:13px;"> — ${p.companyName}</span><br>
          <span style="font-size:13px;color:#7a7a7a;">
            ${p.ownerName} (${p.officerTitle || 'Insider'}) &middot;
            Picked ${p.entryDate} at $${p.entryPrice?.toFixed(2)} &middot;
            Score: ${p.score}
          </span><br>
          <span style="font-size:14px;color:${color};font-weight:600;">
            ${arrow} ${p.currentReturn > 0 ? '+' : ''}${p.currentReturn}%
            (now $${p.currentPrice?.toFixed(2)})
          </span>
          ${p.return30d !== null ? `<span style="font-size:12px;color:#7a7a7a;"> &middot; 30d: ${p.return30d > 0 ? '+' : ''}${p.return30d}%</span>` : ''}
        </td>
      </tr>`;
  }).join('');

  return `
<tr><td style="padding:24px 20px;">
  <div style="background:#ffffff;border:1px solid #e0dbd3;border-radius:12px;padding:24px;">
    <p style="margin:0 0 4px;font-size:11px;color:#d4a853;text-transform:uppercase;letter-spacing:1.5px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      Weekly Scorecard
    </p>
    <h3 style="margin:0 0 8px;font-size:22px;color:#1a1a1a;font-family:Georgia,serif;font-weight:normal;">
      How our picks are performing
    </h3>
    <p style="margin:0 0 20px;font-size:15px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;line-height:1.5;">
      Across <strong>${scorecard.totalPicks} picks</strong>, our win rate is 
      <strong>${scorecard.winRate}%</strong> with an average return of 
      <strong style="color:${scorecard.avgReturn > 0 ? '#1a7a4c' : '#c0392b'};">
        ${scorecard.avgReturn > 0 ? '+' : ''}${scorecard.avgReturn}%
      </strong>.
      ${scorecard.bestPick ? `Best pick: $${scorecard.bestPick.ticker} (${scorecard.bestPick.returnPct > 0 ? '+' : ''}${scorecard.bestPick.returnPct}%).` : ''}
    </p>
    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </div>
</td></tr>`;
}

module.exports = {
  recordNewPicks,
  updateAllReturns,
  generateScorecard,
  formatScorecardForEmail,
  formatScorecardForWeekly,
  loadPicks,
};
