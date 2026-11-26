// /api/donations.js — bring donations in from JustGiving, Stripe and PayPal (Donations page, ai-office.js)
// Each organisation connects its own accounts with read-only details. The details are kept in donation_links,
// which only this server can read (no row-level policies), and are never sent back to the browser.
// A sync pulls new gifts since the last one and saves them in donations; the same gift is never saved twice
// (unique org_id + source + external_id). Synced when the Donations page opens, when the morning briefing runs, or "Sync now".
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Needs ai-office.sql.
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DAY = 864e5;
const FIRST_SYNC_DAYS = 365;          // the first sync goes back a year

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && b.message) || ''}`);
  return b;
}
const bad = (res, message, code) => res.status(code || 400).json({ ok: false, error: message });
const trim = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n || 200);
const iso = d => new Date(d).toISOString().slice(0, 10);

async function userFrom(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  const u = await r.json(); return u && u.id ? u : null;
}
// managers connect and remove accounts; any member can sync
async function canUse(user, orgId, managersOnly) {
  try { const s = await sb(`super_admins?user_id=eq.${user.id}&select=user_id&limit=1`); if (Array.isArray(s) && s.length) return true; } catch (e) { /* not a super admin */ }
  const o = await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&select=owner_id&limit=1`);
  if (o && o[0] && o[0].owner_id === user.id) return true;
  const m = await sb(`memberships?user_id=eq.${user.id}&org_id=eq.${encodeURIComponent(orgId)}&status=eq.active&select=role&limit=1`);
  if (!Array.isArray(m) || !m.length) return false;
  return managersOnly ? /^(owner|admin|manager)$/i.test(m[0].role || '') : true;
}

