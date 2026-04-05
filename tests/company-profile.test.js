/**
 * Tests for lib/company-profile.js
 *
 * Run:  npx jest tests/company-profile.test.js
 */

// ── Mock Redis ──
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockPipelineExec = jest.fn();
const mockPipeline = jest.fn(() => ({
  get: jest.fn().mockReturnThis(),
  exec: mockPipelineExec,
}));

jest.mock('../lib/redis', () => ({
  getRedis: () => ({
    get: mockRedisGet,
    set: mockRedisSet,
    pipeline: mockPipeline,
  }),
}));

// ── Mock fetch ──
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Ensure AbortSignal.timeout exists
if (!AbortSignal.timeout) {
  AbortSignal.timeout = () => new AbortController().signal;
}

// Set env before requiring module
process.env.FINNHUB_API_KEY = 'test-key';

const { getCompanyProfile, getCompanyProfileBatch, getSectorLabel } = require('../lib/company-profile');

beforeEach(() => {
  jest.clearAllMocks();
});

// ── getSectorLabel ──

describe('getSectorLabel', () => {
  test('maps known Finnhub industries to broad sectors', () => {
    expect(getSectorLabel('Technology')).toBe('Technology');
    expect(getSectorLabel('Biotechnology')).toBe('Healthcare');
    expect(getSectorLabel('Banking')).toBe('Financial Services');
    expect(getSectorLabel('Oil & Gas')).toBe('Energy');
    expect(getSectorLabel('Retail')).toBe('Consumer Cyclical');
    expect(getSectorLabel('Utilities')).toBe('Utilities');
    expect(getSectorLabel('Real Estate')).toBe('Real Estate');
  });

  test('is case-insensitive', () => {
    expect(getSectorLabel('TECHNOLOGY')).toBe('Technology');
    expect(getSectorLabel('biotechnology')).toBe('Healthcare');
  });

  test('returns raw industry for unmapped values', () => {
    expect(getSectorLabel('Space Tourism')).toBe('Space Tourism');
    expect(getSectorLabel('Underwater Basket Weaving')).toBe('Underwater Basket Weaving');
  });

  test('returns Unknown for null/undefined', () => {
    expect(getSectorLabel(null)).toBe('Unknown');
    expect(getSectorLabel(undefined)).toBe('Unknown');
    expect(getSectorLabel('')).toBe('Unknown');
  });
});

// ── getCompanyProfile ──

describe('getCompanyProfile', () => {
  const finnhubResponse = {
    country: 'US',
    currency: 'USD',
    exchange: 'NASDAQ',
    finnhubIndustry: 'Technology',
    ipo: '1980-12-12',
    logo: 'https://example.com/logo.png',
    marketCapitalization: 2500000,
    name: 'Apple Inc',
    phone: '1234567890',
    shareOutstanding: 15000,
    ticker: 'AAPL',
    weburl: 'https://apple.com',
  };

  test('returns cached data on Redis hit', async () => {
    const cached = {
      sector: 'Technology',
      marketCap: 2500000,
      exchange: 'NASDAQ',
      name: 'Apple Inc',
      ipoDate: '1980-12-12',
      lastUpdated: '2026-03-01T00:00:00.000Z',
    };
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cached));

    const result = await getCompanyProfile('AAPL');

    expect(result).toEqual(cached);
    expect(mockRedisGet).toHaveBeenCalledWith('company:AAPL');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('returns cached data when Redis returns parsed object', async () => {
    const cached = {
      sector: 'Technology',
      marketCap: 2500000,
      exchange: 'NASDAQ',
      name: 'Apple Inc',
      ipoDate: '1980-12-12',
      lastUpdated: '2026-03-01T00:00:00.000Z',
    };
    mockRedisGet.mockResolvedValueOnce(cached); // Upstash auto-parses

    const result = await getCompanyProfile('AAPL');

    expect(result).toEqual(cached);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('fetches from Finnhub on cache miss and caches result', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => finnhubResponse,
    });
    mockRedisSet.mockResolvedValueOnce('OK');

    const result = await getCompanyProfile('AAPL');

    expect(result.sector).toBe('Technology');
    expect(result.marketCap).toBe(2500000);
    expect(result.exchange).toBe('NASDAQ');
    expect(result.name).toBe('Apple Inc');
    expect(result.ipoDate).toBe('1980-12-12');
    expect(result.lastUpdated).toBeDefined();

    // Should cache in Redis with TTL
    expect(mockRedisSet).toHaveBeenCalledWith(
      'company:AAPL',
      expect.any(String),
      { ex: 2592000 }
    );
  });

  test('normalizes ticker to uppercase', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => finnhubResponse,
    });
    mockRedisSet.mockResolvedValueOnce('OK');

    await getCompanyProfile('aapl');

    expect(mockRedisGet).toHaveBeenCalledWith('company:AAPL');
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('symbol=AAPL'),
      expect.any(Object)
    );
  });

  test('returns null and does NOT cache on Finnhub failure', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const result = await getCompanyProfile('AAPL');

    expect(result).toBeNull();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  test('returns null and does NOT cache on empty Finnhub response', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const result = await getCompanyProfile('FAKE');

    expect(result).toBeNull();
    expect(mockRedisSet).not.toHaveBeenCalled();
  });

  test('returns null for null/empty ticker', async () => {
    expect(await getCompanyProfile(null)).toBeNull();
    expect(await getCompanyProfile('')).toBeNull();
    expect(mockRedisGet).not.toHaveBeenCalled();
  });
});

