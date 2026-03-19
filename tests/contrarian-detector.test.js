/**
 * Tests for lib/contrarian-detector.js
 */

const mockFetchResponses = [];

global.fetch = jest.fn(async (url) => {
  const response = mockFetchResponses.shift();
  if (response) return response;
  return { ok: false, status: 404 };
});

process.env.FINNHUB_API_KEY = 'test_key';

const {
  getDrawdownData,
  analyzeContrarianSignal,
  batchAnalyzeContrarian,
  CONTRARIAN_TIERS,
} = require('../lib/contrarian-detector');

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchResponses.length = 0;
});

// Helper: mock quote + metrics responses
function mockQuoteAndMetrics(price, high52w) {
  mockFetchResponses.push({
    ok: true,
    json: async () => ({ c: price, d: 0, dp: 0, h: price, l: price, o: price, pc: price }),
  });
  mockFetchResponses.push({
    ok: true,
    json: async () => ({ metric: { '52WeekHigh': high52w } }),
  });
}

function makeFiling(ticker, opts = {}) {
  return {
    ticker,
    score: opts.score || 50,
    tier: opts.tier || 'feature',
    summary: { buyCount: opts.buyCount ?? 1, sellCount: 0, totalBuyValue: opts.buyValue || 100000 },
    ...opts,
  };
}

// ══════════════════════════════════════════
// Constants
// ══════════════════════════════════════════

describe('CONTRARIAN_TIERS', () => {
  test('has 3 tiers in descending order', () => {
    expect(CONTRARIAN_TIERS.length).toBe(3);
    expect(CONTRARIAN_TIERS[0].minDrawdown).toBe(0.50);
    expect(CONTRARIAN_TIERS[1].minDrawdown).toBe(0.30);
    expect(CONTRARIAN_TIERS[2].minDrawdown).toBe(0.20);
  });

  test('boosts increase with drawdown severity', () => {
    expect(CONTRARIAN_TIERS[0].boost).toBeGreaterThan(CONTRARIAN_TIERS[1].boost);
    expect(CONTRARIAN_TIERS[1].boost).toBeGreaterThan(CONTRARIAN_TIERS[2].boost);
  });
});

// ══════════════════════════════════════════
// getDrawdownData
// ══════════════════════════════════════════

describe('getDrawdownData', () => {
  test('calculates drawdown correctly', async () => {
    mockQuoteAndMetrics(70, 100); // 30% down from high

    const result = await getDrawdownData('ACME');
    expect(result).not.toBeNull();
    expect(result.price).toBe(70);
    expect(result.high52w).toBe(100);
    expect(result.drawdown).toBeCloseTo(0.30);
    expect(result.drawdownPct).toBe(30);
  });

  test('returns null when no API key', async () => {
    const orig = process.env.FINNHUB_API_KEY;
    process.env.FINNHUB_API_KEY = '';

    jest.resetModules();
    const mod = require('../lib/contrarian-detector');
    const result = await mod.getDrawdownData('ACME');
    expect(result).toBeNull();

    process.env.FINNHUB_API_KEY = orig;
  });

  test('returns null when ticker is empty', async () => {
    const result = await getDrawdownData('');
    expect(result).toBeNull();
  });

  test('returns null when quote fails', async () => {
    mockFetchResponses.push({ ok: false, status: 500 });

    const result = await getDrawdownData('ACME');
    expect(result).toBeNull();
  });

  test('returns null when price is 0', async () => {
    mockFetchResponses.push({
      ok: true,
      json: async () => ({ c: 0 }),
    });

    const result = await getDrawdownData('ACME');
    expect(result).toBeNull();
  });

  test('returns null when metrics fail', async () => {
    mockFetchResponses.push({
      ok: true,
      json: async () => ({ c: 50 }),
    });
    mockFetchResponses.push({ ok: false, status: 500 });

    const result = await getDrawdownData('ACME');
    expect(result).toBeNull();
  });

  test('returns null when 52-week high is missing', async () => {
    mockFetchResponses.push({
      ok: true,
      json: async () => ({ c: 50 }),
    });
    mockFetchResponses.push({
      ok: true,
      json: async () => ({ metric: {} }),
    });

    const result = await getDrawdownData('ACME');
    expect(result).toBeNull();
  });

  test('handles stock at its high (0% drawdown)', async () => {
    mockQuoteAndMetrics(100, 100);

    const result = await getDrawdownData('ACME');
    expect(result.drawdown).toBe(0);
    expect(result.drawdownPct).toBe(0);
  });
});

// ══════════════════════════════════════════
// analyzeContrarianSignal
// ══════════════════════════════════════════

