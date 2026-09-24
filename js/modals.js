// js/modals.js — every modal open/save/delete handler
// Depends on: config.js, utils.js, db.js, render.js, agents.js
//
// Each entity follows the pattern:
//   openAddX()    — clear form, show modal
//   openEditX(id) — populate form, show modal
//   saveX()       — write to Supabase, refresh, render, close
//   deleteX(id)   — confirm, delete, refresh, render

'use strict';

// ── Modal-scoped state ──────────────────────────────────────
let _editPId          = null;
let _editVolId        = null;
let _editEmpId        = null;
let _editEvId         = null;
let _editFbId         = null;
let _editItemId       = null;
let _editConId        = null;
let _editCId          = null;
let _editFunderId     = null;
let _editEqPId        = null;
let _editPartnerRefId = null;

let _fbScores = { enjoyed: 5, cb: 3, ca: 5 };

// ── Checkbox group helpers ──────────────────────────────────
function mkChkArr(cid, items, sel) {
  if (!sel) sel = [];
  const el = $(cid); if (!el) return;
  el.innerHTML = items.map(b =>
    '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--txt2);background:#FFFFFF;border:1px solid var(--border);border-radius:6px;padding:3px 7px;cursor:pointer;text-transform:none;letter-spacing:0;font-weight:500">' +
    '<input type="checkbox" value="' + escapeHTML(b) + '"' + (sel.includes(b) ? ' checked' : '') +
    ' style="width:auto;background:none;border:none;padding:0"/> ' + escapeHTML(b) + '</label>'
  ).join('');
}
function getChkArr(cid) {
  return [].slice.call(document.querySelectorAll('#' + cid + ' input[type=checkbox]:checked')).map(x => x.value);
}
function mkChkGroup(cid, items, sel) {
  if (!sel) sel = [];
  const el = $(cid); if (!el) return;
  el.innerHTML = items.map(it =>
    '<div class="chk-pill"><label><input type="checkbox" value="' + escapeHTML(it) + '"' + (sel.includes(it) ? ' checked' : '') + '/> ' + escapeHTML(it) + '</label></div>'
  ).join('');
}

// ── Contract selector inside the participant modal ──────────
function renderContractSelector(sel) {
  if (!sel) sel = [];
  const el = $('mp-contracts-list'); if (!el) return;
  if (!DB.contracts.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--txt3);padding:4px">No contracts yet.</div>';
    return;
  }
  el.innerHTML = DB.contracts.map(c => {
    const s = sel.map(String).includes(String(c.id));
    return '<div class="con-option' + (s ? ' selected' : '') + '" id="con-opt-' + c.id + '" onclick="toggleConOption(' + JSON.stringify(c.id) + ')">' +
      '<input type="checkbox" value="' + escapeHTML(c.id) + '"' + (s ? ' checked' : '') + ' style="width:auto;background:none;border:none;padding:0;pointer-events:none"/>' +
      '<div><div style="font-size:12px;font-weight:600;color:var(--txt)">' + escapeHTML(c.name) + '</div>' +
      '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(c.funder || '—') + ' · £' + num(c.value).toLocaleString() + '</div></div></div>';
  }).join('');
}
function toggleConOption(id) {
  const el = $('con-opt-' + id); if (!el) return;
  const cb = el.querySelector('input');
  cb.checked = !cb.checked;
  el.classList.toggle('selected', cb.checked);
}
function getSelectedContractIds() {
  return [].slice.call(document.querySelectorAll('#mp-contracts-list input[type=checkbox]:checked')).map(x => x.value);
}

// ── Participant modal ───────────────────────────────────────
function openAddP() {
  _editPId = null;
  _editPartnerRefId = null;
  $('mp-title').textContent = 'Add participant';
  ['mp-fn', 'mp-ln', 'mp-note', 'mp-conf', 'mp-work', 'mp-well', 'mp-skillsc', 'mp-intake-text', 'mp-phone', 'mp-email'].forEach(f => {
    if ($(f)) $(f).value = '';
  });
  $('mp-safe').value = '';
  $('mp-due').value  = '';
  $('mp-note-preview').style.display = 'none';
  $('mp-ai-intake-result').innerHTML = '';
  mkChkArr('barrier-checks', BARRIERS);
  mkChkArr('outcome-checks', OUT_TYPES);
  renderContractSelector([]);
  $('modal-p').classList.add('open');
}

function openEditP(id) {
  const p = DB.participants.find(x => x.id === id); if (!p) return;
  _editPId = id;
  _editPartnerRefId = null;
  $('mp-title').textContent = 'Edit participant';
  $('mp-fn').value   = p.first_name;
  $('mp-ln').value   = p.last_name;
  $('mp-rs').value   = p.ref_source;
  $('mp-adv').value  = p.advisor;
  $('mp-st').value   = p.stage;
  $('mp-risk').value = p.risk;
  $('mp-safe').value = p.safeguarding || '';
  $('mp-intake-text').value = '';
  $('mp-note-preview').style.display = 'none';
  $('mp-ai-intake-result').innerHTML = '';
  $('mp-phone').value = p.phone || '';
  $('mp-email').value = p.email || '';
  const sc = p.scores || {};
  $('mp-conf').value    = sc.confidence     || '';
  $('mp-work').value    = sc.work_readiness || '';
  $('mp-well').value    = sc.wellbeing      || '';
  $('mp-skillsc').value = sc.skills         || '';
  mkChkArr('barrier-checks', BARRIERS, p.barriers);
  mkChkArr('outcome-checks', OUT_TYPES, p.outcomes);
  renderContractSelector(toArr(p.contract_ids));
  $('mp-note').value = '';
  $('modal-p').classList.add('open');
}

