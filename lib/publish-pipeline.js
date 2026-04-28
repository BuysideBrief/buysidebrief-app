/**
 * Blog Publish Pipeline
 *
 * Redis storage for SEO content calendar and articles,
 * plus the daily orchestrator that generates and publishes one article per day.
 */

const fs = require('fs');
const path = require('path');
const { generateArticle, wrapArticleInPage } = require('./article-generator');

const STATIC_SITEMAP_ENTRIES = [
  { loc: '/',               changefreq: 'daily',   priority: '1.0' },
  { loc: '/scorecard.html', changefreq: 'daily',   priority: '0.9' },
  { loc: '/archive.html',   changefreq: 'daily',   priority: '0.8' },
  { loc: '/blog',           changefreq: 'daily',   priority: '0.8' },
  { loc: '/research',       changefreq: 'monthly', priority: '0.7' },
  { loc: '/terms.html',     changefreq: 'yearly',  priority: '0.3' },
  { loc: '/privacy.html',   changefreq: 'yearly',  priority: '0.3' },
];

function listResearchSlugs() {
  const dir = path.join(__dirname, '..', 'research');
  try {
    return fs.readdirSync(dir)
      .filter((f) => f.endsWith('.html') && f !== 'index.html')
      .map((f) => f.replace(/\.html$/, ''));
  } catch {
    return [];
  }
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

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
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('Failed to parse calendar JSON:', e.message, 'Raw data:', raw.substring(0, 200));
      return [];
    }
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
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('Failed to parse article JSON:', e.message, 'Raw data:', raw.substring(0, 200));
      return null;
    }
  }

  async getArticleIndex() {
    const raw = await this.redis.get('seo:article-index');
    if (!raw) return [];
    if (typeof raw !== 'string') return raw;
    try {
      return JSON.parse(raw);
    } catch (e) {
      console.error('Failed to parse article-index JSON:', e.message, 'Raw data:', raw.substring(0, 200));
      return [];
    }
  }

  async isAlreadyPublished(slug) {
    const raw = await this.redis.get(`seo:article:${slug}`);
    return raw !== null;
  }

  // Date-scoped marker: set ONLY after saveArticle() succeeds. Independent of
  // whatever slug the article generator picks (which can differ from
  // entry.suggestedSlug because lib/article-generator falls back to meta.slug
  // returned by Claude). Checking this first means a same-day rerun is a
  // clean no-op even if the prior run wrote under a different slug.
  async isPublishedForDate(date) {
    const raw = await this.redis.get(`seo:published:${date}`);
    return raw !== null;
  }

  async markPublishedForDate(date, payload) {
    await this.redis.set(`seo:published:${date}`, JSON.stringify({
      ...payload,
      markedAt: new Date().toISOString(),
    }));
  }

  // -- Sitemap --

  async generateSitemap(baseUrl = 'https://www.buysidebrief.com') {
    const index = await this.getArticleIndex();
    const today = new Date().toISOString().split('T')[0];
    const entries = [];

    for (const entry of STATIC_SITEMAP_ENTRIES) {
      entries.push({
        loc: baseUrl + entry.loc,
        changefreq: entry.changefreq,
        priority: entry.priority,
      });
    }

    for (const slug of listResearchSlugs()) {
      entries.push({
        loc: `${baseUrl}/research/${slug}`,
        changefreq: 'yearly',
        priority: '0.6',
      });
    }

    for (const article of index) {
      entries.push({
        loc: `${baseUrl}/blog/${article.slug}`,
        lastmod: article.publishedAt ? article.publishedAt.split('T')[0] : today,
        changefreq: 'monthly',
        priority: '0.7',
      });
    }

    const urls = entries.map((e) => {
      const lastmod = e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : '';
      return `  <url><loc>${xmlEscape(e.loc)}</loc>${lastmod}<changefreq>${e.changefreq}</changefreq><priority>${e.priority}</priority></url>`;
    }).join('\n');

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
  <meta name="description" content="Insider trading insights, SEC Form 4 analysis, and investment education from Buyside Brief. Plain-English deep dives for regular investors.">
  <link rel="canonical" href="https://www.buysidebrief.com/blog">
  <meta property="og:title" content="Buyside Brief Blog — Insider Trading & Form 4 Explainers">
  <meta property="og:description" content="Plain-English deep dives on insider trading signals, SEC Form 4 mechanics, and how to read filings like an analyst. New posts several times a week.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="https://www.buysidebrief.com/blog">
  <meta property="og:image" content="https://www.buysidebrief.com/og-image.png">
  <meta property="og:site_name" content="Buyside Brief">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="Buyside Brief Blog — Insider Trading & Form 4 Explainers">
  <meta name="twitter:description" content="Plain-English deep dives on insider trading signals, SEC Form 4 mechanics, and how to read filings like an analyst. New posts several times a week.">
  <meta name="twitter:image" content="https://www.buysidebrief.com/og-image.png">
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
    <a href="https://www.buysidebrief.com">Buyside Brief</a>
    <nav class="site-nav">
      <a href="/blog">Blog</a>
      <a href="https://www.buysidebrief.com/archive.html">Newsletter Archive</a>
      <a href="https://www.buysidebrief.com/scorecard.html">Scorecard</a>
      <a href="https://www.buysidebrief.com/#subscribe">Subscribe</a>
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
    <a href="https://www.buysidebrief.com">Home</a> &middot;
    <a href="https://www.buysidebrief.com/#subscribe">Subscribe</a>
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

async function runDailyPipeline(redis, { date } = {}) {
  const store = new BlogStore(redis);
  const today = date || new Date().toISOString().split('T')[0];

  console.log('[SEO] Step 1: Getting today\'s calendar entry...');
  const entry = await store.getTodayEntry();
  if (!entry) {
    console.log('[SEO] No calendar entry for today. Skipping.');
    return { status: 'skipped', reason: 'no_calendar_entry' };
  }
  console.log(`[SEO] Today's keyword: "${entry.keyword}" (${entry.category})`);

  console.log('[SEO] Step 2: Checking if already published...');
  // Date-scoped check FIRST — bulletproof even if a prior run wrote under
  // a slug that differs from entry.suggestedSlug (article-generator falls
  // back to Claude's meta.slug). Slug-scoped check stays as a backup for
  // calendars that intentionally republish the same slug across dates.
  if (await store.isPublishedForDate(today)) {
    console.log(`[SEO] Already published for ${today}. Skipping.`);
    return { status: 'skipped', reason: 'already_published', date: today };
  }
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
  // Set the date-scoped idempotency marker AFTER saveArticle succeeds. If
  // saveArticle threw mid-way, the marker stays unset and a retry can run
  // the full pipeline again.
  await store.markPublishedForDate(today, {
    slug: article.slug,
    title: article.title,
    keyword: entry.keyword,
  });
  console.log(`[SEO] Published at /blog/${article.slug}`);

  return {
    status: 'published',
    slug: article.slug,
    title: article.title,
    wordCount: article.wordCount,
    keyword: entry.keyword,
    category: entry.category,
    generatedAt: article.generatedAt,
    date: today,
  };
}

module.exports = { BlogStore, runDailyPipeline };
