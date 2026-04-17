function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function stddev(arr) {
  if (arr.length < 2) return null;
  const mu = mean(arr);
  const v = arr.reduce((s, x) => s + (x - mu) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(v);
}

function winRate(arr, threshold = 0) {
  if (!arr.length) return null;
  return arr.filter(x => x > threshold).length / arr.length;
}

/**
 * Welch's two-sample t-test (unequal variances). Returns t-stat and two-sided
 * p-value approximated via the normal CDF (valid when both samples are large).
 */
function welchTTest(a, b) {
  if (a.length < 2 || b.length < 2) return { t: null, p: null, reason: 'insufficient-sample' };
  const ma = mean(a), mb = mean(b);
  const va = stddev(a) ** 2, vb = stddev(b) ** 2;
  const t = (ma - mb) / Math.sqrt(va / a.length + vb / b.length);
  // Normal approximation for two-sided p-value — fine for N≥30 per side
  const absT = Math.abs(t);
  const p = 2 * (1 - normCdf(absT));
  return { t, p, meanDiff: ma - mb, n1: a.length, n2: b.length };
}

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.39894228 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

/**
 * Summarize a cohort's returns at a given horizon.
 * `rows` = array of { return, excess }
 */
function summarize(rows) {
  const returns = rows.map(r => r.return).filter(r => r != null && isFinite(r));
  const excess = rows.map(r => r.excess).filter(r => r != null && isFinite(r));
  return {
    n: returns.length,
    meanReturn: mean(returns),
    medianReturn: median(returns),
    stdReturn: stddev(returns),
    meanExcess: mean(excess),
    medianExcess: median(excess),
    stdExcess: stddev(excess),
    winRate: winRate(returns),
    excessWinRate: winRate(excess),
    underpowered: returns.length < 30,
  };
}

module.exports = { mean, median, stddev, winRate, welchTTest, summarize };
