/**
 * /api/afternoon-scan.js
 *
 * Vercel cron job endpoint. Runs weekdays at ~2 PM ET (19:00 UTC).
 * Catches Form 4 filings posted after the morning scan cutoff,
 * scores them, and generates social media snippets for signals ≥ 75.
 *
 * Does NOT send email — this is content fuel for social posting.
 *
 * Cron note: 19:00 UTC = 2 PM ET during EST (Nov-Mar) and 3 PM ET during EDT (Mar-Nov).
 * Being an hour late during summer is acceptable; adjust seasonally if needed.
 */

const { fetchRecentFilingsFromFeed, fetchAndParseForm4 } = require('../lib/sec-fetcher');
const { scoreAllFilings } = require('../lib/signal-scorer');
const { batchAnalyzeEarnings } = require('../lib/earnings-helper');
const { batchAnalyzeContrarian } = require('../lib/contrarian-detector');
const { dampenRepeatInsiders } = require('../lib/pick-filters');
const { enrichAllFilings } = require('../lib/context-enricher');
const { generateSocialSnippet } = require('../lib/social-snippet');
const { getRedisOrNoop } = require('../lib/redis');

module.exports = async function handler(req, res) {
  const isDryRun = req.query.dry === 'true';

  // Auth: same pattern as fetch-and-send.js
  const ua = req.headers['user-agent'] || '';
  const isCron = ua.includes('vercel-cron')
    || (process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`);
  const isManualSend = req.query.send === 'true';
  const shouldRun = isCron || isManualSend || isDryRun;

  if (!shouldRun) {
    return res.status(200).json({ status: 'dry_run', message: 'Pass ?dry=true, ?send=true, or trigger via cron' });
  }

  const startTime = Date.now();
  const redis = getRedisOrNoop();
  const today = new Date().toISOString().split('T')[0];

  try {
    console.log(`[AfternoonScan] Starting ${isDryRun ? 'DRY RUN' : 'LIVE'} scan...`);

    // ── Step 1: Fetch recent Form 4 filings ──
    console.log('[1/6] Fetching afternoon filings from EDGAR...');
    const filingIndex = await fetchRecentFilingsFromFeed(50);
    console.log(`  Found ${filingIndex.length} filings in index`);

    if (filingIndex.length === 0) {
      console.log('  No filings found. Exiting.');
      return res.status(200).json({ status: 'no_new_filings' });
    }

    // ── Step 2: Filter out morning accession numbers ──
    console.log('[2/6] Deduplicating against morning scan...');
    let morningAccessions = [];
    try {
      const stored = await redis.get(`morning:accessions:${today}`);
      if (stored) {
        morningAccessions = typeof stored === 'string' ? JSON.parse(stored) : stored;
      }
    } catch (e) {
      console.error('  Failed to load morning accessions (continuing):', e.message);
    }

    const morningSet = new Set(morningAccessions);
    const newFilings = filingIndex.filter(f => !morningSet.has(f.accessionNumber));
    console.log(`  Morning processed: ${morningAccessions.length}, New afternoon filings: ${newFilings.length}`);

    if (newFilings.length === 0) {
      console.log('  No new afternoon filings. Exiting.');
      return res.status(200).json({ status: 'no_new_filings' });
    }

    // ── Step 3: Parse Form 4 XML docs ──
    console.log('[3/6] Parsing Form 4 filings...');
    const toProcess = newFilings.slice(0, 50);
    const parsed = [];

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
      if (i + BATCH_SIZE < toProcess.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    console.log(`  Parsed ${parsed.length} filings with transactions`);

    if (parsed.length === 0) {
      await redis.set(`afternoon:signals:${today}`, JSON.stringify([]), { ex: 172800 });
      return res.status(200).json({ status: 'no_new_filings' });
    }

    // Deduplicate same insider + ticker
    const deduped = [];
    const seen = new Set();
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

    // ── Step 4: Score filings ──
    console.log('[4/6] Scoring filings...');
    const scored = scoreAllFilings(deduped);

    // Earnings context (non-fatal)
    try {
      const earningsMap = await batchAnalyzeEarnings(scored);
      for (const f of scored) {
        const ec = earningsMap.get(f.ticker);
        if (!ec || !ec.signal) continue;
        f.earningsContext = ec;
        if (ec.scoreAdjustment > 0 && f.summary.buyCount > 0) {
          f.score += ec.scoreAdjustment;
          f.signals.push(`Post-earnings buy (+${ec.scoreAdjustment})`);
          if (f.score >= 100) f.tier = 'strong_signal';
          else if (f.score >= 75) f.tier = 'top_pick';
          else if (f.score >= 45) f.tier = 'feature';
          else if (f.score >= 25) f.tier = 'mention';
        }
      }
    } catch (e) {
      console.error('  Earnings check failed (non-fatal):', e.message);
    }

    // Contrarian detection (non-fatal)
    try {
      const contrarianMap = await batchAnalyzeContrarian(scored);
      for (const f of scored) {
        const cc = contrarianMap.get(f.ticker);
        if (!cc || f.summary.buyCount === 0) continue;
        f.contrarianContext = cc;
        f.score += cc.boost;
        f.signals.push(`${cc.label} (${cc.drawdownPct}% off high, +${cc.boost})`);
        if (f.score >= 100) f.tier = 'strong_signal';
        else if (f.score >= 75) f.tier = 'top_pick';
        else if (f.score >= 45) f.tier = 'feature';
        else if (f.score >= 25) f.tier = 'mention';
      }
    } catch (e) {
      console.error('  Contrarian check failed (non-fatal):', e.message);
    }

    // Repeat dampening (non-fatal)
    try {
      const { loadRecentPicks } = require('../lib/performance-tracker');
      const recentPicks = await loadRecentPicks(30);
      const dampened = dampenRepeatInsiders(scored, recentPicks);
      // Copy dampened results back (spread first to avoid same-reference issue)
      const copy = [...dampened];
      scored.length = 0;
      scored.push(...copy);
    } catch (e) {
      console.error('  Repeat dampening failed (non-fatal):', e.message);
    }

    scored.sort((a, b) => b.score - a.score);

    // ── Step 5: Filter for ≥ 75 signals only ──
    console.log('[5/6] Filtering for high-signal picks (≥ 75)...');
    const qualifying = scored.filter(f => f.score >= 75);
    console.log(`  ${qualifying.length} signals score ≥ 75 out of ${scored.length} total`);

    if (qualifying.length === 0) {
      await redis.set(`afternoon:signals:${today}`, JSON.stringify([]), { ex: 172800 });
      console.log('[AfternoonScan] No qualifying signals. Done.');
      return res.status(200).json({ status: 'no_qualifying_signals' });
    }

    // Take top 2 by score
    const topSignals = qualifying.slice(0, 2);

    // Enrich top signals with context (enrichAllFilings modifies in place and returns same array)
    try {
      await enrichAllFilings(topSignals);
    } catch (e) {
      console.error('  Enrichment failed (non-fatal, using unenriched signals):', e.message);
    }

    // ── Step 6: Generate social snippet ──
    console.log('[6/6] Generating social snippet...');
    const snippet = await generateSocialSnippet(topSignals);

    // Store results in Redis
    const signalSummaries = topSignals.map(s => ({
      ticker: s.ticker,
      company: s.issuerName,
      owner: s.ownerName,
      title: s.officerTitle,
      score: s.score,
      tier: s.tier,
      buyValue: s.summary?.totalBuyValue,
      signals: s.signals,
    }));

    await redis.set(`afternoon:signals:${today}`, JSON.stringify(signalSummaries), { ex: 172800 });

    const snippetData = {
      twitter: snippet.twitter,
      linkedin: snippet.linkedin,
      signals: signalSummaries,
      generated_at: new Date().toISOString(),
    };
    await redis.set(`afternoon:snippet:${today}`, JSON.stringify(snippetData), { ex: 172800 });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`[AfternoonScan] Done in ${elapsed}s — ${topSignals.length} signals, snippet generated`);

    return res.status(200).json({
      status: 'snippet_generated',
      signal_count: topSignals.length,
      elapsed: `${elapsed}s`,
      ...(isDryRun ? { snippet: snippetData } : {}),
    });

  } catch (err) {
    console.error('[AfternoonScan] Error:', err);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};
