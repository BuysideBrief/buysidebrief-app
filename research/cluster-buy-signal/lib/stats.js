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
  const denom = Math.sqrt(va / a.length + vb / b.length);
  if (!denom) return { t: null, p: null, reason: 'zero-variance' };
  const t = (ma - mb) / denom;
  const absT = Math.abs(t);
  const p = 2 * (1 - normCdf(absT));
  return { t, p, meanDiff: ma - mb, n1: a.length, n2: b.length };
}

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.39894228 * Math.exp(-x * x / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

function summarize(values) {
  const v = values.filter(x => x != null && isFinite(x));
  return {
    n: v.length,
    mean: mean(v),
    median: median(v),
    std: stddev(v),
    winRate: winRate(v),
    underpowered: v.length < 30,
  };
}

/**
 * OLS multiple regression with HC0 (heteroskedasticity-robust) standard errors,
 * via straightforward (X'X)^-1 X'y. Includes intercept in X. Returns coef estimates,
 * SEs, t-stats, two-sided p-values, R^2, n.
 *
 * Inputs:
 *   X — array of feature rows (each row an array of numbers, no intercept column)
 *   y — array of outcomes (same length as X)
 *   names — array of feature names matching X columns (intercept name added automatically)
 */
function olsRegression(X, y, names) {
  const n = X.length;
  if (!n || X[0].length + 1 > n) return { error: 'insufficient-data', n };
  const k = X[0].length + 1; // +1 for intercept
  // Build design matrix with intercept column
  const Xd = X.map(row => [1, ...row]);
  const cols = ['(Intercept)', ...names];

  // X'X (k x k)
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) XtX[r][c] += Xd[i][r] * Xd[i][c];
  }
  // X'y (k)
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let r = 0; r < k; r++) Xty[r] += Xd[i][r] * y[i];
  }
  // Solve via Gauss-Jordan inverse of XtX
  const inv = invertMatrix(XtX);
  if (!inv) return { error: 'singular-matrix', n };
  // beta = inv(X'X) * X'y
  const beta = new Array(k).fill(0);
  for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) beta[r] += inv[r][c] * Xty[c];

  // Residuals
  const yhat = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let r = 0; r < k; r++) yhat[i] += Xd[i][r] * beta[r];
  const resid = y.map((yi, i) => yi - yhat[i]);
  const rss = resid.reduce((s, e) => s + e * e, 0);
  const yMean = mean(y);
  const tss = y.reduce((s, yi) => s + (yi - yMean) ** 2, 0);
  const r2 = 1 - rss / tss;

  // HC0 robust SE: inv(X'X) * X' diag(e^2) X * inv(X'X)
  const meatXt = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) {
    const e2 = resid[i] * resid[i];
    for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) meatXt[r][c] += Xd[i][r] * Xd[i][c] * e2;
  }
  // var(beta) = inv * meat * inv
  const tmp = matMul(inv, meatXt);
  const varBeta = matMul(tmp, inv);

  const coefs = beta.map((b, i) => {
    const se = Math.sqrt(Math.max(0, varBeta[i][i]));
    const t = se ? b / se : null;
    const p = t == null ? null : 2 * (1 - normCdf(Math.abs(t)));
    return { name: cols[i], coef: b, se, t, p };
  });

  return { n, k, r2, coefs };
}

function invertMatrix(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...row.map((_, j) => i === j ? 1 : 0)]);
  for (let i = 0; i < n; i++) {
    // find pivot
    let pivot = i;
    for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[pivot][i])) pivot = r;
    if (Math.abs(M[pivot][i]) < 1e-12) return null;
    [M[i], M[pivot]] = [M[pivot], M[i]];
    const div = M[i][i];
    for (let c = 0; c < 2 * n; c++) M[i][c] /= div;
    for (let r = 0; r < n; r++) {
      if (r === i) continue;
      const factor = M[r][i];
      for (let c = 0; c < 2 * n; c++) M[r][c] -= factor * M[i][c];
    }
  }
  return M.map(row => row.slice(n));
}

function matMul(A, B) {
  const n = A.length, m = B[0].length, p = B.length;
  const C = Array.from({ length: n }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let k = 0; k < p; k++) {
    const a = A[i][k];
    for (let j = 0; j < m; j++) C[i][j] += a * B[k][j];
  }
  return C;
}

if (require.main === module) {
  // Quick sanity check on Welch + regression
  const a = [0.05, 0.07, 0.06, 0.04, 0.08, 0.05, 0.06];
  const b = [0.01, 0.00, -0.02, 0.03, 0.01, 0.02, 0.00];
  const t = welchTTest(a, b);
  if (t.meanDiff <= 0 || t.p > 0.05) throw new Error(`Expected significant positive diff, got ${JSON.stringify(t)}`);

  // Regression sanity: y = 2 + 3*x1 - 1*x2 + small noise
  const X = [], y = [];
  let seed = 42;
  function rnd() { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; }
  for (let i = 0; i < 200; i++) {
    const x1 = rnd(), x2 = rnd();
    X.push([x1, x2]);
    y.push(2 + 3 * x1 - 1 * x2 + (rnd() - 0.5) * 0.05);
  }
  const reg = olsRegression(X, y, ['x1', 'x2']);
  if (Math.abs(reg.coefs[1].coef - 3) > 0.1) throw new Error(`x1 coef ${reg.coefs[1].coef}, expected ~3`);
  if (Math.abs(reg.coefs[2].coef + 1) > 0.1) throw new Error(`x2 coef ${reg.coefs[2].coef}, expected ~-1`);
  console.log('stats sanity OK');
}

module.exports = { mean, median, stddev, winRate, welchTTest, summarize, olsRegression };
