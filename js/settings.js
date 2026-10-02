// js/settings.js — Settings page (v2) and everything it edits
// ─────────────────────────────────────────────────────────────
// Split out of render.js. Sections: Organisation · What you do ·
// Look and feel · Feedback questions · Circular activities · Team ·
// Demo mode. Everything autosaves.
// Also holds vAI() (shared AI helper) and the circular activity
// templates / builder (CIRC_*, circMode) used by js/circular.js.
// Depends on: utils.js, db.js, branding.js, render.js (MEASURE_*,
//   renderFeedback, renderImpact, statCard)
'use strict';

// ─────────────────────────────────────────────────────────────
// FEEDBACK QUESTIONS — Settings card
// ─────────────────────────────────────────────────────────────

let _fqRows = null;   // working copy while editing
let _fqOpen = -1;     // which question is expanded
let _fqSugg = null;   // AI suggestions waiting to be added
let _fqDrag = -1;
let _fqTimer = null, _fqSaving = false, _fqAgain = false;

function fqKindLabel(k) { const f = MEASURE_KINDS.find(x => x[0] === (k || 'text')); return f ? f[1] : k; }
function fqMapLabel(k) { const f = MEASURE_MAPS.find(x => x[0] === (k || '')); return f ? f[1] : ''; }

function renderFeedbackQuestionsCard() {
  const body = $('st-body');
  if (!body || _setSection !== 'feedback') return;
  if (!_fqRows) _fqRows = (DB.survey_measures || []).filter(m => !m._demo).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(m => Object.assign({}, m));
  const e = escapeHTML;

  let h = '<div class="st-actions">' +
    '<button class="btn btn-ghost btn-sm" onclick="fqSuggest()" id="fq-sugg-btn">✨ Suggest questions</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="fqCopyOpen()">📋 Copy from a form</button>' +
    '<button class="btn btn-ghost btn-sm" onclick="fqAdd()">+ Add question</button>' +
    (_fqRows.length ? '<button class="btn btn-ghost btn-sm" onclick="fqPreview()">📱 Preview form</button>' : '') +
  '</div>';

  if (_fqSugg && _fqSugg.length) {
    h += '<div class="st-sugg"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
      '<b style="font-size:13px">✨ Suggested</b><div style="display:flex;gap:6px"><button class="btn btn-p btn-sm" onclick="fqAddSugg(-1)">Add all</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="_fqSugg=null;renderFeedbackQuestionsCard()">Dismiss</button></div></div>' +
      _fqSugg.map((s, i) => '<div class="st-sugg-row"><div><div class="st-q-t">' + e(s.question) + '</div><div class="st-q-m">' + e(fqKindLabel(s.kind)) +
        (s.maps_to ? ' · ' + e(fqMapLabel(s.maps_to)) : '') + (s.why ? ' · ' + e(s.why) : '') + '</div></div>' +
        '<button class="btn btn-ghost btn-sm" onclick="fqAddSugg(' + i + ')">+ Add</button></div>').join('') + '</div>';
  }

  if (!_fqRows.length) {
    h += '<div style="font-size:13px;color:var(--txt2);padding:14px;background:var(--bg);border-radius:10px;margin-bottom:8px">No questions yet. ' +
      '<a href="#" onclick="fqUseDefaults();return false">Use Vorlana\'s standard set</a>, or let ✨ suggest some for you.</div>';
  }

  h += _fqRows.map((m, i) => {
    const on = m.active !== false;
    const meta = fqKindLabel(m.kind) + (m.kind === 'choice' ? ((m.options || []).length ? ': ' + m.options.slice(0, 3).join(', ') + (m.options.length > 3 ? ' +' + (m.options.length - 3) : '') : ' — ⚠ add the choices') : '') + (m.maps_to ? ' · ' + fqMapLabel(m.maps_to) : '');
    return '<div class="st-q ' + (on ? '' : 'off') + '" draggable="true" data-i="' + i + '">' +
      '<div class="st-q-row" onclick="fqToggleOpen(' + i + ')"><span class="grip" title="Drag to reorder">⋮⋮</span>' +
        '<div style="flex:1;min-width:0"><div class="st-q-t">' + (m.question ? e(m.question) : '<em>New question</em>') + '</div><div class="st-q-m">' + e(meta) + '</div></div>' +
        '<span class="st-pill ' + (on ? 'on' : 'off') + '" onclick="event.stopPropagation();fqSet(' + i + ',\'active\',' + !on + ')">' + (on ? 'On' : 'Off') + '</span></div>' +
      (_fqOpen === i ?
        '<div class="st-q-edit">' +
          '<div class="form-row"><label>Question</label><input id="fq-q-' + i + '" value="' + e(m.question || '') + '" placeholder="As people will read it" onchange="fqSet(' + i + ',\'question\',this.value)"/>' +
          (m.id ? '<div style="font-size:11px;color:var(--txt3);margin-top:4px">Changing the wording starts a new question in reports.</div>' : '') + '</div>' +
          (m.kind === 'choice' ? '<div class="form-row"><label>The choices people can pick</label>' +
            '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">' + ((m.options || []).length ? choicePills(m.options, 'fqRemoveOpt.bind(null,' + i + ')') : '<span style="font-size:12px;color:var(--txt3)">No choices yet — type one below and press Enter.</span>') + '</div>' +
            '<div style="display:flex;gap:6px"><input id="fq-opt-' + i + '" placeholder="Type a choice, then press Enter" onkeydown="if(event.key===\'Enter\'){event.preventDefault();fqAddOpt(' + i + ')}" style="flex:1"/>' +
              '<button type="button" class="btn btn-ghost btn-sm" onclick="fqAddOpt(' + i + ')">+ Add choice</button></div>' +
            '<div style="font-size:11px;color:var(--txt3);margin-top:4px">People tap one. Your reports count how many chose each.</div></div>' : '') +
          '<div class="form-grid-2">' +
            '<div class="form-row"><label>Answer type</label><select onchange="fqSet(' + i + ',\'kind\',this.value)">' + MEASURE_KINDS.map(k => '<option value="' + k[0] + '"' + ((m.kind || 'text') === k[0] ? ' selected' : '') + '>' + k[1] + '</option>').join('') + '</select></div>' +
            '<div class="form-row"><label>Counts in reports as</label><select onchange="fqSet(' + i + ',\'maps_to\',this.value||null)">' + MEASURE_MAPS.map(k => '<option value="' + k[0] + '"' + ((m.maps_to || '') === k[0] ? ' selected' : '') + '>' + k[1] + '</option>').join('') + '</select></div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;justify-content:space-between"><div style="display:flex;gap:6px">' +
            '<button class="btn btn-ghost btn-sm" onclick="fqMove(' + i + ',-1)" title="Move up">↑</button><button class="btn btn-ghost btn-sm" onclick="fqMove(' + i + ',1)" title="Move down">↓</button></div>' +
            '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="fqDel(' + i + ')">Remove</button></div>' +
        '</div>' : '') +
    '</div>';
  }).join('');

  body.innerHTML = h;

  // Drag to reorder
  body.querySelectorAll('.st-q[draggable]').forEach(el => {
    const i = +el.getAttribute('data-i');
    el.addEventListener('dragstart', ev => { _fqDrag = i; ev.dataTransfer.effectAllowed = 'move'; });
    el.addEventListener('dragover', ev => { ev.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', ev => {
      ev.preventDefault(); el.classList.remove('drag-over');
      if (_fqDrag < 0 || _fqDrag === i) return;
      const [row] = _fqRows.splice(_fqDrag, 1); _fqRows.splice(i, 0, row);
      _fqOpen = -1; _fqDrag = -1;
      renderFeedbackQuestionsCard(); fqQueueSave();
    });
  });
  if (_fqOpen >= 0 && _fqRows[_fqOpen] && !_fqRows[_fqOpen].question) { const q = $('fq-q-' + _fqOpen); if (q) q.focus(); }
}

function fqToggleOpen(i) { _fqOpen = _fqOpen === i ? -1 : i; renderFeedbackQuestionsCard(); }
function fqSet(i, f, v) {
  const r = _fqRows[i]; if (!r) return;
  r[f] = f === 'question' ? String(v || '').trim() : v;
  renderFeedbackQuestionsCard(); fqQueueSave();
}
// choices are added one at a time: type, Enter, type, Enter
function fqAddOpt(i) {
  const r = _fqRows[i]; const inp = $('fq-opt-' + i); if (!r || !inp) return;
  const add = parseChoiceOptions(inp.value); if (!add.length) return;
  r.options = (r.options || []).slice();
  add.forEach(o => { if (!r.options.some(x => x.toLowerCase() === o.toLowerCase()) && r.options.length < 12) r.options.push(o); });
  renderFeedbackQuestionsCard(); fqQueueSave();
  const again = $('fq-opt-' + i); if (again) again.focus();
}
function fqRemoveOpt(i, j) {
  const r = _fqRows[i]; if (!r || !r.options) return;
  r.options = r.options.filter((_, k) => k !== j);
  renderFeedbackQuestionsCard(); fqQueueSave();
  const again = $('fq-opt-' + i); if (again) again.focus();
}
function fqMove(i, d) {
  const j = i + d; if (j < 0 || j >= _fqRows.length) return;
  [_fqRows[i], _fqRows[j]] = [_fqRows[j], _fqRows[i]]; _fqOpen = j;
  renderFeedbackQuestionsCard(); fqQueueSave();
}
function fqDel(i) {
  if (!confirm('Remove this question? Past answers stay in your data.')) return;
  _fqRows.splice(i, 1); _fqOpen = -1;
  renderFeedbackQuestionsCard(); fqQueueSave();
}
function fqAdd() { _fqRows.push({ question: '', kind: 'score', maps_to: null, active: true }); _fqOpen = _fqRows.length - 1; renderFeedbackQuestionsCard(); }
function fqUseDefaults() { _fqRows = DEFAULT_MEASURES.map((m, i) => Object.assign({ active: true, sort: i }, m)); renderFeedbackQuestionsCard(); fqQueueSave(); }

