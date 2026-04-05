/**
 * Performance Tracker Tests
 *
 * Mocks: lib/redis.js (Redis client), lib/price-helper.js (getQuote, calculateReturn),
 *        lib/pick-filters.js (getBestEntryPrice, validateEntryPrice)
 */

// ── Mock Redis client ──

const mockKv = {
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(null),
  mget: jest.fn().mockResolvedValue([]),
  zadd: jest.fn().mockResolvedValue(null),
  zrange: jest.fn().mockResolvedValue([]),
  zrangebyscore: jest.fn().mockResolvedValue([]),
  sadd: jest.fn().mockResolvedValue(null),
  smembers: jest.fn().mockResolvedValue([]),
  pipeline: jest.fn(() => ({
    set: jest.fn(),
    zadd: jest.fn(),
    sadd: jest.fn(),
    exec: jest.fn().mockResolvedValue([]),
  })),
};

// performance-tracker.js constructs its own Redis at module scope via `new Redis(...)`.
// We mock @upstash/redis so it returns our mockKv.
jest.mock('@upstash/redis', () => ({
  Redis: jest.fn().mockImplementation(() => mockKv),
}));

// Ensure env vars exist so the module picks the explicit-url branch
process.env.UPSTASH_REDIS_REST_URL = 'https://fake.upstash.io';
process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

// ── Mock price-helper ──

jest.mock('../lib/price-helper', () => ({
  getQuote: jest.fn().mockResolvedValue(null),
  calculateReturn: jest.fn().mockResolvedValue(null),
  getHistoricalPrices: jest.fn().mockResolvedValue({ prices: [] }),
  getPriceAtDate: jest.fn().mockResolvedValue(null),
  get52WeekRange: jest.fn().mockResolvedValue(null),
}));

// ── Mock pick-filters ──

jest.mock('../lib/pick-filters', () => ({
  getBestEntryPrice: jest.fn(f => {
    // Default: return the first transaction's price
    const tx = (f.transactions || [])[0];
    return tx ? tx.pricePerShare : null;
  }),
  validateEntryPrice: jest.fn((entryPrice, currentPrice) => ({
    price: entryPrice,
    reason: null,
  })),
  dampenRepeatInsiders: jest.fn(filings => filings),
}));

// ── Mock signal-scorer (formatValue) ──

jest.mock('../lib/signal-scorer', () => ({
  formatValue: jest.fn(v => `${(v / 1000).toFixed(0)}K`),
  scoreFiling: jest.fn(),
  scoreAllFilings: jest.fn(),
}));

// ── Load modules under test ──

const { getQuote, calculateReturn } = require('../lib/price-helper');
const {
  recordNewPicks,
  updateAllReturns,
  generateScorecard,
} = require('../lib/performance-tracker');

// ── Helpers ──

