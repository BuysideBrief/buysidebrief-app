/**
 * Historical Data Store
 * 
 * Stores ALL scored filings (not just picks) in Redis for
 * historical analysis, sentiment tracking, and future data products.
 * 
 * This is the data moat — every filing we score gets stored as a
 * compact record. Powers future features:
 * - Insider sentiment index (aggregate buy/sell by day)
 * - Sector heat maps (buy/sell by sector)
 * - "Search any ticker" tool
 * - Historical backtesting
 * - API access for quant traders
 * 
 * Storage schema:
 *   filing:{date}:{ticker}:{ownerCik}  → compact filing record
 *   filings:index:{date}               → sorted set of filing keys by score
 *   filings:daily:{date}               → daily summary stats
 *   filings:ticker:{ticker}            → sorted set of filing keys by date
 * 
 * Estimated storage:
 *   ~500 bytes per filing × 100 filings/day = ~50KB/day = ~1.5MB/month
 *   Well within Upstash free tier limits
 */

const { getRedis } = require('./redis');

/**
 * Store all scored filings from today's run.
 * Called after scoring (Step 3) in the pipeline.
 * 
 * @param {Array} scoredFilings - All scored filings from scoreAllFilings()
 * @param {string} date - ISO date string (e.g. '2026-03-17')
 * @returns {object} { stored, skipped, dailySummary }
 */
async function storeAllScoredFilings(scoredFilings, date) {
  const r = getRedis();
  if (!r) return { stored: 0, skipped: 0, error: 'Redis not available' };

  const today = date || new Date().toISOString().split('T')[0];
  let stored = 0;
  let skipped = 0;

  // Build daily summary as we go
  const summary = {
    date: today,
    totalFilings: scoredFilings.length,
    totalBuyValue: 0,
    totalSellValue: 0,
    buyFilings: 0,
    sellFilings: 0,
    topPicks: 0,
    featured: 0,
    mentions: 0,
    skipped: 0,
    avgScore: 0,
    tickers: [],
    sectors: {},
  };

  const pipeline = r.pipeline();
  let scoreSum = 0;

  for (const f of scoredFilings) {
    if (!f.ticker) {
      skipped++;
      continue;
    }

    const ownerKey = f.ownerCik || f.ownerName || 'unknown';
    const filingKey = `filing:${today}:${f.ticker}:${ownerKey}`;

    // Compact record — only store what we need for analysis
    const record = {
      ticker: f.ticker,
      issuerName: f.issuerName || null,
      ownerName: f.ownerName || null,
      ownerCik: f.ownerCik || null,
      officerTitle: f.officerTitle || null,
      isDirector: f.isDirector || false,
      isOfficer: f.isOfficer || false,
      isTenPercentOwner: f.isTenPercentOwner || false,
      score: f.score,
      tier: f.tier,
      signals: f.signals || [],
      warnings: f.warnings || [],
      buyValue: f.summary?.totalBuyValue || 0,
      sellValue: f.summary?.totalSellValue || 0,
      buyShares: f.summary?.totalBuyShares || 0,
      buyCount: f.summary?.buyCount || 0,
      sellCount: f.summary?.sellCount || 0,
      has10b51Plan: f.has10b51Plan || false,
      date: today,
      // Earnings context if available
      earningsSignal: f.earningsContext?.signal || null,
      earningsAdjustment: f.earningsContext?.scoreAdjustment || 0,
    };

    // Store the filing record (no TTL — keep forever for backtesting)
    pipeline.set(filingKey, JSON.stringify(record));

    // Add to daily index (sorted by score)
    pipeline.zadd(`filings:index:${today}`, { score: f.score, member: filingKey });

    // Add to ticker index (sorted by date timestamp)
    const dateTs = new Date(today).getTime();
    pipeline.zadd(`filings:ticker:${f.ticker.toUpperCase()}`, { score: dateTs, member: filingKey });

    // Update summary
    scoreSum += f.score;
    summary.totalBuyValue += record.buyValue;
    summary.totalSellValue += record.sellValue;
    if (record.buyCount > 0) summary.buyFilings++;
    if (record.sellCount > 0) summary.sellFilings++;
    if (f.tier === 'top_pick') summary.topPicks++;
    else if (f.tier === 'feature') summary.featured++;
    else if (f.tier === 'mention') summary.mentions++;
    else summary.skipped++;

    if (!summary.tickers.includes(f.ticker)) {
      summary.tickers.push(f.ticker);
    }

    stored++;
  }

  // Store daily summary
  summary.avgScore = stored > 0 ? Math.round((scoreSum / stored) * 100) / 100 : 0;
  summary.uniqueTickers = summary.tickers.length;
  delete summary.tickers; // Don't store the full ticker list in summary — it's in the index

  pipeline.set(`filings:daily:${today}`, JSON.stringify(summary));

  // Add today to the master daily index
  pipeline.zadd('filings:daily:index', { score: new Date(today).getTime(), member: today });

  try {
    await pipeline.exec();
  } catch (e) {
    console.error('Historical store pipeline failed:', e.message);
    return { stored: 0, skipped, error: e.message };
  }

  return { stored, skipped, dailySummary: summary };
}

