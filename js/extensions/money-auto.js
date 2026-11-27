// js/extensions/money-auto.js — spend and thank-yous with no typing (demo account only, with ai-office.js)
//   • Fixed costs: set a monthly cost once (staff, rent) and it is posted to its budget line every month by itself.
//   • Bank or card statement CSV: spends are sorted to budget lines by rules Vorlana learns from your choices;
//     anything new gets an AI suggestion and waits for one tap. "Not a project cost" is remembered too.
//   • Thank-yous are drafted ahead for new gifts, so thanking is read, tap, done.
//   • "Ready for you" on the morning briefing is the one place to approve what Vorlana prepared.
// Nothing is posted to a budget line on a guess: a suggestion always waits for a tap, and every spend can be deleted.
// Needs ai-office.sql.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var A = function () { return window.vlAO; };
  var SUG = {}, sugBusy = false, note = '', drafting = false;

  var allLines = function () {
    var S = A().S, C = (typeof DB !== 'undefined' && DB.contracts) || [];
    return S.lines.map(function (l) { var c = C.find(function (x) { return String(x.id) === String(l.contract_id); }); return { id: String(l.id), label: (c ? c.name + ' · ' : '') + l.name, contract_id: String(l.contract_id) }; });
  };
  var unsorted = function () { return A().S.spend.filter(function (s) { return !s.line_id && !s.ignored; }); };
  // "CARD PAYMENT TO SCREWFIX DIRECT 1234 ON 12 NOV" → "screwfix direct"
  function merchant(desc) {
    var t = String(desc || '').toLowerCase().replace(/\b(card payment to|direct debit( to)?|payment to|faster payment( to)?|standing order( to)?|pos|contactless|visa|debit|bacs|ref\b.*|on \d.*)\b/g, ' ')
      .replace(/[^a-z&' ]+/g, ' ').replace(/\s+/g, ' ').trim();
    return t.split(' ').filter(function (w) { return w.length > 1; }).slice(0, 2).join(' ');
  }
  var ruleFor = function (desc) { var m = merchant(desc); return m ? (A().S.rules || []).find(function (r) { return r.match === m; }) : null; };

  // ── load: rules, fixed costs, then the automatic jobs ─────────
  window.vlAOLoaded = async function () {
    var a = A(), S = a.S, res = await Promise.all([a.q('budget_recurring'), a.q('spend_rules')]);
    S.sql.auto = res[0] !== null && res[1] !== null;
    S.rec = res[0] || []; S.rules = res[1] || [];
    await postFixed();
    if (typeof isAdviserRole === 'function' && isAdviserRole()) return;        // frontline staff: no money jobs run for them
    if (typeof window.vlDonSyncAuto === 'function') window.vlDonSyncAuto();   // new gifts from connected accounts
    setTimeout(draftThanks, 2500);
    setTimeout(draftComms, 9000);
  };
  // the week's story pack (from Friday) and the month's newsletter (from the 25th) are written ahead
  async function draftComms() {
    if (typeof window.vlCommsDue !== 'function' || typeof window.vlComms !== 'function') return;
    var due = window.vlCommsDue().filter(function (x) { return !x.ready; });
    for (var i = 0; i < due.length; i++) await window.vlComms(due[i].kind, { background: true });
    if (due.length && typeof window.vlPaintChecks === 'function') window.vlPaintChecks();
  }
  async function add(table, key, row) {
    var a = A(), S = a.S;
    if (!S.sql.auto || /^(demo|mem)-/.test(String(row.line_id || ''))) { row.id = 'mem-' + Date.now() + Math.random().toString(36).slice(2, 6); S[key].push(row); return row; }
    var r = await sb.from(table).insert([Object.assign({ org_id: a.oid() }, row)]).select();
    if (r.error) throw new Error(r.error.message);
    var saved = (r.data && r.data[0]) || row; S[key].push(saved); return saved;
  }

  // ── fixed costs: posted every month by themselves ─────────────
  async function postFixed() {
    var a = A(), S = a.S, t = a.today(), posted = 0;
    for (var i = 0; i < (S.rec || []).length; i++) {
      var r = S.rec[i]; if (!r.start_date || !S.lines.some(function (l) { return String(l.id) === String(r.line_id); })) continue;
      var start = new Date(r.start_date + 'T12:00:00'), dom = start.getDate();
      for (var m = new Date(start.getFullYear(), start.getMonth(), 1, 12), k = 0; k < 60; k++, m = new Date(m.getFullYear(), m.getMonth() + 1, 1, 12)) {
        var last = new Date(m.getFullYear(), m.getMonth() + 1, 0).getDate(), day = a.iso(new Date(m.getFullYear(), m.getMonth(), Math.min(dom, last), 12));
        if (day > t || (r.end_date && day > r.end_date)) break;
        var key = r.id + ':' + day.slice(0, 7);
        if (S.spend.some(function (s) { return s.source === 'fixed' && s.external_id === key; })) continue;
        try { await a.save('budget_spend', { line_id: r.line_id, spend_date: day, amount: a.n(r.amount), note: (r.note || 'Fixed cost') + ' (monthly, automatic)', source: 'fixed', external_id: key }, 'spend'); posted++; }
        catch (e) { if (!/duplicate|unique/i.test(e.message)) console.warn('[money-auto] fixed cost', e.message); }
      }
    }
    return posted;
  }
  window.vlFixAdd = async function () {
    var a = A(), amt = a.n($('ao-fx-amt').value), line = $('ao-fx-line').value; if (!amt || !line) { alert('Pick a budget line and add the monthly amount.'); return; }
    try { await add('budget_recurring', 'rec', { line_id: line, amount: amt, start_date: $('ao-fx-from').value || a.today(), note: ($('ao-fx-note').value || '').trim() || null }); var p = await postFixed(); note = 'Fixed cost saved' + (p ? ': ' + p + ' month' + (p === 1 ? '' : 's') + ' posted.' : '. It will post on that day each month.'); }
    catch (e) { note = 'Couldn’t save: ' + (/budget_recurring/.test(e.message) ? 'run the latest ai-office.sql in Supabase first.' : e.message); }
    a.renderBudget();
  };
  window.vlFixDel = async function (id) {
    if (!confirm('Stop this fixed cost? Months already posted stay.')) return;
    var a = A(), S = a.S; S.rec = S.rec.filter(function (r) { return String(r.id) !== String(id); });
    if (!/^mem-/.test(String(id))) { var r = await sb.from('budget_recurring').delete().eq('id', id); if (r && r.error) alert(r.error.message); }
    a.renderBudget();
  };

  // ── bank or card statement ────────────────────────────────────
  var BCOLS = {
    date: [/^date$/, /^transaction ?date$/, /^posting ?date$/, /^posted$/, /^created$/, /date/],
    desc: [/^description$/, /^transaction ?description$/, /^narrative$/, /^details?$/, /^payee$/, /^merchant( ?name)?$/, /^counter ?party$/, /^name$/, /^memo$/, /^reference$/, /descr|narrat|detail/],
    out: [/^debit( ?amount)?$/, /^money ?out$/, /^paid ?out$/, /^withdrawals?$/, /^out$/, /^spent$/],
    amount: [/^amount$/, /^value$/, /^transaction ?amount$/, /amount/]
  };
  function bankRows(name, text) {
    var all = window.vlParseCSV(text); if (all.length < 2) return null;
    var hi = all.findIndex(function (r) { return r.filter(function (x) { return /date|amount|descr|debit|narrat/i.test(x); }).length >= 2; }); if (hi < 0) hi = 0;   // some banks put account details above the header
    var h = all[hi].map(function (x) { return String(x || '').toLowerCase().replace(/[_\s]+/g, ' ').trim(); }), map = {}, used = {};
    Object.keys(BCOLS).forEach(function (k) { BCOLS[k].some(function (re) { var i = h.findIndex(function (x, j) { return !used[j] && re.test(x); }); if (i >= 0) { map[k] = i; used[i] = 1; return true; } return false; }); });
    if (map.date == null || (map.out == null && map.amount == null)) return null;
    var num = function (s) { var x = parseFloat(String(s || '').replace(/[£$€,\s]|GBP/gi, '').replace(/^\((.*)\)$/, '-$1')); return isNaN(x) ? 0 : Math.round(x * 100) / 100; };
    var body = all.slice(hi + 1), anyNeg = map.out == null && body.some(function (r) { return num(r[map.amount]) < 0; }), seen = {};
    return body.map(function (r) {
      var raw = map.out != null ? num(r[map.out]) : num(r[map.amount]);
      var amt = map.out != null ? Math.abs(raw) : (anyNeg ? (raw < 0 ? -raw : 0) : raw);          // money out only
      var d = window.vlParseDate(r[map.date]), desc = String(map.desc != null ? r[map.desc] : '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!d || amt <= 0) return null;
      var key = d + '|' + desc.toLowerCase() + '|' + amt.toFixed(2); seen[key] = (seen[key] || 0) + 1;   // two identical payments on one day are both kept
      return { spend_date: d, description: desc || 'Payment', amount: amt, source: 'bank', external_id: key + '|' + seen[key] };
    }).filter(Boolean);
  }
  window.vlBankPick = function (input) {
    var f = input.files && input.files[0]; if (!f) return;
    var rd = new FileReader(); rd.onload = function () { input.value = ''; importBank(f.name, rd.result); }; rd.readAsText(f);
  };
  async function importBank(name, text) {
    var a = A(), S = a.S, rows = bankRows(name, text);
    if (!rows) { note = 'Couldn’t read that file: it needs a date column and an amount or money-out column.'; a.renderBudget(); return; }
    var fresh = rows.filter(function (r) { return !S.spend.some(function (s) { return s.source === 'bank' && s.external_id === r.external_id; }); });
    var auto = 0, skip = 0, wait = 0;
    fresh.forEach(function (r) {
      var rule = ruleFor(r.description);
      if (rule && rule.line_id && S.lines.some(function (l) { return String(l.id) === String(rule.line_id); })) { r.line_id = rule.line_id; r.note = r.description; auto++; }
      else if (rule && !rule.line_id) { r.line_id = null; r.ignored = true; skip++; }
      else { r.line_id = null; r.ignored = false; wait++; }
      if (r.ignored == null) r.ignored = false; if (r.note == null) r.note = null;
    });
    try {
      var isMem = function (r) { return !S.sql.auto || /^(demo|mem)-/.test(String(r.line_id || '')); };      // sample lines live in memory, so does their spend
      fresh.filter(isMem).forEach(function (r, i) { r.id = 'mem-bank-' + Date.now() + '-' + i; S.spend.push(r); });
      var real = fresh.filter(function (r) { return !r.id; });
      for (var i = 0; i < real.length; i += 200) {
        var res = await sb.from('budget_spend').upsert(real.slice(i, i + 200).map(function (r) { return Object.assign({ org_id: a.oid() }, r); }), { onConflict: 'org_id,source,external_id', ignoreDuplicates: true }).select();
        if (res.error) throw new Error(res.error.message);
        (res.data || []).forEach(function (r) { S.spend.push(r); });
      }
      note = name + ': ' + fresh.length + ' new payment' + (fresh.length === 1 ? '' : 's') + (rows.length - fresh.length ? ' (' + (rows.length - fresh.length) + ' already in)' : '') +
        (fresh.length ? '. ' + auto + ' sorted by your rules, ' + skip + ' not project costs, ' + wait + ' to sort below.' : '.');
    } catch (e) { note = 'Couldn’t import: ' + (/source|external_id|description|ignored|null/.test(e.message) ? 'run the latest ai-office.sql in Supabase first.' : e.message); }
    a.renderBudget(); if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks();
    suggest();
  }
  // AI suggests a line for payees it hasn't seen; nothing is posted until someone taps
  async function suggest() {
    var a = A(), L = allLines(), todo = {}; if (sugBusy || !L.length) return;
    unsorted().forEach(function (s) { var m = merchant(s.description); if (m && !(m in SUG)) todo[m] = s.description; });
    var keys = Object.keys(todo).slice(0, 40); if (!keys.length) return;
    sugBusy = true; a.renderBudget();
    try {
      var sys = 'You sort a UK charity\'s payments into its budget lines. For each numbered payment, answer with the letter of the best budget line, or "-" if it is not clearly a cost of any of them (for example bank fees, transfers, or anything unclear). Be cautious: answer "-" unless the payee clearly fits. Reply with one line per payment in the form "number: letter", nothing else.';
      var prompt = 'BUDGET LINES\n' + L.map(function (l, i) { return String.fromCharCode(65 + i) + '. ' + l.label; }).slice(0, 26).join('\n') + '\n\nPAYMENTS\n' + keys.map(function (k, i) { return (i + 1) + '. ' + todo[k]; }).join('\n');
      var raw = await callClaude(sys, prompt, 400, false, { purpose: 'spend-sort' });
      keys.forEach(function (k) { SUG[k] = null; });
      String(raw || '').split('\n').forEach(function (ln) { var m = ln.match(/^\s*(\d+)\s*[:.)-]\s*([A-Za-z-])/); if (!m) return; var k = keys[+m[1] - 1], l = L[m[2].toUpperCase().charCodeAt(0) - 65]; if (k && l && m[2] !== '-') SUG[k] = l.id; });
    } catch (e) { keys.forEach(function (k) { SUG[k] = null; }); }
    sugBusy = false; a.renderBudget();
  }
  async function sortOne(id, lineId) {
    var a = A(), S = a.S, s = S.spend.find(function (x) { return String(x.id) === String(id); }); if (!s) return;
    var ignore = lineId === 'ignore';
    await a.patch('budget_spend', 'spend', id, ignore ? { ignored: true } : { line_id: lineId, note: s.note || s.description });
    var m = merchant(s.description);
    if (m && !ruleFor(s.description)) { try { await add('spend_rules', 'rules', { match: m, line_id: ignore ? null : lineId }); } catch (e) { /* the spend is sorted either way */ } }
    // the same payee waiting elsewhere is sorted too
    var rest = unsorted().filter(function (x) { return merchant(x.description) === m && String(x.id) !== String(id); });
    for (var i = 0; i < rest.length; i++) await a.patch('budget_spend', 'spend', rest[i].id, ignore ? { ignored: true } : { line_id: lineId, note: rest[i].description });
  }
  window.vlSpendSort = async function (id) { var v = $('ao-us-' + id).value; if (!v) { alert('Pick a budget line.'); return; } await sortOne(id, v); done(); };
  window.vlSpendIgnore = async function (id) { await sortOne(id, 'ignore'); done(); };
  window.vlSpendConfirmAll = async function () {
    var list = unsorted().filter(function (s) { return SUG[merchant(s.description)]; });
    for (var i = 0; i < list.length; i++) { if (!list[i].line_id && !list[i].ignored) await sortOne(list[i].id, SUG[merchant(list[i].description)]); }
    done();
  };
  function done() { A().renderBudget(); if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks(); }

  // ── Budgets page: the no-typing card ──────────────────────────
  window.vlBudTop = function (c, lines) {
    var a = A(), S = a.S, esc = a.esc, L = allLines(), U = unsorted();
    var recs = (S.rec || []).filter(function (r) { return lines.some(function (l) { return String(l.id) === String(r.line_id); }); });
    var fixed = '<div style="flex:1;min-width:280px"><div style="font-weight:700;margin-bottom:4px">Fixed costs</div><div style="font-size:12px;color:var(--txt2);margin-bottom:8px">Set a monthly cost once. Vorlana posts it to the line every month.</div>' +
      recs.map(function (r) { var l = lines.find(function (x) { return String(x.id) === String(r.line_id); });
        return '<div style="display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:13px;padding:5px 0;border-top:1px solid var(--border)"><span><b>' + a.gbp(r.amount) + '</b> a month · ' + esc(l ? l.name : '') + (r.note ? ' · ' + esc(r.note) : '') + ' · from ' + esc(a.fmt(r.start_date)) + '</span><button class="btn btn-ghost btn-sm" onclick="vlFixDel(\'' + esc(r.id) + '\')">Stop</button></div>'; }).join('') +
      (lines.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px"><select id="ao-fx-line" style="flex:2;min-width:130px">' + lines.map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.name) + '</option>'; }).join('') + '</select>' +
        '<input id="ao-fx-amt" type="number" min="0" step="0.01" placeholder="£ a month" style="flex:1;min-width:90px"/><input id="ao-fx-from" type="date" value="' + a.today() + '" title="First payment" style="flex:1;min-width:125px"/><input id="ao-fx-note" placeholder="What (e.g. Project worker)" style="flex:2;min-width:130px"/><button class="btn btn-p btn-sm" onclick="vlFixAdd()">+ Add</button></div>'
        : '<div style="font-size:12px;color:var(--txt3)">Add a budget line below first.</div>') + '</div>';
    var bank = '<div style="flex:1;min-width:280px"><div style="font-weight:700;margin-bottom:4px">Everything else, from the bank</div><div style="font-size:12px;color:var(--txt2);margin-bottom:8px">Download a statement as CSV from your bank or card and drop it in. Vorlana sorts payees it knows and asks once about new ones.</div>' +
      '<label class="btn btn-ghost btn-sm" style="cursor:pointer">Import statement CSV<input type="file" accept=".csv,text/csv" style="display:none" onchange="vlBankPick(this)"/></label>' +
      ((S.rules || []).length ? '<span style="font-size:12px;color:var(--txt3);margin-left:8px">' + S.rules.length + ' payee' + (S.rules.length === 1 ? '' : 's') + ' remembered</span>' : '') + '</div>';
    var sortBox = '';
    if (U.length) {
      var withSug = U.filter(function (s) { return SUG[merchant(s.description)]; }).length;
      sortBox = '<div style="margin-top:14px;border-top:1px solid var(--border);padding-top:12px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div style="font-weight:700">' + U.length + ' payment' + (U.length === 1 ? '' : 's') + ' to sort' + (sugBusy ? ' <span style="font-weight:400;color:var(--txt3)">· suggesting lines…</span>' : '') + '</div>' +
        (withSug ? '<button class="btn btn-p btn-sm" onclick="vlSpendConfirmAll()">Confirm ' + withSug + ' suggested</button>' : '') + '</div>' +
        (L.length ? '' : '<div style="font-size:12px;color:#B7791F;margin-top:6px">Add budget lines first, then sort these.</div>') +
        U.slice(0, 25).map(function (s) { var sg = SUG[merchant(s.description)];
          return '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px;padding:7px 0;border-top:1px solid var(--border);margin-top:6px"><span style="width:86px;color:var(--txt3)">' + esc(a.fmt(s.spend_date)) + '</span><span style="flex:2;min-width:150px">' + esc(s.description) + '</span><b style="width:70px;text-align:right">' + a.gbp(s.amount) + '</b>' +
            '<select id="ao-us-' + esc(s.id) + '" style="flex:2;min-width:170px"><option value="">Pick a line…</option>' + L.map(function (l) { return '<option value="' + esc(l.id) + '"' + (sg === l.id ? ' selected' : '') + '>' + esc(l.label) + '</option>'; }).join('') + '</select>' +
            (sg ? '<span class="badge" style="background:#EFEAFB;color:#5B3FB8">suggested</span>' : '') +
            '<button class="btn btn-p btn-sm" onclick="vlSpendSort(\'' + esc(s.id) + '\')">OK</button><button class="btn btn-ghost btn-sm" onclick="vlSpendIgnore(\'' + esc(s.id) + '\')" title="Remembered: this payee won’t be asked about again">Not a project cost</button></div>'; }).join('') +
        (U.length > 25 ? '<div style="font-size:12px;color:var(--txt3);margin-top:6px">and ' + (U.length - 25) + ' more</div>' : '') + '</div>';
    }
    return '<div class="card" style="margin-bottom:14px"><div class="card-title">Spend that sorts itself</div>' +
      (S.sql.auto === false ? '<div style="font-size:12px;color:#B7791F;margin-bottom:8px">Not saved yet: run the latest ai-office.sql in Supabase to keep fixed costs, imported payments and remembered payees.</div>' : '') +
      '<div style="display:flex;gap:20px;flex-wrap:wrap">' + fixed + bank + '</div>' + (note ? '<div style="font-size:13px;color:var(--txt2);margin-top:10px">' + esc(note) + '</div>' : '') + sortBox + '</div>';
  };
  window.vlBudAfter = function () { if (unsorted().length && !sugBusy) suggest(); };

  // ── thank-yous drafted ahead ──────────────────────────────────
  var tk = function (id) { return 'vl_thx_' + id; };
  window.vlThanksDraft = function (id) { try { return localStorage.getItem(tk(id)) || ''; } catch (e) { return ''; } };
  function waiting() { var a = A(), from = a.iso(a.addDays(new Date(), -45)); return a.S.don.filter(function (d) { return !d.thanked_at && String(d.gift_date || '') >= from; }); }
  async function draftThanks() {
    if (drafting || typeof callClaude !== 'function') return; drafting = true;
    var a = A(), list = waiting().filter(function (d) { return !window.vlThanksDraft(d.id); }).slice(0, 3);   // a few at a time
    for (var i = 0; i < list.length; i++) {
      try { var t = await callClaude(a.thanksSys(list[i]), a.thanksPrompt(list[i]), 400, false, { purpose: 'donor-thanks' }); if (t) localStorage.setItem(tk(list[i].id), String(t).trim()); } catch (e) { break; }
    }
    drafting = false;
    if (list.length && typeof window.vlPaintChecks === 'function') window.vlPaintChecks();
  }
  window.vlDraftThanksNow = draftThanks;

  // ── morning briefing: what Vorlana prepared, waiting for a tap ─
  window.vlExtraChecks = function () {
    var U = unsorted(); return U.length ? [{ lvl: 'amber', page: 'budget', sort: true, text: U.length + ' payment' + (U.length === 1 ? '' : 's') + ' from the bank to sort (' + A().gbp(U.reduce(function (s, x) { return s + A().n(x.amount); }, 0)) + ')' }] : [];
  };
  window.vlInboxHTML = function () {
    var a = A(), S = a.S, items = [], month = a.today().slice(0, 7);
    var ready = waiting().filter(function (d) { return window.vlThanksDraft(d.id); });
    if (ready.length) items.push(['donations', ready.length + ' thank-you' + (ready.length === 1 ? '' : 's') + ' written and waiting: read, send, tick']);
    var sug = unsorted().filter(function (s) { return SUG[merchant(s.description)]; }).length;
    if (sug) items.push(['budget', sug + ' payment' + (sug === 1 ? '' : 's') + ' matched to budget lines: confirm in one tap']);
    var fx = S.spend.filter(function (s) { return s.source === 'fixed' && String(s.spend_date).slice(0, 7) === month; });
    if (fx.length) items.push(['budget', 'Fixed costs posted this month: ' + a.gbp(fx.reduce(function (t, s) { return t + a.n(s.amount); }, 0)) + ' across ' + fx.length + ' line' + (fx.length === 1 ? '' : 's')]);
    var auto = S.don.filter(function (d) { return d.source && d.source !== 'manual' && !/^csv/.test(d.source) && String(d.created_at || '').slice(0, 10) >= a.iso(a.addDays(new Date(), -1)); }).length;
    if (auto) items.push(['donations', auto + ' new gift' + (auto === 1 ? '' : 's') + ' came in from your giving accounts']);
    (typeof window.vlCommsDue === 'function' ? window.vlCommsDue() : []).forEach(function (x) { if (x.ready) items.push(['social', x.kind === 'story' ? 'This week’s story pack is written: check it and post' : 'This month’s newsletter is written: check it and send']); });
    if (!items.length) return '';
    return '<div style="font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--txt3);margin:12px 0 8px">Ready for you</div>' + items.map(function (x) {
      return '<div onclick="go(\'' + x[0] + '\')" style="display:flex;gap:10px;align-items:flex-start;padding:7px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:13px;background:#F3F8F7"><span style="color:#1F6F6D;font-weight:700">✓</span><span>' + a.esc(x[1]) + '</span></div>'; }).join('');
  };

  if (window.__VORLANA_TEST) window.__maTest = { merchant: merchant, bankRows: bankRows, importBank: importBank, postFixed: postFixed, unsorted: unsorted, SUG: SUG, suggest: suggest };
})();
