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
const { recordNewPicks, updateAllReturns, generateScorecard, formatScorecardForEmail, formatCeoSpotlight, getCeoProfile, loadRecentPicks } = require('../lib/performance-tracker');
const { getMarketOverview, formatMarketOverviewForEmail } = require('../lib/market-overview');
const { generateMarketContext, generateWhyItMattersAI, generateSocialSnippet } = require('../lib/ai-content');
const { batchAnalyzeEarnings } = require('../lib/earnings-helper');
const { batchAnalyzeContrarian } = require('../lib/contrarian-detector');
const { storeAllScoredFilings } = require('../lib/historical-store');
const { rotateHeadlinePick, recordHeadlinePick } = require('../lib/recently-featured');
const { dampenRepeatInsiders } = require('../lib/pick-filters');
const { storeIssue } = require('./archive');
const { getRedisOrNoop } = require('../lib/redis');

module.exports = async function handler(req, res) {
  const isDryRun = req.query.dry === 'true';
  const isDebug = req.query.debug === 'true';
  const isManualSend = req.query.send === 'true';

  // Detect Vercel cron: user-agent or CRON_SECRET authorization header
  const ua = req.headers['user-agent'] || '';
  const isCron = ua.includes('vercel-cron')
    || (process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`);
  const startTime = Date.now();

  function timeRemaining() {
    return 55000 - (Date.now() - startTime); // 55s of 60s budget
  }

  // Safeguard: hitting the URL without params defaults to dry run
  // Live sends only happen from cron or with explicit ?send=true
  const shouldSend = isCron || isManualSend;
  const effectiveDryRun = isDryRun || (!shouldSend && !isDebug);

  try {
    console.log(`[BuysideBrief] Starting ${effectiveDryRun ? 'DRY RUN' : 'LIVE'} digest (cron: ${isCron}, manual: ${isManualSend}, ua: ${ua.substring(0, 30)})...`);

    // ── Step 1: Fetch recent Form 4 filing index ──
    console.log('[1/10] Fetching filing index from EDGAR...');
    const filingIndex = await fetchRecentFilingsFromFeed(50);
    console.log(`  Found ${filingIndex.length} filings in index`);

    if (filingIndex.length === 0) {
      console.log('  No filings found. Exiting.');
      return res.status(200).json({
        success: true,
        message: 'No filings found today',
        dry: effectiveDryRun,
      });
    }

    // ── Step 2: Fetch + parse individual Form 4 XML docs ──
    console.log('[2/10] Parsing individual Form 4 filings...');
    const toProcess = filingIndex.slice(0, 100);
    const parsed = [];

    // Debug mode: return raw filing index data (auth required)
    if (isDebug && isCron) {
      return res.status(200).json({
        success: true,
        debug: true,
        sampleFilings: filingIndex.slice(0, 5),
        totalFilings: filingIndex.length,
      });
    }

    // Process in parallel batches of 5 (safe for SEC 10 req/sec limit)
    const BATCH_SIZE = 5;
    for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
      const batch = toProcess.slice(i, i + BATCH_SIZE);
      const results = await Promise.all(
        batch.map(filing => fetchAndParseForm4(filing).catch(() => null))
      );
      for (const result of results) {
        if (result && result.transactions.length > 0) {
          parsed.push(result);
        }
      }
      // Brief pause between batches to respect rate limit
      if (i + BATCH_SIZE < toProcess.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    console.log(`  Parsed ${parsed.length} filings with transactions out of ${toProcess.length}`);

    // ── Persist processed accession numbers for afternoon dedup ──
    try {
      const redis = getRedisOrNoop();
      const today = new Date().toISOString().split('T')[0];
      await redis.set(`morning:accessions:${today}`, JSON.stringify(filingIndex.map(f => f.accessionNumber)), { ex: 172800 });
      console.log(`  Stored ${filingIndex.length} accession numbers for afternoon dedup`);
    } catch (e) {
      console.error('  Accession number persistence failed (non-fatal):', e.message);
    }

    // Deduplicate: same insider (ownerCik) + same ticker = keep highest value filing
    const deduped = [];
    const seen = new Set();
    // Sort by total buy value descending so we keep the most significant filing
    parsed.sort((a, b) => {
      const aVal = (a.summary?.totalBuyValue || 0) + (a.summary?.totalSellValue || 0);
      const bVal = (b.summary?.totalBuyValue || 0) + (b.summary?.totalSellValue || 0);
      return bVal - aVal;
    });
    for (const filing of parsed) {
      const key = `${filing.ticker || 'UNK'}:${filing.ownerCik || filing.ownerName || 'UNK'}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(filing);
      }
    }
    if (deduped.length < parsed.length) {
      console.log(`  Deduped: ${parsed.length} → ${deduped.length} (removed ${parsed.length - deduped.length} duplicates)`);
    }

    // ── Step 3: Score all filings ──
    console.log('[3/10] Scoring filings...');
    const scored = scoreAllFilings(deduped);
    const categorized = categorizeForDigest(scored);
    console.log(`  Top picks: ${categorized.topPicks.length}`);
    console.log(`  Featured: ${categorized.featured.length}`);
    console.log(`  Mentions: ${categorized.mentions.length}`);

    // ── Step 3b: Cross-reference with earnings calendar ──
    if (timeRemaining() < 15000) {
      console.log(`Skipping earnings cross-reference — only ${timeRemaining()}ms remaining`);
    } else {
    console.log('[3b/10] Checking earnings calendar context...');
    try {
      const earningsMap = await batchAnalyzeEarnings(scored);
      let earningsBoosts = 0;
      let earningsFlags = 0;

      for (const f of scored) {
        const ec = earningsMap.get(f.ticker);
        if (!ec || !ec.signal) continue;

        // Attach earnings context to the filing
        f.earningsContext = ec;

        if (ec.scoreAdjustment > 0 && f.summary.buyCount > 0) {
          // Post-earnings buy boost — only apply to buys
          f.score += ec.scoreAdjustment;
          f.signals.push(`Post-earnings buy (+${ec.scoreAdjustment}): ${ec.signal === 'post_earnings_buy' ? `bought ${ec.daysSinceEarnings}d after earnings` : ec.signal}`);
          earningsBoosts++;

          // Re-evaluate tier after boost
          if (f.score >= 100) f.tier = 'strong_signal';
          else if (f.score >= 75) f.tier = 'top_pick';
          else if (f.score >= 45) f.tier = 'feature';
          else if (f.score >= 25) f.tier = 'mention';
        } else if (ec.signal === 'blackout_flag') {
          f.warnings = f.warnings || [];
          f.warnings.push(`Traded ${ec.daysUntilEarnings}d before earnings — inside typical blackout window`);
          earningsFlags++;
        } else if (ec.signal === 'pre_earnings_caution') {
          // Just informational — attach context for AI blurb
          earningsFlags++;
        }
      }

      console.log(`  Earnings context: ${earningsBoosts} boosts, ${earningsFlags} flags`);
    } catch (e) {
      console.error('  Earnings calendar check failed (non-fatal):', e.message);
    }
    } // end time-check for earnings

    // Re-sort and re-categorize after earnings adjustments
    scored.sort((a, b) => b.score - a.score);
    const postEarningsCategorized = categorizeForDigest(scored);

    // ── Step 3c: Contrarian signal detection ──
    if (timeRemaining() < 15000) {
      console.log(`Skipping contrarian detection — only ${timeRemaining()}ms remaining`);
    } else {
    console.log('[3c/10] Checking for contrarian signals...');
    try {
      const contrarianMap = await batchAnalyzeContrarian(scored);
      let contrarianBoosts = 0;

      for (const f of scored) {
        const cc = contrarianMap.get(f.ticker);
        if (!cc || f.summary.buyCount === 0) continue;

        f.contrarianContext = cc;
        f.score += cc.boost;
        f.signals.push(`${cc.label} (${cc.drawdownPct}% off high, +${cc.boost})`);
        contrarianBoosts++;

        // Re-evaluate tier after boost
        if (f.score >= 100) f.tier = 'strong_signal';
        else if (f.score >= 75) f.tier = 'top_pick';
        else if (f.score >= 45) f.tier = 'feature';
        else if (f.score >= 25) f.tier = 'mention';
      }

      if (contrarianBoosts > 0) {
        scored.sort((a, b) => b.score - a.score);
      }
      console.log(`  Contrarian signals: ${contrarianBoosts} boosts`);
    } catch (e) {
      console.error('  Contrarian check failed (non-fatal):', e.message);
    }
    } // end time-check for contrarian

    // ── Step 3d: Dampen repeat insiders ──
    console.log('[3d/10] Dampening repeat insiders...');
    try {
      // Load recent picks from Redis (last 30 days)
      const recentPicks = await loadRecentPicks(30);
      const beforeCount = scored.filter(f => f.tier === 'top_pick' || f.tier === 'feature').length;

      const dampened = dampenRepeatInsiders(scored, recentPicks);
      // Replace scored array contents
      scored.length = 0;
      scored.push(...dampened);

      const afterCount = scored.filter(f => f.tier === 'top_pick' || f.tier === 'feature').length;
      const dampenedCount = scored.filter(f => f.dampened).length;
      if (dampenedCount > 0) {
        console.log(`  Dampened ${dampenedCount} repeat insiders (picks: ${beforeCount} → ${afterCount})`);
      } else {
        console.log(`  No repeat insiders found`);
      }

      scored.sort((a, b) => b.score - a.score);
    } catch (e) {
      console.error('  Repeat dampening failed (non-fatal):', e.message);
    }

    // ── Step 3e: Store ALL scored filings for historical data ──
    console.log('[3e/10] Storing historical filing data...');
    try {
      const today = new Date().toISOString().split('T')[0];
      const storeResult = await storeAllScoredFilings(scored, today);
      console.log(`  Stored ${storeResult.stored} filings (${storeResult.skipped} skipped)`);
      if (storeResult.dailySummary) {
        console.log(`  Daily: ${storeResult.dailySummary.buyFilings} buys, ${storeResult.dailySummary.sellFilings} sells, avg score ${storeResult.dailySummary.avgScore}`);
      }
    } catch (e) {
      console.error('  Historical store failed (non-fatal):', e.message);
    }

    // ── Step 4: Enrich top picks with context ──
    console.log('[4/10] Enriching filings with context...');
    const enriched = await enrichAllFilings(scored);

    // ── Step 4b: AI-powered "Why it matters" for top signals ──
    if (timeRemaining() < 20000) {
      console.log(`Skipping AI content generation — only ${timeRemaining()}ms remaining`);
      // Fallback: append earnings context to template blurbs where available
      for (const f of enriched) {
        if ((f.tier === 'top_pick' || f.tier === 'feature') && f.earningsContext && f.earningsContext.context) {
          f.whyItMatters = (f.whyItMatters || '') + ' ' + f.earningsContext.context;
        }
      }
    } else {
    console.log('[4b/10] Generating AI content...');
    for (const f of enriched) {
      if (f.tier === 'top_pick' || f.tier === 'feature') {
        try {
          // Pass earnings context to AI for richer blurbs
          const aiBlurb = await generateWhyItMattersAI(f);
          if (aiBlurb) {
            // If we have earnings context, append it to the AI blurb
            if (f.earningsContext && f.earningsContext.context) {
              f.whyItMatters = aiBlurb + ' ' + f.earningsContext.context;
            } else {
              f.whyItMatters = aiBlurb;
            }
          } else if (f.earningsContext && f.earningsContext.context) {
            // No AI blurb but we have earnings context — append to template blurb
            f.whyItMatters = (f.whyItMatters || '') + ' ' + f.earningsContext.context;
          }
        } catch (e) {
          // Keep the template-based blurb as fallback
          console.error(`AI blurb failed for ${f.ticker}:`, e.message);
          // Still try to append earnings context even if AI fails
          if (f.earningsContext && f.earningsContext.context) {
            f.whyItMatters = (f.whyItMatters || '') + ' ' + f.earningsContext.context;
          }
        }
      }
    }
    } // end time-check for AI content

    let enrichedCategorized = categorizeForDigest(enriched);

    // ── Step 4c: Rotate headline pick to avoid repeats ──
    console.log('[4c/10] Checking for repeat headline picks...');
    try {
      const beforeTicker = enrichedCategorized.topPicks[0]?.ticker || '(none)';
      enrichedCategorized = await rotateHeadlinePick(enrichedCategorized);
      const afterTicker = enrichedCategorized.topPicks[0]?.ticker || '(none)';
      if (beforeTicker !== afterTicker) {
        console.log(`  Rotated headline: $${beforeTicker} → $${afterTicker} (repeat cooldown)`);
      } else {
        console.log(`  Headline: $${afterTicker} (fresh)`);
      }
    } catch (e) {
      console.error('  Headline rotation failed (non-fatal):', e.message);
    }

    // ── Step 5: Record picks for performance tracking ──
    console.log('[5/10] Recording picks for scorecard...');
    const newPicksCount = await recordNewPicks(enriched);
    console.log(`  Recorded ${newPicksCount} new picks`);

    // ── Step 5b: Update past pick returns ──
    const updatedReturns = await updateAllReturns();
    console.log(`  Updated returns for ${updatedReturns} past picks`);

    // ── Step 6: Format email (with AI market context, scorecard + CEO spotlight) ──
    console.log('[6/10] Formatting email digest...');

    // Market overview + AI context
    const marketOverview = await getMarketOverview();
    const aiMarketContext = await generateMarketContext(marketOverview, enriched);
    if (aiMarketContext && marketOverview) {
      marketOverview.summary = aiMarketContext;
    }
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

    // Generate social snippet for later use
    const topSignal = enrichedCategorized.topPicks[0] || enrichedCategorized.featured[0];
    const socialSnippet = await generateSocialSnippet(topSignal);

    // ── Step 7: Send via Resend ──
    if (effectiveDryRun) {
      console.log('[7/10] DRY RUN — skipping send');
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return res.status(200).json({
        success: true,
        dry: true,
        elapsed: `${elapsed}s`,
        subject,
        aiContent: {
          marketContext: aiMarketContext || '(fallback — no API key)',
          socialSnippet: socialSnippet || '(fallback — no API key)',
        },
        stats: {
          filingsScanned: filingIndex.length,
          filingsParsed: parsed.length,
          topPicks: categorized.topPicks.length,
          featured: categorized.featured.length,
          mentions: categorized.mentions.length,
        },
        preview: scored.slice(0, 5).map(f => ({
          ticker: f.ticker,
          owner: f.ownerName,
          title: f.officerTitle,
          score: f.score,
          tier: f.tier,
          signals: f.signals,
          buyValue: f.summary.totalBuyValue,
          whyItMatters: f.whyItMatters || null,
          earningsContext: f.earningsContext ? {
            signal: f.earningsContext.signal,
            scoreAdjustment: f.earningsContext.scoreAdjustment,
            context: f.earningsContext.context,
          } : null,
        })),
        html: html,
      });
    }

    console.log('[7/10] Sending via Resend...');
    const sendResult = await sendViaResend(subject, html);

    // Send social snippet to Pete for easy copy/paste
    console.log('[8/10] Sending social snippet...');
    if (socialSnippet && process.env.RESEND_API_KEY) {
      try {
        const snippetEmail = process.env.SNIPPET_EMAIL || process.env.OWNER_EMAIL;
        if (snippetEmail) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: 'Buyside Brief <hello@buysidebrief.com>',
              to: [snippetEmail],
              subject: `📱 Today's social snippet — $${topSignal?.ticker || 'BB'}`,
              html: `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;max-width:500px;padding:20px;">
                <p style="font-size:12px;color:#7a7a7a;margin:0 0 8px;">Copy and paste to Twitter/X or LinkedIn:</p>
                <div style="background:#faf8f4;border:1px solid #e0dbd3;border-radius:8px;padding:16px;font-size:15px;line-height:1.5;color:#1a1a1a;">
                  ${socialSnippet}
                </div>
                <p style="font-size:11px;color:#b0a99f;margin:12px 0 0;">Auto-generated by Buyside Brief AI</p>
              </div>`,
            }),
          });
          console.log(`  Social snippet sent to ${snippetEmail}`);
        }
      } catch (e) {
        console.error('Social snippet email failed:', e.message);
      }
    }

    // ── Step 9: Store in archive ──
    console.log('[9/10] Storing in archive...');
    const today = new Date().toISOString().split('T')[0];
    const topPick = enrichedCategorized.topPicks[0] || enrichedCategorized.featured[0];
    await storeIssue(today, subject, html, {
      topPick: topPick ? `$${topPick.ticker}` : null,
      signalCount: enrichedCategorized.topPicks.length + enrichedCategorized.featured.length,
      filingsScanned: filingIndex.length,
    });

    // Record today's #1 headline for future rotation
    if (topPick?.ticker) {
      await recordHeadlinePick(topPick.ticker, today);
      console.log(`  Recorded $${topPick.ticker} as today's headline pick`);
    }

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
      error: 'Internal server error',
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
    // Resend renamed audiences to segments — try segment_id first
    const createRes = await fetch('https://api.resend.com/broadcasts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        segment_id: AUDIENCE_ID,
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
