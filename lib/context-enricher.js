/**
 * Context Enricher
 * 
 * Adds "Why it matters" context blurbs and insider buy history
 * to scored filings. This is what makes the newsletter feel like
 * a smart friend explaining things over coffee.
 * 
 * Two main features:
 * 1. generateWhyItMatters() — plain English context for each signal
 * 2. getInsiderHistory() — past Form 4 filings by the same insider
 */

const { getQuote, calculateReturn } = require('./price-helper');
const { formatValue } = require('./signal-scorer');

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'BuysideBrief hello@buysidebrief.com';
const RATE_LIMIT_MS = 150;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Enrich a scored filing with context.
 * Adds `whyItMatters` (string) and `insiderHistory` (object) fields.
 */
async function enrichFiling(filing) {
  const enriched = { ...filing };

  // Generate the "Why it matters" blurb
  enriched.whyItMatters = generateWhyItMatters(filing);

  // Look up insider's past filing history at this company
  try {
    enriched.insiderHistory = await getInsiderHistory(filing);
  } catch (e) {
    console.error(`History lookup failed for ${filing.ownerName}:`, e.message);
    enriched.insiderHistory = null;
  }

  // Get current price context if we have price API keys
  try {
    if (filing.ticker && (process.env.FINNHUB_API_KEY || process.env.ALPHA_VANTAGE_KEY)) {
      const quote = await getQuote(filing.ticker);
      if (quote) {
        enriched.currentPrice = quote.price;
        enriched.priceChange = quote.changePercent;
      }
    }
  } catch (e) {
    // Price enrichment is optional — don't fail the pipeline
  }

  return enriched;
}

/**
 * Generate a plain English "Why it matters" blurb.
 * This is the editorial voice — what makes the Brief readable.
 */
function generateWhyItMatters(filing) {
  const parts = [];
  const title = (filing.officerTitle || '').toLowerCase();
  const name = filing.ownerName || 'This insider';
  const firstName = name.split(' ')[0];
  const ticker = filing.ticker || 'the company';

  // Lead with the strongest signal
  if (filing.tier === 'top_pick') {
    // C-suite buying
    if (/ceo|chief executive/i.test(title)) {
      parts.push(`When a CEO puts their own money into their company's stock, it's one of the strongest conviction signals in markets.`);
    } else if (/cfo|chief financial/i.test(title)) {
      parts.push(`The person who sees every line of the financials just bought stock. CFO purchases are among the most reliable insider signals.`);
    } else if (/coo|chief operating/i.test(title)) {
      parts.push(`The COO — who oversees day-to-day operations — just put personal money in. They know the business from the inside.`);
    }

    // Large purchase context
    if (filing.summary.totalBuyValue >= 1_000_000) {
      parts.push(`$${formatValue(filing.summary.totalBuyValue)} is serious money. This isn't a token gesture — it's a real bet.`);
    } else if (filing.summary.totalBuyValue >= 500_000) {
      parts.push(`A half-million-dollar purchase gets our attention. That's meaningful skin in the game.`);
    }
  }

  // Cluster buying
  const clusterSignal = filing.signals.find(s => /cluster/i.test(s));
  if (clusterSignal) {
    parts.push(`Multiple insiders buying the same stock in the same week is called a "cluster buy" — historically one of the strongest predictive signals for future returns.`);
  }

  // Paired buying
  const pairedSignal = filing.signals.find(s => /paired/i.test(s));
  if (pairedSignal) {
    parts.push(`Two insiders buying around the same time could signal the start of a cluster. Worth watching to see if more follow.`);
  }

  // Discretionary vs. pre-scheduled
  if (!filing.has10b51Plan && filing.summary.buyCount > 0) {
    parts.push(`This was a discretionary purchase — not pre-scheduled. ${firstName} chose to buy now.`);
  }

  // 10% owner context
  if (filing.isTenPercentOwner && filing.summary.buyCount > 0) {
    parts.push(`As a 10%+ owner, ${firstName} already has massive exposure to $${ticker}. Adding more means they're very bullish.`);
  }

  // Sell context
  if (filing.summary.sellCount > 0 && filing.summary.buyCount === 0) {
    if (filing.has10b51Plan) {
      parts.push(`This sale was pre-scheduled under a 10b5-1 plan — set up months ago. Not necessarily bearish, but worth noting.`);
    } else {
      parts.push(`Insiders sell for many reasons — taxes, diversification, a new house. Selling alone is a weaker signal than buying.`);
    }
  }

  // Fallback if nothing specific
  if (parts.length === 0) {
    if (filing.summary.buyCount > 0) {
      parts.push(`Open market purchase by a company insider. They chose to buy at current prices with their own money.`);
    } else {
      parts.push(`Filed with the SEC as required by securities law.`);
    }
  }

  return parts.join(' ');
}

/**
 * Fetch past Form 4 filings by this insider at this company.
 * Uses EDGAR full-text search to find historical filings.
 * 
 * Returns:
 * {
 *   pastBuys: [ { date, shares, value, pricePerShare } ],
 *   pastSells: [ ... ],
 *   totalBoughtAllTime: number,
 *   lastBuyDate: string,
 *   daysSinceLastBuy: number,
 *   buyTrackRecord: [ { date, ticker, entryPrice, currentPrice, returnPct } ]
 * }
 */
