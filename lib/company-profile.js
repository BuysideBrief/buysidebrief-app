/**
 * Company Profile Module
 *
 * Fetches and caches company profile data (sector, industry, market cap)
 * from Finnhub. Stores in Redis with 30-day TTL to minimize API calls.
 *
 * Primary: Finnhub /stock/profile2 endpoint
 * Env vars needed: FINNHUB_API_KEY
 */

const { getRedis } = require('./redis');

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const RATE_LIMIT_MS = 200;
const FETCH_TIMEOUT_MS = 10000;
const CACHE_TTL_SECONDS = 2592000; // 30 days

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Sector mapping from Finnhub's granular industry labels to 11 broad sectors.
 * Keys are lowercase for case-insensitive matching.
 * @type {Record<string, string>}
 */
const SECTOR_MAP = {
  // Technology
  'technology': 'Technology',
  'semiconductors': 'Technology',
  'software': 'Technology',
  'hardware': 'Technology',
  'internet': 'Technology',
  'cloud computing': 'Technology',
  'cybersecurity': 'Technology',
  'information technology': 'Technology',
  'electronic technology': 'Technology',
  'technology services': 'Technology',

  // Healthcare
  'healthcare': 'Healthcare',
  'biotechnology': 'Healthcare',
  'pharmaceuticals': 'Healthcare',
  'medical devices': 'Healthcare',
  'health technology': 'Healthcare',
  'health services': 'Healthcare',
  'life sciences': 'Healthcare',

  // Financial Services
  'banking': 'Financial Services',
  'financial services': 'Financial Services',
  'insurance': 'Financial Services',
  'asset management': 'Financial Services',
  'capital markets': 'Financial Services',
  'finance': 'Financial Services',
  'financial': 'Financial Services',

  // Energy
  'energy': 'Energy',
  'oil & gas': 'Energy',
  'oil and gas': 'Energy',
  'renewable energy': 'Energy',
  'energy minerals': 'Energy',

  // Consumer Cyclical
  'consumer cyclical': 'Consumer Cyclical',
  'retail': 'Consumer Cyclical',
  'retail trade': 'Consumer Cyclical',
  'consumer durables': 'Consumer Cyclical',
  'consumer services': 'Consumer Cyclical',
  'automotive': 'Consumer Cyclical',
  'travel & leisure': 'Consumer Cyclical',
  'apparel': 'Consumer Cyclical',
  'restaurants': 'Consumer Cyclical',
  'homebuilding': 'Consumer Cyclical',
  'distribution services': 'Consumer Cyclical',

  // Consumer Defensive
  'consumer defensive': 'Consumer Defensive',
  'consumer non-durables': 'Consumer Defensive',
  'food & beverage': 'Consumer Defensive',
  'household products': 'Consumer Defensive',
  'consumer staples': 'Consumer Defensive',

  // Industrials
  'industrials': 'Industrials',
  'aerospace & defense': 'Industrials',
  'industrial services': 'Industrials',
  'manufacturing': 'Industrials',
  'producer manufacturing': 'Industrials',
  'transportation': 'Industrials',
  'commercial services': 'Industrials',
  'process industries': 'Industrials',

  // Basic Materials
  'basic materials': 'Basic Materials',
  'chemicals': 'Basic Materials',
  'mining': 'Basic Materials',
  'metals & mining': 'Basic Materials',
  'non-energy minerals': 'Basic Materials',

  // Real Estate
  'real estate': 'Real Estate',
  'reits': 'Real Estate',

  // Utilities
  'utilities': 'Utilities',

  // Communication Services
  'communication services': 'Communication Services',
  'media': 'Communication Services',
  'telecommunications': 'Communication Services',
  'communications': 'Communication Services',
};

/**
 * Map a Finnhub industry label to one of 11 broad sectors.
 * Returns the raw industry string if no mapping is found.
 *
 * @param {string} finnhubIndustry — industry label from Finnhub profile2 API
 * @returns {string} broad sector name or raw industry
 */
function getSectorLabel(finnhubIndustry) {
  if (!finnhubIndustry) return 'Unknown';
  const mapped = SECTOR_MAP[finnhubIndustry.toLowerCase()];
  return mapped || finnhubIndustry;
}