// Reset partner-referral context when the modal closes (bug #4 fix)
function closeParticipantModal() {
  closeModal('modal-p');
  _editPartnerRefId = null;
}

async function saveP() {
  const btn = $('p-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const note = $('mp-note').value;
    const contractIds = getSelectedContractIds();
    const d = {
      first_name: $('mp-fn').value || 'Unknown',
      last_name:  $('mp-ln').value || '',
      ref_source: $('mp-rs').value,
      stage:      $('mp-st').value,
      advisor:    $('mp-adv').value,
      barriers:   getChkArr('barrier-checks'),
      outcomes:   getChkArr('outcome-checks'),
      safeguarding: $('mp-safe').value || null,
      risk:       $('mp-risk').value,
      last_contact: today(),
      contract_ids: contractIds,
      phone:      $('mp-phone').value || '',
      email:      $('mp-email').value || '',
      scores: {
        confidence:     parseInt($('mp-conf').value)    || null,
        work_readiness: parseInt($('mp-work').value)    || null,
        wellbeing:      parseInt($('mp-well').value)    || null,
        skills:         parseInt($('mp-skillsc').value) || null
      }
    };
    if (_editPId) {
      const ex = DB.participants.find(x => x.id === _editPId);
      const notes = toArr(ex.notes).slice();
      if (note) notes.push({ t: note, d: today(), s: 'Staff' });
      await sbUpdate('participants', Object.assign({}, d, { notes }), _editPId);
    } else {
      const notes = note ? [{ t: note, d: today(), s: 'Staff' }] : [];
      await sbInsert('participants', Object.assign({}, d, { notes }));
      // If we came from a partner referral, mark it as Converted
      if (_editPartnerRefId) {
        try { await sbUpdate('partner_referrals', { status: 'Converted' }, _editPartnerRefId); } catch (e) { /* ignore */ }
      }
    }
    if (sb) await refreshTable('participants');
    if (sb) await refreshTable('partner_referrals');
    _editPartnerRefId = null;
    closeModal('modal-p');
    renderParticipants();
  } catch (e) {
    alert('Save failed: ' + e.message);
  } finally {
    btn.textContent = 'Save'; btn.disabled = false;
  }
}

async function deleteP(id) {
  if (!confirm('Delete this participant?')) return;
  await sbDelete('participants', id);
  DB.participants = DB.participants.filter(x => x.id !== id);
  renderParticipants();
}

// Notes mini-modal
function openNotes(id) {
  const p = DB.participants.find(x => x.id === id); if (!p) return;
  const notes = toArr(p.notes).slice().reverse();
  const m = document.createElement('div');
  m.className = 'modal-overlay open';
  m.id = 'modal-notes';
  m.innerHTML = '<div class="modal" style="max-width:560px"><h2>Case notes — ' + escapeHTML(p.first_name + ' ' + p.last_name) + '</h2>' +
    '<div style="max-height:220px;overflow-y:auto;margin-bottom:12px">' +
      (notes.length
        ? notes.map(nt => '<div class="tl-entry"><div class="tl-dot blue"></div>' +
            '<div><div class="tl-lbl">' + escapeHTML(nt.t) + '</div>' +
            '<div class="tl-meta">' + escapeHTML(nt.d) + ' · ' + escapeHTML(nt.s) + '</div></div></div>').join('')
        : '<div style="color:var(--txt3);font-size:13px">No notes yet.</div>') +
    '</div>' +
    '<div class="form-row"><label>New case note</label><textarea id="new-note-txt" style="min-height:80px"></textarea></div>' +
    '<div style="display:flex;gap:8px;margin-top:10px">' +
      '<button class="btn btn-p" onclick="addNote(' + JSON.stringify(id) + ')">Save note</button>' +
      '<button class="btn btn-ghost" onclick="document.getElementById(\'modal-notes\').remove()">Close</button>' +
    '</div></div>';
  document.body.appendChild(m);
}

async function addNote(id) {
  const p = DB.participants.find(x => x.id === id);
  const txt = $('new-note-txt').value;
  if (!txt || !p) return;
  const notes = toArr(p.notes).concat({ t: txt, d: today(), s: 'Staff' });
  await sbUpdate('participants', { notes, last_contact: today() }, id);
  if (sb) await refreshTable('participants');
  $('modal-notes').remove();
  renderParticipants();
}

