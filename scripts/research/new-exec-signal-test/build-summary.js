#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, 'output');
const results = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'results.json'), 'utf8'));

const pct = v => (v == null || !isFinite(v)) ? '—' : `${(v * 100).toFixed(2)}%`;
const num = v => (v == null || !isFinite(v)) ? '—' : v.toFixed(3);
function fmtP(p) {
  if (p == null || !isFinite(p)) return '—';
  if (p < 0.001) return '<0.001';
  return p.toFixed(3);
}

const c1 = results.cohort1_all;
const c1rc = results.cohort1_roleConfirmed;
const c2 = results.cohort2;
const c3 = results.cohort3;
const meta = results.meta;
const tt = results.tTests?.cohort1_all_vs_cohort2 || {};
const ttRC = results.tTests?.cohort1_roleConfirmed_vs_cohort2 || {};

const heroDiff90 = (c1?.[90]?.meanExcess != null && c2?.[90]?.meanExcess != null)
  ? (c1[90].meanExcess - c2[90].meanExcess) : null;

const directionWord = heroDiff90 == null
  ? 'inconclusive'
  : heroDiff90 > 0.005 ? 'outperformed'
  : heroDiff90 < -0.005 ? 'underperformed'
  : 'roughly matched';

const sig90 = tt?.[90]?.p != null ? (tt[90].p < 0.05 ? 'statistically significant at p<0.05' : `not significant (p=${fmtP(tt[90].p)})`) : 'no p-value available';

function subBucketRows(buckets) {
  if (!buckets) return '_no data_';
  const keys = Object.keys(buckets).sort();
  if (!keys.length) return '_no data_';
  let out = '| Bucket | N (90d) | Mean ret 90d | Mean excess 90d | Win % | Excess win % |\n';
  out += '|---|---:|---:|---:|---:|---:|\n';
  for (const k of keys) {
    const s = buckets[k]?.[90] || {};
    const warn = s.underpowered ? ' ⚠' : '';
    out += `| ${k} | ${s.n ?? '—'}${warn} | ${pct(s.meanReturn)} | ${pct(s.meanExcess)} | ${pct(s.winRate)} | ${pct(s.excessWinRate)} |\n`;
  }
  return out;
}

function cohortTable(c, label) {
  let out = `### ${label}\n\n| Horizon | N | Mean ret | Median ret | Mean excess | Median excess | Win % | Excess win % | Std dev |\n`;
  out += '|---|---:|---:|---:|---:|---:|---:|---:|---:|\n';
  for (const h of [30, 60, 90]) {
    const s = c?.[h] || {};
    const warn = s.underpowered ? ' ⚠' : '';
    out += `| ${h}d | ${s.n ?? '—'}${warn} | ${pct(s.meanReturn)} | ${pct(s.medianReturn)} | ${pct(s.meanExcess)} | ${pct(s.medianExcess)} | ${pct(s.winRate)} | ${pct(s.excessWinRate)} | ${pct(s.stdReturn)} |\n`;
  }
  return out;
}

