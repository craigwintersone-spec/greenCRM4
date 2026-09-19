// js/extensions/event-contracts.js  — v1.0
// ─────────────────────────────────────────────────────────────
// Links EVENTS to CONTRACTS, then lets you report by funder.
//
//   1. Contract tick-boxes on the Create/Edit event modal, saved
//      to events.contract_ids (jsonb) — same pattern as participants.
//   2. A funder/contract filter on the Delivery Report, so you can
//      produce "PECT nature workshops, Q2" rather than everything.
//   3. A per-event report: one workshop, its volunteers, hours,
//      attendance and feedback — for funders who want the detail.
//
// Events without a contract still appear in the unfiltered report,
// so nothing is lost by not linking them.
//
// Depends on: db.js, agents.js (runAgent, cleanReportText,
//   reportTextToHTML, getOrgLogoUrl), delivery-report.js
// Load AFTER delivery-report.js.
'use strict';

(function () {

var VERSION = 'v1.0';

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function n(v) { return isNaN(+v) ? 0 : +v; }
function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }
function round1(v) { return Math.round(v * 10) / 10; }
function fmtD(d) {
  return d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
}
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

// ── contract helpers ───────────────────────────────────────
function contractsList() { return DB.contracts || []; }
function funderFor(contract) {
  if (!contract || !contract.funder_id) return null;
  return byIdIn(DB.funders || [], contract.funder_id);
}
function contractLabel(c) {
  var f = funderFor(c);
  return (c.name || 'Unnamed contract') + (f ? ' · ' + f.name : '');
}
function eventContracts(ev) { return toArrSafe(ev && ev.contract_ids); }
function eventHasContract(ev, contractId) {
  if (!contractId) return true;
  return eventContracts(ev).map(String).indexOf(String(contractId)) !== -1;
}

// ── 1. contract tick-boxes on the event modal ──────────────
function injectEventContractPicker() {
  var modal = $('modal-ev');
  if (!modal || modal.querySelector('[data-ev-contracts]')) return;
  var footer = modal.querySelector('.modal-footer');
  if (!footer) return;

  var wrap = document.createElement('div');
  wrap.setAttribute('data-ev-contracts', '1');
  wrap.className = 'form-row';
  wrap.innerHTML =
    '<label>Link to contract / funder</label>' +
    '<div class="con-select" id="ev-contracts-list"></div>' +
    '<div style="font-size:11px;color:var(--txt3);margin-top:4px">Optional. Linking lets you report on this funder\u2019s events separately.</div>';
  footer.parentNode.insertBefore(wrap, footer);
}

function paintEventContracts(selected) {
  var el = $('ev-contracts-list');
  if (!el) return;
  var sel = (selected || []).map(String);
  var list = contractsList();
  if (!list.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--txt3);padding:6px">No contracts yet — add one under Contracts to report by funder.</div>';
    return;
  }
  el.innerHTML = list.map(function (c) {
    var on = sel.indexOf(String(c.id)) !== -1;
    return '<div class="chk-pill"><label><input type="checkbox" class="ev-con-chk" value="' + esc(String(c.id)) + '"' +
           (on ? ' checked' : '') + '/> ' + esc(contractLabel(c)) + '</label></div>';
  }).join('');
}

function readEventContracts() {
  var out = [];
  document.querySelectorAll('.ev-con-chk').forEach(function (cb) { if (cb.checked) out.push(cb.value); });
  return out;
}

// wrap the event modal open/save handlers
function wrapEventModal() {
  var origAdd = window.openAddEv;
  if (typeof origAdd === 'function' && !origAdd._evCon) {
    window.openAddEv = function () {
      var r = origAdd.apply(this, arguments);
      injectEventContractPicker();
      paintEventContracts([]);
      return r;
    };
    window.openAddEv._evCon = true;
  }

  var origEdit = window.openEditEv;
  if (typeof origEdit === 'function' && !origEdit._evCon) {
    window.openEditEv = function (id) {
      var ev = byIdIn(DB.events, id);
      var r = origEdit.call(this, ev ? ev.id : id);
      injectEventContractPicker();
      paintEventContracts(eventContracts(ev));
      return r;
    };
    window.openEditEv._evCon = true;
  }

  var origSave = window.saveEv;
  if (typeof origSave === 'function' && !origSave._evCon) {
    window.saveEv = function () {
      var picked = readEventContracts();
      var oInsert = window.sbInsert, oUpdate = window.sbUpdate;
      window.sbInsert = function (table, payload) {
        if (table === 'events') payload.contract_ids = picked;
        return oInsert(table, payload);
      };
      window.sbUpdate = function (table, payload, id) {
        if (table === 'events') payload.contract_ids = picked;
        return oUpdate(table, payload, id);
      };
      var done = function () { window.sbInsert = oInsert; window.sbUpdate = oUpdate; };
      var r;
      try { r = origSave.apply(this, arguments); } catch (e) { done(); throw e; }
      if (r && typeof r.then === 'function') r.then(done, done); else setTimeout(done, 2500);
      return r;
    };
    window.saveEv._evCon = true;
  }
}