// Convert partner referral to participant
function convertToParticipant(id) {
  const r = DB.partner_referrals.find(x => x.id === id); if (!r) return;
  _editPId = null;
  _editPartnerRefId = id;
  $('mp-title').textContent = 'Add participant (from referral)';
  $('mp-fn').value = r.first_name || '';
  $('mp-ln').value = r.last_name  || '';
  $('mp-rs').value = 'Community org';
  $('mp-st').value = 'Referred';
  $('mp-risk').value = 'Medium';
  $('mp-safe').value = r.safeguarding || '';
  $('mp-phone').value = '';
  $('mp-email').value = '';
  $('mp-intake-text').value = r.notes || '';
  mkChkArr('barrier-checks', BARRIERS, toArr(r.barriers));
  mkChkArr('outcome-checks', OUT_TYPES);
  renderContractSelector([]);
  $('mp-note-preview').style.display = 'none';
  $('mp-ai-intake-result').innerHTML = '';
  $('modal-p').classList.add('open');
}

// ── Contacts ────────────────────────────────────────────────
function openAddC() {
  _editCId = null;
  $('c-title').textContent = 'Add contact';
  ['cf-fn', 'cf-ln', 'cf-em'].forEach(f => $(f).value = '');
  $('modal-c').classList.add('open');
}
function openEditC(id) {
  const c = DB.contacts.find(x => x.id === id); if (!c) return;
  _editCId = id;
  $('c-title').textContent = 'Edit contact';
  $('cf-fn').value = c.first_name;
  $('cf-ln').value = c.last_name;
  $('cf-em').value = c.email;
  $('cf-role').value = c.role;
  $('cf-st').value = c.status;
  $('modal-c').classList.add('open');
}
async function saveC() {
  const btn = $('c-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const d = {
      first_name: $('cf-fn').value, last_name: $('cf-ln').value,
      email: $('cf-em').value, role: $('cf-role').value, status: $('cf-st').value
    };
    if (_editCId) await sbUpdate('contacts', d, _editCId);
    else await sbInsert('contacts', d);
    await refreshTable('contacts');
    closeModal('modal-c');
    renderContacts();
  } catch (e) { alert('Save failed: ' + e.message); }
  finally { btn.textContent = 'Save'; btn.disabled = false; }
}
async function deleteC(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('contacts', id);
  await refreshTable('contacts');
  renderContacts();
}

// ── Volunteers ──────────────────────────────────────────────
// Skills offered = Vorlana's standard list + every skill already used in
// this org (e.g. from an imported sign-in sheet) + this volunteer's own.
function volSkillOptions(sel) {
  const seen = {}, out = [];
  const add = s => { s = String(s || '').trim(); if (s && !seen[s.toLowerCase()]) { seen[s.toLowerCase()] = 1; out.push(s); } };
  (sel || []).forEach(add);
  (DB.volunteers || []).forEach(v => toArr(v.skills).forEach(add));
  (typeof VOL_SKILLS !== 'undefined' ? VOL_SKILLS : []).forEach(add);
  return out;
}
function renderVolSkills(sel) {
  sel = sel || [];
  mkChkGroup('vf-skills', volSkillOptions(sel), sel);
  const grp = $('vf-skills'); if (!grp) return;
  let row = $('vf-skill-add-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'vf-skill-add-row';
    row.style.cssText = 'display:flex;gap:6px;margin-top:8px';
    row.innerHTML = '<input id="vf-skill-new" placeholder="Add a skill…" style="flex:1;font-size:13px"/>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="addVolSkill()">+ Add</button>';
    grp.parentNode.insertBefore(row, grp.nextSibling);
    $('vf-skill-new').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addVolSkill(); } });
  }
  $('vf-skill-new').value = '';
}
function addVolSkill() {
  const v = ($('vf-skill-new').value || '').trim();
  if (!v) return;
  const sel = getChkArr('vf-skills');
  if (!sel.some(x => x.toLowerCase() === v.toLowerCase())) sel.push(v);
  renderVolSkills(sel);
}

function openAddVol() {
  _editVolId = null;
  $('vol-modal-title').textContent = 'Add volunteer';
  ['vf-name', 'vf-email', 'vf-phone', 'vf-notes'].forEach(id => { if ($(id)) $(id).value = ''; });
  $('vf-hours').value  = '0';
  $('vf-role').value   = 'Volunteer';
  $('vf-status').value = 'Active';
  renderVolSkills([]);
  $('modal-vol').classList.add('open');
}
function openEditVol(id) {
  const v = DB.volunteers.find(x => x.id === id); if (!v) return;
  _editVolId = id;
  $('vol-modal-title').textContent = 'Edit volunteer';
  $('vf-name').value   = v.name;
  $('vf-email').value  = v.email || '';
  $('vf-phone').value  = v.phone || '';
  $('vf-hours').value  = v.hours;
  $('vf-role').value   = v.role || 'Volunteer';
  $('vf-status').value = v.status;
  renderVolSkills(toArr(v.skills));
  $('modal-vol').classList.add('open');
}
async function saveVol() {
  const fullName = $('vf-name').value.trim();
  const email = $('vf-email').value.trim();
  const phone = $('vf-phone').value.trim();
  const role = $('vf-role').value;
  if (!fullName) { alert('Full name is required.'); return; }
  const btn = $('vol-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const parts = fullName.split(' ');
    const payload = {
      first_name: parts[0],
      last_name:  parts.slice(1).join(' '),
      name:       fullName, email: email || null, phone: phone || null, role,
      hours: parseInt($('vf-hours').value) || 0,
      status: $('vf-status').value,
      skills: JSON.stringify(getChkArr('vf-skills'))
    };
    if (_editVolId) await sbUpdate('volunteers', payload, _editVolId);
    else await sbInsert('volunteers', payload);
    await refreshTable('volunteers');
    closeModal('modal-vol');
    renderVolunteers();
  } catch (e) { alert('Save failed: ' + e.message); }
  finally { btn.textContent = 'Save volunteer'; btn.disabled = false; }
}
async function deleteVol(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('volunteers', id);
  await refreshTable('volunteers');
  renderVolunteers();
}

