/**
 * Test script — runs the full pipeline locally.
 * 
 * Usage:
 *   node scripts/test-fetch.js
 *   node scripts/test-fetch.js --days=3     (look back 3 days)
 *   node scripts/test-fetch.js --count=20   (process 20 filings)
 * 
 * Outputs: scored filings to console + saves HTML digest to test-digest.html
 */

const { fetchRecentFilingsFromFeed, fetchAndParseForm4 } = require('../lib/sec-fetcher');
const { scoreAllFilings, categorizeForDigest } = require('../lib/signal-scorer');
const { formatDigestEmail } = require('../lib/email-formatter');
const fs = require('fs');
const path = require('path');

async function main() {
  // Parse CLI args
  const args = Object.fromEntries(
    process.argv.slice(2).map(a => {
      const [k, v] = a.replace('--', '').split('=');
      return [k, v || true];
    })
  );

  const count = parseInt(args.count) || 40;

  console.log('╔══════════════════════════════════════════╗');
  console.log('║   BUYSIDE BRIEF — Pipeline Test Run     ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log();

  // Step 1: Fetch index
  console.log(`[1/4] Fetching ${count} recent Form 4 filings from EDGAR...`);
  const filingIndex = await fetchRecentFilingsFromFeed(count);
  console.log(`  → Found ${filingIndex.length} filings\n`);

  if (filingIndex.length === 0) {
    console.log('No filings found. SEC might be down or it\'s a weekend/holiday.');
    return;
  }

  // Show first few from index
  console.log('  Sample from index:');
  filingIndex.slice(0, 3).forEach(f => {
    console.log(`    ${f.entityName} | CIK: ${f.cik} | Filed: ${f.filedAt}`);
  });
  console.log();

  // Step 2: Parse individual filings
  const toProcess = filingIndex.slice(0, Math.min(count, 20)); // Cap for testing
  console.log(`[2/4] Parsing ${toProcess.length} individual Form 4 XMLs...`);
  const parsed = [];
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    process.stdout.write(`  Processing ${i + 1}/${toProcess.length}...\r`);
    try {
      const result = await fetchAndParseForm4(toProcess[i]);
      if (result && result.transactions.length > 0) {
        parsed.push(result);
      }
    } catch (err) {
      errors++;
    }
  }
  console.log(`  → Parsed ${parsed.length} filings with transactions (${errors} errors)\n`);

  // Step 3: Score
  console.log('[3/4] Scoring filings...');
  const scored = scoreAllFilings(parsed);
  const categorized = categorizeForDigest(scored);

  console.log(`  → Top picks: ${categorized.topPicks.length}`);
  console.log(`  → Featured:  ${categorized.featured.length}`);
  console.log(`  → Mentions:  ${categorized.mentions.length}`);
  console.log();

  // Show all scored filings
  console.log('── ALL SCORED FILINGS ─────────────────────');
  console.log();
  scored.forEach((f, i) => {
    const arrow = f.summary.buyCount > 0 ? '🟢' : (f.summary.sellCount > 0 ? '🔴' : '⚪');
    console.log(`${arrow} #${i + 1} | $${f.ticker || '???'} | Score: ${f.score} | Tier: ${f.tier}`);
    console.log(`   Owner: ${f.ownerName} (${f.officerTitle || (f.isDirector ? 'Director' : 'Insider')})`);
    if (f.summary.totalBuyValue > 0) {
      console.log(`   Buy: $${f.summary.totalBuyValue.toLocaleString()} (${f.summary.totalBuyShares.toLocaleString()} shares)`);
    }
    if (f.summary.totalSellValue > 0) {
      console.log(`   Sell: $${f.summary.totalSellValue.toLocaleString()}`);
    }
    if (f.signals.length > 0) {
      console.log(`   Signals: ${f.signals.join(' | ')}`);
    }
    if (f.warnings.length > 0) {
      console.log(`   Warnings: ${f.warnings.join(' | ')}`);
    }
    console.log();
  });

  // Step 4: Generate HTML
  console.log('[4/4] Generating HTML digest...');
  const { subject, html } = formatDigestEmail(categorized);
  console.log(`  Subject: ${subject}`);

  const outPath = path.join(__dirname, '..', 'test-digest.html');
  fs.writeFileSync(outPath, html);
  console.log(`  → Saved to ${outPath}`);
  console.log();
  console.log('Done! Open test-digest.html in a browser to preview the email.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