// ── each provider: check the details, then fetch gifts between two dates ──
const PROVIDERS = {
  justgiving: {
    name: 'JustGiving',
    fields: ['app_id', 'charity_id', 'email', 'password'],
    async fetch(cfg, from, to) {
      const out = [], auth = 'Basic ' + Buffer.from(cfg.email + ':' + cfg.password).toString('base64');
      for (let a = new Date(from); a < to; a = new Date(a.getTime() + 89 * DAY)) {        // at most 3 months per request
        const b = new Date(Math.min(a.getTime() + 88 * DAY, to.getTime()));
        const url = `https://dataapi.justgiving.com/${encodeURIComponent(cfg.app_id)}/v1/charity/${encodeURIComponent(cfg.charity_id)}/donations/${iso(a)};${iso(b)}`;
        const r = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json', 'x-api-key': cfg.app_id } });
        if (r.status === 401 || r.status === 403) throw new Error('JustGiving turned the details down. Check the app ID is on the Data API plan, and the charity login.');
        if (!r.ok) throw new Error('JustGiving: ' + r.status);
        const j = await r.json().catch(() => []);
        const rows = Array.isArray(j) ? j : (j && Object.values(j).find(Array.isArray)) || [];
        rows.forEach(d => {
          if (/refund|fail|cancel|declin/i.test(d.TransactionStatus || '')) return;
          const amt = +d.DonationAuthAmount || 0; if (!amt || !d.DonationRef) return;
          out.push({ external_id: String(d.DonationRef), donor_name: trim([d.DonorFirstName, d.DonorLastName].filter(Boolean).join(' '), 120) || 'Anonymous (JustGiving)',
            donor_email: trim(d.DonorEmail, 254) || null, amount: amt, gift_date: String(d.DonationDate || '').slice(0, 10) || iso(b),
            gift_aid: (+d.GiftAidAmount || 0) > 0, method: 'JustGiving' + (/month|recurr/i.test(d.PaymentFrequency || '') ? ' (monthly)' : ''),
            notes: trim([d.AppealName && 'Appeal: ' + d.AppealName, d.FundraiserFirstName && 'Raised by ' + [d.FundraiserFirstName, d.FundraiserLastName].filter(Boolean).join(' '), d.DonorMessage && 'Message: ' + d.DonorMessage].filter(Boolean).join(' · '), 500) || null });
        });
      }
      return out;
    }
  },
  stripe: {
    name: 'Stripe',
    fields: ['key'],
    async fetch(cfg, from, to) {
      const out = []; let after = null;
      for (let page = 0; page < 40; page++) {
        const qs = new URLSearchParams({ limit: '100', 'created[gte]': String(Math.floor(from.getTime() / 1000)), 'created[lte]': String(Math.floor(to.getTime() / 1000)) });
        if (after) qs.set('starting_after', after);
        const r = await fetch('https://api.stripe.com/v1/charges?' + qs, { headers: { Authorization: 'Bearer ' + cfg.key } });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401 || r.status === 403) throw new Error('Stripe turned the key down. Use a restricted key with Charges set to Read.');
        if (!r.ok) throw new Error('Stripe: ' + ((j.error && j.error.message) || r.status));
        (j.data || []).forEach(c => {
          if (c.status !== 'succeeded' || !c.paid) return;
          const amt = ((c.amount || 0) - (c.amount_refunded || 0)) / 100; if (amt <= 0) return;
          const md = c.metadata || {}, bd = c.billing_details || {};
          if (md.vorlana_booking) return;                                                         // event bookings are not donations
          out.push({ external_id: c.id, donor_name: trim(bd.name || md.donor_name || md.name || (c.customer_details && c.customer_details.name), 120) || 'Card donor (Stripe)',
            donor_email: trim(bd.email || c.receipt_email || md.email, 254) || null, amount: amt, gift_date: iso(c.created * 1000),
            gift_aid: /^(true|yes|1|y)$/i.test(String(md.gift_aid || md.giftaid || '')), fund: trim(md.fund || md.restricted_fund, 120) || null,
            method: 'Stripe' + ((c.currency || 'gbp') !== 'gbp' ? ' (' + String(c.currency).toUpperCase() + ')' : ''), notes: trim(c.description, 300) || null });
        });
        if (!j.has_more || !(j.data || []).length) break;
        after = j.data[j.data.length - 1].id;
      }
      return out;
    }
  },
  paypal: {
    name: 'PayPal',
    fields: ['client_id', 'secret'],
    async fetch(cfg, from, to) {
      const host = cfg.sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
      const t = await fetch(host + '/v1/oauth2/token', { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(cfg.client_id + ':' + cfg.secret).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' });
      const tj = await t.json().catch(() => ({}));
      if (!t.ok || !tj.access_token) throw new Error('PayPal turned the details down. Check the client ID and secret (live, not sandbox).');
      const out = [];
      for (let a = new Date(from); a < to; a = new Date(a.getTime() + 31 * DAY)) {          // at most 31 days per request
        const b = new Date(Math.min(a.getTime() + 31 * DAY - 1000, to.getTime()));
        for (let page = 1; page <= 20; page++) {
          const qs = new URLSearchParams({ start_date: a.toISOString().replace(/\.\d{3}Z$/, 'Z'), end_date: b.toISOString().replace(/\.\d{3}Z$/, 'Z'), fields: 'transaction_info,payer_info', transaction_status: 'S', page_size: '500', page: String(page) });
          const r = await fetch(host + '/v1/reporting/transactions?' + qs, { headers: { Authorization: 'Bearer ' + tj.access_token } });
          const j = await r.json().catch(() => ({}));
          if (r.status === 403) throw new Error('PayPal: switch on Transaction Search for this app in the PayPal developer dashboard.');
          if (!r.ok) throw new Error('PayPal: ' + ((j && (j.message || j.name)) || r.status));
          (j.transaction_details || []).forEach(d => {
            const ti = d.transaction_info || {}, pi = d.payer_info || {}, amt = +((ti.transaction_amount || {}).value || 0);
            if (amt <= 0 || !/^T00/.test(ti.transaction_event_code || '')) return;                // money in only
            const nm = pi.payer_name || {};
            out.push({ external_id: ti.transaction_id, donor_name: trim(nm.alternate_full_name || [nm.given_name, nm.surname].filter(Boolean).join(' '), 120) || 'PayPal donor',
              donor_email: trim(pi.email_address, 254) || null, amount: amt, gift_date: String(ti.transaction_initiation_date || '').slice(0, 10) || iso(b), gift_aid: false,
              method: 'PayPal' + ((ti.transaction_amount || {}).currency_code && ti.transaction_amount.currency_code !== 'GBP' ? ' (' + ti.transaction_amount.currency_code + ')' : ''),
              notes: trim(ti.transaction_note || ti.transaction_subject, 300) || null });
          });
          if (!j.total_pages || page >= j.total_pages) break;
        }
      }
      return out;
    }
  }
};

async function links(orgId) {
  return (await sb(`donation_links?org_id=eq.${encodeURIComponent(orgId)}&select=provider,config,last_sync_at,last_error,last_count,created_at`)) || [];
}
const publicLink = l => ({ provider: l.provider, name: (PROVIDERS[l.provider] || {}).name || l.provider, last_sync_at: l.last_sync_at, last_error: l.last_error || null, last_count: l.last_count || 0,
  hint: l.provider === 'justgiving' ? 'Charity ' + ((l.config || {}).charity_id || '') : l.provider === 'stripe' ? 'Key ending ' + String((l.config || {}).key || '').slice(-4) : 'Client ' + String((l.config || {}).client_id || '').slice(0, 6) + '…' });

async function syncOne(orgId, l, full) {
  const P = PROVIDERS[l.provider]; if (!P) return { provider: l.provider, added: 0 };
  const to = new Date(), from = new Date(full || !l.last_sync_at ? to.getTime() - FIRST_SYNC_DAYS * DAY : new Date(l.last_sync_at).getTime() - 3 * DAY);   // 3 days' overlap: late-settling gifts
  try {
    const gifts = await P.fetch(l.config || {}, from, to);
    let added = 0;
    for (let i = 0; i < gifts.length; i += 200) {
      const rows = gifts.slice(i, i + 200).map(g => Object.assign({ org_id: orgId, source: l.provider, restricted: !!g.fund, fund: g.fund || null }, g));
      const saved = await sb('donations?on_conflict=org_id,source,external_id', { method: 'POST', headers: { Prefer: 'resolution=ignore-duplicates,return=representation' }, body: JSON.stringify(rows) });
      added += Array.isArray(saved) ? saved.length : 0;
    }
    await sb(`donation_links?org_id=eq.${encodeURIComponent(orgId)}&provider=eq.${l.provider}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_sync_at: to.toISOString(), last_error: null, last_count: added }) });
    return { provider: l.provider, added };
  } catch (e) {
    await sb(`donation_links?org_id=eq.${encodeURIComponent(orgId)}&provider=eq.${l.provider}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ last_error: trim(e.message, 300) }) }).catch(() => {});
    return { provider: l.provider, added: 0, error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
  if (!SUPABASE_URL || !KEY) return bad(res, 'The server is not set up (Supabase keys missing).', 500);
  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const action = String(body.action || ''), orgId = String(body.org_id || '');
  try {
    const user = await userFrom(req); if (!user) return bad(res, 'Please sign in again.', 401);
    if (!orgId) return bad(res, 'No organisation.');
    const manage = action === 'connect' || action === 'disconnect';
    if (!(await canUse(user, orgId, manage))) return bad(res, manage ? 'Only a manager can connect or remove accounts.' : 'Not allowed.', 403);

    let L;
    try { L = await links(orgId); } catch (e) { return bad(res, 'Run ai-office.sql in Supabase first.', 409); }

    if (action === 'status') return res.status(200).json({ ok: true, links: L.map(publicLink) });

    if (action === 'connect') {
      const prov = String(body.provider || ''), P = PROVIDERS[prov]; if (!P) return bad(res, 'Unknown provider.');
      const cfg = {}; P.fields.forEach(f => { cfg[f] = trim(body.config && body.config[f], 300); });
      const missing = P.fields.filter(f => !cfg[f]); if (missing.length) return bad(res, 'Please fill in: ' + missing.join(', ').replace(/_/g, ' ') + '.');
      if (prov === 'stripe' && !/^(rk|sk)_(live|test)_/.test(cfg.key)) return bad(res, 'That doesn’t look like a Stripe key. It starts rk_live_ (restricted, best) or sk_live_.');
      if (prov === 'paypal') cfg.sandbox = !!(body.config && body.config.sandbox);
      // check the details work before saving them (last 7 days)
      try { await P.fetch(cfg, new Date(Date.now() - 7 * DAY), new Date()); } catch (e) { return bad(res, e.message); }
      await sb('donation_links?on_conflict=org_id,provider', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ org_id: orgId, provider: prov, config: cfg, created_by: user.id, last_sync_at: null, last_error: null }]) });
      const fresh = (await links(orgId)).find(x => x.provider === prov);
      const r = await syncOne(orgId, fresh, true);
      return res.status(200).json({ ok: true, added: r.added, error: r.error || null, links: (await links(orgId)).map(publicLink) });
    }

    if (action === 'disconnect') {
      await sb(`donation_links?org_id=eq.${encodeURIComponent(orgId)}&provider=eq.${encodeURIComponent(String(body.provider || ''))}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
      return res.status(200).json({ ok: true, links: (await links(orgId)).map(publicLink) });
    }

    if (action === 'sync') {
      // automatic syncs skip anything synced in the last hour; "Sync now" always runs
      const due = L.filter(l => body.force || !l.last_sync_at || Date.now() - new Date(l.last_sync_at).getTime() > 3600e3);
      const results = [];
      for (const l of due) results.push(await syncOne(orgId, l, false));
      return res.status(200).json({ ok: true, results, added: results.reduce((a, r) => a + r.added, 0), links: (await links(orgId)).map(publicLink) });
    }

    return bad(res, 'Unknown action.');
  } catch (e) {
    console.error('[donations]', e);
    return bad(res, 'Something went wrong: ' + e.message, 500);
  }
};
