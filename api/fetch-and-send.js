/**
 * /api/fetch-and-send.js
 *
 * Debug-only wrapper that runs /api/digest-prepare and /api/digest-send
 * sequentially in-process. Useful for local testing and one-shot reruns.
 *
 * NOTE: This route is no longer wired to the daily cron — the cron now hits
 * /api/digest-prepare at 11:00 UTC and /api/digest-send at 11:08 UTC. See
 * vercel.json. Kept here so existing manual workflows
 * (?dry=true / ?send=true / ?debug=true) and the test harness still work.
 *
 * The prepare/send halves each have their own 300s budget, but the wrapper
 * runs them in the same invocation under one budget. With the new ceiling
 * of 300s the combined run typically completes in 60-90s.
 */

const { prepare, send, loadPrepared } = require('../lib/digest-pipeline');
const { fetchRecentFilingsFromFeed } = require('../lib/sec-fetcher');
const { getRedisOrNoop } = require('../lib/redis');

module.exports = async function handler(req, res) {
  const isDryRun = req.query.dry === 'true';
  const isDebug = req.query.debug === 'true';
  const isManualSend = req.query.send === 'true';

  const ua = req.headers['user-agent'] || '';
  const isCron = ua.includes('vercel-cron')
    || (process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`);

  // Safeguard: bare URL hits default to dry run; live sends only via cron or ?send=true.
  // (The cron wiring now points at digest-prepare/digest-send, but this route is still
  // usable as a one-shot manual rerun.)
  const shouldSend = isCron || isManualSend;
  const effectiveDryRun = isDryRun || (!shouldSend && !isDebug);

  const startTime = Date.now();
  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
    ? req.query.date
    : new Date().toISOString().split('T')[0];

  try {
    console.log(`[fetch-and-send] DEBUG WRAPPER ${effectiveDryRun ? 'DRY RUN' : 'LIVE'} (cron: ${isCron}, manual: ${isManualSend})`);

    // Debug mode: peek at the raw filing index without running the pipeline.
    if (isDebug && isCron) {
      const filingIndex = await fetchRecentFilingsFromFeed(50);
      return res.status(200).json({
        success: true,
        debug: true,
        sampleFilings: filingIndex.slice(0, 5),
        totalFilings: filingIndex.length,
      });
    }

    const redis = getRedisOrNoop();

    // ── Phase 1: prepare ──
    const prepareResult = await prepare({ redis, date });
    if (!prepareResult.ok) {
      return res.status(500).json({ success: false, prepareResult });
    }
    if (prepareResult.empty) {
      return res.status(200).json({
        success: true,
        date,
        message: 'No filings found today',
        prepareResult,
      });
    }

    // ── Phase 2: send (or dry-run preview) ──
    const sendResult = await send({ redis, date, dryRun: effectiveDryRun });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    if (effectiveDryRun) {
      return res.status(200).json({
        success: true,
        dry: true,
        elapsed: `${elapsed}s`,
        prepareResult,
        sendResult,
      });
    }

    return res.status(200).json({
      success: true,
      elapsed: `${elapsed}s`,
      prepareResult,
      sendResult,
    });
  } catch (err) {
    console.error('[fetch-and-send] error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error',
    });
  }
};

module.exports.maxDuration = 300;
