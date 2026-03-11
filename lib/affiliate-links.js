/**
 * Affiliate Link System — Multi-Partner
 * 
 * Supports multiple affiliate partners simultaneously.
 * Ticker links go to TradingView (research), and a separate
 * "Trade this" CTA section rotates between brokers.
 * 
 * Env vars (all optional — hardcoded defaults included):
 *   TASTYTRADE_REF      = referral code for tastytrade
 *   IBKR_REF            = referral code for Interactive Brokers  
 *   TRADINGVIEW_REF     = referral ID for TradingView
 */

// ── Partner configs ──
const PARTNERS = {
  tastytrade: {
    name: 'tastytrade',
    ref: process.env.TASTYTRADE_REF || '8K8P8N4D73',
    getUrl: (ticker, ref) => `https://tastytrade.com/welcome/?referralCode=${ref}`,
    cta: 'Trade on tastytrade',
    tagline: 'Commission-free stock & options',
  },
  ibkr: {
    name: 'Interactive Brokers',
    ref: process.env.IBKR_REF || '',
    getUrl: (ticker, ref) => ref
      ? `https://www.interactivebrokers.com/mkt/?src=${ref}`
      : `https://www.interactivebrokers.com`,
    cta: 'Trade on IBKR',
    tagline: 'Low-cost global trading',
  },
  tradingview: {
    name: 'TradingView',
    ref: process.env.TRADINGVIEW_REF || '',
    getUrl: (ticker, ref) => {
      const t = (ticker || '').toUpperCase().replace('$', '');
      const base = `https://www.tradingview.com/symbols/${t}/`;
      return ref ? `${base}?aff_id=${ref}` : base;
    },
    cta: 'Chart on TradingView',
    tagline: 'Advanced charting & analysis',
  },
};

// Active partners — only those with a referral code
function getActivePartners() {
  return Object.values(PARTNERS).filter(p => p.ref);
}

// Rotate which partner gets the primary CTA (based on day of year)
function getPrimaryPartner() {
  const active = getActivePartners();
  if (active.length === 0) return PARTNERS.tastytrade; // fallback
  const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
  return active[dayOfYear % active.length];
}

/**
 * Get a research URL for a ticker (always TradingView — best for research).
 * This is what ticker links in the email point to.
 */
function getTickerUrl(ticker) {
  const t = (ticker || '').toUpperCase().replace('$', '');
  if (!t) return '#';
  const ref = PARTNERS.tradingview.ref;
  return ref
    ? `https://www.tradingview.com/symbols/${t}/?aff_id=${ref}`
    : `https://www.tradingview.com/symbols/${t}/`;
}

/**
 * Get a broker URL for a ticker (for "Trade this" CTAs).
 */
function getBrokerUrl(ticker, partnerKey) {
  const partner = partnerKey ? PARTNERS[partnerKey] : getPrimaryPartner();
  if (!partner) return '#';
  return partner.getUrl(ticker, partner.ref);
}

/**
 * Wrap a ticker in a research link for HTML emails.
 */
function tickerLink(ticker, style) {
  const url = getTickerUrl(ticker);
  const t = (ticker || '').toUpperCase().replace('$', '');
  const defaultStyle = 'color:#1a7a4c;text-decoration:underline;text-decoration-color:#1a7a4c;text-underline-offset:2px;font-weight:600;';
  return `<a href="${url}" style="${style || defaultStyle}" target="_blank">$${esc(t)}</a>`;
}

/**
 * Wrap a ticker as a bold research link (for headlines).
 */
function tickerLinkBold(ticker) {
  const url = getTickerUrl(ticker);
  const t = (ticker || '').toUpperCase().replace('$', '');
  return `<a href="${url}" style="color:#1a7a4c;text-decoration:underline;text-decoration-color:#1a7a4c;text-underline-offset:2px;font-size:15px;font-weight:700;" target="_blank">$${esc(t)}</a>`;
}

/**
 * Generate a broker CTA bar for a specific ticker.
 * Shows 1-3 broker buttons depending on how many affiliates are active.
 */
function brokerCta(ticker) {
  const active = getActivePartners();
  if (active.length === 0) return '';

  const t = (ticker || '').toUpperCase().replace('$', '');

  const buttons = active.slice(0, 3).map(p => {
    const url = p.getUrl(t, p.ref);
    return `<a href="${url}" style="display:inline-block;padding:6px 14px;margin-right:8px;margin-bottom:4px;border-radius:6px;border:1px solid #e0dbd3;color:#3d3d3d;font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:12px;text-decoration:none;font-weight:500;" target="_blank">${esc(p.cta)} &rarr;</a>`;
  }).join('');

  return `<p style="margin:10px 0 0;">${buttons}</p>`;
}

/**
 * Generate affiliate disclosure for the email footer.
 */
function affiliateDisclosure() {
  const active = getActivePartners();
  if (active.length === 0) return '';

  const names = active.map(p => p.name).join(', ');
  return `<p style="margin:8px 0 0;font-size:10px;color:#b0a99f;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    Links may go to ${esc(names)}. We may earn a commission if you sign up.
  </p>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  getTickerUrl,
  getBrokerUrl,
  tickerLink,
  tickerLinkBold,
  brokerCta,
  affiliateDisclosure,
  getActivePartners,
  getPrimaryPartner,
  PARTNERS,
};
