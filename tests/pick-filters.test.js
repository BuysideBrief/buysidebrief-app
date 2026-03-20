/**
 * Tests for pick-filters.js
 * Entry price validation + repeat insider dampening
 */

const {
  validateEntryPrice,
  getBestEntryPrice,
  dampenRepeatInsiders,
} = require('../lib/pick-filters');

// ══════════════════════════════════════════
// validateEntryPrice
// ══════════════════════════════════════════

describe('validateEntryPrice', () => {
  test('accepts entry price within normal range of current', () => {
    // Stock at $100, entry at $90 (10% move) — totally fine
    const result = validateEntryPrice(90, 100, null);
    expect(result.price).toBe(90);
    expect(result.suspicious).toBe(false);
    expect(result.source).toBe('filing_verified');
  });

  test('accepts entry price with significant but plausible move', () => {
    // Stock went from $50 to $100 (100% gain) — aggressive but possible
    const result = validateEntryPrice(50, 100, null);
    expect(result.price).toBe(50);
    expect(result.suspicious).toBe(false);
  });

  test('rejects entry price wildly below current (PSA case)', () => {
    // $PSA: entry $44.54 vs current $277 — clearly wrong
    const result = validateEntryPrice(44.54, 277.33, { transactions: [] });
    expect(result.suspicious).toBe(true);
    expect(result.price).toBe(null); // No good fallback
    expect(result.source).toBe('excluded');
  });

  test('finds corrected price from other transactions', () => {
    const filing = {
      transactions: [
        { isOpenMarketBuy: true, pricePerShare: 44.54, shares: 10, totalValue: 445.40 },
        { isOpenMarketBuy: true, pricePerShare: 275.00, shares: 1000, totalValue: 275000 },
      ],
    };
    const result = validateEntryPrice(44.54, 277.33, filing);
    expect(result.suspicious).toBe(true);
    expect(result.price).toBe(275.00); // Found a better price
    expect(result.source).toBe('filing_corrected');
  });

  test('handles missing entry price', () => {
    const result = validateEntryPrice(null, 100, null);
    expect(result.price).toBe(null);
    expect(result.suspicious).toBe(true);
    expect(result.source).toBe('missing');
  });

  test('handles zero entry price', () => {
    const result = validateEntryPrice(0, 100, null);
    expect(result.price).toBe(null);
    expect(result.suspicious).toBe(true);
  });

  test('handles missing current price — passes through unverified', () => {
    const result = validateEntryPrice(50, null, null);
    expect(result.price).toBe(50);
    expect(result.suspicious).toBe(false);
    expect(result.source).toBe('filing_unverified');
  });

  test('accepts entry price above current (stock dropped)', () => {
    // Stock dropped from $150 to $100 — that's a -33% loss, normal
    const result = validateEntryPrice(150, 100, null);
    expect(result.price).toBe(150);
    expect(result.suspicious).toBe(false);
  });

  test('rejects entry price 10x above current', () => {
    // Entry $1000 vs current $100 — something's wrong
    const result = validateEntryPrice(1000, 100, { transactions: [] });
    expect(result.suspicious).toBe(true);
  });
});

// ══════════════════════════════════════════
// getBestEntryPrice
// ══════════════════════════════════════════

describe('getBestEntryPrice', () => {
  test('returns single buy price', () => {
    const filing = {
      transactions: [
        { isOpenMarketBuy: true, pricePerShare: 50, shares: 100 },
      ],
    };
    expect(getBestEntryPrice(filing)).toBe(50);
  });

  test('returns weighted average of multiple buys', () => {
    const filing = {
      transactions: [
        { isOpenMarketBuy: true, pricePerShare: 50, shares: 100 },
        { isOpenMarketBuy: true, pricePerShare: 60, shares: 100 },
      ],
    };
    // (50*100 + 60*100) / 200 = 55
    expect(getBestEntryPrice(filing)).toBe(55);
  });

  test('weights by shares correctly', () => {
    const filing = {
      transactions: [
        { isOpenMarketBuy: true, pricePerShare: 50, shares: 900 },
        { isOpenMarketBuy: true, pricePerShare: 100, shares: 100 },
      ],
    };
    // (50*900 + 100*100) / 1000 = 55
    expect(getBestEntryPrice(filing)).toBe(55);
  });

  test('ignores non-buy transactions', () => {
    const filing = {
      transactions: [
        { isOpenMarketBuy: false, isOpenMarketSell: true, pricePerShare: 200, shares: 500 },
        { isOpenMarketBuy: true, pricePerShare: 50, shares: 100 },
      ],
    };
    expect(getBestEntryPrice(filing)).toBe(50);
  });

  test('ignores zero-price buys', () => {
    const filing = {
      transactions: [
        { isOpenMarketBuy: true, pricePerShare: 0, shares: 100 },
        { isOpenMarketBuy: true, pricePerShare: 50, shares: 100 },
      ],
    };
    expect(getBestEntryPrice(filing)).toBe(50);
  });

  test('returns null for no buys', () => {
    const filing = {
      transactions: [
        { isOpenMarketBuy: false, pricePerShare: 50, shares: 100 },
      ],
    };
    expect(getBestEntryPrice(filing)).toBe(null);
  });

  test('returns null for null filing', () => {
    expect(getBestEntryPrice(null)).toBe(null);
  });

  test('returns null for empty transactions', () => {
    expect(getBestEntryPrice({ transactions: [] })).toBe(null);
  });
});

