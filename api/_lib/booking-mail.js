// /api/_lib/booking-mail.js — the emails a booker receives, and the day-before reminders (run by the daily Sentinel job)
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && b.message) || ''}`);
  return b;
}
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = p => '\u00a3' + (p / 100).toFixed(p % 100 ? 2 : 0);
function longDate(d) { try { return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' }); } catch (e) { return d; } }
function calendarLink(ev) {
  const d = String(ev.event_date || '').replace(/-/g, ''), t = /^\d{1,2}:\d{2}$/.test(ev.start_time || '') ? ev.start_time.padStart(5, '0').replace(':', '') + '00' : '';
  const dates = t ? `${d}T${t}/${d}T${String(Math.min(23, +t.slice(0, 2) + 2)).padStart(2, '0')}${t.slice(2)}` : `${d}/${d}`;
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(ev.name || 'Event') + '&dates=' + dates + '&location=' + encodeURIComponent(ev.location || '');
}
function people(b) { const a = +b.adults || 0, c = +b.children || 0; return a + ' adult' + (a === 1 ? '' : 's') + (c ? ' and ' + c + ' child' + (c === 1 ? '' : 'ren') : ''); }
function shell(org, title, inner) {
  const colour = /^#[0-9a-f]{3,8}$/i.test(org.brand_color || '') ? org.brand_color : '#1F6F6D';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1A1A1A">
<div style="background:${colour};color:#fff;padding:16px 20px;border-radius:10px 10px 0 0;font-weight:bold;font-size:16px">${esc(org.name || 'Your booking')}</div>
<div style="border:1px solid #E5E1D8;border-top:0;border-radius:0 0 10px 10px;padding:20px">
<h2 style="margin:0 0 12px;font-size:20px">${esc(title)}</h2>${inner}
<p style="color:#8A857A;font-size:12px;margin:18px 0 0">Sent by Vorlana on behalf of ${esc(org.name || 'the organiser')}.</p></div></div>`;
}
function details(ev, b) {
  return `<table style="font-size:14px;border-collapse:collapse;margin:0 0 14px">
<tr><td style="padding:3px 14px 3px 0;color:#6B665C">When</td><td><b>${esc(longDate(ev.event_date))}${ev.start_time ? ', ' + esc(ev.start_time) : ''}</b></td></tr>
${ev.location ? `<tr><td style="padding:3px 14px 3px 0;color:#6B665C">Where</td><td>${esc(ev.location)}</td></tr>` : ''}
<tr><td style="padding:3px 14px 3px 0;color:#6B665C">For</td><td>${esc(people(b))}</td></tr>
${b.amount_pence ? `<tr><td style="padding:3px 14px 3px 0;color:#6B665C">Paid</td><td>${money(b.amount_pence)}</td></tr>` : ''}
</table>`;
}
function links(b, ev) {
  return `<p style="font-size:14px;margin:0 0 6px"><a href="${calendarLink(ev)}" style="color:#1F6F6D">Add it to your calendar</a></p>
<p style="font-size:14px;margin:0">Can't come? <a href="${APP_URL}/whats-on.html?cancel=${encodeURIComponent(b.token)}" style="color:#1F6F6D">Cancel your place</a> so someone else can have it.</p>`;
}
async function sendMail(to, subject, html, orgName) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const from = (orgName ? orgName.replace(/[<>"]/g, '').slice(0, 60) + ' via Vorlana' : 'Vorlana') + ' <hello@vorlana.com>';
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, subject, html }) });
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + await r.text());
}
async function mailBooked(org, ev, b) {
  if (!b.email) return;
  await sendMail(b.email, `You're booked: ${ev.name}`, shell(org, "You're booked", `<p style="font-size:14px">Thanks ${esc(String(b.name || '').split(' ')[0])}, your place is confirmed.</p>${details(ev, b)}<p style="font-size:14px">On the day, scan the QR code at the door. If you booked on this phone, you'll be recognised; otherwise tap "I booked" and enter this email address.</p>${links(b, ev)}`), org.name);
}
async function mailWaitlist(org, ev, b) {
  if (!b.email) return;
  await sendMail(b.email, `You're on the waiting list: ${ev.name}`, shell(org, "You're on the waiting list", `<p style="font-size:14px">${esc(ev.name)} is full at the moment. We'll be in touch if a place comes up.</p>${details(ev, Object.assign({}, b, { amount_pence: 0 }))}`), org.name);
}
async function mailCancelled(org, ev, b) {
  if (!b.email) return;
  await sendMail(b.email, `Cancelled: ${ev.name}`, shell(org, 'Your place is cancelled', `<p style="font-size:14px">Your booking for ${esc(ev.name)} on ${esc(longDate(ev.event_date))} has been cancelled.${b.paid ? ' ' + esc(org.name || 'The organiser') + ' will be in touch about a refund.' : ''}</p>`), org.name);
}

// The day before an event, a short reminder to everyone booked. Called by the daily Sentinel job.
async function runBookingReminders(now) {
  const t = now ? new Date(now) : new Date();
  const tomorrow = new Date(t.getTime() + 864e5).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  const out = { sent: 0, errors: [] };
  let events = [];
  try { events = await sb(`events?event_date=eq.${tomorrow}&select=id,org_id,name,event_date,start_time,location&limit=500`) || []; } catch (e) { out.errors.push(e.message); return out; }
  for (const ev of events) {
    let rows = [];
    try { rows = await sb(`bookings?event_id=eq.${encodeURIComponent(ev.id)}&status=eq.booked&reminded_at=is.null&select=id,token,name,email,adults,children,amount_pence,paid&limit=1000`) || []; } catch (e) { out.errors.push(e.message); continue; }
    if (!rows.length) continue;
    let org = { name: '' }; try { org = (await sb(`organisations?id=eq.${ev.org_id}&select=name,brand_color&limit=1`))[0] || org; } catch (e) { /* plain email */ }
    for (const b of rows) {
      if (!b.email) continue;
      try {
        await sendMail(b.email, `See you tomorrow: ${ev.name}`, shell(org, 'See you tomorrow', `<p style="font-size:14px">A quick reminder about your booking.</p>${details(ev, Object.assign({}, b, { amount_pence: 0 }))}${links(b, ev)}`), org.name);
        await sb(`bookings?id=eq.${b.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ reminded_at: new Date().toISOString() }) });
        out.sent++;
      } catch (e) { out.errors.push(e.message); }
    }
  }
  return out;
}

module.exports = { mailBooked, mailWaitlist, mailCancelled, runBookingReminders, calendarLink };
