/**
 * House PTR PDF downloader + parser.
 *
 * For a given filing DocID:
 *   1. Download https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/{year}/{docId}.pdf
 *   2. Extract text via pdf-parse
 *   3. Parse the Transactions section — one row per (owner, asset, tx-type, tx-date)
 *
 * Transaction row format observed (PDF-extracted text is whitespace-noisy):
 *   [OWNER?] Asset Name (TICKER)      <-- owner is SP/JT/DC or blank; ticker in parens
 *   [ST]                              <-- asset type code, [ST] = stock, [GS] = treasury, etc.
 *   P|S|E (optional " (partial)")     <-- transaction type
 *   MM/DD/YYYY MM/DD/YYYY             <-- transaction date, notification date
 *   $low - $high                      <-- amount range
 *
 * We only keep [ST] assets with a detectable ticker and P-type purchases.
 * Everything else is retained in `allRows` for audit, but not used for matching.
 */
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const { fetchHouse, writeJson, readJson, ensureDir, parseUsDate } = require('./util');

const PDF_CACHE = path.join(__dirname, '..', 'cache', 'house-ptr-pdfs');
const PARSED_CACHE = path.join(__dirname, '..', 'cache', 'house-ptr-parsed');

async function downloadPdf(year, docId) {
  ensureDir(PDF_CACHE);
  const dest = path.join(PDF_CACHE, `${year}-${docId}.pdf`);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) return dest;
  const url = `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`;
  const buf = await fetchHouse(url, { responseType: 'buffer' });
  fs.writeFileSync(dest, buf);
  return dest;
}

async function pdfToText(pdfPath) {
  const data = fs.readFileSync(pdfPath);
  const parser = new PDFParse({ data });
  const result = await parser.getText();
  return result.text || '';
}

// Amount range midpoint. Returns dollars as a number, or null.
function amountMidpoint(rangeText) {
  if (!rangeText) return null;
  // "$1,001 - $15,000" or "$15,001 -\n$50,000"
  const cleaned = rangeText.replace(/[\s\n]+/g, ' ');
  const m = cleaned.match(/\$([\d,]+)\s*-\s*\$([\d,]+)/);
  if (!m) {
    // open-ended upper, e.g. "$50,000,001 +"
    const m2 = cleaned.match(/\$([\d,]+)\s*\+/);
    if (m2) return Number(m2[1].replace(/,/g, ''));
    return null;
  }
  const lo = Number(m[1].replace(/,/g, ''));
  const hi = Number(m[2].replace(/,/g, ''));
  return Math.round((lo + hi) / 2);
}

// Parse the transactions section of a PTR PDF into structured rows.
function parseTransactions(rawText) {
  // Isolate the transactions block. The header row is the "Owner / Asset / Transaction Type / Date / Notification Date / Amount / Cap. Gains..." columns.
  // The block ends at "* For the complete list of asset type abbreviations" or "Filing Status" group or page footers.
  const startRe = /Amount\s+Cap\./i;
  const endRe = /For the complete list of asset type abbreviations|Initial Public Offering|Filing ID #/i;
  const start = rawText.search(startRe);
  if (start < 0) return { rows: [], error: 'no-transactions-header' };
  const afterHeader = rawText.slice(start).replace(/^[^\n]*\n/, ''); // drop the header line
  const endIdx = afterHeader.search(endRe);
  const block = endIdx >= 0 ? afterHeader.slice(0, endIdx) : afterHeader;

  // Each transaction's ticker appears as `(TICKER)` immediately before `[ST]` (or other 2-letter asset type).
  // We anchor extraction on that pair and then scan forward for tx-type + dates + amount.
  const rows = [];
  // Ticker: 1-5 uppercase letters, optionally followed by .X or -X for class shares (e.g. BRK.B, BF-B)
  // Then optional whitespace/newline, then [XX] asset type.
  const txRe = /\(([A-Z][A-Z0-9]{0,5}(?:[.\-][A-Z]{1,3})?)\)\s*\[([A-Z]{2})\]/g;
  let m;
  const marks = [];
  while ((m = txRe.exec(block)) !== null) {
    marks.push({ ticker: m[1], assetType: m[2], startIdx: m.index, endIdx: m.index + m[0].length });
  }

  for (let i = 0; i < marks.length; i++) {
    const cur = marks[i];
    const next = marks[i + 1];
    const tail = block.slice(cur.endIdx, next ? next.startIdx : block.length);

    // Look for: tx-type (P|S|E) optionally " (partial)" or " (full)", then first MM/DD/YYYY
    const rowRe = /(P|S|E)\s*(\(partial\)|\(full\))?\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})/;
    const rowMatch = tail.match(rowRe);
    if (!rowMatch) continue;

    // Amount range: allow newline inside the dash-split
    const amtMatch = tail.match(/\$[\d,]+\s*-\s*\n?\s*\$[\d,]+|\$[\d,]+\s*\+/);
    const amountText = amtMatch ? amtMatch[0].replace(/\s+/g, ' ') : '';

    // Owner prefix: scan backward in the previous tail (from previous mark's tail end)
    // PDF text places owner prefix (SP, JT, DC) before the asset name on the same line.
    const preCtx = block.slice(Math.max(0, cur.startIdx - 120), cur.startIdx);
    const ownerMatch = preCtx.match(/\b(SP|JT|DC)\s+\S/);
    const ownerCode = ownerMatch ? ownerMatch[1] : 'SELF';

    rows.push({
      ticker: cur.ticker.toUpperCase(),
      assetType: cur.assetType,
      ownerCode,
      txType: rowMatch[1],
      txTypeQualifier: rowMatch[2] ? rowMatch[2].replace(/[()]/g, '') : null,
      txDate: parseUsDate(rowMatch[3]),
      notificationDate: parseUsDate(rowMatch[4]),
      amountRangeText: amountText,
      amountMidpoint: amountMidpoint(amountText),
    });
  }

  return { rows };
}

async function fetchAndParse(year, docId, opts = {}) {
  const parsedPath = path.join(PARSED_CACHE, `${year}-${docId}.json`);
  const cached = readJson(parsedPath);
  if (cached && !opts.force) return cached;

  ensureDir(PARSED_CACHE);
  try {
    const pdfPath = await downloadPdf(year, docId);
    const text = await pdfToText(pdfPath);
    const parsed = parseTransactions(text);
    const out = { year, docId, rowCount: parsed.rows.length, error: parsed.error || null, rows: parsed.rows };
    writeJson(parsedPath, out);
    return out;
  } catch (e) {
    const out = { year, docId, rowCount: 0, error: e.message, rows: [] };
    writeJson(parsedPath, out);
    return out;
  }
}

module.exports = { downloadPdf, pdfToText, parseTransactions, amountMidpoint, fetchAndParse };
