// /api/office.js — the back office's server jobs (demo account features, js/extensions/office-plus.js)
//   send_thanks  (signed in)  email a donor their thank-you from the charity and mark the gift thanked
//   offers       (public)     what charities are offering companies: team days and things to fund
//   enquire      (public)     a company asks about an offer; saved, and emailed to the charity's managers
//   give / gave  (public)     pay towards a "something to fund" offer by card, straight into the charity's own Stripe
//                             account (the one connected for bookings); the gift is saved in donations once Stripe says paid
//   send_report  (signed in)  email a company its impact report after a team day
//   vol_links    (signed in)  make each active volunteer's personal link, and optionally email it to them
//   vol_me / vol_join / vol_leave (public, by link)  a volunteer's own page: hours, sessions, and "I'll be there"
//   company_me / company_sub / company_subbed (public, by link)  a company's page of every day done; optional yearly plan
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, APP_URL. Needs ai-office.sql.
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const RATE = { windowMs: 60 * 1000, max: 30, hits: new Map() };

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && b.message) || ''}`);
  return b;
}
function flatten(obj, prefix, out) {
  out = out || {};
  Object.keys(obj).forEach(k => { const v = obj[k], key = prefix ? `${prefix}[${k}]` : k; if (v == null) return; if (typeof v === 'object') flatten(v, key, out); else out[key] = String(v); });
  return out;
}
async function stripe(path, params, account) {
  if (!STRIPE_KEY) throw new Error('Card payments are not set up yet.');
  const r = await fetch('https://api.stripe.com/v1/' + path, { method: params ? 'POST' : 'GET',
    headers: Object.assign({ Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, account ? { 'Stripe-Account': account } : {}),
    body: params ? new URLSearchParams(flatten(params)).toString() : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Stripe: ' + ((j.error && j.error.message) || r.status));
  return j;
}
const PLAN_PENCE = parseInt(process.env.COMPANY_PLAN_PENCE || '0', 10) || 0;          // yearly company plan; 0 = not on sale
const token = () => require('crypto').randomBytes(18).toString('base64url');
const evDate = e => String(e.event_date || e.date || '').slice(0, 10);
async function volFromToken(t) {
  if (!/^[A-Za-z0-9_-]{16,40}$/.test(String(t || ''))) return null;
  const l = (await sb(`volunteer_links?token=eq.${t}&select=org_id,volunteer_id&limit=1`))[0]; if (!l) return null;
  const v = (await sb(`volunteers?org_id=eq.${l.org_id}&id=eq.${encodeURIComponent(l.volunteer_id)}&select=id,name,first_name,email,status&limit=1`))[0]; if (!v) return null;
  const org = (await sb(`organisations?id=eq.${l.org_id}&select=id,name,brand_color,settings&limit=1`))[0]; if (!org) return null;
  return { org, v, vid: String(l.volunteer_id) };
}
async function companyAccount(email, company) {
  email = String(email || '').toLowerCase(); if (!okEmail(email)) return null;
  let a = (await sb(`company_accounts?email=eq.${encodeURIComponent(email)}&select=*&limit=1`))[0];
  if (!a) { a = (await sb('company_accounts', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ token: token(), email, company: trim(company, 120) || null }]) }))[0]; }
  return a;
}
const payReady = org => !!(STRIPE_KEY && org && org.settings && org.settings.stripe_account && org.settings.stripe_ready);
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
async function isManager(user, orgId) {
  try { const s = await sb(`super_admins?user_id=eq.${user.id}&select=user_id&limit=1`); if (Array.isArray(s) && s.length) return true; } catch (e) { /* no */ }
  const o = await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&select=owner_id&limit=1`);
  if (o && o[0] && o[0].owner_id === user.id) return true;
  const m = await sb(`memberships?user_id=eq.${user.id}&org_id=eq.${encodeURIComponent(orgId)}&status=eq.active&select=role&limit=1`);
  return Array.isArray(m) && m.length > 0 && /owner|admin|manager|super/i.test(m[0].role || '');
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
        charity: by[o.org_id].name, can_pay: o.kind === 'fund' && payReady(by[o.org_id]), colour: by[o.org_id].brand_color || '', logo: by[o.org_id].logo_url || '' })) });
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

    if (action === 'give') {
      if (body.hp) return res.status(200).json({ ok: true });
      const offer = (await sb(`company_offers?id=eq.${encodeURIComponent(String(body.offer_id || ''))}&open=eq.true&kind=eq.fund&select=id,org_id,title&limit=1`))[0];
      if (!offer) return bad(res, 'This is no longer open.', 404);
      const org = (await sb(`organisations?id=eq.${offer.org_id}&select=id,name,settings&limit=1`))[0];
      if (!payReady(org)) return bad(res, 'This charity can\u2019t take card payments here yet. Use \u201cAsk about funding this\u201d and they\u2019ll reply.');
      const pence = Math.round((parseFloat(body.amount) || 0) * 100), name = trim(body.name, 120), email = trim(body.email, 254).toLowerCase();
      if (pence < 100 || pence > 5000000) return bad(res, 'Enter an amount between \u00a31 and \u00a350,000.');
      if (!name) return bad(res, 'Please add your name or your company\u2019s name.');
      if (!okEmail(email)) return bad(res, 'Please add an email address for the receipt.');
      const ga = !!body.gift_aid, house = trim(body.house, 80), postcode = trim(body.postcode, 12).toUpperCase();
      if (ga && (!house || !postcode)) return bad(res, 'Gift Aid needs your home address: house name or number, and postcode.');
      const session = await stripe('checkout/sessions', { mode: 'payment', submit_type: 'donate', customer_email: email,
        line_items: [{ price_data: { currency: 'gbp', unit_amount: pence, product_data: { name: 'Donation to ' + org.name + ': ' + offer.title } }, quantity: 1 }],
        success_url: `${APP_URL}/companies.html?gave={CHECKOUT_SESSION_ID}&o=${offer.id}`, cancel_url: `${APP_URL}/companies.html`,
        metadata: { vorlana_donation: offer.id, donor_name: name, gift_aid: ga ? 'yes' : 'no', house, postcode } }, org.settings.stripe_account);
      return res.status(200).json({ ok: true, url: session.url });
    }
    if (action === 'gave') {
      const offer = (await sb(`company_offers?id=eq.${encodeURIComponent(String(body.offer_id || ''))}&select=id,org_id,title&limit=1`))[0];
      if (!offer || !/^cs_[A-Za-z0-9_]+$/.test(String(body.session || ''))) return bad(res, 'We couldn\u2019t find that payment.', 404);
      const org = (await sb(`organisations?id=eq.${offer.org_id}&select=id,name,settings&limit=1`))[0];
      if (!payReady(org)) return bad(res, 'We couldn\u2019t find that payment.', 404);
      const s = await stripe('checkout/sessions/' + encodeURIComponent(body.session), null, org.settings.stripe_account);
      const md = s.metadata || {};
      if (s.payment_status !== 'paid' || md.vorlana_donation !== offer.id) return bad(res, 'That payment hasn\u2019t gone through.', 402);
      const amount = (s.amount_total || 0) / 100, email = (s.customer_details && s.customer_details.email) || s.customer_email || null;
      const saved = await sb('donations?on_conflict=org_id,source,external_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
        body: JSON.stringify([{ org_id: org.id, source: 'vorlana', external_id: s.id, donor_name: trim(md.donor_name, 120) || 'Online donor', donor_email: email, amount, gift_date: new Date((s.created || Date.now() / 1000) * 1000).toISOString().slice(0, 10),
          method: 'Card (Vorlana)', gift_aid: md.gift_aid === 'yes', donor_house: md.house || null, donor_postcode: md.postcode || null, fund: offer.title, restricted: true, notes: 'Given on the company page' }]) });
      if (Array.isArray(saved) && saved.length) {                                                // first time we've seen it: tell the charity
        try { const to = await managerEmails(org.id); if (to.length) await sendMail({ to, fromName: 'Vorlana', subject: `New donation: \u00a3${amount.toLocaleString('en-GB')} for ${offer.title}`,
          html: shell(`<p><b>${esc(md.donor_name || 'Someone')}</b> has given <b>\u00a3${amount.toLocaleString('en-GB')}</b> towards <b>${esc(offer.title)}</b>${md.gift_aid === 'yes' ? ', with a Gift Aid declaration' : ''}.</p><p>It\u2019s in Donations in <a href="${APP_URL}/app.html">Vorlana</a>, with a thank-you ready to send.</p>`) }); } catch (e) { /* saved either way */ }
      }
      return res.status(200).json({ ok: true, charity: org.name, amount, title: offer.title });
    }

    if (action === 'vol_me' || action === 'vol_join' || action === 'vol_leave') {
      const me = await volFromToken(body.t || q.t); if (!me) return bad(res, 'This link isn\u2019t right. Ask the organisation to send you a new one.', 404);
      const o = `org_id=eq.${me.org.id}`, today = new Date().toISOString().slice(0, 10);
      const events = ((await sb(`events?${o}&select=*&limit=2000`)) || []).filter(e => evDate(e) >= today && evDate(e) <= new Date(Date.now() + 70 * 864e5).toISOString().slice(0, 10)).sort((a, b) => evDate(a) < evDate(b) ? -1 : 1).slice(0, 30);
      if (action !== 'vol_me') {
        const ev = events.find(e => String(e.id) === String(body.event_id)); if (!ev) return bad(res, 'That session isn\u2019t open for sign-up.', 404);
        if (action === 'vol_join') await sb('volunteer_signups?on_conflict=org_id,volunteer_id,event_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify([{ org_id: me.org.id, volunteer_id: me.vid, event_id: String(ev.id) }]) });
        else await sb(`volunteer_signups?${o}&volunteer_id=eq.${encodeURIComponent(me.vid)}&event_id=eq.${encodeURIComponent(String(ev.id))}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      }
      const [hours, mine, all] = await Promise.all([sb(`volunteer_hours?${o}&volunteer_id=eq.${encodeURIComponent(me.vid)}&select=session_date,hours,activity&order=session_date.desc&limit=500`).catch(() => []),
        sb(`volunteer_signups?${o}&volunteer_id=eq.${encodeURIComponent(me.vid)}&select=event_id`), sb(`volunteer_signups?${o}&select=event_id`)]);
      const year = today.slice(0, 4), joined = new Set((mine || []).map(x => String(x.event_id))), count = {}; (all || []).forEach(x => { count[x.event_id] = (count[x.event_id] || 0) + 1; });
      return res.status(200).json({ ok: true, org: me.org.name, colour: me.org.brand_color || '', name: me.v.first_name || String(me.v.name || '').split(' ')[0] || 'there',
        hours_year: Math.round((hours || []).filter(h => String(h.session_date || '').slice(0, 4) === year).reduce((a, h) => a + (+h.hours || 0), 0) * 10) / 10,
        hours_all: Math.round((hours || []).reduce((a, h) => a + (+h.hours || 0), 0) * 10) / 10, sessions: (hours || []).slice(0, 6).map(h => ({ date: h.session_date, hours: +h.hours || 0, what: h.activity || '' })),
        events: events.map(e => ({ id: String(e.id), name: e.name, date: evDate(e), where: e.location || '', type: e.type || '', joined: joined.has(String(e.id)), volunteers: count[String(e.id)] || 0 })) });
    }
    if (action === 'company_me' || action === 'company_sub' || action === 'company_subbed') {
      const c = String(body.c || q.c || ''); if (!/^[A-Za-z0-9_-]{16,40}$/.test(c)) return bad(res, 'This link isn\u2019t right.', 404);
      let acct = (await sb(`company_accounts?token=eq.${c}&select=*&limit=1`))[0]; if (!acct) return bad(res, 'This link isn\u2019t right.', 404);
      if (action === 'company_sub') {
        if (!PLAN_PENCE || !STRIPE_KEY) return bad(res, 'The yearly plan isn\u2019t on sale yet.');
        const session = await stripe('checkout/sessions', { mode: 'subscription', customer_email: acct.email, line_items: [{ price_data: { currency: 'gbp', unit_amount: PLAN_PENCE, recurring: { interval: 'year' }, product_data: { name: 'Vorlana for companies: yearly plan' } }, quantity: 1 }],
          success_url: `${APP_URL}/company.html?c=${c}&paid={CHECKOUT_SESSION_ID}`, cancel_url: `${APP_URL}/company.html?c=${c}`, metadata: { vorlana_company: c } });
        return res.status(200).json({ ok: true, url: session.url });
      }
      if (action === 'company_subbed') {
        if (!/^cs_[A-Za-z0-9_]+$/.test(String(body.session || ''))) return bad(res, 'We couldn\u2019t find that payment.', 404);
        const s = await stripe('checkout/sessions/' + encodeURIComponent(body.session));
        if (s.payment_status !== 'paid' || (s.metadata || {}).vorlana_company !== c) return bad(res, 'That payment hasn\u2019t gone through.', 402);
        const until = new Date(Date.now() + 366 * 864e5).toISOString().slice(0, 10);
        await sb(`company_accounts?token=eq.${c}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ paid_until: until, stripe_ref: s.subscription || s.id }) });
        acct = Object.assign({}, acct, { paid_until: until });
      }
      const days = (await sb(`company_enquiries?email=eq.${encodeURIComponent(acct.email)}&day_date=not.is.null&select=org_id,offer_id,company,day_date,day_people,day_hours,report_text,report_sent_at&order=day_date.desc&limit=200`)) || [];
      const ids = [...new Set(days.map(d => d.org_id))], offIds = [...new Set(days.map(d => d.offer_id).filter(Boolean))];
      const orgs = ids.length ? await sb(`organisations?id=in.(${ids.join(',')})&select=id,name`) : [], offs = offIds.length ? await sb(`company_offers?id=in.(${offIds.join(',')})&select=id,title`) : [];
      const on = {}, tn = {}; (orgs || []).forEach(o => { on[o.id] = o.name; }); (offs || []).forEach(o => { tn[o.id] = o.title; });
      const paid = !!(acct.paid_until && acct.paid_until >= new Date().toISOString().slice(0, 10));
      return res.status(200).json({ ok: true, company: acct.company || (days[0] && days[0].company) || 'Your company', paid, paid_until: acct.paid_until || null, plan_price: PLAN_PENCE && STRIPE_KEY ? PLAN_PENCE / 100 : 0,
        people: days.reduce((a, d) => a + (d.day_people || 0), 0), hours: Math.round(days.reduce((a, d) => a + (+d.day_hours || 0), 0) * 10) / 10, charities: ids.length,
        days: days.map(d => ({ charity: on[d.org_id] || 'A charity', title: tn[d.offer_id] || 'Team volunteering day', date: d.day_date, people: d.day_people || 0, hours: +d.day_hours || 0, report: d.report_sent_at && (paid || !(PLAN_PENCE && STRIPE_KEY)) ? d.report_text || '' : '', has_report: !!d.report_sent_at })) });
    }

    // ── signed in ──
    const user = await userFrom(req); if (!user) return bad(res, 'Please sign in again.', 401);
    const orgId = String(body.org_id || ''); if (!orgId) return bad(res, 'No organisation.');
    if (!(await isMember(user, orgId))) return bad(res, 'Not allowed.', 403);
    if (!(await isManager(user, orgId))) return bad(res, 'Only a manager can do this.', 403);            // these actions send email in the organisation's name

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
    if (action === 'send_report') {
      const text = trim(body.text, 6000); if (text.length < 40) return bad(res, 'The report is empty.');
      const e = (await sb(`company_enquiries?id=eq.${encodeURIComponent(String(body.enquiry_id || ''))}&org_id=eq.${encodeURIComponent(orgId)}&select=id,company,email&limit=1`))[0];
      if (!e || !okEmail(e.email || '')) return bad(res, 'There\u2019s no email address for this company.', 404);
      const org = (await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&select=name&limit=1`))[0] || {};
      const html = esc(text).split(/\n{2,}/).map(p => /^##\s*/.test(p) ? `<h3 style="color:#1F6F6D;margin:20px 0 6px">${p.replace(/^##\s*/, '')}</h3>` : `<p style="margin:0 0 12px">${p.replace(/\n/g, '<br>').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}</p>`).join('');
      let link = '';
      try { const acct = await companyAccount(e.email, e.company); if (acct) link = `<p style="margin:18px 0 0;font-size:13px;color:#6e6e73">Every day your team has given, in one place for your CSR reporting: <a href="${APP_URL}/company.html?c=${acct.token}">your company page</a>.</p>`; } catch (err) { /* the report still goes */ }
      await sendMail({ to: [e.email], replyTo: user.email, fromName: org.name || 'Thank you', subject: `Your team\u2019s impact with ${org.name || 'us'}`, html: shell(html + link) });
      await sb(`company_enquiries?id=eq.${e.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ report_sent_at: new Date().toISOString() }) });
      return res.status(200).json({ ok: true });
    }
    if (action === 'vol_links') {
      const vols = ((await sb(`volunteers?org_id=eq.${encodeURIComponent(orgId)}&select=id,name,first_name,email,status&limit=2000`)) || []).filter(v => (v.status || 'Active') === 'Active');
      const have = {}; ((await sb(`volunteer_links?org_id=eq.${encodeURIComponent(orgId)}&select=token,volunteer_id`)) || []).forEach(l => { have[String(l.volunteer_id)] = l.token; });
      const fresh = vols.filter(v => !have[String(v.id)]).map(v => ({ token: token(), org_id: orgId, volunteer_id: String(v.id) }));
      if (fresh.length) { await sb('volunteer_links?on_conflict=org_id,volunteer_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' }, body: JSON.stringify(fresh) }); fresh.forEach(l => { have[l.volunteer_id] = l.token; }); }
      let sent = 0, noEmail = 0;
      if (body.send) {
        const org = (await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&select=name&limit=1`))[0] || {};
        const only = body.volunteer_id != null ? String(body.volunteer_id) : null;
        for (const v of vols.slice(0, 200)) {
          if (only && String(v.id) !== only) continue;
          if (!okEmail(v.email || '')) { noEmail++; continue; }
          try { await sendMail({ to: [v.email], replyTo: user.email, fromName: org.name || 'Volunteering', subject: `Your volunteering with ${org.name || 'us'}`,
            html: shell(`<p>Hello ${esc(v.first_name || String(v.name || '').split(' ')[0] || '')},</p><p>Here\u2019s your own page for volunteering with ${esc(org.name || 'us')}. See what\u2019s coming up, say which sessions you\u2019ll be at, and see the hours you\u2019ve given.</p><p style="margin:18px 0"><a href="${APP_URL}/volunteer.html?t=${have[String(v.id)]}" style="background:#1F6F6D;color:#fff;text-decoration:none;border-radius:20px;padding:10px 20px;font-weight:bold">Open my volunteering page</a></p><p style="font-size:13px;color:#6e6e73">This link is just for you. No password needed.</p>`) }); sent++; } catch (err) { /* next */ }
        }
      }
      return res.status(200).json({ ok: true, links: have, sent, no_email: noEmail, volunteers: vols.length });
    }
    return bad(res, 'Unknown action.');
  } catch (e) {
    console.error('[office]', e);
    return bad(res, /RESEND|could not be sent|isn’t set up/.test(e.message) ? e.message : 'Something went wrong: ' + e.message, 500);
  }
};
