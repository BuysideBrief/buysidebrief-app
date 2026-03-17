/**
 * Tests for lib/earnings-helper.js
 * 
 * Tests the earnings calendar cross-reference feature:
 * - Post-earnings buy detection (after beat, miss, or neutral)
 * - Blackout period flagging
 * - Pre-earnings caution
 * - Edge cases (no data, no API key, etc.)
 */

// Mock fetch globally before requiring the module
const mockFetchResponses = new Map();

global.fetch = jest.fn(async (url) => {
  // Find a matching mock based on URL patterns
  for (const [pattern, response] of mockFetchResponses) {
    if (url.includes(pattern)) {
      return response;
    }
  }
  // Default: return empty earnings
  return {
    ok: true,
    json: async () => ({ earningsCalendar: [] }),
  };
});

// Set API key for tests
process.env.FINNHUB_API_KEY = 'test_key';

const {
  getUpcomingEarnings,
  getRecentEarnings,
  analyzeEarningsContext,
  batchAnalyzeEarnings,
  BLACKOUT_DAYS_BEFORE,
  BLACKOUT_DAYS_AFTER,
  POST_EARNINGS_WINDOW_DAYS,
} = require('../lib/earnings-helper');

beforeEach(() => {
  jest.clearAllMocks();
  mockFetchResponses.clear();
});

// ══════════════════════════════════════════
// getUpcomingEarnings
// ══════════════════════════════════════════

describe('getUpcomingEarnings', () => {
  test('returns upcoming earnings data for a ticker', async () => {
    mockFetchResponses.set('calendar/earnings', {
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            date: '2026-04-15',
            epsEstimate: 1.25,
            epsActual: null,
            revenueEstimate: 5000000000,
            revenueActual: null,
            hour: 'amc',
            symbol: 'AAPL',
          },
        ],
      }),
    });

    const result = await getUpcomingEarnings('AAPL');
    expect(result).not.toBeNull();
    expect(result.date).toBe('2026-04-15');
    expect(result.epsEstimate).toBe(1.25);
    expect(result.hour).toBe('amc');
    expect(result.symbol).toBe('AAPL');
  });

  test('returns nearest earnings when multiple exist', async () => {
    mockFetchResponses.set('calendar/earnings', {
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { date: '2026-07-20', epsEstimate: 1.50, symbol: 'AAPL' },
          { date: '2026-04-15', epsEstimate: 1.25, symbol: 'AAPL' },
        ],
      }),
    });

    const result = await getUpcomingEarnings('AAPL');
    expect(result.date).toBe('2026-04-15');
  });

  test('returns null when no earnings found', async () => {
    mockFetchResponses.set('calendar/earnings', {
      ok: true,
      json: async () => ({ earningsCalendar: [] }),
    });

    const result = await getUpcomingEarnings('AAPL');
    expect(result).toBeNull();
  });

  test('returns null when API key is missing', async () => {
    const origKey = process.env.FINNHUB_API_KEY;
    process.env.FINNHUB_API_KEY = '';

    // Re-require to pick up empty key
    jest.resetModules();
    const mod = require('../lib/earnings-helper');
    const result = await mod.getUpcomingEarnings('AAPL');
    expect(result).toBeNull();

    process.env.FINNHUB_API_KEY = origKey;
  });

  test('returns null when ticker is empty', async () => {
    const result = await getUpcomingEarnings('');
    expect(result).toBeNull();
  });

  test('handles API errors gracefully', async () => {
    mockFetchResponses.set('calendar/earnings', {
      ok: false,
      status: 500,
    });

    const result = await getUpcomingEarnings('AAPL');
    expect(result).toBeNull();
  });
});

// ══════════════════════════════════════════
// getRecentEarnings
// ══════════════════════════════════════════

