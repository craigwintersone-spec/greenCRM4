// /api/bookings.js — event bookings and payments
// Public (no login): list an organisation's upcoming events, book a place, pay through Stripe, see or cancel a booking.
// Staff (logged in): counts per event, who's coming, add a phone/cash booking, mark arrived, cancel, connect Stripe.
// Money always goes to the organisation's own Stripe account (Stripe Connect, direct charges). Vorlana never holds it and takes no fee.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY (Vorlana's platform key), RESEND_API_KEY, APP_URL
const crypto = require('crypto');
const mail = require('./_lib/booking-mail.js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');
const PENDING_MINUTES = 30;                       // an unpaid checkout holds its places this long
const RATE = { windowMs: 60 * 1000, max: 120, hits: new Map() };

// ── helpers ──
async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && b.message) || ''}`);
  return b;
}
async function sbTry(...paths) { let last; for (const p of paths) { try { return await sb(p); } catch (e) { last = e; } } throw last; }   // fuller column list first
function flatten(obj, prefix, out) {
  out = out || {};
  Object.keys(obj).forEach(k => {
    const v = obj[k], key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) return;
    if (typeof v === 'object') flatten(v, key, out); else out[key] = String(v);
  });
  return out;
}
async function stripe(path, params, account, method) {
  if (!STRIPE_KEY) throw new Error('Payments are not set up yet (STRIPE_SECRET_KEY is missing).');
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method: method || (params ? 'POST' : 'GET'),
    headers: Object.assign({ Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' }, account ? { 'Stripe-Account': account } : {}),
    body: params ? new URLSearchParams(flatten(params)).toString() : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Stripe: ' + ((j.error && j.error.message) || r.status));
  return j;
}
const bad = (res, message, code, extra) => res.status(code || 400).json(Object.assign({ ok: false, error: message }, extra || {}));
const trim = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n || 200);
const okEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const int = (v, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : lo; };
const newToken = () => crypto.randomBytes(18).toString('base64url');
function londonNow() {
  const p = {}; new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).forEach(x => { p[x.type] = x.value; });
  return { day: `${p.year}-${p.month}-${p.day}`, stamp: `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
function closesAt(ev) { return `${ev.event_date} ${/^\d{1,2}:\d{2}$/.test(ev.start_time || '') ? ev.start_time.padStart(5, '0') : '23:59'}`; }   // at the start time, or the end of the day
function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown', now = Date.now();
  const h = (RATE.hits.get(ip) || []).filter(t => now - t < RATE.windowMs); h.push(now); RATE.hits.set(ip, h);
  return h.length > RATE.max;
}

