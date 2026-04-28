/**
 * Test harness for lib/digest-pipeline.js.
 *
 * Plain Node, no Jest. Provides:
 *   - makeFakeRedis(): tiny in-memory Upstash-shaped client supporting
 *     get / set / del / zadd / zrange / exists / pipeline.
 *   - stubModule(specifier, exports): pre-populates require.cache so a
 *     subsequent require() of the same module path returns the stub.
 *   - installDigestStubs(opts): stubs every heavy dep used by digest-pipeline
 *     with sensible defaults, returning the spy refs so tests can assert.
 *
 * Call installDigestStubs() BEFORE requiring lib/digest-pipeline so the
 * cached stubs win.
 */

const path = require('path');

function stubModule(specifier, exports) {
  const resolved = require.resolve(specifier);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
    children: [],
    paths: [],
  };
  return resolved;
}

function makeFakeRedis() {
  const store = new Map();
  // Sorted sets are modeled as Map<member, score>.
  const zsets = new Map();

  const zsetOf = (key) => {
    if (!zsets.has(key)) zsets.set(key, new Map());
    return zsets.get(key);
  };

  const api = {
    _store: store,
    _zsets: zsets,
    async get(key) {
      const v = store.get(key);
      return v === undefined ? null : v;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    async del(...keys) {
      let n = 0;
      for (const k of keys) if (store.delete(k)) n++;
      return n;
    },
    async exists(key) {
      return store.has(key) ? 1 : 0;
    },
    async zadd(key, entry) {
      const z = zsetOf(key);
      if (Array.isArray(entry)) {
        for (const e of entry) z.set(e.member, e.score);
      } else if (entry && typeof entry === 'object') {
        z.set(entry.member, entry.score);
      }
      return 1;
    },
    async zrange(key, start, stop /*, opts */) {
      const z = zsets.get(key);
      if (!z) return [];
      const sorted = [...z.entries()].sort((a, b) => a[1] - b[1]).map(([m]) => m);
      const lo = Math.max(0, start);
      const hi = stop === -1 ? sorted.length : stop + 1;
      return sorted.slice(lo, hi);
    },
    async sadd(key, ...members) {
      let n = 0;
      const cur = store.get(key) || new Set();
      for (const m of members.flat()) {
        if (!cur.has(m)) {
          cur.add(m);
          n++;
        }
      }
      store.set(key, cur);
      return n;
    },
    async smembers(key) {
      const cur = store.get(key);
      return cur ? [...cur] : [];
    },
    pipeline() {
      const ops = [];
      const pipe = {
        set(k, v /*, opts */) { ops.push(['set', k, v]); return pipe; },
        get(k) { ops.push(['get', k]); return pipe; },
        del(k) { ops.push(['del', k]); return pipe; },
        zadd(k, e) { ops.push(['zadd', k, e]); return pipe; },
        sadd(k, ...m) { ops.push(['sadd', k, m]); return pipe; },
        async exec() {
          const results = [];
          for (const op of ops) {
            if (op[0] === 'set') { store.set(op[1], op[2]); results.push('OK'); }
            else if (op[0] === 'get') { results.push(store.has(op[1]) ? store.get(op[1]) : null); }
            else if (op[0] === 'del') { results.push(store.delete(op[1]) ? 1 : 0); }
            else if (op[0] === 'zadd') {
              const z = zsetOf(op[1]);
              const entry = op[2];
              if (Array.isArray(entry)) for (const e of entry) z.set(e.member, e.score);
              else if (entry) z.set(entry.member, entry.score);
              results.push(1);
            } else if (op[0] === 'sadd') {
              const cur = store.get(op[1]) || new Set();
              for (const m of op[2].flat()) cur.add(m);
              store.set(op[1], cur);
              results.push(1);
            } else {
              results.push(null);
            }
          }
          return results;
        },
      };
      return pipe;
    },
  };

  return api;
}

/**
 * Convenience: builds a tiny scored filing with just the fields the pipeline
 * actually reads. Pass overrides for whatever you want different.
 */
function makeScoredFiling(overrides = {}) {
  return {
    ticker: 'ACME',
    issuerName: 'Acme Corp',
    issuerCik: '1000001',
    ownerName: 'Jane Doe',
    ownerCik: '2000001',
    officerTitle: 'CEO',
    isOfficer: true,
    isDirector: false,
    isTenPercentOwner: false,
    score: 80,
    tier: 'top_pick',
    signals: ['Officer buy'],
    warnings: [],
    summary: {
      totalBuyValue: 500_000,
      totalBuyShares: 10_000,
      totalSellValue: 0,
      buyCount: 1,
      sellCount: 0,
    },
    transactions: [{ type: 'buy', shares: 10_000, value: 500_000 }],
    has10b51Plan: false,
    accessionNumber: '0001000001-26-000001',
    filedAt: '2026-04-28',
    ...overrides,
  };
}

/**
 * Stub every heavy dependency of lib/digest-pipeline.js. Call BEFORE
 * `require('../../lib/digest-pipeline')`. Returns the stubs so tests can
 * inspect what got called and overwrite return values per test.
 */
function installDigestStubs(opts = {}) {
  const calls = {
    fetchRecentFilingsFromFeed: [],
    fetchAndParseForm4: [],
    enrichAllFilings: [],
    sendDigest: [],
    sendOwnerSnippetEmail: [],
    storeIssue: [],
    recordHeadlinePick: [],
    rotateHeadlinePick: [],
    recordNewPicks: [],
    updateAllReturns: [],
  };

  const filings = opts.filings || [makeScoredFiling()];
  const filingIndex = opts.filingIndex || filings.map((f, i) => ({
    accessionNumber: f.accessionNumber || `0001000001-26-${String(i).padStart(6, '0')}`,
    cik: f.issuerCik,
    entityName: f.issuerName,
    filedAt: f.filedAt,
  }));

  // Resolve relative to lib/digest-pipeline.js so paths match how that file
  // resolves them.
  const fromDigest = (rel) =>
    path.resolve(__dirname, '..', '..', 'lib', rel);
  const fromArchive = path.resolve(__dirname, '..', '..', 'api', 'archive.js');

  stubModule(fromDigest('sec-fetcher.js'), {
    fetchRecentFilingsFromFeed: async (n) => {
      calls.fetchRecentFilingsFromFeed.push(n);
      return filingIndex;
    },
    fetchAndParseForm4: async (filing) => {
      calls.fetchAndParseForm4.push(filing.accessionNumber);
      const match = filings.find((f) => f.accessionNumber === filing.accessionNumber);
      return match || null;
    },
  });

  stubModule(fromDigest('signal-scorer.js'), {
    scoreAllFilings: (parsed) => parsed.map((f) => ({ ...f })),
    categorizeForDigest: (scored) => ({
      strongSignals: scored.filter((f) => f.tier === 'strong_signal'),
      topPicks: scored.filter((f) => f.tier === 'top_pick'),
      featured: scored.filter((f) => f.tier === 'feature'),
      mentions: scored.filter((f) => f.tier === 'mention'),
    }),
    isInstitutionalBuyer: () => false,
    formatValue: (v) => `$${v}`,
  });

  stubModule(fromDigest('email-formatter.js'), {
    formatDigestEmail: (cat) => ({
      subject: `Test digest — ${cat.topPicks[0]?.ticker || 'NONE'}`,
      html: '<html>test</html>',
    }),
  });

  stubModule(fromDigest('notable.js'), {
    storeNotableFilings: async (scored) => {
      // Default: nothing notable — tests can override
      if (opts.notableEntries) return opts.notableEntries;
      return [];
    },
  });

  stubModule(fromDigest('context-enricher.js'), {
    enrichAllFilings: async (scored) => {
      calls.enrichAllFilings.push(scored.length);
      return scored.map((f) => ({ ...f, whyItMatters: 'template blurb' }));
    },
  });

  stubModule(fromDigest('performance-tracker.js'), {
    recordNewPicks: async (filings) => {
      calls.recordNewPicks.push(filings.length);
      return filings.length;
    },
    updateAllReturns: async () => {
      calls.updateAllReturns.push(true);
      return 0;
    },
    generateScorecard: async () => ({ winRate: 0.6, totalPicks: 10 }),
    formatScorecardForEmail: () => '<div>scorecard</div>',
    formatCeoSpotlight: () => '<div>ceo</div>',
    getCeoProfile: async () => null,
    loadRecentPicks: async () => [],
  });

  stubModule(fromDigest('market-overview.js'), {
    getMarketOverview: async () => ({ indices: [{ label: 'S&P 500', changePercent: 0.5, isPositive: true }] }),
    formatMarketOverviewForEmail: () => '<div>market</div>',
  });

  stubModule(fromDigest('ai-content.js'), {
    generateMarketContext: async () => 'AI market summary.',
    generateWhyItMattersAI: async (f) => `AI why ${f.ticker}`,
    generateSocialSnippet: async (f) => f ? `Snippet for $${f.ticker}` : null,
  });

  stubModule(fromDigest('earnings-helper.js'), {
    batchAnalyzeEarnings: async () => new Map(),
  });

  stubModule(fromDigest('contrarian-detector.js'), {
    batchAnalyzeContrarian: async () => new Map(),
  });

  stubModule(fromDigest('historical-store.js'), {
    storeAllScoredFilings: async (scored) => ({ stored: scored.length, skipped: 0, dailySummary: null }),
  });

  stubModule(fromDigest('recently-featured.js'), {
    rotateHeadlinePick: async (cat) => {
      calls.rotateHeadlinePick.push(cat.topPicks[0]?.ticker || null);
      return cat;
    },
    recordHeadlinePick: async (ticker, date) => {
      calls.recordHeadlinePick.push({ ticker, date });
      return true;
    },
  });

  stubModule(fromDigest('pick-filters.js'), {
    // Real dampenRepeatInsiders returns a new array; we must too, otherwise
    // the in-place `scored.length = 0; scored.push(...dampened)` in
    // prepare() will clear the very array we're pushing from.
    dampenRepeatInsiders: (scored) => scored.map((f) => ({ ...f })),
  });

  stubModule(fromDigest('company-profile.js'), {
    getCompanyProfileBatch: async () => new Map(),
  });

  stubModule(fromDigest('email-sender.js'), {
    sendDigest: async (subject, html) => {
      calls.sendDigest.push({ subject, htmlLength: html.length });
      if (opts.failResend) throw new Error('Resend explosion (test)');
      return { id: 'broadcast_test_123' };
    },
    sendOwnerSnippetEmail: async (args) => {
      calls.sendOwnerSnippetEmail.push(args);
      return { sent: true, to: 'pete@example.com' };
    },
  });

  stubModule(fromArchive, {
    storeIssue: async (date, subject, html, stats) => {
      calls.storeIssue.push({ date, subject, stats });
      return true;
    },
  });

  return calls;
}

module.exports = {
  stubModule,
  makeFakeRedis,
  makeScoredFiling,
  installDigestStubs,
};