describe('getRecentEarnings', () => {
  test('returns recent earnings with beat surprise', async () => {
    mockFetchResponses.set('calendar/earnings', {
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            date: '2026-03-01',
            epsEstimate: 1.00,
            epsActual: 1.20,
            revenueEstimate: 5000000000,
            revenueActual: 5200000000,
            symbol: 'MSFT',
          },
        ],
      }),
    });

    const result = await getRecentEarnings('MSFT');
    expect(result).not.toBeNull();
    expect(result.date).toBe('2026-03-01');
    expect(result.beat).toBe(true);
    expect(result.miss).toBe(false);
    expect(result.surprise).toBe(20); // (1.20 - 1.00) / 1.00 * 100
  });

  test('returns recent earnings with miss surprise', async () => {
    mockFetchResponses.set('calendar/earnings', {
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            date: '2026-03-01',
            epsEstimate: 2.00,
            epsActual: 1.50,
            symbol: 'META',
          },
        ],
      }),
    });

    const result = await getRecentEarnings('META');
    expect(result.beat).toBe(false);
    expect(result.miss).toBe(true);
    expect(result.surprise).toBe(-25); // (1.50 - 2.00) / 2.00 * 100
  });

  test('handles null estimates gracefully (no surprise calc)', async () => {
    mockFetchResponses.set('calendar/earnings', {
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            date: '2026-03-01',
            epsEstimate: null,
            epsActual: 1.50,
            symbol: 'XYZ',
          },
        ],
      }),
    });

    const result = await getRecentEarnings('XYZ');
    expect(result.surprise).toBeNull();
    expect(result.beat).toBeNull();
    expect(result.miss).toBeNull();
  });

  test('handles zero estimate (avoids division by zero)', async () => {
    mockFetchResponses.set('calendar/earnings', {
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            date: '2026-03-01',
            epsEstimate: 0,
            epsActual: 0.10,
            symbol: 'XYZ',
          },
        ],
      }),
    });

    const result = await getRecentEarnings('XYZ');
    expect(result.surprise).toBeNull();
  });

  test('picks most recent past earnings, not future', async () => {
    const today = new Date();
    const pastDate = new Date(today.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const futureDate = new Date(today.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    mockFetchResponses.set('calendar/earnings', {
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { date: futureDate, epsEstimate: 2.00, epsActual: null, symbol: 'TEST' },
          { date: pastDate, epsEstimate: 1.50, epsActual: 1.60, symbol: 'TEST' },
        ],
      }),
    });

    const result = await getRecentEarnings('TEST');
    expect(result.date).toBe(pastDate);
  });
});

// ══════════════════════════════════════════
// analyzeEarningsContext
// ══════════════════════════════════════════

