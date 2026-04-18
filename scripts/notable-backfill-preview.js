#!/usr/bin/env node
/**
 * Read-only "what would have qualified as notable in the last N days?" preview.
 * Usage: node scripts/notable-backfill-preview.js <days>      (default 7)
 * Scans filing:* records in Redis, applies the current isNotable() filter,
 * and prints qualifiers + rejection-reason counts. Does NOT write to Redis.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const { getRedis } = require('../lib/redis');
const { getCompanyProfile } = require('../lib/company-profile');
const { isNotable } = require('../lib/notable');

const DAYS = parseInt(process.argv[2] || '7', 10);

(async () => {
  const r = getRedis();
  const today = new Date();
  const qualified = [];
  const dailyRejects = {};

  for (let i = 0; i < DAYS; i++) {
    const d = new Date(today.getTime() - i * 86400000);
    const date = d.toISOString().slice(0, 10);
    const idxKey = `filings:index:${date}`;
    const filingKeys = await r.zrange(idxKey, 0, -1) || [];
    if (!filingKeys.length) continue;

    for (const k of filingKeys) {
      const raw = await r.get(k);
      if (!raw) continue;
      const f = typeof raw === 'string' ? JSON.parse(raw) : raw;

      // filing:* records from historical-store.js don't have marketCap — pull it (cached).
      let marketCap = f.marketCap;
      if (!marketCap && f.ticker) {
        try {
          const profile = await getCompanyProfile(f.ticker);
          marketCap = profile?.marketCap || 0;
        } catch { marketCap = 0; }
      }

      // Reshape to what isNotable() expects.
      const scoredShape = {
        ticker: f.ticker,
        issuerName: f.issuerName,
        ownerName: f.ownerName,
        ownerCik: f.ownerCik,
        officerTitle: f.officerTitle,
        isDirector: f.isDirector,
        isOfficer: f.isOfficer,
        score: f.score,
        tier: f.tier,
        summary: {
          totalBuyValue: f.buyValue || 0,
          totalBuyShares: f.buyShares || 0,
          buyCount: f.buyCount || 0,
        },
        marketCap,
      };

      const check = isNotable(scoredShape);
      if (check.qualified) {
        qualified.push({ date, ...scoredShape, _check: check });
      } else {
        dailyRejects[check.reason] = (dailyRejects[check.reason] || 0) + 1;
      }
    }
  }

  console.log(`\n=== Notable backfill preview — last ${DAYS} days ===\n`);
  console.log(`QUALIFYING: ${qualified.length}\n`);
  for (const q of qualified.slice(0, 20)) {
    console.log(`  ${q.date} ${q.ticker} — ${q.ownerName} (${q.officerTitle || 'Insider'})`);
    console.log(`    buy=$${(q.summary.totalBuyValue).toLocaleString()} | mcap=$${q.marketCap}M | score=${q.score} tier=${q.tier}`);
  }
  console.log(`\nRejection reasons (aggregate across all scanned filings):`);
  for (const [reason, n] of Object.entries(dailyRejects).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${reason}: ${n}`);
  }
})().catch(e => { console.error(e); process.exit(1); });
