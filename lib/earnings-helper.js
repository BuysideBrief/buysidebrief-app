/**
 * Earnings Calendar Helper
 * 
 * Uses Finnhub's free earnings calendar API to cross-reference
 * insider trades with recent and upcoming earnings dates.
 * 
 * Key insight: Most companies enforce blackout periods (typically
 * 2-4 weeks before earnings through 1-2 days after). So insiders
 * CAN'T legally buy right before earnings. The real signals are:
 * 
 * 1. Insider buys shortly AFTER earnings (especially after a miss/selloff)
 *    → Strong conviction signal: they saw the numbers, market overreacted,
 *      and they're buying the dip with their own money.
 * 
 * 2. Insider buys with earnings UPCOMING (within blackout window)
 *    → Flag as suspicious / noteworthy — may violate company policy
 *      or indicate the blackout doesn't apply to this insider.
 * 
 * Finnhub free tier: 60 req/min, earnings calendar included.
 * Endpoint: GET /calendar/earnings?from=DATE&to=DATE&symbol=TICKER
 */

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const RATE_LIMIT_MS = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Typical blackout period: 2 weeks before earnings through 2 days after.
 * Some companies do 4 weeks. We use 14 days as the standard window.
 */
const BLACKOUT_DAYS_BEFORE = 14;
const BLACKOUT_DAYS_AFTER = 2;

/**
 * Post-earnings buy window: insiders buying within 30 days after
 * earnings is the sweet spot for conviction signals.
 */
const POST_EARNINGS_WINDOW_DAYS = 30;

/**
 * Get upcoming earnings date for a ticker.
 * Looks 60 days ahead to catch the next scheduled earnings.
 * 
 * @param {string} ticker
 * @returns {object|null} { date, epsEstimate, epsActual, revenueEstimate, revenueActual, hour }
 */
async function getUpcomingEarnings(ticker) {
  if (!FINNHUB_KEY || !ticker) return null;

  try {
    const now = new Date();
    const from = now.toISOString().split('T')[0];
    const future = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);
    const to = future.toISOString().split('T')[0];

    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`;

    const res = await fetch(url);
    await sleep(RATE_LIMIT_MS);

    if (!res.ok) return null;

    const data = await res.json();
    const earnings = data.earningsCalendar || [];

    if (earnings.length === 0) return null;

    // Return the nearest upcoming earnings
    const next = earnings.sort((a, b) => new Date(a.date) - new Date(b.date))[0];

    return {
      date: next.date,
      epsEstimate: next.epsEstimate ?? null,
      epsActual: next.epsActual ?? null,
      revenueEstimate: next.revenueEstimate ?? null,
      revenueActual: next.revenueActual ?? null,
      hour: next.hour || null, // 'bmo' (before market open), 'amc' (after market close)
      symbol: next.symbol,
    };
  } catch (e) {
    console.error(`Earnings lookup failed for ${ticker}:`, e.message);
    return null;
  }
}

/**
 * Get the most recent past earnings date for a ticker.
 * Looks 90 days back.
 * 
 * @param {string} ticker
 * @returns {object|null} { date, epsEstimate, epsActual, revenueEstimate, revenueActual, surprise }
 */
async function getRecentEarnings(ticker) {
  if (!FINNHUB_KEY || !ticker) return null;

  try {
    const now = new Date();
    const to = now.toISOString().split('T')[0];
    const past = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    const from = past.toISOString().split('T')[0];

    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`;

    const res = await fetch(url);
    await sleep(RATE_LIMIT_MS);

    if (!res.ok) return null;

    const data = await res.json();
    const earnings = data.earningsCalendar || [];

    if (earnings.length === 0) return null;

    // Return the most recent past earnings
    const recent = earnings
      .filter(e => new Date(e.date) <= now)
      .sort((a, b) => new Date(b.date) - new Date(a.date))[0];

    if (!recent) return null;

    // Calculate earnings surprise if we have actual vs estimate
    let surprise = null;
    if (recent.epsActual !== null && recent.epsActual !== undefined &&
        recent.epsEstimate !== null && recent.epsEstimate !== undefined &&
        recent.epsEstimate !== 0) {
      surprise = ((recent.epsActual - recent.epsEstimate) / Math.abs(recent.epsEstimate)) * 100;
      surprise = Math.round(surprise * 100) / 100;
    }

    return {
      date: recent.date,
      epsEstimate: recent.epsEstimate ?? null,
      epsActual: recent.epsActual ?? null,
      revenueEstimate: recent.revenueEstimate ?? null,
      revenueActual: recent.revenueActual ?? null,
      hour: recent.hour || null,
      symbol: recent.symbol,
      surprise,
      beat: surprise !== null ? surprise > 0 : null,
      miss: surprise !== null ? surprise < 0 : null,
    };
  } catch (e) {
    console.error(`Recent earnings lookup failed for ${ticker}:`, e.message);
    return null;
  }
}

/**
 * Analyze the relationship between an insider trade and earnings dates.
 * This is the main function the scoring engine should call.
 * 
 * Returns an earnings context object with:
 * - Signal type: 'post_earnings_buy', 'blackout_flag', 'pre_earnings_caution', or null
 * - Relevant dates and data
 * - Score adjustment recommendation
 * - Plain English context for "Why it matters"
 * 
 * @param {string} ticker
 * @param {string} tradeDate - ISO date string of the insider trade (e.g. '2026-03-15')
 * @returns {object|null}
 */