describe('analyzeContrarianSignal', () => {
  test('detects contrarian buy at -25% (tier 3)', async () => {
    mockQuoteAndMetrics(75, 100);

    const result = await analyzeContrarianSignal('ACME');
    expect(result).not.toBeNull();
    expect(result.signal).toBe('contrarian_buy');
    expect(result.boost).toBe(10);
    expect(result.tag).toBe('CONTRARIAN BUY');
    expect(result.drawdownPct).toBe(25);
    expect(result.context).toContain('25%');
    expect(result.context).toContain('52-week high');
  });

  test('detects deep contrarian at -40% (tier 2)', async () => {
    mockQuoteAndMetrics(60, 100);

    const result = await analyzeContrarianSignal('ACME');
    expect(result.boost).toBe(15);
    expect(result.tag).toBe('DEEP CONTRARIAN');
    expect(result.drawdownPct).toBe(40);
  });

  test('detects extreme contrarian at -60% (tier 1)', async () => {
    mockQuoteAndMetrics(40, 100);

    const result = await analyzeContrarianSignal('ACME');
    expect(result.boost).toBe(20);
    expect(result.tag).toBe('EXTREME CONTRARIAN');
    expect(result.drawdownPct).toBe(60);
  });

  test('returns null when drawdown is under 20%', async () => {
    mockQuoteAndMetrics(85, 100); // only 15% down

    const result = await analyzeContrarianSignal('ACME');
    expect(result).toBeNull();
  });

  test('returns null when stock is at its high', async () => {
    mockQuoteAndMetrics(100, 100);

    const result = await analyzeContrarianSignal('ACME');
    expect(result).toBeNull();
  });

  test('exact boundary: 20% drawdown triggers', async () => {
    mockQuoteAndMetrics(80, 100);

    const result = await analyzeContrarianSignal('ACME');
    expect(result).not.toBeNull();
    expect(result.boost).toBe(10);
  });

  test('exact boundary: 30% drawdown triggers deep', async () => {
    mockQuoteAndMetrics(70, 100);

    const result = await analyzeContrarianSignal('ACME');
    expect(result.boost).toBe(15);
    expect(result.tag).toBe('DEEP CONTRARIAN');
  });

  test('exact boundary: 50% drawdown triggers extreme', async () => {
    mockQuoteAndMetrics(50, 100);

    const result = await analyzeContrarianSignal('ACME');
    expect(result.boost).toBe(20);
    expect(result.tag).toBe('EXTREME CONTRARIAN');
  });

  test('context includes dollar amounts', async () => {
    mockQuoteAndMetrics(65.50, 108.75);

    const result = await analyzeContrarianSignal('ACME');
    expect(result.context).toContain('$108.75');
    expect(result.context).toContain('$ACME');
  });

  test('returns null on API failure', async () => {
    mockFetchResponses.push({ ok: false });

    const result = await analyzeContrarianSignal('ACME');
    expect(result).toBeNull();
  });
});

// ══════════════════════════════════════════
// batchAnalyzeContrarian
// ══════════════════════════════════════════

describe('batchAnalyzeContrarian', () => {
  test('processes multiple tickers', async () => {
    // AAPL: 25% down
    mockQuoteAndMetrics(75, 100);
    // MSFT: 10% down (no signal)
    mockQuoteAndMetrics(90, 100);

    const filings = [
      makeFiling('AAPL'),
      makeFiling('MSFT'),
    ];

    const results = await batchAnalyzeContrarian(filings);
    expect(results.size).toBe(1);
    expect(results.has('AAPL')).toBe(true);
    expect(results.has('MSFT')).toBe(false);
  });

  test('skips filings with no buys', async () => {
    const filings = [
      makeFiling('AAPL', { buyCount: 0 }),
      makeFiling('MSFT', { buyCount: 1 }),
    ];

    // Only MSFT should be checked (1 ticker × 2 calls)
    mockQuoteAndMetrics(70, 100);

    const results = await batchAnalyzeContrarian(filings);
    expect(results.size).toBe(1);
    expect(results.has('MSFT')).toBe(true);
    // Only 2 fetch calls (quote + metrics for MSFT)
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('deduplicates tickers', async () => {
    mockQuoteAndMetrics(70, 100);

    const filings = [
      makeFiling('AAPL'),
      makeFiling('AAPL'), // duplicate
    ];

    const results = await batchAnalyzeContrarian(filings);
    // Only 2 fetch calls (one ticker)
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('caps at 15 tickers', async () => {
    const filings = Array.from({ length: 20 }, (_, i) => makeFiling(`TICK${i}`));

    // Mock all as no-signal to keep it simple
    for (let i = 0; i < 30; i++) {
      mockFetchResponses.push({
        ok: true,
        json: async () => ({ c: 95 }),
      });
      mockFetchResponses.push({
        ok: true,
        json: async () => ({ metric: { '52WeekHigh': 100 } }),
      });
    }

    await batchAnalyzeContrarian(filings);
    // 15 tickers × 2 calls = 30 max
    expect(global.fetch.mock.calls.length).toBeLessThanOrEqual(30);
  }, 15000);

  test('returns empty map when no API key', async () => {
    const orig = process.env.FINNHUB_API_KEY;
    process.env.FINNHUB_API_KEY = '';

    jest.resetModules();
    const mod = require('../lib/contrarian-detector');
    const results = await mod.batchAnalyzeContrarian([makeFiling('AAPL')]);
    expect(results.size).toBe(0);

    process.env.FINNHUB_API_KEY = orig;
  });

  test('skips filings with no ticker', async () => {
    const filings = [
      makeFiling(null, { buyCount: 1 }),
      makeFiling('', { buyCount: 1 }),
    ];

    const results = await batchAnalyzeContrarian(filings);
    expect(results.size).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
