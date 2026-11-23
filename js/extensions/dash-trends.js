// js/extensions/dash-trends.js — the top of the dashboard: the last 30 days at a glance, each with the change on the
// 30 days before and a six-month trend line. Works from data already loaded (events, volunteer hours, feedback).
(function () {
  'use strict';
  var DAY = 864e5;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var num = function (v) { v = Number(v); return isFinite(v) ? v : 0; };
  var day = function (s) { return String(s || '').slice(0, 10); };

  // Six 30-day buckets ending today; bucket 5 is "the last 30 days"
  function buckets() {
    var end = new Date(); end.setHours(23, 59, 59, 999);
    var out = [];
    for (var i = 5; i >= 0; i--) {
      var to = new Date(end.getTime() - i * 30 * DAY), from = new Date(to.getTime() - 30 * DAY + 1);
      out.push({ from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) });
    }
    return out;
  }
  var inB = function (d, b) { return d && d >= b.from && d <= b.to; };

  function series() {
    var B = buckets(), today = new Date().toISOString().slice(0, 10);
    var E = (typeof DB !== 'undefined' && DB.events) || [], H = (DB.volunteer_hours) || [], F = (DB.feedback) || [];
    var evDate = {}; E.forEach(function (e) { evDate[e.id] = day(e.date); });
    var past = E.filter(function (e) { return day(e.date) && day(e.date) <= today; });
    var sessions = B.map(function (b) { return past.filter(function (e) { return inB(day(e.date), b); }).length; });
    var people = B.map(function (b) { return past.filter(function (e) { return inB(day(e.date), b); }).reduce(function (a, e) { return a + num(e.attendees); }, 0); });
    var hours = B.map(function (b) { return Math.round(H.filter(function (h) { return inB(day(h.date), b); }).reduce(function (a, h) { return a + num(h.hours); }, 0)); });
    var conf = B.map(function (b) {
      var rows = F.filter(function (f) { var d = day(f.created_at) || evDate[f.eventId || f.event_id]; return inB(d, b) && f.cb != null && f.ca != null && f.cb !== '' && f.ca !== ''; });
      return rows.length ? Math.round(100 * rows.filter(function (f) { return num(f.ca) > num(f.cb); }).length / rows.length) : null;
    });
    return [
      { lbl: 'Sessions run', vals: sessions },
      { lbl: 'People attending', vals: people },
      { lbl: 'Volunteer hours', vals: hours },
      { lbl: 'Felt more confident', vals: conf, pct: true }
    ];
  }

  function spark(vals) {
    var pts = vals.map(function (v, i) { return [i, v == null ? null : v]; }).filter(function (p) { return p[1] != null; });
    if (pts.length < 2) return '';
    var max = Math.max.apply(null, pts.map(function (p) { return p[1]; })), min = Math.min.apply(null, pts.map(function (p) { return p[1]; }));
    var W = 200, Hh = 44, pad = 4, span = max - min || 1;
    var xy = pts.map(function (p) { return [pad + p[0] * (W - 2 * pad) / 5, Hh - pad - (p[1] - min) / span * (Hh - 2 * pad)]; });
    var line = xy.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + xy[xy.length - 1][0].toFixed(1) + ' ' + Hh + ' L' + xy[0][0].toFixed(1) + ' ' + Hh + ' Z';
    var last = xy[xy.length - 1];
    return '<svg viewBox="0 0 ' + W + ' ' + Hh + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<defs><linearGradient id="vtg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="var(--em)" stop-opacity=".18"/><stop offset="1" stop-color="var(--em)" stop-opacity="0"/></linearGradient></defs>' +
      '<path d="' + area + '" fill="url(#vtg)"/><path d="' + line + '" fill="none" stroke="var(--em)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3" fill="var(--em)"/></svg>';
  }

  function change(now, before, pct) {
    if (now == null || before == null) return '<span class="vt-chg vt-flat">new</span>';
    if (pct) { var d = now - before; return d === 0 ? '<span class="vt-chg vt-flat">no change</span>' : '<span class="vt-chg ' + (d > 0 ? 'vt-up' : 'vt-down') + '">' + (d > 0 ? '▲ ' : '▼ ') + Math.abs(d) + ' pts</span>'; }
    if (!before) return now ? '<span class="vt-chg vt-up">▲ new</span>' : '<span class="vt-chg vt-flat">no change</span>';
    var p = Math.round(100 * (now - before) / before);
    return p === 0 ? '<span class="vt-chg vt-flat">no change</span>' : '<span class="vt-chg ' + (p > 0 ? 'vt-up' : 'vt-down') + '">' + (p > 0 ? '▲ ' : '▼ ') + Math.abs(p) + '%</span>';
  }

  function render() {
    var page = document.getElementById('page-dashboard'); if (!page) return;
    var box = document.getElementById('vt-box');
    if (!box) {
      box = document.createElement('div'); box.id = 'vt-box'; box.className = 'vt-wrap';
      var before = page.querySelector('.morning-briefing') || document.getElementById('dash-stats');
      if (before) before.parentNode.insertBefore(box, before); else page.appendChild(box);
    }
    var S = series();
    var any = S.some(function (s) { return s.vals.some(function (v) { return v; }); });
    if (!any) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = '<div class="vt-hd"><div class="vt-title">Last 30 days</div><div class="vt-sub">compared with the 30 days before</div></div><div class="vt-grid">' +
      S.map(function (s) {
        var now = s.vals[5], prev = s.vals[4];
        return '<div class="vt-card"><div class="vt-lbl">' + esc(s.lbl) + '</div>' +
          '<div class="vt-row"><div class="vt-val">' + (now == null ? '—' : esc(now.toLocaleString('en-GB')) + (s.pct ? '%' : '')) + '</div>' + (now == null ? '' : change(now, prev, s.pct)) + '</div>' +
          '<div class="vt-spark">' + spark(s.vals) + '</div><div class="vt-foot"><span>6 months ago</span><span>Now</span></div></div>';
      }).join('') + '</div>';
  }

  (function wait(t) {
    if (typeof renderDashboard === 'function' && typeof DB !== 'undefined') {
      var rd = window.renderDashboard;
      window.renderDashboard = function () {
        var r = rd.apply(this, arguments);
        try { render(); } catch (e) { console.warn('[dash-trends]', e); }
        return r;
      };
      // volunteer hours arrive a moment after the dashboard first draws
      [1500, 4000].forEach(function (ms) { setTimeout(function () { var p = document.getElementById('page-dashboard'); if (p && p.classList.contains('active')) { try { render(); } catch (e) { /* ignore */ } } }, ms); });
      return;
    }
    if (t < 100) setTimeout(function () { wait(t + 1); }, 100);
  })(0);
  if (window.__VORLANA_TEST) window.__vtTest = { series: series, render: render };
})();
