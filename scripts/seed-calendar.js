#!/usr/bin/env node

/**
 * Seed Content Calendar
 *
 * Runs keyword research, scores and ranks keywords, then generates
 * a 30-day content calendar. Optionally saves to Upstash Redis.
 *
 * Usage:
 *   node scripts/seed-calendar.js --dry-run    # Print only, no Redis save
 *   node scripts/seed-calendar.js              # Save to Redis
 */

require('dotenv').config();

const { runKeywordResearch, generateContentCalendar } = require('../lib/keyword-research');

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  console.log('='.repeat(60));
  console.log('  Buyside Brief — SEO Content Calendar Generator');
  console.log('='.repeat(60));
  console.log();

  // Step 1: Keyword Research
  console.log('[1/4] Running keyword research...');
  const keywords = await runKeywordResearch({ maxAutocompleteQueries: 40, minScore: 20 });
  console.log();

  // Step 2: Print top 20
  console.log('[2/4] Top 20 keywords:');
  console.log('-'.repeat(80));
  console.log(
    'Score'.padStart(5),
    'Category'.padEnd(12),
    'Source'.padEnd(14),
    'Keyword'
  );
  console.log('-'.repeat(80));
  for (const kw of keywords.slice(0, 20)) {
    console.log(
      String(kw.score).padStart(5),
      kw.category.padEnd(12),
      kw.source.padEnd(14),
      kw.keyword
    );
  }
  console.log();

  // Step 3: Generate calendar
  console.log('[3/4] Generating 30-day content calendar...');
  const calendar = generateContentCalendar(keywords, { days: 30, postsPerDay: 1 });
  console.log();
  console.log('-'.repeat(100));
  console.log(
    'Day'.padStart(3),
    'Date'.padEnd(12),
    'DoW'.padEnd(10),
    'Cat'.padEnd(12),
    'Score'.padStart(5),
    '  Title'
  );
  console.log('-'.repeat(100));
  for (const entry of calendar) {
    console.log(
      String(entry.day).padStart(3),
      entry.date.padEnd(12),
      entry.dayOfWeek.padEnd(10),
      entry.category.padEnd(12),
      String(entry.score).padStart(5),
      '  ' + entry.suggestedTitle.slice(0, 55)
    );
  }
  console.log();

  // Step 4: Save to Redis (unless dry run)
  if (isDryRun) {
    console.log('[4/4] Dry run — skipping Redis save.');
    console.log(`  ${keywords.length} keywords scored, ${calendar.length} calendar entries generated.`);
  } else {
    console.log('[4/4] Saving to Redis...');
    const { getRedis } = require('../lib/redis');
    const redis = getRedis();
    if (!redis) {
      console.error('  ERROR: Redis not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.');
      process.exit(1);
    }

    const { BlogStore } = require('../lib/publish-pipeline');
    const store = new BlogStore(redis);

    await store.saveCalendar(calendar);
    await redis.set('seo:keyword-research', JSON.stringify(keywords));

    console.log(`  Saved ${calendar.length} calendar entries to seo:calendar`);
    console.log(`  Saved ${keywords.length} keywords to seo:keyword-research`);
  }

  console.log();
  console.log('Done!');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
