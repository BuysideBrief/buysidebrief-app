/**
 * Tests for api/afternoon-scan.js
 *
 * Mocks all external dependencies: Redis, EDGAR, scoring pipeline, Claude API.
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

jest.mock('../lib/performance-tracker', () => ({
  loadRecentPicks: jest.fn().mockResolvedValue([]),
}));

jest.mock('../lib/context-enricher', () => ({
  enrichAllFilings: jest.fn(filings => Promise.resolve(filings)),
}));

jest.mock('../lib/social-snippet', () => ({
  generateSocialSnippet: jest.fn().mockResolvedValue({ twitter: 'tweet', linkedin: 'post' }),
}));

const { fetchRecentFilingsFromFeed, fetchAndParseForm4 } = require('../lib/sec-fetcher');
const { scoreAllFilings } = require('../lib/signal-scorer');
const { enrichAllFilings } = require('../lib/context-enricher');
const { generateSocialSnippet } = require('../lib/social-snippet');
const { batchAnalyzeEarnings } = require('../lib/earnings-helper');
const handler = require('../api/afternoon-scan');

// ── Helpers ──

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
    tier: score >= 75 ? 'top_pick' : 'mention',
    signals: ['Test signal'],
    warnings: [],
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('afternoon-scan handler', () => {

  test('returns dry_run when no auth params', async () => {
    const res = makeRes();
    await handler(makeReq({ dry: undefined }), res);
    expect(res.body.status).toBe('dry_run');
  });

  test('returns no_new_filings when EDGAR returns empty', async () => {
    fetchRecentFilingsFromFeed.mockResolvedValueOnce([]);
    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body.status).toBe('no_new_filings');
  });

  test('filters out morning accession numbers correctly', async () => {
    // Morning processed ACC-001 and ACC-002
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(['ACC-001', 'ACC-002']));

    // EDGAR returns 3 filings, 2 of which were morning-processed
    fetchRecentFilingsFromFeed.mockResolvedValueOnce([
      { accessionNumber: 'ACC-001', cik: '1' },
      { accessionNumber: 'ACC-002', cik: '2' },
      { accessionNumber: 'ACC-003', cik: '3' },
    ]);

    // Only ACC-003 should be parsed
    fetchAndParseForm4.mockResolvedValueOnce(makeFiling('ACC-003'));
    scoreAllFilings.mockReturnValueOnce([makeFiling('ACC-003', 'TEST', 40)]);

    const res = makeRes();
    await handler(makeReq(), res);

    // Should only parse the 1 new filing
    expect(fetchAndParseForm4).toHaveBeenCalledTimes(1);
    expect(fetchAndParseForm4).toHaveBeenCalledWith({ accessionNumber: 'ACC-003', cik: '3' });
  });

  test('returns early when no new filings after dedup', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(['ACC-001']));
    fetchRecentFilingsFromFeed.mockResolvedValueOnce([
      { accessionNumber: 'ACC-001', cik: '1' },
    ]);

    const res = makeRes();
    await handler(makeReq(), res);
    expect(res.body.status).toBe('no_new_filings');
    expect(fetchAndParseForm4).not.toHaveBeenCalled();
  });

  test('returns no_qualifying_signals when no signals score ≥ 75', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify([]));
    fetchRecentFilingsFromFeed.mockResolvedValueOnce([
      { accessionNumber: 'ACC-010', cik: '10' },
    ]);
    fetchAndParseForm4.mockResolvedValueOnce(makeFiling('ACC-010'));

    // All scores below 75
    scoreAllFilings.mockReturnValueOnce([makeFiling('ACC-010', 'LOW', 40)]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.body.status).toBe('no_qualifying_signals');
    // Should still store empty signals array
    expect(mockRedis.set).toHaveBeenCalledWith(
      expect.stringContaining('afternoon:signals:'),
      JSON.stringify([]),
      { ex: 172800 }
    );
  });

  test('only keeps top 2 signals when more qualify', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify([]));
    fetchRecentFilingsFromFeed.mockResolvedValueOnce([
      { accessionNumber: 'A1', cik: '1' },
      { accessionNumber: 'A2', cik: '2' },
      { accessionNumber: 'A3', cik: '3' },
    ]);
    fetchAndParseForm4
      .mockResolvedValueOnce(makeFiling('A1', 'AAA'))
      .mockResolvedValueOnce(makeFiling('A2', 'BBB'))
      .mockResolvedValueOnce(makeFiling('A3', 'CCC'));

    // 3 signals all ≥ 75
    scoreAllFilings.mockReturnValueOnce([
      makeFiling('A1', 'AAA', 90),
      makeFiling('A2', 'BBB', 85),
      makeFiling('A3', 'CCC', 80),
    ]);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.body.status).toBe('snippet_generated');
    expect(res.body.signal_count).toBe(2);
    // generateSocialSnippet should receive exactly 2 signals
    expect(generateSocialSnippet).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ ticker: 'AAA' }),
        expect.objectContaining({ ticker: 'BBB' }),
      ])
    );
  });

  test('stores correct Redis keys with TTL', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify([]));
    fetchRecentFilingsFromFeed.mockResolvedValueOnce([
      { accessionNumber: 'A1', cik: '1' },
    ]);
    fetchAndParseForm4.mockResolvedValueOnce(makeFiling('A1', 'TOP'));
    scoreAllFilings.mockReturnValueOnce([makeFiling('A1', 'TOP', 80)]);

    const res = makeRes();
    await handler(makeReq(), res);

    // Should store both afternoon:signals and afternoon:snippet keys
    const setCalls = mockRedis.set.mock.calls;
    const signalsCall = setCalls.find(c => c[0].includes('afternoon:signals:'));
    const snippetCall = setCalls.find(c => c[0].includes('afternoon:snippet:'));

    expect(signalsCall).toBeTruthy();
    expect(signalsCall[2]).toEqual({ ex: 172800 }); // 48h TTL

    expect(snippetCall).toBeTruthy();
    expect(snippetCall[2]).toEqual({ ex: 172800 }); // 48h TTL

    const snippetData = JSON.parse(snippetCall[1]);
    expect(snippetData.twitter).toBe('tweet');
    expect(snippetData.linkedin).toBe('post');
    expect(snippetData.generated_at).toBeTruthy();
    expect(snippetData.signals).toHaveLength(1);
  });

  test('handles enrichment failures gracefully', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify([]));
    fetchRecentFilingsFromFeed.mockResolvedValueOnce([
      { accessionNumber: 'A1', cik: '1' },
    ]);
    fetchAndParseForm4.mockResolvedValueOnce(makeFiling('A1', 'ERR'));
    scoreAllFilings.mockReturnValueOnce([makeFiling('A1', 'ERR', 80)]);

    // Enrichment throws
    enrichAllFilings.mockRejectedValueOnce(new Error('Finnhub rate limit'));

    const res = makeRes();
    await handler(makeReq(), res);

    // Should still generate snippet with unenriched signals
    expect(res.body.status).toBe('snippet_generated');
    expect(generateSocialSnippet).toHaveBeenCalled();
  });

  test('handles earnings check failure gracefully', async () => {
    mockRedis.get.mockResolvedValueOnce(JSON.stringify([]));
    fetchRecentFilingsFromFeed.mockResolvedValueOnce([
      { accessionNumber: 'A1', cik: '1' },
    ]);
    fetchAndParseForm4.mockResolvedValueOnce(makeFiling('A1', 'TOP'));
    scoreAllFilings.mockReturnValueOnce([makeFiling('A1', 'TOP', 80)]);

    // Earnings throws
    batchAnalyzeEarnings.mockRejectedValueOnce(new Error('API down'));

    const res = makeRes();
    await handler(makeReq(), res);

    // Pipeline should continue despite earnings failure
    expect(res.body.status).toBe('snippet_generated');
  });

  test('handles Redis morning accession load failure gracefully', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis connection failed'));
    fetchRecentFilingsFromFeed.mockResolvedValueOnce([
      { accessionNumber: 'A1', cik: '1' },
    ]);
    fetchAndParseForm4.mockResolvedValueOnce(makeFiling('A1', 'TOP'));
    scoreAllFilings.mockReturnValueOnce([makeFiling('A1', 'TOP', 80)]);

    const res = makeRes();
    await handler(makeReq(), res);

    // Should proceed with all filings (no dedup possible)
    expect(fetchAndParseForm4).toHaveBeenCalledTimes(1);
    expect(res.body.status).toBe('snippet_generated');
  });
});
