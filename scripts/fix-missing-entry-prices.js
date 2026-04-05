/**
 * One-off script: Backfill missing entry prices for picks.
 *
 * Scans picks:index, finds any pick with null/undefined/0 entryPrice,
 * fetches historical price for that ticker+date, and writes it back.
 *
 * Usage: node scripts/fix-missing-entry-prices.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { getRedis } = require('../lib/redis');
const { getQuote, getPriceAtDate } = require('../lib/price-helper');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const kv = getRedis();
  if (!kv) {
    console.error('Redis connection failed — check env vars.');
    process.exit(1);
  }

  console.log('Loading pick IDs from picks:index...');
  const pickIds = await kv.zrange('picks:index', 0, -1);
  console.log(`Found ${pickIds.length} picks.`);

  // Batch-fetch all picks
  const pipeline = kv.pipeline();
  for (const id of pickIds) pipeline.get(id);
  const results = await pipeline.exec();

  // Find picks with missing entry prices
  const broken = [];
  for (let i = 0; i < results.length; i++) {
    const pick = results[i];
    if (!pick) continue;
    if (!pick.entryPrice) {
      broken.push({ id: pickIds[i], pick });
    }
  }

  console.log(`Found ${broken.length} picks with missing entryPrice.\n`);
  if (!broken.length) {
    console.log('Nothing to fix.');
    return;
  }

  let fixed = 0;
  let failed = 0;

  for (const { id, pick } of broken) {
    const { ticker, entryDate } = pick;
    console.log(`Fixing ${ticker} (${entryDate})...`);

    let price = null;

    // Try historical price at the entry date first
    if (entryDate) {
      try {
        const hist = await getPriceAtDate(ticker, entryDate);
        if (hist && hist.close > 0) {
          price = hist.close;
          console.log(`  → Got historical price: $${price.toFixed(2)} (${hist.date})`);
        }
      } catch (e) {
        console.log(`  → Historical lookup failed: ${e.message}`);
      }
      await sleep(1100); // respect Finnhub 60 req/min
    }

    // Fallback to current quote
    if (!price) {
      try {
        const quote = await getQuote(ticker);
        if (quote && quote.price > 0) {
          price = quote.price;
          console.log(`  → Using current price as fallback: $${price.toFixed(2)}`);
        }
      } catch (e) {
        console.log(`  → Quote failed: ${e.message}`);
      }
      await sleep(1100);
    }

    if (price) {
      pick.entryPrice = price;
      pick.lastUpdated = new Date().toISOString();
      await kv.set(id, pick);
      console.log(`  ✓ Fixed ${ticker} → $${price.toFixed(2)}`);
      fixed++;
    } else {
      console.log(`  ✗ Could not get price for ${ticker}`);
      failed++;
    }
  }

  console.log(`\nDone. Fixed: ${fixed}, Failed: ${failed}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
