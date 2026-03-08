/**
 * SEC EDGAR Form 4 Fetcher
 * 
 * Fetches recent Form 4 filings from EDGAR full-text search,
 * then parses individual filing XML to extract transaction data.
 * 
 * SEC API docs: https://efts.sec.gov/LATEST/
 * Form 4 XML schema: https://www.sec.gov/info/edgar/specifications/ownershipxmldoc.htm
 */

const SEC_SEARCH_URL = 'https://efts.sec.gov/LATEST/search-index';
const SEC_ARCHIVES_URL = 'https://www.sec.gov/Archives/edgar/data';
const USER_AGENT = process.env.SEC_USER_AGENT || 'BuysideBrief hello@buysidebrief.com';

// SEC rate limit: 10 requests/second — we stay well under
const RATE_LIMIT_MS = 150;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch recent Form 4 filing index from EDGAR full-text search.
 * Returns an array of filing metadata (accession numbers, filer info).
 */
async function fetchRecentFilingIndex(daysBack = 1) {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - daysBack);

  const fmt = (d) => d.toISOString().split('T')[0];

  // Use EFTS search API to find recent Form 4 filings
  const url = `https://efts.sec.gov/LATEST/search-index?q=%224%22&forms=4&dateRange=custom&startdt=${fmt(startDate)}&enddt=${fmt(endDate)}&from=0&size=50`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
  });

  if (!res.ok) {
    // Fallback: try the EDGAR full-text search API
    const fallbackUrl = `https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=${fmt(startDate)}&enddt=${fmt(endDate)}`;
    const fallbackRes = await fetch(fallbackUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    });
    if (!fallbackRes.ok) {
      throw new Error(`EDGAR search failed: ${fallbackRes.status} ${fallbackRes.statusText}`);
    }
    return parseSearchResults(await fallbackRes.json());
  }

  return parseSearchResults(await res.json());
}

/**
 * Alternative: Use the EDGAR recent filings RSS/JSON feed.
 * More reliable for "latest N filings" use case.
 */
async function fetchRecentFilingsFromFeed(count = 40) {
  const url = `https://efts.sec.gov/LATEST/search-index?forms=4&from=0&size=${count}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
  });

  if (!res.ok) {
    throw new Error(`EDGAR feed failed: ${res.status}`);
  }

  return parseSearchResults(await res.json());
}

/**
 * Parse EDGAR search results into a structured array.
 */
function parseSearchResults(data) {
  if (!data.hits || !data.hits.hits) return [];

  return data.hits.hits.map(hit => {
    const src = hit._source || {};
    return {
      accessionNumber: src.file_num || hit._id,
      filedAt: src.file_date,
      formType: src.form_type || '4',
      entityName: src.entity_name || src.display_names?.[0] || 'Unknown',
      cik: src.entity_id || src.ciks?.[0],
      fileUrl: src.file_url,
    };
  });
}

/**
 * Fetch and parse a single Form 4 XML filing.
 * This is where the real transaction data lives.
 */
async function fetchAndParseForm4(filing) {
  try {
    // First, get the filing index page to find the XML document
    const indexUrl = buildFilingIndexUrl(filing);
    if (!indexUrl) return null;

    const indexRes = await fetch(indexUrl, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
    });
    await sleep(RATE_LIMIT_MS);

    if (!indexRes.ok) return null;

    // Try to get the JSON index which lists all documents in the filing
    let xmlUrl = null;

    // If we have a direct file URL, use it
    if (filing.fileUrl) {
      xmlUrl = filing.fileUrl.startsWith('http')
        ? filing.fileUrl
        : `https://www.sec.gov${filing.fileUrl}`;
    } else {
      // Parse the index to find the primary XML document
      const indexText = await indexRes.text();
      xmlUrl = extractXmlUrlFromIndex(indexText, filing);
    }

    if (!xmlUrl) return null;

    const xmlRes = await fetch(xmlUrl, {
      headers: { 'User-Agent': USER_AGENT }
    });
    await sleep(RATE_LIMIT_MS);

    if (!xmlRes.ok) return null;

    const xmlText = await xmlRes.text();
    return parseForm4Xml(xmlText, filing);
  } catch (err) {
    console.error(`Error parsing filing for ${filing.entityName}:`, err.message);
    return null;
  }
}

/**
 * Build the filing index URL from accession number and CIK.
 */
function buildFilingIndexUrl(filing) {
  if (!filing.cik) return null;
  const accClean = (filing.accessionNumber || '').replace(/-/g, '');
  if (!accClean) return null;
  return `${SEC_ARCHIVES_URL}/${filing.cik}/${accClean}/index.json`;
}

/**
 * Extract the primary XML document URL from a filing index page.
 */