// ── Employers ───────────────────────────────────────────────
function openAddEmployer() {
  _editEmpId = null;
  $('emp-title').textContent = 'Add employer';
  ['ef-nm', 'ef-con', 'ef-cem', 'ef-notes'].forEach(f => $(f).value = '');
  $('ef-vac').value = '0';
  $('modal-emp').classList.add('open');
}
function openEditEmployer(id) {
  const e = DB.employers.find(x => x.id === id); if (!e) return;
  _editEmpId = id;
  $('emp-title').textContent = 'Edit employer';
  $('ef-nm').value   = e.name;
  $('ef-sec').value  = e.sector;
  $('ef-con').value  = e.contact_name;
  $('ef-cem').value  = e.contact_email;
  $('ef-vac').value  = e.vacancies;
  $('ef-rel').value  = e.relationship;
  $('ef-notes').value = e.notes;
  $('modal-emp').classList.add('open');
}
async function saveEmployer() {
  const btn = $('emp-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const d = {
      name: $('ef-nm').value, sector: $('ef-sec').value,
      contact_name: $('ef-con').value, contact_email: $('ef-cem').value,
      vacancies: parseInt($('ef-vac').value) || 0,
      relationship: $('ef-rel').value, notes: $('ef-notes').value
    };
    if (_editEmpId) await sbUpdate('employers', d, _editEmpId);
    else await sbInsert('employers', d);
    await refreshTable('employers');
    closeModal('modal-emp');
    renderEmployers();
  } catch (e) { alert('Save failed: ' + e.message); }
  finally { btn.textContent = 'Save'; btn.disabled = false; }
}
async function deleteEmployer(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('employers', id);
  await refreshTable('employers');
  renderEmployers();
}

// ── Referrals ───────────────────────────────────────────────
function openAddR() {
  $('rf-date').value = today();
  ['rf-fn', 'rf-ln'].forEach(f => $(f).value = '');
  $('modal-r').classList.add('open');
}
async function saveR() {
  const btn = $('r-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    await sbInsert('referrals', {
      first_name: $('rf-fn').value,
      last_name:  $('rf-ln').value,
      source:     $('rf-src').value,
      status:     'Referred',
      advisor:    $('rf-adv').value,
      referred_date: $('rf-date').value
    });
    await refreshTable('referrals');
    closeModal('modal-r');
    renderReferrals();
  } catch (e) { alert('Save failed: ' + e.message); }
  finally { btn.textContent = 'Save'; btn.disabled = false; }
}
async function deleteRef(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('referrals', id);
  await refreshTable('referrals');
  renderReferrals();
}

// ── Events ──────────────────────────────────────────────────
// v3: each event picks which of the org's feedback questions to ask.
// events.question_ids = array of survey_measures ids, or null = all.
function _evQuestionBox() {
  let box = $('evf-questions-wrap');
  if (box) return box;
  const modal = document.querySelector('#modal-ev .modal'); if (!modal) return null;
  const footer = modal.querySelector('.modal-footer');
  box = document.createElement('div');
  box.id = 'evf-questions-wrap';
  box.className = 'form-row';
  modal.insertBefore(box, footer);
  return box;
}
function renderEvQuestions(selectedIds) {
  const box = _evQuestionBox(); if (!box) return;
  const M = (typeof activeMeasures === 'function') ? activeMeasures() : [];
  const all = selectedIds == null;
  box.innerHTML =
    '<label>Feedback questions for this event</label>' +
    (M.length
      ? '<div class="chk-group" id="evf-questions">' +
          M.map(m => '<div class="chk-pill"><label title="' + escapeHTML(m.question) + '"><input type="checkbox" value="' + escapeHTML(String(m.id)) + '"' + ((all || selectedIds.map(String).includes(String(m.id))) ? ' checked' : '') + '/> ' + escapeHTML((m.label || m.question).length > 48 ? (m.label || m.question).slice(0, 48) + '…' : (m.label || m.question)) + '</label></div>').join('') +
        '</div>'
      : '<div style="font-size:12px;color:var(--txt3);margin:4px 0 8px">No questions set up yet — add one below or under Settings → Feedback questions.</div>') +
    '<div style="display:flex;gap:6px;margin-top:8px;align-items:center;flex-wrap:wrap">' +
      '<input id="evf-newq" placeholder="Add a new question, e.g. Would you come again?" style="flex:1;min-width:220px;font-size:13px"/>' +
      '<select id="evf-newq-kind" style="width:auto"><option value="yesno">Yes / no</option><option value="score">Score 1–5</option><option value="choice">Choice</option><option value="text">Comment</option></select>' +
      '<button type="button" class="btn btn-ghost btn-sm" onclick="evAddQuestion()">+ Add</button>' +
    '</div>';
}
function getEvQuestionIds() {
  const boxes = [].slice.call(document.querySelectorAll('#evf-questions input[type=checkbox]'));
  if (!boxes.length) return null;
  const on = boxes.filter(b => b.checked).map(b => b.value);
  return on.length === boxes.length ? null : on;   // all ticked = "every active question"
}
async function evAddQuestion() {
  const q = ($('evf-newq').value || '').trim();
  if (!q) return;
  const kind = $('evf-newq-kind').value;
  const btn = document.querySelector('#evf-questions-wrap button'); if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const sel = getEvQuestionIds();
    const r = await sb.from('survey_measures').upsert({ org_id: orgId, question: q, kind, maps_to: null, label: q.slice(0, 60), active: true, sort: (DB.survey_measures || []).length }, { onConflict: 'org_id,question' }).select();
    if (r.error) throw r.error;
    await refreshTable('survey_measures');
    const added = (DB.survey_measures || []).find(m => m.question === q);
    renderEvQuestions(sel == null ? null : sel.concat(added ? [String(added.id)] : []));
  } catch (e) {
    alert('Could not add question: ' + (e.message || e) + (/survey_measures|active|sort/i.test(e.message || '') ? '\n\nRun sql/import-v3.sql in Supabase first.' : ''));
    if (btn) { btn.disabled = false; btn.textContent = '+ Add'; }
  }
}

