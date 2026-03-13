const { scoreFiling, scoreAllFilings, categorizeForDigest, formatValue } = require('../lib/signal-scorer');

// ── Test Helpers ──

function makeFiling(overrides = {}) {
  return {
    ticker: 'TEST',
    companyName: 'Test Corp',
    ownerName: 'Smith John',
    ownerCik: '0001234567',
    officerTitle: overrides.officerTitle || '',
    isDirector: overrides.isDirector || false,
    isTenPercentOwner: overrides.isTenPercentOwner || false,
    isAmendment: overrides.isAmendment || false,
    has10b51Plan: overrides.has10b51Plan || false,
    transactions: overrides.transactions || [],
    ...overrides,
  };
}

function buyTx(shares, price) {
  return {
    isOpenMarketBuy: true,
    isOpenMarketSell: false,
    isOptionExercise: false,
    isGift: false,
    isAward: false,
    shares,
    pricePerShare: price,
    totalValue: shares * price,
  };
}

function sellTx(shares, price) {
  return {
    isOpenMarketBuy: false,
    isOpenMarketSell: true,
    isOptionExercise: false,
    isGift: false,
    isAward: false,
    shares,
    pricePerShare: price,
    totalValue: shares * price,
  };
}

function optionTx(shares) {
  return {
    isOpenMarketBuy: false,
    isOpenMarketSell: false,
    isOptionExercise: true,
    isGift: false,
    isAward: false,
    shares,
    pricePerShare: 0,
    totalValue: 0,
  };
}

function giftTx(shares) {
  return {
    isOpenMarketBuy: false,
    isOpenMarketSell: false,
    isOptionExercise: false,
    isGift: true,
    isAward: false,
    shares,
    pricePerShare: 0,
    totalValue: 0,
  };
}

// ══════════════════════════════════════
// scoreFiling
// ══════════════════════════════════════