function fqQueueSave() {
  setStatus('Saving…');
  clearTimeout(_fqTimer);
  _fqTimer = setTimeout(fqSave, 700);
}
async function fqSave() {
  if (_fqSaving) { _fqAgain = true; return; }
  _fqSaving = true;
  try {
    const saved = (DB.survey_measures || []).filter(m => !m._demo);
    const rows = _fqRows.filter(r => r.question && r.question.trim()).map((r, i) => {
      const o = { org_id: orgId, question: r.question.trim(), kind: r.kind || 'text', maps_to: r.maps_to || null, label: r.question.trim().slice(0, 60), active: r.active !== false, sort: i };
      if (o.kind === 'choice') o.options = (r.options || []).slice(0, 12);      // only written for choice questions
      const orig = r.id && saved.find(m => m.id === r.id);
      if (orig && orig.question === o.question) o.id = r.id;   // reworded = new question
      return o;
    });
    const keepIds = rows.filter(r => r.id).map(r => r.id);
    const gone = saved.filter(m => !keepIds.includes(m.id) && !rows.some(r => r.question === m.question)).map(m => m.id);
    if (gone.length) { const d = await sb.from('survey_measures').delete().in('id', gone); if (d.error) throw d.error; }
    if (rows.length) { const r = await sb.from('survey_measures').upsert(rows, { onConflict: 'org_id,question' }); if (r.error) throw r.error; }
    await refreshTable('survey_measures');
    // Pick up new ids without disturbing the editor
    (DB.survey_measures || []).filter(m => !m._demo).forEach(m => { const w = _fqRows.find(r => r.question === m.question); if (w) w.id = m.id; });
    setStatus('✓ Saved');
    try { renderFeedback(); renderImpact(); } catch (e) { /* pages may not be open */ }
  } catch (e) {
    setStatus('Not saved: ' + (e.message || e) + (/survey_measures|active|sort/i.test(e.message || '') ? ' — run sql/import-v3.sql in Supabase' : ''), true);
  } finally {
    _fqSaving = false;
    if (_fqAgain) { _fqAgain = false; fqSave(); }
  }
}

// ✨ Suggest questions
function fqAIRules() {
  return 'Allowed kind values: ' + MEASURE_KINDS.filter(k => k[0] !== 'ignore').map(k => k[0] + ' (' + k[1] + ')').join(', ') +
    '. Allowed maps_to values: ' + MEASURE_MAPS.filter(k => k[0]).map(k => k[0] + ' (' + k[1] + ')').join(', ') + ', or "" for the organisation\'s own measure.' +
    ' Return JSON only: {"questions":[{"question":"","kind":"","maps_to":"","why":"max 6 words"}]}';
}
function fqClean(list) {
  const have = new Set(_fqRows.map(r => (r.question || '').toLowerCase().trim()));
  return (list || []).filter(q => q && q.question && !have.has(q.question.toLowerCase().trim())).map(q => ({
    question: String(q.question).trim(),
    kind: MEASURE_KINDS.some(k => k[0] === q.kind) ? q.kind : 'text',
    maps_to: MEASURE_MAPS.some(k => k[0] === q.maps_to) && q.maps_to ? q.maps_to : null,
    why: q.why || ''
  }));
}
async function fqSuggest() {
  const btn = $('fq-sugg-btn'); if (btn) { btn.disabled = true; btn.textContent = '✨ Thinking…'; }
  try {
    const mods = (typeof SET_MODULES !== 'undefined' ? SET_MODULES : []).filter(m => _modState[m.k]).map(m => m.n).join(', ');
    const acts = (typeof CIRC !== 'undefined' && CIRC.length ? CIRC.map(a => a.name).join(', ') : '');
    const j = await vAI(
      'You design short, respectful feedback forms for UK charities and community groups. Plain English, under 12 words per question, no jargon. Suggest 5 to 7 questions that funders value: wellbeing, confidence, skills, connection, plus one open question for quotes. Never duplicate existing questions.',
      'Organisation: ' + (currentOrg.name || '') + ' (' + (currentOrg.sector || '') + ').\nWhat they do: ' + mods + (acts ? '\nCircular activities: ' + acts : '') +
      '\nExisting questions: ' + (_fqRows.map(r => r.question).filter(Boolean).join(' | ') || 'none') + '\n' + fqAIRules(), 900);
    _fqSugg = fqClean(j.questions);
    if (!_fqSugg.length) setStatus('No new suggestions — your set already covers it');
  } catch (e) { setStatus('Could not suggest: ' + e.message, true); }
  renderFeedbackQuestionsCard();
}
function fqAddSugg(i) {
  const add = i < 0 ? _fqSugg : [_fqSugg[i]];
  add.forEach(s => _fqRows.push({ question: s.question, kind: s.kind, maps_to: s.maps_to, active: true }));
  _fqSugg = i < 0 ? null : _fqSugg.filter((_, x) => x !== i);
  if (_fqSugg && !_fqSugg.length) _fqSugg = null;
  renderFeedbackQuestionsCard(); fqQueueSave();
}

// 📋 Copy from a form
function fqCopyOpen() {
  setModal('<h2>Copy questions from a form</h2>' +
    '<div style="font-size:13px;color:var(--txt3);margin-bottom:12px;line-height:1.5">Paste the questions from your paper form, Google Form or SurveyMonkey, or upload a CSV export. ✨ picks out the questions and answer types.</div>' +
    '<div class="form-row"><label>Paste here</label><textarea id="fq-paste" style="min-height:160px" placeholder="1. How much did you enjoy today? (1-5)&#10;2. Did you learn something new? Yes / No&#10;…"></textarea></div>' +
    '<div class="form-row"><label>Or upload a CSV / text export</label><input type="file" id="fq-file" accept=".csv,.txt,text/csv,text/plain"/></div>' +
    '<div id="fq-copy-msg" style="font-size:12px;color:var(--txt3)"></div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="setCloseModal()">Cancel</button><button class="btn btn-p" id="fq-copy-btn" onclick="fqCopyRun()">Find questions</button></div>');
}
async function fqCopyRun() {
  const btn = $('fq-copy-btn'), msg = $('fq-copy-msg');
  let text = $('fq-paste').value.trim();
  const f = $('fq-file').files && $('fq-file').files[0];
  if (f) {
    const raw = await f.text();
    // CSV export: the questions are the column headers
    text += '\n' + (/\.csv$/i.test(f.name) ? raw.split(/\r?\n/)[0] : raw.slice(0, 8000));
  }
  if (!text.trim()) { msg.textContent = 'Paste some questions or choose a file.'; return; }
  btn.disabled = true; btn.textContent = 'Reading…';
  try {
    const j = await vAI('You extract feedback questions from a pasted form or survey export for a UK charity. Ignore names, emails, dates, timestamps and consent tick boxes. Keep the wording as written, tidied only for spelling.',
      'Form content:\n' + text.slice(0, 12000) + '\n' + fqAIRules(), 1500);
    _fqSugg = fqClean(j.questions);
    setCloseModal();
    if (!_fqSugg.length) setStatus('No new questions found');
    renderFeedbackQuestionsCard();
  } catch (e) { msg.textContent = 'Could not read it: ' + e.message; btn.disabled = false; btn.textContent = 'Find questions'; }
}

// 📱 Preview
function fqPreview() {
  const qs = _fqRows.filter(r => r.active !== false && r.question && r.kind !== 'ignore');
  const logo = typeof getOrgLogoUrl === 'function' ? getOrgLogoUrl(currentOrg) : '';
  const ans = (k, opts) => k === 'score' ? '<div class="st-dots">' + [1, 2, 3, 4, 5].map(n => '<span>' + n + '</span>').join('') + '</div>'
    : k === 'yesno' ? '<div class="st-dots"><span style="width:auto;padding:0 16px;border-radius:17px">Yes</span><span style="width:auto;padding:0 16px;border-radius:17px">No</span></div>'
    : k === 'choice' ? '<div style="font-size:12px;color:#777;line-height:1.9">' + ((opts && opts.length) ? opts : ['Option A', 'Option B']).map(x => '○ ' + escapeHTML(x)).join('<br>') + '</div>'
    : '<div style="border:1px solid #ddd;border-radius:8px;height:56px"></div>';
  setModal('<h2>How the form looks on a phone</h2><div class="st-phone">' +
    (logo ? '<div style="text-align:center;margin-bottom:10px"><img src="' + escapeHTML(logo) + '" style="max-height:34px;max-width:140px"/></div>' : '') +
    '<div style="font-size:15px;font-weight:700;text-align:center;margin-bottom:16px;color:#222">How was today?</div>' +
    qs.map(q => '<div class="st-phone-q"><p>' + escapeHTML(q.question) + '</p>' + ans(q.kind, q.options) + '</div>').join('') +
    '<div style="background:' + escapeHTML(currentOrg.brand_color || '#1F6F6D') + ';color:#fff;text-align:center;padding:11px;border-radius:10px;font-weight:700;font-size:14px">Send</div></div>' +
    '<div class="modal-footer"><button class="btn btn-p" onclick="setCloseModal()">Done</button></div>', 380);
}


// ─────────────────────────────────────────────────────────────
// SETTINGS v2 — one section at a time, autosave everywhere
// Sections: Organisation · What you do · Look and feel ·
// Feedback questions · Circular activities · Team · Demo mode
// ─────────────────────────────────────────────────────────────

