/**
 * Performance Tracker — Vercel KV Edition
 * 
 * Persistent storage for:
 * 1. Picks Scorecard — every featured pick, tracked at 30/60/90 days
 * 2. CEO Profiles — insider track records with win rates
 * 
 * KV Key Schema:
 *   pick:{ticker}:{date}:{ownerCik}  → pick object
 *   picks:index                       → sorted set of pick IDs by date
 *   ceo:{ownerCik}                   → CEO profile object
 *   ceo:index                         → set of all tracked CEO CIKs
 *   meta:scorecard                    → cached scorecard summary
 *   meta:sp500:{date}                → S&P 500 price on date (for comparison)
 */

const { Redis } = require('@upstash/redis');
const { getQuote } = require('./price-helper');
const { formatValue } = require('./signal-scorer');

// Auto-detect env var names (Vercel uses different names depending on setup)
const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_TOKEN;

let kv;
if (redisUrl && redisToken) {
  kv = new Redis({ url: redisUrl, token: redisToken });
} else {
  // If REST vars aren't set, try fromEnv() which checks all common names
  try {
    kv = Redis.fromEnv();
  } catch (e) {
    console.error('Redis not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
    // Create a no-op fallback so the app doesn't crash
    kv = {
      get: async () => null,
      set: async () => null,
      zadd: async () => null,
      zrange: async () => [],
      sadd: async () => null,
      smembers: async () => [],
    };
  }
}

// ═══════════════════════════════════════
//  PICKS SCORECARD
// ═══════════════════════════════════════

/**
 * Record new picks from today's digest.
 */
async function recordNewPicks(scoredFilings) {
  const today = new Date().toISOString().split('T')[0];
  let recorded = 0;

  const toRecord = scoredFilings.filter(f =>
    (f.tier === 'top_pick' || f.tier === 'feature') && f.summary.buyCount > 0
  );

  for (const f of toRecord) {
    const pickId = `pick:${f.ticker}:${today}:${f.ownerCik || 'unknown'}`;

    // Skip if already recorded
    const exists = await kv.get(pickId);
    if (exists) continue;

    const entryPrice = f.transactions?.find(t => t.isOpenMarketBuy)?.pricePerShare || null;

    const pick = {
      id: pickId,
      ticker: f.ticker,
      companyName: f.issuerName,
      ownerName: f.ownerName,
      ownerCik: f.ownerCik || '',
      officerTitle: f.officerTitle || (f.isDirector ? 'Director' : 'Insider'),
      isCsuite: /CEO|CFO|COO|CHIEF|PRESIDENT/i.test(f.officerTitle || ''),
      score: f.score,
      tier: f.tier,
      signals: f.signals,
      buyValue: f.summary.totalBuyValue,
      buyShares: f.summary.totalBuyShares,
      entryDate: today,
      entryPrice,
      currentPrice: null,
      currentReturn: null,
      return30d: null,
      return60d: null,
      return90d: null,
      lastUpdated: null,
    };

    await kv.set(pickId, pick);
    // Add to the index (sorted set, score = timestamp for ordering)
    await kv.zadd('picks:index', { score: Date.now(), member: pickId });
    recorded++;

    // Also record in CEO profile if applicable
    if (f.ownerCik) {
      await recordCeoPick(f, today, entryPrice);
    }
  }

  // Record S&P 500 for comparison
  try {
    const sp = await getQuote('SPY');
    if (sp) {
      await kv.set(`meta:sp500:${today}`, { price: sp.price, date: today });
    }
  } catch (e) { /* optional */ }

  return recorded;
}

/**
 * Update returns for all tracked picks.
 * Call this daily to refresh performance data.
 */
async function updateAllReturns() {
  const pickIds = await kv.zrange('picks:index', 0, -1);
  if (!pickIds || pickIds.length === 0) return 0;

  let updated = 0;
  const now = Date.now();

  for (const pickId of pickIds) {
    const pick = await kv.get(pickId);
    if (!pick || !pick.ticker || !pick.entryPrice) continue;

    const daysSince = Math.floor((now - new Date(pick.entryDate).getTime()) / (1000 * 60 * 60 * 24));

    try {
      const quote = await getQuote(pick.ticker);
      if (!quote || !quote.price) continue;

      const returnPct = ((quote.price - pick.entryPrice) / pick.entryPrice) * 100;
      const rounded = Math.round(returnPct * 100) / 100;

      pick.currentPrice = quote.price;
      pick.currentReturn = rounded;
      pick.lastUpdated = new Date().toISOString();

      // Snapshot at milestones (only set once)
      if (daysSince >= 30 && pick.return30d === null) pick.return30d = rounded;
      if (daysSince >= 60 && pick.return60d === null) pick.return60d = rounded;
      if (daysSince >= 90 && pick.return90d === null) pick.return90d = rounded;

      await kv.set(pickId, pick);
      updated++;

      // Also update CEO profile
      if (pick.ownerCik) {
        await updateCeoPickReturn(pick.ownerCik, pickId, rounded, daysSince);
      }
    } catch (e) {
      // Skip failures, don't block the loop
    }
  }

  return updated;
}

/**
 * Generate the scorecard summary.
 */
async function generateScorecard() {
  const pickIds = await kv.zrange('picks:index', 0, -1);
  if (!pickIds || pickIds.length === 0) {
    return { totalPicks: 0, message: 'No picks tracked yet. Check back after our first week!' };
  }

  // Load all picks
  const picks = [];
  for (const id of pickIds) {
    const pick = await kv.get(id);
    if (pick && pick.entryPrice && pick.currentReturn !== null && pick.currentReturn !== undefined) {
      picks.push(pick);
    }
  }

  if (picks.length === 0) {
    return { totalPicks: 0, message: 'Picks recorded but no price data yet. Check back tomorrow!' };
  }

  const winners = picks.filter(p => p.currentReturn > 0);
  const avgReturn = picks.reduce((s, p) => s + p.currentReturn, 0) / picks.length;

  // 30-day returns
  const with30d = picks.filter(p => p.return30d !== null);
  const avg30d = with30d.length > 0
    ? with30d.reduce((s, p) => s + p.return30d, 0) / with30d.length : null;

  // 60-day returns
  const with60d = picks.filter(p => p.return60d !== null);
  const avg60d = with60d.length > 0
    ? with60d.reduce((s, p) => s + p.return60d, 0) / with60d.length : null;

  // 90-day returns
  const with90d = picks.filter(p => p.return90d !== null);
  const avg90d = with90d.length > 0
    ? with90d.reduce((s, p) => s + p.return90d, 0) / with90d.length : null;

  // YTD: picks from this calendar year
  const thisYear = new Date().getFullYear().toString();
  const ytdPicks = picks.filter(p => p.entryDate?.startsWith(thisYear) && p.currentReturn !== null);
  const avgYtd = ytdPicks.length > 0
    ? ytdPicks.reduce((s, p) => s + p.currentReturn, 0) / ytdPicks.length : null;

  // Sort for best/worst
  const sorted = [...picks].sort((a, b) => b.currentReturn - a.currentReturn);
  const recent = [...picks].sort((a, b) => new Date(b.entryDate) - new Date(a.entryDate)).slice(0, 10);

  // Get S&P 500 comparison
  let sp500Return = null;
  if (picks.length > 0) {
    const earliest = picks.reduce((min, p) =>
      p.entryDate < min ? p.entryDate : min, picks[0].entryDate);
    const sp500Entry = await kv.get(`meta:sp500:${earliest}`);
    const sp500Now = await getQuote('SPY').catch(() => null);
    if (sp500Entry && sp500Now) {
      sp500Return = Math.round(((sp500Now.price - sp500Entry.price) / sp500Entry.price) * 10000) / 100;
    }
  }

  const scorecard = {
    totalPicks: picks.length,
    winRate: Math.round((winners.length / picks.length) * 100),
    avgReturn: Math.round(avgReturn * 100) / 100,
    avg30dReturn: avg30d !== null ? Math.round(avg30d * 100) / 100 : null,
    avg60dReturn: avg60d !== null ? Math.round(avg60d * 100) / 100 : null,
    avg90dReturn: avg90d !== null ? Math.round(avg90d * 100) / 100 : null,
    avgYtdReturn: avgYtd !== null ? Math.round(avgYtd * 100) / 100 : null,
    sp500Return,
    winners: winners.length,
    losers: picks.length - winners.length,
    bestPick: sorted[0] ? { ticker: sorted[0].ticker, returnPct: sorted[0].currentReturn, entryDate: sorted[0].entryDate, score: sorted[0].score } : null,
    worstPick: sorted[sorted.length - 1] ? { ticker: sorted[sorted.length - 1].ticker, returnPct: sorted[sorted.length - 1].currentReturn, entryDate: sorted[sorted.length - 1].entryDate } : null,
    recentPicks: recent.map(p => ({
      ticker: p.ticker,
      companyName: p.companyName,
      entryDate: p.entryDate,
      entryPrice: p.entryPrice,
      currentPrice: p.currentPrice,
      currentReturn: p.currentReturn,
      return30d: p.return30d,
      return60d: p.return60d,
      return90d: p.return90d,
      score: p.score,
      ownerName: p.ownerName,
      officerTitle: p.officerTitle,
    })),
  };

  // Cache it
  await kv.set('meta:scorecard', scorecard);
  return scorecard;
}

// ═══════════════════════════════════════
//  CEO PROFILES
// ═══════════════════════════════════════

/**
 * Record a pick in a CEO's profile.
 */
async function recordCeoPick(filing, date, entryPrice) {
  const ceoKey = `ceo:${filing.ownerCik}`;
  let profile = await kv.get(ceoKey);

  if (!profile) {
    profile = {
      ownerCik: filing.ownerCik,
      ownerName: filing.ownerName,
      officerTitle: filing.officerTitle || (filing.isDirector ? 'Director' : 'Insider'),
      isCsuite: /CEO|CFO|COO|CHIEF|PRESIDENT/i.test(filing.officerTitle || ''),
      picks: [],
      totalPicks: 0,
      wins: 0,
      losses: 0,
      winRate: null,
      avgReturn: null,
      totalBuyValue: 0,
    };
  }

  // Check if this pick already exists
  const pickId = `${filing.ticker}:${date}`;
  if (profile.picks.find(p => p.id === pickId)) return;

  profile.picks.push({
    id: pickId,
    ticker: filing.ticker,
    companyName: filing.issuerName,
    entryDate: date,
    entryPrice,
    currentPrice: null,
    currentReturn: null,
    return30d: null,
    return90d: null,
    buyValue: filing.summary?.totalBuyValue || 0,
    score: filing.score,
  });

  profile.totalPicks = profile.picks.length;
  profile.totalBuyValue += filing.summary?.totalBuyValue || 0;

  // Update name/title in case it changed
  if (filing.ownerName) profile.ownerName = filing.ownerName;
  if (filing.officerTitle) profile.officerTitle = filing.officerTitle;

  await kv.set(ceoKey, profile);
  await kv.sadd('ceo:index', filing.ownerCik);
}

/**
 * Update a specific pick's return in a CEO profile.
 */
async function updateCeoPickReturn(ownerCik, pickId, returnPct, daysSince) {
  const ceoKey = `ceo:${ownerCik}`;
  const profile = await kv.get(ceoKey);
  if (!profile) return;

  // Find the pick by matching the pickId components
  // pickId format: "pick:TICKER:DATE:CIK"
  const parts = pickId.split(':');
  const ticker = parts[1];
  const date = parts[2];
  const matchId = `${ticker}:${date}`;

  const pick = profile.picks.find(p => p.id === matchId);
  if (!pick) return;

  pick.currentReturn = returnPct;
  if (daysSince >= 30 && pick.return30d === null) pick.return30d = returnPct;
  if (daysSince >= 90 && pick.return90d === null) pick.return90d = returnPct;

  // Recalculate CEO stats
  const withReturns = profile.picks.filter(p => p.currentReturn !== null);
  if (withReturns.length > 0) {
    profile.wins = withReturns.filter(p => p.currentReturn > 0).length;
    profile.losses = withReturns.length - profile.wins;
    profile.winRate = Math.round((profile.wins / withReturns.length) * 100);
    profile.avgReturn = Math.round(
      withReturns.reduce((s, p) => s + p.currentReturn, 0) / withReturns.length * 100
    ) / 100;
  }

  await kv.set(ceoKey, profile);
}

/**
 * Get a CEO's full profile.
 */
async function getCeoProfile(ownerCik) {
  return await kv.get(`ceo:${ownerCik}`);
}

/**
 * Get all tracked CEO profiles, sorted by pick count.
 */
async function getAllCeoProfiles() {
  const ciks = await kv.smembers('ceo:index');
  if (!ciks || ciks.length === 0) return [];

  const profiles = [];
  for (const cik of ciks) {
    const profile = await kv.get(`ceo:${cik}`);
    if (profile && profile.totalPicks > 0) {
      profiles.push(profile);
    }
  }

  // Sort by total picks descending
  profiles.sort((a, b) => b.totalPicks - a.totalPicks);
  return profiles;
}

// ═══════════════════════════════════════
//  EMAIL FORMATTING
// ═══════════════════════════════════════

/**
 * Format scorecard for the daily email.
 */
function formatScorecardForEmail(scorecard) {
  if (!scorecard || scorecard.totalPicks === 0) return '';

  const rows = (scorecard.recentPicks || []).slice(0, 5).map(p => {
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

  // Build the timeframe stats line
  const timeframes = [];
  if (scorecard.avg30dReturn !== null) timeframes.push(`30d: ${scorecard.avg30dReturn > 0 ? '+' : ''}${scorecard.avg30dReturn}%`);
  if (scorecard.avg60dReturn !== null) timeframes.push(`60d: ${scorecard.avg60dReturn > 0 ? '+' : ''}${scorecard.avg60dReturn}%`);
  if (scorecard.avg90dReturn !== null) timeframes.push(`90d: ${scorecard.avg90dReturn > 0 ? '+' : ''}${scorecard.avg90dReturn}%`);
  if (scorecard.avgYtdReturn !== null) timeframes.push(`YTD: ${scorecard.avgYtdReturn > 0 ? '+' : ''}${scorecard.avgYtdReturn}%`);

  return `
<tr><td style="padding:24px 20px;">
  <div style="background:#ffffff;border:1px solid #e0dbd3;border-radius:12px;padding:24px;">
    <p style="margin:0 0 4px;font-size:11px;color:#d4a853;text-transform:uppercase;letter-spacing:1.5px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      Scorecard
    </p>
    <h3 style="margin:0 0 16px;font-size:20px;color:#1a1a1a;font-family:Georgia,serif;font-weight:normal;">
      How our picks are doing
    </h3>
    <p style="margin:0 0 8px;font-size:14px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      <strong>${scorecard.winRate}%</strong> win rate across ${scorecard.totalPicks} picks
      &middot; Avg return: <strong style="color:${scorecard.avgReturn > 0 ? '#1a7a4c' : '#c0392b'};">${scorecard.avgReturn > 0 ? '+' : ''}${scorecard.avgReturn}%</strong>
      ${scorecard.sp500Return !== null ? `&middot; S&amp;P 500: ${scorecard.sp500Return > 0 ? '+' : ''}${scorecard.sp500Return}%` : ''}
    </p>
    ${timeframes.length > 0 ? `
    <p style="margin:0 0 16px;font-size:13px;color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      ${timeframes.join(' &middot; ')}
    </p>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </div>
</td></tr>`;
}

/**
 * Format CEO spotlight for the email.
 * Highlights the most interesting CEO profile from today's picks.
 */
function formatCeoSpotlight(ceoProfile) {
  if (!ceoProfile || ceoProfile.totalPicks < 2 || ceoProfile.winRate === null) return '';

  const color = ceoProfile.avgReturn > 0 ? '#1a7a4c' : '#c0392b';
  const recentPicks = ceoProfile.picks
    .filter(p => p.currentReturn !== null)
    .sort((a, b) => new Date(b.entryDate) - new Date(a.entryDate))
    .slice(0, 3);

  const pickRows = recentPicks.map(p => {
    const pColor = p.currentReturn > 0 ? '#1a7a4c' : '#c0392b';
    return `$${p.ticker} (${p.currentReturn > 0 ? '+' : ''}${p.currentReturn}%)`;
  }).join(' &middot; ');

  return `
<tr><td style="padding:0 20px 24px;">
  <div style="background:#ffffff;border:1px solid #e0dbd3;border-radius:12px;padding:20px;">
    <p style="margin:0 0 4px;font-size:11px;color:#d4a853;text-transform:uppercase;letter-spacing:1.5px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      Insider Spotlight
    </p>
    <p style="margin:0 0 8px;font-size:15px;color:#1a1a1a;font-family:Georgia,serif;">
      <strong>${ceoProfile.ownerName}</strong> (${ceoProfile.officerTitle})
    </p>
    <p style="margin:0 0 4px;font-size:14px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      <strong>${ceoProfile.winRate}%</strong> win rate across ${ceoProfile.totalPicks} picks
      &middot; Avg return: <strong style="color:${color};">${ceoProfile.avgReturn > 0 ? '+' : ''}${ceoProfile.avgReturn}%</strong>
      &middot; Total invested: $${formatValue(ceoProfile.totalBuyValue)}
    </p>
    ${pickRows ? `
    <p style="margin:4px 0 0;font-size:12px;color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      Recent: ${pickRows}
    </p>` : ''}
  </div>
</td></tr>`;
}

/**
 * Format scorecard for the weekly email (more detailed).
 */
function formatScorecardForWeekly(scorecard) {
  if (!scorecard || scorecard.totalPicks === 0) return '';

  const rows = (scorecard.recentPicks || []).map(p => {
    const color = p.currentReturn > 0 ? '#1a7a4c' : '#c0392b';
    const arrow = p.currentReturn > 0 ? '↑' : '↓';
    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #e0dbd3;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          <strong style="font-size:15px;">$${p.ticker}</strong>
          <span style="color:#7a7a7a;font-size:13px;"> — ${p.companyName || ''}</span><br>
          <span style="font-size:13px;color:#7a7a7a;">
            ${p.ownerName} (${p.officerTitle || 'Insider'}) &middot;
            Picked ${p.entryDate} at $${p.entryPrice?.toFixed(2) || '?'} &middot;
            Score: ${p.score}
          </span><br>
          <span style="font-size:14px;color:${color};font-weight:600;">
            ${arrow} ${p.currentReturn > 0 ? '+' : ''}${p.currentReturn}%
            (now $${p.currentPrice?.toFixed(2) || '?'})
          </span>
          ${p.return30d !== null ? `<span style="font-size:12px;color:#7a7a7a;"> &middot; 30d: ${p.return30d > 0 ? '+' : ''}${p.return30d}%</span>` : ''}
          ${p.return90d !== null ? `<span style="font-size:12px;color:#7a7a7a;"> &middot; 90d: ${p.return90d > 0 ? '+' : ''}${p.return90d}%</span>` : ''}
        </td>
      </tr>`;
  }).join('');

  const timeframes = [];
  if (scorecard.avg30dReturn !== null) timeframes.push(`30d: ${scorecard.avg30dReturn > 0 ? '+' : ''}${scorecard.avg30dReturn}%`);
  if (scorecard.avg60dReturn !== null) timeframes.push(`60d: ${scorecard.avg60dReturn > 0 ? '+' : ''}${scorecard.avg60dReturn}%`);
  if (scorecard.avg90dReturn !== null) timeframes.push(`90d: ${scorecard.avg90dReturn > 0 ? '+' : ''}${scorecard.avg90dReturn}%`);
  if (scorecard.avgYtdReturn !== null) timeframes.push(`YTD: ${scorecard.avgYtdReturn > 0 ? '+' : ''}${scorecard.avgYtdReturn}%`);

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
      ${scorecard.sp500Return !== null ? `S&amp;P 500 over the same period: ${scorecard.sp500Return > 0 ? '+' : ''}${scorecard.sp500Return}%.` : ''}
      ${scorecard.bestPick ? `Best pick: $${scorecard.bestPick.ticker} (${scorecard.bestPick.returnPct > 0 ? '+' : ''}${scorecard.bestPick.returnPct}%).` : ''}
    </p>
    ${timeframes.length > 0 ? `
    <p style="margin:0 0 16px;font-size:13px;color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      ${timeframes.join(' &middot; ')}
    </p>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
  </div>
</td></tr>`;
}

// ═══════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════

module.exports = {
  // Picks
  recordNewPicks,
  updateAllReturns,
  generateScorecard,

  // CEO
  recordCeoPick,
  getCeoProfile,
  getAllCeoProfiles,

  // Email formatting
  formatScorecardForEmail,
  formatScorecardForWeekly,
  formatCeoSpotlight,
};
