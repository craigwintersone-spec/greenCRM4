// /api/sentinel-cron-core.js
// The cheap, fast agents — no web search, runs in ~5-10s on Vercel Hobby.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const { anthropic, MODELS } = require('./_lib/anthropic');
const CLAUDE_MODEL = MODELS.fast;
const TEAMS_LIB = require('./_lib/sentinel-teams.js');
const COST_PER_CALL_PENCE = 1;

async function sbSelect(table, query) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!r.ok) throw new Error(`Supabase ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function sbInsert(table, payload) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Supabase insert ${table} ${r.status}: ${await r.text()}`);
  return r.json();
}

async function logAction(agent, action, detail, orgId, costPence) {
  try {
    await sbInsert('sentinel_actions', [
      { agent, action, detail: detail || null, org_id: orgId || null, cost_pence: costPence || 0 },
    ]);
  } catch (e) {
    console.error('[sentinel] logAction failed:', e.message);
  }
}

async function callClaudeServer(system, prompt, maxTok = 600) {
  // Shared helper: current models, automatic step-down to an older one if needed
  const { status, data } = await anthropic({ model: CLAUDE_MODEL, max_tokens: maxTok, system, messages: [{ role: 'user', content: prompt }] }, { webSearch: false });
  if (status >= 400 || !data || data.type === 'error') throw new Error((data && data.error && data.error.message) || `Claude ${status}`);
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

// ── Activity across everything an organisation can record ─────
// Organisations switch areas on and off (organisations.modules), so a
// circular-only or events-only customer must not look "empty" just
// because it has no participants. Activity = newest record in any
// table that belongs to a switched-on area.
const ACTIVITY_TABLES = [
  { table: 'participants',    module: 'participants', label: 'participants' },
  { table: 'events',          module: 'events',       label: 'events' },
  { table: 'feedback',        module: 'events',       label: 'feedback responses' },
  { table: 'volunteer_hours', module: 'volunteers',   label: 'volunteer sessions' },
  { table: 'circular_items',  module: 'circular',     label: 'circular entries' },
];
function uses(org, mod) { const m = (org && org.modules) || {}; return m[mod] !== false; }

const _activityMemo = {};   // one lookup per organisation per run (Hobby plan time limit)
function orgActivity(org) {
  if (!_activityMemo[org.id]) _activityMemo[org.id] = (async () => {
    const out = { total: 0, last: null, byLabel: {} };
    await Promise.all(ACTIVITY_TABLES.filter(t => uses(org, t.module)).map(async t => {
      try {
        const [rows, cnt] = await Promise.all([
          sbSelect(t.table, `select=created_at&org_id=eq.${org.id}&order=created_at.desc&limit=1`),
          sbCount(t.table, org.id)
        ]);
        if (!rows.length) return;
        out.byLabel[t.label] = cnt;
        out.total += cnt;
        const d = rows[0].created_at;
        if (d && (!out.last || d > out.last)) out.last = d;
      } catch (e) { /* table may not exist on older databases */ }
    }));
    return out;
  })();
  return _activityMemo[org.id];
}
async function sbCount(table, orgId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?select=id&org_id=eq.${orgId}&limit=1`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, Prefer: 'count=exact', Range: '0-0' },
  });
  const cr = r.headers.get('content-range') || '';
  const n = parseInt(cr.split('/')[1], 10);
  return isNaN(n) ? 0 : n;
}
function describeActivity(a) {
  const bits = Object.keys(a.byLabel).map(k => `${a.byLabel[k]} ${k}`);
  return bits.length ? bits.join(', ') : 'no records yet';
}
function describeModules(org) {
  const names = { participants: 'caseload', events: 'events', volunteers: 'volunteers', circular: 'circular economy', funders: 'funders' };
  return Object.keys(names).filter(k => uses(org, k)).map(k => names[k]).join(', ');
}

// A card that is kept up to date: one per issue (by key), closed automatically when the issue goes away
function card(agent, tier, key, orgId, title, description, primary, secondary, extra) {
  return { agent, tier, title, description, primary_action: primary || 'Mark as fixed', secondary_action: secondary || 'Dismiss', org_id: orgId || null, status: 'pending',
    metadata: Object.assign({ guard: true, key, signal: key.split(':')[0] }, extra || {}) };
}

// ── Customers: paying customers who have gone quiet ──
async function runChurnDetector() {
  const orgs = await sbSelect('organisations', 'select=id,name,plan,status,created_at,modules&plan=in.(pro,network,starter,group)');
  const found = [], now = Date.now();
  await Promise.all(orgs.map(orgActivity));
  for (const org of orgs) {
    if (String(org.status || '').toLowerCase() === 'suspended') continue;
    const act = await orgActivity(org);
    if (!act.last) {
      const ageDays = Math.floor((now - new Date(org.created_at).getTime()) / 86400000);
      if (ageDays > 14) found.push(card('Customer Success', 'high', `paid_no_records:${org.id}`, org.id,
        `${org.name} has no records yet — ${ageDays} days since signup`,
        `Paying customer (${TEAMS_LIB.PLAN_NAMES[org.plan] || org.plan}) using ${describeModules(org) || 'no areas'} hasn't added any data. Their onboarding has stalled.`,
        'Send check-in email', 'Schedule call', { age_days: ageDays }));
      continue;
    }
    const daysSince = Math.floor((now - new Date(act.last).getTime()) / 86400000);
    if (daysSince > 21) found.push(card('Customer Success', daysSince > 35 ? 'urgent' : 'high', `quiet_customer:${org.id}`, org.id,
      `${org.name} silent for ${daysSince} days`,
      `Nothing new recorded in ${daysSince} days across ${describeModules(org) || 'their areas'} (${describeActivity(act)}). ${TEAMS_LIB.PLAN_NAMES[org.plan] || org.plan} plan. A churn risk.`,
      'Send check-in email', 'Call instead', { days_since_last: daysSince }));
  }
  await logAction('Customer Success', 'Ran churn scan', `${orgs.length} paying customers reviewed · ${found.length} flagged`, null, 0);
  return found;
}