const _modState = {};
let _setSection = 'org';
const SET_SECTIONS = [
  ['org', '🏢', 'Organisation'],
  ['modules', '🧩', 'What you do'],
  ['look', '🎨', 'Look and feel'],
  ['feedback', '💬', 'Feedback questions'],
  ['circular', '♻️', 'Circular activities'],
  ['team', '👥', 'Team'],
  ['demo', '🎭', 'Demo mode']
];
const SET_MOD_GROUPS = [
  ['People', ['participants', 'volunteers', 'contacts', 'employers']],
  ['Delivery', ['events', 'circular', 'evidence']],
  ['Reporting', ['impact', 'funders', 'demographics']],
  ['Growth', ['social', 'bd']]
];

function setInjectStyle() {
  if (document.getElementById('st-style')) return;
  const st = document.createElement('style'); st.id = 'st-style';
  st.textContent = `
.st-wrap{display:grid;grid-template-columns:210px minmax(0,1fr);gap:18px;align-items:start}
.st-nav{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:8px;position:sticky;top:12px}
.st-nav button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:none;border:none;border-radius:8px;padding:9px 10px;font-size:13px;color:var(--txt2);cursor:pointer}
.st-nav button:hover{background:var(--bg)}
.st-nav button.on{background:var(--bg);color:var(--txt);font-weight:700}
.st-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:4px}
.st-h{font-size:18px;font-weight:700;color:var(--txt)}
.st-sub{font-size:13px;color:var(--txt3);line-height:1.5;margin-bottom:18px}
.st-status{font-size:12px;font-weight:700;color:var(--em);white-space:nowrap;min-height:16px}
.st-group{font-size:11px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin:18px 0 8px}
.st-group:first-child{margin-top:0}
.st-mods{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
.st-mod{display:flex;align-items:center;gap:12px;padding:12px 14px;border:1px solid var(--border);border-radius:10px;background:var(--surface);cursor:pointer}
.st-mod.on{border-color:rgba(31,111,109,.35);background:rgba(31,111,109,.04)}
.st-mod-n{font-size:13px;font-weight:600;color:var(--txt)}
.st-mod-d{font-size:11px;color:var(--txt3);margin-top:2px}
.st-sw{position:relative;width:40px;height:22px;border-radius:11px;background:#E0DAD0;flex-shrink:0;transition:background .2s}
.st-sw:after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:left .2s}
.st-sw.on{background:var(--em)}
.st-sw.on:after{left:21px}
.st-actions{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}
.st-q{border:1px solid var(--border);border-radius:10px;background:var(--surface);margin-bottom:6px}
.st-q-row{display:flex;align-items:center;gap:10px;padding:10px 12px;cursor:pointer}
.st-q-row .grip{color:var(--txt3);cursor:grab;font-size:15px;user-select:none}
.st-q-t{font-size:13px;color:var(--txt);font-weight:600}
.st-q-m{font-size:11px;color:var(--txt3);margin-top:2px}
.st-q.off .st-q-t{color:var(--txt3);font-weight:400}
.st-q.drag-over{border-color:var(--em);box-shadow:0 0 0 2px rgba(31,111,109,.15)}
.st-q-edit{padding:4px 12px 12px;border-top:1px solid var(--border)}
.st-pill{font-size:11px;padding:2px 9px;border-radius:10px;font-weight:600;white-space:nowrap}
.st-pill.on{background:rgba(31,111,109,.1);color:var(--em)}
.st-pill.off{background:var(--bg);color:var(--txt3);border:1px solid var(--border)}
.st-sugg{border:1px dashed var(--em);border-radius:10px;padding:12px;margin-bottom:14px;background:rgba(31,111,109,.03)}
.st-sugg-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)}
.st-sugg-row:last-child{border-bottom:none}
.st-phone{width:300px;margin:0 auto;border:8px solid #222;border-radius:28px;background:#fff;padding:18px 14px;max-height:540px;overflow-y:auto}
.st-phone-q{margin-bottom:16px}
.st-phone-q p{font-size:13px;font-weight:600;margin:0 0 8px;color:#222}
.st-dots{display:flex;gap:6px}.st-dots span{width:34px;height:34px;border-radius:50%;border:1.5px solid #ccc;display:flex;align-items:center;justify-content:center;font-size:13px;color:#555}
.st-brand{display:grid;grid-template-columns:1fr 1fr;gap:18px}
.st-prev{border:1px solid var(--border);border-radius:10px;overflow:hidden;margin-top:16px}
.st-prev-bar{height:40px;display:flex;align-items:center;padding:0 12px;color:#fff;font-size:12px;font-weight:700;gap:10px}
.st-prev-body{display:grid;grid-template-columns:90px 1fr;height:90px;background:var(--bg)}
.st-prev-side{background:var(--surface);border-right:1px solid var(--border);display:flex;align-items:flex-start;justify-content:center;padding-top:10px}
/* circular */
.st-circ{display:grid;grid-template-columns:230px minmax(0,1fr);gap:14px;align-items:start}
.st-tile{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--surface);cursor:pointer;margin-bottom:8px}
.st-tile.on{border:2px solid var(--em);padding:9px 11px}
.st-tile-i{font-size:20px}
.st-tile-n{font-size:13px;font-weight:700;color:var(--txt)}
.st-tile-d{font-size:11px;color:var(--txt3)}
.st-add{display:flex;align-items:center;justify-content:center;gap:6px;padding:10px;border:1px dashed var(--border);border-radius:10px;font-size:13px;color:var(--txt2);cursor:pointer;background:none;width:100%}
.st-panel{border:1px solid var(--border);border-radius:10px;background:var(--surface);padding:14px}
.st-seg{display:flex;gap:3px;background:var(--bg);border-radius:8px;padding:3px;margin:10px 0 16px}
.st-seg button{flex:1;border:none;background:none;border-radius:6px;padding:7px 4px;font-size:12px;color:var(--txt2);cursor:pointer}
.st-seg button.on{background:var(--surface);color:var(--txt);font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.st-lbl{font-size:12px;color:var(--txt3);margin:0 0 6px}
.st-mode{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:16px}
.st-mode div{padding:10px 12px;border:1px solid var(--border);border-radius:10px;cursor:pointer}
.st-mode div.on{border:2px solid var(--em);padding:9px 11px}
.st-mode b{display:block;font-size:13px;color:var(--txt)}
.st-mode span{font-size:11px;color:var(--txt3)}
.st-chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.st-chip{font-size:12px;padding:5px 11px;border-radius:14px;border:1px solid var(--border);background:var(--surface);color:var(--txt);cursor:pointer}
.st-chip.fill{background:rgba(31,111,109,.08);border-color:rgba(31,111,109,.25);color:var(--em)}
.st-chip.sel{box-shadow:0 0 0 2px var(--em)}
.st-chip.new{border-style:dashed;color:var(--txt2)}
.st-chip small{opacity:.7;margin-left:4px}
.st-edit{background:var(--bg);border-radius:10px;padding:10px 12px;margin:-4px 0 14px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.st-edit input,.st-edit select{padding:6px 9px;font-size:13px;width:auto;flex:1;min-width:120px}
.st-fig{width:100%;border-collapse:collapse;font-size:12px}
.st-fig th{text-align:left;color:var(--txt3);font-weight:600;padding:4px 6px}
.st-fig td{padding:3px 6px}
.st-fig input{padding:5px 7px;font-size:12px}
.st-tpls{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:8px}
.st-tpl{padding:10px 12px;border:1px solid var(--border);border-radius:10px;cursor:pointer}
.st-tpl.on{border:2px solid var(--em);padding:9px 11px;background:rgba(31,111,109,.04)}
.st-tpl.had{opacity:.5;cursor:default}
.st-tpl b{font-size:13px;display:block}
.st-tpl span{font-size:11px;color:var(--txt3);line-height:1.4}
.st-back{display:none}
@media(max-width:760px){
  .st-wrap{grid-template-columns:1fr}
  .st-nav{display:flex;overflow-x:auto;position:static;padding:6px;gap:4px}
  .st-nav button{white-space:nowrap;width:auto}
  .st-brand{grid-template-columns:1fr}
  .st-circ{grid-template-columns:1fr}
  .st-circ.open .st-tiles{display:none}
  .st-circ:not(.open) .st-panel{display:none}
  .st-back{display:inline-block}
}`;
  document.head.appendChild(st);
}

function setStatus(t, err) {
  const el = $('st-status'); if (!el) return;
  el.textContent = t || ''; el.style.color = err ? 'var(--red)' : 'var(--em)';
  if (t && !err && /Saved/.test(t)) setTimeout(() => { if (el.textContent === t) el.textContent = ''; }, 2500);
}

function setModal(html, maxW) {
  let m = $('st-modal');
  if (!m) {
    m = document.createElement('div'); m.className = 'modal-overlay'; m.id = 'st-modal';
    m.addEventListener('click', e => { if (e.target === m) setCloseModal(); });
    document.body.appendChild(m);
  }
  m.innerHTML = '<div class="modal" style="max-width:' + (maxW || 560) + 'px">' + html + '</div>';
  m.classList.add('open');
}
function setCloseModal() { const m = $('st-modal'); if (m) m.classList.remove('open'); }

// Shared AI helper: returns parsed JSON from Claude
// A sign-in token that is definitely current (refreshes it if it has expired or is about to)
async function vToken(force) {
  let { data: { session } } = await sb.auth.getSession();
  if (force || !session || (session.expires_at && session.expires_at * 1000 - Date.now() < 60000)) {
    try { const r = await sb.auth.refreshSession(); if (r && r.data && r.data.session) session = r.data.session; } catch (e) { /* fall through */ }
  }
  return session ? session.access_token : '';
}

