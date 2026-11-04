// /api/_lib/volunteer-autoout.js — volunteers who said at check-in how long they'd stay are checked out at that time.
// A shift stays open for the rest of its day, so someone who stays longer and checks out still gets their real time.
// Once the day is over (the daily job, or their next check-in) it is closed at the time they gave, and the hours are logged.
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && b.message) || ''}`);
  return b;
}
const londonDay = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const HOUR_CHOICES = [1, 1.5, 2, 2.5, 3, 3.5, 4, 5, 6, 7, 8];

// Closes planned shifts from earlier days. Optional filters: orgId, volunteerId. Returns the shifts it closed.
async function closePlannedShifts(opts) {
  const o = opts || {}, today = londonDay(new Date().toISOString()), closed = [];
  let rows = [];
  try {
    rows = await sb(`volunteer_checkins?checked_out_at=is.null&planned_out_at=not.is.null` + (o.orgId ? `&org_id=eq.${encodeURIComponent(o.orgId)}` : '') +
      (o.volunteerId ? `&volunteer_id=eq.${encodeURIComponent(o.volunteerId)}` : '') + `&select=id,org_id,volunteer_id,event_id,site_id,checked_in_at,planned_out_at&limit=500`) || [];
  } catch (e) { return closed; }   // the columns aren't there yet: nothing to do
  for (const s of rows) {
    if (londonDay(s.checked_in_at) >= today) continue;   // still their day: they may yet check out with the real time
    let hours = (new Date(s.planned_out_at) - new Date(s.checked_in_at)) / 3600000;
    if (!isFinite(hours) || hours <= 0) continue;
    hours = Math.min(12, Math.max(0.25, Math.round(hours * 4) / 4));
    try {
      const upd = await sb(`volunteer_checkins?id=eq.${s.id}&checked_out_at=is.null`, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ checked_out_at: s.planned_out_at, hours, auto_out: true }) });
      if (!Array.isArray(upd) || !upd.length) continue;   // someone else closed it first
      const row = { org_id: s.org_id, volunteer_id: String(s.volunteer_id), event_id: s.event_id || null, site_id: s.site_id || null, session_date: londonDay(s.checked_in_at), hours, activity: 'Volunteering (checked out automatically)', source: 'qr-auto' };
      try { await sb('volunteer_hours', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) }); }
      catch (e) { if (!/site_id/i.test(e.message || '')) throw e; delete row.site_id; await sb('volunteer_hours', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([row]) }); }
      closed.push({ id: s.id, volunteer_id: String(s.volunteer_id), hours, day: londonDay(s.checked_in_at) });
    } catch (e) { console.error('[volunteer-autoout]', e.message); }
  }
  return closed;
}

module.exports = { closePlannedShifts, HOUR_CHOICES };
