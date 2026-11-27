// js/extensions/nav.js — a shorter sidebar: line icons, plain names, and pages grouped into ten sections that open and close.
// The original buttons are kept and simply moved into groups, so go(), module switches and page access all work as before.
(function () {
  'use strict';
  var ICON = {
    dashboard: '<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>',
    rag: '<rect x="7" y="2" width="10" height="20" rx="5"/><circle cx="12" cy="7" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="17" r="1.6"/>',
    impact: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.5 19 2c1 2 2 4.2 2 8 0 5.5-4.8 10-10 10Z"/><path d="M2 21c0-3 1.9-5.4 5.1-6C9.5 14.5 12 13 13 12"/>',
    participants: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    contacts: '<rect x="4" y="3" width="16" height="18" rx="3"/><circle cx="12" cy="10" r="3"/><path d="M8 17a4 4 0 0 1 8 0"/>',
    volunteers: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7"/><path d="M18 14.5a6.5 6.5 0 0 1 3.5 5.5"/>',
    employers: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1M10 21v-3h4v3"/>',
    pipeline: '<path d="M6 4v12M12 4v7M18 4v16"/>',
    referrals: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4 20-7Z"/>',
    partnerrefs: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    events: '<rect x="3" y="4.5" width="18" height="17" rx="3"/><path d="M16 2.5v4M8 2.5v4M3 10h18"/>',
    feedback: '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12Z"/>',
    circular: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    outcomes: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    funders: '<path d="M3 21h18M6 17v-6M10 17v-6M14 17v-6M18 17v-6"/><path d="M12 3 20 8H4l8-5Z"/>',
    funding: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    reports: '<path d="M3 3v18h18"/><path d="M8 16v-4M13 16V8M18 16v-6"/>',
    evidence: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    demographics: '<path d="M21 12A9 9 0 1 1 12 3v9Z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15Z"/>',
    social: '<path d="m3 11 15-6v14L3 13v-2Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    bd: '<path d="m21 21-4.3-4.3"/><circle cx="11" cy="11" r="7"/><path d="M11 8v6M8 11h6"/>',
    safeguarding: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
    settings: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    growth: '<path d="m3 17 6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
    chev: '<path d="m9 6 6 6-6 6"/>'
  };
  // Plain names in the sidebar
  var NAME = { dashboard: 'Home', rag: 'Funder health', impact: 'Social impact', volunteers: 'Volunteers & staff', contacts: 'Contacts & donors',
    partnerrefs: 'From partners', funding: 'Contracts', evidence: 'Evidence', bd: 'Find funding', social: 'Social media', circular: 'Circular economy' };
  // Ten sections, in order. One page = no sub-list.
  var GROUPS = [
    { key: 'home', pages: ['dashboard'] },
    { key: 'people', label: 'People', icon: 'participants', pages: ['myday', 'participants', 'pipeline', 'referrals', 'partnerrefs', 'safeguarding'] },
    { key: 'vols', pages: ['volunteers'] },
    { key: 'events', label: 'Events', icon: 'events', pages: ['events', 'feedback'] },
    { key: 'impact', label: 'Impact', icon: 'impact', pages: ['impact', 'outcomes', 'demographics'] },
    { key: 'funders', label: 'Funders', icon: 'funders', pages: ['funders', 'funding', 'budget', 'calendar', 'rag', 'reports', 'evidence'] },
    { key: 'contacts', label: 'Contacts', icon: 'contacts', pages: ['contacts', 'donations', 'employers'] },
    { key: 'circ', pages: ['circular'] },
    { key: 'growth', label: 'Growth', icon: 'growth', pages: ['bd', 'social', 'companies'] },
    { key: 'settings', pages: ['settings'] }
  ];
  var svg = function (k) { return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON[k] || '') + '</svg>'; };
  var pageOf = function (b) { var m = /go\('([a-z]+)'\)/.exec(b.getAttribute('onclick') || ''); return m ? m[1] : null; };
  var shown = function (b) { return b.style.display !== 'none' && !b.hasAttribute('data-lens-hide'); };
  var built = false, syncing = false;

  function build() {
    var sb = document.getElementById('sidebar'); if (!sb || built) return;
    var btns = {};
    sb.querySelectorAll('.nav-btn').forEach(function (b) {
      var p = pageOf(b); if (!p) return;
      btns[p] = b;
      var ic = b.querySelector('.icon'); if (ic && ICON[p]) ic.innerHTML = svg(p);
      var lbl = b.querySelector('span:not(.icon):not(.ai-dot):not(.nav-count)'); if (lbl && NAME[p]) lbl.textContent = NAME[p];
      if (!b.title) b.title = (lbl && lbl.textContent) || '';
    });
    var anchor = sb.querySelector('.sidebar-bottom');
    var nav = document.createElement('nav'); nav.id = 'vl-nav'; nav.setAttribute('aria-label', 'Main');
    GROUPS.forEach(function (g) {
      var kids = g.pages.map(function (p) { return btns[p]; }).filter(Boolean);
      if (!kids.length) return;
      var wrap = document.createElement('div'); wrap.className = 'nav-grp'; wrap.dataset.grp = g.key;
      if (g.pages.length === 1) { wrap.classList.add('nav-single'); wrap.appendChild(kids[0]); nav.appendChild(wrap); return; }
      var head = document.createElement('button'); head.type = 'button'; head.className = 'nav-head'; head.title = g.label;
      head.setAttribute('aria-expanded', 'false');
      head.innerHTML = '<span class="icon">' + svg(g.icon) + '</span><span class="nav-head-lbl">' + g.label + '</span><span class="chev">' + svg('chev') + '</span>';
      var box = document.createElement('div'); box.className = 'nav-kids';
      kids.forEach(function (k) { box.appendChild(k); });
      head.addEventListener('click', function () {
        if (wrap.classList.contains('open')) { setOpen(wrap, false); return; }   // tap again to fold it away
        var first = Array.prototype.find.call(box.querySelectorAll('.nav-btn'), shown);
        if (wrap.querySelector('.nav-btn.active') || !first) setOpen(wrap, true); else first.click();
      });
      wrap.appendChild(head); wrap.appendChild(box); nav.appendChild(wrap);
    });
    // Old section headings and any buttons not in a group stay where they were (headings hidden)
    sb.querySelectorAll('.nav-section').forEach(function (s) { s.classList.add('nav-old'); });
    sb.insertBefore(nav, anchor || null);
    var logo = sb.querySelector('.sidebar-logo'); if (logo && logo.nextSibling !== nav) sb.insertBefore(nav, logo.nextSibling);
    built = true;
    new MutationObserver(function () { if (!syncing) sync(); }).observe(nav, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    sync();
  }
  function setOpen(wrap, on) {
    wrap.classList.toggle('open', on);
    var h = wrap.querySelector('.nav-head'); if (h) h.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
  // Hide a section when all its pages are switched off. When the page changes, open its section and fold the others.
  var lastActive;
  function sync() {
    syncing = true;
    var act = document.querySelector('#vl-nav .nav-btn.active'), ap = act ? pageOf(act) : null, changed = ap !== lastActive;
    lastActive = ap;
    document.querySelectorAll('#vl-nav .nav-grp').forEach(function (w) {
      var kids = Array.prototype.filter.call(w.querySelectorAll('.nav-btn'), shown);
      w.style.display = kids.length ? '' : 'none';
      var active = !!w.querySelector('.nav-btn.active'), h = w.querySelector('.nav-head');
      if (!h) return;
      h.classList.toggle('has-active', active);
      if (changed && ap) setOpen(w, active);
    });
    syncing = false;
  }
  // A different grouping (the demo account's six-section menu, js/extensions/menu.js): put the buttons back, then build again
  var DEFAULT_NAMES = {};
  window.vlNavRegroup = function (groups, names) {
    var sb = document.getElementById('sidebar'), nav = document.getElementById('vl-nav'); if (!sb || !nav) return false;
    var anchor = sb.querySelector('.sidebar-bottom');
    nav.querySelectorAll('.nav-btn').forEach(function (b) { sb.insertBefore(b, anchor || null); });
    nav.remove(); built = false; lastActive = undefined;
    GROUPS = groups; Object.keys(names || {}).forEach(function (k) { NAME[k] = names[k]; });
    build(); return true;
  };
  window.vlNavSync = function () { if (built) sync(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
  if (window.__VORLANA_TEST) window.__navTest = { build: build, sync: sync, GROUPS: GROUPS };
})();
