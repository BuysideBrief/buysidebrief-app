/**
 * Blog Article Page
 *
 * GET /blog/:slug — serves a published blog article as HTML.
 */

const { getRedis } = require('../../lib/redis');
const { BlogStore } = require('../../lib/publish-pipeline');
const { wrapArticleInPage } = require('../../lib/article-generator');

module.exports = async function handler(req, res) {
  const { slug } = req.query;
  if (!slug) {
    return res.status(400).send('Missing slug');
  }

  const redis = getRedis();
  if (!redis) {
    return res.status(500).send('Redis not configured');
  }

  try {
    const store = new BlogStore(redis);
    const article = await store.getArticle(slug);

    if (!article) {
      res.setHeader('Content-Type', 'text/html');
      return res.status(404).send(`<!DOCTYPE html><html><head><title>Not Found</title></head><body><h1>404 — Article Not Found</h1><p><a href="/blog">Back to Blog</a></p></body></html>`);
    }

    const html = wrapArticleInPage(article);

    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=86400');
    return res.status(200).send(html);
  } catch (err) {
    console.error('[Blog] Error:', err);
    return res.status(500).send('Internal server error');
  }
};