async function vAI(system, content, maxTokens) {
  const send = async force => fetch('/api/claude', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (await vToken(force)) },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: maxTokens || 800, system, messages: [{ role: 'user', content }] })
  });
  let res = await send(false);
  if (res.status === 401) res = await send(true);     // token had gone stale: refresh once and retry
  if (res.status === 401) throw new Error('Your sign-in has expired — refresh the page (you will stay signed in) and try again');
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.type === 'error') throw new Error((data.error && (data.error.message || data.error)) || 'AI is not available on this plan');
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.search(/[\[{]/);
  return JSON.parse(start > 0 ? clean.slice(start) : clean);
}

function renderSettings() {
  if (!currentOrg) return;
  setInjectStyle();
  const m = currentOrg.modules || {};
  if (typeof SET_MODULES !== 'undefined') SET_MODULES.forEach(mod => { _modState[mod.k] = m[mod.k] != null ? m[mod.k] : true; });
  const page = $('page-settings'); if (!page) return;
  const mgr = typeof isAdviserRole === 'function' ? !isAdviserRole() : true;
  const secs = SET_SECTIONS.filter(s => (s[0] !== 'circular' || _modState.circular !== false) && (s[0] !== 'access' || mgr));
  if (!secs.some(s => s[0] === _setSection)) _setSection = 'org';
  page.innerHTML =
    '<div class="page-header"><div><div class="page-title">Settings</div><div class="page-sub">Changes save automatically</div></div></div>' +
    '<div class="st-wrap"><nav class="st-nav" id="st-nav">' +
      secs.map(s => '<button data-sec="' + s[0] + '" onclick="setOpen(\'' + s[0] + '\')"><span>' + s[1] + '</span><span>' + s[2] + '</span></button>').join('') +
    '</nav><div class="card" style="margin:0" id="st-main"></div></div>';
  setOpen(_setSection);
}

function setOpen(sec) {
  _setSection = sec;
  document.querySelectorAll('#st-nav button').forEach(b => b.classList.toggle('on', b.getAttribute('data-sec') === sec));
  const s = SET_SECTIONS.find(x => x[0] === sec);
  const subs = {
    org: 'Your details. Used on reports, forms and legal pages.',
    modules: 'Switch on what you do. Only these show in the menu.',
    look: 'Your logo and colour appear in the menu, banner, forms and reports.',
    feedback: 'What people are asked after a session. Used on QR forms, imports and reports.',
    circular: 'The circular activities you run and how you record them.',
    team: 'Invite staff and set what they can see.',
    access: 'Choose which pages advisers can open. Managers and admins always see everything.',
    demo: 'Explore every feature with sample data.'
  };
  $('st-main').innerHTML =
    '<div class="st-head"><div class="st-h">' + s[1] + ' ' + s[2] + '</div><div class="st-status" id="st-status"></div></div>' +
    '<div class="st-sub">' + subs[sec] + '</div><div id="st-body"></div>';
  const body = $('st-body');
  if (sec === 'org') setOrgHTML(body);
  if (sec === 'modules') setModulesHTML(body);
  if (sec === 'look') setLookHTML(body);
  if (sec === 'feedback') { _fqRows = null; renderFeedbackQuestionsCard(); }
  if (sec === 'circular') renderCircularSettingsCard();
  if (sec === 'team') body.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:14px;flex-wrap:wrap"><div style="font-size:13px;color:var(--txt2);line-height:1.6">Invite advisors and admin staff, manage roles, choose which pages each person can open, and remove team members.</div><a href="team.html" class="btn btn-p" style="text-decoration:none;white-space:nowrap">👥 Manage team →</a></div>';
  if (sec === 'demo') setDemoHTML(body);
  if (sec === 'access') setAccessHTML(body);
}

// ── Organisation ─────────────────────────────────────────────
function setOrgHTML(body) {
  const sectors = ['Charity / VCSE', 'Social enterprise', 'Local authority', 'Housing association', 'Education', 'Health', 'Community group', 'Other'];
  const cur = currentOrg.sector || 'Charity / VCSE';
  if (!sectors.includes(cur)) sectors.push(cur);
  const plan = currentOrg.plan === 'pro' ? 'Pro ✦' : currentOrg.plan === 'network' ? 'Network' : currentOrg.plan === 'starter' ? 'Starter' : 'Free';
  body.innerHTML =
    '<div class="form-grid-2">' +
      '<div class="form-row"><label>Organisation name</label><input id="set-name" value="' + escapeHTML(currentOrg.name || '') + '" onchange="setSaveOrg()"/></div>' +
      '<div class="form-row"><label>Sector</label><select id="set-sector" onchange="setSaveOrg()">' + sectors.map(x => '<option' + (x === cur ? ' selected' : '') + '>' + escapeHTML(x) + '</option>').join('') + '</select></div>' +
    '</div>' +
    '<div class="form-grid-2">' +
      '<div class="form-row"><label>Plan</label><div style="font-size:14px;font-weight:700;color:var(--em);padding:8px 0">' + plan + '</div></div>' +
      '<div class="form-row"><label>Status</label><div style="font-size:14px;color:var(--txt2);padding:8px 0">' + escapeHTML(currentOrg.status || 'active') + '</div></div>' +
    '</div>';
}
async function setSaveOrg() {
  const d = { name: $('set-name').value.trim(), sector: $('set-sector').value };
  if (!d.name) { setStatus('Name cannot be blank', true); return; }
  setStatus('Saving…');
  try {
    await sbUpdate('organisations', d, orgId);
    currentOrg = Object.assign({}, currentOrg, d);
    if ($('ob-txt')) $('ob-txt').textContent = currentOrg.name;
    setStatus('✓ Saved');
  } catch (e) { setStatus('Not saved: ' + e.message, true); }
}

// ── What you do (modules) ────────────────────────────────────
function setModulesHTML(body) {
  const mods = typeof SET_MODULES !== 'undefined' ? SET_MODULES : [];
  const used = new Set();
  const groups = SET_MOD_GROUPS.map(g => [g[0], g[1].map(k => mods.find(x => x.k === k)).filter(Boolean)]);
  groups.forEach(g => g[1].forEach(x => used.add(x.k)));
  const rest = mods.filter(x => !used.has(x.k));
  if (rest.length) groups.push(['Other', rest]);
  body.innerHTML = groups.map(g =>
    '<div class="st-group">' + g[0] + '</div><div class="st-mods">' + g[1].map(mod =>
      '<div class="st-mod ' + (_modState[mod.k] ? 'on' : '') + '" onclick="toggleMod(\'' + mod.k + '\')">' +
        '<div style="flex:1;min-width:0"><div class="st-mod-n">' + escapeHTML(mod.n) + '</div><div class="st-mod-d">' + escapeHTML(mod.d) + '</div></div>' +
        '<div class="st-sw ' + (_modState[mod.k] ? 'on' : '') + '"></div></div>').join('') + '</div>').join('');
}
let _modSaveTimer = null;
function toggleMod(key) {
  _modState[key] = !_modState[key];
  if (_setSection === 'modules') setModulesHTML($('st-body'));
  setStatus('Saving…');
  clearTimeout(_modSaveTimer);
  _modSaveTimer = setTimeout(async () => {
    const mods = {};
    SET_MODULES.forEach(mod => mods[mod.k] = _modState[mod.k] != null ? _modState[mod.k] : true);
    try {
      await sbUpdate('organisations', { modules: mods }, orgId);
      currentOrg = Object.assign({}, currentOrg, { modules: mods });
      if (typeof applyModules === 'function') applyModules(mods, currentOrg.plan);
      // Circular section appears / disappears in the menu
      const nav = $('st-nav');
      if (nav) {
        const has = !!nav.querySelector('[data-sec="circular"]');
        if (has !== (mods.circular !== false)) { renderSettings(); setOpen('modules'); }
      }
      setStatus('✓ Saved');
    } catch (e) { setStatus('Not saved: ' + e.message, true); }
  }, 400);
}

// ── Look and feel ────────────────────────────────────────────
function setLookHTML(body) {
  _selectedColour = currentOrg.brand_color || '#1F6F6D';
  const logo = typeof getOrgLogoUrl === 'function' ? getOrgLogoUrl(currentOrg) : currentOrg.logo_url;
  body.innerHTML =
    '<div class="st-brand"><div>' +
      '<div class="st-lbl">Logo</div>' +
      '<div style="border:2px dashed var(--border);border-radius:10px;background:var(--bg);padding:16px;text-align:center;cursor:pointer" onclick="$(\'set-logo-input\').click()">' +
        '<div id="set-logo-preview" style="height:90px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:6px;margin-bottom:10px;overflow:hidden;border:1px solid var(--border)">' +
          (logo ? '<img src="' + escapeHTML(logo) + '" style="max-width:100%;max-height:100%;object-fit:contain"/>' : '<span style="color:var(--txt3);font-size:13px">No logo yet</span>') + '</div>' +
        '<span class="btn btn-ghost btn-sm">Choose file</span>' +
        '<input type="file" id="set-logo-input" accept="image/png,image/jpeg,image/svg+xml,image/webp" style="display:none" onchange="handleSetLogoSelect(event)"/>' +
        '<div style="font-size:11px;color:var(--txt3);margin-top:6px">PNG, JPG, SVG or WebP · max 2MB</div>' +
      '</div></div><div>' +
      '<div class="st-lbl">Colour</div>' +
      '<div id="set-colour-swatches" style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px"></div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-top:12px">' +
        '<div id="set-colour-preview" style="width:32px;height:32px;border-radius:6px;border:1px solid var(--border);flex-shrink:0;background:' + escapeHTML(_selectedColour) + '"></div>' +
        '<input type="text" id="set-colour-hex" value="' + escapeHTML(_selectedColour) + '" oninput="onSetHexInput(this.value)" style="max-width:130px"/>' +
      '</div></div></div>' +
    '<div class="st-lbl" style="margin-top:18px">Preview</div><div class="st-prev" id="st-prev"></div>';
  renderSetSwatches(); setLookPreview();
}
function setLookPreview() {
  const p = $('st-prev'); if (!p) return;
  const logo = typeof getOrgLogoUrl === 'function' ? getOrgLogoUrl(currentOrg) : currentOrg.logo_url;
  p.innerHTML = '<div class="st-prev-bar" style="background:linear-gradient(90deg,#1F4F4D,' + escapeHTML(_selectedColour) + ')">' + escapeHTML(currentOrg.name || '') + '</div>' +
    '<div class="st-prev-body"><div class="st-prev-side">' + (logo ? '<img src="' + escapeHTML(logo) + '" style="max-width:70px;max-height:34px;object-fit:contain"/>' : '') + '</div>' +
    '<div style="padding:12px"><span style="display:inline-block;padding:6px 12px;border-radius:6px;background:' + escapeHTML(_selectedColour) + ';color:#fff;font-size:12px;font-weight:700">Button</span></div></div>';
}
function renderSetSwatches() {
  const wrap = $('set-colour-swatches'); if (!wrap || typeof BRAND_COLOURS === 'undefined') return;
  wrap.innerHTML = BRAND_COLOURS.map(c =>
    '<div style="width:100%;aspect-ratio:1;border-radius:6px;cursor:pointer;background:' + c.hex + ';border:3px solid ' +
    (c.hex.toLowerCase() === _selectedColour.toLowerCase() ? 'var(--txt)' : 'transparent') + ';position:relative" title="' + escapeHTML(c.name) +
    '" onclick="pickSetColour(\'' + c.hex + '\')">' +
    (c.hex.toLowerCase() === _selectedColour.toLowerCase() ? '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700">✓</span>' : '') +
    '</div>').join('');
}
let _colourSaveTimer = null;
function setSaveColour() {
  setStatus('Saving…');
  clearTimeout(_colourSaveTimer);
  _colourSaveTimer = setTimeout(async () => {
    try {
      await sbUpdate('organisations', { brand_color: _selectedColour }, orgId);
      currentOrg = Object.assign({}, currentOrg, { brand_color: _selectedColour });
      if (typeof applyBranding === 'function') applyBranding(currentOrg);
      setStatus('✓ Saved');
    } catch (e) { setStatus('Not saved: ' + e.message, true); }
  }, 500);
}
function pickSetColour(hex) {
  _selectedColour = hex;
  if ($('set-colour-hex')) $('set-colour-hex').value = hex;
  if ($('set-colour-preview')) $('set-colour-preview').style.background = hex;
  renderSetSwatches(); setLookPreview(); setSaveColour();
}
function onSetHexInput(v) {
  v = (v || '').trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
    _selectedColour = v;
    if ($('set-colour-preview')) $('set-colour-preview').style.background = v;
    renderSetSwatches(); setLookPreview(); setSaveColour();
  }
}
async function handleSetLogoSelect(ev) {
  const file = ev.target.files && ev.target.files[0]; if (!file) return;
  if (file.size > 2 * 1024 * 1024) { setStatus('Logo too large (max 2MB)', true); return; }
  setStatus('Uploading logo…');
  try {
    const ext = (file.name.split('.').pop() || 'png').toLowerCase();
    const path = orgId + '/logo-' + Date.now() + '.' + ext;
    const { error } = await sb.storage.from('org-logos').upload(path, file, { cacheControl: '3600', upsert: false });
    if (error) throw new Error('Logo upload failed: ' + error.message);
    const { data } = sb.storage.from('org-logos').getPublicUrl(path);
    await sbUpdate('organisations', { logo_url: data.publicUrl }, orgId);
    currentOrg = Object.assign({}, currentOrg, { logo_url: data.publicUrl });
    if (typeof applyBranding === 'function') applyBranding(currentOrg);
    setLookHTML($('st-body'));
    setStatus('✓ Saved');
  } catch (e) { setStatus(e.message, true); }
}

