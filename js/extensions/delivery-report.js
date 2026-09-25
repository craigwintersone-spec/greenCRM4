// js/extensions/delivery-report.js  — v1.1
// ─────────────────────────────────────────────────────────────
// DELIVERY REPORT — events, volunteers, hours and feedback.
//
// Sits on the Reports page alongside the contract-based funder
// report. Built from events, volunteer hours and attendee feedback.
//
// PRINCIPLE: the code computes every number. The AI only writes
// the prose around them. LLMs miscount; a wrong volunteer-hours
// total in a funder report is a real problem.
//
// Declares its own DATA GAPS ("12 of 40 volunteers have
// demographics recorded") — funders trust that more than silence.
//
// v1.1 — the funder/contract filter now lives HERE, inside
// buildStats(). Previously event-contracts.js tried to wrap this
// file's functions at startup, which silently failed whenever this
// file finished loading second — so choosing a funder changed
// nothing. No cross-file wrapping any more.
//
// Depends on: db.js (DB, sb, orgId), agents.js (runAgent,
//   cleanReportText, reportTextToHTML, getOrgLogoUrl)
'use strict';

(function () {

var VERSION = 'v1.2';

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
function toArrSafe(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.indexOf('[') === 0) { try { return JSON.parse(v); } catch (e) { return []; } }
  return [];
}
function byIdIn(list, id) {
  list = list || [];
  for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
  return null;
}

// ── contracts ──────────────────────────────────────────────
function funderFor(c) {
  return (c && c.funder_id) ? byIdIn(DB.funders || [], c.funder_id) : null;
}
function contractLabel(c) {
  var f = funderFor(c);
  return (c.name || 'Unnamed contract') + (f ? ' · ' + f.name : '');
}
function selectedContract() {
  var id = gv('dr-contract');
  return id ? byIdIn(DB.contracts || [], id) : null;
}

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
  var con = selectedContract();
  var conId = con ? String(con.id) : '';

  // events in period, and in the chosen contract if one is picked
  var EV = (DB.events || []).filter(function (e) {
    if (!inPeriod(e.date, p)) return false;
    if (!conId) return true;
    return toArrSafe(e.contract_ids).map(String).indexOf(conId) !== -1;
  });
  var evIds = {};
  EV.forEach(function (e) { evIds[String(e.id)] = 1; });

  // hours: in period; if filtering by contract, only hours on those events
  var HRS = (DB.volunteer_hours || []).filter(function (h) {
    if (!inPeriod(h.date, p)) return false;
    if (!conId) return true;
    return h.event_id && evIds[String(h.event_id)];
  });

  // feedback: dated by its event; if filtering, only on those events
  var FB = (DB.feedback || []).filter(function (f) {
    var eid = String(f.eventId || f.event_id || '');
    if (conId) return !!evIds[eid];
    var ev = byIdIn(DB.events || [], eid);
    return ev ? inPeriod(ev.date, p) : !p.from;
  });

  var V = DB.volunteers || [];

  var activeIds = {};
  HRS.forEach(function (h) { activeIds[String(h.volunteer_id)] = 1; });
  var activeVols = V.filter(function (v) { return activeIds[String(v.id)]; });

  var totalHours = HRS.reduce(function (a, h) { return a + n(h.hours); }, 0);
  var rate = parseFloat(gv('dr-rate')) || DEFAULT_RATE;

  var byMonth = {};
  HRS.forEach(function (h) {
    var k = (h.date || '').slice(0, 7);
    if (k) byMonth[k] = (byMonth[k] || 0) + n(h.hours);
  });

  var byEvent = {};
  HRS.forEach(function (h) {
    if (!h.event_id) return;
    var k = String(h.event_id);
    byEvent[k] = (byEvent[k] || 0) + n(h.hours);
  });

  var STAFF_ROLES = { 'Advisor': 1, 'Manager': 1, 'Admin': 1, 'Staff': 1 };
  var volHours = 0, staffHours = 0;
  HRS.forEach(function (h) {
    var v = byIdIn(V, h.volunteer_id);
    if (v && STAFF_ROLES[v.role]) staffHours += n(h.hours);
    else volHours += n(h.hours);
  });

  var byType = {};
  var attendees = 0, capacity = 0;
  EV.forEach(function (e) {
    var t = e.type || 'Other';
    byType[t] = (byType[t] || 0) + 1;
    attendees += n(e.attendees);
    capacity += n(e.capacity);
  });

  var fbCount = FB.length;
  // Averages over people who ANSWERED — a blank is not a zero
  function avg(key) {
    var v = FB.map(function (f) { return f[key]; }).filter(function (x) { return x != null && x !== '' && n(x) > 0; }).map(n);
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : 0;
  }
  function answeredPct(key) {
    var v = FB.filter(function (f) { return f[key] === true || f[key] === false; });
    return v.length ? pct(v.filter(function (f) { return f[key]; }).length, v.length) : 0;
  }
  var pairs = FB.filter(function (f) { return n(f.cb) > 0 && n(f.ca) > 0; });
  var improved = pairs.filter(function (f) { return n(f.ca) > n(f.cb); }).length;
  var quotes = (typeof measureQuotes === 'function' ? measureQuotes(FB).map(function (q) { return q.quote; })
               : FB.map(function (f) { return f.quote; }))
    .filter(function (q) { return q && String(q).trim().length > 15 && !/^(nothing|none|n\/?a|no|not really|all good)\b/i.test(String(q).trim()); })
    .map(function (q) { return String(q).trim(); });

  // The org's own questions (same figures as the Feedback page)
  var ownMeasures = [];
  if (typeof measureStats === 'function' && typeof activeMeasures === 'function' && activeMeasures().length) {
    measureStats(FB).forEach(function (st) {
      if (st.m.maps_to === 'cb' || st.m.maps_to === 'ca') return;
      var line = st.kind === 'score' ? st.avg.toFixed(1) + ' / 5 average (' + st.pctHigh + '% rated 4–5)'
               : st.kind === 'yesno' ? st.pctYes + '% yes'
               : 'most common answer "' + st.breakdown[0][0] + '"';
      ownMeasures.push({ q: st.m.question, text: line, n: st.n, allYes: st.kind === 'yesno' && st.pctYes === 100 && st.n >= 20 });
    });
  }
  var journey = (typeof measureJourney === 'function') ? measureJourney(FB) : null;

  // Demographics — tidied the same way as the Demographics page
  var T = window.DemoTidy || { tidyRecord: function (d) { return d || {}; }, isBEM: function (e) { return !!e && !/^white/i.test(e); }, isDisabled: function (d) { return !!d && !/^(no|none|no disability)$/i.test(d); } };
  function demoSummary(records) {
    var withData = records.filter(function (d) { return Object.keys(d).length; });
    function tally(key) {
      var out = {};
      withData.forEach(function (d) { if (d[key]) out[d[key]] = (out[d[key]] || 0) + 1; });
      return out;
    }
    var eth = withData.filter(function (d) { return d.ethnicity; });
    var dis = withData.filter(function (d) { return d.disability; });
    var pcs = tally('postcode');
    var topPc = Object.keys(pcs).sort(function (a, b) { return pcs[b] - pcs[a]; }).slice(0, 3);
    var pcTotal = Object.keys(pcs).reduce(function (a, k) { return a + pcs[k]; }, 0);
    return {
      count: withData.length,
      age: tally('age'), ethnicity: tally('ethnicity'), gender: tally('gender'), disability: tally('disability'), postcode: pcs,
      ethN: eth.length, bemPct: eth.length ? pct(eth.filter(function (d) { return T.isBEM(d.ethnicity); }).length, eth.length) : null,
      disN: dis.length, disabledPct: dis.length ? pct(dis.filter(function (d) { return T.isDisabled(d.disability); }).length, dis.length) : null,
      topPostcodes: topPc, topPostcodePct: pcTotal ? pct(topPc.slice(0, 2).reduce(function (a, k) { return a + pcs[k]; }, 0), pcTotal) : null
    };
  }
  var volDemo = demoSummary(activeVols.map(function (v) { return T.tidyRecord(v.equality_data); }));
  var attDemo = demoSummary(FB.map(function (f) { return T.tidyRecord(f.demographics); }));
  var withEq = { length: volDemo.count };

  // hours with no event can't be attributed to a funder — say so
  var unlinkedHours = conId ? 0 : (DB.volunteer_hours || []).filter(function (h) {
    return inPeriod(h.date, p) && !h.event_id;
  }).reduce(function (a, h) { return a + n(h.hours); }, 0);

  return {
    period: p,
    contract: con,
    funder: con ? funderFor(con) : null,
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
    unlinkedHours: round1(unlinkedHours),
    sessionCount: HRS.length,
    byMonth: byMonth,
    byEvent: byEvent,
    activeVolunteers: activeVols.length,
    totalVolunteers: V.length,
    value: totalHours * rate,
    avgPerVolunteer: activeVols.length ? round1(totalHours / activeVols.length) : 0,
    fbCount: fbCount,
    avgEnjoyed: round1(avg('enjoyed')),
    avgCB: journey ? +journey.before : round1(avg('cb')),
    avgCA: journey ? +journey.after : round1(avg('ca')),
    confGain: journey ? round1(journey.after - journey.before) : round1(avg('ca') - avg('cb')),
    improvedPct: pairs.length ? pct(improved, pairs.length) : 0,
    learnedPct: answeredPct('learned'),
    connectedPct: answeredPct('connected'),
    friendPct: answeredPct('friend'),
    ownMeasures: ownMeasures,
    quotes: quotes,
    eqCount: volDemo.count,
    eqAge: volDemo.age,
    eqEthnicity: volDemo.ethnicity,
    eqGender: volDemo.gender,
    eqDisability: volDemo.disability,
    volDemo: volDemo,
    attDemo: attDemo
  };
}