// carry contract_ids through the events mapper (db.js drops unknown columns)
function patchEventMapper() {
  if (typeof MAPPERS === 'undefined' || !MAPPERS.events || MAPPERS._evConPatched) return;
  var orig = MAPPERS.events;
  MAPPERS.events = function (r) {
    var o = orig(r);
    o.contract_ids = toArrSafe(r.contract_ids);
    return o;
  };
  MAPPERS._evConPatched = true;
}

// ── 2. contract filter on the Delivery Report ──────────────
function injectReportFilter() {
  var panel = $('dr-panel');
  if (!panel || $('dr-contract-wrap')) return;
  var grid = panel.querySelector('.form-grid-3');
  if (!grid) return;

  var row = document.createElement('div');
  row.className = 'form-row';
  row.id = 'dr-contract-wrap';
  row.innerHTML =
    '<label>Funder / contract</label>' +
    '<select id="dr-contract"><option value="">All activity (no filter)</option></select>' +
    '<div style="font-size:11px;color:var(--txt3);margin-top:4px">Reports only on events linked to this contract.</div>';
  grid.appendChild(row);

  paintContractOptions();
  $('dr-contract').addEventListener('change', function () {
    if (typeof window._drRenderPreview === 'function') window._drRenderPreview();
  });
}

function paintContractOptions() {
  var sel = $('dr-contract');
  if (!sel) return;
  var cur = sel.value;
  sel.innerHTML = '<option value="">All activity (no filter)</option>' +
    contractsList().map(function (c) {
      return '<option value="' + esc(String(c.id)) + '">' + esc(contractLabel(c)) + '</option>';
    }).join('');
  if (cur) sel.value = cur;
}

// Filter DB.events down to one contract while the report runs,
// then put it back. Keeps delivery-report.js untouched.
function withContractFilter(fn) {
  var sel = $('dr-contract');
  var cid = sel ? sel.value : '';
  if (!cid) return fn();

  var all = DB.events || [];
  var kept = all.filter(function (e) { return eventHasContract(e, cid); });
  var keptIds = {};
  kept.forEach(function (e) { keptIds[String(e.id)] = 1; });

  var allHours = DB.volunteer_hours || [];
  var allFb = DB.feedback || [];

  DB.events = kept;
  DB.volunteer_hours = allHours.filter(function (h) { return h.event_id && keptIds[String(h.event_id)]; });
  DB.feedback = allFb.filter(function (f) { return keptIds[String(f.eventId || f.event_id)]; });

  try {
    return fn();
  } finally {
    DB.events = all;
    DB.volunteer_hours = allHours;
    DB.feedback = allFb;
  }
}

function wrapDeliveryReport() {
  // preview
  var origPrev = window._drRenderPreview;
  if (typeof origPrev === 'function' && !origPrev._evCon) {
    window._drRenderPreview = function () {
      var self = this, args = arguments;
      return withContractFilter(function () { return origPrev.apply(self, args); });
    };
    window._drRenderPreview._evCon = true;
  }
  // generate
  var origGen = window._drGenerate;
  if (typeof origGen === 'function' && !origGen._evCon) {
    window._drGenerate = function () {
      var self = this, args = arguments;
      return withContractFilter(function () { return origGen.apply(self, args); });
    };
    window._drGenerate._evCon = true;
  }
}

