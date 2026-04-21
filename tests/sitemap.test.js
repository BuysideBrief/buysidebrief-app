const fs = require('fs');
const path = require('path');
const { BlogStore } = require('../lib/publish-pipeline');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'https://www.buysidebrief.com';

function makeRedis(articles) {
  return {
    get: async (key) => {
      if (key === 'seo:article-index') return JSON.stringify(articles);
      return null;
    },
    set: async () => null,
    smembers: async () => [],
  };
}

function extractLocs(xml) {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

describe('BlogStore.generateSitemap', () => {
  test('includes every required static page', async () => {
    const store = new BlogStore(makeRedis([]));
    const locs = extractLocs(await store.generateSitemap(BASE));

    for (const rel of ['/', '/scorecard.html', '/archive.html', '/terms.html', '/privacy.html', '/blog', '/research']) {
      expect(locs).toContain(BASE + rel);
    }
  });

  test('includes every research article on disk (no .html extension)', async () => {
    const store = new BlogStore(makeRedis([]));
    const locs = extractLocs(await store.generateSitemap(BASE));

    const researchFiles = fs.readdirSync(path.join(ROOT, 'research'))
      .filter((f) => f.endsWith('.html') && f !== 'index.html');
    expect(researchFiles.length).toBeGreaterThan(0);

    for (const file of researchFiles) {
      const slug = file.replace(/\.html$/, '');
      expect(locs).toContain(`${BASE}/research/${slug}`);
    }

    for (const loc of locs) {
      if (loc.includes('/research/')) expect(loc).not.toMatch(/\.html$/);
    }
  });

  test('includes every blog article from Redis seo:article-index with lastmod', async () => {
    const articles = [
      { slug: 'how-form-4-works', publishedAt: '2026-04-01T00:00:00.000Z' },
      { slug: 'ceo-vs-cfo-buys',  publishedAt: '2026-04-10T00:00:00.000Z' },
      { slug: 'cluster-buying',   publishedAt: '2026-04-15T00:00:00.000Z' },
    ];
    const store = new BlogStore(makeRedis(articles));
    const xml = await store.generateSitemap(BASE);
    const locs = extractLocs(xml);

    for (const a of articles) {
      expect(locs).toContain(`${BASE}/blog/${a.slug}`);
      expect(xml).toMatch(new RegExp(`/blog/${a.slug}</loc><lastmod>${a.publishedAt.split('T')[0]}</lastmod>`));
    }
  });

  test('still emits a valid sitemap when Redis has no articles', async () => {
    const store = new BlogStore(makeRedis([]));
    const xml = await store.generateSitemap(BASE);
    expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain('</urlset>');
    expect(extractLocs(xml).length).toBeGreaterThanOrEqual(7);
  });

  test('no duplicate <loc> entries', async () => {
    const articles = [{ slug: 'a', publishedAt: '2026-04-01T00:00:00.000Z' }];
    const store = new BlogStore(makeRedis(articles));
    const locs = extractLocs(await store.generateSitemap(BASE));
    expect(new Set(locs).size).toBe(locs.length);
  });

  test('all <loc> values are absolute https URLs under buysidebrief.com', async () => {
    const store = new BlogStore(makeRedis([{ slug: 'x', publishedAt: '2026-04-01T00:00:00.000Z' }]));
    const locs = extractLocs(await store.generateSitemap(BASE));
    for (const loc of locs) {
      expect(loc).toMatch(/^https:\/\/www\.buysidebrief\.com\//);
    }
  });

  test('no stale /sitemap.xml shadow file in repo root', () => {
    expect(fs.existsSync(path.join(ROOT, 'sitemap.xml'))).toBe(false);
  });
});
