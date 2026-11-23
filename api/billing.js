// /api/billing.js — self-serve sign-up and Vorlana's own subscriptions (paid to Winters Ventures' Stripe account)
// signup   (public)   → creates the login, the organisation (14-day free trial, no card, owner_id = them), an admin membership and profile
// checkout (manager)  → Stripe Checkout for Starter, Community or Standard, monthly or yearly
// confirm  (member)   → after Stripe sends them back: checks the payment with Stripe, then switches the plan on
// portal   (manager)  → Stripe's billing page: change card, see invoices, cancel
// webhook  (Stripe)   → subscription changes and cancellations; every event is re-checked with Stripe before it is trusted
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, STRIPE_SECRET_KEY, APP_URL
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');
const TRIAL_DAYS = 14;

// What can be bought online. Provider and Partnership stay "talk to us".
const PLANS = {
  group:   { name: 'Starter',   month: 2900,  year: 29000 },
  starter: { name: 'Community', month: 7900,  year: 79000 },
  pro:     { name: 'Standard',  month: 14900, year: 149000 }
};
const ALL_MODULES = ['participants', 'volunteers', 'events', 'impact', 'contacts', 'employers', 'funders', 'evidence', 'demographics', 'social', 'bd', 'circular'];
const RATE = { windowMs: 60 * 60 * 1000, max: 5, hits: new Map() };   // sign-ups per address per hour

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && (b.message || b.msg)) || ''}`);
  return b;
}
async function authAdmin(path, method, body) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/${path}`, { method, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  return { ok: r.ok, status: r.status, body: b };
}
function flatten(obj, prefix, out) {
  out = out || {};
  Object.keys(obj).forEach(k => {
    const v = obj[k], key = prefix ? `${prefix}[${k}]` : k;
    if (v == null) return;
    if (typeof v === 'object') flatten(v, key, out); else out[key] = String(v);
  });
  return out;
}
async function stripe(path, params, method) {
  if (!STRIPE_KEY) throw new Error('Payments are not set up yet (STRIPE_SECRET_KEY is missing).');
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    method: method || (params ? 'POST' : 'GET'),
    headers: { Authorization: 'Bearer ' + STRIPE_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? new URLSearchParams(flatten(params)).toString() : undefined
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Stripe: ' + ((j.error && j.error.message) || r.status));
  return j;
}
const bad = (res, message, code) => res.status(code || 400).json({ ok: false, error: message });
const trim = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n || 200);
const okEmail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown', now = Date.now();
  const h = (RATE.hits.get(ip) || []).filter(t => now - t < RATE.windowMs); h.push(now); RATE.hits.set(ip, h);
  return h.length > RATE.max;
}
async function staffUser(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json(); return u && u.id ? u : null;
}
async function roleIn(user, orgId) {   // 'super' | the membership role | null
  try { const s = await sb(`super_admins?user_id=eq.${user.id}&select=user_id&limit=1`); if (Array.isArray(s) && s.length) return 'super'; } catch (e) { /* not a super admin */ }
  const m = await sb(`memberships?user_id=eq.${user.id}&org_id=eq.${encodeURIComponent(orgId)}&status=eq.active&select=role&limit=1`);
  return (Array.isArray(m) && m[0] && m[0].role) || null;
}
const isManager = role => role === 'super' || /^(owner|admin|manager)$/i.test(role || '');
async function getOrg(orgId) { return (await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&select=id,name,plan,status,settings&limit=1`))[0] || null; }
async function saveOrg(orgId, fields, settingsPatch) {
  const body = Object.assign({}, fields || {});
  if (settingsPatch) { const cur = (await getOrg(orgId)) || {}; body.settings = Object.assign({}, cur.settings || {}, settingsPatch); }
  await sb(`organisations?id=eq.${encodeURIComponent(orgId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body) });
}

