# Congressional Overlap — Non-finding (April 2026) reproducibility bundle

This directory contains the raw outputs supporting
<https://www.buysidebrief.com/research/congressional-overlap-nonfinding-2026-04>.

## Files

- `sanity-check.json` — final counts and the decision-gate output from
  `scripts/research/congressional-overlay-test/run-sanity.js`. The
  `cohorts`, `direction`, `windowBucket`, and `decisionGate` fields are
  what drove the STOP decision.
- `fmp-probe-summary.json` — record of the eight FMP endpoint probes we
  ran after discovering the free-tier endpoint had been deprecated.
  Kept as audit trail for the data-source pivot from FMP to the House
  disclosures clerk zip.
- `house-ptr-parsed/` — one JSON per House PTR filing we parsed within
  the sanity window. Each file has `{ year, docId, rowCount, rows[] }`
  where each row is a single transaction (ticker / assetType / ownerCode
  / txType / txDate / notificationDate / amountRangeText /
  amountMidpoint). Only `[ST]` (stock) rows are kept.

## Pipeline

Source: <https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip>
→ XML index (filing metadata) → per-DocID PTR PDF
(`/public_disc/ptr-pdfs/{year}/{docId}.pdf`) → `pdf-parse` text
extraction → regex table parser (see
`scripts/research/congressional-overlay-test/lib/house-ptr-parser.js`).

Form 4 buys came from the standard EDGAR full-text search at
`efts.sec.gov` with `forms=4` and day-by-day date filters (same
polite-client pattern the rest of this site uses).

## Known limits

- House-only (no Senate)
- Amount ranges converted to midpoints ($1,001 - $15,000 → $8,001)
- 45-day disclosure lag not corrected for

See the published writeup for the full discussion.
