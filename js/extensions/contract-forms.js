// js/extensions/contract-forms.js — one card per contract, three form slots
// Start form (fills itself for every new start), Outcome form (fills itself when someone gets an outcome),
// Reporting form (the funder's own return, filled by the zero-touch report). Each is dropped in once and set up once.
// Depends on: render.js (renderFunding), onboarding.js (civaraSetupContractForm), app.html (civaraUploadContractTemplate), db.js (sbUpdate, refreshTable)
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s); };
  var SLOTS = [
    { kind: 'start',   title: 'Start form',     done: 'fills itself for every new start',            empty: 'Drop in the funder\u2019s enrolment form (Word)' },
    { kind: 'outcome', title: 'Outcome form',   done: 'fills itself when someone gets an outcome',   empty: 'Drop in the funder\u2019s outcome or exit form (Word)' },
    { kind: 'report',  title: 'Reporting form', done: 'the zero-touch report fills it each period', empty: 'Drop in the funder\u2019s return (Word or Excel)' }
  ];
  var COL = { start: ['template_name', 'template_data'], outcome: ['outcome_template_name', 'outcome_template_data'], report: ['report_template_name', 'report_template_data'] };
  var STATE = {};   // contractId -> { start: name|null, outcome: name|null, report: name|null, startMap: bool, outcomeMap: bool }

  function isManager() { return typeof currentRole === 'undefined' || !currentRole || /manager|admin|owner|super/i.test(currentRole); }
  async function load() {
    try {
      var r = await sb.from('contracts').select('id,template_name,outcome_template_name,report_template_name').eq('org_id', orgId);
      (r.data || []).forEach(function (c) { STATE[String(c.id)] = Object.assign(STATE[String(c.id)] || {}, { start: c.template_name || null, outcome: c.outcome_template_name || null, report: c.report_template_name || null }); });
      var m = await sb.from('form_maps').select('form_key').eq('org_id', orgId).like('form_key', 'contract:%');
      (m.data || []).forEach(function (x) {
        var k = x.form_key.split(':'); var st = STATE[k[1]] || (STATE[k[1]] = {});
        if (k[2] === 'outcome') st.outcomeMap = true; else st.startMap = true;
      });
    } catch (e) { /* columns missing until the SQL is run; the slots still show */ }
  }
  function fileB64(f) { return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(String(r.result).split(',')[1]); }; r.onerror = rej; r.readAsDataURL(f); }); }

  window.cfUpload = function (contractId, kind) {
    var input = document.createElement('input'); input.type = 'file';
    input.accept = kind === 'report' ? '.docx,.xlsx' : '.docx';
    input.onchange = async function () {
      var f = input.files && input.files[0]; if (!f) return;
      if (kind !== 'report' && !/\.docx$/i.test(f.name)) { alert('Please choose a Word .docx file.'); return; }
      if (kind === 'report' && !/\.(docx|xlsx)$/i.test(f.name)) { alert('Please choose a Word .docx or Excel .xlsx file.'); return; }
      if (f.size > 3 * 1024 * 1024) { alert('That file is over 3 MB. Funder forms are usually much smaller.'); return; }
      var patch = {}; patch[COL[kind][0]] = f.name; patch[COL[kind][1]] = await fileB64(f);
      try { await sbUpdate('contracts', patch, contractId); }
      catch (e) { alert(/template/i.test(e.message || '') ? 'Run contract-forms.sql in Supabase first, then try again.' : 'Upload failed: ' + (e.message || e)); return; }
      STATE[String(contractId)] = Object.assign(STATE[String(contractId)] || {}, (function () { var o = {}; o[kind] = f.name; return o; })());
      paint();
      if (kind !== 'report' && typeof civaraSetupContractForm === 'function') civaraSetupContractForm(contractId, false, kind);   // set it up straight away
    };
    input.click();
  };
  window.cfSetup = function (contractId, kind) { if (typeof civaraSetupContractForm === 'function') civaraSetupContractForm(contractId, false, kind); };
  window.cfRemove = async function (contractId, kind) {
    if (!confirm('Remove this form from the contract? Forms already filled are kept.')) return;
    var patch = {}; patch[COL[kind][0]] = null; patch[COL[kind][1]] = null;
    try { await sbUpdate('contracts', patch, contractId); } catch (e) { alert('Could not remove: ' + (e.message || e)); return; }
    STATE[String(contractId)][kind] = null; paint();
  };

  function slotHTML(id, slot) {
    var st = STATE[id] || {}, name = st[slot.kind], mapped = slot.kind === 'start' ? st.startMap : slot.kind === 'outcome' ? st.outcomeMap : true;
    var mgr = isManager();
    if (!name) {
      return '<div class="cf-slot cf-empty"' + (mgr ? ' onclick="cfUpload(\'' + esc(id) + '\',\'' + slot.kind + '\')"' : '') + '>' +
        '<span class="cf-ico">\u2B06</span><div><div class="cf-t">' + slot.title + '</div><div class="cf-s">' + (mgr ? slot.empty : 'Not set up yet') + '</div></div></div>';
    }
    return '<div class="cf-slot"><span class="cf-ico">' + (mapped ? '\u2705' : '\uD83D\uDCC4') + '</span><div style="flex:1;min-width:0"><div class="cf-t">' + slot.title + '</div>' +
      '<div class="cf-s">' + esc(name) + ' \u00b7 ' + (slot.kind === 'report' ? 'ready for the zero-touch report' : mapped ? 'set up \u00b7 ' + slot.done : 'not set up yet') + '</div></div>' +
      (mgr ? '<div style="display:flex;gap:6px;flex-shrink:0">' + (slot.kind !== 'report' && !mapped ? '<button class="btn btn-p btn-sm" onclick="cfSetup(\'' + esc(id) + '\',\'' + slot.kind + '\')">Set up</button>' : '') +
        '<button class="btn btn-ghost btn-sm" onclick="cfUpload(\'' + esc(id) + '\',\'' + slot.kind + '\')">Replace</button>' +
        '<button class="btn btn-ghost btn-sm" title="Remove" onclick="cfRemove(\'' + esc(id) + '\',\'' + slot.kind + '\')">\u00d7</button></div>' : '') + '</div>';
  }
  function style() {
    if ($('cf-style')) return;
    var st = document.createElement('style'); st.id = 'cf-style';
    st.textContent = '#fund-list .civ-tpl-btn,#fund-list .civ-map-btn{display:none !important}' +
      '.cf-wrap{margin-top:12px;padding-top:10px;border-top:1px solid var(--border)}.cf-h{font-size:11px;font-weight:700;color:var(--txt3);margin-bottom:6px;text-transform:uppercase;letter-spacing:.5px}' +
      '.cf-slot{display:flex;align-items:center;gap:10px;border:1px solid var(--border);border-radius:10px;padding:9px 12px;margin-bottom:6px;background:#fff}.cf-slot.cf-empty{border-style:dashed;cursor:pointer;color:var(--txt3)}' +
      '.cf-ico{font-size:18px;flex:none}.cf-t{font-size:13px;font-weight:600;color:var(--txt)}.cf-empty .cf-t{color:var(--txt2)}.cf-s{font-size:12px;color:var(--txt3)}';
    document.head.appendChild(st);
  }
  function paint() {
    var el = $('fund-list'); if (!el) return; style();
    el.querySelectorAll('.civ-tpl-btn,.civ-map-btn').forEach(function (b) { b.remove(); });   // the old two buttons
    el.querySelectorAll('button[onclick^="openEditCon"]').forEach(function (edit) {
      var m = /openEditCon\('([^']+)'\)/.exec(edit.getAttribute('onclick') || ''); if (!m) return;
      var id = m[1], card = edit.closest('.card') || edit.parentNode.parentNode;
      var wrap = card.querySelector('.cf-wrap'); if (!wrap) { wrap = document.createElement('div'); wrap.className = 'cf-wrap'; card.appendChild(wrap); }
      wrap.innerHTML = '<div class="cf-h">The funder\u2019s forms</div>' + SLOTS.map(function (s) { return slotHTML(id, s); }).join('');
    });
  }
  function ready(fn) { var t = 0; (function w() { if (typeof renderFunding === 'function' && typeof sb !== 'undefined' && sb) return fn(); if (++t < 100) setTimeout(w, 100); })(); }
  ready(function () {
    var orig = window.renderFunding;
    window.renderFunding = function () { var r = orig.apply(this, arguments); load().then(paint); return r; };
    if ($('fund-list') && $('fund-list').children.length) load().then(paint);
  });
})();
