// /api/sentinel-cron.js
// Runs daily at 06:00 via Vercel cron (or manually from the UI).
// Rate-limit aware: Sales + BD spaced 60s apart, smaller token budgets.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CRON_SECRET = process.env.CRON_SECRET || null;

const COST_PER_CALL_PENCE = 1;
const COST_PER_SEARCH_CALL_PENCE = 5;

const WEEKLY_CAP_SALES = 5;
const WEEKLY_CAP_GRANTS = 5;

// Pause between agents that use web search, to stay under input token rate limit (50k/min on tier 1)
const RATE_LIMIT_PAUSE_MS = 65000;

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

async function callClaudeServer(system, prompt, maxTok = 600, useWebSearch = false) {
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: maxTok,
    system,
    messages: [{ role: 'user', content: prompt }],
  };
  if (useWebSearch) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok || data.type === 'error') {
    throw new Error(data.error?.message || `Claude ${r.status}`);
  }
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function extractJSON(text) {
  if (!text) return null;
  const cleaned = text.replace(/```json|```/gi, '').trim();
  const m = cleaned.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// ── AGENT 1 — Chief of Staff briefing ────────────────────────
async function runChiefOfStaffBriefing() {
  const orgs = await sbSelect('organisations', 'select=id,name,sector,plan,status,created_at&order=created_at.desc');
  const counts = await sbSelect('participants', 'select=org_id,created_at&order=created_at.desc&limit=2000');

  const byOrg = {};
  counts.forEach((p) => {
    if (!byOrg[p.org_id]) byOrg[p.org_id] = { total: 0 };
    byOrg[p.org_id].total++;
  });

  const totalOrgs = orgs.length;
  const paidOrgs = orgs.filter((o) => ['pro', 'network', 'starter'].includes(o.plan)).length;
  const trialOrgs = orgs.filter((o) => o.plan === 'free' || o.status === 'trial').length;
  const newThisWeek = orgs.filter((o) => Date.now() - new Date(o.created_at).getTime() < 7*24*60*60*1000).length;

  const orgSummary = orgs.slice(0, 30).map((o) => {
    const c = byOrg[o.id] || { total: 0 };
    return `- ${o.name} (${o.plan || 'free'}, ${o.sector || 'unknown'}): ${c.total} participants`;
  }).join('\n');

  const sys =
    'You are the Chief of Staff for a solo founder running Civara, a UK CRM SaaS for charities. ' +
    'Generate a warm, specific morning briefing in clean British English. Three short sections: ' +
    '1) Overnight summary (2 sentences), 2) What needs attention today (3 bullets max), ' +
    '3) One strategic observation. Use **bold** for emphasis. No hashtags, no markdown headings, ' +
    'no horizontal rules. Max 200 words. Be honest if data is quiet — never invent activity.';

  const prompt =
    `Today: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long' })}\n` +
    `Total customers: ${totalOrgs}\nPaid: ${paidOrgs}\nOn trial: ${trialOrgs}\nNew this week: ${newThisWeek}\n\n` +
    `Customer snapshot:\n${orgSummary}`;

  let narrative = '';
  try {
    narrative = await callClaudeServer(sys, prompt, 400);
    await logAction('Chief of Staff', 'Generated morning briefing', `${totalOrgs} customers reviewed`, null, COST_PER_CALL_PENCE);
  } catch (e) {
    narrative = `Briefing generation failed: ${e.message}.`;
  }

  const headline = `${totalOrgs} customers · ${paidOrgs} paying · ${newThisWeek} new this week`;

  await sbInsert('sentinel_briefings', [{
    headline, narrative,
    stats: { total_orgs: totalOrgs, paid_orgs: paidOrgs, trial_orgs: trialOrgs, new_this_week: newThisWeek, generated_at: new Date().toISOString() },
    status: 'ready',
  }]);

  return { headline, totalOrgs, paidOrgs };
}

// ── AGENT 2 — Customer Success churn ─────────────────────────
async function runChurnDetector() {
  const orgs = await sbSelect('organisations', 'select=id,name,plan,status,created_at&plan=in.(pro,network,starter)');
  const decisions = [];
  const now = Date.now();
  let inactive = 0;

  for (const org of orgs) {
    const ps = await sbSelect('participants', `select=created_at&org_id=eq.${org.id}&order=created_at.desc&limit=1`);
    if (!ps.length) {
      const ageDays = Math.floor((now - new Date(org.created_at).getTime()) / 86400000);
      if (ageDays > 14) {
        decisions.push({
          agent: 'Customer Success', tier: 'high',
          title: `${org.name} has zero participants — ${ageDays} days since signup`,
          description: `Paid customer (${org.plan}) hasn't added any data. Strong onboarding-stalled signal.`,
          primary_action: 'Send check-in email', secondary_action: 'Schedule call',
          org_id: org.id, status: 'pending',
          metadata: { signal: 'onboarding_stalled', age_days: ageDays },
        });
        inactive++;
      }
      continue;
    }
    const daysSince = Math.floor((now - new Date(ps[0].created_at).getTime()) / 86400000);
    if (daysSince > 21) {
      decisions.push({
        agent: 'Customer Success', tier: daysSince > 35 ? 'urgent' : 'high',
        title: `${org.name} silent for ${daysSince} days`,
        description: `No new participant data in ${daysSince} days. ${org.plan} plan. Pattern suggests churn risk.`,
        primary_action: 'Send check-in email', secondary_action: 'Call instead',
        org_id: org.id, status: 'pending',
        metadata: { signal: 'inactivity', days_since_last: daysSince },
      });
      inactive++;
    }
  }

  if (decisions.length) await sbInsert('sentinel_decisions', decisions);
  await logAction('Customer Success', 'Ran churn scan', `${orgs.length} customers reviewed · ${inactive} flagged`, null, 0);
  return { count: decisions.length };
}

// ── AGENT 3 — Onboarding scan ────────────────────────────────
async function runOnboardingScan() {
  const orgs = await sbSelect('organisations', 'select=id,name,plan,status,created_at');
  let stalled = 0;
  for (const org of orgs) {
    const ageDays = Math.floor((Date.now() - new Date(org.created_at).getTime()) / 86400000);
    if (ageDays > 3 && ageDays <= 14) {
      const ps = await sbSelect('participants', `select=id&org_id=eq.${org.id}&limit=1`);
      if (!ps.length) stalled++;
    }
  }
  await logAction('Onboarding', 'Ran onboarding scan', `${orgs.length} customers · ${stalled} not activated`, null, 0);
  return { stalled };
}

// ── AGENT 4 — Cross-domain insights ──────────────────────────
async function runInsights() {
  const orgs = await sbSelect('organisations', 'select=id,name,plan,sector,created_at');
  const ps = await sbSelect('participants', 'select=org_id&limit=2000');
  const contracts = await sbSelect('contracts', 'select=org_id,target_outcomes,actual_outcomes&limit=500');

  const byOrgP = {};
  ps.forEach((p) => { byOrgP[p.org_id] = (byOrgP[p.org_id] || 0) + 1; });

  const total = orgs.length;
  const paying = orgs.filter((o) => ['pro', 'network', 'starter'].includes(o.plan)).length;
  const free = orgs.filter((o) => o.plan === 'free' || !o.plan).length;
  const empty = orgs.filter((o) => !byOrgP[o.id]).length;
  const emptyPct = total ? Math.round((empty / total) * 100) : 0;

  const insights = [];
  if (emptyPct >= 40) insights.push({
    agent: 'Insights', tier: 'medium',
    title: `${emptyPct}% of customers have zero participants`,
    description: `${empty} of your ${total} customers haven't added participant data. Onboarding-to-activation is your biggest leak.`,
    primary_action: 'Draft onboarding fix', secondary_action: 'Email affected customers',
    status: 'pending', metadata: { kind: 'insight', signal: 'empty_orgs', empty_pct: emptyPct },
  });
  if (free > paying && total >= 3) insights.push({
    agent: 'Insights', tier: 'medium',
    title: `More free than paying (${free} vs ${paying})`,
    description: `Trial conversion is your bottleneck. Worth reviewing the path from free trial to paid.`,
    primary_action: 'Review upgrade flow', secondary_action: 'Dismiss',
    status: 'pending', metadata: { kind: 'insight', signal: 'low_conversion' },
  });
  const under = contracts.filter((c) => c.target_outcomes && c.actual_outcomes < c.target_outcomes * 0.6).length;
  if (under >= 1) insights.push({
    agent: 'Insights', tier: 'medium',
    title: `${under} contract${under === 1 ? '' : 's'} below 60% of target`,
    description: `Customers struggling to hit funder outcomes. Forecasting agent (Pro+) would catch this in week 6.`,
    primary_action: 'Promote forecasting', secondary_action: 'Dismiss',
    status: 'pending', metadata: { kind: 'insight', signal: 'contract_underperformance' },
  });

  if (insights.length) await sbInsert('sentinel_decisions', insights);
  await logAction('Insights', 'Generated cross-domain patterns', `${insights.length} insight${insights.length === 1 ? '' : 's'} surfaced`, null, 0);
  return { count: insights.length };
}

async function getRecentOutreach(kind, daysBack = 90) {
  const cutoff = new Date(Date.now() - daysBack * 86400000).toISOString();
  return await sbSelect('sentinel_outreach', `select=target_key&kind=eq.${kind}&created_at=gte.${cutoff}`);
}

async function getThisWeekCount(kind) {
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const rows = await sbSelect('sentinel_outreach', `select=id&kind=eq.${kind}&created_at=gte.${cutoff}`);
  return rows.length;
}

// ── AGENT 5 — Sales (cold prospect outreach) ─────────────────
async function runSalesAgent() {
  const thisWeek = await getThisWeekCount('sales');
  const remaining = WEEKLY_CAP_SALES - thisWeek;

  if (remaining <= 0) {
    await logAction('Sales', 'Skipped run', `Weekly cap reached (${thisWeek}/${WEEKLY_CAP_SALES})`, null, 0);
    return { drafted: 0, skipped: 'weekly_cap' };
  }

  const recent = await getRecentOutreach('sales', 90);
  const recentKeys = new Set(recent.map((r) => r.target_key));

  // Tighter prompt to keep input tokens low
  const findSys =
    'Find UK charities to pitch a charity CRM to. Return JSON array only, no prose. ' +
    `Up to ${Math.min(remaining + 2, 6)} items. Each: ` +
    '{"name":"...","website":"...","why_fit":"1 line","recent_signal":"1 line if known","contact_hint":"role"}. ' +
    'Focus: small charities (5-30 staff) in employability, youth, justice, circular economy, registered or funded recently.';

  const findPrompt =
    'Civara CRM with built-in AI agents. £29-£249/mo. ICP: small UK charities holding public funder contracts (MoJ, GLA, City Bridge, Lottery, Trust for London).';

  let candidates = [];
  let findCost = 0;
  let searchReturnedAnything = false;
  try {
    const raw = await callClaudeServer(findSys, findPrompt, 1200, true);
    findCost = COST_PER_SEARCH_CALL_PENCE;
    candidates = extractJSON(raw) || [];
    searchReturnedAnything = candidates.length > 0;
  } catch (e) {
    await logAction('Sales', 'Search failed', e.message, null, 0);
    return { drafted: 0, error: e.message };
  }

  // Honest reporting: distinguish "search empty" from "all duplicates"
  const fresh = candidates
    .filter((c) => c && c.name && !recentKeys.has(slugify(c.name)))
    .slice(0, remaining);

  if (!searchReturnedAnything) {
    await logAction('Sales', 'Search returned empty', `Web search did not find suitable candidates this run`, null, findCost);
    return { drafted: 0, reason: 'empty_search' };
  }
  if (!fresh.length) {
    await logAction('Sales', 'All candidates were duplicates', `${candidates.length} found, all already drafted in last 90 days`, null, findCost);
    return { drafted: 0, reason: 'all_duplicates' };
  }

  const draftSys =
    'Write a cold email from Craig (UK charity-CRM founder) to a charity CEO. ' +
    'First line "Subject: ..." then blank line then 100-130 word email. Warm, specific, British English, no fluff. ' +
    'Reference the charity\'s recent signal. Mention Civara saves 5-10 hours/week of admin via built-in AI. ' +
    'Soft CTA: "worth a 15-min call?". Sign "Craig". No emoji.';

  const drafted = [];
  for (const c of fresh) {
    try {
      const draftPrompt =
        `Charity: ${c.name}\nWebsite: ${c.website || 'unknown'}\nSignal: ${c.recent_signal || 'unknown'}\n` +
        `Contact: ${c.contact_hint || 'CEO'}\nFit: ${c.why_fit || ''}`;
      const raw = await callClaudeServer(draftSys, draftPrompt, 400, false);

      const lines = raw.split('\n');
      const subjectLine = lines.find((l) => /^subject:/i.test(l)) || 'Subject: A quick question about your work';
      const subject = subjectLine.replace(/^subject:\s*/i, '').trim();
      const body = raw.replace(/^subject:.*\n+/i, '').trim();

      const fit = (c.recent_signal && c.recent_signal.length > 20) ? 8 : 6;

      const outreachRow = await sbInsert('sentinel_outreach', [{
        kind: 'sales',
        target_key: slugify(c.name),
        target_name: c.name,
        fit_score: fit,
        fit_reason: c.why_fit || null,
        draft_subject: subject,
        draft_body: body,
        source_url: c.website || null,
        status: 'drafted',
        metadata: { contact_hint: c.contact_hint || null, recent_signal: c.recent_signal || null },
      }]);
      const outId = outreachRow && outreachRow[0] && outreachRow[0].id;

      await sbInsert('sentinel_decisions', [{
        agent: 'Sales',
        tier: fit >= 8 ? 'high' : 'medium',
        title: `Cold prospect drafted: ${c.name}`,
        description: `${c.why_fit || 'UK charity matching ICP'}. ${c.recent_signal ? 'Signal: ' + c.recent_signal : ''} Fit ${fit}/10.`,
        primary_action: 'View & copy draft',
        secondary_action: 'Skip this one',
        status: 'pending',
        metadata: {
          kind: 'outreach', outreach_id: outId, outreach_kind: 'sales',
          subject, body, target_name: c.name, source_url: c.website || null,
        },
      }]);

      drafted.push(c.name);
      // Pause between draft calls — gentler on rate limit
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.warn(`[sentinel] draft failed for ${c.name}: ${e.message}`);
    }
  }

  const totalCost = findCost + drafted.length * COST_PER_CALL_PENCE;
  await logAction('Sales', 'Drafted cold outreach', `${drafted.length} prospects: ${drafted.join(', ')}`, null, totalCost);

  return { drafted: drafted.length, names: drafted };
}

// ── AGENT 6 — BD Researcher (grants for Civara) ──────────────
async function runBDResearcher() {
  const thisWeek = await getThisWeekCount('grant');
  const remaining = WEEKLY_CAP_GRANTS - thisWeek;

  if (remaining <= 0) {
    await logAction('BD Researcher', 'Skipped run', `Weekly cap reached (${thisWeek}/${WEEKLY_CAP_GRANTS})`, null, 0);
    return { drafted: 0, skipped: 'weekly_cap' };
  }

  const recent = await getRecentOutreach('grant', 180);
  const recentKeys = new Set(recent.map((r) => r.target_key));

  // Tighter prompt
  const findSys =
    'Find live UK grants Civara (a charity-sector AI SaaS) could apply for. JSON array only, no prose. ' +
    `Up to ${Math.min(remaining + 2, 6)} items. Each: ` +
    '{"funder":"...","programme":"...","deadline":"...","value":"£ range","why_fit":"1 line","application_url":"..."}. ' +
    'Funders to check: Innovate UK, NESTA, Catalyst, Tech for Good UK, Comic Relief Tech for Good, UKSPF.';

  const findPrompt =
    'Civara: UK charity CRM with AI agents. Solo founder Craig. Pre-seed. Grants £5k-£100k for product / AI / charity adoption.';

  let candidates = [];
  let findCost = 0;
  let searchReturnedAnything = false;
  try {
    const raw = await callClaudeServer(findSys, findPrompt, 1200, true);
    findCost = COST_PER_SEARCH_CALL_PENCE;
    candidates = extractJSON(raw) || [];
    searchReturnedAnything = candidates.length > 0;
  } catch (e) {
    await logAction('BD Researcher', 'Search failed', e.message, null, 0);
    return { drafted: 0, error: e.message };
  }

  const fresh = candidates
    .filter((c) => c && c.funder && c.programme && !recentKeys.has(slugify(c.funder + '-' + c.programme)))
    .slice(0, remaining);

  if (!searchReturnedAnything) {
    await logAction('BD Researcher', 'Search returned empty', `Web search did not find suitable grants this run`, null, findCost);
    return { drafted: 0, reason: 'empty_search' };
  }
  if (!fresh.length) {
    await logAction('BD Researcher', 'All grants were duplicates', `${candidates.length} found, all already drafted in last 180 days`, null, findCost);
    return { drafted: 0, reason: 'all_duplicates' };
  }

  const draftSys =
    'Write an EOI for Civara (UK charity CRM with 6 AI agents, solo founder Craig). 250-350 words British English. ' +
    'Sections: ## About Civara, ## Why this grant fits, ## What we would do with the funding, ## Impact and measurement. ' +
    'Honest, specific, no inflated claims. End "Craig | Founder, Civara".';

  const drafted = [];
  for (const g of fresh) {
    try {
      const draftPrompt =
        `Funder: ${g.funder}\nProgramme: ${g.programme}\nDeadline: ${g.deadline || 'unknown'}\n` +
        `Value: ${g.value || 'unknown'}\nFit: ${g.why_fit || ''}\nURL: ${g.application_url || ''}`;
      const raw = await callClaudeServer(draftSys, draftPrompt, 700, false);

      const fit = (g.why_fit && g.why_fit.length > 20) ? 8 : 6;

      const outreachRow = await sbInsert('sentinel_outreach', [{
        kind: 'grant',
        target_key: slugify(g.funder + '-' + g.programme),
        target_name: `${g.funder} — ${g.programme}`,
        fit_score: fit,
        fit_reason: g.why_fit || null,
        draft_subject: `EOI: ${g.programme}`,
        draft_body: raw.trim(),
        source_url: g.application_url || null,
        status: 'drafted',
        metadata: { deadline: g.deadline || null, value: g.value || null },
      }]);
      const outId = outreachRow && outreachRow[0] && outreachRow[0].id;

      await sbInsert('sentinel_decisions', [{
        agent: 'BD Researcher',
        tier: fit >= 8 ? 'high' : 'medium',
        title: `Grant drafted: ${g.funder} — ${g.programme}`,
        description: `${g.why_fit || 'Live grant opportunity'}. Value: ${g.value || 'unspecified'}. Deadline: ${g.deadline || 'check link'}. Fit ${fit}/10.`,
        primary_action: 'View & copy EOI',
        secondary_action: 'Skip this one',
        status: 'pending',
        metadata: {
          kind: 'outreach', outreach_id: outId, outreach_kind: 'grant',
          subject: `EOI: ${g.programme}`, body: raw.trim(),
          target_name: `${g.funder} — ${g.programme}`, source_url: g.application_url || null,
          deadline: g.deadline || null, value: g.value || null,
        },
      }]);

      drafted.push(`${g.funder} — ${g.programme}`);
      await new Promise((r) => setTimeout(r, 2000));
    } catch (e) {
      console.warn(`[sentinel] grant draft failed for ${g.funder}: ${e.message}`);
    }
  }

  const totalCost = findCost + drafted.length * COST_PER_CALL_PENCE;
  await logAction('BD Researcher', 'Drafted grant EOIs', `${drafted.length} grants: ${drafted.join('; ')}`, null, totalCost);

  return { drafted: drafted.length, names: drafted };
}

// ── Handler ──────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const results = { briefing: null, churn: null, onboarding: null, insights: null, sales: null, bd: null, errors: [] };

  // Light agents first
  try { results.briefing = await runChiefOfStaffBriefing(); }
  catch (e) { results.errors.push({ agent: 'briefing', error: e.message }); }

  try { results.churn = await runChurnDetector(); }
  catch (e) { results.errors.push({ agent: 'churn', error: e.message }); }

  try { results.onboarding = await runOnboardingScan(); }
  catch (e) { results.errors.push({ agent: 'onboarding', error: e.message }); }

  try { results.insights = await runInsights(); }
  catch (e) { results.errors.push({ agent: 'insights', error: e.message }); }

  // Web-search agents — space them out to stay under tier-1 rate limit
  try { results.sales = await runSalesAgent(); }
  catch (e) { results.errors.push({ agent: 'sales', error: e.message }); }

  // Pause before BD so we don't both call web search inside the same minute
  console.log('[sentinel] pausing before BD agent to respect rate limit…');
  await new Promise((r) => setTimeout(r, RATE_LIMIT_PAUSE_MS));

  try { results.bd = await runBDResearcher(); }
  catch (e) { results.errors.push({ agent: 'bd', error: e.message }); }

  return res.status(200).json({ ok: true, ...results });
};
