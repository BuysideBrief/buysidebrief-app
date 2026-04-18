/**
 * Email Digest Formatter
 * 
 * Takes scored + categorized filings and produces an HTML email
 * ready to send via Resend.
 */

const { formatValue } = require('./signal-scorer');
const { tickerLink, tickerLinkBold, brokerCta, affiliateDisclosure } = require('./affiliate-links');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_ABBRS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Return natural timing language for a filing's transaction date.
 * @param {object} filing - a scored filing object
 * @param {Date} [now] - override "today" for testing
 * @returns {string} e.g. "bought", "bought yesterday", "bought on Friday", "bought on Mar 27"
 */
function getTimingPhrase(filing, now) {
  const txDate = filing.transactions?.[0]?.transactionDate;
  if (!txDate) return 'bought';

  const today = now ? new Date(now) : new Date();
  today.setHours(0, 0, 0, 0);

  // Parse YYYY-MM-DD as local date (not UTC)
  const parts = String(txDate).split('-');
  const tx = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));

  const diffMs = today.getTime() - tx.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return 'bought';
  if (diffDays === 1) return 'bought yesterday';
  if (diffDays >= 2 && diffDays <= 5) return `bought on ${DAY_NAMES[tx.getDay()]}`;
  return `bought on ${MONTH_ABBRS[tx.getMonth()]} ${tx.getDate()}`;
}

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

${(categorized.notable && categorized.notable.length > 0) ? formatNotable(categorized.notable) : ''}

${categorized.totalFeatured === 0 && !(categorized.notable && categorized.notable.length > 0) ? formatQuietDay() : ''}

${scorecardHtml || ''}

${(categorized.notable && categorized.notable.length > 0) ? formatNotableExplainer() : ''}

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
    <a href="https://www.buysidebrief.com" style="color:#1a7a4c;">buysidebrief.com</a> 
    &nbsp;&middot;&nbsp; <a href="%unsubscribe_url%" style="color:#b0a99f;">Unsubscribe</a>
    &nbsp;&middot;&nbsp; <a href="https://www.buysidebrief.com/privacy.html" style="color:#b0a99f;">Privacy</a>
    &nbsp;&middot;&nbsp; <a href="https://www.buysidebrief.com/terms.html" style="color:#b0a99f;">Terms</a>
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
    <p style="margin:0 0 8px;font-size:11px;color:${pick.tier === 'strong_signal' ? '#d4a853' : '#1a7a4c'};text-transform:uppercase;letter-spacing:1.5px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      ${pick.tier === 'strong_signal' ? 'Strong Signal' : 'Top Pick'}
    </p>
    <h2 style="margin:0 0 10px;font-size:22px;color:#1a1a1a;font-family:Georgia,serif;font-weight:normal;">
      ${tickerLinkBold(pick.ticker)} — ${esc(pick.issuerName)}
    </h2>
    <p style="margin:0 0 8px;font-size:15px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      ${esc(pick.officerTitle || (pick.isDirector ? 'Director' : 'Insider'))} 
      <strong>${esc(pick.ownerName)}</strong> ${getTimingPhrase(pick)}
      <span style="color:#1a7a4c;font-weight:600;">$${formatValue(pick.summary.totalBuyValue)}</span>
      (${formatValue(pick.summary.totalBuyShares)} shares)
    </p>
    <p style="margin:0 0 12px;font-size:13px;color:#7a7a7a;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      Filed: ${esc(pick.filedAt || 'Today')} 
      &middot; Signal score: <strong style="color:#1a7a4c;">${pick.score}</strong>
      ${earningsTag(pick)}${contrarianTag(pick)}
    </p>
    ${pick.whyItMatters ? `
    <p style="margin:0 0 8px;font-size:14px;color:#3d3d3d;font-family:Georgia,serif;line-height:1.5;">
      <strong>Why it matters:</strong> ${esc(pick.whyItMatters)}
    </p>` : (pick.signals.length > 0 ? `
    <p style="margin:0 0 8px;font-size:14px;color:#3d3d3d;font-family:Georgia,serif;line-height:1.5;">
      <strong>Why it matters:</strong> ${esc(pick.signals.join('. '))}
    </p>` : '')}
    ${earningsCallout(pick)}${contrarianCallout(pick)}
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
    ${brokerCta(pick.ticker)}
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
          ${earningsTag(f)}${contrarianTag(f)}
        </p>
        <p style="margin:0 0 4px;font-size:14px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          ${title} <strong>${ownerName}</strong> ${getTimingPhrase(f)}
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
        ${earningsCallout(f)}${contrarianCallout(f)}
        ${f.insiderHistory && f.insiderHistory.daysSinceLastBuy ? `
        <p style="margin:4px 0 0;font-size:12px;color:#b0a99f;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          Last filed ${f.insiderHistory.daysSinceLastBuy} days ago &middot; ${f.insiderHistory.filingCount} filings at this company
        </p>` : (f.insiderHistory && f.insiderHistory.isFirstFiling ? `
        <p style="margin:4px 0 0;font-size:12px;color:#d4a853;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          First-time purchase at this company
        </p>` : '')}
        ${brokerCta(f.ticker)}
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
    `&bull; ${tickerLink(f.ticker)} — ${esc(f.ownerName)} ${f.summary.buyCount > 0 ? 'bought' : 'sold'} $${formatValue(f.summary.buyCount > 0 ? f.summary.totalBuyValue : f.summary.totalSellValue)} &middot; Score: ${f.score}`
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
    `&bull; ${tickerLink(f.ticker)} — ${esc(f.officerTitle || 'Insider')} sold $${formatValue(f.summary.totalSellValue)}${f.has10b51Plan ? ' (10b5-1 plan, pre-scheduled)' : ''}`
  ).join('<br>');

  return `
<tr><td style="padding:24px 20px;">
  <h3 style="margin:0 0 12px;font-size:14px;color:#c0392b;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e0dbd3;padding-bottom:10px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    Insider Sells to Watch
  </h3>
  <p style="margin:0;font-size:14px;color:#7a7a7a;line-height:1.8;font-family:-apple-system,Helvetica,Arial,sans-serif;">${items}</p>
</td></tr>`;
}

