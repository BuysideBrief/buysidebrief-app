/**
 * tests/digest-send-idempotent.test.js
 *
 * Verifies that /api/digest-send is idempotent on the day's date:
 *   - First call sets digest:sent:{date} only AFTER Resend returns 2xx.
 *   - Second call short-circuits with { alreadySent: true } and does NOT
 *     invoke Resend a second time.
 *   - The owner-snippet email and archive paths also each have their own
 *     idempotency markers, but the top-level gate is digest:sent:{date}.
 *
 * Run:
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config tests/digest-send-idempotent.test.js
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
  ];
  const calls = installDigestStubs({ filings });

  const { prepare, send, sentKeys } = require('../lib/digest-pipeline');

  const date = '2026-04-28';
  const redis = makeFakeRedis();

  // Seed: prepare so :complete is set.
  await prepare({ redis, date, log: () => {} });

  // First send — live.
  const first = await send({ redis, date, dryRun: false, log: () => {} });
  assert.equal(first.ok, true, 'first send ok');
  assert.equal(first.sent, true, 'first send actually sent');
  assert.equal(calls.sendDigest.length, 1, 'Resend called exactly once on first send');

  const keys = sentKeys(date);
  assert.ok(redis._store.has(keys.sent), 'digest:sent:{date} marker is set after Resend');
  const marker = JSON.parse(redis._store.get(keys.sent));
  assert.ok(marker.sentAt, 'marker carries sentAt');
  assert.equal(marker.broadcastId, 'broadcast_test_123', 'marker carries broadcastId');

  // Second send — should short-circuit.
  const second = await send({ redis, date, dryRun: false, log: () => {} });
  assert.equal(second.ok, true, 'second send returns ok');
  assert.equal(second.alreadySent, true, 'second send reports alreadySent');
  assert.ok(!second.sent, 'second send does NOT report sent=true');
  assert.equal(calls.sendDigest.length, 1, 'Resend NOT called a second time');

  // Third call: also short-circuit, no double-archive, no double-snippet.
  const third = await send({ redis, date, dryRun: false, log: () => {} });
  assert.equal(third.alreadySent, true, 'third send still alreadySent');
  assert.equal(calls.sendDigest.length, 1, 'Resend still called only once total');
  assert.equal(calls.sendOwnerSnippetEmail.length, 1, 'owner snippet email called only once total');
  assert.equal(calls.storeIssue.length, 1, 'archive storeIssue called only once total');
  assert.equal(calls.recordHeadlinePick.length, 1, 'recordHeadlinePick called only once total');

  console.log('OK — digest-send-idempotent.test.js');
}

main().catch((err) => {
  console.error('FAIL — digest-send-idempotent.test.js');
  console.error(err);
  process.exit(1);
});
