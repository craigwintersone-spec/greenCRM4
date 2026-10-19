// /api/event-checkin.js
// Public endpoint behind event.html — the QR target.
//
// A token belongs EITHER to an event (events.public_token) OR to a site
// (volunteer_sites.public_token — "the garden", "the shop"): a permanent
// QR for volunteers who come in to help on a normal day, not an event.
//
// Actions:
//   info      → name / date / location / org name, mode ('event' | 'site'),
//               and for events the org's own feedback questions
//   feedback  → anonymous attendee feedback (events only)
//   checkin   → volunteer arrives (name OR email; first-timers can sign up)
//   checkout  → volunteer leaves; hours = gap, written to volunteer_hours,
//               plus optional "what did you do" and "how do you feel" (1–5)
//
// SECURITY NOTES — this is a PUBLIC endpoint, so:
//   • The browser never receives a Supabase key and can never read rows.
//   • Volunteers are matched WITHIN the token's org only; no list is ever
//     returned. Matching by name means someone could learn whether a named
//     person volunteers here — accepted trade-off so volunteers without an
//     email on file (e.g. imported from a sign-in sheet) can use it.
//   • Rate limited per IP. Tokens can be turned off from the app.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// A session longer than this is treated as a forgotten check-out.
const MAX_SESSION_HOURS = 10;
const RATE = { windowMs: 60 * 1000, max: 20, hits: new Map() };

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function rateLimited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now();
  const rec = RATE.hits.get(ip);
  if (!rec || now - rec.start > RATE.windowMs) {
    RATE.hits.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count++;
  return rec.count > RATE.max;
}

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await r.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = text; }
  if (!r.ok) {
    const m = (body && body.message) || `Supabase ${r.status}`;
    const err = new Error(m);
    err.status = r.status;
    throw err;
  }
  return body;
}

function bad(res, message, code = 400, extra) {
  return res.status(code).json(Object.assign({ ok: false, error: message }, extra || {}));
}
const trim = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// ── context: event or site ─────────────────────────────────
async function getContext(token) {
  if (!token || typeof token !== 'string' || token.length < 12) return null;
  const t = encodeURIComponent(token);
  let evs;
  try {
    evs = await sb(`events?public_token=eq.${t}&select=id,org_id,name,event_date,location,type,public_enabled,question_ids&limit=1`);
  } catch (e) {
    // question_ids column not added yet
    evs = await sb(`events?public_token=eq.${t}&select=id,org_id,name,event_date,location,type,public_enabled&limit=1`);
  }
  if (Array.isArray(evs) && evs.length) {
    const ev = evs[0];
    if (ev.public_enabled === false) return null;
    return { mode: 'event', orgId: ev.org_id, eventId: String(ev.id), siteId: null, name: ev.name || 'Event',
             date: ev.event_date || null, location: ev.location || '', questionIds: ev.question_ids || null, type: ev.type || '' };
  }
  let sites = [];
  try { sites = await sb(`volunteer_sites?public_token=eq.${t}&select=id,org_id,name,public_enabled&limit=1`); }
  catch (e) { sites = []; }   // table not created yet
  if (Array.isArray(sites) && sites.length) {
    const s = sites[0];
    if (s.public_enabled === false) return null;
    const site = { mode: 'site', orgId: s.org_id, eventId: null, siteId: String(s.id), name: s.name || 'Volunteer sign-in',
                    date: null, location: '', questionIds: null };
    // EVERGREEN QR: one code, printed once. If an event is on today, this
    // same code quietly becomes that event's page — attendee feedback and
    // all. No event today → falls back to plain volunteer sign-in. Nothing
    // to reprint when a new event is added.
    const today = await todaysEvent(s.org_id, s.name);
    if (today) { today.siteId = String(s.id); today.siteName = s.name || 'Volunteer sign-in'; return today; }   // same code, both options
    return site;
  }
  return null;
}