// ── Onboarding: new sign-ups that haven't started ──
async function runOnboardingScan() {
  const orgs = await sbSelect('organisations', 'select=id,name,plan,status,created_at,modules');
  const found = [];
  await Promise.all(orgs.map(orgActivity));
  for (const org of orgs) {
    const ageDays = Math.floor((Date.now() - new Date(org.created_at).getTime()) / 86400000);
    if (ageDays < 3 || ageDays > 30) continue;
    const act = await orgActivity(org);
    if (!act.last) found.push(card('Onboarding', ageDays > 10 ? 'high' : 'medium', `not_started:${org.id}`, org.id,
      `${org.name} signed up ${ageDays} days ago and hasn't recorded anything`,
      `${TEAMS_LIB.PLAN_NAMES[org.plan] || 'Trial'} · uses ${describeModules(org) || 'no areas yet'}. A short call to set up their first event or contract usually gets them going.`,
      'Send setup email', 'Book a setup call', { age_days: ageDays }));
  }
  await logAction('Onboarding', 'Ran onboarding scan', `${orgs.length} customers · ${found.length} new sign-ups not started`, null, 0);
  return found;
}

// ── Patterns across customers, filed with the team that owns them ──
async function runInsights() {
  const orgs = await sbSelect('organisations', 'select=id,name,plan,sector,created_at,modules');
  const contracts = await sbSelect('contracts', 'select=org_id,target_outcomes,actual_outcomes&limit=500');
  const active = {};
  await Promise.all(orgs.map(async o => { const a = await orgActivity(o); if (a.last) active[o.id] = a; }));
  const total = orgs.length;
  const paying = orgs.filter(o => ['pro', 'network', 'starter', 'group'].includes(o.plan)).length;
  const free = orgs.filter(o => o.plan === 'free' || !o.plan).length;
  const empty = orgs.filter(o => !active[o.id]).length;
  const emptyPct = total ? Math.round((empty / total) * 100) : 0;
  const found = [];
  if (emptyPct >= 40) found.push(card('Onboarding', 'medium', 'insight_empty_orgs', null, `${emptyPct}% of customers have no records yet`,
    `${empty} of your ${total} customers haven't recorded anything in the areas they use. Getting from sign-up to first use is the biggest leak.`, 'Draft onboarding fix', 'Dismiss', { kind: 'insight' }));
  if (free > paying && total >= 3) found.push(card('Finance', 'medium', 'insight_low_conversion', null, `More on trial than paying (${free} vs ${paying})`,
    'Trial to paid is the bottleneck. Worth reviewing the path from trial to a paid plan.', 'Review upgrade flow', 'Dismiss', { kind: 'insight' }));
  const under = contracts.filter(c => c.target_outcomes && c.actual_outcomes < c.target_outcomes * 0.6).length;
  if (under >= 1) found.push(card('Customer Success', 'medium', 'insight_contracts_under', null, `${under} customer contract${under === 1 ? '' : 's'} below 60% of target`,
    'Customers struggling to hit funder outcomes. A check-in now helps them before their funder notices.', 'See which', 'Dismiss', { kind: 'insight' }));
  await logAction('Insights', 'Looked for patterns across customers', `${found.length} pattern${found.length === 1 ? '' : 's'}`, null, 0);
  return found;
}

