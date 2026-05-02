// js/db.js — Supabase client + the in-memory DB cache.
// Depends on: config.js, utils.js
//
// Responsibilities:
//   • create the Supabase client (`sb`)
//   • hold the in-memory DB cache (`DB`) used by render.js
//   • provide safe wrappers: sbQ, sbInsert, sbUpdate, sbDelete
//   • provide syncAll() and refreshTable() to keep DB in sync with Postgres
//
// Critical safety: every query/insert REQUIRES orgId. Refuses to run
// without one — this prevents the cross-org data leak the original
// codebase had with feedback and partner_referrals.

'use strict';

// ── State ─────────────────────────────────────────────────────
let sb = null;
let orgId = null;
let currentOrg = null;
let currentUser = null;
let currentRole = null;
let isSuperAdmin = false;
let userMemberships = [];

// In-memory cache. Render.js reads from here, never from Supabase directly.
const DB = {
  participants:       [],
  volunteers:         [],
  events:             [],
  feedback:           [],
  contacts:           [],
  employers:          [],
  referrals:          [],
  partner_referrals:  [],
  circular:           [],
  contracts:          [],
  evidence:           [],
  funders:            []
};

// ── Init ──────────────────────────────────────────────────────
function initSB() {
  if (sb) return sb;
  if (!window.supabase) {
    console.error('[db] Supabase library not loaded');
    return null;
  }
  try {
    sb = window.supabase.createClient(SB_URL, SB_KEY);
    return sb;
  } catch (e) {
    console.error('[db] Supabase init failed:', e);
    return null;
  }
}

// ── Safe wrappers ─────────────────────────────────────────────

// Refuses to query without an orgId. Returns [] instead of falling
// back to an unfiltered query (which was the original GDPR bug).
async function sbQ(table) {
  if (!sb) return null;
  if (!orgId) {
    console.warn('[sbQ] Refusing to query ' + table + ' without orgId');
    return [];
  }
  try {
    const { data, error } = await sb.from(table).select('*').eq('org_id', orgId);
    if (error) {
      console.error('[sbQ] ' + table + ' failed:', error.message);
      return [];
    }
    return data;
  } catch (e) {
    console.error('[sbQ] ' + table + ' threw:', e);
    return [];
  }
}

async function sbInsert(table, payload) {
  if (!sb) return null;
  if (!orgId) throw new Error('Cannot insert into ' + table + ' without orgId');
  payload.org_id = orgId;
  const { data, error } = await sb.from(table).insert([payload]).select();
  if (error) throw error;
  return data && data[0];
}

async function sbUpdate(table, payload, id) {
  if (!sb) return;
  const { error } = await sb.from(table).update(payload).eq('id', id);
  if (error) throw error;
}

async function sbDelete(table, id) {
  if (!sb) return;
  await sb.from(table).delete().eq('id', id);
}

// ── Row mappers ───────────────────────────────────────────────
// These shape the raw Postgres rows into the format render.js expects.
// One mapper per table — keeps refreshTable() clean.

