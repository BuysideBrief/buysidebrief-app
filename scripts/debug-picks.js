/**
 * Debug script — dump pick records to understand data shape.
 * Usage: node scripts/debug-picks.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const { getRedis } = require('../lib/redis');

async function main() {
  const kv = getRedis();
  if (!kv) { console.error('No Redis'); process.exit(1); }

  const pickIds = await kv.zrange('picks:index', 0, -1);
  console.log(`picks:index has ${pickIds.length} entries\n`);

  // Sample: first 3, last 3
  const sample = [
    ...pickIds.slice(0, 3),
    ...pickIds.slice(-3),
  ];
  // Dedupe in case <6 total
  const unique = [...new Set(sample)];

  for (const id of unique) {
    const pick = await kv.get(id);
    console.log(`── ${id} ──`);
    if (!pick) { console.log('  (null)\n'); continue; }

    // Print all top-level keys
    console.log('  Keys:', Object.keys(pick).join(', '));

    // Print key fields
    console.log('  entryPrice:', pick.entryPrice);
    console.log('  entryDate:', pick.entryDate);
    console.log('  currentReturn:', pick.currentReturn);
    console.log('  return30d:', pick.return30d);
    console.log('  return60d:', pick.return60d);
    console.log('  return90d:', pick.return90d);
    console.log('  lastUpdated:', pick.lastUpdated);
    console.log('  tier:', pick.tier);
    console.log('  signals:', JSON.stringify(pick.signals));
    console.log();
  }

  // Summary: how many have entryPrice, return30d, etc.
  console.log('── Aggregate Stats ──');
  const pipeline = kv.pipeline();
  for (const id of pickIds) pipeline.get(id);
  const all = (await pipeline.exec()).filter(Boolean);

  const hasEntry = all.filter(p => p.entryPrice != null);
  const hasCurrentReturn = all.filter(p => p.currentReturn != null);
  const has30d = all.filter(p => p.return30d != null);
  const has60d = all.filter(p => p.return60d != null);
  const has90d = all.filter(p => p.return90d != null);
  const noEntryPrice = all.filter(p => p.entryPrice == null);

  console.log(`Total pick records: ${all.length}`);
  console.log(`With entryPrice: ${hasEntry.length}`);
  console.log(`With currentReturn: ${hasCurrentReturn.length}`);
  console.log(`With return30d: ${has30d.length}`);
  console.log(`With return60d: ${has60d.length}`);
  console.log(`With return90d: ${has90d.length}`);
  console.log(`Missing entryPrice: ${noEntryPrice.length}`);

  if (noEntryPrice.length > 0) {
    console.log('\nPicks missing entryPrice:');
    for (const p of noEntryPrice) {
      console.log(`  ${p.id} — ${p.ticker} — tier: ${p.tier} — entryDate: ${p.entryDate}`);
    }
  }

  // Age distribution
  const now = Date.now();
  const under30 = hasEntry.filter(p => {
    const days = (now - new Date(p.entryDate).getTime()) / (1000*60*60*24);
    return days < 30;
  });
  const between30and90 = hasEntry.filter(p => {
    const days = (now - new Date(p.entryDate).getTime()) / (1000*60*60*24);
    return days >= 30 && days < 90;
  });
  const over90 = hasEntry.filter(p => {
    const days = (now - new Date(p.entryDate).getTime()) / (1000*60*60*24);
    return days >= 90;
  });

  console.log(`\nAge distribution (picks with entryPrice):`);
  console.log(`  < 30 days old: ${under30.length} (too young for return30d)`);
  console.log(`  30-90 days old: ${between30and90.length}`);
  console.log(`  > 90 days old: ${over90.length}`);

  // Picks old enough for 30d but missing return30d
  const oldEnoughNoReturn = hasEntry.filter(p => {
    const days = (now - new Date(p.entryDate).getTime()) / (1000*60*60*24);
    return days >= 30 && p.return30d == null;
  });
  console.log(`  30+ days old but missing return30d: ${oldEnoughNoReturn.length}`);
  for (const p of oldEnoughNoReturn.slice(0, 5)) {
    const days = Math.floor((now - new Date(p.entryDate).getTime()) / (1000*60*60*24));
    console.log(`    ${p.id} — ${days}d old — lastUpdated: ${p.lastUpdated} — currentReturn: ${p.currentReturn}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