// ── getCompanyProfileBatch ──

describe('getCompanyProfileBatch', () => {
  const cachedProfile = {
    sector: 'Technology',
    marketCap: 2500000,
    exchange: 'NASDAQ',
    name: 'Apple Inc',
    ipoDate: '1980-12-12',
    lastUpdated: '2026-03-01T00:00:00.000Z',
  };

  test('returns mix of cached and fetched profiles', async () => {
    // Pipeline returns: AAPL cached, MSFT not cached
    mockPipelineExec.mockResolvedValueOnce([
      JSON.stringify(cachedProfile),
      null,
    ]);

    // Finnhub call for MSFT
    mockRedisGet.mockResolvedValueOnce(null); // cache miss in getCompanyProfile
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        name: 'Microsoft',
        finnhubIndustry: 'Technology',
        marketCapitalization: 3000000,
        exchange: 'NASDAQ',
        ipo: '1986-03-13',
      }),
    });
    mockRedisSet.mockResolvedValueOnce('OK');

    const results = await getCompanyProfileBatch(['AAPL', 'MSFT']);

    expect(results.get('AAPL')).toEqual(cachedProfile);
    expect(results.get('MSFT').name).toBe('Microsoft');
    expect(results.size).toBe(2);
  });

  test('handles empty array', async () => {
    const results = await getCompanyProfileBatch([]);
    expect(results.size).toBe(0);
  });

  test('deduplicates tickers', async () => {
    mockPipelineExec.mockResolvedValueOnce([
      JSON.stringify(cachedProfile),
    ]);

    const results = await getCompanyProfileBatch(['AAPL', 'aapl', 'AAPL']);

    // Should only query Redis once for AAPL
    expect(mockPipeline).toHaveBeenCalledTimes(1);
    expect(results.get('AAPL')).toEqual(cachedProfile);
  });
});

// ── Rate limiting ──

describe('rate limiting', () => {
  test('getCompanyProfile sleeps 200ms after Finnhub call', async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        name: 'Test Corp',
        finnhubIndustry: 'Technology',
        marketCapitalization: 100,
        exchange: 'NYSE',
        ipo: '2020-01-01',
      }),
    });
    mockRedisSet.mockResolvedValueOnce('OK');

    const start = Date.now();
    await getCompanyProfile('TEST');
    const elapsed = Date.now() - start;

    // Should take at least ~200ms due to rate limit sleep
    expect(elapsed).toBeGreaterThanOrEqual(180); // small tolerance
  });
});
