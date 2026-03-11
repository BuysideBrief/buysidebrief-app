/**
 * Stock Price Helper
 * 
 * Fetches current and historical prices for performance tracking.
 * Primary: Finnhub (60 req/min free tier)
 * Fallback: Alpha Vantage (25 req/day free tier)
 * 
 * Env vars needed:
 *   FINNHUB_API_KEY — free at finnhub.io
 *   ALPHA_VANTAGE_KEY — free at alphavantage.co (optional fallback)
 */

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const AV_KEY = process.env.ALPHA_VANTAGE_KEY || '';

const RATE_LIMIT_MS = 100;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Get the current quote for a ticker.
 * Returns { price, change, changePercent, high, low, open, prevClose }
 */
async function getQuote(ticker) {
  if (FINNHUB_KEY) {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(ticker)}&token=${FINNHUB_KEY}`
      );
      if (res.ok) {
        const d = await res.json();
        if (d.c && d.c > 0) {
          return {
            price: d.c,
            change: d.d,
            changePercent: d.dp,
            high: d.h,
            low: d.l,
            open: d.o,
            prevClose: d.pc,
            source: 'finnhub',
          };
        }
      }
    } catch (e) { console.error('Finnhub quote error:', e.message); }
    await sleep(RATE_LIMIT_MS);
  }

  // Fallback: Alpha Vantage
  if (AV_KEY) {
    try {
      const res = await fetch(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(ticker)}&apikey=${AV_KEY}`
      );
      if (res.ok) {
        const d = await res.json();
        const q = d['Global Quote'] || {};
        if (q['05. price']) {
          return {
            price: parseFloat(q['05. price']),
            change: parseFloat(q['09. change']),
            changePercent: parseFloat(q['10. change percent']),
            high: parseFloat(q['03. high']),
            low: parseFloat(q['04. low']),
            open: parseFloat(q['02. open']),
            prevClose: parseFloat(q['08. previous close']),
            source: 'alphavantage',
          };
        }
      }
    } catch (e) { console.error('AV quote error:', e.message); }
  }

  return null;
}

/**
 * Get historical daily closing prices for a ticker.
 * Returns array of { date, close, volume } sorted newest first.
 * 
 * @param {string} ticker
 * @param {number} days — how many trading days back (max ~250 for free tiers)
 */
async function getHistoricalPrices(ticker, days = 90) {
  if (FINNHUB_KEY) {
    try {
      const now = Math.floor(Date.now() / 1000);
      const from = now - (days * 24 * 60 * 60 * 1.5); // 1.5x to account for weekends
      const res = await fetch(
        `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(ticker)}&resolution=D&from=${Math.floor(from)}&to=${now}&token=${FINNHUB_KEY}`
      );
      if (res.ok) {
        const d = await res.json();
        if (d.s === 'ok' && d.c && d.c.length > 0) {
          const prices = d.t.map((ts, i) => ({
            date: new Date(ts * 1000).toISOString().split('T')[0],
            close: d.c[i],
            volume: d.v[i],
          }));
          prices.reverse(); // newest first
          return { prices, source: 'finnhub' };
        }
      }
    } catch (e) { console.error('Finnhub history error:', e.message); }
    await sleep(RATE_LIMIT_MS);
  }

  // Fallback: Alpha Vantage
  if (AV_KEY) {
    try {
      const res = await fetch(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}&outputsize=compact&apikey=${AV_KEY}`
      );
      if (res.ok) {
        const d = await res.json();
        const series = d['Time Series (Daily)'] || {};
        const prices = Object.entries(series)
          .map(([date, vals]) => ({
            date,
            close: parseFloat(vals['4. close']),
            volume: parseInt(vals['5. volume']),
          }))
          .slice(0, days); // already sorted newest first from AV
        return { prices, source: 'alphavantage' };
      }
    } catch (e) { console.error('AV history error:', e.message); }
  }

  return { prices: [], source: 'none' };
}

/**
 * Get price at a specific date (or closest trading day).
 * Useful for "what was the price when the insider bought?"
 */
async function getPriceAtDate(ticker, targetDate) {
  const { prices } = await getHistoricalPrices(ticker, 120);
  if (!prices.length) return null;

  // Find the closest date on or after the target
  const target = new Date(targetDate).toISOString().split('T')[0];

  // Prices are sorted newest first, so find the closest match
  let closest = null;
  for (const p of prices) {
    if (p.date <= target) {
      closest = p;
      break;
    }
  }

  return closest || prices[prices.length - 1]; // fallback to oldest available
}

/**
 * Calculate return from a given date to now.
 * Returns { entryPrice, currentPrice, returnPct, daysSince }
 */
async function calculateReturn(ticker, entryDate, entryPrice) {
  const quote = await getQuote(ticker);
  if (!quote) return null;

  const entry = entryPrice || (await getPriceAtDate(ticker, entryDate))?.close;
  if (!entry) return null;

  const returnPct = ((quote.price - entry) / entry) * 100;
  const daysSince = Math.floor((Date.now() - new Date(entryDate).getTime()) / (1000 * 60 * 60 * 24));

  return {
    ticker,
    entryDate,
    entryPrice: entry,
    currentPrice: quote.price,
    returnPct: Math.round(returnPct * 100) / 100,
    daysSince,
    isPositive: returnPct > 0,
  };
}

/**
 * Get the 52-week high and low for a ticker.
 * Returns { high52w, low52w, currentPrice, pctFromLow, pctFromHigh, nearLow }
 */
async function get52WeekRange(ticker) {
  const { prices } = await getHistoricalPrices(ticker, 260); // ~52 weeks of trading days
  if (!prices || prices.length < 20) return null; // need meaningful history

  const closes = prices.map(p => p.close).filter(c => c > 0);
  if (closes.length === 0) return null;

  const high52w = Math.max(...closes);
  const low52w = Math.min(...closes);
  const currentPrice = closes[0]; // newest first

  if (low52w === 0 || high52w === 0) return null;

  const pctFromLow = ((currentPrice - low52w) / low52w) * 100;
  const pctFromHigh = ((currentPrice - high52w) / high52w) * 100;

  return {
    high52w: Math.round(high52w * 100) / 100,
    low52w: Math.round(low52w * 100) / 100,
    currentPrice: Math.round(currentPrice * 100) / 100,
    pctFromLow: Math.round(pctFromLow * 100) / 100,
    pctFromHigh: Math.round(pctFromHigh * 100) / 100,
    nearLow: pctFromLow <= 15, // within 15% of 52-week low
    nearHigh: Math.abs(pctFromHigh) <= 10, // within 10% of 52-week high
    range52w: Math.round(((high52w - low52w) / low52w) * 100), // total range as %
  };
}

module.exports = {
  getQuote,
  getHistoricalPrices,
  getPriceAtDate,
  calculateReturn,
  get52WeekRange,
};
