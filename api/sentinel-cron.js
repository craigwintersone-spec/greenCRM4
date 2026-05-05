// /api/sentinel-cron.js
// Runs daily at 06:00 via Vercel cron (or manually from the UI).
// Agents: Chief of Staff, Customer Success, Onboarding, Insights, Sales, BD Researcher.
// Sales + BD use Claude web search and are weekly-capped to 5 each.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CRON_SECRET = process.env.CRON_SECRET || null;

const COST_PER_CALL_PENCE = 1;
const COST_PER_SEARCH_CALL_PENCE = 5; // web search calls are pricier

const WEEKLY_CAP_SALES = 5;
const WEEKLY_CAP_GRANTS = 5;

// ── Service-role helpers ─────────────────────────────────────
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

// ── Claude helpers ───────────────────────────────────────────
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

// Try to parse JSON out of an LLM response that may have extra prose
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

// ── Helpers for Sales + BD ───────────────────────────────────
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

  // Fetch dedupe list (last 90 days)
  const recent = await getRecentOutreach('sales', 90);
  const recentKeys = new Set(recent.map((r) => r.target_key));

  // Phase 1 — find prospects with web search
  const findSys =
    'You are a UK charity sector researcher helping Civara, a CRM SaaS for charities, find new sales prospects. ' +
    'Use web search to find UK charities currently a strong fit: registered in last 12 months OR newly funded, ' +
    'in sectors employability, youth, justice/probation, circular economy, social enterprise. Focus on small-medium ' +
    `(turnover under £2M, fewer than 30 staff). Return up to ${remaining + 3} candidates as a JSON array. ` +
    'Each item: {"name":"charity name","registered_no":"...","website":"https://...","why_fit":"1 sentence reason",' +
    '"recent_signal":"e.g. just won X grant / launched Y programme","contact_hint":"role and name if findable"}. ' +
    'Skip charities you cannot find a clear ICP signal for. Output ONLY the JSON array, no preamble.';

  const findPrompt =
    'Find UK charity prospects who would benefit from Civara. Civara is a CRM with 6 built-in AI agents ' +
    '(Morning Briefing, BD Manager, Social Media, HR/Equality, Outcomes Analyst, Case Note). ' +
    'Pricing: £29-£249/mo. ICP: 5-30 staff, multiple frontline workers, holds public funder contracts ' +
    '(MoJ, GLA, City Bridge, Lottery, Trust for London). Avoid orgs that already use Salesforce NPSP, Beacon, or Lamplight.';

  let candidates = [];
  let findCost = 0;
  try {
    const raw = await callClaudeServer(findSys, findPrompt, 1500, true);
    findCost = COST_PER_SEARCH_CALL_PENCE;
    candidates = extractJSON(raw) || [];
  } catch (e) {
    await logAction('Sales', 'Search failed', e.message, null, 0);
    return { drafted: 0, error: e.message };
  }

  // Filter dedupe + cap
  const fresh = candidates
    .filter((c) => c && c.name && !recentKeys.has(slugify(c.name)))
    .slice(0, remaining);

  if (!fresh.length) {
    await logAction('Sales', 'No new prospects', `${candidates.length} found, all already drafted in last 90 days`, null, findCost);
    return { drafted: 0 };
  }

  // Phase 2 — draft outreach for each
  const draftSys =
    'You are a UK SaaS founder writing a cold outreach email to a charity CEO. ' +
    'Tone: warm, specific, no salesy fluff, British English. 100-140 words. Include a SUBJECT LINE on the first line ' +
    'prefixed "Subject: ", then a blank line, then the email. The email must reference the specific charity\'s ' +
    'recent signal (grant won, programme launched, new registration). Mention Civara is a CRM with built-in ' +
    'AI agents that save 5-10 hours/week of admin. Soft CTA: "worth a 15-min call?". Sign off "Craig". No emoji.';

  const drafted = [];
  for (const c of fresh) {
    try {
      const draftPrompt =
        `Charity: ${c.name}\nWebsite: ${c.website || 'unknown'}\nRecent signal: ${c.recent_signal || 'unknown'}\n` +
        `Contact hint: ${c.contact_hint || 'CEO'}\nWhy a fit: ${c.why_fit || ''}`;
      const raw = await callClaudeServer(draftSys, draftPrompt, 500, false);

      const lines = raw.split('\n');
      const subjectLine = lines.find((l) => /^subject:/i.test(l)) || 'Subject: A quick question about your work';
      const subject = subjectLine.replace(/^subject:\s*/i, '').trim();
      const body = raw.replace(/^subject:.*\n+/i, '').trim();

      // Score fit roughly from signal richness
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

      const decisionRow = await sbInsert('sentinel_decisions', [{
        agent: 'Sales',
        tier: fit >= 8 ? 'high' : 'medium',
        title: `Cold prospect drafted: ${c.name}`,
        description: `${c.why_fit || 'UK charity matching ICP'}. ${c.recent_signal ? 'Signal: ' + c.recent_signal : ''} Fit ${fit}/10. Draft ready below.`,
        primary_action: 'View & copy draft',
        secondary_action: 'Skip this one',
        status: 'pending',
        metadata: {
          kind: 'outreach', outreach_id: outId, outreach_kind: 'sales',
          subject, body, target_name: c.name, source_url: c.website || null,
        },
      }]);

      drafted.push(c.name);
      await new Promise((r) => setTimeout(r, 800)); // gentle pacing
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

  const findSys =
    'You are a UK grants researcher helping Civara, a tech-for-good SaaS, find live grant opportunities. ' +
    'Use web search to find currently open grants/funds Civara could realistically apply for. Targets: ' +
    'AI for public good, charity sector innovation, tech-for-good SaaS, early-stage UK SaaS, sole founders, ' +
    'social impact tech, civic tech. Funders to check: Innovate UK, NESTA, Cabinet Office, UKSPF, ' +
    'AccelerateAI, Catalyst, Tech for Good UK, Innovate Fund, Comic Relief Tech for Good. ' +
    `Return up to ${remaining + 3} as JSON array: ` +
    '{"funder":"name","programme":"specific call/programme","deadline":"YYYY-MM-DD or text","value":"£ range",' +
    '"why_fit":"1 sentence","application_url":"https://..."}. Verify deadlines are still open. ' +
    'Output ONLY the JSON array, no preamble.';

  const findPrompt =
    'Find live grants for Civara. Civara is: UK SaaS, charity sector CRM with 6 AI agents, solo founder (Craig), ' +
    'pre-revenue/early-stage, serves UK charities of 5-30 staff, mission to reduce admin burden so frontline ' +
    'staff can focus on people. Pre-seed/seed stage. Looking for grants £5k-£100k that fund product, AI development, ' +
    'or charity sector adoption.';

  let candidates = [];
  let findCost = 0;
  try {
    const raw = await callClaudeServer(findSys, findPrompt, 1500, true);
    findCost = COST_PER_SEARCH_CALL_PENCE;
    candidates = extractJSON(raw) || [];
  } catch (e) {
    await logAction('BD Researcher', 'Search failed', e.message, null, 0);
    return { drafted: 0, error: e.message };
  }

  const fresh = candidates
    .filter((c) => c && c.funder && c.programme && !recentKeys.has(slugify(c.funder + '-' + c.programme)))
    .slice(0, remaining);

  if (!fresh.length) {
    await logAction('BD Researcher', 'No new grants', `${candidates.length} found, all already drafted in last 180 days`, null, findCost);
    return { drafted: 0 };
  }

  const draftSys =
    'You are writing an Expression of Interest for a grant on behalf of Civara. ' +
    'Civara is a UK CRM SaaS for charities with 6 built-in AI agents that automate admin work — Morning Briefing, ' +
    'BD Manager, Social Media, HR/Equality, Outcomes Analyst, Case Note. Founded by Craig, a solo founder. ' +
    'Mission: reduce admin burden so frontline charity staff can focus on people. Currently early-stage with ' +
    'a small group of UK charity customers across employability and circular economy. ' +
    'Write an EOI in clean British English, 250-350 words, with sections: ' +
    '## About Civara, ## Why this grant fits, ## What we would do with the funding, ## Impact and measurement. ' +
    'Honest, specific, no inflated claims. End with "Craig | Founder, Civara" on its own line.';

  const drafted = [];
  for (const g of fresh) {
    try {
      const draftPrompt =
        `Funder: ${g.funder}\nProgramme: ${g.programme}\nDeadline: ${g.deadline || 'unknown'}\n` +
        `Value: ${g.value || 'unknown'}\nWhy fit: ${g.why_fit || ''}\nURL: ${g.application_url || ''}`;
      const raw = await callClaudeServer(draftSys, draftPrompt, 800, false);

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
      await new Promise((r) => setTimeout(r, 800));
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

  try { results.briefing = await runChiefOfStaffBriefing(); }
  catch (e) { results.errors.push({ agent: 'briefing', error: e.message }); }

  try { results.churn = await runChurnDetector(); }
  catch (e) { results.errors.push({ agent: 'churn', error: e.message }); }

  try { results.onboarding = await runOnboardingScan(); }
  catch (e) { results.errors.push({ agent: 'onboarding', error: e.message }); }

  try { results.insights = await runInsights(); }
  catch (e) { results.errors.push({ agent: 'insights', error: e.message }); }

  try { results.sales = await runSalesAgent(); }
  catch (e) { results.errors.push({ agent: 'sales', error: e.message }); }

  try { results.bd = await runBDResearcher(); }
  catch (e) { results.errors.push({ agent: 'bd', error: e.message }); }

  return res.status(200).json({ ok: true, ...results });
};
