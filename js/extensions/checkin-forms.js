// js/extensions/checkin-forms.js — the Check-in card under Settings, Feedback
// Every event's QR has a Check in tab with a simple standard form. To ask your funder's questions instead, paste or drop in their form:
// it is read once (checkin-parse.js), remembered, and used for every event or for one kind of event. Same idea as Feedback forms.
// Stored in organisations.settings: checkin_enabled, checkin_forms [{id,name,questions}], checkin_default, checkin_form_for_type.
// Answers arrive in the checkins table (api/event-checkin.js); here staff see today's count and download them.
// Depends on: checkin-parse.js (vlParseCheckinText), settings.js (renderFeedbackQuestionsCard), agents.js (readUploadedFormFile)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var TXT = 'text-transform:none;letter-spacing:0';
  var KIND = { single: 'Choose one', multi: 'Choose several', text: 'Short answer', number: 'Number', email: 'Email', postcode: 'Postcode', count: 'Number of under-16s' };

  function st() { return (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.settings) || {}; }
  function forms() { return Array.isArray(st().checkin_forms) ? st().checkin_forms : []; }
  function typeMap() { return st().checkin_form_for_type || {}; }
  async function save(patch) {
    var base = st();
    try { var cur = await sb.from('organisations').select('settings').eq('id', orgId).single(); if (cur && cur.data && cur.data.settings) base = cur.data.settings; } catch (e) { /* use what we have */ }
    var settings = Object.assign({}, base, patch);
    var res = await sb.from('organisations').update({ settings: settings }).eq('id', orgId);
    if (res && res.error) throw res.error;
    currentOrg = Object.assign({}, currentOrg, { settings: settings });
  }
  function eventTypes() {
    var seen = {}, out = [];
    [].slice.call(document.querySelectorAll('#evf-type option')).forEach(function (o) { if (o.value && !seen[o.value]) { seen[o.value] = 1; out.push(o.value); } });
    (DB.events || []).forEach(function (e) { if (e.type && !seen[e.type]) { seen[e.type] = 1; out.push(e.type); } });
    return out;
  }
  function usedFor(f) {
    var bits = [];
    if (st().checkin_default === f.id) bits.push('all events');
    Object.keys(typeMap()).forEach(function (t) { if (typeMap()[t] === f.id) bits.push(t + ' events'); });
    return bits.length ? 'used for ' + bits.join(', ') : 'not used yet';
  }
  function london() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); }

  // ── state of the drop-in box ──
  var S = { mode: 'idle', parsed: null, name: '', msg: '' };

  function reviewHTML() {
    var p = S.parsed, qs = p.questions, types = eventTypes();
    var asked = qs.filter(function (q) { return q.role !== 'location'; });
    return '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px">' +
      '<div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">Read ' + asked.length + ' question' + (asked.length === 1 ? '' : 's') + '</div>' +
      '<div style="font-size:12px;color:var(--txt3);margin-bottom:8px;' + TXT + '">from ' + esc(p.name) + (qs.some(function (q) { return q.role === 'location'; }) ? ' &middot; the location question is dropped: people check in to the session they are at' : '') + '</div>' +
      '<div style="max-height:300px;overflow:auto">' + asked.map(function (q) {
        return '<div style="border-top:1px solid var(--border);padding:7px 0;display:flex;justify-content:space-between;gap:10px;font-size:13px;color:var(--txt);' + TXT + '"><span>' + esc(q.label) + (q.required ? ' <b style="color:#C84545">*</b>' : '') + (q.showIf ? ' <i style="color:var(--txt3)">(only if ' + q.showIf.maxAge + ' or under)</i>' : '') + '</span><span style="color:var(--txt3);white-space:nowrap">' + esc(KIND[q.kind] || q.kind) + (q.options && q.options.length && q.kind !== 'count' ? ' &middot; ' + q.options.length : '') + '</span></div>';
      }).join('') + '</div>' +
      '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:10px 0 4px;' + TXT + '">Form name</div>' +
      '<input id="vlci-name" value="' + esc(S.name) + '" maxlength="80" style="font-size:14px;font-weight:600;margin-bottom:10px"/>' +
      '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:2px 0 4px;' + TXT + '">Use this form for</div>' +
      '<select id="vlci-use" style="margin-bottom:10px"><option value="all">All my events</option>' + types.map(function (t) { return '<option value="t:' + esc(t) + '">Only ' + esc(t) + ' events</option>'; }).join('') + '<option value="none">Don\u2019t use it yet</option></select>' +
      '<div id="vlci-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin-bottom:6px"></div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-ghost btn-sm" onclick="vlciMode(\'idle\')">Back</button><button class="btn btn-p btn-sm" id="vlci-go" onclick="vlciSave()">Save form</button></div></div>';
  }
  function dropHTML() {
    if (S.mode === 'busy') return '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:16px;font-size:14px;color:var(--txt);' + TXT + '">&#8987; Reading the form&hellip;</div>';
    if (S.mode === 'review' && S.parsed) return reviewHTML();
    if (S.mode === 'paste') return '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px"><div style="font-size:14px;font-weight:600;color:var(--txt);margin-bottom:6px;' + TXT + '">Paste the form</div>' +
      '<div style="font-size:12px;color:var(--txt3);margin-bottom:8px;' + TXT + '">Each question on its own line, with its answers underneath, one per line. A * at the end means required.</div>' +
      '<textarea id="vlci-paste" style="min-height:160px;font-size:13px"></textarea><div id="vlci-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin:6px 0"></div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-ghost btn-sm" onclick="vlciMode(\'idle\')">Back</button><button class="btn btn-p btn-sm" onclick="vlciPaste()">Read the form</button></div></div>';
    return '<div id="vlci-drop" style="border:2px dashed #A39C8E;border-radius:10px;padding:16px;text-align:center;cursor:pointer;background:var(--bg)" onclick="document.getElementById(\'vlci-file\').click()">' +
      '<div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">&#11014; Drop in a check-in form</div><div style="font-size:12px;color:var(--txt3);' + TXT + '">Word, PDF or text. We read the questions for you.</div>' +
      '<input type="file" id="vlci-file" accept=".docx,.pdf,.txt,text/plain" style="display:none" onchange="vlciFile(this)"/></div>' +
      '<div style="text-align:center;margin:8px 0 2px"><a href="#" style="font-size:12px" onclick="vlciMode(\'paste\');return false">or paste the questions</a></div>' +
      (S.msg ? '<div style="font-size:13px;color:#065F46;text-align:center;margin-top:6px;' + TXT + '">&#10003; ' + esc(S.msg) + '</div>' : '');
  }
  function cardHTML() {
    var on = st().checkin_enabled !== false, list = forms();
    var rows = list.length ? list.map(function (f) {
      var n = (f.questions || []).filter(function (q) { return q.role !== 'location'; }).length;
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--border)"><div style="min-width:0;flex:1">' +
        '<input value="' + esc(f.name) + '" maxlength="80" aria-label="Form name" title="Click to rename" style="font-weight:600;font-size:14px;color:var(--txt);border:1px solid transparent;background:transparent;padding:3px 6px;margin:0 0 0 -6px;width:100%;max-width:340px" ' +
        'onfocus="this.style.borderColor=\'var(--border)\';this.style.background=\'#fff\'" onblur="this.style.borderColor=\'transparent\';this.style.background=\'transparent\'" onkeydown="if(event.key===\'Enter\')this.blur();if(event.key===\'Escape\'){this.value=this.defaultValue;this.blur()}" onchange="vlciRename(\'' + esc(f.id) + '\',this)"/>' +
        '<div style="font-size:12px;color:var(--txt3);' + TXT + '">' + n + ' question' + (n === 1 ? '' : 's') + ' &middot; ' + esc(usedFor(f)) + '</div></div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0"><select style="width:auto;font-size:12px;padding:3px 6px" onchange="vlciUse(\'' + esc(f.id) + '\',this.value)" title="Where to use this form"><option value="">Use for&hellip;</option><option value="all">All events</option>' + eventTypes().map(function (t) { return '<option value="t:' + esc(t) + '">' + esc(t) + ' events</option>'; }).join('') + '<option value="none">Stop using it</option></select>' +
        '<button class="btn btn-ghost btn-sm" onclick="vlciDelete(\'' + esc(f.id) + '\')" aria-label="Remove form" title="Remove">&times;</button></div></div>';
    }).join('') : '<div style="font-size:13px;color:var(--txt3);padding:6px 0;' + TXT + '">No forms yet, so every event uses the standard check-in: \u201cfirst time here?\u201d and \u201chow many people?\u201d.</div>';
    return '<div id="vlci-card" style="margin:0 0 26px;padding-bottom:18px;border-bottom:2px solid var(--border)">' +
      '<div style="font-size:15px;font-weight:700;color:var(--txt);' + TXT + '">Check-in</div>' +
      '<div style="font-size:13px;color:var(--txt3);line-height:1.5;margin:2px 0 10px;' + TXT + '">Every event\u2019s QR code has a <b>Check in</b> tab. Out of the box it asks two things. To ask your funder\u2019s questions instead, drop their form in below.</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin:0 0 12px;font-size:14px;color:var(--txt);' + TXT + '"><input type="checkbox" id="vlci-on" ' + (on ? 'checked' : '') + ' style="width:18px;height:18px;margin:0;flex:none" onchange="vlciToggle(this.checked)"/><span>Show the Check in tab on QR codes</span></div>' +
      '<div id="vlci-today" style="font-size:13px;color:var(--txt2);margin:0 0 12px;' + TXT + '">Loading today\u2019s check-ins&hellip;</div>' +
      '<div id="vlci-host">' + dropHTML() + '</div><div style="margin-top:12px">' + rows + '</div></div>';
  }
  function paint() { var h = $('vlci-host'); if (h) h.innerHTML = dropHTML(); wireDrop(); }
  function wireDrop() {
    var d = $('vlci-drop'); if (!d) return;
    d.addEventListener('dragover', function (e) { e.preventDefault(); });
    d.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); });
  }
  function addCard() {
    var body = $('st-body'); if (!body || (typeof _setSection !== 'undefined' && _setSection !== 'feedback')) return;
    var old = $('vlci-card'); if (old) old.remove();
    var anchor = $('vlfm-card-settings');                                           // sits under the Feedback forms card when there is one
    if (anchor) anchor.insertAdjacentHTML('afterend', cardHTML()); else body.insertAdjacentHTML('afterbegin', cardHTML());
    wireDrop(); loadToday();
  }
  async function loadToday() {
    var el = $('vlci-today'); if (!el) return;
    try {
      var r = await sb.from('checkins').select('event_id,people').eq('org_id', String(orgId)).eq('day', london());
      if (r.error) throw r.error;
      var by = {}, total = 0; (r.data || []).forEach(function (c) { by[c.event_id] = (by[c.event_id] || 0) + (+c.people || 1); total += (+c.people || 1); });
      var names = Object.keys(by).map(function (id) { var ev = (DB.events || []).find(function (e) { return String(e.id) === String(id); }); return esc((ev && (ev.location || ev.name)) || 'Event') + ' ' + by[id]; });
      el.innerHTML = total ? '<b>' + total + ' checked in today</b> &middot; ' + names.join(' &middot; ') + ' &nbsp;<a href="#" onclick="vlciCsv();return false">Download all check-ins (CSV)</a>'
        : 'No one has checked in today. <a href="#" onclick="vlciCsv();return false">Download all check-ins (CSV)</a>';
    } catch (e) { el.innerHTML = 'Check-ins will show here once <b>checkin.sql</b> has been run in Supabase.'; }
  }

  // ── read a form ──
  async function readFile(file) {
    var text = '';
    try { text = (typeof readUploadedFormFile === 'function') ? await readUploadedFormFile(file) : await file.text(); }
    catch (e) { alert('Couldn\u2019t open that file: ' + (e && e.message ? e.message : e)); return; }
    run(text, file.name.replace(/\.[a-z0-9]+$/i, ''));
  }
  function run(text, name) {
    S.mode = 'busy'; paint();
    var qs = (typeof vlParseCheckinText === 'function') ? vlParseCheckinText(text) : [];
    var asked = qs.filter(function (q) { return q.role !== 'location'; });
    if (asked.length < 2) { S.mode = 'idle'; paint(); alert('We couldn\u2019t find questions in that. Each question should be on its own line with its answers underneath, one per line. Try pasting it instead.'); return; }
    S.parsed = { name: name, questions: qs }; S.name = name; S.mode = 'review'; paint();
  }
  window.vlciMode = function (m) { S.mode = m; if (m !== 'idle') S.msg = ''; paint(); };
  window.vlciFile = function (inp) { var f = inp.files && inp.files[0]; if (f) readFile(f); };
  window.vlciPaste = function () { var t = ($('vlci-paste') || {}).value || ''; if (!t.trim()) { var e = $('vlci-err'); if (e) e.textContent = 'Paste the form first.'; return; } run(t, 'Pasted check-in form'); };
  window.vlciSave = async function () {
    var p = S.parsed; if (!p) return; var err = $('vlci-err'), btn = $('vlci-go');
    var name = (($('vlci-name') || {}).value || '').trim(); if (!name) { err.textContent = 'Give the form a name.'; return; }
    if (forms().some(function (f) { return f.name.toLowerCase() === name.toLowerCase(); })) { err.textContent = 'You already have a form with that name.'; return; }
    btn.disabled = true; btn.textContent = 'Saving\u2026';
    try {
      var f = { id: 'ci_' + Date.now().toString(36), name: name.slice(0, 80), questions: p.questions };
      var patch = { checkin_forms: forms().concat([f]) }, use = ($('vlci-use') || {}).value;
      if (use === 'all') patch.checkin_default = f.id;
      else if (/^t:/.test(use)) { var tm = Object.assign({}, typeMap()); tm[use.slice(2)] = f.id; patch.checkin_form_for_type = tm; }
      await save(patch);
      S = { mode: 'idle', parsed: null, name: '', msg: '\u201c' + f.name + '\u201d saved' + (use === 'all' ? ' and used for all events' : /^t:/.test(use) ? ' and used for ' + use.slice(2) + ' events' : '') };
      redraw();
    } catch (e) { err.textContent = 'Couldn\u2019t save: ' + (e.message || e); btn.disabled = false; btn.textContent = 'Save form'; }
  };
  window.vlciRename = async function (id, input) {
    var nm = String(input.value || '').trim().slice(0, 80), f = forms().filter(function (x) { return x.id === id; })[0]; if (!f) return;
    if (!nm) { input.value = f.name; alert('A form needs a name.'); return; }
    if (nm === f.name) return;
    if (forms().some(function (x) { return x.id !== id && x.name.toLowerCase() === nm.toLowerCase(); })) { input.value = f.name; alert('You already have a form with that name.'); return; }
    try { await save({ checkin_forms: forms().map(function (x) { return x.id === id ? Object.assign({}, x, { name: nm }) : x; }) }); } catch (e) { input.value = f.name; alert('Couldn\u2019t rename: ' + (e.message || e)); return; }
    input.defaultValue = nm;
  };
  window.vlciUse = async function (id, v) {
    if (!v) return;
    var patch = {}, tm = Object.assign({}, typeMap());
    Object.keys(tm).forEach(function (t) { if (tm[t] === id) delete tm[t]; });
    var def = st().checkin_default === id ? '' : st().checkin_default;
    if (v === 'all') { patch.checkin_default = id; }
    else if (/^t:/.test(v)) { tm[v.slice(2)] = id; if (st().checkin_default === id) patch.checkin_default = null; }
    else { if (st().checkin_default === id) patch.checkin_default = null; }
    patch.checkin_form_for_type = tm; void def;
    try { await save(patch); } catch (e) { alert('Couldn\u2019t save: ' + (e.message || e)); return; }
    redraw();
  };
  window.vlciDelete = async function (id) {
    var f = forms().filter(function (x) { return x.id === id; })[0]; if (!f) return;
    if (!confirm('Remove \u201c' + f.name + '\u201d? Events that used it go back to the standard check-in. Check-ins already collected are kept.')) return;
    var tm = Object.assign({}, typeMap()); Object.keys(tm).forEach(function (t) { if (tm[t] === id) delete tm[t]; });
    var patch = { checkin_forms: forms().filter(function (x) { return x.id !== id; }), checkin_form_for_type: tm }; if (st().checkin_default === id) patch.checkin_default = null;
    try { await save(patch); } catch (e) { alert('Couldn\u2019t remove: ' + (e.message || e)); return; }
    redraw();
  };
  window.vlciToggle = async function (on) { try { await save({ checkin_enabled: !!on }); } catch (e) { alert('Couldn\u2019t save: ' + (e.message || e)); var c = $('vlci-on'); if (c) c.checked = !on; } };
  function redraw() { if (typeof renderFeedbackQuestionsCard === 'function') renderFeedbackQuestionsCard(); else addCard(); }

  // ── download everything as a spreadsheet ──
  function csvCell(v) { var s = Array.isArray(v) ? v.join('; ') : String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function buildCsv(rows) {
    var evs = {}; (DB.events || []).forEach(function (e) { evs[String(e.id)] = e; });
    var keys = []; rows.forEach(function (r) { Object.keys(r.answers || {}).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
    var head = ['Date', 'Time', 'Event', 'Location', 'People checked in'].concat(keys);
    var lines = [head.map(csvCell).join(',')];
    rows.forEach(function (r) {
      var ev = evs[String(r.event_id)] || {}, d = new Date(r.created_at);
      var time = isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
      lines.push([r.day || '', time, ev.name || '', ev.location || '', r.people || 1].concat(keys.map(function (k) { return (r.answers || {})[k]; })).map(csvCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }
  window.vlciCsv = async function () {
    try {
      var r = await sb.from('checkins').select('*').eq('org_id', String(orgId)).order('created_at', { ascending: true }).limit(5000);
      if (r.error) throw r.error;
      if (!(r.data || []).length) { alert('No check-ins yet.'); return; }
      var blob = new Blob([buildCsv(r.data)], { type: 'text/csv;charset=utf-8' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'check-ins-' + london() + '.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch (e) { alert('Couldn\u2019t download: ' + (e.message || e)); }
  };

  function ready(fn) { var t = 0; (function w() { if (typeof renderFeedbackQuestionsCard === 'function') return fn(); if (++t < 100) setTimeout(w, 100); })(); }
  ready(function () {
    var orig = window.renderFeedbackQuestionsCard;
    window.renderFeedbackQuestionsCard = function () { orig.apply(this, arguments); try { addCard(); } catch (e) { console.warn('[checkin-forms]', e); } };
  });
  if (window.__VORLANA_TEST) window.__ciTest = { buildCsv: buildCsv, usedFor: usedFor, state: function () { return S; } };
})();
