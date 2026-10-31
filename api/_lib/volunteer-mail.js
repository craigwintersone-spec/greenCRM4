// /api/_lib/volunteer-mail.js — when someone says "I'd like to volunteer" on a QR page:
//   1. the organisation's chosen inbox gets an alert with their details
//   2. the volunteer (if they gave an email) gets a thank-you, sent as "<Organisation> via Vorlana", replies going to the organisation
// Settings live in organisations.settings: volunteer_alert_to (comma-separated emails), volunteer_reply_to,
// volunteer_alerts (false = off), volunteer_thanks (false = off), volunteer_thanks_text (optional extra paragraph).
// With no alert inbox chosen, alerts go to the organisation's owners and managers.
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');

async function sb(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}`);
  return r.json();
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const okEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());
const emailList = v => String(v || '').split(/[,;\s]+/).map(s => s.trim().toLowerCase()).filter(okEmail).slice(0, 10);

async function managerEmails(orgId) {   // owners and managers, from their logins
  const out = [];
  try {
    const m = await sb(`memberships?org_id=eq.${orgId}&status=eq.active&select=user_id,role&limit=50`);
    for (const row of (m || []).filter(x => /^(owner|admin|manager)$/i.test(x.role || '')).slice(0, 5)) {
      try {
        const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${row.user_id}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
        const u = r.ok ? await r.json() : null;
        if (u && okEmail(u.email)) out.push(u.email.toLowerCase());
      } catch (e) { /* skip this one */ }
    }
  } catch (e) { /* no managers found */ }
  return out;
}
function shell(org, title, inner) {
  const colour = /^#[0-9a-f]{3,8}$/i.test(org.brand_color || '') ? org.brand_color : '#1F6F6D';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1A1A1A">
<div style="background:${colour};color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-weight:bold;font-size:16px">${esc(org.name || '')}</div>
<div style="border:1px solid #E5E1D8;border-top:0;border-radius:0 0 10px 10px;padding:20px">
<h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>${inner}
<p style="color:#8A857A;font-size:12px;margin:18px 0 0">Sent by Vorlana on behalf of ${esc(org.name || 'the organisation')}.</p></div></div>`;
}
async function send(to, subject, html, fromName, replyTo) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const body = { from: `${String(fromName || 'Vorlana').replace(/[<>"]/g, '').slice(0, 60)} <hello@vorlana.com>`, to, subject, html };
  if (replyTo && replyTo.length) body.reply_to = replyTo;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + await r.text());
}

// lead: { first, last, email, phone, where, note }
async function sendVolunteerEmails(orgId, lead) {
  const result = { alert: false, thanks: false, errors: [] };
  let org = {};
  try { org = (await sb(`organisations?id=eq.${orgId}&select=name,brand_color,settings&limit=1`))[0] || {}; } catch (e) { result.errors.push(e.message); return result; }
  const st = org.settings || {}, name = `${lead.first} ${lead.last}`.trim();
  let alertTo = emailList(st.volunteer_alert_to);
  if (!alertTo.length) alertTo = await managerEmails(orgId);
  const replyTo = emailList(st.volunteer_reply_to).length ? emailList(st.volunteer_reply_to) : alertTo.slice(0, 1);

  if (st.volunteer_alerts !== false && alertTo.length) {
    const rows = [['Name', name], ['Email', lead.email], ['Phone', lead.phone], ['Signed up at', lead.where], ['Their note', lead.note]].filter(r => r[1]);
    const html = shell(org, 'New volunteer sign-up', `<p style="font-size:14px">${esc(lead.first)} would like to volunteer with you.</p>
<table style="font-size:14px;border-collapse:collapse;margin:0 0 16px">${rows.map(r => `<tr><td style="padding:3px 14px 3px 0;color:#6B665C;vertical-align:top">${r[0]}</td><td>${esc(r[1])}</td></tr>`).join('')}</table>
<p style="margin:0 0 6px"><a href="${APP_URL}/app.html" style="display:inline-block;background:#1F6F6D;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:bold;font-size:14px">Open in Vorlana</a></p>
<p style="font-size:13px;color:#6B665C;margin:10px 0 0">They're saved in Contacts as a volunteer prospect.${lead.email ? ' Reply to this email to contact them directly.' : ''}</p>`);
    try { await send(alertTo, `New volunteer: ${name}`, html, 'Vorlana', lead.email ? [lead.email] : null); result.alert = true; } catch (e) { result.errors.push(e.message); }
  }
  if (st.volunteer_thanks !== false && okEmail(lead.email)) {
    const extra = String(st.volunteer_thanks_text || '').trim().slice(0, 1200);
    const html = shell(org, 'Thank you for offering to volunteer', `<p style="font-size:14px">Hi ${esc(lead.first)},</p>
<p style="font-size:14px">Thank you for letting us know you'd like to volunteer with ${esc(org.name || 'us')}. Someone from the team will be in touch soon.</p>
${extra ? extra.split(/\n{2,}/).map(p => `<p style="font-size:14px">${esc(p).replace(/\n/g, '<br/>')}</p>`).join('') : ''}
<p style="font-size:14px">If you have any questions in the meantime, just reply to this email.</p>`);
    try { await send([lead.email], `Thanks for offering to volunteer with ${org.name || 'us'}`, html, `${org.name || 'Vorlana'} via Vorlana`, replyTo); result.thanks = true; } catch (e) { result.errors.push(e.message); }
  }
  return result;
}

module.exports = { sendVolunteerEmails };
