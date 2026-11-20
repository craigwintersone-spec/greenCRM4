// js/extensions/plan-limits.js — what each plan includes, applied where it matters in the app
// Starter: 1 live funder contract. Community and trial: up to 2. Staff logins are checked by api/send-invite.js, AI calls by api/claude.js.
(function () {
  'use strict';
  var CONTRACT_LIMIT = { free: 2, group: 1, starter: 2 };          // Standard and Provider: no limit
  var PLAN_NAME = { free: 'trial', group: 'Starter plan', starter: 'Community plan' };
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
        alert('Your ' + PLAN_NAME[plan()] + ' includes ' + cap + ' live funder contract' + (cap === 1 ? '' : 's') + ', and you have ' + liveContracts() + '. Mark one you have finished as closed, or ask us about upgrading.');
        return;
      }
      return orig.apply(this, arguments);
    };
  });
  if (window.__VORLANA_TEST) window.__planTest = { liveContracts: liveContracts };
})();
