/**
 * Pick Filters
 * 
 * Two data quality filters applied before picks are recorded/displayed:
 * 
 * 1. Entry Price Validation — sanity-checks the filing's entry price
 *    against the current market price. Catches cases like $PSA where
 *    a fractional lot or derivative price gets used instead of the
 *    actual stock price.
 * 
 * 2. Repeat Insider Dampening — reduces scores for the same insider+ticker
 *    combo that's been featured recently. Prevents Murray Stahl filing
 *    $3K buys on RCG every week from filling the newsletter.
 */

const PRICE_DRIFT_THRESHOLD = 0.70; // Entry price must be within 70% of current price

/**
 * Validate an entry price against the current market quote.
 * 
 * If the entry price is suspiciously far from the current price,
 * returns a corrected price or null.
 * 
 * Why this matters:
 * - Some Form 4 XMLs list derivative prices, partial lots, or
 *   warrant exercise prices as the "pricePerShare"
 * - $PSA showed $44.54 entry when the stock trades at ~$280
 * - These bad prices produce absurd return numbers (+522%)
 * 
 * @param {number} entryPrice - Price from the Form 4 XML
 * @param {number} currentPrice - Current quote from Finnhub
 * @param {object} filing - Full filing object for fallback logic
 * @returns {{ price: number, source: string, suspicious: boolean }}
 */
function validateEntryPrice(entryPrice, currentPrice, filing) {
  // No entry price at all
  if (!entryPrice || entryPrice <= 0) {
    return { price: null, source: 'missing', suspicious: true };
  }

  // No current price to compare against
  if (!currentPrice || currentPrice <= 0) {
    return { price: entryPrice, source: 'filing_unverified', suspicious: false };
  }

  // Calculate how far the entry price is from current
  const ratio = entryPrice / currentPrice;

  // Within reasonable range (30% to 300% of current price)
  // Stocks can move a lot in 90 days, but not 5-10x typically
  if (ratio >= (1 - PRICE_DRIFT_THRESHOLD) && ratio <= (1 + PRICE_DRIFT_THRESHOLD + 1)) {
    return { price: entryPrice, source: 'filing_verified', suspicious: false };
  }

  // Entry price is suspiciously low or high — try to find a better one
  // Look through all buy transactions for a more reasonable price
  if (filing && filing.transactions) {
    const buys = filing.transactions.filter(t => t.isOpenMarketBuy && t.pricePerShare > 0);
    
    // Sort by total value descending — the largest transaction is most likely
    // to have the correct per-share price
    const sorted = buys.sort((a, b) => b.totalValue - a.totalValue);
    
    for (const txn of sorted) {
      const txnRatio = txn.pricePerShare / currentPrice;
      if (txnRatio >= 0.30 && txnRatio <= 2.70) {
        return { 
          price: txn.pricePerShare, 
          source: 'filing_corrected', 
          suspicious: true,
          originalPrice: entryPrice,
          reason: `Original $${entryPrice.toFixed(2)} was ${Math.round((1 - ratio) * 100)}% off current $${currentPrice.toFixed(2)}; used $${txn.pricePerShare.toFixed(2)} from largest transaction`,
        };
      }
    }
  }

  // No good price found — mark as suspicious and exclude from return calcs
  return { 
    price: null, 
    source: 'excluded', 
    suspicious: true,
    originalPrice: entryPrice,
    reason: `Entry $${entryPrice.toFixed(2)} is ${Math.round(Math.abs(1 - ratio) * 100)}% away from current $${currentPrice.toFixed(2)} — likely wrong price class`,
  };
}

/**
 * Get the best entry price from a filing's transactions.
 * Uses weighted average of open market buy prices (weighted by shares).
 * 
 * Better than just grabbing the first transaction's price, which is
 * what the current code does.
 * 
 * @param {object} filing - Scored filing with transactions array
 * @returns {number|null} - Weighted average buy price, or null
 */