function gapsFor(s) {
  var gaps = [];
  if (s.activeVolunteers && s.eqCount < s.activeVolunteers) {
    gaps.push('Demographic data is held for ' + s.eqCount + ' of ' + s.activeVolunteers + ' active volunteers (' + pct(s.eqCount, s.activeVolunteers) + '%); completion is voluntary.');
  }
  if (s.fbCount && s.attDemo.count < s.fbCount) {
    gaps.push('Demographic data was given in ' + s.attDemo.count + ' of ' + s.fbCount + ' feedback responses (' + pct(s.attDemo.count, s.fbCount) + '%); it is optional and anonymous.');
  }
  if (s.eventCount && !s.fbCount) gaps.push('No feedback responses were collected in this period.');
  if (s.eventCount && !s.capacity) gaps.push('Capacity was not recorded for these events, so an attendance rate is not given.');
  if (s.contract && !s.eventCount) gaps.push('No events are linked to this contract in this period.');
  if (s.unlinkedHours) gaps.push(s.unlinkedHours + ' volunteer hours in this period are not linked to an event.');
  return gaps;
}

// ── UI ─────────────────────────────────────────────────────
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

function paintContractOptions() {
  var sel = $('dr-contract');
  if (!sel) return;
  var cur = sel.value;
  sel.innerHTML = '<option value="">All activity (no funder filter)</option>' +
    (DB.contracts || []).map(function (c) {
      return '<option value="' + esc(String(c.id)) + '">' + esc(contractLabel(c)) + '</option>';
    }).join('');
  if (cur) sel.value = cur;
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
      'For workshops, volunteering and community delivery. Every figure is calculated from your records; ' +
      'the Org Brain writes the narrative around them. The report states what data is missing, so nothing is overclaimed.' +
    '</p>' +
    '<div class="form-grid-3">' +
      '<div class="form-row"><label>Funder / contract</label>' +
        '<select id="dr-contract"><option value="">All activity (no funder filter)</option></select>' +
      '</div>' +
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
  paintContractOptions();

  $('dr-period-type').addEventListener('change', function () {
    var t = this.value;
    ['year', 'quarter', 'month', 'from', 'to'].forEach(function (k) {
      var el = $('dr-' + k + '-wrap'); if (el) el.style.display = 'none';
    });
    if (t === 'year') $('dr-year-wrap').style.display = 'block';
    if (t === 'quarter') $('dr-quarter-wrap').style.display = 'block';
    if (t === 'month') $('dr-month-wrap').style.display = 'block';
    if (t === 'custom') { $('dr-from-wrap').style.display = 'block'; $('dr-to-wrap').style.display = 'block'; }
    renderPreview();
  });
  ['dr-contract', 'dr-year', 'dr-quarter', 'dr-month', 'dr-from', 'dr-to', 'dr-rate'].forEach(function (id) {
    var el = $(id); if (el) el.addEventListener('change', renderPreview);
  });
  $('dr-generate').addEventListener('click', generate);
  $('dr-refresh').addEventListener('click', renderPreview);

  renderPreview();
}

