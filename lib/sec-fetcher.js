/**
 * SEC EDGAR Form 4 Fetcher — v2
 * 
 * Approach: Use the EDGAR full-text search API (efts.sec.gov) to find
 * recent Form 4 filings, then fetch the filing index page to locate
 * the XML ownership document, then parse it.
 * 
 * The key insight: EFTS returns file_url fields that point directly
 * to filing documents. We use those to navigate to the filing index,
 * then find the XML ownership document.
 * 
 * Fallback: Use the EDGAR daily index for the most reliable data.
 */

const USER_AGENT = process.env.SEC_USER_AGENT || 'BuysideBrief hello@buysidebrief.com';
const RATE_LIMIT_MS = 120;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

/**
 * Fetch recent Form 4 filings using EDGAR full-text search.
 * Returns structured filing metadata.
 */
async function fetchRecentFilingsFromFeed(count = 40) {
  // Try EFTS search first
  try {
    const url = `https://efts.sec.gov/LATEST/search-index?q=%224%22&forms=4&dateRange=custom&startdt=${daysAgo(3)}&enddt=${today()}&from=0&size=${count}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    });
    
    if (res.ok) {
      const data = await res.json();
      const hits = data.hits?.hits || [];
      if (hits.length > 0) {
        return hits.map(parseEftsHit).filter(Boolean);
      }
    }
  } catch (e) {
    console.error('EFTS search failed:', e.message);
  }

  // Fallback: EDGAR daily index
  return await fetchFromDailyIndex(count);
}

/**
 * Parse a single EFTS search hit into our standard format.
 */
function parseEftsHit(hit) {
  const src = hit._source || {};
  const ciks = src.ciks || [];
  const names = src.display_names || [];
  
  // Extract accession number from the file URL or hit ID
  let accessionNumber = '';
  let cik = ciks[0] || '';
  
  // EFTS sometimes includes file_url like /Archives/edgar/data/CIK/ACCESSION/file.xml
  const fileUrl = src.file_url || '';
  const archiveMatch = fileUrl.match(/\/Archives\/edgar\/data\/(\d+)\/([\d-]+)\//);
  if (archiveMatch) {
    cik = archiveMatch[1];
    accessionNumber = archiveMatch[2];
  } else {
    // Try to extract from _id field
    accessionNumber = hit._id || '';
  }

  return {
    accessionNumber,
    cik,
    filedAt: src.file_date || src.period_of_report,
    formType: src.form_type || '4',
    entityName: names[0] || src.entity_name || 'Unknown',
    fileUrl: fileUrl,
  };
}

/**
 * Fallback: Fetch from EDGAR daily index.
 * The daily index lists every filing for a given day.
 */
async function fetchFromDailyIndex(count = 40) {
  const results = [];
  
  // Try today and yesterday
  for (const dateStr of [today(), daysAgo(1), daysAgo(2)]) {
    if (results.length >= count) break;
    
    try {
      const [year, month, day] = dateStr.split('-');
      const quarter = `QTR${Math.ceil(parseInt(month) / 3)}`;
      const url = `https://www.sec.gov/Archives/edgar/daily-index/${year}/${quarter}/form${dateStr.replace(/-/g, '')}.idx`;
      
      const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      await sleep(RATE_LIMIT_MS);
      
      if (!res.ok) continue;
      const text = await res.text();
      
      // Parse the index file — tab-separated after header
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.includes('4') || line.startsWith('Form Type')) continue;
        
        // Format: Form Type | Company Name | CIK | Date Filed | Filename
        const parts = line.split(/\s{2,}|\t/);
        if (parts.length < 5) continue;
        
        const formType = parts[0]?.trim();
        if (formType !== '4' && formType !== '4/A') continue;
        
        const companyName = parts[1]?.trim();
        const cik = parts[2]?.trim();
        const dateFiled = parts[3]?.trim();
        const filename = parts[4]?.trim();
        
        if (!cik || !filename) continue;
        
        // Extract accession number from filename path
        const accMatch = filename.match(/([\d-]+)/);
        const accessionNumber = accMatch ? accMatch[1] : '';
        
        results.push({
          accessionNumber,
          cik,
          filedAt: dateFiled,
          formType,
          entityName: companyName,
          fileUrl: `https://www.sec.gov/Archives/${filename}`,
        });
        
        if (results.length >= count) break;
      }
    } catch (e) {
      console.error(`Daily index fetch failed for ${dateStr}:`, e.message);
    }
  }
  
  return results;
}

