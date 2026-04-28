/**
 * SEO Article Generation Endpoint
 *
 * POST /api/seo/generate — generates today's blog article from the content calendar.
 * Requires Authorization: Bearer {CRON_SECRET} header.
 * ?dry=1 returns today's calendar entry without generating.
 */

const { getRedis } = require('../../lib/redis');
const { BlogStore, runDailyPipeline } = require('../../lib/publish-pipeline');

module.exports = async function handler(req, res) {
  // Auth check
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers.authorization || '';
  const isCron = req.headers['x-vercel-cron'] === '1';

  if (!isCron && secret && authHeader !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(500).json({ error: 'Redis not configured' });
  }

  try {
    // Dry run — show today's entry + recent articles
    if (req.query.dry === '1' || req.query.dry === 'true') {
      const store = new BlogStore(redis);
      const entry = await store.getTodayEntry();
      const index = await store.getArticleIndex();
      return res.status(200).json({
        mode: 'dry_run',
        todayEntry: entry,
        recentArticles: index.slice(-5),
        totalPublished: index.length,
      });
    }

    // Generate
    const result = await runDailyPipeline(redis);
    return res.status(200).json({
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[SEO] Generate error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

module.exports.maxDuration = 300;
