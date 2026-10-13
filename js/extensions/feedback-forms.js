// js/extensions/feedback-forms.js — drop a feedback form onto an event
// v2: no form management. On an event you either keep the form suggested (the one from your last event of the same kind),
// drop in a Word / PDF / spreadsheet form (the questions are read for you), pick one you used before, or use your standard questions.
// A form is just a named set of questions, remembered automatically in organisations.settings.feedback_forms.
// An event still saves its own list of questions (events.question_ids), so the public QR page and the reports work as before.
// Depends on: modals.js (renderEvQuestions, getEvQuestionIds, _editEvId), render.js (activeMeasures, MEASURE_KINDS, MEASURE_MAPS),
//             settings.js (vAI, fqMapLabel, renderFeedbackQuestionsCard), agents.js (readUploadedFormFile)
(function () {
  'use strict';

  var esc = function (s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var $ = function (id) { return document.getElementById(id); };
  var KIND_LABEL = { score: '1 to 5', yesno: 'Yes or no', choice: 'Choice', text: 'Comment' };

  // ── saved forms (remembered automatically) ──────────────────
  function orgSettings() { return (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.settings) || {}; }
  function forms() { var f = orgSettings().feedback_forms; return Array.isArray(f) ? f : []; }
  function forTypeMap() { return orgSettings().feedback_form_for_type || {}; }
  function allMeasures() { return (typeof DB !== 'undefined' && DB.survey_measures ? DB.survey_measures : []).filter(function (m) { return !m._demo; }); }
  function activeQs() { return (typeof activeMeasures === 'function') ? activeMeasures() : []; }
  function liveIds(f) {                    // a form's questions that still exist and are switched on
    var on = {}; activeQs().forEach(function (m) { on[String(m.id)] = 1; });
    return (f.question_ids || []).map(String).filter(function (id) { return on[id]; });
  }
  function sameSet(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    var s = {}; a.forEach(function (x) { s[String(x)] = 1; });
    return b.every(function (x) { return s[String(x)]; });
  }
  function usedBy(f) {
    var ids = liveIds(f);
    return (typeof DB !== 'undefined' && DB.events ? DB.events : []).filter(function (ev) { return ev.question_ids && sameSet(ev.question_ids.map(String), ids); }).length;
  }
  // Write our part of the settings without overwriting anything else (read the latest, add ours, write)
  async function saveSettings(patch) {
    var base = orgSettings();
    try {
      var cur = await sb.from('organisations').select('settings').eq('id', orgId).single();
      if (cur && cur.data && cur.data.settings) base = cur.data.settings;
    } catch (e) { /* fall back to what we have */ }
    var settings = Object.assign({}, base, patch);
    var res = await sb.from('organisations').update({ settings: settings }).eq('id', orgId);
    if (res && res.error) throw res.error;
    currentOrg = Object.assign({}, currentOrg, { settings: settings });
  }

  // ── what is ticked on the event form ────────────────────────
  function boxes() { return [].slice.call(document.querySelectorAll('#evf-questions input[type=checkbox]')); }
  function ticked() { return boxes().filter(function (b) { return b.checked; }).map(function (b) { return b.value; }); }
  function setTicks(ids) {
    var want = {}; (ids || []).forEach(function (q) { want[String(q)] = 1; });
    boxes().forEach(function (b) { b.checked = !!want[b.value]; });
  }
  function isNewEvent() { return (typeof _editEvId === 'undefined') ? false : !_editEvId; }
  function eventType() { var t = $('evf-type'); return t ? t.value : ''; }

  // ── the form suggested for a new event ──────────────────────
  // 1. the form you said to use for this kind of event  2. the form your last event of this kind used  3. a form marked default
  function suggestFor(type) {
    var fid = forTypeMap()[type];
    var f = fid && forms().filter(function (x) { return x.id === fid && liveIds(x).length; })[0];
    if (f) return { ids: liveIds(f), why: 'Your ' + type + ' form' };
    var evs = (typeof DB !== 'undefined' && DB.events ? DB.events : []).filter(function (e) { return e.type === type && Array.isArray(e.question_ids) && e.question_ids.length; })
      .sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    if (evs.length) {
      var on = {}; activeQs().forEach(function (m) { on[String(m.id)] = 1; });
      var ids = evs[0].question_ids.map(String).filter(function (q) { return on[q]; });
      if (ids.length) return { ids: ids, why: 'Same as your last ' + type + ' event' };
    }
    var d = forms().filter(function (x) { return x.is_default && liveIds(x).length; })[0];
    if (d) return { ids: liveIds(d), why: 'Your default form' };
    return null;
  }

  // ── the card on the event form ──────────────────────────────
  var _st = { key: '', mode: 'summary', touched: false, why: '', parsed: null, msg: '' };
  function resetState(key) { _st = { key: key, mode: 'summary', touched: false, why: '', parsed: null, msg: '' }; }

  function describeCurrent() {
    var on = ticked(), all = boxes().length;
    var f = forms().filter(function (x) { return sameSet(on, liveIds(x)); })[0];
    var fromLast = !f && _st.why;                     // e.g. "Same as your last Green Skills event"
    var name = f ? f.name : fromLast ? _st.why : (all && on.length === all ? 'Your standard questions' : 'Questions chosen for this event');
    return { name: name, count: on.length, showWhy: !fromLast };
  }

  var BTN = 'border:1px solid var(--border);background:#fff;border-radius:10px;padding:11px 14px;text-align:left;width:100%;cursor:pointer;font-family:inherit;font-size:14px;color:var(--txt);margin-bottom:8px;display:block';
  var SUB = 'font-size:12px;color:var(--txt3);font-weight:400;margin-top:2px;text-transform:none;letter-spacing:0';
  var TXT = 'text-transform:none;letter-spacing:0';
  function paintCard() {
    var host = $('vlfm-card'); if (!host) return;
    var h = '';
    if (_st.mode === 'summary') {
      var c = describeCurrent();
      h = '<div style="display:flex;align-items:center;gap:12px;border:1px solid var(--border);background:#fff;border-radius:10px;padding:11px 14px">' +
        '<div style="font-size:22px;line-height:1" aria-hidden="true">&#128196;</div>' +
        '<div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">' + esc(c.name) + '</div>' +
        '<div style="' + SUB + '">' + c.count + ' question' + (c.count === 1 ? '' : 's') + (_st.why && c.showWhy ? ' &middot; ' + esc(_st.why) : '') + (_st.msg ? ' &middot; ' + esc(_st.msg) : '') + '</div></div>' +
        '<button type="button" class="btn btn-ghost btn-sm" onclick="ffMode(\'change\')">Change</button></div>';
    } else if (_st.mode === 'change') {
      var list = forms().filter(function (f) { return liveIds(f).length; });
      h = '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px">' +
        '<div style="font-size:14px;font-weight:600;color:var(--txt);margin-bottom:10px;' + TXT + '">Feedback form for this event</div>' +
        '<div id="vlfm-drop" style="border:2px dashed #A39C8E;border-radius:10px;padding:16px;text-align:center;cursor:pointer;margin-bottom:10px;background:var(--bg)" onclick="document.getElementById(\'vlfm-file\').click()">' +
          '<div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">&#11014; Drop in a form</div>' +
          '<div style="' + SUB + '">Word, PDF or a spreadsheet (CSV). We read the questions for you.</div>' +
          '<input type="file" id="vlfm-file" accept=".docx,.pdf,.txt,.csv,text/csv,text/plain" style="display:none" onchange="ffFile(this)"/></div>' +
        '<div style="text-align:center;margin:-2px 0 12px"><a href="#" style="font-size:12px" onclick="ffMode(\'paste\');return false">or paste the questions</a></div>' +
        (list.length ? '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:4px 0 6px;' + TXT + '">One you used before</div>' + list.map(function (f) {
          var n = liveIds(f).length, u = usedBy(f);
          return '<button type="button" style="' + BTN + '" onclick="ffUse(\'' + esc(f.id) + '\')"><div style="font-weight:600">' + esc(f.name) + '</div><div style="' + SUB + '">' + n + ' question' + (n === 1 ? '' : 's') + (u ? ' &middot; used by ' + u + ' event' + (u === 1 ? '' : 's') : '') + '</div></button>';
        }).join('') : '') +
        '<button type="button" style="' + BTN + '" onclick="ffStandard()"><div style="font-weight:600">Your standard questions</div><div style="' + SUB + '">Everything you currently ask</div></button>' +
        '<div style="text-align:right"><a href="#" style="font-size:13px" onclick="ffMode(\'summary\');return false">Cancel</a></div></div>';
    } else if (_st.mode === 'paste') {
      h = '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px">' +
        '<div style="font-size:14px;font-weight:600;color:var(--txt);margin-bottom:8px;' + TXT + '">Paste the questions</div>' +
        '<textarea id="vlfm-paste" style="min-height:130px;font-size:13px" placeholder="1. How confident did you feel before? (1-5)&#10;2. Did you learn something new? Yes / No"></textarea>' +
        '<div id="vlfm-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin:6px 0"></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn btn-ghost btn-sm" onclick="ffMode(\'change\')">Back</button><button type="button" class="btn btn-p btn-sm" onclick="ffPaste()">Read questions</button></div></div>';
    } else if (_st.mode === 'busy') {
      h = '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:16px;font-size:14px;color:var(--txt);' + TXT + '">&#8987; Reading ' + esc(_st.fileName || 'the form') + '&hellip;</div>';
    } else if (_st.mode === 'review' && _st.parsed) {
      var p = _st.parsed, qs = p.questions, shown = qs.slice(0, 6);
      var maps = {}; qs.forEach(function (q) { if (q.maps_to && typeof fqMapLabel === 'function' && fqMapLabel(q.maps_to)) maps[fqMapLabel(q.maps_to)] = 1; });
      var mapNames = Object.keys(maps);
      h = '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px">' +
        '<div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">Read ' + qs.length + ' question' + (qs.length === 1 ? '' : 's') + '</div>' +
        '<div style="' + SUB + ';margin-bottom:8px">from ' + esc(p.name) + '</div>' +
        shown.map(function (q) {
          return '<div style="border-top:1px solid var(--border);padding:7px 0;display:flex;justify-content:space-between;gap:10px;font-size:13px;color:var(--txt);' + TXT + '"><span>' + esc(q.question) + '</span><span style="color:var(--txt3);white-space:nowrap">' + esc(KIND_LABEL[q.kind] || 'Comment') + '</span></div>';
        }).join('') +
        (qs.length > shown.length ? '<div style="border-top:1px solid var(--border);padding:7px 0;font-size:13px;color:var(--txt3);' + TXT + '">and ' + (qs.length - shown.length) + ' more</div>' : '') +
        '<div style="background:#ECFDF5;color:#065F46;border-radius:8px;padding:9px 11px;font-size:12px;margin:8px 0 10px;' + TXT + '">&#10003; ' +
          (mapNames.length ? 'Your reports use these answers automatically: ' + esc(mapNames.join(', ')) + '.' : 'Your reports will show these answers as your own measures.') + '</div>' +
        '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:2px 0 4px;' + TXT + '">Form name</div>' +
        '<input id="vlfm-name" value="' + esc(p.name) + '" maxlength="80" style="font-size:14px;font-weight:600;margin-bottom:10px"/>' +
        '<div style="display:flex;align-items:center;gap:10px;margin:0 0 12px;cursor:pointer;font-size:13px;color:var(--txt);' + TXT + '" onclick="var c=document.getElementById(\'vlfm-all\');c.checked=!c.checked">' +
          '<input type="checkbox" id="vlfm-all" checked style="width:16px;height:16px;flex:none;margin:0;padding:0" onclick="event.stopPropagation()"/><span>Use for all my ' + esc(eventType() || 'new') + ' events</span></div>' +
        '<div id="vlfm-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin-bottom:6px"></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px"><button type="button" class="btn btn-ghost btn-sm" onclick="ffMode(\'change\')">Back</button><button type="button" class="btn btn-p btn-sm" id="vlfm-go" onclick="ffAdopt()">Use this form</button></div></div>';
    }
    host.innerHTML = h;
    var drop = $('vlfm-drop');
    if (drop) {
      drop.addEventListener('dragover', function (e) { e.preventDefault(); });
      drop.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) readFile(f); });
    }
  }
  window.ffMode = function (m) { _st.mode = m; paintCard(); };

  function injectCard(sel) {
    var box = $('evf-questions-wrap'); if (!box) return;
    var key = isNewEvent() ? 'new' : String(typeof _editEvId === 'undefined' ? '' : _editEvId);
    if (sel == null || _st.key !== key) resetState(key);
    var old = $('vlfm-card'); if (old) old.remove();
    var det = $('vlfm-details'); if (det) { while (det.childNodes.length > 1) box.appendChild(det.lastChild); det.remove(); }
    var label = box.querySelector('label'); if (!label) return;
    label.textContent = 'Feedback form';
    var card = document.createElement('div'); card.id = 'vlfm-card'; card.style.margin = '4px 0 10px';
    label.insertAdjacentElement('afterend', card);
    // everything else (the question ticks and "add a question") tucks away; it is still there if you want it
    var d = document.createElement('details'); d.id = 'vlfm-details'; d.style.marginTop = '4px';
    d.innerHTML = '<summary style="cursor:pointer;font-size:12px;color:var(--txt3);' + TXT + '">Choose questions one by one</summary>';
    [].slice.call(box.childNodes).forEach(function (n) { if (n !== label && n !== card && n !== d) d.appendChild(n); });
    box.appendChild(d);
    if (sel == null && isNewEvent() && !_st.touched) {          // a new event starts on the suggested form
      var s = suggestFor(eventType());
      if (s) { setTicks(s.ids); _st.why = s.why; }
    }
    paintCard();
  }

  // ── picking, dropping in, reading ───────────────────────────
  window.ffUse = function (id) {
    var f = forms().filter(function (x) { return x.id === id; })[0]; if (!f) return;
    setTicks(liveIds(f)); _st.touched = true; _st.why = ''; _st.msg = ''; _st.mode = 'summary'; paintCard();
  };
  window.ffStandard = function () {
    setTicks(boxes().map(function (b) { return b.value; })); _st.touched = true; _st.why = ''; _st.msg = ''; _st.mode = 'summary'; paintCard();
  };

  var ALLOWED_KINDS = function () { return (typeof MEASURE_KINDS !== 'undefined' ? MEASURE_KINDS : [['score'], ['yesno'], ['choice'], ['text']]).map(function (k) { return k[0]; }).filter(function (k) { return k && k !== 'ignore'; }); };
  var ALLOWED_MAPS = function () { return (typeof MEASURE_MAPS !== 'undefined' ? MEASURE_MAPS : []).map(function (k) { return k[0]; }).filter(Boolean); };
  function norm(q) { return String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

  // The reading of the form, made safe: allowed answer types only, no repeats, no two questions for the same standard measure
  function clean(list) {
    var kinds = ALLOWED_KINDS(), maps = ALLOWED_MAPS(), seen = {}, taken = {}, out = [];
    (list || []).forEach(function (q) {
      if (!q || !q.question) return;
      var text = String(q.question).replace(/\s+/g, ' ').trim().slice(0, 300);
      if (text.length < 6 || seen[norm(text)] || out.length >= 25) return;
      seen[norm(text)] = 1;
      var kind = kinds.indexOf(q.kind) >= 0 ? q.kind : 'text';
      var row = { question: text, kind: kind, maps_to: (q.maps_to && maps.indexOf(q.maps_to) >= 0) ? q.maps_to : null };
      if (row.maps_to) { if (taken[row.maps_to]) row.maps_to = null; else taken[row.maps_to] = 1; }
      if (kind === 'choice') {
        var o = (Array.isArray(q.options) ? q.options : []).map(function (x) { return String(x).trim().slice(0, 80); }).filter(Boolean).slice(0, 12);
        if (o.length >= 2) row.options = o; else row.kind = 'text';
      } else if (kind === 'score' && q.low && q.high) row.options = [String(q.low).trim().slice(0, 40), String(q.high).trim().slice(0, 40)];
      out.push(row);
    });
    return out;
  }

  // Read the form's text into clean questions (no screen involved, so the event screen and Settings share it)
  async function readToQuestions(text) {
    var kinds = ALLOWED_KINDS().join(', '), maps = ALLOWED_MAPS().join(', ');
    // the questions already on the platform: a form question that means the same must come back worded exactly the same, so it is recognised, not added twice
    var have = allMeasures().filter(function (m) { return m.active !== false && m.kind !== 'ignore'; }).slice(0, 40).map(function (m) { return '- ' + String(m.question).slice(0, 200); }).join('\n');
    var j = await vAI('You extract the questions people answer on a feedback form, for a UK charity. Ignore names, emails, dates, consent boxes, headings and instructions. Keep each question\u2019s wording as written, tidied only for spelling. Work out how each is answered: score (a 1 to 5 scale), yesno, choice (give the options exactly as written), or text (a comment). For a 1 to 5 question that says what 1 and 5 mean, give them as low and high.',
      'Form content:\n' + String(text).slice(0, 12000) + (have ? '\n\nThe organisation already asks these questions:\n' + have + '\nIf a question on the form means the same as one of them, return that existing wording exactly, character for character, so it is recognised as the same question.' : '') + '\nAllowed kind values: ' + kinds + '. Allowed maps_to values: ' + maps + ', or "" for the organisation\u2019s own measure. Use a maps_to value only when the question clearly measures it. Return JSON only: {"questions":[{"question":"","kind":"","maps_to":"","options":[],"low":"","high":""}]}', 2200);
    return clean(j && j.questions);
  }
  // Make sure every question exists, protecting existing events first. Returns the ids (in the form's order).
  async function ensureQuestions(qs) {
    var existing = allMeasures(), byNorm = {};
    existing.forEach(function (m) { byNorm[norm(m.question)] = m; });
    var fresh = qs.filter(function (q) { return !byNorm[norm(q.question)]; });
    var reuse = qs.map(function (q) { return byNorm[norm(q.question)]; }).filter(Boolean);
    if (fresh.length) {
      // Events that have no saved question list ask EVERY active question. Adding new questions would silently lengthen them,
      // so give each its current list first.
      var before = activeQs().map(function (m) { return String(m.id); });
      var open = (DB.events || []).filter(function (e) { return !e.question_ids; }).map(function (e) { return e.id; });
      for (var i = 0; i < open.length; i += 100) {
        var chunk = open.slice(i, i + 100);
        var u = await sb.from('events').update({ question_ids: before }).in('id', chunk);
        if (u && u.error) throw new Error('Couldn\u2019t protect your existing events (' + (u.error.message || u.error) + '). Nothing was changed.');
      }
      (DB.events || []).forEach(function (e) { if (!e.question_ids) e.question_ids = before.slice(); });
      var maxSort = existing.reduce(function (a, m) { return Math.max(a, +m.sort || 0); }, 0);
      var rows = fresh.map(function (q, k) {
        var r = { org_id: orgId, question: q.question, kind: q.kind, maps_to: q.maps_to || null, label: q.question.slice(0, 60), active: true, sort: maxSort + 1 + k };
        if (q.options) r.options = q.options;
        return r;
      });
      var ins = await sb.from('survey_measures').insert(rows);
      if (ins && ins.error) throw ins.error;
    }
    // a question you had switched off comes back on when a form needs it
    var off = reuse.filter(function (m) { return m.active === false; }).map(function (m) { return m.id; });
    if (off.length) { var re = await sb.from('survey_measures').update({ active: true }).in('id', off); if (re && re.error) throw re.error; }
    if (fresh.length || off.length) await refreshTable('survey_measures');
    var now = {}; allMeasures().forEach(function (m) { now[norm(m.question)] = m; });
    var ids = qs.map(function (q) { return now[norm(q.question)]; }).filter(Boolean).map(function (m) { return String(m.id); });
    if (!ids.length) throw new Error('The questions didn\u2019t save. Please try again.');
    return { ids: ids, fresh: fresh.length, off: off.length };
  }
  // Remember a set of questions as a named form (the same set is never saved twice). Returns the form.
  function rememberForm(list, name, ids) {
    var form = list.filter(function (f) { return sameSet(liveIds(f), ids); })[0];
    if (form) return form;
    var base = String(name || 'Feedback form').trim().slice(0, 80) || 'Feedback form', nm = base, n2 = 2;
    while (list.some(function (f) { return f.name.toLowerCase() === nm.toLowerCase(); })) nm = base + ' (' + (n2++) + ')';
    form = { id: 'f_' + Date.now().toString(36), name: nm, question_ids: ids, is_default: false };
    list.push(form);
    return form;
  }

  async function parseText(text, name) {
    _st.mode = 'busy'; _st.fileName = name; paintCard();
    try {
      var qs = await readToQuestions(text);
      if (!qs.length) { _st.mode = 'change'; paintCard(); alert('We couldn\u2019t find any questions in that. Try a different file, or paste the questions.'); return; }
      _st.parsed = { name: name, questions: qs }; _st.mode = 'review'; paintCard();
    } catch (e) {
      _st.mode = 'change'; paintCard();
      alert('Couldn\u2019t read that form: ' + (e && e.message ? e.message : e));
    }
  }
  async function fileText(file) {
    var text = '';
    try {
      if (/\.csv$/i.test(file.name)) { var raw = await file.text(); text = raw.split(/\r?\n/)[0] || ''; }       // a CSV export: the questions are the column headers
      else if (typeof readUploadedFormFile === 'function') text = await readUploadedFormFile(file);
      else text = await file.text();
    } catch (e) { alert('Couldn\u2019t open that file: ' + (e && e.message ? e.message : e)); return ''; }
    if (!String(text).trim()) { alert('That file looks empty.'); return ''; }
    return text;
  }
  async function readFile(file) { var t = await fileText(file); if (t) parseText(t, file.name.replace(/\.[a-z0-9]+$/i, '')); }
  window.ffFile = function (inp) { var f = inp.files && inp.files[0]; if (f) readFile(f); };
  window.ffPaste = function () {
    var t = ($('vlfm-paste') || {}).value || '';
    if (!t.trim()) { var e = $('vlfm-err'); if (e) e.textContent = 'Paste the questions first.'; return; }
    parseText(t, 'pasted questions');
  };

  // ── using the form: make sure the questions exist, protect existing events, attach to this event ──
  window.ffAdopt = async function () {
    var p = _st.parsed; if (!p) return;
    var btn = $('vlfm-go'), err = $('vlfm-err');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
    try {
      var r = await ensureQuestions(p.questions);
      var list = forms().slice(), type = eventType();
      var nmEl = $('vlfm-name'), nm = (nmEl && nmEl.value.trim()) || p.name;
      var form = rememberForm(list, nm, r.ids);
      var patch = { feedback_forms: list };
      var all = $('vlfm-all');
      if (all && all.checked && type) { var tm = Object.assign({}, forTypeMap()); tm[type] = form.id; patch.feedback_form_for_type = tm; }
      await saveSettings(patch);
      _st.touched = true; _st.why = ''; _st.mode = 'summary'; _st.parsed = null;
      _st.msg = r.fresh ? r.fresh + ' new question' + (r.fresh === 1 ? '' : 's') + ' added' : 'questions you already had';
      window.renderEvQuestions(r.ids);              // redraw the event form with these questions ticked
    } catch (e) {
      if (err) err.textContent = (e && e.message) ? e.message : String(e);
      if (btn) { btn.disabled = false; btn.textContent = 'Use this form'; }
    }
  };

  // ── Settings: drop in a form here too; rename a form by typing over its name ──
  var _ss = { mode: 'idle', parsed: null, fileName: '', msg: '' };
  function eventTypes() {
    var seen = {}, out = [];
    [].slice.call(document.querySelectorAll('#evf-type option')).forEach(function (o) { if (o.value && !seen[o.value]) { seen[o.value] = 1; out.push(o.value); } });
    (DB.events || []).forEach(function (e) { if (e.type && !seen[e.type]) { seen[e.type] = 1; out.push(e.type); } });
    return out;
  }
  function settingsDropHTML() {
    if (_ss.mode === 'busy') return '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:16px;font-size:14px;color:var(--txt);' + TXT + '">&#8987; Reading ' + esc(_ss.fileName) + '&hellip;</div>';
    if (_ss.mode === 'paste') return '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px">' +
      '<div style="font-size:14px;font-weight:600;color:var(--txt);margin-bottom:8px;' + TXT + '">Paste the questions</div>' +
      '<textarea id="ffs-paste" style="min-height:120px;font-size:13px" placeholder="1. How confident did you feel before? (1-5)&#10;2. Did you learn something new? Yes / No"></textarea>' +
      '<div id="ffs-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin:6px 0"></div>' +
      '<div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-ghost btn-sm" onclick="ffsMode(\'idle\')">Back</button><button class="btn btn-p btn-sm" onclick="ffsPaste()">Read questions</button></div></div>';
    if (_ss.mode === 'review' && _ss.parsed) {
      var p = _ss.parsed, qs = p.questions, shown = qs.slice(0, 6), maps = {};
      qs.forEach(function (q) { if (q.maps_to && typeof fqMapLabel === 'function' && fqMapLabel(q.maps_to)) maps[fqMapLabel(q.maps_to)] = 1; });
      var mapNames = Object.keys(maps), types = eventTypes();
      return '<div style="border:1px solid var(--border);background:#fff;border-radius:10px;padding:14px">' +
        '<div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">Read ' + qs.length + ' question' + (qs.length === 1 ? '' : 's') + '</div>' +
        '<div style="' + SUB + ';margin-bottom:8px">from ' + esc(p.name) + '</div>' +
        shown.map(function (q) { return '<div style="border-top:1px solid var(--border);padding:7px 0;display:flex;justify-content:space-between;gap:10px;font-size:13px;color:var(--txt);' + TXT + '"><span>' + esc(q.question) + '</span><span style="color:var(--txt3);white-space:nowrap">' + esc(KIND_LABEL[q.kind] || 'Comment') + '</span></div>'; }).join('') +
        (qs.length > shown.length ? '<div style="border-top:1px solid var(--border);padding:7px 0;font-size:13px;color:var(--txt3);' + TXT + '">and ' + (qs.length - shown.length) + ' more</div>' : '') +
        '<div style="background:#ECFDF5;color:#065F46;border-radius:8px;padding:9px 11px;font-size:12px;margin:8px 0 10px;' + TXT + '">&#10003; ' + (mapNames.length ? 'Your reports use these answers automatically: ' + esc(mapNames.join(', ')) + '.' : 'Your reports will show these answers as your own measures.') + '</div>' +
        '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:2px 0 4px;' + TXT + '">Form name</div>' +
        '<input id="ffs-name" value="' + esc(p.name) + '" maxlength="80" style="font-size:14px;font-weight:600;margin-bottom:10px"/>' +
        '<div style="font-size:12px;font-weight:600;color:var(--txt3);margin:2px 0 4px;' + TXT + '">Start new events of this kind on this form</div>' +
        '<select id="ffs-type" style="margin-bottom:10px"><option value="">Don\u2019t set a default</option>' + types.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('') + '</select>' +
        '<div id="ffs-err" style="font-size:12px;color:#B91C1C;min-height:16px;margin-bottom:6px"></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px"><button class="btn btn-ghost btn-sm" onclick="ffsMode(\'idle\')">Back</button><button class="btn btn-p btn-sm" id="ffs-go" onclick="ffsSave()">Save form</button></div></div>';
    }
    return '<div id="ffs-drop" style="border:2px dashed #A39C8E;border-radius:10px;padding:16px;text-align:center;cursor:pointer;background:var(--bg)" onclick="document.getElementById(\'ffs-file\').click()">' +
      '<div style="font-size:14px;font-weight:600;color:var(--txt);' + TXT + '">&#11014; Drop in a form</div>' +
      '<div style="' + SUB + '">Word, PDF or a spreadsheet (CSV). We read the questions for you.</div>' +
      '<input type="file" id="ffs-file" accept=".docx,.pdf,.txt,.csv,text/csv,text/plain" style="display:none" onchange="ffsFile(this)"/></div>' +
      '<div style="text-align:center;margin:8px 0 2px"><a href="#" style="font-size:12px" onclick="ffsMode(\'paste\');return false">or paste the questions</a></div>' +
      (_ss.msg ? '<div style="font-size:13px;color:#065F46;text-align:center;margin-top:6px;' + TXT + '">&#10003; ' + esc(_ss.msg) + '</div>' : '');
  }
  function settingsCard() {
    var list = forms();
    var rows = list.length ? list.map(function (f) {
      var n = liveIds(f).length, u = usedBy(f);
      var types = Object.keys(forTypeMap()).filter(function (t) { return forTypeMap()[t] === f.id; });
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--border)">' +
        '<div style="min-width:0;flex:1"><input value="' + esc(f.name) + '" maxlength="80" aria-label="Form name" title="Click to rename" ' +
          'style="font-weight:600;font-size:14px;color:var(--txt);border:1px solid transparent;background:transparent;padding:3px 6px;margin:0 0 0 -6px;width:100%;max-width:340px" ' +
          'onfocus="this.style.borderColor=\'var(--border)\';this.style.background=\'#fff\'" onblur="this.style.borderColor=\'transparent\';this.style.background=\'transparent\'" ' +
          'onkeydown="if(event.key===\'Enter\')this.blur();if(event.key===\'Escape\'){this.value=this.defaultValue;this.blur()}" onchange="ffRenameTo(\'' + esc(f.id) + '\',this)"/>' +
        '<div style="font-size:12px;color:var(--txt3);' + TXT + '">' + n + ' question' + (n === 1 ? '' : 's') + ' &middot; used by ' + u + ' event' + (u === 1 ? '' : 's') + (types.length ? ' &middot; default for ' + esc(types.join(', ')) + ' events' : '') + '</div></div>' +
        '<button class="btn btn-ghost btn-sm" onclick="ffDelete(\'' + esc(f.id) + '\')" aria-label="Remove form" title="Remove from this list">&times;</button></div>';
    }).join('') : '<div style="font-size:13px;color:var(--txt3);padding:6px 0;' + TXT + '">No forms yet. Drop one in above, or from an event.</div>';
    return '<div id="vlfm-card-settings" style="margin:0 0 26px;padding-bottom:18px;border-bottom:2px solid var(--border)">' +
      '<div style="font-size:15px;font-weight:700;color:var(--txt);' + TXT + '">Feedback forms</div>' +
      '<div style="font-size:13px;color:var(--txt3);line-height:1.5;margin:2px 0 10px;' + TXT + '">Drop in a form and its questions are added for you. To use one at an event, open the event and press <b>Change</b> under Feedback form. Click a name to rename it.</div>' +
      '<div id="ffs-host">' + settingsDropHTML() + '</div>' + '<div style="margin-top:12px">' + rows + '</div></div>';
  }
  function paintSettingsDrop() { var h = $('ffs-host'); if (h) h.innerHTML = settingsDropHTML(); wireDrop(); }
  function wireDrop() {
    var drop = $('ffs-drop'); if (!drop) return;
    drop.addEventListener('dragover', function (e) { e.preventDefault(); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) ffsRead(f); });
  }
  function addSettingsCard() {
    var body = $('st-body'); if (!body || (typeof _setSection !== 'undefined' && _setSection !== 'feedback')) return;
    var old = $('vlfm-card-settings'); if (old) old.remove();
    body.insertAdjacentHTML('afterbegin', settingsCard());
    wireDrop();
  }
  window.ffsMode = function (m) { _ss.mode = m; if (m !== 'idle') _ss.msg = ''; paintSettingsDrop(); };
  async function ffsRun(text, name) {
    _ss.mode = 'busy'; _ss.fileName = name; paintSettingsDrop();
    try {
      var qs = await readToQuestions(text);
      if (!qs.length) { _ss.mode = 'idle'; paintSettingsDrop(); alert('We couldn\u2019t find any questions in that. Try a different file, or paste the questions.'); return; }
      _ss.parsed = { name: name, questions: qs }; _ss.mode = 'review'; paintSettingsDrop();
    } catch (e) { _ss.mode = 'idle'; paintSettingsDrop(); alert('Couldn\u2019t read that form: ' + (e && e.message ? e.message : e)); }
  }
  async function ffsRead(file) { var t = await fileText(file); if (t) ffsRun(t, file.name.replace(/\.[a-z0-9]+$/i, '')); }
  window.ffsFile = function (inp) { var f = inp.files && inp.files[0]; if (f) ffsRead(f); };
  window.ffsPaste = function () {
    var t = ($('ffs-paste') || {}).value || '';
    if (!t.trim()) { var e = $('ffs-err'); if (e) e.textContent = 'Paste the questions first.'; return; }
    ffsRun(t, 'pasted questions');
  };
  window.ffsSave = async function () {
    var p = _ss.parsed; if (!p) return;
    var btn = $('ffs-go'), err = $('ffs-err');
    var nm = (($('ffs-name') || {}).value || '').trim();
    if (!nm) { if (err) err.textContent = 'Give the form a name.'; return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
    try {
      var r = await ensureQuestions(p.questions);
      var list = forms().slice();
      var form = rememberForm(list, nm, r.ids);
      // the same questions under a new name: take the name you typed (if no other form has it)
      if (form.name.toLowerCase() !== nm.toLowerCase() && !list.some(function (f) { return f !== form && f.name.toLowerCase() === nm.toLowerCase(); })) form.name = nm.slice(0, 80);
      var patch = { feedback_forms: list };
      var type = ($('ffs-type') || {}).value;
      if (type) { var tm = Object.assign({}, forTypeMap()); tm[type] = form.id; patch.feedback_form_for_type = tm; }
      await saveSettings(patch);
      _ss = { mode: 'idle', parsed: null, fileName: '', msg: '\u201c' + form.name + '\u201d saved' + (r.fresh ? ' (' + r.fresh + ' new question' + (r.fresh === 1 ? '' : 's') + ' added)' : '') };
      redrawSettings();
    } catch (e) {
      if (err) err.textContent = (e && e.message) ? e.message : String(e);
      if (btn) { btn.disabled = false; btn.textContent = 'Save form'; }
    }
  };
  window.ffRenameTo = async function (id, input) {
    var nm = String(input.value || '').trim().slice(0, 80);
    var f = forms().filter(function (x) { return x.id === id; })[0]; if (!f) return;
    if (!nm) { input.value = f.name; alert('A form needs a name.'); return; }
    if (nm === f.name) return;
    if (forms().some(function (x) { return x.id !== id && x.name.toLowerCase() === nm.toLowerCase(); })) { input.value = f.name; alert('You already have a form with that name.'); return; }
    try { await saveSettings({ feedback_forms: forms().map(function (x) { return x.id === id ? Object.assign({}, x, { name: nm }) : x; }) }); }
    catch (e) { input.value = f.name; alert('Couldn\u2019t rename: ' + (e.message || e)); return; }
    input.defaultValue = nm;
    if (typeof setStatus === 'function') setStatus('\u2713 Saved');
  };
  window.ffDelete = async function (id) {
    var f = forms().filter(function (x) { return x.id === id; })[0]; if (!f) return;
    var u = usedBy(f);
    if (!confirm('Remove \u201c' + f.name + '\u201d from this list?' + (u ? ' The ' + u + ' event' + (u === 1 ? '' : 's') + ' using it keep their questions.' : ''))) return;
    var tm = Object.assign({}, forTypeMap()); Object.keys(tm).forEach(function (t) { if (tm[t] === id) delete tm[t]; });
    try { await saveSettings({ feedback_forms: forms().filter(function (x) { return x.id !== id; }), feedback_form_for_type: tm }); }
    catch (e) { alert('Couldn\u2019t remove: ' + (e.message || e)); return; }
    redrawSettings();
  };
  function redrawSettings() { if (typeof renderFeedbackQuestionsCard === 'function') renderFeedbackQuestionsCard(); else addSettingsCard(); }

  // ── wire into the existing screens ──────────────────────────
  function ready(fn) {
    var tries = 0;
    (function wait() {
      if (typeof renderEvQuestions === 'function' && typeof renderFeedbackQuestionsCard === 'function' && typeof vAI === 'function') return fn();
      if (++tries < 100) setTimeout(wait, 100);
    })();
  }
  ready(function () {
    var origEv = window.renderEvQuestions;
    window.renderEvQuestions = function (sel) {
      var wasOpen = !!($('vlfm-details') && $('vlfm-details').open);
      origEv.apply(this, arguments);
      try { injectCard(sel); if (wasOpen && $('vlfm-details')) $('vlfm-details').open = true; } catch (e) { console.warn('[feedback-forms] card:', e); }
    };
    // With saved forms an event always keeps an explicit list of questions ("all ticked" is no longer saved as "every active question"),
    // so adding another form's questions later can never lengthen it.
    var origIds = window.getEvQuestionIds;
    window.getEvQuestionIds = function () {
      var ids = origIds.apply(this, arguments);
      return (ids == null && forms().length && boxes().length) ? ticked() : ids;
    };
    var origCard = window.renderFeedbackQuestionsCard;
    window.renderFeedbackQuestionsCard = function () {
      origCard.apply(this, arguments);
      try { addSettingsCard(); } catch (e) { console.warn('[feedback-forms] settings:', e); }
    };
    document.addEventListener('change', function (ev) {
      var t = ev.target; if (!t) return;
      if (t.closest && t.closest('#evf-questions')) { _st.touched = true; _st.why = ''; _st.msg = ''; if (_st.mode === 'summary') paintCard(); }
      if (t.id === 'evf-type' && isNewEvent() && !_st.touched) {        // changing the kind of event changes the suggested form
        var s = suggestFor(eventType());
        if (s) { setTicks(s.ids); _st.why = s.why; } else { setTicks(boxes().map(function (b) { return b.value; })); _st.why = ''; }
        if (_st.mode === 'summary') paintCard();
      }
    });
  });

  if (window.__VORLANA_TEST) window.__ffTest = { forms: forms, clean: clean, norm: norm, suggestFor: suggestFor, state: function () { return _st; } };
})();