describe('scoreFiling', () => {

  test('amendment filings score 0 and tier skip', () => {
    const result = scoreFiling(makeFiling({ isAmendment: true, transactions: [buyTx(1000, 50)] }));
    expect(result.score).toBe(0);
    expect(result.tier).toBe('skip');
  });

  test('CEO open market buy gets C-suite boost (+30)', () => {
    const result = scoreFiling(makeFiling({
      officerTitle: 'CEO',
      transactions: [buyTx(1000, 50)],
    }));
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/C-suite purchase/),
    ]));
    expect(result.score).toBeGreaterThanOrEqual(30);
  });

  test('CFO purchase gets C-suite boost', () => {
    const result = scoreFiling(makeFiling({
      officerTitle: 'Chief Financial Officer',
      transactions: [buyTx(500, 100)],
    }));
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/C-suite purchase/),
    ]));
  });

  test('director purchase gets +15', () => {
    const result = scoreFiling(makeFiling({
      isDirector: true,
      transactions: [buyTx(1000, 50)],
    }));
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/Director purchase/),
    ]));
  });

  test('director who is also C-suite does not double-count director bonus', () => {
    const result = scoreFiling(makeFiling({
      officerTitle: 'CEO',
      isDirector: true,
      transactions: [buyTx(1000, 50)],
    }));
    const directorSignals = result.signals.filter(s => /Director purchase/.test(s));
    expect(directorSignals.length).toBe(0);
  });

  test('10% owner purchase gets +20', () => {
    const result = scoreFiling(makeFiling({
      isTenPercentOwner: true,
      transactions: [buyTx(5000, 100)],
    }));
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/10%\+ owner/),
    ]));
  });

  test('mega purchase (>$1M) gets +35', () => {
    const result = scoreFiling(makeFiling({
      transactions: [buyTx(10000, 120)], // $1.2M
    }));
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/Major purchase/),
    ]));
  });

  test('large purchase ($500K-$1M) gets +25', () => {
    const result = scoreFiling(makeFiling({
      transactions: [buyTx(5000, 120)], // $600K
    }));
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/Large purchase/),
    ]));
  });

  test('medium purchase ($100K-$500K) gets +15', () => {
    const result = scoreFiling(makeFiling({
      transactions: [buyTx(1000, 150)], // $150K
    }));
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/Notable purchase/),
    ]));
  });

  test('discretionary purchase (no 10b5-1) gets +10', () => {
    const result = scoreFiling(makeFiling({
      has10b51Plan: false,
      transactions: [buyTx(1000, 50)],
    }));
    expect(result.signals).toEqual(expect.arrayContaining([
      expect.stringMatching(/Discretionary/),
    ]));
  });

  test('pre-scheduled (10b5-1) does not get discretionary bonus', () => {
    const result = scoreFiling(makeFiling({
      has10b51Plan: true,
      transactions: [buyTx(1000, 50)],
    }));
    const discSignals = result.signals.filter(s => /Discretionary/.test(s));
    expect(discSignals.length).toBe(0);
  });

  test('option exercise only gets penalty (-20)', () => {
    const result = scoreFiling(makeFiling({
      transactions: [optionTx(5000)],
    }));
    expect(result.score).toBeLessThan(0);
  });

  test('gift/transfer gets penalty (-30)', () => {
    const result = scoreFiling(makeFiling({
      transactions: [giftTx(5000)],
    }));
    expect(result.score).toBeLessThan(0);
  });

  test('tiny purchase (<$10K) gets penalty', () => {
    const result = scoreFiling(makeFiling({
      transactions: [buyTx(10, 50)], // $500
    }));
    // Tiny purchase should score lower than a medium one
    const medium = scoreFiling(makeFiling({
      transactions: [buyTx(1000, 150)], // $150K
    }));
    expect(result.score).toBeLessThan(medium.score);
  });

  // ── Tier thresholds ──

  test('score >= 75 → top_pick', () => {
    // CEO + mega purchase + discretionary = 30 + 35 + 10 = 75
    const result = scoreFiling(makeFiling({
      officerTitle: 'CEO',
      transactions: [buyTx(10000, 120)],
    }));
    expect(result.tier).toBe('top_pick');
  });

  test('score >= 50 but < 75 → feature', () => {
    // Director + large purchase + discretionary = 15 + 25 + 10 = 50
    const result = scoreFiling(makeFiling({
      isDirector: true,
      transactions: [buyTx(5000, 110)],
    }));
    expect(result.tier).toBe('feature');
  });

  test('score >= 25 but < 50 → mention', () => {
    // CEO small purchase = 30 + 10 - 15 = 25 (discretionary + tiny penalty)
    const result = scoreFiling(makeFiling({
      officerTitle: 'CEO',
      transactions: [buyTx(100, 50)], // $5K — tiny
    }));
    expect(result.score).toBeGreaterThanOrEqual(25);
    expect(result.tier).toBe('mention');
  });

  test('filing with no buys and no special signals → skip', () => {
    const result = scoreFiling(makeFiling({
      transactions: [sellTx(1000, 50)],
      has10b51Plan: true,
    }));
    expect(result.tier).toBe('skip');
  });

  // ── Summary fields ──

  test('summary has correct buy count and value', () => {
    const result = scoreFiling(makeFiling({
      transactions: [buyTx(1000, 50), buyTx(500, 60)],
    }));
    expect(result.summary.buyCount).toBe(2);
    expect(result.summary.totalBuyValue).toBe(80000);
    expect(result.summary.totalBuyShares).toBe(1500);
  });
});


// ══════════════════════════════════════
// scoreAllFilings — cluster detection
// ══════════════════════════════════════