async function analyzeEarningsContext(ticker, tradeDate) {
  if (!FINNHUB_KEY || !ticker) return null;

  const tradeDateObj = new Date(tradeDate || Date.now());

  // Fetch both upcoming and recent earnings
  const [upcoming, recent] = await Promise.all([
    getUpcomingEarnings(ticker),
    getRecentEarnings(ticker),
  ]);

  const result = {
    ticker,
    tradeDate: tradeDateObj.toISOString().split('T')[0],
    upcomingEarnings: upcoming,
    recentEarnings: recent,
    signal: null,
    scoreAdjustment: 0,
    context: null,
  };

  // ── Check 1: Is the trade within the typical blackout period BEFORE upcoming earnings? ──
  if (upcoming) {
    const earningsDate = new Date(upcoming.date);
    const daysUntilEarnings = Math.floor((earningsDate - tradeDateObj) / (1000 * 60 * 60 * 24));

    if (daysUntilEarnings >= 0 && daysUntilEarnings <= BLACKOUT_DAYS_BEFORE) {
      result.signal = 'blackout_flag';
      result.daysUntilEarnings = daysUntilEarnings;
      result.scoreAdjustment = 0; // Don't boost or penalize — just flag it
      result.context = `This insider traded ${daysUntilEarnings} day${daysUntilEarnings !== 1 ? 's' : ''} before earnings (${upcoming.date}). Most companies enforce trading blackouts in this window — worth noting.`;
      return result;
    }

    // Trade is 15-30 days before earnings — not in blackout, but close
    if (daysUntilEarnings > BLACKOUT_DAYS_BEFORE && daysUntilEarnings <= 30) {
      result.signal = 'pre_earnings_caution';
      result.daysUntilEarnings = daysUntilEarnings;
      result.scoreAdjustment = 0;
      result.context = `Earnings are coming up on ${upcoming.date} (${daysUntilEarnings} days away). This trade was likely made before the blackout window closed.`;
      return result;
    }
  }

  // ── Check 2: Did the insider buy AFTER a recent earnings report? ──
  if (recent) {
    const earningsDate = new Date(recent.date);
    const daysSinceEarnings = Math.floor((tradeDateObj - earningsDate) / (1000 * 60 * 60 * 24));

    if (daysSinceEarnings >= 0 && daysSinceEarnings <= POST_EARNINGS_WINDOW_DAYS) {
      // Post-earnings buy — this is the money signal
      result.signal = 'post_earnings_buy';
      result.daysSinceEarnings = daysSinceEarnings;

      if (recent.miss) {
        // Buying after an earnings MISS — strongest signal
        result.scoreAdjustment = 20;
        result.context = `This insider bought ${daysSinceEarnings} day${daysSinceEarnings !== 1 ? 's' : ''} after earnings missed estimates by ${Math.abs(recent.surprise)}%. When insiders buy after a miss, they're saying the market overreacted.`;
      } else if (recent.beat) {
        // Buying after an earnings BEAT — still good
        result.scoreAdjustment = 10;
        result.context = `This insider bought ${daysSinceEarnings} day${daysSinceEarnings !== 1 ? 's' : ''} after earnings beat estimates by ${recent.surprise}%. They saw the numbers first-hand and chose to buy more.`;
      } else {
        // Buying after earnings but no surprise data
        result.scoreAdjustment = 10;
        result.context = `This insider bought ${daysSinceEarnings} day${daysSinceEarnings !== 1 ? 's' : ''} after the most recent earnings report (${recent.date}). Post-earnings insider buying is a strong conviction signal — the blackout window just lifted and this was their first chance to buy.`;
      }

      return result;
    }
  }

  // No meaningful earnings context
  return result;
}

/**
 * Batch analyze earnings context for multiple tickers.
 * Respects Finnhub rate limits (60 req/min on free tier).
 * Each ticker requires 2 API calls (upcoming + recent), so
 * we can safely do ~25 tickers per batch.
 * 
 * @param {Array} filings - Array of { ticker, filedAt } objects
 * @returns {Map} ticker → earningsContext
 */
async function batchAnalyzeEarnings(filings) {
  const results = new Map();
  if (!FINNHUB_KEY) return results;

  // Deduplicate tickers
  const uniqueTickers = [...new Set(filings.map(f => f.ticker).filter(Boolean))];

  // Cap at 20 tickers per batch to stay well under rate limit
  const toProcess = uniqueTickers.slice(0, 20);

  for (const ticker of toProcess) {
    try {
      const filing = filings.find(f => f.ticker === ticker);
      const tradeDate = filing?.filedAt || new Date().toISOString().split('T')[0];
      const context = await analyzeEarningsContext(ticker, tradeDate);
      if (context) {
        results.set(ticker, context);
      }
    } catch (e) {
      console.error(`Earnings batch failed for ${ticker}:`, e.message);
    }
  }

  return results;
}

module.exports = {
  getUpcomingEarnings,
  getRecentEarnings,
  analyzeEarningsContext,
  batchAnalyzeEarnings,
  // Export constants for testing
  BLACKOUT_DAYS_BEFORE,
  BLACKOUT_DAYS_AFTER,
  POST_EARNINGS_WINDOW_DAYS,
};
