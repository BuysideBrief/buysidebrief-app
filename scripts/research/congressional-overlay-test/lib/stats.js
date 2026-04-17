function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function median(a) { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function stddev(a) { if (a.length < 2) return null; const mu = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1)); }
function winRate(a, t = 0) { return a.length ? a.filter(x => x > t).length / a.length : null; }

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.39894228 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

function welchTTest(a, b) {
  if (a.length < 2 || b.length < 2) return { t: null, p: null, reason: 'insufficient-sample' };
  const ma = mean(a), mb = mean(b);
  const va = stddev(a) ** 2, vb = stddev(b) ** 2;
  const t = (ma - mb) / Math.sqrt(va / a.length + vb / b.length);
  const p = 2 * (1 - normCdf(Math.abs(t)));
  return { t, p, meanDiff: ma - mb, n1: a.length, n2: b.length };
}

function summarize(rows) {
  const rets = rows.map(r => r.return).filter(r => r != null && isFinite(r));
  const ex = rows.map(r => r.excess).filter(r => r != null && isFinite(r));
  return {
    n: rets.length,
    meanReturn: mean(rets), medianReturn: median(rets), stdReturn: stddev(rets),
    meanExcess: mean(ex), medianExcess: median(ex), stdExcess: stddev(ex),
    winRate: winRate(rets), excessWinRate: winRate(ex),
    underpowered: rets.length < 30,
  };
}

module.exports = { mean, median, stddev, winRate, welchTTest, summarize };
