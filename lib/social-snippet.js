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
    return { twitter: null, linkedin: null };
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
      return { twitter: null, linkedin: null };
    }

    // Parse the two variants
    const parts = result.split('---LINKEDIN---');
    const twitter = (parts[0] || '').trim() || null;
    const linkedin = (parts[1] || '').trim() || null;

    return { twitter, linkedin };
  } catch (e) {
    console.error('Social snippet generation failed:', e.message);
    return { twitter: null, linkedin: null, error: 'API call failed' };
  }
}

module.exports = { generateSocialSnippet };
