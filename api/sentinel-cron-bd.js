// /api/sentinel-cron-bd.js
// BD Researcher only — web search + drafts. Runs in ~30-50s.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const CRON_SECRET = process.env.CRON_SECRET || null;
const COST_PER_CALL_PENCE = 1;
const COST_PER_SEARCH_CALL_PENCE = 5;
const WEEKLY_CAP_GRANTS = 5;

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

  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString();
  const weekRows = await sbSelect('sentinel_outreach', `select=id&kind=eq.grant&created_at=gte.${cutoff}`);
  const remaining = WEEKLY_CAP_GRANTS - weekRows.length;

  if (remaining <= 0) {
    await logAction('BD Researcher', 'Skipped run', `Weekly cap reached (${weekRows.length}/${WEEKLY_CAP_GRANTS})`, null, 0);
    return res.status(200).json({ ok: true, drafted: 0, skipped: 'weekly_cap' });
  }

  const recentCutoff = new Date(Date.now() - 180 * 86400000).toISOString();
  const recent = await sbSelect('sentinel_outreach', `select=target_key&kind=eq.grant&created_at=gte.${recentCutoff}`);
  const recentKeys = new Set(recent.map(r => r.target_key));

  const findSys =
    'Find live UK grants Vorlana (a charity-sector AI SaaS) could apply for. JSON array only, no prose. ' +
    `Up to ${Math.min(remaining + 2, 6)} items. Each: ` +
    '{"funder":"...","programme":"...","deadline":"...","value":"£ range","why_fit":"1 line","application_url":"..."}. ' +
    'Funders: Innovate UK, NESTA, Catalyst, Tech for Good UK, Comic Relief Tech for Good, UKSPF.';

  const findPrompt =
    'Vorlana: UK charity CRM with AI agents. Solo founder Craig. Pre-seed. Grants £5k-£100k for product / AI / charity adoption.';

  let candidates = [];
  let findCost = 0;
  try {
    const raw = await callClaudeServer(findSys, findPrompt, 1200, true);
    findCost = COST_PER_SEARCH_CALL_PENCE;
    candidates = extractJSON(raw) || [];
  } catch (e) {
    await logAction('BD Researcher', 'Search failed', e.message, null, 0);
    return res.status(200).json({ ok: false, error: e.message });
  }

  const fresh = candidates
    .filter(c => c && c.funder && c.programme && !recentKeys.has(slugify(c.funder + '-' + c.programme)))
    .slice(0, remaining);

  if (!candidates.length) {
    await logAction('BD Researcher', 'Search returned empty', 'Web search did not find grants this run', null, findCost);
    return res.status(200).json({ ok: true, drafted: 0, reason: 'empty_search' });
  }
  if (!fresh.length) {
    await logAction('BD Researcher', 'All grants were duplicates', `${candidates.length} found, all already drafted in last 180 days`, null, findCost);
    return res.status(200).json({ ok: true, drafted: 0, reason: 'all_duplicates' });
  }

  const draftSys =
    'Write an EOI for Vorlana (UK charity CRM with 6 AI agents, solo founder Craig). 250-350 words British English. ' +
    'Sections: ## About Vorlana, ## Why this grant fits, ## What we would do with the funding, ## Impact and measurement. ' +
    'Honest, specific, no inflated claims. End "Craig | Founder, Vorlana".';

  const drafted = [];
  for (const g of fresh) {
    try {
      const draftPrompt =
        `Funder: ${g.funder}\nProgramme: ${g.programme}\nDeadline: ${g.deadline || 'unknown'}\n` +
        `Value: ${g.value || 'unknown'}\nFit: ${g.why_fit || ''}\nURL: ${g.application_url || ''}`;
      const raw = await callClaudeServer(draftSys, draftPrompt, 700, false);

      const fit = (g.why_fit && g.why_fit.length > 20) ? 8 : 6;

      const outreachRow = await sbInsert('sentinel_outreach', [{
        kind: 'grant', target_key: slugify(g.funder + '-' + g.programme),
        target_name: `${g.funder} — ${g.programme}`,
        fit_score: fit, fit_reason: g.why_fit || null,
        draft_subject: `EOI: ${g.programme}`, draft_body: raw.trim(),
        source_url: g.application_url || null, status: 'drafted',
        metadata: { deadline: g.deadline || null, value: g.value || null },
      }]);
      const outId = outreachRow && outreachRow[0] && outreachRow[0].id;

      await sbInsert('sentinel_decisions', [{
        agent: 'BD Researcher', tier: fit >= 8 ? 'high' : 'medium',
        title: `Grant drafted: ${g.funder} — ${g.programme}`,
        description: `${g.why_fit || 'Live grant opportunity'}. Value: ${g.value || 'unspecified'}. Deadline: ${g.deadline || 'check link'}. Fit ${fit}/10.`,
        primary_action: 'View & copy EOI', secondary_action: 'Skip this one',
        status: 'pending',
        metadata: {
          kind: 'outreach', outreach_id: outId, outreach_kind: 'grant',
          subject: `EOI: ${g.programme}`, body: raw.trim(),
          target_name: `${g.funder} — ${g.programme}`, source_url: g.application_url || null,
          deadline: g.deadline || null, value: g.value || null,
        },
      }]);

      drafted.push(`${g.funder} — ${g.programme}`);
      await new Promise(r => setTimeout(r, 1500));
    } catch (e) {
      console.warn(`[sentinel] grant draft failed for ${g.funder}: ${e.message}`);
    }
  }

  const totalCost = findCost + drafted.length * COST_PER_CALL_PENCE;
  await logAction('BD Researcher', 'Drafted grant EOIs', `${drafted.length} grants: ${drafted.join('; ')}`, null, totalCost);

  return res.status(200).json({ ok: true, drafted: drafted.length, names: drafted });
};
