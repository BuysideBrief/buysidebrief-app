/**
 * Regression: the footer's Unsubscribe link must use Resend's broadcast merge
 * tag. Resend only substitutes {{{RESEND_UNSUBSCRIBE_URL}}}; any other
 * placeholder (e.g. the Mailgun-style %unsubscribe_url%) ships to subscribers
 * verbatim and the link goes nowhere.
 */
const fs = require('fs');
const path = require('path');
const { formatDigestEmail, UNSUBSCRIBE_URL_TAG } = require('../lib/email-formatter');
const { formatWeeklyEmail } = require('../api/send-weekly');

const RESEND_TAG = '{{{RESEND_UNSUBSCRIBE_URL}}}';

const emptyCategorized = {
  topPicks: [],
  featured: [],
  mentions: [],
  notable_sells: [],
  notable: [],
  totalProcessed: 0,
  totalFeatured: 0,
};

describe('unsubscribe link', () => {
  test('shared tag is Resend\'s broadcast unsubscribe merge tag', () => {
    expect(UNSUBSCRIBE_URL_TAG).toBe(RESEND_TAG);
  });

  test('daily digest footer links Unsubscribe to the Resend merge tag', () => {
    const { html } = formatDigestEmail(emptyCategorized, '2026-11-23T12:00:00Z');
    expect(html).toContain(`href="${RESEND_TAG}"`);
    expect(html).not.toContain('%unsubscribe_url%');
  });

  test('weekly digest footer links Unsubscribe to the Resend merge tag', () => {
    const { html } = formatWeeklyEmail([], null, null, []);
    expect(html).toContain(`href="${RESEND_TAG}"`);
    expect(html).not.toContain('%unsubscribe_url%');
  });

  test('no source file still uses the old placeholder', () => {
    const root = path.join(__dirname, '..');
    for (const rel of ['lib/email-formatter.js', 'api/send-weekly.js', 'test-digest.html']) {
      expect(fs.readFileSync(path.join(root, rel), 'utf8')).not.toContain('%unsubscribe_url%');
    }
  });
});