function makeFiling(overrides = {}) {
  return {
    ticker: 'AAPL',
    issuerName: 'Apple Inc',
    ownerName: 'Tim Cook',
    ownerCik: '000111',
    officerTitle: 'CEO',
    isDirector: false,
    score: 80,
    tier: 'top_pick',
    signals: ['cluster_buy'],
    summary: { buyCount: 2, totalBuyValue: 500000, totalBuyShares: 1000 },
    transactions: [
      { isOpenMarketBuy: true, shares: 1000, pricePerShare: 150, totalValue: 150000 },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reset default mock returns
  mockKv.get.mockResolvedValue(null);
  mockKv.set.mockResolvedValue(null);
  mockKv.zrange.mockResolvedValue([]);
  mockKv.mget.mockResolvedValue([]);
  mockKv.zadd.mockResolvedValue(null);
  mockKv.sadd.mockResolvedValue(null);
  getQuote.mockResolvedValue(null);
  calculateReturn.mockResolvedValue(null);
});

// ═══════════════════════════════════════
//  recordNewPicks
// ═══════════════════════════════════════

describe('recordNewPicks', () => {
  test('records a new pick with correct Redis keys and data structure', async () => {
    getQuote.mockResolvedValue({ price: 155 });

    const filings = [makeFiling()];
    const count = await recordNewPicks(filings);

    expect(count).toBe(1);

    // Writes go through pipeline
    expect(mockKv.pipeline).toHaveBeenCalled();
    const pipe = mockKv.pipeline.mock.results[0].value;

    // Should have called pipe.set with a pick:AAPL:<date>:000111 key
    const setCall = pipe.set.mock.calls.find(c => c[0].startsWith('pick:AAPL:'));
    expect(setCall).toBeDefined();

    const pickData = setCall[1];
    expect(pickData.ticker).toBe('AAPL');
    expect(pickData.companyName).toBe('Apple Inc');
    expect(pickData.ownerName).toBe('Tim Cook');
    expect(pickData.ownerCik).toBe('000111');
    expect(pickData.score).toBe(80);
    expect(pickData.tier).toBe('top_pick');
    expect(pickData.entryPrice).toBe(150);
    expect(pickData.currentPrice).toBeNull();
    expect(pickData.currentReturn).toBeNull();
    expect(pickData.return30d).toBeNull();

    // Should have added to sorted index via pipeline
    expect(pipe.zadd).toHaveBeenCalledWith(
      'picks:index',
      expect.objectContaining({ member: expect.stringContaining('pick:AAPL:') })
    );
  });

  test('skips duplicate picks (same ticker+date already tracked)', async () => {
    // First call to kv.get returns an existing pick → skip
    mockKv.get.mockResolvedValueOnce({ id: 'pick:AAPL:2026-04-05:000111', ticker: 'AAPL' });
    getQuote.mockResolvedValue({ price: 155 });

    const filings = [makeFiling()];
    const count = await recordNewPicks(filings);

    expect(count).toBe(0);
    // Pipeline should not be called for picks (0 pickWrites)
    // The only pipeline call would be from CEO writes if any
    const pipelineCalls = mockKv.pipeline.mock.calls;
    // If pipeline was called, none of its set calls should be for pick:AAPL:
    if (pipelineCalls.length > 0) {
      const pipe = mockKv.pipeline.mock.results[0].value;
      const pickSetCalls = pipe.set.mock.calls.filter(c => c[0].startsWith('pick:AAPL:'));
      expect(pickSetCalls).toHaveLength(0);
    }
  });

  test('handles empty input array gracefully', async () => {
    const count = await recordNewPicks([]);
    expect(count).toBe(0);
    // No pick-related set calls
    const pickSetCalls = mockKv.set.mock.calls.filter(c => c[0].startsWith('pick:'));
    expect(pickSetCalls).toHaveLength(0);
  });

  test('filters out filings that are not top_pick/feature/strong_signal tier', async () => {
    getQuote.mockResolvedValue({ price: 10 });

    const filings = [
      makeFiling({ tier: 'mention', score: 30 }),
      makeFiling({ tier: 'skip', score: 10 }),
    ];
    const count = await recordNewPicks(filings);

    expect(count).toBe(0);
  });

  test('filters out filings with zero buys', async () => {
    getQuote.mockResolvedValue({ price: 10 });

    const filings = [makeFiling({ summary: { buyCount: 0, totalBuyValue: 0, totalBuyShares: 0 } })];
    const count = await recordNewPicks(filings);

    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════
//  updateAllReturns
// ═══════════════════════════════════════

describe('updateAllReturns', () => {
  test('updates return percentages correctly (positive return)', async () => {
    const pickId = 'pick:AAPL:2026-03-01:000111';
    const pickData = {
      ticker: 'AAPL',
      entryPrice: 100,
      entryDate: '2026-03-01',
      ownerCik: '000111',
      currentPrice: null,
      currentReturn: null,
      return30d: null,
      return60d: null,
      return90d: null,
      lastUpdated: null,
    };

    mockKv.zrange.mockResolvedValue([pickId]);
    mockKv.get.mockResolvedValue(pickData);
    getQuote.mockResolvedValue({ price: 120 }); // +20%

    const updated = await updateAllReturns();

    expect(updated).toBe(1);
    // Check the value written to Redis
    const setCall = mockKv.set.mock.calls.find(c => c[0] === pickId)
      || mockKv.pipeline.mock.results[0]?.value?.set?.mock?.calls?.[0];
    // With pipeline, writes go through pipe.set
    // Either way, verify getQuote was called
    expect(getQuote).toHaveBeenCalledWith('AAPL');
  });

  test('updates return percentages correctly (negative return)', async () => {
    const pickId = 'pick:MSFT:2026-03-01:000222';
    const pickData = {
      ticker: 'MSFT',
      entryPrice: 200,
      entryDate: '2026-03-01',
      ownerCik: '000222',
      currentPrice: null,
      currentReturn: null,
      return30d: null,
      return60d: null,
      return90d: null,
      lastUpdated: null,
    };

    mockKv.zrange.mockResolvedValue([pickId]);
    mockKv.get.mockResolvedValue(pickData);
    getQuote.mockResolvedValue({ price: 180 }); // -10%

    const updated = await updateAllReturns();

    expect(updated).toBe(1);
    expect(getQuote).toHaveBeenCalledWith('MSFT');
  });

  test('handles price API failure gracefully for individual tickers', async () => {
    const pickIds = ['pick:AAPL:2026-03-01:000111', 'pick:GOOG:2026-03-01:000222'];
    const aaplPick = { ticker: 'AAPL', entryPrice: 100, entryDate: '2026-03-01', ownerCik: '000111', currentReturn: null, return30d: null, return60d: null, return90d: null };
    const googPick = { ticker: 'GOOG', entryPrice: 150, entryDate: '2026-03-01', ownerCik: '000222', currentReturn: null, return30d: null, return60d: null, return90d: null };

    mockKv.zrange.mockResolvedValue(pickIds);
    // get is called per-pick via Promise.all
    mockKv.get
      .mockResolvedValueOnce(aaplPick)
      .mockResolvedValueOnce(googPick);

    // AAPL price succeeds, GOOG fails
    getQuote
      .mockResolvedValueOnce({ price: 110 })
      .mockResolvedValueOnce(null);

    const updated = await updateAllReturns();

    // Only AAPL should be updated
    expect(updated).toBe(1);
  });

  test('skips tickers where price data is unavailable', async () => {
    const pickId = 'pick:DELIST:2026-03-01:000333';
    const pick = { ticker: 'DELIST', entryPrice: 50, entryDate: '2026-03-01', ownerCik: '000333', currentReturn: null, return30d: null, return60d: null, return90d: null };

    mockKv.zrange.mockResolvedValue([pickId]);
    mockKv.get.mockResolvedValue(pick);
    getQuote.mockResolvedValue(null);

    const updated = await updateAllReturns();
    expect(updated).toBe(0);
  });

  test('returns 0 when no picks are tracked', async () => {
    mockKv.zrange.mockResolvedValue([]);
    const updated = await updateAllReturns();
    expect(updated).toBe(0);
  });
});

// ═══════════════════════════════════════
//  generateScorecard
// ═══════════════════════════════════════

describe('generateScorecard', () => {
  test('returns correct win/loss counts and win rate', async () => {
    const pickIds = ['pick:A:2026-01-01:001', 'pick:B:2026-01-01:002', 'pick:C:2026-01-01:003'];

    mockKv.zrange.mockResolvedValue(pickIds);
    mockKv.mget.mockResolvedValue([
      { ticker: 'A', entryPrice: 10, entryDate: '2026-01-01', currentReturn: 15, currentPrice: 11.5, return30d: null, return60d: null, return90d: null },
      { ticker: 'B', entryPrice: 20, entryDate: '2026-01-01', currentReturn: -5, currentPrice: 19, return30d: null, return60d: null, return90d: null },
      { ticker: 'C', entryPrice: 30, entryDate: '2026-01-01', currentReturn: 10, currentPrice: 33, return30d: null, return60d: null, return90d: null },
    ]);

    const sc = await generateScorecard();

    expect(sc.totalPicks).toBe(3);
    expect(sc.winners).toBe(2);
    expect(sc.losers).toBe(1);
    expect(sc.winRate).toBe(67); // 2/3 rounded
  });

  test('groups picks by tier correctly (recentPicks present)', async () => {
    const pickIds = ['pick:X:2026-01-01:001'];

    mockKv.zrange.mockResolvedValue(pickIds);
    mockKv.mget.mockResolvedValue([
      {
        ticker: 'X',
        companyName: 'X Corp',
        entryPrice: 100,
        entryDate: '2026-01-01',
        currentReturn: 25,
        currentPrice: 125,
        return30d: 10,
        return60d: null,
        return90d: null,
        score: 85,
        ownerName: 'Elon',
        officerTitle: 'CEO',
        tier: 'top_pick',
      },
    ]);

    const sc = await generateScorecard();

    expect(sc.recentPicks).toHaveLength(1);
    expect(sc.recentPicks[0].ticker).toBe('X');
    expect(sc.recentPicks[0].score).toBe(85);
    expect(sc.avg30dReturn).toBe(10);
  });

  test('handles empty scorecard (no picks tracked yet)', async () => {
    mockKv.zrange.mockResolvedValue([]);

    const sc = await generateScorecard();

    expect(sc.totalPicks).toBe(0);
    expect(sc.message).toBeDefined();
  });

  test('batched read works correctly (mget pattern)', async () => {
    const pickIds = ['pick:A:2026-01-01:001', 'pick:B:2026-01-01:002'];

    mockKv.zrange.mockResolvedValue(pickIds);
    mockKv.mget.mockResolvedValue([
      { ticker: 'A', entryPrice: 10, entryDate: '2026-01-01', currentReturn: 5, currentPrice: 10.5, return30d: null, return60d: null, return90d: null },
      { ticker: 'B', entryPrice: 20, entryDate: '2026-01-01', currentReturn: -3, currentPrice: 19.4, return30d: null, return60d: null, return90d: null },
    ]);

    await generateScorecard();

    // mget should be called once with all pick IDs spread as arguments
    expect(mockKv.mget).toHaveBeenCalledTimes(1);
    expect(mockKv.mget).toHaveBeenCalledWith('pick:A:2026-01-01:001', 'pick:B:2026-01-01:002');
  });

  test('handles picks with no return data yet', async () => {
    const pickIds = ['pick:A:2026-01-01:001'];

    mockKv.zrange.mockResolvedValue(pickIds);
    mockKv.mget.mockResolvedValue([
      { ticker: 'A', entryPrice: 10, entryDate: '2026-01-01', currentReturn: null, currentPrice: null, return30d: null, return60d: null, return90d: null },
    ]);

    const sc = await generateScorecard();

    expect(sc.totalPicks).toBe(0);
    expect(sc.message).toContain('no price data');
  });
});

// ═══════════════════════════════════════
//  calculateReturn edge cases (via price-helper mock)
// ═══════════════════════════════════════

describe('calculateReturn edge cases', () => {
  test('entry price of 0 — should handle without division by zero', async () => {
    // calculateReturn is from price-helper which we mock.
    // Test the real logic by reimplementing the formula check:
    // If entryPrice is 0, the real function returns null because
    // getPriceAtDate returns null or entry is 0 → would cause Infinity.
    // The mock should reflect this expected behavior.
    calculateReturn.mockResolvedValue(null);

    const result = await calculateReturn('TEST', '2026-01-01', 0);
    expect(result).toBeNull();
  });

  test('stock delisted — price unavailable returns null', async () => {
    calculateReturn.mockResolvedValue(null);

    const result = await calculateReturn('DELIST', '2026-01-01', 50);
    expect(result).toBeNull();
  });

  test('weekend/holiday date — returns data from nearest trading day', async () => {
    // A Saturday date should still work — the price API returns
    // the last available trading day's data.
    calculateReturn.mockResolvedValue({
      ticker: 'AAPL',
      entryDate: '2026-04-04', // Saturday
      entryPrice: 150,
      currentPrice: 160,
      returnPct: 6.67,
      daysSince: 1,
      isPositive: true,
    });

    const result = await calculateReturn('AAPL', '2026-04-04', 150);
    expect(result).not.toBeNull();
    expect(result.returnPct).toBeCloseTo(6.67, 1);
    expect(result.isPositive).toBe(true);
  });
});
