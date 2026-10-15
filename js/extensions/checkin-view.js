// js/extensions/checkin-view.js — see what people answered at check-in, per event
// Adds a "Checked in" column on the Events page. Click it for a summary: for every question on that event's form,
// how many people gave each answer, plus the raw list and a CSV for just that event. Reads the checkins table; writes nothing.
// Depends on: render.js (renderEvents), settings.js (setModal, setCloseModal)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s); };
  var TXT = 'text-transform:none;letter-spacing:0';
  var COUNTS = {}, loaded = false, loading = null;

  async function load() {
    if (loading) return loading;
    loading = (async function () {
      try {
        var r = await sb.from('checkins').select('event_id,people').eq('org_id', String(orgId)).limit(20000);
        if (r.error) throw r.error;
        COUNTS = {}; (r.data || []).forEach(function (c) { var k = String(c.event_id); COUNTS[k] = COUNTS[k] || { rows: 0, people: 0 }; COUNTS[k].rows++; COUNTS[k].people += (+c.people || 1); });
        loaded = true;
      } catch (e) { loaded = false; }
      loading = null;
    })();
    return loading;
  }
  function paint() {
    var tbl = document.querySelector('#ev-list table'); if (!tbl) return;
    var head = tbl.querySelector('thead tr'); if (!head || head.querySelector('.civ-th')) return;
    var ths = head.querySelectorAll('th'); var at = ths[3];                       // after Attendees
    var th = document.createElement('th'); th.className = 'civ-th'; th.textContent = 'Checked in'; th.style.textAlign = 'center'; at.insertAdjacentElement('afterend', th);
    tbl.querySelectorAll('tbody tr').forEach(function (tr) {
      var edit = tr.querySelector('button[onclick^="openEditEv"]'); if (!edit) return;
      var m = /openEditEv\('([^']+)'\)/.exec(edit.getAttribute('onclick') || ''); if (!m) return;
      var c = COUNTS[m[1]], td = document.createElement('td'); td.style.textAlign = 'center';
      td.innerHTML = c ? '<a href="#" onclick="civOpen(\'' + esc(m[1]) + '\');return false" title="See what people answered" style="font-weight:600">' + c.people + '</a>' : '<span style="color:var(--txt3)">\u2014</span>';
      tr.children[3].insertAdjacentElement('afterend', td);
    });
  }

  // ── the summary for one event ──
  function tally(rows) {
    var qs = [], by = {};
    rows.forEach(function (r) {
      Object.keys(r.answers || {}).forEach(function (q) {
        if (!by[q]) { by[q] = { counts: {}, n: 0, text: [] }; qs.push(q); }
        var v = r.answers[q], b = by[q]; b.n++;
        (Array.isArray(v) ? v : [v]).forEach(function (a) {
          var s = String(a == null ? '' : a).trim(); if (!s) return;
          if (/^Other: /.test(s)) { s = 'Other'; b.text.push(String(a).replace(/^Other: /, '')); }
          b.counts[s] = (b.counts[s] || 0) + 1;
        });
      });
    });
    return qs.map(function (q) { return { q: q, n: by[q].n, counts: by[q].counts, text: by[q].text }; });
  }
  function isFreeText(t) { return Object.keys(t.counts).length > 12 && Object.keys(t.counts).length > t.n * 0.6; }
  function summaryHTML(ev, rows) {
    var people = rows.reduce(function (a, r) { return a + (+r.people || 1); }, 0), days = {};
    rows.forEach(function (r) { days[r.day] = 1; });
    var t = tally(rows);
    var h = '<h2>' + esc(ev.name) + '</h2><div style="font-size:13px;color:var(--txt3);margin:-6px 0 12px;' + TXT + '">' + esc(ev.date ? fmtD(ev.date) : '') + (ev.location ? ' \u00b7 ' + esc(ev.location) : '') + ' \u00b7 <b style="color:var(--txt)">' + people + ' people</b> from ' + rows.length + ' check-in' + (rows.length === 1 ? '' : 's') + (Object.keys(days).length > 1 ? ' over ' + Object.keys(days).length + ' days' : '') + '</div>' +
      '<div style="max-height:60vh;overflow:auto;padding-right:4px">';
    t.forEach(function (x) {
      h += '<div style="margin-bottom:14px"><div style="font-size:13px;font-weight:600;color:var(--txt);' + TXT + '">' + esc(x.q) + ' <span style="font-weight:400;color:var(--txt3)">\u00b7 ' + x.n + ' answered</span></div>';
      if (isFreeText(x)) { h += '<div style="font-size:12px;color:var(--txt2);' + TXT + '">' + Object.keys(x.counts).slice(0, 30).map(esc).join(' \u00b7 ') + (Object.keys(x.counts).length > 30 ? ' \u2026' : '') + '</div>'; }
      else {
        var keys = Object.keys(x.counts).sort(function (a, b) { return x.counts[b] - x.counts[a]; }), max = Math.max.apply(null, keys.map(function (k) { return x.counts[k]; }).concat([1]));
        keys.forEach(function (k) {
          var n = x.counts[k], pct = x.n ? Math.round(n / x.n * 100) : 0;
          h += '<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin:3px 0;' + TXT + '"><span style="flex:0 0 46%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(k) + '">' + esc(k) + '</span>' +
            '<span style="flex:1;height:8px;background:var(--bg);border-radius:4px;overflow:hidden"><span style="display:block;width:' + Math.round(n / max * 100) + '%;height:8px;background:var(--em)"></span></span><span style="flex:0 0 70px;text-align:right;color:var(--txt2)">' + n + ' \u00b7 ' + pct + '%</span></div>';
        });
        if (x.text.length) h += '<div style="font-size:11px;color:var(--txt3);margin-top:3px;' + TXT + '">Other: ' + x.text.slice(0, 12).map(esc).join('; ') + '</div>';
      }
      h += '</div>';
    });
    if (!t.length) h += '<div class="cxp-s">The check-ins for this event have no answers recorded.</div>';
    h += '</div><div class="modal-footer"><button class="btn btn-ghost" onclick="civCsv(\'' + esc(String(ev.id)) + '\')">Download this event (CSV)</button><button class="btn btn-p" onclick="setCloseModal()">Close</button></div>';
    return h;
  }
  async function rowsFor(evId) {
    var r = await sb.from('checkins').select('*').eq('org_id', String(orgId)).eq('event_id', String(evId)).order('created_at', { ascending: true }).limit(5000);
    if (r.error) throw r.error; return r.data || [];
  }
  window.civOpen = async function (evId) {
    var ev = (DB.events || []).find(function (e) { return String(e.id) === String(evId); }); if (!ev) return;
    setModal('<h2>' + esc(ev.name) + '</h2><div class="cxp-s">Loading check-ins\u2026</div>');
    try { setModal(summaryHTML(ev, await rowsFor(evId)), 640); }
    catch (e) { setModal('<h2>' + esc(ev.name) + '</h2><div class="alert alert-warn">Couldn\u2019t load check-ins: ' + esc(e.message || e) + '</div><div class="modal-footer"><button class="btn btn-p" onclick="setCloseModal()">Close</button></div>'); }
  };
  function csvCell(v) { var s = Array.isArray(v) ? v.join('; ') : String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  window.civCsv = async function (evId) {
    try {
      var ev = (DB.events || []).find(function (e) { return String(e.id) === String(evId); }) || {}, rows = await rowsFor(evId);
      if (!rows.length) { alert('No check-ins for this event.'); return; }
      var keys = []; rows.forEach(function (r) { Object.keys(r.answers || {}).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
      var lines = [['Date', 'Time', 'People checked in'].concat(keys).map(csvCell).join(',')];
      rows.forEach(function (r) { var d = new Date(r.created_at); lines.push([r.day || '', isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' }), r.people || 1].concat(keys.map(function (k) { return (r.answers || {})[k]; })).map(csvCell).join(',')); });
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' })); a.download = 'check-ins - ' + String(ev.name || 'event').replace(/[\\/:*?"<>|]+/g, ' ') + '.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch (e) { alert('Couldn\u2019t download: ' + (e.message || e)); }
  };

  function ready(fn) { var t = 0; (function w() { if (typeof renderEvents === 'function' && typeof setModal === 'function') return fn(); if (++t < 100) setTimeout(w, 100); })(); }
  ready(function () {
    var orig = window.renderEvents;
    window.renderEvents = function () { var r = orig.apply(this, arguments); if (loaded) paint(); else load().then(function () { if (loaded) paint(); }); return r; };
    if (document.querySelector('#ev-list table')) load().then(function () { if (loaded) paint(); });
  });
  if (window.__VORLANA_TEST) window.__civTest = { tally: tally, summaryHTML: summaryHTML, reload: function () { loaded = false; return load(); } };
})();