// ── Sales & Funding: deals with a next step due, sent emails with no follow-up ──
async function runPipelineChecks() {
  let rows = [];
  try { rows = await sbSelect('sentinel_outreach', 'select=id,kind,target_name,status,created_at,metadata&kind=in.(sales,deal,grant)&limit=2000'); } catch (e) { return []; }
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }), found = [];
  rows.forEach(r => {
    const m = r.metadata || {}, nm = r.target_name || 'A prospect';
    if (r.kind === 'deal' && !/^(won|lost)$/i.test(r.status || '') && m.next_date && m.next_date <= today)
      found.push(card('Sales', m.next_date < today ? 'high' : 'medium', `deal_due:${r.id}`, null, `${nm}: ${m.next_step || 'next step'} ${m.next_date < today ? 'was due ' + new Date(m.next_date + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : 'is due today'}`,
        `Stage: ${r.status || 'talking'}.${m.notes ? ' ' + m.notes : ''}`, 'Done — update it', 'Dismiss', { deal_id: r.id }));
    const age = Math.floor((Date.now() - new Date(m.sent_at || r.created_at)) / 864e5);
    if (r.kind === 'sales' && r.status === 'sent' && !m.replied && !m.followed_up && age >= 10 && age <= 45)
      found.push(card('Sales', 'medium', `follow_up:${r.id}`, null, `Follow up ${nm}: cold email sent ${age} days ago, no reply logged`, 'A short second email doubles the reply rate.', 'Followed up', 'Dismiss', { outreach_id: r.id }));
  });
  return found;
}

