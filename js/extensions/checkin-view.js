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
    var th2 = document.createElement('th'); th2.className = 'civ-th'; th2.textContent = 'Feedback'; th2.style.textAlign = 'center'; th.insertAdjacentElement('afterend', th2);
    var fbBy = {}; (DB.feedback || []).forEach(function (f) { var k = String(f.eventId || f.event_id); fbBy[k] = (fbBy[k] || 0) + 1; });
    tbl.querySelectorAll('tbody tr').forEach(function (tr) {
      var edit = tr.querySelector('button[onclick^="openEditEv"]'); if (!edit) return;
      var m = /openEditEv\('([^']+)'\)/.exec(edit.getAttribute('onclick') || ''); if (!m) return;
      var c = COUNTS[m[1]], td = document.createElement('td'); td.style.textAlign = 'center';
      td.innerHTML = c ? '<a href="#" onclick="civOpen(\'' + esc(m[1]) + '\');return false" title="See what people answered" style="font-weight:600">' + c.people + '</a>' : '<span style="color:var(--txt3)">\u2014</span>';
      tr.children[3].insertAdjacentElement('afterend', td);
      var n = fbBy[m[1]] || 0, td2 = document.createElement('td'); td2.style.textAlign = 'center';
      td2.innerHTML = n ? '<a href="#" onclick="civFeedback(\'' + esc(m[1]) + '\');return false" title="Read the feedback for this event" style="font-weight:600">' + n + '</a>' : '<span style="color:var(--txt3)">\u2014</span>';
      td.insertAdjacentElement('afterend', td2);
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
  // open the Feedback page already filtered to this event
  window.civFeedback = function (evId) {
    if (typeof go === 'function') go('feedback');
    var tries = 0; (function w() { var sel = $('fb-filter-ev'); if (sel && [].slice.call(sel.options).some(function (o) { return o.value === String(evId); })) { sel.value = String(evId); sel.dispatchEvent(new Event('change')); if (typeof renderFeedback === 'function') renderFeedback(); return; } if (++tries < 30) setTimeout(w, 100); })();
  };
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


  // ── Feedback page: pick an event, see every question on its form with the results ──
  function bar(label, n, total, extra) {
    var pc = total ? Math.round(n / total * 100) : 0;
    return '<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin:3px 0;' + TXT + '"><span style="flex:0 0 38%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(label) + '">' + esc(label) + '</span>' +
      '<span style="flex:1;height:8px;background:var(--bg);border-radius:4px;overflow:hidden"><span style="display:block;width:' + pc + '%;height:8px;background:var(--em)"></span></span><span style="flex:0 0 74px;text-align:right;color:var(--txt2)">' + n + ' \u00b7 ' + pc + '%' + (extra || '') + '</span></div>';
  }
  function fbSummary() {
    var sel = $('fb-filter-ev'), list = $('fb-list'); if (!sel || !list) return;
    var old = $('civ-fbsum'); if (old) old.remove();
    if (!sel.value || typeof activeMeasures !== 'function' || typeof answerFor !== 'function') return;
    var ev = (DB.events || []).find(function (e) { return String(e.id) === String(sel.value); });
    var F = (DB.feedback || []).filter(function (f) { return String(f.eventId) === String(sel.value); });
    if (!F.length) return;
    var rows = '';
    activeMeasures().forEach(function (m) {
      var t = String(m.question || '');
      if (/where did you attend|which (location|site|venue)|workshop location/i.test(t) || (m.kind === 'text' && /\b(name|e-?mail|phone|contact details?)\b/i.test(t))) return;
      var vals = F.map(function (f) { return answerFor(f, m); }).filter(function (v) { return v != null && v !== ''; });
      if (!vals.length) return;
      var h = '<div style="margin-bottom:14px"><div style="font-size:13px;font-weight:600;color:var(--txt);' + TXT + '">' + esc(t) + ' <span style="font-weight:400;color:var(--txt3)">\u00b7 ' + vals.length + ' answered</span></div>';
      if (m.kind === 'score' && typeof scoreOf === 'function') {
        var sc = vals.map(scoreOf).filter(function (x) { return x != null; }), avg = sc.length ? sc.reduce(function (a, b) { return a + b; }, 0) / sc.length : 0;
        h += '<div style="font-size:12px;color:var(--txt2);margin:2px 0 4px;' + TXT + '">Average <b>' + avg.toFixed(1) + ' out of 5</b> \u00b7 ' + (sc.length ? Math.round(sc.filter(function (x) { return x >= 4; }).length / sc.length * 100) : 0) + '% rated 4 or 5</div>';
        [5, 4, 3, 2, 1].forEach(function (k) { h += bar(k + (k === 5 ? ' (highest)' : k === 1 ? ' (lowest)' : ''), sc.filter(function (x) { return Math.round(x) === k; }).length, sc.length); });
      } else if (m.kind === 'text') {
        h += vals.slice(0, 5).map(function (v) { return '<div style="font-size:12px;color:var(--txt2);border-left:3px solid var(--border);padding:2px 8px;margin:4px 0;' + TXT + '">\u201c' + esc(String(v).slice(0, 240)) + '\u201d</div>'; }).join('') + (vals.length > 5 ? '<div style="font-size:11px;color:var(--txt3)">and ' + (vals.length - 5) + ' more below</div>' : '');
      } else {
        var counts = {}; vals.forEach(function (v) { (Array.isArray(v) ? v : [v]).forEach(function (a) { var k = (typeof yesOf === 'function' && m.kind === 'yesno') ? (yesOf(a) ? 'Yes' : 'No') : String(a).trim(); counts[k] = (counts[k] || 0) + 1; }); });
        Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (k) { h += bar(k, counts[k], vals.length); });
      }
      rows += h + '</div>';
    });
    if (!rows) return;
    list.insertAdjacentHTML('beforebegin', '<div class="card" id="civ-fbsum" style="margin-bottom:14px"><div class="card-title">What people told us' + (ev ? ' at ' + esc(ev.name) : '') + ' (' + F.length + ' response' + (F.length === 1 ? '' : 's') + ')</div>' + rows + '</div>');
  }
  function ready(fn) { var t = 0; (function w() { if (typeof renderEvents === 'function' && typeof setModal === 'function') return fn(); if (++t < 100) setTimeout(w, 100); })(); }
  ready(function () {
    var origFb = window.renderFeedback;
    if (typeof origFb === 'function') window.renderFeedback = function () { var r = origFb.apply(this, arguments); try { fbSummary(); } catch (e) { console.warn('[checkin-view] feedback summary:', e); } return r; };
    var orig = window.renderEvents;
    window.renderEvents = function () { var r = orig.apply(this, arguments); if (loaded) paint(); else load().then(function () { if (loaded) paint(); }); return r; };
    if (document.querySelector('#ev-list table')) load().then(function () { if (loaded) paint(); });
  });
  if (window.__VORLANA_TEST) window.__civTest = { fbSummary: fbSummary, tally: tally, summaryHTML: summaryHTML, reload: function () { loaded = false; return load(); } };
})();
