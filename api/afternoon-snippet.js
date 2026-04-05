const { getRedisOrNoop } = require('../lib/redis');

const kv = getRedisOrNoop();

module.exports = async function handler(req, res) {
  // Auth check
  const ua = req.headers['user-agent'] || '';
  const isCron = ua.includes('vercel-cron')
    || (process.env.CRON_SECRET && req.headers['authorization'] === `Bearer ${process.env.CRON_SECRET}`);
  if (!isCron) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  const date = req.query.date || new Date().toISOString().slice(0, 10);

  try {
    const snippet = await kv.get(`afternoon:snippet:${date}`);
    if (!snippet) {
      return res.status(404).json({ error: `No snippet found for ${date}` });
    }
    return res.status(200).json(typeof snippet === 'string' ? JSON.parse(snippet) : snippet);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch snippet' });
  }
};
