/**
 * Tests for institutional buyer detection, ticker validation,
 * and scoring adjustments in signal-scorer.js
 */

const {
  scoreFiling,
  scoreAllFilings,
  isInstitutionalBuyer,
  isValidTicker,
} = require('../lib/signal-scorer');

// Helper: make a filing
function makeFiling(overrides = {}) {
  return {
    ticker: 'AAPL',
    issuerName: 'Apple Inc.',
    ownerName: 'Tim Cook',
    ownerCik: '123456',
    officerTitle: 'CEO',
    isDirector: false,
    isOfficer: true,
    isTenPercentOwner: false,
    isAmendment: false,
    has10b51Plan: false,
    transactions: [
      {
        code: 'P',
        shares: 10000,
        pricePerShare: 50,
        totalValue: 500000,
        acquired: true,
        disposed: false,
        isOpenMarketBuy: true,
        isOpenMarketSell: false,
        isOptionExercise: false,
        isGift: false,
        isAward: false,
      },
    ],
    ...overrides,
  };
}

// ══════════════════════════════════════════
// isInstitutionalBuyer
// ══════════════════════════════════════════

describe('isInstitutionalBuyer', () => {
  test('detects LP entities', () => {
    expect(isInstitutionalBuyer('Saba Capital Management, L.P.')).toBe(true);
    expect(isInstitutionalBuyer('STEEL PARTNERS HOLDINGS L.P.')).toBe(true);
    expect(isInstitutionalBuyer('Andreessen Horowitz LSV Fund III, L.P.')).toBe(true);
    expect(isInstitutionalBuyer('Casdin Partners Master Fund, L.P.')).toBe(true);
  });

  test('detects LLC entities', () => {
    expect(isInstitutionalBuyer('Kennedy Lewis Investment Holdings II LLC')).toBe(true);
    expect(isInstitutionalBuyer('Tremont Realty Capital LLC')).toBe(true);
  });

  test('detects Ltd/Inc/Corp entities', () => {
    expect(isInstitutionalBuyer('Manulife (International) Ltd')).toBe(true);
    expect(isInstitutionalBuyer('MITSUI SUMITOMO INSURANCE CO LTD')).toBe(true);
    expect(isInstitutionalBuyer('Manulife (Singapore) Pte. Ltd.')).toBe(true);
  });

  test('detects fund/capital/management keywords', () => {
    expect(isInstitutionalBuyer('RA CAPITAL MANAGEMENT')).toBe(true);
    expect(isInstitutionalBuyer('Abu Dhabi Investment Authority')).toBe(true);
    expect(isInstitutionalBuyer('MPM BIOVENTURES 2018')).toBe(false); // no keyword match without Fund/Capital etc
    expect(isInstitutionalBuyer('Opaleye Management Inc.')).toBe(true);
  });

  test('does NOT flag individual names', () => {
    expect(isInstitutionalBuyer('BIGLARI, SARDAR')).toBe(false);
    expect(isInstitutionalBuyer('Cohen Ryan')).toBe(false);
    expect(isInstitutionalBuyer('Todd Paul M')).toBe(false);
    expect(isInstitutionalBuyer('Hoffmann David Henry')).toBe(false);
    expect(isInstitutionalBuyer('ROBBINS LARRY')).toBe(false);
    expect(isInstitutionalBuyer('Kutzkey Tim')).toBe(false);
  });

  test('handles null/empty', () => {
    expect(isInstitutionalBuyer(null)).toBe(false);
    expect(isInstitutionalBuyer('')).toBe(false);
    expect(isInstitutionalBuyer(undefined)).toBe(false);
  });
});

// ══════════════════════════════════════════
// isValidTicker
// ══════════════════════════════════════════

describe('isValidTicker', () => {
  test('accepts valid tickers', () => {
    expect(isValidTicker('AAPL')).toBe(true);
    expect(isValidTicker('A')).toBe(true);
    expect(isValidTicker('BRK')).toBe(true);
    expect(isValidTicker('MSFT')).toBe(true);
  });

  test('rejects NONE and N/A', () => {
    expect(isValidTicker('NONE')).toBe(false);
    expect(isValidTicker('N/A')).toBe(false);
    expect(isValidTicker('NA')).toBe(false);
    expect(isValidTicker('NULL')).toBe(false);
  });

  test('rejects empty/null', () => {
    expect(isValidTicker('')).toBe(false);
    expect(isValidTicker(null)).toBe(false);
    expect(isValidTicker(undefined)).toBe(false);
  });

  test('rejects tickers with special characters', () => {
    expect(isValidTicker('N/A')).toBe(false);
    expect(isValidTicker('BR.K')).toBe(false);
  });

  test('is case insensitive', () => {
    expect(isValidTicker('none')).toBe(false);
    expect(isValidTicker('aapl')).toBe(true);
  });

  test('rejects tickers longer than 6 chars', () => {
    expect(isValidTicker('TOOLONG')).toBe(false);
    expect(isValidTicker('ABCDEF')).toBe(true); // 6 is ok
  });
});

// ══════════════════════════════════════════
// scoreFiling — institutional handling
// ══════════════════════════════════════════

