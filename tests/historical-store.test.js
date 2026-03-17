/**
 * Tests for lib/historical-store.js
 * 
 * Tests the historical filing storage system:
 * - Storing all scored filings
 * - Querying by date
 * - Querying by ticker
 * - Daily summaries
 * - Insider sentiment calculation
 */

// Mock Redis
const mockStore = new Map();
const mockSortedSets = new Map();
const mockPipelineOps = [];

const mockPipeline = {
  set: jest.fn((key, value, opts) => {
    mockPipelineOps.push({ op: 'set', key, value, opts });
    mockStore.set(key, value);
  }),
  zadd: jest.fn((key, entry) => {
    mockPipelineOps.push({ op: 'zadd', key, entry });
    if (!mockSortedSets.has(key)) mockSortedSets.set(key, []);
    mockSortedSets.get(key).push(entry);
  }),
  exec: jest.fn(async () => {}),
};

const mockRedis = {
  pipeline: jest.fn(() => mockPipeline),
  get: jest.fn(async (key) => mockStore.get(key) || null),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
  zrange: jest.fn(async (key, ...args) => {
    const set = mockSortedSets.get(key) || [];
    // Return members sorted by score descending
    return set
      .sort((a, b) => b.score - a.score)
      .map(e => e.member);
  }),
};

// Mock @upstash/redis
jest.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: () => mockRedis,
  },
}));

const {
  storeAllScoredFilings,
  getFilingsByDate,
  getFilingsByTicker,
  getDailySummaries,
  getInsiderSentiment,
} = require('../lib/historical-store');

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  mockSortedSets.clear();
  mockPipelineOps.length = 0;
});

// ══════════════════════════════════════════
// Helper: create a scored filing
// ══════════════════════════════════════════

function makeFiling(overrides = {}) {
  return {
    ticker: 'AAPL',
    issuerName: 'Apple Inc.',
    ownerName: 'Tim Cook',
    ownerCik: '123456',
    officerTitle: 'CEO',
    isDirector: false,
    isOfficer: true,
    isTenPercentOwner: false,
    score: 75,
    tier: 'top_pick',
    signals: ['C-suite purchase (CEO)', 'Large purchase: $2.1M'],
    warnings: [],
    has10b51Plan: false,
    summary: {
      totalBuyValue: 2100000,
      totalSellValue: 0,
      totalBuyShares: 85000,
      buyCount: 1,
      sellCount: 0,
    },
    earningsContext: null,
    ...overrides,
  };
}

// ══════════════════════════════════════════
// storeAllScoredFilings
// ══════════════════════════════════════════

