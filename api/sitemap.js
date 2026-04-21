/**
 * XML Sitemap
 *
 * GET /sitemap.xml — generates sitemap including static pages and all blog posts.
 */

const { getRedis } = require('../lib/redis');
const { BlogStore } = require('../lib/publish-pipeline');

const EMPTY_REDIS = { get: async () => null, set: async () => null, smembers: async () => [] };

module.exports = async function handler(req, res) {
  const redis = getRedis() || EMPTY_REDIS;

  try {
    const store = new BlogStore(redis);
    const xml = await store.generateSitemap('https://www.buysidebrief.com');

    res.setHeader('Content-Type', 'application/xml');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).send(xml);
  } catch (err) {
    console.error('[Sitemap] Error:', err);
    return res.status(500).send('Error generating sitemap');
  }
};