/**
 * "Also worth noting" — large-cap insider buys that didn't clear the scored
 * feature threshold. Editorial color only. Never performance-tracked.
 * See lib/notable.js for the filter logic.
 */
function formatNotable(notable) {
  const rows = notable.slice(0, 8).map(n => `
    <tr>
      <td style="padding:12px 0;border-bottom:1px solid #f2efe8;">
        <strong style="font-size:15px;font-family:Georgia,serif;">${tickerLinkBold(n.ticker)}</strong>
        <span style="color:#7a7a7a;font-size:13px;font-family:-apple-system,Helvetica,Arial,sans-serif;"> — ${esc(n.issuerName || '')}</span><br>
        <span style="font-size:14px;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          ${esc(n.officerTitle || (n.isDirector ? 'Director' : 'Insider'))} <strong>${esc(n.ownerName || '')}</strong>
          bought <strong style="color:#1a7a4c;">$${formatValue(n.buyValue)}</strong>
        </span>
      </td>
    </tr>`).join('');

  return `
<tr><td style="padding:24px 20px;">
  <h3 style="margin:0 0 6px;font-size:14px;color:#b0a99f;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #e0dbd3;padding-bottom:10px;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    Also Worth Noting
  </h3>
  <p style="margin:10px 0 14px;font-size:13px;color:#7a7a7a;line-height:1.55;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    Real insider purchases at companies you&rsquo;ve probably heard of. These don&rsquo;t score high enough on our model to be featured picks &mdash; usually because the buy is small relative to the company&rsquo;s market cap &mdash;
    <a href="#notable-explainer" style="color:#1a7a4c;">but they&rsquo;re worth knowing about</a>.
  </p>
  <table width="100%" cellpadding="0" cellspacing="0">${rows}</table>
</td></tr>`;
}

