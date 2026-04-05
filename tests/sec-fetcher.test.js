/**
 * Tests for lib/sec-fetcher.js
 *
 * Run:  node tests/sec-fetcher.test.js
 */

const assert = require('assert');

// ── Mock fetch before requiring the module ──

let fetchCalls = [];
let fetchHandler = () => ({ ok: false, status: 500, text: async () => '', json: async () => ({}) });

global.fetch = async (...args) => {
  fetchCalls.push(args);
  return fetchHandler(...args);
};

// Stub AbortSignal.timeout if missing (Node < 18)
if (!AbortSignal.timeout) {
  AbortSignal.timeout = () => new AbortController().signal;
}

const {
  fetchRecentFilingsFromFeed,
  fetchAndParseForm4,
  parseForm4Xml,
  TRANSACTION_CODES,
} = require('../lib/sec-fetcher');

// ── Helpers ──

function makeOkResponse(body, contentType = 'text/xml') {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => contentType },
    text: async () => text,
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  };
}

function makeErrorResponse(status, body = '') {
  return {
    ok: false,
    status,
    headers: { get: () => 'text/html' },
    text: async () => body,
    json: async () => { throw new Error('not json'); },
  };
}

function resetFetch() {
  fetchCalls = [];
  fetchHandler = () => makeErrorResponse(500);
}

// ── Mock XML Data ──

const VALID_FORM4_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ownershipDocument>
  <schemaVersion>X0407</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>2026-04-01</periodOfReport>
  <issuer>
    <issuerCik>0001234567</issuerCik>
    <issuerName>ACME Corp</issuerName>
    <issuerTradingSymbol>ACME</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0009876543</rptOwnerCik>
      <rptOwnerName>John Smith</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>true</isDirector>
      <isOfficer>true</isOfficer>
      <isTenPercentOwner>false</isTenPercentOwner>
      <officerTitle>CEO</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-04-01</value></transactionDate>
      <transactionCoding>
        <transactionFormType>4</transactionFormType>
        <transactionCode>P</transactionCode>
      </transactionCoding>
      <transactionAmounts>
        <transactionShares><value>10000</value></transactionShares>
        <transactionPricePerShare><value>25.50</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>`;

const FORM4_WITH_DERIVATIVE = `<?xml version="1.0" encoding="UTF-8"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer>
    <issuerCik>0001111111</issuerCik>
    <issuerName>Widget Inc</issuerName>
    <issuerTradingSymbol>WDGT</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0002222222</rptOwnerCik>
      <rptOwnerName>Jane Doe</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>false</isDirector>
      <isOfficer>true</isOfficer>
      <isTenPercentOwner>false</isTenPercentOwner>
      <officerTitle>CFO</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <transactionDate><value>2026-04-01</value></transactionDate>
      <transactionCoding><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>5000</value></transactionShares>
        <transactionPricePerShare><value>42.00</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction>
      <transactionDate><value>2026-04-01</value></transactionDate>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>2000</value></transactionShares>
        <transactionPricePerShare><value>15.00</value></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
    </derivativeTransaction>
  </derivativeTable>
</ownershipDocument>`;

const FORM4_NO_TRANSACTIONS = `<?xml version="1.0" encoding="UTF-8"?>
<ownershipDocument>
  <documentType>4</documentType>
  <issuer>
    <issuerCik>0003333333</issuerCik>
    <issuerName>EmptyFiling Inc</issuerName>
    <issuerTradingSymbol>EMPT</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId>
      <rptOwnerCik>0004444444</rptOwnerCik>
      <rptOwnerName>No Trade Nolan</rptOwnerName>
    </reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>true</isDirector>
      <isOfficer>false</isOfficer>
      <isTenPercentOwner>false</isTenPercentOwner>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable></nonDerivativeTable>
</ownershipDocument>`;

const MALFORMED_XML = `<ownershipDocument>
  <issuer>
    <issuerCik>broken
    <issuerName>Incomplete Tag
  </issuer>
  <this is not valid xml at all <<<>>>