function extractXmlUrlFromIndex(indexText, filing) {
  try {
    const indexData = JSON.parse(indexText);
    const docs = indexData.directory?.item || [];
    // Look for the primary XML document (not the R-file or text)
    const xmlDoc = docs.find(d =>
      d.name?.endsWith('.xml') &&
      !d.name?.startsWith('R') &&
      !d.name?.includes('primary_doc')
    ) || docs.find(d => d.name?.endsWith('.xml'));

    if (xmlDoc) {
      const accClean = (filing.accessionNumber || '').replace(/-/g, '');
      return `${SEC_ARCHIVES_URL}/${filing.cik}/${accClean}/${xmlDoc.name}`;
    }
  } catch {
    // Try HTML parsing as fallback
    const match = indexText.match(/href="([^"]+\.xml)"/i);
    if (match) return `https://www.sec.gov${match[1]}`;
  }
  return null;
}

/**
 * Parse Form 4 XML into structured transaction data.
 * 
 * Form 4 XML structure:
 * <ownershipDocument>
 *   <issuer><issuerCik>, <issuerName>, <issuerTradingSymbol>
 *   <reportingOwner><reportingOwnerId>, <reportingOwnerRelationship>
 *   <nonDerivativeTable><nonDerivativeTransaction>...
 *   <derivativeTable><derivativeTransaction>...
 * </ownershipDocument>
 */
function parseForm4Xml(xml, filing) {
  const result = {
    // Issuer (the company)
    issuerCik: extractXmlValue(xml, 'issuerCik'),
    issuerName: extractXmlValue(xml, 'issuerName'),
    ticker: extractXmlValue(xml, 'issuerTradingSymbol'),

    // Owner (the insider)
    ownerName: extractXmlValue(xml, 'rptOwnerName'),
    ownerCik: extractXmlValue(xml, 'rptOwnerCik'),

    // Relationship
    isDirector: xml.includes('<isDirector>true</isDirector>') || xml.includes('<isDirector>1</isDirector>'),
    isOfficer: xml.includes('<isOfficer>true</isOfficer>') || xml.includes('<isOfficer>1</isOfficer>'),
    isTenPercentOwner: xml.includes('<isTenPercentOwner>true</isTenPercentOwner>') || xml.includes('<isTenPercentOwner>1</isTenPercentOwner>'),
    officerTitle: extractXmlValue(xml, 'officerTitle'),

    // Filing metadata
    filedAt: filing.filedAt,
    accessionNumber: filing.accessionNumber,

    // Transactions
    transactions: [],

    // Is this an amendment?
    isAmendment: xml.includes('<isAmendment>true</isAmendment>'),

    // Is there a 10b5-1 plan?
    has10b51Plan: xml.includes('<rule10b5-1Flag>true</rule10b5-1Flag>') ||
                  xml.includes('<rule10b51Flag>true</rule10b51Flag>') ||
                  xml.toLowerCase().includes('10b5-1'),
  };

  // Parse non-derivative transactions (direct stock buys/sells)
  const nonDerivTxns = extractAllBetween(xml, '<nonDerivativeTransaction>', '</nonDerivativeTransaction>');
  for (const txn of nonDerivTxns) {
    const parsed = parseTransaction(txn, 'non-derivative');
    if (parsed) result.transactions.push(parsed);
  }

  // Parse derivative transactions (options, warrants, etc.)
  const derivTxns = extractAllBetween(xml, '<derivativeTransaction>', '</derivativeTransaction>');
  for (const txn of derivTxns) {
    const parsed = parseTransaction(txn, 'derivative');
    if (parsed) result.transactions.push(parsed);
  }

  return result;
}

/**
 * Parse a single transaction block from Form 4 XML.
 * 
 * Transaction codes:
 *   P = Open market purchase
 *   S = Open market sale
 *   A = Grant/Award
 *   M = Exercise of options
 *   C = Conversion of derivative
 *   G = Gift
 *   F = Tax withholding
 *   J = Other
 */
function parseTransaction(txnXml, type) {
  const code = extractXmlValue(txnXml, 'transactionCode');
  const shares = parseFloat(extractXmlValue(txnXml, 'transactionShares>value') ||
                            extractXmlValue(txnXml, 'transactionTotalValue') || '0');
  const pricePerShare = parseFloat(extractXmlValue(txnXml, 'transactionPricePerShare>value') || '0');
  const acquiredDisposed = extractXmlValue(txnXml, 'transactionAcquiredDisposedCode>value');
  const transactionDate = extractXmlValue(txnXml, 'transactionDate>value');

  // Skip if no meaningful data
  if (!code && !shares) return null;

  const totalValue = shares * pricePerShare;

  return {
    type,
    code,
    codeLabel: TRANSACTION_CODES[code] || code || 'Unknown',
    shares,
    pricePerShare,
    totalValue,
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

// --- XML Helpers ---

function extractXmlValue(xml, tag) {
  // Handle nested tags like "transactionShares>value"
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

module.exports = {
  fetchRecentFilingIndex,
  fetchRecentFilingsFromFeed,
  fetchAndParseForm4,
  parseForm4Xml,
  TRANSACTION_CODES,
  USER_AGENT,
};
