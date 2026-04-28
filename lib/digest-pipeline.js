/**
 * Daily digest pipeline — split into prepare() and send() halves so the cron
 * fits inside Vercel's per-function budget.
 *
 *   prepare()  — steps 1 → 3g (fetch, parse, score, earnings/contrarian, dampen,
 *                store historical, profiles, notable). Persists a date-scoped
 *                payload to Redis under digest:prepared:{date}:{meta|scored|notable}
 *                and sets digest:prepared:{date}:complete LAST as the all-clear.
 *
 *   send()     — steps 4 → 9 (enrich, AI, headline rotation, record picks,
 *                update returns, format email, send via Resend, owner-snippet
 *                email, archive, headline pick). Idempotent on
 *                digest:sent:{date}, digest:snippet-sent:{date}, and
 *                digest:archived:{date} — markers are written only after the
 *                corresponding side-effect succeeds, so retries on failure
 *                are safe.
 *
 *   loadPrepared() — read-back helper; returns null if the :complete marker
 *                    is absent (i.e. prepare did not finish cleanly).
 *
 * Storage shape rationale: payload is split into three keys (meta / scored /
 * notable) instead of one blob. Keeps each Upstash request well under any
 * per-command size ceiling, and on a heavy day a debugger can pull each chunk
 * independently. The :complete marker is the single source of truth for
 * "send may proceed".
 *
 * All fields, scoring, AI prompts, and email templates are unchanged from the
 * monolithic api/fetch-and-send.js — this file only relocates orchestration.
 */

const { fetchRecentFilingsFromFeed, fetchAndParseForm4 } = require('./sec-fetcher');
const { scoreAllFilings, categorizeForDigest } = require('./signal-scorer');
const { formatDigestEmail } = require('./email-formatter');
const { storeNotableFilings } = require('./notable');
const { enrichAllFilings } = require('./context-enricher');
const {
  recordNewPicks,
  updateAllReturns,
  generateScorecard,
  formatScorecardForEmail,
  formatCeoSpotlight,
  getCeoProfile,
  loadRecentPicks,
} = require('./performance-tracker');
const { getMarketOverview, formatMarketOverviewForEmail } = require('./market-overview');
const { generateMarketContext, generateWhyItMattersAI, generateSocialSnippet } = require('./ai-content');
const { batchAnalyzeEarnings } = require('./earnings-helper');
const { batchAnalyzeContrarian } = require('./contrarian-detector');
const { storeAllScoredFilings } = require('./historical-store');
const { rotateHeadlinePick, recordHeadlinePick } = require('./recently-featured');
const { dampenRepeatInsiders } = require('./pick-filters');
const { getCompanyProfileBatch } = require('./company-profile');
const { getRedisOrNoop } = require('./redis');
const { sendDigest, sendOwnerSnippetEmail } = require('./email-sender');
const { storeIssue } = require('../api/archive');

const PREPARED_TTL_SECONDS = 60 * 60 * 24; // 24h — well past same-day send window

function todayUtc() {
  return new Date().toISOString().split('T')[0];
}

function preparedKeys(date) {
  return {
    meta: `digest:prepared:${date}:meta`,
    scored: `digest:prepared:${date}:scored`,
    notable: `digest:prepared:${date}:notable`,
    complete: `digest:prepared:${date}:complete`,
  };
}

function sentKeys(date) {
  return {
    sent: `digest:sent:${date}`,
    snippet: `digest:snippet-sent:${date}`,
    archived: `digest:archived:${date}`,
  };
}

function makeBudget(startTime, totalMs) {
  return () => totalMs - (Date.now() - startTime);
}

// ────────────────────────────────────────────────────────────────────────────
// PREPARE — steps 1 → 3g
// ────────────────────────────────────────────────────────────────────────────

