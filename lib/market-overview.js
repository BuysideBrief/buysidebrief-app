/**
 * Market Overview Helper
 * 
 * Fetches major index data for the daily email header.
 * Uses Finnhub for quotes (already configured).
 */

const FINNHUB_KEY = process.env.FINNHUB_API_KEY || '';
const RATE_LIMIT_MS = 200;
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const INDICES = [
  { symbol: 'SPY', label: 'S&P 500' },
  { symbol: 'QQQ', label: 'Nasdaq' },
  { symbol: 'DIA', label: 'Dow' },
];

/**
 * Fetch market overview data.
 * Returns { indices: [...], summary: "string" }
 */
async function getMarketOverview() {
  if (!FINNHUB_KEY) return null;

  const results = [];

  for (const idx of INDICES) {
    try {
      const res = await fetch(
        `https://finnhub.io/api/v1/quote?symbol=${idx.symbol}&token=${FINNHUB_KEY}`
      );
      await sleep(RATE_LIMIT_MS);

      if (res.ok) {
        const d = await res.json();
        if (d.c && d.c > 0) {
          results.push({
            symbol: idx.symbol,
            label: idx.label,
            price: d.c,
            change: d.d,
            changePercent: d.dp,
            isPositive: d.dp >= 0,
          });
        }
      }
    } catch (e) {
      // Skip failed indices
    }
  }

  if (results.length === 0) return null;

  // Generate a one-line summary
  const summary = generateSummary(results);

  return { indices: results, summary };
}

/**
 * Generate a plain English market summary.
 */
function generateSummary(indices) {
  const sp = indices.find(i => i.symbol === 'SPY');
  if (!sp) return '';

  const direction = sp.isPositive ? 'up' : 'down';
  const magnitude = Math.abs(sp.changePercent);

  let tone = '';
  if (magnitude < 0.3) tone = 'Markets were mostly flat';
  else if (magnitude < 1.0) tone = `Markets ${sp.isPositive ? 'edged higher' : 'dipped'}`;
  else if (magnitude < 2.0) tone = `Markets ${sp.isPositive ? 'rallied' : 'sold off'}`;
  else tone = `Markets ${sp.isPositive ? 'surged' : 'tumbled'}`;

  // Check if indices diverged
  const allSameDirection = indices.every(i => i.isPositive === sp.isPositive);
  if (!allSameDirection) {
    const outlier = indices.find(i => i.isPositive !== sp.isPositive);
    if (outlier) {
      tone += ` — though ${outlier.label} ${outlier.isPositive ? 'bucked the trend higher' : 'lagged'}`;
    }
  }

  return tone + '.';
}

/**
 * Format market overview as HTML for the email.
 */
function formatMarketOverviewForEmail(overview) {
  if (!overview || !overview.indices || overview.indices.length === 0) return '';

  const indexPills = overview.indices.map(idx => {
    const color = idx.isPositive ? '#1a7a4c' : '#c0392b';
    const arrow = idx.isPositive ? '▲' : '▼';
    const sign = idx.isPositive ? '+' : '';
    return `<span style="display:inline-block;margin-right:16px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      <span style="font-size:12px;color:#7a7a7a;">${idx.label}</span>
      <span style="font-size:13px;color:${color};font-weight:600;"> ${arrow} ${sign}${idx.changePercent?.toFixed(2)}%</span>
    </span>`;
  }).join('');

  return `
<tr><td style="padding:20px 20px 0;">
  <div style="background:#ffffff;border:1px solid #e0dbd3;border-radius:10px;padding:16px 20px;">
    <div style="margin-bottom:8px;">
      ${indexPills}
    </div>
    ${overview.summary ? `
    <p style="margin:0;font-size:14px;color:#3d3d3d;line-height:1.5;font-family:Georgia,serif;">
      ${overview.summary}
    </p>` : ''}
  </div>
</td></tr>`;
}

module.exports = {
  getMarketOverview,
  formatMarketOverviewForEmail,
};
