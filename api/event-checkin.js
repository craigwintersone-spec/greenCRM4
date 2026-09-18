// /api/event-checkin.js
// Public endpoint behind event.html — the QR target.
//
// Handles four actions, all keyed off a per-event token:
//   info      → event name / date / location / org name (nothing sensitive)
//   feedback  → anonymous attendee feedback for that event
//   checkin   → volunteer arrives (matched by their registered email)
//   checkout  → volunteer leaves; hours = gap, written to volunteer_hours
//
// SECURITY NOTES — this is a PUBLIC endpoint, so:
//   • The browser never receives a Supabase key and can never read rows.
//   • Volunteers are matched by email WITHIN the token's org only. We never
//     return a list of volunteers, and a wrong email gets a generic answer —
//     so the endpoint cannot be used to enumerate who volunteers for you.
//   • Rate limited per IP to blunt spam.
//   • Tokens are per-event and can be rotated from the app.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Volunteers who forget to check out are auto-closed at this many hours.
const MAX_SESSION_HOURS = 8;
// Simple in-memory rate limit (per warm lambda). Not bulletproof, but stops floods.
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

function bad(res, message, code = 400) {
  return res.status(code).json({ ok: false, error: message });
}

// Look up the event this token belongs to. Tokens live on the events row.
async function getEventByToken(token) {
  if (!token || typeof token !== 'string' || token.length < 12) return null;
  const rows = await sb(
    `events?public_token=eq.${encodeURIComponent(token)}&select=id,org_id,name,event_date,location,public_enabled&limit=1`
  );
  if (!Array.isArray(rows) || !rows.length) return null;
  const ev = rows[0];
  if (ev.public_enabled === false) return null;
  return ev;
}

async function getOrgName(orgId) {
  try {
    const rows = await sb(`organisations?id=eq.${orgId}&select=name&limit=1`);
    return (Array.isArray(rows) && rows[0] && rows[0].name) || '';
  } catch (e) {
    return '';
  }
}

// Match a volunteer by email, scoped to this event's org. Never returns a list.
async function findVolunteer(orgId, email) {
  const clean = String(email || '').trim().toLowerCase();
  if (!clean || clean.indexOf('@') < 0 || clean.length > 254) return null;
  const rows = await sb(
    `volunteers?org_id=eq.${orgId}&email=ilike.${encodeURIComponent(clean)}&select=id,name,status&limit=1`
  );
  if (!Array.isArray(rows) || !rows.length) return null;
  const v = rows[0];
  if (v.status && v.status !== 'Active') return null;
  return v;
}

// An open session = checked in, not yet checked out, for this event + volunteer.
async function openSession(orgId, eventId, volunteerId) {
  const rows = await sb(
    `volunteer_checkins?org_id=eq.${orgId}&event_id=eq.${encodeURIComponent(eventId)}` +
    `&volunteer_id=eq.${encodeURIComponent(volunteerId)}&checked_out_at=is.null` +
    `&select=id,checked_in_at&order=checked_in_at.desc&limit=1`
  );
  return (Array.isArray(rows) && rows[0]) || null;
}

function hhmm(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return bad(res, 'Method not allowed', 405);

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return bad(res, 'Server not configured.', 500);
  }
  if (rateLimited(req)) {
    return bad(res, 'Too many attempts. Please wait a minute and try again.', 429);
  }

  const body = req.body || {};
  const action = body.action;
  const token = body.token;

  let ev;
  try {
    ev = await getEventByToken(token);
  } catch (e) {
    console.error('[event-checkin] token lookup failed:', e.message);
    return bad(res, 'Could not check that link. Please try again.', 500);
  }
  if (!ev) {
    return bad(res, 'This event link isn\u2019t valid or has been turned off. Please ask a member of staff for the current QR code.', 404);
  }

  try {
    // ── info ────────────────────────────────────────────────
    if (action === 'info') {
      const orgName = await getOrgName(ev.org_id);
      return res.status(200).json({
        ok: true,
        event: {
          name: ev.name || 'Event',
          date: ev.event_date || null,
          location: ev.location || '',
          org_name: orgName
        }
      });
    }

    // ── feedback ────────────────────────────────────────────
    if (action === 'feedback') {
      const clamp = (v) => {
        const x = parseInt(v, 10);
        return isNaN(x) ? 3 : Math.min(5, Math.max(1, x));
      };
      const trim = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

      await sb('feedback', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          org_id: ev.org_id,
          event_id: ev.id,
          name: trim(body.name, 120),
          enjoyed: clamp(body.enjoyed),
          cb: clamp(body.cb),
          ca: clamp(body.ca),
          learned: !!body.learned,
          connected: !!body.connected,
          friend: !!body.friend,
          quote: trim(body.quote, 2000)
        }])
      });
      return res.status(200).json({ ok: true });
    }

    // ── volunteer check in ──────────────────────────────────
    if (action === 'checkin') {
      const v = await findVolunteer(ev.org_id, body.email);
      // Generic message either way — never reveals whether an email exists.
      if (!v) {
        return bad(res, 'We couldn\u2019t match that email to a registered volunteer for this event. Please check it, or ask a member of staff.', 404);
      }

      const existing = await openSession(ev.org_id, ev.id, v.id);
      if (existing) {
        return res.status(200).json({ ok: true, at: hhmm(existing.checked_in_at), already: true });
      }

      const nowIso = new Date().toISOString();
      await sb('volunteer_checkins', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          org_id: ev.org_id,
          event_id: String(ev.id),
          volunteer_id: String(v.id),
          checked_in_at: nowIso
        }])
      });
      return res.status(200).json({ ok: true, at: hhmm(nowIso), name: v.name || '' });
    }

    // ── volunteer check out ─────────────────────────────────
    if (action === 'checkout') {
      const v = await findVolunteer(ev.org_id, body.email);
      if (!v) {
        return bad(res, 'We couldn\u2019t match that email to a registered volunteer for this event. Please check it, or ask a member of staff.', 404);
      }

      const open = await openSession(ev.org_id, ev.id, v.id);
      if (!open) {
        return bad(res, 'We don\u2019t have you checked in for this event. Tap \u201cCheck in\u201d first, or ask a member of staff to log your hours.', 409);
      }

      const outIso = new Date().toISOString();
      let hours = (new Date(outIso) - new Date(open.checked_in_at)) / 3600000;
      if (!isFinite(hours) || hours <= 0) hours = 0;
      if (hours > MAX_SESSION_HOURS) hours = MAX_SESSION_HOURS; // forgot to check out
      hours = Math.round(hours * 4) / 4;                        // nearest 15 min
      if (hours < 0.25) hours = 0.25;                           // minimum credit

      // Close the session
      await sb(`volunteer_checkins?id=eq.${open.id}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ checked_out_at: outIso, hours: hours })
      });

      // Write the hours into the same log the app reads
      await sb('volunteer_hours', {
        method: 'POST',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify([{
          org_id: ev.org_id,
          volunteer_id: String(v.id),
          event_id: String(ev.id),
          session_date: outIso.slice(0, 10),
          hours: hours,
          activity: ev.name ? ('Checked in at ' + ev.name) : null,
          source: 'qr'
        }])
      });

      return res.status(200).json({ ok: true, hours: hours, name: v.name || '' });
    }

    return bad(res, 'Unknown action.');
  } catch (e) {
    console.error('[event-checkin] ' + action + ' failed:', e.message);
    return bad(res, 'Something went wrong saving that. Please try again, or ask a member of staff.', 500);
  }
};
