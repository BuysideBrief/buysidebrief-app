#!/usr/bin/env node
/**
 * Backfill Company Profiles
 *
 * Retroactively fetches Finnhub profiles for all tickers already in Redis
 * from historical filings and pick records.
 *
 * Usage: node scripts/backfill-company-profiles.js
 */

require('dotenv').config();
const { getRedis } = require('../lib/redis');
const { getCompanyProfileBatch } = require('../lib/company-profile');

async function backfill() {
  const redis = getRedis();
  if (!redis) {
    console.error('Redis not available. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
    process.exit(1);
  }

  if (!process.env.FINNHUB_API_KEY) {
    console.error('FINNHUB_API_KEY not set.');
    process.exit(1);
  }

  console.log('Scanning Redis for tickers...');
  const tickers = new Set();

  // Scan filing:* keys — format: filing:{date}:{ticker}:{ownerCik}
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'filing:*', count: 200 });
    cursor = nextCursor;
    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length >= 3 && parts[2]) {
        tickers.add(parts[2].toUpperCase());
      }
    }
  } while (cursor !== '0' && cursor !== 0);

  console.log(`  Found ${tickers.size} unique tickers from filing:* keys`);

  // Scan pick:* keys — format: pick:{ticker}:{date}:{ownerCik}
  cursor = '0';
  const pickTickersBefore = tickers.size;
  do {
    const [nextCursor, keys] = await redis.scan(cursor, { match: 'pick:*', count: 200 });
    cursor = nextCursor;
    for (const key of keys) {
      const parts = key.split(':');
      if (parts.length >= 2 && parts[1]) {
        tickers.add(parts[1].toUpperCase());
      }
    }
  } while (cursor !== '0' && cursor !== 0);

  const newFromPicks = tickers.size - pickTickersBefore;
  if (newFromPicks > 0) {
    console.log(`  Found ${newFromPicks} additional tickers from pick:* keys`);
  }

  console.log(`\nTotal unique tickers: ${tickers.size}`);

  if (tickers.size === 0) {
    console.log('No tickers to backfill.');
    return;
  }

  // Fetch profiles
  console.log('Fetching profiles...\n');
  const tickerArray = [...tickers].sort();
  const profiles = await getCompanyProfileBatch(tickerArray);

  // Summarize results
  const fetched = [];
  const cached = [];
  const failed = [];

  for (const [ticker, profile] of profiles) {
    if (profile === null) {
      failed.push(ticker);
    } else if (profile.lastUpdated) {
      // All results come back — we can't distinguish cached vs fetched here
      // but getCompanyProfileBatch already logged that
      fetched.push(ticker);
    }
  }

  console.log(`\nBackfill complete: ${profiles.size} tickers processed.`);

  if (failed.length > 0) {
    console.log(`\nFailed tickers (${failed.length}) — likely delisted or OTC:`);
    console.log(`  ${failed.join(', ')}`);
  }
}

backfill().catch(e => {
  console.error('Backfill failed:', e);
  process.exit(1);
});
