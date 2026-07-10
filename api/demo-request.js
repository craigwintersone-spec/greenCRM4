// /api/demo-request.js
// Receives a demo enquiry from the site and emails it to hello@vorlana.com via Resend.
//
// Requires an environment variable in Vercel (Production + Preview):
//   RESEND_API_KEY   → your re_... key from resend.com
//
// This runs server-side so the API key is never exposed in the browser.

export default async function handler(req, res) {
  // Only accept POSTs
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('[demo-request] RESEND_API_KEY is not set');
    return res.status(500).json({ error: 'Email is not configured yet. Please try again later.' });
  }

  // Parse body (Vercel usually parses JSON automatically; guard just in case)
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  const name = String(body.name || '').trim();
  const email = String(body.email || '').trim();
  const org = String(body.org || '').trim();
  const message = String(body.message || '').trim();

  // Basic validation
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!name || !emailOk) {
    return res.status(400).json({ error: 'Please provide a name and a valid email address.' });
  }

  // Simple honeypot: if the hidden "company_url" field is filled, it's a bot.
  if (String(body.company_url || '').trim() !== '') {
    // Pretend success so bots don't learn anything.
    return res.status(200).json({ ok: true });
  }

  // Escape user content before dropping into HTML
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const safeName = esc(name);
  const safeEmail = esc(email);
  const safeOrg = esc(org || '—');
  const safeMessage = esc(message || '—').replace(/\n/g, '<br/>');

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#22312E;line-height:1.6">
      <h2 style="color:#175655;margin:0 0 12px">New demo request</h2>
      <table style="border-collapse:collapse;font-size:14px">
        <tr><td style="padding:4px 12px 4px 0;color:#7A847F">Name</td><td style="padding:4px 0"><strong>${safeName}</strong></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#7A847F">Email</td><td style="padding:4px 0"><a href="mailto:${safeEmail}" style="color:#1F6F6D">${safeEmail}</a></td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#7A847F">Organisation</td><td style="padding:4px 0">${safeOrg}</td></tr>
      </table>
      <div style="margin-top:14px;padding:14px;background:#F5F1EA;border:1px solid #E0DAD0;border-radius:10px">
        <div style="font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#7A847F;margin-bottom:6px">Message</div>
        <div style="font-size:14px;color:#22312E">${safeMessage}</div>
      </div>
      <p style="margin-top:16px;font-size:12px;color:#7A847F">Sent from the vorlana.com demo form.</p>
    </div>
  `;

  const text =
`New demo request

Name: ${name}
Email: ${email}
Organisation: ${org || '—'}

Message:
${message || '—'}

— Sent from the vorlana.com demo form`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Vorlana Demo Requests <hello@vorlana.com>',
        to: ['hello@vorlana.com'],
        reply_to: email,            // so you can reply straight to the enquirer
        subject: `Demo request — ${name}${org ? ' · ' + org : ''}`,
        html,
        text,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[demo-request] Resend error:', resp.status, detail);
      return res.status(502).json({ error: 'Could not send your request right now. Please email hello@vorlana.com directly.' });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[demo-request] threw:', e);
    return res.status(500).json({ error: 'Something went wrong. Please email hello@vorlana.com directly.' });
  }
}
