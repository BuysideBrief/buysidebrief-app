const fs = require('fs');
const path = require('path');

const USER_AGENT = process.env.SEC_USER_AGENT || 'NewExecSignalTest research@buysidebrief.com';
const FETCH_TIMEOUT_MS = 30000;

// SEC allows ~10 req/sec. We target 9 req/sec with a minimum 115ms gap between
// request *starts* across ALL callers — a single global serialized-dispatch queue.
const SEC_MIN_GAP_MS = 115;
let _secQueueTail = Promise.resolve();
let _secLastStart = 0;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Acquire a request slot — returns when the caller may start a fetch.
 * Chaining through _secQueueTail guarantees global ordering regardless of
 * caller concurrency.
 */
function acquireSecSlot() {
  const mine = _secQueueTail.then(async () => {
    const now = Date.now();
    const wait = Math.max(0, _secLastStart + SEC_MIN_GAP_MS - now);
    if (wait) await sleep(wait);
    _secLastStart = Date.now();
  });
  _secQueueTail = mine;
  return mine;
}

async function fetchSec(url, { json = false, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await acquireSecSlot();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': json ? 'application/json' : '*/*' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`SEC ${res.status} ${url}`);
        lastErr.status = res.status;
        if (attempt < retries) { await sleep(500 * (attempt + 1)); continue; }
        throw lastErr;
      }
      if (!res.ok) {
        const err = new Error(`SEC ${res.status} ${url}`);
        err.status = res.status;
        throw err;
      }
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

/**
 * Run `tasks` with at most `concurrency` in-flight workers.
 * Each task is an async () => result. Results are returned in input order.
 * An optional onResult(result, index) hook fires as each task completes.
 */
async function runConcurrent(tasks, concurrency = 6, onResult = null) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = { __error: e.message };
      }
      if (onResult) onResult(results[i], i);
    }
  }
  const workers = [];
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function writeJson(p, data) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function appendLog(p, line) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, `[${new Date().toISOString()}] ${line}\n`);
}

function toIsoDate(d) {
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return toIsoDate(d);
}

/**
 * Progress tracker — writes a single append-only line to a log file
 * every time count crosses a new threshold (default every 1,000 records).
 */
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
  USER_AGENT,
  sleep,
  fetchSec,
  acquireSecSlot,
  runConcurrent,
  ensureDir,
  readJson,
  writeJson,
  appendLog,
  toIsoDate,
  daysBetween,
  addDays,
  makeProgress,
};
