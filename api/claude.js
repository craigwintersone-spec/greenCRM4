// /api/claude.js
// Server-side gated proxy to the Anthropic API — HARDENED VERSION.
// Adds: strict CORS, model allowlist, max_tokens ceiling, per-org daily
// quota, and usage logging. Drop-in replacement for the previous file.
//
// Requires: the ai_usage table (run ai-usage-migration.sql first).

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ALLOWED_PLANS = ['pro', 'network'];

// ── Hardening knobs ─────────────────────────────────────────────
// Only these exact origins may call from a browser. NO wildcard vercel.app.
// While developing, add your ONE specific preview URL here temporarily.
const ALLOWED_ORIGINS = new Set([
  'https://vorlana.com',
  'https://www.vorlana.com',
  'http://localhost:3000',
  'http://localhost:5173',
]);

// Only models YOU choose to pay for. The client cannot pick anything else.
const ALLOWED_MODELS = new Set([
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const MAX_TOKENS_CEILING = 2000;   // server-enforced output cap per call
const MAX_MESSAGES = 30;           // sane conversation length
const MAX_BODY_CHARS = 200_000;    // ~50k tokens of input, generous
const DAILY_CALLS_PER_ORG = 300;   // quota; tune per plan later
// ────────────────────────────────────────────────────────────────

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function svcHeaders() {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    Accept: 'application/json',
  };
}

async function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const user = await r.json();
  return user && user.id ? user : null;
}

// Now returns BOTH plan and org_id — we need the org for quota + logging.
async function getUserOrg(userId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/memberships?user_id=eq.${userId}&status=eq.active&select=org_id,role,organisations(plan,status)`,
    { headers: svcHeaders() }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const live = rows.find(m => m.organisations && m.organisations.status !== 'suspended');
  if (!live) return null;
  return { orgId: live.org_id, plan: live.organisations.plan || 'free' };
}

async function isSuperAdmin(userId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/super_admins?user_id=eq.${userId}&select=user_id`,
    { headers: svcHeaders() }
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

// Count today's calls for this org (UTC day). Cheap thanks to idx_ai_usage_org_day.
async function callsToday(orgId) {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/ai_usage?org_id=eq.${orgId}&called_at=gte.${dayStart.toISOString()}&select=id`,
    { headers: { ...svcHeaders(), Prefer: 'count=exact', Range: '0-0' } }
  );
  if (!r.ok) return 0; // fail open on the COUNT only; the ceiling still protects cost
  const range = r.headers.get('content-range') || '';
  const total = parseInt(range.split('/')[1], 10);
  return Number.isFinite(total) ? total : 0;
}

async function logUsage(row) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/ai_usage`, {
      method: 'POST',
      headers: { ...svcHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
  } catch (_) { /* logging must never break the request */ }
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'Server misconfigured: missing environment variables.' });
  }

  // 0. Reject oversized payloads before doing any work.
  try {
    if (JSON.stringify(req.body || {}).length > MAX_BODY_CHARS) {
      return res.status(413).json({ error: 'Request too large.' });
    }
  } catch (_) {
    return res.status(400).json({ error: 'Invalid request body.' });
  }

  // 1. Authenticate
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  // 2. Plan + org (super admins bypass the plan gate but still get logged/capped)
  const admin = await isSuperAdmin(user.id);
  const org = await getUserOrg(user.id);
  if (!admin) {
    if (!org) return res.status(403).json({ error: 'No active organisation found for this account.' });
    if (!ALLOWED_PLANS.includes(org.plan)) {
      return res.status(403).json({ error: 'AI features require the Pro or Network plan.', code: 'AI_PLAN_GATE' });
    }
  }
  const orgId = org ? org.orgId : user.id; // admins with no org: quota against their own id

  // 3. Daily quota
  const used = await callsToday(orgId);
  if (used >= DAILY_CALLS_PER_ORG) {
    return res.status(429).json({
      error: 'Daily AI limit reached for your organisation. Resets at midnight UTC.',
      code: 'AI_QUOTA',
    });
  }

  // 4. Sanitise the request — the SERVER decides model, caps and tools.
  const { web_search, messages, system, temperature, model: requestedModel } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages[] is required.' });
  }
  if (messages.length > MAX_MESSAGES) {
    return res.status(400).json({ error: `Too many messages (max ${MAX_MESSAGES}).` });
  }

  const model = ALLOWED_MODELS.has(requestedModel) ? requestedModel : DEFAULT_MODEL;

  const body = {
    model,
    max_tokens: MAX_TOKENS_CEILING,          // client cannot raise this
    messages,
  };
  if (typeof system === 'string' && system.length) body.system = system;
  if (typeof temperature === 'number' && temperature >= 0 && temperature <= 1) {
    body.temperature = temperature;
  }
  if (web_search) {
    body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  // Note: we deliberately do NOT spread req.body — nothing else passes through.

  // 5. Forward to Anthropic
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05',
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    // 6. Log usage (never blocks the response)
    logUsage({
      org_id: orgId,
      user_id: user.id,
      model,
      status: response.status,
      input_tokens: data && data.usage ? data.usage.input_tokens : null,
      output_tokens: data && data.usage ? data.usage.output_tokens : null,
      purpose: typeof req.body.purpose === 'string' ? req.body.purpose.slice(0, 40) : null,
    });

    return res.status(response.status).json(data);
  } catch (err) {
    console.error('Claude API error:', err);
    return res.status(500).json({ error: err.message || 'Upstream error' });
  }
};
