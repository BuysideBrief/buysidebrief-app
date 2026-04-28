/**
 * tests/seo-idempotent.test.js
 *
 * Verifies the daily SEO article pipeline is idempotent:
 *   1. Same-day double-fire: second run is a no-op with reason=already_published.
 *   2. Marker set AFTER save: a Claude failure leaves no marker behind,
 *      so a retry can succeed.
 *   3. Slug drift safety: if Claude returns a slug that differs from
 *      entry.suggestedSlug, the second run still recognizes the date as
 *      published (date-scoped marker is the canonical gate).
 *
 * Run:
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config tests/seo-idempotent.test.js
 */

const assert = require('node:assert/strict');
const path = require('path');
const { makeFakeRedis, stubModule } = require('./_helpers/digest-pipeline-stubs');

// Stub article-generator BEFORE requiring publish-pipeline so the real
// Claude call never fires.
const generateArticleSpy = {
  calls: 0,
  nextResult: null,
  nextError: null,
};

const generatorPath = path.resolve(__dirname, '..', 'lib', 'article-generator.js');
stubModule(generatorPath, {
  generateArticle: async (args) => {
    generateArticleSpy.calls++;
    if (generateArticleSpy.nextError) throw generateArticleSpy.nextError;
    return generateArticleSpy.nextResult || {
      title: `About ${args.keyword}`,
      slug: `about-${args.keyword.replace(/\s+/g, '-').toLowerCase()}`,
      metaDescription: 'desc',
      content: '<p>body</p>',
      wordCount: 800,
      keyword: args.keyword,
      category: args.category,
      generatedAt: new Date().toISOString(),
    };
  },
  wrapArticleInPage: (a) => `<html>${a.title}</html>`,
});

// Now safe to require publish-pipeline.
delete require.cache[require.resolve('../lib/publish-pipeline')];
const { BlogStore, runDailyPipeline } = require('../lib/publish-pipeline');

async function seedCalendar(redis, date, entry) {
  await redis.set('seo:calendar', JSON.stringify([{
    date,
    keyword: entry.keyword,
    category: entry.category,
    suggestedTitle: entry.suggestedTitle,
    suggestedSlug: entry.suggestedSlug,
  }]));
}

function freezeDate(iso) {
  const RealDate = Date;
  const fixedNow = new RealDate(iso + 'T00:00:00Z').getTime();
  global.Date = class extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedNow);
      } else {
        super(...args);
      }
    }
    static now() { return fixedNow; }
  };
  return () => { global.Date = RealDate; };
}

async function main() {
  // ── Case 1: same-day double-fire is a no-op ──
  {
    generateArticleSpy.calls = 0;
    generateArticleSpy.nextError = null;
    generateArticleSpy.nextResult = null;
    const restore = freezeDate('2026-04-29');
    const redis = makeFakeRedis();
    await seedCalendar(redis, '2026-04-29', {
      keyword: 'insider trading',
      category: 'education',
      suggestedTitle: 'Insider Trading 101',
      suggestedSlug: 'insider-trading-101',
    });

    const first = await runDailyPipeline(redis);
    assert.equal(first.status, 'published', 'first call publishes');
    assert.equal(generateArticleSpy.calls, 1, 'Claude called once');
    assert.ok(redis._store.has('seo:published:2026-04-29'), 'date marker set after publish');

    const second = await runDailyPipeline(redis);
    assert.equal(second.status, 'skipped', 'second call skipped');
    assert.equal(second.reason, 'already_published', 'reason is already_published');
    assert.equal(generateArticleSpy.calls, 1, 'Claude NOT called a second time');

    const third = await runDailyPipeline(redis);
    assert.equal(third.status, 'skipped', 'third call still skipped');
    assert.equal(generateArticleSpy.calls, 1, 'Claude still called only once total');

    restore();
  }

  // ── Case 2: Claude failure leaves no marker; retry can proceed ──
  {
    generateArticleSpy.calls = 0;
    generateArticleSpy.nextError = new Error('Claude timeout (test)');
    generateArticleSpy.nextResult = null;
    const restore = freezeDate('2026-04-30');
    const redis = makeFakeRedis();
    await seedCalendar(redis, '2026-04-30', {
      keyword: 'form 4',
      category: 'education',
      suggestedTitle: 'Form 4 Explained',
      suggestedSlug: 'form-4-explained',
    });

    let threw = false;
    try {
      await runDailyPipeline(redis);
    } catch (e) {
      threw = true;
      assert.match(e.message, /Claude timeout/);
    }
    assert.equal(threw, true, 'pipeline propagates Claude error');
    assert.equal(generateArticleSpy.calls, 1, 'Claude attempted once');
    assert.ok(!redis._store.has('seo:published:2026-04-30'), 'date marker NOT set after Claude failure');
    assert.ok(!redis._store.has('seo:article:form-4-explained'), 'article NOT saved after Claude failure');

    // Retry with a working Claude — should publish cleanly.
    generateArticleSpy.nextError = null;
    const retry = await runDailyPipeline(redis);
    assert.equal(retry.status, 'published', 'retry publishes successfully');
    assert.equal(generateArticleSpy.calls, 2, 'Claude called again on retry');
    assert.ok(redis._store.has('seo:published:2026-04-30'), 'date marker set on retry success');

    restore();
  }

  // ── Case 3: slug drift — Claude returns a slug different from suggestedSlug.
  //   Date-scoped marker still catches the duplicate on a same-day rerun.
  {
    generateArticleSpy.calls = 0;
    generateArticleSpy.nextError = null;
    generateArticleSpy.nextResult = {
      title: 'A Different Title',
      slug: 'a-different-title',  // NOT what suggestedSlug says
      metaDescription: 'desc',
      content: '<p>body</p>',
      wordCount: 900,
      keyword: 'options expiry',
      category: 'education',
      generatedAt: new Date().toISOString(),
    };
    const restore = freezeDate('2026-05-01');
    const redis = makeFakeRedis();
    await seedCalendar(redis, '2026-05-01', {
      keyword: 'options expiry',
      category: 'education',
      suggestedTitle: 'Options Expiry Cycles',
      suggestedSlug: 'options-expiry-cycles', // calendar's slug
    });

    const first = await runDailyPipeline(redis);
    assert.equal(first.status, 'published');
    assert.equal(first.slug, 'a-different-title', 'article saved under drifted slug');
    assert.ok(redis._store.has('seo:article:a-different-title'), 'storage uses drifted slug');
    assert.ok(!redis._store.has('seo:article:options-expiry-cycles'), 'suggestedSlug NOT in storage');
    assert.ok(redis._store.has('seo:published:2026-05-01'), 'date marker set');

    // Same-day rerun. The slug-only check (suggestedSlug) would MISS this.
    // The date marker catches it.
    const second = await runDailyPipeline(redis);
    assert.equal(second.status, 'skipped', 'same-day rerun caught by date marker');
    assert.equal(second.reason, 'already_published');
    assert.equal(generateArticleSpy.calls, 1, 'Claude NOT called again despite slug drift');

    restore();
  }

  console.log('OK — seo-idempotent.test.js');
}

main().catch((err) => {
  console.error('FAIL — seo-idempotent.test.js');
  console.error(err);
  process.exit(1);
});