</ownershipDocument>`;

const NOT_A_FORM4 = `<?xml version="1.0"?>
<html><body><h1>SEC EDGAR</h1><p>This is not a filing</p></body></html>`;

// ── Test runner ──

let passed = 0;
let failed = 0;

async function test(name, fn) {
  resetFetch();
  try {
    await fn();
    passed++;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
  }
}

// ── Tests ──

async function run() {
  console.log('\nsec-fetcher.test.js\n');

  // 1. Parses a valid Form 4 XML filing correctly
  await test('parseForm4Xml — extracts issuer, owner, and transactions', () => {
    const filing = { filedAt: '2026-04-01', accessionNumber: '0001234567-26-000001' };
    const result = parseForm4Xml(VALID_FORM4_XML, filing);

    assert.strictEqual(result.issuerCik, '0001234567');
    assert.strictEqual(result.issuerName, 'ACME Corp');
    assert.strictEqual(result.ticker, 'ACME');
    assert.strictEqual(result.ownerName, 'John Smith');
    assert.strictEqual(result.ownerCik, '0009876543');
    assert.strictEqual(result.isDirector, true);
    assert.strictEqual(result.isOfficer, true);
    assert.strictEqual(result.isTenPercentOwner, false);
    assert.strictEqual(result.officerTitle, 'CEO');
    assert.strictEqual(result.filedAt, '2026-04-01');
    assert.strictEqual(result.transactions.length, 1);

    const txn = result.transactions[0];
    assert.strictEqual(txn.type, 'non-derivative');
    assert.strictEqual(txn.code, 'P');
    assert.strictEqual(txn.codeLabel, 'Open market purchase');
    assert.strictEqual(txn.shares, 10000);
    assert.strictEqual(txn.pricePerShare, 25.5);
    assert.strictEqual(txn.totalValue, 255000);
    assert.strictEqual(txn.isOpenMarketBuy, true);
    assert.strictEqual(txn.isOpenMarketSell, false);
    assert.strictEqual(txn.acquired, true);
    assert.strictEqual(txn.disposed, false);
    assert.strictEqual(txn.transactionDate, '2026-04-01');
  });

  // 2. Handles malformed XML gracefully
  await test('parseForm4Xml — malformed XML returns result with empty fields, no throw', () => {
    const filing = { filedAt: '2026-04-01', accessionNumber: '000' };
    const result = parseForm4Xml(MALFORMED_XML, filing);

    // Should return an object (not null, not throw)
    assert.ok(result);
    assert.strictEqual(result.ticker, '');
    assert.strictEqual(result.transactions.length, 0);
  });

  await test('fetchAndParseForm4 — non-Form4 XML returns null', async () => {
    fetchHandler = () => makeOkResponse(NOT_A_FORM4);
    const filing = {
      cik: '123',
      accessionNumber: '0001234567-26-000001',
      fileUrl: 'https://www.sec.gov/Archives/edgar/data/123/000123456726000001/doc.xml',
      filedAt: '2026-04-01',
    };
    const result = await fetchAndParseForm4(filing);
    assert.strictEqual(result, null);
  });

  // 3. Handles SEC rate limit response (429)
  await test('fetchAndParseForm4 — 429 response returns null', async () => {
    fetchHandler = () => makeErrorResponse(429, '<html><body>Rate limited</body></html>');
    const filing = {
      cik: '123',
      accessionNumber: '0001234567-26-000001',
      fileUrl: 'https://www.sec.gov/Archives/edgar/data/123/000123456726000001/doc.xml',
      filedAt: '2026-04-01',
    };
    const result = await fetchAndParseForm4(filing);
    assert.strictEqual(result, null);
  });

  await test('fetchRecentFilingsFromFeed — 429 from EFTS falls back to daily index gracefully', async () => {
    let callCount = 0;
    fetchHandler = () => {
      callCount++;
      // First call = EFTS search, return 429
      // Subsequent calls = daily index attempts, return 404
      if (callCount === 1) return makeErrorResponse(429);
      return makeErrorResponse(404);
    };
    const results = await fetchRecentFilingsFromFeed(5);
    // Should not throw, returns empty array from failed fallback
    assert.ok(Array.isArray(results));
  });

  // 4. Handles network timeout — returns empty results, doesn't hang
  await test('fetchAndParseForm4 — network timeout returns null', async () => {
    fetchHandler = () => { throw new Error('network timeout'); };
    const filing = {
      cik: '123',
      accessionNumber: '0001234567-26-000001',
      fileUrl: 'https://www.sec.gov/Archives/edgar/data/123/000123456726000001/doc.xml',
      filedAt: '2026-04-01',
    };
    const result = await fetchAndParseForm4(filing);
    assert.strictEqual(result, null);
  });

  await test('fetchRecentFilingsFromFeed — fetch throws returns empty array', async () => {
    fetchHandler = () => { throw new Error('AbortError: The operation was aborted'); };
    const results = await fetchRecentFilingsFromFeed(5);
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0);
  });

  // 5. Multiple filings — processes batch correctly
  await test('fetchAndParseForm4 — processes multiple filings via index.json', async () => {
    const xmlFiles = {
      'https://www.sec.gov/Archives/edgar/data/100/000123456726000001/ownership.xml': VALID_FORM4_XML,
      'https://www.sec.gov/Archives/edgar/data/200/000222222226000001/form4.xml': FORM4_WITH_DERIVATIVE,
    };

    const filings = [
      { cik: '100', accessionNumber: '0001234567-26-000001', filedAt: '2026-04-01' },
      { cik: '200', accessionNumber: '0002222222-26-000001', filedAt: '2026-04-01' },
    ];

    fetchHandler = (url) => {
      // index.json requests
      if (url.endsWith('/index.json')) {
        if (url.includes('/100/')) {
          return makeOkResponse({ directory: { item: [{ name: 'ownership.xml' }] } }, 'application/json');
        }
        if (url.includes('/200/')) {
          return makeOkResponse({ directory: { item: [{ name: 'form4.xml' }] } }, 'application/json');
        }
      }
      // XML requests
      const xmlBody = xmlFiles[url];
      if (xmlBody) return makeOkResponse(xmlBody);
      return makeErrorResponse(404);
    };

    const results = [];
    for (const f of filings) {
      results.push(await fetchAndParseForm4(f));
    }

    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].ticker, 'ACME');
    assert.strictEqual(results[0].transactions.length, 1);
    assert.strictEqual(results[1].ticker, 'WDGT');
    assert.strictEqual(results[1].transactions.length, 2);
  });

  // 6. Filing with no transactions — skips it
  await test('parseForm4Xml — filing with no transactions has empty array', () => {
    const filing = { filedAt: '2026-04-01', accessionNumber: '000' };
    const result = parseForm4Xml(FORM4_NO_TRANSACTIONS, filing);

    assert.ok(result);
    assert.strictEqual(result.ticker, 'EMPT');
    assert.strictEqual(result.ownerName, 'No Trade Nolan');
    assert.strictEqual(result.transactions.length, 0);
  });

  // 7. Filing with derivative transactions vs direct — handles both
  await test('parseForm4Xml — parses both non-derivative and derivative transactions', () => {
    const filing = { filedAt: '2026-04-01', accessionNumber: '000' };
    const result = parseForm4Xml(FORM4_WITH_DERIVATIVE, filing);

    assert.strictEqual(result.ticker, 'WDGT');
    assert.strictEqual(result.ownerName, 'Jane Doe');
    assert.strictEqual(result.officerTitle, 'CFO');
    assert.strictEqual(result.transactions.length, 2);

    const nonDeriv = result.transactions.find(t => t.type === 'non-derivative');
    assert.ok(nonDeriv);
    assert.strictEqual(nonDeriv.code, 'S');
    assert.strictEqual(nonDeriv.codeLabel, 'Open market sale');
    assert.strictEqual(nonDeriv.shares, 5000);
    assert.strictEqual(nonDeriv.pricePerShare, 42);
    assert.strictEqual(nonDeriv.isOpenMarketSell, true);
    assert.strictEqual(nonDeriv.disposed, true);

    const deriv = result.transactions.find(t => t.type === 'derivative');
    assert.ok(deriv);
    assert.strictEqual(deriv.code, 'M');
    assert.strictEqual(deriv.codeLabel, 'Option exercise');
    assert.strictEqual(deriv.shares, 2000);
    assert.strictEqual(deriv.pricePerShare, 15);
    assert.strictEqual(deriv.isOptionExercise, true);
    assert.strictEqual(deriv.acquired, true);
  });

  // ── Additional edge cases ──

  await test('parseForm4Xml — amendment and 10b5-1 flags', () => {
    const xml = VALID_FORM4_XML
      .replace('</ownershipDocument>', '<isAmendment>true</isAmendment><rule10b5-1Flag>true</rule10b5-1Flag></ownershipDocument>');
    const result = parseForm4Xml(xml, { filedAt: '2026-04-01', accessionNumber: '000' });
    assert.strictEqual(result.isAmendment, true);
    assert.strictEqual(result.has10b51Plan, true);
  });

  await test('parseForm4Xml — XML entity decoding in names', () => {
    const xml = VALID_FORM4_XML.replace('ACME Corp', 'Smith &amp; Jones Inc');
    const result = parseForm4Xml(xml, { filedAt: '2026-04-01', accessionNumber: '000' });
    assert.strictEqual(result.issuerName, 'Smith & Jones Inc');
  });

  await test('fetchAndParseForm4 — missing cik/accession returns null', async () => {
    const result = await fetchAndParseForm4({ cik: '', accessionNumber: '' });
    assert.strictEqual(result, null);
    assert.strictEqual(fetchCalls.length, 0); // should not even attempt fetch
  });

  // ── Summary ──

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