/**
 * Get all filings for a specific date.
 * 
 * @param {string} date - ISO date string
 * @param {object} opts - { minScore, tier, limit }
 * @returns {Array} filing records
 */
async function getFilingsByDate(date, opts = {}) {
  const r = getRedis();
  if (!r) return [];

  const { minScore = -100, limit = 100 } = opts;

  // Get filing keys from the daily index, sorted by score descending
  const keys = await r.zrange(`filings:index:${date}`, 0, limit - 1, { rev: true });

  if (!keys || keys.length === 0) return [];

  // Fetch all records
  const records = [];
  for (const key of keys) {
    try {
      const raw = await r.get(key);
      if (raw) {
        const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (record.score >= minScore) {
          if (!opts.tier || record.tier === opts.tier) {
            records.push(record);
          }
        }
      }
    } catch (e) {
      // Skip corrupt records
    }
  }

  return records;
}

/**
 * Get all filings for a specific ticker across all dates.
 * 
 * @param {string} ticker
 * @param {object} opts - { limit, daysBack }
 * @returns {Array} filing records sorted by date (newest first)
 */
async function getFilingsByTicker(ticker, opts = {}) {
  const r = getRedis();
  if (!r) return [];

  const { limit = 50, daysBack = 90 } = opts;

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffTs = cutoff.getTime();

  // Get filing keys from ticker index, sorted by date descending
  const keys = await r.zrange(
    `filings:ticker:${ticker.toUpperCase()}`,
    '+inf', cutoffTs,
    { byScore: true, rev: true, count: limit, offset: 0 }
  );

  if (!keys || keys.length === 0) return [];

  const records = [];
  for (const key of keys) {
    try {
      const raw = await r.get(key);
      if (raw) {
        const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
        records.push(record);
      }
    } catch (e) {
      // Skip corrupt records
    }
  }

  return records;
}

/**
 * Get daily summary stats for a date range.
 * Powers the sentiment index and dashboard.
 * 
 * @param {number} daysBack - How many days of history
 * @returns {Array} daily summaries sorted by date (newest first)
 */
async function getDailySummaries(daysBack = 30) {
  const r = getRedis();
  if (!r) return [];

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffTs = cutoff.getTime();

  // Get dates from master index
  const dates = await r.zrange('filings:daily:index', '+inf', cutoffTs, {
    byScore: true, rev: true,
  });

  if (!dates || dates.length === 0) return [];

  const summaries = [];
  for (const date of dates) {
    try {
      const raw = await r.get(`filings:daily:${date}`);
      if (raw) {
        const summary = typeof raw === 'string' ? JSON.parse(raw) : raw;
        summaries.push(summary);
      }
    } catch (e) {
      // Skip
    }
  }

  return summaries;
}

/**
 * Calculate a simple insider sentiment score from recent daily summaries.
 * Score ranges from 0 (all selling) to 100 (all buying).
 * 
 * @param {number} daysBack
 * @returns {object} { score, trend, buyRatio, totalBuyValue, totalSellValue }
 */
async function getInsiderSentiment(daysBack = 7) {
  const summaries = await getDailySummaries(daysBack);
  if (summaries.length === 0) return null;

  let totalBuyFilings = 0;
  let totalSellFilings = 0;
  let totalBuyValue = 0;
  let totalSellValue = 0;

  for (const s of summaries) {
    totalBuyFilings += s.buyFilings || 0;
    totalSellFilings += s.sellFilings || 0;
    totalBuyValue += s.totalBuyValue || 0;
    totalSellValue += s.totalSellValue || 0;
  }

  const totalFilings = totalBuyFilings + totalSellFilings;
  if (totalFilings === 0) return null;

  const buyRatio = totalBuyFilings / totalFilings;
  const score = Math.round(buyRatio * 100);

  // Simple trend: compare first half vs second half
  const mid = Math.floor(summaries.length / 2);
  const recentBuys = summaries.slice(0, mid).reduce((s, d) => s + (d.buyFilings || 0), 0);
  const olderBuys = summaries.slice(mid).reduce((s, d) => s + (d.buyFilings || 0), 0);
  const trend = recentBuys > olderBuys ? 'increasing' : (recentBuys < olderBuys ? 'decreasing' : 'stable');

  return {
    score,
    trend,
    buyRatio: Math.round(buyRatio * 10000) / 100, // e.g. 67.32%
    totalBuyValue,
    totalSellValue,
    totalBuyFilings,
    totalSellFilings,
    daysAnalyzed: summaries.length,
  };
}

module.exports = {
  storeAllScoredFilings,
  getFilingsByDate,
  getFilingsByTicker,
  getDailySummaries,
  getInsiderSentiment,
};