const MAPPERS = {
  participants: r => ({
    id: r.id,
    first_name: r.first_name || '',
    last_name:  r.last_name  || '',
    ref_source: r.ref_source || 'Self-referral',
    stage:      r.stage || 'Referred',
    advisor:    r.advisor || 'Unassigned',
    barriers:   toArr(r.barriers),
    outcomes:   toArr(r.outcomes),
    safeguarding: r.safeguarding || null,
    risk:       r.risk || 'Low',
    last_contact: r.last_contact || null,
    notes:      toArr(r.notes),
    scores:     r.scores || {},
    contract_ids: toArr(r.contract_ids),
    equality_data: r.equality_data || {},
    phone:      r.phone || '',
    email:      r.email || '',
    owner_user_id: r.owner_user_id || null
  }),
  volunteers: r => ({
    id: r.id,
    name: r.name || [r.first_name, r.last_name].filter(Boolean).join(' ') || 'Unknown',
    email: r.email || '',
    phone: r.phone || '',
    role: r.role || 'Volunteer',
    skills: toArr(r.skills),
    hours: num(r.hours),
    status: r.status || 'Active'
  }),
  events: r => ({
    id: r.id,
    name: r.name || '',
    type: r.type || 'Other',
    date: r.event_date || r.date || '',
    attendees: num(r.attendees),
    capacity: num(r.capacity) || 20,
    location: r.location || ''
  }),
  feedback: r => ({
    id: r.id,
    eventId: r.event_id || r.eventId,
    name: r.name || '',
    enjoyed: num(r.enjoyed) || 3,
    cb: num(r.cb) || 3,
    ca: num(r.ca) || 3,
    learned: !!r.learned,
    connected: !!r.connected,
    friend: !!r.friend,
    quote: r.quote || ''
  }),
  contacts: r => ({
    id: r.id,
    first_name: r.first_name || '',
    last_name:  r.last_name  || '',
    email: r.email || '',
    role: r.role || '',
    status: r.status || 'Prospect'
  }),
  employers: r => ({
    id: r.id,
    name: r.name || '',
    sector: r.sector || '',
    contact_name: r.contact_name || '',
    contact_email: r.contact_email || '',
    vacancies: num(r.vacancies),
    placements: num(r.placements),
    relationship: r.relationship || 'Prospecting',
    notes: r.notes || ''
  }),
  circular: r => ({
    id: r.id,
    name: r.name || '',
    category: r.category || '',
    weight_kg: num(r.weight_kg),
    status: r.status || 'Collected',
    fixer: r.fixer || '',
    outcome: r.outcome || ''
  }),
  contracts: r => ({
    id: r.id,
    name: r.name || '',
    funder: r.funder || '',
    funder_id: r.funder_id ? String(r.funder_id) : null,
    report_type: r.report_type || 'other',
    value: num(r.value),
    target_starts: num(r.target_starts),
    actual_starts: num(r.actual_starts || 0),
    target_outcomes: num(r.target_outcomes),
    actual_outcomes: num(r.actual_outcomes || 0),
    start_date: r.start_date || '',
    end_date: r.end_date || '',
    status: r.status || 'live'
  }),
  evidence: r => ({
    id: r.id,
    participant_name: r.participant_name || '',
    type: r.type || '',
    linked_outcome: r.linked_outcome || '',
    staff: r.staff || '',
    evidence_date: r.evidence_date || '',
    status: r.status || 'Pending'
  }),
  referrals: r => ({
    id: r.id,
    first_name: r.first_name || '',
    last_name:  r.last_name  || '',
    source: r.source || '',
    status: r.status || 'Referred',
    advisor: r.advisor || '',
    referred_date: r.referred_date || ''
  }),
  partner_referrals: r => ({
    id: r.id,
    partner_name: r.partner_name || '',
    first_name: r.first_name || '',
    last_name:  r.last_name  || '',
    primary_need: r.primary_need || '',
    urgency: r.urgency || 'Standard',
    notes: r.notes || '',
    barriers: toArr(r.barriers),
    safeguarding: r.safeguarding || '',
    consent: !!r.consent,
    status: r.status || 'Referred',
    created_at: r.created_at || ''
  }),
  funders: r => ({
    id: r.id,
    name: r.name || '',
    type: r.type || 'other',
    contact_name: r.contact_name || '',
    contact_email: r.contact_email || '',
    notes: r.notes || ''
  })
};

// Maps Postgres table names to DB cache keys
const TABLE_TO_DB_KEY = {
  participants:      'participants',
  volunteers:        'volunteers',
  events:            'events',
  feedback:          'feedback',
  contacts:          'contacts',
  employers:         'employers',
  circular_items:    'circular',
  contracts:         'contracts',
  evidence:          'evidence',
  referrals:         'referrals',
  partner_referrals: 'partner_referrals',
  funders:           'funders'
};

// Maps DB cache keys back to mapper names (mostly identity, except circular)
const DB_KEY_TO_MAPPER = {
  participants:      'participants',
  volunteers:        'volunteers',
  events:            'events',
  feedback:          'feedback',
  contacts:          'contacts',
  employers:         'employers',
  circular:          'circular',
  contracts:         'contracts',
  evidence:          'evidence',
  referrals:         'referrals',
  partner_referrals: 'partner_referrals',
  funders:           'funders'
};

// ── Sync ──────────────────────────────────────────────────────

// Pull every table at once. Used on boot and full refresh.
async function syncAll() {
  if (!sb) return;
  const tables = [
    'participants', 'volunteers', 'events', 'feedback',
    'contacts', 'employers', 'circular_items', 'contracts',
    'evidence', 'referrals', 'partner_referrals', 'funders'
  ];
  const results = await Promise.all(tables.map(t => sbQ(t)));
  tables.forEach((tbl, i) => {
    const data = results[i];
    if (!data) return;
    const dbKey = TABLE_TO_DB_KEY[tbl];
    const mapper = MAPPERS[dbKey];
    if (mapper) DB[dbKey] = data.map(mapper);
  });
}

// Refresh a single table (faster than syncAll after a save)
async function refreshTable(table) {
  const fresh = await sbQ(table);
  if (!fresh) return;
  const dbKey = TABLE_TO_DB_KEY[table] || table;
  const mapper = MAPPERS[DB_KEY_TO_MAPPER[dbKey] || dbKey];
  if (mapper) DB[dbKey] = fresh.map(mapper);
}