function openAddEv() {
  _editEvId = null;
  $('ev-modal-title').textContent = 'Create event';
  ['evf-name', 'evf-loc'].forEach(id => $(id).value = '');
  $('evf-type').value = 'Green Skills';
  $('evf-date').value = today();
  $('evf-att').value = '';
  $('evf-cap').value = '20';
  renderEvQuestions(null);
  $('modal-ev').classList.add('open');
}
function openEditEv(id) {
  const ev = DB.events.find(x => x.id === id); if (!ev) return;
  _editEvId = id;
  $('ev-modal-title').textContent = 'Edit event';
  $('evf-name').value = ev.name;
  $('evf-type').value = ev.type;
  $('evf-date').value = ev.date;
  $('evf-att').value  = ev.attendees;
  $('evf-cap').value  = ev.capacity;
  $('evf-loc').value  = ev.location;
  renderEvQuestions(ev.question_ids || null);
  $('modal-ev').classList.add('open');
}
async function saveEv() {
  const name = $('evf-name').value.trim();
  if (!name) { alert('Event name required'); return; }
  const btn = $('ev-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const d = {
      name, type: $('evf-type').value,
      event_date: $('evf-date').value,
      attendees: parseInt($('evf-att').value) || 0,
      capacity:  parseInt($('evf-cap').value) || 20,
      location:  $('evf-loc').value,
      question_ids: getEvQuestionIds()
    };
    const write = (payload) => _editEvId ? sbUpdate('events', payload, _editEvId) : sbInsert('events', payload);
    try { await write(d); }
    catch (e) {
      if (/question_ids/i.test(e.message || '')) { const d2 = Object.assign({}, d); delete d2.question_ids; await write(d2); alert('Saved, but the per-event question choice was not stored — run sql/import-v3.sql in Supabase.'); }
      else throw e;
    }
    await refreshTable('events');
    closeModal('modal-ev');
    renderEvents();
  } catch (e) { alert('Save failed: ' + e.message); }
  finally { btn.textContent = 'Save event'; btn.disabled = false; }
}
async function deleteEv(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('events', id);
  await refreshTable('events');
  renderEvents();
}

// ── Feedback ────────────────────────────────────────────────
// v3: the form asks the org's OWN questions (DB.survey_measures).
// Answers are stored word-for-word in feedback.answers; the fixed
// fields (enjoyed, cb, ca, learned, connected, friend, quote) are
// filled from whichever question maps to them. With no questions
// set up yet, the original fixed form is shown.
function makeStars(cid, key, val) {
  const c = $(cid); if (!c) return;
  c.innerHTML = [1, 2, 3, 4, 5].map(n =>
    '<div class="fb-star ' + (val >= n ? 'sel' : '') + '" onclick="setFbScore(\'' + key + '\',' + n + ',\'' + cid + '\')">' + n + '</div>'
  ).join('');
}
function setFbScore(key, val, cid) {
  _fbScores[key] = val;
  [].slice.call($(cid).children).forEach((s, i) => s.classList.toggle('sel', i + 1 <= val));
}

function _fbMeasures(eventId) {
  const M = (typeof activeMeasures === 'function') ? activeMeasures() : [];
  if (!eventId) return M;
  const ev = (DB.events || []).find(e => String(e.id) === String(eventId));
  if (!ev || !ev.question_ids) return M;
  const ids = ev.question_ids.map(String);
  const sub = M.filter(m => ids.includes(String(m.id)));
  return sub.length ? sub : M;
}
// Questions for the event chosen in the form.
function eventQuestionsFor(eventId) { return _fbMeasures(eventId); }

