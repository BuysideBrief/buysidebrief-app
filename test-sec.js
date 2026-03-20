require('dotenv').config();
const { fetchAndParseForm4 } = require('./lib/sec-fetcher');

const testFiling = {
  accessionNumber: '0001897926-26-000002',
  cik: '1897926',
  fileUrl: 'https://www.sec.gov/Archives/edgar/data/1897926/000189792626000002/ownership.xml',
  filedAt: '2026-03-17',
  entityName: 'Test',
};

fetchAndParseForm4(testFiling).then(r => {
  if (r) {
    console.log('SUCCESS:', r.ticker, r.transactions.length, 'transactions');
  } else {
    console.log('NULL - filing failed to parse');
  }
}).catch(e => console.error('Error:', e.message));
