// /api/sentinel-cron.js
// Runs daily at 06:00 via Vercel cron.
// 1. Pulls cross-tenant data using service role
// 2. Generates morning briefing via Claude
// 3. Runs churn detector, queues decisions
// 4. Writes to sentinel_briefings + sentinel_decisions

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const CRON_SECRET = process.env.CRON_SECRET || null;

// ── Service-role helpers ─────────────────────────────────────
async function sbSelect(table, query) {
  const url = `${SUPABASE_URL}/rest/v1/${table}?${query}`;
  const r = await fetch(url, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Supabase select ${table} failed: ${r.status} ${text}`);
  }
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
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Supabase insert ${table} failed: ${r.status} ${text}`);
  }
  return r.json();
}

// ── Claude helper (server-side, no auth gate) ────────────────
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
    throw new Error(data.error?.message || `Claude HTTP ${r.status}`);
  }
  return (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

// ── Agents ───────────────────────────────────────────────────
async function runChiefOfStaffBriefing() {
  // Pull all orgs + all participants (for activity signals)
  const orgs = await sbSelect(
    'organisations',
    'select=id,name,sector,plan,status,created_at&order=created_at.desc'
  );

  // For each org, count participants and last activity (cheap aggregates)
  const counts = await sbSelect(
    'participants',
    'select=org_id,created_at&order=created_at.desc&limit=1000'
  );

  // Group counts by org
  const byOrg = {};
  counts.forEach((p) => {
    if (!byOrg[p.org_id]) byOrg[p.org_id] = { total: 0, lastActivity: null };
    byOrg[p.org_id].total++;
    if (!byOrg[p.org_id].lastActivity || p.created_at > byOrg[p.org_id].lastActivity) {
      byOrg[p.org_id].lastActivity = p.created_at;
    }
  });

  const totalOrgs = orgs.length;
  const paidOrgs = orgs.filter((o) => ['pro', 'network', 'starter'].includes(o.plan)).length;
  const trialOrgs = orgs.filter((o) => o.plan === 'free' || o.status === 'trial').length;
  const newThisWeek = orgs.filter((o) => {
    const d = new Date(o.created_at);
    return Date.now() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  }).length;

  const orgSummary = orgs
    .slice(0, 30)
    .map((o) => {
      const c = byOrg[o.id] || { total: 0, lastActivity: null };
      return `- ${o.name} (${o.plan || 'free'}, ${o.sector || 'unknown'}): ${c.total} participants`;
    })
    .join('\n');

  const sys =
    'You are the Chief of Staff for a solo founder running Civara, a UK CRM SaaS for charities. ' +
    'Generate a warm, specific morning briefing in clean British English. Three short sections: ' +
    '1) Overnight summary (2 sentences), 2) What needs attention today (3 bullets max), ' +
    '3) One strategic observation. Use **bold** for emphasis. No hashtags, no markdown headings, ' +
    'no horizontal rules. Max 200 words. Be honest if the data is quiet — do not invent activity.';

  const prompt =
    `Today: ${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long' })}\n` +
    `Total customers: ${totalOrgs}\n` +
    `Paid customers: ${paidOrgs}\n` +
    `On trial: ${trialOrgs}\n` +
    `New this week: ${newThisWeek}\n\n` +
    `Customer snapshot:\n${orgSummary}`;

  let narrative = '';
  try {
    narrative = await callClaudeServer(sys, prompt, 400);
  } catch (e) {
    narrative = `Briefing generation failed: ${e.message}. Raw stats below.\n\nOrgs: ${totalOrgs}, Paid: ${paidOrgs}, Trial: ${trialOrgs}.`;
  }

  const headline = `${totalOrgs} customers · ${paidOrgs} paying · ${newThisWeek} new this week`;

  await sbInsert('sentinel_briefings', [
    {
      headline,
      narrative,
      stats: {
        total_orgs: totalOrgs,
        paid_orgs: paidOrgs,
        trial_orgs: trialOrgs,
        new_this_week: newThisWeek,
        generated_at: new Date().toISOString(),
      },
      status: 'ready',
    },
  ]);

  return { headline, narrative };
}

async function runChurnDetector() {
  // Pull orgs and recent activity
  const orgs = await sbSelect(
    'organisations',
    "select=id,name,plan,status,created_at&plan=in.(pro,network,starter)"
  );

  const decisions = [];
  const now = Date.now();

  for (const org of orgs) {
    // Quick activity signal — most recent participant added
    const participants = await sbSelect(
      'participants',
      `select=created_at&org_id=eq.${org.id}&order=created_at.desc&limit=1`
    );

    if (!participants.length) {
      // No participants ever
      const created = new Date(org.created_at).getTime();
      const ageDays = Math.floor((now - created) / (1000 * 60 * 60 * 24));
      if (ageDays > 14) {
        decisions.push({
          agent: 'Customer Success',
          tier: 'high',
          title: `${org.name} has zero participants — ${ageDays} days since signup`,
          description: `Paid customer (${org.plan}) hasn't added any data. Strong onboarding-stalled signal. Consider a personal check-in.`,
          primary_action: 'Send check-in email',
          secondary_action: 'Schedule call',
          org_id: org.id,
          status: 'pending',
          metadata: { signal: 'onboarding_stalled', age_days: ageDays },
        });
      }
      continue;
    }

    const lastAdd = new Date(participants[0].created_at).getTime();
    const daysSince = Math.floor((now - lastAdd) / (1000 * 60 * 60 * 24));

    if (daysSince > 21) {
      decisions.push({
        agent: 'Customer Success',
        tier: daysSince > 35 ? 'urgent' : 'high',
        title: `${org.name} silent for ${daysSince} days`,
        description: `No new participant data in ${daysSince} days. ${org.plan} plan. Pattern suggests churn risk — drafted check-in email.`,
        primary_action: 'Send check-in email',
        secondary_action: 'Call instead',
        org_id: org.id,
        status: 'pending',
        metadata: { signal: 'inactivity', days_since_last: daysSince },
      });
    }
  }

  if (decisions.length) {
    await sbInsert('sentinel_decisions', decisions);
  }

  return { count: decisions.length };
}

// ── Handler ──────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  // Optional: protect against random hits with a secret
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({
      error: 'Missing env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY',
    });
  }

  const results = { briefing: null, churn: null, errors: [] };

  try {
    results.briefing = await runChiefOfStaffBriefing();
  } catch (e) {
    results.errors.push({ agent: 'briefing', error: e.message });
  }

  try {
    results.churn = await runChurnDetector();
  } catch (e) {
    results.errors.push({ agent: 'churn', error: e.message });
  }

  return res.status(200).json({ ok: true, ...results });
};
