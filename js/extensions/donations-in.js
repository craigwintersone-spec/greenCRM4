// js/extensions/donations-in.js — donations arrive by themselves (demo account only, with ai-office.js)
//   • Connect JustGiving, Stripe or PayPal once (read-only); new gifts are synced by /api/donations
//     when the app loads (at most hourly) or on "Sync now". The login details stay on the server.
//   • Import the CSV export from any platform or bank: columns are matched for you, duplicates skipped.
//   • A thank-you is drafted ahead for each new gift, so thanking is one tap (see money-auto.js for the inbox).
// Needs ai-office.sql.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var A = function () { return window.vlAO; };
  var LINKS = null, syncing = false, msg = '', openForm = null, CSV = null;

  async function api(body) {
    var tok = '';
    try { var s = await sb.auth.getSession(); tok = (s && s.data && s.data.session && s.data.session.access_token) || ''; } catch (e) { /* signed out */ }
    var r = await fetch('/api/donations', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: JSON.stringify(Object.assign({ org_id: A().oid() }, body)) });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok || j.ok === false) throw new Error(j.error || ('Error ' + r.status));
    return j;
  }
  var onPage = function () { var p = $('page-donations'); return !!(p && p.classList.contains('active')); };
  var repaint = function () { if (onPage()) A().renderDonations(); };
  async function reload() {
    var rows = await A().q('donations'); if (rows === null) return;
    var S = A().S; S.don = rows.concat(S.don.filter(function (d) { return d._demo || /^mem-/.test(String(d.id)); }));
  }
  async function sync(force) {
    if (syncing || !A().S.sql.don) return; syncing = true; if (force) repaint();
    try {
      var j = await api({ action: 'sync', force: !!force });
      LINKS = j.links || LINKS || [];
      if (j.added) await reload();
      if (force) msg = j.added ? j.added + ' new gift' + (j.added === 1 ? '' : 's') + ' brought in.' : ((LINKS || []).length ? 'Up to date: no new gifts.' : '');
      (j.results || []).forEach(function (r) { if (r.error) msg = PROV[r.provider].name + ': ' + r.error; });
      if (j.added && typeof window.vlPaintChecks === 'function') window.vlPaintChecks();
    } catch (e) { if (force) msg = e.message; if (LINKS === null) LINKS = []; }
    syncing = false; repaint();
  }
  window.vlDonSyncAuto = function () { return sync(false); };

  var PROV = {
    justgiving: { name: 'JustGiving', help: 'In your JustGiving developer account, copy the app ID and ask JustGiving to put it on the Data API plan. The charity ID is on the Settings tab of your JustGiving charity account. Use the charity account’s own login.',
      fields: [['app_id', 'App ID'], ['charity_id', 'Charity ID (not your charity number)'], ['email', 'Charity account email'], ['password', 'Charity account password', 'password']] },
    stripe: { name: 'Stripe', help: 'In Stripe: Developers → API keys → Create restricted key. Set Charges to Read and everything else to None, then paste the key (it starts rk_live_). With it Vorlana can only read gifts, never take or move money.',
      fields: [['key', 'Restricted key (rk_live_…)', 'password']] },
    paypal: { name: 'PayPal', help: 'At developer.paypal.com: Apps & Credentials → Live → Create app, tick Transaction search, then copy the client ID and secret. Gifts can take a few hours to show in PayPal’s reports.',
      fields: [['client_id', 'Client ID'], ['secret', 'Secret', 'password']] }
  };

  window.vlDonTop = function () {
    var a = A(), esc = a.esc;
    if (!a.S.sql.don) return '<div class="card" style="margin-bottom:14px"><div class="card-title">Bring donations in</div><div style="font-size:13px;color:#B7791F">Run ai-office.sql in Supabase to import CSVs and connect JustGiving, Stripe or PayPal.</div></div>';
    if (LINKS === null) { LINKS = []; api({ action: 'status' }).then(function (j) { LINKS = j.links || []; repaint(); }, function (e) { msg = /ai-office/.test(e.message) ? 'Run the latest ai-office.sql in Supabase to connect accounts.' : ''; repaint(); }); }
    var by = {}; LINKS.forEach(function (l) { by[l.provider] = l; });
    var chips = Object.keys(PROV).map(function (k) {
      var l = by[k];
      return '<div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;min-width:200px;flex:1"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px"><b>' + PROV[k].name + '</b>' +
        (l ? '<span class="badge" style="background:' + (l.last_error ? '#FDECEC;color:#B42318' : '#E7F6EC;color:#1E7B3C') + '">' + (l.last_error ? 'Needs a look' : 'Connected') + '</span>' : '') + '</div>' +
        (l ? '<div style="font-size:12px;color:var(--txt3);margin:4px 0 8px">' + esc(l.hint) + (l.last_sync_at ? ' · synced ' + esc(a.fmt(l.last_sync_at)) : '') + '</div>' + (l.last_error ? '<div style="font-size:12px;color:#B42318;margin-bottom:8px">' + esc(l.last_error) + '</div>' : '') +
              '<button class="btn btn-ghost btn-sm" onclick="vlDonUnlink(\'' + k + '\')">Disconnect</button>'
           : '<div style="font-size:12px;color:var(--txt3);margin:4px 0 8px">Not connected</div><button class="btn btn-ghost btn-sm" onclick="vlDonLinkForm(\'' + k + '\')">Connect</button>') + '</div>';
    }).join('');
    var form = '';
    if (openForm) {
      var P = PROV[openForm];
      form = '<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:10px;background:var(--bg)"><div style="font-weight:700;margin-bottom:4px">Connect ' + P.name + '</div><div style="font-size:12px;color:var(--txt2);margin-bottom:10px">' + esc(P.help) + '</div>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' + P.fields.map(function (f) { return '<input id="ao-lk-' + f[0] + '" type="' + (f[2] || 'text') + '" placeholder="' + esc(f[1]) + '" autocomplete="off" style="flex:1;min-width:180px"/>'; }).join('') + '</div>' +
        (openForm === 'paypal' ? '<label style="display:flex;gap:6px;align-items:center;font-size:12px;margin-top:6px"><input type="checkbox" id="ao-lk-sandbox" style="width:auto"/> Sandbox (testing) account</label>' : '') +
        '<div style="display:flex;gap:6px;margin-top:10px"><button class="btn btn-p btn-sm" onclick="vlDonLink()">Check and connect</button><button class="btn btn-ghost btn-sm" onclick="vlDonLinkForm(null)">Cancel</button></div>' +
        '<div style="font-size:11px;color:var(--txt3);margin-top:8px">The details are checked with ' + P.name + ', then kept on Vorlana’s server only. They are never shown again or sent to anyone’s browser.</div></div>';
    }
    return '<div class="card" style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div class="card-title" style="margin:0">Bring donations in</div>' +
      '<div style="display:flex;gap:6px"><label class="btn btn-ghost btn-sm" style="cursor:pointer">Import CSV<input type="file" accept=".csv,text/csv" style="display:none" onchange="vlDonCSVPick(this)"/></label>' +
      (LINKS.length ? '<button class="btn btn-p btn-sm" onclick="vlDonSync()"' + (syncing ? ' disabled' : '') + '>' + (syncing ? 'Syncing…' : 'Sync now') + '</button>' : '') + '</div></div>' +
      '<div style="font-size:13px;color:var(--txt2);margin:6px 0 10px">Connect your giving accounts once and new gifts come in by themselves. Or import the CSV export from any platform: JustGiving, Enthuse, CAF Donate, Give as you Live, PayPal, Stripe or your bank.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' + chips + '</div>' + form +
      (msg ? '<div id="ao-don-msg" style="font-size:13px;margin-top:10px;color:var(--txt2)">' + esc(msg) + '</div>' : '') + '<div id="ao-csv"></div></div>';
  };
  window.vlDonAfter = function () { paintCSV(); };
  window.vlDonLinkForm = function (k) { openForm = k; msg = ''; repaint(); };
  window.vlDonLink = async function () {
    var k = openForm, cfg = {}; PROV[k].fields.forEach(function (f) { cfg[f[0]] = ($('ao-lk-' + f[0]).value || '').trim(); });
    if ($('ao-lk-sandbox')) cfg.sandbox = $('ao-lk-sandbox').checked;
    msg = 'Checking with ' + PROV[k].name + '…'; openForm = null; repaint();
    try {
      var j = await api({ action: 'connect', provider: k, config: cfg });
      LINKS = j.links || []; await reload();
      msg = PROV[k].name + ' connected. ' + (j.error ? 'The first sync hit a problem: ' + j.error : j.added + ' gift' + (j.added === 1 ? '' : 's') + ' from the last year brought in.');
    } catch (e) { msg = e.message; openForm = k; }
    repaint();
  };
  window.vlDonUnlink = async function (k) {
    if (!confirm('Disconnect ' + PROV[k].name + '? Gifts already brought in stay.')) return;
    try { var j = await api({ action: 'disconnect', provider: k }); LINKS = j.links || []; msg = PROV[k].name + ' disconnected.'; } catch (e) { msg = e.message; }
    repaint();
  };
  window.vlDonSync = function () { msg = ''; return sync(true); };

  // ── CSV from any platform ─────────────────────────────────────
  function parseCSV(text) {
    text = String(text || '').replace(/^﻿/, '');
    var first = text.split(/\r?\n/)[0] || '', sep = (first.split(';').length > first.split(',').length) ? ';' : (first.split('\t').length > first.split(',').length ? '\t' : ',');
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === sep) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.some(function (x) { return x.trim(); })) rows.push(row); row = []; }
      else cur += c;
    }
    row.push(cur); if (row.some(function (x) { return x.trim(); })) rows.push(row);
    return rows;
  }
  window.vlParseCSV = parseCSV;
  // column names the common platforms use, best first
  var COLS = {
    first: [/^donor ?first ?name$/, /^first ?name$/, /^forename$/, /^given ?name$/],
    last: [/^donor ?last ?name$/, /^last ?name$/, /^surname$/, /^family ?name$/],
    name: [/^donor ?name$/, /^donor$/, /^full ?name$/, /^name$/, /^supporter( ?name)?$/, /^customer ?name$/, /^from ?name$/, /^payer( ?name)?$/, /^card ?name$/, /^description$/],
    email: [/^donor ?email$/, /^e-?mail( ?address)?$/, /^customer ?email$/, /^from ?email( ?address)?$/, /^payer ?email$/],
    amount: [/^donation ?auth ?amount$/, /^donation ?amount$/, /^amount ?donated$/, /^gross( ?amount)?$/, /^amount$/, /^donation$/, /^gift ?amount$/, /^total$/, /^value$/, /^credit( ?amount)?$/, /^paid ?in$/, /^money ?in$/, /^net( ?amount)?$/],
    date: [/^donation ?date$/, /^date ?of ?donation$/, /^gift ?date$/, /^date$/, /^created( ?(date|at|\(utc\)))?$/, /^transaction ?date$/, /^payment ?date$/, /^date ?received$/],
    giftaid: [/^gift ?aid ?amount$/, /^gift ?aid( ?(eligible|declaration|declared|status|claimed))?$/, /^giftaid$/],
    fund: [/^fund$/, /^restricted ?fund$/, /^appeal( ?name)?$/, /^campaign( ?name)?$/, /^designation$/, /^project$/],
    ref: [/^donation ?ref(erence)?$/, /^transaction ?id$/, /^donation ?id$/, /^id$/, /^payment ?id$/, /^reference$/, /^receipt ?(id|number)$/],
    method: [/^payment ?(type|method)$/, /^method$/]
  };
  var LABEL = { name: 'Donor name', first: 'First name', last: 'Last name', email: 'Email', amount: 'Amount', date: 'Date', giftaid: 'Gift Aid', fund: 'Fund', ref: 'Reference', method: 'Method' };
  function guess(head) {
    var h = head.map(function (x) { return String(x || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[_\s]+/g, ' ').trim(); }), used = {}, map = {};
    Object.keys(COLS).forEach(function (k) { COLS[k].some(function (re) { var i = h.findIndex(function (x, j) { return !used[j] && re.test(x); }); if (i >= 0) { map[k] = i; used[i] = 1; return true; } return false; }); });
    return map;
  }
  function platform(head, file) {
    var j = (head.join(' ') + ' ' + file).toLowerCase().replace(/\s/g, '');
    return /donationref|donorfirstname|justgiving/.test(j) ? 'JustGiving' : /enthuse/.test(j) ? 'Enthuse' : /paypal|fromemailaddress/.test(j) ? 'PayPal' : /stripe|customeremail/.test(j) ? 'Stripe' : /caf/.test(j) ? 'CAF Donate' : /giveasyoulive/.test(j) ? 'Give as you Live' : '';
  }
  function parseDate(s) {
    s = String(s || '').trim(); if (!s) return null; var m;
    if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return m[1] + '-' + m[2] + '-' + m[3];
    if ((m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/))) return (m[3].length === 2 ? '20' + m[3] : m[3]) + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');   // UK: day first
    var d = new Date(s); return isNaN(d) ? null : A().iso(d);
  }
  window.vlParseDate = parseDate;
  var money = function (s) { var x = parseFloat(String(s || '').replace(/[£$€,\s]|GBP/gi, '')); return isNaN(x) ? 0 : Math.round(x * 100) / 100; };
  var yes = function (s) { s = String(s || '').trim().toLowerCase(); return /^(y|yes|true|eligible|declared|claimed)$/.test(s) || (/^[£\d.]+$/.test(s) && money(s) > 0); };
  function rowsOf() {
    if (!CSV) return [];
    var m = CSV.map, pick = function (r, k) { return m[k] != null ? String(r[m[k]] || '').trim() : ''; };
    return CSV.rows.map(function (r) {
      var nm = pick(r, 'name') || [pick(r, 'first'), pick(r, 'last')].filter(Boolean).join(' '), fund = pick(r, 'fund');
      if (/^(general|unrestricted|none|n\/a|-)$/i.test(fund)) fund = '';
      return { donor_name: nm || 'Anonymous', donor_email: /@/.test(pick(r, 'email')) ? pick(r, 'email') : null, amount: money(pick(r, 'amount')), gift_date: parseDate(pick(r, 'date')),
        gift_aid: yes(pick(r, 'giftaid')), fund: fund || null, restricted: !!fund, method: pick(r, 'method') || CSV.platform || 'Imported', external_id: pick(r, 'ref') || null };
    }).filter(function (d) { return d.amount > 0 && d.gift_date; });
  }
  function dupe(d) {
    return A().S.don.some(function (x) {
      if (d.external_id && x.external_id && String(x.external_id) === String(d.external_id)) return true;
      return String(x.donor_name || '').toLowerCase() === String(d.donor_name).toLowerCase() && Math.abs(A().n(x.amount) - d.amount) < 0.005 && String(x.gift_date || '').slice(0, 10) === d.gift_date;
    });
  }
  function paintCSV() {
    var box = $('ao-csv'); if (!box) return; if (!CSV) { box.innerHTML = ''; return; }
    var a = A(), esc = a.esc, rows = rowsOf(), dupes = rows.filter(dupe).length, fresh = rows.length - dupes, skipped = CSV.rows.length - rows.length;
    var opts = function (k) { return '<option value="">— none —</option>' + CSV.head.map(function (h, i) { return '<option value="' + i + '"' + (CSV.map[k] === i ? ' selected' : '') + '>' + esc(h) + '</option>'; }).join(''); };
    box.innerHTML = '<div style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-top:12px;background:var(--bg)">' +
      '<div style="font-weight:700">' + esc(CSV.file) + (CSV.platform ? ' · looks like ' + esc(CSV.platform) : '') + '</div>' +
      '<div style="font-size:12px;color:var(--txt2);margin:4px 0 10px">The columns are matched for you: change any that are wrong. Dates are read day first (UK).</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px">' + Object.keys(LABEL).map(function (k) { return '<label style="font-size:12px">' + LABEL[k] + '<select onchange="vlDonCSVMap(\'' + k + '\',this.value)" style="width:100%">' + opts(k) + '</select></label>'; }).join('') + '</div>' +
      '<div style="font-size:13px;margin:12px 0 6px"><b>' + rows.length + '</b> gifts, ' + a.gbp(rows.reduce(function (s, d) { return s + d.amount; }, 0)) + (dupes ? ' · ' + dupes + ' already in Vorlana (skipped)' : '') + (skipped ? ' · ' + skipped + ' rows with no amount or date (skipped)' : '') + '</div>' +
      (rows.length ? '<div class="tbl-wrap" style="max-height:230px;overflow:auto"><table><thead><tr><th>Date</th><th>Donor</th><th>Amount</th><th>Gift Aid</th><th>Fund</th></tr></thead><tbody>' + rows.slice(0, 8).map(function (d) { return '<tr' + (dupe(d) ? ' style="opacity:.45"' : '') + '><td>' + esc(a.fmt(d.gift_date)) + '</td><td>' + esc(d.donor_name) + '</td><td>' + a.gbp(d.amount) + '</td><td>' + (d.gift_aid ? 'Yes' : '—') + '</td><td>' + esc(d.fund || 'Unrestricted') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') +
      '<div style="display:flex;gap:6px;margin-top:10px"><button class="btn btn-p btn-sm" onclick="vlDonCSVImport()"' + (fresh ? '' : ' disabled') + '>Import ' + fresh + ' gift' + (fresh === 1 ? '' : 's') + '</button><button class="btn btn-ghost btn-sm" onclick="vlDonCSVCancel()">Cancel</button></div></div>';
  }
  function take(name, text) {
    var all = parseCSV(text);
    if (all.length < 2) { msg = 'That file has no rows to import.'; CSV = null; repaint(); return; }
    CSV = { file: name, head: all[0], rows: all.slice(1), map: guess(all[0]), platform: platform(all[0], name) };
    msg = (CSV.map.amount == null || CSV.map.date == null) ? 'Pick the amount and date columns below.' : '';
    repaint();
  }
  window.vlDonCSVPick = function (input) {
    var f = input.files && input.files[0]; if (!f) return;
    var rd = new FileReader(); rd.onload = function () { input.value = ''; take(f.name, rd.result); }; rd.readAsText(f);
  };
  window.vlDonCSVMap = function (k, v) { if (v === '') delete CSV.map[k]; else CSV.map[k] = +v; paintCSV(); };
  window.vlDonCSVCancel = function () { CSV = null; paintCSV(); };
  window.vlDonCSVImport = async function () {
    var a = A(), rows = rowsOf().filter(function (d) { return !dupe(d); }); if (!rows.length) return;
    var src = 'csv' + (CSV.platform ? ':' + CSV.platform.toLowerCase().replace(/\s+/g, '-') : '');
    rows = rows.map(function (d) { return Object.assign({ source: src }, d); });
    try {
      for (var i = 0; i < rows.length; i += 200) {
        var r = await sb.from('donations').upsert(rows.slice(i, i + 200).map(function (d) { return Object.assign({ org_id: a.oid() }, d); }), { onConflict: 'org_id,source,external_id', ignoreDuplicates: true }).select();
        if (r.error) throw new Error(r.error.message);
      }
      await reload();
      msg = rows.length + ' gift' + (rows.length === 1 ? '' : 's') + ' imported from ' + CSV.file + '.'; CSV = null;
      if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks();
    } catch (e) { msg = 'Couldn’t import: ' + (/source|external_id|constraint/.test(e.message) ? 'run the latest ai-office.sql in Supabase first.' : e.message); }
    repaint();
  };

  if (window.__VORLANA_TEST) window.__donInTest = { parseCSV: parseCSV, guess: guess, parseDate: parseDate, take: take, rowsOf: rowsOf };
})();