function openAddFb() {
  _editFbId = null;
  _fbScores = {};
  const M = _fbMeasures();
  const box = document.querySelector('#modal-fb .modal');
  if (!box) return;

  if (!M.length) {
    _fbScores = { enjoyed: 5, cb: 3, ca: 5 };
    box.innerHTML =
      '<h2 id="fb-modal-title">Add feedback</h2>' +
      '<div class="form-grid-2"><div class="form-row"><label>Event *</label><select id="fbf-ev"><option value="">Select event…</option></select></div><div class="form-row"><label>Participant name</label><input id="fbf-name"/></div></div>' +
      '<div class="form-row"><label>Enjoyment (1–5)</label><div style="display:flex;gap:5px;margin-top:4px" id="fbf-enjoyed-stars"></div></div>' +
      '<div class="form-grid-2"><div class="form-row"><label>Confidence before</label><div style="display:flex;gap:5px;margin-top:4px" id="fbf-cb-stars"></div></div><div class="form-row"><label>Confidence after</label><div style="display:flex;gap:5px;margin-top:4px" id="fbf-ca-stars"></div></div></div>' +
      '<div class="form-row"><label>Outcomes</label><div class="chk-group"><div class="chk-pill"><label><input type="checkbox" id="fbf-learned"/> Learned something new</label></div><div class="chk-pill"><label><input type="checkbox" id="fbf-connected"/> Felt more connected</label></div><div class="chk-pill"><label><input type="checkbox" id="fbf-friend"/> Made a new friend</label></div></div></div>' +
      '<div class="form-row"><label>Quote</label><textarea id="fbf-quote" style="min-height:55px"></textarea></div>' +
      '<div style="font-size:12px;color:var(--txt3);margin-top:4px">These are Vorlana\'s standard questions. Set your own under Settings → Feedback questions.</div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal(\'modal-fb\')">Cancel</button><button class="btn btn-p" id="fb-save-btn" onclick="saveFb()">Save</button></div>';
    populateFbEvSelect();
    makeStars('fbf-enjoyed-stars', 'enjoyed', 5);
    makeStars('fbf-cb-stars', 'cb', 3);
    makeStars('fbf-ca-stars', 'ca', 5);
    $('modal-fb').classList.add('open');
    return;
  }

  box.innerHTML =
    '<h2 id="fb-modal-title">Add feedback</h2>' +
    '<div class="form-grid-2"><div class="form-row"><label>Event *</label><select id="fbf-ev" onchange="renderFbQuestions()"><option value="">Select event…</option></select></div><div class="form-row"><label>Participant name (optional)</label><input id="fbf-name"/></div></div>' +
    '<div id="fbf-qs"></div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="closeModal(\'modal-fb\')">Cancel</button><button class="btn btn-p" id="fb-save-btn" onclick="saveFb()">Save</button></div>';
  populateFbEvSelect();
  renderFbQuestions();
  $('modal-fb').classList.add('open');
}

let _fbQs = [];
function renderFbQuestions() {
  const wrap = $('fbf-qs'); if (!wrap) return;
  const M = _fbMeasures($('fbf-ev') ? $('fbf-ev').value : '');
  _fbQs = M; _fbScores = {};
  wrap.innerHTML =
    M.map((m, i) => {
      const lbl = '<label title="' + escapeHTML(m.question) + '">' + escapeHTML(m.question) + '</label>';
      if (m.kind === 'score') return '<div class="form-row">' + lbl + '<div style="display:flex;gap:5px;margin-top:4px" id="fbq-' + i + '"></div></div>';
      if (m.kind === 'yesno') return '<div class="form-row">' + lbl + '<select id="fbq-' + i + '"><option value="">—</option><option>Yes</option><option>No</option></select></div>';
      if (m.kind === 'text')  return '<div class="form-row">' + lbl + '<textarea id="fbq-' + i + '" style="min-height:55px"></textarea></div>';
      return '<div class="form-row">' + lbl + '<input id="fbq-' + i + '"/></div>';
    }).join('');
  M.forEach((m, i) => { if (m.kind === 'score') makeStars('fbq-' + i, 'q' + i, 0); });
}

async function saveFb() {
  const evId = $('fbf-ev').value;
  if (!evId) { alert('Please select an event'); return; }
  const btn = $('fb-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const M = (typeof activeMeasures === 'function' && activeMeasures().length) ? _fbQs : [];
    let d;
    if (!M.length) {
      d = {
        event_id:  evId,
        name:      $('fbf-name').value,
        enjoyed:   _fbScores.enjoyed,
        cb:        _fbScores.cb,
        ca:        _fbScores.ca,
        learned:   $('fbf-learned').checked,
        connected: $('fbf-connected').checked,
        friend:    $('fbf-friend').checked,
        quote:     $('fbf-quote').value,
        answers:   {}
      };
    } else {
      const answers = {};
      const std = { enjoyed: null, cb: null, ca: null, learned: false, connected: false, friend: false, quote: '' };
      M.forEach((m, i) => {
        let v;
        if (m.kind === 'score') v = _fbScores['q' + i] || null;
        else { const el = $('fbq-' + i); v = el ? el.value.trim() : ''; }
        if (v == null || v === '') return;
        answers[m.question] = v;
        if (!m.maps_to) return;
        if (m.maps_to === 'quote') { if (!std.quote) std.quote = String(v); return; }
        if (m.maps_to === 'enjoyed' || m.maps_to === 'cb' || m.maps_to === 'ca') {
          let sc = scoreOf(v);
          if (sc == null) { const y = yesOf(v); if (y === true) sc = 5; else if (y === false) sc = 1; }
          if (sc != null) std[m.maps_to] = Math.min(5, Math.max(1, Math.round(sc)));
          return;
        }
        std[m.maps_to] = yesOf(v) === true;
      });
      d = Object.assign({ event_id: evId, name: $('fbf-name').value, answers }, std);
    }
    await sbInsert('feedback', d);
    await refreshTable('feedback');
    closeModal('modal-fb');
    renderFeedback();
  } catch (e) {
    alert('Save failed: ' + e.message + (/answers/i.test(e.message || '') ? '\n\nRun sql/import-v3.sql in Supabase to add the answers column.' : ''));
  }
  finally { btn.textContent = 'Save'; btn.disabled = false; }
}
async function deleteFb(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('feedback', id);
  await refreshTable('feedback');
  renderFeedback();
}

