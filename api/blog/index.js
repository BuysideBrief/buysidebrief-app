/**
 * Blog Index Page
 *
 * GET /blog — lists all published blog articles.
 */

const { getRedis } = require('../../lib/redis');
const { BlogStore } = require('../../lib/publish-pipeline');

module.exports = async function handler(req, res) {
  const redis = getRedis();
  if (!redis) {
    return res.status(500).send('Redis not configured');
  }

  try {
    const store = new BlogStore(redis);
    const html = await store.generateBlogIndexHTML();

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[Blog] Index error:', err);
    return res.status(500).send('Internal server error');
  }
};