// ── 3. per-event report ────────────────────────────────────
function eventStats(ev) {
  var hours = (DB.volunteer_hours || []).filter(function (h) { return String(h.event_id) === String(ev.id); });
  var volIds = {};
  hours.forEach(function (h) { volIds[String(h.volunteer_id)] = 1; });
  var vols = (DB.volunteers || []).filter(function (v) { return volIds[String(v.id)]; });
  var fb = (DB.feedback || []).filter(function (f) { return String(f.eventId || f.event_id) === String(ev.id); });

  var totalHours = hours.reduce(function (a, h) { return a + n(h.hours); }, 0);
  var rate = parseFloat($('dr-rate') && $('dr-rate').value) || 12.60;

  var cons = eventContracts(ev).map(function (id) { return byIdIn(contractsList(), id); }).filter(Boolean);

  return {
    ev: ev,
    contracts: cons,
    hours: hours,
    volunteers: vols,
    totalHours: round1(totalHours),
    value: totalHours * rate,
    rate: rate,
    attendees: n(ev.attendees),
    capacity: n(ev.capacity),
    fill: n(ev.capacity) ? pct(n(ev.attendees), n(ev.capacity)) : null,
    fb: fb,
    fbCount: fb.length,
    avgEnjoyed: fb.length ? round1(fb.reduce(function (a, f) { return a + n(f.enjoyed); }, 0) / fb.length) : 0,
    avgCB: fb.length ? round1(fb.reduce(function (a, f) { return a + n(f.cb); }, 0) / fb.length) : 0,
    avgCA: fb.length ? round1(fb.reduce(function (a, f) { return a + n(f.ca); }, 0) / fb.length) : 0,
    learnedPct: fb.length ? pct(fb.filter(function (f) { return f.learned; }).length, fb.length) : 0,
    connectedPct: fb.length ? pct(fb.filter(function (f) { return f.connected; }).length, fb.length) : 0,
    quotes: fb.filter(function (f) { return f.quote && String(f.quote).trim().length > 15; })
              .map(function (f) { return String(f.quote).trim(); })
  };
}

window.openEventReport = function (eventId) {
  var ev = byIdIn(DB.events, eventId);
  if (!ev) return;
  if (typeof go === 'function') go('reports');
  setTimeout(function () { runEventReport(ev); }, 350);
};

