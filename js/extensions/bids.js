// js/extensions/bids.js — the bid tracker, with no admin.
// A bid is saved automatically when Vorlana writes it (questions and answers included), kept up to date as it's edited,
// and marked "submitted" when it's downloaded or copied. Eight weeks later the writer gets one email asking
// "Did you win?" (api/bid-asks.js). "Your bids" on the Find funding page shows the win rate and opens any past bid.
// Needs bid-tracker.sql; without it, this stays hidden.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var bids = [], ready = false, currentId = null, currentKey = '', showAll = false, noContent = false, saveTimer = null;
  var LABEL = { drafted: 'Drafted', submitted: 'Sent', won: 'Won', lost: 'Not won', withdrawn: 'Withdrawn' };
  var COLOUR = { drafted: '#F0F0F2;color:#424245', submitted: '#E8F0FE;color:#1A56DB', won: '#E7F6EC;color:#1E7B3C', lost: '#FDECEC;color:#B42318', withdrawn: '#F0F0F2;color:#6E6E73' };

  function money(s) { var m = String(s || '').replace(/,/g, '').match(/£\s*(\d+(?:\.\d+)?)\s*(k)?/i); return m ? Math.round(parseFloat(m[1]) * (m[2] ? 1000 : 1)) : 0; }
  function when(d) { try { return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); } catch (e) { return ''; } }

  async function load() {
    if (typeof sb === 'undefined' || !sb || typeof orgId === 'undefined' || !orgId) return;
    try {
      var r = await sb.from('bids').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(100);
      if (r.error) { ready = false; return; }
      bids = (r.data || []).slice(); ready = true;
    } catch (e) { ready = false; }
    paint();
  }

  function paint() {
    var side = document.querySelector('#page-bd .bd-side'); if (!side) return;
    var box = $('vl-bids');
    if (!ready || !bids.length) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.id = 'vl-bids'; box.className = 'card'; box.style.marginBottom = '16px'; side.insertBefore(box, side.firstChild); }
    var decided = bids.filter(function (b) { return b.status === 'won' || b.status === 'lost'; });
    var won = bids.filter(function (b) { return b.status === 'won'; });
    var raised = won.reduce(function (a, b) { return a + (Number(b.amount_won) || money(b.amount)); }, 0);
    var waiting = bids.filter(function (b) { return b.status === 'submitted'; }).length;
    var list = showAll ? bids : bids.slice(0, 6);
    box.innerHTML = '<div style="font-size:17px;font-weight:650;color:var(--txt);margin-bottom:4px">Your bids</div>' +
      '<div style="font-size:13px;color:var(--txt3);margin-bottom:12px">' +
        (decided.length ? '<b style="color:var(--txt)">' + Math.round(100 * won.length / decided.length) + '% win rate</b> · won ' + won.length + ' of ' + decided.length + (raised ? ' · £' + raised.toLocaleString('en-GB') + ' raised' : '') : 'Your win rate appears once you hear back.') +
        (waiting ? ' · ' + waiting + ' waiting to hear' : '') + '</div>' +
      list.map(function (b) {
        var acts = b.status === 'submitted' ? '<button class="btn btn-ghost btn-sm" onclick="vlBidResult(\'' + b.id + '\',\'won\')">Won</button> <button class="btn btn-ghost btn-sm" onclick="vlBidResult(\'' + b.id + '\',\'lost\')">Not won</button>'
          : b.status === 'drafted' ? '<button class="btn btn-ghost btn-sm" onclick="vlBidResult(\'' + b.id + '\',\'submitted\')">Mark as sent</button>' : '';
        var canOpen = Array.isArray(b.questions) && b.questions.length;
        return '<div style="padding:10px 0;border-top:1px solid var(--border)' + (b.id === currentId ? ';background:rgba(31,111,109,.05);margin:0 -10px;padding:10px' : '') + '"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">' +
          '<div style="min-width:0">' + (canOpen ? '<a href="#" onclick="vlBidOpen(\'' + b.id + '\');return false" style="font-size:13.5px;font-weight:600;color:var(--em2);text-decoration:none">' + esc(b.funder) + ' ›</a>' : '<div style="font-size:13.5px;font-weight:600;color:var(--txt)">' + esc(b.funder) + '</div>') +
          '<div style="font-size:12px;color:var(--txt3)">' + esc([b.programme, b.amount, when(b.created_at)].filter(Boolean).join(' · ')) + '</div></div>' +
          '<span class="badge" style="background:' + (COLOUR[b.status] || COLOUR.drafted) + '">' + esc(LABEL[b.status] || b.status) + '</span></div>' +
          (acts || canOpen ? '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' + (canOpen ? '<button class="btn btn-ghost btn-sm" onclick="vlBidOpen(\'' + b.id + '\')">Open</button>' : '') + acts + '</div>' : '') + '</div>';
      }).join('') +
      (bids.length > 6 ? '<a href="#" onclick="vlBidsAll();return false" style="display:block;margin-top:10px;font-size:12.5px;color:var(--em);font-weight:600">' + (showAll ? 'Show fewer' : 'Show all ' + bids.length + ' bids') + '</a>' : '');
  }
  window.vlBidsAll = function () { showAll = !showAll; paint(); };

  // What's on screen now, ready to save
  function content() {
    var qs = (typeof _eoiQuestions !== 'undefined' && _eoiQuestions) || [], ans = (typeof _eoiAnswers !== 'undefined' && _eoiAnswers) || {};
    return { questions: qs.map(function (q) { return { id: q.id, question: q.question, wordLimit: q.wordLimit || null, charLimit: q.charLimit || null, guidance: q.guidance || '', proposal: !!q.proposal }; }),
      answers: ans, project_text: (typeof _eoiProject !== 'undefined' && _eoiProject) || null, funder_full: (($('eoi-funder') || {}).value || '').trim() || null };
  }

  // A bid has been written: save it (once per funder + project)
  async function drafted() {
    if (!ready || typeof sb === 'undefined' || !orgId) return;
    var funder = (($('eoi-funder') || {}).value || '').trim(); if (!funder) return;
    var sel = (typeof _bdSel !== 'undefined' && _bdSel) || {};
    var project = (typeof _eoiProject !== 'undefined' && _eoiProject) || '';
    var key = funder + '|' + project;
    if (currentId && key === currentKey) { save(); return; }
    var amt = (project.match(/Amount requested:\s*([^.]+)/i) || [])[1] || '';
    var row = { org_id: orgId, funder: funder.split(' — ')[0].slice(0, 200), programme: (sel.programme || funder.split(' — ')[1] || '').slice(0, 200) || null,
      project: project.split(':')[0].slice(0, 300) || null, amount: amt.trim().slice(0, 60) || null, deadline: (sel.deadline || '').slice(0, 80) || null, url: sel.url || null, status: 'drafted' };
    try {
      var r = await sb.from('bids').insert([noContent ? row : Object.assign({}, row, content())]).select();
      if (r.error && !noContent) { noContent = true; r = await sb.from('bids').insert([row]).select(); }   // before the answers columns were added
      if (!r.error && r.data && r.data[0]) { currentId = r.data[0].id; currentKey = key; bids.unshift(r.data[0]); paint(); }
    } catch (e) { /* tracker is optional */ }
  }
  // Keep the saved copy up to date as answers are edited and gaps filled
  async function save() {
    if (!currentId || noContent) return;
    try {
      var c = content();
      var r = await sb.from('bids').update(c).eq('id', currentId);
      if (r.error) { noContent = true; return; }
      var b = bids.find(function (x) { return x.id === currentId; }); if (b) Object.assign(b, c);
    } catch (e) { /* optional */ }
  }
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(save, 1500); }

  // Downloaded or copied: it's on its way to the funder
  async function sent() {
    if (!currentId) await drafted();
    if (!currentId) return;
    await save();
    var b = bids.find(function (x) { return x.id === currentId; });
    if (b && b.status !== 'drafted') return;
    await setStatus(currentId, 'submitted');
  }
  async function setStatus(id, status) {
    var patch = { status: status };
    if (status === 'submitted') patch.submitted_at = new Date().toISOString();
    if (status === 'won' || status === 'lost') patch.decided_at = new Date().toISOString();
    if (status === 'won') {
      var b0 = bids.find(function (x) { return x.id === id; }) || {};
      var got = window.prompt('Brilliant! How much did you win? (leave as it is if it was the amount you asked for)', b0.amount || '');
      if (got === null) return;
      if (money(got)) patch.amount_won = money(got);
    }
    try {
      var r = await sb.from('bids').update(patch).eq('id', id);
      if (r.error) throw r.error;
      var b = bids.find(function (x) { return x.id === id; }); if (b) Object.assign(b, patch);
      paint();
    } catch (e) { alert('Couldn’t update that bid: ' + (e.message || e)); }
  }
  window.vlBidResult = setStatus;

  // Open a past bid: its questions and answers come back on screen, ready to edit, download or reuse
  window.vlBidOpen = function (id) {
    var b = bids.find(function (x) { return x.id === id; });
    if (!b || !Array.isArray(b.questions) || !b.questions.length) { alert('This bid was saved before answers were kept, so there’s nothing to open.'); return; }
    if (typeof go === 'function' && !document.querySelector('#page-bd.active')) go('bd');
    _eoiQuestions = b.questions.map(function (q) { return { id: q.id, question: q.question, wordLimit: q.wordLimit || null, charLimit: q.charLimit || null, guidance: q.guidance || '', proposal: !!q.proposal }; });
    _eoiAnswers = Object.assign({}, b.answers || {});
    _eoiProject = b.project_text || '';
    if (typeof _eoiProjectFor !== 'undefined') _eoiProjectFor = b.funder_full || b.funder;
    _bdSel = { funder: b.funder, programme: b.programme, deadline: b.deadline, url: b.url };
    _eoiDoc = { kind: 'text', url: b.url, reopened: true };
    window._eoiAssessed = null;
    var f = $('eoi-funder'); if (f) f.value = b.funder_full || (b.funder + (b.programme ? ' — ' + b.programme : ''));
    currentId = b.id; currentKey = (f ? f.value : b.funder) + '|' + (_eoiProject || '');
    if (typeof bdShowSection === 'function') bdShowSection(3);
    if (typeof renderFilledEOI === 'function') renderFilledEOI();
    var note = $('bd-pull-note'); if (note) note.innerHTML = '<div class="bd-pullnote" style="background:#F0FDF4">Opened your <b>' + esc(b.funder) + '</b> bid from ' + esc(when(b.created_at)) + '. Changes are saved as you go.</div>';
    paint();
    var out = $('eoi-output'); if (out && out.scrollIntoView) out.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  // Hook into the bid writer without changing it
  function wrap(name, after) {
    var f = window[name]; if (typeof f !== 'function' || f._vlBids) return;
    var w = async function () { var r = await f.apply(this, arguments); try { await after.apply(this, arguments); } catch (e) { /* optional */ } return r; };
    w._vlBids = true; window[name] = w;
  }
  (function wait(t) {
    if (typeof runEOIFormFill === 'function' && typeof sb !== 'undefined' && typeof go === 'function') {
      wrap('runEOIFormFill', function () { if (typeof _eoiAnswers !== 'undefined' && Object.keys(_eoiAnswers).length) return drafted(); });
      wrap('runEOIGenerator', function () { return drafted(); });
      ['downloadFilledForm', 'downloadAnswersDoc', 'downloadEOIPDF', 'copyEOI'].forEach(function (n) { wrap(n, sent); });
      wrap('applyEOIGaps', function () { return save(); });
      var ed = window._eoiEditAnswer;
      if (typeof ed === 'function') window._eoiEditAnswer = function () { var r = ed.apply(this, arguments); saveSoon(); return r; };
      var pf = window.pullFunderForm;
      window.pullFunderForm = function () { currentId = null; currentKey = ''; return pf.apply(this, arguments); };
      var g = window.go;
      window.go = function (p) { var r = g.apply(this, arguments); if (p === 'bd') load(); return r; };
      if (document.querySelector('#page-bd.active')) load();
      return;
    }
    if (t < 100) setTimeout(function () { wait(t + 1); }, 100);
  })(0);
  if (window.__VORLANA_TEST) window.__bidsTest = { money: money, load: load, paint: paint };
})();
