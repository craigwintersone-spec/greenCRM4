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

// Module visibility — hides nav buttons for disabled modules.
// Pages are still reachable via direct go() calls (data is RLS-protected
// at the database level, so this is a UX not a security boundary).
//
// ── LAUNCH SCOPE (dial-down) ────────────────────────────────────────
// Launching three pillars only: Employability · Funder Reporting · BD Manager.
// Changes below are DEFAULTS for orgs that haven't set module prefs — orgs
// with saved prefs keep theirs. Nothing is removed; deferred modules stay in
// the codebase and can be re-enabled per org in Settings, or by reverting the
// // launch: comments here. To broaden the product later, undo those lines.
function applyModules(mods, plan) {
  // ── LAUNCH: the sidebar in app.html is the single source of truth. ──
  // Whatever buttons are in the HTML are the ones we want, so this function
  // just makes sure they are all VISIBLE. It never hides anything — that is
  // what stops the "buttons flash on refresh then disappear" glitch.
  // To take a button out of the product, delete it from app.html's sidebar
  // (not here). `mods` and `plan` are still accepted so existing calls work,
  // but they are no longer used to hide anything.
  document.querySelectorAll('.nav-btn').forEach(function (btn) {
    btn.style.display = '';
  });
}
