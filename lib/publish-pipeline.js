/**
 * Blog Publish Pipeline
 *
 * Redis storage for SEO content calendar and articles,
 * plus the daily orchestrator that generates and publishes one article per day.
 */

const { generateArticle, wrapArticleInPage } = require('./article-generator');

// ---------------------------------------------------------------------------
// BlogStore — Redis-backed storage for calendar and articles
// ---------------------------------------------------------------------------

class BlogStore {
  constructor(redis) {
    this.redis = redis;
  }

  // -- Calendar --

  async saveCalendar(calendar) {
    await this.redis.set('seo:calendar', JSON.stringify(calendar));
  }

  async getCalendar() {
    const raw = await this.redis.get('seo:calendar');
    if (!raw) return [];
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  async getTodayEntry() {
    const calendar = await this.getCalendar();
    const today = new Date().toISOString().split('T')[0];
    return calendar.find((e) => e.date === today) || null;
  }

  // -- Articles --

  async saveArticle(article) {
    const key = `seo:article:${article.slug}`;
    await this.redis.set(key, JSON.stringify(article));

    // Append to index
    const index = await this.getArticleIndex();
    index.push({
      slug: article.slug,
      title: article.title,
      keyword: article.keyword,
      category: article.category,
      publishedAt: article.generatedAt,
      wordCount: article.wordCount,
    });
    await this.redis.set('seo:article-index', JSON.stringify(index));
  }

  async getArticle(slug) {
    const raw = await this.redis.get(`seo:article:${slug}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  async getArticleIndex() {
    const raw = await this.redis.get('seo:article-index');
    if (!raw) return [];
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  async isAlreadyPublished(slug) {
    const raw = await this.redis.get(`seo:article:${slug}`);
    return raw !== null;
  }

  // -- Sitemap --

  async generateSitemap(baseUrl = 'https://buysidebrief.com') {
    const index = await this.getArticleIndex();
    const today = new Date().toISOString().split('T')[0];

    let urls = `  <url><loc>${baseUrl}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>
  <url><loc>${baseUrl}/archive.html</loc><changefreq>daily</changefreq><priority>0.8</priority></url>
  <url><loc>${baseUrl}/scorecard.html</loc><changefreq>weekly</changefreq><priority>0.7</priority></url>
  <url><loc>${baseUrl}/blog</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`;

    for (const entry of index) {
      const lastmod = entry.publishedAt ? entry.publishedAt.split('T')[0] : today;
      urls += `\n  <url><loc>${baseUrl}/blog/${entry.slug}</loc><lastmod>${lastmod}</lastmod><changefreq>monthly</changefreq><priority>0.6</priority></url>`;
    }

    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
  }

  // -- Blog Index Page --

  async generateBlogIndexHTML() {
    const index = await this.getArticleIndex();
    const sorted = [...index].sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));

    let listHTML = '';
    for (const entry of sorted) {
      const date = entry.publishedAt
        ? new Date(entry.publishedAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
        : '';
      listHTML += `
      <li class="post-item">
        <a href="/blog/${entry.slug}" class="post-title">${escapeHtml(entry.title)}</a>
        <div class="post-meta">
          ${date} &middot; ${entry.wordCount || '?'} words &middot;
          <span class="category-badge">${entry.category || 'general'}</span>
        </div>
      </li>`;
    }

    if (!listHTML) {
      listHTML = '<li class="post-item"><p>No articles published yet. Check back soon!</p></li>';
    }

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Blog | Buyside Brief</title>
  <meta name="description" content="Insider trading insights, SEC Form 4 analysis, and investment education from Buyside Brief.">
  <link rel="canonical" href="https://buysidebrief.com/blog">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fafaf8; line-height: 1.7; }
    .site-header { background: #2d5016; color: #fff; padding: 1rem 2rem; text-align: center; }
    .site-header a { color: #fff; text-decoration: none; font-size: 1.4rem; font-weight: bold; }
    .site-nav { margin-top: 0.4rem; }
    .site-nav a { color: rgba(255,255,255,0.85); margin: 0 0.75rem; font-size: 0.9rem; text-decoration: none; }
    .site-nav a:hover { color: #fff; text-decoration: underline; }
    .container { max-width: 720px; margin: 0 auto; padding: 2rem 1.5rem 4rem; }
    h1 { font-size: 2rem; margin-bottom: 0.5rem; color: #111; }
    .subtitle { color: #666; margin-bottom: 2rem; font-size: 1rem; }
    .post-list { list-style: none; }
    .post-item { padding: 1.25rem 0; border-bottom: 1px solid #eee; }
    .post-title { color: #2d5016; font-size: 1.15rem; text-decoration: none; font-weight: bold; }
    .post-title:hover { text-decoration: underline; }
    .post-meta { color: #888; font-size: 0.8rem; margin-top: 0.3rem; font-family: -apple-system, sans-serif; }
    .category-badge {
      background: #e8f0e0; color: #2d5016; padding: 0.1rem 0.4rem;
      border-radius: 3px; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
    }
    .site-footer { text-align: center; padding: 2rem; color: #888; font-size: 0.8rem; font-family: -apple-system, sans-serif; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <header class="site-header">
    <a href="https://buysidebrief.com">Buyside Brief</a>
    <nav class="site-nav">
      <a href="/blog">Blog</a>
      <a href="https://buysidebrief.com/archive.html">Newsletter Archive</a>
      <a href="https://buysidebrief.com/scorecard.html">Scorecard</a>
      <a href="https://buysidebrief.com/#subscribe">Subscribe</a>
    </nav>
  </header>
  <main class="container">
    <h1>Buyside Brief Blog</h1>
    <p class="subtitle">Insider trading insights, SEC Form 4 analysis, and investment education.</p>
    <ul class="post-list">
      ${listHTML}
    </ul>
  </main>
  <footer class="site-footer">
    &copy; ${new Date().getFullYear()} Buyside Brief &middot;
    <a href="https://buysidebrief.com">Home</a> &middot;
    <a href="https://buysidebrief.com/#subscribe">Subscribe</a>
  </footer>
</body>
</html>`;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Daily Pipeline Orchestrator
// ---------------------------------------------------------------------------

async function runDailyPipeline(redis) {
  const store = new BlogStore(redis);

  console.log('[SEO] Step 1: Getting today\'s calendar entry...');
  const entry = await store.getTodayEntry();
  if (!entry) {
    console.log('[SEO] No calendar entry for today. Skipping.');
    return { status: 'skipped', reason: 'no_calendar_entry' };
  }
  console.log(`[SEO] Today's keyword: "${entry.keyword}" (${entry.category})`);

  console.log('[SEO] Step 2: Checking if already published...');
  if (await store.isAlreadyPublished(entry.suggestedSlug)) {
    console.log(`[SEO] Article "${entry.suggestedSlug}" already published. Skipping.`);
    return { status: 'skipped', reason: 'already_published', slug: entry.suggestedSlug };
  }

  console.log('[SEO] Step 3: Generating article via Claude...');
  const article = await generateArticle({
    keyword: entry.keyword,
    category: entry.category,
    suggestedTitle: entry.suggestedTitle,
    relatedKeywords: [],
  });
  console.log(`[SEO] Generated: "${article.title}" (${article.wordCount} words)`);

  console.log('[SEO] Step 4: Saving to Redis...');
  await store.saveArticle(article);
  console.log(`[SEO] Published at /blog/${article.slug}`);

  return {
    status: 'published',
    slug: article.slug,
    title: article.title,
    wordCount: article.wordCount,
    keyword: entry.keyword,
    category: entry.category,
    generatedAt: article.generatedAt,
  };
}

module.exports = { BlogStore, runDailyPipeline };
