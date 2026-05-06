/**
 * Clean-room copy of the institutional-buyer regex used in production
 * (lib/signal-scorer.js — isInstitutionalBuyer). Copied verbatim into this
 * research project so the backtest never imports production scoring code.
 *
 * Source-of-truth: production lib/signal-scorer.js as of 2026-05-06.
 * If production diverges later, that is fine — this file is the frozen
 * filter the backtest was run against.
 */

function isInstitutionalBuyer(ownerName) {
  if (!ownerName) return false;
  const name = ownerName.toUpperCase();

  // Entity suffixes
  if (/\b(L\.?P\.?|LLC|LTD|INC|CORP|PLC|CO\b|HOLDINGS|PARTNERS|GROUP)\b/.test(name)) return true;

  // Fund/management keywords
  if (/\b(FUND|CAPITAL|MANAGEMENT|INVESTMENT|ADVISORS|VENTURES|PARTNERS|TRUST CO|AUTHORITY|REINSURANCE|INSURANCE CO)\b/.test(name)) return true;

  // Parenthetical entities — e.g. "Manulife (International) Ltd"
  if (/\(.+\)/.test(name) && /\b(LTD|PTE|PTY|INC|SA|AG)\b/.test(name)) return true;

  return false;
}

// Sanity test — uncomment block below and run with `node lib/institutional-filter.js`
if (require.main === module) {
  const positives = [
    'Saba Capital Management, L.P.',
    'Andreessen Horowitz LSV Fund III, L.P.',
    'JANA Partners Management, LP',
    'Kennedy Lewis Investment Holdings II LLC',
    'Abu Dhabi Investment Authority',
    'Manulife (International) Ltd',
    'STEEL PARTNERS HOLDINGS L.P.',
  ];
  const negatives = [
    'BIGLARI, SARDAR',
    'Smith John A',
    'Todd Paul M',
    'Jane Doe',
  ];
  for (const n of positives) {
    if (!isInstitutionalBuyer(n)) throw new Error(`Expected institutional: ${n}`);
  }
  for (const n of negatives) {
    if (isInstitutionalBuyer(n)) throw new Error(`Expected individual: ${n}`);
  }
  console.log('institutional-filter sanity OK:', positives.length, 'positives,', negatives.length, 'negatives');
}

module.exports = { isInstitutionalBuyer };
