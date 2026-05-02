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
function applyModules(mods) {
  const m = {
    participants: mods.participants != null ? mods.participants : true,
    volunteers:   mods.volunteers   != null ? mods.volunteers   : true,
    events:       mods.events       != null ? mods.events       : true,
    employers:    mods.employers    != null ? mods.employers    : false,
    circular:     mods.circular     != null ? mods.circular     : false,
    funders:      mods.funders      != null ? mods.funders      : false
  };

  // Which pages each module gates
  const gates = {
    participants: ['participants', 'pipeline', 'referrals', 'partnerrefs', 'outcomes', 'safeguarding', 'evidence'],
    volunteers:   ['volunteers'],
    events:       ['events', 'feedback', 'impact'],
    employers:    ['employers'],
    circular:     ['circular'],
    funders:      ['funding', 'reports', 'rag', 'funders']
  };

  Object.keys(gates).forEach(modKey => {
    gates[modKey].forEach(page => {
      const btn = document.querySelector('.nav-btn[onclick="go(\'' + page + '\')"]');
      if (btn) btn.style.display = m[modKey] ? '' : 'none';
    });
  });
}
