/**
 * /api/archive.js
 * 
 * Serves past newsletter issues.
 * 
 * GET /api/archive           → list all past issues (metadata)
 * GET /api/archive?date=2026-03-11  → get a specific issue's HTML
 * 
 * Issues are stored in Redis by the daily cron after each send.
 */

const { Redis } = require('@upstash/redis');

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_TOKEN;
let kv;
try {
  kv = (redisUrl && redisToken) ? new Redis({ url: redisUrl, token: redisToken }) : Redis.fromEnv();
} catch (e) {
  kv = { get: async () => null, zrange: async () => [], zrevrange: async () => [] };
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');

  const { date } = req.query;

  try {
    if (date) {
      // Return a specific issue
      const issue = await kv.get(`archive:${date}`);
      if (!issue) {
        return res.status(404).json({ success: false, error: 'Issue not found' });
      }
      return res.status(200).json({ success: true, issue });
    }

    // Return list of all past issues
    const issueIds = await kv.zrange('archive:index', 0, -1, { rev: true });
    if (!issueIds || issueIds.length === 0) {
      return res.status(200).json({ success: true, issues: [] });
    }

    // Load metadata for each (not the full HTML)
    const issues = [];
    for (const id of issueIds) {
      const issue = await kv.get(`archive:${id}`);
      if (issue) {
        issues.push({
          date: issue.date,
          subject: issue.subject,
          topPick: issue.topPick,
          signalCount: issue.signalCount,
          filingsScanned: issue.filingsScanned,
        });
      }
    }

    return res.status(200).json({ success: true, issues });

  } catch (err) {
    console.error('Archive API error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Store an issue in the archive. Called from fetch-and-send after sending.
 */
async function storeIssue(date, subject, html, stats) {
  try {
    const issue = {
      date,
      subject,
      html,
      topPick: stats.topPick || null,
      signalCount: stats.signalCount || 0,
      filingsScanned: stats.filingsScanned || 0,
      storedAt: new Date().toISOString(),
    };

    await kv.set(`archive:${date}`, issue);
    await kv.zadd('archive:index', { score: new Date(date).getTime(), member: date });

    return true;
  } catch (e) {
    console.error('Archive store error:', e);
    return false;
  }
}

module.exports.storeIssue = storeIssue;
