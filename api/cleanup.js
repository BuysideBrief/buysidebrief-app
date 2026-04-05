/**
 * One-time Redis cleanup — remove duplicate picks.
 * 
 * Run via Vercel as an API route:
 *   /api/cleanup?dry=true    → see what would be removed
 *   /api/cleanup?run=true    → actually remove duplicates
 */

const { getRedis } = require('../lib/redis');

module.exports = async function handler(req, res) {
  // Auth check
  const ua = req.headers['user-agent'] || '';
  const isCron = ua.includes('vercel-cron')
    || (process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`);
  if (!isCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const isDry = req.query.run !== 'true';

  try {
    const kv = getRedis();
    if (!kv) return res.status(500).json({ error: 'Redis not configured' });

    // Get all pick IDs from the sorted set
    const pickIds = await kv.zrange('picks:index', 0, -1);

    if (!pickIds || pickIds.length === 0) {
      return res.status(200).json({ message: 'No picks found in Redis', pickIds: [] });
    }

    // Load all picks
    const picks = [];
    for (const id of pickIds) {
      const pick = await kv.get(id);
      if (pick) {
        picks.push({ id, ...pick });
      }
    }

    // Find duplicates: same ticker + ownerCik, keep the one with the earliest date
    const seen = {};
    const toRemove = [];
    const toKeep = [];

    // Sort by date ascending so we keep the earliest
    picks.sort((a, b) => (a.entryDate || '').localeCompare(b.entryDate || ''));

    for (const pick of picks) {
      const key = `${pick.ticker}:${pick.ownerCik || pick.ownerName}`;
      if (seen[key]) {
        toRemove.push(pick);
      } else {
        seen[key] = pick;
        toKeep.push(pick);
      }
    }

    if (isDry) {
      return res.status(200).json({
        dry: true,
        message: `Found ${toRemove.length} duplicates to remove out of ${picks.length} total picks`,
        keeping: toKeep.map(p => ({ id: p.id, ticker: p.ticker, date: p.entryDate, owner: p.ownerName })),
        removing: toRemove.map(p => ({ id: p.id, ticker: p.ticker, date: p.entryDate, owner: p.ownerName })),
      });
    }

    // Actually remove duplicates
    let removed = 0;
    for (const pick of toRemove) {
      await kv.del(pick.id);
      await kv.zrem('picks:index', pick.id);
      removed++;
    }

    // Clear the cached scorecard so it regenerates fresh
    await kv.del('meta:scorecard');

    return res.status(200).json({
      success: true,
      message: `Removed ${removed} duplicate picks, ${toKeep.length} remaining`,
      removed: toRemove.map(p => ({ id: p.id, ticker: p.ticker, date: p.entryDate })),
      remaining: toKeep.map(p => ({ id: p.id, ticker: p.ticker, date: p.entryDate })),
    });

  } catch (err) {
    console.error('cleanup error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};
