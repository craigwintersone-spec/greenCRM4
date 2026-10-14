// /api/_lib/report-reminders.js — zero-touch funder reports
// Once a day: for every live contract, work out the reporting period that has just ended (or ends this week).
// If nobody has been told about it yet, email the organisation's managers one link. Opening the link writes the
// report for them. Nothing to set up: every contract reports quarterly from its start date unless told otherwise.

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = process.env.APP_URL || 'https://www.vorlana.com';
const MONTHS = { month: 1, quarter: 3, half: 6, year: 12 };

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && b.message) || ''}`);
  return b;
}
const day = d => new Date(d).toISOString().slice(0, 10);
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const fmt = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

// The latest period (aligned to the contract's start date) that ends on or before `horizon`.
function latestPeriod(contract, today, horizonDays) {
  const every = contract.report_every || 'quarter';
  const n = MONTHS[every]; if (!n) return null;                                   // 'off'
  const start = contract.start_date ? new Date(contract.start_date + 'T00:00:00Z') : new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  if (isNaN(start)) return null;
  const horizon = new Date(today.getTime() + horizonDays * 864e5);
  let from = start, to = new Date(addMonths(start, n).getTime() - 864e5), last = null;
  while (to <= horizon) { last = { from: day(from), to: day(to) }; from = addMonths(from, n); to = new Date(addMonths(from, n).getTime() - 864e5); }
  if (last && contract.end_date && last.from > contract.end_date) return null;       // the contract was over before this period
  return last;
}

async function managerEmails(orgId) {
  const ms = await sb(`memberships?org_id=eq.${orgId}&status=eq.active&role=in.(owner,admin,manager)&select=user_id`);
  const out = [];
  for (const m of ms || []) {
    try {
      const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${m.user_id}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
      if (r.ok) { const u = await r.json(); if (u && u.email) out.push(u.email); }
    } catch (e) { /* skip */ }
  }
  return [...new Set(out)];
}

async function sendMail(to, subject, html) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not set');
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Vorlana <hello@vorlana.com>', to, subject, html }) });
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + await r.text());
}

async function runReportReminders(now) {
  const today = now ? new Date(now) : new Date();
  const todayStr = day(today);
  const contracts = await sb(`contracts?select=id,org_id,name,funder,report_type,start_date,end_date,status,report_every,report_reminded&status=neq.closed`);
  const results = { checked: 0, sent: 0, skipped: 0, errors: [] };
  const orgNames = {};
  for (const c of contracts || []) {
    results.checked++;
    try {
      if ((c.report_every || 'quarter') === 'off') { results.skipped++; continue; }
      const p = latestPeriod(c, today, 7); if (!p) { results.skipped++; continue; }
      const key = p.from + '_' + p.to;
      if (c.report_reminded === key) { results.skipped++; continue; }                    // already told
      if ((today.getTime() - new Date(p.to + 'T00:00:00Z').getTime()) / 864e5 > 45) {    // too old to chase: mark and move on
        await sb(`contracts?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ report_reminded: key }) });
        results.skipped++; continue;
      }
      const to = await managerEmails(c.org_id); if (!to.length) { results.skipped++; continue; }
      if (!orgNames[c.org_id]) { const o = await sb(`organisations?id=eq.${c.org_id}&select=name`); orgNames[c.org_id] = (o && o[0] && o[0].name) || 'your organisation'; }
      const link = `${APP_URL}/app.html#reports?contract=${encodeURIComponent(c.id)}&from=${p.from}&to=${p.to}`;
      const funder = c.funder || c.name || 'your funder';
      const ended = new Date(p.to + 'T00:00:00Z') <= today;
      const subject = `Your ${funder} report for ${fmt(p.from)} to ${fmt(p.to)} is ready`;
      const html = `<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#222;max-width:560px">
<p>Hello,</p>
<p>The reporting period for <b>${funder}</b> (${c.name || ''}) ${ended ? 'ended' : 'ends'} on <b>${fmt(p.to)}</b>.</p>
<p>Your report is written and waiting. Open it, read it, and send it on.</p>
<p style="margin:22px 0"><a href="${link}" style="background:#1F6F6D;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:bold">Open my ${funder} report</a></p>
<p style="font-size:13px;color:#666">Every number is calculated from ${orgNames[c.org_id]}'s records in Vorlana and checked before you see it. Funders usually want a report within a month of the period ending.</p>
<p style="font-size:12px;color:#999">Vorlana sends this once per reporting period. To change how often ${funder} needs a report, open the Reports page.</p></div>`;
      await sendMail(to, subject, html);
      await sb(`contracts?id=eq.${c.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ report_reminded: key }) });
      results.sent++;
    } catch (e) { results.errors.push({ contract: c.id, error: e.message }); }
  }
  return results;
}

module.exports = { runReportReminders, latestPeriod };