// ── Circular items ──────────────────────────────────────────
function openAddItem() {
  _editItemId = null;
  $('item-title').textContent = 'Log item';
  ['it-name', 'it-kg', 'it-fixer'].forEach(f => $(f).value = '');
  $('it-st').value = 'Collected';
  $('modal-item').classList.add('open');
}
function openEditItem(id) {
  const i = DB.circular.find(x => x.id === id); if (!i) return;
  _editItemId = id;
  $('item-title').textContent = 'Edit item';
  $('it-name').value    = i.name;
  $('it-cat').value     = i.category;
  $('it-kg').value      = i.weight_kg;
  $('it-st').value      = i.status;
  $('it-fixer').value   = i.fixer;
  $('it-outcome').value = i.outcome;
  $('modal-item').classList.add('open');
}
async function saveItem() {
  const btn = $('item-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const d = {
      name:      $('it-name').value,
      category:  $('it-cat').value,
      weight_kg: parseFloat($('it-kg').value) || 0,
      status:    $('it-st').value,
      fixer:     $('it-fixer').value,
      outcome:   $('it-outcome').value
    };
    if (_editItemId) await sbUpdate('circular_items', d, _editItemId);
    else await sbInsert('circular_items', d);
    await refreshTable('circular_items');
    closeModal('modal-item');
    renderCircular();
  } catch (e) { alert('Save failed: ' + e.message); }
  finally { btn.textContent = 'Save'; btn.disabled = false; }
}
async function deleteItem(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('circular_items', id);
  await refreshTable('circular_items');
  renderCircular();
}

// ── Funders ─────────────────────────────────────────────────
function openAddFunder() {
  _editFunderId = null;
  $('funder-modal-title').textContent = 'Add funder';
  ['ff-name', 'ff-contact', 'ff-email', 'ff-notes'].forEach(id => $(id).value = '');
  $('ff-type').value = 'moj';
  $('modal-funder').classList.add('open');
}
function openEditFunder(id) {
  const f = (DB.funders || []).find(x => String(x.id) === String(id)); if (!f) return;
  _editFunderId = id;
  $('funder-modal-title').textContent = 'Edit funder';
  $('ff-name').value    = f.name || '';
  $('ff-type').value    = f.type || 'other';
  $('ff-contact').value = f.contact_name || '';
  $('ff-email').value   = f.contact_email || '';
  $('ff-notes').value   = f.notes || '';
  $('modal-funder').classList.add('open');
}
async function saveFunder() {
  const name = $('ff-name').value.trim();
  if (!name) { alert('Funder name required'); return; }
  const btn = $('funder-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const d = {
      name, type: $('ff-type').value,
      contact_name:  $('ff-contact').value || null,
      contact_email: $('ff-email').value || null,
      notes:         $('ff-notes').value || null
    };
    if (_editFunderId) await sbUpdate('funders', d, _editFunderId);
    else await sbInsert('funders', d);
    await refreshTable('funders');
    closeModal('modal-funder');
    renderFunders();
  } catch (e) { alert('Save failed: ' + e.message); }
  finally { btn.textContent = 'Save funder'; btn.disabled = false; }
}
async function deleteFunder(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('funders', id);
  await refreshTable('funders');
  renderFunders();
}

// ── Contracts ───────────────────────────────────────────────
function populateConFunderSelect(preselect) {
  const sel = $('con-funder-id'); if (!sel) return;
  sel.innerHTML = '<option value="">— Select funder —</option>';
  (DB.funders || []).forEach(f => {
    const o = document.createElement('option');
    o.value = String(f.id); o.textContent = f.name;
    sel.appendChild(o);
  });
  if (preselect) sel.value = String(preselect);
}
function onConFunderChange() {
  const funderId = $('con-funder-id').value;
  const f = (DB.funders || []).find(x => String(x.id) === String(funderId));
  const lbl = $('con-linked-funder-label');
  if (f) {
    if (f.type) $('con-report-type').value = f.type;
    if (lbl) lbl.textContent = f.name;
  } else if (lbl) lbl.textContent = 'None selected';
}

