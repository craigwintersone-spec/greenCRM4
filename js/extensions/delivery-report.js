// js/extensions/delivery-report.js  — v1.0
// ─────────────────────────────────────────────────────────────
// DELIVERY REPORT — events, volunteers, hours and feedback.
//
// The existing Reports page generates a FUNDER report from
// participants + contracts. This adds a second kind: a delivery
// and impact report built from events, volunteer hours and
// attendee feedback. For orgs whose work is workshops and
// volunteering rather than caseloads.
//
// PRINCIPLE: the code computes every number. The AI only writes
// the prose around them. LLMs miscount; a wrong volunteer-hours
// total in a funder report is a real problem.
//
// Also reports DATA COMPLETENESS ("12 of 40 volunteers have
// demographics recorded") — funders trust a report more when it
// is honest about its own gaps.
//
// Depends on: db.js (DB, sb, orgId), agents.js (runAgent,
//   cleanReportText, reportTextToHTML, getOrgLogoUrl),
//   utils.js ($, escapeHTML)
// Load AFTER boot.js and the other extensions.
'use strict';

(function () {

var VERSION = 'v1.0';

// UK Living Wage (Living Wage Foundation, 2024/25). Shown in the
// report and editable — never present a made-up rate to a funder.
var DEFAULT_RATE = 12.60;
var RATE_LABEL = 'UK Living Wage (Living Wage Foundation, 2024/25)';

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function n(v) { return isNaN(+v) ? 0 : +v; }
function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
function gv(id) { var e = $(id); return e ? (e.value || '') : ''; }
function money(v) { return '£' + Math.round(v).toLocaleString('en-GB'); }
function round1(v) { return Math.round(v * 10) / 10; }

// ── period ─────────────────────────────────────────────────
function quarterRange(y, q) {
  var s = new Date(y, (q - 1) * 3, 1);
  var e = new Date(y, (q - 1) * 3 + 3, 0);
  return { from: s.toISOString().slice(0, 10), to: e.toISOString().slice(0, 10) };
}
function currentPeriod() {
  var t = gv('dr-period-type') || 'all';
  var now = new Date();
  if (t === 'all') return { from: null, to: null, label: 'all activity to date' };
  if (t === 'month') {
    var m = gv('dr-month'); if (!m) return { from: null, to: null, label: 'all activity to date' };
    var p = m.split('-');
    var y = +p[0], mo = +p[1];
    return {
      from: new Date(y, mo - 1, 1).toISOString().slice(0, 10),
      to: new Date(y, mo, 0).toISOString().slice(0, 10),
      label: new Date(y, mo - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
    };
  }
  if (t === 'quarter') {
    var v = gv('dr-quarter'); if (!v) return { from: null, to: null, label: 'all activity to date' };
    var bits = v.split('-Q');
    var r = quarterRange(+bits[0], +bits[1]);
    return { from: r.from, to: r.to, label: 'Q' + bits[1] + ' ' + bits[0] };
  }
  if (t === 'year') {
    var yr = gv('dr-year') || String(now.getFullYear());
    return { from: yr + '-01-01', to: yr + '-12-31', label: yr };
  }
  var f = gv('dr-from'), tt = gv('dr-to');
  if (!f || !tt) return { from: null, to: null, label: 'all activity to date' };
  return { from: f, to: tt, label: f + ' to ' + tt };
}
function inPeriod(dateStr, p) {
  if (!p.from || !p.to) return true;
  if (!dateStr) return false;
  var d = String(dateStr).slice(0, 10);
  return d >= p.from && d <= p.to;
}

// ── stats: ALL computed here, never by the AI ──────────────
function buildStats(p) {
  var EV = (DB.events || []).filter(function (e) { return inPeriod(e.date, p); });
  var evIds = {}; EV.forEach(function (e) { evIds[String(e.id)] = e; });

  var HRS = (DB.volunteer_hours || []).filter(function (h) { return inPeriod(h.date, p); });

  // Feedback is dated by its event
  var FB = (DB.feedback || []).filter(function (f) {
    var ev = (DB.events || []).filter(function (e) { return String(e.id) === String(f.eventId || f.event_id); })[0];
    return ev ? inPeriod(ev.date, p) : (!p.from);
  });

  var V = DB.volunteers || [];

  // volunteers active in period
  var activeIds = {};
  HRS.forEach(function (h) { activeIds[String(h.volunteer_id)] = 1; });
  var activeVols = V.filter(function (v) { return activeIds[String(v.id)]; });

  var totalHours = HRS.reduce(function (a, h) { return a + n(h.hours); }, 0);
  var rate = parseFloat(gv('dr-rate')) || DEFAULT_RATE;

  // hours by month
  var byMonth = {};
  HRS.forEach(function (h) {
    var k = (h.date || '').slice(0, 7);
    if (k) byMonth[k] = (byMonth[k] || 0) + n(h.hours);
  });

  // hours by event
  var byEvent = {};
  HRS.forEach(function (h) {
    if (!h.event_id) return;
    var k = String(h.event_id);
    byEvent[k] = (byEvent[k] || 0) + n(h.hours);
  });

  // volunteer vs staff roles
  var STAFF_ROLES = { 'Advisor': 1, 'Manager': 1, 'Admin': 1, 'Staff': 1 };
  var volHours = 0, staffHours = 0;
  HRS.forEach(function (h) {
    var v = V.filter(function (x) { return String(x.id) === String(h.volunteer_id); })[0];
    if (v && STAFF_ROLES[v.role]) staffHours += n(h.hours);
    else volHours += n(h.hours);
  });

  // events by type + attendance
  var byType = {};
  var attendees = 0, capacity = 0;
  EV.forEach(function (e) {
    var t = e.type || 'Other';
    byType[t] = (byType[t] || 0) + 1;
    attendees += n(e.attendees);
    capacity += n(e.capacity);
  });

  // feedback
  var fbCount = FB.length;
  var avgEnjoyed = fbCount ? FB.reduce(function (a, f) { return a + n(f.enjoyed); }, 0) / fbCount : 0;
  var avgCB = fbCount ? FB.reduce(function (a, f) { return a + n(f.cb); }, 0) / fbCount : 0;
  var avgCA = fbCount ? FB.reduce(function (a, f) { return a + n(f.ca); }, 0) / fbCount : 0;
  var learned = FB.filter(function (f) { return f.learned; }).length;
  var connected = FB.filter(function (f) { return f.connected; }).length;
  var friend = FB.filter(function (f) { return f.friend; }).length;
  var improved = FB.filter(function (f) { return n(f.ca) > n(f.cb); }).length;
  var quotes = FB.filter(function (f) { return f.quote && String(f.quote).trim().length > 15; })
                 .map(function (f) { return String(f.quote).trim(); });

  // demographics of ACTIVE volunteers (aggregate only)
  var withEq = activeVols.filter(function (v) { return v.equality_data && Object.keys(v.equality_data).length; });
  function tally(key) {
    var out = {};
    withEq.forEach(function (v) {
      var val = v.equality_data[key];
      if (val) out[val] = (out[val] || 0) + 1;
    });
    return out;
  }

  return {
    period: p,
    rate: rate,
    events: EV,
    eventCount: EV.length,
    byType: byType,
    attendees: attendees,
    capacity: capacity,
    fillRate: capacity ? pct(attendees, capacity) : null,
    hoursRows: HRS,
    totalHours: round1(totalHours),
    volHours: round1(volHours),
    staffHours: round1(staffHours),
    sessionCount: HRS.length,
    byMonth: byMonth,
    byEvent: byEvent,
    activeVolunteers: activeVols.length,
    totalVolunteers: V.length,
    value: totalHours * rate,
    avgPerVolunteer: activeVols.length ? round1(totalHours / activeVols.length) : 0,
    fbCount: fbCount,
    avgEnjoyed: round1(avgEnjoyed),
    avgCB: round1(avgCB),
    avgCA: round1(avgCA),
    confGain: round1(avgCA - avgCB),
    improvedPct: fbCount ? pct(improved, fbCount) : 0,
    learnedPct: fbCount ? pct(learned, fbCount) : 0,
    connectedPct: fbCount ? pct(connected, fbCount) : 0,
    friendPct: fbCount ? pct(friend, fbCount) : 0,
    quotes: quotes,
    eqCount: withEq.length,
    eqAge: tally('age'),
    eqEthnicity: tally('ethnicity'),
    eqGender: tally('gender'),
    eqDisability: tally('disability')
  };
}

// ── UI: inject the picker onto the Reports page ────────────
function yearOptions() {
  var y = new Date().getFullYear(), out = '';
  for (var i = y; i >= y - 4; i--) out += '<option value="' + i + '">' + i + '</option>';
  return out;
}
function quarterOptions() {
  var now = new Date(), y = now.getFullYear(), out = '';
  var curQ = Math.floor(now.getMonth() / 3) + 1;
  for (var yy = y; yy >= y - 2; yy--) {
    for (var q = 4; q >= 1; q--) {
      var sel = (yy === y && q === curQ) ? ' selected' : '';
      out += '<option value="' + yy + '-Q' + q + '"' + sel + '>Q' + q + ' ' + yy + '</option>';
    }
  }
  return out;
}

function injectUI() {
  var host = $('reports-contract-list');
  if (!host || $('dr-panel')) return;

  var panel = document.createElement('div');
  panel.id = 'dr-panel';
  panel.className = 'card';
  panel.innerHTML =
    '<div class="card-title">📅 Delivery report — events, volunteers &amp; feedback</div>' +
    '<p style="font-size:13px;color:var(--txt2);line-height:1.7;margin-bottom:14px">' +
      'For workshops, volunteering and community delivery — no contract needed. Every figure is calculated from your records; ' +
      'the Org Brain writes the narrative around them. The report states what data is missing, so nothing is overclaimed.' +
    '</p>' +
    '<div class="form-grid-3">' +
      '<div class="form-row"><label>Reporting period</label>' +
        '<select id="dr-period-type">' +
          '<option value="all">All activity to date</option>' +
          '<option value="year">Calendar year</option>' +
          '<option value="quarter">Quarter</option>' +
          '<option value="month">Month</option>' +
          '<option value="custom">Custom range</option>' +
        '</select>' +
      '</div>' +
      '<div class="form-row" id="dr-year-wrap" style="display:none"><label>Year</label><select id="dr-year">' + yearOptions() + '</select></div>' +
      '<div class="form-row" id="dr-quarter-wrap" style="display:none"><label>Quarter</label><select id="dr-quarter">' + quarterOptions() + '</select></div>' +
      '<div class="form-row" id="dr-month-wrap" style="display:none"><label>Month</label><input type="month" id="dr-month" value="' + new Date().toISOString().slice(0, 7) + '"/></div>' +
      '<div class="form-row" id="dr-from-wrap" style="display:none"><label>From</label><input type="date" id="dr-from"/></div>' +
      '<div class="form-row" id="dr-to-wrap" style="display:none"><label>To</label><input type="date" id="dr-to"/></div>' +
      '<div class="form-row"><label>Volunteer hour value (£)</label><input type="number" id="dr-rate" step="0.01" min="0" value="' + DEFAULT_RATE + '"/>' +
        '<div style="font-size:11px;color:var(--txt3);margin-top:4px">Default: ' + RATE_LABEL + '</div></div>' +
    '</div>' +
    '<div id="dr-preview" style="margin:14px 0"></div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
      '<button class="btn btn-ai" id="dr-generate">✦ Generate delivery report</button>' +
      '<button class="btn btn-ghost btn-sm" id="dr-refresh">↻ Refresh figures</button>' +
    '</div>';

  host.parentNode.insertBefore(panel, host);

  $('dr-period-type').addEventListener('change', function () {
    var t = this.value;
    ['year', 'quarter', 'month', 'from', 'to'].forEach(function (k) {
      var el = $('dr-' + k + '-wrap'); if (el) el.style.display = 'none';
    });
    if (t === 'year') $('dr-year-wrap').style.display = 'block';
    if (t === 'quarter') $('dr-quarter-wrap').style.display = 'block';
    if (t === 'month') $('dr-month-wrap').style.display = 'block';
    if (t === 'custom') { $('dr-from-wrap').style.display = 'block'; $('dr-to-wrap').style.display = 'block'; }
    (window._drRenderPreview || renderPreview)();
  });
  ['dr-year', 'dr-quarter', 'dr-month', 'dr-from', 'dr-to', 'dr-rate'].forEach(function (id) {
    var el = $(id); if (el) el.addEventListener('change', function () { (window._drRenderPreview || renderPreview)(); });
  });
  $('dr-generate').addEventListener('click', function () { (window._drGenerate || generate)(); });
  $('dr-refresh').addEventListener('click', function () { (window._drRenderPreview || renderPreview)(); });

  (window._drRenderPreview || renderPreview)();
}

// ── live preview of the computed figures ───────────────────
function renderPreview() {
  var el = $('dr-preview'); if (!el) return;
  var s = buildStats(currentPeriod());

  var gaps = [];
  if (s.activeVolunteers && s.eqCount < s.activeVolunteers) {
    gaps.push(s.eqCount + ' of ' + s.activeVolunteers + ' active volunteers have demographics recorded');
  }
  if (s.eventCount && !s.fbCount) gaps.push('no feedback responses in this period');
  if (s.eventCount && !s.capacity) gaps.push('event capacity not recorded, so attendance rate cannot be shown');
  if (!s.hoursRows.length) gaps.push('no volunteer hours logged in this period');

  el.innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;margin-bottom:10px">' +
      stat('Events', s.eventCount) +
      stat('Attendees', s.attendees) +
      stat('Volunteers', s.activeVolunteers) +
      stat('Hours', s.totalHours) +
      stat('Value', money(s.value)) +
      stat('Feedback', s.fbCount) +
    '</div>' +
    (gaps.length
      ? '<div class="alert alert-warn" style="margin:0;font-size:12px"><strong>Data gaps — these will be stated in the report:</strong><br/>• ' + gaps.map(esc).join('<br/>• ') + '</div>'
      : '<div class="alert alert-ok" style="margin:0;font-size:12px">✓ Complete data for this period.</div>');
}
function stat(label, val) {
  return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center">' +
    '<div style="font-size:20px;font-weight:800;color:var(--em)">' + esc(String(val)) + '</div>' +
    '<div style="font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;font-weight:700">' + esc(label) + '</div>' +
  '</div>';
}

// ── tables for the finished document ───────────────────────
function tableFrom(obj, label, totalOverride) {
  var keys = Object.keys(obj);
  if (!keys.length) return '';
  var total = totalOverride || keys.reduce(function (a, k) { return a + obj[k]; }, 0);
  keys.sort(function (a, b) { return obj[b] - obj[a]; });
  return '<table class="dr-tbl"><thead><tr><th>' + esc(label) + '</th><th>Count</th><th>%</th></tr></thead><tbody>' +
    keys.map(function (k) {
      return '<tr><td>' + esc(k) + '</td><td>' + obj[k] + '</td><td>' + pct(obj[k], total) + '%</td></tr>';
    }).join('') +
    '</tbody></table>';
}

function monthTable(byMonth) {
  var keys = Object.keys(byMonth).sort();
  if (!keys.length) return '';
  return '<table class="dr-tbl"><thead><tr><th>Month</th><th>Hours</th></tr></thead><tbody>' +
    keys.map(function (k) {
      var lbl = new Date(k + '-01').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      return '<tr><td>' + esc(lbl) + '</td><td>' + round1(byMonth[k]) + '</td></tr>';
    }).join('') +
    '</tbody></table>';
}

function eventTable(s) {
  if (!s.events.length) return '';
  var rows = s.events.slice().sort(function (a, b) { return (a.date || '').localeCompare(b.date || ''); });
  return '<table class="dr-tbl"><thead><tr><th>Date</th><th>Event</th><th>Type</th><th>Attendees</th><th>Volunteer hours</th></tr></thead><tbody>' +
    rows.map(function (e) {
      var h = s.byEvent[String(e.id)] || 0;
      var d = e.date ? new Date(e.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
      return '<tr><td>' + esc(d) + '</td><td>' + esc(e.name || '—') + '</td><td>' + esc(e.type || '—') + '</td>' +
             '<td>' + n(e.attendees) + '</td><td>' + round1(h) + '</td></tr>';
    }).join('') +
    '</tbody></table>';
}

// ── generate ───────────────────────────────────────────────
function generate() {
  var progressEl = $('brain-progress');
  var outEl = $('report-output');
  if (!progressEl || !outEl) return;

  var p = currentPeriod();
  var s = buildStats(p);

  if (!s.eventCount && !s.hoursRows.length && !s.fbCount) {
    outEl.innerHTML = '<div class="alert alert-warn">There is no event, volunteer-hour or feedback data in this period. Choose a wider period, or log some activity first.</div>';
    return;
  }

  outEl.innerHTML = '';
  progressEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  var orgName = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || 'Organisation';
  var todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

  var gaps = [];
  if (s.activeVolunteers && s.eqCount < s.activeVolunteers) {
    gaps.push('Demographic data is held for ' + s.eqCount + ' of ' + s.activeVolunteers + ' active volunteers (' + pct(s.eqCount, s.activeVolunteers) + '%); completion is voluntary.');
  }
  if (s.eventCount && !s.fbCount) gaps.push('No feedback responses were collected in this period.');
  if (s.eventCount && !s.capacity) gaps.push('Capacity was not recorded for these events, so an attendance rate is not given.');

  var steps = [
    { label: 'Calculating figures', meta: s.eventCount + ' events · ' + s.sessionCount + ' hour entries · ' + s.fbCount + ' feedback responses' },
    { label: 'Checking data completeness', meta: gaps.length ? gaps.length + ' gap(s) to declare' : 'complete' },
    { label: 'Writing the narrative', meta: 'Org Brain composing from your verified numbers' },
    { label: 'Quality check', meta: 'Tone, claims and structure' },
    { label: 'Ready', meta: 'Review and download below' }
  ];

  var sys = 'You are a professional UK charity impact writer producing a delivery report for a funder or board. ' +
    'Write clean formal British English. Structure with these sections, each beginning with ## and the section title: ' +
    'Executive Summary, Delivery Overview, Volunteer Contribution, Participant Experience, Data Quality, Forward View. ' +
    'CRITICAL: use ONLY the figures supplied. Never invent, estimate, extrapolate or recalculate any number — ' +
    'every statistic has already been computed from the database. Do not add totals of your own. ' +
    'Quote the supplied numbers exactly as given. Use **bold** sparingly for headline figures. 600-800 words. ' +
    'In Data Quality, state the listed gaps plainly and without defensiveness. ' +
    'Do not use hashtags except as section markers, no horizontal rules, no emoji.';

  var lines = [
    'Organisation: ' + orgName,
    'Report date: ' + todayStr,
    'Reporting period: ' + p.label + (p.from ? ' (' + p.from + ' to ' + p.to + ')' : ''),
    '',
    'DELIVERY',
    'Events delivered: ' + s.eventCount,
    'Total attendances: ' + s.attendees,
    s.fillRate != null ? 'Attendance against capacity: ' + s.fillRate + '%' : '',
    'Events by type: ' + (Object.keys(s.byType).map(function (k) { return k + ' ' + s.byType[k]; }).join(', ') || 'none'),
    '',
    'VOLUNTEERING',
    'Volunteers active in period: ' + s.activeVolunteers + ' (of ' + s.totalVolunteers + ' registered)',
    'Total hours contributed: ' + s.totalHours,
    'Volunteer hours: ' + s.volHours + ' · staff hours: ' + s.staffHours,
    'Average hours per active volunteer: ' + s.avgPerVolunteer,
    'Notional value of volunteer time: ' + money(s.value) + ' (at £' + s.rate.toFixed(2) + '/hour, ' + RATE_LABEL + ')',
    '',
    'PARTICIPANT FEEDBACK',
    'Responses: ' + s.fbCount,
    s.fbCount ? 'Average enjoyment: ' + s.avgEnjoyed + ' out of 5' : '',
    s.fbCount ? 'Confidence before: ' + s.avgCB + ' → after: ' + s.avgCA + ' (average gain ' + s.confGain + ')' : '',
    s.fbCount ? 'Reported increased confidence: ' + s.improvedPct + '%' : '',
    s.fbCount ? 'Learned something new: ' + s.learnedPct + '%' : '',
    s.fbCount ? 'Felt more connected: ' + s.connectedPct + '%' : '',
    s.fbCount ? 'Made a new friend: ' + s.friendPct + '%' : '',
    s.quotes.length ? 'Participant quotes you may use verbatim (do not alter):\n' + s.quotes.slice(0, 4).map(function (q) { return '- "' + q + '"'; }).join('\n') : '',
    '',
    'DATA QUALITY NOTES' ,
    gaps.length ? gaps.map(function (g) { return '- ' + g; }).join('\n') : '- No significant data gaps in this period.'
  ].filter(Boolean).join('\n');

  if (typeof runAgent !== 'function') {
    outEl.innerHTML = '<div class="alert alert-warn">The Org Brain agent is not available on this page.</div>';
    return;
  }

  runAgent({
    container: progressEl,
    headerLabel: 'Org Brain — Delivery Report',
    headerSub: 'Figures calculated from your records; the Brain writes the narrative',
    steps: steps,
    sys: sys,
    prompt: lines,
    maxTok: 1400
  }).then(function (raw) {
    if (!raw) return;
    renderDoc(raw, s, orgName, todayStr);
  });
}

function renderDoc(raw, s, orgName, todayStr) {
  var outEl = $('report-output');
  var cleaned = (typeof cleanReportText === 'function') ? cleanReportText(raw) : raw;
  var bodyHTML = (typeof reportTextToHTML === 'function') ? reportTextToHTML(cleaned, raw) : '<pre>' + esc(cleaned) + '</pre>';

  if (typeof window !== 'undefined') {
    window._lastReportText = cleaned;
    window._lastReportTitle = orgName + ' — Delivery Report (' + s.period.label + ')';
  }

  var logo = (typeof getOrgLogoUrl === 'function') ? getOrgLogoUrl(typeof currentOrg !== 'undefined' ? currentOrg : null) : '';
  var header = logo
    ? '<div class="report-header-flex"><div class="report-header-text">' +
        '<div class="report-meta">Delivery &amp; Impact Report · ' + esc(s.period.label) + '</div>' +
        '<div class="report-title">Events, Volunteering &amp; Participant Experience</div>' +
        '<div class="report-subtitle">' + esc(orgName) + ' · ' + esc(todayStr) + '</div>' +
      '</div><div class="report-header-logo"><img src="' + esc(logo) + '" alt="' + esc(orgName) + '" class="org-logo-report" onerror="this.style.display=\'none\'"/></div></div>'
    : '<div class="report-header">' +
        '<div class="report-meta">Delivery &amp; Impact Report · ' + esc(s.period.label) + '</div>' +
        '<div class="report-title">Events, Volunteering &amp; Participant Experience</div>' +
        '<div class="report-subtitle">' + esc(orgName) + ' · ' + esc(todayStr) + '</div>' +
      '</div>';

  // headline figures block — the numbers, plainly
  var headline =
    '<div class="dr-figs">' +
      fig('Events delivered', s.eventCount) +
      fig('Total attendances', s.attendees) +
      fig('Active volunteers', s.activeVolunteers) +
      fig('Hours contributed', s.totalHours) +
      fig('Value of volunteer time', money(s.value)) +
      fig('Feedback responses', s.fbCount) +
    '</div>';

  var demographics = '';
  if (s.eqCount) {
    demographics =
      '<h3>Volunteer demographics</h3>' +
      '<p style="font-size:12px;color:#666">Aggregate and anonymised. Based on the ' + s.eqCount + ' active volunteer' + (s.eqCount === 1 ? '' : 's') + ' who chose to provide this information.</p>' +
      tableFrom(s.eqAge, 'Age group', s.eqCount) +
      tableFrom(s.eqEthnicity, 'Ethnicity', s.eqCount) +
      tableFrom(s.eqGender, 'Gender', s.eqCount) +
      tableFrom(s.eqDisability, 'Disability', s.eqCount);
  }

  var appendix =
    '<h3>Appendix A — Events delivered</h3>' + (eventTable(s) || '<p>No events in this period.</p>') +
    '<h3>Appendix B — Volunteer hours by month</h3>' + (monthTable(s.byMonth) || '<p>No hours logged in this period.</p>') +
    (Object.keys(s.byType).length ? '<h3>Appendix C — Events by type</h3>' + tableFrom(s.byType, 'Type', s.eventCount) : '') +
    demographics +
    '<p style="font-size:11px;color:#777;margin-top:18px">Volunteer time valued at £' + s.rate.toFixed(2) + ' per hour — ' + esc(RATE_LABEL) + '. ' +
      'All figures calculated directly from records held in Vorlana for the period stated.</p>';

  outEl.innerHTML =
    '<style>' +
      '.dr-figs{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0 24px}' +
      '.dr-fig{border:1px solid #ddd;border-radius:8px;padding:12px;text-align:center}' +
      '.dr-fig-v{font-size:24px;font-weight:800;color:#1F6F6D}' +
      '.dr-fig-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#777;font-weight:700;margin-top:2px}' +
      '.dr-tbl{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:13px}' +
      '.dr-tbl th{text-align:left;border-bottom:2px solid #ccc;padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#555}' +
      '.dr-tbl td{border-bottom:1px solid #eee;padding:6px 8px}' +
      '@media print{.dr-figs{grid-template-columns:repeat(3,1fr)}.dr-tbl{page-break-inside:avoid}}' +
    '</style>' +
    '<div class="report-actions">' +
      '<button class="btn btn-p" onclick="downloadReportPDF()">⬇ Download as PDF</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="copyReportText()" id="copy-report-btn">📋 Copy text</button>' +
      '<button class="btn btn-ghost btn-sm" id="dr-regen">↻ Regenerate</button>' +
    '</div>' +
    '<div class="report-doc">' +
      header +
      '<div class="report-body">' + headline + bodyHTML + appendix + '</div>' +
      '<div class="report-footer">Generated by Vorlana · ' + esc(todayStr) + ' · Period: ' + esc(s.period.label) + '</div>' +
    '</div>';

  var rg = $('dr-regen');
  if (rg) rg.addEventListener('click', function () { (window._drGenerate || generate)(); });

  outEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fig(label, val) {
  return '<div class="dr-fig"><div class="dr-fig-v">' + esc(String(val)) + '</div><div class="dr-fig-l">' + esc(label) + '</div></div>';
}

// ── init ───────────────────────────────────────────────────
function whenReady(fn) {
  if (typeof DB !== 'undefined' && typeof renderReports === 'function') return setTimeout(fn, 350);
  setTimeout(function () { whenReady(fn); }, 150);
}

whenReady(function () {
  // Expose these so event-contracts.js can wrap them with a funder filter.
  window._drRenderPreview = renderPreview;
  window._drGenerate = generate;

  // The Reports page builds its list on render; add our panel after it.
  var orig = window.renderReports;
  if (typeof orig === 'function' && !orig._dr) {
    window.renderReports = function () {
      var r = orig.apply(this, arguments);
      try { injectUI(); window._drRenderPreview(); } catch (e) {}
      return r;
    };
    window.renderReports._dr = true;
  }
  var page = $('page-reports');
  if (page && page.classList.contains('active')) { try { injectUI(); } catch (e) {} }
  console.log('[delivery-report ' + VERSION + '] ready');
});

})();