// ── The morning briefing, team by team ──
async function runChiefOfStaffBriefing(pending, shipped) {
  const orgs = await sbSelect('organisations', 'select=id,name,sector,plan,status,created_at,modules&order=created_at.desc');
  const live = orgs.filter(o => String(o.status || '').toLowerCase() !== 'suspended');
  const paid = live.filter(o => TEAMS_LIB.PRICES[o.plan] > 0 && String(o.status || '').toLowerCase() !== 'trial');
  const mrr = paid.reduce((a, o) => a + TEAMS_LIB.PRICES[o.plan], 0);
  const trials = live.filter(o => o.plan === 'free' || !o.plan || String(o.status || '').toLowerCase() === 'trial');
  const newThisWeek = orgs.filter(o => Date.now() - new Date(o.created_at).getTime() < 7 * 864e5).length;
  let deals = [];
  try { deals = await sbSelect('sentinel_outreach', 'select=target_name,status,metadata&kind=eq.deal&limit=500'); } catch (e) { deals = []; }
  const openDeals = deals.filter(d => !/^(won|lost)$/i.test(d.status || ''));

  const byTeam = {};
  TEAMS_LIB.TEAMS.forEach(t => { byTeam[t.id] = { name: t.name, cards: [] }; });
  (pending || []).forEach(d => { const k = TEAMS_LIB.teamOf(d); (byTeam[k] || byTeam.customers).cards.push(d); });
  const tierRank = { urgent: 0, high: 1, medium: 2, low: 3 };
  const teamLines = TEAMS_LIB.TEAMS.map(t => {
    const c = byTeam[t.id].cards.slice().sort((a, b) => (tierRank[a.tier] ?? 4) - (tierRank[b.tier] ?? 4));
    const urgent = c.filter(x => x.tier === 'urgent').length, high = c.filter(x => x.tier === 'high').length;
    let facts = '';
    if (t.id === 'finance') facts = `MRR £${mrr.toLocaleString('en-GB')} from ${paid.length} paying; ${trials.length} on trial. `;
    if (t.id === 'onboarding') facts = `${newThisWeek} new sign-up${newThisWeek === 1 ? '' : 's'} this week. `;
    if (t.id === 'sales') facts = `${openDeals.length} open deal${openDeals.length === 1 ? '' : 's'}${openDeals.length ? ' (' + openDeals.slice(0, 5).map(d => d.target_name + ': ' + (d.status || 'talking')).join('; ') + ')' : ''}. `;
    if (t.id === 'product' && shipped) facts = `${shipped} change${shipped === 1 ? '' : 's'} shipped in the last 7 days. `;
    return `${t.name}: ${facts}${c.length} open card${c.length === 1 ? '' : 's'} (${urgent} urgent, ${high} high)` + (c.length ? `. Top: ${c.slice(0, 3).map(x => x.title).join(' | ')}` : '');
  });

  const sys = 'You are the Chief of Staff for a solo founder running Vorlana, a UK software company for charities. Write his morning briefing in clean British English, team by team. ' +
    'Format exactly: one line per team, starting with the team name in bold and a colon (**Customers:** …), one sentence each, saying the state of that team and the one thing that matters; ' +
    'then a blank line and **Today:** followed by the three most important things to do today, as three short numbered lines, urgent safety and data issues first. ' +
    'Use only the facts given; never invent customers, numbers or activity. If a team has nothing open, say it is clear in a few words. No headings, no hashtags, no other markdown. Under 220 words.';
  const prompt = `Today: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' })}\n\n` + teamLines.join('\n');
  let narrative = '';
  try {
    narrative = await callClaudeServer(sys, prompt, 600);
    await logAction('Chief of Staff', 'Wrote the morning briefing by team', `${(pending || []).length} open cards across ${TEAMS_LIB.TEAMS.length} teams`, null, COST_PER_CALL_PENCE);
  } catch (e) {
    narrative = teamLines.map(l => '**' + l.replace(/:/, ':**')).join('\n');   // the facts, unwritten, rather than nothing
  }
  const teams = {};
  TEAMS_LIB.TEAMS.forEach(t => { const c = byTeam[t.id].cards; teams[t.id] = { open: c.length, urgent: c.filter(x => x.tier === 'urgent').length, high: c.filter(x => x.tier === 'high').length }; });
  const urgentAll = (pending || []).filter(d => d.tier === 'urgent').length;
  const briefing = {
    headline: `£${mrr.toLocaleString('en-GB')} MRR · ${paid.length} paying · ${trials.length} on trial · ${urgentAll} urgent`,
    narrative,
    stats: { mrr, paid_orgs: paid.length, trial_orgs: trials.length, total_orgs: orgs.length, new_this_week: newThisWeek, open_deals: openDeals.length, shipped_7d: shipped || 0, teams, generated_at: new Date().toISOString() },
    status: 'ready',
  };
  await sbInsert('sentinel_briefings', [briefing]);
  return { mrr, paid: paid.length, briefing, teams: TEAMS_LIB.TEAMS.map(t => Object.assign({ name: t.name }, teams[t.id])) };
}

