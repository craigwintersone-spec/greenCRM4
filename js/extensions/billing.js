// js/extensions/billing.js — trial and subscription, inside the app
// Only for organisations that signed up themselves (settings.self_serve). Pilots and set-up-by-us organisations never see any of it.
//   During the trial: a slim bar with the days left and "Choose a plan".
//   Trial over and no plan: a screen asking an owner or manager to choose one (others are asked to tell their manager).
//   Settings > Organisation: the plan, and "Choose a plan" or "Manage billing".
// Talks to api/billing.js. Depends on: auth.js (orgId, currentOrg, isSuperAdmin, currentRole), settings.js (setOrgHTML)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var PLANS = [
    { key: 'group', name: 'Starter', month: 29, year: 290, who: 'Volunteer-run groups', points: ['1 funder contract', 'Up to 2 staff logins'] },
    { key: 'starter', name: 'Community', month: 79, year: 790, who: 'Small charities', points: ['Up to 2 funder contracts', 'Up to 3 staff logins'] },
    { key: 'pro', name: 'Standard', month: 149, year: 1490, who: 'Several programmes and funders', points: ['Unlimited funder contracts', 'Up to 10 staff logins'], hot: true }
  ];
  var NAMES = { free: 'Free trial', group: 'Starter', starter: 'Community', pro: 'Standard', network: 'Provider' };
  var INTERVAL = 'year';

  function org() { return (typeof currentOrg !== 'undefined' && currentOrg) || null; }
  function st() { var o = org(); return (o && o.settings) || {}; }
  function selfServe() { return !!st().self_serve; }
  function onFree() { var o = org(); return !o || !o.plan || o.plan === 'free'; }
  function isSuper() { try { return !!isSuperAdmin; } catch (e) { return false; } }
  function isManager() { try { return isSuper() || /^(owner|admin|manager)$/i.test(currentRole || ''); } catch (e) { return false; } }
  function trialEnds() { var t = st().trial_ends; if (t) return new Date(t); var o = org(); return o && o.created_at ? new Date(new Date(o.created_at).getTime() + 14 * 864e5) : null; }
  function daysLeft() { var e = trialEnds(); return e ? Math.ceil((e.getTime() - Date.now()) / 864e5) : 0; }

  async function api(body) {
    var tok = '';
    try { var s = await sb.auth.getSession(); tok = (s && s.data && s.data.session && s.data.session.access_token) || ''; } catch (e) { /* not signed in */ }
    var r = await fetch('/api/billing', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(Object.assign({ org_id: String(orgId) }, body)) });
    var j = await r.json().catch(function () { return { ok: false, error: 'Something went wrong. Please try again.' }; });
    if (!j.ok) throw new Error(j.error || 'Something went wrong.');
    return j;
  }

  // ── the slim bar during the trial ──
  function trialBar() {
    var old = $('vlb-bar'); if (old) old.remove();
    if (!selfServe() || !onFree() || daysLeft() <= 0) return;
    var d = daysLeft(), bar = document.createElement('div');
    bar.id = 'vlb-bar';
    bar.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:7px 14px;background:#FFF6E0;color:#5C4400;font-size:13px;border-bottom:1px solid #F1E3BC';
    bar.innerHTML = '<span><b>Free trial:</b> ' + d + ' day' + (d === 1 ? '' : 's') + ' left</span>' +
      (isManager() ? '<button class="btn btn-p btn-sm" type="button" onclick="vlbPick()">Choose a plan</button>' : '<span>Your manager can choose a plan in Settings.</span>');
    var banner = $('org-banner');
    if (banner && banner.parentNode) banner.parentNode.insertBefore(bar, banner.nextSibling); else document.body.insertBefore(bar, document.body.firstChild);
  }

  // ── choosing a plan ──
  function cards() {
    return '<div style="display:flex;justify-content:center;gap:6px;margin:4px 0 14px">' +
        ['month', 'year'].map(function (i) { return '<button type="button" class="btn btn-sm ' + (INTERVAL === i ? 'btn-p' : 'btn-ghost') + '" onclick="vlbInterval(\'' + i + '\')">' + (i === 'month' ? 'Monthly' : 'Yearly, two months free') + '</button>'; }).join('') + '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px">' + PLANS.map(function (p) {
        var price = INTERVAL === 'year' ? '£' + p.year.toLocaleString('en-GB') + '<span style="font-size:13px;font-weight:400;color:var(--txt3)"> a year</span>' : '£' + p.month + '<span style="font-size:13px;font-weight:400;color:var(--txt3)"> a month</span>';
        return '<div style="border:' + (p.hot ? '2px solid var(--em)' : '1px solid var(--border)') + ';border-radius:12px;padding:14px;background:#fff;display:flex;flex-direction:column;gap:6px;text-transform:none;letter-spacing:0">' +
          '<div style="font-weight:700;font-size:15px;color:var(--txt)">' + p.name + '</div><div style="font-size:12px;color:var(--txt3)">' + esc(p.who) + '</div>' +
          '<div style="font-size:22px;font-weight:800;color:var(--em)">' + price + '</div>' +
          '<ul style="margin:0;padding-left:16px;font-size:12.5px;color:var(--txt2)">' + p.points.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' +
          '<button type="button" class="btn ' + (p.hot ? 'btn-p' : 'btn-ghost') + ' btn-sm" style="margin-top:auto" onclick="vlbBuy(\'' + p.key + '\', this)">Choose ' + p.name + '</button></div>';
      }).join('') + '</div>' +
      '<div style="font-size:12px;color:var(--txt3);margin-top:10px;text-transform:none;letter-spacing:0">Larger organisation? <a href="mailto:hello@vorlana.com?subject=Vorlana%20Provider%20plan">Ask us about the Provider plan</a>. Payment is by card through Stripe; cancel any time.</div>' +
      '<div id="vlb-err" style="font-size:13px;color:#B91C1C;margin-top:8px"></div>';
  }
  window.vlbInterval = function (i) { INTERVAL = i; var c = $('vlb-cards'); if (c) c.innerHTML = cards(); };
  window.vlbPick = function () {
    if (typeof setModal === 'function') setModal('<h2>Choose your plan</h2><div id="vlb-cards">' + cards() + '</div><div class="modal-footer"><button class="btn btn-ghost" onclick="setCloseModal()">Not now</button></div>', 680);
  };
  window.vlbBuy = async function (plan, btn) {
    var e = $('vlb-err'); if (e) e.textContent = '';
    if (btn) { btn.disabled = true; btn.textContent = 'Opening Stripe…'; }
    try { var j = await api({ action: 'checkout', plan: plan, interval: INTERVAL }); location.href = j.url; }
    catch (x) { if (e) e.textContent = x.message; if (btn) { btn.disabled = false; btn.textContent = 'Try again'; } }
  };
  window.vlbPortal = async function (btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Opening…'; }
    try { var j = await api({ action: 'portal' }); location.href = j.url; }
    catch (x) { alert(x.message); if (btn) { btn.disabled = false; btn.textContent = 'Manage billing'; } }
  };

  // ── trial over, no plan ──
  function gate() {
    var old = $('vlb-gate'); if (old) old.remove();
    if (!selfServe() || !onFree() || daysLeft() > 0 || isSuper()) return;
    var g = document.createElement('div');
    g.id = 'vlb-gate';
    g.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(20,30,28,.55);display:flex;align-items:center;justify-content:center;padding:16px;overflow:auto';
    var ended = st().subscription_ended_at;
    g.innerHTML = '<div style="background:var(--bg,#FBF8F3);border-radius:16px;max-width:720px;width:100%;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.25)">' +
      '<h2 style="margin:0 0 6px">' + (ended ? 'Your subscription has ended' : 'Your free trial has ended') + '</h2>' +
      '<p style="margin:0 0 14px;color:var(--txt2);font-size:14px">Everything you’ve added is safe. ' + (isManager() ? 'Choose a plan to carry on using Vorlana.' : 'Ask your organisation’s owner or manager to choose a plan, then refresh this page.') + '</p>' +
      (isManager() ? '<div id="vlb-cards">' + cards() + '</div>' : '') +
      '<div style="margin-top:14px;font-size:12px;color:var(--txt3)">Questions? Email <a href="mailto:hello@vorlana.com">hello@vorlana.com</a>.</div></div>';
    document.body.appendChild(g);
  }

  // ── back from Stripe ──
  async function returned() {
    var p = new URLSearchParams(location.search), b = p.get('billing');
    if (!b) return;
    var clean = function () { p.delete('billing'); p.delete('session'); history.replaceState(history.state, '', location.pathname + '?' + p.toString() + location.hash); };
    if (b !== 'done') { clean(); return; }
    var sid = p.get('session'), tries = 0;
    while (tries++ < 6) {
      try {
        var j = await api({ action: 'confirm', session: sid });
        if (j.done) { clean(); alert('Thank you, you’re now on the ' + (j.plan_name || 'new') + ' plan.'); location.reload(); return; }
      } catch (e) { clean(); alert(e.message); return; }
      await new Promise(function (r) { setTimeout(r, 1500); });
    }
    clean(); alert('Your payment is being confirmed. Refresh in a minute and your plan will show.');
  }

  // ── Settings > Organisation ──
  function settingsCard(body) {
    if (!body || $('vlb-card')) return;
    var o = org() || {}, s = st(), plan = NAMES[o.plan || 'free'] || o.plan;
    var line = onFree() ? (selfServe() ? (daysLeft() > 0 ? 'Free trial, ' + daysLeft() + ' day' + (daysLeft() === 1 ? '' : 's') + ' left.' : 'Free trial ended.') : 'Free plan.')
      : plan + ' plan' + (s.billing_interval ? ', paid ' + (s.billing_interval === 'year' ? 'yearly' : 'monthly') : '') + (s.cancel_at_period_end ? '. Cancelled: it stays active until the end of the period you’ve paid for.' : '.');
    var btn = !isManager() ? '' : (s.stripe_customer && !onFree()) ? '<button class="btn btn-ghost btn-sm" type="button" onclick="vlbPortal(this)">Manage billing</button>'
      : onFree() ? '<button class="btn btn-p btn-sm" type="button" onclick="vlbPick()">Choose a plan</button>' : '';
    var card = document.createElement('div');
    card.id = 'vlb-card';
    card.style.cssText = 'margin-top:22px;padding-top:16px;border-top:1px solid var(--border);text-transform:none;letter-spacing:0';
    card.innerHTML = '<div style="font-size:15px;font-weight:700;color:var(--txt)">Plan and billing</div><div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:6px"><span style="font-size:13px;color:var(--txt2)">' + esc(line) + '</span>' + btn + '</div>' +
      (s.stripe_customer && isManager() ? '<div style="font-size:12px;color:var(--txt3);margin-top:4px">Change your card, download invoices or cancel. To switch plans, email hello@vorlana.com.</div>' : '');
    body.appendChild(card);
  }

  function ready(fn) { var t = 0; (function w() { if (typeof orgId !== 'undefined' && orgId && typeof currentOrg !== 'undefined' && currentOrg && typeof sb !== 'undefined' && sb) return fn(); if (++t < 150) setTimeout(w, 100); })(); }
  ready(function () {
    trialBar(); gate(); returned();
    var so = window.setOrgHTML;
    if (typeof so === 'function') window.setOrgHTML = function (body) { var r = so.apply(this, arguments); try { settingsCard(body); } catch (e) { console.warn('[billing]', e); } return r; };
  });
  if (window.__VORLANA_TEST) window.__vlbTest = { trialBar: trialBar, gate: gate, settingsCard: settingsCard, daysLeft: daysLeft };
})();
