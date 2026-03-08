/**
 * /api/subscribe.js
 * 
 * Handles email signups from the landing page.
 * Adds subscriber to Resend audience (primary) and optionally Beehiiv.
 * 
 * POST { email: "user@example.com" }
 */

module.exports = async function handler(req, res) {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { email } = req.body || {};

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    const results = {};

    // ── Add to Resend audience ──
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const RESEND_AUDIENCE_ID = process.env.RESEND_AUDIENCE_ID;

    if (RESEND_API_KEY && RESEND_AUDIENCE_ID) {
      const resendRes = await fetch(
        `https://api.resend.com/audiences/${RESEND_AUDIENCE_ID}/contacts`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email,
            unsubscribed: false,
          }),
        }
      );

      if (resendRes.ok) {
        results.resend = 'added';
      } else {
        const err = await resendRes.text();
        console.error('Resend add contact failed:', err);
        results.resend = 'error';
      }
    }

    // ── Optionally add to Beehiiv ──
    const BEEHIIV_API_KEY = process.env.BEEHIIV_API_KEY;
    const BEEHIIV_PUB_ID = process.env.BEEHIIV_PUB_ID;

    if (BEEHIIV_API_KEY && BEEHIIV_PUB_ID) {
      const beehiivRes = await fetch(
        `https://api.beehiiv.com/v2/publications/${BEEHIIV_PUB_ID}/subscriptions`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${BEEHIIV_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            email,
            reactivate_existing: true,
            send_welcome_email: false,
          }),
        }
      );

      if (beehiivRes.ok) {
        results.beehiiv = 'added';
      } else {
        const err = await beehiivRes.text();
        console.error('Beehiiv add subscriber failed:', err);
        results.beehiiv = 'error';
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Subscribed!',
      results,
    });

  } catch (err) {
    console.error('Subscribe error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