module.exports = async function handler(req, res) {
  if (!(await TEAMS_LIB.allowed(req))) return res.status(401).json({ error: 'Unauthorized' });
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) return res.status(500).json({ error: 'Missing env vars' });

  const results = { errors: [] };
  const guard = require('./_lib/sentinel-guard.js');
  let found = [];
  const run = async (name, agent, fn) => { try { const f = await fn(); if (Array.isArray(f)) found = found.concat(f); return f; } catch (e) { results.errors.push({ agent: name, team: agent, error: e.message }); return null; } };

  await run('checks', 'Customer Success', () => guard.runGuard());          // first: quick, and it should run even if a later agent is slow
  await run('churn', 'Customer Success', runChurnDetector);
  await run('onboarding', 'Onboarding', runOnboardingScan);
  await run('insights', 'Insights', runInsights);
  await run('pipeline', 'Sales', runPipelineChecks);

  // jobs that act rather than report
  try { results.reports = await require('./_lib/report-reminders.js').runReportReminders(); } catch (e) { results.errors.push({ agent: 'reports', error: e.message }); }
  try { results.volunteerAutoOut = (await require('./_lib/volunteer-autoout.js').closePlannedShifts()).length; } catch (e) { results.errors.push({ agent: 'volunteer-auto-out', error: e.message }); }
  try { results.volunteerReminders = await require('./_lib/daily-brief.js').runVolunteerReminders(); } catch (e) { results.errors.push({ agent: 'volunteer-reminders', error: e.message }); }
  try { results.dailyBriefs = await require('./_lib/daily-brief.js').runDailyBriefs(); } catch (e) { results.errors.push({ agent: 'daily-briefs', error: e.message }); }
  try { results.bookingReminders = await require('./_lib/booking-mail.js').runBookingReminders(); } catch (e) { results.errors.push({ agent: 'booking-reminders', error: e.message }); }

  // the cards: new issues added, old ones left alone, fixed ones closed (but nothing is closed on a morning an agent failed)
  try { results.cards = await guard.syncDecisions(found.concat(guard.agentFailures(results.errors)), { closeGone: !results.errors.length }); }
  catch (e) { results.errors.push({ agent: 'cards', error: e.message }); }
  try { results.shipped = await guard.shippedThisWeek(); } catch (e) { /* not essential */ }

  // the briefing last, so it sees every team's cards as they now stand
  try {
    const pending = await sbSelect('sentinel_decisions', 'select=agent,tier,title,description,metadata&status=eq.pending&limit=2000');
    const b = await runChiefOfStaffBriefing(pending, results.shipped);
    results.briefing = { mrr: b.mrr, paid: b.paid };
    // …and to your inbox, once a day
    const teamName = d => (TEAMS_LIB.TEAMS.find(t => t.id === TEAMS_LIB.teamOf(d)) || {}).name;
    const urgent = pending.filter(d => d.tier === 'urgent').map(d => Object.assign({ team: teamName(d) }, d));
    const fresh = ((results.cards && results.cards.fresh) || []).map(d => Object.assign({ team: teamName(d) }, d));
    try { results.email = await require('./_lib/sentinel-mail.js').sendBriefingEmail({ briefing: b.briefing, teams: b.teams, urgent, fresh, force: /[?&]email=force\b/.test(req.url || '') }); }
    catch (e) { results.errors.push({ agent: 'email', error: e.message }); }
  } catch (e) { results.errors.push({ agent: 'briefing', error: e.message }); }
  if (results.cards) delete results.cards.fresh;

  return res.status(200).json({ ok: true, ...results });
};
