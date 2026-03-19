/**
 * Shared Redis Singleton
 *
 * Single Upstash Redis connection reused across the entire app.
 * Avoids opening multiple connections per request from different modules.
 */

let instance = null;

function getRedis() {
  if (instance) return instance;

  try {
    const { Redis } = require('@upstash/redis');

    // Auto-detect env var names (Vercel uses different names depending on setup)
    const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_TOKEN;

    if (url && token) {
      instance = new Redis({ url, token });
    } else {
      instance = Redis.fromEnv();
    }

    return instance;
  } catch (e) {
    console.error('Redis not available:', e.message);
    return null;
  }
}

/**
 * No-op fallback — returned when Redis isn't configured,
 * so callers don't crash.
 */
const NO_OP = {
  get: async () => null,
  set: async () => null,
  zadd: async () => null,
  zrange: async () => [],
  zrangebyscore: async () => [],
  sadd: async () => null,
  smembers: async () => [],
  del: async () => null,
  pipeline: () => ({ exec: async () => [] }),
};

/**
 * Get the shared Redis instance, or a no-op fallback if unavailable.
 * Use this when the caller should never crash due to missing Redis.
 */
function getRedisOrNoop() {
  return getRedis() || NO_OP;
}

module.exports = { getRedis, getRedisOrNoop, NO_OP };