// ── Demo mode ────────────────────────────────────────────────
function setDemoHTML(body) {
  body.innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:14px">' +
      '<div style="font-size:13px;color:var(--txt2);line-height:1.6;flex:1">Show sample participants, events, feedback and a demo contract. Your real data is not changed.</div>' +
      '<div style="position:relative;width:44px;height:24px;flex-shrink:0;cursor:pointer" id="demo-toggle" onclick="toggleDemoMode(' + (!_demoMode) + ');setTimeout(()=>{if(_setSection===\'demo\')setOpen(\'demo\')},300)">' +
        '<div id="demo-toggle-track" style="position:absolute;inset:0;border-radius:12px;background:' + (_demoMode ? '#F59E0B' : '#E0DAD0') + ';transition:background .2s"></div>' +
        '<div id="demo-toggle-thumb" style="position:absolute;top:3px;left:' + (_demoMode ? '23' : '3') + 'px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .2s;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.2)"></div>' +
      '</div></div>';
}

// ── Team access: which pages advisers can open ──────────────
function setAccessHTML(body) {
  const on = new Set(adviserPages());
  const groups = [
    ['Caseload', ['participants', 'pipeline', 'referrals', 'partnerrefs', 'outcomes', 'safeguarding', 'evidence']],
    ['Delivery', ['events', 'feedback', 'volunteers', 'circular']],
    ['People & partners', ['contacts', 'employers']],
    ['Reporting & money', ['impact', 'rag', 'demographics', 'reports', 'funders', 'funding']],
    ['Growth & admin', ['social', 'bd', 'hr', 'settings']]
  ];
  const label = k => (PAGE_LIST.find(p => p[0] === k) || [k, k])[1];
  body.innerHTML = '<div style="font-size:13px;color:var(--txt2);line-height:1.6;margin-bottom:6px">Advisers can open the pages switched on here. The dashboard is always available. Whatever is chosen, everyone only ever sees your organisation\'s data, and deleting participants, contracts, funders or evidence always needs a manager.</div>' +
    groups.map(g => '<div class="st-group">' + g[0] + '</div><div class="st-mods">' + g[1].map(k =>
      '<div class="st-mod ' + (on.has(k) ? 'on' : '') + '" onclick="toggleAccess(\'' + k + '\')"><div style="flex:1;min-width:0"><div class="st-mod-n">' + escapeHTML(label(k)) + '</div></div><div class="st-sw ' + (on.has(k) ? 'on' : '') + '"></div></div>').join('') + '</div>').join('') +
    '<div style="margin-top:14px"><a href="#" onclick="resetAccess();return false" style="font-size:12.5px;color:var(--txt3)">Reset to the recommended set</a></div>';
}
let _accessTimer = null;
async function saveAccess(pages) {
  const settings = Object.assign({}, currentOrg.settings || {}, { adviser_pages: pages });
  currentOrg = Object.assign({}, currentOrg, { settings });
  setAccessHTML($('st-body'));
  setStatus('Saving…');
  clearTimeout(_accessTimer);
  _accessTimer = setTimeout(async () => {
    try { await sbUpdate('organisations', { settings }, orgId); setStatus('✓ Saved'); if (typeof applyModules === 'function') applyModules(currentOrg.modules || {}); }
    catch (e) { setStatus('Not saved: ' + e.message, true); }
  }, 400);
}
function toggleAccess(k) {
  const set = new Set(adviserPages());
  set.has(k) ? set.delete(k) : set.add(k);
  saveAccess(Array.from(set));
}
function resetAccess() { saveAccess(ADVISER_DEFAULT_PAGES.slice()); }

// Kept for anything that still calls it — everything autosaves now
async function saveSettings() { setStatus('✓ Saved'); }

// ─────────────────────────────────────────────────────────────
// CIRCULAR ACTIVITIES — settings (v2: tiles + panel, autosave)
// Stored in circular_activities (see circular-migration.sql).
// mode column: circular-migration-v3.sql
// ─────────────────────────────────────────────────────────────

const CIRC_OUT_TYPES = [
  ['reuse', 'Reused'], ['repair', 'Repaired'], ['share', 'Shared (food)'], ['loan', 'Loaned'],
  ['return', 'Returned to owner'], ['recycle', 'Recycled'], ['dispose', 'Disposed'], ['other', 'Other']
];
const CIRC_FIELD_TYPES = [['text', 'Text'], ['number', 'Number'], ['date', 'Date'], ['yesno', 'Yes / no']];
const CIRC_STARTER = 'Vorlana starter estimate';
const CIRC_TALLY_DEFAULT = ['growing', 'food', 'textiles', 'scrap_store', 'repair_cafe'];

function _circSlug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'x'; }
function _circRid(p) { return p + '_' + Math.random().toString(36).slice(2, 8); }
function circMode(a) { return a.mode || (CIRC_TALLY_DEFAULT.includes(a.template) ? 'tally' : 'tracked'); }

// Item rows: [label, unit ('kg' or 'each'), kg each, CO₂e kg avoided per unit, £ value per unit]
function _circT(key, name, icon, desc, stages, outcomes, items, fields, links) {
  return {
    key, name, icon, desc,
    stages: stages.map(s => ({ key: _circSlug(s), label: s })),
    outcomes: outcomes.map(o => ({ key: _circSlug(o[0]), label: o[0], type: o[1] })),
    item_types: items.map(i => ({ key: _circSlug(i[0]), label: i[0], unit: i[1], weight_kg: i[2], co2e_kg: i[3], value_gbp: i[4], source: CIRC_STARTER })),
    fields: (fields || []).map(f => ({ key: _circSlug(f[0]), label: f[0], type: f[1] })),
    links: links || []
  };
}

