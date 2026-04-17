const fs = require('fs');
const path = require('path');
const { fetchSec, writeJson, readJson, ensureDir, toIsoDate, runConcurrent } = require('./util');

const CACHE_DIR = path.join(__dirname, '..', 'cache', 'form4');

/**
 * Search EDGAR full-text for Form 4 filings on a specific date.
 * EFTS caps results at 10,000 per query; a single day of Form 4s
 * typically fits well under that.
 */
async function searchForm4ForDate(date) {
  const results = [];
  const PAGE_SIZE = 100;
  let from = 0;

  while (true) {
    const url = `https://efts.sec.gov/LATEST/search-index?q=&forms=4&dateRange=custom&startdt=${date}&enddt=${date}&from=${from}&size=${PAGE_SIZE}`;
    let data;
    try {
      data = await fetchSec(url, { json: true });
    } catch (e) {
      console.error(`  EFTS search failed ${date} from=${from}: ${e.message}`);
      break;
    }
    const hits = data?.hits?.hits || [];
    if (!hits.length) break;

    for (const hit of hits) {
      const src = hit._source || {};
      const formType = src.form || src.form_type || '';
      if (formType !== '4' && formType !== '4/A') continue;
      const hitId = hit._id || '';
      const [accPart, xmlFilename] = hitId.split(':');
      const cikRaw = (src.ciks && src.ciks[0]) || '';
      const cik = cikRaw.replace(/^0+/, '');
      if (!accPart || !cik || !xmlFilename) continue;
      const accClean = accPart.replace(/-/g, '');
      // ciks[0] is typically the reporting owner for Form 4; archives are stored under that CIK.
      const issuerCikHint = (src.ciks && src.ciks[1]) ? src.ciks[1].replace(/^0+/, '') : '';
      results.push({
        accession: accPart,
        cik,                        // owner/filer CIK (used for Archives path)
        issuerCikHint,              // issuer CIK (confirmed via XML later)
        filedAt: src.file_date || date,
        formType,
        entityName: (src.display_names && src.display_names[0]) || '',
        xmlUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/${xmlFilename}`,
      });
    }

    const total = data?.hits?.total?.value || 0;
    from += hits.length;
    if (from >= total || hits.length < PAGE_SIZE) break;
    if (from >= 10000) {
      console.warn(`  EFTS 10k cap hit for ${date} — some filings may be missed`);
      break;
    }
  }

  return results;
}

// Extract single-value XML nodes via regex — Form 4 XML is small and well-structured.
function xmlVal(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>\\s*<value>([\\s\\S]*?)</value>\\s*</${tag}>`));
  if (m) return m[1].trim();
  const m2 = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m2 ? m2[1].trim() : '';
}

function xmlBool(xml, tag) {
  const v = xmlVal(xml, tag);
  return v === '1' || v.toLowerCase() === 'true';
}

function parseForm4Xml(xml, meta) {
  const issuerCik = xmlVal(xml, 'issuerCik').replace(/^0+/, '');
  const issuerName = xmlVal(xml, 'issuerName');
  const ticker = xmlVal(xml, 'issuerTradingSymbol').toUpperCase();

  const ownerBlockMatch = xml.match(/<reportingOwner>[\s\S]*?<\/reportingOwner>/);
  const ownerBlock = ownerBlockMatch ? ownerBlockMatch[0] : xml;
  const ownerCik = xmlVal(ownerBlock, 'rptOwnerCik').replace(/^0+/, '');
  const ownerName = xmlVal(ownerBlock, 'rptOwnerName');

  const relBlockMatch = ownerBlock.match(/<reportingOwnerRelationship>[\s\S]*?<\/reportingOwnerRelationship>/);
  const rel = relBlockMatch ? relBlockMatch[0] : ownerBlock;
  const isDirector = xmlBool(rel, 'isDirector');
  const isOfficer = xmlBool(rel, 'isOfficer');
  const isTenPercent = xmlBool(rel, 'isTenPercentOwner');
  const officerTitle = xmlVal(rel, 'officerTitle');

  const transactions = [];
  const txBlocks = xml.match(/<nonDerivativeTransaction>[\s\S]*?<\/nonDerivativeTransaction>/g) || [];
  for (const tx of txBlocks) {
    const code = xmlVal(tx, 'transactionCode');
    if (code !== 'P') continue;
    const txDate = xmlVal(tx, 'transactionDate');
    const shares = parseFloat(xmlVal(tx, 'transactionShares') || '0');
    const price = parseFloat(xmlVal(tx, 'transactionPricePerShare') || '0');
    const ad = xmlVal(tx, 'transactionAcquiredDisposedCode');
    if (ad !== 'A') continue;
    if (!txDate || !shares || !price) continue;
    transactions.push({ txDate, code, shares, price, value: shares * price });
  }

  if (!transactions.length) return null;

  return {
    accession: meta.accession,
    filedAt: meta.filedAt,
    issuerCik,
    issuerName,
    ticker,
    ownerCik,
    ownerName,
    isDirector,
    isOfficer,
    isTenPercent,
    officerTitle,
    transactions,
  };
}

async function fetchAndParseForm4(meta) {
  try {
    const xml = await fetchSec(meta.xmlUrl);
    return parseForm4Xml(xml, meta);
  } catch (e) {
    return { error: e.message, accession: meta.accession };
  }
}

/**
 * Pull all Form 4 P-transactions for a date range.
 * Checkpoints per-day to cache/form4/{date}.json so re-runs skip already-pulled days.
 *
 * opts:
 *   concurrency: number of parallel XML fetches (default 6)
 *   onProgress: function(incrementalCount, { errors }) — called periodically
 *   force: ignore cache
 */
async function pullForm4Range(startDate, endDate, opts = {}) {
  ensureDir(CACHE_DIR);
  const concurrency = opts.concurrency || 6;
  const onProgress = opts.onProgress || (() => {});
  const allBuys = [];
  let runningErrors = 0;
  const dates = [];
  let d = startDate;
  while (d <= endDate) {
    dates.push(d);
    d = toIsoDate(new Date(new Date(d).getTime() + 86400000));
  }

  for (const date of dates) {
    const cachePath = path.join(CACHE_DIR, `${date}.json`);
    let dayData = readJson(cachePath);
    if (dayData && !opts.force) {
      console.log(`  [cache] ${date} — ${dayData.buys.length} buys (${dayData.filingCount || '?'} filings)`);
      allBuys.push(...dayData.buys);
      onProgress(dayData.filingCount || 0, { errors: runningErrors });
      continue;
    }

    console.log(`  [fetch] ${date} — searching EFTS...`);
    const filings = await searchForm4ForDate(date);
    console.log(`  [fetch] ${date} — ${filings.length} Form 4 filings, parsing XML (concurrency=${concurrency})...`);

    const tasks = filings.map(f => () => fetchAndParseForm4(f));
    let processed = 0;
    const results = await runConcurrent(tasks, concurrency, (_r, _i) => {
      processed++;
      if (processed % 50 === 0) process.stdout.write(`    ...${processed}/${filings.length}\r`);
      onProgress(1, { errors: runningErrors });
    });

    const buys = [];
    let dayErrors = 0;
    for (const r of results) {
      if (r?.__error || r?.error) { dayErrors++; continue; }
      if (r.transactions && r.transactions.length) buys.push(r);
    }
    runningErrors += dayErrors;
    console.log(`  [fetch] ${date} — ${buys.length} filings had P-transactions (${dayErrors} errors)`);
    writeJson(cachePath, { date, fetchedAt: new Date().toISOString(), filingCount: filings.length, errors: dayErrors, buys });
    allBuys.push(...buys);
  }

  return allBuys;
}

module.exports = {
  pullForm4Range,
  searchForm4ForDate,
  fetchAndParseForm4,
  parseForm4Xml,
};
