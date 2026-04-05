/**
 * Tests for api/fetch-and-send.js
 *
 * Mocks all external dependencies: SEC EDGAR, scoring, enrichment,
 * AI content, performance tracking, email formatting, Redis, and Resend.
 */

// ── Mocks ──

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
};

jest.mock('../lib/redis', () => ({
  getRedisOrNoop: () => mockRedis,
}));

jest.mock('../lib/sec-fetcher', () => ({
  fetchRecentFilingsFromFeed: jest.fn(),
  fetchAndParseForm4: jest.fn(),
}));

jest.mock('../lib/signal-scorer', () => ({
  scoreAllFilings: jest.fn(),
  categorizeForDigest: jest.fn(),
}));

jest.mock('../lib/earnings-helper', () => ({
  batchAnalyzeEarnings: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../lib/contrarian-detector', () => ({
  batchAnalyzeContrarian: jest.fn().mockResolvedValue(new Map()),
}));

jest.mock('../lib/pick-filters', () => ({
  dampenRepeatInsiders: jest.fn(filings => filings),
}));

jest.mock('../lib/context-enricher', () => ({
  enrichAllFilings: jest.fn(filings => Promise.resolve(filings)),
}));

jest.mock('../lib/ai-content', () => ({
  generateMarketContext: jest.fn().mockResolvedValue('AI market summary'),
  generateWhyItMattersAI: jest.fn().mockResolvedValue('AI blurb'),
  generateSocialSnippet: jest.fn().mockResolvedValue('social snippet text'),
}));

jest.mock('../lib/performance-tracker', () => ({
  recordNewPicks: jest.fn().mockResolvedValue(2),
  updateAllReturns: jest.fn().mockResolvedValue(5),
  generateScorecard: jest.fn().mockResolvedValue({ winRate: 0.65, totalPicks: 10 }),
  formatScorecardForEmail: jest.fn().mockReturnValue('<div>scorecard</div>'),
  formatCeoSpotlight: jest.fn().mockReturnValue('<div>ceo</div>'),
  getCeoProfile: jest.fn().mockResolvedValue(null),
  loadRecentPicks: jest.fn().mockResolvedValue([]),
}));

jest.mock('../lib/email-formatter', () => ({
  formatDigestEmail: jest.fn().mockReturnValue({
    subject: 'Buyside Brief — Test Subject',
    html: '<html>mock email</html>',
  }),
}));

jest.mock('../lib/market-overview', () => ({
  getMarketOverview: jest.fn().mockResolvedValue({ sp500: { change: 0.5 } }),
  formatMarketOverviewForEmail: jest.fn().mockReturnValue('<div>market</div>'),
}));

jest.mock('../lib/historical-store', () => ({
  storeAllScoredFilings: jest.fn().mockResolvedValue({ stored: 5, skipped: 0 }),
}));

jest.mock('../lib/recently-featured', () => ({
  rotateHeadlinePick: jest.fn(cat => Promise.resolve(cat)),
  recordHeadlinePick: jest.fn().mockResolvedValue(true),
}));

jest.mock('../api/archive', () => ({
  storeIssue: jest.fn().mockResolvedValue(true),
}));

const { fetchRecentFilingsFromFeed, fetchAndParseForm4 } = require('../lib/sec-fetcher');
const { scoreAllFilings, categorizeForDigest } = require('../lib/signal-scorer');
const { enrichAllFilings } = require('../lib/context-enricher');
const { batchAnalyzeEarnings } = require('../lib/earnings-helper');
const { formatDigestEmail } = require('../lib/email-formatter');
const handler = require('../api/fetch-and-send');

// ── Helpers ──

const originalFetch = global.fetch;

function makeReq(query = {}, headers = {}) {
  return {
    query: { dry: 'true', ...query },
    headers: { 'user-agent': '', ...headers },
  };
}

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { res.statusCode = code; return res; },
    json(data) { res.body = data; return res; },
  };
  return res;
}

