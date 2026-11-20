// js/extensions/bookings.js — bookings and payments, staff side
// On the event: a price (blank = free), optional concession price and start time. Every upcoming event is bookable unless switched off.
// On the Events page: a "Booked" column; click it for who's coming, mark arrivals, add a phone or cash booking, cancel.
// In Settings > Events: connect Stripe once, and copy the "What's on" link for the organisation's website.
// Talks to api/bookings.js. Depends on: modals.js (openAddEv/openEditEv/saveEv), render.js (renderEvents), settings.js (setModal)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var TXT = 'text-transform:none;letter-spacing:0';
  var money = function (p) { return '\u00a3' + ((+p || 0) / 100).toFixed((+p || 0) % 100 ? 2 : 0); };
  var COUNTS = {}, PAY = { checked: false, connected: false, ready: false }, SITE_TOKEN = null;

  async function api(body) {
    var tok = '';
    try { var s = await sb.auth.getSession(); tok = (s && s.data && s.data.session && s.data.session.access_token) || ''; } catch (e) { /* not signed in */ }
    var r = await fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(body) });
    var j = await r.json().catch(function () { return { ok: false, error: 'Something went wrong.' }; });
    if (!j.ok) throw new Error(j.error || 'Something went wrong.');
    return j;
  }
  async function payStatus(force) {
    if (PAY.checked && !force) return PAY;
    try { var j = await api({ action: 'connect_status', org_id: String(orgId) }); PAY = { checked: true, connected: !!j.connected, ready: !!j.ready }; }
    catch (e) { PAY = { checked: true, connected: false, ready: false, error: e.message }; }
    return PAY;
  }
  async function siteToken() {
    if (SITE_TOKEN) return SITE_TOKEN;
    try { var r = await sb.from('volunteer_sites').select('public_token').eq('org_id', orgId).limit(1); SITE_TOKEN = r && r.data && r.data[0] && r.data[0].public_token; } catch (e) { SITE_TOKEN = null; }
    return SITE_TOKEN;
  }

  // ══ the event screen: a price, and that's it ══
  var CUR = null;
  function evRow(ev) {
    var p = ev && ev.price_pence ? (ev.price_pence / 100).toFixed(2).replace(/\.00$/, '') : '', c = ev && ev.concession_pence ? (ev.concession_pence / 100).toFixed(2).replace(/\.00$/, '') : '';
    return '<label>Bookings</label>' +
      '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:12px 14px">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;font-size:14px;color:var(--txt);' + TXT + '"><input type="checkbox" id="vlbk-on" ' + (!ev || ev.bookable !== false ? 'checked' : '') + ' style="width:18px;height:18px;margin:0;flex:none"/><span>People can book this event on your What\u2019s on page</span></div>' +
        '<div class="form-grid-2" id="vlbk-fields"><div class="form-row" style="margin:0"><label style="' + TXT + '">Price (\u00a3)</label><input id="vlbk-price" inputmode="decimal" placeholder="Free" value="' + esc(p) + '"/></div>' +
          '<div class="form-row" style="margin:0"><label style="' + TXT + '">Start time</label><input id="vlbk-time" type="time" value="' + esc((ev && ev.start_time) || '') + '"/></div></div>' +
        '<div style="margin-top:8px;font-size:13px;color:var(--txt2);' + TXT + '"><a href="#" id="vlbk-conc-link"' + (c ? ' style="display:none"' : '') + '>+ Add a concession price</a><span id="vlbk-conc-box"' + (c ? '' : ' style="display:none"') + '>Concessions \u00a3 <input id="vlbk-conc" inputmode="decimal" value="' + esc(c) + '" style="width:90px;display:inline-block;margin-left:4px"/></span></div>' +
        '<div id="vlbk-warn" style="display:none;font-size:12px;color:#8A5A00;background:#FFF6E0;border-radius:8px;padding:7px 10px;margin-top:10px;' + TXT + '"></div>' +
        '<div style="font-size:12px;color:var(--txt3);margin-top:8px;' + TXT + '">Capacity sets the places. When it\u2019s full, people join a waiting list. Booking closes at the start time.</div>' +
      '</div>';
  }
  function readPence(id) { var v = String(($(id) || {}).value || '').replace(/[\u00a3,\s]/g, ''); if (!v) return null; var n = Math.round(parseFloat(v) * 100); return n > 0 ? n : null; }
  function warn() {
    var w = $('vlbk-warn'); if (!w) return;
    var paid = !!readPence('vlbk-price') && $('vlbk-on').checked;
    if (paid && PAY.checked && !PAY.ready) { w.style.display = ''; w.innerHTML = 'To take payments, connect Stripe in Settings, then Events. Until then, people can\u2019t book this event online.'; }
    else w.style.display = 'none';
  }
  function injectEventRow(ev) {
    var modal = $('modal-ev'); if (!modal) return;
    var old = $('vlbk-wrap'); if (old) old.remove();
    var wrap = document.createElement('div'); wrap.id = 'vlbk-wrap'; wrap.className = 'form-row'; wrap.innerHTML = evRow(ev);
    var after = $('vlcie-wrap') || modal.querySelector('[data-ev-contracts]'), footer = modal.querySelector('.modal-footer');
    if (after) after.insertAdjacentElement('afterend', wrap); else if (footer) footer.parentNode.insertBefore(wrap, footer); else return;
    CUR = ev ? ev.id : null;
    $('vlbk-conc-link').addEventListener('click', function (e) { e.preventDefault(); this.style.display = 'none'; $('vlbk-conc-box').style.display = ''; $('vlbk-conc').focus(); });
    ['vlbk-price', 'vlbk-on'].forEach(function (id) { $(id).addEventListener('input', warn); $(id).addEventListener('change', warn); });
    payStatus().then(warn);
  }
  function wireEventModal() {
    var oa = window.openAddEv, oe = window.openEditEv, os = window.saveEv;
    if (typeof oa === 'function' && !oa._bk) { window.openAddEv = function () { var r = oa.apply(this, arguments); setTimeout(function () { injectEventRow(null); }, 20); return r; }; window.openAddEv._bk = true; }
    if (typeof oe === 'function' && !oe._bk) { window.openEditEv = function (id) { var r = oe.apply(this, arguments); setTimeout(function () { injectEventRow((DB.events || []).filter(function (e) { return String(e.id) === String(id); })[0] || null); }, 20); return r; }; window.openEditEv._bk = true; }
    if (typeof os === 'function' && !os._bk) {
      window.saveEv = function () {
        var extra = $('vlbk-wrap') ? { bookable: !!$('vlbk-on').checked, price_pence: readPence('vlbk-price'), concession_pence: readPence('vlbk-conc'), start_time: (($('vlbk-time') || {}).value || '') || null } : null;
        var oi = window.sbInsert, ou = window.sbUpdate, missing = false;
        var wrapFn = function (fn) { return async function (table, payload, id) {
          if (table !== 'events' || !extra) return fn.apply(null, arguments);
          var p = Object.assign({}, payload, extra);
          try { return await (id === undefined ? fn(table, p) : fn(table, p, id)); }
          catch (e) { if (!/bookable|price_pence|concession_pence|start_time|column/i.test((e && e.message) || '')) throw e; missing = true; return id === undefined ? fn(table, payload) : fn(table, payload, id); }
        }; };
        window.sbInsert = wrapFn(oi); window.sbUpdate = wrapFn(ou);
        var done = function () { window.sbInsert = oi; window.sbUpdate = ou; if (missing) alert('The event is saved, but its price and booking settings could not be. Run bookings.sql in Supabase first.'); };
        var r; try { r = os.apply(this, arguments); } catch (e) { done(); throw e; }
        if (r && typeof r.then === 'function') r.then(done, done); else setTimeout(done, 2500);
        return r;
      };
      window.saveEv._bk = true;
    }
  }

  // ══ the Events page: a Booked column ══
  async function loadCounts() { try { var j = await api({ action: 'staff_counts', org_id: String(orgId) }); COUNTS = j.counts || {}; } catch (e) { COUNTS = {}; } }
  function paintColumn() {
    var tbl = document.querySelector('#ev-list table'); if (!tbl) return false;
    var head = tbl.querySelector('thead tr'); if (!head) return false;
    if (head.querySelector('.vlbk-th')) return true;
    var ths = [].slice.call(head.querySelectorAll('th')), fbIdx = ths.findIndex(function (t) { return t.textContent.trim() === 'Feedback'; }), idx = fbIdx >= 0 ? fbIdx : 3;
    var th = document.createElement('th'); th.className = 'vlbk-th'; th.textContent = 'Booked'; th.style.textAlign = 'center'; ths[idx].insertAdjacentElement('afterend', th);
    tbl.querySelectorAll('tbody tr').forEach(function (tr) {
      var edit = tr.querySelector('button[onclick^="openEditEv"]'), m = edit && /openEditEv\('([^']+)'\)/.exec(edit.getAttribute('onclick') || '');
      var td = document.createElement('td'); td.style.textAlign = 'center';
      var c = m && COUNTS[m[1]];
      td.innerHTML = c && (c.booked || c.waitlist) ? '<a href="#" onclick="vlbkOpen(\'' + esc(m[1]) + '\');return false" style="font-weight:600" title="Who\u2019s coming">' + c.people + (c.money ? ' \u00b7 ' + money(c.money) : '') + '</a>' + (c.waitlist ? '<div style="font-size:11px;color:var(--txt3)">+' + c.waitlist + ' waiting</div>' : '')
        : (m ? '<a href="#" onclick="vlbkOpen(\'' + esc(m[1]) + '\');return false" style="color:var(--txt3)">\u2014</a>' : '\u2014');
      if (tr.children[idx]) tr.children[idx].insertAdjacentElement('afterend', td);
    });
    return true;
  }
  function paintSoon() { var t = 0; (function w() { var ok = document.querySelector('#ev-list th.civ-th') || t > 8; if (ok && paintColumn()) return; if (++t < 20) setTimeout(w, 150); })(); }

  // ══ who's coming ══
  var WHO = null;
  function whoHTML() {
    var ev = WHO.event, rows = WHO.bookings, past = ev.date < new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
    var live = rows.filter(function (b) { return b.status === 'booked'; }), ppl = function (b) { return (+b.adults || 0) + (+b.children || 0); };
    var booked = live.reduce(function (a, b) { return a + ppl(b); }, 0), arrived = live.filter(function (b) { return b.arrived_at; }).reduce(function (a, b) { return a + ppl(b); }, 0);
    var takenMoney = live.filter(function (b) { return b.paid; }).reduce(function (a, b) { return a + (+b.amount_pence || 0); }, 0), waiting = rows.filter(function (b) { return b.status === 'waitlist'; });
    var line = booked + ' booked' + (ev.left != null ? ' \u00b7 ' + ev.left + ' place' + (ev.left === 1 ? '' : 's') + ' left' : '') + (takenMoney ? ' \u00b7 ' + money(takenMoney) : '') + (arrived ? ' \u00b7 ' + arrived + ' arrived' : '') + (past && booked > arrived ? ' \u00b7 ' + (booked - arrived) + ' didn\u2019t come' : '') + (waiting.length ? ' \u00b7 ' + waiting.reduce(function (a, b) { return a + ppl(b); }, 0) + ' waiting' : '');
    var status = function (b) {
      if (b.status === 'cancelled') return '<span style="color:var(--txt3)">Cancelled' + (b.paid ? ' \u00b7 refund due' : '') + '</span>';
      if (b.status === 'waitlist') return '<span style="color:#8A5A00">Waiting list</span>';
      if (b.arrived_at) return '<span style="color:#065F46">Arrived</span>';
      return '<span>' + (b.paid ? (b.method === 'cash' ? 'Paid cash' : 'Paid') : (+b.amount_pence ? 'Pay on the day' : 'Booked')) + '</span>';
    };
    return '<h2>' + esc(ev.name) + '</h2><div style="font-size:13px;color:var(--txt2);margin:-6px 0 12px;' + TXT + '">' + esc(line) + '</div>' +
      '<div style="max-height:52vh;overflow:auto">' + (rows.length ? rows.map(function (b) {
        var kids = +b.children || 0;
        return '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border);font-size:13px;' + TXT + '"><div style="flex:1;min-width:0"><div style="font-weight:600;color:var(--txt)">' + esc(b.name) + '</div><div style="color:var(--txt3);font-size:12px">' + (+b.adults || 0) + ' adult' + (+b.adults === 1 ? '' : 's') + (kids ? ', ' + kids + ' child' + (kids === 1 ? '' : 'ren') : '') + (b.phone ? ' \u00b7 ' + esc(b.phone) : '') + (b.email ? ' \u00b7 ' + esc(b.email) : '') + '</div></div>' +
          '<div style="white-space:nowrap">' + status(b) + '</div>' +
          (b.status === 'booked' && !b.arrived_at ? '<button class="btn btn-ghost btn-sm" onclick="vlbkArrive(' + b.id + ')">Arrived</button>' : '') +
          (b.status === 'booked' || b.status === 'waitlist' ? '<button class="btn btn-ghost btn-sm" onclick="vlbkCancel(' + b.id + ')" title="Cancel this booking">&times;</button>' : '') + '</div>';
      }).join('') : '<div style="font-size:13px;color:var(--txt3);padding:10px 0;' + TXT + '">No bookings yet.</div>') + '</div>' +
      '<details style="margin-top:12px"><summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--em2);' + TXT + '">+ Add a booking (phone, walk-in or cash)</summary>' +
        '<div class="form-grid-2" style="margin-top:8px"><div class="form-row"><label>Name</label><input id="vlbk-a-name"/></div><div class="form-row"><label>Phone or email</label><input id="vlbk-a-contact"/></div></div>' +
        '<div class="form-grid-2"><div class="form-row"><label>Adults</label><input id="vlbk-a-ad" type="number" min="1" value="1"/></div><div class="form-row"><label>Children</label><input id="vlbk-a-ch" type="number" min="0" value="0"/></div></div>' +
        (ev.price ? '<div style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:8px;' + TXT + '"><input type="checkbox" id="vlbk-a-paid" style="width:16px;height:16px;margin:0"/><span>Paid cash \u00a3</span><input id="vlbk-a-amt" inputmode="decimal" style="width:80px" value="' + (ev.price / 100) + '"/></div>' : '') +
        '<div id="vlbk-a-err" style="font-size:12px;color:#B91C1C;min-height:14px"></div><button class="btn btn-p btn-sm" onclick="vlbkAdd()">Add booking</button></details>' +
      '<div class="modal-footer"><button class="btn btn-p" onclick="setCloseModal()">Close</button></div>';
  }
  async function refreshWho() { var j = await api({ action: 'staff_list', event_id: WHO.id }); WHO.event = j.event; WHO.bookings = j.bookings || []; setModal(whoHTML(), 600); }
  window.vlbkOpen = async function (eventId) {
    var ev = (DB.events || []).filter(function (e) { return String(e.id) === String(eventId); })[0];
    setModal('<h2>' + esc(ev ? ev.name : 'Event') + '</h2><div class="cxp-s">Loading bookings\u2026</div>');
    try { WHO = { id: String(eventId) }; await refreshWho(); }
    catch (e) { setModal('<h2>' + esc(ev ? ev.name : 'Event') + '</h2><div class="alert alert-warn">' + esc(e.message) + '</div><div class="modal-footer"><button class="btn btn-p" onclick="setCloseModal()">Close</button></div>'); }
  };
  window.vlbkArrive = async function (id) { try { await api({ action: 'staff_arrive', event_id: WHO.id, id: id }); await refreshWho(); afterChange(); } catch (e) { alert(e.message); } };
  window.vlbkCancel = async function (id) {
    if (!confirm('Cancel this booking? Their place goes back on sale.')) return;
    try { var j = await api({ action: 'staff_cancel', event_id: WHO.id, id: id }); if (j.refund) alert('Cancelled. They paid online, so refund them from your Stripe dashboard.'); await refreshWho(); afterChange(); } catch (e) { alert(e.message); }
  };
  window.vlbkAdd = async function () {
    var err = $('vlbk-a-err'), name = $('vlbk-a-name').value.trim(), contact = $('vlbk-a-contact').value.trim(); err.textContent = '';
    if (!name) { err.textContent = 'Add their name.'; return; }
    var isEmail = contact.indexOf('@') > 0, paidBox = $('vlbk-a-paid');
    try {
      await api({ action: 'staff_add', event_id: WHO.id, name: name, email: isEmail ? contact : '', phone: isEmail ? '' : contact, adults: +$('vlbk-a-ad').value || 1, children: +$('vlbk-a-ch').value || 0,
        method: paidBox && paidBox.checked ? 'cash' : 'staff', paid: !!(paidBox && paidBox.checked), amount: paidBox && paidBox.checked ? parseFloat(String($('vlbk-a-amt').value).replace(/[\u00a3,]/g, '')) || 0 : 0 });
      await refreshWho(); afterChange();
    } catch (e) { err.textContent = e.message; }
  };
  function afterChange() { loadCounts().then(function () { var th = document.querySelector('#ev-list th.vlbk-th'); if (th && typeof renderEvents === 'function') renderEvents(); }); }

  // ══ Settings > Events: connect Stripe once, copy the What's on link ══
  async function settingsCard() {
    var body = $('st-body'); if (!body || (typeof _setSection !== 'undefined' && _setSection !== 'feedback')) return;
    var old = $('vlbk-card'); if (old) old.remove();
    body.insertAdjacentHTML('afterbegin', '<div id="vlbk-card" style="margin:0 0 26px;padding-bottom:18px;border-bottom:2px solid var(--border)"><div style="font-size:15px;font-weight:700;color:var(--txt);' + TXT + '">Bookings and payments</div><div id="vlbk-card-body" style="font-size:13px;color:var(--txt3);' + TXT + '">Loading\u2026</div></div>');
    var st = await payStatus(true), tok = await siteToken(), link = tok ? location.origin + '/whats-on.html?t=' + encodeURIComponent(tok) : '';
    var pay = st.ready ? '<span style="color:#065F46;font-weight:600">\u2713 Stripe connected. Payments go straight to your bank.</span>'
      : st.connected ? 'Stripe is connected but not finished. <button class="btn btn-p btn-sm" onclick="vlbkConnect()">Finish setting up Stripe</button>'
      : 'Free events can be booked now. To take payments for paid events, connect your own Stripe account (about 5 minutes). <button class="btn btn-p btn-sm" onclick="vlbkConnect()">Connect Stripe</button>';
    var b = $('vlbk-card-body'); if (!b) return;
    b.innerHTML = '<div style="line-height:1.6;margin:4px 0 12px;color:var(--txt2)">' + pay + '</div>' +
      (link ? '<div style="font-size:13px;color:var(--txt);font-weight:600;margin-bottom:4px">Your What\u2019s on page</div><div style="font-size:12px;color:var(--txt3);margin-bottom:6px">Every upcoming event appears here by itself. Put this on your website once.</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap"><input readonly value="' + esc(link) + '" style="flex:1;min-width:220px;font-size:12px" onclick="this.select()"/>' +
        '<button class="btn btn-ghost btn-sm" onclick="vlbkCopy(\'link\')">Copy link</button><button class="btn btn-ghost btn-sm" onclick="vlbkCopy(\'button\')">Copy a Book now button</button><button class="btn btn-ghost btn-sm" onclick="vlbkCopy(\'embed\')">Copy the full list for your site</button>' +
        '<a class="btn btn-ghost btn-sm" href="' + esc(link) + '" target="_blank" rel="noopener">Open</a></div>'
        : '<div style="font-size:12px;color:var(--txt3)">Create your sign-in QR on the Events page first; your What\u2019s on page uses the same link.</div>');
    b.dataset.link = link;
  }
  window.vlbkCopy = function (kind) {
    var link = ($('vlbk-card-body') || {}).dataset ? $('vlbk-card-body').dataset.link : '';
    var colour = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.brand_color) || '#1F6F6D';
    var text = kind === 'button' ? '<a href="' + link + '" style="display:inline-block;background:' + colour + ';color:#fff;padding:12px 22px;border-radius:10px;font-weight:600;text-decoration:none;font-family:inherit">Book now</a>'
      : kind === 'embed' ? '<iframe src="' + link + '" title="What\u2019s on" style="width:100%;min-height:900px;border:0" loading="lazy"></iframe>' : link;
    (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(text) : Promise.reject()).then(function () { alert('Copied. Paste it into your website.'); }, function () { prompt('Copy this:', text); });
  };
  window.vlbkConnect = async function () {
    try { var j = await api({ action: 'connect', org_id: String(orgId) }); location.href = j.url; } catch (e) { alert('Couldn\u2019t start Stripe: ' + e.message); }
  };

  function ready(fn) { var t = 0; (function w() { if (typeof openAddEv === 'function' && typeof saveEv === 'function' && typeof renderEvents === 'function' && typeof renderFeedbackQuestionsCard === 'function' && typeof sb !== 'undefined') return fn(); if (++t < 100) setTimeout(w, 100); })(); }
  ready(function () {
    wireEventModal();
    var re = window.renderEvents;
    window.renderEvents = function () { var r = re.apply(this, arguments); loadCounts().then(paintSoon); return r; };
    var rf = window.renderFeedbackQuestionsCard;
    window.renderFeedbackQuestionsCard = function () { var r = rf.apply(this, arguments); try { settingsCard(); } catch (e) { console.warn('[bookings]', e); } return r; };
    if (/[?&]stripe=(done|again)/.test(location.search)) payStatus(true).then(function (s) { alert(s.ready ? 'Stripe is connected. You can now take payments for events.' : 'Stripe isn\u2019t finished yet. You can carry on from Settings, then Events.'); });
  });
  if (window.__VORLANA_TEST) window.__bkTest = { settingsCard: settingsCard, readPence: readPence, whoHTML: function (w) { WHO = w; return whoHTML(); }, counts: function (c) { COUNTS = c; }, paintColumn: paintColumn };
})();