function openAddCon(funderId) {
  _editConId = null;
  $('con-title').textContent = 'Add contract';
  ['con-name', 'con-val', 'con-ts', 'con-to'].forEach(f => $(f).value = '');
  $('con-start').value = '';
  $('con-end').value = '';
  $('con-status').value = 'live';
  $('con-report-type').value = 'other';
  populateConFunderSelect(funderId);
  const warnEl = $('con-no-funder-warn');
  if (warnEl) warnEl.style.display = DB.funders.length ? 'none' : 'flex';
  if (funderId) onConFunderChange();
  else { const lbl = $('con-linked-funder-label'); if (lbl) lbl.textContent = 'None selected'; }
  $('modal-con').classList.add('open');
}

function openEditCon(id) {
  const c = DB.contracts.find(x => String(x.id) === String(id)); if (!c) return;
  _editConId = id;
  $('con-title').textContent = 'Edit contract';
  $('con-name').value = c.name;
  $('con-val').value  = c.value;
  $('con-ts').value   = c.target_starts;
  $('con-to').value   = c.target_outcomes;
  $('con-start').value = c.start_date || '';
  $('con-end').value   = c.end_date || '';
  $('con-status').value = c.status || 'live';
  $('con-report-type').value = c.report_type || 'other';
  populateConFunderSelect(c.funder_id);
  if (c.funder_id) onConFunderChange();
  $('modal-con').classList.add('open');
}

async function saveCon() {
  const name = $('con-name').value.trim();
  if (!name) { alert('Contract name required'); return; }
  const funderId = $('con-funder-id').value;
  if (!funderId) { alert('Please select a funder.'); return; }
  const btn = $('con-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const funderObj = DB.funders.find(f => String(f.id) === String(funderId));
    const d = {
      name,
      funder: (funderObj && funderObj.name) || '',
      funder_id: String(funderId),
      report_type: $('con-report-type').value || 'other',
      value: parseInt($('con-val').value) || 0,
      target_starts:   parseInt($('con-ts').value) || 0,
      target_outcomes: parseInt($('con-to').value) || 0,
      start_date: $('con-start').value || null,
      end_date:   $('con-end').value || null,
      status:     $('con-status').value || 'live'
    };
    if (_editConId) await sbUpdate('contracts', d, _editConId);
    else await sbInsert('contracts', d);
    await refreshTable('contracts');
    closeModal('modal-con');
    renderFunding();
    renderFunders();
  } catch (e) { alert('Save failed: ' + e.message); }
  finally { btn.textContent = 'Save'; btn.disabled = false; }
}

async function deleteCon(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('contracts', id);
  await refreshTable('contracts');
  renderFunding();
  renderFunders();
}

// ── Evidence ────────────────────────────────────────────────
function openAddEvid() {
  ['evid-p', 'evid-staff'].forEach(f => $(f).value = '');
  $('evid-date').value = today();
  $('modal-evid').classList.add('open');
}
async function saveEvid() {
  const btn = $('evid-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    await sbInsert('evidence', {
      participant_name: $('evid-p').value,
      type: $('evid-type').value,
      linked_outcome: $('evid-out').value,
      staff: $('evid-staff').value,
      evidence_date: $('evid-date').value,
      status: 'Pending'
    });
    await refreshTable('evidence');
    closeModal('modal-evid');
    renderEvidence();
  } catch (e) { alert('Save failed: ' + e.message); }
  finally { btn.textContent = 'Save'; btn.disabled = false; }
}
async function deleteEvid(id) {
  if (!confirm('Delete?')) return;
  await sbDelete('evidence', id);
  await refreshTable('evidence');
  renderEvidence();
}

// ── Equality data modal ─────────────────────────────────────
function openEqualityModal(pid) {
  const p = DB.participants.find(x => x.id === pid); if (!p) return;
  _editEqPId = pid;
  // Expose for extensions/demographics.js (which patches saveEqualityData)
  window._editEqPId = pid;
  $('eq-modal-title').textContent = 'Equality monitoring — ' + p.first_name + ' ' + p.last_name;
  const ed = p.equality_data || {};
  ['eq-age', 'eq-ethnicity', 'eq-gender', 'eq-disability'].forEach(id => {
    const key = id.replace('eq-', '');
    if ($(id)) $(id).value = ed[key] || '';
  });
  $('modal-eq').classList.add('open');
}

async function saveEqualityData() {
  if (!_editEqPId) return;
  const btn = $('eq-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const data = {
      age:        $('eq-age').value,
      ethnicity:  $('eq-ethnicity').value,
      gender:     $('eq-gender').value,
      disability: $('eq-disability').value
    };
    Object.keys(data).forEach(k => { if (!data[k]) delete data[k]; });
    if (sb) try { await sbUpdate('participants', { equality_data: data }, _editEqPId); } catch (e) { /* ignore */ }
    const idx = DB.participants.findIndex(x => x.id === _editEqPId);
    if (idx >= 0) DB.participants[idx].equality_data = data;
    closeModal('modal-eq');
    renderEqMonitoringList();
  } catch (e) {
    alert('Save failed: ' + e.message);
  } finally {
    btn.textContent = 'Save'; btn.disabled = false;
  }
}
