/**
 * Social Snippet Generator
 *
 * Takes scored/enriched insider trading signals from the afternoon scan
 * and generates platform-ready social media copy (X/Twitter + LinkedIn)
 * using the Anthropic Claude API.
 *
 * Reuses the same API pattern as ai-content.js.
 */

const { callClaude } = require('./ai-content');

/**
 * Generate social media snippets for afternoon signals.
 *
 * @param {Array} signals - Scored + enriched filing objects (max 2, pre-sorted by score)
 * @returns {{ twitter: string|null, linkedin: string|null }}
 */
async function generateSocialSnippet(signals) {
  if (!signals || signals.length === 0) {
    return { twitter: '', linkedin: '' };
  }

  // Cap at 2 signals
  const top = signals.slice(0, 2);

  const signalDescriptions = top.map(s => {
    const title = s.officerTitle || (s.isDirector ? 'Director' : 'Insider');
    const buyValue = s.summary?.totalBuyValue || 0;
    const valueStr = buyValue >= 1_000_000
      ? `$${(buyValue / 1_000_000).toFixed(1)}M`
      : `$${(buyValue / 1_000).toFixed(0)}K`;

    const contextParts = [];
    if (s.priceContext?.nearLow) contextParts.push(`near 52-week low`);
    if (s.contrarianContext) contextParts.push(`stock down ${s.contrarianContext.drawdownPct}% from high`);
    if (s.earningsContext?.signal === 'post_earnings_buy') contextParts.push(`post-earnings buy`);
    const clusterSignal = (s.signals || []).find(sig => /cluster/i.test(sig));
    if (clusterSignal) contextParts.push('cluster buy');

    const scoreDrivers = (s.signals || []).slice(0, 3).join('; ');

    return {
      ticker: s.ticker,
      company: s.issuerName || s.ticker,
      title,
      name: s.ownerName || 'An insider',
      valueStr,
      score: s.score,
      context: contextParts.join(', ') || 'discretionary open-market purchase',
      scoreDrivers,
    };
  });

  const isSingle = signalDescriptions.length === 1;
  const s1 = signalDescriptions[0];
  const s2 = signalDescriptions[1];

  // Build the prompt for both variants
  const signalBlock = isSingle
    ? `Signal: ${s1.title} "${s1.name}" at $${s1.ticker} (${s1.company}) bought ${s1.valueStr}. Score: ${s1.score}/100. Context: ${s1.context}. Score drivers: ${s1.scoreDrivers}.`
    : `Signal 1: ${s1.title} "${s1.name}" at $${s1.ticker} (${s1.company}) bought ${s1.valueStr}. Score: ${s1.score}/100. Context: ${s1.context}. Score drivers: ${s1.scoreDrivers}.\nSignal 2: ${s2.title} "${s2.name}" at $${s2.ticker} (${s2.company}) bought ${s2.valueStr}. Score: ${s2.score}/100. Context: ${s2.context}. Score drivers: ${s2.scoreDrivers}.`;

  const prompt = `You are the editorial voice of Buyside Brief, a free daily SEC insider trading newsletter. Generate TWO social media snippets for an afternoon signal that was filed after the morning newsletter cutoff.

${signalBlock}

Generate exactly two variants, separated by the marker "---LINKEDIN---":

FIRST: An X/Twitter post (MUST be under 250 characters to leave room for the URL). Format:
${isSingle
    ? '🚨 Afternoon signal: [Company] $[Ticker] — [Role] just bought $[Amount] of stock [1 brief context phrase]. Filed after the morning brief.\nScore: [X]/100 | Tomorrow\'s Buyside Brief → buysidebrief.com'
    : '🚨 Two afternoon signals: $[Ticker1] ([Role] bought $[X]) and $[Ticker2] ([Role] bought $[Y]) — both filed after the morning brief.\nDetails in tomorrow\'s Buyside Brief → buysidebrief.com'}

---LINKEDIN---

SECOND: A LinkedIn post (under 600 characters). Format:
- Hook line about an afternoon insider signal crossing the radar
- 1-2 sentence plain-English explanation of what happened and why it's interesting
- The score and what drove it (purchase size, cluster buying, proximity to 52-week low, etc.)
- "Didn't make this morning's brief because it was filed after our cutoff. Full analysis drops tomorrow."
- End with: 📬 buysidebrief.com (free, daily, no spam)

Voice rules:
- Casual, data-forward, no clickbait, no false confidence
- Write like a smart friend explaining something interesting, not a finance influencer pumping a stock
- Never claim predictive power — the scoring model surfaces interesting activity, that's it
- No hashtags, no emojis beyond the 🚨 and 📬 specified above`;

  try {
    const result = await callClaude(prompt, 500);
    if (!result) {
      return buildTemplateFallback(signalDescriptions);
    }

    // Parse the two variants
    const parts = result.split('---LINKEDIN---');
    const twitter = (parts[0] || '').trim() || '';
    const linkedin = (parts[1] || '').trim() || '';

    // If parsing produced empty strings, fall back to templates
    if (!twitter && !linkedin) {
      return buildTemplateFallback(signalDescriptions);
    }

    return { twitter, linkedin };
  } catch (e) {
    console.error('Social snippet generation failed:', e.message);
    return buildTemplateFallback(signalDescriptions);
  }
}

/**
 * Template-based fallback when the AI API is unavailable.
 * Always produces usable content from the signal data directly.
 */
function buildTemplateFallback(signalDescriptions) {
  const s1 = signalDescriptions[0];
  const isSingle = signalDescriptions.length === 1;

  let twitter, linkedin;

  if (isSingle) {
    twitter = `Afternoon signal: ${s1.company} $${s1.ticker} — ${s1.title} just bought ${s1.valueStr} of stock. Score: ${s1.score}/100. Filed after this morning's brief.\nFree daily signals → buysidebrief.com`;
    linkedin = `Afternoon insider signal: ${s1.name} (${s1.title}) at $${s1.ticker} (${s1.company}) just bought ${s1.valueStr} of stock.\n\nOur model scored this ${s1.score}/100 based on: ${s1.scoreDrivers || s1.context}.\n\nThis filing came in after our morning cutoff — full analysis drops in tomorrow's brief.\n\nbuysidebrief.com (free, daily, no spam)`;
  } else {
    const s2 = signalDescriptions[1];
    twitter = `Two afternoon signals: $${s1.ticker} (${s1.title} bought ${s1.valueStr}) and $${s2.ticker} (${s2.title} bought ${s2.valueStr}) — both filed after the morning brief.\nDetails tomorrow → buysidebrief.com`;
    linkedin = `Two insider signals filed after this morning's cutoff:\n\n1. ${s1.name} (${s1.title}) at $${s1.ticker} bought ${s1.valueStr} — score ${s1.score}/100. ${s1.context}.\n2. ${s2.name} (${s2.title}) at $${s2.ticker} bought ${s2.valueStr} — score ${s2.score}/100. ${s2.context}.\n\nFull analysis in tomorrow's Buyside Brief.\n\nbuysidebrief.com (free, daily, no spam)`;
  }

  return { twitter, linkedin };
}

module.exports = { generateSocialSnippet };
