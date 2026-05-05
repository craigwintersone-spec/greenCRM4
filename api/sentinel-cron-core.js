// /api/sentinel-cron-core.js
// The cheap, fast agents — no web search, runs in ~5-10s on Vercel Hobby.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CRON_SECRET = process.env.CRON_SECRET || null;
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
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTok,
      system,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const data = await r.json();
  if (!r.ok || data.type === 'error') {
    throw new Error(data.error?.message || `Claude ${r.status}`);
  }
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

async function runChiefOfStaffBriefing() {
  const orgs = await sbSelect('organisations', 'select=id,name,sector,plan,status,created_at&order=created_at.desc');
  const counts = await sbSelect('participants', 'select=org_id,created_at&order=created_at.desc&limit=2000');

  const byOrg = {};
  counts.forEach(p => {
    if (!byOrg[p.org_id]) byOrg[p.org_id] = { total: 0 };
    byOrg[p.org_id].total++;
  });

  const totalOrgs = orgs.length;
  const paidOrgs = orgs.filter(o => ['pro', 'network', 'starter'].includes(o.plan)).length;
  const trialOrgs = orgs.filter(o => o.plan === 'free' || o.status === 'trial').length;
  const newThisWeek = orgs.filter(o => Date.now() - new Date(o.created_at).getTime() < 7*24*60*60*1000).length;

  const orgSummary = orgs.slice(0, 30).map(o => {
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

  await sbInsert('sentinel_briefings', [{
    headline: `${totalOrgs} customers · ${paidOrgs} paying · ${newThisWeek} new this week`,
    narrative,
    stats: { total_orgs: totalOrgs, paid_orgs: paidOrgs, trial_orgs: trialOrgs, new_this_week: newThisWeek, generated_at: new Date().toISOString() },
    status: 'ready',
  }]);

  return { totalOrgs, paidOrgs };
}

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

async function runInsights() {
  const orgs = await sbSelect('organisations', 'select=id,name,plan,sector,created_at');
  const ps = await sbSelect('participants', 'select=org_id&limit=2000');
  const contracts = await sbSelect('contracts', 'select=org_id,target_outcomes,actual_outcomes&limit=500');

  const byOrgP = {};
  ps.forEach(p => { byOrgP[p.org_id] = (byOrgP[p.org_id] || 0) + 1; });

  const total = orgs.length;
  const paying = orgs.filter(o => ['pro', 'network', 'starter'].includes(o.plan)).length;
  const free = orgs.filter(o => o.plan === 'free' || !o.plan).length;
  const empty = orgs.filter(o => !byOrgP[o.id]).length;
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
  const under = contracts.filter(c => c.target_outcomes && c.actual_outcomes < c.target_outcomes * 0.6).length;
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

module.exports = async function handler(req, res) {
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  const results = { briefing: null, churn: null, onboarding: null, insights: null, errors: [] };

  try { results.briefing = await runChiefOfStaffBriefing(); }
  catch (e) { results.errors.push({ agent: 'briefing', error: e.message }); }

  try { results.churn = await runChurnDetector(); }
  catch (e) { results.errors.push({ agent: 'churn', error: e.message }); }

  try { results.onboarding = await runOnboardingScan(); }
  catch (e) { results.errors.push({ agent: 'onboarding', error: e.message }); }

  try { results.insights = await runInsights(); }
  catch (e) { results.errors.push({ agent: 'insights', error: e.message }); }

  return res.status(200).json({ ok: true, ...results });
};
