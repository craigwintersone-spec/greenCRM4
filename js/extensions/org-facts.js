// js/extensions/org-facts.js — Settings > Organisation > "Details for bids": everything bids use about the organisation,
// in one place to check and correct. Filled from the public register (Charity Commission / Companies House, via
// Find that Charity) when the organisation is created, or with one tap here ("Is this you?"). Saved in settings.bid_facts.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var FIELDS = [
    ['From the register', [
      ['legal_name', 'Legal name'], ['charity_number', 'Charity number'], ['company_number', 'Company number'],
      ['address', 'Registered address'], ['postcode', 'Postcode'], ['website', 'Website'],
      ['year_end', 'Accounting year end', 'e.g. 31 March'], ['annual_income', 'Income, latest year (turnover)', 'e.g. £85,000'], ['annual_spend', 'Spending, latest year', 'e.g. 82,000'],
      ['income_previous', 'Income, the year before'], ['staff_count', 'Paid staff'], ['volunteer_count', 'Volunteers'], ['trustee_count', 'Trustees']]],
    ['For your bids', [
      ['contact', 'Main contact for funders', 'Name, role, email, phone'], ['venue', 'Main venue', 'Name and address where most sessions happen'],
      ['area', 'Area and wards you serve'], ['secured_income', 'Money secured for the next 12 months', 'e.g. 22,000 (0 if none)'], ['reserves', 'Unrestricted reserves', 'e.g. 9,000'],
      ['people_per_year', 'People you support in a typical year', 'e.g. 350'],
      ['signatories', 'Bank signatories', 'e.g. 2 unrelated trustees'], ['trustee_review', 'How often trustees review finances', 'e.g. every quarter']]]
  ];
  function st() { return (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.settings) || {}; }
  function facts() { return st().bid_facts || {}; }
  function isManager() { return /owner|admin|manager|super/i.test((typeof currentRole !== 'undefined' && currentRole) || '') || (typeof isSuperAdmin !== 'undefined' && isSuperAdmin); }
  async function api(body) {
    body.org_id = orgId;
    if (typeof _postJSON === 'function') return _postJSON('/api/org-lookup', body);
    var s = await sb.auth.getSession(), tok = s && s.data && s.data.session && s.data.session.access_token;
    var r = await fetch('/api/org-lookup', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tok || '') }, body: JSON.stringify(body) });
    return r.json();
  }
  function setLocal(newFacts, register) {
    if (typeof currentOrg === 'undefined' || !currentOrg) return;
    currentOrg.settings = Object.assign({}, currentOrg.settings || {});
    if (newFacts) currentOrg.settings.bid_facts = newFacts;
    if (register) currentOrg.settings.register = register;
  }

  function sourceLine() {
    var r = st().register, f = facts();
    if (r && r.id) return '<span style="color:#1E7B3C">✓ Filled from the public register' + (f.register_year ? ' (' + esc(f.register_year) + ')' : '') + '.</span> Correct anything that has changed — what you type is kept.';
    if (r && r.none) return 'Not found on the register. Fill in what you can — it saves typing on every bid.';
    return 'Fill these once and every bid uses them. <a href="#" onclick="vlFactsFind();return false" style="color:var(--em);font-weight:600">Find us on the register</a> to fill most of them in one tap.';
  }
  function cardHTML() {
    var f = facts(), edit = isManager();
    return '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap"><div style="font-size:15px;font-weight:700;color:var(--txt)">Details for bids</div>' +
        (edit ? '<a href="#" onclick="vlFactsFind();return false" style="font-size:12.5px;color:var(--em);font-weight:600">' + (st().register && st().register.id ? 'Look us up again' : 'Find us on the register') + '</a>' : '') + '</div>' +
      '<div style="font-size:12.5px;color:var(--txt3);margin:4px 0 12px">' + sourceLine() + '</div>' +
      '<div id="vlf-find"></div>' +
      FIELDS.map(function (g) {
        return '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:14px 0 6px">' + esc(g[0]) + '</div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px 14px">' +
          g[1].map(function (x) {
            return '<div><label style="text-transform:none;letter-spacing:0;font-size:12.5px;font-weight:600;color:var(--txt2);margin-bottom:3px">' + esc(x[1]) + '</label>' +
              '<input id="vlf-' + x[0] + '" value="' + esc(f[x[0]] || '') + '" placeholder="' + esc(x[2] || '') + '" ' + (edit ? '' : 'disabled') + ' style="font-size:13px"/></div>';
          }).join('') + '</div>';
      }).join('') +
      (edit ? '<div style="display:flex;gap:10px;align-items:center;margin-top:14px"><button class="btn btn-p btn-sm" type="button" onclick="vlFactsSave()">Save details</button><span id="vlf-msg" style="font-size:12px"></span></div>'
        : '<div style="font-size:12px;color:var(--txt3);margin-top:10px">Only an owner or manager can change these.</div>');
  }
  function paint(body) {
    body = body || $('st-body'); if (!body) return;
    var card = $('vlf-card');
    if (!card) { card = document.createElement('div'); card.id = 'vlf-card'; card.style.cssText = 'margin-top:22px;padding-top:16px;border-top:1px solid var(--border);text-transform:none;letter-spacing:0'; body.appendChild(card); }
    card.innerHTML = cardHTML();
  }

  window.vlFactsSave = async function () {
    var msg = $('vlf-msg'), say = function (t, bad) { if (msg) { msg.textContent = t; msg.style.color = bad ? '#B91C1C' : '#065F46'; } };
    say('Saving…');
    try {
      var r = await sb.from('organisations').select('settings').eq('id', orgId).limit(1);
      if (r.error) throw r.error;
      var s = (r.data && r.data[0] && r.data[0].settings) || {}, bf = Object.assign({}, s.bid_facts || {});
      FIELDS.forEach(function (g) { g[1].forEach(function (x) { var el = $('vlf-' + x[0]); if (!el) return; var v = el.value.trim(); if (v) bf[x[0]] = v; else delete bf[x[0]]; }); });
      s.bid_facts = bf;
      var u = await sb.from('organisations').update({ settings: s }).eq('id', orgId);
      if (u.error) throw u.error;
      setLocal(bf); say('Saved.');
    } catch (e) { say('Couldn’t save: ' + (e.message || e), true); }
  };

  // "Is this you?"
  window.vlFactsFind = async function (number) {
    var box = $('vlf-find'); if (!box) { if (typeof vlOrgFactsOpen === 'function') vlOrgFactsOpen(true); return; }
    box.innerHTML = '<div style="font-size:13px;color:var(--txt3);margin-bottom:10px"><span class="bd-spin"></span> Searching the register…</div>';
    var j = null; try { j = await api({ action: 'search', number: number || '', name: (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || '' }); } catch (e) { j = null; }
    var m = (j && j.matches) || [];
    box.innerHTML = '<div style="background:#F5F5F7;border-radius:12px;padding:12px 14px;margin-bottom:12px">' +
      (m.length ? '<div style="font-size:14px;font-weight:600;margin-bottom:6px">Is this you?</div>' + m.map(function (x) {
        return '<div style="display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-top:1px solid #E8E8ED"><div><div style="font-size:13.5px;font-weight:600">' + esc(x.name) + (x.active === false ? ' <span style="color:#B42318;font-weight:400">(removed)</span>' : '') + '</div><div style="font-size:12px;color:var(--txt3)">' + esc(x.summary) + '</div></div>' +
          '<button class="btn btn-p btn-sm" type="button" onclick="vlFactsPick(\'' + esc(x.id) + '\')">This is us</button></div>';
      }).join('') : '<div style="font-size:13px;color:var(--txt2)">We couldn’t find you by name.</div>') +
      '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center"><input id="vlf-num" placeholder="Charity or company number" style="max-width:220px;font-size:13px"/><button class="btn btn-ghost btn-sm" type="button" onclick="vlFactsFind(($(\'vlf-num\')||{}).value)">Search</button>' +
      '<a href="#" onclick="vlFactsNone();return false" style="font-size:12.5px;color:var(--txt3)">We’re not registered</a></div></div>';
  };
  window.vlFactsPick = async function (id) {
    var box = $('vlf-find'); if (box) box.innerHTML = '<div style="font-size:13px;color:var(--txt3);margin-bottom:10px"><span class="bd-spin"></span> Filling in your details…</div>';
    try {
      var j = await api({ action: 'save', id: id });
      if (!j || !j.ok) throw new Error((j && j.error) || 'failed');
      setLocal(j.facts, { id: id, name: j.name, checked_at: new Date().toISOString() });
      paint();
    } catch (e) { if (box) box.innerHTML = '<div class="alert alert-warn" style="margin:0 0 12px">Couldn’t fill them in: ' + esc(e.message || e) + '</div>'; }
  };
  window.vlFactsNone = async function () {
    try { await api({ action: 'none' }); } catch (e) { /* fine */ }
    setLocal(null, { none: true, checked_at: new Date().toISOString() }); paint();
  };

  // Open Settings > Organisation at this card (from Find funding)
  window.vlOrgFactsOpen = function (find) {
    if (typeof go === 'function') go('settings');
    setTimeout(function () {
      if (typeof setOpen === 'function') { try { setOpen('org'); } catch (e) { /* older settings */ } }
      setTimeout(function () { var c = $('vlf-card'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); if (find) vlFactsFind(); }, 250);
    }, 150);
  };

  // A nudge on Find funding until the register has been checked
  function nudge() {
    var side = document.getElementById('bd-nudges'); if (!side) return;
    var s = st(), old = $('vlf-nudge');
    if ((s.register && (s.register.id || s.register.none)) || facts().charity_number || facts().company_number || !isManager()) { if (old) old.remove(); return; }
    if (old) return;
    var d = document.createElement('div'); d.id = 'vlf-nudge'; d.className = 'card'; d.style.cssText = 'margin-bottom:14px;padding:14px 18px;display:flex;gap:14px;align-items:center;justify-content:space-between;flex-wrap:wrap';
    d.innerHTML = '<div style="min-width:0;flex:1"><div style="font-size:14px;font-weight:650">Fewer gaps in every bid</div><div style="font-size:12.5px;color:var(--txt3);margin-top:2px">We can fill your charity number, address, turnover, staff and volunteers from the public register in one tap.</div></div>' +
      '<button class="btn btn-p btn-sm" type="button" onclick="vlOrgFactsOpen(true)">Find us</button>';
    side.insertBefore(d, side.firstChild);
  }

  (function wait(t) {
    if (typeof sb !== 'undefined' && typeof go === 'function' && typeof orgId !== 'undefined' && orgId && typeof currentOrg !== 'undefined' && currentOrg) {
      var so = window.setOrgHTML;
      if (typeof so === 'function') window.setOrgHTML = function (body) { var r = so.apply(this, arguments); try { paint(body); } catch (e) { console.warn('[org-facts]', e); } return r; };
      var g = window.go;
      window.go = function (p) { var r = g.apply(this, arguments); if (p === 'bd') setTimeout(nudge, 50); return r; };
      if (document.querySelector('#page-bd.active')) nudge();
      return;
    }
    if (t < 150) setTimeout(function () { wait(t + 1); }, 100);
  })(0);
  if (window.__VORLANA_TEST) window.__factsTest = { paint: paint, nudge: nudge, FIELDS: FIELDS };
})();
