// js/extensions/feedback-forms.js — named feedback forms, and picking one on an event
// A form is a named set of the organisation's existing feedback questions, e.g. "Garden workshops" or "Green Skills (PECT)".
// Stored in organisations.settings.feedback_forms = [{ id, name, question_ids: [...], is_default }].
// Choosing a form on an event simply ticks that form's questions; the event still saves its own list of questions
// (events.question_ids), so the public QR page, reports and every existing event work exactly as before.
// Depends on: modals.js (renderEvQuestions, getEvQuestionIds, _editEvId), render.js (activeMeasures), settings.js (renderFeedbackQuestionsCard)
(function () {
  'use strict';

  var esc = function (s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var $ = function (id) { return document.getElementById(id); };

  // ── the forms ───────────────────────────────────────────────
  function forms() {
    var s = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.settings) || {};
    return Array.isArray(s.feedback_forms) ? s.feedback_forms : [];
  }
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
  function eventsUsing(f) {
    var ids = liveIds(f);
    return (typeof DB !== 'undefined' && DB.events ? DB.events : []).filter(function (ev) { return ev.question_ids && sameSet(ev.question_ids.map(String), ids); }).length;
  }

  // Save without overwriting anything else in the organisation's settings (read the latest, add ours, write)
  async function save(next) {
    var base = (currentOrg && currentOrg.settings) || {};
    try {
      var cur = await sb.from('organisations').select('settings').eq('id', orgId).single();
      if (cur && cur.data && cur.data.settings) base = cur.data.settings;
    } catch (e) { /* fall back to what we have */ }
    var settings = Object.assign({}, base, { feedback_forms: next });
    var res = await sb.from('organisations').update({ settings: settings }).eq('id', orgId);
    if (res && res.error) throw res.error;
    currentOrg = Object.assign({}, currentOrg, { settings: settings });
  }

  // ── on the event form: pick a form ──────────────────────────
  var _applying = false;
  function boxes() { return [].slice.call(document.querySelectorAll('#evf-questions input[type=checkbox]')); }
  function ticked() { return boxes().filter(function (b) { return b.checked; }).map(function (b) { return b.value; }); }

  window.ffApply = function (id) {
    if (!id) return;
    var f = forms().filter(function (x) { return x.id === id; })[0]; if (!f) return;
    var want = {}; liveIds(f).forEach(function (q) { want[q] = 1; });
    _applying = true;
    boxes().forEach(function (b) { b.checked = !!want[b.value]; });
    _applying = false;
    var msg = $('ff-note');
    if (msg) msg.textContent = Object.keys(want).length ? '' : 'None of this form\u2019s questions are switched on any more. Edit the form in Settings.';
  };
  function syncSelect() {                  // the picker follows the ticks: if they no longer match a form, it says so
    var sel = $('ff-select'); if (!sel || _applying) return;
    var on = ticked(), hit = '';
    forms().forEach(function (f) { if (!hit && sameSet(on, liveIds(f))) hit = f.id; });
    sel.value = hit;
  }
  function injectPicker(selectedIds) {
    var box = $('evf-questions-wrap'); if (!box || $('ff-pick')) return;
    var list = forms().filter(function (f) { return liveIds(f).length; });
    if (!list.length) return;
    var label = box.querySelector('label'); if (!label) return;
    var opts = '<option value="">Choose questions myself</option>' + list.map(function (f) {
      return '<option value="' + esc(f.id) + '">' + esc(f.name) + ' (' + liveIds(f).length + ' question' + (liveIds(f).length === 1 ? '' : 's') + ')</option>';
    }).join('');
    label.insertAdjacentHTML('afterend',
      '<div id="ff-pick" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:2px 0 10px"><span style="font-size:13px;color:var(--txt2)">Use form</span>' +
      '<select id="ff-select" onchange="ffApply(this.value)" style="width:auto;max-width:300px">' + opts + '</select>' +
      '<span id="ff-note" style="font-size:12px;color:var(--txt3)"></span></div>');
    var isNew = (typeof _editEvId === 'undefined') ? false : !_editEvId;
    var def = list.filter(function (f) { return f.is_default; })[0];
    if (selectedIds == null && isNew && def) { $('ff-select').value = def.id; window.ffApply(def.id); }   // a new event starts on your default form
    else syncSelect();
  }

  // ── Settings: manage the forms ──────────────────────────────
  function cardHTML() {
    var list = forms();
    var rows = list.length ? list.map(function (f) {
      var n = liveIds(f).length, used = eventsUsing(f);
      return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-top:1px solid var(--border)">' +
        '<div style="min-width:0"><div style="font-weight:600;font-size:14px">' + esc(f.name) + (f.is_default ? ' <span style="font-size:11px;font-weight:600;background:var(--bg);color:var(--em);border-radius:10px;padding:2px 8px;margin-left:6px">Default for new events</span>' : '') + '</div>' +
        '<div style="font-size:12px;color:var(--txt3)">' + n + ' question' + (n === 1 ? '' : 's') + ' &middot; used by ' + used + ' event' + (used === 1 ? '' : 's') + '</div></div>' +
        '<div style="display:flex;gap:6px;flex-shrink:0"><button class="btn btn-ghost btn-sm" onclick="ffEdit(\'' + esc(f.id) + '\')">Edit</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="ffDelete(\'' + esc(f.id) + '\')" aria-label="Delete form">&times;</button></div></div>';
    }).join('') : '<div style="font-size:13px;color:var(--txt3);padding:8px 0">No forms yet. Make one for each project or funder, then pick it when you create an event.</div>';
    return '<div id="ff-card" style="margin-top:26px;padding-top:18px;border-top:2px solid var(--border)">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:4px"><b style="font-size:15px">Feedback forms</b>' +
      '<button class="btn btn-p btn-sm" onclick="ffEdit(\'\')">+ New form</button></div>' +
      '<div style="font-size:13px;color:var(--txt3);line-height:1.5;margin-bottom:6px">Group your questions into forms, for example one per project or funder. When you create an event, pick the form to use.</div>' +
      rows + '</div>';
  }
  function addCard() {
    var body = $('st-body'); if (!body || (typeof _setSection !== 'undefined' && _setSection !== 'feedback')) return;
    var old = $('ff-card'); if (old) old.remove();
    body.insertAdjacentHTML('beforeend', cardHTML());
  }

  var _editing = '';
  window.ffEdit = function (id) {
    _editing = id || '';
    var f = id ? forms().filter(function (x) { return x.id === id; })[0] : null;
    var have = {}; (f ? liveIds(f) : []).forEach(function (q) { have[q] = 1; });
    var qs = activeQs();
    var html = '<h2>' + (f ? 'Edit form' : 'New feedback form') + '</h2>' +
      '<div class="form-row"><label>Form name</label><input id="ff-name" value="' + esc(f ? f.name : '') + '" placeholder="e.g. Garden workshops, or Green Skills (PECT)"/></div>' +
      '<div class="form-row"><label>Questions on this form</label>' +
      (qs.length ? '<div style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:6px 12px">' + qs.map(function (m) {
        return '<label style="display:flex;gap:10px;align-items:flex-start;padding:7px 0;font-size:14px;cursor:pointer"><input type="checkbox" class="ff-q" value="' + esc(String(m.id)) + '"' + (have[String(m.id)] ? ' checked' : '') + ' style="margin-top:3px"/><span>' + esc(m.question) + '</span></label>';
      }).join('') + '</div>' : '<div style="font-size:13px;color:var(--txt3)">No questions yet. Add or copy some under Feedback questions first.</div>') + '</div>' +
      '<label style="display:flex;gap:10px;align-items:center;font-size:14px;margin:4px 0 10px;cursor:pointer"><input type="checkbox" id="ff-def"' + (f && f.is_default ? ' checked' : '') + '/> Use this form for new events</label>' +
      '<div id="ff-err" style="font-size:13px;color:var(--danger,#B91C1C);min-height:18px"></div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" onclick="setCloseModal()">Cancel</button><button class="btn btn-p" id="ff-save" onclick="ffSaveForm()">Save form</button></div>';
    setModal(html);
  };
  window.ffSaveForm = async function () {
    var err = $('ff-err'), btn = $('ff-save');
    var name = ($('ff-name').value || '').trim();
    var ids = [].slice.call(document.querySelectorAll('.ff-q')).filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    if (!name) { err.textContent = 'Give the form a name.'; return; }
    if (!ids.length) { err.textContent = 'Tick at least one question.'; return; }
    if (forms().some(function (f) { return f.id !== _editing && f.name.toLowerCase() === name.toLowerCase(); })) { err.textContent = 'You already have a form with that name.'; return; }
    err.textContent = ''; btn.disabled = true; btn.textContent = 'Saving\u2026';
    try {
      var isDef = $('ff-def').checked;
      var next = forms().map(function (f) { return Object.assign({}, f, isDef ? { is_default: false } : {}); });
      var rec = { id: _editing || ('f_' + Date.now().toString(36)), name: name.slice(0, 80), question_ids: ids, is_default: isDef };
      var at = next.findIndex(function (f) { return f.id === rec.id; });
      if (at >= 0) next[at] = Object.assign({}, next[at], rec); else next.push(rec);
      await save(next);
      setCloseModal();
      if (typeof renderFeedbackQuestionsCard === 'function') renderFeedbackQuestionsCard(); else addCard();
    } catch (e) { err.textContent = 'Couldn\u2019t save: ' + (e.message || e); btn.disabled = false; btn.textContent = 'Save form'; }
  };
  window.ffDelete = async function (id) {
    var f = forms().filter(function (x) { return x.id === id; })[0]; if (!f) return;
    var used = eventsUsing(f);
    if (!confirm('Delete the form \u201c' + f.name + '\u201d?' + (used ? ' The ' + used + ' event' + (used === 1 ? '' : 's') + ' using it keep their questions.' : ''))) return;
    try { await save(forms().filter(function (x) { return x.id !== id; })); }
    catch (e) { alert('Couldn\u2019t delete: ' + (e.message || e)); return; }
    if (typeof renderFeedbackQuestionsCard === 'function') renderFeedbackQuestionsCard(); else addCard();
  };

  // ── wire into the existing screens ──────────────────────────
  function ready(fn) {
    var tries = 0;
    (function wait() {
      if (typeof renderEvQuestions === 'function' && typeof renderFeedbackQuestionsCard === 'function' && typeof setModal === 'function') return fn();
      if (++tries < 100) setTimeout(wait, 100);
    })();
  }
  ready(function () {
    var origEv = window.renderEvQuestions;
    window.renderEvQuestions = function (sel) {
      origEv.apply(this, arguments);
      try { injectPicker(sel); } catch (e) { console.warn('[feedback-forms] picker:', e); }
    };
    var origCard = window.renderFeedbackQuestionsCard;
    window.renderFeedbackQuestionsCard = function () {
      origCard.apply(this, arguments);
      try { addCard(); } catch (e) { console.warn('[feedback-forms] card:', e); }
    };
    document.addEventListener('change', function (ev) { if (ev.target && ev.target.closest && ev.target.closest('#evf-questions')) syncSelect(); });
  });

  if (window.__VORLANA_TEST) window.__ffTest = { forms: forms, liveIds: liveIds, sameSet: sameSet, save: save };
})();