/**
 * Fetch and parse a single Form 4 filing.
 * Strategy: Get the filing's index.json to find the XML document,
 * then fetch and parse the XML.
 */
async function fetchAndParseForm4(filing) {
  try {
    const { cik, accessionNumber } = filing;
    if (!cik || !accessionNumber) return null;
    
    // Clean accession number — remove dashes for URL path
    const accClean = accessionNumber.replace(/-/g, '');
    const accDashed = accessionNumber.includes('-') 
      ? accessionNumber 
      : accessionNumber.replace(/(\d{10})(\d{2})(\d+)/, '$1-$2-$3');
    
    // Step 1: Get the filing index to find the XML document
    const indexUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/index.json`;
    const indexRes = await fetch(indexUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    });
    await sleep(RATE_LIMIT_MS);
    
    if (!indexRes.ok) {
      // Try alternative: direct filing URL if we have one
      if (filing.fileUrl && filing.fileUrl.endsWith('.xml')) {
        return await fetchXmlDirect(filing.fileUrl, filing);
      }
      return null;
    }
    
    const indexData = await indexRes.json();
    const items = indexData.directory?.item || [];
    
    // Find the ownership XML document (not the R-file, not .txt)
    // Form 4 XMLs typically end in .xml and aren't named R*.xml
    const xmlDoc = items.find(i => 
      i.name?.endsWith('.xml') && 
      !i.name?.startsWith('R') &&
      !i.name?.startsWith('primary_doc') &&
      i.name !== 'FilingSummary.xml'
    ) || items.find(i => 
      i.name?.endsWith('.xml') && 
      i.name !== 'FilingSummary.xml'
    );
    
    if (!xmlDoc) return null;
    
    // Step 2: Fetch the XML
    const xmlUrl = `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/${xmlDoc.name}`;
    return await fetchXmlDirect(xmlUrl, filing);
    
  } catch (err) {
    console.error(`Error parsing filing for ${filing.entityName}:`, err.message);
    return null;
  }
}

/**
 * Fetch an XML URL directly and parse it.
 */
async function fetchXmlDirect(url, filing) {
  try {
    const fullUrl = url.startsWith('http') ? url : `https://www.sec.gov${url}`;
    const res = await fetch(fullUrl, { headers: { 'User-Agent': USER_AGENT } });
    await sleep(RATE_LIMIT_MS);
    
    if (!res.ok) return null;
    
    const xml = await res.text();
    
    // Verify this is actually a Form 4 ownership document
    if (!xml.includes('ownershipDocument') && !xml.includes('OwnershipDocument')) {
      return null;
    }
    
    return parseForm4Xml(xml, filing);
  } catch (err) {
    return null;
  }
}

/**
 * Parse Form 4 XML into structured transaction data.
 */
