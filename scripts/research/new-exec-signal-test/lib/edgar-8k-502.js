const fs = require('fs');
const path = require('path');
const { fetchSec, writeJson, readJson, ensureDir, toIsoDate, runConcurrent } = require('./util');

const CACHE_DIR = path.join(__dirname, '..', 'cache', '8k');

/**
 * Search EDGAR for 8-K filings on a specific date that contain "5.02" in
 * their full text. This narrows 8-K volume significantly since only ~5-10%
 * of 8-Ks are Item 5.02 filings.
 */
async function search8K502ForDate(date) {
  const results = [];
  const PAGE_SIZE = 100;
  let from = 0;
  const q = encodeURIComponent('"5.02"');

  while (true) {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${q}&forms=8-K&dateRange=custom&startdt=${date}&enddt=${date}&from=${from}&size=${PAGE_SIZE}`;
    let data;
    try {
      data = await fetchSec(url, { json: true });
    } catch (e) {
      console.error(`  EFTS 8-K search failed ${date} from=${from}: ${e.message}`);
      break;
    }
    const hits = data?.hits?.hits || [];
    if (!hits.length) break;

    for (const hit of hits) {
      const src = hit._source || {};
      const formType = src.form || src.form_type || '';
      if (!formType.startsWith('8-K')) continue;
      const items = src.items || [];
      // Require Item 5.02 in the items field — EDGAR indexes this reliably.
      const has502 = items.some(it => String(it).trim().startsWith('5.02'));
      if (!has502) continue;

      const hitId = hit._id || '';
      const [accPart, filename] = hitId.split(':');
      const cikRaw = (src.ciks && src.ciks[0]) || '';
      const cik = cikRaw.replace(/^0+/, '');
      if (!accPart || !cik) continue;
      const accClean = accPart.replace(/-/g, '');
      const docUrl = filename
        ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/${filename}`
        : `https://www.sec.gov/Archives/edgar/data/${cik}/${accClean}/`;

      results.push({
        accession: accPart,
        cik,
        filedAt: src.file_date || date,
        formType,
        entityName: (src.display_names && src.display_names[0]) || '',
        items,
        docUrl,
        filename,
        periodOfReport: src.period_of_report || null,
      });
    }

    const total = data?.hits?.total?.value || 0;
    from += hits.length;
    if (from >= total || hits.length < PAGE_SIZE) break;
    if (from >= 10000) break;
  }

  return results;
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractItem502Section(text) {
  // Find "Item 5.02" and grab until next "Item X.XX" header or end of doc.
  const re = /Item\s*5\.02[\s\S]*?(?=Item\s*\d\.\d{2}[^0-9]|Signatures?\s*$|$)/i;
  const m = text.match(re);
  return m ? m[0] : '';
}

const ROLE_KEYWORDS = [
  { role: 'CEO', patterns: [/chief\s+executive\s+officer/i, /\bCEO\b/, /president\s+and\s+chief\s+executive/i] },
  { role: 'CFO', patterns: [/chief\s+financial\s+officer/i, /\bCFO\b/] },
  { role: 'COO', patterns: [/chief\s+operating\s+officer/i, /\bCOO\b/] },
  { role: 'President', patterns: [/\bpresident\b/i] },
  { role: 'Director', patterns: [/\b(?:board\s+of\s+)?director\b/i, /elected\s+to\s+the\s+board/i] },
  { role: 'Other C-suite', patterns: [/chief\s+\w+\s+officer/i, /chief\s+\w+\s+\w+\s+officer/i] },
];

function classifyRole(context) {
  for (const { role, patterns } of ROLE_KEYWORDS) {
    if (patterns.some(p => p.test(context))) return role;
  }
  return 'Unknown';
}

const APPOINTMENT_VERBS = /\b(appoint(?:ed|s|ing)?|nam(?:ed|es|ing)|elect(?:ed|s|ing)?|promot(?:ed|es|ing)|hir(?:ed|es|ing)|engag(?:ed|es)|designat(?:ed|es))\b/i;
const DEPARTURE_VERBS = /\b(resign(?:ed|s|ation)?|retir(?:ed|es|ement)|depart(?:ed|s|ure)|terminat(?:ed|es)|remov(?:ed|es)|step(?:ped|s|ping)?\s+down|no\s+longer)\b/i;

