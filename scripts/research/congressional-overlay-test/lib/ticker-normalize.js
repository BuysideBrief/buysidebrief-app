/**
 * Normalize tickers across sources.
 * Form 4 XML: uses dot-separated class shares (BRK.B, BF.B)
 * House PTRs: mostly no class suffix, sometimes dot, occasionally dash
 * Polygon: accepts both but canonical is dot-separated for class shares
 *
 * Strategy: strip everything non-alphanumeric, then treat `X.Y` and `X-Y`
 * as equivalent for matching. Canonical output uses dot.
 */
function normalize(raw) {
  if (!raw) return '';
  const s = String(raw).trim().toUpperCase();
  // Collapse BRK-B / BRK.B / BRKB into BRK.B canonical
  const m = s.match(/^([A-Z]{1,5})[.\-]([A-Z]{1,3})$/);
  if (m) return `${m[1]}.${m[2]}`;
  return s.replace(/[^A-Z0-9]/g, '');
}

function equivalent(a, b) {
  return normalize(a) === normalize(b);
}

module.exports = { normalize, equivalent };
