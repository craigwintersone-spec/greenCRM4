// /api/_lib/daily-brief.js — the morning checks, emailed to managers (run by the 06:00 job in sentinel-cron-core)
// The same checks as "Today's checks" on the Dashboard (js/extensions/ai-office.js), worked out here from the
// database so nobody has to open Vorlana first. One email a day per organisation, and only when there is
// something to act on. Demo accounts only while this is tested (organisations.settings.demo_account = true).
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');
const MONTHS = { month: 1, quarter: 3, half: 6, year: 12 };

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}`);
  return b;
}
const opt = async path => { try { return (await sb(path)) || []; } catch (e) { return []; } };      // a table that isn't there yet is just empty
const day = d => new Date(d).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(new Date(d).getTime() + n * 864e5);
const addMonths = (d, n) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
const fmt = d => new Date(String(d).length === 10 ? d + 'T00:00:00Z' : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const gbp = v => '£' + Math.round(+v || 0).toLocaleString('en-GB');
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const num = v => +v || 0;

function elapsed(c, now) {
  if (!c.start_date || !c.end_date) return null;
  const a = new Date(c.start_date), b = new Date(c.end_date); if (isNaN(a) || isNaN(b) || b <= a) return null;
  return Math.max(0, Math.min(100, Math.round((now - a) / (b - a) * 100)));
}
function nextDue(c, t) {
  const n = MONTHS[c.report_every || 'quarter']; if (!n || !c.start_date) return null;
  const start = new Date(c.start_date + 'T00:00:00Z'); if (isNaN(start)) return null;
  const end = c.end_date ? new Date(c.end_date + 'T00:00:00Z') : addMonths(new Date(), 12);
  for (let from = start, i = 0; from <= end && i < 120; i++, from = addMonths(from, n)) {
    let to = addDays(addMonths(from, n), -1); if (to > end) to = end;
    const due = day(addDays(to, c.report_due_days || 0));
    if (due >= t) return { from: day(from), to: day(to), due, hasDue: !!c.report_due_days };
  }
  return null;
}

// pure: the checks for one organisation's rows (also used by the tests)
function buildChecks(d, now) {
  now = now || new Date();
  const out = [], t = day(now), mods = d.modules || {}, uses = k => mods[k] !== false;
  const C = uses('funders') ? (d.contracts || []).filter(c => c.status !== 'closed') : [];
  C.forEach(c => {
    if ((c.report_every || 'quarter') !== 'off') { const p = nextDue(c, t); if (p && p.due <= day(addDays(now, 14))) out.push({ lvl: p.due <= day(addDays(now, 5)) ? 'red' : 'amber', text: `Report for ${c.name} (${fmt(p.from)} to ${fmt(p.to)}) ${p.hasDue ? 'is due' : 'period ends'} ${fmt(p.due)}` }); }
    if (c.end_date && c.end_date >= t && c.end_date <= day(addDays(now, 90))) out.push({ lvl: 'amber', text: `${c.name} ends ${fmt(c.end_date)}: time to line up renewal or the next funder` });
    const el = elapsed(c, now);
    if (el != null && el >= 15) [['starts', c.target_starts, c.actual_starts], ['outcomes', c.target_outcomes, c.actual_outcomes]].forEach(x => {
      if (num(x[1]) > 0) { const pc = Math.round(num(x[2]) / num(x[1]) * 100); if (pc < el - 10) out.push({ lvl: pc < el - 25 ? 'red' : 'amber', text: `${c.name}: ${num(x[2])} of ${num(x[1])} ${x[0]} (${pc}%) with ${el}% of the contract gone` }); }
    });
    const lines = (d.lines || []).filter(l => String(l.contract_id) === String(c.id));
    lines.forEach(l => { const spent = (d.spend || []).filter(s => s.line_id === l.id).reduce((a, s) => a + num(s.amount), 0); if (num(l.amount) && spent > num(l.amount)) out.push({ lvl: 'red', text: `${c.name}: ${l.name} is overspent, ${gbp(spent)} of ${gbp(l.amount)}` }); });
  });
  (d.bids || []).forEach(b => { if (b.status !== 'drafted') return; const m = String(b.deadline || '').match(/^\d{4}-\d{2}-\d{2}/); const dl = m ? m[0] : (isNaN(new Date(b.deadline)) ? null : day(new Date(b.deadline)));
    if (dl && dl >= t && dl <= day(addDays(now, 21))) out.push({ lvl: dl <= day(addDays(now, 7)) ? 'red' : 'amber', text: `Bid to ${b.funder} closes ${fmt(dl)} and is still a draft` }); });
  if (uses('participants')) {
    const sg = (d.participants || []).filter(p => p.stage !== 'Closed' && (p.safeguarding || p.risk === 'High') && (!p.last_contact || (now - new Date(p.last_contact)) / 864e5 > 14));
    if (sg.length) out.push({ lvl: 'red', text: `${sg.length} high-risk or safeguarding ${sg.length === 1 ? 'person has' : 'people have'} had no contact for 14+ days` });   // no names by email
  }
  if (uses('volunteers') && (d.hours || []).length) {
    const from = day(addDays(now, -30)), act = {}; d.hours.forEach(h => { if (String(h.date || h.shift_date || '').slice(0, 10) >= from) act[String(h.volunteer_id)] = 1; });
    const quiet = (d.volunteers || []).filter(v => (v.status || 'Active') === 'Active' && !act[String(v.id)]);
    if (quiet.length) out.push({ lvl: 'amber', text: `${quiet.length} active volunteer${quiet.length === 1 ? ' has' : 's have'} logged no hours in 30 days` });
  }
  const unth = (d.donations || []).filter(x => !x.thanked_at && x.gift_date && (now - new Date(x.gift_date)) / 864e5 >= 2);
  if (unth.length) out.push({ lvl: 'amber', text: `${unth.length} donation${unth.length === 1 ? '' : 's'} not thanked yet (${gbp(unth.reduce((a, x) => a + num(x.amount), 0))})` });
  const uns = (d.spend || []).filter(s => !s.line_id && !s.ignored);
  if (uns.length) out.push({ lvl: 'amber', text: `${uns.length} payment${uns.length === 1 ? '' : 's'} from the bank to sort (${gbp(uns.reduce((a, s) => a + num(s.amount), 0))})` });
  (d.keyDates || []).forEach(k => { if (k.done_at || !k.due_date) return; if (k.due_date < t) out.push({ lvl: 'red', text: `${k.title} was due ${fmt(k.due_date)}` }); else if (k.due_date <= day(addDays(now, 30))) out.push({ lvl: 'amber', text: `${k.title} is due ${fmt(k.due_date)}` }); });
  const enq = (d.enquiries || []).filter(e => e.status === 'new');
  if (enq.length) out.push({ lvl: 'amber', text: `${enq.length} compan${enq.length === 1 ? 'y has' : 'ies have'} asked about working with you` });
  if (uses('events')) (d.events || []).filter(e => (e.event_date || e.date) >= t && (e.event_date || e.date) <= day(addDays(now, 2))).forEach(e => out.push({ lvl: 'info', text: `${e.name} on ${fmt(e.event_date || e.date)}` }));
  const order = { red: 0, amber: 1, info: 2 };
  return out.sort((a, b) => order[a.lvl] - order[b.lvl]);
}

function emailHTML(org, checks, now) {
  const dot = { red: '#B42318', amber: '#B7791F', info: '#1A56DB' };
  return `<div style="font-family:Arial,Helvetica,sans-serif;color:#1d1d1f;max-width:560px">
    <div style="font-size:13px;color:#6e6e73">${esc(new Date(now).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' }))}</div>
    <h2 style="margin:4px 0 14px;font-size:20px">Good morning. Today at ${esc(org.name)}</h2>
    ${checks.map(c => `<div style="border:1px solid #e5e5ea;border-radius:8px;padding:9px 12px;margin-bottom:6px;font-size:14px"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dot[c.lvl]};margin-right:9px"></span>${esc(c.text)}</div>`).join('')}
    <p style="margin:18px 0"><a href="${APP_URL}/app.html?org_id=${encodeURIComponent(org.id)}" style="background:#1F6F6D;color:#fff;text-decoration:none;border-radius:20px;padding:10px 20px;font-weight:bold;font-size:14px">Open Vorlana</a></p>
    <p style="font-size:12px;color:#6e6e73">People are never named in this email. Open Vorlana to see who.</p></div>`;
}

async function managerEmails(orgId) {
  const ms = await sb(`memberships?org_id=eq.${orgId}&status=eq.active&role=in.(owner,admin,manager)&select=user_id`);
  const out = [];
  for (const m of ms || []) { try { const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${m.user_id}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } }); if (r.ok) { const u = await r.json(); if (u && u.email) out.push(u.email); } } catch (e) { /* skip */ } }
  return [...new Set(out)];
}

async function runDailyBriefs(now) {
  now = now ? new Date(now) : new Date();
  const today = day(now), results = { sent: 0, quiet: 0, skipped: 0, errors: [] };
  if (!RESEND_API_KEY) { results.errors.push('RESEND_API_KEY not set'); return results; }
  const orgs = (await sb('organisations?select=id,name,modules,settings,status&limit=2000')).filter(o => o.status !== 'suspended' && o.settings && o.settings.demo_account === true);
  for (const org of orgs) {
    try {
      if (org.settings.brief_sent === today || org.settings.brief_email === false) { results.skipped++; continue; }
      const o = `org_id=eq.${org.id}`;
      const [contracts, participants, volunteers, hours, donations, lines, spend, bids, keyDates, enquiries, events] = await Promise.all([
        opt(`contracts?${o}&select=*`), opt(`participants?${o}&select=stage,risk,safeguarding,last_contact`), opt(`volunteers?${o}&select=id,status`), opt(`volunteer_hours?${o}&select=*&limit=5000`),
        opt(`donations?${o}&select=amount,gift_date,thanked_at`), opt(`budget_lines?${o}&select=*`), opt(`budget_spend?${o}&select=line_id,amount,ignored`), opt(`bids?${o}&select=funder,deadline,status`),
        opt(`key_dates?${o}&select=*`), opt(`company_enquiries?${o}&select=status`), opt(`events?${o}&event_date=gte.${today}&select=name,event_date&limit=50`)]);
      const checks = buildChecks({ modules: org.modules, contracts, participants, volunteers, hours, donations, lines, spend, bids, keyDates, enquiries, events }, now);
      if (!checks.some(c => c.lvl !== 'info')) { results.quiet++; continue; }                     // nothing to act on: no email
      const to = await managerEmails(org.id); if (!to.length) { results.skipped++; continue; }
      const urgent = checks.filter(c => c.lvl === 'red').length, n = checks.filter(c => c.lvl !== 'info').length;
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Vorlana <hello@vorlana.com>', to, subject: `${org.name}: ${n} thing${n === 1 ? '' : 's'} for today${urgent ? ' (' + urgent + ' urgent)' : ''}`, html: emailHTML(org, checks, now) }) });
      if (!r.ok) throw new Error('Resend ' + r.status);
      await sb(`organisations?id=eq.${org.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ settings: Object.assign({}, org.settings, { brief_sent: today }) }) });
      results.sent++;
    } catch (e) { results.errors.push(org.name + ': ' + e.message); }
  }
  return results;
}

module.exports = { runDailyBriefs, buildChecks, emailHTML };
