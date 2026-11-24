// /api/funder-giving.js — who a funder has actually given to, from 360Giving open grants data.
// POST { funders: ["Garfield Weston Foundation", ...], area: "Peterborough and Cambridgeshire", postcodes: ["PE1"], keywords: ["repair", "wellbeing"] }
//   → { ok, funders: [{ name, orgId, grants, recent, typical: { low, median, high }, lastAward, local, similar, localExamples: [...], similarExamples: [...], source }] }
// For each funder: find its organisation ID (Find That Charity, then 360Giving's own list as a fallback),
// read its most recent grants (up to 1,000), and work out its typical grant, how many went to groups in the area,
// how many were for similar work, and a few examples. Results are cached for a week (table funder_giving).
// Data: 360Giving (CC BY 4.0) — credit 360Giving and the original publishers; each result links to GrantNav.
// Signed-in users only. 360Giving allows 2 requests a second, so calls are spaced.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const API = 'https://api.threesixtygiving.org/api/v1';
const UA = 'Vorlana/1.0 (+https://www.vorlana.com; hello@vorlana.com)';
const WEEK = 7 * 864e5;

let lastCall = 0;
async function slow(url, opts) {                       // keep to 360Giving's 2 requests a second
  const wait = Math.max(0, lastCall + 550 - Date.now()); lastCall = Date.now() + wait;
  if (wait) await new Promise(r => setTimeout(r, wait));
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 15000);
  try {
    let r = await fetch(url, Object.assign({ signal: c.signal, headers: { Accept: 'application/json', 'User-Agent': UA } }, opts || {}));
    if (r.status === 429) { await new Promise(x => setTimeout(x, 1200)); r = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': UA } }); }
    return r;
  } finally { clearTimeout(t); }
}
async function json(url) { try { const r = await slow(url); return r.ok ? await r.json() : null; } catch (e) { return null; } }

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}`);
  return b;
}
async function authed(req) {
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok || !SUPABASE_URL) return false;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${tok}` } }).catch(() => null);
  return !!(r && r.ok);
}

const norm = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\b(the|ltd|limited|uk|cio|trust|foundation|fund|charitable|charity|community|national|lottery)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
const simple = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

// 1. The funder's organisation ID
async function findOrgId(name) {
  const q = encodeURIComponent(JSON.stringify({ q0: { query: name, limit: 5 } }));
  for (const base of ['https://findthatcharity.uk/reconcile', 'https://findthatcharity.uk/api/v1/reconcile']) {
    const r = await json(`${base}?queries=${q}`);
    const res = r && r.q0 && Array.isArray(r.q0.result) ? r.q0.result : [];
    const best = res.find(x => x.match) || res.find(x => simple(x.name) === simple(name)) || res.find(x => (x.score || 0) >= 80);
    if (best && best.id) return { orgId: String(best.id), name: best.name || name };
  }
  return null;
}

function money(n) { return Math.round(+n || 0); }
function pct(arr, p) { if (!arr.length) return 0; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * (a.length - 1) + 0.5))]; }
function where(g) {                          // every place a grant mentions: recipient address, location codes, districts, beneficiary areas
  const d = g.data || g, ad = d.additional_data || g.additional_data || {};
  const bits = [];
  (d.recipientOrganization || []).forEach(o => { bits.push(o.postalCode, o.addressLocality, o.addressRegion); (o.location || []).forEach(l => bits.push(l.name)); });
  (d.beneficiaryLocation || []).forEach(l => bits.push(l.name));
  ['recipientDistrictName', 'recipientRegionName', 'recipientWardName', 'recipientCountyName', 'beneficiaryLocationName'].forEach(k => bits.push(ad[k]));
  (ad.locationLookup || []).forEach(l => bits.push(l.areaname, l.ladname, l.utlaname, l.rgnnm || l.rgnname, l.ctyname));
  return bits.filter(Boolean).join(' | ');
}
function brief(g) {
  const d = g.data || g, r = (d.recipientOrganization || [])[0] || {};
  return { recipient: r.name || '', title: String(d.title || '').slice(0, 140), amount: money(d.amountAwarded), date: String(d.awardDate || '').slice(0, 10) };
}