function parseForm4Xml(xml, filing) {
  const result = {
    issuerCik: extractXmlValue(xml, 'issuerCik'),
    issuerName: extractXmlValue(xml, 'issuerName'),
    ticker: extractXmlValue(xml, 'issuerTradingSymbol'),
    ownerName: extractXmlValue(xml, 'rptOwnerName'),
    ownerCik: extractXmlValue(xml, 'rptOwnerCik'),
    isDirector: xml.includes('<isDirector>true') || xml.includes('<isDirector>1'),
    isOfficer: xml.includes('<isOfficer>true') || xml.includes('<isOfficer>1'),
    isTenPercentOwner: xml.includes('<isTenPercentOwner>true') || xml.includes('<isTenPercentOwner>1'),
    officerTitle: extractXmlValue(xml, 'officerTitle'),
    filedAt: filing.filedAt,
    accessionNumber: filing.accessionNumber,
    transactions: [],
    isAmendment: xml.includes('<isAmendment>true'),
    has10b51Plan: xml.toLowerCase().includes('10b5-1') || 
                  xml.includes('<rule10b5-1Flag>true') ||
                  xml.includes('<rule10b51Flag>true'),
  };

  // Parse non-derivative transactions
  const nonDerivTxns = extractAllBetween(xml, '<nonDerivativeTransaction>', '</nonDerivativeTransaction>');
  for (const txn of nonDerivTxns) {
    const parsed = parseTransaction(txn, 'non-derivative');
    if (parsed) result.transactions.push(parsed);
  }

  // Parse derivative transactions
  const derivTxns = extractAllBetween(xml, '<derivativeTransaction>', '</derivativeTransaction>');
  for (const txn of derivTxns) {
    const parsed = parseTransaction(txn, 'derivative');
    if (parsed) result.transactions.push(parsed);
  }

  return result;
}

/**
 * Parse a single transaction block.
 * Codes: P=Purchase, S=Sale, A=Award, M=Exercise, C=Conversion, G=Gift, F=Tax
 */
function parseTransaction(txnXml, type) {
  const code = extractXmlValue(txnXml, 'transactionCode');
  const shares = parseFloat(
    extractXmlValue(txnXml, 'transactionShares>value') ||
    extractXmlValue(txnXml, 'transactionTotalValue') || '0'
  );
  const pricePerShare = parseFloat(
    extractXmlValue(txnXml, 'transactionPricePerShare>value') || '0'
  );
  const acquiredDisposed = extractXmlValue(txnXml, 'transactionAcquiredDisposedCode>value');
  const transactionDate = extractXmlValue(txnXml, 'transactionDate>value');

  if (!code && !shares) return null;

  return {
    type,
    code,
    codeLabel: TRANSACTION_CODES[code] || code || 'Unknown',
    shares,
    pricePerShare,
    totalValue: shares * pricePerShare,
    acquired: acquiredDisposed === 'A',
    disposed: acquiredDisposed === 'D',
    transactionDate,
    isOpenMarketBuy: code === 'P' && acquiredDisposed === 'A',
    isOpenMarketSell: code === 'S' && acquiredDisposed === 'D',
    isOptionExercise: code === 'M' || code === 'C',
    isGift: code === 'G',
    isAward: code === 'A',
  };
}

const TRANSACTION_CODES = {
  P: 'Open market purchase',
  S: 'Open market sale',
  A: 'Grant/Award',
  M: 'Option exercise',
  C: 'Conversion',
  G: 'Gift',
  F: 'Tax withholding',
  J: 'Other',
  K: 'Equity swap',
  I: 'Discretionary',
  W: 'Warrant exercise',
};

// ── XML Helpers ──

function extractXmlValue(xml, tag) {
  const parts = tag.split('>');
  let context = xml;
  for (const part of parts) {
    const regex = new RegExp(`<${part}[^>]*>([\\s\\S]*?)</${part}>`, 'i');
    const match = context.match(regex);
    if (!match) return '';
    context = match[1];
  }
  return context.trim();
}

function extractAllBetween(xml, startTag, endTag) {
  const results = [];
  let idx = 0;
  while (true) {
    const start = xml.indexOf(startTag, idx);
    if (start === -1) break;
    const end = xml.indexOf(endTag, start);
    if (end === -1) break;
    results.push(xml.substring(start, end + endTag.length));
    idx = end + endTag.length;
  }
  return results;
}

// ── Date Helpers ──

function today() {
  return new Date().toISOString().split('T')[0];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

module.exports = {
  fetchRecentFilingsFromFeed,
  fetchFromDailyIndex,
  fetchAndParseForm4,
  parseForm4Xml,
  TRANSACTION_CODES,
  USER_AGENT,
};
