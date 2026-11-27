// js/extensions/reach.js — three more views of the same records (demo account only, with ai-office.js)
//   • CEO view: one line per programme and per team, problems only, no scrolling (a "View as" option on the Dashboard)
//   • Who to ask next (Donations): lapsed, regular and new donors and funders coming up for renewal, worked out
//     from the records, with the approach drafted on request
//   • My day: a phone screen for frontline staff: who needs contact, speak a note, call, this week's events
// Nothing here is typed in by anyone: it is all read from what is already recorded.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var A = function () { return window.vlAO; };
  var DAY = 864e5;
  var since = function (d) { return d ? Math.floor((new Date() - new Date(d)) / DAY) : null; };

  // ── CEO view ──────────────────────────────────────────────────
  window.vlLenses = (window.vlLenses || []).concat([['ceo', 'View as CEO']]);
  window.vlLensNote = 'The CEO view shows every programme and team on one screen: green is fine, amber needs watching, red needs you.';
  var DOT = { red: '#B42318', amber: '#B7791F', green: '#1E7B3C' };
  function ceoRows() {
    var a = A(), t = a.today(), progs = [], teams = [];
    (DB.contracts || []).filter(function (c) { return c.status !== 'closed'; }).forEach(function (c) {
      var el = a.elapsedPct(c), flags = [], lvl = 'green', worse = function (l) { if (l === 'red' || (l === 'amber' && lvl === 'green')) lvl = l; };
      [['starts', c.target_starts, c.actual_starts], ['outcomes', c.target_outcomes, c.actual_outcomes]].forEach(function (x) {
        if (a.n(x[1]) > 0 && el != null && el >= 15) { var pc = Math.round(a.n(x[2]) / a.n(x[1]) * 100); if (pc < el - 10) { flags.push(x[0] + ' ' + pc + '% with ' + el + '% of time gone'); worse(pc < el - 25 ? 'red' : 'amber'); } }
      });
      var bd = a.budgetOf(c);
      if (bd) { var over = bd.rows.filter(function (r) { return r.budget && r.spent > r.budget; }); if (over.length) { flags.push(over.length + ' budget line' + (over.length === 1 ? '' : 's') + ' overspent'); worse('red'); } else if (bd.elapsed != null && bd.pct > bd.elapsed + 15) { flags.push('spend ' + bd.pct + '% vs ' + bd.elapsed + '% of time'); worse('amber'); } }
      if (c.end_date && c.end_date >= t && c.end_date <= a.iso(a.addDays(new Date(), 90))) { flags.push('ends ' + a.fmt(c.end_date)); worse('amber'); }
      progs.push({ name: c.name, sub: [c.funder, a.n(c.value) ? a.gbp(c.value) : ''].filter(Boolean).join(' · '), lvl: lvl, flags: flags });
    });
    var by = {};
    (DB.participants || []).filter(function (p) { return p.stage !== 'Closed'; }).forEach(function (p) { var k = p.advisor && p.advisor !== 'Unassigned' ? p.advisor : 'Unassigned'; (by[k] = by[k] || []).push(p); });
    Object.keys(by).sort(function (x, y) { return by[y].length - by[x].length; }).forEach(function (k) {
      var L = by[k], risk = L.filter(function (p) { return (p.safeguarding || p.risk === 'High') && (since(p.last_contact) == null || since(p.last_contact) > 14); }).length;
      var quiet = L.filter(function (p) { return since(p.last_contact) != null && since(p.last_contact) > 21; }).length, flags = [];
      if (risk) flags.push(risk + ' high-risk with no contact for 14+ days');
      if (quiet > Math.max(2, L.length * 0.3)) flags.push(quiet + ' of ' + L.length + ' not contacted for 3+ weeks');
      if (k === 'Unassigned' && L.length) flags.push('nobody is responsible for these people');
      teams.push({ name: k === 'Unassigned' ? 'Unassigned' : k + '’s caseload', sub: L.length + ' people', lvl: risk || k === 'Unassigned' ? 'red' : flags.length ? 'amber' : 'green', flags: flags });
    });
    return { progs: progs, teams: teams };
  }
  window.vlLensRender = function (L) {
    if (L !== 'ceo') return null;
    var a = A(), esc = a.esc, r = ceoRows(), order = { red: 0, amber: 1, green: 2 };
    var line = function (x) { return '<div style="display:flex;gap:10px;align-items:flex-start;padding:7px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;font-size:13px;background:var(--surface,#fff)"><span style="width:9px;height:9px;border-radius:50%;background:' + DOT[x.lvl] + ';margin-top:5px;flex-shrink:0"></span><span style="flex:1"><b>' + esc(x.name) + '</b>' + (x.sub ? ' <span style="color:var(--txt3)">· ' + esc(x.sub) + '</span>' : '') + '<div style="color:' + (x.flags.length ? 'var(--txt2)' : 'var(--txt3)') + '">' + esc(x.flags.length ? x.flags.join(' · ') : 'On track') + '</div></span></div>'; };
    var sec = function (title, rows, page) { rows = rows.slice().sort(function (x, y) { return order[x.lvl] - order[y.lvl]; }); return rows.length ? '<div onclick="go(\'' + page + '\')" style="cursor:pointer"><div style="font-size:12px;font-weight:700;color:var(--txt3);margin:8px 0 6px">' + title + '</div>' + rows.map(line).join('') + '</div>' : ''; };
    var all = r.progs.concat(r.teams), red = all.filter(function (x) { return x.lvl === 'red'; }).length, amber = all.filter(function (x) { return x.lvl === 'amber'; }).length;
    var money = a.allChecks().filter(function (c) { return c.page === 'donations' || c.page === 'calendar' || c.page === 'companies' || c.page === 'bd'; });
    return { title: 'CEO view: ' + (red ? red + ' need you' : amber ? 'nothing urgent' : 'all on track') + (amber ? ', ' + amber + ' to watch' : ''),
      html: (all.length ? '' : '<div style="font-size:13px;color:var(--txt3);margin-bottom:8px">Add contracts and people and each one gets a line here.</div>') + sec('Programmes', r.progs, 'funding') + sec('Teams', r.teams, 'participants') +
        (money.length ? '<div style="font-size:12px;font-weight:700;color:var(--txt3);margin:8px 0 6px">Organisation</div>' + money.map(function (c) { return line({ name: c.text, sub: '', lvl: c.lvl === 'red' ? 'red' : 'amber', flags: [' '] }).replace('<div style="color:var(--txt2)"> </div>', ''); }).join('') : '') };
  };

  // ── Who to ask next (Donations) ───────────────────────────────
  function prospects() {
    var a = A(), S = a.S, by = {}, out = [], t = new Date();
    S.don.forEach(function (d) { var k = String(d.donor_name || '').trim(); if (!k || /^anonymous/i.test(k)) return; (by[k] = by[k] || []).push(d); });
    Object.keys(by).forEach(function (k) {
      var L = by[k].slice().sort(function (x, y) { return String(x.gift_date) < String(y.gift_date) ? 1 : -1; }), last = L[0], total = L.reduce(function (s, d) { return s + a.n(d.amount); }, 0), gap = since(last.gift_date), email = (L.find(function (d) { return d.donor_email; }) || {}).donor_email || '';
      var base = { name: k, email: email, total: total, gifts: L.length, last: last.gift_date, lastAmt: a.n(last.amount), fund: last.fund || '' };
      if (gap > 300 && gap < 800) out.push(Object.assign({ kind: 'lapsed', why: 'Last gave ' + a.fmt(last.gift_date) + ' (' + a.gbp(last.amount) + '). Nothing since.', rank: 1000 + total }, base));
      else if (L.length >= 3 && gap <= 120 && !L.some(function (d) { return /monthly|direct debit|standing/i.test(d.method || ''); })) out.push(Object.assign({ kind: 'regular', why: L.length + ' separate gifts, ' + a.gbp(total) + ' in all. Could become a monthly giver.', rank: 600 + total }, base));
      else if (L.length === 1 && gap <= 60 && gap >= 14) out.push(Object.assign({ kind: 'new', why: 'First gift ' + a.fmt(last.gift_date) + ' (' + a.gbp(last.amount) + '). A good moment to show what it did.', rank: 300 + total }, base));
      else if (total >= 500 && gap > 150 && gap <= 300) out.push(Object.assign({ kind: 'major', why: a.gbp(total) + ' given, last ' + a.fmt(last.gift_date) + '. Worth a personal update before asking again.', rank: 800 + total }, base));
    });
    (DB.contracts || []).forEach(function (c) { if (c.status === 'closed' || !c.end_date) return; var left = -since(c.end_date); if (left >= 0 && left <= 180 && c.funder) out.push({ kind: 'renewal', name: c.funder, email: '', why: c.name + ' ends ' + a.fmt(c.end_date) + (a.n(c.target_starts) ? ': ' + a.n(c.actual_starts) + ' of ' + a.n(c.target_starts) + ' starts so far.' : a.n(c.target_outcomes) ? ': ' + a.n(c.actual_outcomes) + ' of ' + a.n(c.target_outcomes) + ' outcomes so far.' : '.'), rank: 2000 - left, contract: c }); });
    return out.sort(function (x, y) { return y.rank - x.rank; });
  }
  var LABEL = { lapsed: ['Lapsed', '#FDECEC', '#B42318'], regular: ['Regular', '#E7F6EC', '#1E7B3C'], 'new': ['New donor', '#E8F0FE', '#1A56DB'], major: ['Larger giver', '#EFEAFB', '#5B3FB8'], renewal: ['Renewal', '#FEF6E7', '#B7791F'] };
  var prevDon = window.vlDonTop;
  window.vlDonTop = function () {
    var html = typeof prevDon === 'function' ? prevDon() : '', a = A(), esc = a.esc, P = prospects(); if (!P.length) return html;
    return html + '<div class="card" style="margin-bottom:14px"><div class="card-title">Who to ask next</div><div style="font-size:13px;color:var(--txt2);margin-bottom:6px">Worked out from your giving history and contracts. Press Draft and Vorlana writes the approach from your recent work.</div>' +
      P.slice(0, 8).map(function (p, i) { var l = LABEL[p.kind]; return '<div style="padding:8px 0;border-top:1px solid var(--border);font-size:13px"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="badge" style="background:' + l[1] + ';color:' + l[2] + '">' + l[0] + '</span><b>' + esc(p.name) + '</b><span style="flex:1;min-width:200px;color:var(--txt2)">' + esc(p.why) + '</span><button class="btn btn-ai btn-sm" onclick="vlAskDraft(' + i + ',this)">Draft</button></div><div id="rc-ask-' + i + '"></div></div>'; }).join('') +
      (P.length > 8 ? '<div style="font-size:12px;color:var(--txt3);margin-top:6px">and ' + (P.length - 8) + ' more</div>' : '') + '</div>';
  };
  window.vlAskDraft = async function (i, btn) {
    var a = A(), p = prospects()[i], box = $('rc-ask-' + i); if (!p || !box) return;
    btn.disabled = true; btn.textContent = 'Writing…';
    var goal = { lapsed: 'a warm message to a donor who has not given for a while: thank them for their past support, show what has happened since with one or two real figures, and gently invite them to give again. No guilt.',
      regular: 'a message to a donor who gives often: thank them, show the difference with one or two real figures, and invite them to consider a regular monthly gift, with no pressure.',
      'new': 'a follow-up to a first-time donor about two to eight weeks after their gift: show what gifts like theirs made possible with one or two real figures. Do not ask for money.',
      major: 'a personal update to a generous donor: what their support has helped achieve, with two real figures, and an offer to visit or talk. Do not ask for money.',
      renewal: 'a short email to a funder whose grant is coming to an end: thank them, summarise progress against the targets using only the figures given, and ask for a conversation about continuing the work.' }[p.kind];
    try {
      var t = await callClaude('Write ' + goal + ' From a UK charity. 90-140 words, starting "Dear <first name or organisation>,". Use only the details and facts given; never invent figures, people, plans or promises; never name anyone the charity supports. British English, plain and warm, no emoji, no headings, no subject line. Sign off "With thanks, the team at ' + a.orgName() + '".',
        'To: ' + p.name + '\nWhy now: ' + p.why + (p.gifts ? '\nTheir giving: ' + p.gifts + ' gift' + (p.gifts === 1 ? '' : 's') + ', ' + a.gbp(p.total) + ' in total' + (p.fund ? ', most recently to ' + p.fund : '') : '') + '\n\nThe charity\'s recent work:\n' + a.factsFor(a.iso(a.addDays(new Date(), -180)), a.today(), { quotes: 1, eventList: 3 }), 400, false, { purpose: 'fundraising-ask' });
      box.innerHTML = '<div id="rc-askt-' + i + '" contenteditable="true" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.6;white-space:pre-wrap;outline:none;margin-top:8px">' + a.esc(String(t).trim()) + '</div><div style="display:flex;gap:6px;margin-top:6px"><button class="btn btn-ghost btn-sm" onclick="vlCopyEl(\'rc-askt-' + i + '\',this)">Copy</button>' +
        (p.email ? '<a class="btn btn-ghost btn-sm" href="mailto:' + a.esc(p.email) + '?subject=' + encodeURIComponent('From ' + a.orgName()) + '&body=' + encodeURIComponent(String(t).trim()) + '">Open in email</a>' : '') + '</div>';
    } catch (e) { if (e.message !== 'AI_PLAN_GATE') box.innerHTML = '<div class="alert alert-warn" style="margin-top:8px">' + a.esc(e.message) + '</div>'; }
    btn.disabled = false; btn.textContent = 'Draft';
  };

  // ── My day: the phone screen for frontline staff ──────────────
  function myDayPage() {
    var main = $('main'); if (!main || $('page-myday')) return; var d = document.createElement('div'); d.className = 'page'; d.id = 'page-myday';
    d.innerHTML = '<div id="rc-myday" style="max-width:560px;margin:0 auto"></div>'; main.appendChild(d);
  }
  function renderMyDay() {
    var el = $('rc-myday'); if (!el) return; var a = A(), esc = a.esc, mp = a.myPeople(), t = a.today();
    var mine = mp.list.filter(function (p) { return p.stage !== 'Closed'; });
    var score = function (p) { var s = since(p.last_contact); return ((p.safeguarding || p.risk === 'High') ? 1000 : 0) + (s == null ? 400 : s); };
    var need = mine.filter(function (p) { var s = since(p.last_contact); return s == null || s > 14 || ((p.safeguarding || p.risk === 'High') && s > 7); }).sort(function (x, y) { return score(y) - score(x); });
    var ok = mine.length - need.length;
    var ev = (DB.events || []).filter(function (e) { return e.date >= t && e.date <= a.iso(a.addDays(new Date(), 7)); }).sort(function (x, y) { return x.date < y.date ? -1 : 1; });
    var big = 'display:flex;align-items:center;justify-content:center;gap:6px;min-height:46px;border-radius:12px;font-size:15px;font-weight:600;flex:1;text-decoration:none;border:0;cursor:pointer';
    el.innerHTML = '<div style="font-size:22px;font-weight:700;margin:4px 0 2px">My day</div><div style="color:var(--txt3);font-size:14px;margin-bottom:14px">' + esc(new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })) + ' · ' + mine.length + ' people in ' + esc(mp.who) + ' caseload</div>' +
      '<div style="font-weight:700;margin-bottom:8px">' + (need.length ? need.length + ' to contact' : 'Everyone has been contacted recently') + (ok && need.length ? ' <span style="font-weight:400;color:var(--txt3)">· ' + ok + ' up to date</span>' : '') + '</div>' +
      need.slice(0, 12).map(function (p) { var s = since(p.last_contact), hot = p.safeguarding || p.risk === 'High';
        return '<div class="card" style="margin-bottom:10px;padding:14px;border-left:4px solid ' + (hot ? '#B42318' : '#B7791F') + '"><div style="font-size:17px;font-weight:700">' + esc(p.first_name + ' ' + p.last_name) + '</div>' +
          '<div style="font-size:13px;color:var(--txt2);margin:2px 0 10px">' + esc([hot ? (p.safeguarding ? 'Safeguarding flag' : 'High risk') : '', s == null ? 'No contact recorded' : 'Last contact ' + s + ' days ago', p.stage].filter(Boolean).join(' · ')) + '</div>' +
          '<div style="display:flex;gap:8px">' + (p.phone ? '<a href="tel:' + esc(String(p.phone).replace(/[^\d+]/g, '')) + '" style="' + big + ';background:#EFEFF2;color:var(--txt)">📞 Call</a>' : '') + '<button onclick="openNotes(\'' + esc(p.id) + '\')" style="' + big + ';background:#1F6F6D;color:#fff">🎙 Add a note</button></div></div>'; }).join('') +
      (need.length > 12 ? '<div style="font-size:13px;color:var(--txt3);margin-bottom:10px">and ' + (need.length - 12) + ' more on the Participants page</div>' : '') +
      '<div style="font-weight:700;margin:18px 0 8px">This week</div>' + (ev.length ? ev.slice(0, 6).map(function (e) { return '<div class="card" onclick="go(\'events\')" style="margin-bottom:8px;padding:12px 14px;cursor:pointer"><b>' + esc(e.name) + '</b><div style="font-size:13px;color:var(--txt2)">' + esc(a.fmt(e.date)) + (e.capacity && e.capacity_set !== false ? ' · ' + a.n(e.attendees) + ' of ' + a.n(e.capacity) + ' places taken' : '') + '</div></div>'; }).join('') : '<div style="font-size:13px;color:var(--txt3)">No events in the next 7 days.</div>') +
      '<button onclick="go(\'participants\')" style="' + big + ';width:100%;background:#EFEFF2;color:var(--txt);margin-top:16px">All my people</button>';
  }

  var tries = 0, phoned = false;
  (function wait() {
    if (window.vlAO && window.vlAO.on() && $('ao-ask-btn')) {
      myDayPage(); window.VL_EXTRA_PAGES = window.VL_EXTRA_PAGES || {}; window.VL_EXTRA_PAGES.myday = renderMyDay;
      // after a note is saved from My day, the list is redrawn; on a phone, frontline staff land here
      var an = window.addNote; if (typeof an === 'function' && !an._rc) { window.addNote = async function () { var r = await an.apply(this, arguments); if ($('page-myday') && $('page-myday').classList.contains('active')) renderMyDay(); return r; }; window.addNote._rc = true; }
      if (!phoned && window.innerWidth < 700 && window.vlAO.lens() === 'frontline') { phoned = true; setTimeout(function () { go('myday'); }, 400); }
      return;
    }
    if (++tries > 120) return; setTimeout(wait, 500);
  })();
  if (window.__VORLANA_TEST) window.__reachTest = { ceoRows: ceoRows, prospects: prospects };
})();
