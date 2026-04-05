/**
 * /api/scorecard.js
 * 
 * Public API endpoint that returns scorecard data and CEO profiles.
 * Powers the /scorecard.html page.
 * Cached in Redis for 1 hour to avoid recomputing on every page load.
 */

const { generateScorecard, getAllCeoProfiles } = require('../lib/performance-tracker');
const { getRedisOrNoop } = require('../lib/redis');

module.exports = async function handler(req, res) {
  // CORS for the frontend
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=1800');

  try {
    const redis = getRedisOrNoop();

    const [scorecard, ceoProfiles, signalReportCard, tierPerformance, decayCurve, seasonality, funnel] = await Promise.all([
      generateScorecard(),
      getAllCeoProfiles(),
      redis.get('meta:signal-report-card'),
      redis.get('meta:tier-performance'),
      redis.get('meta:decay-curve'),
      redis.get('meta:seasonality'),
      redis.get('meta:funnel'),
    ]);

    // Only include CEOs with return data
    const ceoData = ceoProfiles
      .filter(p => p.winRate !== null && p.totalPicks >= 1)
      .map(p => ({
        ownerName: p.ownerName,
        officerTitle: p.officerTitle,
        isCsuite: p.isCsuite,
        totalPicks: p.totalPicks,
        winRate: p.winRate,
        avgReturn: p.avgReturn,
        totalBuyValue: p.totalBuyValue,
        wins: p.wins,
        losses: p.losses,
        picks: (p.picks || [])
          .filter(pk => pk.currentReturn !== null)
          .map(pk => ({
            ticker: pk.ticker,
            companyName: pk.companyName,
            entryDate: pk.entryDate,
            entryPrice: pk.entryPrice,
            currentReturn: pk.currentReturn,
            return30d: pk.return30d,
            return90d: pk.return90d,
            buyValue: pk.buyValue,
            score: pk.score,
          }))
          .sort((a, b) => new Date(b.entryDate) - new Date(a.entryDate)),
      }))
      .sort((a, b) => b.totalPicks - a.totalPicks);

    return res.status(200).json({
      success: true,
      scorecard,
      ceoProfiles: ceoData,
      signalReportCard: signalReportCard || null,
      tierPerformance: tierPerformance || null,
      decayCurve: decayCurve || null,
      seasonality: seasonality || null,
      funnel: funnel || null,
      updatedAt: new Date().toISOString(),
    });

  } catch (err) {
    console.error('Scorecard API error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
};
