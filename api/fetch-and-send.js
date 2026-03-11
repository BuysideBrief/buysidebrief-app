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
const { recordNewPicks, updateAllReturns, generateScorecard, formatScorecardForEmail, formatCeoSpotlight, getCeoProfile } = require('../lib/performance-tracker');
const { getMarketOverview, formatMarketOverviewForEmail } = require('../lib/market-overview');

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
    console.log('[2/7] Parsing individual Form 4 filings...');
    const toProcess = filingIndex.slice(0, 80);
    const parsed = [];

    // Debug mode: return raw filing index data
    if (req.query.debug === 'true') {
      return res.status(200).json({
        success: true,
        debug: true,
        sampleFilings: filingIndex.slice(0, 5),
        totalFilings: filingIndex.length,
      });
    }

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

    // ── Step 6: Format email (with market overview, scorecard + CEO spotlight) ──
    console.log('[6/7] Formatting email digest...');

    // Market overview
    const marketOverview = await getMarketOverview();
    const marketHtml = formatMarketOverviewForEmail(marketOverview);

    const scorecard = await generateScorecard();
    const scorecardHtml = formatScorecardForEmail(scorecard);

    // Find the most interesting CEO from today's picks for the spotlight
    let ceoSpotlightHtml = '';
    for (const f of enriched) {
      if (f.ownerCik && (f.tier === 'top_pick' || f.tier === 'feature')) {
        const profile = await getCeoProfile(f.ownerCik);
        if (profile && profile.totalPicks >= 2 && profile.winRate !== null) {
          ceoSpotlightHtml = formatCeoSpotlight(profile);
          break; // Just show one per email
        }
      }
    }

    const extraHtml = scorecardHtml + ceoSpotlightHtml;
    const { subject, html } = formatDigestEmail(enrichedCategorized, null, extraHtml, marketHtml);

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

  const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;
  const TEST_EMAIL = process.env.TEST_EMAIL;

  // If we have a test email, always send there first (for MVP)
  if (TEST_EMAIL) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Buyside Brief <hello@buysidebrief.com>',
        to: [TEST_EMAIL],
        subject,
        html,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Resend send failed: ${res.status} — ${err}`);
    }

    return await res.json();
  }

  // Broadcast to audience via Resend Broadcast API
  if (AUDIENCE_ID) {
    // Step 1: Create the broadcast
    const createRes = await fetch('https://api.resend.com/broadcasts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        audienceId: AUDIENCE_ID,
        from: 'Buyside Brief <hello@buysidebrief.com>',
        subject,
        html,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Resend broadcast create failed: ${createRes.status} — ${err}`);
    }

    const broadcast = await createRes.json();

    // Step 2: Send the broadcast
    const sendRes = await fetch(`https://api.resend.com/broadcasts/${broadcast.id}/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      throw new Error(`Resend broadcast send failed: ${sendRes.status} — ${err}`);
    }

    return await sendRes.json();
  }

  throw new Error('No TEST_EMAIL or RESEND_AUDIENCE_ID configured');
}
