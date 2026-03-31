/**
 * Tests for lib/social-snippet.js
 */

// Mock the ai-content module before requiring social-snippet
jest.mock('../lib/ai-content', () => ({
  callClaude: jest.fn(),
}));

const { callClaude } = require('../lib/ai-content');
const { generateSocialSnippet } = require('../lib/social-snippet');

function makeSignal(overrides = {}) {
  return {
    ticker: 'ACME',
    issuerName: 'Acme Corp',
    ownerName: 'Jane Smith',
    officerTitle: 'CEO',
    isDirector: false,
    score: 85,
    tier: 'top_pick',
    summary: { totalBuyValue: 2500000, buyCount: 1, totalSellValue: 0 },
    signals: ['C-suite buy (+30)', 'Major purchase >$1M (+35)', 'Discretionary (+10)'],
    priceContext: null,
    contrarianContext: null,
    earningsContext: null,
    ...overrides,
  };
}

afterEach(() => {
  jest.clearAllMocks();
});

describe('generateSocialSnippet', () => {

  test('returns nulls for empty input', async () => {
    const result = await generateSocialSnippet([]);
    expect(result.twitter).toBeNull();
    expect(result.linkedin).toBeNull();
  });

  test('returns nulls for null input', async () => {
    const result = await generateSocialSnippet(null);
    expect(result.twitter).toBeNull();
    expect(result.linkedin).toBeNull();
  });

  test('generates twitter and linkedin variants from single signal', async () => {
    const twitterText = '🚨 Afternoon signal: Acme Corp $ACME — CEO just bought $2.5M of stock near 52-week low. Filed after the morning brief.\nScore: 85/100 | Tomorrow\'s Buyside Brief → buysidebrief.com';
    const linkedinText = 'Afternoon insider signal just crossed my radar.\n\nThe CEO of Acme Corp just bought $2.5M of stock. This one scored 85/100 on the Buyside Brief model.\n\nDidn\'t make this morning\'s brief because it was filed after our cutoff. Full analysis drops tomorrow.\n\n📬 buysidebrief.com (free, daily, no spam)';

    callClaude.mockResolvedValueOnce(`${twitterText}\n---LINKEDIN---\n${linkedinText}`);

    const result = await generateSocialSnippet([makeSignal()]);

    expect(result.twitter).toBe(twitterText);
    expect(result.linkedin).toBe(linkedinText);
    expect(callClaude).toHaveBeenCalledTimes(1);
  });

  test('handles two signals (combined format)', async () => {
    const twitterText = '🚨 Two afternoon signals: $ACME (CEO bought $2.5M) and $XYZ (CFO bought $500K) — both filed after the morning brief.\nDetails in tomorrow\'s Buyside Brief → buysidebrief.com';
    const linkedinText = 'Two afternoon insider signals just crossed my radar.\n\nAcme Corp CEO bought $2.5M and XYZ Inc CFO bought $500K.\n\n📬 buysidebrief.com (free, daily, no spam)';

    callClaude.mockResolvedValueOnce(`${twitterText}\n---LINKEDIN---\n${linkedinText}`);

    const signal1 = makeSignal();
    const signal2 = makeSignal({
      ticker: 'XYZ',
      issuerName: 'XYZ Inc',
      ownerName: 'Bob Jones',
      officerTitle: 'CFO',
      score: 78,
      summary: { totalBuyValue: 500000, buyCount: 1, totalSellValue: 0 },
    });

    const result = await generateSocialSnippet([signal1, signal2]);

    expect(result.twitter).toBeTruthy();
    expect(result.linkedin).toBeTruthy();
    // Prompt should mention both tickers
    const promptArg = callClaude.mock.calls[0][0];
    expect(promptArg).toContain('$ACME');
    expect(promptArg).toContain('$XYZ');
  });

  test('caps at 2 signals even if more provided', async () => {
    callClaude.mockResolvedValueOnce('tweet text\n---LINKEDIN---\nlinkedin text');

    const signals = [makeSignal(), makeSignal({ ticker: 'B' }), makeSignal({ ticker: 'C' })];
    await generateSocialSnippet(signals);

    const promptArg = callClaude.mock.calls[0][0];
    expect(promptArg).toContain('$ACME');
    expect(promptArg).toContain('$B');
    expect(promptArg).not.toContain('$C');
  });

  test('returns nulls gracefully when Claude API fails', async () => {
    callClaude.mockResolvedValueOnce(null);

    const result = await generateSocialSnippet([makeSignal()]);
    expect(result.twitter).toBeNull();
    expect(result.linkedin).toBeNull();
  });

  test('returns nulls when callClaude throws', async () => {
    callClaude.mockRejectedValueOnce(new Error('API timeout'));

    const result = await generateSocialSnippet([makeSignal()]);
    expect(result.twitter).toBeNull();
    expect(result.linkedin).toBeNull();
    expect(result.error).toBe('API call failed');
  });

  test('twitter variant stays under 280 chars when API cooperates', async () => {
    const shortTweet = '🚨 Afternoon signal: $ACME — CEO bought $2.5M near 52wk low. Score: 85/100 | Tomorrow → buysidebrief.com';
    callClaude.mockResolvedValueOnce(`${shortTweet}\n---LINKEDIN---\nLinkedIn post here.`);

    const result = await generateSocialSnippet([makeSignal()]);
    expect(result.twitter.length).toBeLessThanOrEqual(280);
  });

  test('linkedin variant stays under 700 chars when API cooperates', async () => {
    const linkedinPost = 'Afternoon insider signal just crossed my radar.\n\nThe CEO of Acme Corp just bought $2.5M of stock, scoring 85/100 on our model — driven by C-suite purchase size and discretionary open-market timing.\n\nDidn\'t make this morning\'s brief because it was filed after our cutoff. Full analysis drops tomorrow.\n\n📬 buysidebrief.com (free, daily, no spam)';
    callClaude.mockResolvedValueOnce(`Short tweet\n---LINKEDIN---\n${linkedinPost}`);

    const result = await generateSocialSnippet([makeSignal()]);
    expect(result.linkedin.length).toBeLessThanOrEqual(700);
  });

  test('includes context clues in prompt (near 52-week low)', async () => {
    callClaude.mockResolvedValueOnce('tweet\n---LINKEDIN---\nlinkedin');

    const signal = makeSignal({
      priceContext: { nearLow: true, pctFromLow: 5, low52w: 10, high52w: 50 },
    });
    await generateSocialSnippet([signal]);

    const promptArg = callClaude.mock.calls[0][0];
    expect(promptArg).toContain('near 52-week low');
  });

  test('includes contrarian context in prompt', async () => {
    callClaude.mockResolvedValueOnce('tweet\n---LINKEDIN---\nlinkedin');

    const signal = makeSignal({
      contrarianContext: { drawdownPct: 35, label: 'Deep contrarian', boost: 15 },
    });
    await generateSocialSnippet([signal]);

    const promptArg = callClaude.mock.calls[0][0];
    expect(promptArg).toContain('stock down 35% from high');
  });
});
