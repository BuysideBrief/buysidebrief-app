#!/usr/bin/env node
/**
 * Diagnose the low Cohort 1 match rate in the sanity test.
 * Questions:
 *   1. How many issuer CIKs in Form 4 buys also have a prior-90d 8-K 5.02?
 *   2. When there's a CIK overlap, does name-matching succeed?
 *   3. What are example "same CIK, different person" mismatches?
 */
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '..', '.env.local') });

const fs = require('fs');
const path = require('path');
const { readJson } = require('./lib/util');
const { normalize, matchNames } = require('./lib/name-match');

const CACHE_FORM4 = path.join(__dirname, 'cache', 'form4');
const CACHE_8K = path.join(__dirname, 'cache', '8k');

function loadAllForm4() {
  const out = [];
  for (const f of fs.readdirSync(CACHE_FORM4)) {
    if (!f.endsWith('.json')) continue;
    const data = readJson(path.join(CACHE_FORM4, f));
    if (data?.buys) out.push(...data.buys);
  }
  return out;
}

function loadAllAppts() {
  const out = [];
  for (const f of fs.readdirSync(CACHE_8K)) {
    if (!f.endsWith('.json')) continue;
    const data = readJson(path.join(CACHE_8K, f));
    for (const filing of (data?.filings || [])) {
      for (const a of (filing.appointments || [])) {
        out.push({
          ...a,
          cik: filing.cik,
          entityName: filing.entityName,
          filedAt: filing.filedAt,
        });
      }
    }
  }
  return out;
}

function main() {
  const buys = loadAllForm4().filter(b => !b.error && b.ticker && b.transactions?.length);
  const priced = buys.filter(b => b.transactions[0].price >= 2);
  const appts = loadAllAppts();

  console.log(`Total Form 4 buys (clean): ${buys.length}`);
  console.log(`After $2 floor: ${priced.length}`);
  console.log(`Total 8-K appointments: ${appts.length}`);

  const apptByCik = new Map();
  for (const a of appts) {
    if (!apptByCik.has(a.cik)) apptByCik.set(a.cik, []);
    apptByCik.get(a.cik).push(a);
  }

  let buysWithAnyApptAtCik = 0;
  let buysWith90dApptAtCik = 0;
  let buysWithNameMatch = 0;
  const nearMisses = [];
  const byConfidence = { high: 0, medium: 0, low: 0, none: 0 };

  for (const buy of priced) {
    const txDate = buy.transactions[0].txDate;
    const cikAppts = apptByCik.get(buy.issuerCik) || [];
    if (cikAppts.length) buysWithAnyApptAtCik++;

    const recentAppts = cikAppts.filter(a => {
      const gap = (new Date(txDate) - new Date(a.effectiveDate)) / 86400000;
      return gap >= 0 && gap <= 90;
    });
    if (recentAppts.length === 0) continue;
    buysWith90dApptAtCik++;

    let best = null;
    for (const a of recentAppts) {
      const m = matchNames(buy.ownerName, a.name);
      if (m.match) {
        if (!best || (m.confidence === 'high' && best.confidence !== 'high')) best = { match: m, appt: a };
      }
    }
    if (best) {
      buysWithNameMatch++;
      byConfidence[best.match.confidence] = (byConfidence[best.match.confidence] || 0) + 1;
    } else {
      // Record the near-miss: same CIK, recent appointment, but owner name doesn't match any appointee
      nearMisses.push({
        ticker: buy.ticker,
        issuerCik: buy.issuerCik,
        ownerName: buy.ownerName,
        ownerNameNormalized: normalize(buy.ownerName),
        officerTitle: buy.officerTitle,
        isOfficer: buy.isOfficer,
        isDirector: buy.isDirector,
        txDate,
        candidateAppts: recentAppts.map(a => ({
          name: a.name,
          role: a.role,
          effectiveDate: a.effectiveDate,
          apptType: a.appointmentType,
        })),
      });
    }
  }

  console.log(`\nBuys with ANY 8-K 5.02 appt at same CIK (any time): ${buysWithAnyApptAtCik}`);
  console.log(`Buys with 8-K 5.02 appt at same CIK within prior 90d: ${buysWith90dApptAtCik}`);
  console.log(`Buys with successful name match: ${buysWithNameMatch}`);
  console.log(`  By confidence: ${JSON.stringify(byConfidence)}`);

  console.log(`\nNear-misses (same CIK, recent appt, name didn't match): ${nearMisses.length}`);
  for (const nm of nearMisses.slice(0, 15)) {
    console.log(`  ${nm.ticker} (${nm.issuerCik}) — Form4: "${nm.ownerName}" ${nm.officerTitle ? `[${nm.officerTitle}]` : ''} ${nm.isDirector ? 'dir' : ''}`);
    for (const a of nm.candidateAppts) {
      console.log(`    8-K appt candidate: "${a.name}" (${a.role}, ${a.apptType}, eff ${a.effectiveDate})`);
    }
  }

  // Also sample some extracted names to spot bad regex matches
  console.log(`\nSample extracted names (first 30):`);
  for (const a of appts.slice(0, 30)) {
    console.log(`  "${a.name}" (${a.role}, ${a.appointmentType}, ${a.entityName?.slice(0, 50)})`);
  }
}

main();