// 2. Its recent grants, and what they say about it
async function giving(f, area, postcodes, keywords) {
  const id = encodeURIComponent(f.orgId);
  const head = await json(`${API}/org/${id}/grants_made/?limit=1`);
  if (!head || typeof head.count !== 'number') return null;
  const total = head.count, take = Math.min(1000, total);
  const page = take ? await json(`${API}/org/${id}/grants_made/?limit=${take}&offset=${Math.max(0, total - take)}`) : { results: [] };
  const grants = (page && page.results) || [];
  const amounts = grants.map(g => +((g.data || g).amountAwarded) || 0).filter(n => n > 0);
  const areaWords = String(area || '').split(/,|\band\b|&|\//i).map(s => s.trim()).filter(s => s.length > 3);
  const areaRe = areaWords.length ? new RegExp('\\b(' + areaWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'i') : null;
  const pcRe = (postcodes || []).length ? new RegExp('\\b(' + postcodes.map(p => String(p).toUpperCase().replace(/[^A-Z0-9]/g, '')).filter(Boolean).join('|') + ')\\d?', 'i') : null;
  const kw = (keywords || []).map(k => String(k).toLowerCase().trim()).filter(k => k.length > 3).slice(0, 20);
  const isLocal = g => { const w = where(g); return (areaRe && areaRe.test(w)) || (pcRe && pcRe.test(w)); };
  const isSimilar = g => { const d = g.data || g, t = (String(d.title || '') + ' ' + String(d.description || '')).toLowerCase(); return kw.some(k => t.includes(k)); };
  const local = grants.filter(isLocal), similar = grants.filter(isSimilar), both = local.filter(isSimilar);
  const dates = grants.map(g => String((g.data || g).awardDate || '')).filter(Boolean).sort();
  return {
    name: f.name, orgId: f.orgId, grants: total, recent: grants.length,
    typical: amounts.length ? { low: money(pct(amounts, 0.25)), median: money(pct(amounts, 0.5)), high: money(pct(amounts, 0.75)) } : null,
    lastAward: dates.length ? dates[dates.length - 1].slice(0, 10) : '', firstInSample: dates.length ? dates[0].slice(0, 10) : '',
    local: local.length, similar: similar.length, localSimilar: both.length,
    localExamples: (both.length ? both : local).slice(-3).reverse().map(brief),
    similarExamples: similar.slice(-3).reverse().map(brief),
    source: 'https://grantnav.threesixtygiving.org/org/' + f.orgId
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'Use POST.' }); }
  try {
    if (!(await authed(req))) return res.status(401).json({ ok: false, error: 'Please sign in again.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const names = (Array.isArray(body.funders) ? body.funders : []).map(s => String(s || '').trim()).filter(Boolean).slice(0, 10);
    const area = String(body.area || '').slice(0, 120), postcodes = (body.postcodes || []).slice(0, 6), keywords = (body.keywords || []).slice(0, 20);
    const out = [];
    for (const name of names) {
      const key = norm(name).slice(0, 120) || simple(name);
      let f = null, cached = null;
      try { cached = ((await sb(`funder_giving?key=eq.${encodeURIComponent(key)}&select=org_id,name,grants,updated_at&limit=1`)) || [])[0]; } catch (e) { cached = undefined; }   // undefined: no cache table
      if (cached && cached.org_id) f = { orgId: cached.org_id, name: cached.name || name };
      if (!f) f = await findOrgId(name);
      if (!f) { out.push({ name, found: false }); continue; }
      let g = null;
      if (cached && cached.grants && Date.now() - new Date(cached.updated_at).getTime() < WEEK && cached.grants.area === area) g = cached.grants;
      if (!g) {
        g = await giving(f, area, postcodes, keywords);
        if (g && cached !== undefined) {
          g.area = area;
          try { await sb('funder_giving?on_conflict=key', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify([{ key, org_id: f.orgId, name: f.name, grants: g, updated_at: new Date().toISOString() }]) }); } catch (e) { /* cache is optional */ }
        }
      }
      out.push(g ? Object.assign({ found: true, asked: name }, g) : { name, orgId: f.orgId, found: false });
    }
    return res.status(200).json({ ok: true, funders: out, credit: 'Grant data from 360Giving and its publishers (CC BY 4.0)' });
  } catch (e) {
    console.error('[funder-giving]', e);
    return res.status(500).json({ ok: false, error: 'Could not read funder data just now.' });
  }
};
module.exports._test = { findOrgId, giving, where, norm };