// Today's event for this organisation, preferring one whose location
// roughly matches the site's name (so two concurrent sites don't collide).
async function todaysEvent(orgId, siteName) {
  const today = new Date().toISOString().slice(0, 10);
  let evs;
  try {
    evs = await sb(`events?org_id=eq.${orgId}&event_date=eq.${today}&public_enabled=neq.false&select=id,name,event_date,location,type,public_token,public_enabled,question_ids&order=id.asc`);
  } catch (e) {
    evs = await sb(`events?org_id=eq.${orgId}&event_date=eq.${today}&public_enabled=neq.false&select=id,name,event_date,location,type,public_token,public_enabled&order=id.asc`);
  }
  evs = (evs || []).filter(e => e.public_enabled !== false);
  if (!evs.length) return null;
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  let ev = evs[0];
  if (evs.length > 1) {
    const sn = norm(siteName);
    const match = evs.find(e => sn && norm(e.location) && norm(e.location).includes(sn)) || evs.find(e => sn && norm(e.location) && sn.includes(norm(e.location)));   // a blank location never counts as a match
    if (match) ev = match;
    else return { mode: 'choose', orgId, eventId: null, siteId: null, name: 'Choose today\u2019s session',
      date: today, location: '', questionIds: null,
      choices: evs.map(e => ({ id: String(e.id), name: e.name || 'Event', location: e.location || '' })) };
  }
  // An event with no QR of its own yet still gets one automatically, so the check-in works either way
  if (!ev.public_token) {
    ev.public_token = genToken();
    try { await sb(`events?id=eq.${ev.id}`, { method: 'PATCH', body: JSON.stringify({ public_token: ev.public_token }) }); } catch (e) { /* non-fatal */ }
  }
  return { mode: 'event', orgId, eventId: String(ev.id), siteId: null, name: ev.name || 'Event',
           date: ev.event_date || today, location: ev.location || '', questionIds: ev.question_ids || null, type: ev.type || '', viaSite: true };
}
function genToken() {
  const a = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let t = '';
  for (let i = 0; i < 32; i++) t += a[Math.floor(Math.random() * a.length)];
  return t;
}

async function getOrgName(orgId) {
  try {
    const rows = await sb(`organisations?id=eq.${orgId}&select=name&limit=1`);
    return (Array.isArray(rows) && rows[0] && rows[0].name) || '';
  } catch (e) { return ''; }
}

// ── participant check-in (attendance) and volunteering interest ──────────────
// A check-in form is a list of questions: { id, label, kind: single|multi|text|number|email|postcode|count, required, options, other, showIf:{q,maxAge}, role }.
// Roles: location (the event's own location is used, never asked), people (how many are being checked in), extra_people (under-16s with you), email (kept apart from the answers).
const CI_STANDARD = org => ({ id: 'standard', name: 'Standard check-in', questions: [
  { id: 'first', label: 'Is this your first time with ' + (org || 'us') + '?', kind: 'single', required: true, options: ['Yes', 'No'] },
  { id: 'people', label: 'How many people are you checking in?', kind: 'single', required: true, role: 'people', options: ['Just me', '2', '3', '4', '5 or more'] }
] });
async function getCheckin(ctx) {
  let org = { name: '', settings: {} };
  try { const r = await sb(`organisations?id=eq.${ctx.orgId}&select=name,settings&limit=1`); if (Array.isArray(r) && r[0]) org = r[0]; } catch (e) { /* use the standard form */ }
  const st = (org.settings && typeof org.settings === 'object') ? org.settings : {};
  const forms = Array.isArray(st.checkin_forms) ? st.checkin_forms : [];
  const byId = id => forms.find(f => f && f.id === id && Array.isArray(f.questions) && f.questions.length);
  // the organisation can edit the standard form; otherwise the built-in one
  const standard = (st.checkin_standard && Array.isArray(st.checkin_standard.questions) && st.checkin_standard.questions.length)
    ? { id: 'standard', name: 'Standard check-in', questions: st.checkin_standard.questions } : CI_STANDARD(org.name);
  // this event's own choice, and the funders it is linked to (columns may not exist yet: ask for what is there)
  let evRow = null;
  for (const cols of ['checkin_form,contract_ids', 'checkin_form', 'contract_ids']) {
    try { const r = await sb(`events?id=eq.${encodeURIComponent(ctx.eventId)}&select=${cols}&limit=1`); if (Array.isArray(r) && r[0]) { evRow = r[0]; break; } } catch (e) { /* column not added yet */ }
  }
  let form = null;
  // 1. the form picked on the event   2. the form for a funder the event is linked to   3. the form for this kind of event   4. the default   5. standard
  if (evRow && evRow.checkin_form) form = evRow.checkin_form === 'standard' ? standard : byId(evRow.checkin_form);
  const byContract = (st.checkin_form_for_contract && typeof st.checkin_form_for_contract === 'object') ? st.checkin_form_for_contract : {};
  if (!form && evRow && Array.isArray(evRow.contract_ids)) { for (const cid of evRow.contract_ids) { const f = byContract[String(cid)] ? byId(byContract[String(cid)]) : null; if (f) { form = f; break; } } }
  const map = (st.checkin_form_for_type && typeof st.checkin_form_for_type === 'object') ? st.checkin_form_for_type : {};
  if (!form && ctx.type && map[ctx.type]) form = byId(map[ctx.type]);
  if (!form && st.checkin_default) form = byId(st.checkin_default);
  return { enabled: st.checkin_enabled !== false, orgName: org.name || '', form: form || standard };
}
const publicForm = f => ({ id: f.id, name: f.name, questions: (f.questions || []).filter(q => q && q.role !== 'location').map(q => ({
  id: String(q.id), label: String(q.label || '').slice(0, 300), kind: q.kind || 'text', required: !!q.required, options: Array.isArray(q.options) ? q.options.map(o => String(o).slice(0, 120)).slice(0, 20) : [],
  other: !!q.other, hint: q.hint ? String(q.hint).slice(0, 300) : '', role: q.role || '', showIf: q.showIf || null, perVisit: !!q.perVisit })) });
