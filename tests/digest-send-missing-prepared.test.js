/**
 * tests/digest-send-missing-prepared.test.js
 *
 * Verifies that /api/digest-send refuses to run when the
 * digest:prepared:{date}:complete marker is absent. We must NEVER send an
 * empty / partial email — better to fail loud than ship a blank broadcast.
 *
 * Also verifies that if Resend fails, the digest:sent:{date} marker is NOT
 * set, so a retry can succeed.
 *
 * Run:
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config tests/digest-send-missing-prepared.test.js
 */

const assert = require('node:assert/strict');
const {
  installDigestStubs,
  makeFakeRedis,
  makeScoredFiling,
} = require('./_helpers/digest-pipeline-stubs');

async function main() {
  // ── Case 1: no prepared payload at all ──
  {
    const calls = installDigestStubs({ filings: [makeScoredFiling()] });
    const { send, sentKeys, preparedKeys } = require('../lib/digest-pipeline');

    const date = '2026-04-28';
    const redis = makeFakeRedis();

    const result = await send({ redis, date, dryRun: false, log: () => {} });

    assert.equal(result.ok, false, 'send returns ok=false');
    assert.equal(result.error, 'prepared-payload-missing', 'error code is prepared-payload-missing');
    assert.ok(result.message.includes('digest-prepare'), 'error message points at digest-prepare');
    assert.equal(calls.sendDigest.length, 0, 'Resend NOT called when prepared payload is missing');
    assert.equal(calls.enrichAllFilings.length, 0, 'enrichment NOT called when prepared payload is missing');

    const keys = sentKeys(date);
    assert.ok(!redis._store.has(keys.sent), 'digest:sent:{date} NOT set on missing prepared');

    // Also verify nothing was written under the prepared keys themselves.
    const pkeys = preparedKeys(date);
    assert.ok(!redis._store.has(pkeys.complete), 'prepared:complete remains absent');
  }

  // ── Case 2: chunk keys exist but :complete marker is missing ──
  // (Simulates a prepare() crash mid-write.)
  {
    // Fresh module cache for a clean install.
    delete require.cache[require.resolve('../lib/digest-pipeline')];
    const calls = installDigestStubs({ filings: [makeScoredFiling()] });
    const { send, preparedKeys } = require('../lib/digest-pipeline');

    const date = '2026-04-28';
    const redis = makeFakeRedis();
    const pkeys = preparedKeys(date);
    // Write chunks but NOT :complete.
    await redis.set(pkeys.meta, JSON.stringify({ date, scoredCount: 1 }));
    await redis.set(pkeys.scored, JSON.stringify([makeScoredFiling()]));
    await redis.set(pkeys.notable, JSON.stringify([]));

    const result = await send({ redis, date, dryRun: false, log: () => {} });

    assert.equal(result.ok, false, 'partial-write case: send returns ok=false');
    assert.equal(result.error, 'prepared-payload-missing', 'partial-write case: still errors as missing');
    assert.equal(calls.sendDigest.length, 0, 'Resend NOT called on partial write');
  }

  // ── Case 3: Resend fails -> digest:sent:{date} must NOT be set ──
  {
    delete require.cache[require.resolve('../lib/digest-pipeline')];
    const calls = installDigestStubs({
      filings: [makeScoredFiling()],
      failResend: true,
    });
    const { prepare, send, sentKeys } = require('../lib/digest-pipeline');

    const date = '2026-04-28';
    const redis = makeFakeRedis();
    await prepare({ redis, date, log: () => {} });

    let threw = false;
    try {
      await send({ redis, date, dryRun: false, log: () => {} });
    } catch (e) {
      threw = true;
      assert.match(e.message, /Resend explosion/);
    }
    assert.equal(threw, true, 'send throws when Resend fails');
    assert.equal(calls.sendDigest.length, 1, 'Resend WAS attempted');

    const keys = sentKeys(date);
    assert.ok(!redis._store.has(keys.sent), 'digest:sent:{date} NOT set after Resend failure');
    assert.ok(!redis._store.has(keys.snippet), 'digest:snippet-sent:{date} NOT set after Resend failure');
    assert.ok(!redis._store.has(keys.archived), 'digest:archived:{date} NOT set after Resend failure');
  }

  console.log('OK — digest-send-missing-prepared.test.js');
}

main().catch((err) => {
  console.error('FAIL — digest-send-missing-prepared.test.js');
  console.error(err);
  process.exit(1);
});
