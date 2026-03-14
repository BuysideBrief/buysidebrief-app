/**
 * /api/send-weekly.js
 * 
 * Weekly digest — "The Week in Insider Trades"
 * Sends every Saturday morning. Lower commitment than daily.
 * Includes: week's top picks, full scorecard, and best context blurbs.
 * 
 * Vercel cron: "0 14 * * 6" (Saturday 10am ET / 2pm UTC)
 */

const { generateScorecard, formatScorecardForWeekly } = require('../lib/performance-tracker');
const { formatValue } = require('../lib/signal-scorer');
const { Redis } = require('@upstash/redis');

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_URL;
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_TOKEN;
let kv;
try {
  kv = (redisUrl && redisToken) ? new Redis({ url: redisUrl, token: redisToken }) : Redis.fromEnv();
} catch (e) {
  kv = { get: async () => null, zrange: async () => [] };
}

module.exports = async function handler(req, res) {
  const isDryRun = req.query.dry === 'true';

  try {
    // Load this week's picks from KV
    const pickIds = await kv.zrange('picks:index', 0, -1);
    const allPicks = [];
    for (const id of (pickIds || [])) {
      const pick = await kv.get(id);
      if (pick) allPicks.push(pick);
    }

    const oneWeekAgo = new Date();
    oneWeekAgo.setDate(oneWeekAgo.getDate() - 7);
    const weekStr = oneWeekAgo.toISOString().split('T')[0];
    const weekPicks = allPicks.filter(p => p.entryDate >= weekStr);
    const scorecard = await generateScorecard();

    // Build the weekly email
    const { subject, html } = formatWeeklyEmail(weekPicks, scorecard);

    if (isDryRun) {
      return res.status(200).json({
        success: true,
        dry: true,
        subject,
        weekPicks: weekPicks.length,
        scorecard,
        html,
      });
    }

    // Send via Resend Broadcast API
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;

    if (!RESEND_API_KEY) {
      return res.status(500).json({ error: 'RESEND_API_KEY not set' });
    }

    if (!AUDIENCE_ID) {
      return res.status(500).json({ error: 'RESEND_AUDIENCE_ID not set' });
    }

    // Step 1: Create the broadcast
    const createRes = await fetch('https://api.resend.com/broadcasts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        segment_id: AUDIENCE_ID,
        from: 'Buyside Brief <hello@buysidebrief.com>',
        subject,
        html,
      }),
    });

    if (!createRes.ok) {
      const err = await createRes.text();
      return res.status(500).json({ success: false, error: `Broadcast create failed: ${createRes.status} — ${err}` });
    }

    const broadcast = await createRes.json();

    // Step 2: Send the broadcast
    const sendRes = await fetch(`https://api.resend.com/broadcasts/${broadcast.id}/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!sendRes.ok) {
      const err = await sendRes.text();
      return res.status(500).json({ success: false, error: `Broadcast send failed: ${sendRes.status} — ${err}` });
    }

    return res.status(200).json({
      success: true,
      subject,
      weekPicks: weekPicks.length,
      broadcastId: broadcast.id,
    });

  } catch (err) {
    console.error('[Weekly] Error:', err);
    return res.status(500).json({ error: err.message });
  }
};

function formatWeeklyEmail(weekPicks, scorecard) {
  const now = new Date();
  const weekEnd = now.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

  const topPick = weekPicks.sort((a, b) => b.score - a.score)[0];
  const subject = topPick
    ? `☕ This week's best insider signal: $${topPick.ticker} (score ${topPick.score})`
    : `☕ The Week in Insider Trades — ${weekEnd}`;

  // Format top picks of the week
  const pickRows = weekPicks
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map(p => {
      const color = '#1a7a4c';
      return `
      <tr>
        <td style="padding:14px 0;border-bottom:1px solid #e0dbd3;">
          <strong style="font-size:16px;font-family:Georgia,serif;">$${esc(p.ticker)}</strong>
          <span style="color:#7a7a7a;font-size:13px;font-family:-apple-system,Helvetica,Arial,sans-serif;"> — ${esc(p.companyName || '')}</span><br>
          <span style="font-size:14px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;">
            ${esc(p.ownerName)} (${esc(p.officerTitle || 'Insider')}) bought 
            <strong style="color:${color};">$${formatValue(p.buyValue)}</strong>
          </span><br>
          <span style="font-size:12px;color:#b0a99f;font-family:-apple-system,Helvetica,Arial,sans-serif;">
            Score: ${p.score} &middot; ${esc(p.signals?.[0] || '')}
          </span>
        </td>
      </tr>`;
    }).join('');

  const scorecardHtml = formatScorecardForWeekly(scorecard);

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#faf8f4;color:#1a1a1a;font-family:Georgia,serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf8f4;">
<tr><td align="center" style="padding:20px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

<!-- Header -->
<tr><td style="padding:32px 20px 20px;border-bottom:2px solid #1a1a1a;">
  <h1 style="margin:0;font-size:26px;color:#1a1a1a;font-family:Georgia,serif;font-weight:normal;">
    Buyside Brief
  </h1>
  <p style="margin:6px 0 0;font-size:13px;color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    The Week in Insider Trades &middot; ${esc(weekStart)} – ${esc(weekEnd)}
  </p>
</td></tr>

<!-- Intro -->
<tr><td style="padding:24px 20px;">
  <p style="margin:0;font-size:16px;color:#3d3d3d;font-family:Georgia,serif;line-height:1.6;">
    Here's your weekly roundup — the insider trades that mattered most this week, 
    plus how our past picks are performing. Grab your coffee. ☕
  </p>
</td></tr>

<!-- Week's picks -->
<tr><td style="padding:0 20px 24px;">
  <h2 style="margin:0 0 16px;font-size:20px;font-family:Georgia,serif;font-weight:normal;border-bottom:1px solid #e0dbd3;padding-bottom:10px;">
    This Week's Top Signals
  </h2>
  ${weekPicks.length > 0 ? `<table width="100%" cellpadding="0" cellspacing="0">${pickRows}</table>` :
    '<p style="color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">Quiet week on the insider front. No filings crossed our threshold.</p>'}
</td></tr>

${scorecardHtml}

<!-- Footer -->
<tr><td style="padding:20px;border-top:1px solid #e0dbd3;">
  <p style="margin:0;font-size:11px;color:#b0a99f;line-height:1.7;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    Not investment advice. SEC Form 4 data is public record. 
    Past insider buying patterns do not predict future performance.<br><br>
    <a href="https://buysidebrief.com" style="color:#1a7a4c;">buysidebrief.com</a>
    &middot; <a href="%unsubscribe_url%" style="color:#b0a99f;">Unsubscribe</a>
  </p>
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html };
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
