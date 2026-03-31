/**
 * Tests for api/get-snippet.js
 */

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
};

jest.mock('../lib/redis', () => ({
  getRedisOrNoop: () => mockRedis,
}));

const handler = require('../api/get-snippet');

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

afterEach(() => {
  jest.clearAllMocks();
});

describe('get-snippet handler', () => {

  test('rejects unauthenticated requests', async () => {
    const res = makeRes();
    await handler(makeReq({ dry: undefined }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  test('allows access with dry=true', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(makeReq({ dry: 'true' }), res);
    expect(res.statusCode).toBe(200);
  });

  test('allows access with CRON_SECRET auth header', async () => {
    process.env.CRON_SECRET = 'test-secret';
    mockRedis.get.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(
      makeReq({ dry: undefined }, { authorization: 'Bearer test-secret' }),
      res
    );
    expect(res.statusCode).toBe(200);
    delete process.env.CRON_SECRET;
  });

  test('returns snippet when it exists', async () => {
    const snippetData = {
      twitter: '🚨 Afternoon signal: $ACME...',
      linkedin: 'Afternoon insider signal...',
      signals: [{ ticker: 'ACME', score: 85 }],
      generated_at: '2026-03-31T19:00:00Z',
    };
    mockRedis.get.mockResolvedValueOnce(JSON.stringify(snippetData));

    const res = makeRes();
    await handler(makeReq({ date: '2026-03-31' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.twitter).toBe(snippetData.twitter);
    expect(res.body.linkedin).toBe(snippetData.linkedin);
    expect(res.body.date).toBe('2026-03-31');
  });

  test('returns no_snippet status when Redis key does not exist', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(makeReq({ date: '2026-03-31' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('no_snippet');
    expect(res.body.date).toBe('2026-03-31');
  });

  test('defaults to today when no date param provided', async () => {
    mockRedis.get.mockResolvedValueOnce(null);
    const res = makeRes();
    await handler(makeReq({}), res);

    expect(res.statusCode).toBe(200);
    // Should use today's date
    const today = new Date().toISOString().split('T')[0];
    expect(mockRedis.get).toHaveBeenCalledWith(`afternoon:snippet:${today}`);
  });

  test('handles Redis errors gracefully', async () => {
    mockRedis.get.mockRejectedValueOnce(new Error('Redis connection failed'));
    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body.error).toContain('Redis connection failed');
  });

  test('handles pre-parsed Redis objects (not strings)', async () => {
    // Upstash sometimes returns already-parsed objects
    const snippetData = {
      twitter: 'tweet text',
      linkedin: 'linkedin text',
      signals: [],
      generated_at: '2026-03-31T19:00:00Z',
    };
    mockRedis.get.mockResolvedValueOnce(snippetData);

    const res = makeRes();
    await handler(makeReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.twitter).toBe('tweet text');
  });
});
