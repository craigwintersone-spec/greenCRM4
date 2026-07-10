// /api/sentinel-cron-sales.js
// Sales agent only — web search + drafts. Runs in ~30-50s.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CRON_SECRET = process.env.CRON_SECRET || null;
const COST_PER_CALL_PENCE = 1;
const COST_PER_SEARCH_CALL_PENCE = 5;
const WEEKLY_CAP_SALES = 5;

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
  if (useWebSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
  };
  if (useWebSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await r.json();
  if (!r.ok || data.type === 'error') throw new Error(data.error?.message || `Claude ${r.status}`);
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
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

module.exports = async function handler(req, res) {
  if (CRON_SECRET) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Missing env vars' });
  }

  // Weekly cap check
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const weekRows = await sbSelect('sentinel_outreach', `select=id&kind=eq.sales&created_at=gte.${cutoff}`);
  const remaining = WEEKLY_CAP_SALES - weekRows.length;

  if (remaining <= 0) {
    await logAction('Sales', 'Skipped run', `Weekly cap reached (${weekRows.length}/${WEEKLY_CAP_SALES})`, null, 0);
    return res.status(200).json({ ok: true, drafted: 0, skipped: 'weekly_cap' });
  }

  // Dedupe
  const recentCutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const recent = await sbSelect('sentinel_outreach', `select=target_key&kind=eq.sales&created_at=gte.${recentCutoff}`);
  const recentKeys = new Set(recent.map(r => r.target_key));

  const findSys =
    'Find UK charities to pitch a charity CRM to. Return JSON array only, no prose. ' +
    `Up to ${Math.min(remaining + 2, 6)} items. Each: ` +
    '{"name":"...","website":"...","why_fit":"1 line","recent_signal":"1 line","contact_hint":"role"}. ' +
    'Focus: small charities (5-30 staff) in employability, youth, justice, circular economy, registered or funded recently.';

  const findPrompt =
    'Vorlana CRM with built-in AI agents. £29-£249/mo. ICP: small UK charities holding public funder contracts (MoJ, GLA, City Bridge, Lottery, Trust for London).';

  let candidates = [];
  let findCost = 0;
  try {
    const raw = await callClaudeServer(findSys, findPrompt, 1200, true);
    findCost = COST_PER_SEARCH_CALL_PENCE;
    candidates = extractJSON(raw) || [];
  } catch (e) {
    await logAction('Sales', 'Search failed', e.message, null, 0);
    return res.status(200).json({ ok: false, error: e.message });
  }

  const fresh = candidates.filter(c => c && c.name && !recentKeys.has(slugify(c.name))).slice(0, remaining);

  if (!candidates.length) {
    await logAction('Sales', 'Search returned empty', 'Web search did not find candidates this run', null, findCost);
    return res.status(200).json({ ok: true, drafted: 0, reason: 'empty_search' });
  }
  if (!fresh.length) {
    await logAction('Sales', 'All candidates were duplicates', `${candidates.length} found, all already drafted in last 90 days`, null, findCost);
    return res.status(200).json({ ok: true, drafted: 0, reason: 'all_duplicates' });
  }

  const draftSys =
    'Write a cold email from Craig (UK charity-CRM founder) to a charity CEO. ' +
    'First line "Subject: ..." then blank line then 100-130 word email. Warm, specific, British English, no fluff. ' +
    'Reference the charity\'s recent signal. Mention Vorlana saves 5-10 hours/week of admin via built-in AI. ' +
    'Soft CTA: "worth a 15-min call?". Sign "Craig". No emoji.';

  const drafted = [];
  for (const c of fresh) {
    try {
      const draftPrompt =
        `Charity: ${c.name}\nWebsite: ${c.website || 'unknown'}\nSignal: ${c.recent_signal || 'unknown'}\n` +
        `Contact: ${c.contact_hint || 'CEO'}\nFit: ${c.why_fit || ''}`;
      const raw = await callClaudeServer(draftSys, draftPrompt, 400, false);

      const lines = raw.split('\n');
      const subjectLine = lines.find(l => /^subject:/i.test(l)) || 'Subject: A quick question about your work';
      const subject = subjectLine.replace(/^subject:\s*/i, '').trim();
      const body = raw.replace(/^subject:.*\n+/i, '').trim();

      const fit = (c.recent_signal && c.recent_signal.length > 20) ? 8 : 6;

      const outreachRow = await sbInsert('sentinel_outreach', [{
        kind: 'sales', target_key: slugify(c.name), target_name: c.name,
        fit_score: fit, fit_reason: c.why_fit || null,
        draft_subject: subject, draft_body: body,
        source_url: c.website || null, status: 'drafted',
        metadata: { contact_hint: c.contact_hint || null, recent_signal: c.recent_signal || null },
      }]);
      const outId = outreachRow && outreachRow[0] && outreachRow[0].id;

      await sbInsert('sentinel_decisions', [{
        agent: 'Sales', tier: fit >= 8 ? 'high' : 'medium',
        title: `Cold prospect drafted: ${c.name}`,
        description: `${c.why_fit || 'UK charity matching ICP'}. ${c.recent_signal ? 'Signal: ' + c.recent_signal : ''} Fit ${fit}/10.`,
        primary_action: 'View & copy draft', secondary_action: 'Skip this one',
        status: 'pending',
        metadata: { kind: 'outreach', outreach_id: outId, outreach_kind: 'sales', subject, body, target_name: c.name, source_url: c.website || null },
      }]);

      drafted.push(c.name);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.warn(`[sentinel] draft failed for ${c.name}: ${e.message}`);
    }
  }

  const totalCost = findCost + drafted.length * COST_PER_CALL_PENCE;
  await logAction('Sales', 'Drafted cold outreach', `${drafted.length} prospects: ${drafted.join(', ')}`, null, totalCost);

  return res.status(200).json({ ok: true, drafted: drafted.length, names: drafted });
};
