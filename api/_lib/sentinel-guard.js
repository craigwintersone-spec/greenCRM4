// /api/_lib/sentinel-guard.js — the checks that would have caught Yaxley, and the rest of the platform's quiet failures
// Runs inside the daily Sentinel job. Writes cards to sentinel_decisions (your Sentinel page), one per issue, never twice:
// an issue already on the page is left alone, and a card whose issue has gone away is closed automatically.
// Uses your existing agents only, with their roles as you defined them:
//   Customer Success (the health of each customer's data)   Legal & GDPR (privacy, consent, who can read what)
//   Dev (errors: the site, its services, missing files)     Finance (plans: trials, staff limits, AI allowance)   Product (what shipped)
// Reads only. The one write besides the cards is the changelog line in sentinel_actions.

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');
const PLAN_STAFF = { free: 3, starter: 3, pro: 10 };   // network: unlimited
const PLAN_AI = { free: 30, starter: 60, pro: 300, network: 600 };
const DAY = 864e5;

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && b.message) || ''}`);
  return b;
}
async function read(path) { try { return { rows: await sb(path) }; } catch (e) { return { rows: [], error: e.message }; } }
async function fetchWithin(url, ms, method) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { method: method || 'GET', signal: c.signal }); } finally { clearTimeout(t); }
}
const iso = d => new Date(d).toISOString();
const londonDay = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const PII = /\b(name|e-?mail|phone|mobile|address|contact details?)\b/i;
const STANDARD = ['cb', 'ca', 'enjoyed', 'connected', 'learned', 'friend'];

async function runGuard(now) {
  const t0 = now ? new Date(now) : new Date();
  const since14 = iso(t0.getTime() - 14 * DAY), since30 = londonDay(t0.getTime() - 30 * DAY), today = londonDay(t0), dayStart = new Date(Date.UTC(t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate())).toISOString();
  // everything in parallel: one pass over the database, then the checks run in memory
  const since7 = londonDay(t0.getTime() - 7 * DAY), since60 = iso(t0.getTime() - 60 * DAY), since30iso = iso(t0.getTime() - 30 * DAY);
  const readAny = async (...paths) => { let last; for (const p of paths) { const r = await read(p); if (!r.error) return r; last = r; } return last; };   // try a fuller column list first, then a smaller one
  const [orgs, measures, feedback, checkins, events, openVols, bigItems, contracts, members, ai,
         people, evidence, pReferrals, referrals, intake, volHours, stuck, activities, prospects, formMaps] = await Promise.all([
    read('organisations?select=id,name,plan,status,created_at'),
    read('survey_measures?active=eq.true&select=id,org_id,question,kind,maps_to'),
    read(`feedback?created_at=gte.${since14}&select=org_id,event_id,answers,created_at&limit=20000`),
    read(`checkins?created_at=gte.${since14}&select=org_id,event_id,people,day,created_at&limit=20000`),
    read(`events?event_date=gte.${since30}&select=id,org_id,name,event_date,capacity,attendees&limit=5000`),
    read(`volunteer_checkins?checked_out_at=is.null&checked_in_at=lt.${iso(t0.getTime() - DAY)}&select=org_id,checked_in_at&limit=2000`),
    read(`circular_items?created_at=gte.${since14}&weight_kg=gte.250&select=org_id,name,weight_kg&limit=500`),
    readAny('contracts?select=id,org_id,name,funder,end_date,start_date,status,target_starts,actual_starts,target_outcomes,actual_outcomes,template_name&limit=5000', 'contracts?select=id,org_id,name,funder,end_date,start_date,status,target_starts,actual_starts&limit=5000'),
    read('memberships?select=org_id,role,status&limit=50000'),
    read(`ai_usage?called_at=gte.${dayStart}&select=org_id&limit=50000`),
    readAny('participants?select=id,org_id,first_name,last_name,stage,risk,safeguarding,last_contact,outcomes,equality_data,contract_ids,email,phone&limit=50000', 'participants?select=id,org_id,first_name,last_name,stage,risk,last_contact&limit=50000'),
    read('evidence?select=id,org_id,participant_id,status,evidence_date&limit=50000'),
    read('partner_referrals?select=id,org_id,partner_name,status,consent,created_at&limit=20000'),
    read('referrals?select=id,org_id,status,referred_date&limit=20000'),
    read('intake_requests?select=id,org_id,status,expires_at&limit=20000'),
    read(`volunteer_hours?hours=gt.12&session_date=gte.${since30}&select=org_id,hours,session_date&limit=2000`),
    read(`circular_items?outcome_type=is.null&updated_at=lt.${since60}&select=org_id,activity_id&limit=20000`),
    read('circular_activities?select=id,org_id,name,template,mode&limit=2000'),
    read(`contacts?role=eq.Volunteer%20interest&status=eq.Prospect&created_at=lt.${iso(t0.getTime() - 7 * DAY)}&select=org_id,first_name&limit=2000`),
    read('form_maps?select=org_id,form_key&limit=20000')
  ]);
  const orgName = {}; orgs.rows.forEach(o => { orgName[String(o.id)] = o.name || 'An organisation'; });
  const evById = {}; events.rows.forEach(e => { evById[String(e.id)] = e; });
  const found = [];
  const add = (agent, tier, key, org, title, description, extra) => found.push({ agent, tier, title, description, primary_action: 'Mark as fixed', secondary_action: 'Dismiss', org_id: org || null, status: 'pending', metadata: Object.assign({ guard: true, key, signal: key.split(':')[0] }, extra || {}) });
  const byOrg = (rows) => { const m = {}; rows.forEach(r => { const k = String(r.org_id); (m[k] = m[k] || []).push(r); }); return m; };

  // ── Customer Success: forms ──
  const mByOrg = byOrg(measures.rows), fbByOrg = byOrg(feedback.rows);
  Object.keys(mByOrg).forEach(oid => {
    const ms = mByOrg[oid], nm = orgName[oid] || 'An organisation';
    ms.filter(m => m.maps_to && PII.test(m.question || '')).forEach(m => add('Customer Success', 'urgent', `unsafe_mapping:${oid}:${m.id}`, oid,
      `${nm}: a name or email question is counted as a score`,
      `"${String(m.question).slice(0, 90)}" is set to count as ${m.maps_to}. Anything typed there would be read as a figure. Set it to "own measure" in their Settings, Events, or run: update survey_measures set maps_to = null where id = ${m.id};`));
    ms.filter(m => !m.maps_to && PII.test(m.question || '') && m.kind === 'text').forEach(m => add('Legal & GDPR', 'medium', `pii_on_form:${oid}:${m.id}`, oid,
      `${nm}: their anonymous feedback form asks for personal details`,
      `"${String(m.question).slice(0, 90)}" collects names or contact details inside anonymous answers. Suggest they switch it off and use the Volunteer tab's "leave your details" box.`));
    const scored = ms.filter(m => m.kind === 'score' || m.kind === 'yesno');
    const mapped = ms.filter(m => STANDARD.includes(m.maps_to));
    if ((fbByOrg[oid] || []).length && scored.length && !mapped.length) add('Customer Success', 'high', `unmapped_feedback:${oid}`, oid,
      `${nm}: feedback is coming in but counts in no standard figure`,
      `${(fbByOrg[oid] || []).length} responses in 14 days. None of their ${scored.length} rating questions counts as confidence, enjoyment, connection or learning, so headline report figures will be missing. Examples: ${scored.slice(0, 3).map(m => '"' + String(m.question).slice(0, 60) + '"').join(', ')}. Set what each counts as in their Settings, Events.`);
  });
  // ── Customer Success: check-ins ──
  const ciByEvent = {}; checkins.rows.forEach(c => { const k = String(c.event_id); (ciByEvent[k] = ciByEvent[k] || []).push(c); });
  const fbByEvent = {}; feedback.rows.forEach(f => { const k = String(f.event_id); fbByEvent[k] = (fbByEvent[k] || 0) + 1; });
  Object.keys(ciByEvent).forEach(eid => {
    const rows = ciByEvent[eid], ev = evById[eid]; if (!ev) return;
    const oid = String(ev.org_id), nm = orgName[oid] || 'An organisation', people = rows.reduce((a, r) => a + (+r.people || 1), 0);
    const off = rows.filter(r => r.day && ev.event_date && r.day !== ev.event_date);
    if (off.length) add('Customer Success', 'high', `checkins_off_day:${eid}`, oid,
      `${nm}: ${off.length} check-in${off.length === 1 ? '' : 's'} on "${ev.name}" made on a different day`,
      `The event is on ${ev.event_date}; ${off.length} check-in${off.length === 1 ? ' was' : 's were'} made on ${[...new Set(off.map(r => r.day))].join(', ')}, adding ${off.reduce((a, r) => a + (+r.people || 1), 0)} people. Usually test entries. To remove: delete from checkins where event_id::text = '${eid}' and day <> '${ev.event_date}';`);
    if (+ev.capacity > 0 && people > ev.capacity * 1.25) add('Customer Success', 'medium', `over_capacity:${eid}`, oid,
      `${nm}: "${ev.name}" has more people checked in than its capacity`,
      `${people} people checked in against a capacity of ${ev.capacity}. Check for repeats or children counted twice.`);
    if (rows.length >= 5 && !fbByEvent[eid] && ev.event_date < today) add('Customer Success', 'low', `no_feedback:${eid}`, oid,
      `${nm}: ${rows.length} check-ins on "${ev.name}" but no feedback`,
      `People checked in but nobody gave feedback. Possibly they checked in again instead, or the end-of-session prompt was missed.`);
  });
  // ── Customer Success: odd feedback, open volunteers, heavy items, contracts ──
  feedback.rows.forEach(f => {
    const sc = Object.values(f.answers || {}).filter(v => typeof v === 'number');
    if (sc.length >= 3 && sc.every(v => v === 1)) {
      const ev = evById[String(f.event_id)];
      add('Customer Success', 'low', `all_ones:${f.org_id}:${f.created_at}`, String(f.org_id),
        `${orgName[String(f.org_id)] || 'An organisation'}: one feedback response scored everything 1`,
        `On ${ev ? '"' + ev.name + '"' : 'an event'} at ${String(f.created_at).slice(0, 16).replace('T', ' ')}. Either a genuinely bad experience or a mis-tap. It pulls every average down; it stays in unless they know otherwise.`);
    }
  });
  Object.entries(byOrg(openVols.rows)).forEach(([oid, rows]) => add('Customer Success', 'medium', `open_volunteers:${oid}`, oid,
    `${orgName[oid] || 'An organisation'}: ${rows.length} volunteer${rows.length === 1 ? '' : 's'} still checked in from a previous day`,
    `Oldest since ${String(rows.map(r => r.checked_in_at).sort()[0]).slice(0, 10)}. Their hours aren't counted until someone checks them out.`));
  bigItems.rows.forEach(i => add('Customer Success', 'high', `heavy_item:${i.org_id}:${i.name}:${i.weight_kg}`, String(i.org_id),
    `${orgName[String(i.org_id)] || 'An organisation'}: an item logged at ${i.weight_kg} kg`,
    `"${i.name || 'Item'}" weighs ${i.weight_kg} kg. Often grams typed as kilograms (840 g becomes 840 kg). Check it before a report uses it.`));
  contracts.rows.forEach(c => {
    if (!c.end_date || (c.status && c.status !== 'live')) return;
    const days = Math.round((new Date(c.end_date + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / DAY), nm = orgName[String(c.org_id)] || 'An organisation';
    if (days >= 0 && days <= 30) add('Customer Success', 'medium', `contract_ending:${c.id}`, String(c.org_id), `${nm}: "${c.name}" ends in ${days} day${days === 1 ? '' : 's'}`, `Funder: ${c.funder || 'not set'}. The final report and any renewal are due soon.`);
    if (days < -7) add('Customer Success', 'low', `contract_ended:${c.id}`, String(c.org_id), `${nm}: "${c.name}" ended ${-days} days ago but is still live`, `Mark it closed so it stops appearing in reports and reminders.`);
  });

  // ── Finance: trials, staff limits, AI allowance ──
  const staff = {}; members.rows.forEach(m => { const k = String(m.org_id); staff[k] = (staff[k] || 0) + 1; });
  const aiCount = {}; ai.rows.forEach(a => { const k = String(a.org_id); aiCount[k] = (aiCount[k] || 0) + 1; });
  orgs.rows.forEach(o => {
    const oid = String(o.id), plan = String(o.plan || '').toLowerCase(), status = String(o.status || '').toLowerCase();
    const age = Math.floor((t0 - new Date(o.created_at)) / DAY);
    if (status === 'trial' && age > 14) add('Finance', 'high', `trial_overdue:${oid}`, oid, `${o.name}: trial is ${age - 14} days past its 14 days`, `Still on Trial after ${age} days. Move them to a paid plan or suspend.`);
    if (PLAN_STAFF[plan] && staff[oid] > PLAN_STAFF[plan]) add('Finance', 'medium', `staff_over:${oid}`, oid, `${o.name}: ${staff[oid]} staff on a plan for ${PLAN_STAFF[plan]}`, `Their ${plan === 'starter' ? 'Community' : plan === 'free' ? 'trial' : 'Standard'} plan includes ${PLAN_STAFF[plan]} staff. Upgrade conversation, or tidy the Team page.`);
    if (PLAN_AI[plan] && aiCount[oid] >= PLAN_AI[plan] * 0.8) add('Finance', aiCount[oid] >= PLAN_AI[plan] ? 'high' : 'medium', `ai_allowance:${oid}:${today}`, oid,
      `${o.name}: ${aiCount[oid]} of ${PLAN_AI[plan]} AI calls used today`, aiCount[oid] >= PLAN_AI[plan] ? 'They have hit the limit: reports, bids and searches fail until midnight UTC.' : 'Close to the limit. Reports, bids and searches will stop if they reach it.');
  });

  // ── Customer Success: people, referrals, evidence (employment programmes) ──
  const ago = d => d ? Math.floor((t0 - new Date(d)) / DAY) : Infinity;
  const live = p => !/^(closed|sustained|exited|completed|withdrawn)$/i.test(String(p.stage || ''));
  const sgFlag = v => v && !/^(none|no|n\/a|false|-|—)$/i.test(String(v).trim());
  const hasOutcome = v => Array.isArray(v) ? v.length > 0 : (v && typeof v === 'object' ? Object.keys(v).length > 0 : !!(v && String(v).trim() && !/^(none|\[\]|\{\})$/i.test(String(v))));
  const evByP = {}; evidence.rows.forEach(e => { if (e.participant_id) evByP[String(e.participant_id)] = 1; });
  Object.entries(byOrg(people.rows)).forEach(([oid, P]) => {
    const nm = orgName[oid] || 'An organisation';
    const sg = P.filter(p => live(p) && sgFlag(p.safeguarding) && ago(p.last_contact) > 14);
    if (sg.length) add('Customer Success', 'urgent', `safeguarding_quiet:${oid}`, oid, `${nm}: ${sg.length} participant${sg.length === 1 ? '' : 's'} with a safeguarding flag and no contact for 14+ days`,
      `${sg.slice(0, 5).map(p => p.first_name + ' ' + String(p.last_name || '').slice(0, 1) + '.').join(', ')}${sg.length > 5 ? ' and more' : ''}. Someone should make contact and log it.`);
    const hr = P.filter(p => live(p) && /high/i.test(String(p.risk || '')) && ago(p.last_contact) > 30);
    if (hr.length) add('Customer Success', 'high', `high_risk_quiet:${oid}`, oid, `${nm}: ${hr.length} high-risk participant${hr.length === 1 ? '' : 's'} not contacted for 30+ days`, `Oldest last contact: ${hr.map(p => p.last_contact || 'never').sort()[0]}.`);
    const quiet = P.filter(p => live(p) && ago(p.last_contact) > 60);
    if (quiet.length >= 3) add('Customer Success', 'medium', `quiet_caseload:${oid}`, oid, `${nm}: ${quiet.length} open participants with no contact for 60+ days`, `Either they have left and should be closed, or they need a call. Open caseloads inflate figures in reports.`);
    if (people.rows.length && 'equality_data' in (people.rows[0] || {})) {
      const onContract = P.filter(p => { const c = p.contract_ids; return Array.isArray(c) ? c.length : (typeof c === 'string' && c.length > 2); });
      const noEq = onContract.filter(p => !p.equality_data || !Object.keys(p.equality_data || {}).length);
      if (onContract.length >= 5 && noEq.length / onContract.length > 0.2) add('Customer Success', 'medium', `equality_gap:${oid}`, oid, `${nm}: ${Math.round(noEq.length / onContract.length * 100)}% of contract participants have no equality data`, `${noEq.length} of ${onContract.length}. Funders ask for this; the start form or intake link collects it.`);
      const noEv = P.filter(p => hasOutcome(p.outcomes) && !evByP[String(p.id)]);
      if (noEv.length) add('Customer Success', 'high', `outcome_no_evidence:${oid}`, oid, `${nm}: ${noEv.length} participant${noEv.length === 1 ? ' has' : 's have'} an outcome with no evidence`, `An outcome without evidence won't survive a funder audit. Add the payslip, letter or certificate on each record.`);
      const keyOf = p => (String(p.first_name || '') + ' ' + String(p.last_name || '')).toLowerCase().replace(/\s+/g, ' ').trim() + '|' + (String(p.email || '').toLowerCase() || String(p.phone || '').replace(/\D/g, ''));
      const seenP = {}, dups = []; P.forEach(p => { const k = keyOf(p); if (!/\|$/.test(k)) { if (seenP[k]) dups.push(p); else seenP[k] = 1; } });
      if (dups.length) add('Customer Success', 'medium', `duplicate_people:${oid}`, oid, `${nm}: ${dups.length} participant${dups.length === 1 ? ' looks' : 's look'} like a duplicate`, `Same name and same email or phone as another record: ${dups.slice(0, 4).map(p => p.first_name + ' ' + p.last_name).join(', ')}. Duplicates double-count starts.`);
    }
  });
  Object.entries(byOrg(evidence.rows.filter(e => /pending/i.test(String(e.status || '')) && ago(e.evidence_date) > 14))).forEach(([oid, E]) =>
    add('Customer Success', 'medium', `evidence_pending:${oid}`, oid, `${orgName[oid] || 'An organisation'}: ${E.length} piece${E.length === 1 ? '' : 's'} of evidence pending for 14+ days`, `Pending evidence doesn't count for the funder until it's checked.`));
  Object.entries(byOrg(pReferrals.rows)).forEach(([oid, R]) => {
    const nm = orgName[oid] || 'An organisation';
    const waiting = R.filter(r => /^(new|referred|pending)$/i.test(String(r.status || 'new')) && ago(r.created_at) > 5);
    if (waiting.length) add('Customer Success', 'high', `referrals_waiting:${oid}`, oid, `${nm}: ${waiting.length} partner referral${waiting.length === 1 ? '' : 's'} waiting 5+ days`, `People referred by ${[...new Set(waiting.map(r => r.partner_name).filter(Boolean))].slice(0, 3).join(', ') || 'partners'} haven't been picked up.`);
    const noConsent = R.filter(r => r.consent === false && /^(accepted|converted)$/i.test(String(r.status || '')));
    if (noConsent.length) add('Legal & GDPR', 'urgent', `referral_no_consent:${oid}`, oid, `${nm}: ${noConsent.length} referral${noConsent.length === 1 ? '' : 's'} accepted without recorded consent`, `Personal data is being held without consent on record. Get consent or remove the data.`);
  });
  Object.entries(byOrg(referrals.rows.filter(r => /^new$/i.test(String(r.status || '')) && ago(r.referred_date) > 7))).forEach(([oid, R]) =>
    add('Customer Success', 'medium', `referrals_new:${oid}`, oid, `${orgName[oid] || 'An organisation'}: ${R.length} referral${R.length === 1 ? '' : 's'} still "new" after 7 days`, `Someone was referred and nobody has moved them on.`));
  Object.entries(byOrg(intake.rows.filter(r => /^(sent|opened)$/i.test(String(r.status || '')) && r.expires_at && new Date(r.expires_at) < t0 && ago(r.expires_at) <= 14))).forEach(([oid, R]) =>
    add('Customer Success', 'low', `intake_expired:${oid}`, oid, `${orgName[oid] || 'An organisation'}: ${R.length} intake link${R.length === 1 ? '' : 's'} expired without being filled in`, `The person never completed their details. Send a new link if they're still starting.`));

  // ── Customer Success: contracts and the funder's forms ──
  const mapped = {}; formMaps.rows.forEach(m => { const k = String(m.form_key || '').split(':'); if (k[0] === 'contract') mapped[k[1] + (k[2] ? ':' + k[2] : '')] = 1; });
  contracts.rows.forEach(c => {
    if (c.status && c.status !== 'live') return;
    const nm = orgName[String(c.org_id)] || 'An organisation';
    if (!c.start_date || !c.end_date) { add('Customer Success', 'low', `contract_no_dates:${c.id}`, String(c.org_id), `${nm}: "${c.name}" has no ${!c.start_date ? 'start' : 'end'} date`, `Without dates, reports can't work out progress and reminders can't be sent.`); return; }
    const s0 = new Date(c.start_date + 'T00:00:00Z'), e0 = new Date(c.end_date + 'T00:00:00Z'), f = Math.min(1, Math.max(0, (t0 - s0) / (e0 - s0)));
    if (f >= 0.25 && +c.target_starts > 0 && +(c.actual_starts || 0) < c.target_starts * f * 0.7) add('Customer Success', 'high', `behind_starts:${c.id}`, String(c.org_id),
      `${nm}: "${c.name}" is behind on starts`, `${+(c.actual_starts || 0)} of ${c.target_starts} starts with ${Math.round(f * 100)}% of the contract gone (on track would be about ${Math.round(c.target_starts * f)}).`);
    if (c.template_name && !mapped[String(c.id)]) add('Customer Success', 'medium', `start_form_not_setup:${c.id}`, String(c.org_id), `${nm}: "${c.name}" has a start form that isn't set up`, `The form is uploaded but its questions aren't matched, so it can't fill itself. One click on the contract card.`);
  });

  // ── Customer Success: events with nothing recorded, volunteer hours, stuck items, unanswered volunteer interest ──
  const ciEv = {}, fbEv = {}; checkins.rows.forEach(c => { ciEv[String(c.event_id)] = 1; }); feedback.rows.forEach(f => { fbEv[String(f.event_id)] = 1; });
  Object.entries(byOrg(events.rows.filter(e => e.event_date < since7 && !(+e.attendees > 0) && !ciEv[String(e.id)] && !fbEv[String(e.id)]))).forEach(([oid, E]) =>
    add('Customer Success', 'low', `empty_events:${oid}`, oid, `${orgName[oid] || 'An organisation'}: ${E.length} past event${E.length === 1 ? '' : 's'} with nothing recorded`, `No attendance, check-ins or feedback: ${E.slice(0, 4).map(e => '"' + e.name + '"').join(', ')}. Either add the numbers or delete events that didn't happen.`));
  Object.entries(byOrg(volHours.rows)).forEach(([oid, H]) => add('Customer Success', 'medium', `long_hours:${oid}`, oid, `${orgName[oid] || 'An organisation'}: ${H.length} volunteer shift${H.length === 1 ? '' : 's'} over 12 hours`, `Longest: ${Math.max(...H.map(h => +h.hours))} hours. Usually a forgotten check-out; it inflates the value of volunteer time.`));
  const actById = {}; activities.rows.forEach(a => { actById[String(a.id)] = a; });
  Object.entries(byOrg(stuck.rows.filter(i => { const a = actById[String(i.activity_id)]; return a && !/^(growing|compost)$/.test(a.template || '') && (a.mode || 'tracked') === 'tracked'; }))).forEach(([oid, I]) =>
    add('Customer Success', 'low', `stuck_items:${oid}`, oid, `${orgName[oid] || 'An organisation'}: ${I.length} circular item${I.length === 1 ? '' : 's'} untouched for 60+ days`, `They're still "in progress" so they count nowhere. Finish or remove them.`));
  Object.entries(byOrg(prospects.rows)).forEach(([oid, C]) => add('Customer Success', 'low', `volunteer_leads:${oid}`, oid, `${orgName[oid] || 'An organisation'}: ${C.length} volunteer lead${C.length === 1 ? '' : 's'} not followed up in 7+ days`, `People who offered to volunteer at an event are still "Prospect" on the Contacts tab.`));

  // ── Finance and access: who can get in ──
  const roles = {}; members.rows.forEach(m => { const k = String(m.org_id); (roles[k] = roles[k] || []).push(m); });
  orgs.rows.forEach(o => {
    const oid = String(o.id), M = roles[oid] || [], status = String(o.status || '').toLowerCase();
    if (status === 'suspended' && M.some(m => m.status === 'active')) add('Legal & GDPR', 'high', `suspended_with_access:${oid}`, oid, `${o.name}: suspended, but ${M.filter(m => m.status === 'active').length} people can still log in`, `Suspension stops the AI only. Suspend each person on their Team page.`);
    if (status !== 'suspended' && M.length && !M.some(m => m.status === 'active' && /^(owner|admin|manager)$/i.test(String(m.role || '')))) add('Customer Success', 'high', `no_manager:${oid}`, oid, `${o.name}: nobody active can manage this organisation`, `No active owner, admin or manager. Nobody can add staff, change settings or receive report emails.`);
  });

  // ── Legal & GDPR: can anyone read the data without logging in? ──
  try {
    const cfg = await fetchWithin(APP_URL + '/js/config.js', 4000);
    const txt = cfg.ok ? await cfg.text() : '';
    const anon = (txt.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/) || [])[0];
    if (anon) {
      const open = [];
      await Promise.all(['participants', 'feedback', 'checkins', 'checkin_emails', 'contacts', 'volunteers', 'volunteer_hours', 'evidence', 'partner_referrals', 'referrals', 'intake_requests', 'memberships', 'organisations', 'contracts', 'employers', 'events', 'survey_measures', 'circular_items', 'ai_usage', 'sentinel_decisions'].map(async t => {
        try { const r = await fetch(`${SUPABASE_URL}/rest/v1/${t}?select=*&limit=1`, { headers: { apikey: anon, Authorization: `Bearer ${anon}` } }); if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) open.push(t); } } catch (e) { /* unreachable is not open */ }
      }));
      if (open.length) add('Legal & GDPR', 'urgent', `public_tables:${open.sort().join(',')}`, null, `${open.length} table${open.length === 1 ? ' is' : 's are'} readable by anyone, without logging in`,
        `Using only the public website key, Sentinel read rows from: ${open.join(', ')}. Add row-level security policies to ${open.length === 1 ? 'it' : 'them'} today.`);
    }
  } catch (e) { /* tomorrow will tell */ }

  // ── Dev: the site and its services answer ──
  const probes = [['the home page', APP_URL + '/', 'GET', null], ['the login page', APP_URL + '/login.html', 'GET', null], ['the app', APP_URL + '/app.html', 'GET', null],
    ['the QR page service', APP_URL + '/api/event-checkin', 'POST', { action: 'info', token: 'sentinel-probe-000000000000' }], ['the AI service', APP_URL + '/api/claude', 'POST', {}]];
  const down = [];
  await Promise.all(probes.map(async ([label, url, method, body]) => {
    try { const c = new AbortController(); const tm = setTimeout(() => c.abort(), 8000); const r = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: c.signal }); clearTimeout(tm); if (r.status >= 500) down.push(label + ' (' + r.status + ')'); }
    catch (e) { down.push(label + ' (no answer)'); }
  }));
  if (down.length) add('Dev', 'urgent', `site_down:${down.map(d => d.split(' (')[0]).sort().join(',')}`, null, `${down.length === 1 ? 'Part of the site is' : down.length + ' parts of the site are'} failing`, `${down.join(', ')}. Check Vercel, then Logs.`);

  // ── Dev: files the website asks for that aren't there ──
  try {
    const page = await fetchWithin(APP_URL + '/app.html', 5000);
    if (page.ok) {
      const html = await page.text();
      const srcs = [...new Set([...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="((?:js|css)\/[^"]+)"/g)].map(m => m[1]))];
      const missing = [];
      await Promise.all(srcs.map(async s => { try { const r = await fetchWithin(APP_URL + '/' + s, 4000, 'HEAD'); if (r.status === 404) missing.push(s.split('?')[0]); } catch (e) { /* slow is not missing */ } }));
      if (missing.length) add('Dev', 'high', `missing_files:${missing.sort().join(',')}`, null, `The app asks for ${missing.length} file${missing.length === 1 ? '' : 's'} that ${missing.length === 1 ? "isn't" : "aren't"} on the site`,
        `Every page load fails to fetch: ${missing.join(', ')}. Upload ${missing.length === 1 ? 'it' : 'them'}, or remove the line from app.html.`);
    }
  } catch (e) { /* the site was unreachable for a moment: tomorrow will tell */ }

  // a check that could not run is itself worth knowing
  const skipped = [['survey_measures', measures], ['feedback', feedback], ['checkins', checkins], ['events', events], ['volunteer_checkins', openVols], ['circular_items', bigItems], ['contracts', contracts], ['memberships', members], ['ai_usage', ai],
    ['participants', people], ['evidence', evidence], ['partner_referrals', pReferrals], ['referrals', referrals], ['intake_requests', intake], ['volunteer_hours', volHours], ['circular_activities', activities], ['form_maps', formMaps]].filter(([, r]) => r.error).map(([t, r]) => t + ' (' + r.error.slice(0, 80) + ')');
  if (skipped.length) add('Dev', 'medium', `guard_skipped:${skipped.map(s => s.split(' ')[0]).sort().join(',')}`, null, `Sentinel couldn't read ${skipped.length} table${skipped.length === 1 ? '' : 's'}`, `Checks that need them were skipped: ${skipped.join('; ')}.`);

  return found;
}

