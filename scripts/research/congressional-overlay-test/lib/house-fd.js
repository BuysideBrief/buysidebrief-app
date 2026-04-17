/**
 * House Financial Disclosures: download the year's FD zip, extract the XML,
 * parse out the list of P (PTR / Periodic Transaction Report) filings.
 *
 * The FD zip contains ONLY filing metadata (name, state/district, DocID,
 * filing type, filing date). The actual trade rows live in per-DocID PDFs
 * which are parsed by house-ptr-parser.js.
 *
 * Source: https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{year}FD.zip
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { fetchHouse, writeJson, readJson, ensureDir } = require('./util');

const CACHE_DIR = path.join(__dirname, '..', 'cache', 'house-fd');

async function fetchFdZip(year) {
  ensureDir(CACHE_DIR);
  const zipPath = path.join(CACHE_DIR, `${year}FD.zip`);
  const metaPath = path.join(CACHE_DIR, `${year}FD.meta.json`);
  const cachedMeta = readJson(metaPath);
  // Refresh if older than 24h — the zip is updated daily.
  if (cachedMeta && fs.existsSync(zipPath) && (Date.now() - cachedMeta.fetchedAt < 86400000)) {
    return { zipPath, refreshed: false, ...cachedMeta };
  }
  const url = `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`;
  const buf = await fetchHouse(url, { responseType: 'buffer' });
  fs.writeFileSync(zipPath, buf);
  const meta = { year, url, fetchedAt: Date.now(), bytes: buf.length };
  writeJson(metaPath, meta);
  return { zipPath, refreshed: true, ...meta };
}

function extractXml(zipPath, innerName) {
  // Use system `unzip -p` — available on macOS/Linux out of the box, avoids a JS zip dep.
  try {
    return execSync(`unzip -p "${zipPath}" "${innerName}"`, { maxBuffer: 50 * 1024 * 1024 }).toString('utf8');
  } catch (e) {
    throw new Error(`unzip failed for ${zipPath}:${innerName} — ${e.message}`);
  }
}

/**
 * Parse the year's FD XML into { year, filings: [{ last, first, docId, filingType, filingDate, stateDst }] }
 * Filters to filingType === 'P' (PTR) by default.
 */
function parseFdXml(xml, { onlyPtr = true } = {}) {
  const filings = [];
  const memberRe = /<Member>([\s\S]*?)<\/Member>/g;
  let m;
  while ((m = memberRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const mm = block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
      return mm ? mm[1].trim() : '';
    };
    const filingType = get('FilingType');
    if (onlyPtr && filingType !== 'P') continue;
    filings.push({
      prefix: get('Prefix'),
      last: get('Last'),
      first: get('First'),
      suffix: get('Suffix'),
      filingType,
      stateDst: get('StateDst'),
      year: get('Year'),
      filingDate: get('FilingDate'),
      docId: get('DocID'),
    });
  }
  return filings;
}

async function loadHousePtrsForYears(years, opts = {}) {
  const out = [];
  for (const y of years) {
    const { zipPath } = await fetchFdZip(y);
    const xml = extractXml(zipPath, `${y}FD.xml`);
    const filings = parseFdXml(xml, opts);
    console.log(`  [house-fd] ${y}: ${filings.length} PTR filings`);
    for (const f of filings) out.push({ ...f, sourceYear: y });
  }
  return out;
}

module.exports = { fetchFdZip, extractXml, parseFdXml, loadHousePtrsForYears };