const CIRC_TEMPLATES = [
  _circT('collections', 'Collections', '🚚', 'Donors, councils and businesses book a pickup. Items are collected and booked in.',
    ['Requested', 'Scheduled', 'Collected', 'Booked in'], [['Passed to activity', 'other'], ['Declined', 'other']], [], [], [{ on: 'end', to: '' }]),
  _circT('device_reuse', 'Device reuse', '💻', 'Laptops, phones and tablets: wiped, tested, refurbished, then donated or resold.',
    ['Booked in', 'Data wiped', 'Tested', 'Refurbished', 'Ready'],
    [['Donated', 'reuse'], ['Resold', 'reuse'], ['Parts harvested', 'recycle'], ['Recycled', 'recycle']],
    [['Laptop', 'each', 2.2, 250, 200], ['Desktop PC', 'each', 8, 300, 150], ['Monitor', 'each', 5, 200, 60], ['Tablet', 'each', 0.5, 90, 120], ['Smartphone', 'each', 0.2, 55, 100], ['Printer', 'each', 7, 60, 50]],
    [['Wipe method', 'text'], ['Wipe certificate ref', 'text'], ['PAT result', 'yesno']]),
  _circT('repair_cafe', 'Repair café', '🔧', 'Items brought to a session. Fixed or not, back to the owner.',
    ['Brought in', 'Being repaired'],
    [['Fixed', 'repair'], ['Partly fixed', 'repair'], ['Not fixable', 'return'], ['Referred on', 'other']],
    [['Kettle', 'each', 1.2, 10, 20], ['Toaster', 'each', 1.5, 12, 20], ['Vacuum cleaner', 'each', 5, 35, 80], ['Lamp', 'each', 1, 8, 15], ['Hairdryer', 'each', 0.6, 6, 15], ['Radio / speaker', 'each', 1.5, 15, 30], ['Clothing', 'each', 0.5, 8, 15], ['Bike', 'each', 15, 100, 150]]),
  _circT('furniture', 'Furniture & household', '🛋️', 'Checked, cleaned, then rehomed, sold or recycled.',
    ['Booked in', 'Checked', 'Cleaned / repaired', 'Ready'],
    [['Rehomed', 'reuse'], ['Sold', 'reuse'], ['Recycled', 'recycle'], ['Disposed', 'dispose']],
    [['Sofa', 'each', 40, 90, 250], ['Chair', 'each', 7, 15, 40], ['Table', 'each', 20, 35, 80], ['Wardrobe', 'each', 50, 80, 150], ['Bed frame', 'each', 35, 60, 120], ['Mattress', 'each', 25, 60, 150]],
    [['Fire safety label present', 'yesno']]),
  _circT('textiles', 'Textiles & clothing', '👕', 'Sorted, then reused, swapped, sold or recycled.',
    ['Received', 'Sorted'],
    [['Reused', 'reuse'], ['Swapped', 'reuse'], ['Sold', 'reuse'], ['Recycled', 'recycle']],
    [['Clothing', 'kg', 1, 15, 10], ['Shoes', 'each', 1, 10, 15], ['Bedding & linen', 'kg', 1, 10, 8]]),
  _circT('bikes', 'Bikes', '🚲', 'Safety checked and refurbished, then sold, donated or loaned.',
    ['Booked in', 'Safety checked', 'Refurbished', 'Ready'],
    [['Sold', 'reuse'], ['Donated', 'reuse'], ['Loaned', 'loan'], ['Stripped for parts', 'recycle'], ['Recycled', 'recycle']],
    [['Adult bike', 'each', 15, 100, 150], ['Child bike', 'each', 8, 50, 60]],
    [['Frame number', 'text']]),
  _circT('food', 'Food surplus', '🥕', 'Surplus food collected and shared with households or partners.',
    ['Collected', 'Stored'],
    [['Shared', 'share'], ['Given to partner', 'share'], ['Composted', 'recycle'], ['Disposed', 'dispose']],
    [['Fresh produce', 'kg', 1, 2.5, 3], ['Bread & bakery', 'kg', 1, 2.5, 3], ['Chilled', 'kg', 1, 2.5, 4], ['Tins & dry goods', 'kg', 1, 2.5, 3]]),
  _circT('growing', 'Growing', '🌱', 'Food grown and harvested, then shared, sold or given to food banks.',
    ['Planted', 'Growing', 'Harvested'],
    [['Shared', 'share'], ['Food bank', 'share'], ['Sold', 'share'], ['Compost', 'recycle']],
    [['Tomatoes', 'kg', 1, 0, 3], ['Potatoes', 'kg', 1, 0, 1.5], ['Courgettes', 'kg', 1, 0, 2.5], ['Salad leaves', 'kg', 1, 0, 8], ['Beans', 'kg', 1, 0, 5], ['Fruit', 'kg', 1, 0, 4]],
    [['Bed / planter', 'text'], ['Batch number', 'text'], ['Harvester', 'text'], ['Packer', 'text'], ['Packing date', 'date']]),
  _circT('tool_library', 'Library of things', '🧰', 'Tools and equipment loaned out and returned.',
    ['Available', 'On loan', 'Under repair'],
    [['Retired', 'recycle']],
    [['Power tool', 'each', 2, 25, 60], ['Garden tool', 'each', 2, 10, 25], ['Event / camping kit', 'each', 5, 20, 50]],
    [['Borrower', 'text'], ['Due back', 'date']]),
  _circT('scrap_store', 'Scrap store & upcycling', '🎨', 'Materials received, sorted and used in workshops or passed on.',
    ['Received', 'Sorted', 'In stock'],
    [['Used in workshop', 'reuse'], ['Given to groups', 'reuse'], ['Sold', 'reuse'], ['Recycled', 'recycle']],
    [['Materials', 'kg', 1, 1, 2]])
];

let CIRC = [];
let CIRC_REMOVED = [];
let CIRC_READY = false;
let _circSel = 0, _circTab = 'basics', _circEdit = null, _circOpenMobile = false;

async function loadCircSettings() {
  const { data, error } = await cxFrom('circular_activities').select('*').eq('org_id', orgId).order('sort');
  if (error) {
    CIRC_READY = false;
    const b = $('st-body');
    if (b && _setSection === 'circular') b.innerHTML = '<div class="alert alert-warn">Circular set-up needs the database update. Run circular-migration.sql in Supabase, then refresh.</div>';
    return;
  }
  CIRC = (data || []).filter(a => a.active);
  CIRC.forEach(a => (a.item_types || []).forEach(t => { if (!t.unit) t.unit = /per\s*kg/i.test(t.label || '') ? 'kg' : 'each'; }));
  CIRC_READY = true;
  renderCircSettings();
}

function renderCircularSettingsCard() {
  const b = $('st-body'); if (!b || _setSection !== 'circular') return;
  b.innerHTML = '<div class="cx-hint" style="font-size:13px;color:var(--txt3)">Loading…</div>';
  CIRC = []; CIRC_REMOVED = []; CIRC_READY = false; _circEdit = null;
  loadCircSettings();
}

function renderCircSettings() {
  const b = $('st-body'); if (!b || _setSection !== 'circular' || !CIRC_READY) return;
  const e = escapeHTML;
  if (_circSel >= CIRC.length) _circSel = Math.max(0, CIRC.length - 1);
  const tiles = CIRC.map((a, i) => {
    const d = a.template === 'collections' ? 'Bookings and pickups'
      : (circMode(a) === 'tally' ? 'Quick tally' : 'Tracked · ' + (a.stages || []).length + ' steps') + ' · ' + (a.item_types || []).length + ' items';
    return '<div class="st-tile ' + (i === _circSel ? 'on' : '') + '" onclick="circPick(' + i + ')"><span class="st-tile-i">' + e(a.icon || '♻️') + '</span>' +
      '<div style="flex:1;min-width:0"><div class="st-tile-n">' + e(a.name) + '</div><div class="st-tile-d">' + e(d) + '</div></div><span style="color:var(--txt3)">›</span></div>';
  }).join('');
  b.innerHTML = '<div class="st-circ ' + (_circOpenMobile ? 'open' : '') + '">' +
    '<div class="st-tiles">' + (tiles || '<div style="font-size:13px;color:var(--txt3);margin-bottom:10px">No activities yet.</div>') +
      '<button class="st-add" onclick="circAddOpen()">+ Add activity</button></div>' +
    '<div class="st-panel" id="st-circ-panel">' + (CIRC.length ? circPanelHTML(CIRC[_circSel], _circSel) : '<div style="font-size:13px;color:var(--txt3)">Add an activity to set it up.</div>') + '</div>' +
  '</div>';
}

function circPick(i) { _circSel = i; _circTab = 'basics'; _circEdit = null; _circOpenMobile = true; renderCircSettings(); }