describe('storeAllScoredFilings', () => {
  test('stores filings and returns correct counts', async () => {
    const filings = [
      makeFiling({ ticker: 'AAPL', score: 85, tier: 'top_pick' }),
      makeFiling({ ticker: 'MSFT', score: 55, tier: 'feature', ownerCik: '789' }),
      makeFiling({ ticker: 'GOOG', score: 30, tier: 'mention', ownerCik: '456' }),
    ];

    const result = await storeAllScoredFilings(filings, '2026-03-17');

    expect(result.stored).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.dailySummary).toBeDefined();
    expect(result.dailySummary.totalFilings).toBe(3);
    expect(result.dailySummary.topPicks).toBe(1);
    expect(result.dailySummary.featured).toBe(1);
    expect(result.dailySummary.mentions).toBe(1);
  });

  test('skips filings without a ticker', async () => {
    const filings = [
      makeFiling({ ticker: 'AAPL' }),
      makeFiling({ ticker: '', ownerCik: '111' }),
      makeFiling({ ticker: null, ownerCik: '222' }),
    ];

    const result = await storeAllScoredFilings(filings, '2026-03-17');
    expect(result.stored).toBe(1);
    expect(result.skipped).toBe(2);
  });

  test('calculates daily summary correctly', async () => {
    const filings = [
      makeFiling({ ticker: 'AAPL', score: 80, summary: { totalBuyValue: 1000000, totalSellValue: 0, totalBuyShares: 50000, buyCount: 1, sellCount: 0 } }),
      makeFiling({ ticker: 'MSFT', score: 60, ownerCik: '789', summary: { totalBuyValue: 500000, totalSellValue: 0, totalBuyShares: 20000, buyCount: 1, sellCount: 0 } }),
      makeFiling({ ticker: 'TSLA', score: -10, tier: 'skip', ownerCik: '456', summary: { totalBuyValue: 0, totalSellValue: 200000, totalBuyShares: 0, buyCount: 0, sellCount: 1 } }),
    ];

    const result = await storeAllScoredFilings(filings, '2026-03-17');
    const s = result.dailySummary;

    expect(s.totalBuyValue).toBe(1500000);
    expect(s.totalSellValue).toBe(200000);
    expect(s.buyFilings).toBe(2);
    expect(s.sellFilings).toBe(1);
    expect(s.avgScore).toBe(43.33);
    expect(s.uniqueTickers).toBe(3);
  });

  test('stores correct Redis keys', async () => {
    const filings = [makeFiling({ ticker: 'AAPL', ownerCik: '123456' })];

    await storeAllScoredFilings(filings, '2026-03-17');

    // Check pipeline ops
    const setOps = mockPipelineOps.filter(op => op.op === 'set');
    const zaddOps = mockPipelineOps.filter(op => op.op === 'zadd');

    // Should have: 1 filing record + 1 daily summary = 2 sets
    expect(setOps.length).toBe(2);
    expect(setOps[0].key).toBe('filing:2026-03-17:AAPL:123456');
    expect(setOps[1].key).toBe('filings:daily:2026-03-17');

    // Should have: daily index + ticker index + daily master index = 3 zadds
    expect(zaddOps.length).toBe(3);
    expect(zaddOps[0].key).toBe('filings:index:2026-03-17');
    expect(zaddOps[1].key).toBe('filings:ticker:AAPL');
    expect(zaddOps[2].key).toBe('filings:daily:index');

    // No expire ops — data kept forever
    const expireOps = mockPipelineOps.filter(op => op.op === 'expire');
    expect(expireOps.length).toBe(0);
  });

  test('includes earnings context when present', async () => {
    const filings = [
      makeFiling({
        ticker: 'AAPL',
        earningsContext: {
          signal: 'post_earnings_buy',
          scoreAdjustment: 20,
          context: 'Bought 5 days after earnings missed',
        },
      }),
    ];

    await storeAllScoredFilings(filings, '2026-03-17');

    const setOps = mockPipelineOps.filter(op => op.op === 'set');
    const record = JSON.parse(setOps[0].value);
    expect(record.earningsSignal).toBe('post_earnings_buy');
    expect(record.earningsAdjustment).toBe(20);
  });

  test('stores records without TTL (kept forever)', async () => {
    const filings = [makeFiling()];
    await storeAllScoredFilings(filings, '2026-03-17');

    const setOps = mockPipelineOps.filter(op => op.op === 'set');
    // Should NOT have an expiry option
    expect(setOps[0].opts).toBeUndefined();
  });

  test('counts unique tickers correctly', async () => {
    const filings = [
      makeFiling({ ticker: 'AAPL', ownerCik: '111' }),
      makeFiling({ ticker: 'AAPL', ownerCik: '222' }), // same ticker, different insider
      makeFiling({ ticker: 'MSFT', ownerCik: '333' }),
    ];

    const result = await storeAllScoredFilings(filings, '2026-03-17');
    expect(result.dailySummary.uniqueTickers).toBe(2);
  });

  test('handles empty filings array', async () => {
    const result = await storeAllScoredFilings([], '2026-03-17');
    expect(result.stored).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.dailySummary.avgScore).toBe(0);
  });

  test('defaults to today when no date provided', async () => {
    const filings = [makeFiling()];
    const result = await storeAllScoredFilings(filings);

    const today = new Date().toISOString().split('T')[0];
    expect(result.dailySummary.date).toBe(today);
  });
});

// ══════════════════════════════════════════
// getFilingsByDate
// ══════════════════════════════════════════

describe('getFilingsByDate', () => {
  test('returns filings for a given date', async () => {
    // Seed data
    const record = JSON.stringify(makeFiling({ ticker: 'AAPL', score: 85 }));
    const key = 'filing:2026-03-17:AAPL:123456';
    mockStore.set(key, record);
    mockSortedSets.set('filings:index:2026-03-17', [
      { score: 85, member: key },
    ]);

    const results = await getFilingsByDate('2026-03-17');
    expect(results.length).toBe(1);
    expect(results[0].ticker).toBe('AAPL');
    expect(results[0].score).toBe(85);
  });

  test('filters by minimum score', async () => {
    const key1 = 'filing:2026-03-17:AAPL:111';
    const key2 = 'filing:2026-03-17:MSFT:222';
    mockStore.set(key1, JSON.stringify(makeFiling({ ticker: 'AAPL', score: 85 })));
    mockStore.set(key2, JSON.stringify(makeFiling({ ticker: 'MSFT', score: 30 })));
    mockSortedSets.set('filings:index:2026-03-17', [
      { score: 85, member: key1 },
      { score: 30, member: key2 },
    ]);

    const results = await getFilingsByDate('2026-03-17', { minScore: 50 });
    expect(results.length).toBe(1);
    expect(results[0].ticker).toBe('AAPL');
  });

  test('filters by tier', async () => {
    const key1 = 'filing:2026-03-17:AAPL:111';
    const key2 = 'filing:2026-03-17:MSFT:222';
    mockStore.set(key1, JSON.stringify(makeFiling({ ticker: 'AAPL', tier: 'top_pick', score: 85 })));
    mockStore.set(key2, JSON.stringify(makeFiling({ ticker: 'MSFT', tier: 'mention', score: 30 })));
    mockSortedSets.set('filings:index:2026-03-17', [
      { score: 85, member: key1 },
      { score: 30, member: key2 },
    ]);

    const results = await getFilingsByDate('2026-03-17', { tier: 'top_pick' });
    expect(results.length).toBe(1);
    expect(results[0].tier).toBe('top_pick');
  });

  test('returns empty array when no data', async () => {
    const results = await getFilingsByDate('2026-01-01');
    expect(results).toEqual([]);
  });
});

