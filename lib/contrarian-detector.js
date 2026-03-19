/**
 * Contrarian Signal Detector
 * 
 * Detects insider buys when the stock is significantly down from
 * its 52-week high. One of the strongest conviction signals —
 * the person with the most information about the company thinks
 * the market has it wrong.
 * 
 * Tiers:
 *   -20% to -30% from high → Contrarian signal (+10)
 *   -30% to -50% from high → Deep contrarian (+15)
 *   -50%+ from high        → Extreme contrarian (+20)
 * 
 * Uses Finnhub's quote + 52-week high data (already in price-helper).
 * 
 * Note: The existing 52-week-low proximity boost in context-enricher.js
 * rewards buying near the low. This module rewards buying after a big
 * drawdown from the high. They're related but different:
 *   - Near 52-week low = absolute floor proximity
 *   - Contrarian = percentage decline from peak (more intuitive for readers)
 */

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const RATE_LIMIT_MS = 200;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Drawdown thresholds and their score boosts.
 */
const CONTRARIAN_TIERS = [
  { minDrawdown: 0.50, boost: 20, label: 'Extreme contrarian', tag: 'EXTREME CONTRARIAN' },
  { minDrawdown: 0.30, boost: 15, label: 'Deep contrarian', tag: 'DEEP CONTRARIAN' },
  { minDrawdown: 0.20, boost: 10, label: 'Contrarian buy', tag: 'CONTRARIAN BUY' },
];

/**
 * Get the current price and 52-week high for a ticker.
 * Returns { price, high52w, drawdown, drawdownPct }
 * 
 * @param {string} ticker
 * @returns {object|null}
 */
async function getDrawdownData(ticker) {
  if (!FINNHUB_KEY || !ticker) return null;

  try {
    // Get current quote (includes 52-week high on some endpoints)
    const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`;
    const quoteRes = await fetch(quoteUrl);
    await sleep(RATE_LIMIT_MS);

    if (!quoteRes.ok) return null;

    const quote = await quoteRes.json();
    const currentPrice = quote.c;

    if (!currentPrice || currentPrice <= 0) return null;

    // Get basic financials which includes 52-week high
    const metricsUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${encodeURIComponent(ticker)}&metric=all&token=${FINNHUB_KEY}`;
    const metricsRes = await fetch(metricsUrl);
    await sleep(RATE_LIMIT_MS);

    if (!metricsRes.ok) return null;

    const metrics = await metricsRes.json();
    const high52w = metrics.metric?.['52WeekHigh'];

    if (!high52w || high52w <= 0) return null;

    const drawdown = (high52w - currentPrice) / high52w;
    const drawdownPct = Math.round(drawdown * 10000) / 100; // e.g. 34.21%

    return {
      ticker,
      price: currentPrice,
      high52w,
      drawdown,
      drawdownPct,
    };
  } catch (e) {
    console.error(`Contrarian data failed for ${ticker}:`, e.message);
    return null;
  }
}

/**
 * Analyze a single filing for contrarian signal.
 * Only applies to filings with buys.
 * 
 * @param {string} ticker
 * @returns {object|null} { signal, boost, label, tag, drawdownPct, high52w, price, context }
 */
async function analyzeContrarianSignal(ticker) {
  const data = await getDrawdownData(ticker);
  if (!data) return null;

  // Only flag if meaningful drawdown
  if (data.drawdown < 0.20) return null;

  // Find the matching tier
  for (const tier of CONTRARIAN_TIERS) {
    if (data.drawdown >= tier.minDrawdown) {
      return {
        signal: 'contrarian_buy',
        boost: tier.boost,
        label: tier.label,
        tag: tier.tag,
        drawdownPct: data.drawdownPct,
        high52w: data.high52w,
        price: data.price,
        context: `$${ticker} is down ${data.drawdownPct}% from its 52-week high of $${data.high52w.toFixed(2)}. When insiders buy at these levels, they're betting the selloff has gone too far.`,
      };
    }
  }

  return null;
}

/**
 * Batch analyze contrarian signals for multiple tickers.
 * Each ticker requires 2 API calls (quote + metrics), so
 * we cap at 15 tickers to stay under Finnhub rate limits.
 * 
 * Only analyzes filings that have buys (no point checking sells).
 * 
 * @param {Array} filings - Array of scored filings
 * @returns {Map} ticker → contrarianContext
 */
async function batchAnalyzeContrarian(filings) {
  const results = new Map();
  if (!FINNHUB_KEY) return results;

  // Only check filings with buys
  const withBuys = filings.filter(f => f.summary?.buyCount > 0 && f.ticker);

  // Deduplicate tickers
  const uniqueTickers = [...new Set(withBuys.map(f => f.ticker))];

  // Cap at 15 tickers (2 API calls each = 30 calls, under 60/min limit)
  const toProcess = uniqueTickers.slice(0, 15);

  for (const ticker of toProcess) {
    try {
      const context = await analyzeContrarianSignal(ticker);
      if (context) {
        results.set(ticker, context);
      }
    } catch (e) {
      console.error(`Contrarian batch failed for ${ticker}:`, e.message);
    }
  }

  return results;
}

module.exports = {
  getDrawdownData,
  analyzeContrarianSignal,
  batchAnalyzeContrarian,
  CONTRARIAN_TIERS,
};
