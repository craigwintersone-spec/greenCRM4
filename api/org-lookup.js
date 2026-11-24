// /api/org-lookup.js — "Is this you?": find the organisation on the public registers and keep its facts for bids.
// POST { action: 'search', org_id, name?, number? } → { ok, matches: [{ id, name, summary }] }   (any member)
// POST { action: 'save', org_id, id }                → { ok, facts }   (owner, admin or manager) — fills settings.bid_facts
// POST { action: 'none', org_id }                     → { ok }          (owner, admin or manager) — "none of these", stop asking
// Facts the organisation typed in itself are never overwritten; register facts fill the blanks.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const lookup = require('./_lib/org-lookup');

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}`);
  return b;
}
async function user(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }).catch(() => null);
  if (!r || !r.ok) return null;
  const u = await r.json(); return u && u.id ? u : null;
}
async function roleIn(u, orgId) {
  try { const s = await sb(`super_admins?user_id=eq.${u.id}&select=user_id&limit=1`); if (Array.isArray(s) && s.length) return 'super'; } catch (e) { /* not a super admin */ }
  const m = await sb(`memberships?user_id=eq.${u.id}&org_id=eq.${encodeURIComponent(orgId)}&status=eq.active&select=role&limit=1`);
  if (Array.isArray(m) && m[0]) return m[0].role;
  const o = await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&owner_id=eq.${u.id}&select=id&limit=1`);
  return Array.isArray(o) && o.length ? 'owner' : null;
}
const manager = r => r === 'super' || /^(owner|admin|manager)$/i.test(r || '');

async function saveFacts(orgId, d) {
  const org = ((await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&select=settings&limit=1`)) || [])[0];
  const st = (org && org.settings) || {};
  const mine = st.bid_facts || {};
  const merged = Object.assign({}, d ? d.facts : {}, mine);        // what they typed wins; the register fills the gaps
  st.bid_facts = merged;
  st.register = d ? { id: d.id, name: d.name, checked_at: new Date().toISOString() } : { none: true, checked_at: new Date().toISOString() };
  await sb(`organisations?id=eq.${encodeURIComponent(orgId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ settings: st }) });
  return merged;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'Use POST.' }); }
  try {
    const u = await user(req);
    if (!u) return res.status(401).json({ ok: false, error: 'Please sign in again.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const orgId = String(body.org_id || '').slice(0, 64);
    const role = orgId ? await roleIn(u, orgId) : null;
    if (!role) return res.status(403).json({ ok: false, error: 'Not allowed.' });

    if (body.action === 'search') {
      let ids = [];
      const byNumber = lookup.idFromNumber(body.number);
      if (byNumber) ids = [byNumber];
      else {
        let name = String(body.name || '').trim();
        if (!name) { const o = ((await sb(`organisations?id=eq.${encodeURIComponent(orgId)}&select=name&limit=1`)) || [])[0]; name = (o && o.name) || ''; }
        ids = (await lookup.candidates(name)).slice(0, 3).map(c => c.id);
      }
      const matches = (await Promise.all(ids.map(id => lookup.details(id)))).filter(Boolean).map(d => ({ id: d.id, name: d.name, summary: d.summary, active: d.active }));
      return res.status(200).json({ ok: true, matches });
    }
    if (body.action === 'save') {
      if (!manager(role)) return res.status(403).json({ ok: false, error: 'Only an owner or manager can do this.' });
      const d = await lookup.details(String(body.id || '').slice(0, 40));
      if (!d) return res.status(404).json({ ok: false, error: 'We couldn\'t read that record just now. Please try again.' });
      return res.status(200).json({ ok: true, facts: await saveFacts(orgId, d), name: d.name });
    }
    if (body.action === 'none') {
      if (!manager(role)) return res.status(403).json({ ok: false, error: 'Only an owner or manager can do this.' });
      await saveFacts(orgId, null);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    console.error('[org-lookup]', e);
    return res.status(500).json({ ok: false, error: 'Something went wrong.' });
  }
};
