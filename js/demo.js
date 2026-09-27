// js/demo.js — sample data for every feature
// Depends on: utils.js, db.js, render.js, router.js
//
// Demo mode shows a full, believable organisation's worth of sample
// data alongside real data so every page can be explored: caseload,
// referrals, volunteers and hours, events, feedback with quotes and
// demographics, funders and contracts, employers, evidence, and the
// whole circular economy (devices with a chain of custody, repair
// café, growing, textiles, collections — see cxDemoSeed in circular.js).
//
// SAFETY: demo rows live in memory only. Every id starts "demo-" and
// every write aimed at one is applied in memory and never reaches
// Supabase. Turning demo mode off removes them all.

'use strict';

let _demoMode = safeStorage.get('demo_mode') === 'on';

// Repeatable "random" so the demo looks the same every time
function _demoRng(seed) { return function () { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function _dIso(daysAgo) { return new Date(Date.now() - daysAgo * 864e5).toISOString().slice(0, 10); }

function buildDemoData() {
  const R = _demoRng(20260927);
  const pick = a => a[Math.floor(R() * a.length)];
  const int = (a, b) => a + Math.floor(R() * (b - a + 1));
  const D = { funders: [], contracts: [], participants: [], referrals: [], partner_referrals: [], volunteers: [], volunteer_hours: [],
    events: [], feedback: [], survey_measures: [], employers: [], contacts: [], evidence: [] };

  // ── Funders and contracts ──────────────────────────────────
  D.funders = [
    { id: 'demo-f-1', _demo: true, name: 'Riverside Council (DEMO)', type: 'council', contact_name: 'Helen Price', contact_email: 'h.price@example.gov.uk', notes: 'Waste reduction and digital inclusion.' },
    { id: 'demo-f-2', _demo: true, name: 'Green Futures Fund (DEMO)', type: 'trust', contact_name: 'Tom Ellis', contact_email: 'tom@example.org', notes: 'Food growing and wellbeing.' },
    { id: 'demo-f-3', _demo: true, name: 'Into Work Partnership (DEMO)', type: 'dwp', contact_name: 'Amira Khan', contact_email: 'a.khan@example.gov.uk', notes: 'Job starts and 13-week sustainment.' }
  ];
  const cStart = _dIso(200), cEnd = new Date(Date.now() + 165 * 864e5).toISOString().slice(0, 10);
  D.contracts = [
    { id: 'demo-c-1', _demo: true, name: 'Into Work 2026 (DEMO)', funder: 'Into Work Partnership (DEMO)', funder_id: 'demo-f-3', report_type: 'other', value: 60000, target_starts: 30, actual_starts: 0, target_outcomes: 15, actual_outcomes: 0, start_date: cStart, end_date: cEnd, status: 'live' },
    { id: 'demo-c-2', _demo: true, name: 'Tech Rehome (DEMO)', funder: 'Riverside Council (DEMO)', funder_id: 'demo-f-1', report_type: 'other', value: 25000, target_starts: 0, actual_starts: 0, target_outcomes: 0, actual_outcomes: 0, start_date: cStart, end_date: cEnd, status: 'live' },
    { id: 'demo-c-3', _demo: true, name: 'Grow & Share (DEMO)', funder: 'Green Futures Fund (DEMO)', funder_id: 'demo-f-2', report_type: 'other', value: 12000, target_starts: 0, actual_starts: 0, target_outcomes: 0, actual_outcomes: 0, start_date: cStart, end_date: cEnd, status: 'live' }
  ];

  // ── People ─────────────────────────────────────────────────
  const first = ['Aisha', 'Marcus', 'Priya', 'James', 'Fatima', 'Daniel', 'Grace', 'Tomasz', 'Leah', 'Kwame', 'Sophie', 'Ali', 'Chloe', 'Nathan', 'Zainab', 'Ryan', 'Ewa', 'Jordan', 'Mei', 'Callum', 'Hana', 'Oliver', 'Blessing', 'Liam'];
  const last = ['Okonkwo', 'Webb', 'Sharma', 'Okafor', 'Hussain', 'Clarke', 'Mensah', 'Nowak', 'Barnes', 'Asante', 'Taylor', 'Rahman', 'Evans', 'Price', 'Begum', 'Murphy', 'Kowalska', 'Lewis', 'Chen', 'Reid', 'Ahmed', 'Hughes', 'Adeyemi', 'Walsh'];
  const ages = ['16–24', '25–34', '35–44', '45–54', '55–64', '65+'];
  const eths = ['White British', 'White British', 'White Other', 'Black/Black British', 'Asian/Asian British', 'Asian/Asian British', 'Mixed/Multiple', 'Arab', 'White Irish'];
  const gens = ['Woman', 'Man', 'Woman', 'Man', 'Non-binary'];
  const dis = ['No', 'No', 'No', 'Yes'];
  const pcs = ['PE1 2AB', 'PE1 5QT', 'PE2 8LN', 'PE3 6DB', 'PE4 7RZ', 'PE7 1XP'];
  const eq = () => ({ age: pick(ages), ethnicity: pick(eths), gender: pick(gens), disability: pick(dis), postcode: pick(pcs) });
  const stages = ['Referred', 'Engaged', 'In Support', 'In Support', 'Job Ready', 'Outcome Achieved', 'Outcome Achieved'];
  const sources = ['Jobcentre Plus', 'Probation', 'Self-referral', 'Community org', 'Housing provider', 'GP / social prescriber'];
  const barriers = ['Confidence', 'Housing', 'Skills gap', 'Childcare', 'Mental health', 'Digital access', 'Criminal record', 'English language', 'Transport'];
  const advisors = ['Sarah T.', 'Marcus O.', 'Priya S.'];
  for (let i = 0; i < 24; i++) {
    const st = pick(stages);
    const done = st === 'Outcome Achieved';
    const base = int(2, 5);
    D.participants.push({
      id: 'demo-p-' + (i + 1), _demo: true, first_name: first[i], last_name: last[i], ref_source: pick(sources), stage: st,
      advisor: pick(advisors), barriers: [pick(barriers), pick(barriers)].filter((v, k, a) => a.indexOf(v) === k),
      outcomes: done ? [pick(['Employment', 'Employment', 'Training', 'Volunteering', 'Education'])] : (st === 'Job Ready' ? ['Training'] : []),
      risk: pick(['Low', 'Low', 'Medium', 'High']), last_contact: _dIso(int(0, 30)),
      notes: [{ t: pick(['Initial assessment completed.', 'CV reviewed and updated.', 'Mock interview went well.', 'Referred to digital skills course.', 'Received a refurbished laptop.']), d: _dIso(int(1, 40)), s: pick(advisors) }],
      scores: { confidence: Math.min(10, base + (done ? 5 : int(0, 3))), work_readiness: Math.min(10, base + (done ? 5 : int(0, 3))), wellbeing: int(4, 9), skills: int(3, 9) },
      safeguarding: i === 2 ? 'Mental health' : null, contract_ids: i < 20 ? ['demo-c-1'] : [],
      phone: '07700 9' + String(10000 + i).slice(1), email: first[i].toLowerCase() + '@example.com', equality_data: R() < 0.85 ? eq() : {}
    });
  }
  D.referrals = [0, 1, 2, 3].map(i => ({ id: 'demo-r-' + (i + 1), _demo: true, first_name: pick(first), last_name: pick(last), source: pick(sources), status: pick(['Referred', 'Contacted', 'Booked']), advisor: pick(advisors), referred_date: _dIso(int(1, 12)) }));
  D.partner_referrals = [
    { id: 'demo-pr-1', _demo: true, partner_name: 'Riverside Housing (DEMO)', first_name: 'Dean', last_name: 'Foster', primary_need: 'Employment support', urgency: 'Standard', notes: 'Keen to get back into warehouse work.', barriers: ['Transport'], safeguarding: '', consent: true, status: 'Referred', created_at: _dIso(3) },
    { id: 'demo-pr-2', _demo: true, partner_name: 'Hope Food Bank (DEMO)', first_name: 'Rosa', last_name: 'Silva', primary_need: 'Digital skills', urgency: 'Priority', notes: 'Needs a device for job searching.', barriers: ['Digital access'], safeguarding: '', consent: true, status: 'Accepted', created_at: _dIso(9) }
  ];

  const vNames = ['Hannah Green', 'Dev Patel', 'Margaret Hill', 'Sam Okoro', 'Lucy Brennan', 'Tariq Ali', 'Joan Fletcher', 'Kofi Boateng', 'Ellie Ward', 'Pete Morris'];
  const vSkills = [['Gardening', 'Teaching/Facilitation'], ['IT support', 'Data wiping'], ['Sewing', 'Retail'], ['Electrical repair', 'PAT testing'], ['Admin'], ['Driving', 'Collections'], ['Gardening'], ['Electrical repair'], ['Social media'], ['Bike repair', 'Driving']];
  vNames.forEach((n, i) => D.volunteers.push({ id: 'demo-v-' + (i + 1), _demo: true, name: n, email: n.split(' ')[0].toLowerCase() + '@example.com', phone: '', role: i === 0 ? 'Staff' : 'Volunteer', skills: vSkills[i], hours: 0, status: i === 9 ? 'Inactive' : 'Active', equality_data: R() < 0.7 ? eq() : {} }));

  // ── Events over the last 8 months ──────────────────────────
  const evTypes = [
    ['Repair Café (DEMO)', 'Repair', ['demo-c-2']], ['Job Club (DEMO)', 'Employability', ['demo-c-1']], ['Harvest Day (DEMO)', 'Growing', ['demo-c-3']],
    ['Digital Skills Drop-in (DEMO)', 'Digital', ['demo-c-1', 'demo-c-2']], ['Clothes Swap (DEMO)', 'Community', []], ['CV & Interview Workshop (DEMO)', 'Employability', ['demo-c-1']]
  ];
  for (let i = 0; i < 18; i++) {
    const t = evTypes[i % evTypes.length];
    const cap = int(12, 25);
    D.events.push({ id: 'demo-e-' + (i + 1), _demo: true, name: t[0], type: t[1], date: _dIso(i === 0 ? 0 : 7 + i * 12 + int(0, 5)), attendees: Math.min(cap, int(8, cap)), capacity: cap, location: pick(['Riverside Hub', 'Community Garden', 'Library Hall']), contract_ids: t[2].slice(), import_batch: null, question_ids: null });
  }

  // ── Volunteer hours ────────────────────────────────────────
  let hid = 0;
  D.events.forEach(ev => {
    const n = int(2, 4);
    for (let k = 0; k < n; k++) {
      const v = pick(D.volunteers.slice(0, 9));
      const h = pick([2, 2.5, 3, 3, 4]);
      D.volunteer_hours.push({ id: 'demo-h-' + (++hid), _demo: true, volunteer_id: v.id, event_id: ev.id, date: ev.date, hours: h, activity: ev.type, source: 'staff' });
      v.hours += h;
    }
  });
  for (let k = 0; k < 10; k++) {   // some admin/driving time not tied to a session
    const v = pick(D.volunteers.slice(0, 9)); const h = pick([1.5, 2, 3]);
    D.volunteer_hours.push({ id: 'demo-h-' + (++hid), _demo: true, volunteer_id: v.id, event_id: null, date: _dIso(int(5, 200)), hours: h, activity: pick(['Collections run', 'Admin', 'Sorting donations']), source: 'staff' });
    v.hours += h;
  }

  // ── Feedback questions and responses ───────────────────────
  const Q = DEFAULT_MEASURES;
  D.survey_measures = Q.map((m, i) => Object.assign({ id: 'demo-m-' + (i + 1), _demo: true, active: true, sort: i }, m));
  const quotes = ['I didn\'t know my kettle could be fixed — saved me buying a new one.', 'The volunteers were so patient with me.', 'I feel ready to apply for jobs now.', 'Lovely to take home fresh vegetables for the kids.',
    'I met people from my street I\'d never spoken to.', 'Getting a laptop has changed everything for my job search.', 'Really practical — I updated my CV on the day.', 'A safe, friendly space.', 'I learned to change a fuse!', 'Brilliant session, can\'t wait for the next one.'];
  let fid = 0;
  D.events.forEach(ev => {
    const n = Math.max(3, Math.round(ev.attendees * (0.45 + R() * 0.35)));
    for (let k = 0; k < n; k++) {
      const cb = int(1, 3), ca = Math.min(5, cb + int(1, 2)), en = int(3, 5);
      const learned = R() < 0.82, connected = R() < 0.7, friend = R() < 0.45;
      const quote = R() < 0.35 ? pick(quotes) : '';
      const answers = {};
      answers[Q[0].question] = en; answers[Q[1].question] = cb; answers[Q[2].question] = ca;
      answers[Q[3].question] = learned ? 'Yes' : 'No'; answers[Q[4].question] = connected ? 'Yes' : 'No'; answers[Q[5].question] = friend ? 'Yes' : 'No';
      if (quote) answers[Q[6].question] = quote;
      D.feedback.push({ id: 'demo-fb-' + (++fid), _demo: true, eventId: ev.id, name: R() < 0.6 ? 'Anonymous' : pick(first) + ' ' + pick(last).charAt(0) + '.',
        enjoyed: en, cb, ca, learned, connected, friend, quote, answers,
        demographics: R() < 0.5 ? { age: pick(ages), ethnicity: pick(eths), gender: pick(gens) } : {}, import_batch: null, created_at: ev.date + 'T15:00:00Z' });
    }
  });

  // ── Employers, contacts, evidence ──────────────────────────
  D.employers = [
    { id: 'demo-em-1', _demo: true, name: 'Greenway Logistics (DEMO)', sector: 'Logistics', contact_name: 'Karen Doyle', contact_email: 'karen@example.com', vacancies: 6, placements: 4, relationship: 'Active partner', notes: 'Warehouse operatives, flexible shifts.' },
    { id: 'demo-em-2', _demo: true, name: 'Riverside Retrofit (DEMO)', sector: 'Construction', contact_name: 'Gary Holt', contact_email: 'gary@example.com', vacancies: 3, placements: 2, relationship: 'Active partner', notes: 'Green skills — insulation and retrofit.' },
    { id: 'demo-em-3', _demo: true, name: 'City Care Homes (DEMO)', sector: 'Health & care', contact_name: 'Nadia Iqbal', contact_email: 'nadia@example.com', vacancies: 5, placements: 1, relationship: 'Engaged', notes: 'Care assistants, training provided.' },
    { id: 'demo-em-4', _demo: true, name: 'ReUse Store (DEMO)', sector: 'Retail', contact_name: 'Leon Park', contact_email: 'leon@example.com', vacancies: 2, placements: 0, relationship: 'Prospecting', notes: 'Retail assistants for the new hub shop.' }
  ];
  D.contacts = [
    { id: 'demo-ct-1', _demo: true, first_name: 'Helen', last_name: 'Price', email: 'h.price@example.gov.uk', role: 'Council funder', status: 'Active' },
    { id: 'demo-ct-2', _demo: true, first_name: 'Robert', last_name: 'Lane', email: 'robert@example.com', role: 'Corporate laptop donor', status: 'Active' },
    { id: 'demo-ct-3', _demo: true, first_name: 'Maya', last_name: 'Green', email: 'maya@example.com', role: 'Trustee', status: 'Active' },
    { id: 'demo-ct-4', _demo: true, first_name: 'Owen', last_name: 'Day', email: 'owen@example.com', role: 'Local business', status: 'Prospect' }
  ];
  const done = D.participants.filter(p => p.stage === 'Outcome Achieved');
  D.evidence = done.slice(0, 5).map((p, i) => ({ id: 'demo-ev-' + (i + 1), _demo: true, participant_name: p.first_name + ' ' + p.last_name, type: pick(['Payslip', 'Employer letter', 'Certificate']), linked_outcome: p.outcomes[0] || 'Employment', staff: p.advisor, evidence_date: _dIso(int(3, 60)), status: i === 4 ? 'Pending' : 'Verified' }));

  // Contract progress from the participants above
  const c1 = D.contracts[0];
  c1.actual_starts = D.participants.filter(p => p.contract_ids.includes('demo-c-1') && p.stage !== 'Referred').length;
  c1.actual_outcomes = D.participants.filter(p => p.contract_ids.includes('demo-c-1') && p.stage === 'Outcome Achieved').length;
  return D;
}

let DEMO_DATA = null;
const DEMO_KEYS = ['participants', 'referrals', 'partner_referrals', 'volunteers', 'volunteer_hours', 'events', 'feedback', 'survey_measures',
  'contracts', 'funders', 'employers', 'contacts', 'evidence'];

function _demoAdd(k) {
  if (!DEMO_DATA || !DEMO_DATA[k]) return;
  // Sample questions only when the organisation hasn't set its own
  if (k === 'survey_measures' && (DB.survey_measures || []).some(r => !r._demo)) return;
  DB[k] = (DB[k] || []).filter(r => !r._demo).concat(DEMO_DATA[k]);
}
// Put demo rows back if a reload of real data replaced them
function ensureDemoRows() {
  if (!_demoMode || !DEMO_DATA) return;
  DEMO_KEYS.forEach(k => { if (!(DB[k] || []).some(r => r._demo)) _demoAdd(k); });
}

function loadDemoData() {
  DEMO_DATA = buildDemoData();
  DEMO_KEYS.forEach(_demoAdd);
  _demoMode = true;
  safeStorage.set('demo_mode', 'on');
  if (typeof cxDemoClear === 'function') cxDemoClear();   // circular sample is built fresh on first use
  if (typeof CXR !== 'undefined') CXR.at = 0;
  _demoInstallGuards();
  applyDemoBanner();
  // Some pages load their own tables a moment after start-up
  [1500, 4000, 9000].forEach(ms => setTimeout(ensureDemoRows, ms));
}

function unloadDemoData() {
  DEMO_KEYS.forEach(k => { DB[k] = (DB[k] || []).filter(r => !r._demo); });
  _demoMode = false;
  DEMO_DATA = null;
  safeStorage.set('demo_mode', 'off');
  if (typeof cxDemoClear === 'function') cxDemoClear();
  if (typeof CXR !== 'undefined') CXR.at = 0;
  applyDemoBanner();
}

// Writes aimed at demo rows stay in memory; demo rows survive reloads
let _demoGuarded = false;
function _demoInstallGuards() {
  if (_demoGuarded) return;
  _demoGuarded = true;
  const isDemo = id => String(id || '').indexOf('demo-') === 0;
  const keyFor = t => (typeof TABLE_TO_DB_KEY !== 'undefined' && TABLE_TO_DB_KEY[t]) || t;
  const upd0 = sbUpdate, del0 = sbDelete, ref0 = refreshTable;
  sbUpdate = async function (table, payload, id) {
    if (isDemo(id)) { const r = (DB[keyFor(table)] || []).find(x => String(x.id) === String(id)); if (r) Object.assign(r, payload); return; }
    return upd0(table, payload, id);
  };
  sbDelete = async function (table, id) {
    if (isDemo(id)) { const k = keyFor(table); DB[k] = (DB[k] || []).filter(x => String(x.id) !== String(id)); return; }
    return del0(table, id);
  };
  refreshTable = async function (table) { await ref0(table); ensureDemoRows(); };
  if (typeof window.go === 'function' && !window.go._demo) {
    const go0 = window.go;
    window.go = function () { ensureDemoRows(); return go0.apply(this, arguments); };
    window.go._demo = true;
  }
}

function applyDemoBanner() {
  let banner = $('demo-mode-banner');
  if (_demoMode) {
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'demo-mode-banner';
      banner.style.cssText = 'background:linear-gradient(90deg,#F59E0B,#FBBF24);color:#1a1a1a;padding:8px 20px;font-size:12px;font-weight:700;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;position:relative;z-index:50';
      banner.innerHTML =
        '<span>🎭 Demo mode — sample data is shown alongside yours on every page. Anything you do to sample rows is never saved.</span>' +
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
  const active = document.querySelector('.page.active');
  if (active) go(active.id.replace('page-', ''));
  const track = $('demo-toggle-track');
  const thumb = $('demo-toggle-thumb');
  if (track) track.style.background = _demoMode ? '#F59E0B' : '#E0DAD0';
  if (thumb) thumb.style.left = _demoMode ? '23px' : '3px';
  const tog = $('demo-toggle');
  if (tog) tog.setAttribute('onclick', 'toggleDemoMode(' + (!_demoMode) + ')');
}
