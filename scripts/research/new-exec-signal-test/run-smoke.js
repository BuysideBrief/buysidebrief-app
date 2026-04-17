#!/usr/bin/env node
/**
 * Smoke test: single day of Form 4 + single day of 8-K 5.02 + one price pull.
 * Just verifies the pieces work end-to-end before investing in the full sanity run.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env.local') });

const { searchForm4ForDate, fetchAndParseForm4 } = require('./lib/edgar-form4');
const { search8K502ForDate, parse8K502, htmlToText } = require('./lib/edgar-8k-502');
const { fetchSec } = require('./lib/util');
const { matchNames } = require('./lib/name-match');
const { getDailyBars, getTickerMeta } = require('./lib/prices');
const { computeForwardReturns } = require('./lib/returns');

async function main() {
  const TEST_DATE = '2025-04-16';
  console.log(`\n=== SMOKE TEST (single day: ${TEST_DATE}) ===\n`);

  // 1. Form 4
  console.log('[1] Form 4 search...');
  const form4Filings = await searchForm4ForDate(TEST_DATE);
  console.log(`    Found ${form4Filings.length} Form 4 filings`);
  if (form4Filings.length === 0) throw new Error('No Form 4 filings — EFTS search broken?');
  console.log(`    Sample: ${form4Filings[0].entityName} / ${form4Filings[0].accession}`);

  console.log('[1] Parsing first 30 Form 4 XMLs...');
  let parsedCount = 0;
  let errorCount = 0;
  for (const f of form4Filings.slice(0, 30)) {
    const parsed = await fetchAndParseForm4(f);
    if (parsed && parsed.transactions && parsed.transactions.length) {
      parsedCount++;
      console.log(`    ✓ ${parsed.ticker} ${parsed.ownerName} / ${parsed.officerTitle || '(no title)'} — ${parsed.transactions.length} P-tx`);
      for (const tx of parsed.transactions) {
        console.log(`       ${tx.txDate}: ${tx.shares} sh @ $${tx.price}`);
      }
    } else if (parsed?.error) {
      errorCount++;
    }
  }
  console.log(`    Parsed ${parsedCount}/30 with P-transactions (${errorCount} errors)\n`);

  // 2. 8-K 5.02
  console.log('[2] 8-K Item 5.02 search...');
  const k8Filings = await search8K502ForDate(TEST_DATE);
  console.log(`    Found ${k8Filings.length} 8-K filings with Item 5.02`);
  if (k8Filings.length === 0) {
    console.log('    WARN: no 8-Ks — unusual but not fatal');
  } else {
    console.log(`    Sample: ${k8Filings[0].entityName} / ${k8Filings[0].accession}`);
    console.log('[2] Fetching + parsing first 3 8-K docs...');
    for (const f of k8Filings.slice(0, 3)) {
      try {
        const html = await fetchSec(f.docUrl);
        const text = htmlToText(html);
        const parsed = parse8K502(text, f.filedAt);
        console.log(`    ${f.entityName} — ${parsed.appointments?.length || 0} appointments`);
        for (const a of (parsed.appointments || []).slice(0, 3)) {
          console.log(`       ${a.name} — ${a.role} (${a.appointmentType}, eff ${a.effectiveDate})`);
        }
      } catch (e) {
        console.log(`    ✗ ${f.entityName}: ${e.message}`);
      }
    }
  }

  // 3. Name matching sanity
  console.log('\n[3] Name matcher checks:');
  const cases = [
    ['SMITH JOHN A', 'John A. Smith'],
    ['SMITH JOHN', 'John Smith Jr.'],
    ['DOE JANE MARIE', 'Jane M. Doe'],
    ['SMITH JOHN', 'John Doe'],
    ['JOHNSON ROBERT', 'Bob Johnson'],
  ];
  for (const [a, b] of cases) {
    const m = matchNames(a, b);
    console.log(`    "${a}" vs "${b}" → ${m.match ? m.confidence : 'no-match'} (${m.reason})`);
  }

  // 4. Price pull
  console.log('\n[4] Polygon price pull (SPY 2-week window)...');
  const spy = await getDailyBars('SPY', '2025-04-16', '2025-04-29');
  console.log(`    SPY bars: ${spy.bars.length} (first ${spy.bars[0]?.date} close=$${spy.bars[0]?.c}, last ${spy.bars[spy.bars.length - 1]?.date} close=$${spy.bars[spy.bars.length - 1]?.c})`);

  // 5. Ticker meta
  console.log('[5] Ticker meta for AAPL...');
  const meta = await getTickerMeta('AAPL');
  console.log(`    AAPL: exchange=${meta.exchange} name=${meta.name}`);

  // 6. Return calc
  console.log('\n[6] Return calc test (fake data)...');
  const fakeBars = [];
  for (let i = 0; i < 120; i++) {
    const d = new Date('2025-04-16');
    d.setDate(d.getDate() + i);
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    fakeBars.push({ date: d.toISOString().slice(0, 10), c: 100 + i * 0.5 });
  }
  const fakeSpy = fakeBars.map(b => ({ ...b, c: 500 + (b.c - 100) * 2 }));
  const r = computeForwardReturns(fakeBars, fakeSpy, '2025-04-16');
  console.log(`    r30: ret=${(r.r30?.return * 100).toFixed(2)}% excess=${(r.r30?.excess * 100).toFixed(2)}%`);
  console.log(`    r60: ret=${(r.r60?.return * 100).toFixed(2)}% excess=${(r.r60?.excess * 100).toFixed(2)}%`);
  console.log(`    r90: ret=${(r.r90?.return * 100).toFixed(2)}% excess=${(r.r90?.excess * 100).toFixed(2)}%`);

  console.log('\n=== SMOKE TEST COMPLETE ===');
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
