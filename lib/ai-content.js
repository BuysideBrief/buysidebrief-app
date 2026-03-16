/**
 * AI Content Generator
 * 
 * Uses the Anthropic API to generate:
 * 1. Market context — a 2-3 sentence editorial paragraph about today's market + signals
 * 2. "Why it matters" blurbs — unique, conversational context for each top pick
 * 3. Weekly deep dive — pattern analysis for the Saturday digest
 * 4. Social snippets — tweet-length summaries for social media
 * 
 * Falls back gracefully to template-based content if the API is unavailable.
 */

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

/**
 * Call the Anthropic API.
 */
async function callClaude(prompt, maxTokens = 300) {
  if (!ANTHROPIC_API_KEY) return null;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error(`Anthropic API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.content?.[0]?.text?.trim() || null;
  } catch (e) {
    console.error('Anthropic API call failed:', e.message);
    return null;
  }
}

/**
 * Generate an AI-written market context paragraph.
 * Replaces the hardcoded "Markets sold off." one-liner.
 * 
 * @param {object} marketOverview - { indices: [...], summary: "..." }
 * @param {array} topSignals - top scored filings for today
 * @returns {string} 2-3 sentence market context
 */
async function generateMarketContext(marketOverview, topSignals) {
  if (!marketOverview?.indices?.length) return null;

  const indexData = marketOverview.indices
    .map(i => `${i.label}: ${i.isPositive ? '+' : ''}${i.changePercent?.toFixed(2)}%`)
    .join(', ');

  const signalSummary = topSignals
    .filter(f => f.tier === 'top_pick' || f.tier === 'feature')
    .slice(0, 3)
    .map(f => {
      const action = f.summary.buyCount > 0 ? 'bought' : 'sold';
      const value = f.summary.buyCount > 0 ? f.summary.totalBuyValue : f.summary.totalSellValue;
      const valueStr = value >= 1_000_000 ? `$${(value / 1_000_000).toFixed(1)}M` : `$${(value / 1_000).toFixed(0)}K`;
      return `${f.officerTitle || (f.isDirector ? 'Director' : 'Insider')} at $${f.ticker} ${action} ${valueStr}`;
    })
    .join('; ');

  const prompt = `You are the editorial voice of Buyside Brief, a daily SEC insider trading newsletter. Write 2-3 sentences of market context for today's email.

Today's market data: ${indexData}

Today's top insider signals: ${signalSummary || 'Quiet day — no major signals'}

Rules:
- Write like a smart friend explaining markets over coffee, not a Bloomberg terminal
- Connect the market move to today's insider signals when relevant (e.g. "insiders buying into the dip" or "buying despite the rally")
- If there's no connection, just set the scene briefly
- Never give investment advice or predictions
- No bullet points, no headers — just flowing prose
- Keep it under 50 words
- Do not use the word "amidst"`;

  const result = await callClaude(prompt, 150);
  return result;
}

/**
 * Generate an AI-written "Why it matters" blurb for a filing.
 * Replaces the template-based blurbs in context-enricher.js.
 * 
 * @param {object} filing - scored + enriched filing
 * @returns {string} conversational paragraph
 */
async function generateWhyItMattersAI(filing) {
  const title = filing.officerTitle || (filing.isDirector ? 'Director' : 'Insider');
  const name = filing.ownerName || 'An insider';
  const ticker = filing.ticker || 'the company';
  const buyValue = filing.summary?.totalBuyValue || 0;
  const valueStr = buyValue >= 1_000_000 ? `$${(buyValue / 1_000_000).toFixed(1)}M` : `$${(buyValue / 1_000).toFixed(0)}K`;

  let priceContext = '';
  if (filing.priceContext) {
    const pc = filing.priceContext;
    if (pc.nearLow) priceContext = `The stock is trading ${pc.pctFromLow.toFixed(0)}% above its 52-week low of $${pc.low52w}. The 52-week high is $${pc.high52w}.`;
    else if (pc.nearHigh) priceContext = `The stock is near its 52-week high of $${pc.high52w}.`;
    else if (pc.pctFromHigh < -25) priceContext = `The stock is down ${Math.abs(pc.pctFromHigh).toFixed(0)}% from its 52-week high of $${pc.high52w}.`;
  }

  let historyContext = '';
  if (filing.insiderHistory) {
    const h = filing.insiderHistory;
    if (h.isFirstFiling) historyContext = 'This is their first purchase at this company.';
    else if (h.daysSinceLastBuy) historyContext = `Last filed ${h.daysSinceLastBuy} days ago. ${h.filingCount} total filings at this company.`;
  }

  const signals = (filing.signals || []).join('. ');

  const prompt = `You are the editorial voice of Buyside Brief, a daily SEC insider trading newsletter. Write a "Why it matters" paragraph for this insider trade.

Filing data:
- ${title} "${name}" bought ${valueStr} of $${ticker} (${filing.issuerName || ticker})
- Score: ${filing.score}/100
- Signals: ${signals}
- Discretionary (not pre-scheduled): ${!filing.has10b51Plan}
- Is 10%+ owner: ${filing.isTenPercentOwner || false}
${priceContext ? `- Price context: ${priceContext}` : ''}
${historyContext ? `- History: ${historyContext}` : ''}

Rules:
- Write 2-3 sentences max
- Sound like a smart friend explaining over coffee — conversational, not robotic
- Highlight what makes THIS specific trade interesting
- Never give investment advice or say "you should buy/sell"
- Don't start with "When a CEO..." or other generic openers — be specific to this trade
- No bullet points, no headers — just flowing prose`;

  const result = await callClaude(prompt, 200);
  return result;
}

/**
 * Generate a weekly deep dive analysis.
 * 
 * @param {array} weekPicks - this week's picks
 * @param {object} scorecard - current scorecard data
 * @returns {string} 2-3 paragraph analysis
 */
async function generateWeeklyDeepDive(weekPicks, scorecard) {
  if (!weekPicks || weekPicks.length === 0) return null;

  const pickSummary = weekPicks
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 8)
    .map(p => `$${p.ticker} (${p.ownerName}, ${p.officerTitle || 'Insider'}, bought $${((p.buyValue || 0) / 1000).toFixed(0)}K, score ${p.score})`)
    .join('\n');

  const prompt = `You are the editorial voice of Buyside Brief, a weekly SEC insider trading newsletter. Write a 2-3 paragraph "Week in Review" analysis.

This week's insider signals:
${pickSummary}

Scorecard: ${scorecard?.winRate || 'N/A'}% win rate across ${scorecard?.totalPicks || 0} all-time picks, avg return ${scorecard?.avgReturn || 'N/A'}%

Rules:
- Look for patterns: are insiders clustering in a sector? Buying the dip? Adding to winners?
- Be conversational — "Here's what caught our eye this week"
- Mention specific tickers and names — the data makes it credible
- Close with a forward-looking observation (not advice) like "worth watching next week"
- Never give investment advice
- Keep it under 150 words
- No bullet points or headers — flowing editorial prose`;

  const result = await callClaude(prompt, 400);
  return result;
}

/**
 * Generate a social media snippet from today's top signal.
 * 
 * @param {object} topSignal - the highest-scored filing
 * @returns {string} tweet-length summary
 */
async function generateSocialSnippet(topSignal) {
  if (!topSignal) return null;

  const title = topSignal.officerTitle || (topSignal.isDirector ? 'Director' : 'Insider');
  const buyValue = topSignal.summary?.totalBuyValue || 0;
  const valueStr = buyValue >= 1_000_000 ? `$${(buyValue / 1_000_000).toFixed(1)}M` : `$${(buyValue / 1_000).toFixed(0)}K`;

  const prompt = `Write a tweet (under 280 characters) about this SEC insider trade for the Buyside Brief newsletter account.

${title} at $${topSignal.ticker} just bought ${valueStr} of stock. Score: ${topSignal.score}/100. ${(topSignal.signals || []).slice(0, 2).join('. ')}.

Rules:
- Lead with the most interesting fact
- Include the ticker with $
- End with "Free daily signals → buysidebrief.com"
- No hashtags
- Punchy and conversational, not salesy
- Under 280 characters total`;

  const result = await callClaude(prompt, 100);
  return result;
}

module.exports = {
  callClaude,
  generateMarketContext,
  generateWhyItMattersAI,
  generateWeeklyDeepDive,
  generateSocialSnippet,
};