function circPanelHTML(a, ai) {
  const e = escapeHTML;
  const isCol = a.template === 'collections';
  const tracked = circMode(a) === 'tracked';
  const tabs = isCol ? [['basics', 'Basics'], ['more', 'More']] : [['basics', 'Basics'], ['items', 'Items'], ['goes', 'Where it goes'], ['more', 'More']];
  if (!tabs.some(t => t[0] === _circTab)) _circTab = 'basics';
  let h = '<div style="display:flex;align-items:center;gap:8px"><button class="btn btn-ghost btn-sm st-back" onclick="_circOpenMobile=false;renderCircSettings()">‹ Back</button>' +
    '<div style="font-size:15px;font-weight:700;flex:1">' + e(a.icon || '♻️') + ' ' + e(a.name) + '</div></div>' +
    '<div class="st-seg">' + tabs.map(t => '<button class="' + (t[0] === _circTab ? 'on' : '') + '" onclick="_circTab=\'' + t[0] + '\';_circEdit=null;renderCircSettings()">' + t[1] + '</button>').join('') + '</div>';

  if (_circTab === 'basics') {
    h += '<div style="display:grid;grid-template-columns:70px 1fr;gap:8px;margin-bottom:14px">' +
      '<div class="form-row" style="margin:0"><label>Icon</label><input value="' + e(a.icon || '') + '" maxlength="4" onchange="circTop(' + ai + ',\'icon\',this.value)"/></div>' +
      '<div class="form-row" style="margin:0"><label>Name</label><input value="' + e(a.name) + '" onchange="circTop(' + ai + ',\'name\',this.value)"/></div></div>';
    if (isCol) {
      const others = CIRC.filter(x => x.template !== 'collections');
      const cur = ((a.links || []).find(l => l.on === 'end') || {}).to || '';
      h += '<div class="st-lbl">Collected items go to</div><select onchange="circColTarget(' + ai + ',this.value)" style="margin-bottom:14px"><option value="">Choose when booking in</option>' +
        others.map(x => '<option value="' + e(x.key) + '"' + (x.key === cur ? ' selected' : '') + '>' + e(x.icon + ' ' + x.name) + '</option>').join('') + '</select>';
    } else {
      const cons = DB.contracts || [];
      if (cons.length) {
        const on = _cxrArr(a.contract_ids);
        h += '<div class="st-lbl">Funded by — everything logged here counts in these funder reports</div><div class="st-chips">' + cons.map(c => {
          const f = (DB.funders || []).find(x => String(x.id) === String(c.funder_id));
          return '<span class="st-chip ' + (on.includes(String(c.id)) ? 'fill' : '') + '" onclick="circToggleContract(' + ai + ',\'' + e(String(c.id)) + '\')">' + (on.includes(String(c.id)) ? '✓ ' : '') + e(c.name || 'Contract') + (f ? '<small>' + e(f.name) + '</small>' : '') + '</span>';
        }).join('') + '</div><div style="font-size:11px;color:var(--txt3);margin:-6px 0 14px">Entries logged at a session linked to a contract also count for it.</div>';
      }
      h += '<div class="st-lbl">How do you record it?</div><div class="st-mode">' +
        '<div class="' + (!tracked ? 'on' : '') + '" onclick="circSetMode(' + ai + ',\'tally\')"><b>Quick tally</b><span>Weigh or count, tap where it went</span></div>' +
        '<div class="' + (tracked ? 'on' : '') + '" onclick="circSetMode(' + ai + ',\'tracked\')"><b>Track each item</b><span>QR label, steps and full history</span></div></div>';
    }
    h += '<div style="text-align:right"><button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="circRemove(' + ai + ')">Remove activity</button></div>';
  }

  if (_circTab === 'items') {
    h += '<div class="st-lbl">' + (a.template === 'growing' ? 'Crops' : 'Items') + ' — tap to edit</div>' +
      '<div class="st-chips">' + (a.item_types || []).map((t, i) =>
        '<span class="st-chip fill ' + (_circEdit && _circEdit.list === 'item_types' && _circEdit.i === i ? 'sel' : '') + '" onclick="circChip(\'item_types\',' + i + ')">' + e(t.label) + '<small>' + (t.unit === 'kg' ? 'kg' : 'each') + '</small></span>').join('') +
      '<span class="st-chip new" onclick="circAdd(' + ai + ',\'item_types\')">+ Add</span></div>';
    if (_circEdit && _circEdit.list === 'item_types' && a.item_types[_circEdit.i]) {
      const t = a.item_types[_circEdit.i], i = _circEdit.i;
      h += '<div class="st-edit"><input value="' + e(t.label) + '" onchange="circSet(' + ai + ',\'item_types\',' + i + ',\'label\',this.value)"/>' +
        '<select style="flex:0 0 130px" onchange="circSet(' + ai + ',\'item_types\',' + i + ',\'unit\',this.value)"><option value="kg"' + (t.unit === 'kg' ? ' selected' : '') + '>Weighed (kg)</option><option value="each"' + (t.unit !== 'kg' ? ' selected' : '') + '>Counted</option></select>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="circDel(' + ai + ',\'item_types\',' + i + ')">Remove</button></div>';
    }
    h += '<div style="font-size:12px;color:var(--txt3)">Weights, CO₂e and £ values are pre-filled. Change them under More.</div>';
  }

  if (_circTab === 'goes') {
    if (tracked) {
      h += '<div class="st-lbl">Steps along the way — tap to edit</div><div class="st-chips">' + (a.stages || []).map((s, i) =>
        '<span class="st-chip ' + (_circEdit && _circEdit.list === 'stages' && _circEdit.i === i ? 'sel' : '') + '" onclick="circChip(\'stages\',' + i + ')">' + (i + 1) + '. ' + e(s.label) + '</span>').join('') +
        '<span class="st-chip new" onclick="circAdd(' + ai + ',\'stages\')">+ Add</span></div>';
      if (_circEdit && _circEdit.list === 'stages' && a.stages[_circEdit.i]) {
        const i = _circEdit.i;
        h += '<div class="st-edit"><input value="' + e(a.stages[i].label) + '" onchange="circSet(' + ai + ',\'stages\',' + i + ',\'label\',this.value)"/>' +
          '<button class="btn btn-ghost btn-sm" onclick="circMove(' + ai + ',\'stages\',' + i + ',-1)">←</button><button class="btn btn-ghost btn-sm" onclick="circMove(' + ai + ',\'stages\',' + i + ',1)">→</button>' +
          '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="circDel(' + ai + ',\'stages\',' + i + ')">Remove</button></div>';
      }
    }
    h += '<div class="st-lbl">' + (tracked ? 'How it leaves' : 'Where it goes') + ' — these are the buttons people tap</div><div class="st-chips">' + (a.outcomes || []).map((o, i) =>
      '<span class="st-chip ' + (_circEdit && _circEdit.list === 'outcomes' && _circEdit.i === i ? 'sel' : '') + '" onclick="circChip(\'outcomes\',' + i + ')">' + e(o.label) + '</span>').join('') +
      '<span class="st-chip new" onclick="circAdd(' + ai + ',\'outcomes\')">+ Add</span></div>';
    if (_circEdit && _circEdit.list === 'outcomes' && a.outcomes[_circEdit.i]) {
      const o = a.outcomes[_circEdit.i], i = _circEdit.i;
      h += '<div class="st-edit"><input value="' + e(o.label) + '" onchange="circSet(' + ai + ',\'outcomes\',' + i + ',\'label\',this.value)"/>' +
        '<select style="flex:0 0 170px" title="How it counts in reports" onchange="circSet(' + ai + ',\'outcomes\',' + i + ',\'type\',this.value)">' + CIRC_OUT_TYPES.map(x => '<option value="' + x[0] + '"' + (x[0] === o.type ? ' selected' : '') + '>Counts as: ' + x[1] + '</option>').join('') + '</select>' +
        '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="circDel(' + ai + ',\'outcomes\',' + i + ')">Remove</button></div>';
    }
  }

  if (_circTab === 'more') {
    if (!isCol && (a.item_types || []).length) {
      h += '<div class="st-lbl">Figures used in reports (per kg for weighed items, per item for counted)</div>' +
        '<div style="overflow-x:auto;margin-bottom:6px"><table class="st-fig"><tr><th>Item</th><th>kg each</th><th>CO₂e kg</th><th>Value £</th></tr>' +
        a.item_types.map((t, i) => '<tr><td style="font-size:12px">' + e(t.label) + '</td>' +
          '<td><input type="number" step="0.1" min="0" ' + (t.unit === 'kg' ? 'value="1" disabled' : 'value="' + (t.weight_kg ?? '') + '"') + ' onchange="circSet(' + ai + ',\'item_types\',' + i + ',\'weight_kg\',+this.value)"/></td>' +
          '<td><input type="number" step="0.1" min="0" value="' + (t.co2e_kg ?? '') + '" onchange="circSet(' + ai + ',\'item_types\',' + i + ',\'co2e_kg\',+this.value)"/></td>' +
          '<td><input type="number" step="0.5" min="0" value="' + (t.value_gbp ?? '') + '" onchange="circSet(' + ai + ',\'item_types\',' + i + ',\'value_gbp\',+this.value)"/></td></tr>').join('') +
        '</table></div><div style="font-size:11px;color:var(--txt3);margin-bottom:16px">Starter figures are Vorlana estimates. Once you change one it shows as "set by your organisation" in reports.</div>';
    }
    if (!isCol && tracked) {
      h += '<div class="st-lbl">Extra details — asked at the step where they happen</div><div class="st-chips">' + (a.fields || []).map((f, i) => {
        const at = cxStage(a, cxFieldStage(a, f));
        return '<span class="st-chip ' + (_circEdit && _circEdit.list === 'fields' && _circEdit.i === i ? 'sel' : '') + '" onclick="circChip(\'fields\',' + i + ')">' + e(f.label) + (at ? '<small>at ' + e(at.label) + '</small>' : '') + '</span>';
      }).join('') +
        '<span class="st-chip new" onclick="circAdd(' + ai + ',\'fields\')">+ Add</span></div>';
      if (_circEdit && _circEdit.list === 'fields' && a.fields[_circEdit.i]) {
        const f = a.fields[_circEdit.i], i = _circEdit.i;
        h += '<div class="st-edit"><input value="' + e(f.label) + '" onchange="circSet(' + ai + ',\'fields\',' + i + ',\'label\',this.value)"/>' +
          '<select style="flex:0 0 120px" onchange="circSet(' + ai + ',\'fields\',' + i + ',\'type\',this.value)">' + CIRC_FIELD_TYPES.map(x => '<option value="' + x[0] + '"' + (x[0] === f.type ? ' selected' : '') + '>' + x[1] + '</option>').join('') + '</select>' +
          '<select style="flex:0 0 170px" title="Asked when an item reaches this step" onchange="circSet(' + ai + ',\'fields\',' + i + ',\'ask_at\',this.value)"><option value="-"' + (f.ask_at === '-' ? ' selected' : '') + '>Only when editing</option>' + (a.stages || []).map(x => '<option value="' + e(x.key) + '"' + (x.key === cxFieldStage(a, f) ? ' selected' : '') + '>Ask at: ' + e(x.label) + '</option>').join('') + '</select>' +
          '<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="circDel(' + ai + ',\'fields\',' + i + ')">Remove</button></div>';
      }
    }
    const others = CIRC.filter(x => x !== a && x.template !== 'collections');
    if (!isCol && others.length) {
      h += '<div class="st-lbl">Pass items on to another activity</div>' +
        (a.links || []).map((l, i) => '<div class="st-edit" style="margin:0 0 8px">' +
          '<select onchange="circSet(' + ai + ',\'links\',' + i + ',\'on\',this.value)">' +
            [['end', 'After the last step']].concat((a.outcomes || []).map(o => ['outcome:' + o.key, 'When: ' + o.label])).map(x => '<option value="' + e(x[0]) + '"' + (x[0] === l.on ? ' selected' : '') + '>' + e(x[1]) + '</option>').join('') +
          '</select><select onchange="circSet(' + ai + ',\'links\',' + i + ',\'to\',this.value)"><option value="">→ choose</option>' +
            others.map(x => '<option value="' + e(x.key) + '"' + (x.key === l.to ? ' selected' : '') + '>→ ' + e(x.icon + ' ' + x.name) + '</option>').join('') +
          '</select><button class="btn btn-ghost btn-sm" onclick="circDel(' + ai + ',\'links\',' + i + ')">×</button></div>').join('') +
        '<button class="btn btn-ghost btn-sm" onclick="circAdd(' + ai + ',\'links\')">+ Add a hand-over</button>';
    }
    if (isCol) h += '<div style="font-size:13px;color:var(--txt2)">Bookings, run sheets and donor details are handled on the Circular page. Nothing else to set up here.</div>';
  }
  return h;
}

