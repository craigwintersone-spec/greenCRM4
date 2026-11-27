// js/extensions/people-plus.js — volunteers' own pages, hubs, and a five-minute setup (demo account only)
//   • Volunteer self-service (Volunteers page): each active volunteer gets a personal link (volunteer.html) to see
//     what's coming up, say "I'll be there", and see their hours. A reminder goes the day before. Staff see who's coming.
//   • Hubs: group teams and contracts into hubs (organisations.settings.hubs); the CEO view then shows one line per hub.
//   • Setup: four short steps for a new organisation: what you do, your funding, dates you mustn't miss, done.
// Depends on ai-office.js (vlAO), office-plus.js (vlOP), reach.js (vlCeoRows), grow.js (vlSetupOpen), api/office.js.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var A = function () { return window.vlAO; }, OP = function () { return window.vlOP; };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  async function saveSettings(patch) {
    var st = Object.assign({}, (currentOrg && currentOrg.settings) || {}, patch);
    await sbUpdate('organisations', { settings: st }, orgId); currentOrg = Object.assign({}, currentOrg, { settings: st });
  }

  // ── Volunteer self-service ────────────────────────────────────
  var SIGN = null, volMsg = '', LINKS = null;
  async function loadSign() { var r = await A().q('volunteer_signups'); SIGN = r; }
  function volCard() {
    var page = $('page-volunteers'); if (!page || !A() || !A().on()) return;
    var box = $('pp-vol'); if (!box) { box = document.createElement('div'); box.id = 'pp-vol'; box.className = 'card'; box.style.marginBottom = '16px'; var h = page.querySelector('.page-header'); page.insertBefore(box, h ? h.nextSibling : page.firstChild); }
    var a = A(), t = a.today(), V = (DB.volunteers || []).filter(function (v) { return v.status === 'Active'; }), withEmail = V.filter(function (v) { return v.email; }).length;
    var by = {}; (SIGN || []).forEach(function (s) { (by[String(s.event_id)] = by[String(s.event_id)] || []).push(String(s.volunteer_id)); });
    var up = (DB.events || []).filter(function (e) { return e.date >= t && by[String(e.id)]; }).sort(function (x, y) { return x.date < y.date ? -1 : 1; }).slice(0, 6);
    box.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div class="card-title" style="margin:0">Volunteers’ own pages</div><button class="btn btn-p btn-sm" onclick="vlVolSend()">Email every active volunteer their link</button></div>' +
      '<div style="font-size:13px;color:var(--txt2);margin:6px 0">Each volunteer gets a personal link, with no password: what’s coming up, “I’ll be there”, and the hours they’ve given. They get a reminder the day before. ' + V.length + ' active volunteers, ' + withEmail + ' with an email address.</div>' +
      (SIGN === null ? '<div style="font-size:12px;color:#B7791F">Run the latest ai-office.sql in Supabase to switch this on.</div>' : up.length ? '<div style="font-weight:700;font-size:13px;margin-top:8px">Who’s coming</div>' + up.map(function (e) {
        var names = by[String(e.id)].map(function (id) { var v = (DB.volunteers || []).find(function (x) { return String(x.id) === id; }); return v ? v.name : null; }).filter(Boolean);
        return '<div style="font-size:13px;padding:6px 0;border-top:1px solid var(--border)"><b>' + esc(e.name) + '</b> · ' + esc(a.fmt(e.date)) + ' · ' + names.length + ' volunteer' + (names.length === 1 ? '' : 's') + (names.length ? ': ' + esc(names.join(', ')) : '') + '</div>'; }).join('') : '<div style="font-size:12px;color:var(--txt3)">Nobody has signed up to a coming session yet.</div>') +
      (volMsg ? '<div style="font-size:13px;color:var(--txt2);margin-top:8px">' + esc(volMsg) + '</div>' : '') +
      (LINKS ? '<details style="margin-top:8px"><summary style="font-size:12px;color:var(--txt3);cursor:pointer">Copy one volunteer’s link</summary>' + V.slice(0, 60).map(function (v) { return LINKS[String(v.id)] ? '<div style="font-size:12px;padding:3px 0">' + esc(v.name) + ': <a href="volunteer.html?t=' + LINKS[String(v.id)] + '" target="_blank">open their page</a></div>' : ''; }).join('') + '</details>' : '');
  }
  window.vlVolSend = async function () {
    var V = (DB.volunteers || []).filter(function (v) { return v.status === 'Active' && v.email; }).length;
    if (!confirm('Email ' + V + ' active volunteer' + (V === 1 ? '' : 's') + ' their personal link now?')) return;
    volMsg = 'Sending…'; volCard();
    try { var j = await OP().api({ action: 'vol_links', send: true }); LINKS = j.links || {}; volMsg = j.sent + ' email' + (j.sent === 1 ? '' : 's') + ' sent.' + (j.no_email ? ' ' + j.no_email + ' volunteer' + (j.no_email === 1 ? ' has' : 's have') + ' no email address: use “Copy one volunteer’s link” for them.' : ''); }
    catch (e) { volMsg = /volunteer_links|404|relation/.test(e.message) ? 'Run the latest ai-office.sql in Supabase first.' : e.message; }
    volCard();
  };
  async function volOpen() { volCard(); if (SIGN === null || SIGN) { await loadSign(); volCard(); } if (!LINKS && SIGN !== null) { try { var j = await OP().api({ action: 'vol_links' }); LINKS = j.links || {}; volCard(); } catch (e) { /* shown when they press send */ } } }

  // ── Hubs ──────────────────────────────────────────────────────
  var hubs = function () { return ((currentOrg && currentOrg.settings && currentOrg.settings.hubs) || []).slice(); };
  var editing = false, draft = null;
  var prevRender = window.vlLensRender;
  window.vlLensRender = function (L) {
    var base = typeof prevRender === 'function' ? prevRender(L) : null; if (L !== 'ceo' || !base) return base;
    var H = hubs(), link = '<div style="margin-top:6px"><a href="#" onclick="vlHubsEdit();return false" style="font-size:12px">' + (H.length ? 'Change hubs' : 'Group these into hubs') + '</a></div>';
    if (editing) return { title: 'Hubs', html: editor() };
    if (!H.length) return { title: base.title, html: base.html + link };
    var r = window.vlCeoRows(), rank = { red: 0, amber: 1, green: 2 }, DOT = { red: '#B42318', amber: '#B7791F', green: '#1E7B3C' }, used = { p: {}, t: {} };
    var rows = H.map(function (h) {
      var P = r.progs.filter(function (p) { return (h.contracts || []).indexOf(p.id) >= 0; }), T = r.teams.filter(function (t) { return (h.teams || []).indexOf(t.key) >= 0; });
      P.forEach(function (p) { used.p[p.id] = 1; }); T.forEach(function (t) { used.t[t.key] = 1; });
      var all = P.concat(T), lvl = all.reduce(function (w, x) { return rank[x.lvl] < rank[w] ? x.lvl : w; }, 'green');
      return { name: h.name, lvl: lvl, sub: P.length + ' programme' + (P.length === 1 ? '' : 's') + ', ' + T.length + ' team' + (T.length === 1 ? '' : 's'), flags: all.filter(function (x) { return x.flags.length; }).map(function (x) { return x.name + ': ' + x.flags.join(', '); }) };
    });
    var loose = r.progs.filter(function (p) { return !used.p[p.id]; }).concat(r.teams.filter(function (t) { return !used.t[t.key]; }));
    if (loose.length) rows.push({ name: 'Not in a hub yet', lvl: loose.reduce(function (w, x) { return rank[x.lvl] < rank[w] ? x.lvl : w; }, 'green'), sub: loose.map(function (x) { return x.name; }).join(', '), flags: loose.filter(function (x) { return x.flags.length; }).map(function (x) { return x.name + ': ' + x.flags.join(', '); }) });
    rows.sort(function (x, y) { return rank[x.lvl] - rank[y.lvl]; });
    var red = rows.filter(function (x) { return x.lvl === 'red'; }).length, amber = rows.filter(function (x) { return x.lvl === 'amber'; }).length;
    return { title: 'CEO view by hub: ' + (red ? red + ' need you' : amber ? 'nothing urgent' : 'all on track') + (amber ? ', ' + amber + ' to watch' : ''),
      html: rows.map(function (x) { return '<div style="display:flex;gap:10px;align-items:flex-start;padding:9px 12px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;font-size:13px;background:var(--surface,#fff)"><span style="width:10px;height:10px;border-radius:50%;background:' + DOT[x.lvl] + ';margin-top:5px;flex-shrink:0"></span><span style="flex:1"><b style="font-size:14px">' + esc(x.name) + '</b> <span style="color:var(--txt3)">· ' + esc(x.sub) + '</span>' +
        (x.flags.length ? x.flags.map(function (f) { return '<div style="color:var(--txt2)">' + esc(f) + '</div>'; }).join('') : '<div style="color:var(--txt3)">On track</div>') + '</span></div>'; }).join('') + link };
  };
  function editor() {
    var r = window.vlCeoRows(), D = draft;
    var tick = function (hi, kind, key, label) { var onIt = (D[hi][kind] || []).indexOf(key) >= 0; return '<label style="display:inline-flex;gap:5px;align-items:center;font-size:12px;margin:2px 10px 2px 0;font-weight:400"><input type="checkbox" style="width:auto" ' + (onIt ? 'checked' : '') + ' onchange="vlHubTick(' + hi + ',\'' + kind + '\',\'' + esc(key).replace(/'/g, '\\\'') + '\',this.checked)"/>' + esc(label) + '</label>'; };
    return '<div style="font-size:13px;color:var(--txt2);margin-bottom:8px">A hub is a site, service or manager’s area. Tick the teams and programmes that belong to each. The CEO view then shows one line per hub.</div>' +
      D.map(function (h, i) { return '<div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px"><div style="display:flex;gap:6px"><input value="' + esc(h.name) + '" placeholder="Hub name, e.g. Riverside hub" onchange="vlHubName(' + i + ',this.value)" style="flex:1"/><button class="btn btn-ghost btn-sm" onclick="vlHubDel(' + i + ')">×</button></div>' +
        '<div style="margin-top:6px"><span style="font-size:11px;color:var(--txt3)">Teams</span><br>' + r.teams.map(function (t) { return tick(i, 'teams', t.key, t.name); }).join('') + '</div>' +
        '<div style="margin-top:4px"><span style="font-size:11px;color:var(--txt3)">Programmes</span><br>' + r.progs.map(function (p) { return tick(i, 'contracts', p.id, p.name); }).join('') + '</div></div>'; }).join('') +
      '<div style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" onclick="vlHubAdd()">+ Add a hub</button><button class="btn btn-p btn-sm" onclick="vlHubsSave()">Save hubs</button><button class="btn btn-ghost btn-sm" onclick="vlHubsCancel()">Cancel</button></div>';
  }
  var repaint = function () { if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks(); };
  window.vlHubsEdit = function () { draft = hubs().map(function (h) { return { id: h.id, name: h.name, teams: (h.teams || []).slice(), contracts: (h.contracts || []).slice() }; }); if (!draft.length) draft.push({ id: 'h' + Date.now(), name: '', teams: [], contracts: [] }); editing = true; repaint(); };
  window.vlHubAdd = function () { draft.push({ id: 'h' + Date.now(), name: '', teams: [], contracts: [] }); repaint(); };
  window.vlHubDel = function (i) { draft.splice(i, 1); repaint(); };
  window.vlHubName = function (i, v) { draft[i].name = String(v).trim().slice(0, 60); };
  window.vlHubTick = function (i, kind, key, onIt) { draft.forEach(function (h, j) { h[kind] = (h[kind] || []).filter(function (k) { return k !== key; }); if (j === i && onIt) h[kind].push(key); }); repaint(); };   // a team or programme sits in one hub
  window.vlHubsCancel = function () { editing = false; repaint(); };
  window.vlHubsSave = async function () {
    var clean = draft.filter(function (h) { return h.name; }); if (draft.some(function (h) { return !h.name; }) && !clean.length && draft.length) { alert('Give the hub a name.'); return; }
    try { await saveSettings({ hubs: clean }); editing = false; } catch (e) { alert('Couldn’t save: ' + (e.message || e)); }
    repaint();
  };

  // ── Setup in four steps ───────────────────────────────────────
  var step = 0, W = { areas: {}, dates: {} };
  var AREAS = [['people', 'We support people one to one', ['participants', 'evidence', 'demographics']], ['events', 'We run sessions, groups or events', ['events']], ['volunteers', 'We work with volunteers', ['volunteers']],
    ['circular', 'We reuse, repair, share food or grow', ['circular']], ['funded', 'We have grants or contracts to report on', ['funders', 'bd']], ['donors', 'We take donations', ['contacts']]];
  var DATES = ['Charity Commission annual return', 'Annual accounts filing', 'Public liability insurance renewal', 'Safeguarding policy review', 'DBS checks: review who is due'];
  function wiz() {
    var ov = $('pp-wiz'); if (!ov) { ov = document.createElement('div'); ov.id = 'pp-wiz'; ov.className = 'modal-overlay'; ov.innerHTML = '<div class="modal" style="max-width:600px"><div id="pp-wiz-body"></div></div>'; document.body.appendChild(ov); }
    ov.classList.add('open'); ov.style.display = 'flex';
    var el = $('pp-wiz-body'), bar = '<div style="display:flex;gap:4px;margin-bottom:14px">' + [0, 1, 2, 3].map(function (i) { return '<span style="flex:1;height:4px;border-radius:2px;background:' + (i <= step ? '#1F6F6D' : 'var(--border)') + '"></span>'; }).join('') + '</div>';
    var nav = function (next, label) { return '<div style="display:flex;gap:6px;margin-top:16px">' + (step ? '<button class="btn btn-ghost btn-sm" onclick="vlWizGo(' + (step - 1) + ')">Back</button>' : '') + '<button class="btn btn-p btn-sm" onclick="' + next + '">' + label + '</button><button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="vlWizClose()">Finish later</button></div><div id="pp-wiz-msg" style="font-size:13px;color:var(--txt2);margin-top:8px"></div>'; };
    if (step === 0) {
      var mods = (currentOrg && currentOrg.modules) || {};
      el.innerHTML = bar + '<h2 style="margin:0 0 4px">What does your organisation do?</h2><div style="font-size:13px;color:var(--txt2);margin-bottom:10px">Tick everything that fits. Vorlana only shows what you use, and you can change it any time in Settings.</div>' +
        AREAS.map(function (a) { var onIt = a[0] in W.areas ? W.areas[a[0]] : a[2].some(function (k) { return mods[k] !== false; }); W.areas[a[0]] = onIt;
          return '<label style="display:flex;gap:10px;align-items:center;padding:10px 12px;border:1px solid var(--border);border-radius:10px;margin-bottom:6px;cursor:pointer;font-weight:400"><input type="checkbox" style="width:auto" ' + (onIt ? 'checked' : '') + ' onchange="vlWizArea(\'' + a[0] + '\',this.checked)"/>' + a[1] + '</label>'; }).join('') + nav('vlWizAreas()', 'Next');
    } else if (step === 1) {
      el.innerHTML = bar + '<h2 style="margin:0 0 4px">Your funding</h2><div style="font-size:13px;color:var(--txt2);margin-bottom:12px">Drop in a grant agreement or award letter and Vorlana sets up the contract, its targets, budget and report deadlines. You tick what’s right before anything is created. Do it for each grant, now or later.</div>' +
        '<button class="btn btn-ai btn-sm" onclick="vlWizDoc()">✦ Read a grant agreement</button>' +
        '<div style="font-size:12px;color:var(--txt3);margin-top:10px">' + (DB.contracts || []).length + ' contract' + ((DB.contracts || []).length === 1 ? '' : 's') + ' set up so far.</div>' + nav('vlWizGo(2)', (DB.contracts || []).length ? 'Next' : 'Skip for now');
    } else if (step === 2) {
      el.innerHTML = bar + '<h2 style="margin:0 0 4px">Dates you mustn’t miss</h2><div style="font-size:13px;color:var(--txt2);margin-bottom:10px">Add the date for any that apply. Vorlana reminds you 30 days ahead, every year.</div>' +
        DATES.map(function (d, i) { return '<div style="display:flex;gap:10px;align-items:center;padding:6px 0;border-top:1px solid var(--border);font-size:13px"><span style="flex:1">' + d + '</span><input type="date" id="pp-wd-' + i + '" value="' + (W.dates[i] || '') + '" style="width:auto"/></div>'; }).join('') + nav('vlWizDates()', 'Next');
    } else {
      el.innerHTML = bar + '<h2 style="margin:0 0 4px">You’re set up</h2><div style="font-size:14px;line-height:1.7;color:var(--txt2)">From here Vorlana does the preparing and you do the approving.<br>• <b>Every morning</b> the Dashboard shows what needs you, and it’s emailed to managers when there’s something to act on.<br>• <b>Reports, thank-yous and newsletters</b> are drafted from your records, ready to check.<br>• <b>Ask Vorlana</b> (bottom right) answers questions from your own records.<br>• Got spreadsheets of people, events or volunteer hours? Each page has an import button.</div>' +
        '<div style="display:flex;gap:6px;margin-top:16px"><button class="btn btn-p btn-sm" onclick="vlWizClose(true)">Go to my Dashboard</button></div>';
    }
  }
  window.vlWizard = function () { step = 0; wiz(); };
  window.vlWizGo = function (n) { step = n; wiz(); };
  window.vlWizArea = function (k, v) { W.areas[k] = v; };
  window.vlWizAreas = async function () {
    var mods = Object.assign({}, (currentOrg && currentOrg.modules) || {});
    AREAS.forEach(function (a) { a[2].forEach(function (k) { mods[k] = !!W.areas[a[0]]; }); });
    if (!Object.keys(mods).some(function (k) { return mods[k]; })) { $('pp-wiz-msg').textContent = 'Tick at least one.'; return; }
    try { await sbUpdate('organisations', { modules: mods }, orgId); currentOrg = Object.assign({}, currentOrg, { modules: mods }); if (typeof applyModules === 'function') applyModules(mods, currentOrg.plan); step = 1; wiz(); }
    catch (e) { $('pp-wiz-msg').textContent = 'Couldn’t save: ' + (e.message || e); }
  };
  window.vlWizDoc = function () { window.vlWizClose(); go('funding'); setTimeout(function () { if (typeof window.vlSetupOpen === 'function') window.vlSetupOpen(); }, 300); try { sessionStorage.setItem('vl_wiz_resume', '2'); } catch (e) { /* none */ } };
  window.vlWizDates = async function () {
    var made = 0;
    for (var i = 0; i < DATES.length; i++) { var v = ($('pp-wd-' + i) || {}).value; if (v && W.dates[i] !== v) { try { await OP().addKeyDate({ title: DATES[i], due_date: v, repeat_months: 12, done_at: null }); made++; W.dates[i] = v; } catch (e) { $('pp-wiz-msg').textContent = 'Couldn’t save: ' + e.message; return; } } }
    step = 3; wiz(); repaint();
  };
  window.vlWizClose = function (done) { var ov = $('pp-wiz'); if (ov) { ov.classList.remove('open'); ov.style.display = 'none'; } if (done) { try { localStorage.setItem('vl_wiz_done_' + orgId, '1'); } catch (e) { /* none */ } go('dashboard'); } };
  // after "Read a grant agreement" closes, the setup carries on where it left off
  var sc = null;
  function resumeWatch() { var ov = $('gr-ov'), want = null; try { want = sessionStorage.getItem('vl_wiz_resume'); } catch (e) { /* none */ } if (!want) return; var open = ov && ov.style.display !== 'none' && ov.classList.contains('open'); if (sc === true && !open) { try { sessionStorage.removeItem('vl_wiz_resume'); } catch (e) { /* none */ } sc = null; step = 1; wiz(); return; } sc = !!open; }

  function newPanelButton() {
    var p = $('ao-new'); if (!p || $('pp-wiz-btn')) return; var row = p.lastElementChild; if (!row) return;
    var b = document.createElement('button'); b.id = 'pp-wiz-btn'; b.className = 'btn btn-p btn-sm'; b.textContent = 'Set up in 5 minutes'; b.onclick = window.vlWizard; row.insertBefore(b, row.firstChild);
  }

  var tries = 0, started = false;
  (function wait() {
    if (window.vlAO && window.vlAO.on() && $('ao-ask-btn')) {
      if (started) return; started = true;
      var og = window.go; window.go = function (page) { var r = og.apply(this, arguments); if (page === 'volunteers') setTimeout(volOpen, 200); return r; };
      setInterval(function () { newPanelButton(); resumeWatch(); if ($('page-volunteers') && $('page-volunteers').classList.contains('active') && !$('pp-vol')) volOpen(); }, 1200);
      // a brand-new organisation with nothing in it yet is walked through setup once
      var empty = !(DB.contracts || []).length && !(DB.participants || []).length && !(DB.events || []).length, seen = null; try { seen = localStorage.getItem('vl_wiz_done_' + orgId); } catch (e) { /* none */ }
      if (empty && !seen && !(typeof isAdviserRole === 'function' && isAdviserRole())) setTimeout(window.vlWizard, 1200);
      return;
    }
    if (++tries > 120) return; setTimeout(wait, 500);
  })();
  if (window.__VORLANA_TEST) window.__ppTest = { hubs: hubs };
})();
