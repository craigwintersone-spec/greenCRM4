// js/demo.js — sample data toggle for empty / demo orgs
// Depends on: utils.js, db.js, render.js, router.js
//
// When demo mode is on, sample participants/events/feedback are
// added to the in-memory DB *only* — they are tagged `_demo: true`
// and never written to Supabase. Toggling off removes them.

'use strict';

let _demoMode = safeStorage.get('demo_mode') === 'on';

const DEMO_DATA = {
  funders: [
    { id: 'demo-f-1', _demo: true, name: 'Ministry of Justice (DEMO)', type: 'moj',
      contact_name: 'Sarah Thompson', contact_email: 's.thompson@example.gov.uk',
      notes: 'Focus on sustained employment outcomes.' },
    { id: 'demo-f-2', _demo: true, name: 'City Bridge Foundation (DEMO)', type: 'cbf',
      contact_name: 'James Wright', contact_email: 'j.wright@example.org',
      notes: 'Wellbeing and community resilience.' }
  ],
  contracts: [
    { id: 'demo-c-1', _demo: true, name: 'MoJ Employment Support 2024-25 (DEMO)',
      funder: 'Ministry of Justice (DEMO)', funder_id: 'demo-f-1', report_type: 'moj',
      value: 45000, target_starts: 25, target_outcomes: 15,
      actual_starts: 0, actual_outcomes: 0,
      start_date: '2024-04-01', end_date: '2025-03-31', status: 'live' }
  ],
  participants: [
    { id: 'demo-p-1', _demo: true, first_name: 'Aisha', last_name: 'Okonkwo',
      ref_source: 'Probation', stage: 'In Support', advisor: 'Sarah T.',
      barriers: ['Confidence', 'Housing'], outcomes: [], risk: 'Medium',
      last_contact: today(),
      notes: [{ t: 'Initial assessment completed.', d: today(), s: 'Sarah T.' }],
      scores: { confidence: 6, work_readiness: 5, wellbeing: 7, skills: 5 },
      safeguarding: null, contract_ids: ['demo-c-1'],
      phone: '07700 900001', email: 'aisha@example.com', equality_data: {} },
    { id: 'demo-p-2', _demo: true, first_name: 'Marcus', last_name: 'Webb',
      ref_source: 'Jobcentre Plus', stage: 'Job Ready', advisor: 'Marcus O.',
      barriers: ['Skills gap'], outcomes: ['Training'], risk: 'Low',
      last_contact: today(), notes: [],
      scores: { confidence: 8, work_readiness: 8, wellbeing: 7, skills: 7 },
      safeguarding: null, contract_ids: ['demo-c-1'],
      phone: '', email: '', equality_data: {} },
    { id: 'demo-p-3', _demo: true, first_name: 'Priya', last_name: 'Sharma',
      ref_source: 'Community org', stage: 'Engaged', advisor: 'Priya S.',
      barriers: ['Childcare', 'Mental health'], outcomes: [], risk: 'High',
      last_contact: new Date(Date.now() - 25 * 86400000).toISOString().split('T')[0],
      notes: [],
      scores: { confidence: 3, work_readiness: 2, wellbeing: 4, skills: 4 },
      safeguarding: 'Mental health', contract_ids: ['demo-c-1'],
      phone: '', email: '', equality_data: {} },
    { id: 'demo-p-4', _demo: true, first_name: 'James', last_name: 'Okafor',
      ref_source: 'Self-referral', stage: 'Outcome Achieved', advisor: 'Sarah T.',
      barriers: ['Criminal record'], outcomes: ['Employment', 'Volunteering'], risk: 'Low',
      last_contact: today(),
      notes: [{ t: 'Started full-time role.', d: today(), s: 'Sarah T.' }],
      scores: { confidence: 9, work_readiness: 9, wellbeing: 8, skills: 8 },
      safeguarding: null, contract_ids: ['demo-c-1'],
      phone: '', email: '', equality_data: {} }
  ],
  events: [
    { id: 'demo-e-1', _demo: true, name: 'Green Skills Workshop (DEMO)',
      type: 'Green Skills', date: today(), attendees: 18, capacity: 20, location: 'East London' },
    { id: 'demo-e-2', _demo: true, name: 'Wellbeing Drop-in (DEMO)',
      type: 'Wellbeing', date: today(), attendees: 12, capacity: 15, location: 'East London' }
  ],
  feedback: [
    { id: 'demo-fb-1', _demo: true, eventId: 'demo-e-1', name: 'Aisha O.',
      enjoyed: 5, cb: 3, ca: 5, learned: true, connected: true, friend: false,
      quote: 'I learned so much about retrofitting.' },
    { id: 'demo-fb-2', _demo: true, eventId: 'demo-e-2', name: 'Anonymous',
      enjoyed: 4, cb: 2, ca: 4, learned: true, connected: true, friend: true,
      quote: 'A safe space to talk.' }
  ],
  volunteers: [
    { id: 'demo-v-1', _demo: true, name: 'Hannah Green',
      email: 'hannah@example.com', phone: '07700 900100', role: 'Volunteer',
      skills: ['Gardening', 'Teaching/Facilitation'], hours: 24, status: 'Active' }
  ],
  employers: [],
  partner_referrals: []
};

const DEMO_KEYS = [
  'participants', 'events', 'feedback', 'volunteers',
  'contracts', 'funders', 'employers', 'partner_referrals'
];

function loadDemoData() {
  // Strip any existing demo rows first (so we don't duplicate)
  DEMO_KEYS.forEach(k => { DB[k] = (DB[k] || []).filter(r => !r._demo); });
  // Add fresh demo rows
  DEMO_KEYS.forEach(k => { if (DEMO_DATA[k]) DB[k] = DB[k].concat(DEMO_DATA[k]); });
  _demoMode = true;
  safeStorage.set('demo_mode', 'on');
  applyDemoBanner();
}

function unloadDemoData() {
  DEMO_KEYS.forEach(k => { DB[k] = (DB[k] || []).filter(r => !r._demo); });
  _demoMode = false;
  safeStorage.set('demo_mode', 'off');
  applyDemoBanner();
}

function applyDemoBanner() {
  let banner = $('demo-mode-banner');
  if (_demoMode) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'demo-mode-banner';
      banner.style.cssText = 'background:linear-gradient(90deg,#F59E0B,#FBBF24);color:#1a1a1a;padding:8px 20px;font-size:12px;font-weight:700;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap';
      banner.innerHTML =
        '<span>🎭 DEMO MODE — sample data shown alongside your real data. Demo rows are tagged (DEMO) and never saved.</span>' +
        '<button class="btn btn-sm" style="background:#1a1a1a;color:#FBBF24;border:none" onclick="toggleDemoMode(false)">Turn off demo</button>';
      document.body.insertBefore(banner, document.body.firstChild);
    }
  } else if (banner) {
    banner.remove();
  }
}

async function toggleDemoMode(on) {
  if (on) loadDemoData();
  else unloadDemoData();

  // Re-render whichever page is active
  const active = document.querySelector('.page.active');
  if (active) go(active.id.replace('page-', ''));

  // Update toggle visuals if present
  const track = $('demo-toggle-track');
  const thumb = $('demo-toggle-thumb');
  if (track) track.style.background = _demoMode ? '#F59E0B' : '#E0DAD0';
  if (thumb) thumb.style.left = _demoMode ? '23px' : '3px';
  const tog = $('demo-toggle');
  if (tog) tog.setAttribute('onclick', 'toggleDemoMode(' + (!_demoMode) + ')');
}