// ── who and what ──
const EVENT_COLS = 'id,org_id,name,event_date,location,capacity,public_enabled,bookable,price_pence,concession_pence,start_time';
const EVENT_BASE = 'id,org_id,name,event_date,location,capacity,public_enabled';
async function orgFromToken(t) {
  if (!t || String(t).length < 16) return null;
  const s = await sb(`volunteer_sites?public_token=eq.${encodeURIComponent(t)}&select=org_id,public_enabled&limit=1`);
  if (!Array.isArray(s) || !s[0] || s[0].public_enabled === false) return null;
  const o = await sb(`organisations?id=eq.${s[0].org_id}&select=id,name,brand_color,logo_url,settings&limit=1`);
  return (o && o[0]) || null;
}
async function eventById(id) {
  const r = await sbTry(`events?id=eq.${encodeURIComponent(id)}&select=${EVENT_COLS}&limit=1`, `events?id=eq.${encodeURIComponent(id)}&select=${EVENT_BASE}&limit=1`);
  return (r && r[0]) || null;
}
async function taken(eventIds) {
  const out = {}; if (!eventIds.length) return out;
  const cutoff = Date.now() - PENDING_MINUTES * 60000;
  let rows = [];
  try { rows = await sb(`bookings?event_id=in.(${eventIds.map(encodeURIComponent).join(',')})&status=in.(booked,pending)&select=event_id,adults,children,status,created_at&limit=10000`) || []; } catch (e) { rows = []; }
  rows.forEach(b => { if (b.status === 'pending' && new Date(b.created_at).getTime() < cutoff) return; out[b.event_id] = (out[b.event_id] || 0) + (+b.adults || 0) + (+b.children || 0); });
  return out;
}
function publicEvent(ev, used, now) {
  const cap = +ev.capacity || 0, left = cap ? Math.max(0, cap - (used || 0)) : null;
  const closed = closesAt(ev) <= now.stamp;
  return { id: String(ev.id), name: ev.name, date: ev.event_date, time: ev.start_time || '', location: ev.location || '',
    price: +ev.price_pence || 0, concession: +ev.concession_pence || 0, left, status: closed ? 'closed' : (left === 0 ? 'full' : 'open') };
}
const payReady = org => !!(org && org.settings && org.settings.stripe_account && org.settings.stripe_ready);
async function staffUser(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json(); return u && u.id ? u : null;
}
async function canManage(user, orgId, managersOnly) {
  try { const s = await sb(`super_admins?user_id=eq.${user.id}&select=user_id&limit=1`); if (Array.isArray(s) && s.length) return true; } catch (e) { /* not a super admin */ }
  const m = await sb(`memberships?user_id=eq.${user.id}&org_id=eq.${orgId}&status=eq.active&select=role&limit=1`);
  if (!Array.isArray(m) || !m.length) return false;
  return managersOnly ? /^(owner|admin|manager)$/i.test(m[0].role || '') : true;
}
async function saveOrgSettings(orgId, patch) {
  const cur = (await sb(`organisations?id=eq.${orgId}&select=settings&limit=1`))[0] || {};
  const settings = Object.assign({}, cur.settings || {}, patch);
  await sb(`organisations?id=eq.${orgId}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ settings }) });
  return settings;
}
async function markArrived(b, ev) {   // the booking is counted, and an anonymous check-in is made for it
  const claim = newToken(), day = londonNow().day;
  await sb(`bookings?id=eq.${b.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ arrived_at: new Date().toISOString() }) });
  const row = { org_id: String(ev.org_id), event_id: String(ev.id), form_id: 'booking', people: (+b.adults || 0) + (+b.children || 0) || 1, answers: {}, day, claim_token: claim };
  try { await sb('checkins', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) }); }
  catch (e) { delete row.claim_token; await sb('checkins', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) }); }
  try {   // attendance never drops below what staff typed
    const rows = await sb(`checkins?event_id=eq.${encodeURIComponent(ev.id)}&select=people&limit=5000`);
    const total = (rows || []).reduce((a, r) => a + (+r.people || 1), 0);
    const e2 = await sb(`events?id=eq.${encodeURIComponent(ev.id)}&select=attendees&limit=1`);
    if (total > (+(e2 && e2[0] && e2[0].attendees) || 0)) await sb(`events?id=eq.${encodeURIComponent(ev.id)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ attendees: total }) });
  } catch (e) { /* the arrival is saved either way */ }
  return claim;
}
async function confirmPaid(b) {   // check with Stripe itself, so a payment can't be faked
  if (b.status === 'booked' && b.paid) return true;
  if (!b.stripe_session) return false;
  const org = (await sb(`organisations?id=eq.${b.org_id}&select=id,name,brand_color,settings&limit=1`))[0] || {};
  const s = await stripe('checkout/sessions/' + encodeURIComponent(b.stripe_session), null, org.settings && org.settings.stripe_account);
  if (s.payment_status !== 'paid') return false;
  await sb(`bookings?id=eq.${b.id}&status=neq.booked`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'booked', paid: true }) });
  const ev = await eventById(b.event_id);
  if (ev && b.status !== 'booked') { try { await mail.mailBooked(org, ev, Object.assign({}, b, { paid: true })); } catch (e) { /* the place is booked even if the email fails */ } }
  return true;
}

// ── the handler ──
async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') return bad(res, 'Method not allowed', 405);
  const q = req.query || {}, body = (req.body && typeof req.body === 'object') ? req.body : {};
  const action = String(body.action || q.action || '');
  if (action !== 'webhook' && rateLimited(req)) return bad(res, 'Too many requests. Please wait a moment and try again.', 429);
  try {
    // Stripe tells us a payment finished. We re-check it with Stripe before trusting it.
    if (action === 'webhook') {
      const obj = body && body.data && body.data.object;
      if (body.type === 'checkout.session.completed' && obj && obj.id) {
        const rows = await sb(`bookings?stripe_session=eq.${encodeURIComponent(obj.id)}&select=*&limit=1`);
        if (Array.isArray(rows) && rows[0]) await confirmPaid(rows[0]);
      }
      return res.status(200).json({ received: true });
    }

    // ── public ──
    if (action === 'list' || action === 'event') {
      const org = await orgFromToken(body.t || q.t); if (!org) return bad(res, 'This link has expired or is not right.', 404);
      const now = londonNow();
      let evs = await sbTry(`events?org_id=eq.${org.id}&event_date=gte.${now.day}&select=${EVENT_COLS}&order=event_date.asc&limit=60`, `events?org_id=eq.${org.id}&event_date=gte.${now.day}&select=${EVENT_BASE}&order=event_date.asc&limit=60`);
      evs = (evs || []).filter(e => e.public_enabled !== false && e.bookable !== false);
      if (action === 'event') evs = evs.filter(e => String(e.id) === String(body.id || q.id));
      const used = await taken(evs.map(e => String(e.id)));
      return res.status(200).json({ ok: true, org: { name: org.name, colour: org.brand_color || '', logo: org.logo_url || '' }, payments: payReady(org),
        events: evs.map(e => publicEvent(e, used[String(e.id)], now)) });
    }
    if (action === 'book') {
      if (body.hp) return res.status(200).json({ ok: true, status: 'booked' });              // a bot filled the hidden box
      const org = await orgFromToken(body.t); if (!org) return bad(res, 'This link has expired or is not right.', 404);
      const ev = await eventById(body.event_id);
      if (!ev || String(ev.org_id) !== String(org.id) || ev.public_enabled === false || ev.bookable === false) return bad(res, 'This event is not taking bookings.', 404);
      const now = londonNow(); if (closesAt(ev) <= now.stamp) return bad(res, 'Booking for this event has closed.');
      const adults = int(body.adults, 1, 20), children = int(body.children, 0, 20), conc = ev.concession_pence ? int(body.concessions, 0, adults) : 0;
      const name = trim(body.name, 120), email = trim(body.email, 254).toLowerCase(), phone = trim(body.phone, 30);
      if (!name) return bad(res, 'Please add your name.');
      if (!okEmail(email)) return bad(res, 'Please add an email address so we can send your confirmation.');
      const need = adults + children, used = (await taken([String(ev.id)]))[String(ev.id)] || 0, cap = +ev.capacity || 0;
      const full = cap && used + need > cap;
      const row = { org_id: String(org.id), event_id: String(ev.id), token: newToken(), name, email, phone: phone || null, adults, children, concessions: conc, optin: !!body.optin, method: 'online' };
      if (full) {
        if (!body.waitlist) return res.status(200).json({ ok: false, full: true, left: Math.max(0, cap - used), error: cap - used > 0 ? `Only ${cap - used} place${cap - used === 1 ? '' : 's'} left.` : 'This event is full.' });
        await sb('bookings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([Object.assign(row, { status: 'waitlist', amount_pence: 0 })]) });
        try { await mail.mailWaitlist(org, ev, row); } catch (e) { /* still on the list */ }
        return res.status(200).json({ ok: true, status: 'waitlist', token: row.token });
      }
      const amount = (adults - conc) * (+ev.price_pence || 0) + conc * (+ev.concession_pence || 0);
      if (!amount) {
        await sb('bookings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([Object.assign(row, { status: 'booked', amount_pence: 0 })]) });
        try { await mail.mailBooked(org, ev, row); } catch (e) { /* booked even if the email fails */ }
        return res.status(200).json({ ok: true, status: 'booked', token: row.token, first: name.split(' ')[0], people: need });
      }
      if (!payReady(org)) return bad(res, 'This organisation can\u2019t take payments online yet. Please contact them to book.');
      await sb('bookings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([Object.assign(row, { status: 'pending', amount_pence: amount })]) });
      const lines = [];
      if (adults - conc > 0) lines.push({ price_data: { currency: 'gbp', unit_amount: +ev.price_pence, product_data: { name: ev.name + (conc ? ' (standard)' : '') } }, quantity: adults - conc });
      if (conc > 0) lines.push({ price_data: { currency: 'gbp', unit_amount: +ev.concession_pence, product_data: { name: ev.name + ' (concession)' } }, quantity: conc });
      const session = await stripe('checkout/sessions', {
        mode: 'payment', customer_email: email, line_items: lines,
        success_url: `${APP_URL}/whats-on.html?t=${encodeURIComponent(body.t)}&paid=${row.token}&session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/whats-on.html?t=${encodeURIComponent(body.t)}&e=${encodeURIComponent(ev.id)}&unpaid=${row.token}`,
        expires_at: Math.floor(Date.now() / 1000) + PENDING_MINUTES * 60 + 60, metadata: { booking: row.token }
      }, org.settings.stripe_account);
      await sb(`bookings?token=eq.${row.token}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ stripe_session: session.id }) });
      return res.status(200).json({ ok: true, status: 'pending', url: session.url, token: row.token });
    }
    if (action === 'mine' || action === 'confirm' || action === 'cancel' || action === 'unpaid') {
      const tok = trim(body.token, 64); if (!tok) return bad(res, 'Missing booking.');
      const rows = await sb(`bookings?token=eq.${encodeURIComponent(tok)}&select=*&limit=1`);
      const b = Array.isArray(rows) && rows[0]; if (!b) return bad(res, 'We couldn\u2019t find that booking.', 404);
      const ev = await eventById(b.event_id);
      if (action === 'confirm' && b.status === 'pending') { await confirmPaid(b); }
      if (action === 'unpaid' && b.status === 'pending') {   // they left Stripe without paying: free the places
        await sb(`bookings?id=eq.${b.id}&status=eq.pending`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'cancelled' }) });
      }
      if (action === 'cancel' && b.status !== 'cancelled') {
        if (ev && closesAt(ev) <= londonNow().stamp && b.status === 'booked') return bad(res, 'This event has already started, so the booking can\u2019t be cancelled here.');
        await sb(`bookings?id=eq.${b.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'cancelled' }) });
        try { const org = (await sb(`organisations?id=eq.${b.org_id}&select=name,brand_color&limit=1`))[0] || {}; if (ev) await mail.mailCancelled(org, ev, b); } catch (e) { /* cancelled anyway */ }
      }
      const now = (await sb(`bookings?id=eq.${b.id}&select=status,paid,arrived_at&limit=1`))[0] || b;
      return res.status(200).json({ ok: true, booking: { status: now.status, paid: !!now.paid, first: String(b.name || '').split(' ')[0], adults: b.adults, children: b.children, amount: b.amount_pence, event: ev ? { id: String(ev.id), name: ev.name, date: ev.event_date, time: ev.start_time || '', location: ev.location || '' } : null,
        calendar: ev ? mail.calendarLink(ev) : '' } });
    }

    // ── staff ──
    const user = await staffUser(req);
    if (!user) return bad(res, 'Please sign in again.', 401);
    if (action === 'staff_counts') {
      const orgId = trim(body.org_id, 64); if (!(await canManage(user, orgId))) return bad(res, 'Not allowed.', 403);
      const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
      const evs = await sb(`events?org_id=eq.${orgId}&event_date=gte.${since}&select=id,event_date&limit=2000`) || [];
      const today = londonNow().day, ids = evs.map(e => String(e.id)), dates = {}; evs.forEach(e => { dates[String(e.id)] = e.event_date; });
      const out = {}; if (!ids.length) return res.status(200).json({ ok: true, counts: out });
      const rows = await sb(`bookings?event_id=in.(${ids.join(',')})&select=event_id,adults,children,status,paid,amount_pence,arrived_at&limit=20000`) || [];
      rows.forEach(b => {
        const k = b.event_id, c = out[k] = out[k] || { booked: 0, people: 0, money: 0, arrived: 0, waitlist: 0, noshow: 0 };
        const n = (+b.adults || 0) + (+b.children || 0);
        if (b.status === 'booked') { c.booked++; c.people += n; if (b.paid) c.money += +b.amount_pence || 0; if (b.arrived_at) c.arrived += n; else if (dates[k] < today) c.noshow += n; }
        if (b.status === 'waitlist') c.waitlist += n;
      });
      return res.status(200).json({ ok: true, counts: out });
    }
    if (/^staff_(list|add|arrive|cancel)$/.test(action)) {
      const ev = await eventById(body.event_id); if (!ev) return bad(res, 'Event not found.', 404);
      if (!(await canManage(user, ev.org_id))) return bad(res, 'Not allowed.', 403);
      if (action === 'staff_list') {
        const rows = await sb(`bookings?event_id=eq.${encodeURIComponent(ev.id)}&status=neq.pending&select=id,name,email,phone,adults,children,concessions,amount_pence,paid,method,status,arrived_at,created_at&order=created_at.asc&limit=2000`) || [];
        return res.status(200).json({ ok: true, event: publicEvent(ev, (await taken([String(ev.id)]))[String(ev.id)], londonNow()), bookings: rows });
      }
      if (action === 'staff_add') {
        const name = trim(body.name, 120); if (!name) return bad(res, 'Add their name.');
        const adults = int(body.adults, 1, 50), children = int(body.children, 0, 50), email = trim(body.email, 254).toLowerCase();
        if (email && !okEmail(email)) return bad(res, 'That email doesn\u2019t look right.');
        const row = { org_id: String(ev.org_id), event_id: String(ev.id), token: newToken(), name, email: email || null, phone: trim(body.phone, 30) || null, adults, children, concessions: 0,
          amount_pence: Math.max(0, Math.round((+body.amount || 0) * 100)), paid: !!body.paid, method: body.method === 'cash' ? 'cash' : 'staff', status: 'booked' };
        await sb('bookings', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) });
        if (email) { try { const org = (await sb(`organisations?id=eq.${ev.org_id}&select=name,brand_color&limit=1`))[0] || {}; await mail.mailBooked(org, ev, row); } catch (e) { /* booked anyway */ } }
        return res.status(200).json({ ok: true });
      }
      const rows = await sb(`bookings?id=eq.${int(body.id, 0, 1e12)}&event_id=eq.${encodeURIComponent(ev.id)}&select=*&limit=1`);
      const b = Array.isArray(rows) && rows[0]; if (!b) return bad(res, 'Booking not found.', 404);
      if (action === 'staff_arrive') { if (!b.arrived_at && b.status === 'booked') await markArrived(b, ev); return res.status(200).json({ ok: true }); }
      if (action === 'staff_cancel') { await sb(`bookings?id=eq.${b.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'cancelled' }) }); return res.status(200).json({ ok: true, refund: !!b.paid }); }
    }
    if (action === 'connect' || action === 'connect_status') {
      const orgId = trim(body.org_id, 64); if (!(await canManage(user, orgId, action === 'connect'))) return bad(res, 'Only a manager can set up payments.', 403);
      const org = (await sb(`organisations?id=eq.${orgId}&select=id,name,settings&limit=1`))[0]; if (!org) return bad(res, 'Organisation not found.', 404);
      let acct = org.settings && org.settings.stripe_account;
      if (action === 'connect_status') {
        if (!acct) return res.status(200).json({ ok: true, connected: false, ready: false });
        const a = await stripe('accounts/' + encodeURIComponent(acct));
        if (!!a.charges_enabled !== !!(org.settings || {}).stripe_ready) await saveOrgSettings(orgId, { stripe_ready: !!a.charges_enabled });
        return res.status(200).json({ ok: true, connected: true, ready: !!a.charges_enabled, details: !!a.details_submitted });
      }
      if (!acct) { const a = await stripe('accounts', { type: 'standard', country: 'GB', email: user.email || undefined, business_profile: { name: org.name } }); acct = a.id; await saveOrgSettings(orgId, { stripe_account: acct, stripe_ready: false }); }
      const link = await stripe('account_links', { account: acct, type: 'account_onboarding', refresh_url: `${APP_URL}/app.html?stripe=again`, return_url: `${APP_URL}/app.html?stripe=done` });
      return res.status(200).json({ ok: true, url: link.url });
    }
    return bad(res, 'Unknown action');
  } catch (e) {
    console.error('[bookings]', action, e && e.message);
    return bad(res, /Stripe/.test(e && e.message) ? e.message : 'Something went wrong. Please try again.', 500);
  }
}
module.exports = handler;
module.exports._test = { publicEvent, closesAt, flatten, londonNow };
