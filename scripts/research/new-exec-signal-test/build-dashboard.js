#!/usr/bin/env node
/**
 * Reads output/results.json and emits output/dashboard.html.
 * Pure CSS bar charts — no external JS libraries, one self-contained file.
 */
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'output');
const results = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'results.json'), 'utf8'));

const pct = v => (v == null || !isFinite(v)) ? '—' : `${(v * 100).toFixed(2)}%`;
const num = v => (v == null || !isFinite(v)) ? '—' : v.toFixed(2);
const int = v => (v == null) ? '—' : String(v);

function fmtP(p) {
  if (p == null || !isFinite(p)) return '—';
  if (p < 0.001) return '<0.001';
  if (p < 0.01) return p.toFixed(3);
  return p.toFixed(3);
}

const c1All = results.cohort1_all;
const c1RC = results.cohort1_roleConfirmed;
const c2 = results.cohort2;
const c3 = results.cohort3;
const meta = results.meta;
const tt = results.tTests?.cohort1_all_vs_cohort2 || {};

const heroDiff = (c1All?.[90]?.meanExcess != null && c2?.[90]?.meanExcess != null)
  ? (c1All[90].meanExcess - c2[90].meanExcess)
  : null;

function barRow(label, value, maxAbs, color) {
  const v = value || 0;
  const widthPct = maxAbs > 0 ? Math.min(100, (Math.abs(v) / maxAbs) * 100) : 0;
  const side = v >= 0 ? 'right' : 'left';
  return `<div class="bar-row">
    <div class="bar-label">${label}</div>
    <div class="bar-track">
      <div class="bar-fill bar-${side}" style="width:${widthPct}%; background:${color};"></div>
    </div>
    <div class="bar-val mono">${pct(v)}</div>
  </div>`;
}

function cohortTable(cohort, label) {
  if (!cohort) return '';
  const row = (h) => {
    const s = cohort[h] || {};
    const warn = s.underpowered ? '<span class="warn"> ⚠ N&lt;30</span>' : '';
    return `<tr>
      <td class="mono">${h}d</td>
      <td class="mono">${int(s.n)}${warn}</td>
      <td class="mono">${pct(s.meanReturn)}</td>
      <td class="mono">${pct(s.medianReturn)}</td>
      <td class="mono">${pct(s.meanExcess)}</td>
      <td class="mono">${pct(s.medianExcess)}</td>
      <td class="mono">${pct(s.winRate)}</td>
      <td class="mono">${pct(s.excessWinRate)}</td>
      <td class="mono">${pct(s.stdReturn)}</td>
    </tr>`;
  };
  return `<table class="data-table">
    <caption>${label}</caption>
    <thead><tr>
      <th>Horizon</th><th>N</th><th>Mean ret</th><th>Median ret</th>
      <th>Mean excess</th><th>Median excess</th><th>Win %</th><th>Excess win %</th><th>Std dev</th>
    </tr></thead>
    <tbody>${[30, 60, 90].map(row).join('')}</tbody>
  </table>`;
}

function maxAbsAcrossHorizons() {
  let m = 0;
  for (const h of [30, 60, 90]) {
    for (const c of [c1All, c1RC, c2, c3]) {
      if (c?.[h]?.meanExcess != null) m = Math.max(m, Math.abs(c[h].meanExcess));
    }
  }
  return m;
}
const maxAbs = maxAbsAcrossHorizons();

function chartSection(horizon) {
  const rows = [
    { label: 'Cohort 1 — new exec (all)', val: c1All?.[horizon]?.meanExcess, n: c1All?.[horizon]?.n, color: '#355E3B' },
    { label: 'Cohort 1 — role-confirmed', val: c1RC?.[horizon]?.meanExcess, n: c1RC?.[horizon]?.n, color: '#6B8E4E' },
    { label: 'Cohort 2 — placebo C-suite', val: c2?.[horizon]?.meanExcess, n: c2?.[horizon]?.n, color: '#B8845A' },
    { label: 'Cohort 3 — baseline', val: c3?.[horizon]?.meanExcess, n: c3?.[horizon]?.n, color: '#8A7F72' },
  ];
  return `<div class="chart">
    <h3>Mean excess return vs. SPY — ${horizon}-day horizon</h3>
    ${rows.map(r => `
      <div class="bar-row">
        <div class="bar-label">${r.label} <span class="n-badge mono">N=${int(r.n)}</span></div>
        <div class="bar-track">
          ${barFill(r.val, maxAbs, r.color)}
        </div>
        <div class="bar-val mono">${pct(r.val)}</div>
      </div>`).join('')}
  </div>`;
}

