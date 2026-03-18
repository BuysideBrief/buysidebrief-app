/**
 * Tests for lib/recently-featured.js
 */

const mockStore = new Map();

const mockRedis = {
  get: jest.fn(async (key) => mockStore.get(key) || null),
  set: jest.fn(async (key, value) => { mockStore.set(key, value); }),
};

jest.mock('@upstash/redis', () => ({
  Redis: {
    fromEnv: () => mockRedis,
  },
}));

const {
  getRecentHeadlineTickers,
  recordHeadlinePick,
  rotateHeadlinePick,
  COOLDOWN_DAYS,
} = require('../lib/recently-featured');

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
});

// Helper: make a filing
function makeFiling(ticker, score, tier = 'top_pick') {
  return {
    ticker,
    score,
    tier,
    issuerName: `${ticker} Inc.`,
    ownerName: 'Test Insider',
    officerTitle: 'CEO',
    signals: [],
    warnings: [],
    summary: { totalBuyValue: 1000000, totalSellValue: 0, buyCount: 1, sellCount: 0 },
  };
}

// Helper: date string for N days ago
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// ══════════════════════════════════════════
// Constants
// ══════════════════════════════════════════

describe('Constants', () => {
  test('cooldown is 3 days', () => {
    expect(COOLDOWN_DAYS).toBe(3);
  });
});

// ══════════════════════════════════════════
// getRecentHeadlineTickers
// ══════════════════════════════════════════

describe('getRecentHeadlineTickers', () => {
  test('returns empty set when no recent headlines', async () => {
    const result = await getRecentHeadlineTickers();
    expect(result.size).toBe(0);
  });

  test('returns tickers from last N days', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'AAPL');
    mockStore.set(`featured:headline:${daysAgo(2)}`, 'MSFT');

    const result = await getRecentHeadlineTickers(3);
    expect(result.size).toBe(2);
    expect(result.has('AAPL')).toBe(true);
    expect(result.has('MSFT')).toBe(true);
  });

  test('does not include today', async () => {
    const today = new Date().toISOString().split('T')[0];
    mockStore.set(`featured:headline:${today}`, 'AAPL');

    const result = await getRecentHeadlineTickers(3);
    expect(result.has('AAPL')).toBe(false);
  });

  test('does not include tickers older than cooldown', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'AAPL');
    mockStore.set(`featured:headline:${daysAgo(5)}`, 'OLD');

    const result = await getRecentHeadlineTickers(3);
    expect(result.has('AAPL')).toBe(true);
    expect(result.has('OLD')).toBe(false);
  });

  test('normalizes tickers to uppercase', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'aapl');

    const result = await getRecentHeadlineTickers(3);
    expect(result.has('AAPL')).toBe(true);
  });
});

// ══════════════════════════════════════════
// recordHeadlinePick
// ══════════════════════════════════════════