async function prepare({
  redis = getRedisOrNoop(),
  count = 100,
  budgetMs = 290000,
  date = todayUtc(),
  log = console.log,
} = {}) {
  const startTime = Date.now();
  const timeRemaining = makeBudget(startTime, budgetMs);

  // ── Step 1: fetch filing index ──
  log('[prepare 1/9] Fetching filing index from EDGAR...');
  const filingIndex = await fetchRecentFilingsFromFeed(50);
  log(`  Found ${filingIndex.length} filings in index`);

  if (filingIndex.length === 0) {
    return {
      ok: true,
      date,
      empty: true,
      filingIndexCount: 0,
      parsedCount: 0,
      scoredCount: 0,
      notableCount: 0,
      elapsedMs: Date.now() - startTime,
    };
  }

  // ── Step 2: parse Form 4 XML in parallel batches ──
  log('[prepare 2/9] Parsing individual Form 4 filings...');
  const toProcess = filingIndex.slice(0, count);
  const parsed = [];

  const BATCH_SIZE = 5;
  for (let i = 0; i < toProcess.length; i += BATCH_SIZE) {
    const batch = toProcess.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((filing) => fetchAndParseForm4(filing).catch(() => null))
    );
    for (const result of results) {
      if (result && result.transactions.length > 0) parsed.push(result);
    }
    if (i + BATCH_SIZE < toProcess.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  log(`  Parsed ${parsed.length} filings with transactions out of ${toProcess.length}`);

  // Persist morning accession numbers for afternoon-scan dedup (best-effort)
  try {
    await redis.set(
      `morning:accessions:${date}`,
      JSON.stringify(filingIndex.map((f) => f.accessionNumber)),
      { ex: 172800 }
    );
    log(`  Stored ${filingIndex.length} accession numbers for afternoon dedup`);
  } catch (e) {
    console.error('  Accession number persistence failed (non-fatal):', e.message);
  }

  // Dedup by ticker + ownerCik, keeping highest-value filing
  parsed.sort((a, b) => {
    const aVal = (a.summary?.totalBuyValue || 0) + (a.summary?.totalSellValue || 0);
    const bVal = (b.summary?.totalBuyValue || 0) + (b.summary?.totalSellValue || 0);
    return bVal - aVal;
  });
  const deduped = [];
  const seen = new Set();
  for (const filing of parsed) {
    const key = `${filing.ticker || 'UNK'}:${filing.ownerCik || filing.ownerName || 'UNK'}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(filing);
    }
  }
  if (deduped.length < parsed.length) {
    log(`  Deduped: ${parsed.length} → ${deduped.length} (removed ${parsed.length - deduped.length} duplicates)`);
  }

  // ── Step 3: score ──
  log('[prepare 3/9] Scoring filings...');
  const scored = scoreAllFilings(deduped);
  const initialCategorized = categorizeForDigest(scored);
  log(`  Top picks: ${initialCategorized.topPicks.length}, Featured: ${initialCategorized.featured.length}, Mentions: ${initialCategorized.mentions.length}`);

  // ── Step 3b: earnings calendar context ──
  if (timeRemaining() < 15000) {
    log(`  Skipping earnings cross-reference — only ${timeRemaining()}ms remaining`);
  } else {
    log('[prepare 3b/9] Checking earnings calendar context...');
    try {
      const earningsMap = await batchAnalyzeEarnings(scored);
      let earningsBoosts = 0;
      let earningsFlags = 0;

      for (const f of scored) {
        const ec = earningsMap.get(f.ticker);
        if (!ec || !ec.signal) continue;
        f.earningsContext = ec;

        if (ec.scoreAdjustment > 0 && f.summary?.buyCount > 0) {
          f.score += ec.scoreAdjustment;
          f.signals.push(`Post-earnings buy (+${ec.scoreAdjustment}): ${ec.signal === 'post_earnings_buy' ? `bought ${ec.daysSinceEarnings}d after earnings` : ec.signal}`);
          earningsBoosts++;
          if (f.score >= 100) f.tier = 'strong_signal';
          else if (f.score >= 75) f.tier = 'top_pick';
          else if (f.score >= 45) f.tier = 'feature';
          else if (f.score >= 25) f.tier = 'mention';
        } else if (ec.signal === 'blackout_flag') {
          f.warnings = f.warnings || [];
          f.warnings.push(`Traded ${ec.daysUntilEarnings}d before earnings — inside typical blackout window`);
          earningsFlags++;
        } else if (ec.signal === 'pre_earnings_caution') {
          earningsFlags++;
        }
      }

      log(`  Earnings context: ${earningsBoosts} boosts, ${earningsFlags} flags`);
    } catch (e) {
      console.error('  Earnings calendar check failed (non-fatal):', e.message);
    }
  }

  scored.sort((a, b) => b.score - a.score);

  // ── Step 3c: contrarian signals ──
  if (timeRemaining() < 15000) {
    log(`  Skipping contrarian detection — only ${timeRemaining()}ms remaining`);
  } else {
    log('[prepare 3c/9] Checking for contrarian signals...');
    try {
      const contrarianMap = await batchAnalyzeContrarian(scored);
      let contrarianBoosts = 0;
      for (const f of scored) {
        const cc = contrarianMap.get(f.ticker);
        if (!cc || (f.summary?.buyCount ?? 0) === 0) continue;
        f.contrarianContext = cc;
        f.score += cc.boost;
        f.signals.push(`${cc.label} (${cc.drawdownPct}% off high, +${cc.boost})`);
        contrarianBoosts++;
        if (f.score >= 100) f.tier = 'strong_signal';
        else if (f.score >= 75) f.tier = 'top_pick';
        else if (f.score >= 45) f.tier = 'feature';
        else if (f.score >= 25) f.tier = 'mention';
      }
      if (contrarianBoosts > 0) scored.sort((a, b) => b.score - a.score);
      log(`  Contrarian signals: ${contrarianBoosts} boosts`);
    } catch (e) {
      console.error('  Contrarian check failed (non-fatal):', e.message);
    }
  }

  // ── Step 3d: dampen repeat insiders ──
  log('[prepare 3d/9] Dampening repeat insiders...');
  try {
    const recentPicks = await loadRecentPicks(30);
    const beforeCount = scored.filter((f) => f.tier === 'top_pick' || f.tier === 'feature').length;
    const dampened = dampenRepeatInsiders(scored, recentPicks);
    scored.length = 0;
    scored.push(...dampened);
    const afterCount = scored.filter((f) => f.tier === 'top_pick' || f.tier === 'feature').length;
    const dampenedCount = scored.filter((f) => f.dampened).length;
    if (dampenedCount > 0) {
      log(`  Dampened ${dampenedCount} repeat insiders (picks: ${beforeCount} → ${afterCount})`);
    } else {
      log('  No repeat insiders found');
    }
    scored.sort((a, b) => b.score - a.score);
  } catch (e) {
    console.error('  Repeat dampening failed (non-fatal):', e.message);
  }

  // ── Step 3e: store historical filing data ──
  log('[prepare 3e/9] Storing historical filing data...');
  try {
    const storeResult = await storeAllScoredFilings(scored, date);
    log(`  Stored ${storeResult.stored} filings (${storeResult.skipped} skipped)`);
    if (storeResult.dailySummary) {
      log(`  Daily: ${storeResult.dailySummary.buyFilings} buys, ${storeResult.dailySummary.sellFilings} sells, avg score ${storeResult.dailySummary.avgScore}`);
    }
  } catch (e) {
    console.error('  Historical store failed (non-fatal):', e.message);
  }

  // ── Step 3f: company profiles ──
  log('[prepare 3f/9] Fetching company profiles...');
  try {
    const tickers = [...new Set(scored.map((f) => f.ticker).filter(Boolean))];
    const profiles = await getCompanyProfileBatch(tickers);
    for (const filing of scored) {
      const profile = profiles.get(filing.ticker?.toUpperCase());
      if (profile) {
        filing.sector = profile.sector;
        filing.marketCap = profile.marketCap;
        filing.companyExchange = profile.exchange;
        filing.convictionIntensity = filing.summary?.totalBuyValue && profile.marketCap
          ? (filing.summary.totalBuyValue / (profile.marketCap * 1_000_000)) * 100
          : null;
      }
    }
  } catch (e) {
    console.error('  Company profile fetch failed (non-fatal):', e.message);
  }

  // ── Step 3g: notable (isolated namespace) ──
  log('[prepare 3g/9] Identifying notable (non-scored) large-cap buys...');
  let notableEntries = [];
  try {
    notableEntries = await storeNotableFilings(scored, date);
    log(`  Notable: ${notableEntries.length} large-cap insider buys surfaced`);
  } catch (e) {
    console.error('  Notable store failed (non-fatal):', e.message);
  }

  // ── Persist prepared payload (split shape) ──
  const meta = {
    date,
    filingIndexCount: filingIndex.length,
    parsedCount: parsed.length,
    dedupedCount: deduped.length,
    scoredCount: scored.length,
    notableCount: notableEntries.length,
    builtAt: new Date().toISOString(),
    elapsedMs: Date.now() - startTime,
    version: 1,
  };

  await writePreparedPayload(redis, date, { meta, scored, notable: notableEntries });
  log(`[prepare] payload written to ${preparedKeys(date).complete}`);

  return {
    ok: true,
    date,
    empty: false,
    filingIndexCount: filingIndex.length,
    parsedCount: parsed.length,
    scoredCount: scored.length,
    notableCount: notableEntries.length,
    elapsedMs: Date.now() - startTime,
  };
}

async function writePreparedPayload(redis, date, { meta, scored, notable }) {
  const keys = preparedKeys(date);
  // Write data chunks first; only set :complete after they all succeed.
  if (typeof redis.pipeline === 'function') {
    const pipe = redis.pipeline();
    pipe.set(keys.meta, JSON.stringify(meta), { ex: PREPARED_TTL_SECONDS });
    pipe.set(keys.scored, JSON.stringify(scored), { ex: PREPARED_TTL_SECONDS });
    pipe.set(keys.notable, JSON.stringify(notable), { ex: PREPARED_TTL_SECONDS });
    await pipe.exec();
  } else {
    await redis.set(keys.meta, JSON.stringify(meta), { ex: PREPARED_TTL_SECONDS });
    await redis.set(keys.scored, JSON.stringify(scored), { ex: PREPARED_TTL_SECONDS });
    await redis.set(keys.notable, JSON.stringify(notable), { ex: PREPARED_TTL_SECONDS });
  }
  await redis.set(
    keys.complete,
    JSON.stringify({ writtenAt: new Date().toISOString(), version: 1 }),
    { ex: PREPARED_TTL_SECONDS }
  );
}

// ────────────────────────────────────────────────────────────────────────────
// LOAD PREPARED PAYLOAD
// ────────────────────────────────────────────────────────────────────────────

async function loadPrepared(date, { redis = getRedisOrNoop() } = {}) {
  const keys = preparedKeys(date);
  const complete = await redis.get(keys.complete);
  if (!complete) return null;

  // Upstash returns parsed JSON for objects but raw strings for our JSON.stringify
  // payloads — handle both.
  const parse = (v) => {
    if (v == null) return null;
    if (typeof v === 'string') {
      try { return JSON.parse(v); } catch { return null; }
    }
    return v;
  };

  let meta, scored, notable;
  if (typeof redis.pipeline === 'function') {
    const pipe = redis.pipeline();
    pipe.get(keys.meta);
    pipe.get(keys.scored);
    pipe.get(keys.notable);
    const [rawMeta, rawScored, rawNotable] = await pipe.exec();
    meta = parse(rawMeta);
    scored = parse(rawScored);
    notable = parse(rawNotable);
  } else {
    meta = parse(await redis.get(keys.meta));
    scored = parse(await redis.get(keys.scored));
    notable = parse(await redis.get(keys.notable));
  }

  return {
    meta: meta || null,
    scored: Array.isArray(scored) ? scored : [],
    notable: Array.isArray(notable) ? notable : [],
  };
}

// ────────────────────────────────────────────────────────────────────────────
// SEND — steps 4 → 9
// ────────────────────────────────────────────────────────────────────────────

async function send({
  redis = getRedisOrNoop(),
  date = todayUtc(),
  dryRun = false,
  budgetMs = 290000,
  log = console.log,
} = {}) {
  const startTime = Date.now();
  const timeRemaining = makeBudget(startTime, budgetMs);
  const keys = sentKeys(date);

  // Idempotency gate (only enforced for live sends — dry runs may re-format freely)
  if (!dryRun) {
    const alreadySent = await redis.get(keys.sent);
    if (alreadySent) {
      log(`[send] digest:sent:${date} marker already set — no-op`);
      return {
        ok: true,
        alreadySent: true,
        date,
        marker: alreadySent,
      };
    }
  }

  const prepared = await loadPrepared(date, { redis });
  if (!prepared || !prepared.meta) {
    return {
      ok: false,
      error: 'prepared-payload-missing',
      date,
      message: `digest:prepared:${date}:complete marker not found — run /api/digest-prepare first`,
    };
  }

  if (prepared.meta.empty || prepared.scored.length === 0) {
    log(`[send] prepared payload reports empty day — no email to send`);
    return {
      ok: true,
      date,
      empty: true,
      message: 'No filings to send',
    };
  }

  const scored = prepared.scored;
  const notableEntries = prepared.notable || [];

  // ── Step 4: enrich top tiers with context ──
  log('[send 4/9] Enriching filings with context...');
  const enriched = await enrichAllFilings(scored);

  // ── Step 4b: AI "Why it matters" ──
  // TODO: parallelize — see audit 2026-04-28. This loop is sequential and
  // independent across filings; a Promise.all would collapse N×latency to
  // ~1×latency. Same applies to the three AI calls in step 6 below
  // (market-context, social-snippet) which can fan out concurrently with
  // this loop. Left sequential for now to preserve current ordering and
  // avoid churn during the prepare/send split.
  if (timeRemaining() < 20000) {
    log(`  Skipping AI content generation — only ${timeRemaining()}ms remaining`);
    for (const f of enriched) {
      if ((f.tier === 'top_pick' || f.tier === 'feature') && f.earningsContext && f.earningsContext.context) {
        f.whyItMatters = (f.whyItMatters || '') + ' ' + f.earningsContext.context;
      }
    }
  } else {
    log('[send 4b/9] Generating AI content...');
    for (const f of enriched) {
      if (f.tier === 'top_pick' || f.tier === 'feature') {
        try {
          const aiBlurb = await generateWhyItMattersAI(f);
          if (aiBlurb) {
            if (f.earningsContext && f.earningsContext.context) {
              f.whyItMatters = aiBlurb + ' ' + f.earningsContext.context;
            } else {
              f.whyItMatters = aiBlurb;
            }
          } else if (f.earningsContext && f.earningsContext.context) {
            f.whyItMatters = (f.whyItMatters || '') + ' ' + f.earningsContext.context;
          }
        } catch (e) {
          console.error(`AI blurb failed for ${f.ticker}:`, e.message);
          if (f.earningsContext && f.earningsContext.context) {
            f.whyItMatters = (f.whyItMatters || '') + ' ' + f.earningsContext.context;
          }
        }
      }
    }
  }

  let enrichedCategorized = categorizeForDigest(enriched);

  // ── Step 4c: rotate headline pick ──
  log('[send 4c/9] Checking for repeat headline picks...');
  try {
    const beforeTicker = enrichedCategorized.topPicks[0]?.ticker || '(none)';
    enrichedCategorized = await rotateHeadlinePick(enrichedCategorized);
    const afterTicker = enrichedCategorized.topPicks[0]?.ticker || '(none)';
    if (beforeTicker !== afterTicker) {
      log(`  Rotated headline: $${beforeTicker} → $${afterTicker} (repeat cooldown)`);
    } else {
      log(`  Headline: $${afterTicker} (fresh)`);
    }
  } catch (e) {
    console.error('  Headline rotation failed (non-fatal):', e.message);
  }

  // ── Step 5: record picks ──
  log('[send 5/9] Recording picks for scorecard...');
  const newPicksCount = await recordNewPicks(enriched);
  log(`  Recorded ${newPicksCount} new picks`);

  // ── Step 5b: update past pick returns ──
  const updatedReturns = await updateAllReturns();
  log(`  Updated returns for ${updatedReturns} past picks`);

  // ── Step 6: format email ──
  // TODO: parallelize — see audit 2026-04-28. getMarketOverview,
  // generateMarketContext, generateScorecard, and generateSocialSnippet are
  // all independent of each other and of the whyItMatters loop above; they
  // could fan out via Promise.all to shave several seconds.
  log('[send 6/9] Formatting email digest...');
  const marketOverview = await getMarketOverview();
  const aiMarketContext = await generateMarketContext(marketOverview, enriched);
  if (aiMarketContext && marketOverview) {
    marketOverview.summary = aiMarketContext;
  }
  const marketHtml = formatMarketOverviewForEmail(marketOverview);

  const scorecard = await generateScorecard();
  const scorecardHtml = formatScorecardForEmail(scorecard);

  // CEO spotlight: walk top tiers until we find a profile worth showing
  let ceoSpotlightHtml = '';
  for (const f of enriched) {
    if (f.ownerCik && (f.tier === 'top_pick' || f.tier === 'feature')) {
      const profile = await getCeoProfile(f.ownerCik);
      if (profile && profile.totalPicks >= 2 && profile.winRate !== null) {
        ceoSpotlightHtml = formatCeoSpotlight(profile);
        break;
      }
    }
  }

  const extraHtml = scorecardHtml + ceoSpotlightHtml;
  enrichedCategorized.notable = notableEntries;
  const { subject, html } = formatDigestEmail(enrichedCategorized, null, extraHtml, marketHtml);

  const topSignal = enrichedCategorized.topPicks[0] || enrichedCategorized.featured[0];
  const socialSnippet = await generateSocialSnippet(topSignal);

  // ── Step 7: send via Resend ──
  if (dryRun) {
    log('[send 7/9] DRY RUN — skipping send');
    return {
      ok: true,
      dry: true,
      date,
      subject,
      elapsedMs: Date.now() - startTime,
      stats: {
        filingsScanned: prepared.meta.filingIndexCount,
        filingsParsed: prepared.meta.parsedCount,
        topPicks: enrichedCategorized.topPicks.length,
        featured: enrichedCategorized.featured.length,
        mentions: enrichedCategorized.mentions.length,
      },
      aiContent: {
        marketContext: aiMarketContext || '(fallback — no API key)',
        socialSnippet: socialSnippet || '(fallback — no API key)',
      },
      preview: enriched.slice(0, 5).map((f) => ({
        ticker: f.ticker,
        owner: f.ownerName,
        title: f.officerTitle,
        score: f.score,
        tier: f.tier,
        signals: f.signals,
        buyValue: f.summary?.totalBuyValue ?? 0,
        whyItMatters: f.whyItMatters || null,
      })),
      html,
    };
  }

  log('[send 7/9] Sending via Resend...');
  const sendResult = await sendDigest(subject, html);
  // Mark sent BEFORE downstream side-effects — Resend returned 2xx, the broadcast
  // is in-flight, so we must not retry. Subsequent failures (snippet email,
  // archive) have their own markers.
  await redis.set(
    keys.sent,
    JSON.stringify({
      sentAt: new Date().toISOString(),
      subject,
      broadcastId: sendResult?.id || null,
    }),
    { ex: PREPARED_TTL_SECONDS * 7 } // keep marker around for a week
  );

  // ── Step 8: owner-only social snippet (idempotent) ──
  log('[send 8/9] Sending social snippet...');
  let snippetResult = null;
  try {
    const snippetMarker = await redis.get(keys.snippet);
    if (snippetMarker) {
      log(`  digest:snippet-sent:${date} already set — skipping`);
      snippetResult = { sent: false, alreadySent: true };
    } else {
      snippetResult = await sendOwnerSnippetEmail({
        snippet: socialSnippet,
        ticker: topSignal?.ticker,
      });
      if (snippetResult?.sent) {
        await redis.set(
          keys.snippet,
          JSON.stringify({ sentAt: new Date().toISOString(), to: snippetResult.to }),
          { ex: PREPARED_TTL_SECONDS * 7 }
        );
        log(`  Social snippet sent to ${snippetResult.to}`);
      }
    }
  } catch (e) {
    console.error('  Social snippet email failed:', e.message);
  }

  // ── Step 9: archive + headline pick (idempotent) ──
  log('[send 9/9] Storing in archive...');
  let archiveResult = null;
  try {
    const archiveMarker = await redis.get(keys.archived);
    if (archiveMarker) {
      log(`  digest:archived:${date} already set — skipping`);
      archiveResult = { archived: false, alreadyArchived: true };
    } else {
      const topPick = enrichedCategorized.topPicks[0] || enrichedCategorized.featured[0];
      await storeIssue(date, subject, html, {
        topPick: topPick ? `$${topPick.ticker}` : null,
        signalCount: enrichedCategorized.topPicks.length + enrichedCategorized.featured.length,
        filingsScanned: prepared.meta.filingIndexCount,
      });
      if (topPick?.ticker) {
        await recordHeadlinePick(topPick.ticker, date);
        log(`  Recorded $${topPick.ticker} as today's headline pick`);
      }
      await redis.set(
        keys.archived,
        JSON.stringify({
          archivedAt: new Date().toISOString(),
          topPick: topPick?.ticker || null,
        }),
        { ex: PREPARED_TTL_SECONDS * 7 }
      );
      archiveResult = { archived: true, topPick: topPick?.ticker || null };
    }
  } catch (e) {
    console.error('  Archive failed (non-fatal):', e.message);
  }

  return {
    ok: true,
    sent: true,
    date,
    subject,
    sendResult,
    snippetResult,
    archiveResult,
    elapsedMs: Date.now() - startTime,
    stats: {
      filingsScanned: prepared.meta.filingIndexCount,
      filingsParsed: prepared.meta.parsedCount,
      topPicks: enrichedCategorized.topPicks.length,
      featured: enrichedCategorized.featured.length,
    },
  };
}

module.exports = {
  prepare,
  send,
  loadPrepared,
  preparedKeys,
  sentKeys,
  // Exported for tests
  writePreparedPayload,
};
