// js/extensions/checkin-forms.js v2 — check-in forms: Settings, Events tab, and a card on each event
// A check-in form is a list of questions { id, label, kind, required, options, other, hint, role, showIf, perVisit }.
// Which form an event uses (the server applies the same order, api/event-checkin.js):
//   1. the form picked on the event  2. the form attached to a funder (contract) the event is linked to  3. the form for that kind of event
//   4. your default  5. the standard form (first time here? how many people?), which can be edited too.
// Stored in organisations.settings: checkin_enabled, checkin_forms, checkin_standard, checkin_form_for_contract, checkin_default, checkin_form_for_type.
// Depends on: checkin-parse.js (vlParseCheckinText), settings.js (renderFeedbackQuestionsCard, setModal, setCloseModal), event-contracts.js (.ev-con-chk), agents.js (readUploadedFormFile)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var TXT = 'text-transform:none;letter-spacing:0';
  var KIND = { single: 'Choose one', multi: 'Choose several', text: 'Short answer', number: 'Number', email: 'Email', postcode: 'Postcode', count: 'Number of under-16s' };
  var EDIT_KINDS = ['single', 'multi', 'text', 'number', 'email', 'postcode'];

  // ── data ──
  function st() { return (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.settings) || {}; }
  function forms() { return Array.isArray(st().checkin_forms) ? st().checkin_forms : []; }
  function byContract() { return st().checkin_form_for_contract || {}; }
  function byType() { return st().checkin_form_for_type || {}; }
  function orgName() { return (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || 'us'; }
  function builtinStandard() {
    return { id: 'standard', name: 'Standard check-in', questions: [
      { id: 'first', label: 'Is this your first time with ' + orgName() + '?', kind: 'single', required: true, options: ['Yes', 'No'] },
      { id: 'people', label: 'How many people are you checking in?', kind: 'single', required: true, role: 'people', options: ['Just me', '2', '3', '4', '5 or more'] }] };
  }
  function standard() { var s = st().checkin_standard; return (s && Array.isArray(s.questions) && s.questions.length) ? { id: 'standard', name: 'Standard check-in', questions: s.questions } : builtinStandard(); }
  function formById(id) { if (id === 'standard') return standard(); return forms().filter(function (f) { return f.id === id; })[0] || null; }
  function contracts() { return (typeof DB !== 'undefined' && DB.contracts) ? DB.contracts : []; }
  function cLabel(c) { return (c.name || 'Contract') + (c.funder && c.funder !== c.name ? ' \u00b7 ' + c.funder : ''); }
  function toArr(v) { if (Array.isArray(v)) return v.map(String); if (typeof v === 'string') { try { var j = JSON.parse(v); return Array.isArray(j) ? j.map(String) : []; } catch (e) { return []; } } return []; }
  function london() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }); }
  async function save(patch) {
    var base = st();
    try { var cur = await sb.from('organisations').select('settings').eq('id', orgId).single(); if (cur && cur.data && cur.data.settings) base = cur.data.settings; } catch (e) { /* use what we have */ }
    var settings = Object.assign({}, base, patch);
    var res = await sb.from('organisations').update({ settings: settings }).eq('id', orgId);
    if (res && res.error) throw res.error;
    currentOrg = Object.assign({}, currentOrg, { settings: settings });
  }
  // the form an event gets: the same order the server uses
  function resolve(ev) {
    var forms_ = forms(), has = function (id) { return forms_.some(function (f) { return f.id === id; }); };
    if (ev.checkin_form) { if (ev.checkin_form === 'standard') return { id: 'standard', why: 'chosen for this event' }; if (has(ev.checkin_form)) return { id: ev.checkin_form, why: 'chosen for this event' }; }
    var cids = toArr(ev.contract_ids);
    for (var i = 0; i < cids.length; i++) { var f = byContract()[cids[i]]; if (f && has(f)) { var c = contracts().filter(function (x) { return String(x.id) === cids[i]; })[0]; return { id: f, why: 'from the funder' + (c ? ' (' + (c.funder || c.name) + ')' : '') }; } }
    if (ev.type && byType()[ev.type] && has(byType()[ev.type])) return { id: byType()[ev.type], why: 'for ' + ev.type + ' events' };
    if (st().checkin_default && has(st().checkin_default)) return { id: st().checkin_default, why: 'your default' };
    return { id: 'standard', why: 'standard' };
  }
  function usedByCount(id) { return ((typeof DB !== 'undefined' && DB.events) ? DB.events : []).filter(function (e) { return resolve(e).id === id; }).length; }
  function usedForChips(f) {
    var bits = [];
    if (st().checkin_default === f.id) bits.push({ t: 'All events', k: 'default' });
    Object.keys(byContract()).forEach(function (cid) { if (byContract()[cid] === f.id) { var c = contracts().filter(function (x) { return String(x.id) === cid; })[0]; bits.push({ t: c ? cLabel(c) : 'a contract', k: 'c:' + cid }); } });
    Object.keys(byType()).forEach(function (t) { if (byType()[t] === f.id) bits.push({ t: t + ' events', k: 't:' + t }); });
    return bits;
  }

  // ── reading a pasted or dropped form (shared by Settings and the event card) ──
  async function fileText(file) {
    try { return (typeof readUploadedFormFile === 'function') ? await readUploadedFormFile(file) : await file.text(); }
    catch (e) { alert('Couldn\u2019t open that file: ' + (e && e.message ? e.message : e)); return ''; }
  }
  function parse(text) { var qs = (typeof vlParseCheckinText === 'function') ? vlParseCheckinText(text) : []; return qs.filter(function (q) { return q.role !== 'location'; }).length < 2 ? null : qs; }
  function reviewRows(qs) {
    return qs.filter(function (q) { return q.role !== 'location'; }).map(function (q) {
      return '<div style="border-top:1px solid var(--border);padding:7px 0;display:flex;justify-content:space-between;gap:10px;font-size:13px;color:var(--txt);' + TXT + '"><span>' + esc(q.label) + (q.required ? ' <b style="color:#C84545">*</b>' : '') + (q.showIf ? ' <i style="color:var(--txt3)">(only if ' + q.showIf.maxAge + ' or under)</i>' : '') + '</span><span style="color:var(--txt3);white-space:nowrap">' + esc(KIND[q.kind] || q.kind) + '</span></div>';
    }).join('');
  }
  var BTN = 'border:1px solid var(--border);background:#fff;border-radius:10px;padding:11px 14px;text-align:left;width:100%;cursor:pointer;font-family:inherit;font-size:14px;color:var(--txt);margin-bottom:8px;display:block';
  var SUB = 'font-size:12px;color:var(--txt3);font-weight:400;margin-top:2px;' + TXT;

  // ══ Settings, Events tab ═══════════════════════════════════════
  var S = { mode: 'idle', parsed: null, name: '', msg: '' };
  function useSelect(id) {
    return '<select style="width:auto;font-size:12px;padding:3px 6px" title="Where to use this form" onchange="vlciUse(\'' + esc(id) + '\',this.value);this.value=\'\'"><option value="">Use for&hellip;</option><option value="default">All events</option>' +
      contracts().map(function (c) { return '<option value="c:' + esc(String(c.id)) + '">' + esc(cLabel(c)) + '</option>'; }).join('') + '</select>';
  }
  function formRow(f, isStd) {
    var qs = (f.questions || []).filter(function (q) { return q.role !== 'location'; }), n = qs.length, used = usedByCount(f.id), chips = isStd ? [] : usedForChips(f);
    var name = isStd ? '<div style="font-weight:600;font-size:14px;color:var(--txt);' + TXT + '">Standard check-in</div>' :
      '<input value="' + esc(f.name) + '" maxlength="80" aria-label="Form name" title="Click to rename" style="font-weight:600;font-size:14px;color:var(--txt);border:1px solid transparent;background:transparent;padding:3px 6px;margin:0 0 0 -6px;width:100%;max-width:340px" onfocus="this.style.borderColor=\'var(--border)\';this.style.background=\'#fff\'" onblur="this.style.borderColor=\'transparent\';this.style.background=\'transparent\'" onkeydown="if(event.key===\'Enter\')this.blur();if(event.key===\'Escape\'){this.value=this.defaultValue;this.blur()}" onchange="vlciRename(\'' + esc(f.id) + '\',this)"/>';
    return '<div style="padding:10px 0;border-top:1px solid var(--border)"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><div style="min-width:0;flex:1">' + name +
      '<div style="font-size:12px;color:var(--txt3);' + TXT + '">' + n + ' question' + (n === 1 ? '' : 's') + ' &middot; ' + (isStd ? 'used when nothing else applies' : 'attached to ' + (chips.length ? chips.length + ' place' + (chips.length === 1 ? '' : 's') : 'nothing yet')) + ' &middot; ' + used + ' event' + (used === 1 ? '' : 's') + '</div></div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0;align-items:center"><button class="btn btn-ghost btn-sm" onclick="vlciEdit(\'' + esc(f.id) + '\')">Edit</button>' + (isStd ? (st().checkin_standard ? '<button class="btn btn-ghost btn-sm" onclick="vlciResetStd()" title="Go back to the original two questions">Reset</button>' : '') : useSelect(f.id) + '<button class="btn btn-ghost btn-sm" onclick="vlciDelete(\'' + esc(f.id) + '\')" aria-label="Remove form" title="Remove">&times;</button>') + '</div></div>' +
      (chips.length ? '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px">' + chips.map(function (c) { return '<span style="font-size:11px;background:var(--bg);color:var(--txt2);border-radius:10px;padding:2px 9px;' + TXT + '">' + esc(c.t) + ' <a href="#" style="margin-left:4px;color:var(--txt3)" title="Stop using it here" onclick="vlciUnuse(\'' + esc(f.id) + '\',\'' + esc(c.k) + '\');return false">&times;</a></span>'; }).join('') + '</div>' : '') + '</div>';
  }
  function dropHTML() {
    if (S.mode === 'busy') return '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:16px;font-size:14px;color:var(--txt);' + TXT + '">&#8987; Reading the form&hellip;</div>';
    if (S.mode === 'review' && S.parsed) return '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px"><div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">Read ' + S.parsed.filter(function (q) { return q.role !== 'location'; }).length + ' questions</div>' +
      '<div style="font-size:12px;color:var(--txt3);margin-bottom:8px;' + TXT + '">The location question is dropped: people check in to the session they are at.</div><div style="max-height:260px;overflow:auto">' + reviewRows(S.parsed) + '</div>' +
      '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:10px 0 4px;' + TXT + '">Form name</div><input id="vlci-name" value="' + esc(S.name) + '" maxlength="80" style="font-size:14px;font-weight:600;margin-bottom:10px"/>' +
      '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:2px 0 4px;' + TXT + '">Use it for</div><select id="vlci-use" style="margin-bottom:10px"><option value="none">Don\u2019t use it yet (attach it afterwards)</option><option value="default">All my events</option>' + contracts().map(function (c) { return '<option value="c:' + esc(String(c.id)) + '">' + esc(cLabel(c)) + '</option>'; }).join('') + '</select>' +
      '<div id="vlci-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin-bottom:6px"></div><div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-ghost btn-sm" onclick="vlciMode(\'idle\')">Back</button><button class="btn btn-p btn-sm" id="vlci-go" onclick="vlciSave()">Save form</button></div></div>';
    if (S.mode === 'paste') return '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px"><div style="font-size:14px;font-weight:600;color:var(--txt);margin-bottom:6px;' + TXT + '">Paste the form</div><div style="font-size:12px;color:var(--txt3);margin-bottom:8px;' + TXT + '">Each question on its own line, its answers underneath, one per line. A * at the end means required.</div>' +
      '<textarea id="vlci-paste" style="min-height:160px;font-size:13px"></textarea><div id="vlci-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin:6px 0"></div><div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-ghost btn-sm" onclick="vlciMode(\'idle\')">Back</button><button class="btn btn-p btn-sm" onclick="vlciPaste()">Read the form</button></div></div>';
    return '<div id="vlci-drop" style="border:2px dashed #A39C8E;border-radius:10px;padding:16px;text-align:center;cursor:pointer;background:var(--bg)" onclick="document.getElementById(\'vlci-file\').click()"><div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">&#11014; Drop in a check-in form</div><div style="font-size:12px;color:var(--txt3);' + TXT + '">Word, PDF or text. We read the questions for you.</div><input type="file" id="vlci-file" accept=".docx,.pdf,.txt,text/plain" style="display:none" onchange="vlciFile(this)"/></div>' +
      '<div style="text-align:center;margin:8px 0 2px"><a href="#" style="font-size:12px" onclick="vlciMode(\'paste\');return false">or paste the questions</a></div>' + (S.msg ? '<div style="font-size:13px;color:#065F46;text-align:center;margin-top:6px;' + TXT + '">&#10003; ' + esc(S.msg) + '</div>' : '');
  }
  function cardHTML() {
    var on = st().checkin_enabled !== false;
    return '<div id="vlci-card" style="margin:0 0 26px;padding-bottom:18px;border-bottom:2px solid var(--border)"><div style="font-size:15px;font-weight:700;color:var(--txt);' + TXT + '">Check-in forms</div>' +
      '<div style="font-size:13px;color:var(--txt3);line-height:1.5;margin:2px 0 10px;' + TXT + '">Different funders want different information, so each can have its own form. Attach a form to a funder and every event linked to that funder uses it. You can still choose a different one on any single event.</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin:0 0 10px;font-size:14px;color:var(--txt);' + TXT + '"><input type="checkbox" id="vlci-on" ' + (on ? 'checked' : '') + ' style="width:18px;height:18px;margin:0;flex:none" onchange="vlciToggle(this.checked)"/><span>Show the Check in tab on QR codes</span></div>' +
      '<div id="vlci-today" style="font-size:13px;color:var(--txt2);margin:0 0 10px;' + TXT + '">Loading today\u2019s check-ins&hellip;</div>' +
      '<div style="margin-bottom:8px">' + forms().map(function (f) { return formRow(f, false); }).join('') + formRow(standard(), true) + '</div><div id="vlci-host">' + dropHTML() + '</div></div>';
  }
  function paint() { var h = $('vlci-host'); if (h) h.innerHTML = dropHTML(); wireDrop(); }
  function wireDrop() { var d = $('vlci-drop'); if (!d) return; d.addEventListener('dragover', function (e) { e.preventDefault(); }); d.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); }); }
  function addCard() {
    var body = $('st-body'); if (!body || (typeof _setSection !== 'undefined' && _setSection !== 'feedback')) return;
    var old = $('vlci-card'); if (old) old.remove();
    var anchor = $('vlfm-card-settings');                                 // the Check-in card sits above the Feedback forms card
    if (anchor) anchor.insertAdjacentHTML('beforebegin', cardHTML()); else body.insertAdjacentHTML('afterbegin', cardHTML());
    wireDrop(); loadToday();
  }
  async function loadToday() {
    var el = $('vlci-today'); if (!el) return;
    try {
      var r = await sb.from('checkins').select('event_id,people').eq('org_id', String(orgId)).eq('day', london()); if (r.error) throw r.error;
      var by = {}, total = 0; (r.data || []).forEach(function (c) { by[c.event_id] = (by[c.event_id] || 0) + (+c.people || 1); total += (+c.people || 1); });
      var names = Object.keys(by).map(function (id) { var ev = (DB.events || []).find(function (e) { return String(e.id) === String(id); }); return esc((ev && (ev.location || ev.name)) || 'Event') + ' ' + by[id]; });
      el.innerHTML = (total ? '<b>' + total + ' checked in today</b> &middot; ' + names.join(' &middot; ') : 'No one has checked in today.') + ' &nbsp;<a href="#" onclick="vlciCsv();return false">Download all check-ins (CSV)</a>';
    } catch (e) { el.innerHTML = 'Check-ins will show here once <b>checkin.sql</b> has been run in Supabase.'; }
  }
  async function readFile(file) { var t = await fileText(file); if (t) run(t, file.name.replace(/\.[a-z0-9]+$/i, '')); }
  function run(text, name) {
    S.mode = 'busy'; paint(); var qs = parse(text);
    if (!qs) { S.mode = 'idle'; paint(); alert('We couldn\u2019t find questions in that. Each question should be on its own line with its answers underneath, one per line. Try pasting it instead.'); return; }
    S.parsed = qs; S.name = name; S.mode = 'review'; paint();
  }
  window.vlciMode = function (m) { S.mode = m; if (m !== 'idle') S.msg = ''; paint(); };
  window.vlciFile = function (inp) { var f = inp.files && inp.files[0]; if (f) readFile(f); };
  window.vlciPaste = function () { var t = ($('vlci-paste') || {}).value || ''; if (!t.trim()) { var e = $('vlci-err'); if (e) e.textContent = 'Paste the form first.'; return; } run(t, 'Check-in form'); };
  function attach(patch, formId, use) {   // 'default' | 'c:<id>' | 'none'
    if (use === 'default') patch.checkin_default = formId;
    else if (/^c:/.test(use)) { var m = Object.assign({}, byContract()); m[use.slice(2)] = formId; patch.checkin_form_for_contract = m; }
  }
  window.vlciSave = async function () {
    var qs = S.parsed; if (!qs) return; var err = $('vlci-err'), btn = $('vlci-go');
    var name = (($('vlci-name') || {}).value || '').trim(); if (!name) { err.textContent = 'Give the form a name.'; return; }
    if (forms().some(function (f) { return f.name.toLowerCase() === name.toLowerCase(); })) { err.textContent = 'You already have a form with that name.'; return; }
    btn.disabled = true; btn.textContent = 'Saving\u2026';
    try {
      var f = { id: 'ci_' + Date.now().toString(36), name: name.slice(0, 80), questions: qs }, use = ($('vlci-use') || {}).value, patch = { checkin_forms: forms().concat([f]) };
      attach(patch, f.id, use); await save(patch);
      S = { mode: 'idle', parsed: null, name: '', msg: '\u201c' + f.name + '\u201d saved' + (use === 'none' ? '. Attach it to a funder with \u201cUse for\u2026\u201d, or choose it on an event.' : ' and attached') };
      redraw();
    } catch (e) { err.textContent = 'Couldn\u2019t save: ' + (e.message || e); btn.disabled = false; btn.textContent = 'Save form'; }
  };
  window.vlciRename = async function (id, input) {
    var nm = String(input.value || '').trim().slice(0, 80), f = forms().filter(function (x) { return x.id === id; })[0]; if (!f) return;
    if (!nm) { input.value = f.name; alert('A form needs a name.'); return; } if (nm === f.name) return;
    if (forms().some(function (x) { return x.id !== id && x.name.toLowerCase() === nm.toLowerCase(); })) { input.value = f.name; alert('You already have a form with that name.'); return; }
    try { await save({ checkin_forms: forms().map(function (x) { return x.id === id ? Object.assign({}, x, { name: nm }) : x; }) }); } catch (e) { input.value = f.name; alert('Couldn\u2019t rename: ' + (e.message || e)); return; }
    input.defaultValue = nm;
  };
  window.vlciUse = async function (id, v) { if (!v) return; var patch = {}; attach(patch, id, v); try { await save(patch); } catch (e) { alert('Couldn\u2019t save: ' + (e.message || e)); return; } redraw(); };
  window.vlciUnuse = async function (id, key) {
    var patch = {};
    if (key === 'default') patch.checkin_default = null;
    else if (/^c:/.test(key)) { var m = Object.assign({}, byContract()); delete m[key.slice(2)]; patch.checkin_form_for_contract = m; }
    else if (/^t:/.test(key)) { var t = Object.assign({}, byType()); delete t[key.slice(2)]; patch.checkin_form_for_type = t; }
    try { await save(patch); } catch (e) { alert('Couldn\u2019t save: ' + (e.message || e)); return; } redraw();
  };
  window.vlciDelete = async function (id) {
    var f = forms().filter(function (x) { return x.id === id; })[0]; if (!f) return;
    if (!confirm('Remove \u201c' + f.name + '\u201d? Events that used it go back to the next choice (your default, then standard). Check-ins already collected are kept.')) return;
    var cm = Object.assign({}, byContract()), tm = Object.assign({}, byType());
    Object.keys(cm).forEach(function (k) { if (cm[k] === id) delete cm[k]; }); Object.keys(tm).forEach(function (k) { if (tm[k] === id) delete tm[k]; });
    var patch = { checkin_forms: forms().filter(function (x) { return x.id !== id; }), checkin_form_for_contract: cm, checkin_form_for_type: tm }; if (st().checkin_default === id) patch.checkin_default = null;
    try { await save(patch); } catch (e) { alert('Couldn\u2019t remove: ' + (e.message || e)); return; } redraw();
  };
  window.vlciToggle = async function (on) { try { await save({ checkin_enabled: !!on }); } catch (e) { alert('Couldn\u2019t save: ' + (e.message || e)); var c = $('vlci-on'); if (c) c.checked = !on; } };
  window.vlciResetStd = async function () { if (!confirm('Go back to the original standard check-in?')) return; try { await save({ checkin_standard: null }); } catch (e) { alert('Couldn\u2019t reset: ' + (e.message || e)); return; } redraw(); };
  function redraw() { if (typeof renderFeedbackQuestionsCard === 'function') renderFeedbackQuestionsCard(); else addCard(); }

  // ══ the editor: open a form and change it ══════════════════════
  var ED = null;      // { id, name, std, qs: working copy of every question (location question included, never shown) }
  function edNewId() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function edSync() {     // copy what is on screen back into the working copy
    if (!ED) return;
    ED.qs.forEach(function (q) {
      var el = document.querySelector('.vlce-q[data-id="' + q.id + '"]'); if (!el) return;
      q.label = el.querySelector('.vlce-label').value;
      var k = el.querySelector('.vlce-kind'); if (k) q.kind = k.value;
      q.required = !!el.querySelector('.vlce-req').checked;
      var o = el.querySelector('.vlce-opts'); if (o) q.options = o.value.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
      var ot = el.querySelector('.vlce-other'); if (ot) q.other = !!ot.checked;
    });
  }
  function edHTML() {
    var shown = ED.qs.filter(function (q) { return q.role !== 'location'; });
    return '<h2>' + esc(ED.std ? 'Standard check-in' : ED.name) + '</h2>' +
      '<div style="font-size:13px;color:var(--txt3);margin:-6px 0 10px;' + TXT + '">Change the wording, the answers, which questions are required, and the order. People are never asked for their name.</div>' +
      '<div style="max-height:420px;overflow:auto;padding-right:4px">' + shown.map(function (q, i) {
        var fixedKind = q.kind === 'count' || q.role === 'email' || q.role === 'people', hasOpts = q.kind === 'single' || q.kind === 'multi' || q.kind === 'count';
        return '<div class="vlce-q" data-id="' + esc(q.id) + '" style="border:1px solid var(--border);border-radius:10px;padding:10px;margin-bottom:8px;background:#fff">' +
          '<input class="vlce-label" value="' + esc(q.label) + '" maxlength="300" placeholder="The question" style="font-weight:600;font-size:14px;margin-bottom:6px"/>' +
          '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--txt2);' + TXT + '">' +
            (fixedKind ? '<span style="padding:2px 8px;background:var(--bg);border-radius:6px">' + esc(KIND[q.kind] || q.kind) + (q.kind === 'count' ? ' &middot; counts towards attendance' : '') + '</span>' :
              '<select class="vlce-kind" style="width:auto;font-size:12px;padding:3px 6px">' + EDIT_KINDS.map(function (k) { return '<option value="' + k + '"' + (k === q.kind ? ' selected' : '') + '>' + KIND[k] + '</option>'; }).join('') + '</select>') +
            '<span style="display:inline-flex;align-items:center;gap:5px"><input type="checkbox" class="vlce-req" ' + (q.required ? 'checked' : '') + ' style="width:15px;height:15px;margin:0"/> Required</span>' +
            ((q.kind === 'single' || q.kind === 'multi') ? '<span style="display:inline-flex;align-items:center;gap:5px"><input type="checkbox" class="vlce-other" ' + (q.other ? 'checked' : '') + ' style="width:15px;height:15px;margin:0"/> Allow \u201cOther\u201d</span>' : '') +
            '<span style="margin-left:auto;white-space:nowrap"><a href="#" onclick="vlceMove(\'' + esc(q.id) + '\',-1);return false" title="Move up" style="text-decoration:none">&uarr;</a> <a href="#" onclick="vlceMove(\'' + esc(q.id) + '\',1);return false" title="Move down" style="text-decoration:none">&darr;</a> <a href="#" onclick="vlceRemove(\'' + esc(q.id) + '\');return false" title="Remove this question" style="text-decoration:none;color:#B91C1C">&times;</a></span></div>' +
          (hasOpts ? '<textarea class="vlce-opts" ' + (q.kind === 'count' ? 'readonly' : '') + ' placeholder="One answer per line" style="min-height:' + Math.max(54, Math.min(150, (q.options || []).length * 22 + 14)) + 'px;font-size:13px;margin-top:6px">' + esc((q.options || []).join('\n')) + '</textarea>' : '') +
          (q.showIf ? '<div style="font-size:12px;color:var(--txt3);margin-top:6px;' + TXT + '">Only shown to people aged ' + q.showIf.maxAge + ' or under. <a href="#" onclick="vlceDropRule(\'' + esc(q.id) + '\');return false">Show to everyone</a></div>' : '') +
          (q.hint ? '<div style="font-size:11px;color:var(--txt3);margin-top:4px;' + TXT + '">Hint shown under it: ' + esc(q.hint) + '</div>' : '') + '</div>';
      }).join('') + '</div>' +
      '<div style="margin:6px 0 10px"><a href="#" onclick="vlceAdd();return false" style="font-size:13px">+ Add a question</a></div><div id="vlce-err" style="font-size:12px;color:#B91C1C;min-height:16px"></div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" onclick="setCloseModal()">Cancel</button><button class="btn btn-p" id="vlce-go" onclick="vlceSave()">Save form</button></div>';
  }
  window.vlciEdit = function (id) {
    var f = formById(id); if (!f) return;
    ED = { id: id, name: f.name, std: id === 'standard', qs: JSON.parse(JSON.stringify(f.questions || [])) };
    setModal(edHTML());
  };
  function edRedraw() { var m = document.querySelector('#modal-body') || $('modal-body'); setModal(edHTML()); }
  window.vlceMove = function (id, d) { edSync(); var i = ED.qs.findIndex(function (q) { return q.id === id; }), j = i + d; while (j >= 0 && j < ED.qs.length && ED.qs[j].role === 'location') j += d; if (i < 0 || j < 0 || j >= ED.qs.length) return; var t = ED.qs[i]; ED.qs[i] = ED.qs[j]; ED.qs[j] = t; edRedraw(); };
  window.vlceRemove = function (id) { edSync(); ED.qs = ED.qs.filter(function (q) { return q.id !== id; }); ED.qs.forEach(function (q) { if (q.showIf && q.showIf.q === id) delete q.showIf; }); edRedraw(); };
  window.vlceDropRule = function (id) { edSync(); ED.qs.forEach(function (q) { if (q.id === id) delete q.showIf; }); edRedraw(); };
  window.vlceAdd = function () { edSync(); ED.qs.push({ id: edNewId(), label: '', kind: 'single', required: false, options: ['Yes', 'No'] }); edRedraw(); var l = document.querySelectorAll('.vlce-label'); if (l.length) l[l.length - 1].focus(); };
  window.vlceSave = async function () {
    edSync(); var err = $('vlce-err'), btn = $('vlce-go');
    var asked = ED.qs.filter(function (q) { return q.role !== 'location'; });
    if (!asked.length) { err.textContent = 'A form needs at least one question.'; return; }
    for (var i = 0; i < asked.length; i++) {
      var q = asked[i]; q.label = String(q.label || '').replace(/\s+/g, ' ').trim();
      if (!q.label) { err.textContent = 'Every question needs some wording.'; return; }
      if ((q.kind === 'single' || q.kind === 'multi') && (q.options || []).length < 2) { err.textContent = '\u201c' + q.label.slice(0, 50) + '\u201d needs at least two answers.'; return; }
    }
    btn.disabled = true; btn.textContent = 'Saving\u2026';
    try {
      if (ED.std) await save({ checkin_standard: { questions: ED.qs } });
      else await save({ checkin_forms: forms().map(function (f) { return f.id === ED.id ? Object.assign({}, f, { questions: ED.qs }) : f; }) });
      setCloseModal(); ED = null; redraw();
    } catch (e) { err.textContent = 'Couldn\u2019t save: ' + (e.message || e); btn.disabled = false; btn.textContent = 'Save form'; }
  };

  // ══ each event: a Check-in form card, like the Feedback form one ═════
  var CE = { mode: 'summary', sel: '', parsed: null, name: '', evId: null };
  function linkedContracts() { return [].slice.call(document.querySelectorAll('.ev-con-chk')).filter(function (c) { return c.checked; }).map(function (c) { return c.value; }); }
  function eventNow() { var t = $('evf-type'); return { checkin_form: CE.sel, contract_ids: linkedContracts(), type: t ? t.value : '' }; }
  function ceHost() { return $('vlcie-card'); }
  function cePaint() {
    var host = ceHost(); if (!host) return; var h = '';
    if (CE.mode === 'summary') {
      var r = resolve(eventNow()), f = formById(r.id) || standard(), n = (f.questions || []).filter(function (q) { return q.role !== 'location'; }).length;
      h = '<div style="display:flex;align-items:center;gap:12px;border:1px solid var(--border);background:#fff;border-radius:10px;padding:11px 14px"><div style="font-size:22px;line-height:1" aria-hidden="true">&#128203;</div><div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">' + esc(f.name) + '</div><div style="' + SUB + '">' + n + ' question' + (n === 1 ? '' : 's') + ' &middot; ' + esc(r.why) + '</div></div><button type="button" class="btn btn-ghost btn-sm" onclick="vlceMode(\'change\')">Change</button></div>' +
        '<div style="font-size:11px;color:var(--txt3);margin-top:4px;' + TXT + '">' + (CE.sel ? 'You chose this form for this event.' : 'Chosen automatically: the funder you link above, then your default.') + '</div>';
    } else if (CE.mode === 'change') {
      h = '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px"><div style="font-size:14px;font-weight:600;color:var(--txt);margin-bottom:10px;' + TXT + '">Check-in form for this event</div>' +
        '<div id="vlcie-drop" style="border:2px dashed #A39C8E;border-radius:10px;padding:14px;text-align:center;cursor:pointer;margin-bottom:8px;background:var(--bg)" onclick="document.getElementById(\'vlcie-file\').click()"><div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">&#11014; Drop in a check-in form</div><div style="' + SUB + '">Word, PDF or text. We read the questions.</div><input type="file" id="vlcie-file" accept=".docx,.pdf,.txt,text/plain" style="display:none" onchange="vlcieFile(this)"/></div>' +
        '<div style="text-align:center;margin:0 0 10px"><a href="#" style="font-size:12px" onclick="vlceMode(\'paste\');return false">or paste the questions</a></div>' +
        (forms().length ? '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:4px 0 6px;' + TXT + '">One you used before</div>' + forms().map(function (f) { var n = (f.questions || []).filter(function (q) { return q.role !== 'location'; }).length; return '<button type="button" style="' + BTN + '" onclick="vlcePick(\'' + esc(f.id) + '\')"><div style="font-weight:600">' + esc(f.name) + '</div><div style="' + SUB + '">' + n + ' questions</div></button>'; }).join('') : '') +
        '<button type="button" style="' + BTN + '" onclick="vlcePick(\'standard\')"><div style="font-weight:600">Standard check-in</div><div style="' + SUB + '">First time here, and how many people</div></button>' +
        (CE.sel ? '<button type="button" style="' + BTN + '" onclick="vlcePick(\'\')"><div style="font-weight:600">Follow my settings</div><div style="' + SUB + '">The funder\u2019s form, then your default</div></button>' : '') +
        '<div style="text-align:right"><a href="#" style="font-size:13px" onclick="vlceMode(\'summary\');return false">Cancel</a></div></div>';
    } else if (CE.mode === 'paste') {
      h = '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px"><div style="font-size:14px;font-weight:600;color:var(--txt);margin-bottom:6px;' + TXT + '">Paste the form</div><textarea id="vlcie-paste" style="min-height:140px;font-size:13px"></textarea><div id="vlcie-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin:6px 0"></div><div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn btn-ghost btn-sm" onclick="vlceMode(\'change\')">Back</button><button type="button" class="btn btn-p btn-sm" onclick="vlciePaste()">Read the form</button></div></div>';
    } else if (CE.mode === 'busy') { h = '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:16px;font-size:14px;' + TXT + '">&#8987; Reading the form&hellip;</div>'; }
    else if (CE.mode === 'review' && CE.parsed) {
      var linked = linkedContracts().map(function (id) { return contracts().filter(function (c) { return String(c.id) === id; })[0]; }).filter(Boolean);
      h = '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px"><div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">Read ' + CE.parsed.filter(function (q) { return q.role !== 'location'; }).length + ' questions</div><div style="max-height:200px;overflow:auto;margin:6px 0">' + reviewRows(CE.parsed) + '</div>' +
        '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:6px 0 4px;' + TXT + '">Form name</div><input id="vlcie-name" value="' + esc(CE.name) + '" maxlength="80" style="font-size:14px;font-weight:600;margin-bottom:8px"/>' +
        (linked.length ? '<div style="display:flex;align-items:center;gap:10px;margin:0 0 10px;cursor:pointer;font-size:13px;color:var(--txt);' + TXT + '" onclick="var c=document.getElementById(\'vlcie-all\');c.checked=!c.checked"><input type="checkbox" id="vlcie-all" checked style="width:16px;height:16px;flex:none;margin:0" onclick="event.stopPropagation()"/><span>Use it for every event linked to ' + esc(linked.map(function (c) { return c.funder || c.name; }).join(', ')) + '</span></div>' : '') +
        '<div id="vlcie-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin-bottom:6px"></div><div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn btn-ghost btn-sm" onclick="vlceMode(\'change\')">Back</button><button type="button" class="btn btn-p btn-sm" id="vlcie-go" onclick="vlcieSave()">Use this form</button></div></div>';
    }
    host.innerHTML = h;
    var d = $('vlcie-drop'); if (d) { d.addEventListener('dragover', function (e) { e.preventDefault(); }); d.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) ceRead(f); }); }
  }
  window.vlceMode = function (m) { CE.mode = m; cePaint(); };
  window.vlcePick = function (id) { CE.sel = id; CE.mode = 'summary'; cePaint(); };
  async function ceRead(file) { var t = await fileText(file); if (t) ceRun(t, file.name.replace(/\.[a-z0-9]+$/i, '')); }
  function ceRun(text, name) {
    CE.mode = 'busy'; cePaint(); var qs = parse(text);
    if (!qs) { CE.mode = 'change'; cePaint(); alert('We couldn\u2019t find questions in that. Each question should be on its own line with its answers underneath. Try pasting it instead.'); return; }
    CE.parsed = qs; CE.name = name; CE.mode = 'review'; cePaint();
  }
  window.vlcieFile = function (inp) { var f = inp.files && inp.files[0]; if (f) ceRead(f); };
  window.vlciePaste = function () { var t = ($('vlcie-paste') || {}).value || ''; if (!t.trim()) { var e = $('vlcie-err'); if (e) e.textContent = 'Paste the form first.'; return; } ceRun(t, 'Check-in form'); };
  window.vlcieSave = async function () {
    var qs = CE.parsed; if (!qs) return; var err = $('vlcie-err'), btn = $('vlcie-go');
    var name = (($('vlcie-name') || {}).value || '').trim(); if (!name) { err.textContent = 'Give the form a name.'; return; }
    if (forms().some(function (f) { return f.name.toLowerCase() === name.toLowerCase(); })) { err.textContent = 'You already have a form with that name.'; return; }
    btn.disabled = true; btn.textContent = 'Saving\u2026';
    try {
      var f = { id: 'ci_' + Date.now().toString(36), name: name.slice(0, 80), questions: qs }, patch = { checkin_forms: forms().concat([f]) };
      var all = $('vlcie-all'), viaFunder = !!(all && all.checked);
      if (viaFunder) { var m = Object.assign({}, byContract()); linkedContracts().forEach(function (id) { m[id] = f.id; }); patch.checkin_form_for_contract = m; }
      await save(patch);
      CE.sel = viaFunder ? '' : f.id; CE.parsed = null; CE.mode = 'summary'; cePaint();
    } catch (e) { err.textContent = 'Couldn\u2019t save: ' + (e.message || e); btn.disabled = false; btn.textContent = 'Use this form'; }
  };
  function injectEventCard(ev) {
    var modal = $('modal-ev'); if (!modal) return;
    var old = $('vlcie-wrap'); if (old) old.remove();
    var wrap = document.createElement('div'); wrap.id = 'vlcie-wrap'; wrap.className = 'form-row';
    wrap.innerHTML = '<label>Check-in form</label><div id="vlcie-card"></div>';
    var contractsBox = modal.querySelector('[data-ev-contracts]'), footer = modal.querySelector('.modal-footer');
    if (contractsBox) contractsBox.insertAdjacentElement('afterend', wrap); else if (footer) footer.parentNode.insertBefore(wrap, footer); else return;
    CE = { mode: 'summary', sel: (ev && ev.checkin_form) || '', parsed: null, name: '', evId: ev ? ev.id : null }; cePaint();
  }
  function wireEventModal() {
    var oa = window.openAddEv, oe = window.openEditEv, os = window.saveEv;
    if (typeof oa === 'function' && !oa._ci) { window.openAddEv = function () { var r = oa.apply(this, arguments); setTimeout(function () { injectEventCard(null); }, 0); return r; }; window.openAddEv._ci = true; }
    if (typeof oe === 'function' && !oe._ci) { window.openEditEv = function (id) { var r = oe.apply(this, arguments); setTimeout(function () { injectEventCard((DB.events || []).filter(function (e) { return String(e.id) === String(id); })[0] || null); }, 0); return r; }; window.openEditEv._ci = true; }
    if (typeof os === 'function' && !os._ci) {
      window.saveEv = function () {
        var sel = CE.sel || null, oi = window.sbInsert, ou = window.sbUpdate, missing = false;
        var wrapFn = function (fn) { return async function (table, payload, id) { if (table !== 'events') return fn.apply(null, arguments);
          var p = Object.assign({}, payload, { checkin_form: sel });
          try { return await (id === undefined ? fn(table, p) : fn(table, p, id)); }
          catch (e) { if (/checkin_form/i.test((e && e.message) || '')) { missing = true; return id === undefined ? fn(table, payload) : fn(table, payload, id); } throw e; } }; };
        window.sbInsert = wrapFn(oi); window.sbUpdate = wrapFn(ou);
        var done = function () { window.sbInsert = oi; window.sbUpdate = ou; if (missing && sel) alert('The event is saved, but its check-in form choice could not be: run checkin.sql in Supabase first.'); };
        var r; try { r = os.apply(this, arguments); } catch (e) { done(); throw e; }
        if (r && typeof r.then === 'function') r.then(done, done); else setTimeout(done, 2500);
        return r;
      };
      window.saveEv._ci = true;
    }
  }
  document.addEventListener('change', function (ev) { var t = ev.target; if (t && t.classList && t.classList.contains('ev-con-chk') && CE.mode === 'summary') cePaint(); if (t && t.id === 'evf-type' && CE.mode === 'summary') cePaint(); });

  // ══ download everything as a spreadsheet ═══════════════════════
  function csvCell(v) { var s = Array.isArray(v) ? v.join('; ') : String(v == null ? '' : v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function buildCsv(rows) {
    var evs = {}; (DB.events || []).forEach(function (e) { evs[String(e.id)] = e; });
    var keys = []; rows.forEach(function (r) { Object.keys(r.answers || {}).forEach(function (k) { if (keys.indexOf(k) < 0) keys.push(k); }); });
    var lines = [['Date', 'Time', 'Event', 'Location', 'People checked in'].concat(keys).map(csvCell).join(',')];
    rows.forEach(function (r) {
      var ev = evs[String(r.event_id)] || {}, d = new Date(r.created_at);
      var time = isNaN(d) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
      lines.push([r.day || '', time, ev.name || '', ev.location || '', r.people || 1].concat(keys.map(function (k) { return (r.answers || {})[k]; })).map(csvCell).join(','));
    });
    return '\uFEFF' + lines.join('\r\n');
  }
  window.vlciCsv = async function () {
    try {
      var r = await sb.from('checkins').select('*').eq('org_id', String(orgId)).order('created_at', { ascending: true }).limit(5000); if (r.error) throw r.error;
      if (!(r.data || []).length) { alert('No check-ins yet.'); return; }
      var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([buildCsv(r.data)], { type: 'text/csv;charset=utf-8' })); a.download = 'check-ins-' + london() + '.csv'; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    } catch (e) { alert('Couldn\u2019t download: ' + (e.message || e)); }
  };

  function ready(fn) { var t = 0; (function w() { if (typeof renderFeedbackQuestionsCard === 'function' && typeof openAddEv === 'function' && typeof saveEv === 'function') return fn(); if (++t < 100) setTimeout(w, 100); })(); }
  ready(function () {
    var orig = window.renderFeedbackQuestionsCard;
    window.renderFeedbackQuestionsCard = function () { orig.apply(this, arguments); try { addCard(); } catch (e) { console.warn('[checkin-forms]', e); } };
    wireEventModal();
  });
  if (window.__VORLANA_TEST) window.__ciTest = { buildCsv: buildCsv, resolve: resolve, usedByCount: usedByCount, state: function () { return { S: S, CE: CE, ED: ED }; } };
})();