function circChip(list, i) {
  _circEdit = _circEdit && _circEdit.list === list && _circEdit.i === i ? null : { list, i };
  renderCircSettings();
}

// Add activity: "What do you do?"
let _circPickT = [];
function circAddOpen() {
  _circPickT = [];
  const had = new Set(CIRC.map(a => a.template).filter(Boolean));
  setModal('<h2>What do you do?</h2><div style="font-size:13px;color:var(--txt3);margin-bottom:14px">Tick everything that applies. Each one comes ready to use.</div>' +
    '<div class="st-tpls" id="st-tpls">' + CIRC_TEMPLATES.map(t =>
      '<div class="st-tpl ' + (had.has(t.key) ? 'had' : '') + '" data-k="' + t.key + '" onclick="circTplToggle(this)"><b>' + t.icon + ' ' + escapeHTML(t.name) + '</b><span>' + (had.has(t.key) ? 'Already added' : escapeHTML(t.desc)) + '</span></div>').join('') +
      '<div class="st-tpl" data-k="__custom" onclick="circTplToggle(this)"><b>✏️ Something else</b><span>Start blank and name it yourself</span></div></div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="setCloseModal()">Cancel</button><button class="btn btn-p" onclick="circAddSelected()">Add</button></div>', 680);
}
function circTplToggle(el) {
  if (el.classList.contains('had')) return;
  const k = el.getAttribute('data-k');
  el.classList.toggle('on');
  _circPickT = el.classList.contains('on') ? _circPickT.concat(k) : _circPickT.filter(x => x !== k);
}
function circAddSelected() {
  if (!_circPickT.length) { setCloseModal(); return; }
  _circPickT.filter(k => k !== '__custom').forEach(k => circAddTemplate(k, true));
  if (_circPickT.includes('__custom')) circAddCustom(true);
  setCloseModal();
  _circSel = CIRC.length - 1; _circTab = 'basics'; _circOpenMobile = true;
  renderCircSettings(); _circQueueSave();
}
function _circUniqueKey(base) {
  let k = _circSlug(base), n = 2;
  while (CIRC.some(a => a.key === k)) k = _circSlug(base) + '_' + (n++);
  return k;
}
function circAddTemplate(key, quiet) {
  const t = JSON.parse(JSON.stringify(CIRC_TEMPLATES.find(x => x.key === key)));
  const a = { key: _circUniqueKey(t.key), template: t.key, name: t.name, icon: t.icon, description: t.desc,
    stages: t.stages, outcomes: t.outcomes, item_types: t.item_types, fields: t.fields, links: t.links };
  if (key === 'collections') { const other = CIRC.find(x => x.template !== 'collections'); a.links = [{ on: 'end', to: other ? other.key : '' }]; }
  if (key === 'growing') { const h = (a.stages.find(s => /harvest/i.test(s.label)) || {}).key; if (h) a.fields.forEach(f => { f.ask_at = h; }); }
  CIRC.forEach(x => { if (x.template === 'collections' && (!x.links.length || !x.links[0].to)) x.links = [{ on: 'end', to: a.key }]; });
  CIRC.push(a);
  if (!quiet) { renderCircSettings(); _circQueueSave(); }
}
function circAddCustom(quiet) {
  CIRC.push({ key: _circUniqueKey('custom'), template: null, name: 'New activity', icon: '♻️', description: '', mode: null,
    stages: [{ key: _circRid('st'), label: 'Received' }, { key: _circRid('st'), label: 'Ready' }],
    outcomes: [{ key: _circRid('oc'), label: 'Reused', type: 'reuse' }, { key: _circRid('oc'), label: 'Recycled', type: 'recycle' }],
    item_types: [], fields: [], links: [] });
  if (!quiet) { renderCircSettings(); _circQueueSave(); }
}

function circTop(ai, f, v) { CIRC[ai][f] = v; renderCircSettings(); _circQueueSave(); }
function circToggleContract(ai, id) {
  const a = CIRC[ai], cur = _cxrArr(a.contract_ids);
  a.contract_ids = cur.includes(id) ? cur.filter(x => x !== id) : cur.concat(id);
  renderCircSettings(); _circQueueSave();
}
function circSetMode(ai, m) { CIRC[ai].mode = m; renderCircSettings(); _circQueueSave(); }
function circColTarget(ai, key) { CIRC[ai].links = [{ on: 'end', to: key }]; _circQueueSave(); }
function circSet(ai, list, i, f, v) {
  const row = CIRC[ai][list][i]; row[f] = v;
  if (list === 'item_types' && ['weight_kg', 'co2e_kg', 'value_gbp'].includes(f)) row.source = 'Set by organisation';
  if (list === 'item_types' && f === 'unit' && v === 'kg') row.weight_kg = 1;
  renderCircSettings(); _circQueueSave();
}
function circMove(ai, list, i, d) {
  const arr = CIRC[ai][list], j = i + d; if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]]; _circEdit = { list, i: j };
  renderCircSettings(); _circQueueSave();
}
function circDel(ai, list, i) { CIRC[ai][list].splice(i, 1); _circEdit = null; renderCircSettings(); _circQueueSave(); }
function circAdd(ai, list) {
  const a = CIRC[ai];
  if (list === 'stages') a.stages.push({ key: _circRid('st'), label: 'New step' });
  if (list === 'outcomes') a.outcomes.push({ key: _circRid('oc'), label: 'New', type: 'reuse' });
  if (list === 'item_types') a.item_types.push({ key: _circRid('it'), label: 'New item', unit: circMode(a) === 'tally' ? 'kg' : 'each', weight_kg: 1, co2e_kg: 0, value_gbp: 0, source: 'Set by organisation' });
  if (list === 'fields') a.fields.push({ key: _circRid('f'), label: 'New detail', type: 'text' });
  if (list === 'links') { a.links.push({ on: 'end', to: '' }); renderCircSettings(); return; }
  _circEdit = { list, i: a[list].length - 1 };
  renderCircSettings(); _circQueueSave();
  setTimeout(() => { const inp = document.querySelector('.st-edit input'); if (inp) { inp.focus(); inp.select(); } }, 30);
}
function circRemove(ai) {
  const a = CIRC[ai];
  if (!confirm('Remove ' + a.name + '? Items already logged keep their history.')) return;
  if (a.id) CIRC_REMOVED.push(a.id);
  CIRC.splice(ai, 1);
  CIRC.forEach(x => x.links = (x.links || []).filter(l => l.to !== a.key));
  _circSel = 0; _circOpenMobile = false;
  renderCircSettings(); _circQueueSave();
}

// Autosave
let _circSaveTimer = null, _circSaving = false, _circSaveAgain = false;
function _circQueueSave() {
  if (!CIRC_READY) return;
  setStatus('Saving…');
  clearTimeout(_circSaveTimer);
  _circSaveTimer = setTimeout(_circRunSave, 700);
}
async function _circRunSave() {
  if (_circSaving) { _circSaveAgain = true; return; }
  _circSaving = true;
  try { await saveCircularActivities(); setStatus('✓ Saved'); }
  catch (e) { setStatus('Not saved: ' + (e.message || e) + (/mode/i.test(e.message || '') ? ' — run circular-migration-v3.sql in Supabase' : /contract_ids/i.test(e.message || '') ? ' — run circular-migration-v4.sql in Supabase' : ''), true); }
  finally { _circSaving = false; if (_circSaveAgain) { _circSaveAgain = false; _circRunSave(); } }
}
async function saveCircularActivities() {
  if (!CIRC_READY) return;
  for (const a of CIRC) {
    if (!String(a.name || '').trim()) throw new Error('Every activity needs a name');
    const row = { org_id: orgId, key: a.key, template: a.template, name: a.name.trim(), icon: a.icon || '♻️',
      description: a.description || '', stages: a.stages, outcomes: a.outcomes, item_types: a.item_types,
      fields: a.fields, links: (a.links || []).filter(l => l.to), active: true, sort: CIRC.indexOf(a), updated_at: new Date().toISOString() };
    if (a.mode) row.mode = a.mode;
    if (Array.isArray(a.contract_ids)) row.contract_ids = a.contract_ids;
    if (a.id) {
      const { error } = await cxFrom('circular_activities').update(row).eq('id', a.id);
      if (error) throw error;
    } else {
      const { data, error } = await cxFrom('circular_activities').insert([row]).select('id').single();
      if (error) throw error;
      a.id = data.id;
    }
  }
  for (const id of CIRC_REMOVED) {
    const { error } = await cxFrom('circular_activities').update({ active: false }).eq('id', id);
    if (error) throw error;
  }
  CIRC_REMOVED = [];
}