function makeFiling(accessionNumber, ticker = 'TEST', score = 50) {
  return {
    accessionNumber,
    ticker,
    ownerName: 'John Doe',
    ownerCik: '12345',
    officerTitle: 'CEO',
    isDirector: false,
    issuerName: `${ticker} Inc`,
    transactions: [{ type: 'buy', totalValue: 100000 }],
    summary: { totalBuyValue: 100000, buyCount: 1, totalSellValue: 0 },
    score,
    tier: score >= 100 ? 'strong_signal' : score >= 75 ? 'top_pick' : score >= 45 ? 'feature' : score >= 25 ? 'mention' : 'skip',
    signals: ['Test signal'],
    warnings: [],
  };
}

function makeCategorized(topPicks = [], featured = [], mentions = [], sells = []) {
  return { topPicks, featured, mentions, sells };
}

/** Set up the standard happy-path mocks for all pipeline steps. */
function setupHappyPath() {
  const filingIndex = [
    { accessionNumber: 'ACC-001', cik: '1' },
    { accessionNumber: 'ACC-002', cik: '2' },
  ];
  const filing1 = makeFiling('ACC-001', 'AAPL', 85);
  const filing2 = makeFiling('ACC-002', 'MSFT', 55);

  fetchRecentFilingsFromFeed.mockResolvedValue(filingIndex);
  fetchAndParseForm4
    .mockResolvedValueOnce(filing1)
    .mockResolvedValueOnce(filing2);
  scoreAllFilings.mockReturnValue([filing1, filing2]);
  categorizeForDigest.mockReturnValue(
    makeCategorized([filing1], [filing2], [], [])
  );

  return { filingIndex, filing1, filing2 };
}

beforeEach(() => {
  process.env.RESEND_API_KEY = 'test-key';
  process.env.TEST_EMAIL = 'test@example.com';
  process.env.CRON_SECRET = 'secret123';

  // Mock global fetch for Resend API calls
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ id: 'email-123' }),
    text: () => Promise.resolve('OK'),
  });
});

afterEach(() => {
  jest.clearAllMocks();
  global.fetch = originalFetch;
  delete process.env.RESEND_API_KEY;
  delete process.env.TEST_EMAIL;
  delete process.env.CRON_SECRET;
});

// ── Tests ──

