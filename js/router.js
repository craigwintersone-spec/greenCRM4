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
    bd:           () => {}  // form-only page, no render needed
  };
  return renders[page];
}

function go(page) {
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
  try { localStorage.setItem(_MODS_KEY, JSON.stringify(mods)); } catch (e) { /* private mode */ }
  _paintModules(mods);
}

function _paintModules(mods) {
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const k = btn.getAttribute('data-module');
    btn.style.display = k && mods[k] === false ? 'none' : '';
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
  try { const m = JSON.parse(localStorage.getItem(_MODS_KEY) || 'null'); if (m) _paintModules(m); } catch (e) { /* ignore */ }
})();
