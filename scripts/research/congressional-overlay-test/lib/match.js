/**
 * Overlap classifier for the Congressional Overlay Test.
 *
 * Inputs:
 *   form4Buy     — { ticker, transactions[0].txDate, ... }
 *   congressIdx  — ticker → sorted list of { txDate, txType: 'P'|'S', ownerCode, ... }
 *
 * Classification:
 *   overlap90   — ≥1 congressional PURCHASE at same ticker in [T-90d, T]
 *   placebo180  — ZERO congressional trades (any type) at same ticker in [T-180d, T]
 *   neither     — recent activity but no buy in 90d, OR no 180d activity overflow
 *
 * Directional order (only for overlap90):
 *   politician-first → nearest congressional buy dated BEFORE form4 tx
 *   insider-first    → nearest congressional buy dated AFTER form4 tx
 *   simultaneous     → dates are equal
 *
 * Window bucket: days between nearest congressional buy and form4 tx.
 */
const { normalize } = require('./ticker-normalize');
const { daysBetween } = require('./util');

function dayDiff(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }

function classify(form4Buy, congressIdx) {
  const ticker = normalize(form4Buy.ticker);
  const txDate = form4Buy.transactions[0].txDate;
  const all = congressIdx.get(ticker) || [];

  // Scan trades at this ticker
  const within180 = all.filter(c => {
    const d = dayDiff(c.txDate, txDate);
    return d >= -90 && d <= 180; // include trades up to 90d after Form4 for directional order (insider-first)
  });

  // Placebo: zero congressional activity of any kind in the full 180 prior window
  const within180Prior = all.filter(c => {
    const d = dayDiff(c.txDate, txDate);
    return d >= 0 && d <= 180;
  });
  if (within180Prior.length === 0) {
    return { cohort: 'placebo', reason: 'no-congressional-activity-180d' };
  }

  // Overlap: ≥1 congressional purchase within [T-90d, T+0d]
  const purchasesWithin90 = all.filter(c => {
    if (c.txType !== 'P') return false;
    const d = dayDiff(c.txDate, txDate);
    return d >= 0 && d <= 90;
  });

  if (purchasesWithin90.length) {
    // Find the nearest (smallest |gap|) for directional order
    // We also look at any buy within ±90 days for directional context
    const purchasesFlex = all.filter(c => {
      if (c.txType !== 'P') return false;
      const d = dayDiff(c.txDate, txDate);
      return d >= -90 && d <= 90;
    });
    let nearest = purchasesFlex[0];
    let minAbs = Math.abs(dayDiff(nearest.txDate, txDate));
    for (const c of purchasesFlex) {
      const ag = Math.abs(dayDiff(c.txDate, txDate));
      if (ag < minAbs) { nearest = c; minAbs = ag; }
    }
    const gap = dayDiff(nearest.txDate, txDate);
    const direction = gap > 0 ? 'politician-first'
                     : gap < 0 ? 'insider-first'
                     : 'simultaneous';
    const windowBucket =
      Math.abs(gap) <= 30 ? '0-30'
      : Math.abs(gap) <= 60 ? '31-60'
      : '61-90';
    return {
      cohort: 'overlap',
      direction,
      gapDays: gap,                                  // + means politician first, - means insider first
      windowBucket,
      nearestCongress: nearest,
      congressBuyCount90d: purchasesWithin90.length,
      totalCongressActivity180d: within180Prior.length,
    };
  }

  // Middle ground: congressional activity at this ticker in 180d but no *buy* in 90d
  return { cohort: 'neither', reason: 'activity-but-no-90d-buy', totalActivity180d: within180Prior.length };
}

function buildCongressIndex(rows) {
  const idx = new Map();
  for (const r of rows) {
    const k = normalize(r.ticker);
    if (!k) continue;
    if (!idx.has(k)) idx.set(k, []);
    idx.get(k).push(r);
  }
  for (const [k, arr] of idx) arr.sort((a, b) => (a.txDate < b.txDate ? -1 : 1));
  return idx;
}

module.exports = { classify, buildCongressIndex };