function formatNotableExplainer() {
  return `
<tr><td id="notable-explainer" style="padding:16px 20px;border-top:1px dashed #e0dbd3;">
  <p style="margin:0;font-size:11px;color:#b0a99f;line-height:1.7;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    <strong style="color:#7a7a7a;">About &ldquo;Also worth noting&rdquo;:</strong> our model penalizes large-cap insider buys
    because historical data shows small-cap purchases significantly outperform in the 30&ndash;90 day window. Notable entries
    are editorial context &mdash; they are <em>not</em> tracked on our scorecard.
  </p>
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

// Basic HTML escaping — decodes XML entities first to prevent double-encoding
function esc(str) {
  if (!str) return '';
  return String(str)
    // First decode any existing XML/HTML entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    // Then re-encode for HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate an earnings tag pill for the signal header line.
 * Returns HTML string or empty string if no earnings context.
 */
function earningsTag(filing) {
  const ec = filing.earningsContext;
  if (!ec || !ec.signal) return '';

  if (ec.signal === 'post_earnings_buy') {
    // Determine if beat or miss for tag color
    const recent = ec.recentEarnings || {};
    if (recent.miss) {
      return `<span style="display:inline-block;margin-left:8px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:0.5px;border-radius:12px;background:#e8f5ee;color:#1a7a4c;font-family:-apple-system,Helvetica,Arial,sans-serif;">EARNINGS MISS +${ec.scoreAdjustment}</span>`;
    } else if (recent.beat) {
      return `<span style="display:inline-block;margin-left:8px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:0.5px;border-radius:12px;background:#e8f5ee;color:#1a7a4c;font-family:-apple-system,Helvetica,Arial,sans-serif;">EARNINGS BEAT +${ec.scoreAdjustment}</span>`;
    }
    // Generic post-earnings
    return `<span style="display:inline-block;margin-left:8px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:0.5px;border-radius:12px;background:#eff6ff;color:#185fa5;font-family:-apple-system,Helvetica,Arial,sans-serif;">POST-EARNINGS BUY</span>`;
  }

  if (ec.signal === 'blackout_flag') {
    return `<span style="display:inline-block;margin-left:8px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:0.5px;border-radius:12px;background:#faeeda;color:#854f0b;font-family:-apple-system,Helvetica,Arial,sans-serif;">BLACKOUT WINDOW</span>`;
  }

  if (ec.signal === 'pre_earnings_caution') {
    return `<span style="display:inline-block;margin-left:8px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:0.5px;border-radius:12px;background:#faeeda;color:#854f0b;font-family:-apple-system,Helvetica,Arial,sans-serif;">EARNINGS UPCOMING</span>`;
  }

  return '';
}

/**
 * Generate an earnings context callout box.
 * The colored left-border box that shows below the blurb.
 * Returns HTML string or empty string if no earnings context.
 */
function earningsCallout(filing) {
  const ec = filing.earningsContext;
  if (!ec || !ec.signal || !ec.context) return '';

  if (ec.signal === 'post_earnings_buy') {
    const recent = ec.recentEarnings || {};
    if (recent.miss) {
      // Green callout for buying the dip after a miss — strongest signal
      return `
        <div style="margin:8px 0 0;padding:8px 12px;background:#e8f5ee;border-left:3px solid #1a7a4c;border-radius:0;font-family:-apple-system,Helvetica,Arial,sans-serif;">
          <p style="margin:0;font-size:12px;color:#1a7a4c;font-weight:600;">Buying the dip</p>
          <p style="margin:2px 0 0;font-size:12px;color:#3d3d3d;line-height:1.4;">${esc(ec.context)}</p>
        </div>`;
    }
    // Blue callout for post-earnings buy (beat or neutral)
    return `
      <div style="margin:8px 0 0;padding:8px 12px;background:#eff6ff;border-left:3px solid #185fa5;border-radius:0;font-family:-apple-system,Helvetica,Arial,sans-serif;">
        <p style="margin:0;font-size:12px;color:#185fa5;font-weight:600;">Earnings context</p>
        <p style="margin:2px 0 0;font-size:12px;color:#3d3d3d;line-height:1.4;">${esc(ec.context)}</p>
      </div>`;
  }

  if (ec.signal === 'blackout_flag' || ec.signal === 'pre_earnings_caution') {
    return `
      <div style="margin:8px 0 0;padding:8px 12px;background:#faeeda;border-left:3px solid #854f0b;border-radius:0;font-family:-apple-system,Helvetica,Arial,sans-serif;">
        <p style="margin:0;font-size:12px;color:#854f0b;font-weight:600;">Earnings caution</p>
        <p style="margin:2px 0 0;font-size:12px;color:#3d3d3d;line-height:1.4;">${esc(ec.context)}</p>
      </div>`;
  }

  return '';
}

/**
 * Generate a contrarian signal tag pill.
 * Returns HTML string or empty string if no contrarian context.
 */
function contrarianTag(filing) {
  const cc = filing.contrarianContext;
  if (!cc || !cc.signal) return '';

  // Red/coral color scheme for contrarian — signals "against the crowd"
  if (cc.tag === 'EXTREME CONTRARIAN') {
    return `<span style="display:inline-block;margin-left:8px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:0.5px;border-radius:12px;background:#fce8e6;color:#993c1d;font-family:-apple-system,Helvetica,Arial,sans-serif;">${cc.tag} -${cc.drawdownPct}%</span>`;
  }
  if (cc.tag === 'DEEP CONTRARIAN') {
    return `<span style="display:inline-block;margin-left:8px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:0.5px;border-radius:12px;background:#faece7;color:#993c1d;font-family:-apple-system,Helvetica,Arial,sans-serif;">${cc.tag} -${cc.drawdownPct}%</span>`;
  }
  return `<span style="display:inline-block;margin-left:8px;padding:2px 10px;font-size:11px;font-weight:600;letter-spacing:0.5px;border-radius:12px;background:#faece7;color:#993c1d;font-family:-apple-system,Helvetica,Arial,sans-serif;">${cc.tag} -${cc.drawdownPct}%</span>`;
}

/**
 * Generate a contrarian context callout box.
 * Coral/red left-border box below the blurb.
 */
function contrarianCallout(filing) {
  const cc = filing.contrarianContext;
  if (!cc || !cc.context) return '';

  return `
    <div style="margin:8px 0 0;padding:8px 12px;background:#faece7;border-left:3px solid #993c1d;border-radius:0;font-family:-apple-system,Helvetica,Arial,sans-serif;">
      <p style="margin:0;font-size:12px;color:#993c1d;font-weight:600;">${esc(cc.label)}</p>
      <p style="margin:2px 0 0;font-size:12px;color:#3d3d3d;line-height:1.4;">${esc(cc.context)}</p>
    </div>`;
}

module.exports = { formatDigestEmail, getTimingPhrase, formatNotable, formatNotableExplainer };
