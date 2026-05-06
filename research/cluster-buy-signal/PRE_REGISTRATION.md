# Cluster Buy Signal Backtest — Pre-registration

**Date committed:** 2026-05-06
**Author:** Pete / Buyside Brief
**Status:** Pre-analysis. This document is committed before any data is pulled or analyzed.

## Hypothesis

Form 4 open-market purchases at companies where 2+ distinct insiders bought within an N-day window will produce higher excess returns vs. SPY at 30/60/90 days than solo-insider buys, after controlling for market capitalization and buy value.

## Why this matters

Cluster buying is currently scored in production at +25 each (3+ insiders) and +10 each (paired). This weighting was reduced from +40 after a prior backfill analysis. This experiment tests whether the current weighting is appropriate, whether it should be increased or decreased, or whether the signal is confounded with size and market cap and should be removed entirely.

## Cohorts

For each of four windows (N = 3, 7, 14, 30 days), every qualifying filing is assigned to one cohort:

- **solo** — no other Form 4 buys at the same ticker within ±N days
- **paired** — exactly 2 distinct CIKs within window
- **cluster** — 3–4 distinct CIKs within window
- **mega_cluster** — 5+ distinct CIKs within window

For non-solo cohorts, additional composition tagging:

- **officer_only** — all participants are c-suite, VP-tier, or other officer
- **director_only** — all participants are directors
- **mixed** — any combination
- **owner_involved** — non-exclusive flag for any 10%+ owner in group

## Data scope

- Period: 2025-04-01 to 2026-04-01 (12 months)
- SEC Form 4, transaction code "P" (open-market purchase)
- NYSE / Nasdaq listed only
- Individual insiders only (institutional entities excluded)
- Buy value ≥ $10,000
- Stock price ≥ $1 at filing date

## Outcome variable

Excess return vs. SPY at 30, 60, and 90 trading days from filing date. Calculated using Massive (api.polygon.io) historical daily closes.

## Statistical tests

1. **Naive comparison** — Welch's t-test of mean excess return, paired vs. solo, cluster vs. solo, mega_cluster vs. solo, at each horizon.
2. **Bucketed comparison** — within each (market cap bucket × buy value bucket) cell with ≥10 observations per cohort, t-test cluster vs. solo. Primary test.
3. **Optional regression** — if buckets are sparse, fit `excess_return_90d ~ cohort + log(market_cap) + log(buy_value) + micro_cap_dummy` and report the cluster coefficient with confidence interval.

## Decision rules (committed before analysis)

Primary decision criterion is the bucketed cluster vs. solo spread at 90 days, in the production window (initially N=7, may switch based on data).

| Spread (bucketed, 90d) | p-value | Action |
|---|---|---|
| ≥ +3pp | < 0.05 | Keep current weights; signal validated as-is |
| ≥ +5pp | < 0.05 | Increase weights; recommend new value |
| < +1pp or not significant | — | Reduce weights or remove signal entirely |

If a different window N produces a materially stronger spread (≥2pp larger than the production window), recommend switching the production window.

The naive comparison alone does NOT count as validation. Cluster buys are confounded with both size and market cap; only the bucketed (or regression-controlled) comparison can isolate the cluster effect.

## Sanity gate

If the cluster cohort at N=3 contains fewer than 50 observations, the analysis halts before the price pull. Sample size that small reproduces the new-exec test's underpowered sub-bucket failure mode and is not informative.

## Publication

Results will be published at `buysidebrief.com/research/cluster-buy-signal/` regardless of direction. A null or negative result is publishable; methodology and decision rules are committed in advance.

## Limitations acknowledged before analysis

- 12 months is a single market regime. Findings may not generalize to a different macro environment.
- The 2025-04 to 2026-04 window includes [whatever regime context applies — fill in at writeup time, not now].
- Form 4 transaction code filtering excludes some legitimate open-market purchases that file under non-standard codes. Estimated coverage is ≥95% of true open-market activity.
- Cluster definition is mechanical (distinct CIK count). It does not weight participants by seniority, dollar amount, or prior trading history.