// A subscription Stripe says is live switches the plan on; an ended one returns the organisation to the free plan
async function applySubscription(sub) {
  const md = (sub && sub.metadata) || {}, orgId = md.org_id, plan = md.plan;
  if (!orgId || !PLANS[plan]) return { applied: false };
  const live = /^(active|trialing|past_due)$/.test(sub.status);
  const item = sub.items && sub.items.data && sub.items.data[0], interval = item && item.price && item.price.recurring && item.price.recurring.interval;
  if (live) {
    await saveOrg(orgId, { plan, status: 'active' }, { stripe_customer: sub.customer, stripe_subscription: sub.id, billing_interval: interval || null, billing_status: sub.status, cancel_at_period_end: !!sub.cancel_at_period_end, subscription_ended_at: null });
    return { applied: true, plan };
  }
  if (/^(canceled|unpaid|incomplete_expired)$/.test(sub.status)) {
    const cur = await getOrg(orgId);
    if (cur && cur.settings && cur.settings.stripe_subscription && cur.settings.stripe_subscription !== sub.id) return { applied: false };   // an older subscription ending
    await saveOrg(orgId, { plan: 'free' }, { billing_status: sub.status, subscription_ended_at: new Date().toISOString(), trial_ends: new Date().toISOString() });
    return { applied: true, plan: 'free' };
  }
  return { applied: false };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
  const q = req.query || {}, body = (req.body && typeof req.body === 'object') ? req.body : {};
  const action = String(body.action || q.action || '');
  try {
    // ── Stripe tells us something changed: re-check with Stripe, then apply ──
    if (action === 'webhook') {
      const obj = body && body.data && body.data.object;
      if (obj && /^customer\.subscription\./.test(body.type || '') && obj.id) await applySubscription(await stripe('subscriptions/' + encodeURIComponent(obj.id)));
      if (obj && body.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.subscription) await applySubscription(await stripe('subscriptions/' + encodeURIComponent(obj.subscription)));
      return res.status(200).json({ received: true });
    }

    // ── self-serve sign-up: 14-day free trial, no card ──
    if (action === 'signup') {
      if (body.hp) return res.status(200).json({ ok: true });   // a bot filled the hidden box
      if (rateLimited(req)) return bad(res, 'Too many sign-ups from here. Please try again later.', 429);
      const orgName = trim(body.org_name, 120), name = trim(body.name, 120), email = trim(body.email, 254).toLowerCase(), password = String(body.password || '');
      const sector = trim(body.sector, 60) || 'Charity / VCSE';
      if (!orgName) return bad(res, 'Please add your organisation’s name.');
      if (!name) return bad(res, 'Please add your name.');
      if (!okEmail(email)) return bad(res, 'Please add a valid email address.');
      if (password.length < 8) return bad(res, 'Your password needs at least 8 characters.');
      const u = await authAdmin('users', 'POST', { email, password, email_confirm: true, user_metadata: { full_name: name } });
      if (!u.ok) {
        const m = JSON.stringify(u.body || '').toLowerCase(), code = String((u.body && (u.body.error_code || u.body.code)) || '').toLowerCase();
        if (/email_exists|user_already_exists/.test(code) || /already (been )?registered|already exists/.test(m)) return bad(res, 'There’s already an account with that email. Sign in instead, or use a different email.', 409);
        if (/weak_password/.test(code) || /pwned|weak|password should/.test(m)) return bad(res, /pwned/.test(m) ? 'That password has appeared in a data breach elsewhere, so it isn’t safe. Please choose a different one.' : 'Please choose a stronger password: at least 8 characters, mixing letters and numbers.');
        if (/email_address_invalid|validation_failed/.test(code) || /invalid.*email|email.*invalid/.test(m)) return bad(res, 'That email address wasn’t accepted. Please check it, or try another.');
        if (u.status === 422) return bad(res, 'We couldn’t create your login: ' + String((u.body && (u.body.msg || u.body.message)) || 'please check your details').slice(0, 160));
        throw new Error('auth ' + u.status + ': ' + m.slice(0, 160));
      }
      const userId = u.body.id || (u.body.user && u.body.user.id);
      let org = null;
      try {
        const modules = {}; ALL_MODULES.forEach(k => { modules[k] = true; });
        const trialEnds = new Date(Date.now() + TRIAL_DAYS * 864e5).toISOString();
        org = (await sb('organisations', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify([{ name: orgName, sector, plan: 'free', status: 'trial', owner_id: userId, modules, settings: { self_serve: true, trial_ends: trialEnds, signed_up_by: email } }]) }))[0];
        await sb('memberships', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ user_id: userId, org_id: org.id, role: 'admin', status: 'active' }]) });
        try { await sb('profiles?on_conflict=id', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ id: userId, full_name: name, email, org_id: org.id, role: 'admin' }]) }); }
        catch (e) { /* the profile is optional: the membership is what gives access */ }
      } catch (e) {   // undo, so they can simply try again
        if (org && org.id) { try { await sb(`organisations?id=eq.${org.id}`, { method: 'DELETE' }); } catch (x) { /* best effort */ } }
        try { await authAdmin('users/' + userId, 'DELETE'); } catch (x) { /* best effort */ }
        throw e;
      }
      return res.status(200).json({ ok: true, org_id: org.id });
    }

    // ── everything else needs a signed-in member of the organisation ──
    const user = await staffUser(req);
    if (!user) return bad(res, 'Please sign in again.', 401);
    const orgId = trim(body.org_id, 64);
    const role = await roleIn(user, orgId);
    if (!role) return bad(res, 'Not allowed.', 403);

    if (action === 'checkout') {
      if (!isManager(role)) return bad(res, 'Only an owner or manager can choose the plan. Ask them to do this.', 403);
      const plan = String(body.plan || ''), interval = body.interval === 'year' ? 'year' : 'month';
      if (!PLANS[plan]) return bad(res, 'For the Provider plan, please get in touch and we’ll set it up.');
      const org = await getOrg(orgId); if (!org) return bad(res, 'Organisation not found.', 404);
      const st = org.settings || {};
      if (st.stripe_subscription && /^(active|trialing|past_due)$/.test(st.billing_status || '')) return bad(res, 'You already have a subscription. Use Manage billing to change it, or get in touch to switch plans.');
      const p = PLANS[plan], md = { org_id: org.id, plan };
      const session = await stripe('checkout/sessions', Object.assign({
        mode: 'subscription',
        line_items: [{ quantity: 1, price_data: { currency: 'gbp', unit_amount: p[interval], recurring: { interval }, product_data: { name: `Vorlana ${p.name} plan` } } }],
        client_reference_id: org.id, metadata: md, subscription_data: { metadata: md, description: `${org.name}: Vorlana ${p.name}` },
        allow_promotion_codes: true, billing_address_collection: 'auto',
        success_url: `${APP_URL}/app.html?org_id=${encodeURIComponent(org.id)}&billing=done&session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${APP_URL}/app.html?org_id=${encodeURIComponent(org.id)}&billing=cancel`
      }, st.stripe_customer ? { customer: st.stripe_customer } : { customer_email: user.email || undefined }));
      return res.status(200).json({ ok: true, url: session.url });
    }
    if (action === 'confirm') {
      const sid = trim(body.session, 200); if (!/^cs_/.test(sid)) return bad(res, 'Missing payment reference.');
      const s = await stripe('checkout/sessions/' + encodeURIComponent(sid));
      if (!s.metadata || s.metadata.org_id !== orgId) return bad(res, 'That payment is for a different organisation.', 403);
      if (s.status !== 'complete' || !s.subscription) return res.status(200).json({ ok: true, done: false });
      const out = await applySubscription(await stripe('subscriptions/' + encodeURIComponent(s.subscription)));
      return res.status(200).json({ ok: true, done: !!out.applied, plan: out.plan, plan_name: PLANS[out.plan] ? PLANS[out.plan].name : '' });
    }
    if (action === 'portal') {
      if (!isManager(role)) return bad(res, 'Only an owner or manager can manage billing.', 403);
      const org = await getOrg(orgId), cust = org && org.settings && org.settings.stripe_customer;
      if (!cust) return bad(res, 'There’s no subscription to manage yet. Choose a plan first.');
      const p = await stripe('billing_portal/sessions', { customer: cust, return_url: `${APP_URL}/app.html?org_id=${encodeURIComponent(orgId)}` });
      return res.status(200).json({ ok: true, url: p.url });
    }
    return bad(res, 'Unknown action');
  } catch (e) {
    const m = (e && e.message) || '';
    console.error('[billing]', action, m);
    if (/STRIPE_SECRET_KEY/.test(m)) return bad(res, 'Payments aren’t switched on yet. Please try again later.', 500);
    if (/^Stripe:/.test(m)) return bad(res, m, 502);
    return bad(res, 'Something went wrong. Please try again.', 500);
  }
}
module.exports = handler;
module.exports._test = { PLANS, applySubscription };