const md = `# Do insider buys from newly-appointed executives outperform?

_A clean-room backtest. ${meta.windows.form4.start} through ${meta.windows.form4.end}. Generated ${meta.generatedAt}._

## TL;DR

At a 90-day horizon, the new-executive cohort ${directionWord} the stable-C-suite placebo by **${heroDiff90 == null ? '—' : (heroDiff90 * 100).toFixed(2) + ' pp'}** in mean excess return vs. SPY (${sig90}; N=${c1?.[90]?.n ?? '—'} vs ${c2?.[90]?.n ?? '—'}).

## Why we ran this

Buyside Brief scores SEC Form 4 insider buys and publishes daily picks. We wanted to test a specific hypothesis that comes up often in insider-buying research: buys from executives who were recently appointed (via 8-K Item 5.02) carry more signal than buys from long-tenured executives, because new appointees are deploying personal capital behind their own fresh mandate. If the signal is real, we'll fold it into the conviction model. Either outcome is worth publishing — negative results are useful.

## Methodology

### Universe
- **Exchanges:** NYSE, Nasdaq, NYSE American (XNYS / XNAS / XASE). Universe snapshot size: **${meta.filters?.universeSize ?? '—'}** tickers.
- **Filter:** Form 4 transaction code \`P\` (purchase), Acquired-Disposed \`A\`, price ≥ $2.
- **Window:** Form 4 transactions ${meta.windows.form4.start} to ${meta.windows.form4.end}; 8-K Item 5.02 lookback from ${meta.windows.k8.start} (180 days before Form 4 window start).

### Cohorts
- **Cohort 1 — New executive buy (two variants):**
  - _All matches_ — Form 4 buyer named in an 8-K Item 5.02 appointment/promotion at the same CIK, effective ≤ 90 days before the transaction. Any match confidence, any role.
  - _Role-confirmed only_ — Restricted to role ≠ Unknown AND name-match confidence = high. Robustness check against parser noise.
- **Cohort 2 — Placebo (stable C-suite):** Officer with a C-suite title (CEO / CFO / COO / President) at a company with NO 8-K Item 5.02 in the prior 180 days. Designed to isolate "exec buys at stable companies."
- **Cohort 3 — Baseline:** All qualifying Form 4 P-buys. Sampled (head-500) for price pulls to stay inside Polygon free-tier limits.

### Forward returns
- Entry: closing price on Form 4 _transaction_ date (not filing date).
- Exit: +30 / +60 / +90 calendar days, rolled forward to next trading day.
- Excess return: ticker return minus SPY return over the same window.
- Simple returns, no dividends beyond adjusted close.

### Data sources
- SEC EDGAR: \`efts.sec.gov\` full-text search for filings; \`www.sec.gov/Archives/\` for documents.
- Prices: Polygon adjusted daily aggregates, 5 req/min free tier with exponential backoff on 429.

## Sample sizes

| Stage | Count |
|---|---:|
| Form 4 filings with P-tx returned | ${meta.sampleSizes?.form4Total ?? '—'} |
| After clean/parse | ${meta.sampleSizes?.form4Clean ?? '—'} |
| After $2 price floor | ${meta.sampleSizes?.afterPriceFloor ?? '—'} |
| After NYSE/Nasdaq exchange filter | ${meta.sampleSizes?.afterExchangeFilter ?? '—'} |
| 8-K Item 5.02 appointments extracted | ${meta.sampleSizes?.appointmentsExtracted ?? '—'} |
| Cohort 1 (all matches) | ${meta.sampleSizes?.cohort1_all ?? '—'} |
| Cohort 1 (role-confirmed only) | ${meta.sampleSizes?.cohort1_roleConfirmed ?? '—'} |
| Cohort 2 (placebo) | ${meta.sampleSizes?.cohort2 ?? '—'} |
| Cohort 3 (baseline, sampled for prices) | ${meta.sampleSizes?.cohort3_sampled ?? '—'} / ${meta.sampleSizes?.cohort3_full ?? '—'} |
| Ambiguous matches (audit file) | ${meta.sampleSizes?.ambiguousMatches ?? '—'} |
| Form 4 XML fetch errors | ${meta.sampleSizes?.form4Errors ?? 0} |

## Headline results

${cohortTable(c1, 'Cohort 1 — new executive buys (all matches)')}

${cohortTable(c1rc, 'Cohort 1 — new executive buys (role-confirmed only)')}

${cohortTable(c2, 'Cohort 2 — placebo (stable C-suite)')}

${cohortTable(c3, 'Cohort 3 — baseline (all qualifying P-buys)')}

## Statistical tests (Welch's two-sample t-test)

| Horizon | Test | t | p | Δ mean excess | N₁ / N₂ |
|---|---|---:|---:|---:|---:|
| 30d | C1(all) vs C2 | ${num(tt?.[30]?.t)} | ${fmtP(tt?.[30]?.p)} | ${pct(tt?.[30]?.meanDiff)} | ${tt?.[30]?.n1 ?? '—'} / ${tt?.[30]?.n2 ?? '—'} |
| 60d | C1(all) vs C2 | ${num(tt?.[60]?.t)} | ${fmtP(tt?.[60]?.p)} | ${pct(tt?.[60]?.meanDiff)} | ${tt?.[60]?.n1 ?? '—'} / ${tt?.[60]?.n2 ?? '—'} |
| 90d | C1(all) vs C2 | ${num(tt?.[90]?.t)} | ${fmtP(tt?.[90]?.p)} | ${pct(tt?.[90]?.meanDiff)} | ${tt?.[90]?.n1 ?? '—'} / ${tt?.[90]?.n2 ?? '—'} |
| 30d | C1(role-conf) vs C2 | ${num(ttRC?.[30]?.t)} | ${fmtP(ttRC?.[30]?.p)} | ${pct(ttRC?.[30]?.meanDiff)} | ${ttRC?.[30]?.n1 ?? '—'} / ${ttRC?.[30]?.n2 ?? '—'} |
| 60d | C1(role-conf) vs C2 | ${num(ttRC?.[60]?.t)} | ${fmtP(ttRC?.[60]?.p)} | ${pct(ttRC?.[60]?.meanDiff)} | ${ttRC?.[60]?.n1 ?? '—'} / ${ttRC?.[60]?.n2 ?? '—'} |
| 90d | C1(role-conf) vs C2 | ${num(ttRC?.[90]?.t)} | ${fmtP(ttRC?.[90]?.p)} | ${pct(ttRC?.[90]?.meanDiff)} | ${ttRC?.[90]?.n1 ?? '—'} / ${ttRC?.[90]?.n2 ?? '—'} |

Normal approximation for p-values. Treat N<30 results with caution — flagged ⚠ in tables.

## Sub-cohort breakdown (Cohort 1, 90-day)

### By role
${subBucketRows(results.subBuckets?.cohort1_byRole)}

### By tenure bucket (days since appointment)
${subBucketRows(results.subBuckets?.cohort1_byTenureBucket)}

## Caveats

1. **Sample size.** Even over a full 12 months, the new-exec cohort is naturally rare — most newly-appointed executives don't file personal-account buys within 90 days. Sub-buckets by role and tenure are likely underpowered; interpret with caution.
2. **8-K Item 5.02 parsing is heuristic.** The appointee-name extractor is regex-based. Some real appointees are missed; some false "company name" matches are filtered out via a stop-word list but a few may slip through. The role-confirmed variant is the robustness check.
3. **Survivorship bias.** We exclude Form 4 buys where the forward window extends past the data availability date (${meta.windows.priceMax}) — this drops some late-period buys but doesn't introduce a direction bias.
4. **Lookahead.** Entry price is the _transaction_ date close, not the filing date. This is realistic for someone who is the insider themselves. An outsider trying to replicate would enter at the filing-date close, which could differ by several trading days. Not modeled here.
5. **Baseline overlap.** Cohort 3 (baseline) includes both cohort 1 and cohort 2 buyers. It's a universe measure, not a clean control.
6. **Tenure measurement.** Uses the 8-K effective date when extractable, else falls back to the 8-K filing date. For promotions that were pre-announced, effective date vs. announcement date can differ.

## What we're doing with this

${heroDiff90 == null ? '_TBD — requires completed run_' : heroDiff90 > 0 ? '**Adding to the scoring model, with a weight proportional to the observed edge and tenure bucket.** A +3-5 point bonus for new-exec buys (0–90 day tenure) with a stronger weight for the 0–30 day bucket, subject to the role-confirmed robustness check holding up.' : '**Not adding to the scoring model.** The new-exec signal did not beat the stable-C-suite placebo on the primary headline metric. We may revisit with a longer window or a different cohort definition.'}

---

_Audit trail: raw cohort records in \`cohort1-full.json\`; ambiguous matches in \`ambiguous-matches.json\`; per-day EDGAR caches in \`cache/form4/\` and \`cache/8k/\`; per-ticker price bars in \`cache/prices/\`. Full re-run reproducible via \`node run-full.js\`._
`;

fs.writeFileSync(path.join(OUT_DIR, 'summary.md'), md);
console.log(`Wrote ${path.join(OUT_DIR, 'summary.md')}`);
