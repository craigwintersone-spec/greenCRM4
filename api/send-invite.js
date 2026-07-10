// /api/send-invite.js
// Emails an invitation link to a new user via Resend.
// Called after an invitation row has been created in the `invitations` table
// (from super-admin.html when inviting a manager, or team.html when a manager
// invites their staff).
//
// Requires env var in Vercel (Production + Preview):
//   RESEND_API_KEY   → your re_... key
//
// POST body (JSON):
//   { email, org_name, role, token, inviter_name? }

const SITE_URL = 'https://vorlana.com'; // canonical, non-www to avoid mismatch

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const RESEND_API_KEY = process.env.RESEND_API_KEY;
  if (!RESEND_API_KEY) {
    console.error('[send-invite] RESEND_API_KEY not set');
    return res.status(500).json({ error: 'Email is not configured yet.' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  const email = String(body.email || '').trim();
  const orgName = String(body.org_name || 'your organisation').trim();
  const role = String(body.role || 'team member').trim();
  const token = String(body.token || '').trim();
  const inviterName = String(body.inviter_name || '').trim();

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk || !token) {
    return res.status(400).json({ error: 'A valid email and invite token are required.' });
  }

  const inviteLink = `${SITE_URL}/invite.html?token=${encodeURIComponent(token)}`;

  const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  const roleLabel = { manager: 'Manager', advisor: 'Advisor', admin: 'Admin' }[role] || esc(role);
  const introLine = inviterName
    ? `${esc(inviterName)} has invited you to join <strong>${esc(orgName)}</strong> on Vorlana.`
    : `You've been invited to join <strong>${esc(orgName)}</strong> on Vorlana.`;

  const html = `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#F5F1EA;padding:32px 0">
    <div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #E5DFD3;border-radius:14px;overflow:hidden">
      <div style="background:#1F6F6D;padding:22px 28px">
        <span style="color:#fff;font-size:22px;font-weight:800;letter-spacing:-.5px">Vorlana</span>
      </div>
      <div style="padding:28px">
        <h1 style="margin:0 0 12px;font-size:20px;color:#1F2A28">You're invited to join a team</h1>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#4F5B58">${introLine}</p>
        <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#4F5B58">
          Your role will be <strong>${roleLabel}</strong>. Click below to set your password and get started.
        </p>
        <a href="${inviteLink}"
           style="display:inline-block;background:#1F6F6D;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:13px 26px;border-radius:10px">
          Accept invitation →
        </a>
        <p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:#7A857F">
          Or paste this link into your browser:<br/>
          <a href="${inviteLink}" style="color:#1F6F6D;word-break:break-all">${inviteLink}</a>
        </p>
        <p style="margin:18px 0 0;font-size:12px;color:#7A857F">This invitation expires in 7 days.</p>
      </div>
      <div style="padding:16px 28px;border-top:1px solid #E5DFD3;font-size:12px;color:#7A857F">
        Sent by Vorlana · If you weren't expecting this, you can safely ignore it.
      </div>
    </div>
  </div>`;

  const text =
`You're invited to join ${orgName} on Vorlana.

Your role will be ${roleLabel}. Open the link below to set your password and get started:

${inviteLink}

This invitation expires in 7 days.
If you weren't expecting this, you can safely ignore it.`;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'Vorlana <hello@vorlana.com>',
        to: [email],
        subject: `You're invited to join ${orgName} on Vorlana`,
        html,
        text,
      }),
    });

    if (!resp.ok) {
      const detail = await resp.text().catch(() => '');
      console.error('[send-invite] Resend error:', resp.status, detail);
      return res.status(502).json({ error: 'Could not send the invite email.', link: inviteLink });
    }

    return res.status(200).json({ ok: true, link: inviteLink });
  } catch (e) {
    console.error('[send-invite] threw:', e);
    return res.status(500).json({ error: 'Something went wrong sending the invite.', link: inviteLink });
  }
}
