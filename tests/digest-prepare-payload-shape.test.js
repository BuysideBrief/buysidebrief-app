/**
 * tests/digest-prepare-payload-shape.test.js
 *
 * Verifies that prepare() writes the prepared payload across the expected
 * split keys (meta / scored / notable) and sets the :complete marker LAST.
 * Confirms loadPrepared() returns everything send() needs to consume.
 *
 * Run:
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config tests/digest-prepare-payload-shape.test.js
 */

const assert = require('node:assert/strict');
const {
  installDigestStubs,
  makeFakeRedis,
  makeScoredFiling,
} = require('./_helpers/digest-pipeline-stubs');

async function main() {
  const filings = [
    makeScoredFiling({ ticker: 'ACME', score: 80, tier: 'top_pick' }),
    makeScoredFiling({ ticker: 'BETA', score: 55, tier: 'feature', accessionNumber: '0001000001-26-000099' }),
    makeScoredFiling({ ticker: 'CTRL', score: 30, tier: 'mention', accessionNumber: '0001000001-26-000100' }),
  ];
  const notableFixture = [
    {
      key: 'notable:filing:2026-04-28:NKE:0001000099',
      ticker: 'NKE',
      buyValue: 500_000,
      date: '2026-04-28',
    },
  ];

  installDigestStubs({
    filings,
    notableEntries: notableFixture,
  });

  const { prepare, loadPrepared, preparedKeys } = require('../lib/digest-pipeline');

  const date = '2026-04-28';
  const redis = makeFakeRedis();

  const result = await prepare({ redis, date, log: () => {} });

  assert.equal(result.ok, true, 'prepare returned ok');
  assert.equal(result.empty, false, 'prepare reports non-empty day');
  assert.equal(result.scoredCount, filings.length, 'scoredCount matches filings');
  assert.equal(result.notableCount, notableFixture.length, 'notableCount matches notable fixture');

  const keys = preparedKeys(date);
  assert.ok(redis._store.has(keys.meta), 'meta key written');
  assert.ok(redis._store.has(keys.scored), 'scored key written');
  assert.ok(redis._store.has(keys.notable), 'notable key written');
  assert.ok(redis._store.has(keys.complete), 'complete marker written');

  // Shape contract: meta must contain everything send() reads.
  const meta = JSON.parse(redis._store.get(keys.meta));
  assert.equal(meta.date, date);
  assert.equal(typeof meta.filingIndexCount, 'number');
  assert.equal(typeof meta.parsedCount, 'number');
  assert.equal(meta.scoredCount, filings.length);
  assert.equal(meta.notableCount, notableFixture.length);
  assert.equal(typeof meta.builtAt, 'string');
  assert.equal(typeof meta.version, 'number');

  const scored = JSON.parse(redis._store.get(keys.scored));
  assert.ok(Array.isArray(scored));
  assert.equal(scored.length, filings.length);
  // Every scored filing must carry the fields enrichAllFilings/AI/email need.
  for (const f of scored) {
    assert.ok(f.ticker, 'ticker present');
    assert.ok(typeof f.score === 'number', 'score present');
    assert.ok(typeof f.tier === 'string', 'tier present');
    assert.ok(f.summary, 'summary present');
    assert.ok(Array.isArray(f.signals), 'signals array present');
  }

  const notable = JSON.parse(redis._store.get(keys.notable));
  assert.deepEqual(notable, notableFixture, 'notable round-trips');

  // Round-trip via loadPrepared.
  const loaded = await loadPrepared(date, { redis });
  assert.ok(loaded, 'loadPrepared returns non-null when complete is set');
  assert.equal(loaded.scored.length, filings.length, 'loaded scored count matches');
  assert.equal(loaded.notable.length, notableFixture.length, 'loaded notable count matches');
  assert.equal(loaded.meta.scoredCount, filings.length, 'loaded meta carries scoredCount');

  // Negative case: if :complete is missing, loadPrepared returns null even if
  // chunk keys exist. This is the contract send() relies on for "is the
  // payload safe to consume?".
  await redis.del(keys.complete);
  const loadedAfter = await loadPrepared(date, { redis });
  assert.equal(loadedAfter, null, 'loadPrepared returns null without :complete marker');

  console.log('OK — digest-prepare-payload-shape.test.js');
}

main().catch((err) => {
  console.error('FAIL — digest-prepare-payload-shape.test.js');
  console.error(err);
  process.exit(1);
});