describe('analyzeEarningsContext', () => {

  // ── Post-earnings buy signals ──

  test('detects post-earnings buy after a MISS (+20 boost)', async () => {
    const earningsDate = '2026-03-01';
    const tradeDate = '2026-03-10'; // 9 days after earnings

    // Mock: recent earnings returns a miss
    global.fetch = jest.fn(async (url) => {
      if (url.includes('calendar/earnings')) {
        return {
          ok: true,
          json: async () => ({
            earningsCalendar: [
              {
                date: earningsDate,
                epsEstimate: 2.00,
                epsActual: 1.50,
                symbol: 'ACME',
              },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ earningsCalendar: [] }) };
    });

    const result = await analyzeEarningsContext('ACME', tradeDate);
    expect(result.signal).toBe('post_earnings_buy');
    expect(result.scoreAdjustment).toBe(20);
    expect(result.daysSinceEarnings).toBe(9);
    expect(result.context).toContain('missed estimates');
    expect(result.context).toContain('25%');
  });

  test('detects post-earnings buy after a BEAT (+10 boost)', async () => {
    const earningsDate = '2026-03-01';
    const tradeDate = '2026-03-05'; // 4 days after earnings

    global.fetch = jest.fn(async (url) => ({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            date: earningsDate,
            epsEstimate: 1.00,
            epsActual: 1.30,
            symbol: 'ACME',
          },
        ],
      }),
    }));

    const result = await analyzeEarningsContext('ACME', tradeDate);
    expect(result.signal).toBe('post_earnings_buy');
    expect(result.scoreAdjustment).toBe(10);
    expect(result.context).toContain('beat estimates');
    expect(result.context).toContain('30%');
  });

  test('detects post-earnings buy with no surprise data (+10 boost)', async () => {
    const earningsDate = '2026-03-01';
    const tradeDate = '2026-03-08';

    global.fetch = jest.fn(async (url) => ({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          {
            date: earningsDate,
            epsEstimate: null,
            epsActual: null,
            symbol: 'ACME',
          },
        ],
      }),
    }));

    const result = await analyzeEarningsContext('ACME', tradeDate);
    expect(result.signal).toBe('post_earnings_buy');
    expect(result.scoreAdjustment).toBe(10);
    expect(result.context).toContain('blackout window just lifted');
  });

  test('post-earnings buy outside 30-day window returns no signal', async () => {
    const earningsDate = '2026-01-15';
    const tradeDate = '2026-03-10'; // 54 days after

    global.fetch = jest.fn(async (url) => ({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { date: earningsDate, epsEstimate: 1.00, epsActual: 1.10, symbol: 'ACME' },
        ],
      }),
    }));

    const result = await analyzeEarningsContext('ACME', tradeDate);
    expect(result.signal).toBeNull();
    expect(result.scoreAdjustment).toBe(0);
  });

  // ── Blackout period flags ──

  test('flags trade within blackout period (14 days before earnings)', async () => {
    const today = new Date();
    const earningsDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
    const tradeDateStr = today.toISOString().split('T')[0];
    const earningsDateStr = earningsDate.toISOString().split('T')[0];

    // First call (upcoming): returns upcoming earnings
    // Second call (recent): returns nothing
    let callCount = 0;
    global.fetch = jest.fn(async (url) => {
      callCount++;
      if (callCount <= 1) {
        // upcoming
        return {
          ok: true,
          json: async () => ({
            earningsCalendar: [
              { date: earningsDateStr, epsEstimate: 1.00, symbol: 'ACME' },
            ],
          }),
        };
      }
      // recent
      return { ok: true, json: async () => ({ earningsCalendar: [] }) };
    });

    const result = await analyzeEarningsContext('ACME', tradeDateStr);
    expect(result.signal).toBe('blackout_flag');
    expect(result.daysUntilEarnings).toBe(7);
    expect(result.scoreAdjustment).toBe(0);
    expect(result.context).toContain('blackout');
  });

  test('flags trade 1 day before earnings as blackout', async () => {
    const today = new Date();
    const earningsDate = new Date(today.getTime() + 1 * 24 * 60 * 60 * 1000);
    const tradeDateStr = today.toISOString().split('T')[0];
    const earningsDateStr = earningsDate.toISOString().split('T')[0];

    let callCount = 0;
    global.fetch = jest.fn(async (url) => {
      callCount++;
      if (callCount <= 1) {
        return {
          ok: true,
          json: async () => ({
            earningsCalendar: [
              { date: earningsDateStr, symbol: 'ACME' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ earningsCalendar: [] }) };
    });

    const result = await analyzeEarningsContext('ACME', tradeDateStr);
    expect(result.signal).toBe('blackout_flag');
    expect(result.daysUntilEarnings).toBe(1);
  });

  // ── Pre-earnings caution ──

  test('pre-earnings caution for trade 20 days before earnings', async () => {
    const today = new Date();
    const earningsDate = new Date(today.getTime() + 20 * 24 * 60 * 60 * 1000);
    const tradeDateStr = today.toISOString().split('T')[0];
    const earningsDateStr = earningsDate.toISOString().split('T')[0];

    let callCount = 0;
    global.fetch = jest.fn(async (url) => {
      callCount++;
      if (callCount <= 1) {
        return {
          ok: true,
          json: async () => ({
            earningsCalendar: [
              { date: earningsDateStr, symbol: 'ACME' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ earningsCalendar: [] }) };
    });

    const result = await analyzeEarningsContext('ACME', tradeDateStr);
    expect(result.signal).toBe('pre_earnings_caution');
    expect(result.daysUntilEarnings).toBe(20);
    expect(result.scoreAdjustment).toBe(0);
  });

  // ── Edge cases ──

  test('returns null context when no earnings data exists', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ earningsCalendar: [] }),
    }));

    const result = await analyzeEarningsContext('NOPE', '2026-03-15');
    expect(result.signal).toBeNull();
    expect(result.scoreAdjustment).toBe(0);
  });

  test('returns null when no API key', async () => {
    const origKey = process.env.FINNHUB_API_KEY;
    process.env.FINNHUB_API_KEY = '';

    jest.resetModules();
    const mod = require('../lib/earnings-helper');
    const result = await mod.analyzeEarningsContext('AAPL', '2026-03-15');
    expect(result).toBeNull();

    process.env.FINNHUB_API_KEY = origKey;
  });

  test('blackout takes priority over post-earnings when both match', async () => {
    // Edge case: earnings was today, and next earnings is in 10 days
    // The blackout flag should take priority
    const today = new Date();
    const upcomingDate = new Date(today.getTime() + 10 * 24 * 60 * 60 * 1000);
    const recentDate = new Date(today.getTime() - 2 * 24 * 60 * 60 * 1000);
    const tradeDateStr = today.toISOString().split('T')[0];

    let callCount = 0;
    global.fetch = jest.fn(async (url) => {
      callCount++;
      if (callCount <= 1) {
        // upcoming
        return {
          ok: true,
          json: async () => ({
            earningsCalendar: [
              { date: upcomingDate.toISOString().split('T')[0], symbol: 'ACME' },
            ],
          }),
        };
      }
      // recent
      return {
        ok: true,
        json: async () => ({
          earningsCalendar: [
            { date: recentDate.toISOString().split('T')[0], epsEstimate: 1.00, epsActual: 0.80, symbol: 'ACME' },
          ],
        }),
      };
    });

    const result = await analyzeEarningsContext('ACME', tradeDateStr);
    // Blackout should take priority since it's checked first
    expect(result.signal).toBe('blackout_flag');
  });

  test('handles singular day in context string', async () => {
    const earningsDate = '2026-03-14';
    const tradeDate = '2026-03-15'; // 1 day after

    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        earningsCalendar: [
          { date: earningsDate, epsEstimate: null, epsActual: null, symbol: 'ACME' },
        ],
      }),
    }));

    const result = await analyzeEarningsContext('ACME', tradeDate);
    expect(result.signal).toBe('post_earnings_buy');
    expect(result.context).toContain('1 day after');
    expect(result.context).not.toContain('1 days after');
  });
});

