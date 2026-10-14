// js/extensions/zero-touch.js — funder reports that write themselves
// 1. The daily job emails managers one link when a reporting period ends. Opening that link lands here,
//    sets the period, and the report is generated with no clicks: read it, download it, send it.
// 2. On the Reports page each contract shows when its next report comes, with one dropdown to change how often.
// Depends on: router.js (go), render.js (renderReports), reporting-periods.js (the period picker), agents.js (generateAIReport)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s); };
  var MONTHS = { month: 1, quarter: 3, half: 6, year: 12 };
  var LABEL = { month: 'Every month', quarter: 'Every quarter', half: 'Every 6 months', year: 'Every year', off: 'No report needed' };
  var day = function (d) { return new Date(d).toISOString().slice(0, 10); };
  var addMonths = function (d, n) { var x = new Date(d); x.setUTCMonth(x.getUTCMonth() + n); return x; };
  var fmt = function (d) { return new Date(d + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); };

  // the period the next report covers, and when the email will come (the same rules as the daily job)
  function nextReport(c) {
    var every = c.report_every || 'quarter', n = MONTHS[every]; if (!n) return null;
    var today = new Date(), start = c.start_date ? new Date(c.start_date + 'T00:00:00Z') : new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    if (isNaN(start)) return null;
    var from = start, to = new Date(addMonths(start, n).getTime() - 864e5);
    while (to.getTime() < today.getTime() - 7 * 864e5) { from = addMonths(from, n); to = new Date(addMonths(from, n).getTime() - 864e5); }
    if (c.end_date && day(from) > c.end_date) return null;
    return { from: day(from), to: day(to), emailOn: day(new Date(to.getTime() - 6 * 864e5)) };
  }

  // ── the Reports page: next report, and how often ──
  function decorate() {
    var el = $('reports-contract-list'); if (!el || !(DB.contracts || []).length) return;
    var rows = el.querySelectorAll('.card > div[style*="justify-content:space-between"]');
    (DB.contracts || []).forEach(function (c, i) {
      var row = rows[i]; if (!row || row.querySelector('.zt-line')) return;
      var p = nextReport(c), every = c.report_every || 'quarter';
      var line = document.createElement('div'); line.className = 'zt-line';
      line.style.cssText = 'font-size:11px;color:var(--txt3);margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap';
      line.innerHTML = (every === 'off' ? '<span>No report needed</span>' : p ? '<span>Next: <b>' + esc(fmt(p.from)) + ' to ' + esc(fmt(p.to)) + '</b>, written for you and emailed on ' + esc(fmt(p.emailOn)) + '</span>' : '<span>No more reports: contract has ended</span>') +
        '<select style="width:auto;font-size:11px;padding:2px 6px" title="How often does this funder want a report?" onchange="ztSetEvery(\'' + esc(String(c.id)) + '\',this.value)">' +
        Object.keys(LABEL).map(function (k) { return '<option value="' + k + '"' + (k === every ? ' selected' : '') + '>' + LABEL[k] + '</option>'; }).join('') + '</select>';
      var left = row.firstElementChild; if (left) left.appendChild(line);
    });
    if (!$('zt-note')) {
      var n = document.createElement('div'); n.id = 'zt-note'; n.className = 'cxp-s';
      n.style.cssText = 'font-size:12px;color:var(--txt3);margin:-6px 0 14px';
      n.textContent = 'When a reporting period ends, your managers get one email. Opening it writes the report. Nothing to remember.';
      el.insertAdjacentElement('afterbegin', n);
    }
  }
  window.ztSetEvery = async function (id, v) {
    var c = (DB.contracts || []).find(function (x) { return String(x.id) === String(id); }); if (!c) return;
    var r = await sb.from('contracts').update({ report_every: v }).eq('id', c.id);
    if (r && r.error) { alert('Couldn\u2019t save: ' + (/report_every/.test(r.error.message || '') ? 'run report-schedule.sql in Supabase first.' : r.error.message)); return; }
    c.report_every = v; if (typeof renderReports === 'function') renderReports();
  };

  // ── the emailed link: write the report, no clicks ──
  function fromLink() {
    var m = (location.hash || '').match(/^#reports\?(.+)$/i); if (!m) return null;
    var q = {}; m[1].split('&').forEach(function (kv) { var p = kv.split('='); q[decodeURIComponent(p[0])] = decodeURIComponent(p[1] || ''); });
    return q.contract && q.from && q.to ? q : null;
  }
  var _running = false;
  function wait(test, ms) { return new Promise(function (res) { var t = 0; (function tick() { if (test()) return res(true); if ((t += 100) > ms) return res(false); setTimeout(tick, 100); })(); }); }
  async function runFromLink() {
    var q = fromLink(); if (!q || _running) return; _running = true;
    try {
      history.replaceState(null, '', location.pathname);                                   // one run per link
      if (typeof go === 'function') go('reports');
      await wait(function () { return $('civara-period-type') && (DB.contracts || []).length && typeof generateAIReport === 'function'; }, 15000);
      var c = (DB.contracts || []).find(function (x) { return String(x.id) === String(q.contract); });
      if (!c || !$('civara-period-type')) return;
      $('civara-period-type').value = 'custom'; $('civara-period-type').dispatchEvent(new Event('change'));
      $('civara-period-from').value = q.from; $('civara-period-to').value = q.to;
      ['civara-period-from', 'civara-period-to'].forEach(function (id) { $(id).dispatchEvent(new Event('change')); });
      var out = $('report-output');
      if (out) out.insertAdjacentHTML('beforebegin', '<div id="zt-banner" class="alert alert-ok" style="margin:0 0 12px;font-size:13px">\u270E Writing your <b>' + esc(c.funder || c.name) + '</b> report for ' + esc(fmt(q.from)) + ' to ' + esc(fmt(q.to)) + '. Read it, then download or send it. Nothing to edit.</div>');
      await generateAIReport(c.report_type || 'other', String(c.id));
      var b = $('zt-banner'); if (b) b.innerHTML = '\u2713 Your <b>' + esc(c.funder || c.name) + '</b> report for ' + esc(fmt(q.from)) + ' to ' + esc(fmt(q.to)) + ' is written. Read it, then download or send it.';
    } catch (e) { console.warn('[zero-touch]', e); } finally { _running = false; }
  }

  function ready(fn) { var t = 0; (function w() { if (typeof renderReports === 'function' && typeof go === 'function') return fn(); if (++t < 100) setTimeout(w, 100); })(); }
  ready(function () {
    var orig = window.renderReports;
    window.renderReports = function () { orig.apply(this, arguments); try { decorate(); } catch (e) { console.warn('[zero-touch] decorate:', e); } };
    window.addEventListener('hashchange', runFromLink);
    var tries = 0; (function boot() { if ((DB.contracts || []).length || typeof currentOrg !== 'undefined' && currentOrg && currentOrg.id) return runFromLink(); if (++tries < 150) setTimeout(boot, 200); })();
  });
  if (window.__VORLANA_TEST) window.__ztTest = { nextReport: nextReport, fromLink: fromLink, runFromLink: runFromLink };
})();
