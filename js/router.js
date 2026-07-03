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
  const m = {
    participants: mods.participants != null ? mods.participants : true,
    volunteers:   mods.volunteers   != null ? mods.volunteers   : false, // launch: was true (deferred)
    events:       mods.events       != null ? mods.events       : false, // launch: was true (deferred)
    employers:    mods.employers    != null ? mods.employers    : false,
    circular:     mods.circular     != null ? mods.circular     : false,
    funders:      mods.funders      != null ? mods.funders      : true    // launch: was false (core pillar)
  };
  // Which pages each module gates
  const gates = {
    participants: ['participants', 'pipeline', 'referrals', 'partnerrefs', 'outcomes', 'safeguarding', 'evidence'],
    volunteers:   ['volunteers'],
    events:       ['events', 'feedback'],                                 // launch: 'impact' moved to funders (below)
    employers:    ['employers'],
    circular:     ['circular'],
    funders:      ['funding', 'reports', 'rag', 'funders', 'impact']      // launch: gained 'impact' so it ships with reporting
  };
  Object.keys(gates).forEach(modKey => {
    gates[modKey].forEach(page => {
      const btn = document.querySelector('.nav-btn[onclick="go(\'' + page + '\')"]');
      if (btn) btn.style.display = m[modKey] ? '' : 'none';
    });
  });

  // ── launch: hide ungated pages outside the three pillars ──
  // hr and social have no module gate, so they'd otherwise always show.
  // Remove this block to bring them back.
  ['hr', 'social'].forEach(page => {
    const btn = document.querySelector('.nav-btn[onclick="go(\'' + page + '\')"]');
    if (btn) btn.style.display = 'none';
  });

  // ── launch: BD Manager is a launch pillar, but AI-plan only ──
  // AI_PLANS comes from config.js (loads first). We resolve the plan from the
  // explicit `plan` arg first, then fall back to likely current-org globals.
  // `typeof` guards mean an undeclared global can NEVER throw here.
  // If the plan can't be resolved at all (e.g. not wired yet), BD stays
  // VISIBLE — fail-open, so nothing silently disappears. Once you know which
  // variable holds the org plan, pass it in as applyModules(mods, thatPlan)
  // or add it to the chain below.
  const bdPlan = plan
    || (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.plan)
    || (typeof activeOrg  !== 'undefined' && activeOrg  && activeOrg.plan)
    || null;
  const bdBtn = document.querySelector('.nav-btn[onclick="go(\'bd\')"]');
  if (bdBtn) {
    // Resolvable plan → gate strictly. Unresolvable → leave visible.
    bdBtn.style.display = (bdPlan == null || AI_PLANS.includes(bdPlan)) ? '' : 'none';
  }
}
