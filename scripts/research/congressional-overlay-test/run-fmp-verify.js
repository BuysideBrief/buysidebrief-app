#!/usr/bin/env node
/**
 * One-shot FMP endpoint probe.
 * Tries v4 and /stable/ paths for Senate + House trades, prints the
 * response shape, date coverage, and a 1-row sample. Saves raw bodies
 * to output/ for inspection.
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env.local') });

const fs = require('fs');
const path = require('path');

const KEY = process.env.FMP_API_KEY || '';
const OUT = path.join(__dirname, 'output');
fs.mkdirSync(OUT, { recursive: true });

const CANDIDATES = [
  // v4 variants (user's brief listed these; "senate-disclosure" is FMP's
  // legacy name for House disclosures despite the confusing label)
  { label: 'senate-trading (v4, Senate)',       url: 'https://financialmodelingprep.com/api/v4/senate-trading' },
  { label: 'senate-disclosure (v4, House)',     url: 'https://financialmodelingprep.com/api/v4/senate-disclosure' },
  // stable/ variants — FMP's newer path. Many v4 endpoints migrated.
  { label: 'senate-trades (stable)',            url: 'https://financialmodelingprep.com/stable/senate-trades' },
  { label: 'house-trades (stable)',             url: 'https://financialmodelingprep.com/stable/house-trades' },
  // symbol-filtered variants — to verify per-ticker query works
  { label: 'senate-trading by symbol AAPL',     url: 'https://financialmodelingprep.com/api/v4/senate-trading?symbol=AAPL' },
  { label: 'senate-disclosure by symbol AAPL',  url: 'https://financialmodelingprep.com/api/v4/senate-disclosure?symbol=AAPL' },
  { label: 'senate-trades by symbol AAPL (stable)', url: 'https://financialmodelingprep.com/stable/senate-trades?symbol=AAPL' },
  { label: 'house-trades by symbol AAPL (stable)',  url: 'https://financialmodelingprep.com/stable/house-trades?symbol=AAPL' },
];

function withKey(u) { return u + (u.includes('?') ? '&' : '?') + 'apikey=' + KEY; }

async function probe(c, idx) {
  const full = withKey(c.url);
  console.log(`\n[${idx}] ${c.label}`);
  console.log(`    ${c.url}`);
  try {
    const res = await fetch(full);
    const ct = res.headers.get('content-type') || '';
    console.log(`    status: ${res.status} ${res.statusText} | ${ct}`);
    const text = await res.text();
    const file = path.join(OUT, `fmp-probe-${String(idx).padStart(2, '0')}.json`);
    fs.writeFileSync(file, text);
    console.log(`    saved ${text.length} bytes → ${path.basename(file)}`);
    if (!res.ok) {
      console.log(`    body head: ${text.slice(0, 200)}`);
      return { label: c.label, status: res.status, ok: false };
    }
    let data;
    try { data = JSON.parse(text); } catch (e) {
      console.log(`    NOT JSON: ${text.slice(0, 120)}`);
      return { label: c.label, status: res.status, ok: false };
    }
    if (!Array.isArray(data)) {
      console.log(`    top-level NOT array: keys=${Object.keys(data || {}).join(',')}`);
      return { label: c.label, status: res.status, ok: false, sample: data };
    }
    console.log(`    array length: ${data.length}`);
    if (data.length) {
      const first = data[0];
      console.log(`    row keys: ${Object.keys(first).join(', ')}`);
      console.log(`    row sample:`);
      for (const [k, v] of Object.entries(first)) {
        const vs = typeof v === 'string' ? (v.length > 50 ? v.slice(0, 47) + '...' : v) : String(v);
        console.log(`       ${k}: ${vs}`);
      }
      // Detect date field and report coverage
      const dateFields = ['transactionDate', 'dateRecieved', 'dateReceived', 'disclosureDate', 'filingDate', 'date'];
      for (const df of dateFields) {
        if (first[df]) {
          const all = data.map(r => r[df]).filter(Boolean).sort();
          console.log(`    ${df} coverage: ${all[0]} → ${all[all.length - 1]} (${all.length} rows)`);
          break;
        }
      }
    }
    return { label: c.label, status: res.status, ok: true, count: data.length, keys: data[0] ? Object.keys(data[0]) : [] };
  } catch (e) {
    console.log(`    ERROR: ${e.message}`);
    return { label: c.label, status: 0, ok: false, error: e.message };
  }
}

async function main() {
  if (!KEY) { console.error('FMP_API_KEY not set'); process.exit(1); }
  console.log(`=== FMP endpoint probe ===`);
  console.log(`API key: ${KEY.slice(0, 4)}...${KEY.slice(-4)}`);
  const summary = [];
  for (let i = 0; i < CANDIDATES.length; i++) {
    summary.push(await probe(CANDIDATES[i], i));
  }
  fs.writeFileSync(path.join(OUT, 'fmp-probe-summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n=== SUMMARY ===`);
  for (const s of summary) console.log(`  ${s.ok ? '✓' : '✗'} ${s.label} — status=${s.status}${s.count != null ? ` count=${s.count}` : ''}`);
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
