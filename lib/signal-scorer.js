/**
 * Signal Scoring Engine
 * 
 * Scores parsed Form 4 filings to separate signal from noise.
 * Higher score = more likely to be a meaningful insider conviction signal.
 * 
 * Adjustments from original plan:
 * - Removed 52-week-low proximity (requires stock price API, deferred to v2)
 * - Calibrated thresholds after reviewing typical daily filing volumes
 */

/**
 * Score a single parsed Form 4 filing.
 * Returns the filing object with `score`, `signals` (reasons), and `tier` added.
 */
function scoreFiling(filing) {
  let score = 0;
  const signals = [];
  const warnings = [];

  // Skip amendments — they're corrections, not new signals
  if (filing.isAmendment) {
    return { ...filing, score: 0, signals: ['Amendment filing — skipped'], tier: 'skip', warnings };
  }

  // Aggregate transaction data
  const buys = filing.transactions.filter(t => t.isOpenMarketBuy);
  const sells = filing.transactions.filter(t => t.isOpenMarketSell);
  const optionExercises = filing.transactions.filter(t => t.isOptionExercise);
  const gifts = filing.transactions.filter(t => t.isGift);
  const awards = filing.transactions.filter(t => t.isAward);

  const totalBuyValue = buys.reduce((sum, t) => sum + t.totalValue, 0);
  const totalSellValue = sells.reduce((sum, t) => sum + t.totalValue, 0);
  const totalBuyShares = buys.reduce((sum, t) => sum + t.shares, 0);

  // ═══════════════════════════════
  //  BOOST SIGNALS (positive)
  // ═══════════════════════════════

  // C-suite buyer — CEO/CFO/COO buying is the strongest individual signal
  const title = (filing.officerTitle || '').toUpperCase();
  const isCsuite = /\b(CEO|CFO|COO|CHIEF|PRESIDENT)\b/.test(title);
  if (isCsuite && buys.length > 0) {
    score += 30;
    signals.push(`C-suite purchase (${filing.officerTitle})`);
  }

  // Director buying — weaker than C-suite but still meaningful
  if (filing.isDirector && !isCsuite && buys.length > 0) {
    score += 15;
    signals.push('Director purchase');
  }

  // 10% owner buying
  if (filing.isTenPercentOwner && buys.length > 0) {
    score += 20;
    signals.push('10%+ owner purchase');
  }

  // Large purchase — >$500K
  if (totalBuyValue >= 500_000) {
    score += 25;
    signals.push(`Large purchase: $${formatValue(totalBuyValue)}`);
  }
  // Medium purchase — >$100K
  else if (totalBuyValue >= 100_000) {
    score += 15;
    signals.push(`Notable purchase: $${formatValue(totalBuyValue)}`);
  }

  // No 10b5-1 plan — discretionary trade (not pre-scheduled)
  if (!filing.has10b51Plan && buys.length > 0) {
    score += 10;
    signals.push('Discretionary (no 10b5-1 plan)');
  }

  // Open market buy exists at all — baseline signal
  if (buys.length > 0 && score === 0) {
    score += 10;
    signals.push('Open market purchase');
  }

  // ═══════════════════════════════
  //  REDUCE SIGNALS (negative)
  // ═══════════════════════════════

  // Only option exercises — usually mechanical, not conviction
  if (optionExercises.length > 0 && buys.length === 0 && sells.length === 0) {
    score -= 20;
    warnings.push('Option exercise only (likely mechanical)');
  }

  // Gift/estate transfer — not a market signal
  if (gifts.length > 0 && buys.length === 0 && sells.length === 0) {
    score -= 30;
    warnings.push('Gift/transfer (not market signal)');
  }

  // Award only — company-granted, not insider-initiated
  if (awards.length > 0 && buys.length === 0 && sells.length === 0) {
    score -= 20;
    warnings.push('Award/grant only (company-initiated)');
  }

  // Tiny purchase — <$10K
  if (totalBuyValue > 0 && totalBuyValue < 10_000) {
    score -= 15;
    warnings.push(`Small purchase ($${formatValue(totalBuyValue)})`);
  }

  // C-suite selling — weaker signal (many legit reasons)
  if (isCsuite && sells.length > 0 && buys.length === 0) {
    score -= 10;
    warnings.push(`C-suite sell (${filing.officerTitle})`);
  }

  // Pre-scheduled sell — even weaker
  if (filing.has10b51Plan && sells.length > 0) {
    score -= 15;
    warnings.push('Pre-scheduled sale (10b5-1 plan)');
  }

  // ═══════════════════════════════
  //  TIER ASSIGNMENT
  // ═══════════════════════════════

  let tier = 'skip';
  if (score >= 75) tier = 'top_pick';
  else if (score >= 50) tier = 'feature';
  else if (score >= 25) tier = 'mention';

  return {
    ...filing,
    score,
    signals,
    warnings,
    tier,
    summary: {
      totalBuyValue,
      totalSellValue,
      totalBuyShares,
      buyCount: buys.length,
      sellCount: sells.length,
      optionExerciseCount: optionExercises.length,
      giftCount: gifts.length,
    },
  };
}

/**
 * Score an array of filings and detect cluster buying.
 * Cluster buying: 3+ insiders at the same company buying in the same batch.
 */
function scoreAllFilings(filings) {
  // First pass: score individually
  let scored = filings.map(f => scoreFiling(f));

  // Second pass: detect cluster buying (by ticker)
  const tickerGroups = {};
  for (const filing of scored) {
    if (!filing.ticker) continue;
    const key = filing.ticker.toUpperCase();
    if (!tickerGroups[key]) tickerGroups[key] = [];
    if (filing.summary.buyCount > 0) {
      tickerGroups[key].push(filing);
    }
  }

  // Apply cluster bonus
  for (const [ticker, group] of Object.entries(tickerGroups)) {
    if (group.length >= 3) {
      for (const filing of group) {
        filing.score += 40;
        filing.signals.push(`Cluster buying: ${group.length} insiders at $${ticker}`);
        // Re-evaluate tier after cluster bonus
        if (filing.score >= 75) filing.tier = 'top_pick';
        else if (filing.score >= 50) filing.tier = 'feature';
        else if (filing.score >= 25) filing.tier = 'mention';
      }
    } else if (group.length === 2) {
      for (const filing of group) {
        filing.score += 15;
        filing.signals.push(`Paired buying: 2 insiders at $${ticker}`);
        if (filing.score >= 75) filing.tier = 'top_pick';
        else if (filing.score >= 50) filing.tier = 'feature';
        else if (filing.score >= 25) filing.tier = 'mention';
      }
    }
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  return scored;
}

/**
 * Filter scored filings into digest-ready categories.
 */
function categorizeForDigest(scoredFilings) {
  const topPicks = scoredFilings.filter(f => f.tier === 'top_pick');
  const featured = scoredFilings.filter(f => f.tier === 'feature');
  const mentions = scoredFilings.filter(f => f.tier === 'mention');
  const notable_sells = scoredFilings.filter(f =>
    f.summary.sellCount > 0 && f.summary.sellValue >= 100_000 && f.tier !== 'skip'
  );

  return {
    topPicks,
    featured,
    mentions,
    notable_sells,
    totalProcessed: scoredFilings.length,
    totalFeatured: topPicks.length + featured.length,
  };
}

// --- Helpers ---

function formatValue(num) {
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(0)}K`;
  return num.toFixed(0);
}

module.exports = {
  scoreFiling,
  scoreAllFilings,
  categorizeForDigest,
  formatValue,
};
