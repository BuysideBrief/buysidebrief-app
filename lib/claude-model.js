/**
 * Shared Claude settings for every call in the app.
 *
 * Claude Sonnet 4 (claude-sonnet-4-20250514) was retired on Jun 15, 2026 and
 * now returns 404. Its replacement, Claude Sonnet 5.5, thinks adaptively by
 * default: a reply can start with a thinking block, so read text by block
 * type, never content[0]. It can also decline (stop_reason "refusal").
 */

const CLAUDE_MODEL = 'claude-sonnet-5-5';

// Short content generation: low effort keeps thinking brief and skips it on
// most requests.
const CLAUDE_OUTPUT_CONFIG = { effort: 'low' };

// Thinking counts toward max_tokens, so leave room for it on top of the reply.
const THINKING_HEADROOM_TOKENS = 1024;

/**
 * The text of the first text block, or null when Claude declined or sent none.
 * Works on both SDK Message objects and raw API JSON.
 */
function firstText(message) {
  if (!message || message.stop_reason === 'refusal') return null;
  const block = (message.content || []).find((b) => b && b.type === 'text');
  return block && typeof block.text === 'string' ? block.text : null;
}

module.exports = {
  CLAUDE_MODEL,
  CLAUDE_OUTPUT_CONFIG,
  THINKING_HEADROOM_TOKENS,
  firstText,
};
