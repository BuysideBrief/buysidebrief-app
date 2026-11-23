const { CLAUDE_MODEL, firstText } = require('../lib/claude-model');

describe('claude-model', () => {
  test('uses Claude Sonnet 5.5', () => {
    expect(CLAUDE_MODEL).toBe('claude-sonnet-5-5');
  });

  test('skips a leading thinking block and returns the text', () => {
    const message = {
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Market context' }],
    };
    expect(firstText(message)).toBe('Market context');
  });

  test('returns null when Claude declines', () => {
    const message = { stop_reason: 'refusal', content: [{ type: 'text', text: 'I cannot help.' }] };
    expect(firstText(message)).toBeNull();
  });

  test('returns null when there is no text block', () => {
    expect(firstText({ stop_reason: 'max_tokens', content: [{ type: 'thinking' }] })).toBeNull();
    expect(firstText(null)).toBeNull();
  });
});
