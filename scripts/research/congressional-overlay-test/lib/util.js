const fs = require('fs');
const path = require('path');

const SEC_USER_AGENT = process.env.SEC_USER_AGENT || 'CongressionalOverlayTest research@buysidebrief.com';
const FETCH_TIMEOUT_MS = 30000;

// SEC rate limiter (same pattern as the prior test — global min-gap queue).
const SEC_MIN_GAP_MS = 115;
let _secQueueTail = Promise.resolve();
let _secLastStart = 0;

// House disclosures server has no published rate limit. Be polite: ~3 req/sec.
const HOUSE_MIN_GAP_MS = 330;
let _houseQueueTail = Promise.resolve();
let _houseLastStart = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function _mkSlot(tailRef, lastRef, gap) {
  return () => {
    const mine = tailRef.tail.then(async () => {
      const now = Date.now();
      const wait = Math.max(0, lastRef.last + gap - now);
      if (wait) await sleep(wait);
      lastRef.last = Date.now();
    });
    tailRef.tail = mine;
    return mine;
  };
}

const _secRef = { tail: _secQueueTail, last: _secLastStart };
const _houseRef = { tail: _houseQueueTail, last: _houseLastStart };
const acquireSecSlot = _mkSlot(_secRef, _secRef, SEC_MIN_GAP_MS);
const acquireHouseSlot = _mkSlot(_houseRef, _houseRef, HOUSE_MIN_GAP_MS);

async function fetchWith(url, { json = false, retries = 2, slot, userAgent, responseType = 'text' } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (slot) await slot();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': userAgent, 'Accept': json ? 'application/json' : '*/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${res.status} ${url}`);
        lastErr.status = res.status;
        if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
        throw lastErr;
      }
      if (!res.ok) {
        const err = new Error(`${res.status} ${url}`);
        err.status = res.status;
        throw err;
      }
      if (responseType === 'buffer') return Buffer.from(await res.arrayBuffer());
      return json ? res.json() : res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < retries && (e.name === 'AbortError' || e.code === 'UND_ERR_SOCKET' || e.message?.includes('fetch failed'))) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

const fetchSec = (url, opts = {}) => fetchWith(url, { ...opts, slot: acquireSecSlot, userAgent: SEC_USER_AGENT });
const fetchHouse = (url, opts = {}) => fetchWith(url, { ...opts, slot: acquireHouseSlot, userAgent: SEC_USER_AGENT });

async function runConcurrent(tasks, concurrency = 6, onResult = null) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try { results[i] = await tasks[i](); }
      catch (e) { results[i] = { __error: e.message }; }
      if (onResult) onResult(results[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJson(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, data) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(data, null, 2)); }
function appendLog(p, line) { ensureDir(path.dirname(p)); fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`); }

function toIsoDate(d) { return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(date); d.setUTCDate(d.getUTCDate() + days); return toIsoDate(d); }
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function parseUsDate(s) {
  // "1/17/2025" or "01/17/2025" → ISO "2025-01-17"
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}`;
}

function makeProgress(logPath, interval = 1000) {
  let lastLogged = 0;
  ensureDir(path.dirname(logPath));
  return function tick(count, extra = {}) {
    const bucket = Math.floor(count / interval);
    if (bucket <= lastLogged) return;
    lastLogged = bucket;
    const extraStr = Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(' ');
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] processed=${count} ${extraStr}\n`);
  };
}

module.exports = {
  SEC_USER_AGENT, sleep, fetchSec, fetchHouse, runConcurrent,
  ensureDir, readJson, writeJson, appendLog,
  toIsoDate, addDays, daysBetween, parseUsDate, makeProgress,
};
