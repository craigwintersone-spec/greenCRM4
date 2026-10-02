// js/router.js — page navigation and module-based nav visibility
// Depends on: utils.js, db.js, render.js
//
// Responsibilities:
//   • go(pageName) — switch which page is showing and call its renderer
//   • applyModules(mods) — hide/show sidebar buttons based on org modules
//
// Note: render functions live in render.js. Modal handlers live in
// modals.js. This file is just the router.
'use strict';

// Map page names → render functions. New pages get added here.
function _renderForPage(page) {
  const renders = {
    dashboard:    renderDashboard,
    rag:          renderRAG,
    impact:       renderImpact,
    participants: renderParticipants,
    contacts:     renderContacts,
    volunteers:   renderVolunteers,
    employers:    renderEmployers,
    pipeline:     renderPipeline,
    referrals:    renderReferrals,
    partnerrefs:  () => { renderPartnerRefs(); initPartnerPortal(); },
    events:       renderEvents,
    feedback:     renderFeedback,
    circular:     renderCircular,
    outcomes:     renderOutcomes,
    funding:      renderFunding,
    funders:      renderFunders,
    evidence:     renderEvidence,
    safeguarding: renderSafeguarding,
    settings:     renderSettings,
    reports:      renderReports,
    hr:           renderHR,
    social:       () => {}, // form-only page, no render needed
    bd:           () => { if (typeof populateOrgProfileField === 'function') populateOrgProfileField(); }   // loads the organisation panel
  };
  return renders[page];
}

// ── Who can open which page ────────────────────────────────
// Set per person by a manager on the Team page (memberships.page_access).
// Nobody set yet: managers/admins see everything, advisers see the
// day-to-day pages. Super admins always see everything. The database still
// limits everyone to their own organisation — this decides what's shown.
const PAGE_LIST = [
  ['dashboard', 'Dashboard'], ['participants', 'Participants'], ['pipeline', 'Pipeline'], ['referrals', 'Referrals'], ['partnerrefs', 'Partner referrals'],
  ['outcomes', 'Outcomes'], ['safeguarding', 'Safeguarding'], ['evidence', 'Evidence hub'], ['events', 'Events'], ['feedback', 'Feedback'],
  ['volunteers', 'Volunteers'], ['contacts', 'Contacts & donors'], ['employers', 'Employers'], ['circular', 'Circular economy'],
  ['impact', 'Social impact'], ['rag', 'RAG dashboard'], ['demographics', 'Demographics'], ['reports', 'Reports'], ['funders', 'Funders'],
  ['funding', 'Contracts'], ['social', 'Social media'], ['bd', 'BD manager'], ['hr', 'HR'], ['settings', 'Settings']
];
const ADVISER_DEFAULT_PAGES = ['dashboard', 'participants', 'pipeline', 'referrals', 'partnerrefs', 'outcomes', 'safeguarding', 'evidence',
  'events', 'feedback', 'volunteers', 'contacts', 'employers', 'circular'];
const _ACCESS_KEY = 'vorlana_access';

function isAdviserRole(role) {
  role = role !== undefined ? role : (typeof currentRole !== 'undefined' ? currentRole : '');
  return !!role && !/owner|admin|manager|super/i.test(role);
}
function adviserPages() { return ADVISER_DEFAULT_PAGES; }
// This person's own list for the organisation they're in (null = role default)
function myPageAccess() {
  if (typeof userMemberships === 'undefined' || typeof orgId === 'undefined') return null;
  const m = (userMemberships || []).find(x => x.org_id === orgId);
  return m && Array.isArray(m.page_access) ? m.page_access : null;
}
function pageAllowed(page, role, pages) {
  if (page === 'dashboard') return true;
  role = role !== undefined ? role : (typeof currentRole !== 'undefined' ? currentRole : '');
  if (/super/i.test(role || '')) return true;
  const list = pages !== undefined ? pages : myPageAccess();
  if (Array.isArray(list)) return list.includes(page);
  return !isAdviserRole(role) || ADVISER_DEFAULT_PAGES.includes(page);
}

function go(page) {
  // Advisers only reach the pages their organisation allows
  if (!pageAllowed(page)) page = 'dashboard';
  // Hide all pages and clear active nav
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  const el = $('page-' + page);
  if (!el) return;
  el.classList.add('active');
  // Call the render function for this page
  const fn = _renderForPage(page);
  if (fn) fn();
  // Highlight the active nav button
  document.querySelectorAll('.nav-btn').forEach(b => {
    const onclick = b.getAttribute('onclick') || '';
    if (onclick.indexOf("'" + page + "'") >= 0) b.classList.add('active');
  });
}

// Module visibility — hides sidebar buttons for areas the organisation
// has switched off (Settings → What you do). Pages stay reachable by
// go() (data is protected by RLS in the database — this is UX, not
// security).
//
// No flash on refresh: the last-known switches are saved in the browser
// and applied the instant this file loads, before the organisation's
// settings arrive; the real settings then correct them if they changed.
// Buttons without data-module (Dashboard, Settings) always show.
const _MODS_KEY = 'vorlana_mods';

function applyModules(mods, plan) {
  mods = mods || {};
  try {
    localStorage.setItem(_MODS_KEY, JSON.stringify(mods));
    localStorage.setItem(_ACCESS_KEY, JSON.stringify({ role: typeof currentRole !== 'undefined' ? currentRole : '', pages: myPageAccess() }));
  } catch (e) { /* private mode */ }
  _paintModules(mods);
}

function _paintModules(mods, access) {
  let role, pages;
  if (access) { role = access.role; pages = access.pages; }
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const k = btn.getAttribute('data-module');
    const m = /go\('([a-z]+)'\)/.exec(btn.getAttribute('onclick') || '');
    const byRole = m ? pageAllowed(m[1], role, pages) : true;
    btn.style.display = (k && mods[k] === false) || !byRole ? 'none' : '';
  });
  // Hide a section heading when everything under it is hidden
  document.querySelectorAll('.nav-section').forEach(sec => {
    let el = sec.nextElementSibling, any = false;
    while (el && !el.classList.contains('nav-section')) {
      if (el.classList.contains('nav-btn') && el.style.display !== 'none') { any = true; break; }
      el = el.nextElementSibling;
    }
    sec.style.display = any ? '' : 'none';
  });
}

// Paint straight away from the last-known switches
(function () {
  try {
    const m = JSON.parse(localStorage.getItem(_MODS_KEY) || 'null');
    const a = JSON.parse(localStorage.getItem(_ACCESS_KEY) || 'null');
    if (m) _paintModules(m, a || undefined);
  } catch (e) { /* ignore */ }
})();
