/**
 * Email Digest Formatter
 * 
 * Takes scored + categorized filings and produces an HTML email
 * ready to send via Resend.
 */

const { formatValue } = require('./signal-scorer');
const { tickerLink, tickerLinkBold, affiliateDisclosure } = require('./affiliate-links');

/**
 * Generate the full HTML email for a daily digest.
 */
function formatDigestEmail(categorized, date, scorecardHtml, marketOverviewHtml) {
  const dateStr = new Date(date || Date.now()).toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const topPick = categorized.topPicks[0] || categorized.featured[0];
  const subject = topPick
    ? `🔍 Buyside Brief — ${dateStr} | $${topPick.ticker} ${topPick.officerTitle || 'insider'} buys $${formatValue(topPick.summary.totalBuyValue)}`
    : `🔍 Buyside Brief — ${dateStr}`;

  const html = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Buyside Brief — ${dateStr}</title>
</head>
<body style="margin:0;padding:0;background-color:#faf8f4;color:#1a1a1a;font-family:Georgia,'Times New Roman',serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background-color:#faf8f4;">
<tr><td align="center" style="padding:20px;">
<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

<!-- Header -->
<tr><td style="padding:32px 20px 20px;border-bottom:2px solid #1a1a1a;">
  <h1 style="margin:0;font-size:26px;color:#1a1a1a;font-family:Georgia,serif;font-weight:normal;">
    Buyside Brief
  </h1>
  <p style="margin:6px 0 0;font-size:13px;color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    ${dateStr} &middot; Public SEC data, plain English
  </p>
</td></tr>

${marketOverviewHtml || ''}

${categorized.topPicks.length > 0 ? formatTopPicks(categorized.topPicks) : ''}

${categorized.featured.length > 0 ? formatFeatured(categorized.featured) : ''}

${categorized.mentions.length > 0 ? formatMentions(categorized.mentions) : ''}

${categorized.notable_sells.length > 0 ? formatSells(categorized.notable_sells) : ''}

${categorized.totalFeatured === 0 ? formatQuietDay() : ''}

${scorecardHtml || ''}

<!-- Stats -->
<tr><td style="padding:20px;border-top:1px solid #e0dbd3;">
  <p style="margin:0;font-size:12px;color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    ${categorized.totalProcessed} filings scanned &middot; ${categorized.totalFeatured} signals surfaced
  </p>
</td></tr>

<!-- Footer -->
<tr><td style="padding:20px;border-top:1px solid #e0dbd3;">
  <p style="margin:0;font-size:11px;color:#b0a99f;line-height:1.7;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    Not investment advice. SEC Form 4 data is public record. Past insider buying patterns 
    do not predict future performance. Always do your own research.<br><br>
    <a href="https://buysidebrief.com" style="color:#1a7a4c;">buysidebrief.com</a> 
    &nbsp;&middot;&nbsp; <a href="%unsubscribe_url%" style="color:#b0a99f;">Unsubscribe</a>
  </p>
  ${affiliateDisclosure()}
</td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, html };
}

function formatTopPicks(picks) {
  return picks.map((pick, i) => `
<!-- Top Pick ${i + 1} -->
<tr><td style="padding:24px 20px;">
  <div style="background:#ffffff;border:1px solid #e0dbd3;border-radius:12px;padding:24px;">
    <p style="margin:0 0 8px;font-size:11px;color:#1a7a4c;text-transform:uppercase;letter-spacing:1.5px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      Top Pick
    </p>
    <h2 style="margin:0 0 10px;font-size:22px;color:#1a1a1a;font-family:Georgia,serif;font-weight:normal;">
      ${tickerLinkBold(pick.ticker)} — ${esc(pick.issuerName)}
    </h2>
    <p style="margin:0 0 8px;font-size:15px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      ${esc(pick.officerTitle || (pick.isDirector ? 'Director' : 'Insider'))} 
      <strong>${esc(pick.ownerName)}</strong> bought 
      <span style="color:#1a7a4c;font-weight:600;">$${formatValue(pick.summary.totalBuyValue)}</span>
      (${formatValue(pick.summary.totalBuyShares)} shares)
    </p>
    <p style="margin:0 0 12px;font-size:13px;color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      Filed: ${esc(pick.filedAt || 'Today')} 
      &middot; Signal score: <strong style="color:#1a7a4c;">${pick.score}/100</strong>
    </p>
    ${pick.whyItMatters ? `
    <p style="margin:0 0 8px;font-size:14px;color:#3d3d3d;font-family:Georgia,serif;line-height:1.5;">
      <strong>Why it matters:</strong> ${esc(pick.whyItMatters)}
    </p>` : (pick.signals.length > 0 ? `
    <p style="margin:0 0 8px;font-size:14px;color:#3d3d3d;font-family:Georgia,serif;line-height:1.5;">
      <strong>Why it matters:</strong> ${esc(pick.signals.join('. '))}
    </p>` : '')}
    ${pick.insiderHistory && pick.insiderHistory.daysSinceLastBuy ? `
    <p style="margin:0 0 8px;font-size:13px;color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      Last filed: ${pick.insiderHistory.daysSinceLastBuy} days ago &middot; 
      ${pick.insiderHistory.filingCount} total filings at this company
    </p>` : (pick.insiderHistory && pick.insiderHistory.isFirstFiling ? `
    <p style="margin:0 0 8px;font-size:13px;color:#d4a853;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      First-time purchase at this company
    </p>` : '')}
    ${pick.accessionNumber ? `
    <p style="margin:12px 0 0;">
      <a href="https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${esc(pick.issuerCik || '')}&type=4&dateb=&owner=include&count=10" 
         style="color:#1a7a4c;font-size:13px;font-family:-apple-system,Helvetica,Arial,sans-serif;">View SEC filing &rarr;</a>
    </p>` : ''}
  </div>
</td></tr>`).join('');
}