describe('recordHeadlinePick', () => {
  test('stores ticker in Redis', async () => {
    await recordHeadlinePick('AAPL', '2026-03-18');

    expect(mockRedis.set).toHaveBeenCalledWith('featured:headline:2026-03-18', 'AAPL');
  });

  test('defaults to today when no date provided', async () => {
    const today = new Date().toISOString().split('T')[0];
    await recordHeadlinePick('MSFT');

    expect(mockRedis.set).toHaveBeenCalledWith(`featured:headline:${today}`, 'MSFT');
  });

  test('uppercases the ticker', async () => {
    await recordHeadlinePick('aapl', '2026-03-18');

    expect(mockRedis.set).toHaveBeenCalledWith('featured:headline:2026-03-18', 'AAPL');
  });

  test('does nothing when ticker is empty', async () => {
    await recordHeadlinePick('', '2026-03-18');
    await recordHeadlinePick(null, '2026-03-18');

    expect(mockRedis.set).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════
// rotateHeadlinePick
// ══════════════════════════════════════════

describe('rotateHeadlinePick', () => {
  test('does not rotate when no recent headlines exist', async () => {
    const categorized = {
      topPicks: [makeFiling('AAPL', 85), makeFiling('MSFT', 75)],
      featured: [makeFiling('GOOG', 55)],
      mentions: [],
      notable_sells: [],
      totalProcessed: 3,
      totalFeatured: 3,
    };

    const result = await rotateHeadlinePick(categorized);
    expect(result.topPicks[0].ticker).toBe('AAPL');
  });

  test('rotates #1 pick when it was recently the headline', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'AAPL');

    const categorized = {
      topPicks: [makeFiling('AAPL', 85), makeFiling('MSFT', 75)],
      featured: [makeFiling('GOOG', 55)],
      mentions: [],
      notable_sells: [],
      totalProcessed: 3,
      totalFeatured: 3,
    };

    const result = await rotateHeadlinePick(categorized);
    expect(result.topPicks[0].ticker).toBe('MSFT');
    expect(result.topPicks[1].ticker).toBe('AAPL');
    expect(result.topPicks[1]._isRepeatHeadline).toBe(true);
  });

  test('promotes from featured when all top picks are repeats', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'AAPL');
    mockStore.set(`featured:headline:${daysAgo(2)}`, 'MSFT');

    const categorized = {
      topPicks: [makeFiling('AAPL', 85), makeFiling('MSFT', 75)],
      featured: [makeFiling('GOOG', 55), makeFiling('TSLA', 50)],
      mentions: [],
      notable_sells: [],
      totalProcessed: 4,
      totalFeatured: 4,
    };

    const result = await rotateHeadlinePick(categorized);
    // GOOG should be promoted to #1 top pick
    expect(result.topPicks[0].ticker).toBe('GOOG');
    // AAPL should be demoted to featured
    expect(result.featured[0].ticker).toBe('AAPL');
    expect(result.featured[0]._isRepeatHeadline).toBe(true);
  });

  test('leaves repeat in place when EVERYTHING is a repeat', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'AAPL');
    mockStore.set(`featured:headline:${daysAgo(2)}`, 'MSFT');
    mockStore.set(`featured:headline:${daysAgo(3)}`, 'GOOG');

    const categorized = {
      topPicks: [makeFiling('AAPL', 85)],
      featured: [makeFiling('MSFT', 55), makeFiling('GOOG', 50)],
      mentions: [],
      notable_sells: [],
      totalProcessed: 3,
      totalFeatured: 3,
    };

    const result = await rotateHeadlinePick(categorized);
    // AAPL stays #1 because there's nothing fresh to promote
    expect(result.topPicks[0].ticker).toBe('AAPL');
    expect(result.topPicks[0]._isRepeatHeadline).toBe(true);
  });

  test('does not rotate when #1 pick is fresh', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'TSLA');

    const categorized = {
      topPicks: [makeFiling('AAPL', 85), makeFiling('MSFT', 75)],
      featured: [],
      mentions: [],
      notable_sells: [],
      totalProcessed: 2,
      totalFeatured: 2,
    };

    const result = await rotateHeadlinePick(categorized);
    expect(result.topPicks[0].ticker).toBe('AAPL');
    expect(result.topPicks[0]._isRepeatHeadline).toBeUndefined();
  });

  test('handles empty top picks gracefully', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'AAPL');

    const categorized = {
      topPicks: [],
      featured: [makeFiling('GOOG', 55)],
      mentions: [],
      notable_sells: [],
      totalProcessed: 1,
      totalFeatured: 1,
    };

    const result = await rotateHeadlinePick(categorized);
    expect(result.topPicks.length).toBe(0);
    expect(result.featured[0].ticker).toBe('GOOG');
  });

  test('ticker matching is case-insensitive', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'aapl');

    const categorized = {
      topPicks: [makeFiling('AAPL', 85), makeFiling('MSFT', 75)],
      featured: [],
      mentions: [],
      notable_sells: [],
      totalProcessed: 2,
      totalFeatured: 2,
    };

    const result = await rotateHeadlinePick(categorized);
    expect(result.topPicks[0].ticker).toBe('MSFT');
  });

  test('ticker can return as #1 after cooldown expires', async () => {
    // AAPL was #1 four days ago — outside the 3-day cooldown
    mockStore.set(`featured:headline:${daysAgo(4)}`, 'AAPL');

    const categorized = {
      topPicks: [makeFiling('AAPL', 85)],
      featured: [],
      mentions: [],
      notable_sells: [],
      totalProcessed: 1,
      totalFeatured: 1,
    };

    const result = await rotateHeadlinePick(categorized);
    expect(result.topPicks[0].ticker).toBe('AAPL');
    expect(result.topPicks[0]._isRepeatHeadline).toBeUndefined();
  });

  test('adds repeat note to demoted pick', async () => {
    mockStore.set(`featured:headline:${daysAgo(1)}`, 'AAPL');

    const categorized = {
      topPicks: [makeFiling('AAPL', 85), makeFiling('MSFT', 75)],
      featured: [],
      mentions: [],
      notable_sells: [],
      totalProcessed: 2,
      totalFeatured: 2,
    };

    const result = await rotateHeadlinePick(categorized);
    const repeat = result.topPicks.find(f => f.ticker === 'AAPL');
    expect(repeat._repeatNote).toContain('Still our top-scored signal');
    expect(repeat._repeatNote).toContain('$AAPL');
  });
});
