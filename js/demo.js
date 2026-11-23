// js/demo.js — sample data for every feature
// Depends on: utils.js, db.js, render.js, router.js
//
// Demo mode shows a full, believable community charity's worth of sample
// data alongside real data so every page can be explored: caseload,
// referrals, volunteers and hours, events, feedback with quotes and
// demographics, funders and contracts, evidence, and the
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
  // A believable small community charity: a community garden, a repair café,
  // wellbeing walks for people referred by social prescribers, family cooking
  // sessions and a winter warm space. Six months of sessions, with attendance
  // that follows the seasons. Every name and organisation is made up.
  const R = _demoRng(20261123);
  const pick = a => a[Math.floor(R() * a.length)];
  const int = (a, b) => a + Math.floor(R() * (b - a + 1));
  const chance = p => R() < p;
  const D = { funders: [], contracts: [], participants: [], referrals: [], partner_referrals: [], volunteers: [], volunteer_hours: [],
    events: [], feedback: [], survey_measures: [], employers: [], contacts: [], evidence: [] };

  // Dates: the same weekday each week, counted back from today (negative = upcoming)
  const onDay = (dow, weeksAgo) => {
    const d = new Date(); d.setHours(12, 0, 0, 0);
    if (weeksAgo >= 0) d.setDate(d.getDate() - ((d.getDay() - dow + 7) % 7 || 7) - 7 * weeksAgo);
    else d.setDate(d.getDate() + (((dow - d.getDay() + 7) % 7) || 7) + 7 * (-weeksAgo - 1));
    return d.toISOString().slice(0, 10);
  };
  const season = iso => { const m = new Date(iso).getMonth(); return m >= 4 && m <= 7 ? 1 : (m === 3 || m === 8) ? 0.8 : 0.55; };
  const isWinter = iso => { const m = new Date(iso).getMonth(); return m >= 9 || m <= 2; };

  // ── Funders and contracts ──────────────────────────────────
  D.funders = [
    { id: 'demo-f-1', _demo: true, name: 'Fenmoor Community Foundation', type: 'trust', contact_name: 'Helen Price', contact_email: 'grants@fenmoorcf.example.org', notes: 'Two-year grant for the community garden. Six-monthly report, with case studies and photos.' },
    { id: 'demo-f-2', _demo: true, name: 'Riverside City Council', type: 'ukspf', contact_name: 'Tom Ellis', contact_email: 't.ellis@riverside.example.gov.uk', notes: 'UK Shared Prosperity Fund, Communities and Place. Quarterly claim with outputs.' },
    { id: 'demo-f-3', _demo: true, name: 'Riverside Health and Care Partnership', type: 'nhs', contact_name: 'Dr Amira Khan', contact_email: 'socialprescribing@rhcp.example.nhs.uk', notes: 'Pays for wellbeing walks for social prescribing referrals. Wants WEMWBS change and attendance.' }
  ];
  const cStart = _dIso(210), cEnd = _dIso(-155);
  D.contracts = [
    { id: 'demo-c-1', _demo: true, name: 'Grow Together 2026–28', funder: 'Fenmoor Community Foundation', funder_id: 'demo-f-1', report_type: 'other', value: 18500, target_starts: 30, actual_starts: 0, target_outcomes: 18, actual_outcomes: 0, start_date: cStart, end_date: _dIso(-520), status: 'live' },
    { id: 'demo-c-2', _demo: true, name: 'Repair and Reuse Riverside', funder: 'Riverside City Council', funder_id: 'demo-f-2', report_type: 'other', value: 24000, target_starts: 0, actual_starts: 0, target_outcomes: 0, actual_outcomes: 0, start_date: cStart, end_date: cEnd, status: 'live' },
    { id: 'demo-c-3', _demo: true, name: 'Walk and Talk Wellbeing', funder: 'Riverside Health and Care Partnership', funder_id: 'demo-f-3', report_type: 'other', value: 9800, target_starts: 20, actual_starts: 0, target_outcomes: 12, actual_outcomes: 0, start_date: cStart, end_date: cEnd, status: 'live' }
  ];

  // ── Staff and equality data ────────────────────────────────
  const staff = ['Jo Mason', 'Sam Patel', 'Rachel Adeyemi'];   // wellbeing lead, garden coordinator, community worker
  const ages = ['16–24', '25–34', '35–44', '35–44', '45–54', '55–64', '55–64', '65+', '65+', '65+'];   // skews older, like most community groups
  const eths = ['White British', 'White British', 'White British', 'White British', 'White British', 'White Other', 'White Other', 'Asian/Asian British', 'Asian/Asian British', 'Black/Black British', 'Mixed/Multiple', 'Prefer not to say'];
  const gens = ['Woman', 'Woman', 'Man', 'Man', 'Woman', 'Prefer not to say'];
  const pcs = ['PE1 2AB', 'PE1 3NS', 'PE1 5QT', 'PE2 8LN', 'PE3 6DB', 'PE4 7RZ', 'PE4 6HQ', 'PE7 1XP'];
  const eq = (o) => Object.assign({ age: pick(ages), ethnicity: pick(eths), gender: pick(gens), disability: chance(0.27) ? 'Yes' : 'No', postcode: pick(pcs) }, o || {});

  // ── People supported (walk referrals and garden regulars) ──
  // [first, last, contract, stage, source, barriers, outcomes, note, ageBand]
  const people = [
    ['Margaret', 'Hollis', 'demo-c-3', 'Sustained', 'GP / social prescriber', ['Mental health', 'Confidence'], ['Wellbeing', 'Volunteering'], 'Now helps lead the Thursday walk. Says she has her Thursdays back.', '65+'],
    ['Tomasz', 'Nowak', 'demo-c-1', 'Outcome Achieved', 'Self-referral', ['Language', 'Confidence'], ['Wellbeing', 'Qualification'], 'Passed Level 2 Food Hygiene. Brings his daughter to cooking sessions.', '35–44'],
    ['Aisha', 'Rahman', 'demo-c-3', 'Outcome Achieved', 'GP / social prescriber', ['Mental health'], ['Wellbeing'], 'WEMWBS up from 38 to 49 over 12 weeks.', '25–34'],
    ['Derek', 'Moss', 'demo-c-3', 'In Support', 'GP / social prescriber', ['Disability', 'Mental health'], [], 'Recent bereavement. Prefers the shorter route; walks with Margaret.', '65+'],
    ['Joanna', 'Kowalska', 'demo-c-1', 'Outcome Achieved', 'Family hub', ['Confidence', 'Language'], ['Volunteering'], 'Volunteers on Wednesdays and runs the seed swap stall.', '35–44'],
    ['Kevin', 'Burrows', 'demo-c-1', 'Engaged', 'Housing association', ['Mental health', 'Financial'], [], 'Came twice. Interested in the polytunnel; Sam to call him.', '45–54'],
    ['Shabana', 'Begum', 'demo-c-3', 'In Support', 'GP / social prescriber', ['Mental health', 'Childcare'], [], 'Can only come in school hours. Moved to the Tuesday warm space in winter.', '35–44'],
    ['Gintaras', 'Petrauskas', 'demo-c-1', 'In Support', 'Self-referral', ['Language'], [], 'Experienced grower. Keen to help others; offered him the volunteer induction.', '55–64'],
    ['Patricia', 'Owusu', 'demo-c-3', 'Outcome Achieved', 'GP / social prescriber', ['Disability', 'Confidence'], ['Wellbeing'], 'Uses a walking frame; the flat route works well. Much less isolated.', '65+'],
    ['Liam', 'Carter', 'demo-c-1', 'Referred', 'Youth service', ['Confidence'], [], 'Referred by youth worker. First visit booked for next Wednesday.', '16–24'],
    ['Ewa', 'Zielinska', 'demo-c-1', 'Outcome Achieved', 'Family hub', ['Financial', 'Childcare'], ['Wellbeing', 'Training'], 'Completed the 6-week cook and eat course with her two children.', '25–34'],
    ['Brian', 'Ashworth', 'demo-c-3', 'Closed', 'GP / social prescriber', ['Mental health', 'Transport'], [], 'Moved to Lincoln. Signposted to a walking group there.', '55–64'],
    ['Nadia', 'Hussain', 'demo-c-3', 'In Support', 'Self-referral', ['Mental health', 'Confidence'], [], 'Found us through the library. Week 5 of 12.', '45–54'],
    ['Graham', 'Pike', 'demo-c-1', 'Outcome Achieved', 'Self-referral', ['Mental health'], ['Volunteering'], 'Retired engineer; now a repair café fixer as well.', '65+'],
    ['Fatima', 'Ali', 'demo-c-1', 'In Support', 'Family hub', ['Language', 'Childcare'], [], 'Attends with her toddler. ESOL class at the library on Mondays.', '25–34'],
    ['Stephen', 'Walsh', 'demo-c-3', 'Engaged', 'GP / social prescriber', ['Mental health', 'Substance misuse'], [], 'Attended first walk. Link worker is aware and in touch.', '45–54'],
    ['Olena', 'Shevchenko', 'demo-c-1', 'Outcome Achieved', 'Community org', ['Language', 'Mental health'], ['Wellbeing', 'Volunteering'], 'Runs the herb bed. Says the garden feels like home.', '35–44'],
    ['Pauline', 'Hart', 'demo-c-3', 'Sustained', 'GP / social prescriber', ['Confidence'], ['Wellbeing'], 'Finished 12 weeks in summer and still comes every week.', '65+'],
    ['Daniel', 'Okafor', 'demo-c-1', 'In Support', 'Housing association', ['Housing', 'Mental health'], [], 'In temporary housing. Takes veg home each week.', '25–34'],
    ['Maria', 'Ferreira', 'demo-c-1', 'Engaged', 'Self-referral', ['Language'], [], 'Came to harvest day; wants to bring her neighbour.', '45–54'],
    ['Alan', 'Whitmore', 'demo-c-3', 'In Support', 'GP / social prescriber', ['Disability', 'Mental health'], [], 'COPD; walks part of the route and joins the café chat.', '65+'],
    ['Chloe', 'Bennett', 'demo-c-3', 'Referred', 'GP / social prescriber', ['Mental health'], [], 'New referral from the link worker. Rachel to phone this week.', '16–24'],
    ['Imran', 'Shah', 'demo-c-1', 'Outcome Achieved', 'Community org', ['Confidence'], ['Training'], 'Completed the RHS Level 1 taster at the college.', '16–24'],
    ['Susan', 'Clarke', 'demo-c-3', 'Outcome Achieved', 'GP / social prescriber', ['Mental health', 'Confidence'], ['Wellbeing'], 'WEMWBS up from 41 to 52. Now goes to the Saturday parkrun too.', '55–64']
  ];
  const noteBank = {
    'demo-c-3': ['Welcome call; explained the walk and the café afterwards.', 'First walk done. Quiet but stayed for tea.', 'Week 6 WEMWBS completed.', 'Missed two weeks (unwell). Called to check in.', 'Paired with a walk buddy.'],
    'demo-c-1': ['Garden induction and tour.', 'Planted out the leeks with the Wednesday group.', 'Took home a bag of veg and a recipe card.', 'Signed up for the food hygiene course.', 'Helped at the harvest day stall.']
  };
  people.forEach((p, i) => {
    const [fn, ln, cid, st, src, bar, outs, keyNote, age] = p;
    const done = st === 'Outcome Achieved' || st === 'Sustained';
    const started = st !== 'Referred';
    const base = int(3, 5);
    const lead = cid === 'demo-c-3' ? (chance(0.7) ? staff[0] : staff[2]) : (chance(0.7) ? staff[1] : staff[2]);
    const notes = [];
    if (started) notes.push({ t: noteBank[cid][0], d: _dIso(int(90, 170)), s: lead });
    if (started && st !== 'Engaged') notes.push({ t: pick(noteBank[cid].slice(1)), d: _dIso(int(30, 89)), s: lead });
    notes.push({ t: keyNote, d: _dIso(int(2, 28)), s: lead });
    D.participants.push({
      id: 'demo-p-' + (i + 1), _demo: true, _ref: (0x3a7c1e20 + i * 0x9e3779b).toString(16).slice(-8), first_name: fn, last_name: ln, ref_source: src, stage: st, advisor: lead,
      barriers: bar, outcomes: outs, risk: bar.includes('Mental health') && !done ? pick(['Medium', 'Medium', 'High']) : pick(['Low', 'Low', 'Medium']),
      last_contact: _dIso(st === 'Closed' ? int(40, 70) : int(1, 24)), notes,
      scores: { confidence: Math.min(10, base + (done ? int(3, 5) : started ? int(0, 2) : 0)), work_readiness: null, wellbeing: Math.min(10, base + (done ? int(3, 4) : started ? int(0, 2) : 0)), skills: Math.min(10, base + (done ? int(2, 4) : int(0, 1))) },
      safeguarding: (fn === 'Stephen') ? 'Substance misuse — link worker aware' : (fn === 'Derek' ? 'Bereavement — low mood, check in weekly' : null),
      contract_ids: [cid], phone: '07700 9' + String(10000 + i * 37).slice(1), email: chance(0.7) ? (fn + '.' + ln).toLowerCase() + '@example.com' : '',
      equality_data: chance(0.85) ? eq({ age }) : {}
    });
  });

  D.referrals = [
    { id: 'demo-r-1', _demo: true, first_name: 'Chloe', last_name: 'Bennett', source: 'GP / social prescriber', status: 'Contacted', advisor: staff[2], referred_date: _dIso(4) },
    { id: 'demo-r-2', _demo: true, first_name: 'Liam', last_name: 'Carter', source: 'Youth service', status: 'Booked', advisor: staff[1], referred_date: _dIso(9) },
    { id: 'demo-r-3', _demo: true, first_name: 'Hazel', last_name: 'Dunn', source: 'GP / social prescriber', status: 'Referred', advisor: staff[0], referred_date: _dIso(1) }
  ];
  D.partner_referrals = [
    { id: 'demo-pr-1', _demo: true, partner_name: 'Riverside Social Prescribing Service', first_name: 'Hazel', last_name: 'Dunn', primary_need: 'Loneliness and low mood', urgency: 'Standard', notes: 'Widowed last year, lives alone. Would like a gentle walking group.', barriers: ['Mental health'], safeguarding: '', consent: true, status: 'Referred', created_at: _dIso(1) },
    { id: 'demo-pr-2', _demo: true, partner_name: 'Eastfield Housing Association', first_name: 'Kevin', last_name: 'Burrows', primary_need: 'Wellbeing and something to do', urgency: 'Standard', notes: 'Tenant support worker says he enjoys being outdoors.', barriers: ['Mental health', 'Financial'], safeguarding: '', consent: true, status: 'Accepted', created_at: _dIso(52) },
    { id: 'demo-pr-3', _demo: true, partner_name: 'Northfield Family Hub', first_name: 'Fatima', last_name: 'Ali', primary_need: 'Social contact for parent and toddler', urgency: 'Standard', notes: 'New to the area, limited English, very keen on growing food.', barriers: ['Language', 'Childcare'], safeguarding: '', consent: true, status: 'Accepted', created_at: _dIso(98) }
  ];

  // ── Volunteers ─────────────────────────────────────────────
  // [name, skills, programme they mostly help with, status, since (days)]
  const vols = [
    ['Hannah Green', ['Gardening', 'Teaching/Facilitation'], 'garden', 'Active'],
    ['Graham Pike', ['Electrical', 'Other'], 'repair', 'Active'],
    ['Margaret Hollis', ['Event Setup'], 'walk', 'Active'],
    ['Dev Mistry', ['Electrical', 'Bike repair'], 'repair', 'Active'],
    ['Joanna Kowalska', ['Gardening', 'Cooking'], 'garden', 'Active'],
    ['Pete Morris', ['Driving', 'Event Setup'], 'any', 'Active'],
    ['Lucy Brennan', ['Sewing/Textiles'], 'repair', 'Active'],
    ['Olena Shevchenko', ['Gardening', 'Cooking'], 'garden', 'Active'],
    ['Ruth Ellison', ['Cooking', 'Teaching/Facilitation'], 'cook', 'Active'],
    ['Kofi Boateng', ['Photography', 'Social Media'], 'any', 'Active'],
    ['Carol Dixon', ['Admin/Office', 'Fundraising'], 'warm', 'Active'],
    ['Arjun Nair', ['Electrical'], 'repair', 'Active'],
    ['Sophie Turner', ['Gardening'], 'garden', 'Inactive'],
    ['Bill Hayes', ['Event Setup', 'Driving'], 'warm', 'Active']
  ];
  vols.forEach((v, i) => D.volunteers.push({ id: 'demo-v-' + (i + 1), _demo: true, name: v[0], email: v[0].toLowerCase().replace(' ', '.') + '@example.com', phone: '07700 8' + String(10000 + i * 53).slice(1), role: 'Volunteer', skills: v[1], hours: 0, status: v[3], _prog: v[2], equality_data: chance(0.75) ? eq() : {} }));
  const volsFor = prog => D.volunteers.filter(v => v.status === 'Active' && v._prog === prog)
    .concat(R() < 0.3 ? [pick(D.volunteers.filter(v => v._prog === 'any'))] : []);   // a driver or photographer now and then

  // ── Sessions over the last six months, plus what's coming up ──
  const P = {
    garden: { name: 'Grow Together garden session', type: 'Growing', dow: 3, time: '10:00', loc: 'Hub community garden', cap: 20, base: 15, c: ['demo-c-1'] },
    repair: { name: 'Repair Café', type: 'Repair', dow: 6, time: '10:00', loc: 'St Mark\'s church hall', cap: 40, base: 26, c: ['demo-c-2'] },
    walk:   { name: 'Walk and Talk', type: 'Wellbeing', dow: 4, time: '11:00', loc: 'Meet at the hub, Ferry Meadows loop', cap: 15, base: 10, c: ['demo-c-3'] },
    cook:   { name: 'Cook and Eat Together (families)', type: 'Food', dow: 2, time: '16:00', loc: 'Hub kitchen', cap: 16, base: 13, c: ['demo-c-1'] },
    warm:   { name: 'Warm Space and Soup', type: 'Community', dow: 2, time: '12:00', loc: 'Hub main room', cap: 35, base: 22, c: [] },
    harvest:{ name: 'Harvest Day and Seed Swap', type: 'Growing', dow: 6, time: '11:00', loc: 'Hub community garden', cap: 80, base: 64, c: ['demo-c-1'] }
  };
  let eid = 0;
  const addEvent = (k, date, upcoming) => {
    const p = P[k];
    const n = upcoming ? 0 : Math.min(p.cap, Math.max(3, Math.round(p.base * (k === 'garden' || k === 'harvest' ? season(date) : 1) * (0.8 + R() * 0.4))));
    const ev = { id: 'demo-e-' + (++eid), _demo: true, name: p.name, type: p.type, date, start_time: p.time, attendees: n, capacity: p.cap, location: p.loc, contract_ids: p.c.slice(), import_batch: null, question_ids: null, _k: k };
    D.events.push(ev);
    return ev;
  };
  for (let w = 0; w < 26; w++) {
    if (w % 2 === 0) addEvent('garden', onDay(3, w));                       // fortnightly Wednesdays
    addEvent('walk', onDay(4, w));                                           // every Thursday
    const sat = onDay(6, w);
    if (+sat.slice(8, 10) <= 7) addEvent('repair', sat);                     // first Saturday of the month
    const tue = onDay(2, w);
    if (isWinter(tue)) addEvent('warm', tue);                                // Tuesdays, October to March
  }
  [4, 5, 17, 18, 19].forEach(w => addEvent('cook', onDay(2, w)));          // October half-term and the summer holidays
  addEvent('harvest', [9, 10, 11].map(w => onDay(6, w)).find(d => !D.events.some(e => e.date === d)) || onDay(6, 10));
  addEvent('walk', onDay(4, -1), true); addEvent('garden', onDay(3, -1), true);
  addEvent('repair', (() => { for (let w = -1; w > -6; w--) { const d = onDay(6, w); if (+d.slice(8, 10) <= 7) return d; } return onDay(6, -2); })(), true);
  addEvent('warm', onDay(2, -1), true);
  D.events.sort((a, b) => b.date.localeCompare(a.date));
  const today = _dIso(0);

  // ── Volunteer hours ────────────────────────────────────────
  let hid = 0;
  const logHours = (v, date, h, activity, evId) => {
    D.volunteer_hours.push({ id: 'demo-h-' + (++hid), _demo: true, volunteer_id: v.id, event_id: evId || null, date, hours: h, activity, source: pick(['qr', 'qr', 'staff']) });
  };
  D.events.filter(e => e.date <= today).forEach(ev => {
    const pool = volsFor(ev._k === 'harvest' ? 'garden' : ev._k);
    const need = { garden: 3, repair: 5, walk: 2, cook: 2, warm: 3, harvest: 6 }[ev._k] || 2;
    pool.slice().sort(() => R() - 0.5).slice(0, Math.min(pool.length, int(need - 1, need))).forEach(v => {
      logHours(v, ev.date, { garden: 3, repair: 4, walk: 2, cook: 2.5, warm: 3, harvest: 5 }[ev._k] || 2, ev.type, ev.id);
    });
  });
  for (let k = 0; k < 14; k++) {   // time that isn't a session: watering rota, collections, social media
    const v = pick(D.volunteers.filter(x => x.status === 'Active'));
    const act = v._prog === 'garden' ? 'Watering rota' : v._prog === 'any' ? pick(['Collecting donated tools', 'Photos and social media']) : 'Admin and sorting donations';
    logHours(v, _dIso(int(3, 170)), pick([1, 1.5, 2]), act, null);
  }
  const left = D.volunteers.find(v => v.status === 'Inactive');           // stopped coming in the summer
  if (left) D.events.filter(e => e._k === 'garden' && e.date < _dIso(110)).slice(0, 6).forEach(e => logHours(left, e.date, 3, e.type, e.id));
  const opening = { 'Hannah Green': 140, 'Graham Pike': 64, 'Pete Morris': 85, 'Sophie Turner': 48 };   // hours from their old spreadsheet
  D.volunteers.forEach(v => { v.hours = opening[v.name] || 0; delete v._prog; });

  // ── Feedback ───────────────────────────────────────────────
  const Q = DEFAULT_MEASURES;
  D.survey_measures = Q.map((m, i) => Object.assign({ id: 'demo-m-' + (i + 1), _demo: true, active: true, sort: i }, m));
  const quotes = {
    garden: ['I hadn\'t been outside properly for weeks before I started coming.', 'Took home courgettes, beans and a recipe. The kids actually ate them.', 'Hannah showed me how to take cuttings. I\'ve got six on my windowsill now.', 'It\'s the one morning a week I look forward to.', 'Nobody minds if you just sit and have a cuppa.'],
    repair: ['My lamp was going to the tip. Now it works and I know how to rewire a plug.', 'Brilliant. Saved me £60 on a new toaster.', 'They fixed my granddaughter\'s jacket zip while I waited.', 'Graham explained everything he was doing. Fascinating.', 'Lovely atmosphere and the cake was great.'],
    walk: ['My GP said get out more. This is the first thing that\'s actually worked.', 'I came for the walk but stay for the chat.', 'Since my husband died I don\'t see many people. Thursdays are different.', 'Margaret made me feel so welcome on my first day.', 'I can do the full loop now. In September I couldn\'t.'],
    cook: ['My son chopped an onion for the first time!', 'We made the curry again at home on Sunday.', 'Cheap, healthy and the kids loved it.', 'I didn\'t know you could freeze leftover rice safely. Really useful.'],
    warm: ['Warm, a hot meal and a friendly face. That\'s everything right now.', 'I come for the soup and the crossword.', 'Rachel helped me sort out my energy bill.', 'It\'s good to be somewhere that isn\'t my flat.'],
    harvest: ['What a day! Swapped my tomato seeds for squash.', 'Lovely to see so many neighbours together.', 'The kids loved the pumpkin weigh-in.']
  };
  const yes = { garden: [0.78, 0.82, 0.5], repair: [0.72, 0.6, 0.35], walk: [0.45, 0.88, 0.6], cook: [0.9, 0.65, 0.45], warm: [0.3, 0.8, 0.55], harvest: [0.6, 0.9, 0.5] };
  const respondents = D.participants.map(p => p.first_name + ' ' + p.last_name.charAt(0) + '.');
  let fid = 0;
  D.events.filter(e => e.date <= today && e.attendees > 0).forEach(ev => {
    if (ev._k === 'warm' && chance(0.4)) return;                              // not every session collects feedback
    const n = Math.max(2, Math.round(ev.attendees * (0.35 + R() * 0.3)));
    const y = yes[ev._k];
    for (let k = 0; k < n; k++) {
      const cb = pick([2, 2, 3, 3, 3, 4]), ca = Math.min(5, cb + pick([0, 1, 1, 1, 2])), en = pick([4, 4, 5, 5, 5, 3]);
      const learned = chance(y[0]), connected = chance(y[1]), friend = chance(y[2]);
      const quote = chance(0.3) ? pick(quotes[ev._k]) : '';
      const answers = {};
      answers[Q[0].question] = en; answers[Q[1].question] = cb; answers[Q[2].question] = ca;
      answers[Q[3].question] = learned ? 'Yes' : 'No'; answers[Q[4].question] = connected ? 'Yes' : 'No'; answers[Q[5].question] = friend ? 'Yes' : 'No';
      if (quote) answers[Q[6].question] = quote;
      D.feedback.push({ id: 'demo-fb-' + (++fid), _demo: true, eventId: ev.id, name: chance(0.65) ? 'Anonymous' : pick(respondents),
        enjoyed: en, cb, ca, learned, connected, friend, quote, answers,
        demographics: chance(0.5) ? { age: pick(ages), ethnicity: pick(eths), gender: pick(gens) } : {}, import_batch: null,
        created_at: ev.date + 'T' + String(+ev.start_time.slice(0, 2) + 2).padStart(2, '0') + ':' + String(int(0, 59)).padStart(2, '0') + ':00Z' });
    }
  });
  D.events.forEach(e => { delete e._k; });

  // ── Contacts and evidence (no employer work in this charity) ──
  D.employers = [];
  D.contacts = [
    { id: 'demo-ct-1', _demo: true, first_name: 'Helen', last_name: 'Price', email: 'grants@fenmoorcf.example.org', role: 'Grants officer, Fenmoor Community Foundation', status: 'Active' },
    { id: 'demo-ct-2', _demo: true, first_name: 'Tom', last_name: 'Ellis', email: 't.ellis@riverside.example.gov.uk', role: 'UKSPF officer, Riverside City Council', status: 'Active' },
    { id: 'demo-ct-3', _demo: true, first_name: 'Priya', last_name: 'Desai', email: 'priya@example.com', role: 'Social prescribing link worker', status: 'Active' },
    { id: 'demo-ct-4', _demo: true, first_name: 'Maya', last_name: 'Green', email: 'maya.green@example.com', role: 'Chair of trustees', status: 'Active' },
    { id: 'demo-ct-5', _demo: true, first_name: 'Robert', last_name: 'Lane', email: 'robert@lanehardware.example.co.uk', role: 'Local business — donates tools and parts', status: 'Active' },
    { id: 'demo-ct-6', _demo: true, first_name: 'Owen', last_name: 'Day', email: 'owen.day@example.com', role: 'Supermarket community champion (surplus food)', status: 'Active' },
    { id: 'demo-ct-7', _demo: true, first_name: 'Grace', last_name: 'Mensah', email: 'grace@example.com', role: 'Regular donor', status: 'Active' },
    { id: 'demo-ct-8', _demo: true, first_name: 'Neil', last_name: 'Barker', email: 'neil.barker@example.com', role: 'Possible corporate volunteering day', status: 'Prospect' }
  ];
  D.evidence = [
    { id: 'demo-ev-1', _demo: true, participant_name: 'Tomasz Nowak', type: 'Certificate', linked_outcome: 'Qualification', staff: staff[1], evidence_date: _dIso(41), status: 'Verified' },
    { id: 'demo-ev-2', _demo: true, participant_name: 'Imran Shah', type: 'Certificate', linked_outcome: 'Training', staff: staff[1], evidence_date: _dIso(63), status: 'Verified' },
    { id: 'demo-ev-3', _demo: true, participant_name: 'Aisha Rahman', type: 'WEMWBS form', linked_outcome: 'Wellbeing', staff: staff[0], evidence_date: _dIso(19), status: 'Verified' },
    { id: 'demo-ev-4', _demo: true, participant_name: 'Susan Clarke', type: 'WEMWBS form', linked_outcome: 'Wellbeing', staff: staff[0], evidence_date: _dIso(12), status: 'Verified' },
    { id: 'demo-ev-5', _demo: true, participant_name: 'Ewa Zielinska', type: 'Case study and photo consent', linked_outcome: 'Wellbeing', staff: staff[2], evidence_date: _dIso(27), status: 'Verified' },
    { id: 'demo-ev-6', _demo: true, participant_name: 'Patricia Owusu', type: 'WEMWBS form', linked_outcome: 'Wellbeing', staff: staff[0], evidence_date: _dIso(5), status: 'Pending' }
  ];

  // Contract progress from the people above
  D.contracts.forEach(c => {
    const mine = D.participants.filter(p => p.contract_ids.includes(c.id));
    if (!c.target_starts) return;
    c.actual_starts = mine.filter(p => p.stage !== 'Referred').length;
    c.actual_outcomes = mine.filter(p => p.stage === 'Outcome Achieved' || p.stage === 'Sustained').length;
  });
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

// remember = false for a demo account, so the sample data doesn't follow
// you into your other organisations on this browser
function loadDemoData(remember) {
  DEMO_DATA = buildDemoData();
  DEMO_KEYS.forEach(_demoAdd);
  _demoMode = true;
  if (remember !== false) safeStorage.set('demo_mode', 'on');
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