/**
 * Fetch and cache a company profile for a single ticker.
 *
 * Checks Redis first (key: company:{TICKER}), calls Finnhub on miss.
 * Failures are NOT cached so the next call can retry.
 *
 * @param {string} ticker
 * @returns {Promise<{sector: string, marketCap: number, exchange: string, name: string, ipoDate: string, lastUpdated: string}|null>}
 */
async function getCompanyProfile(ticker) {
  if (!ticker) return null;
  const key = `company:${ticker.toUpperCase()}`;

  // Check cache
  const redis = getRedis();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        return typeof cached === 'string' ? JSON.parse(cached) : cached;
      }
    } catch (e) {
      console.error(`Redis read error for ${key}:`, e.message);
    }
  }

  // Fetch from Finnhub
  if (!FINNHUB_KEY) return null;

  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/stock/profile2?symbol=${encodeURIComponent(ticker.toUpperCase())}&token=${FINNHUB_KEY}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }
    );

    if (!res.ok) return null;

    const d = await res.json();
    if (!d || !d.name) return null; // empty response for unknown tickers

    const profile = {
      sector: d.finnhubIndustry || null,
      marketCap: d.marketCapitalization || null,
      exchange: d.exchange || null,
      name: d.name || null,
      ipoDate: d.ipo || null,
      lastUpdated: new Date().toISOString(),
    };

    // Cache in Redis (don't cache failures)
    if (redis) {
      try {
        await redis.set(key, JSON.stringify(profile), { ex: CACHE_TTL_SECONDS });
      } catch (e) {
        console.error(`Redis write error for ${key}:`, e.message);
      }
    }

    return profile;
  } catch (e) {
    console.error(`Finnhub profile error for ${ticker}:`, e.message);
    return null;
  } finally {
    await sleep(RATE_LIMIT_MS);
  }
}

/**
 * Fetch and cache company profiles for multiple tickers.
 *
 * Batch-checks Redis first via pipeline, then fetches uncached tickers
 * from Finnhub one at a time with rate limiting.
 *
 * @param {string[]} tickers
 * @returns {Promise<Map<string, object|null>>} ticker → profile (or null)
 */
async function getCompanyProfileBatch(tickers) {
  const results = new Map();
  if (!tickers || tickers.length === 0) return results;

  const normalized = tickers.map(t => t.toUpperCase());
  const unique = [...new Set(normalized)];

  let cachedCount = 0;
  let fetchedCount = 0;
  let failedCount = 0;

  // Batch check Redis cache
  const redis = getRedis();
  const uncached = [];

  if (redis) {
    try {
      const pipeline = redis.pipeline();
      for (const ticker of unique) {
        pipeline.get(`company:${ticker}`);
      }
      const cached = await pipeline.exec();

      for (let i = 0; i < unique.length; i++) {
        const val = cached[i];
        if (val) {
          const profile = typeof val === 'string' ? JSON.parse(val) : val;
          results.set(unique[i], profile);
          cachedCount++;
        } else {
          uncached.push(unique[i]);
        }
      }
    } catch (e) {
      console.error('Redis batch read error:', e.message);
      uncached.push(...unique.filter(t => !results.has(t)));
    }
  } else {
    uncached.push(...unique);
  }

  // Fetch uncached from Finnhub
  if (FINNHUB_KEY) {
    for (const ticker of uncached) {
      try {
        const profile = await getCompanyProfile(ticker);
        if (profile) {
          results.set(ticker, profile);
          fetchedCount++;
        } else {
          results.set(ticker, null);
          failedCount++;
        }
      } catch (e) {
        console.error(`Profile fetch failed for ${ticker}:`, e.message);
        results.set(ticker, null);
        failedCount++;
      }
    }
  } else {
    for (const ticker of uncached) {
      results.set(ticker, null);
      failedCount++;
    }
  }

  console.log(`Profiles: ${cachedCount} cached, ${fetchedCount} fetched, ${failedCount} failed`);
  return results;
}

module.exports = {
  getCompanyProfile,
  getCompanyProfileBatch,
  getSectorLabel,
};