async function getInsiderHistory(filing) {
  if (!filing.ownerCik || !filing.issuerCik) return null;

  try {
    // Search EDGAR for past Form 4 filings by this owner for this issuer
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${filing.ownerCik}%22&forms=4&from=0&size=20`;

    const res = await fetch(url, {
      headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'application/json' }
    });
    await sleep(RATE_LIMIT_MS);

    if (!res.ok) return null;

    const data = await res.json();
    const hits = data.hits?.hits || [];

    // Filter to same issuer
    const relevantFilings = hits.filter(h => {
      const ciks = h._source?.ciks || [];
      return ciks.includes(String(filing.issuerCik));
    });

    if (relevantFilings.length <= 1) {
      // Only the current filing — this may be a first-time filer
      return {
        isFirstFiling: true,
        pastBuys: [],
        pastSells: [],
        totalBoughtAllTime: filing.summary.totalBuyValue,
        lastBuyDate: null,
        daysSinceLastBuy: null,
        filingCount: 1,
      };
    }

    // Parse dates to find patterns
    const filingDates = relevantFilings
      .map(h => h._source?.file_date)
      .filter(Boolean)
      .sort()
      .reverse();

    const lastBuyDate = filingDates[1] || null; // [0] is current, [1] is previous
    const daysSinceLastBuy = lastBuyDate
      ? Math.floor((Date.now() - new Date(lastBuyDate).getTime()) / (1000 * 60 * 60 * 24))
      : null;

    return {
      isFirstFiling: false,
      filingCount: relevantFilings.length,
      lastBuyDate,
      daysSinceLastBuy,
      totalBoughtAllTime: filing.summary.totalBuyValue, // We only know current from parsed data
      pastFilingDates: filingDates.slice(1, 6), // Last 5 previous filings
    };
  } catch (e) {
    console.error('Insider history lookup error:', e.message);
    return null;
  }
}

/**
 * Look up an insider's buy track record with performance data.
 * This is the "CEO win rate" feature — shows how past buys performed.
 * 
 * Requires price API keys (FINNHUB_API_KEY or ALPHA_VANTAGE_KEY).
 * 
 * @param {string} ownerCik — the insider's CIK number
 * @param {string} ownerName — for display
 * @returns {object} — track record with win rate and individual trades
 */
async function getInsiderTrackRecord(ownerCik, ownerName) {
  if (!ownerCik) return null;
  if (!process.env.FINNHUB_API_KEY && !process.env.ALPHA_VANTAGE_KEY) return null;

  try {
    // Find all Form 4 filings by this person
    const url = `https://efts.sec.gov/LATEST/search-index?q=%22${ownerCik}%22&forms=4&from=0&size=30`;

    const res = await fetch(url, {
      headers: { 'User-Agent': SEC_USER_AGENT, 'Accept': 'application/json' }
    });
    await sleep(RATE_LIMIT_MS);

    if (!res.ok) return null;

    const data = await res.json();
    const hits = data.hits?.hits || [];

    // Group by company (issuer) using display names
    const byCompany = {};
    for (const hit of hits) {
      const names = hit._source?.display_names || [];
      const date = hit._source?.file_date;
      const ticker = hit._source?.tickers?.[0];
      if (!date || !ticker) continue;

      if (!byCompany[ticker]) {
        byCompany[ticker] = {
          ticker,
          companyName: names[0] || ticker,
          filings: [],
        };
      }
      byCompany[ticker].filings.push({ date });
    }

    // For each company, calculate return from earliest filing to now
    // (This is a simplified track record — proper version would parse each XML)
    const trackRecord = [];
    let wins = 0;
    let total = 0;

    for (const [ticker, info] of Object.entries(byCompany)) {
      if (info.filings.length === 0) continue;

      // Get the earliest filing date as "entry point"
      const earliest = info.filings
        .map(f => f.date)
        .sort()[0];

      // Only look at filings > 30 days old (need time for return to develop)
      const daysSince = Math.floor((Date.now() - new Date(earliest).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince < 30) continue;

      try {
        const result = await calculateReturn(ticker, earliest, null);
        await sleep(RATE_LIMIT_MS);

        if (result) {
          trackRecord.push({
            ticker,
            companyName: info.companyName,
            entryDate: earliest,
            ...result,
            filingCount: info.filings.length,
          });

          total++;
          if (result.returnPct > 0) wins++;
        }
      } catch (e) {
        // Skip tickers where we can't get price data
      }
    }

    // Sort by return (best first)
    trackRecord.sort((a, b) => b.returnPct - a.returnPct);

    return {
      ownerName,
      ownerCik,
      winRate: total > 0 ? Math.round((wins / total) * 100) : null,
      totalTrades: total,
      wins,
      losses: total - wins,
      avgReturn: total > 0
        ? Math.round(trackRecord.reduce((sum, t) => sum + t.returnPct, 0) / total * 100) / 100
        : null,
      bestTrade: trackRecord[0] || null,
      worstTrade: trackRecord[trackRecord.length - 1] || null,
      trades: trackRecord,
    };
  } catch (e) {
    console.error('Track record lookup error:', e.message);
    return null;
  }
}

/**
 * Enrich an array of scored filings (top picks + featured only, to conserve API calls).
 */
async function enrichAllFilings(scoredFilings) {
  const toEnrich = scoredFilings.filter(f =>
    f.tier === 'top_pick' || f.tier === 'feature'
  );

  const enriched = [];
  for (const filing of toEnrich) {
    enriched.push(await enrichFiling(filing));
  }

  // Replace the originals
  const enrichedTickers = new Set(enriched.map(f => f.ticker));
  const result = scoredFilings.map(f =>
    enrichedTickers.has(f.ticker)
      ? enriched.find(e => e.ticker === f.ticker && e.ownerCik === f.ownerCik) || f
      : f
  );

  return result;
}

module.exports = {
  enrichFiling,
  enrichAllFilings,
  generateWhyItMatters,
  getInsiderHistory,
  getInsiderTrackRecord,
};
