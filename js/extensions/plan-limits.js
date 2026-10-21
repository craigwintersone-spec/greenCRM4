// js/extensions/plan-limits.js — what each plan includes, applied where it matters in the app
// Community and trial: up to 2 live funder contracts. Staff logins are checked by api/send-invite.js, AI calls by api/claude.js.
(function () {
  'use strict';
  var CONTRACT_LIMIT = { free: 2, starter: 2 };          // Standard and Provider: no limit
  var PLAN_NAME = { free: 'trial', starter: 'Community plan' };
  function plan() { return (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.plan) || 'free'; }
  function liveContracts() {
    return ((typeof DB !== 'undefined' && DB.contracts) || []).filter(function (c) { return !/clos|end|complet|archiv/i.test(String(c.status || '')); }).length;
  }
  function editing() { try { return !!_editConId; } catch (e) { return false; } }
  function ready(fn) { var t = 0; (function w() { if (typeof saveCon === 'function') return fn(); if (++t < 100) setTimeout(w, 100); })(); }
  ready(function () {
    var orig = window.saveCon;
    window.saveCon = function () {
      var cap = CONTRACT_LIMIT[plan()];
      if (cap && !editing() && liveContracts() >= cap) {
        alert('Your ' + PLAN_NAME[plan()] + ' includes ' + cap + ' live funder contracts, and you have ' + liveContracts() + '. Mark one you have finished as closed, or ask us about the Standard plan, which has no limit.');
        return;
      }
      return orig.apply(this, arguments);
    };
  });
  if (window.__VORLANA_TEST) window.__planTest = { liveContracts: liveContracts };
})();
