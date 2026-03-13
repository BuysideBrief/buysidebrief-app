const { generateWhyItMatters } = require('../lib/context-enricher');

function makeScoredFiling(overrides = {}) {
  return {
    ticker: 'TEST',
    companyName: 'Test Corp',
    ownerName: 'Smith John',
    officerTitle: overrides.officerTitle || '',
    isDirector: overrides.isDirector || false,
    isTenPercentOwner: overrides.isTenPercentOwner || false,
    has10b51Plan: overrides.has10b51Plan || false,
    tier: overrides.tier || 'feature',
    score: overrides.score || 50,
    signals: overrides.signals || [],
    summary: overrides.summary || {
      totalBuyValue: 100000,
      totalSellValue: 0,
      buyCount: 1,
      sellCount: 0,
    },
    priceContext: overrides.priceContext || null,
    ...overrides,
  };
}

describe('generateWhyItMatters', () => {

  test('CEO top pick gets C-suite context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      officerTitle: 'CEO',
      tier: 'top_pick',
    }));
    expect(blurb).toMatch(/CEO|conviction/i);
  });

  test('CFO top pick gets CFO-specific context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      officerTitle: 'Chief Financial Officer',
      tier: 'top_pick',
    }));
    expect(blurb).toMatch(/CFO|financials/i);
  });

  test('mega purchase gets dollar amount context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      officerTitle: 'CEO',
      tier: 'top_pick',
      summary: { totalBuyValue: 2_000_000, totalSellValue: 0, buyCount: 1, sellCount: 0 },
    }));
    expect(blurb).toMatch(/serious money|real bet/i);
  });

  test('cluster signal gets cluster context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      signals: ['Cluster buying: 3 insiders at $TEST'],
    }));
    expect(blurb).toMatch(/cluster/i);
  });

  test('paired signal gets paired context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      signals: ['Paired buying: 2 insiders at $TEST'],
    }));
    expect(blurb).toMatch(/cluster|pair/i);
  });

  test('discretionary purchase gets discretionary context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      has10b51Plan: false,
      summary: { totalBuyValue: 100000, totalSellValue: 0, buyCount: 1, sellCount: 0 },
    }));
    expect(blurb).toMatch(/discretionary|chose to buy/i);
  });

  test('10b5-1 plan does not get discretionary-specific context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      has10b51Plan: true,
      summary: { totalBuyValue: 100000, totalSellValue: 0, buyCount: 1, sellCount: 0 },
    }));
    expect(blurb).not.toMatch(/discretionary/i);
  });

  test('10% owner gets large exposure context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      isTenPercentOwner: true,
      summary: { totalBuyValue: 100000, totalSellValue: 0, buyCount: 1, sellCount: 0 },
    }));
    expect(blurb).toMatch(/10%|massive exposure|bullish/i);
  });

  test('near 52-week low gets conviction context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      priceContext: {
        high52w: 100,
        low52w: 40,
        currentPrice: 44,
        pctFromLow: 10,
        pctFromHigh: -56,
        nearLow: true,
        nearHigh: false,
      },
      summary: { totalBuyValue: 100000, totalSellValue: 0, buyCount: 1, sellCount: 0 },
    }));
    expect(blurb).toMatch(/52-week low|bottom|conviction/i);
  });

  test('near 52-week high gets high context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      priceContext: {
        high52w: 100,
        low52w: 40,
        currentPrice: 95,
        pctFromLow: 137.5,
        pctFromHigh: -5,
        nearLow: false,
        nearHigh: true,
      },
      summary: { totalBuyValue: 100000, totalSellValue: 0, buyCount: 1, sellCount: 0 },
    }));
    expect(blurb).toMatch(/52-week high|elevated/i);
  });

  test('significant pullback gets contrarian context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      priceContext: {
        high52w: 100,
        low52w: 40,
        currentPrice: 65,
        pctFromLow: 62.5,
        pctFromHigh: -35,
        nearLow: false,
        nearHigh: false,
      },
      summary: { totalBuyValue: 100000, totalSellValue: 0, buyCount: 1, sellCount: 0 },
    }));
    expect(blurb).toMatch(/pullback|contrarian|down/i);
  });

  test('sell-only with 10b5-1 gets pre-scheduled context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      has10b51Plan: true,
      summary: { totalBuyValue: 0, totalSellValue: 500000, buyCount: 0, sellCount: 1 },
    }));
    expect(blurb).toMatch(/pre-scheduled|10b5-1/i);
  });

  test('sell-only without 10b5-1 gets neutral sell context', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      has10b51Plan: false,
      summary: { totalBuyValue: 0, totalSellValue: 500000, buyCount: 0, sellCount: 1 },
    }));
    expect(blurb).toMatch(/sell|many reasons/i);
  });

  test('filing with no signals gets fallback blurb', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      has10b51Plan: true,
      isTenPercentOwner: false,
      signals: [],
      summary: { totalBuyValue: 50000, totalSellValue: 0, buyCount: 1, sellCount: 0 },
    }));
    expect(blurb.length).toBeGreaterThan(0);
  });

  test('always returns a non-empty string', () => {
    const blurb = generateWhyItMatters(makeScoredFiling({
      has10b51Plan: true,
      summary: { totalBuyValue: 0, totalSellValue: 0, buyCount: 0, sellCount: 0 },
    }));
    expect(typeof blurb).toBe('string');
    expect(blurb.length).toBeGreaterThan(0);
  });
});