// ══════════════════════════════════════════
// batchAnalyzeEarnings
// ══════════════════════════════════════════

describe('batchAnalyzeEarnings', () => {
  test('processes multiple unique tickers', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ earningsCalendar: [] }),
    }));

    const filings = [
      { ticker: 'AAPL', filedAt: '2026-03-15' },
      { ticker: 'MSFT', filedAt: '2026-03-15' },
      { ticker: 'AAPL', filedAt: '2026-03-15' }, // duplicate
    ];

    const results = await batchAnalyzeEarnings(filings);
    expect(results instanceof Map).toBe(true);
    // Should have 2 entries (AAPL deduplicated)
    expect(results.size).toBe(2);
  });

  test('returns empty map when no API key', async () => {
    const origKey = process.env.FINNHUB_API_KEY;
    process.env.FINNHUB_API_KEY = '';

    jest.resetModules();
    const mod = require('../lib/earnings-helper');
    const results = await mod.batchAnalyzeEarnings([{ ticker: 'AAPL', filedAt: '2026-03-15' }]);
    expect(results.size).toBe(0);

    process.env.FINNHUB_API_KEY = origKey;
  });

  test('caps at 20 tickers per batch', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ earningsCalendar: [] }),
    }));

    const filings = Array.from({ length: 30 }, (_, i) => ({
      ticker: `TICK${i}`,
      filedAt: '2026-03-15',
    }));

    const results = await batchAnalyzeEarnings(filings);
    // Each ticker = 2 fetch calls (upcoming + recent via analyzeEarningsContext)
    // 20 tickers * 2 = 40 fetch calls max
    expect(global.fetch.mock.calls.length).toBeLessThanOrEqual(40);
  });

  test('skips tickers with no ticker value', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ earningsCalendar: [] }),
    }));

    const filings = [
      { ticker: '', filedAt: '2026-03-15' },
      { ticker: null, filedAt: '2026-03-15' },
      { ticker: 'AAPL', filedAt: '2026-03-15' },
    ];

    const results = await batchAnalyzeEarnings(filings);
    expect(results.size).toBe(1);
    expect(results.has('AAPL')).toBe(true);
  });
});

// ══════════════════════════════════════════
// Constants
// ══════════════════════════════════════════

describe('Constants', () => {
  test('blackout period is 14 days', () => {
    expect(BLACKOUT_DAYS_BEFORE).toBe(14);
  });

  test('post-earnings window is 30 days', () => {
    expect(POST_EARNINGS_WINDOW_DAYS).toBe(30);
  });

  test('blackout after earnings is 2 days', () => {
    expect(BLACKOUT_DAYS_AFTER).toBe(2);
  });
});