function renderPreview() {
  var el = $('dr-preview'); if (!el) return;
  var s = buildStats(currentPeriod());
  var gaps = gapsFor(s);

  el.innerHTML =
    (s.contract
      ? '<div style="font-size:12px;color:var(--em);font-weight:700;margin-bottom:8px">Filtered to: ' + esc(contractLabel(s.contract)) + '</div>'
      : '') +
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

// ── document tables ────────────────────────────────────────
function tableFrom(obj, label, total) {
  var keys = Object.keys(obj);
  if (!keys.length) return '';
  total = total || keys.reduce(function (a, k) { return a + obj[k]; }, 0);
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
    outEl.innerHTML = '<div class="alert alert-warn">There is no event, volunteer-hour or feedback data for this ' +
      (s.contract ? 'funder in this period.' : 'period.') + ' Choose a wider period, or link events to this contract.</div>';
    return;
  }

  outEl.innerHTML = '';
  progressEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  var orgName = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || 'Organisation';
  var todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  var gaps = gapsFor(s);
  var funderName = s.funder ? s.funder.name : (s.contract ? s.contract.name : '');

  var steps = [
    { label: 'Calculating figures', meta: s.eventCount + ' events · ' + s.sessionCount + ' hour entries · ' + s.fbCount + ' feedback' },
    { label: 'Checking data completeness', meta: gaps.length ? gaps.length + ' gap(s) to declare' : 'complete' },
    { label: 'Writing the narrative', meta: 'Org Brain composing from verified numbers' },
    { label: 'Quality check', meta: 'Tone, claims and structure' },
    { label: 'Ready', meta: 'Review and download below' }
  ];

  var sys = 'You are a professional UK charity impact writer producing a delivery report for a funder or board. ' +
    'Write clean formal British English. Structure with these sections, each beginning with ## and the section title: ' +
    'Executive Summary, Delivery Overview, Who We Reached, Volunteer Contribution, Participant Experience, Data Quality, Forward View. ' +
    'In Who We Reached, describe the people reached using only the demographic figures supplied, in plain respectful language, and say they are from optional anonymous answers. ' +
    'CRITICAL: use ONLY the figures supplied. Never invent, estimate, extrapolate or recalculate any number — ' +
    'every statistic has already been computed from the database. Do not add totals of your own. ' +
    'Quote the supplied numbers exactly as given. Use **bold** sparingly for headline figures. 600-800 words. ' +
    'If a funder is named, write the report as delivered under that funder\'s programme. ' +
    'In Data Quality, state the listed gaps plainly and without defensiveness. ' +
    'Do not use hashtags except as section markers, no horizontal rules, no emoji.';

  var lines = [
    'Organisation: ' + orgName,
    funderName ? 'Funder / programme: ' + funderName + (s.contract ? ' (' + s.contract.name + ')' : '') : 'Scope: all activity, not limited to one funder',
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
    'Volunteers active: ' + s.activeVolunteers + ' (of ' + s.totalVolunteers + ' registered)',
    'Total hours contributed: ' + s.totalHours,
    'Volunteer hours: ' + s.volHours + ' · staff hours: ' + s.staffHours,
    'Average hours per active volunteer: ' + s.avgPerVolunteer,
    'Notional value of volunteer time: ' + money(s.value) + ' (at £' + s.rate.toFixed(2) + '/hour, ' + RATE_LABEL + ')',
    '',
    'PARTICIPANT FEEDBACK',
    'Responses: ' + s.fbCount,
    s.fbCount && s.avgCB && s.avgCA ? 'Confidence before: ' + s.avgCB + ' → after: ' + s.avgCA + ' out of 5 (average gain ' + s.confGain + ')' : '',
    s.ownMeasures.length
      ? s.ownMeasures.map(function (m) { return '"' + m.q + '": ' + m.text + ' (' + m.n + ' answers)'; }).join('\n')
      : [s.fbCount && s.avgEnjoyed ? 'Average enjoyment: ' + s.avgEnjoyed + ' out of 5' : '',
         s.fbCount ? 'Learned something new: ' + s.learnedPct + '%' : '',
         s.fbCount ? 'Felt more connected: ' + s.connectedPct + '%' : '',
         s.fbCount ? 'Made a new friend: ' + s.friendPct + '%' : ''].filter(Boolean).join('\n'),
    s.ownMeasures.some(function (m) { return m.allYes; })
      ? 'Caveat: every answer to ' + s.ownMeasures.filter(function (m) { return m.allYes; }).map(function (m) { return '"' + m.q + '"'; }).join(' and ') + ' was "Yes" — the form may only have offered Yes; mention this and do not present those as evidence.' : '',
    '',
    'WHO WE REACHED (event attendees, from anonymous optional answers)',
    s.attDemo.count ? 'Responses with demographic data: ' + s.attDemo.count + ' of ' + s.fbCount : 'No attendee demographic data in this period.',
    s.attDemo.bemPct != null ? 'Black and ethnic minority: ' + s.attDemo.bemPct + '% (of ' + s.attDemo.ethN + ' who stated ethnicity)' : '',
    s.attDemo.disabledPct != null ? 'Disabled: ' + s.attDemo.disabledPct + '% (of ' + s.attDemo.disN + ' who answered)' : '',
    s.attDemo.topPostcodes.length ? 'Main postcode areas: ' + s.attDemo.topPostcodes.join(', ') + (s.attDemo.topPostcodePct != null ? ' (' + s.attDemo.topPostcodePct + '% from ' + s.attDemo.topPostcodes.slice(0, 2).join(' and ') + ')' : '') : '',
    Object.keys(s.attDemo.age).length ? 'Age groups: ' + Object.keys(s.attDemo.age).sort(function (a, b) { return s.attDemo.age[b] - s.attDemo.age[a]; }).map(function (k) { return k + ' ' + s.attDemo.age[k]; }).join(', ') : '',
    Object.keys(s.attDemo.gender).length ? 'Gender: ' + Object.keys(s.attDemo.gender).map(function (k) { return k + ' ' + s.attDemo.gender[k]; }).join(', ') : '',
    s.volDemo.count ? 'Volunteers with demographic data: ' + s.volDemo.count + (s.volDemo.bemPct != null ? ' · black and ethnic minority ' + s.volDemo.bemPct + '%' : '') + (s.volDemo.disabledPct != null ? ' · disabled ' + s.volDemo.disabledPct + '%' : '') : '',
    s.quotes.length ? 'Participant quotes you may use verbatim (do not alter):\n' + s.quotes.slice(0, 4).map(function (q) { return '- "' + q + '"'; }).join('\n') : '',
    '',
    'DATA QUALITY NOTES',
    gaps.length ? gaps.map(function (g) { return '- ' + g; }).join('\n') : '- No significant data gaps in this period.'
  ].filter(Boolean).join('\n');

  if (typeof runAgent !== 'function') {
    outEl.innerHTML = '<div class="alert alert-warn">The Org Brain agent is not available on this page.</div>';
    return;
  }

  runAgent({
    container: progressEl,
    headerLabel: 'Org Brain — Delivery Report',
    headerSub: funderName ? 'For ' + funderName : 'Figures calculated from your records',
    steps: steps,
    sys: sys,
    prompt: lines,
    maxTok: 1400
  }).then(function (raw) {
    if (!raw) return;
    renderDoc(raw, s, orgName, todayStr, funderName);
  });
}

