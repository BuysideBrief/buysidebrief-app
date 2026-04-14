#!/usr/bin/env node

/**
 * Backfill Metadata
 *
 * Scans all published blog articles in Redis, identifies those with
 * titles or meta descriptions outside the target length ranges, and
 * regenerates the metadata fields via Claude.
 *
 * Usage:
 *   node scripts/backfill-metadata.js           # Dry run — list flagged posts
 *   node scripts/backfill-metadata.js --fix      # Regenerate and save to Redis
 */

require('dotenv').config();

const { Redis } = require('@upstash/redis');
const Anthropic = require('@anthropic-ai/sdk');
const { constrainLength } = require('../lib/article-generator');

const TITLE_MIN = 50;
const TITLE_MAX = 60;
const DESC_MIN = 140;
const DESC_MAX = 155;

function isTitleOk(title) {
  return title && title.length >= TITLE_MIN && title.length <= TITLE_MAX;
}

function isDescOk(desc) {
  return desc && desc.length >= DESC_MIN && desc.length <= DESC_MAX;
}

async function regenerateMetadata(article) {
  const client = new Anthropic();

  const message = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: `You rewrite blog post metadata for SEO. Return ONLY valid JSON, nothing else.`,
    messages: [{
      role: 'user',
      content: `Rewrite the title and meta description for this blog post.

Current title (${article.title.length} chars): "${article.title}"
Current meta description (${(article.metaDescription || '').length} chars): "${article.metaDescription}"
Keyword: "${article.keyword}"
Category: ${article.category}

Rules:
- title: MUST be 50-60 characters. Count carefully.
- metaDescription: MUST be 140-155 characters. Count carefully. Must include the keyword.
- Keep the same topic and meaning, just adjust length.
- Return JSON: {"title": "...", "metaDescription": "..."}`,
    }],
  });

  const raw = message.content[0].text.trim();
  try {
    const parsed = JSON.parse(raw.replace(/^```json?\s*\n?/i, '').replace(/\n?```\s*$/i, ''));

    // Apply hard constraints as safety net
    parsed.title = constrainLength(parsed.title || article.title, TITLE_MIN, TITLE_MAX);
    parsed.metaDescription = constrainLength(parsed.metaDescription || article.metaDescription, DESC_MIN, DESC_MAX);

    return parsed;
  } catch (e) {
    console.error(`  Failed to parse LLM response for ${article.slug}:`, e.message);
    console.error(`  Raw:`, raw.slice(0, 200));
    return null;
  }
}

async function main() {
  const fix = process.argv.includes('--fix');

  const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN,
  });

  // Load article index
  let indexRaw = await redis.get('seo:article-index');
  if (!indexRaw) {
    console.log('No article index found in Redis.');
    return;
  }
  const index = typeof indexRaw === 'string' ? JSON.parse(indexRaw) : indexRaw;
  console.log(`Found ${index.length} articles in index.\n`);

  // Scan all articles and flag problems
  const flagged = [];
  for (const entry of index) {
    const raw = await redis.get(`seo:article:${entry.slug}`);
    if (!raw) continue;
    const article = typeof raw === 'string' ? JSON.parse(raw) : raw;

    const issues = [];
    if (!isTitleOk(article.title)) {
      issues.push(`title ${article.title.length} chars (want ${TITLE_MIN}-${TITLE_MAX})`);
    }
    if (!isDescOk(article.metaDescription)) {
      issues.push(`desc ${(article.metaDescription || '').length} chars (want ${DESC_MIN}-${DESC_MAX})`);
    }

    if (issues.length > 0) {
      flagged.push({ article, issues });
    }
  }

  if (flagged.length === 0) {
    console.log('All articles have metadata within target ranges. Nothing to do.');
    return;
  }

  console.log(`${flagged.length} articles flagged:\n`);
  for (const { article, issues } of flagged) {
    console.log(`  /blog/${article.slug}`);
    console.log(`    URL: https://www.buysidebrief.com/blog/${article.slug}`);
    console.log(`    Issues: ${issues.join(', ')}`);
    console.log(`    Title (${article.title.length}): "${article.title}"`);
    console.log(`    Desc (${(article.metaDescription || '').length}): "${article.metaDescription}"`);
    console.log();
  }

  if (!fix) {
    console.log('Run with --fix to regenerate metadata and save to Redis.');
    return;
  }

  console.log('--- Regenerating metadata ---\n');

  let updated = 0;
  const updatedIndex = typeof indexRaw === 'string' ? JSON.parse(indexRaw) : [...index];

  for (const { article } of flagged) {
    console.log(`Fixing: /blog/${article.slug}`);
    const newMeta = await regenerateMetadata(article);

    if (!newMeta) {
      console.log('  Skipped (LLM parse failure)\n');
      continue;
    }

    const oldTitle = article.title;
    const oldDesc = article.metaDescription;

    article.title = newMeta.title;
    article.metaDescription = newMeta.metaDescription;

    console.log(`  Title: "${oldTitle}" (${oldTitle.length}) -> "${article.title}" (${article.title.length})`);
    console.log(`  Desc:  "${oldDesc}" (${(oldDesc || '').length}) -> "${article.metaDescription}" (${article.metaDescription.length})`);

    // Save article back to Redis
    await redis.set(`seo:article:${article.slug}`, JSON.stringify(article));

    // Update index entry title
    const idxEntry = updatedIndex.find((e) => e.slug === article.slug);
    if (idxEntry) {
      idxEntry.title = article.title;
    }

    updated++;
    console.log('  Saved.\n');

    // Small delay to avoid rate limits
    await new Promise((r) => setTimeout(r, 500));
  }

  // Save updated index
  await redis.set('seo:article-index', JSON.stringify(updatedIndex));

  console.log(`\nDone. Updated ${updated}/${flagged.length} articles.`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