describe('scoreAllFilings — cluster detection', () => {

  test('3+ insiders buying same ticker get cluster bonus (+40)', () => {
    const filings = [
      makeFiling({ ticker: 'XYZ', ownerName: 'A', ownerCik: '001', transactions: [buyTx(100, 50)] }),
      makeFiling({ ticker: 'XYZ', ownerName: 'B', ownerCik: '002', transactions: [buyTx(100, 50)] }),
      makeFiling({ ticker: 'XYZ', ownerName: 'C', ownerCik: '003', transactions: [buyTx(100, 50)] }),
    ];
    const scored = scoreAllFilings(filings);
    for (const f of scored) {
      expect(f.signals).toEqual(expect.arrayContaining([
        expect.stringMatching(/Cluster buying/),
      ]));
    }
  });

  test('2 insiders buying same ticker get paired bonus (+15)', () => {
    const filings = [
      makeFiling({ ticker: 'ABC', ownerName: 'A', ownerCik: '001', transactions: [buyTx(100, 50)] }),
      makeFiling({ ticker: 'ABC', ownerName: 'B', ownerCik: '002', transactions: [buyTx(100, 50)] }),
    ];
    const scored = scoreAllFilings(filings);
    for (const f of scored) {
      expect(f.signals).toEqual(expect.arrayContaining([
        expect.stringMatching(/Paired buying/),
      ]));
    }
  });

  test('1 insider buying does not get cluster or paired bonus', () => {
    const filings = [
      makeFiling({ ticker: 'SOLO', ownerName: 'A', ownerCik: '001', transactions: [buyTx(100, 50)] }),
    ];
    const scored = scoreAllFilings(filings);
    expect(scored[0].signals).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/Cluster|Paired/),
    ]));
  });

  test('cluster detection is case-insensitive on ticker', () => {
    const filings = [
      makeFiling({ ticker: 'xyz', ownerName: 'A', ownerCik: '001', transactions: [buyTx(100, 50)] }),
      makeFiling({ ticker: 'XYZ', ownerName: 'B', ownerCik: '002', transactions: [buyTx(100, 50)] }),
      makeFiling({ ticker: 'Xyz', ownerName: 'C', ownerCik: '003', transactions: [buyTx(100, 50)] }),
    ];
    const scored = scoreAllFilings(filings);
    for (const f of scored) {
      expect(f.signals).toEqual(expect.arrayContaining([
        expect.stringMatching(/Cluster buying/),
      ]));
    }
  });

  test('results are sorted by score descending', () => {
    const filings = [
      makeFiling({ ticker: 'LOW', ownerName: 'A', transactions: [buyTx(10, 5)] }), // tiny
      makeFiling({ ticker: 'HIGH', ownerName: 'B', officerTitle: 'CEO', transactions: [buyTx(10000, 120)] }), // mega CEO
    ];
    const scored = scoreAllFilings(filings);
    expect(scored[0].ticker).toBe('HIGH');
    expect(scored[0].score).toBeGreaterThan(scored[1].score);
  });
});


// ══════════════════════════════════════
// categorizeForDigest
// ══════════════════════════════════════

describe('categorizeForDigest', () => {

  test('correctly buckets filings by tier', () => {
    const filings = [
      { tier: 'top_pick', summary: { sellCount: 0, sellValue: 0 } },
      { tier: 'feature', summary: { sellCount: 0, sellValue: 0 } },
      { tier: 'feature', summary: { sellCount: 0, sellValue: 0 } },
      { tier: 'mention', summary: { sellCount: 0, sellValue: 0 } },
      { tier: 'skip', summary: { sellCount: 0, sellValue: 0 } },
    ];
    const cat = categorizeForDigest(filings);
    expect(cat.topPicks.length).toBe(1);
    expect(cat.featured.length).toBe(2);
    expect(cat.mentions.length).toBe(1);
    expect(cat.totalProcessed).toBe(5);
    expect(cat.totalFeatured).toBe(3);
  });

  test('empty input returns empty categories', () => {
    const cat = categorizeForDigest([]);
    expect(cat.topPicks.length).toBe(0);
    expect(cat.featured.length).toBe(0);
    expect(cat.mentions.length).toBe(0);
    expect(cat.totalProcessed).toBe(0);
  });
});


// ══════════════════════════════════════
// formatValue
// ══════════════════════════════════════

describe('formatValue', () => {
  test('formats millions', () => {
    expect(formatValue(4_400_000)).toBe('4.4M');
    expect(formatValue(1_000_000)).toBe('1.0M');
  });

  test('formats thousands', () => {
    expect(formatValue(500_000)).toBe('500K');
    expect(formatValue(10_000)).toBe('10K');
  });

  test('formats small numbers', () => {
    expect(formatValue(999)).toBe('999');
    expect(formatValue(50)).toBe('50');
  });
});