// "Keep me updated": name and email go to the organisation's Contacts as a mailing-list entry, never into the answers
async function saveOptin(ctx, o) {
  if (!o || typeof o !== 'object') return false;
  const email = trim(o.email, 254).toLowerCase(), name = likeSafe(trim(o.name, 120));
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return false;
  try { const dup = await sb(`contacts?org_id=eq.${ctx.orgId}&email=eq.${encodeURIComponent(email)}&select=id&limit=1`); if (Array.isArray(dup) && dup.length) return true; } catch (e) { /* carry on */ }
  const parts = name.split(/\s+/).filter(Boolean), first = parts.shift() || '', last = parts.join(' ');
  const where = ctx.mode === 'event' ? (ctx.name || 'Event') + (ctx.date ? ', ' + ctx.date : '') : (ctx.name || 'Volunteer sign-in');
  const row = { org_id: ctx.orgId, first_name: first || '(no name given)', last_name: last, email, role: 'Mailing list', status: 'Subscribed', notes: 'Asked for updates at ' + where + '.' };
  try { await sb('contacts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) }); }
  catch (e) { if (!/column|schema cache|does not exist/i.test(e.message || '')) throw e; delete row.notes; await sb('contacts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) }); }
  return true;
}
function ciMaxAge(opt) { const t = String(opt || ''); if (/prefer not/i.test(t)) return null; if (/\+/.test(t)) return Infinity; const n = t.match(/\d+/g); return n ? +n[n.length - 1] : null; }
function ciValidate(form, answers) {
  const qs = (form.questions || []).filter(q => q && q.role !== 'location'), out = {}; let people = 1, extra = 0, email = '';
  const byId = {}; qs.forEach(q => { byId[String(q.id)] = q; });
  if (JSON.stringify(answers || {}).length > 8000) return { error: 'That is too much text.' };
  const val = (q) => answers ? answers[q.id] : undefined;
  for (const q of qs) {
    if (q.showIf && byId[q.showIf.q]) { const a = val(byId[q.showIf.q]), mx = ciMaxAge(a); if (!(mx != null && mx <= q.showIf.maxAge)) continue; }   // e.g. "if you are 25 or under"
    let v = val(q); const empty = v == null || v === '' || (Array.isArray(v) && !v.length);
    if (empty) { if (q.required) return { error: 'Please answer: ' + String(q.label).slice(0, 90) }; continue; }
    const opts = Array.isArray(q.options) ? q.options : [];
    const okOpt = s => opts.includes(s) || (q.other && /^Other: .{1,80}$/.test(s));
    if (q.kind === 'single' || q.kind === 'count') { v = String(v).slice(0, 100); if (!okOpt(v)) return { error: 'Please choose one of the answers for: ' + String(q.label).slice(0, 90) }; out[q.label] = v; }
    else if (q.kind === 'multi') { if (!Array.isArray(v) || v.length > 12 || !v.every(x => typeof x === 'string' && okOpt(x.slice(0, 100)))) return { error: 'Please choose from the answers for: ' + String(q.label).slice(0, 90) }; out[q.label] = v.map(x => x.slice(0, 100)); }
    else if (q.kind === 'email') { v = String(v).trim().toLowerCase().slice(0, 254); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return { error: 'That email doesn\u2019t look right.' }; if (q.role === 'email') email = v; else out[q.label] = v; }
    else if (q.kind === 'postcode') { const m = /^([A-Z]{1,2}\d[A-Z\d]?)/.exec(String(v).toUpperCase().replace(/\s+/g, '')); if (!m) return { error: 'Please enter the first part of your postcode, like PE2.' }; out[q.label] = m[1]; }
    else if (q.kind === 'number') { const n = parseInt(v, 10); if (!(n >= 0 && n <= 50)) return { error: 'Please enter a number for: ' + String(q.label).slice(0, 90) }; out[q.label] = n; }
    else { out[q.label] = String(v).trim().slice(0, 200); }
    if (q.role === 'people') { const m = /\d+/.exec(String(v)); people = /just me/i.test(String(v)) ? 1 : (m ? Math.min(+m[0], 20) : 1); }
    if (q.role === 'extra_people') { const m = /\d+/.exec(String(v)); extra = /n\/a|none/i.test(String(v)) ? 0 : (m ? Math.min(+m[0], 20) : 0); }
  }
  if (qs.some(q => q.role === 'extra_people')) people = 1 + extra;
  return { answers: out, people, email };
}

// The org's own feedback questions for this event (null question_ids = all active).
async function getQuestions(ctx) {
  let rows = [];
  try {
    rows = await sb(`survey_measures?org_id=eq.${ctx.orgId}&select=id,question,kind,maps_to,options,active,sort&order=sort.asc`);
  } catch (e) {
    try { rows = await sb(`survey_measures?org_id=eq.${ctx.orgId}&select=id,question,kind,maps_to,active,sort&order=sort.asc`); }   // options column not added yet
    catch (e2) { return []; }
  }
  rows = (rows || []).filter(r => r.active !== false && r.kind !== 'ignore');
  if (Array.isArray(ctx.questionIds) && ctx.questionIds.length) {
    const ids = ctx.questionIds.map(String);
    const sub = rows.filter(r => ids.includes(String(r.id)));
    if (sub.length) rows = sub;
  }
  return rows.map(r => ({ id: r.id, question: r.question, kind: r.kind, maps_to: r.maps_to || null,
    options: r.kind === 'choice' && Array.isArray(r.options) ? r.options.map(x => String(x).slice(0, 80)).slice(0, 12)
           : r.kind === 'score' && Array.isArray(r.options) && r.options.length === 2 ? r.options.map(x => String(x).slice(0, 40)) : undefined }));
}

// ── scoring (same rules as the app) ────────────────────────
const LIKERT = { 'strongly disagree': 1, 'disagree': 2, 'neutral': 3, 'agree': 4, 'strongly agree': 5 };
function scoreOf(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (LIKERT[s] != null) return LIKERT[s];
  if (/^\d+(\.\d+)?$/.test(s)) { const x = +s; return x >= 0 && x <= 10 ? x : null; }
  if (/^(y|yes)\b/.test(s)) return 5;
  if (/^(n|no)\b/.test(s)) return 1;
  return null;
}
function yesOf(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (/^(y|yes)\b/.test(s)) return true;
  const sc = scoreOf(v);
  return sc != null && sc >= 4;
}

// ── volunteers: match by email or full name, within the org ─
function likeSafe(s) { return s.replace(/[%_*,()]/g, ' ').replace(/\s+/g, ' ').trim(); }

async function findVolunteers(orgId, who) {
  const clean = String(who || '').trim();
  if (!clean || clean.length > 254) return [];
  if (clean.indexOf('@') > 0) {
    return (await sb(`volunteers?org_id=eq.${orgId}&email=ilike.${encodeURIComponent(likeSafe(clean.toLowerCase()))}&select=id,name,status&limit=2`)) || [];
  }
  const name = likeSafe(clean);
  if (name.length < 2) return [];
  return (await sb(`volunteers?org_id=eq.${orgId}&name=ilike.${encodeURIComponent(name)}&select=id,name,status&limit=2`)) || [];
}

async function resolveVolunteer(ctx, body, allowCreate) {
  const who = trim(body.who || body.email, 254);
  if (!who) return { error: 'Please enter your name or email.' };
  const found = (await findVolunteers(ctx.orgId, who)).filter(v => !v.status || v.status === 'Active');
  if (found.length > 1) return { error: 'More than one volunteer has that name. Please use your email instead.', code: 409 };
  if (found.length === 1) return { v: found[0] };

  if (!allowCreate || !body.newVolunteer) {
    return {
      error: allowCreate
        ? 'We don\u2019t know that name yet.'
        : 'We don\u2019t know that name or email. Check the spelling, or check in first.',
      code: 404, unknown: allowCreate
    };
  }
  // First-timer signs themselves up
  const isEmail = who.indexOf('@') > 0;
  const name = likeSafe(isEmail ? trim(body.name, 120) : who).slice(0, 120);
  const email = isEmail ? who.toLowerCase() : (trim(body.email, 254).toLowerCase() || null);
  if (!name || name.indexOf(' ') < 0) return { error: 'Please add your full name (first and last).' };
  if (email && email.indexOf('@') < 1) return { error: 'That email doesn\u2019t look right.' };
  const parts = name.split(' ');
  const rows = await sb('volunteers', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify([{
      org_id: ctx.orgId, name, first_name: parts[0], last_name: parts.slice(1).join(' '),
      email, phone: null, role: 'Volunteer', status: 'Active', hours: 0, skills: '[]'
    }])
  });
  return { v: rows && rows[0], created: true };
}

// Open session for this volunteer at this event / site.
async function openSession(ctx, volunteerId) {
  const ev = ctx.eventId ? encodeURIComponent(ctx.eventId) : null, st = ctx.siteId ? encodeURIComponent(ctx.siteId) : null;
  const place = (ev && st) ? `or=(event_id.eq.${ev},and(event_id.is.null,site_id.eq.${st}))`
              : ev ? `event_id=eq.${ev}`
              : `event_id=is.null&site_id=eq.${st}`;
  const rows = await sb(
    `volunteer_checkins?org_id=eq.${ctx.orgId}&${place}` +
    `&volunteer_id=eq.${encodeURIComponent(volunteerId)}&checked_out_at=is.null` +
    `&select=id,checked_in_at,event_id${st ? ',site_id' : ''}&order=checked_in_at.desc&limit=1`
  );
  return (Array.isArray(rows) && rows[0]) || null;
}

async function patchCheckin(id, patch) {
  try {
    await sb(`volunteer_checkins?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(patch) });
  } catch (e) {
    if (!/flagged/i.test(e.message || '')) throw e;
    const p2 = Object.assign({}, patch); delete p2.flagged;
    await sb(`volunteer_checkins?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(p2) });
  }
}

function hhmm(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}
function londonDay(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });   // YYYY-MM-DD
}

