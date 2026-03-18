/**
 * Recently Featured Checker
 * 
 * Prevents the same ticker from being the #1 headline pick
 * on consecutive days. Keeps the email feeling fresh.
 * 
 * How it works:
 * 1. After scoring, check Redis for tickers featured as #1 in the last N days
 * 2. If today's top pick was recently #1, rotate it down and promote the next one
 * 3. The repeated pick still appears in the email — just not as the headline
 * 4. Store today's #1 pick in Redis after the email is formatted
 * 
 * Redis keys:
 *   featured:headline:{date}  → ticker that was the #1 pick that day
 *   featured:recent           → sorted set of recent #1 tickers by date
 */

let redis = null;

function getRedis() {
  if (redis) return redis;
  try {
    const { Redis } = require('@upstash/redis');
    redis = Redis.fromEnv();
    return redis;
  } catch (e) {
    console.error('Redis not available for recently featured:', e.message);
    return null;
  }
}

/**
 * How many days back to check for repeat #1 picks.
 * A ticker can be #1 again after this many days.
 */
const COOLDOWN_DAYS = 3;

/**
 * Get tickers that were the #1 headline pick in the last N days.
 * 
 * @param {number} days - How many days back to check (default: COOLDOWN_DAYS)
 * @returns {Set<string>} Set of ticker strings (uppercase)
 */
async function getRecentHeadlineTickers(days = COOLDOWN_DAYS) {
  const r = getRedis();
  if (!r) return new Set();

  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);

    const recentTickers = new Set();

    // Check each of the last N days
    for (let i = 1; i <= days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = d.toISOString().split('T')[0];

      const ticker = await r.get(`featured:headline:${dateStr}`);
      if (ticker) {
        recentTickers.add(String(ticker).toUpperCase());
      }
    }

    return recentTickers;
  } catch (e) {
    console.error('Failed to fetch recent headlines:', e.message);
    return new Set();
  }
}

/**
 * Record today's #1 headline pick in Redis.
 * Call this AFTER the email is sent.
 * 
 * @param {string} ticker
 * @param {string} date - ISO date string (optional, defaults to today)
 */
async function recordHeadlinePick(ticker, date) {
  const r = getRedis();
  if (!r || !ticker) return;

  const today = date || new Date().toISOString().split('T')[0];

  try {
    await r.set(`featured:headline:${today}`, ticker.toUpperCase());
  } catch (e) {
    console.error('Failed to record headline pick:', e.message);
  }
}

/**
 * Rotate the categorized filings so the #1 pick is fresh.
 * 
 * If the current top pick was recently the headline, it gets
 * moved down and the next eligible pick gets promoted.
 * The repeated pick gets a "still watching" flag for the email.
 * 
 * @param {object} categorized - Output from categorizeForDigest()
 * @returns {object} Updated categorized object with rotation applied
 */
async function rotateHeadlinePick(categorized) {
  const recentTickers = await getRecentHeadlineTickers();

  if (recentTickers.size === 0) {
    // No recent data yet — nothing to rotate
    return categorized;
  }

  const topPicks = [...categorized.topPicks];
  const featured = [...categorized.featured];

  // Check if the #1 top pick is a repeat
  if (topPicks.length > 0 && recentTickers.has((topPicks[0].ticker || '').toUpperCase())) {
    const repeatedPick = topPicks[0];
    repeatedPick._isRepeatHeadline = true;
    repeatedPick._repeatNote = `Still our top-scored signal for $${repeatedPick.ticker} — featured again this week`;

    // Look for a non-repeat pick to promote
    let promoted = false;

    // First check remaining top picks
    for (let i = 1; i < topPicks.length; i++) {
      if (!recentTickers.has((topPicks[i].ticker || '').toUpperCase())) {
        // Swap: move this fresh pick to #1, move the repeat down
        const freshPick = topPicks.splice(i, 1)[0];
        topPicks.splice(0, 0, freshPick);
        promoted = true;
        break;
      }
    }

    // If no fresh top pick found, try promoting from featured
    if (!promoted && featured.length > 0) {
      for (let i = 0; i < featured.length; i++) {
        if (!recentTickers.has((featured[i].ticker || '').toUpperCase())) {
          const freshPick = featured.splice(i, 1)[0];
          // Move repeat from #1 top pick down to featured
          const demoted = topPicks.shift();
          featured.unshift(demoted);
          // Promote the fresh pick to #1 top pick
          topPicks.unshift(freshPick);
          promoted = true;
          break;
        }
      }
    }

    // If everything is a repeat (rare), just leave it — better to show a repeat
    // than show nothing. The _isRepeatHeadline flag lets the email template
    // add a "still watching" note if desired.
  }

  return {
    ...categorized,
    topPicks,
    featured,
  };
}

module.exports = {
  getRecentHeadlineTickers,
  recordHeadlinePick,
  rotateHeadlinePick,
  COOLDOWN_DAYS,
};
