// /api/office.js — the back office's server jobs (demo account features, js/extensions/office-plus.js)
//   send_thanks  (signed in)  email a donor their thank-you from the charity and mark the gift thanked
//   offers       (public)     what charities are offering companies: team days and things to fund
//   enquire      (public)     a company asks about an offer; saved, and emailed to the charity's managers
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, APP_URL. Needs ai-office.sql.
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');
const RATE = { windowMs: 60 * 1000, max: 30, hits: new Map() };

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && b.message) || ''}`);
  return b;
}
const bad = (res, message, code) => res.status(code || 400).json({ ok: false, error: message });
const trim = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b-\u001f]/g, ' ').trim().slice(0, n || 200);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const okEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown', now = Date.now();
  const h = (RATE.hits.get(ip) || []).filter(t => now - t < RATE.windowMs); h.push(now); RATE.hits.set(ip, h);
  return h.length > RATE.max;
}
async function userFrom(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json(); return u && u.id ? u : null;
}
async function isMember(user, orgId) {
  try { const s = await sb(`super_admins?user_id=eq.${user.id}&select=user_id&limit=1`); if (Array.isArray(s) && s.length) return true; } catch (e) { /* no */ }
  const o = await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&select=owner_id&limit=1`);
  if (o && o[0] && o[0].owner_id === user.id) return true;
  const m = await sb(`memberships?user_id=eq.${user.id}&org_id=eq.${encodeURIComponent(orgId)}&status=eq.active&select=role&limit=1`);
  return Array.isArray(m) && m.length > 0;
}
async function managerEmails(orgId) {
  const ms = await sb(`memberships?org_id=eq.${encodeURIComponent(orgId)}&status=eq.active&role=in.(owner,admin,manager)&select=user_id`);
  const out = [];
  for (const m of ms || []) {
    try { const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${m.user_id}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }); if (r.ok) { const u = await r.json(); if (u && u.email) out.push(u.email); } } catch (e) { /* skip */ }
  }
  return [...new Set(out)];
}
async function sendMail({ to, subject, html, fromName, replyTo }) {
  if (!RESEND_API_KEY) throw new Error('Email isn’t set up yet (RESEND_API_KEY is missing).');
  const from = `${String(fromName || 'Vorlana').replace(/[<>"\r\n]/g, '').slice(0, 60)} <hello@vorlana.com>`;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ from, to, subject, html }, replyTo ? { reply_to: replyTo } : {})) });
  if (!r.ok) throw new Error('The email could not be sent (' + r.status + ').');
}
const para = t => esc(t).split(/\n{2,}/).map(p => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
const shell = inner => `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1d1d1f;max-width:560px">${inner}</div>`;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && req.method !== 'GET') return bad(res, 'Method not allowed', 405);
  if (!SUPABASE_URL || !KEY) return bad(res, 'The server is not set up.', 500);
  if (rateLimited(req)) return bad(res, 'Too many requests. Please wait a moment.', 429);
  const q = req.query || {}, body = (req.body && typeof req.body === 'object') ? req.body : {};
  const action = String(body.action || q.action || '');
  try {
    // ── public: what charities offer companies ──
    if (action === 'offers') {
      let offers;
      try { offers = await sb('company_offers?open=eq.true&select=id,org_id,kind,title,description,offer_date,places,amount,area,cause&order=offer_date.asc.nullslast&limit=300'); }
      catch (e) { return res.status(200).json({ ok: true, offers: [] }); }
      const today = new Date().toISOString().slice(0, 10);
      offers = (offers || []).filter(o => !o.offer_date || o.offer_date >= today);
      const ids = [...new Set(offers.map(o => o.org_id))];
      const orgs = ids.length ? await sb(`organisations?id=in.(${ids.join(',')})&select=id,name,brand_color,logo_url,settings,status`) : [];
      const by = {}; (orgs || []).forEach(o => { if (o.status !== 'suspended' && o.settings && o.settings.demo_account === true) by[o.id] = o; });   // demo account only while this is tested
      return res.status(200).json({ ok: true, offers: offers.filter(o => by[o.org_id]).map(o => ({ id: o.id, kind: o.kind, title: o.title, description: o.description || '', date: o.offer_date, places: o.places, amount: o.amount, area: o.area || '', cause: o.cause || '',
        charity: by[o.org_id].name, colour: by[o.org_id].brand_color || '', logo: by[o.org_id].logo_url || '' })) });
    }
    if (action === 'enquire') {
      if (body.hp) return res.status(200).json({ ok: true });                                 // a bot filled the hidden box
      const offer = (await sb(`company_offers?id=eq.${encodeURIComponent(String(body.offer_id || ''))}&open=eq.true&select=id,org_id,title,kind&limit=1`))[0];
      if (!offer) return bad(res, 'This offer is no longer open.', 404);
      const company = trim(body.company, 120), name = trim(body.name, 120), email = trim(body.email, 254).toLowerCase();
      if (!company) return bad(res, 'Please add your company’s name.');
      if (!okEmail(email)) return bad(res, 'Please add an email address so the charity can reply.');
      const row = { org_id: offer.org_id, offer_id: offer.id, company, contact_name: name || null, email, phone: trim(body.phone, 30) || null, people: parseInt(body.people, 10) || null, message: trim(body.message, 1500) || null };
      await sb('company_enquiries', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) });
      try {
        const org = (await sb(`organisations?id=eq.${offer.org_id}&select=name&limit=1`))[0] || {};
        const to = await managerEmails(offer.org_id);
        if (to.length) await sendMail({ to, replyTo: email, fromName: 'Vorlana', subject: `${company} is interested in: ${offer.title}`,
          html: shell(`<p><b>${esc(company)}</b> has asked about <b>${esc(offer.title)}</b> at ${esc(org.name || 'your organisation')}.</p>` +
            `<p>${esc(name || 'No name given')} · <a href="mailto:${esc(email)}">${esc(email)}</a>${row.phone ? ' · ' + esc(row.phone) : ''}${row.people ? ' · ' + row.people + ' people' : ''}</p>` +
            (row.message ? `<p style="border-left:3px solid #1F6F6D;padding-left:12px;color:#424245">${esc(row.message).replace(/\n/g, '<br>')}</p>` : '') +
            `<p>Reply to this email to answer them directly. It’s also saved under Company partners in <a href="${APP_URL}/app.html">Vorlana</a>.</p>`) });
      } catch (e) { /* the enquiry is saved even if the email fails */ }
      return res.status(200).json({ ok: true });
    }

    // ── signed in ──
    const user = await userFrom(req); if (!user) return bad(res, 'Please sign in again.', 401);
    const orgId = String(body.org_id || ''); if (!orgId) return bad(res, 'No organisation.');
    if (!(await isMember(user, orgId))) return bad(res, 'Not allowed.', 403);

    if (action === 'send_thanks') {
      const text = trim(body.text, 4000); if (text.length < 20) return bad(res, 'The thank-you is empty.');
      const d = (await sb(`donations?id=eq.${encodeURIComponent(String(body.donation_id || ''))}&org_id=eq.${encodeURIComponent(orgId)}&select=id,donor_name,donor_email,thanks_sent_at&limit=1`))[0];
      if (!d) return bad(res, 'That donation isn’t saved yet, so it can’t be emailed from here.', 404);
      if (!okEmail(d.donor_email || '')) return bad(res, 'There’s no email address for this donor.');
      if (d.thanks_sent_at && !body.again) return bad(res, 'A thank-you was already sent for this gift.', 409);
      const org = (await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&select=name&limit=1`))[0] || {};
      await sendMail({ to: [d.donor_email], replyTo: user.email, fromName: org.name || 'Thank you', subject: 'Thank you from ' + (org.name || 'us'), html: shell(para(text)) });
      const now = new Date().toISOString();
      await sb(`donations?id=eq.${d.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ thanked_at: now, thanks_sent_at: now }) });
      return res.status(200).json({ ok: true, thanked_at: now });
    }
    return bad(res, 'Unknown action.');
  } catch (e) {
    console.error('[office]', e);
    return bad(res, /RESEND|could not be sent|isn’t set up/.test(e.message) ? e.message : 'Something went wrong: ' + e.message, 500);
  }
};
