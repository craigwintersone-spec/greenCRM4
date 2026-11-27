// js/extensions/menu.js — the menu, organised by the job in hand (demo account only, with ai-office.js)
//   • Six sections named for what you're doing: Today, People, Activity, Money, Reports, Settings.
//   • "Go to…" at the top: type a page ("gift aid"), a person, a volunteer or a contract and jump straight there.
//   • Counts beside a page show what's waiting there (the same things as today's checks).
//   • "View as" on the Dashboard also shows that role's menu, so each role's view can be demonstrated.
// Other organisations keep the standard menu (nav.js) until this is switched on for them.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var A = function () { return window.vlAO; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  var GROUPS = [
    { key: 'today', label: 'Today', icon: 'dashboard', pages: ['dashboard', 'myday'] },
    { key: 'people', label: 'People', icon: 'participants', pages: ['participants', 'pipeline', 'referrals', 'partnerrefs', 'safeguarding', 'volunteers', 'employers', 'contacts'] },
    { key: 'activity', label: 'Activity', icon: 'events', pages: ['events', 'feedback', 'circular'] },
    { key: 'money', label: 'Money', icon: 'funders', pages: ['funding', 'funders', 'budget', 'donations', 'calendar', 'bd', 'companies'] },
    { key: 'reports', label: 'Reports', icon: 'impact', pages: ['reports', 'impact', 'outcomes', 'demographics', 'rag', 'evidence', 'social'] },
    { key: 'settings', pages: ['settings'] }
  ];
  var NAMES = { dashboard: 'Today’s checks', reports: 'Funder reports', funders: 'Funders', funding: 'Contracts', contacts: 'Contacts', social: 'Comms and social', calendar: 'Deadlines', companies: 'Company partners', bd: 'Find funding', rag: 'Funder health' };
  // what each role's menu holds when "View as" is used
  var LENS_PAGES = { frontline: ['dashboard', 'myday', 'participants', 'pipeline', 'referrals', 'safeguarding', 'events', 'feedback'], trustee: ['dashboard', 'reports', 'impact', 'outcomes', 'rag'] };
  // extra words people type for a page
  var WORDS = { dashboard: 'home today checks briefing', myday: 'my day phone caseload', participants: 'people clients caseload case notes', pipeline: 'stages kanban', referrals: 'referral', safeguarding: 'risk concern', volunteers: 'volunteer staff hours shifts rota',
    employers: 'jobs vacancies', contacts: 'donors partners trustees', events: 'sessions workshops bookings check-in', feedback: 'surveys forms', circular: 'repair reuse food growing', funding: 'contracts grants targets', funders: 'funder', budget: 'budgets spend receipts bank statement fixed costs',
    donations: 'gifts gift aid thank you justgiving stripe paypal donor', calendar: 'deadlines key dates insurance annual return dbs', bd: 'bids find funding tenders grants', companies: 'corporate team day csr', reports: 'funder report annual report trustee pack', impact: 'social impact', outcomes: 'outcomes',
    demographics: 'equality diversity', rag: 'funder health rag', evidence: 'payslips certificates consent', social: 'social media newsletter story comms', settings: 'settings users branding' };

  var pageOf = function (b) { var m = /go\('([a-z]+)'\)/.exec(b.getAttribute('onclick') || ''); return m ? m[1] : null; };
  var visible = function (b) { return b.style.display !== 'none' && !b.hasAttribute('data-lens-hide'); };
  var label = function (b) { var l = b.querySelector('span:not(.icon):not(.ai-dot):not(.nav-count)'); return l ? l.textContent.trim() : ''; };

  // ── Go to… ────────────────────────────────────────────────────
  function searchBox() {
    var nav = $('vl-nav'); if (!nav || $('mn-go')) return;
    var w = document.createElement('div'); w.id = 'mn-go'; w.style.cssText = 'position:relative;margin:0 10px 8px';
    w.innerHTML = '<input id="mn-q" placeholder="Go to…  (page or name)" autocomplete="off" style="width:100%;padding:8px 10px;font-size:13px;border-radius:10px"/><div id="mn-res" style="display:none;position:absolute;left:0;right:0;top:38px;z-index:980;background:var(--surface,#fff);border:1px solid var(--border);border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.15);max-height:340px;overflow:auto;padding:4px"></div>';
    nav.parentNode.insertBefore(w, nav);
    var q = $('mn-q'), res = $('mn-res'), hits = [], sel = 0;
    function find(t) {
      t = t.trim().toLowerCase(); var out = []; if (!t) return out;
      document.querySelectorAll('#vl-nav .nav-btn').forEach(function (b) { if (!visible(b)) return; var p = pageOf(b), name = label(b), hay = (name + ' ' + (WORDS[p] || '')).toLowerCase(); if (hay.indexOf(t) >= 0) out.push({ kind: 'Page', text: name, rank: name.toLowerCase().indexOf(t) === 0 ? 0 : 1, run: function () { go(p); } }); });
      var can = function (p) { var b = document.querySelector('#vl-nav .nav-btn[onclick*="\'' + p + '\'"]'); return b && visible(b); };
      if (t.length >= 2) {
        if (can('participants')) (DB.participants || []).forEach(function (p) { var n = (p.first_name + ' ' + p.last_name).trim(); if (n.toLowerCase().indexOf(t) >= 0) out.push({ kind: 'Person', text: n, sub: p.stage, rank: 2, run: function () { go('participants'); setTimeout(function () { if (typeof openNotes === 'function') openNotes(p.id); }, 250); } }); });
        if (can('volunteers')) (DB.volunteers || []).forEach(function (v) { if (String(v.name || '').toLowerCase().indexOf(t) >= 0) out.push({ kind: 'Volunteer', text: v.name, rank: 3, run: function () { go('volunteers'); } }); });
        if (can('funding')) (DB.contracts || []).forEach(function (c) { if ((c.name + ' ' + (c.funder || '')).toLowerCase().indexOf(t) >= 0) out.push({ kind: 'Contract', text: c.name, sub: c.funder, rank: 3, run: function () { go('funding'); } }); });
        if (can('events')) (DB.events || []).filter(function (e) { return e.date >= A().iso(A().addDays(new Date(), -14)); }).forEach(function (e) { if (String(e.name || '').toLowerCase().indexOf(t) >= 0) out.push({ kind: 'Event', text: e.name, sub: A().fmt(e.date), rank: 4, run: function () { go('events'); } }); });
        if (can('donations') && A()) { var seen = {}; A().S.don.forEach(function (d) { var n = String(d.donor_name || ''); if (!seen[n] && n.toLowerCase().indexOf(t) >= 0) { seen[n] = 1; out.push({ kind: 'Donor', text: n, rank: 4, run: function () { go('donations'); } }); } }); }
      }
      return out.sort(function (x, y) { return x.rank - y.rank; }).slice(0, 9);
    }
    function paint() {
      hits = find(q.value); sel = Math.min(sel, Math.max(0, hits.length - 1));
      if (!q.value.trim()) { res.style.display = 'none'; return; }
      res.style.display = ''; res.innerHTML = hits.length ? hits.map(function (h, i) { return '<div data-i="' + i + '" style="display:flex;gap:8px;align-items:center;padding:7px 9px;border-radius:8px;cursor:pointer;font-size:13px;background:' + (i === sel ? 'rgba(31,111,109,.10)' : 'transparent') + '"><span style="font-size:10px;font-weight:700;color:var(--txt3);width:58px;flex-shrink:0;text-transform:uppercase">' + h.kind + '</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(h.text) + (h.sub ? ' <span style="color:var(--txt3)">· ' + esc(h.sub) + '</span>' : '') + '</span></div>'; }).join('')
        : '<div style="padding:9px;font-size:13px;color:var(--txt3)">Nothing matches. Try Ask Vorlana for a question.</div>';
    }
    function pick(i) { var h = hits[i]; if (!h) return; q.value = ''; res.style.display = 'none'; q.blur(); h.run(); }
    q.addEventListener('input', function () { sel = 0; paint(); });
    q.addEventListener('keydown', function (e) { if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, hits.length - 1); paint(); e.preventDefault(); } else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); paint(); e.preventDefault(); } else if (e.key === 'Enter') pick(sel); else if (e.key === 'Escape') { q.value = ''; paint(); q.blur(); } });
    res.addEventListener('mousedown', function (e) { var r = e.target.closest('[data-i]'); if (r) { e.preventDefault(); pick(+r.dataset.i); } });
    q.addEventListener('blur', function () { setTimeout(function () { res.style.display = 'none'; }, 150); });
    document.addEventListener('keydown', function (e) { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '') && !(document.activeElement || {}).isContentEditable) { e.preventDefault(); q.focus(); } });
  }

  // ── Counts: what's waiting on each page ───────────────────────
  function counts() {
    if (!A() || !$('vl-nav')) return; var by = {}, urgent = {};
    try { (A().lens() === 'manager' || A().lens() === 'ceo' ? A().allChecks() : A().checksFor(A().lens())).forEach(function (c) { if (c.lvl === 'info' || !c.page || c.page === 'dashboard') return; by[c.page] = (by[c.page] || 0) + 1; if (c.lvl === 'red') urgent[c.page] = 1; }); } catch (e) { return; }
    var key = JSON.stringify([by, urgent]); if ($('vl-nav').dataset.counted === key) return;
    $('vl-nav').dataset.counted = key;
    document.querySelectorAll('#vl-nav .nav-count').forEach(function (x) { x.remove(); });
    var pill = function (n, red) { return '<span class="nav-count" style="margin-left:auto;min-width:18px;height:18px;padding:0 5px;border-radius:9px;font-size:11px;font-weight:700;line-height:18px;text-align:center;background:' + (red ? '#B42318' : '#B7791F') + ';color:#fff;flex-shrink:0">' + n + '</span>'; };
    document.querySelectorAll('#vl-nav .nav-grp').forEach(function (g) {
      var sum = 0, red = false;
      g.querySelectorAll('.nav-btn').forEach(function (b) { var p = pageOf(b); if (!visible(b) || !by[p]) return; sum += by[p]; red = red || !!urgent[p]; b.insertAdjacentHTML('beforeend', pill(by[p], urgent[p])); });
      var h = g.querySelector('.nav-head'), ch = h && h.querySelector('.chev'); if (h && sum && ch) ch.insertAdjacentHTML('beforebegin', pill(sum, red));
    });
  }

  // ── "View as" shows that role's menu ──────────────────────────
  var lastLens = null;
  function lensMenu() {
    if (!A()) return; var L = A().lens(); if (L === lastLens) return; lastLens = L;
    var adviser = typeof isAdviserRole === 'function' && isAdviserRole();
    var allow = adviser ? null : (LENS_PAGES[L] || null);       // real frontline staff keep the pages their organisation gives them
    document.querySelectorAll('#vl-nav .nav-btn').forEach(function (b) { var p = pageOf(b); if (allow && allow.indexOf(p) < 0) b.setAttribute('data-lens-hide', '1'); else b.removeAttribute('data-lens-hide'); });
    var css = $('mn-css'); if (!css) { css = document.createElement('style'); css.id = 'mn-css'; css.textContent = '#vl-nav .nav-btn[data-lens-hide]{display:none !important}#vl-nav .nav-btn{display:flex;align-items:center}'; document.head.appendChild(css); }
    if (typeof window.vlNavSync === 'function') window.vlNavSync();
    $('vl-nav').dataset.counted = ''; counts();
    var bar = $('mn-lens');
    if (allow) { if (!bar) { bar = document.createElement('div'); bar.id = 'mn-lens'; bar.style.cssText = 'margin:0 10px 8px;padding:7px 10px;border-radius:10px;background:#FEF6E7;color:#8A5A0B;font-size:12px;line-height:1.4'; var nav = $('vl-nav'); nav.parentNode.insertBefore(bar, nav); }
      bar.innerHTML = 'Showing the menu a ' + (L === 'frontline' ? 'frontline worker' : 'trustee') + ' sees. <a href="#" onclick="vlSetLens(\'manager\');return false" style="color:inherit;font-weight:700">Back to mine</a>'; }
    else if (bar) bar.remove();
  }

  var tries = 0;
  (function wait() {
    if (window.vlAO && window.vlAO.on() && $('ao-ask-btn') && typeof window.vlNavRegroup === 'function' && $('vl-nav')) {
      if (!window.vlNavRegroup(GROUPS, NAMES)) return;
      searchBox();
      setInterval(function () { lensMenu(); counts(); }, 1500); lensMenu(); counts();
      return;
    }
    if (++tries > 120) return; setTimeout(wait, 500);
  })();
})();