function runEventReport(ev) {
  var progressEl = $('brain-progress');
  var outEl = $('report-output');
  if (!progressEl || !outEl) return;
  outEl.innerHTML = '';
  progressEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  var s = eventStats(ev);
  var orgName = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || 'Organisation';
  var todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  var funderNames = s.contracts.map(function (c) { var f = funderFor(c); return f ? f.name : c.name; }).join(', ');

  var gaps = [];
  if (!s.fbCount) gaps.push('No feedback was collected for this session.');
  if (!s.hours.length) gaps.push('No volunteer hours were logged against this session.');
  if (!s.capacity) gaps.push('Capacity was not recorded, so an attendance rate is not given.');

  var steps = [
    { label: 'Reading the session record', meta: ev.name },
    { label: 'Gathering volunteers and feedback', meta: s.volunteers.length + ' volunteers · ' + s.fbCount + ' responses' },
    { label: 'Writing the report', meta: 'Org Brain composing from verified figures' },
    { label: 'Ready', meta: '' }
  ];

  var sys = 'You are a UK charity impact writer producing a short report on ONE delivered session for a funder. ' +
    'Structure with these sections, each beginning with ## and the title: Session Overview, Delivery, Participant Experience, Notes. ' +
    'CRITICAL: use ONLY the figures supplied — never invent, estimate or recalculate anything. ' +
    'Keep it to 300-450 words. Clean formal British English. **bold** for headline figures. ' +
    'State any listed data gaps plainly in Notes. No hashtags except section markers, no emoji.';

  var prompt = [
    'Organisation: ' + orgName,
    'Session: ' + (ev.name || 'Event'),
    'Date: ' + (ev.date ? new Date(ev.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : 'not recorded'),
    'Type: ' + (ev.type || 'not recorded'),
    'Location: ' + (ev.location || 'not recorded'),
    funderNames ? 'Delivered under: ' + funderNames : 'Not linked to a funder contract',
    '',
    'Attendances: ' + s.attendees,
    s.capacity ? 'Capacity: ' + s.capacity + ' (' + s.fill + '% filled)' : '',
    'Volunteers involved: ' + s.volunteers.length,
    'Volunteer hours: ' + s.totalHours,
    'Notional value of volunteer time: £' + Math.round(s.value).toLocaleString('en-GB') + ' (at £' + s.rate.toFixed(2) + '/hour)',
    '',
    s.fbCount ? 'Feedback responses: ' + s.fbCount : 'Feedback responses: none',
    s.fbCount ? 'Average enjoyment: ' + s.avgEnjoyed + ' out of 5' : '',
    s.fbCount ? 'Confidence before: ' + s.avgCB + ' → after: ' + s.avgCA : '',
    s.fbCount ? 'Learned something new: ' + s.learnedPct + '%' : '',
    s.fbCount ? 'Felt more connected: ' + s.connectedPct + '%' : '',
    s.quotes.length ? 'Quotes you may use verbatim (do not alter):\n' + s.quotes.slice(0, 3).map(function (q) { return '- "' + q + '"'; }).join('\n') : '',
    '',
    'DATA GAPS',
    gaps.length ? gaps.map(function (g) { return '- ' + g; }).join('\n') : '- None.'
  ].filter(Boolean).join('\n');

  if (typeof runAgent !== 'function') {
    outEl.innerHTML = '<div class="alert alert-warn">The Org Brain agent is not available.</div>';
    return;
  }

  runAgent({
    container: progressEl,
    headerLabel: 'Org Brain — Session Report',
    headerSub: ev.name,
    steps: steps, sys: sys, prompt: prompt, maxTok: 900
  }).then(function (raw) {
    if (!raw) return;
    renderEventDoc(raw, s, orgName, todayStr, funderNames);
  });
}

function renderEventDoc(raw, s, orgName, todayStr, funderNames) {
  var outEl = $('report-output');
  var cleaned = (typeof cleanReportText === 'function') ? cleanReportText(raw) : raw;
  var body = (typeof reportTextToHTML === 'function') ? reportTextToHTML(cleaned, raw) : '<pre>' + esc(cleaned) + '</pre>';

  window._lastReportText = cleaned;
  window._lastReportTitle = (s.ev.name || 'Session') + ' — ' + orgName;

  var logo = (typeof getOrgLogoUrl === 'function') ? getOrgLogoUrl(typeof currentOrg !== 'undefined' ? currentOrg : null) : '';
  var header = logo
    ? '<div class="report-header-flex"><div class="report-header-text">' +
        '<div class="report-meta">Session Report' + (funderNames ? ' · ' + esc(funderNames) : '') + '</div>' +
        '<div class="report-title">' + esc(s.ev.name || 'Session') + '</div>' +
        '<div class="report-subtitle">' + esc(orgName) + ' · ' + esc(todayStr) + '</div>' +
      '</div><div class="report-header-logo"><img src="' + esc(logo) + '" alt="" class="org-logo-report" onerror="this.style.display=\'none\'"/></div></div>'
    : '<div class="report-header">' +
        '<div class="report-meta">Session Report' + (funderNames ? ' · ' + esc(funderNames) : '') + '</div>' +
        '<div class="report-title">' + esc(s.ev.name || 'Session') + '</div>' +
        '<div class="report-subtitle">' + esc(orgName) + ' · ' + esc(todayStr) + '</div>' +
      '</div>';

  var figs =
    '<div class="dr-figs">' +
      f('Attendances', s.attendees) +
      f('Volunteers', s.volunteers.length) +
      f('Volunteer hours', s.totalHours) +
      (s.fill != null ? f('Capacity filled', s.fill + '%') : '') +
      f('Value of time', '£' + Math.round(s.value).toLocaleString('en-GB')) +
      f('Feedback', s.fbCount) +
    '</div>';

  var volTable = s.hours.length
    ? '<h3>Volunteers on this session</h3><table class="dr-tbl"><thead><tr><th>Volunteer</th><th>Role</th><th>Hours</th><th>Activity</th></tr></thead><tbody>' +
      s.hours.map(function (h) {
        var v = byIdIn(DB.volunteers, h.volunteer_id);
        return '<tr><td>' + esc(v ? v.name : 'Unknown') + '</td><td>' + esc(v ? (v.role || 'Volunteer') : '—') + '</td>' +
               '<td>' + n(h.hours) + '</td><td>' + esc(h.activity || '—') + '</td></tr>';
      }).join('') + '</tbody></table>'
    : '';

  var quoteBlock = s.quotes.length
    ? '<h3>In their words</h3>' + s.quotes.slice(0, 5).map(function (q) {
        return '<blockquote style="border-left:3px solid #1F6F6D;margin:10px 0;padding:6px 14px;color:#444;font-style:italic">' + esc(q) + '</blockquote>';
      }).join('')
    : '';

  outEl.innerHTML =
    '<style>' +
      '.dr-figs{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:18px 0 24px}' +
      '.dr-fig{border:1px solid #ddd;border-radius:8px;padding:12px;text-align:center}' +
      '.dr-fig-v{font-size:24px;font-weight:800;color:#1F6F6D}' +
      '.dr-fig-l{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#777;font-weight:700;margin-top:2px}' +
      '.dr-tbl{width:100%;border-collapse:collapse;margin:10px 0 18px;font-size:13px}' +
      '.dr-tbl th{text-align:left;border-bottom:2px solid #ccc;padding:6px 8px;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:#555}' +
      '.dr-tbl td{border-bottom:1px solid #eee;padding:6px 8px}' +
    '</style>' +
    '<div class="report-actions">' +
      '<button class="btn btn-p" onclick="downloadReportPDF()">⬇ Download as PDF</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="copyReportText()" id="copy-report-btn">📋 Copy text</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="openEventReport(\'' + esc(String(s.ev.id)) + '\')">↻ Regenerate</button>' +
    '</div>' +
    '<div class="report-doc">' + header +
      '<div class="report-body">' + figs + body + volTable + quoteBlock +
        '<p style="font-size:11px;color:#777;margin-top:18px">Volunteer time valued at £' + s.rate.toFixed(2) + ' per hour. All figures calculated directly from records held in Vorlana.</p>' +
      '</div>' +
      '<div class="report-footer">Generated by Vorlana · ' + esc(todayStr) + '</div>' +
    '</div>';

  outEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function f(label, val) {
  return '<div class="dr-fig"><div class="dr-fig-v">' + esc(String(val)) + '</div><div class="dr-fig-l">' + esc(label) + '</div></div>';
}

// ── report button + funder column on the Events page ───────
function wrapRenderEvents() {
  var orig = window.renderEvents;
  if (typeof orig !== 'function' || orig._evCon) return;
  window.renderEvents = function () {
    var r = orig.apply(this, arguments);
    try {
      var tbl = document.querySelector('#ev-list table');
      if (!tbl) return r;

      var head = tbl.querySelector('thead tr');
      if (head && !head.querySelector('[data-con-col]')) {
        var th = document.createElement('th');
        th.setAttribute('data-con-col', '1');
        th.textContent = 'Funder';
        head.insertBefore(th, head.lastElementChild);
      }

      tbl.querySelectorAll('tbody tr').forEach(function (tr) {
        var edit = tr.querySelector('button[onclick^="openEditEv"]');
        if (!edit) return;
        var m = /openEditEv\('([^']+)'\)/.exec(edit.getAttribute('onclick') || '');
        if (!m) return;
        var ev = byIdIn(DB.events, m[1]);

        if (!tr.querySelector('[data-con-col]')) {
          var cons = eventContracts(ev).map(function (id) { return byIdIn(contractsList(), id); }).filter(Boolean);
          var td = document.createElement('td');
          td.setAttribute('data-con-col', '1');
          td.style.fontSize = '11px';
          td.innerHTML = cons.length
            ? cons.map(function (c) { var fd = funderFor(c); return esc(fd ? fd.name : c.name); }).join('<br/>')
            : '<span style="color:var(--txt3)">—</span>';
          tr.insertBefore(td, tr.lastElementChild);
        }

        var row = edit.parentNode;
        if (row && !row.querySelector('.ev-rep-btn')) {
          var b = document.createElement('button');
          b.className = 'btn btn-ghost btn-sm ev-rep-btn';
          b.textContent = '📄 Report';
          b.title = 'Generate a funder report for this session';
          b.setAttribute('onclick', "openEventReport('" + m[1] + "')");
          row.insertBefore(b, edit);
          row.insertBefore(document.createTextNode(' '), edit);
        }
      });
    } catch (e) { /* never break the page */ }
    return r;
  };
  window.renderEvents._evCon = true;
}

// ── init ───────────────────────────────────────────────────
function whenReady(fn) {
  if (typeof DB !== 'undefined' && typeof renderEvents === 'function') return setTimeout(fn, 400);
  setTimeout(function () { whenReady(fn); }, 150);
}

whenReady(function () {
  patchEventMapper();
  wrapEventModal();
  wrapRenderEvents();
  wrapDeliveryReport();

  // add the filter when the Reports page renders
  var origRep = window.renderReports;
  if (typeof origRep === 'function' && !origRep._evCon) {
    window.renderReports = function () {
      var r = origRep.apply(this, arguments);
      try { injectReportFilter(); paintContractOptions(); } catch (e) {}
      return r;
    };
    window.renderReports._evCon = true;
  }

  if (typeof refreshTable === 'function') {
    try {
      refreshTable('events').then(function () {
        var p = $('page-events');
        if (p && p.classList.contains('active')) renderEvents();
      });
    } catch (e) {}
  }

  var rp = $('page-reports');
  if (rp && rp.classList.contains('active')) { try { injectReportFilter(); } catch (e) {} }

  console.log('[event-contracts ' + VERSION + '] ready');
});

})();