// Match plausible full names: 2-5 capitalized tokens, allow middle initials, suffixes.
const NAME_RE = /\b(?:Mr\.|Ms\.|Mrs\.|Dr\.|Prof\.)?\s*([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z]\.?(?:\s+|$))?(?:\s+[A-Z][a-zA-Z'’-]+){1,3})(?:,\s*(?:Jr\.|Sr\.|II|III|IV|Ph\.?D\.?|M\.?D\.?|J\.?D\.?|CPA|CFA|Esq\.?))?/g;

const STOP_PREFIXES = new Set([
  'The', 'This', 'On', 'Effective', 'Pursuant', 'Company', 'Board', 'Directors',
  'Item', 'Section', 'Departure', 'Appointment', 'Compensatory', 'Arrangements',
  'Principal', 'Officers', 'Officer', 'Election', 'Elected', 'Elect',
  'Exchange', 'Act', 'Stock', 'Common',
  'Signatures', 'Signature', 'United', 'States', 'Securities', 'Commission',
  'New', 'York', 'San', 'Francisco', 'Los', 'Angeles', 'Washington',
  'January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
  'Chief', 'President', 'Vice', 'Senior', 'Executive', 'Financial', 'Operating',
  'Current', 'Report', "Report's", 'Form', 'Agreement', 'Mr', 'Ms', 'Mrs',
  'At', 'Accordingly', 'Thereafter', 'Also', 'Additionally', 'Further',
  'He', 'She', 'They', 'His', 'Her', 'As', 'For', 'From', 'With',
  'Inc', 'Corporation', "Company's",
  'Class', 'Consent', 'Severance', "Board's", "Committee's", 'Committee',
  'Special', 'Annual', 'Quarterly', 'Written', 'Nominating',
  'North', 'South', 'East', 'West', 'Central', 'Greater',
  'First', 'Second', 'Third', 'Fourth', 'Fifth',
]);

// Role keywords — if any token is one of these, it's almost certainly a title, not a name.
const ROLE_TOKEN = /^(Chief|Officer|Officers|President|Vice|Senior|Executive|Financial|Operating|Operations|Accounting|Technology|Legal|Compliance|Marketing|Commercial|Revenue|Director|Directors|Chairman|Chairwoman|Chairperson|Principal|Treasurer|Secretary|Controller|Manager|Counsel|Committee|Board|Company|Corporation|Inc)$/i;

// Company-identifier tokens — if the last token is one of these, it's a company name, not a person.
const COMPANY_SUFFIX = new Set([
  'Bank', 'Banks', 'Bancorp', 'Bancshares', 'Bankshares',
  'Corp', 'Corporation', 'Inc', 'LLC', 'LP', 'LLP', 'Co', 'Company',
  'Group', 'Holdings', 'Holding', 'Partners', 'Partnership',
  'Capital', 'Financial', 'Finance', 'Investments', 'Investment', 'Investors',
  'Energy', 'Resources', 'Industries', 'Enterprises', 'Systems', 'Technologies',
  'Pharmaceuticals', 'Pharma', 'Therapeutics', 'Biosciences', 'Sciences',
  'Health', 'Healthcare', 'Medical', 'Laboratories',
  'Properties', 'Realty', 'Trust', 'Fund', 'Funds',
  'Securities', 'Management', 'Services', 'Solutions', 'Networks', 'Communications',
  'International', 'Global', 'Worldwide', 'National',
  'Plan', 'Plans', 'Program', 'Agreement', 'Arrangements',
]);

function isLikelyPersonName(name) {
  if (!name) return false;
  const rawTokens = String(name).trim().split(/\s+/);
  if (rawTokens.length < 2 || rawTokens.length > 5) return false;
  if (STOP_PREFIXES.has(rawTokens[0])) return false;
  if (STOP_PREFIXES.has(rawTokens[rawTokens.length - 1])) return false;
  // Reject if ANY token is a role keyword
  if (rawTokens.some(t => ROLE_TOKEN.test(t.replace(/[.,'’]/g, '')))) return false;
  // Reject if ANY token is a company suffix (catches "Community West Bank", "Merchants Bancorp", "Retail Banking Trust")
  if (rawTokens.some(t => COMPANY_SUFFIX.has(t.replace(/[.,'’]/g, '')))) return false;
  // Require at least one token > 2 chars
  if (!rawTokens.some(t => t.replace(/[^A-Za-z]/g, '').length > 2)) return false;
  // Reject all-upper or all-lower strings
  if (rawTokens.every(t => t === t.toUpperCase())) return false;
  // Last token must look like a surname (>1 char, starts capital, mostly letters)
  const last = rawTokens[rawTokens.length - 1].replace(/[.,'’]/g, '');
  if (last.length < 2 || !/^[A-Z][a-zA-Z'’-]+$/.test(last)) return false;
  return true;
}

function extractEffectiveDate(context, fallback) {
  const patterns = [
    /effective\s+(?:as\s+of\s+)?(?:on\s+)?([A-Z][a-z]+\s+\d{1,2},?\s+20\d{2})/i,
    /(?:on|beginning)\s+([A-Z][a-z]+\s+\d{1,2},?\s+20\d{2}),?\s+(?:the\s+)?(?:Board|Company|Mr\.|Ms\.|Dr\.)/i,
    /\bas\s+of\s+([A-Z][a-z]+\s+\d{1,2},?\s+20\d{2})/i,
  ];
  for (const p of patterns) {
    const m = context.match(p);
    if (m) {
      const d = new Date(m[1]);
      if (!isNaN(d.getTime())) return toIsoDate(d);
    }
  }
  return fallback;
}

/**
 * Parse an 8-K Item 5.02 filing to extract appointments/promotions.
 * Returns an array of { name, role, effectiveDate, appointmentType, ambiguous, context }.
 */
function parse8K502(text, filingDate) {
  const section = extractItem502Section(text);
  if (!section || section.length < 50) return { appointments: [], ambiguous: true, reason: 'no-5.02-section' };

  // Split into sentences for local context around names.
  const sentences = section.split(/(?<=[.!?])\s+/);
  const appointments = [];
  const seenNames = new Set();

  for (let i = 0; i < sentences.length; i++) {
    const sent = sentences[i];
    const isAppointment = APPOINTMENT_VERBS.test(sent);
    const isDeparture = DEPARTURE_VERBS.test(sent);
    // Skip pure departure sentences (per spec — only keep appointments/promotions)
    if (isDeparture && !isAppointment) continue;
    if (!isAppointment) continue;

    // Broaden context: previous + current + next sentence
    const context = [sentences[i - 1] || '', sent, sentences[i + 1] || ''].join(' ');

    let m;
    NAME_RE.lastIndex = 0;
    while ((m = NAME_RE.exec(sent)) !== null) {
      const name = m[1].trim().replace(/\s+/g, ' ');
      if (!isLikelyPersonName(name)) continue;
      const key = name.toLowerCase();
      if (seenNames.has(key)) continue;
      seenNames.add(key);

      const role = classifyRole(context);
      const appointmentType = /\bpromot/i.test(context)
        ? 'promotion'
        : /\bhir/i.test(context)
          ? 'new-hire'
          : 'appointment';
      const effectiveDate = extractEffectiveDate(context, filingDate);

      appointments.push({
        name,
        role,
        appointmentType,
        effectiveDate,
        context: context.slice(0, 500),
        ambiguous: role === 'Unknown',
      });
    }
  }

  return { appointments, ambiguous: false };
}

async function fetchAndParse8K(filing) {
  try {
    const html = await fetchSec(filing.docUrl);
    const text = htmlToText(html);
    const parsed = parse8K502(text, filing.filedAt);
    // Cache the Item 5.02 section text so future parser improvements can re-extract
    // without re-hitting SEC. Skip if it's too large (weird filings).
    const section = extractItem502Section(text);
    const sectionSlim = section && section.length < 80000 ? section : null;
    return {
      ...filing,
      appointments: parsed.appointments,
      parseIssue: parsed.reason || null,
      section502: sectionSlim,
    };
  } catch (e) {
    return { ...filing, appointments: [], error: e.message };
  }
}

async function pull8K502Range(startDate, endDate, opts = {}) {
  ensureDir(CACHE_DIR);
  const concurrency = opts.concurrency || 6;
  const allAppointments = [];
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
      // Apply current stop-word rules to cached appointments — this is a cheap
      // way to benefit from parser improvements without re-fetching SEC docs.
      const refiltered = refilterCachedAppts(dayData);
      const apptTotal = refiltered.reduce((n, f) => n + (f.appointments?.length || 0), 0);
      console.log(`  [cache] 8-K ${date} — ${refiltered.length} filings, ${apptTotal} appointments`);
      for (const f of refiltered) {
        for (const a of (f.appointments || [])) {
          allAppointments.push({ ...a, cik: f.cik, entityName: f.entityName, filedAt: f.filedAt, accession: f.accession });
        }
      }
      continue;
    }

    console.log(`  [fetch] 8-K ${date} — searching EFTS...`);
    const filings = await search8K502ForDate(date);
    console.log(`  [fetch] 8-K ${date} — ${filings.length} Item 5.02 candidates (concurrency=${concurrency})...`);

    const tasks = filings.map(f => () => fetchAndParse8K(f));
    const enriched = await runConcurrent(tasks, concurrency);

    const apptCount = enriched.reduce((n, f) => n + (f && f.appointments?.length || 0), 0);
    console.log(`  [fetch] 8-K ${date} — ${apptCount} appointments extracted`);
    writeJson(cachePath, { date, fetchedAt: new Date().toISOString(), filings: enriched, appointmentCount: apptCount });

    for (const f of enriched) {
      if (!f) continue;
      for (const a of (f.appointments || [])) {
        allAppointments.push({ ...a, cik: f.cik, entityName: f.entityName, filedAt: f.filedAt, accession: f.accession });
      }
    }
  }

  return allAppointments;
}

/**
 * Re-apply current isLikelyPersonName rules + re-parse cached section502
 * text (if available) to benefit from parser improvements without re-fetching.
 */
function refilterCachedAppts(dayData) {
  const out = [];
  for (const f of (dayData.filings || [])) {
    if (!f) continue;
    // If we have cached Item 5.02 section text, re-parse from scratch.
    if (f.section502) {
      const reparsed = parse8K502(f.section502, f.filedAt);
      out.push({ ...f, appointments: reparsed.appointments });
      continue;
    }
    // Otherwise filter existing appointments through the current name predicate.
    const kept = (f.appointments || []).filter(a => isLikelyPersonName(a.name));
    out.push({ ...f, appointments: kept });
  }
  return out;
}

module.exports = {
  pull8K502Range,
  search8K502ForDate,
  parse8K502,
  htmlToText,
  isLikelyPersonName,
  refilterCachedAppts,
};
