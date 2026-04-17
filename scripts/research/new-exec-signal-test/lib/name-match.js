const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'phd', 'md', 'jd', 'cpa', 'cfa', 'esq']);
const TITLES = new Set(['mr', 'ms', 'mrs', 'miss', 'dr', 'prof']);

function tokensOf(name) {
  if (!name) return [];
  let cleaned = String(name)
    .replace(/[\u2018\u2019\u201C\u201D]/g, "'")
    .replace(/\./g, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.split(/\s+/)
    .map(t => t.toLowerCase())
    .filter(t => t && !TITLES.has(t) && !SUFFIXES.has(t));
}

// Produce up to two candidate parses: "First Middle Last" and "Last First Middle".
// Form 4 XML rptOwnerName is almost always "LAST FIRST MIDDLE" but casing varies;
// 8-K text is "First Middle Last". We try both and use whichever matches.
function candidates(name) {
  const toks = tokensOf(name);
  if (toks.length < 2) return toks.length ? [{ first: toks[0], middle: '', last: toks[0] }] : [];
  const out = [];
  // "First ... Last"
  out.push({ first: toks[0], middle: toks.slice(1, -1).join(' '), last: toks[toks.length - 1] });
  // "Last First ..."
  out.push({ first: toks[1], middle: toks.slice(2).join(' '), last: toks[0] });
  return out;
}

// Back-compat wrapper used by diagnose/other callers.
function normalize(name) {
  const toks = tokensOf(name);
  const cleaned = toks.join(' ');
  if (!toks.length) return { first: '', middle: '', last: '', raw: cleaned };
  const isAllCaps = String(name) === String(name).toUpperCase();
  if (isAllCaps && toks.length >= 2) {
    return { first: toks[1], middle: toks.slice(2).join(' '), last: toks[0], raw: cleaned, tokens: toks };
  }
  return { first: toks[0], middle: toks.slice(1, -1).join(' '), last: toks[toks.length - 1], raw: cleaned, tokens: toks };
}

function firstInitial(s) { return s ? s[0] : ''; }

function _scorePair(f, a) {
  if (!f.last || !a.last) return { match: false, confidence: 'none', reason: 'empty', score: 0 };
  const lastMatch = f.last === a.last;
  const firstMatch = f.first === a.first;
  const firstInitMatch = firstInitial(f.first) === firstInitial(a.first);

  if (lastMatch && firstMatch) {
    if (f.middle && a.middle && f.middle !== a.middle) {
      if (firstInitial(f.middle) === firstInitial(a.middle)) {
        return { match: true, confidence: 'high', reason: 'last+first+middle-initial', score: 3 };
      }
      return { match: true, confidence: 'medium', reason: 'last+first-match-middle-differs', score: 2 };
    }
    return { match: true, confidence: 'high', reason: 'last+first', score: 3 };
  }
  if (lastMatch && firstInitMatch && (f.first.length === 1 || a.first.length === 1)) {
    return { match: true, confidence: 'medium', reason: 'last+first-initial', score: 2 };
  }
  if (lastMatch && firstInitMatch) {
    return { match: true, confidence: 'low', reason: 'last+first-initial-both-full', score: 1 };
  }
  return { match: false, confidence: 'none', reason: 'no-match', score: 0 };
}

/**
 * Match a Form 4 insider name against an 8-K-extracted name.
 * Tries both "First Last" and "Last First" orderings for each — Form 4 XML
 * names are inconsistent in case, so we can't rely on the all-caps heuristic alone.
 */
function matchNames(form4Name, apptName) {
  const fs_ = candidates(form4Name);
  const as_ = candidates(apptName);
  let best = { match: false, confidence: 'none', reason: 'no-candidates', score: 0 };
  for (const f of fs_) {
    for (const a of as_) {
      const r = _scorePair(f, a);
      if (r.score > best.score) best = r;
    }
  }
  return best;
}

/**
 * For a given Form 4 buy, find the closest appointment match at the same CIK.
 * Returns the best match (if any) with a `confidence` rating.
 */
function findBestApptMatch(form4, appointments) {
  const candidates = appointments.filter(a => String(a.cik) === String(form4.issuerCik));
  if (!candidates.length) return null;

  let best = null;
  for (const appt of candidates) {
    const m = matchNames(form4.ownerName, appt.name);
    if (!m.match) continue;
    // Prefer closer tenure to the Form 4 transaction date
    const txDate = form4.transactions[0]?.txDate || form4.filedAt;
    const tenureDays = Math.round(
      (new Date(txDate).getTime() - new Date(appt.effectiveDate).getTime()) / 86400000
    );
    // Only consider appointments BEFORE the Form 4 transaction
    if (tenureDays < 0) continue;
    const confScore = m.confidence === 'high' ? 3 : m.confidence === 'medium' ? 2 : 1;
    const entry = { appt, match: m, tenureDays, confScore };
    if (!best || confScore > best.confScore || (confScore === best.confScore && tenureDays < best.tenureDays)) {
      best = entry;
    }
  }
  return best;
}

module.exports = { normalize, matchNames, findBestApptMatch };
