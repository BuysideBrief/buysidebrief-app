const fs = require('fs');
const path = require('path');
const { wrapArticleInPage } = require('../lib/article-generator');
const { BlogStore } = require('../lib/publish-pipeline');

const ROOT = path.resolve(__dirname, '..');

const REQUIRED_OG = [
  'og:title',
  'og:description',
  'og:type',
  'og:url',
  'og:image',
  'og:site_name',
];

const REQUIRED_TWITTER = [
  'twitter:card',
  'twitter:title',
  'twitter:description',
  'twitter:image',
];

function extractHead(html) {
  const m = html.match(/<head[\s\S]*?<\/head>/i);
  return m ? m[0] : '';
}

function hasMetaProperty(head, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, 'i');
  return re.test(head);
}

function getMetaContent(head, name) {
  const re = new RegExp(`<meta[^>]+(?:property|name)\\s*=\\s*["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*content\\s*=\\s*["']([^"']+)["']`, 'i');
  const m = head.match(re);
  return m ? m[1] : null;
}

function assertMetaTags(label, html) {
  const head = extractHead(html);
  expect(head).not.toBe('');

  const title = head.match(/<title>([^<]+)<\/title>/i);
  expect(title && title[1].trim().length).toBeGreaterThan(0);

  const description = getMetaContent(head, 'description');
  expect(description).toBeTruthy();

  for (const prop of REQUIRED_OG) {
    if (!hasMetaProperty(head, prop)) {
      throw new Error(`${label} missing ${prop}`);
    }
  }
  for (const name of REQUIRED_TWITTER) {
    if (!hasMetaProperty(head, name)) {
      throw new Error(`${label} missing ${name}`);
    }
  }

  expect(getMetaContent(head, 'twitter:card')).toBe('summary_large_image');

  const ogUrl = getMetaContent(head, 'og:url');
  expect(ogUrl).toMatch(/^https:\/\/(www\.)?buysidebrief\.com/);

  const ogImage = getMetaContent(head, 'og:image');
  expect(ogImage).toMatch(/^https:\/\/(www\.)?buysidebrief\.com\/.+\.(png|jpg|jpeg|webp)$/i);

  const twitterImage = getMetaContent(head, 'twitter:image');
  expect(twitterImage).toMatch(/^https:\/\/(www\.)?buysidebrief\.com\/.+\.(png|jpg|jpeg|webp)$/i);
}

const staticPages = [
  'index.html',
  'archive.html',
  'scorecard.html',
  'terms.html',
  'privacy.html',
  'research/index.html',
  'research/new-exec-signal-2026-04.html',
  'research/congressional-overlap-nonfinding-2026-04.html',
];

describe('Public static HTML pages — OG and Twitter card meta tags', () => {
  for (const rel of staticPages) {
    test(`${rel} has full OG + Twitter card set`, () => {
      const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      assertMetaTags(rel, html);
    });
  }
});

describe('Dynamic blog routes — OG and Twitter card meta tags', () => {
  test('wrapArticleInPage renders full OG + Twitter set for a blog post', () => {
    const html = wrapArticleInPage({
      title: 'How Form 4 insider buys actually work',
      slug: 'how-form-4-insider-buys-work',
      metaDescription: 'A plain-English walkthrough of SEC Form 4 filings, what the codes mean, and which signals actually matter for regular investors.',
      content: '<article><h1>How Form 4 insider buys actually work</h1><p>Body.</p></article>',
      wordCount: 1234,
      category: 'explainer',
      generatedAt: '2026-04-18T12:00:00.000Z',
    });
    assertMetaTags('/blog/:slug', html);

    const head = extractHead(html);
    expect(getMetaContent(head, 'og:type')).toBe('article');
  });

  test('BlogStore blog index page has full OG + Twitter set', async () => {
    const store = new BlogStore({
      get: async () => null,
      smembers: async () => [],
    });
    const html = await store.generateBlogIndexHTML();
    assertMetaTags('/blog', html);
  });
});
