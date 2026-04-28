/**
 * /api/digest-send
 *
 * Second half of the daily digest cron. Reads digest:prepared:{date}:* (only
 * if the :complete marker is set), runs steps 4 → 9 (enrich, AI, format,
 * Resend, owner-snippet email, archive, headline pick), and writes
 * digest:sent:{date} ONLY after Resend returns 2xx.
 *
 * Idempotency markers (set after their corresponding side-effect succeeds):
 *   digest:sent:{date}          — main broadcast
 *   digest:snippet-sent:{date}  — owner-only social snippet email
 *   digest:archived:{date}      — archive + headline pick
 *
 * Cron: weekdays 11:08 UTC (8 minutes after /api/digest-prepare).
 *
 * Manual triggers:
 *   /api/digest-send?send=true   — explicit live send
 *   /api/digest-send?dry=true    — runs the pipeline up to send and returns the formatted email
 */

const { send } = require('../lib/digest-pipeline');
const { getRedisOrNoop } = require('../lib/redis');

module.exports = async function handler(req, res) {
  const ua = req.headers['user-agent'] || '';
  const isCron = ua.includes('vercel-cron')
    || (process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`);
  const isManualSend = req.query.send === 'true';
  const isDry = req.query.dry === 'true';

  // Default to no-op for unauthenticated GETs to avoid accidental triggers.
  if (!isCron && !isManualSend && !isDry) {
    return res.status(200).json({
      success: true,
      message: 'Use ?send=true (manual), ?dry=true (test), or trigger via cron',
    });
  }

  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
    ? req.query.date
    : new Date().toISOString().split('T')[0];

  console.log(`[digest-send] starting for ${date} (cron: ${isCron}, manual: ${isManualSend}, dry: ${isDry})`);

  try {
    const redis = getRedisOrNoop();
    const result = await send({ redis, date, dryRun: isDry });

    if (result.ok === false && result.error === 'prepared-payload-missing') {
      return res.status(409).json({
        success: false,
        date,
        error: result.error,
        message: result.message,
      });
    }

    return res.status(200).json({
      success: true,
      date,
      ...result,
    });
  } catch (err) {
    console.error('[digest-send] error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error',
    });
  }
};

module.exports.maxDuration = 300;
