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
    evs = await sb(`events?public_token=eq.${t}&select=id,org_id,name,event_date,location,public_enabled,question_ids&limit=1`);
  } catch (e) {
    // question_ids column not added yet
    evs = await sb(`events?public_token=eq.${t}&select=id,org_id,name,event_date,location,public_enabled&limit=1`);
  }
  if (Array.isArray(evs) && evs.length) {
    const ev = evs[0];
    if (ev.public_enabled === false) return null;
    return { mode: 'event', orgId: ev.org_id, eventId: String(ev.id), siteId: null, name: ev.name || 'Event',
             date: ev.event_date || null, location: ev.location || '', questionIds: ev.question_ids || null };
  }
  let sites = [];
  try { sites = await sb(`volunteer_sites?public_token=eq.${t}&select=id,org_id,name,public_enabled&limit=1`); }
  catch (e) { sites = []; }   // table not created yet
  if (Array.isArray(sites) && sites.length) {
    const s = sites[0];
    if (s.public_enabled === false) return null;
    return { mode: 'site', orgId: s.org_id, eventId: null, siteId: String(s.id), name: s.name || 'Volunteer sign-in',
             date: null, location: '', questionIds: null };
  }
  return null;
}

async function getOrgName(orgId) {
  try {
    const rows = await sb(`organisations?id=eq.${orgId}&select=name&limit=1`);
    return (Array.isArray(rows) && rows[0] && rows[0].name) || '';
  } catch (e) { return ''; }
}

// The org's own feedback questions for this event (null question_ids = all active).
async function getQuestions(ctx) {
  let rows = [];
  try {
    rows = await sb(`survey_measures?org_id=eq.${ctx.orgId}&select=id,question,kind,maps_to,active,sort&order=sort.asc`);
  } catch (e) { return []; }
  rows = (rows || []).filter(r => r.active !== false && r.kind !== 'ignore');
  if (Array.isArray(ctx.questionIds) && ctx.questionIds.length) {
    const ids = ctx.questionIds.map(String);
    const sub = rows.filter(r => ids.includes(String(r.id)));
    if (sub.length) rows = sub;
  }
  return rows.map(r => ({ id: r.id, question: r.question, kind: r.kind, maps_to: r.maps_to || null }));
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
  const place = ctx.eventId ? `event_id=eq.${encodeURIComponent(ctx.eventId)}`
                            : `event_id=is.null&site_id=eq.${encodeURIComponent(ctx.siteId)}`;
  const rows = await sb(
    `volunteer_checkins?org_id=eq.${ctx.orgId}&${place}` +
    `&volunteer_id=eq.${encodeURIComponent(volunteerId)}&checked_out_at=is.null` +
    `&select=id,checked_in_at&order=checked_in_at.desc&limit=1`
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

  try {
    // ── info ────────────────────────────────────────────────
    if (action === 'info') {
      const orgName = await getOrgName(ctx.orgId);
      const questions = ctx.mode === 'event' ? await getQuestions(ctx) : [];
      return res.status(200).json({
        ok: true,
        mode: ctx.mode,
        event: { name: ctx.name, date: ctx.date, location: ctx.location, org_name: orgName },
        questions
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
      return res.status(200).json({ ok: true });
    }

    // ── volunteer check in ──────────────────────────────────
    if (action === 'checkin') {
      const r = await resolveVolunteer(ctx, body, true);
      if (r.error) return bad(res, r.error, r.code || 400, r.unknown ? { unknown: true } : null);
      const v = r.v;

      const nowIso = new Date().toISOString();
      const existing = await openSession(ctx, v.id);
      if (existing) {
        // Same day → already in. Earlier day → they forgot to check out: close it (0h, flagged) and start fresh.
        if (londonDay(existing.checked_in_at) === londonDay(nowIso)) {
          return res.status(200).json({ ok: true, at: hhmm(existing.checked_in_at), already: true, name: v.name || '' });
        }
        await patchCheckin(existing.id, { checked_out_at: existing.checked_in_at, hours: 0, flagged: 'forgot to check out' });
      }

      const row = { org_id: ctx.orgId, event_id: ctx.eventId, volunteer_id: String(v.id), checked_in_at: nowIso };
      if (ctx.siteId) row.site_id = ctx.siteId;
      await sb('volunteer_checkins', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) });
      return res.status(200).json({ ok: true, at: hhmm(nowIso), name: v.name || '', created: !!r.created });
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
        event_id: ctx.eventId,
        site_id: ctx.siteId,
        session_date: londonDay(outIso),
        hours,
        activity: trim(body.activity, 200) || (ctx.mode === 'event' ? 'Volunteered at ' + ctx.name : ctx.name),
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