// Write the cards: new issues added, existing ones left alone, fixed ones closed
async function syncDecisions(found) {
  let existing = [];
  try { existing = await sb(`sentinel_decisions?status=eq.pending&metadata->>guard=eq.true&select=id,metadata&limit=2000`); } catch (e) { existing = []; }
  const have = {}; (existing || []).forEach(d => { if (d.metadata && d.metadata.key) have[d.metadata.key] = d.id; });
  const seen = {}; const fresh = [];
  found.forEach(d => { if (seen[d.metadata.key]) return; seen[d.metadata.key] = 1; if (!have[d.metadata.key]) fresh.push(d); });
  if (fresh.length) await sb('sentinel_decisions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(fresh) });
  const gone = Object.keys(have).filter(k => !seen[k]).map(k => have[k]);
  if (gone.length) await sb(`sentinel_decisions?id=in.(${gone.join(',')})`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: 'resolved', resolved_at: new Date().toISOString() }) });
  return { found: found.length, added: fresh.length, closed: gone.length };
}

// Product: what shipped in the last 7 days, from CHANGELOG.md on the site
async function shippedThisWeek(now) {
  try {
    const r = await fetchWithin(APP_URL + '/CHANGELOG.md', 4000); if (!r.ok) return null;
    const text = await r.text(), cutoff = londonDay((now ? new Date(now) : new Date()).getTime() - 7 * DAY), items = [];
    let day = '';
    text.split('\n').forEach(l => { const h = /^##\s+(\d{4}-\d{2}-\d{2})/.exec(l); if (h) { day = h[1]; return; } const b = /^\s*[-*]\s+(.+)/.exec(l); if (b && day && day >= cutoff) items.push(b[1].trim()); });
    if (!items.length) return null;
    await sb('sentinel_actions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ agent: 'Product', action: `Shipped in the last 7 days: ${items.length} change${items.length === 1 ? '' : 's'}`, detail: items.slice(0, 12).join(' · ').slice(0, 1800), org_id: null, cost_pence: 0 }]) });
    return items.length;
  } catch (e) { return null; }
}

// Agents that failed in today's run become a Dev card
function agentFailures(errors) {
  return (errors || []).map(e => ({ agent: 'Dev', tier: 'high', title: `Sentinel's ${e.agent} agent failed this morning`, description: String(e.error || '').slice(0, 400), primary_action: 'Mark as fixed', secondary_action: 'Dismiss', org_id: null, status: 'pending', metadata: { guard: true, key: `agent_failed:${e.agent}:${londonDay(Date.now())}`, signal: 'agent_failed' } }));
}

module.exports = { runGuard, syncDecisions, shippedThisWeek, agentFailures };