function renderDoc(raw, s, orgName, todayStr, funderName) {
  var outEl = $('report-output');
  var cleaned = (typeof cleanReportText === 'function') ? cleanReportText(raw) : raw;
  var bodyHTML = (typeof reportTextToHTML === 'function') ? reportTextToHTML(cleaned, raw) : '<pre>' + esc(cleaned) + '</pre>';

  window._lastReportText = cleaned;
  window._lastReportTitle = orgName + ' — Delivery Report' + (funderName ? ' — ' + funderName : '') + ' (' + s.period.label + ')';

  var meta = 'Delivery &amp; Impact Report' + (funderName ? ' · ' + esc(funderName) : '') + ' · ' + esc(s.period.label);
  var logo = (typeof getOrgLogoUrl === 'function') ? getOrgLogoUrl(typeof currentOrg !== 'undefined' ? currentOrg : null) : '';
  var header = logo
    ? '<div class="report-header-flex"><div class="report-header-text">' +
        '<div class="report-meta">' + meta + '</div>' +
        '<div class="report-title">Events, Volunteering &amp; Participant Experience</div>' +
        '<div class="report-subtitle">' + esc(orgName) + ' · ' + esc(todayStr) + '</div>' +
      '</div><div class="report-header-logo"><img src="' + esc(logo) + '" alt="' + esc(orgName) + '" class="org-logo-report" onerror="this.style.display=\'none\'"/></div></div>'
    : '<div class="report-header">' +
        '<div class="report-meta">' + meta + '</div>' +
        '<div class="report-title">Events, Volunteering &amp; Participant Experience</div>' +
        '<div class="report-subtitle">' + esc(orgName) + ' · ' + esc(todayStr) + '</div>' +
      '</div>';

  var headline =
    '<div class="dr-figs">' +
      fig('Events delivered', s.eventCount) +
      fig('Total attendances', s.attendees) +
      fig('Active volunteers', s.activeVolunteers) +
      fig('Hours contributed', s.totalHours) +
      fig('Value of volunteer time', money(s.value)) +
      fig('Feedback responses', s.fbCount) +
    '</div>';

  function demoBlock(title, d, who) {
    if (!d.count) return '';
    var head = [];
    if (d.bemPct != null) head.push(d.bemPct + '% black and ethnic minority');
    if (d.disabledPct != null) head.push(d.disabledPct + '% disabled');
    if (d.topPostcodePct != null && d.topPostcodes.length) head.push(d.topPostcodePct + '% from ' + d.topPostcodes.slice(0, 2).join(' and '));
    return '<h3>' + esc(title) + '</h3>' +
      '<p style="font-size:12px;color:#666">Aggregate and anonymised. Based on the ' + d.count + ' ' + esc(who) + ' who chose to provide this information.' +
        (head.length ? ' <strong>' + esc(head.join(' · ')) + '</strong>.' : '') + '</p>' +
      tableFrom(d.age, 'Age group') +
      tableFrom(d.ethnicity, 'Ethnicity') +
      tableFrom(d.gender, 'Gender') +
      tableFrom(d.disability, 'Disability') +
      tableFrom(topN(d.postcode, 10), 'Postcode area');
  }
  function topN(obj, k) {
    var out = {};
    Object.keys(obj).sort(function (a, b) { return obj[b] - obj[a]; }).slice(0, k).forEach(function (x) { out[x] = obj[x]; });
    return out;
  }
  var demographics =
    demoBlock('Who we reached — event attendees', s.attDemo, 'feedback responses') +
    demoBlock('Volunteer demographics', s.volDemo, 'active volunteers');

  var appendix =
    '<h3>Appendix A — Events delivered</h3>' + (eventTable(s) || '<p>No events in this period.</p>') +
    '<h3>Appendix B — Volunteer hours by month</h3>' + (monthTable(s.byMonth) || '<p>No hours logged in this period.</p>') +
    (Object.keys(s.byType).length ? '<h3>Appendix C — Events by type</h3>' + tableFrom(s.byType, 'Type', s.eventCount) : '') +
    demographics +
    '<p style="font-size:11px;color:#777;margin-top:18px">Volunteer time valued at £' + s.rate.toFixed(2) + ' per hour — ' + esc(RATE_LABEL) + '. ' +
      'All figures calculated directly from records held in Vorlana for the period stated' + (funderName ? ', limited to events linked to ' + esc(funderName) : '') + '.</p>';

  outEl.innerHTML =
    '<style>' +
      '.dr-figs{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0 24px}' +
      '.dr-fig{border:1px solid #ddd;border-radius:8px;padding:12px;text-align:center}' +
      '.dr-fig-v{font-size:24px;font-weight:800;color:#1F6F6D}' +
      '.dr-fig-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#777;font-weight:700;margin-top:2px}' +
      '.dr-tbl{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:13px}' +
      '.dr-tbl th{text-align:left;border-bottom:2px solid #ccc;padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#555}' +
      '.dr-tbl td{border-bottom:1px solid #eee;padding:6px 8px}' +
      '@media print{.dr-tbl{page-break-inside:avoid}}' +
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
  if (rg) rg.addEventListener('click', generate);

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
  var orig = window.renderReports;
  if (typeof orig === 'function' && !orig._dr) {
    window.renderReports = function () {
      var r = orig.apply(this, arguments);
      try { injectUI(); paintContractOptions(); renderPreview(); } catch (e) {}
      return r;
    };
    window.renderReports._dr = true;
  }
  var page = $('page-reports');
  if (page && page.classList.contains('active')) { try { injectUI(); } catch (e) {} }
  console.log('[delivery-report ' + VERSION + '] ready');
});

})();
