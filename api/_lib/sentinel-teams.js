// /api/_lib/sentinel-teams.js — Sentinel by team: who owns which card, and who may run the agents
// The same team list is used in super-admin.html (keep the two in step).

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CRON_SECRET = process.env.CRON_SECRET || null;

// team id, name, the agents whose cards belong to it
const TEAMS = [
  { id: 'customers',  name: 'Customers',         agents: ['Customer Success'] },
  { id: 'onboarding', name: 'Onboarding',        agents: ['Onboarding'] },
  { id: 'sales',      name: 'Sales & Marketing', agents: ['Sales', 'Marketing'] },
  { id: 'finance',    name: 'Finance',           agents: ['Finance'] },
  { id: 'product',    name: 'Product & Dev',     agents: ['Product', 'Dev'] },
  { id: 'legal',      name: 'Legal & GDPR',      agents: ['Legal & GDPR'] },
  { id: 'funding',    name: 'Funding',           agents: ['BD Researcher'] }
];
// cards from before teams existed
const OLD_INSIGHT_TEAM = { empty_orgs: 'onboarding', low_conversion: 'finance', contract_underperformance: 'customers' };
function teamOf(d) {
  if (d && d.agent === 'Insights') return OLD_INSIGHT_TEAM[(d.metadata || {}).signal] || 'customers';
  const t = TEAMS.find(x => x.agents.indexOf(d && d.agent) !== -1);
  return t ? t.id : 'customers';
}

// monthly list prices by plan code (paying yearly is 10 months for 12)
const PRICES = { free: 0, group: 29, starter: 79, pro: 149, network: 349 };
const PLAN_NAMES = { free: 'Trial', group: 'Starter', starter: 'Community', pro: 'Standard', network: 'Provider' };

// The daily job (CRON_SECRET), or a signed-in super admin pressing "Run" on the Sentinel page
async function allowed(req) {
  const auth = req.headers.authorization || '';
  if (!CRON_SECRET || auth === `Bearer ${CRON_SECRET}`) return true;
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || !SUPABASE_URL || !KEY) return false;
  try {
    const u = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: KEY, Authorization: `Bearer ${token}` } });
    if (!u.ok) return false;
    const user = await u.json();
    if (!user || !user.id) return false;
    const r = await fetch(`${SUPABASE_URL}/rest/v1/super_admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
    const rows = r.ok ? await r.json() : [];
    return Array.isArray(rows) && rows.length > 0;
  } catch (e) { return false; }
}

module.exports = { TEAMS, teamOf, PRICES, PLAN_NAMES, allowed };
