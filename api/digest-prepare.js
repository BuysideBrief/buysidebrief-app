/**
 * /api/digest-prepare
 *
 * First half of the daily digest cron. Runs steps 1 → 3g of the original
 * fetch-and-send pipeline (fetch, parse, score, earnings, contrarian, dampen,
 * historical store, profiles, notable) and writes the result to Redis under
 * digest:prepared:{date}:{meta|scored|notable}, then sets
 * digest:prepared:{date}:complete LAST as the all-clear marker.
 *
 * Cron: weekdays 11:00 UTC. /api/digest-send fires at 11:08 UTC.
 *
 * Manual triggers:
 *   /api/digest-prepare?send=true   — explicit run (cron-equivalent)
 *   /api/digest-prepare?dry=true    — runs the pipeline but skips Redis writes
 */

const { prepare, preparedKeys } = require('../lib/digest-pipeline');
const { getRedisOrNoop } = require('../lib/redis');

module.exports = async function handler(req, res) {
  const ua = req.headers['user-agent'] || '';
  const isCron = ua.includes('vercel-cron')
    || (process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`);
  const isManual = req.query.send === 'true';
  const isDry = req.query.dry === 'true';

  // Default to no-op for unauthenticated GETs to avoid accidental triggers.
  if (!isCron && !isManual && !isDry) {
    return res.status(200).json({
      success: true,
      message: 'Use ?send=true (manual), ?dry=true (test), or trigger via cron',
    });
  }

  const date = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
    ? req.query.date
    : new Date().toISOString().split('T')[0];

  console.log(`[digest-prepare] starting for ${date} (cron: ${isCron}, manual: ${isManual}, dry: ${isDry})`);

  try {
    const redis = isDry
      ? makeNoopRedis()
      : getRedisOrNoop();

    const result = await prepare({ redis, date });

    return res.status(200).json({
      success: true,
      date,
      dry: isDry,
      keys: preparedKeys(date),
      ...result,
    });
  } catch (err) {
    console.error('[digest-prepare] error:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Internal server error',
    });
  }
};

// Dry-run shim: keep the read path real (so historical store etc. can pull
// recent picks) but no-op writes so the prepared-payload keys aren't clobbered
// by a casual debug hit.
function makeNoopRedis() {
  const real = getRedisOrNoop();
  const noopPipeline = () => {
    const pipe = {
      set: () => pipe,
      zadd: () => pipe,
      get: () => pipe,
      del: () => pipe,
      exec: async () => [],
    };
    return pipe;
  };
  return {
    ...real,
    set: async () => null,
    zadd: async () => null,
    sadd: async () => null,
    del: async () => null,
    pipeline: noopPipeline,
  };
}

module.exports.maxDuration = 300;
