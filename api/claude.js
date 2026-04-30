// /api/claude.js
// Server-side gated proxy to the Anthropic API.
// Verifies the user's session and plan before forwarding.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const ALLOWED_PLANS = ['pro', 'network'];

// Reasonably permissive CORS for now. Tighten to your real domain later.
const ALLOWED_ORIGIN_REGEX = /^https?:\/\/(localhost(:\d+)?|.*\.vercel\.app|civara\.co\.uk|www\.civara\.co\.uk)$/i;

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGIN_REGEX.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

async function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!r.ok) return null;
  const user = await r.json();
  return user && user.id ? user : null;
}

async function getUserOrgPlan(userId) {
  // Find an active membership and the org's plan, ignoring RLS.
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/memberships?user_id=eq.${userId}&status=eq.active&select=org_id,role,organisations(plan,status)`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    }
  );
  if (!r.ok) return null;
  const rows = await r.json();
  if (!Array.isArray(rows) || rows.length === 0) return null;
  // Pick the first active membership whose org is also active.
  const live = rows.find(
    (m) => m.organisations && m.organisations.status !== 'suspended'
  );
  return live ? live.organisations.plan || 'free' : null;
}

async function isSuperAdmin(userId) {
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/super_admins?user_id=eq.${userId}&select=user_id`,
    {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        Accept: 'application/json',
      },
    }
  );
  if (!r.ok) return false;
  const rows = await r.json();
  return Array.isArray(rows) && rows.length > 0;
}

module.exports = async function handler(req, res) {
  setCors(req, res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Sanity-check env
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !ANTHROPIC_API_KEY) {
    return res
      .status(500)
      .json({ error: 'Server misconfigured: missing required environment variables.' });
  }

  // 1. Authenticate the user
  const user = await getAuthUser(req);
  if (!user) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  // 2. Check plan (super admins always allowed)
  const isAdmin = await isSuperAdmin(user.id);
  let plan = null;
  if (!isAdmin) {
    plan = await getUserOrgPlan(user.id);
    if (!plan) {
      return res
        .status(403)
        .json({ error: 'No active organisation found for this account.' });
    }
    if (!ALLOWED_PLANS.includes(plan)) {
      return res.status(403).json({
        error: 'AI features require the Pro or Network plan.',
        code: 'AI_PLAN_GATE',
      });
    }
  }

  // 3. Forward to Anthropic
  try {
    const { useWebSearch, ...rest } = req.body || {};
    const body = { ...rest };

    if (useWebSearch) {
      body.tools = [
        ...(body.tools || []),
        { type: 'web_search_20250305', name: 'web_search' },
      ];
    }

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
    return res.status(response.status).json(data);
  } catch (err) {
    console.error('Claude API error:', err);
    return res.status(500).json({ error: err.message || 'Upstream error' });
  }
};
