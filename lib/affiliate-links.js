/**
 * Affiliate Link Helper
 * 
 * Wraps $TICKER mentions in affiliate links.
 * Configure your affiliate platform and ID via env vars.
 * 
 * Supported platforms:
 *   - TradingView (default)
 *   - Seeking Alpha
 *   - Yahoo Finance (fallback, no affiliate)
 * 
 * Env vars:
 *   AFFILIATE_PLATFORM = "tradingview" | "seekingalpha" | "yahoo"
 *   AFFILIATE_ID = your affiliate/referral ID
 */

const PLATFORM = (process.env.AFFILIATE_PLATFORM || 'tastytrade').toLowerCase();
const AFF_ID = process.env.AFFILIATE_ID || '8K8P8N4D73';

/**
 * Get an affiliate URL for a ticker.
 */
function getTickerUrl(ticker) {
  const t = (ticker || '').toUpperCase().replace('$', '');
  if (!t) return '#';

  switch (PLATFORM) {
    case 'tastytrade':
      return `https://tastytrade.com/welcome/?referralCode=${AFF_ID}`;

    case 'tradingview':
      const tvBase = `https://www.tradingview.com/symbols/${t}/`;
      return AFF_ID ? `${tvBase}?aff_id=${AFF_ID}` : tvBase;

    case 'seekingalpha':
      const saBase = `https://seekingalpha.com/symbol/${t}`;
      return AFF_ID ? `${saBase}?source=${AFF_ID}` : saBase;

    case 'yahoo':
      return `https://finance.yahoo.com/quote/${t}`;

    default:
      return `https://tastytrade.com/welcome/?referralCode=${AFF_ID}`;
  }
}

/**
 * Wrap a ticker in an affiliate link for HTML emails.
 */
function tickerLink(ticker, style) {
  const url = getTickerUrl(ticker);
  const t = (ticker || '').toUpperCase().replace('$', '');
  const defaultStyle = 'color:#1a1a1a;text-decoration:none;border-bottom:1px dotted #e0dbd3;';
  return `<a href="${url}" style="${style || defaultStyle}" target="_blank">$${esc(t)}</a>`;
}

/**
 * Wrap a ticker as a bold affiliate link (for headlines).
 */
function tickerLinkBold(ticker) {
  const url = getTickerUrl(ticker);
  const t = (ticker || '').toUpperCase().replace('$', '');
  return `<a href="${url}" style="color:#1a1a1a;text-decoration:none;font-weight:700;border-bottom:1px dotted #e0dbd3;" target="_blank">$${esc(t)}</a>`;
}

/**
 * Get the platform name for disclosure.
 */
function getPlatformName() {
  switch (PLATFORM) {
    case 'tastytrade': return 'tastytrade';
    case 'tradingview': return 'TradingView';
    case 'seekingalpha': return 'Seeking Alpha';
    case 'yahoo': return 'Yahoo Finance';
    default: return 'tastytrade';
  }
}

/**
 * Generate a small affiliate disclosure line for the email footer.
 * Only shows if an affiliate ID is configured.
 */
function affiliateDisclosure() {
  if (!AFF_ID) return '';
  return `<p style="margin:8px 0 0;font-size:10px;color:#b0a99f;font-family:-apple-system,Helvetica,Arial,sans-serif;">
    Ticker links go to ${getPlatformName()}. We may earn a commission if you sign up.
  </p>`;
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = {
  getTickerUrl,
  tickerLink,
  tickerLinkBold,
  affiliateDisclosure,
  getPlatformName,
};