function barFill(v, maxAbs, color) {
  if (v == null) return '';
  const widthPct = maxAbs > 0 ? Math.min(100, (Math.abs(v) / maxAbs) * 50) : 0;
  if (v >= 0) {
    return `<div class="bar-center"></div><div class="bar-fill-right" style="width:${widthPct}%; background:${color};"></div>`;
  }
  return `<div class="bar-fill-left" style="width:${widthPct}%; background:${color};"></div><div class="bar-center"></div>`;
}

function subBucketTable(buckets, title, keyLabel) {
  if (!buckets || !Object.keys(buckets).length) return '';
  const keys = Object.keys(buckets).sort();
  const header = `<th>${keyLabel}</th><th>N (90d)</th><th>Mean ret 90d</th><th>Mean excess 90d</th><th>Win % 90d</th><th>Excess win % 90d</th>`;
  const rows = keys.map(k => {
    const s = buckets[k]?.[90] || {};
    const warn = s.underpowered ? '<span class="warn"> ⚠</span>' : '';
    return `<tr>
      <td>${k}</td>
      <td class="mono">${int(s.n)}${warn}</td>
      <td class="mono">${pct(s.meanReturn)}</td>
      <td class="mono">${pct(s.meanExcess)}</td>
      <td class="mono">${pct(s.winRate)}</td>
      <td class="mono">${pct(s.excessWinRate)}</td>
    </tr>`;
  }).join('');
  return `<table class="data-table">
    <caption>${title}</caption>
    <thead><tr>${header}</tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Does insider buying from newly-appointed execs outperform? — Buyside Brief research</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #FAF8F5;
    --ink: #1C1C1E;
    --muted: #6B6B6B;
    --rule: #D8D4CC;
    --accent: #355E3B;
    --warn: #B8845A;
    --chip: #EFE9DF;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--bg);
    color: var(--ink);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    margin: 0;
    padding: 0;
    line-height: 1.55;
  }
  .container { max-width: 1040px; margin: 0 auto; padding: 56px 40px 80px; }
  .eyebrow {
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.15em;
    color: var(--muted);
    font-weight: 600;
  }
  h1 {
    font-family: 'DM Serif Display', Georgia, serif;
    font-weight: 400;
    font-size: 44px;
    line-height: 1.15;
    margin: 6px 0 10px;
    letter-spacing: -0.01em;
  }
  h2 {
    font-family: 'DM Serif Display', Georgia, serif;
    font-weight: 400;
    font-size: 28px;
    margin: 40px 0 14px;
    letter-spacing: -0.01em;
  }
  h3 { font-size: 16px; font-weight: 600; margin: 18px 0 10px; }
  p, li { font-size: 15px; }
  .sub { color: var(--muted); font-size: 14px; }
  .mono { font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace; }

  .hero {
    background: var(--chip);
    border: 1px solid var(--rule);
    border-radius: 10px;
    padding: 28px 32px;
    margin: 28px 0 36px;
  }
  .hero .stat {
    font-family: 'DM Serif Display', Georgia, serif;
    font-size: 54px;
    line-height: 1;
    color: var(--accent);
  }
  .hero .label {
    margin-top: 10px;
    font-size: 15px;
    color: var(--ink);
  }

  .chart { margin: 18px 0 32px; }
  .bar-row {
    display: grid;
    grid-template-columns: 280px 1fr 90px;
    align-items: center;
    column-gap: 14px;
    padding: 4px 0;
    font-size: 14px;
  }
  .bar-label { color: var(--ink); }
  .n-badge { color: var(--muted); font-size: 12px; margin-left: 6px; }
  .bar-track {
    position: relative;
    height: 22px;
    background: transparent;
    display: grid;
    grid-template-columns: 1fr 1fr;
  }
  .bar-center { border-left: 1px dashed var(--rule); }
  .bar-fill-right { height: 22px; align-self: center; grid-column: 2 / 3; border-radius: 0 2px 2px 0; }
  .bar-fill-left { height: 22px; align-self: center; grid-column: 1 / 2; border-radius: 2px 0 0 2px; justify-self: end; }
  .bar-val { text-align: right; font-size: 14px; }

  .data-table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0 24px;
    font-size: 14px;
  }
  .data-table caption {
    text-align: left;
    font-weight: 600;
    padding: 8px 0;
    color: var(--ink);
  }
  .data-table th, .data-table td {
    text-align: right;
    padding: 8px 10px;
    border-bottom: 1px solid var(--rule);
  }
  .data-table th:first-child, .data-table td:first-child { text-align: left; }
  .data-table thead th {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    font-weight: 600;
    border-bottom: 2px solid var(--ink);
  }
  .warn { color: var(--warn); font-size: 12px; }

  .row-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
  @media (max-width: 780px) {
    .row-pair { grid-template-columns: 1fr; }
    .bar-row { grid-template-columns: 1fr; }
  }

  .tests { margin: 16px 0; font-size: 14px; }
  .test-line { padding: 6px 0; border-bottom: 1px dotted var(--rule); }

  footer {
    margin-top: 56px;
    padding-top: 24px;
    border-top: 1px solid var(--rule);
    color: var(--muted);
    font-size: 13px;
  }
  footer code { background: var(--chip); padding: 1px 6px; border-radius: 3px; font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .methodology dt { font-weight: 600; color: var(--ink); margin-top: 10px; }
  .methodology dd { margin: 2px 0 0 0; }
</style>
</head>
<body>
<div class="container">
  <div class="eyebrow">Buyside Brief — research</div>
  <h1>Do insider buys from newly-appointed executives outperform?</h1>
  <p class="sub">A clean-room backtest of SEC Form 4 purchase transactions against 8-K Item 5.02 appointments, ${meta.windows.form4.start} through ${meta.windows.form4.end}.</p>

  <div class="hero">
    <div class="stat mono">${heroDiff == null ? '—' : (heroDiff >= 0 ? '+' : '') + (heroDiff * 100).toFixed(2) + '%'}</div>
    <div class="label">
      90-day mean excess-return difference: <strong>new-exec cohort</strong> vs. <strong>stable-C-suite placebo</strong>.
      ${c1All?.[90]?.n != null && c2?.[90]?.n != null ? `(N=${c1All[90].n} vs N=${c2[90].n}; p=${fmtP(tt?.[90]?.p)})` : ''}
    </div>
  </div>

  <h2>Mean excess return vs. SPY, by cohort</h2>
  ${chartSection(30)}
  ${chartSection(60)}
  ${chartSection(90)}

  <h2>Full cohort tables</h2>
  <div>
    ${cohortTable(c1All, 'Cohort 1 — New executive buy (all matches)')}
    ${cohortTable(c1RC, 'Cohort 1 — New executive buy (role-confirmed only, high-confidence name match)')}
    ${cohortTable(c2, 'Cohort 2 — Placebo: stable C-suite (no 8-K 5.02 in prior 180 days)')}
    ${cohortTable(c3, 'Cohort 3 — Baseline: all qualifying Form 4 P-buys')}
  </div>

  <h2>Sub-cohort breakdown (Cohort 1)</h2>
  <div class="row-pair">
    ${subBucketTable(results.subBuckets?.cohort1_byRole, 'By role category', 'Role')}
    ${subBucketTable(results.subBuckets?.cohort1_byTenureBucket, 'By tenure bucket (days since appointment)', 'Tenure')}
  </div>

  <h2>Statistical tests</h2>
  <div class="tests">
    ${[30, 60, 90].map(h => {
      const t = tt?.[h] || {};
      const rcT = results.tTests?.cohort1_roleConfirmed_vs_cohort2?.[h] || {};
      return `<div class="test-line">
        <strong>${h}-day excess return — Cohort 1 (all) vs Cohort 2:</strong>
        <span class="mono">t=${num(t.t)}, p=${fmtP(t.p)}, Δmean=${pct(t.meanDiff)}, N=${int(t.n1)}/${int(t.n2)}</span><br>
        <span class="sub">— role-confirmed variant: <span class="mono">t=${num(rcT.t)}, p=${fmtP(rcT.p)}, Δmean=${pct(rcT.meanDiff)}, N=${int(rcT.n1)}/${int(rcT.n2)}</span></span>
      </div>`;
    }).join('')}
    <p class="sub">Welch's two-sample t-test with normal approximation for p-values. Treat with care when N&lt;30 on either side.</p>
  </div>

  <footer>
    <h2 style="margin-top:0">Methodology</h2>
    <dl class="methodology">
      <dt>Universe</dt><dd>NYSE + Nasdaq (XNYS / XNAS / XASE) active US stocks, price ≥ $2 at transaction. ${int(meta.filters?.universeSize)} tickers in the universe snapshot.</dd>
      <dt>Form 4 filter</dt><dd>Transaction code <code>P</code> (purchase), Acquired-Disposed code <code>A</code>.</dd>
      <dt>Cohort 1 definition</dt><dd>Buyer named in an 8-K Item 5.02 appointment/promotion at the same CIK within 90 days prior to the transaction. Two variants: "all" (headline) and "role-confirmed" (role≠Unknown AND name-match confidence=high).</dd>
      <dt>Cohort 2 definition</dt><dd>C-suite buyer (officer; title contains CEO / CFO / COO / President) with NO 8-K Item 5.02 at the same CIK in the prior 180 days.</dd>
      <dt>Cohort 3</dt><dd>All qualifying Form 4 P-buys (baseline). Price pulls sampled to 500 to cap Polygon free-tier calls.</dd>
      <dt>Forward returns</dt><dd>Entry = closing price on Form 4 <em>transaction</em> date (not filing date). Exit = closing price at +30 / +60 / +90 calendar days, rolled forward to next trading day for weekends/holidays.</dd>
      <dt>Excess return</dt><dd>Ticker return minus SPY return over the same window.</dd>
      <dt>Sample sizes</dt><dd>
        Form 4 total: ${int(meta.sampleSizes?.form4Total)} |
        after clean: ${int(meta.sampleSizes?.form4Clean)} |
        $2 floor: ${int(meta.sampleSizes?.afterPriceFloor)} |
        exchange: ${int(meta.sampleSizes?.afterExchangeFilter)} |
        appointments: ${int(meta.sampleSizes?.appointmentsExtracted)} |
        cohort 1 all: ${int(meta.sampleSizes?.cohort1_all)} |
        cohort 1 role-confirmed: ${int(meta.sampleSizes?.cohort1_roleConfirmed)} |
        cohort 2: ${int(meta.sampleSizes?.cohort2)}.
      </dd>
      <dt>Data sources</dt><dd>SEC EDGAR (efts.sec.gov full-text search + /Archives/ document pulls). Prices via Polygon daily aggregates (adjusted).</dd>
      <dt>Caveats</dt><dd>8-K Item 5.02 appointee extraction is regex-based and imperfect — role=Unknown entries are retained in cohort 1 "all" but excluded from the role-confirmed variant. Ambiguous matches are logged to <code>ambiguous-matches.json</code> for manual review. Some recent buys are excluded from the 90-day bucket because the forward window extends past the data availability date (${meta.windows.priceMax}).</dd>
    </dl>
    <p class="sub">Generated ${meta.generatedAt}.</p>
  </footer>
</div>
</body>
</html>`;

fs.writeFileSync(path.join(OUT_DIR, 'dashboard.html'), html);
console.log(`Wrote ${path.join(OUT_DIR, 'dashboard.html')}`);