function getBestEntryPrice(filing) {
  if (!filing || !filing.transactions) return null;

  const buys = filing.transactions.filter(t => 
    t.isOpenMarketBuy && t.pricePerShare > 0 && t.shares > 0
  );

  if (buys.length === 0) return null;

  // Single buy — just return it
  if (buys.length === 1) return buys[0].pricePerShare;

  // Multiple buys — weighted average by shares
  let totalShares = 0;
  let totalValue = 0;
  for (const b of buys) {
    totalShares += b.shares;
    totalValue += b.shares * b.pricePerShare;
  }

  if (totalShares === 0) return null;
  return Math.round((totalValue / totalShares) * 100) / 100;
}


// ══════════════════════════════════════════
//  REPEAT INSIDER DAMPENING
// ══════════════════════════════════════════

/**
 * Check recent picks and reduce scores for repeat insider+ticker combos.
 * 
 * The problem: Murray Stahl buys $3K of RCG every single week.
 * Without dampening, he shows up 12 times in 90 days of data.
 * 
 * Rules:
 * - If same insider+ticker was a pick in the last 7 days: score = 0 (skip)
 * - If same insider+ticker was a pick in the last 14 days: score capped at 25 (mention only)
 * - If same insider+ticker was a pick in the last 30 days: score reduced by 20
 * - Beyond 30 days: no penalty
 * 
 * @param {Array} scoredFilings - Already-scored filings for today
 * @param {Array} recentPicks - Past picks from Redis (last 30 days)
 * @returns {Array} - Filings with adjusted scores
 */
function dampenRepeatInsiders(scoredFilings, recentPicks) {
  if (!recentPicks || recentPicks.length === 0) return scoredFilings;

  const now = Date.now();

  // Build a map of insider+ticker → most recent pick date
  const recentMap = new Map();
  for (const pick of recentPicks) {
    if (!pick.ticker || !pick.ownerCik) continue;
    const key = `${pick.ticker.toUpperCase()}:${pick.ownerCik}`;
    const pickDate = new Date(pick.entryDate || pick.date).getTime();
    
    const existing = recentMap.get(key);
    if (!existing || pickDate > existing) {
      recentMap.set(key, pickDate);
    }
  }

  return scoredFilings.map(f => {
    if (!f.ticker || !f.ownerCik) return f;
    
    const key = `${f.ticker.toUpperCase()}:${f.ownerCik}`;
    const lastPicked = recentMap.get(key);
    if (!lastPicked) return f; // Never featured — no dampening

    const daysSince = Math.floor((now - lastPicked) / (1000 * 60 * 60 * 24));

    if (daysSince <= 7) {
      // Featured in last week — skip entirely
      return {
        ...f,
        score: 0,
        tier: 'skip',
        warnings: [...(f.warnings || []), `Repeat insider: last featured ${daysSince}d ago — skipped`],
        dampened: true,
        dampenReason: `Same insider+ticker featured ${daysSince} days ago`,
      };
    }

    if (daysSince <= 14) {
      // Featured in last 2 weeks — cap at mention
      const cappedScore = Math.min(f.score, 25);
      let tier = 'skip';
      if (cappedScore >= 75) tier = 'top_pick';
      else if (cappedScore >= 45) tier = 'feature';
      else if (cappedScore >= 25) tier = 'mention';

      return {
        ...f,
        score: cappedScore,
        tier,
        warnings: [...(f.warnings || []), `Repeat insider: last featured ${daysSince}d ago — capped`],
        dampened: true,
        dampenReason: `Same insider+ticker featured ${daysSince} days ago`,
      };
    }

    if (daysSince <= 30) {
      // Featured in last month — reduce by 20
      const newScore = f.score - 20;
      let tier = 'skip';
      if (newScore >= 75) tier = 'top_pick';
      else if (newScore >= 45) tier = 'feature';
      else if (newScore >= 25) tier = 'mention';

      return {
        ...f,
        score: newScore,
        tier,
        warnings: [...(f.warnings || []), `Repeat insider: last featured ${daysSince}d ago — reduced`],
        dampened: true,
        dampenReason: `Same insider+ticker featured ${daysSince} days ago`,
      };
    }

    // Beyond 30 days — no penalty
    return f;
  });
}

module.exports = {
  validateEntryPrice,
  getBestEntryPrice,
  dampenRepeatInsiders,
  PRICE_DRIFT_THRESHOLD,
};