// ══════════════════════════════════════════
// getFilingsByTicker
// ══════════════════════════════════════════

describe('getFilingsByTicker', () => {
  test('returns filings for a ticker', async () => {
    const key = 'filing:2026-03-17:AAPL:123456';
    mockStore.set(key, JSON.stringify(makeFiling({ ticker: 'AAPL', score: 85 })));
    mockSortedSets.set('filings:ticker:AAPL', [
      { score: new Date('2026-03-17').getTime(), member: key },
    ]);

    const results = await getFilingsByTicker('AAPL');
    expect(results.length).toBe(1);
    expect(results[0].ticker).toBe('AAPL');
  });

  test('is case-insensitive on ticker', async () => {
    const key = 'filing:2026-03-17:AAPL:123456';
    mockStore.set(key, JSON.stringify(makeFiling({ ticker: 'AAPL' })));
    mockSortedSets.set('filings:ticker:AAPL', [
      { score: new Date('2026-03-17').getTime(), member: key },
    ]);

    const results = await getFilingsByTicker('aapl');
    expect(results.length).toBe(1);
  });

  test('returns empty array for unknown ticker', async () => {
    const results = await getFilingsByTicker('ZZZZ');
    expect(results).toEqual([]);
  });
});

// ══════════════════════════════════════════
// getDailySummaries
// ══════════════════════════════════════════

describe('getDailySummaries', () => {
  test('returns daily summaries', async () => {
    const summary = { date: '2026-03-17', totalFilings: 50, buyFilings: 30, sellFilings: 20 };
    mockStore.set('filings:daily:2026-03-17', JSON.stringify(summary));
    mockSortedSets.set('filings:daily:index', [
      { score: new Date('2026-03-17').getTime(), member: '2026-03-17' },
    ]);

    const results = await getDailySummaries(7);
    expect(results.length).toBe(1);
    expect(results[0].totalFilings).toBe(50);
  });

  test('returns empty array when no data', async () => {
    const results = await getDailySummaries(7);
    expect(results).toEqual([]);
  });
});

// ══════════════════════════════════════════
// getInsiderSentiment
// ══════════════════════════════════════════

describe('getInsiderSentiment', () => {
  test('calculates bullish sentiment correctly', async () => {
    const summaries = [
      { date: '2026-03-17', buyFilings: 40, sellFilings: 10, totalBuyValue: 5000000, totalSellValue: 500000 },
      { date: '2026-03-16', buyFilings: 35, sellFilings: 15, totalBuyValue: 4000000, totalSellValue: 800000 },
    ];

    // Seed Redis mocks
    for (const s of summaries) {
      mockStore.set(`filings:daily:${s.date}`, JSON.stringify(s));
    }
    mockSortedSets.set('filings:daily:index', summaries.map(s => ({
      score: new Date(s.date).getTime(),
      member: s.date,
    })));

    const result = await getInsiderSentiment(7);

    expect(result).not.toBeNull();
    expect(result.score).toBe(75); // 75 buys / 100 total = 75%
    expect(result.totalBuyFilings).toBe(75);
    expect(result.totalSellFilings).toBe(25);
    expect(result.totalBuyValue).toBe(9000000);
    expect(result.totalSellValue).toBe(1300000);
    expect(result.daysAnalyzed).toBe(2);
  });

  test('returns null when no data', async () => {
    const result = await getInsiderSentiment(7);
    expect(result).toBeNull();
  });

  test('detects increasing trend', async () => {
    const summaries = [
      { date: '2026-03-17', buyFilings: 50, sellFilings: 10, totalBuyValue: 0, totalSellValue: 0 },
      { date: '2026-03-16', buyFilings: 20, sellFilings: 30, totalBuyValue: 0, totalSellValue: 0 },
    ];

    for (const s of summaries) {
      mockStore.set(`filings:daily:${s.date}`, JSON.stringify(s));
    }
    mockSortedSets.set('filings:daily:index', summaries.map(s => ({
      score: new Date(s.date).getTime(),
      member: s.date,
    })));

    const result = await getInsiderSentiment(7);
    expect(result.trend).toBe('increasing');
  });
});