// Write hours; drop optional columns if the SQL hasn't been run yet.
async function insertHours(row) {
  try {
    await sb('volunteer_hours', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) });
  } catch (e) {
    if (/wellbeing|site_id/i.test(e.message || '')) {
      const r2 = Object.assign({}, row); delete r2.wellbeing; delete r2.site_id;
      await sb('volunteer_hours', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([r2]) });
    } else throw e;
  }
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return bad(res, 'Server not configured.', 500);
  if (rateLimited(req)) return bad(res, 'Too many attempts. Please wait a minute and try again.', 429);

  const body = req.body || {};
  const action = body.action;

  let ctx;
  try { ctx = await getContext(body.token); }
  catch (e) {
    console.error('[event-checkin] token lookup failed:', e.message);
    return bad(res, 'Could not check that link. Please try again.', 500);
  }
  if (!ctx) return bad(res, 'This link isn\u2019t valid or has been turned off. Please ask a member of staff for the current QR code.', 404);

  // Rare case: two events are on today at the same evergreen QR and the location
  // text doesn't tell them apart — the visitor picks one, then we act on that.
  if (ctx.mode === 'choose' && body.eventId) {
    const pick = (ctx.choices || []).find(c => c.id === String(body.eventId));
    if (!pick) return bad(res, 'Please choose one of today\u2019s sessions.');
    const evs = await sb(`events?id=eq.${encodeURIComponent(pick.id)}&select=id,org_id,name,event_date,location,type,public_token,public_enabled,question_ids&limit=1`).catch(() => []);
    const ev = (evs || [])[0];
    if (!ev || String(ev.org_id) !== String(ctx.orgId) || ev.public_enabled === false) return bad(res, 'That session is not available.');
    if (!ev.public_token) { ev.public_token = genToken(); try { await sb(`events?id=eq.${ev.id}`, { method: 'PATCH', body: JSON.stringify({ public_token: ev.public_token }) }); } catch (e) { /* non-fatal */ } }
    ctx = { mode: 'event', orgId: ctx.orgId, eventId: String(ev.id), siteId: ctx.siteId || null, siteName: ctx.siteName || '', name: ev.name || 'Event',
            date: ev.event_date || null, location: ev.location || '', questionIds: ev.question_ids || null, type: ev.type || '' };
  }
  if (ctx.mode === 'choose' && action !== 'info') return bad(res, 'Please choose today\u2019s session first.');

  try {
    // ── info ────────────────────────────────────────────────
    // ── participant check-in: attendance, with the organisation's own questions ──
    if (action === 'attend') {
      if (body.hp) return res.status(200).json({ ok: true });                   // a bot filled the hidden box
      if (ctx.mode !== 'event') return bad(res, 'Check-in is for a session. There is no session on today.');
      const cfg = await getCheckin(ctx);
      if (!cfg.enabled) return bad(res, 'Check-in is not switched on for this session.');
      const v = ciValidate(cfg.form, body.answers || {});
      if (v.error) return bad(res, v.error);
      const day = londonDay(new Date().toISOString());
      await sb('checkins', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ org_id: String(ctx.orgId), event_id: String(ctx.eventId), form_id: String(cfg.form.id), people: v.people, answers: v.answers, day }]) });
      try { await saveOptin(ctx, body.optin); } catch (e) { /* the check-in still counts */ }
      if (v.email) { try { await sb('checkin_emails', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ org_id: String(ctx.orgId), day, email: v.email }]) }); } catch (e) { /* the check-in still counts */ } }
      // attendance fills itself: the session's count becomes everyone checked in, and never drops below what staff typed
      try {
        const rows = await sb(`checkins?event_id=eq.${encodeURIComponent(ctx.eventId)}&select=people&limit=5000`);
        const total = (rows || []).reduce((a, r) => a + (+r.people || 1), 0);
        const evs = await sb(`events?id=eq.${encodeURIComponent(ctx.eventId)}&select=attendees&limit=1`);
        const cur = +(evs && evs[0] && evs[0].attendees) || 0;
        if (total > cur) await sb(`events?id=eq.${encodeURIComponent(ctx.eventId)}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ attendees: total }) });
      } catch (e) { /* the check-in is saved either way */ }
      return res.status(200).json({ ok: true, people: v.people });
    }

    // ── "I'd like to volunteer": a lead for the Contacts tab, never a volunteer until staff decide ──
    if (action === 'volunteer_interest') {
      if (body.hp) return res.status(200).json({ ok: true });
      const first = likeSafe(trim(body.first, 60)), last = likeSafe(trim(body.last, 60)), contact = trim(body.contact, 254), note = trim(body.note, 400);
      if (!first || !last) return bad(res, 'Please add your first and last name.');
      if (!contact) return bad(res, 'Please add an email or phone number so we can reach you.');
      const isEmail = contact.indexOf('@') > 0, email = isEmail ? contact.toLowerCase() : '', phone = isEmail ? '' : contact.replace(/[^\d+ ()-]/g, '').slice(0, 30);
      if (isEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return bad(res, 'That email doesn\u2019t look right.');
      if (!isEmail && phone.replace(/\D/g, '').length < 7) return bad(res, 'That phone number doesn\u2019t look right.');
      const where = ctx.mode === 'event' ? (ctx.name || 'Event') + (ctx.date ? ', ' + ctx.date : '') : (ctx.name || 'Volunteer sign-in');
      const notes = ('Interested in volunteering. Seen at: ' + where + '.' + (phone ? ' Phone: ' + phone + '.' : '') + (note ? ' Note: ' + note : '')).slice(0, 900);
      if (email) { try { const dup = await sb(`contacts?org_id=eq.${ctx.orgId}&email=eq.${encodeURIComponent(email)}&select=id&limit=1`); if (Array.isArray(dup) && dup.length) return res.status(200).json({ ok: true, already: true }); } catch (e) { /* carry on */ } }
      const row = { org_id: ctx.orgId, first_name: first, last_name: last, email, role: 'Volunteer interest', status: 'Prospect', phone: phone || null, notes };
      try { await sb('contacts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) }); }
      catch (e) {   // the phone and notes columns may not be added yet: keep the details in the role so nothing is lost
        if (!/column|schema cache|does not exist/i.test(e.message || '')) throw e;
        await sb('contacts', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ org_id: ctx.orgId, first_name: first, last_name: last, email, role: ('Volunteer interest: ' + notes).slice(0, 250), status: 'Prospect' }]) });
      }
      return res.status(200).json({ ok: true });
    }

    if (action === 'info') {
      const ciCfg = ctx.mode === 'event' ? await getCheckin(ctx) : null;
      const orgName = (ciCfg && ciCfg.orgName) || await getOrgName(ctx.orgId);
      const questions = ctx.mode === 'event' ? await getQuestions(ctx) : [];
      return res.status(200).json({
        ok: true,
        mode: ctx.mode,
        event: { name: ctx.name, date: ctx.date, location: ctx.location, org_name: orgName },
        site: (ctx.mode === 'event' && ctx.siteId) ? { name: ctx.siteName || 'Volunteer sign-in' } : null,   // on an event day the same code also offers general site volunteering
        questions,
        checkin: (ciCfg && ciCfg.enabled) ? { form: publicForm(ciCfg.form) } : null,   // the Check in tab, with this session's form
        choices: ctx.mode === 'choose' ? (ctx.choices || []) : undefined   // today's sessions to tap between
      });
    }

    // ── feedback (events only) ──────────────────────────────
    if (action === 'feedback') {
      if (ctx.mode !== 'event') return bad(res, 'Feedback is only for events.');
      const questions = await getQuestions(ctx);
      let row;

      if (questions.length && body.answers && typeof body.answers === 'object') {
        // The org's own questions: answers kept word-for-word; Vorlana's standard fields filled from the ones that map
        const answers = {};
        const std = { enjoyed: null, cb: null, ca: null, learned: false, connected: false, friend: false, quote: '' };
        questions.forEach(q => {
          let a = body.answers[q.question];
          if (a == null || a === '') return;
          if (q.kind === 'score') { a = parseInt(a, 10); if (!(a >= 1 && a <= 5)) return; }
          else if (q.kind === 'choice' && q.options && q.options.length) { a = trim(a, 200); if (!q.options.includes(a)) return; }   // only one of the choices on offer
          else { a = trim(a, 2000); if (!a) return; }
          answers[q.question] = a;
          if (!q.maps_to) return;
          if (q.maps_to === 'quote') { if (!std.quote) std.quote = String(a); return; }
          if (['enjoyed', 'cb', 'ca'].includes(q.maps_to)) { const sc = scoreOf(a); if (sc != null) std[q.maps_to] = Math.min(5, Math.max(1, Math.round(sc))); return; }
          std[q.maps_to] = yesOf(a);
        });
        if (!Object.keys(answers).length) return bad(res, 'Please answer at least one question.');
        row = Object.assign({ org_id: ctx.orgId, event_id: ctx.eventId, name: trim(body.name, 120), answers }, std);
      } else {
        // No questions set up yet — Vorlana's standard form
        const clamp = (v) => { const x = parseInt(v, 10); return isNaN(x) ? null : Math.min(5, Math.max(1, x)); };
        row = {
          org_id: ctx.orgId, event_id: ctx.eventId, name: trim(body.name, 120),
          enjoyed: clamp(body.enjoyed), cb: clamp(body.cb), ca: clamp(body.ca),
          learned: !!body.learned, connected: !!body.connected, friend: !!body.friend,
          quote: trim(body.quote, 2000)
        };
      }
      // Optional "About you" — anonymous, never stored with an email; postcode first half only
      const demo = {};
      const d = (body.demographics && typeof body.demographics === 'object') ? body.demographics : {};
      ['age', 'gender', 'ethnicity', 'disability'].forEach(k => { const v = trim(d[k], 60); if (v) demo[k] = v; });
      const pc = /^([A-Z]{1,2}\d[A-Z\d]?)/.exec(String(d.postcode || '').toUpperCase().trim());
      if (pc) demo.postcode = pc[1];
      if (Object.keys(demo).length) row.demographics = demo;

      try {
        await sb('feedback', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) });
      } catch (e) {
        if (!/answers|demographics/i.test(e.message || '')) throw e;
        delete row.answers; delete row.demographics;
        await sb('feedback', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) });
      }
      try { await saveOptin(ctx, body.optin); } catch (e) { /* the feedback is saved either way */ }
      return res.status(200).json({ ok: true });
    }

    // ── volunteer check in ──────────────────────────────────
    if (action === 'checkin') {
      const r = await resolveVolunteer(ctx, body, true);
      if (r.error) return bad(res, r.error, r.code || 400, r.unknown ? { unknown: true } : null);
      const v = r.v;

      const nowIso = new Date().toISOString();
      const wantSite = body.place === 'site' && !!ctx.siteId;
      const target = wantSite ? { eventId: null, siteId: ctx.siteId, label: ctx.siteName || 'the site' }
                              : { eventId: ctx.eventId, siteId: ctx.eventId ? null : ctx.siteId, label: ctx.name };
      const existing = await openSession(ctx, v.id);
      if (existing) {
        // Same day → already in. Earlier day → they forgot to check out: close it (0h, flagged) and start fresh.
        if (londonDay(existing.checked_in_at) === londonDay(nowIso)) {
          return res.status(200).json({ ok: true, at: hhmm(existing.checked_in_at), already: true, name: v.name || '', where: existing.event_id ? ctx.name : (ctx.siteName || ctx.name) });
        }
        await patchCheckin(existing.id, { checked_out_at: existing.checked_in_at, hours: 0, flagged: 'forgot to check out' });
      }

      const row = { org_id: ctx.orgId, event_id: target.eventId, volunteer_id: String(v.id), checked_in_at: nowIso };
      if (target.siteId) row.site_id = target.siteId;
      await sb('volunteer_checkins', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) });
      return res.status(200).json({ ok: true, at: hhmm(nowIso), name: v.name || '', created: !!r.created, where: target.label });
    }

    // ── volunteer check out ─────────────────────────────────
    if (action === 'checkout') {
      const r = await resolveVolunteer(ctx, body, false);
      if (r.error) return bad(res, r.error, r.code || 400);
      const v = r.v;

      const open = await openSession(ctx, v.id);
      if (!open) return bad(res, 'We don\u2019t have you checked in here today. Tap \u201cCheck in\u201d first, or ask a member of staff to log your hours.', 409);

      const outIso = new Date().toISOString();
      let hours = (new Date(outIso) - new Date(open.checked_in_at)) / 3600000;
      if (!isFinite(hours) || hours < 0) hours = 0;

      // Checked in on another day, or far too long ago — don't guess the hours; staff confirm them
      if (hours > MAX_SESSION_HOURS || londonDay(open.checked_in_at) !== londonDay(outIso)) {
        await patchCheckin(open.id, { checked_out_at: outIso, hours: 0, flagged: 'check-out too late — hours need confirming' });
        return res.status(200).json({ ok: true, hours: 0, flagged: true, name: v.name || '' });
      }

      hours = Math.max(0.25, Math.round(hours * 4) / 4);   // nearest 15 min, minimum 15 min
      await patchCheckin(open.id, { checked_out_at: outIso, hours });

      const wb = parseInt(body.wellbeing, 10);
      await insertHours({
        org_id: ctx.orgId,
        volunteer_id: String(v.id),
        event_id: open.event_id || null,      // the hours go where the volunteer signed in
        site_id: open.site_id || null,
        session_date: londonDay(outIso),
        hours,
        activity: trim(body.activity, 200) || (open.event_id ? 'Volunteered at ' + ctx.name : (ctx.siteName || ctx.name)),
        wellbeing: (wb >= 1 && wb <= 5) ? wb : null,
        source: 'qr'
      });
      return res.status(200).json({ ok: true, hours, name: v.name || '' });
    }

    return bad(res, 'Unknown action.');
  } catch (e) {
    console.error('[event-checkin] ' + action + ' failed:', e.message);
    return bad(res, 'Something went wrong saving that. Please try again, or ask a member of staff.', 500);
  }
};
