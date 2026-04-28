/**
 * tests/digest-pipeline-flow.test.js
 *
 * End-to-end happy-path: prepare() then send() then a follow-up send() — and
 * verifies all four idempotency markers behave correctly across the flow:
 *   digest:prepared:{date}:complete   (set by prepare, last)
 *   digest:sent:{date}                (set by send after Resend success)
 *   digest:snippet-sent:{date}        (set by send after owner-snippet email)
 *   digest:archived:{date}            (set by send after archive write)
 *
 * Also verifies the prepare → send contract: the in-memory Redis state after
 * prepare() is sufficient for send() to run without any other inputs.
 *
 * Run:
 *   DOTENV_CONFIG_PATH=.env.local node -r dotenv/config tests/digest-pipeline-flow.test.js
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
  ];

  const calls = installDigestStubs({
    filings,
    notableEntries: [{
      key: 'notable:filing:2026-04-28:NKE:0001000099',
      ticker: 'NKE',
      buyValue: 500_000,
      date: '2026-04-28',
    }],
  });

  const { prepare, send, preparedKeys, sentKeys } = require('../lib/digest-pipeline');

  const date = '2026-04-28';
  const redis = makeFakeRedis();

  // ── PREPARE ──
  const prep = await prepare({ redis, date, log: () => {} });
  assert.equal(prep.ok, true);
  assert.equal(prep.empty, false);
  assert.equal(prep.scoredCount, 2);
  assert.equal(prep.notableCount, 1);

  const pkeys = preparedKeys(date);
  assert.ok(redis._store.has(pkeys.complete), 'prepared:complete present after prepare');

  // ── SEND ──
  const sendResult = await send({ redis, date, dryRun: false, log: () => {} });
  assert.equal(sendResult.ok, true);
  assert.equal(sendResult.sent, true, 'first send: sent=true');
  assert.equal(sendResult.alreadySent, undefined);

  // All three send-side markers should now be set.
  const skeys = sentKeys(date);
  assert.ok(redis._store.has(skeys.sent), 'digest:sent:{date} set');
  assert.ok(redis._store.has(skeys.snippet), 'digest:snippet-sent:{date} set');
  assert.ok(redis._store.has(skeys.archived), 'digest:archived:{date} set');

  // Side-effect counts.
  assert.equal(calls.fetchRecentFilingsFromFeed.length, 1, 'fetched index once during prepare');
  assert.equal(calls.fetchAndParseForm4.length, filings.length, 'parsed each indexed filing');
  assert.equal(calls.enrichAllFilings.length, 1, 'enrichment called once during send');
  assert.equal(calls.sendDigest.length, 1, 'Resend called once');
  assert.equal(calls.sendOwnerSnippetEmail.length, 1, 'snippet email called once');
  assert.equal(calls.storeIssue.length, 1, 'archive stored once');
  assert.equal(calls.recordHeadlinePick.length, 1, 'headline pick recorded once');
  assert.equal(calls.recordNewPicks.length, 1, 'recordNewPicks called once');
  assert.equal(calls.updateAllReturns.length, 1, 'updateAllReturns called once');

  // ── REPLAY: re-running send must be a no-op on every side-effect ──
  const replay = await send({ redis, date, dryRun: false, log: () => {} });
  assert.equal(replay.alreadySent, true, 'replay short-circuits on digest:sent marker');

  assert.equal(calls.sendDigest.length, 1, 'Resend NOT re-called on replay');
  assert.equal(calls.sendOwnerSnippetEmail.length, 1, 'snippet email NOT re-called on replay');
  assert.equal(calls.storeIssue.length, 1, 'archive NOT re-written on replay');
  assert.equal(calls.recordHeadlinePick.length, 1, 'headline pick NOT re-recorded on replay');

  // ── DRY RUN AFTER LIVE: dry runs should NOT set markers and SHOULD render ──
  // (Different date so we can exercise the dry-run path freely.)
  const dryDate = '2026-04-29';
  await prepare({ redis, date: dryDate, log: () => {} });
  const dry = await send({ redis, date: dryDate, dryRun: true, log: () => {} });
  assert.equal(dry.ok, true);
  assert.equal(dry.dry, true, 'dry run flag echoed');
  assert.ok(dry.html, 'dry run returns rendered html');
  assert.ok(!redis._store.has(sentKeys(dryDate).sent), 'dry run does NOT set digest:sent');

  // Live send after dry run on the same date works (markers absent).
  const live = await send({ redis, date: dryDate, dryRun: false, log: () => {} });
  assert.equal(live.sent, true, 'live send after dry run actually sends');
  assert.ok(redis._store.has(sentKeys(dryDate).sent), 'digest:sent now set on live send');

  console.log('OK — digest-pipeline-flow.test.js');
}

main().catch((err) => {
  console.error('FAIL — digest-pipeline-flow.test.js');
  console.error(err);
  process.exit(1);
});