// ══════════════════════════════════════════
// dampenRepeatInsiders
// ══════════════════════════════════════════

describe('dampenRepeatInsiders', () => {
  const today = new Date();

  function daysAgo(n) {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0];
  }

  function makeFiling(ticker, ownerCik, score) {
    return {
      ticker,
      ownerCik,
      ownerName: `Owner ${ownerCik}`,
      score,
      tier: score >= 75 ? 'top_pick' : score >= 45 ? 'feature' : score >= 25 ? 'mention' : 'skip',
      signals: [],
      warnings: [],
    };
  }

  test('no dampening when no recent picks', () => {
    const filings = [makeFiling('AAPL', '123', 80)];
    const result = dampenRepeatInsiders(filings, []);
    expect(result[0].score).toBe(80);
    expect(result[0].dampened).toBeUndefined();
  });

  test('skips filing if same insider+ticker was featured 3 days ago', () => {
    const filings = [makeFiling('RCG', '999', 45)];
    const recentPicks = [{ ticker: 'RCG', ownerCik: '999', entryDate: daysAgo(3) }];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    expect(result[0].score).toBe(0);
    expect(result[0].tier).toBe('skip');
    expect(result[0].dampened).toBe(true);
  });

  test('caps at mention if featured 10 days ago', () => {
    const filings = [makeFiling('RCG', '999', 65)];
    const recentPicks = [{ ticker: 'RCG', ownerCik: '999', entryDate: daysAgo(10) }];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    expect(result[0].score).toBe(25); // capped
    expect(result[0].tier).toBe('mention');
    expect(result[0].dampened).toBe(true);
  });

  test('reduces by 20 if featured 20 days ago', () => {
    const filings = [makeFiling('RCG', '999', 65)];
    const recentPicks = [{ ticker: 'RCG', ownerCik: '999', entryDate: daysAgo(20) }];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    expect(result[0].score).toBe(45); // 65 - 20
    expect(result[0].tier).toBe('feature');
    expect(result[0].dampened).toBe(true);
  });

  test('no penalty if featured 35 days ago', () => {
    const filings = [makeFiling('RCG', '999', 65)];
    const recentPicks = [{ ticker: 'RCG', ownerCik: '999', entryDate: daysAgo(35) }];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    expect(result[0].score).toBe(65); // unchanged
    expect(result[0].dampened).toBeUndefined();
  });

  test('different insider at same ticker is NOT dampened', () => {
    const filings = [makeFiling('AAPL', '111', 80)];
    const recentPicks = [{ ticker: 'AAPL', ownerCik: '222', entryDate: daysAgo(3) }];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    expect(result[0].score).toBe(80); // Different person, no penalty
    expect(result[0].dampened).toBeUndefined();
  });

  test('same insider at different ticker is NOT dampened', () => {
    const filings = [makeFiling('MSFT', '999', 80)];
    const recentPicks = [{ ticker: 'AAPL', ownerCik: '999', entryDate: daysAgo(3) }];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    expect(result[0].score).toBe(80); // Different ticker, no penalty
  });

  test('uses most recent pick date when multiple exist', () => {
    const filings = [makeFiling('RCG', '999', 65)];
    const recentPicks = [
      { ticker: 'RCG', ownerCik: '999', entryDate: daysAgo(25) }, // 25 days ago
      { ticker: 'RCG', ownerCik: '999', entryDate: daysAgo(5) },  // 5 days ago — more recent
    ];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    // Should use the 5-day-ago date → skip
    expect(result[0].score).toBe(0);
    expect(result[0].tier).toBe('skip');
  });

  test('handles filings without ownerCik gracefully', () => {
    const filings = [{ ticker: 'AAPL', ownerCik: null, score: 80, tier: 'top_pick', warnings: [] }];
    const recentPicks = [{ ticker: 'AAPL', ownerCik: '123', entryDate: daysAgo(3) }];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    expect(result[0].score).toBe(80); // Can't match without ownerCik
  });

  test('ticker comparison is case insensitive', () => {
    const filings = [makeFiling('rcg', '999', 45)];
    const recentPicks = [{ ticker: 'RCG', ownerCik: '999', entryDate: daysAgo(3) }];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    expect(result[0].score).toBe(0); // Matched despite case difference
  });

  test('multiple filings — only dampens the repeat, leaves others alone', () => {
    const filings = [
      makeFiling('RCG', '999', 45),  // repeat
      makeFiling('AAPL', '111', 80), // fresh
    ];
    const recentPicks = [{ ticker: 'RCG', ownerCik: '999', entryDate: daysAgo(3) }];
    
    const result = dampenRepeatInsiders(filings, recentPicks);
    expect(result[0].score).toBe(0);  // RCG dampened
    expect(result[1].score).toBe(80); // AAPL untouched
  });
});
