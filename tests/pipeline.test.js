/**
 * Tests for pipeline logic — deduplication and send safeguards.
 * These test the logic extracted from fetch-and-send.js.
 */

describe('deduplication logic', () => {

  function dedup(parsed) {
    const deduped = [];
    const seen = new Set();
    parsed.sort((a, b) => {
      const aVal = (a.summary?.totalBuyValue || 0) + (a.summary?.totalSellValue || 0);
      const bVal = (b.summary?.totalBuyValue || 0) + (b.summary?.totalSellValue || 0);
      return bVal - aVal;
    });
    for (const filing of parsed) {
      const key = `${filing.ticker || 'UNK'}:${filing.ownerCik || filing.ownerName || 'UNK'}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(filing);
      }
    }
    return deduped;
  }

  test('removes duplicate filings for same insider + ticker', () => {
    const filings = [
      { ticker: 'AMR', ownerCik: '001', summary: { totalBuyValue: 4400000, totalSellValue: 0 } },
      { ticker: 'AMR', ownerCik: '001', summary: { totalBuyValue: 4400000, totalSellValue: 0 } },
    ];
    const result = dedup(filings);
    expect(result.length).toBe(1);
  });

  test('keeps filings for different insiders at same ticker', () => {
    const filings = [
      { ticker: 'AMR', ownerCik: '001', summary: { totalBuyValue: 1000000, totalSellValue: 0 } },
      { ticker: 'AMR', ownerCik: '002', summary: { totalBuyValue: 500000, totalSellValue: 0 } },
    ];
    const result = dedup(filings);
    expect(result.length).toBe(2);
  });

  test('keeps filings for same insider at different tickers', () => {
    const filings = [
      { ticker: 'AAPL', ownerCik: '001', summary: { totalBuyValue: 100000, totalSellValue: 0 } },
      { ticker: 'MSFT', ownerCik: '001', summary: { totalBuyValue: 200000, totalSellValue: 0 } },
    ];
    const result = dedup(filings);
    expect(result.length).toBe(2);
  });

  test('keeps the highest-value filing when deduping', () => {
    const filings = [
      { ticker: 'TEST', ownerCik: '001', summary: { totalBuyValue: 100000, totalSellValue: 0 } },
      { ticker: 'TEST', ownerCik: '001', summary: { totalBuyValue: 500000, totalSellValue: 0 } },
    ];
    const result = dedup(filings);
    expect(result.length).toBe(1);
    expect(result[0].summary.totalBuyValue).toBe(500000);
  });

  test('handles empty input', () => {
    const result = dedup([]);
    expect(result.length).toBe(0);
  });

  test('handles filings without ownerCik by falling back to ownerName', () => {
    const filings = [
      { ticker: 'TEST', ownerName: 'John Smith', summary: { totalBuyValue: 100000, totalSellValue: 0 } },
      { ticker: 'TEST', ownerName: 'John Smith', summary: { totalBuyValue: 100000, totalSellValue: 0 } },
    ];
    const result = dedup(filings);
    expect(result.length).toBe(1);
  });

  test('handles filings without ticker', () => {
    const filings = [
      { ownerCik: '001', summary: { totalBuyValue: 100000, totalSellValue: 0 } },
      { ownerCik: '001', summary: { totalBuyValue: 100000, totalSellValue: 0 } },
    ];
    const result = dedup(filings);
    expect(result.length).toBe(1);
  });
});


describe('send safeguard logic', () => {

  function shouldSend({ userAgent, queryParams, cronSecret, authHeader }) {
    const ua = userAgent || '';
    const isCron = ua.includes('vercel-cron')
      || (cronSecret && authHeader === `Bearer ${cronSecret}`);
    const isManualSend = queryParams?.send === 'true';
    const isDryRun = queryParams?.dry === 'true';
    const isDebug = queryParams?.debug === 'true';

    const willSend = isCron || isManualSend;
    const effectiveDryRun = isDryRun || (!willSend && !isDebug);

    return { isCron, isManualSend, effectiveDryRun };
  }

  test('bare URL defaults to dry run', () => {
    const result = shouldSend({ queryParams: {} });
    expect(result.effectiveDryRun).toBe(true);
  });

  test('?send=true triggers live send', () => {
    const result = shouldSend({ queryParams: { send: 'true' } });
    expect(result.effectiveDryRun).toBe(false);
    expect(result.isManualSend).toBe(true);
  });

  test('?dry=true always dry runs even with send=true', () => {
    const result = shouldSend({ queryParams: { dry: 'true', send: 'true' } });
    expect(result.effectiveDryRun).toBe(true);
  });

  test('vercel-cron user agent triggers live send', () => {
    const result = shouldSend({ userAgent: 'vercel-cron/1.0', queryParams: {} });
    expect(result.isCron).toBe(true);
    expect(result.effectiveDryRun).toBe(false);
  });

  test('CRON_SECRET authorization triggers live send', () => {
    const result = shouldSend({
      cronSecret: 'mysecret123',
      authHeader: 'Bearer mysecret123',
      queryParams: {},
    });
    expect(result.isCron).toBe(true);
    expect(result.effectiveDryRun).toBe(false);
  });

  test('wrong CRON_SECRET does not trigger live send', () => {
    const result = shouldSend({
      cronSecret: 'mysecret123',
      authHeader: 'Bearer wrongsecret',
      queryParams: {},
    });
    expect(result.isCron).toBe(false);
    expect(result.effectiveDryRun).toBe(true);
  });

  test('debug mode is not a live send', () => {
    const result = shouldSend({ queryParams: { debug: 'true' } });
    expect(result.effectiveDryRun).toBe(false); // not dry run, but also won't reach send step
  });
});
