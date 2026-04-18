/**
 * Notable-but-not-scored filings.
 *
 * Our scoring model correctly penalizes large-cap insider buys because
 * small-cap buys historically outperform — but this means household-name
 * purchases (e.g. $NKE director $500K, $OSCR CEO $11.9M) never surface.
 * This module captures them in a separate editorial-color namespace.
 *
 * Critical invariants:
 *   - Notable entries MUST NOT bleed into picks:* / picks:index (scorecard safety)
 *   - Notable entries are NOT performance-tracked
 *   - Notable criteria apply ONLY to filings that already passed ingestion
 *     (open-market purchases; grants/gifts/exercises already filtered upstream)
 *
 * Redis schema (separate namespace from picks:* and filing:*):
 *   notable:{date}                               — sorted set by buyValue desc
 *   notable:filing:{date}:{ticker}:{ownerCik}    — filing record
 *   notable:index                                — sorted set across all dates (score = date ms)
 */

const { getRedis } = require('./redis');
const { isInstitutionalBuyer } = require('./signal-scorer');

// Finnhub returns marketCap in millions; our filing.marketCap matches that unit.
const NOTABLE_MIN_MARKET_CAP_MILLIONS = 2000;   // $2B
const NOTABLE_MIN_BUY_VALUE_USD       = 100_000;
const FEATURE_SCORE_CUTOFF            = 50;    // strictly below Feature tier

/**
 * Pure predicate. Given a scored filing with marketCap attached (step 3f in
 * fetch-and-send.js populates filing.marketCap in millions), return
 * { qualified: bool, reason: string }.
 */
function isNotable(scored) {
  if (!scored?.ticker) return { qualified: false, reason: 'no-ticker' };
  const buyValue = scored?.summary?.totalBuyValue || 0;
  const score = scored?.score ?? 0;
  const buyCount = scored?.summary?.buyCount || 0;

  if (score >= FEATURE_SCORE_CUTOFF) return { qualified: false, reason: 'made-feature-tier' };
  if (buyCount <= 0) return { qualified: false, reason: 'no-buys' };
  if (buyValue < NOTABLE_MIN_BUY_VALUE_USD) return { qualified: false, reason: 'below-buy-value' };
  if (isInstitutionalBuyer(scored?.ownerName || '')) return { qualified: false, reason: 'entity-buyer' };

  const mcapMm = scored?.marketCap || 0;
  if (mcapMm < NOTABLE_MIN_MARKET_CAP_MILLIONS) return { qualified: false, reason: 'below-market-cap' };

  return { qualified: true, reason: 'qualified' };
}

/**
 * Convert a scored filing to the compact notable record persisted to Redis.
 * Kept as its own function so tests can assert shape without re-implementing.
 */
function buildNotableRecord(scored, date) {
  const today = date || new Date().toISOString().slice(0, 10);
  const ownerKey = scored.ownerCik || scored.ownerName || 'unknown';
  return {
    key: `notable:filing:${today}:${scored.ticker}:${ownerKey}`,
    ticker: scored.ticker,
    issuerName: scored.issuerName || null,
    issuerCik: scored.issuerCik || null,
    ownerName: scored.ownerName || null,
    ownerCik: scored.ownerCik || null,
    officerTitle: scored.officerTitle || null,
    isDirector: scored.isDirector || false,
    isOfficer: scored.isOfficer || false,
    score: scored.score ?? null,
    tier: scored.tier || null,
    buyValue: scored.summary?.totalBuyValue || 0,
    buyShares: scored.summary?.totalBuyShares || 0,
    buyCount: scored.summary?.buyCount || 0,
    marketCapMillions: scored.marketCap || 0,
    sector: scored.sector || null,
    filedAt: scored.filedAt || null,
    accessionNumber: scored.accessionNumber || null,
    date: today,
  };
}

/**
 * Filter + write notable entries. Non-fatal: any Redis error is logged and
 * swallowed so the scored-picks pipeline can keep running.
 *
 * Returns the array of notable records that qualified (written or not — a
 * write-path failure still returns the qualifying records so the email can
 * render them; only persistence is best-effort).
 */
async function storeNotableFilings(scored, date) {
  const today = date || new Date().toISOString().slice(0, 10);
  const r = getRedis();
  const notable = [];

  for (const f of (scored || [])) {
    const check = isNotable(f);
    if (!check.qualified) continue;
    notable.push(buildNotableRecord(f, today));
  }

  if (!notable.length || !r) return notable;

  try {
    const pipe = r.pipeline();
    for (const rec of notable) {
      pipe.set(rec.key, JSON.stringify(rec));
      pipe.zadd(`notable:${today}`, { score: rec.buyValue, member: rec.key });
      pipe.zadd('notable:index', { score: new Date(today).getTime(), member: rec.key });
    }
    await pipe.exec();
  } catch (e) {
    console.error('  Notable write failed (non-fatal):', e.message);
  }

  return notable;
}

/**
 * Query notable entries across a date range (inclusive on both ends).
 * Used by the scorecard API and the weekly email.
 */
async function getNotableForRange(fromDate, toDate) {
  const r = getRedis();
  if (!r) return [];
  const fromTs = new Date(`${fromDate}T00:00:00Z`).getTime();
  const toTs   = new Date(`${toDate}T23:59:59Z`).getTime();
  try {
    const keys = await r.zrange('notable:index', fromTs, toTs, { byScore: true });
    if (!keys || !keys.length) return [];
    const raws = await Promise.all(keys.map(k => r.get(k)));
    return raws
      .filter(Boolean)
      .map(v => (typeof v === 'string' ? JSON.parse(v) : v))
      .sort((a, b) => (a.date === b.date ? b.buyValue - a.buyValue : a.date < b.date ? 1 : -1));
  } catch (e) {
    console.error('  Notable range query failed:', e.message);
    return [];
  }
}

module.exports = {
  NOTABLE_MIN_MARKET_CAP_MILLIONS,
  NOTABLE_MIN_BUY_VALUE_USD,
  FEATURE_SCORE_CUTOFF,
  isNotable,
  buildNotableRecord,
  storeNotableFilings,
  getNotableForRange,
};
