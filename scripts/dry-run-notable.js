#!/usr/bin/env node
/**
 * Local end-to-end dry-run of api/fetch-and-send.js with notable-pipeline focus.
 * Usage: node scripts/dry-run-notable.js
 * Invokes the handler with { query: { dry: "true" } }, captures the JSON
 * response, prints step-3g notable counts, and snapshots the scorecard
 * before/after to help debug contamination questions. No emails sent.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env.local') });

const handler = require('../api/fetch-and-send');

const mockReq = { query: { dry: 'true' }, headers: {} };
const captured = { status: null, body: null };
const mockRes = {
  status(code) { captured.status = code; return this; },
  json(obj) { captured.body = obj; return this; },
  setHeader() { return this; },
};

(async () => {
  console.log('\n=== Local dry run of api/fetch-and-send ===\n');
  const before = await (async () => {
    const { generateScorecard } = require('../lib/performance-tracker');
    const s = await generateScorecard();
    return { totalPicks: s.totalPicks, winRate: s.winRate, winners: s.winners, losers: s.losers };
  })();
  console.log('BEFORE scorecard snapshot:', JSON.stringify(before));
  console.log('---\n');

  try {
    await handler(mockReq, mockRes);
  } catch (e) {
    console.error('HANDLER THREW:', e.message);
    console.error(e.stack);
    process.exit(1);
  }

  console.log('\n---');
  console.log(`status: ${captured.status}`);
  if (!captured.body) { console.error('No body captured'); process.exit(1); }

  const r = captured.body;
  console.log(`success: ${r.success}`);
  console.log(`elapsed: ${r.elapsed}`);
  console.log(`stats:`, JSON.stringify(r.stats, null, 2));

  // Check win-rate unchanged
  const { generateScorecard } = require('../lib/performance-tracker');
  const after = await generateScorecard();
  const unchanged = after.totalPicks === before.totalPicks && after.winRate === before.winRate;
  console.log(`\nAFTER scorecard snapshot: totalPicks=${after.totalPicks} winRate=${after.winRate} winners=${after.winners} losers=${after.losers}`);
  console.log(`win-rate unchanged: ${unchanged ? '✓' : '✗ CONTAMINATED'}`);

  // Check notable entries written today
  const { getRedis } = require('../lib/redis');
  const redis = getRedis();
  const today = new Date().toISOString().slice(0, 10);
  const notableKeys = await redis.zrange(`notable:${today}`, 0, -1, { rev: true });
  console.log(`\nnotable:${today} has ${notableKeys?.length || 0} entries`);
  if (notableKeys?.length) {
    for (const k of notableKeys.slice(0, 5)) {
      const rec = await redis.get(k);
      const r = typeof rec === 'string' ? JSON.parse(rec) : rec;
      console.log(`  ${r.ticker} (mcap=$${r.marketCapMillions}M, buy=$${r.buyValue.toLocaleString()}, score=${r.score}, tier=${r.tier}): ${r.ownerName} — ${r.officerTitle || '(no title)'}`);
    }
  }

  process.exit(unchanged ? 0 : 2);
})();