describe('scoreFiling — institutional buyers', () => {
  test('institutional buyer gets capped score', () => {
    const filing = makeFiling({
      ownerName: 'Saba Capital Management, L.P.',
      isTenPercentOwner: true,
      isOfficer: false,
      officerTitle: '',
      transactions: [{
        code: 'P', shares: 100000, pricePerShare: 50, totalValue: 5000000,
        acquired: true, disposed: false, isOpenMarketBuy: true,
        isOpenMarketSell: false, isOptionExercise: false, isGift: false, isAward: false,
      }],
    });

    const result = scoreFiling(filing);
    expect(result.isInstitutional).toBe(true);
    // 15 (institutional base) + 15 (large fund purchase) = 30
    expect(result.score).toBe(30);
    expect(result.tier).toBe('mention');
    expect(result.signals.some(s => s.includes('Institutional'))).toBe(true);
  });

  test('institutional buyer with $100M still caps below top pick', () => {
    const filing = makeFiling({
      ownerName: 'Kennedy Lewis Investment Holdings II LLC',
      isTenPercentOwner: true,
      isOfficer: false,
      officerTitle: '',
      transactions: [{
        code: 'P', shares: 1000000, pricePerShare: 100, totalValue: 100000000,
        acquired: true, disposed: false, isOpenMarketBuy: true,
        isOpenMarketSell: false, isOptionExercise: false, isGift: false, isAward: false,
      }],
    });

    const result = scoreFiling(filing);
    expect(result.isInstitutional).toBe(true);
    // 15 + 15 = 30 — nowhere near 75 for top pick
    expect(result.score).toBe(30);
    expect(result.tier).not.toBe('top_pick');
  });

  test('individual CEO still scores normally', () => {
    const filing = makeFiling({
      ownerName: 'Cohen Ryan',
      officerTitle: 'CEO',
      isOfficer: true,
    });

    const result = scoreFiling(filing);
    expect(result.isInstitutional).toBe(false);
    // CEO(30) + Large purchase(25) + Discretionary(10) = 65
    expect(result.score).toBe(65);
  });

  test('institutional buyers excluded from cluster detection', () => {
    const filings = [
      makeFiling({ ticker: 'ACME', ownerName: 'Saba Capital Management, L.P.', ownerCik: '111', isOfficer: false, officerTitle: '', isTenPercentOwner: true }),
      makeFiling({ ticker: 'ACME', ownerName: 'JANA Partners, LP', ownerCik: '222', isOfficer: false, officerTitle: '', isTenPercentOwner: true }),
      makeFiling({ ticker: 'ACME', ownerName: 'Fund Three LLC', ownerCik: '333', isOfficer: false, officerTitle: '', isTenPercentOwner: true }),
    ];

    const scored = scoreAllFilings(filings);
    // All 3 are institutional — cluster bonus should NOT apply
    const clusterSignals = scored.filter(f => f.signals.some(s => s.includes('Cluster')));
    expect(clusterSignals.length).toBe(0);
  });

  test('mix of institutional and individual — only individuals get cluster', () => {
    const filings = [
      makeFiling({ ticker: 'ACME', ownerName: 'Saba Capital Management, L.P.', ownerCik: '111', isOfficer: false, officerTitle: '', isTenPercentOwner: true }),
      makeFiling({ ticker: 'ACME', ownerName: 'Smith John', ownerCik: '222', isDirector: true, isOfficer: false, officerTitle: '' }),
      makeFiling({ ticker: 'ACME', ownerName: 'Jones Sarah', ownerCik: '333', isDirector: true, isOfficer: false, officerTitle: '' }),
      makeFiling({ ticker: 'ACME', ownerName: 'Brown Mike', ownerCik: '444', isDirector: true, isOfficer: false, officerTitle: '' }),
    ];

    const scored = scoreAllFilings(filings);
    // 3 individual directors = cluster. Fund excluded.
    const individuals = scored.filter(f => !f.isInstitutional);
    const withCluster = individuals.filter(f => f.signals.some(s => s.includes('Cluster')));
    expect(withCluster.length).toBe(3);
  });
});

// ══════════════════════════════════════════
// scoreFiling — invalid ticker handling
// ══════════════════════════════════════════

describe('scoreFiling — invalid tickers', () => {
  test('skips NONE ticker', () => {
    const filing = makeFiling({ ticker: 'NONE' });
    const result = scoreFiling(filing);
    expect(result.tier).toBe('skip');
    expect(result.score).toBe(0);
  });

  test('skips N/A ticker', () => {
    const filing = makeFiling({ ticker: 'N/A' });
    const result = scoreFiling(filing);
    expect(result.tier).toBe('skip');
    expect(result.score).toBe(0);
  });

  test('skips empty ticker', () => {
    const filing = makeFiling({ ticker: '' });
    const result = scoreFiling(filing);
    expect(result.tier).toBe('skip');
  });

  test('skips null ticker', () => {
    const filing = makeFiling({ ticker: null });
    const result = scoreFiling(filing);
    expect(result.tier).toBe('skip');
  });

  test('valid ticker still scores normally', () => {
    const filing = makeFiling({ ticker: 'AAPL' });
    const result = scoreFiling(filing);
    expect(result.tier).not.toBe('skip');
    expect(result.score).toBeGreaterThan(0);
  });
});
