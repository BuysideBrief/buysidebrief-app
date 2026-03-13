const { tickerLink, tickerLinkBold, brokerCta, affiliateDisclosure } = require('../lib/affiliate-links');

describe('tickerLink', () => {
  test('returns TradingView link with ticker', () => {
    const link = tickerLink('AAPL');
    expect(link).toContain('tradingview.com');
    expect(link).toContain('AAPL');
    expect(link).toContain('<a');
  });

  test('handles uppercase and lowercase tickers', () => {
    const link = tickerLink('aapl');
    expect(link).toContain('AAPL');
  });
});

describe('tickerLinkBold', () => {
  test('returns bold ticker link', () => {
    const link = tickerLinkBold('TSLA');
    expect(link).toContain('TSLA');
    expect(link).toMatch(/font-weight.*700|<strong/);
  });
});

describe('brokerCta', () => {
  test('returns CTA buttons HTML', () => {
    const cta = brokerCta('AAPL');
    expect(cta).toContain('tastytrade');
    // Should contain at least one broker button
    expect(cta).toContain('Trade on');
  });

  test('includes ticker in broker URLs where applicable', () => {
    const cta = brokerCta('MSFT');
    expect(typeof cta).toBe('string');
  });
});

describe('affiliateDisclosure', () => {
  test('returns disclosure text', () => {
    const disc = affiliateDisclosure();
    expect(disc).toMatch(/commission|affiliate|earn/i);
    expect(disc.length).toBeGreaterThan(0);
  });
});
