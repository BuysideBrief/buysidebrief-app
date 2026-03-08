/**
 * /api/fetch-and-send.js
 * 
 * Vercel cron job endpoint. Runs nightly at 11pm ET (weekdays).
 * Pipeline: Fetch Form 4s → Score → Format → Send via Resend
 * 
 * Can also be triggered manually with ?dry=true for testing.
 */

const { fetchRecentFilingsFromFeed, fetchAndParseForm4 } = require('../lib/sec-fetcher');
const { scoreAllFilings, categorizeForDigest } = require('../lib/signal-scorer');
const { formatDigestEmail } = require('../lib/email-formatter');
const { enrichAllFilings } = require('../lib/context-enricher');
const { recordNewPicks, updateAllReturns, generateScorecard, formatScorecardForEmail } = require('../lib/performance-tracker');

module.exports = async function handler(req, res) {
  const isDryRun = req.query.dry === 'true';
  const startTime = Date.now();

  try {
    console.log(`[BuysideBrief] Starting ${isDryRun ? 'DRY RUN' : 'LIVE'} digest...`);

    // ── Step 1: Fetch recent Form 4 filing index ──
    console.log('[1/5] Fetching filing index from EDGAR...');
    const filingIndex = await fetchRecentFilingsFromFeed(50);
    console.log(`  Found ${filingIndex.length} filings in index`);

    if (filingIndex.length === 0) {
      console.log('  No filings found. Exiting.');
      return res.status(200).json({
        success: true,
        message: 'No filings found today',
        dry: isDryRun,
      });
    }

    // ── Step 2: Fetch + parse individual Form 4 XML docs ──
    // Limit to 30 to stay within Vercel timeout
    console.log('[2/5] Parsing individual Form 4 filings...');
    const toProcess = filingIndex.slice(0, 30);
    const parsed = [];

    for (const filing of toProcess) {
      const result = await fetchAndParseForm4(filing);
      if (result && result.transactions.length > 0) {
        parsed.push(result);
      }
    }
    console.log(`  Parsed ${parsed.length} filings with transactions`);

    // ── Step 3: Score all filings ──
    console.log('[3/7] Scoring filings...');
    const scored = scoreAllFilings(parsed);
    const categorized = categorizeForDigest(scored);
    console.log(`  Top picks: ${categorized.topPicks.length}`);
    console.log(`  Featured: ${categorized.featured.length}`);
    console.log(`  Mentions: ${categorized.mentions.length}`);

    // ── Step 4: Enrich top picks with context ──
    console.log('[4/7] Enriching filings with context...');
    const enriched = await enrichAllFilings(scored);
    const enrichedCategorized = categorizeForDigest(enriched);

    // ── Step 5: Record picks for performance tracking ──
    console.log('[5/7] Recording picks for scorecard...');
    const newPicksCount = recordNewPicks(enriched);
    console.log(`  Recorded ${newPicksCount} new picks`);

    // ── Step 5b: Update past pick returns ──
    const updatedReturns = await updateAllReturns();
    console.log(`  Updated returns for ${updatedReturns} past picks`);

    // ── Step 6: Format email (with scorecard) ──
    console.log('[6/7] Formatting email digest...');
    const scorecard = generateScorecard();
    const scorecardHtml = formatScorecardForEmail(scorecard);
    const { subject, html } = formatDigestEmail(enrichedCategorized, null, scorecardHtml);

    // ── Step 7: Send via Resend ──
    if (isDryRun) {
      console.log('[7/7] DRY RUN — skipping send');
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return res.status(200).json({
        success: true,
        dry: true,
        elapsed: `${elapsed}s`,
        subject,
        stats: {
          filingsScanned: filingIndex.length,
          filingsParsed: parsed.length,
          topPicks: categorized.topPicks.length,
          featured: categorized.featured.length,
          mentions: categorized.mentions.length,
        },
        // Include top 5 scored filings for review
        preview: scored.slice(0, 5).map(f => ({
          ticker: f.ticker,
          owner: f.ownerName,
          title: f.officerTitle,
          score: f.score,
          tier: f.tier,
          signals: f.signals,
          buyValue: f.summary.totalBuyValue,
        })),
        html: html,
      });
    }

    console.log('[7/7] Sending via Resend...');
    const sendResult = await sendViaResend(subject, html);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[BuysideBrief] Done in ${elapsed}s`);

    return res.status(200).json({
      success: true,
      elapsed: `${elapsed}s`,
      subject,
      sendResult,
      stats: {
        filingsScanned: filingIndex.length,
        filingsParsed: parsed.length,
        topPicks: categorized.topPicks.length,
        featured: categorized.featured.length,
      },
    });

  } catch (err) {
    console.error('[BuysideBrief] Error:', err);
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
};

/**
 * Send email via Resend.
 * 
 * For MVP: sends to a single audience/broadcast.
 * Uses Resend's batch or broadcast API depending on subscriber count.
 * 
 * Note: You'll need to set up a Resend audience and manage subscribers there,
 * OR use Beehiiv for subscriber management and Resend just for triggered sends
 * to a known list.
 */
async function sendViaResend(subject, html) {
  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not set');
  }

  // For MVP: send to Resend audience (broadcast)
  // You'll create an audience in Resend dashboard and paste the ID here
  const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;

  if (AUDIENCE_ID) {
    // Broadcast to audience
    const res = await fetch('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([{
        from: 'Buyside Brief <hello@buysidebrief.com>',
        to: AUDIENCE_ID, // Resend audience
        subject,
        html,
      }]),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Resend batch send failed: ${res.status} — ${err}`);
    }

    return await res.json();
  }

  // Fallback: send to a test email for development
  const TEST_EMAIL = process.env.TEST_EMAIL || 'hello@buysidebrief.com';

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'Buyside Brief <hello@buysidebrief.com>',
      to: [TEST_EMAIL],
      subject: `[TEST] ${subject}`,
      html,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend send failed: ${res.status} — ${err}`);
  }

  return await res.json();
}
