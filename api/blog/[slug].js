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
      return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Article Not Found | Buyside Brief</title>
  <meta name="description" content="This Buyside Brief article has moved or been unpublished. Browse the full blog index for the latest insider-trading explainers and Form 4 deep dives.">
  <link rel="canonical" href="https://www.buysidebrief.com/blog">
  <meta name="robots" content="noindex,follow">
  <meta property="og:title" content="Article Not Found | Buyside Brief">
  <meta property="og:description" content="This Buyside Brief article has moved or been unpublished. Browse the full blog index for the latest insider-trading explainers and Form 4 deep dives.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://www.buysidebrief.com/blog/${encodeURIComponent(slug)}">
  <meta property="og:image" content="https://www.buysidebrief.com/og-image.png">
  <meta property="og:site_name" content="Buyside Brief">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Article Not Found | Buyside Brief">
  <meta name="twitter:description" content="This Buyside Brief article has moved or been unpublished. Browse the full blog index for the latest insider-trading explainers and Form 4 deep dives.">
  <meta name="twitter:image" content="https://www.buysidebrief.com/og-image.png">
  <script defer src="/_vercel/insights/script.js"></script>
</head>
<body><h1>404 — Article Not Found</h1><p><a href="/blog">Back to Blog</a></p></body>
</html>`);
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
