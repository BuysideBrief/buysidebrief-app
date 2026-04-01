#!/usr/bin/env node

/**
 * Generate One Article
 *
 * Generates a single blog article for a given keyword and writes
 * the full HTML page + JSON to the output/ directory.
 *
 * Usage:
 *   node scripts/generate-one.js "what is SEC Form 4" --category educational
 *   node scripts/generate-one.js "insider trading tracker"
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { generateArticle, wrapArticleInPage } = require('../lib/article-generator');

async function main() {
  const args = process.argv.slice(2);
  const keyword = args.find((a) => !a.startsWith('--'));

  if (!keyword) {
    console.error('Usage: node scripts/generate-one.js "keyword" [--category TYPE]');
    process.exit(1);
  }

  let category = 'general';
  const catIdx = args.indexOf('--category');
  if (catIdx !== -1 && args[catIdx + 1]) {
    category = args[catIdx + 1];
  }

  console.log(`Generating article for: "${keyword}" (${category})`);
  console.log();

  const article = await generateArticle({
    keyword,
    category,
    suggestedTitle: null,
    relatedKeywords: [],
  });

  console.log(`Title:       ${article.title}`);
  console.log(`Slug:        ${article.slug}`);
  console.log(`Word count:  ${article.wordCount}`);
  console.log(`Description: ${article.metaDescription}`);
  console.log();

  // Write output files
  const outDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const htmlPath = path.join(outDir, `${article.slug}.html`);
  const jsonPath = path.join(outDir, `${article.slug}.json`);

  const fullPage = wrapArticleInPage(article);
  fs.writeFileSync(htmlPath, fullPage, 'utf-8');
  fs.writeFileSync(jsonPath, JSON.stringify(article, null, 2), 'utf-8');

  console.log(`HTML: ${htmlPath}`);
  console.log(`JSON: ${jsonPath}`);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