function formatFeatured(filings) {
  const rows = filings.map(f => {
    const title = esc(f.officerTitle || (f.isDirector ? 'Director' : (f.isTenPercentOwner ? '10%+ Owner' : 'Insider')));
    const ownerName = esc(f.ownerName || 'Unknown');
    const shares = f.summary.totalBuyShares ? `${formatValue(f.summary.totalBuyShares)} shares` : '';
    const price = f.transactions?.[0]?.pricePerShare ? `@ $${f.transactions[0].pricePerShare.toFixed(2)}` : '';
    const detail = [shares, price].filter(Boolean).join(' ');

    return `
    <tr>
      <td style="padding:16px 0;border-bottom:1px solid #e0dbd3;">
        <p style="margin:0 0 4px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          ${tickerLinkBold(f.ticker)}
          <span style="color:#b0a99f;font-size:12px;font-family:'JetBrains Mono',monospace;"> Score: ${f.score}</span>
        </p>
        <p style="margin:0 0 4px;font-size:14px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          ${title} <strong>${ownerName}</strong> bought
          <span style="color:#1a7a4c;font-weight:600;">$${formatValue(f.summary.totalBuyValue)}</span>
          ${detail ? `<span style="color:#7a7a7a;font-size:13px;">(${esc(detail)})</span>` : ''}
        </p>
        ${f.whyItMatters ? `
        <p style="margin:4px 0 0;font-size:13px;color:#7a7a7a;line-height:1.5;font-family:Georgia,serif;">
          ${esc(f.whyItMatters)}
        </p>` : (f.signals && f.signals.length > 0 ? `
        <p style="margin:4px 0 0;font-size:13px;color:#7a7a7a;line-height:1.5;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          ${esc(f.signals.join(' · '))}
        </p>` : '')}
        ${f.insiderHistory && f.insiderHistory.daysSinceLastBuy ? `
        <p style="margin:4px 0 0;font-size:12px;color:#b0a99f;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          Last filed ${f.insiderHistory.daysSinceLastBuy} days ago &middot; ${f.insiderHistory.filingCount} filings at this company
        </p>` : (f.insiderHistory && f.insiderHistory.isFirstFiling ? `
        <p style="margin:4px 0 0;font-size:12px;color:#d4a853;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          First-time purchase at this company
        </p>` : '')}
      </td>
    </tr>`;
  }).join('');

  return `
<tr><td style="padding:24px 20px;">
  <h3 style="margin:0 0 12px;font-size:14px;color:#7a7a7a;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e0dbd3;padding-bottom:10px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    More Signals Today
  </h3>
  <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
</td></tr>`;
}

function formatMentions(filings) {
  const items = filings.slice(0, 5).map(f =>
    `&bull; $${esc(f.ticker)} — ${esc(f.ownerName)} ${f.summary.buyCount > 0 ? 'bought' : 'sold'} $${formatValue(f.summary.buyCount > 0 ? f.summary.totalBuyValue : f.summary.totalSellValue)} &middot; Score: ${f.score}`
  ).join('<br>');

  return `
<tr><td style="padding:24px 20px;">
  <h3 style="margin:0 0 12px;font-size:14px;color:#b0a99f;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e0dbd3;padding-bottom:10px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    Also Noted
  </h3>
  <p style="margin:0;font-size:14px;color:#7a7a7a;line-height:1.8;font-family:-apple-system,Helvetica,Arial,sans-serif;">${items}</p>
</td></tr>`;
}

function formatSells(filings) {
  const items = filings.slice(0, 3).map(f =>
    `&bull; $${esc(f.ticker)} — ${esc(f.officerTitle || 'Insider')} sold $${formatValue(f.summary.totalSellValue)}${f.has10b51Plan ? ' (10b5-1 plan, pre-scheduled)' : ''}`
  ).join('<br>');

  return `
<tr><td style="padding:24px 20px;">
  <h3 style="margin:0 0 12px;font-size:14px;color:#c0392b;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e0dbd3;padding-bottom:10px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    Insider Sells to Watch
  </h3>
  <p style="margin:0;font-size:14px;color:#7a7a7a;line-height:1.8;font-family:-apple-system,Helvetica,Arial,sans-serif;">${items}</p>
</td></tr>`;
}

function formatQuietDay() {
  return `
<tr><td style="padding:40px 20px;text-align:center;">
  <p style="margin:0;font-size:16px;color:#7a7a7a;font-family:Georgia,serif;">
    Quiet day on the insider front.<br>
    <span style="font-size:14px;">No filings crossed our signal threshold today. Enjoy the coffee. &#9749;</span>
  </p>
</td></tr>`;
}

// Basic HTML escaping
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { formatDigestEmail };
