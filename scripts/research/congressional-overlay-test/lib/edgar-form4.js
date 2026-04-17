/**
 * Form 4 EFTS search + XML parse. Standalone reimplementation — not importing
 * from the new-exec-signal-test. Same SEC patterns:
 *  - efts.sec.gov full-text search with form=4 filter, day-by-day
 *  - https://www.sec.gov/Archives/edgar/data/{cik}/{acc}/{xmlname} for ownership XML
 *  - Regex-based XML extraction (no XML parser lib)
 *
 * Only P (purchase) + A (Acquired) non-derivative transactions are returned.
 */
const fs = require('fs');
const path = require('path');
const { fetchSec, writeJson, readJson, ensureDir, toIsoDate, runConcurrent } = require('./util');

const CACHE = path.join(__dirname, '..', 'cache', 'form4');

async function searchForDate(date) {
  const out = [];
  const size = 100;
  let from = 0;
  while (true) {
    const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=4&dateRange=custom&startdt=${date}&enddt=${date}&from=${from}&size=${size}`;
    let data;
    try { data = await fetchSec(url, { json: true }); }
    catch (e) { console.error(`  EFTS ${date} from=${from}: ${e.message}`); break; }
    const hits = data?.hits?.hits || [];
    if (!hits.length) break;
    for (const h of hits) {
      const s = h._source || {};
      const formType = s.form || s.form_type || '';
      if (formType !== '4' && formType !== '4/A') continue;
      const [accPart, xmlName] = (h._id || '').split(':');
      const cikRaw = (s.ciks && s.ciks[0]) || '';
      const cik = cikRaw.replace(/^0+/, '');
      if (!accPart || !cik || !xmlName) continue;
      const accClean = accPart.replace(/-/g, '');
      out.push({
        accession: accPart,
        cik,
        filedAt: s.file_date || date,
        entityName: (s.display_names && s.display_names[0]) || '',
        xmlUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/${xmlName}`,
      });
    }
    const total = data?.hits?.total?.value || 0;
    from += hits.length;
    if (from >= total || hits.length < size || from >= 10000) break;
  }
  return out;
}

function xv(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>\\s*<value>([\\s\\S]*?)</value>\\s*</${tag}>`));
  if (m) return m[1].trim();
  const m2 = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m2 ? m2[1].trim() : '';
}
function xb(xml, tag) { const v = xv(xml, tag); return v === '1' || v.toLowerCase() === 'true'; }

function parseOwnershipXml(xml, meta) {
  const issuerCik = xv(xml, 'issuerCik').replace(/^0+/, '');
  const issuerName = xv(xml, 'issuerName');
  const ticker = xv(xml, 'issuerTradingSymbol').toUpperCase();

  const ownerBlockM = xml.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/);
  const ownerBlock = ownerBlockM ? ownerBlockM[0] : xml;
  const ownerName = xv(ownerBlock, 'rptOwnerName');
  const ownerCik = xv(ownerBlock, 'rptOwnerCik').replace(/^0+/, '');

  const relM = ownerBlock.match(/<reportingOwnerRelationship>[\s\S]*?<\/reportingOwnerRelationship>/);
  const rel = relM ? relM[0] : ownerBlock;
  const isDirector = xb(rel, 'isDirector');
  const isOfficer = xb(rel, 'isOfficer');
  const officerTitle = xv(rel, 'officerTitle');

  const txs = [];
  const blocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) || [];
  for (const b of blocks) {
    if (xv(b, 'transactionCode') !== 'P') continue;
    if (xv(b, 'transactionAcquiredDisposedCode') !== 'A') continue;
    const txDate = xv(b, 'transactionDate');
    const shares = parseFloat(xv(b, 'transactionShares') || '0');
    const price = parseFloat(xv(b, 'transactionPricePerShare') || '0');
    if (!txDate || !shares || !price) continue;
    txs.push({ txDate, shares, price, value: shares * price });
  }
  if (!txs.length) return null;

  return {
    accession: meta.accession,
    filedAt: meta.filedAt,
    issuerCik, issuerName, ticker,
    ownerCik, ownerName,
    isDirector, isOfficer, officerTitle,
    transactions: txs,
  };
}

async function fetchAndParse(meta) {
  try {
    const xml = await fetchSec(meta.xmlUrl);
    return parseOwnershipXml(xml, meta);
  } catch (e) {
    return { error: e.message, accession: meta.accession };
  }
}

async function pullRange(startDate, endDate, opts = {}) {
  ensureDir(CACHE);
  const concurrency = opts.concurrency || 6;
  const onProgress = opts.onProgress || (() => {});
  const dates = [];
  for (let d = startDate; d <= endDate; d = toIsoDate(new Date(new Date(d).getTime() + 86400000))) dates.push(d);

  const allBuys = [];
  let runningErrors = 0;

  for (const date of dates) {
    const cachePath = path.join(CACHE, `${date}.json`);
    const cached = readJson(cachePath);
    if (cached && !opts.force) {
      console.log(`  [cache] form4 ${date} — ${cached.buys.length} buys`);
      allBuys.push(...cached.buys);
      onProgress(cached.filingCount || 0, { errors: runningErrors });
      continue;
    }
    console.log(`  [fetch] form4 ${date} — EFTS...`);
    const filings = await searchForDate(date);
    console.log(`  [fetch] form4 ${date} — ${filings.length} filings, parsing XML (conc=${concurrency})...`);
    const tasks = filings.map(f => () => fetchAndParse(f));
    let processed = 0;
    const results = await runConcurrent(tasks, concurrency, () => {
      processed++;
      if (processed % 50 === 0) process.stdout.write(`    ...${processed}/${filings.length}\r`);
      onProgress(1, { errors: runningErrors });
    });
    const buys = [];
    let dayErrors = 0;
    for (const r of results) {
      if (r?.__error || r?.error) { dayErrors++; continue; }
      // null results (Form 4 with no P-tx) are normal — do NOT count as errors.
      if (r?.transactions?.length) buys.push(r);
    }
    runningErrors += dayErrors;
    console.log(`  [fetch] form4 ${date} — ${buys.length} buys (${dayErrors} fetch errors)`);
    writeJson(cachePath, { date, fetchedAt: new Date().toISOString(), filingCount: filings.length, errors: dayErrors, buys });
    allBuys.push(...buys);
  }
  return allBuys;
}

module.exports = { searchForDate, fetchAndParse, parseOwnershipXml, pullRange };
