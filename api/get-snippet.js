/**
 * /api/get-snippet.js
 *
 * Simple GET endpoint that returns today's afternoon social snippet.
 * Accepts optional ?date=YYYY-MM-DD query param (defaults to today).
 *
 * Auth: same pattern as other internal endpoints (cron header or CRON_SECRET).
 */

const { getRedisOrNoop } = require('../lib/redis');

module.exports = async function handler(req, res) {
  // Auth check
  const ua = req.headers['user-agent'] || '';
  const isCron = ua.includes('vercel-cron')
    || (process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`);
  const isDryRun = req.query.dry === 'true';

  if (!isCron && !isDryRun) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const date = req.query.date || new Date().toISOString().split('T')[0];
  const redis = getRedisOrNoop();

  try {
    const stored = await redis.get(`afternoon:snippet:${date}`);
    if (!stored) {
      return res.status(200).json({ status: 'no_snippet', date });
    }

    const snippet = typeof stored === 'string' ? JSON.parse(stored) : stored;
    return res.status(200).json({ status: 'ok', date, ...snippet });
  } catch (e) {
    console.error('[GetSnippet] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
};
