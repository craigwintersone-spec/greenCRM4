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

  const token = String(body.token || '').trim();
  const inviterName = String(body.inviter_name || '').trim().slice(0, 80);
  if (!token) return res.status(400).json({ error: 'An invite token is required.' });

  // SECURITY: only a signed-in manager of the organisation (or a Vorlana super admin) can send an
  // invite, and the email, organisation and role come from the saved invitation — never from the
  // request — so this can't be used to send Vorlana-branded emails to anyone about anything.
  const SUPABASE_URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !KEY) return res.status(500).json({ error: 'Server is not configured.' });
  const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!bearer) return res.status(401).json({ error: 'Please sign in again.' });
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${bearer}` } }).catch(() => null);
  if (!who || !who.ok) return res.status(401).json({ error: 'Please sign in again.' });
  const me = await who.json();
  const q = (path) => fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H }).then(r => r.ok ? r.json() : []).catch(() => []);
  let inv = (await q(`invitations?token=eq.${encodeURIComponent(token)}&select=org_id,email,role,accepted_at&limit=1`))[0];
  if (!inv) inv = (await q(`invites?token=eq.${encodeURIComponent(token)}&select=org_id,email,role&limit=1`))[0];
  if (!inv) return res.status(404).json({ error: 'Invitation not found.' });
  if (inv.accepted_at) return res.status(400).json({ error: 'That invitation has already been used.' });
  const isSuper = (await q(`super_admins?user_id=eq.${me.id}&select=user_id&limit=1`)).length > 0;
  const isMgr = (await q(`memberships?user_id=eq.${me.id}&org_id=eq.${inv.org_id}&status=eq.active&role=in.(owner,admin,manager)&select=user_id&limit=1`)).length > 0;
  if (!isSuper && !isMgr) return res.status(403).json({ error: 'Only a manager of this organisation can send invites.' });
  const org = (await q(`organisations?id=eq.${inv.org_id}&select=name&limit=1`))[0] || {};
  const email = String(inv.email || '').trim();
  const orgName = String(org.name || 'your organisation').trim();
  const role = String(inv.role || 'team member').trim();

  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (!emailOk) return res.status(400).json({ error: 'The invitation has no valid email.' });

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