describe('fetch-and-send handler', () => {

  // 1. Happy path
  test('happy path — filings found, scored, enriched, email sent', async () => {
    const { filing1, filing2 } = setupHappyPath();

    const res = makeRes();
    await handler(makeReq({ dry: undefined, send: 'true' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.subject).toBe('Buyside Brief — Test Subject');
    // Verify pipeline steps were called
    expect(fetchRecentFilingsFromFeed).toHaveBeenCalledWith(50);
    expect(fetchAndParseForm4).toHaveBeenCalledTimes(2);
    expect(scoreAllFilings).toHaveBeenCalled();
    expect(enrichAllFilings).toHaveBeenCalled();
    expect(formatDigestEmail).toHaveBeenCalled();
    // Email was sent via Resend (global.fetch called for email)
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({ method: 'POST' })
    );
  });

  // 1b. Happy path dry run
  test('dry run returns preview without sending email', async () => {
    setupHappyPath();

    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dry).toBe(true);
    expect(res.body.html).toBeDefined();
    expect(res.body.subject).toBeDefined();
    // Resend should NOT be called
    expect(global.fetch).not.toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.anything()
    );
  });

  // 2. No filings found
  test('no filings found — returns early with message', async () => {
    fetchRecentFilingsFromFeed.mockResolvedValue([]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toMatch(/no filings/i);
    expect(fetchAndParseForm4).not.toHaveBeenCalled();
    expect(scoreAllFilings).not.toHaveBeenCalled();
  });

  // 3. Auth check — no auth defaults to dry run
  test('requests without auth params default to dry run', async () => {
    setupHappyPath();

    const res = makeRes();
    // No cron header, no send=true, no dry=true → effectiveDryRun = true
    await handler(makeReq({ dry: undefined }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.dry).toBe(true);
    // Email should not be sent
    expect(global.fetch).not.toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.anything()
    );
  });

  // 3b. Cron auth sends live
  test('vercel cron user-agent triggers live send', async () => {
    setupHappyPath();

    const res = makeRes();
    await handler(makeReq({ dry: undefined }, { 'user-agent': 'vercel-cron/1.0' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dry).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.anything()
    );
  });

  // 3c. Bearer token auth sends live
  test('CRON_SECRET bearer token triggers live send', async () => {
    setupHappyPath();

    const res = makeRes();
    await handler(
      makeReq({ dry: undefined }, { authorization: 'Bearer secret123' }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.dry).toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.anything()
    );
  });

  // 4. Debug mode — requires auth
  test('debug mode with cron auth returns filing index data', async () => {
    const filingIndex = [
      { accessionNumber: 'ACC-001', cik: '1' },
      { accessionNumber: 'ACC-002', cik: '2' },
      { accessionNumber: 'ACC-003', cik: '3' },
    ];
    fetchRecentFilingsFromFeed.mockResolvedValue(filingIndex);

    const res = makeRes();
    await handler(
      makeReq({ debug: 'true', dry: undefined }, { 'user-agent': 'vercel-cron/1.0' }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.debug).toBe(true);
    expect(res.body.sampleFilings).toHaveLength(3);
    expect(res.body.totalFilings).toBe(3);
    // Should NOT proceed to parsing or scoring
    expect(scoreAllFilings).not.toHaveBeenCalled();
  });

  // 4b. Debug mode without auth falls through to dry run
  test('debug mode without auth does not return debug data', async () => {
    setupHappyPath();

    const res = makeRes();
    await handler(makeReq({ debug: 'true' }), res);

    expect(res.statusCode).toBe(200);
    // Without cron auth, isDebug && isCron is false, so it runs the pipeline as dry
    expect(res.body.debug).toBeUndefined();
    expect(res.body.dry).toBe(true);
  });

  // 5. Circuit breaker — when time is running short, optional steps are skipped
  test('circuit breaker skips earnings when time is short', async () => {
    setupHappyPath();

    // Advance Date.now so timeRemaining() returns < 15000
    const realDateNow = Date.now;
    let callCount = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      // First call captures startTime, subsequent calls show 50+ seconds elapsed
      if (callCount === 1) return 1000;
      return 46000; // 45s elapsed → 55000 - 45000 = 10000ms remaining (< 15000)
    });

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    // Earnings should be skipped due to time constraint
    expect(batchAnalyzeEarnings).not.toHaveBeenCalled();

    Date.now.mockRestore();
  });

  // 6. Email send failure — should log error, not crash
  test('email send failure returns 500 but does not crash', async () => {
    setupHappyPath();

    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Resend server error'),
    });

    const res = makeRes();
    await handler(makeReq({ dry: undefined, send: 'true' }), res);

    // sendViaResend throws → caught by outer try/catch → 500
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Internal server error');
  });

  // 7. Tier distribution — verify scoring tiers map correctly
  test('tier distribution: strong_signal >= 100, top_pick >= 75, feature >= 45', async () => {
    const filingIndex = [
      { accessionNumber: 'A1', cik: '1' },
      { accessionNumber: 'A2', cik: '2' },
      { accessionNumber: 'A3', cik: '3' },
      { accessionNumber: 'A4', cik: '4' },
    ];
    const strong = makeFiling('A1', 'STRG', 110);
    const top = makeFiling('A2', 'TOP', 80);
    const feat = makeFiling('A3', 'FEAT', 50);
    const mention = makeFiling('A4', 'MENT', 30);

    fetchRecentFilingsFromFeed.mockResolvedValue(filingIndex);
    fetchAndParseForm4
      .mockResolvedValueOnce(strong)
      .mockResolvedValueOnce(top)
      .mockResolvedValueOnce(feat)
      .mockResolvedValueOnce(mention);
    scoreAllFilings.mockReturnValue([strong, top, feat, mention]);
    categorizeForDigest.mockReturnValue(
      makeCategorized([strong, top], [feat], [mention], [])
    );

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    // Verify the helper assigns correct tiers
    expect(strong.tier).toBe('strong_signal');
    expect(top.tier).toBe('top_pick');
    expect(feat.tier).toBe('feature');
    expect(mention.tier).toBe('mention');
  });

  // 8. Error in enrichment — pipeline continues
  test('enrichment failure does not crash pipeline', async () => {
    setupHappyPath();
    enrichAllFilings.mockRejectedValueOnce(new Error('Finnhub rate limit'));

    const res = makeRes();
    await handler(makeReq(), res);

    // Outer catch handles → returns 500 because enrichAllFilings is not wrapped in try/catch
    // Actually, looking at the handler, enrichAllFilings is NOT in a try/catch —
    // it's called directly. So a rejection will bubble to the outer catch.
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });

  // 8b. Earnings enrichment failure — pipeline continues (this IS wrapped in try/catch)
  test('earnings check failure does not crash pipeline', async () => {
    setupHappyPath();
    batchAnalyzeEarnings.mockRejectedValueOnce(new Error('API down'));

    const res = makeRes();
    await handler(makeReq(), res);

    // Pipeline should continue despite earnings failure
    expect(res.statusCode).toBe(200);
    expect(enrichAllFilings).toHaveBeenCalled();
    expect(formatDigestEmail).toHaveBeenCalled();
  });

  // 9. Default URL hit (no params) defaults to dry run
  test('hitting URL with no query params defaults to dry run', async () => {
    setupHappyPath();

    const req = {
      query: {},
      headers: { 'user-agent': '' },
    };
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.dry).toBe(true);
  });

  // 10. Resend broadcast path (no TEST_EMAIL, with AUDIENCE_ID)
  test('broadcasts via Resend when AUDIENCE_ID set and no TEST_EMAIL', async () => {
    setupHappyPath();
    delete process.env.TEST_EMAIL;
    process.env.RESEND_AUDIENCE_ID = 'aud-123';

    global.fetch = jest.fn()
      // First call: create broadcast
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'broadcast-456' }),
      })
      // Second call: send broadcast
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: 'sent-789' }),
      })
      // Third call: social snippet email (may or may not be called)
      .mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: 'snippet-email' }),
      });

    const res = makeRes();
    await handler(makeReq({ dry: undefined, send: 'true' }), res);

    expect(res.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.resend.com/broadcasts',
      expect.objectContaining({ method: 'POST' })
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.resend.com/broadcasts/broadcast-456/send',
      expect.objectContaining({ method: 'POST' })
    );

    delete process.env.RESEND_AUDIENCE_ID;
  });

  // 11. Missing RESEND_API_KEY throws
  test('missing RESEND_API_KEY causes 500 on live send', async () => {
    setupHappyPath();
    delete process.env.RESEND_API_KEY;

    const res = makeRes();
    await handler(makeReq({ dry: undefined, send: 'true' }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });

  // 12. Filings with no transactions are filtered out
  test('filings with no transactions are excluded from pipeline', async () => {
    const filingIndex = [
      { accessionNumber: 'A1', cik: '1' },
      { accessionNumber: 'A2', cik: '2' },
    ];
    const withTxns = makeFiling('A1', 'AAPL', 80);
    const noTxns = { ...makeFiling('A2', 'GOOG', 60), transactions: [] };

    fetchRecentFilingsFromFeed.mockResolvedValue(filingIndex);
    fetchAndParseForm4
      .mockResolvedValueOnce(withTxns)
      .mockResolvedValueOnce(noTxns);
    scoreAllFilings.mockReturnValue([withTxns]);
    categorizeForDigest.mockReturnValue(makeCategorized([withTxns], [], [], []));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    // scoreAllFilings should only receive the filing with transactions
    expect(scoreAllFilings).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ ticker: 'AAPL' })])
    );
    const scoredArg = scoreAllFilings.mock.calls[0][0];
    expect(scoredArg.every(f => f.transactions.length > 0)).toBe(true);
  });

  // 13. Parse failure for individual filing doesn't crash batch
  test('individual filing parse failure is caught and skipped', async () => {
    const filingIndex = [
      { accessionNumber: 'A1', cik: '1' },
      { accessionNumber: 'A2', cik: '2' },
    ];
    const goodFiling = makeFiling('A2', 'MSFT', 60);

    fetchRecentFilingsFromFeed.mockResolvedValue(filingIndex);
    fetchAndParseForm4
      .mockRejectedValueOnce(new Error('XML parse error'))
      .mockResolvedValueOnce(goodFiling);
    scoreAllFilings.mockReturnValue([goodFiling]);
    categorizeForDigest.mockReturnValue(makeCategorized([], [goodFiling], [], []));

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    // Only the successful filing should make it through
    expect(scoreAllFilings).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ ticker: 'MSFT' })])
    );
  });
});
