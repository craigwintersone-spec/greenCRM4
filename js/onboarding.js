// js/onboarding.js — faster participant onboarding + funder form filling
// ─────────────────────────────────────────────────────────────
// Adds to the participant form (modal-p):
//   ✨ Fill from a referral — photo, PDF, Word or pasted text; the AI
//      fills every field it can and highlights them for checking.
//   Sections open themselves and show "4 of 9 filled".
// Replaces the funder-form filler (civaraFillFunderForm) with one
// screen: pick the form (or upload a one-off), fill, see what was
// filled and what's missing, add the missing answers, fill again.
// Depends on: utils.js, db.js, modals.js, settings.js (vAI),
//   circular.js (cxResize), app.html inline paperwork scripts.
'use strict';

(function () {
  const $id = id => document.getElementById(id);
  const esc = s => escapeHTML(s == null ? '' : String(s));
  const val = id => { const e = $id(id); return e ? (e.value || '').trim() : ''; };

  // ── Styles ─────────────────────────────────────────────────
  function style() {
    if ($id('ob-style')) return;
    const s = document.createElement('style'); s.id = 'ob-style';
    s.textContent = `
#modal-p .modal{max-width:720px}
.ob-quick{border:1.5px dashed rgba(31,111,109,.35);background:rgba(31,111,109,.05);border-radius:12px;padding:12px 14px;margin:6px 0 4px}
.ob-quick-h{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
.ob-quick-h b{font-size:14px;color:var(--em)}
.ob-quick-h span{font-size:12px;color:var(--txt3)}
.ob-quick-btns{display:flex;gap:6px;flex-wrap:wrap}
.ob-quick textarea{margin-top:10px;min-height:90px;font-size:13px}
.ob-status{font-size:12.5px;margin-top:8px;color:var(--em)}
.ob-status.err{color:var(--red)}
.ob-filled{box-shadow:0 0 0 2px rgba(31,111,109,.45)!important;background:rgba(31,111,109,.04)!important}
.ob-count{float:right;font-size:11px;font-weight:600;color:var(--txt3);margin-left:8px}
.ob-count.done{color:var(--em)}
.ff-list{display:flex;flex-direction:column;gap:6px;margin:10px 0}
.ff-opt{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--border);border-radius:10px;cursor:pointer;background:var(--surface)}
.ff-opt.on{border:2px solid var(--em);padding:9px 11px}
.ff-opt b{font-size:13px}.ff-opt span{font-size:11.5px;color:var(--txt3);display:block}
.ff-ok{background:#F0FDF4;border:1px solid #BBF7D0;color:#15803D;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:10px}
.ff-miss{border:1px solid #FDE68A;background:#FFFBEB;border-radius:10px;padding:10px 12px;margin-bottom:10px}
.ff-miss .form-row{margin-bottom:8px}
.el-grid{display:grid;grid-template-columns:1fr;gap:6px}
.el-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px}
.el-seg{display:flex;gap:4px;flex-shrink:0}.el-seg.wrap{flex-wrap:wrap}
.el-seg button,.el-chips button{border:1px solid var(--border);background:var(--surface);border-radius:16px;padding:5px 11px;font-size:12px;color:var(--txt2);cursor:pointer}
.el-seg button.on,.el-chips button.on{background:var(--em);border-color:var(--em);color:#fff;font-weight:600}
.el-chips{display:flex;flex-wrap:wrap;gap:5px}
.fm-list{max-height:60vh;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:4px 10px}
.fm-row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)}
.fm-q{min-width:0}.fm-q b{display:block;font-size:12.5px;font-weight:600}.fm-q span{font-size:11px;color:var(--txt3)}
.fm-row select{width:210px;flex-shrink:0;font-size:12px;padding:5px 8px}
@media(max-width:600px){.el-row{flex-direction:column;align-items:flex-start}.fm-row{flex-direction:column;align-items:stretch}.fm-row select{width:100%}}
.ff-prev{max-height:200px;overflow:auto;font-size:12px;color:var(--txt2);border:1px solid var(--border);border-radius:8px;padding:8px 10px;line-height:1.6}`;
    document.head.appendChild(s);
  }

  // ── Section counters and auto-open ─────────────────────────
  function sectionCount(d) {
    const fields = Array.from(d.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=file]),select,textarea'))
      .filter(f => !/mp-note|mp-intake-text|ob-/.test(f.id || ''));
    const filled = fields.filter(f => f.tagName === 'SELECT' ? f.selectedIndex > 0 || (f.value && !/^(—|Select|Choose)/i.test(f.value)) : f.value.trim());
    const checks = d.querySelectorAll('input[type=checkbox]:checked').length;
    return { n: fields.length, f: filled.length + (checks ? 1 : 0), t: fields.length + (d.querySelector('input[type=checkbox]') ? 1 : 0) };
  }
  function paintCounts() {
    document.querySelectorAll('#modal-p details').forEach(d => {
      const sum = d.querySelector('summary'); if (!sum) return;
      let b = sum.querySelector('.ob-count');
      if (!b) { b = document.createElement('span'); b.className = 'ob-count'; sum.appendChild(b); }
      const c = sectionCount(d);
      if (!c.t) { b.textContent = ''; return; }
      b.textContent = c.f + ' of ' + c.t + ' filled';
      b.classList.toggle('done', c.f === c.t);
    });
  }

  // ── Quick start bar ────────────────────────────────────────
  function injectQuick() {
    const modal = document.querySelector('#modal-p .modal'); if (!modal || $id('ob-quick')) return;
    const h2 = $id('mp-title');
    const box = document.createElement('div'); box.id = 'ob-quick'; box.className = 'ob-quick';
    box.innerHTML =
      '<div class="ob-quick-h"><div><b>✨ Fill from a referral</b><br><span>Photo of a paper form, a PDF or Word referral, or pasted text — checked by you before saving.</span></div>' +
      '<div class="ob-quick-btns"><label class="btn btn-p btn-sm" style="margin:0;cursor:pointer">📷 Photo / file<input type="file" id="ob-file" accept="image/*,.pdf,.docx,.txt" style="display:none"/></label>' +
      '<button class="btn btn-ghost btn-sm" type="button" id="ob-paste-btn">📋 Paste text</button></div></div>' +
      '<div id="ob-paste" style="display:none"><textarea id="ob-text" placeholder="Paste the referral email or form text here…"></textarea>' +
      '<div style="text-align:right;margin-top:6px"><button class="btn btn-p btn-sm" type="button" id="ob-read">Fill the form</button></div></div>' +
      '<div class="ob-status" id="ob-status"></div>';
    h2.parentNode.insertBefore(box, h2.nextSibling);
    $id('ob-paste-btn').onclick = () => { const p = $id('ob-paste'); p.style.display = p.style.display === 'none' ? '' : 'none'; if (p.style.display === '') $id('ob-text').focus(); };
    $id('ob-read').onclick = () => readReferral({ text: val('ob-text') });
    $id('ob-file').onchange = ev => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (f) readReferral({ file: f }); };
    modal.addEventListener('input', e => { if (e.target.classList) e.target.classList.remove('ob-filled'); paintCounts(); });
    const ni = $id('mp-ni');
    if (ni && !ni._ob) {
      ni._ob = true;
      const hint = document.createElement('div'); hint.id = 'ni-hint'; hint.style.cssText = 'font-size:11.5px;margin-top:3px;min-height:14px';
      ni.parentNode.appendChild(hint);
      const check = () => {
        const v = ni.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!v) { hint.textContent = ''; return; }
        const ok = /^[A-CEGHJ-PR-TW-Z]{2}\d{6}[A-D]$/.test(v);
        hint.textContent = ok ? '' : 'That doesn\'t look like an NI number (2 letters, 6 numbers, 1 letter A–D) — forms won\'t fill it';
        hint.style.color = 'var(--red)';
      };
      ni.addEventListener('blur', () => { ni.value = ni.value.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(\w{2})(\d{2})(\d{2})(\d{2})(\w)$/, '$1 $2 $3 $4 $5'); check(); });
      ni.addEventListener('input', check);
    }
    modal.addEventListener('change', e => { if (e.target.classList) e.target.classList.remove('ob-filled'); paintCounts(); });
  }

  function options(id) { const e = $id(id); return e && e.tagName === 'SELECT' ? Array.from(e.options).map(o => o.value || o.text).filter(Boolean) : null; }
  function setField(id, v) {
    const e = $id(id); if (!e || v == null || v === '') return false;
    if (e.tagName === 'SELECT') {
      const want = String(v).toLowerCase();
      const o = Array.from(e.options).find(o => (o.value || o.text).toLowerCase() === want) ||
                Array.from(e.options).find(o => (o.value || o.text).toLowerCase().includes(want) || want.includes((o.value || o.text).toLowerCase()));
      if (!o) return false;
      e.value = o.value || o.text;
    } else if (e.type === 'date') {
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v) || /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})/.exec(v);
      if (!m) return false;
      e.value = m[1].length === 4 ? m[1] + '-' + m[2] + '-' + m[3] : m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
    } else {
      if (e.value.trim() && e.value.trim() !== String(v).trim() && !confirmOverwrite) return false;
      e.value = v;
    }
    e.classList.add('ob-filled');
    return true;
  }
  let confirmOverwrite = false;

  // Word .docx → text using the browser's own unzip (no library)
  async function docxText(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('That Word file could not be opened');
    let p = dv.getUint32(eocd + 16, true); const n = dv.getUint16(eocd + 10, true);
    for (let k = 0; k < n; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const fnl = dv.getUint16(p + 28, true), exl = dv.getUint16(p + 30, true), cml = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.slice(p + 46, p + 46 + fnl));
      if (name === 'word/document.xml') {
        const lfn = dv.getUint16(off + 26, true), lex = dv.getUint16(off + 28, true);
        const data = buf.slice(off + 30 + lfn + lex, off + 30 + lfn + lex + csize);
        let xml;
        if (method === 0) xml = new TextDecoder().decode(data);
        else { const ds = new DecompressionStream('deflate-raw'); xml = await new Response(new Blob([data]).stream().pipeThrough(ds)).text(); }
        return xml.replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, ' | ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
      }
      p += 46 + fnl + exl + cml;
    }
    throw new Error('No text found in that Word file');
  }
  function fileB64(file) { return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => bad(new Error('Could not read the file')); r.readAsDataURL(file); }); }

  async function readReferral(src) {
    const st = $id('ob-status'); st.className = 'ob-status'; st.textContent = '✨ Reading…';
    try {
      const content = [];
      if (src.file) {
        const f = src.file;
        if (/^image\//.test(f.type)) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await cxResize(f, 1600, 0.8, 2400000) } });
        else if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
          if (f.size > 2.4 * 1024 * 1024) throw new Error('That PDF is over 2.4 MB — take a photo of the page instead');
          content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: await fileB64(f) } });
        } else if (/\.docx$/i.test(f.name)) content.push({ type: 'text', text: 'Referral document:\n' + (await docxText(f)).slice(0, 30000) });
        else content.push({ type: 'text', text: 'Referral:\n' + (await f.text()).slice(0, 30000) });
      } else {
        if (!src.text) { st.textContent = 'Paste some text first.'; return; }
        content.push({ type: 'text', text: 'Referral:\n' + src.text.slice(0, 30000) });
      }
      const lists = {
        referral_source: options('mp-rs'), gender: options('mp-gender'), right_to_work: options('mp-rtw'), basic_skills: options('mp-bskills'),
        labour_status: options('mp-labour'), interpersonal: options('mp-inter'), risk: options('mp-risk'), safeguarding: options('mp-safe'),
        barriers: Array.from(document.querySelectorAll('#barrier-checks input[type=checkbox]')).map(c => c.value)
      };
      content.push({ type: 'text', text: 'Choose values ONLY from these lists where a list is given:\n' + Object.keys(lists).filter(k => lists[k] && lists[k].length).map(k => k + ': ' + lists[k].join(' | ')).join('\n') +
        '\n\nReturn JSON only: {"title":"","first_name":"","last_name":"","dob":"YYYY-MM-DD","ni":"","phone":"","email":"","address":"first line(s), no postcode","postcode":"","start_date":"YYYY-MM-DD or \\"\\"",' +
        '"referral_source":"","gender":"","right_to_work":"","basic_skills":"","labour_status":"","interpersonal":"","risk":"","safeguarding":"","barriers":[],"background":"2-4 sentence factual summary of the referral for the case file","not_found":["fields you could not find"]}. ' +
        'Use "" for anything not stated. Never guess a date of birth, NI number or contact detail.' });
      const j = await vAI('You read UK employability and support-service referral forms and emails, and extract details exactly as written. Reply with JSON only.', content, 1200);
      const map = { title: 'mp-ptitle', first_name: 'mp-fn', last_name: 'mp-ln', dob: 'mp-dob', ni: 'mp-ni', phone: 'mp-phone', email: 'mp-email', address: 'mp-address', postcode: 'mp-postcode', start_date: 'mp-start',
        referral_source: 'mp-rs', gender: 'mp-gender', right_to_work: 'mp-rtw', basic_skills: 'mp-bskills', labour_status: 'mp-labour', interpersonal: 'mp-inter', risk: 'mp-risk', safeguarding: 'mp-safe' };
      let n = 0; const kept = [];
      Object.keys(map).forEach(k => { const e = $id(map[k]); if (!e || !j[k]) return; const had = e.value && e.value.trim() && e.tagName !== 'SELECT'; if (had && e.value.trim() !== String(j[k]).trim()) { kept.push(k.replace(/_/g, ' ')); return; } if (setField(map[k], j[k])) n++; });
      if (Array.isArray(j.barriers) && j.barriers.length) {
        document.querySelectorAll('#barrier-checks input[type=checkbox]').forEach(cb => { if (j.barriers.includes(cb.value) && !cb.checked) { cb.checked = true; n++; } });
      }
      if (j.background && $id('mp-intake-text') && !$id('mp-intake-text').value.trim()) { $id('mp-intake-text').value = j.background; $id('mp-intake-text').classList.add('ob-filled'); n++; }
      // Open the sections that now have highlighted fields
      document.querySelectorAll('#modal-p details').forEach(d => { if (d.querySelector('.ob-filled')) d.open = true; });
      paintCounts();
      st.innerHTML = '✓ Filled ' + n + ' field' + (n === 1 ? '' : 's') + ' — highlighted for you to check.' +
        (kept.length ? ' Kept what you had already typed for: ' + esc(kept.join(', ')) + '.' : '') +
        (Array.isArray(j.not_found) && j.not_found.length ? ' <span style="color:var(--txt3)">Not in the referral: ' + esc(j.not_found.slice(0, 6).join(', ')) + '.</span>' : '');
      $id('ob-paste').style.display = 'none';
    } catch (e) { st.className = 'ob-status err'; st.textContent = 'Could not read that: ' + (e.message || e); }
  }

  function onOpen(isNew) {
    style(); injectQuick(); injectElig(); loadElig(); FF.answers = {};
    const st = $id('ob-status'); if (st) { st.textContent = ''; st.className = 'ob-status'; }
    if ($id('ob-text')) $id('ob-text').value = '';
    if ($id('ob-paste')) $id('ob-paste').style.display = 'none';
    document.querySelectorAll('#modal-p .ob-filled').forEach(e => e.classList.remove('ob-filled'));
    const ds = document.querySelectorAll('#modal-p details');
    ds.forEach((d, i) => { d.open = i === 0 || (isNew && i === 1); });
    $id('ob-quick').style.display = isNew ? '' : 'none';
    setTimeout(paintCounts, 400);   // after the saved paperwork has loaded in
  }

  function wrapOpeners() {
    ['openAddP', 'openEditP'].forEach(name => {
      const orig = window[name]; if (typeof orig !== 'function' || orig._ob) return;
      window[name] = function () {
        const r = orig.apply(this, arguments);
        try {
          onOpen(name === 'openAddP');
          if (name === 'openAddP' && !window._vorlanaFullAdd) { $id('modal-p').classList.remove('open'); openQuickAdd(); }
          else { tabify(); intakeBanner(); caseloadBar(); }
        } catch (e) { console.warn('[onboarding]', e); }
        return r;
      };
      window[name]._ob = true;
    });
  }

  // ── Eligibility (asked by most UK funder forms) ────────────
  const YN = ['Yes', 'No', 'Prefer not to say'];
  const ELIG = [
    ['in_education', 'In education or training', ['Yes', 'No']],
    ['jobless_household', 'Lives in a jobless household', YN],
    ['single_adult_dependants', 'Single adult household with dependent children', YN],
    ['health_condition', 'Disability or long-term health condition', YN],
    ['sen', 'Special educational need', YN],
    ['offender', 'Offender or ex-offender', YN],
    ['homeless', 'Homeless', YN],
    ['refugee', 'Refugee', YN],
    ['adult_social_care', 'Known to Adult Social Care', YN],
    ['care_leaver', 'Care leaver', YN],
    ['caring_responsibilities', 'Caring responsibilities', YN]
  ];
  const EDU = ['Below primary (ISCED 0)', 'Primary (ISCED 1)', 'Lower secondary (ISCED 2)', 'Upper secondary (ISCED 3)', 'Post-secondary non-tertiary (ISCED 4)', 'Tertiary (ISCED 5–8)'];
  const EDU_FORM = ['Below Primary education (ISCED level 0)', 'Primary education or equivalent (ISCED 1)', 'Lower secondary education or equivalent (ISCED 2)', 'Upper secondary education or equivalent (ISCED 3)', 'Post-secondary (non-tertiary) education or equivalent (ISCED 4)', 'Tertiary education or equivalent (ISCED 5-8)'];
  const NEEDS = ['English', 'Maths', 'Digital', 'Communication', 'Confidence', 'Working with others', 'Time management', 'Motivation to work', 'Motivation to do training', 'CV writing', 'Interview skills'];
  let ELIG_STATE = {};

  function eligHTML() {
    const e = ELIG_STATE;
    const seg = (k, opts) => '<div class="el-seg">' + opts.map(o => '<button type="button" class="' + (e[k] === o ? 'on' : '') + '" data-k="' + k + '" data-v="' + esc(o) + '">' + esc(o === 'Prefer not to say' ? 'Prefer not' : o) + '</button>').join('') + '</div>';
    return '<div style="padding:12px 2px 2px">' +
      '<div class="cxp-s" style="font-size:12px;margin-bottom:10px">Answered once here, then used on every funder form. Tap to choose, tap again to clear.</div>' +
      '<div class="el-grid">' + ELIG.map(([k, l, o]) => '<div class="el-row"><span>' + esc(l) + '</span>' + seg(k, o) + '</div>').join('') + '</div>' +
      '<div class="form-row" style="margin-top:10px"><label>Highest education</label><select id="el-edu"><option value="">—</option>' + EDU.map((x, i) => '<option value="' + i + '"' + (e.education_level === EDU_FORM[i] ? ' selected' : '') + '>' + esc(x) + '</option>').join('') + '</select></div>' +
      '<div class="form-row"><label>Support needs</label><div class="el-chips">' + NEEDS.map(n => '<button type="button" data-need="' + esc(n) + '" class="' + ((e.support_needs || []).includes(n) ? 'on' : '') + '">' + esc(n) + '</button>').join('') + '</div></div>' +
      '<div class="form-grid-2"><div class="form-row"><label>Evidence of eligibility seen</label><input id="el-evidence" maxlength="80" placeholder="e.g. Passport, UC statement" value="' + esc(e.evidence_seen || '') + '"/></div>' +
      '<div class="form-row"><label>Evidence of employment status</label><input id="el-lms" maxlength="80" placeholder="e.g. UC journal, P45" value="' + esc(e.lms_evidence || '') + '"/></div></div>' +
      '<div class="form-row"><label>Postcode of first assessment meeting</label><input id="el-apc" value="' + esc(e.assessment_postcode || '') + '"/></div></div>';
  }
  function injectElig() {
    const modal = document.querySelector('#modal-p .modal'); if (!modal) return;
    let d = $id('el-details');
    if (!d) {
      const all = modal.querySelectorAll('details');
      const pw = Array.from(all).find(x => /paperwork/i.test(x.querySelector('summary').textContent)) || all[all.length - 1];
      d = document.createElement('details'); d.id = 'el-details';
      const sumStyle = pw ? pw.querySelector('summary').getAttribute('style') : '';
      d.innerHTML = '<summary style="' + esc(sumStyle || 'cursor:pointer;padding:10px 12px;margin-top:12px;border-radius:9px;font-weight:700') + '">✅ Eligibility for funder forms</summary><div id="el-body"></div>';
      pw ? pw.parentNode.insertBefore(d, pw.nextSibling) : modal.appendChild(d);
      d.addEventListener('click', ev => {
        const b = ev.target.closest('button'); if (!b) return;
        if (b.dataset.k) { ELIG_STATE[b.dataset.k] = ELIG_STATE[b.dataset.k] === b.dataset.v ? '' : b.dataset.v; drawElig(); }
        if (b.dataset.need) { const s = new Set(ELIG_STATE.support_needs || []); s.has(b.dataset.need) ? s.delete(b.dataset.need) : s.add(b.dataset.need); ELIG_STATE.support_needs = Array.from(s); drawElig(); }
      });
      d.addEventListener('change', readEligInputs);
      d.addEventListener('input', readEligInputs);
    }
    drawElig();
  }
  function drawElig() { const b = $id('el-body'); if (b) b.innerHTML = eligHTML(); paintCounts(); }
  function readEligInputs() {
    const edu = $id('el-edu'); if (edu) ELIG_STATE.education_level = edu.value === '' ? '' : EDU_FORM[+edu.value];
    if ($id('el-evidence')) ELIG_STATE.evidence_seen = val('el-evidence');
    if ($id('el-lms')) ELIG_STATE.lms_evidence = val('el-lms');
    if ($id('el-apc')) ELIG_STATE.assessment_postcode = val('el-apc');
  }
  function loadElig() {
    const p = currentParticipant();
    ELIG_STATE = Object.assign({}, (p && p.paperwork && p.paperwork.eligibility) || {});
    drawElig();
    if (p && sb && String(p.id).indexOf('demo-') !== 0) {
      sb.from('participants').select('paperwork').eq('id', p.id).single().then(({ data }) => {
        if (data && data.paperwork && data.paperwork.eligibility && currentParticipant() === p) { ELIG_STATE = Object.assign({}, data.paperwork.eligibility); p.paperwork = data.paperwork; drawElig(); }
      });
    }
  }

  // ── Funder form filling: set up once, then fill from the saved map ──
  function fmtDate(v) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : (v || ''); }
  function myProfile() {
    const u = (typeof currentUser !== 'undefined' && currentUser) || {};
    const md = u.user_metadata || {};
    let phone = ''; try { phone = localStorage.getItem('vorlana_my_phone') || ''; } catch (e) { /* ignore */ }
    return { keyworker_name: md.full_name || md.name || '', keyworker_email: u.email || '', keyworker_phone: md.phone || phone };
  }
  function gather() {
    readEligInputs();
    const eq = id => val(id).replace(/^Prefer not to say$/i, 'Participant chose not to say');
    const d = Object.assign({
      title: val('mp-ptitle'), forename: val('mp-fn'), surname: val('mp-ln'), full_name: [val('mp-fn'), val('mp-ln')].filter(Boolean).join(' '),
      ni: val('mp-ni'), dob: fmtDate(val('mp-dob')), address: val('mp-address'), postcode: val('mp-postcode'), phone: val('mp-phone'), email: val('mp-email'),
      participant_id: val('mp-pid'), start_date: fmtDate(val('mp-start')), gender: val('mp-gender') || eq('eq-gender'), right_to_work: val('mp-rtw'), basic_skills: val('mp-bskills'),
      labour_status: val('mp-labour'), interpersonal: val('mp-inter'), adviser: val('mp-adv'), referral_source: val('mp-rs'), stage: val('mp-st'),
      outcome_type: val('mp-outcome-type'), job_title: val('mp-job-title'), employer: val('mp-employer'), job_start: fmtDate(val('mp-job-start')),
      hours: val('mp-hours'), pay: val('mp-pay'), exit_date: fmtDate(val('mp-exit-date')), leave_reason: val('mp-leave-reason'), provider: val('mp-provider'), project: val('mp-project'),
      ethnicity: eq('eq-ethnicity'), disability: eq('eq-disability'), age_band: eq('eq-age'),
      organisation: (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || '', today: new Date().toLocaleDateString('en-GB'),
      barriers: Array.from(document.querySelectorAll('#barrier-checks input:checked')).map(c => c.value)
    }, myProfile());
    Object.keys(ELIG_STATE).forEach(k => { if (ELIG_STATE[k] !== '' && ELIG_STATE[k] != null) d[k] = ELIG_STATE[k]; });
    if (!d.interpersonal && Array.isArray(d.support_needs)) d.interpersonal = d.support_needs.length ? 'Yes' : '';
    const cp = currentParticipant();
    const sig = cp && cp.paperwork && cp.paperwork.signature;
    if (sig && sig.png) { d.signature_png = sig.png; d.signed_name = sig.signed_name; d.signed_date = new Date(sig.signed_at).toLocaleDateString('en-GB'); }
    return d;
  }
  function currentParticipant() { return (typeof _editPId !== 'undefined' && _editPId) ? (DB.participants || []).find(x => x.id === _editPId) : null; }

  const FF = { forms: [], pick: null, oneOff: null, map: null, answers: {} };
  function ffModal(html, w) {
    let m = $id('ff-modal');
    if (!m) { m = document.createElement('div'); m.className = 'modal-overlay'; m.id = 'ff-modal'; m.style.zIndex = 600; m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }); document.body.appendChild(m); }
    m.innerHTML = '<div class="modal" style="max-width:' + (w || 560) + 'px">' + html + '</div>';
    m.classList.add('open');
  }
  function ffClose() { const m = $id('ff-modal'); if (m) m.classList.remove('open'); }
  function formKey() { return FF.oneOff ? 'file:' + FF.oneOff.name + ':' + FF.oneOff.data.length : 'contract:' + FF.pick; }
  function formLabel() { return FF.oneOff ? FF.oneOff.name.replace(/\.docx$/i, '') : ((FF.forms.find(r => String(r.id) === FF.pick) || {}).name || 'Form'); }
  async function formDoc() {
    if (FF.oneOff) return FF.oneOff.data;
    const { data, error } = await sb.from('contracts').select('template_data').eq('id', FF.pick).single();
    if (error || !data) throw new Error('Could not load that form');
    return data.template_data;
  }
  async function api(body) {
    const tok = typeof vToken === 'function' ? vToken : async () => { const { data: { session } } = await sb.auth.getSession(); return session ? session.access_token : ''; };
    const post = async force => fetch('/api/fill-form', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await tok(force)) }, body: JSON.stringify(body) });
    let res = await post(false);
    if (res.status === 401) res = await post(true);
    let j; try { j = await res.json(); } catch (e) { throw new Error(res.status === 504 ? 'That took too long — try again' : 'The form filler is not responding (HTTP ' + res.status + ')'); }
    if (res.status === 409) { const e = new Error(j.error); e.changed = true; throw e; }
    if (!j || j.ok !== true) throw new Error((j && j.error) || 'HTTP ' + res.status);
    return j;
  }

  async function openFill() {
    style();
    Object.assign(FF, { pick: null, oneOff: null, map: null });
    ffModal('<h2>📄 Fill a funder form</h2><div class="cxp-s" style="font-size:13px">Loading forms…</div>');
    let rows = [];
    try { const { data } = await sb.from('contracts').select('id,name,template_name').eq('org_id', orgId).not('template_data', 'is', null); rows = data || []; } catch (e) { rows = []; }
    const linked = (typeof getSelectedContractIds === 'function') ? getSelectedContractIds().map(String) : [];
    rows.sort((a, b) => (linked.includes(String(b.id)) ? 1 : 0) - (linked.includes(String(a.id)) ? 1 : 0));
    FF.forms = rows; if (rows.length) FF.pick = String(rows[0].id);
    drawPicker(linked);
  }
  function drawPicker(linked) {
    const who = [val('mp-fn'), val('mp-ln')].filter(Boolean).join(' ') || 'this participant';
    ffModal('<h2>📄 Fill a funder form</h2><div class="cxp-s" style="font-size:13px;margin-bottom:6px">For <b>' + esc(who) + '</b> — answers come from their record.</div>' +
      '<div class="ff-list">' + FF.forms.map(r => '<div class="ff-opt ' + (FF.pick === String(r.id) && !FF.oneOff ? 'on' : '') + '" data-id="' + esc(r.id) + '"><div>📄</div><div><b>' + esc(r.name) + '</b><span>' + esc(r.template_name || 'form.docx') + (linked.includes(String(r.id)) ? ' · linked to this participant' : '') + '</span></div></div>').join('') +
        '<label class="ff-opt ' + (FF.oneOff ? 'on' : '') + '" style="margin:0"><div>⬆</div><div><b>' + (FF.oneOff ? esc(FF.oneOff.name) : 'Use a different form') + '</b><span>' + (FF.oneOff ? 'Ready' : 'Upload any funder\'s blank Word form (.docx)') + '</span></div><input type="file" id="ff-file" accept=".docx" style="display:none"/></label></div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" id="ff-cancel">Cancel</button><button class="btn btn-p" id="ff-go"' + (FF.pick || FF.oneOff ? '' : ' disabled') + '>Next</button></div>');
    document.querySelectorAll('#ff-modal .ff-opt[data-id]').forEach(el => el.onclick = () => { FF.pick = el.getAttribute('data-id'); FF.oneOff = null; drawPicker(linked); });
    $id('ff-file').onchange = async ev => {
      const f = ev.target.files && ev.target.files[0]; if (!f) return;
      if (!/\.docx$/i.test(f.name)) { alert('Please choose a Word .docx file. (Older .doc: open in Word and Save As .docx.)'); return; }
      if (f.size > 3 * 1024 * 1024) { alert('That file is over 3 MB — funder forms are usually much smaller.'); return; }
      FF.oneOff = { name: f.name, data: await fileB64(f) }; FF.pick = null; drawPicker(linked);
    };
    $id('ff-cancel').onclick = ffClose;
    $id('ff-go').onclick = () => start();
  }

  async function start() {
    ffModal('<h2>📄 ' + esc(formLabel()) + '</h2><div class="cxp-s">Checking the form…</div>');
    try {
      const { data } = await sb.from('form_maps').select('*').eq('org_id', orgId).eq('form_key', formKey()).maybeSingle();
      if (data && data.items) { FF.map = { id: data.id, formHash: data.form_hash, items: data.items }; return runFill(); }
    } catch (e) { /* no table yet: set up without saving */ }
    if (!isManager()) {
      ffModal('<h2>📄 ' + esc(formLabel()) + '</h2><div class="cxp-s" style="font-size:13px;line-height:1.6">This form hasn\'t been set up yet. A manager sets it up once under <b>Funders → Contracts → 🧭 Set up form</b>, then it fills itself for everyone.</div><div class="modal-footer"><button class="btn btn-p" id="ff-ok">OK</button></div>');
      $id('ff-ok').onclick = ffClose; return;
    }
    setup();
  }

  // One-time set-up: every question, and where its answer comes from
  const FIELD_NAMES = {};
  async function setup() {
    ffModal('<h2>🧭 Set up this form</h2><div class="cxp-s" style="font-size:13px;line-height:1.6">✨ Reading every question on <b>' + esc(formLabel()) + '</b> and matching it to Vorlana. You only do this once per form — about 20 seconds.</div>');
    try {
      const j = await api({ action: 'map', docxBase64: await formDoc(), orgId });
      Object.assign(FIELD_NAMES, j.fields || {});
      FF.map = { formHash: j.formHash, items: j.items };
      drawSetup();
    } catch (e) { fail(e); }
  }
  function useOpts(it) {
    const cur = it.use === 'field' ? 'f:' + it.field : it.use;
    return '<option value="ask"' + (cur === 'ask' ? ' selected' : '') + '>Ask me each time</option>' +
      Object.keys(FIELD_NAMES).map(k => '<option value="f:' + k + '"' + (cur === 'f:' + k ? ' selected' : '') + '>' + esc(FIELD_NAMES[k].replace(/\s*\(.*$/, '')) + '</option>').join('') +
      '<option value="sign"' + (cur === 'sign' ? ' selected' : '') + '>Leave blank — completed at signing</option>' +
      '<option value="skip"' + (cur === 'skip' ? ' selected' : '') + '>Not a question</option>';
  }
  function drawSetup() {
    const items = FF.map.items;
    const q = items.filter(i => i.use !== 'skip');
    const sk = items.filter(i => i.use === 'skip');
    const row = it => '<div class="fm-row"><div class="fm-q"><b>' + esc(it.label.length > 110 ? it.label.slice(0, 110) + '…' : it.label) + '</b><span>' +
      ({ text: 'Text', inline: 'Text', choice: 'Tick one', grid: 'Yes / No' }[it.type] || it.type) + (it.boxes ? ' · letter boxes' : '') + (it.options ? ' · ' + esc(it.options.slice(0, 4).join(', ')) + (it.options.length > 4 ? '…' : '') : '') + '</span></div>' +
      '<select data-id="' + esc(it.id) + '">' + useOpts(it) + '</select></div>';
    ffModal('<h2>🧭 Check the set-up</h2>' +
      '<div class="cxp-s" style="font-size:13px;margin-bottom:10px">' + q.length + ' questions found on <b>' + esc(formLabel()) + '</b>. Each one shows where its answer comes from — change any that look wrong. Saved for everyone in your team.</div>' +
      '<div class="fm-list">' + q.map(row).join('') +
      (sk.length ? '<details style="margin-top:8px"><summary class="cxp-s" style="cursor:pointer">' + sk.length + ' headings and notes ignored</summary>' + sk.map(row).join('') + '</details>' : '') + '</div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" id="fm-x">Cancel</button><button class="btn btn-p" id="fm-save">Save &amp; fill</button></div>', 720);
    document.querySelectorAll('#ff-modal select[data-id]').forEach(s => s.onchange = () => {
      const it = items.find(i => i.id === s.dataset.id); const v = s.value;
      if (v.indexOf('f:') === 0) { it.use = 'field'; it.field = v.slice(2); } else { it.use = v; delete it.field; }
    });
    $id('fm-x').onclick = ffClose;
    $id('fm-save').onclick = async () => {
      const row = { org_id: orgId, form_key: formKey(), form_name: formLabel(), form_hash: FF.map.formHash, items: FF.map.items.map(({ id, type, label, use, field, options, boxes }) => ({ id, type, label, use, field, options, boxes })), updated_at: new Date().toISOString() };
      try {
        const { data, error } = await sb.from('form_maps').upsert(row, { onConflict: 'org_id,form_key' }).select('id').single();
        if (error) throw error;
        FF.map.id = data.id;
      } catch (e) { alert((FF.setupOnly ? 'The set-up could not be saved' : 'Filled this time, but the set-up could not be saved') + ' (' + (e.message || e) + '). Run form-maps.sql in Supabase so it is remembered.'); }
      if (FF.setupOnly) {
        FF.setupOnly = false; delete MAPS[FF.pick];
        ffModal('<h2>✓ Form set up</h2><div class="cxp-s" style="font-size:13px;line-height:1.6">Advisers can now pick this contract when adding someone and the start form fills itself.</div><div class="modal-footer"><button class="btn btn-p" id="ff-ok">Done</button></div>');
        $id('ff-ok').onclick = () => { ffClose(); if (FF.afterSetup) FF.afterSetup(); try { addSetupButtons(); } catch (e) { /* page changed */ } };
        return;
      }
      runFill();
    };
  }

  function fail(e) {
    ffModal('<h2>📄 Something went wrong</h2><div style="color:var(--red);font-size:13px;margin-bottom:10px">' + esc(e.message || e) + '</div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" id="ff-x">Close</button>' + (e.changed ? '<button class="btn btn-p" id="ff-re">Set up again</button>' : '<button class="btn btn-p" id="ff-re">Try again</button>') + '</div>');
    $id('ff-x').onclick = ffClose; $id('ff-re').onclick = () => e.changed ? setup() : runFill();
  }

  function savedAnswers() {
    const p = currentParticipant();
    const all = (p && p.paperwork && p.paperwork.form_answers) || {};
    return Object.assign({}, all[formKey()] || {}, FF.answers);
  }

  async function runFill() {
    const who = [val('mp-fn'), val('mp-ln')].filter(Boolean).join(' ');
    ffModal('<h2>📄 Filling…</h2><div class="cxp-s" style="font-size:13px">Writing ' + esc(who || 'the participant') + '\'s answers into ' + esc(formLabel()) + '.</div>');
    try {
      const j = await api({ docxBase64: await formDoc(), filename: (formLabel() + ' - ' + who).trim(), orgId, data: gather(), map: FF.map, answers: savedAnswers() });
      showResult(j);
    } catch (e) { fail(e); }
  }

  // Keep a copy of every filled form on the participant, in the Evidence Hub (private storage)
  async function saveToEvidence(p, j, formName, contractId) {
    if (!p || String(p.id).indexOf('demo-') === 0 || !j || !j.filledBase64) return false;
    try {
      const bin = atob(j.filledBase64); const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const fname = (j.filename || (formName || 'form') + '.docx').replace(/[^\w .()-]+/g, '_');
      const path = orgId + '/' + p.id + '/' + Date.now() + '-' + fname;
      const up = await sb.storage.from('participant-docs').upload(path, new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), { upsert: false });
      if (up.error) throw up.error;
      const me = myProfile();
      const signed = (j.preview || []).some(x => x.source === 'signature');
      const row = { org_id: orgId, participant_id: String(p.id), participant_name: [p.first_name, p.last_name].filter(Boolean).join(' '), type: formName || 'Funder form',
        linked_outcome: /end|exit|leav/i.test(formName || '') ? 'Programme end' : 'Programme start', staff: me.keyworker_name || me.keyworker_email || '',
        evidence_date: new Date().toISOString().slice(0, 10), status: signed && !(j.missing || []).length ? 'Verified' : 'Pending', file_path: path, file_name: fname, source: 'form filler' };
      if (contractId) row.contract_id = String(contractId);
      const ins = await sb.from('evidence').insert([row]);
      if (ins.error) throw ins.error;
      if (typeof refreshTable === 'function') refreshTable('evidence').catch(() => {});
      return true;
    } catch (e) {
      console.warn('[forms] not saved to Evidence Hub', e);
      if (/bucket|not found|column|policy|row-level/i.test(e.message || '')) alert('The form downloaded but could not be saved to the Evidence Hub yet — run evidence-files.sql in Supabase.');
      return false;
    }
  }

  function download(j) {
    const bin = atob(j.filledBase64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    a.download = j.filename || 'form-FILLED.docx'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function showResult(j) {
    const filled = (j.preview || []).length, miss = j.missing || [];
    const ask = m => {
      const opts = m.options && m.options.length ? m.options : (/\?\s*$/.test(m.text) ? ['Yes', 'No'] : null);
      return '<div class="form-row" data-mid="' + esc(m.id) + '"><label style="text-transform:none;letter-spacing:0;font-size:12.5px">' + esc(m.text.replace(/[:_.\s]+$/, '')) + '</label>' +
        (opts ? '<div class="el-seg wrap">' + opts.map(o => '<button type="button" data-v="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>'
              : '<input class="ff-add" data-mid="' + esc(m.id) + '"/>') + '</div>';
    };
    ffModal('<h2>📄 ' + (miss.length ? 'Nearly there' : 'Form filled') + '</h2>' +
      '<div class="ff-ok">✓ ' + filled + ' answer' + (filled === 1 ? '' : 's') + ' filled in.' + (miss.length ? '' : ' Check it over before sending.') + '</div>' +
      (miss.length ? '<div class="ff-miss"><div style="font-size:13px;font-weight:700;margin-bottom:8px">' + miss.length + ' still to answer — saved to this person\'s record for next time</div>' + miss.map(ask).join('') + '</div>' : '') +
      '<div class="modal-footer" style="flex-wrap:wrap"><a href="#" id="ff-edit" class="cxp-s" style="margin-right:auto">Edit form set-up</a><button class="btn btn-ghost" id="ff-done">Close</button>' +
        (miss.length ? '<button class="btn btn-ghost" id="ff-dl2">Download as is</button><button class="btn btn-p" id="ff-again">Save &amp; fill again</button>' : '<button class="btn btn-p" id="ff-dl">⬇ Download</button>') + '</div>', 600);
    document.querySelectorAll('#ff-modal .el-seg button').forEach(b => b.onclick = () => { b.parentNode.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); });
    $id('ff-done').onclick = ffClose;
    $id('ff-edit').onclick = ev => { ev.preventDefault(); if (!FIELD_NAMES.title) { setup(); } else drawSetup(); };
    const keep = async btn => {
      download(j);
      if (btn && btn.dataset.saved) return;
      const ok = await saveToEvidence(currentParticipant(), j, formLabel(), FF.oneOff ? null : FF.pick);
      if (ok && btn) { btn.dataset.saved = '1'; btn.insertAdjacentHTML('afterend', '<span class="cxp-s" style="margin-left:6px">✓ Saved to Evidence Hub</span>'); }
    };
    if ($id('ff-dl')) $id('ff-dl').onclick = () => keep($id('ff-dl'));
    if ($id('ff-dl2')) $id('ff-dl2').onclick = () => keep($id('ff-dl2'));
    if ($id('ff-again')) $id('ff-again').onclick = async () => {
      const toElig = {};
      miss.forEach(m => {
        const box = Array.from(document.querySelectorAll('#ff-modal div.form-row[data-mid]')).find(x => x.getAttribute('data-mid') === String(m.id)); if (!box) return;
        const on = box.querySelector('button.on'); const inp = box.querySelector('input');
        const v = on ? on.dataset.v : (inp ? inp.value.trim() : '');
        if (!v) return;
        FF.answers[m.id] = v;
        if (m.field && (ELIG.some(e => e[0] === m.field) || ['education_level', 'evidence_seen', 'lms_evidence', 'assessment_postcode'].includes(m.field))) toElig[m.field] = v;
        if (m.field === 'keyworker_phone') { try { localStorage.setItem('vorlana_my_phone', v); } catch (e) { /* ignore */ } }
      });
      Object.assign(ELIG_STATE, toElig); drawElig();
      await saveParticipantExtras();
      runFill();
    };
  }

  // Keep eligibility and per-form answers on the participant (paperwork JSON)
  async function saveParticipantExtras(pid) {
    const p = pid ? (DB.participants || []).find(x => x.id === pid) : currentParticipant();
    if (!p || String(p.id).indexOf('demo-') === 0) return;
    try {
      const { data } = await sb.from('participants').select('paperwork').eq('id', p.id).single();
      const pw = Object.assign({}, (data && data.paperwork) || {});
      readEligInputs();
      pw.eligibility = Object.assign({}, ELIG_STATE);
      if (Object.keys(FF.answers).length && (FF.pick || FF.oneOff)) {
        pw.form_answers = Object.assign({}, pw.form_answers || {});
        pw.form_answers[formKey()] = Object.assign({}, pw.form_answers[formKey()] || {}, FF.answers);
      }
      await sb.from('participants').update({ paperwork: pw }).eq('id', p.id);
      p.paperwork = pw;
    } catch (e) { console.warn('[forms] could not save extra answers', e); }
  }

  // Saving the participant rebuilds "paperwork" from the form — put eligibility and form answers back
  function wrapSave() {
    const orig = window.saveP; if (typeof orig !== 'function' || orig._ob) return;
    window.saveP = async function () {
      const before = currentParticipant();
      const keep = before && before.paperwork ? { form_answers: before.paperwork.form_answers, extra: before.paperwork.extra } : {};
      const names = [val('mp-fn'), val('mp-ln')];
      readEligInputs();
      const elig = Object.assign({}, ELIG_STATE);
      const r = await orig.apply(this, arguments);
      setTimeout(afterConvertSave, 0);
      let p = before;
      if (!p) p = (DB.participants || []).filter(x => x.first_name === names[0] && x.last_name === names[1]).slice(-1)[0];
      if (p && String(p.id).indexOf('demo-') !== 0) {
        try {
          const { data } = await sb.from('participants').select('paperwork').eq('id', p.id).single();
          const pw = Object.assign({}, (data && data.paperwork) || {}, { eligibility: elig });
          if (keep.form_answers) pw.form_answers = keep.form_answers;
          if (keep.extra) pw.extra = keep.extra;
          await sb.from('participants').update({ paperwork: pw }).eq('id', p.id);
          p.paperwork = pw;
        } catch (e) { /* non-fatal */ }
      }
      return r;
    };
    window.saveP._ob = true;
  }

  // ── Quick add: the 30-second version of "Add participant" ────
  // Only what's needed to start working with someone. Everything else
  // is filled in later on their record (tabs), when it's known.
  let QA_OPEN = false;
  function qaStyle() {
    if ($id('qa-style')) return;
    const s = document.createElement('style'); s.id = 'qa-style';
    s.textContent = `
#qa-modal .modal{max-width:600px}
.qa-note{font-size:12.5px;color:var(--txt3);background:var(--bg);border-radius:8px;padding:8px 10px;margin-bottom:10px}
.qa-form{border:1px solid var(--border);border-radius:12px;padding:10px 12px;margin-bottom:12px}
.qa-form-h{font-size:13px;font-weight:700;margin-bottom:6px}.qa-form-h span{font-weight:400;color:var(--txt3);font-size:12px}
.qa-q{padding:7px 0;border-top:1px solid var(--border)}.qa-q>span{display:block;font-size:12.5px;color:var(--txt);margin-bottom:5px}
.qa-q input{font-size:13px;padding:6px 9px}
.qa-drop{border:1.5px dashed rgba(31,111,109,.4);background:rgba(31,111,109,.05);border-radius:12px;padding:14px;text-align:center;margin-bottom:14px}
.qa-drop b{color:var(--em);font-size:14px}.qa-drop p{font-size:12px;color:var(--txt3);margin:4px 0 10px}
.qa-drop.drag{background:rgba(31,111,109,.12)}
.qa-chips{display:flex;flex-wrap:wrap;gap:6px}
.qa-chips button{border:1px solid var(--border);background:var(--surface);border-radius:16px;padding:6px 12px;font-size:12.5px;color:var(--txt2);cursor:pointer}
.qa-chips button.on{background:var(--em);border-color:var(--em);color:#fff;font-weight:600}
.qa-dupe{background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;border-radius:8px;padding:8px 10px;font-size:12.5px;margin-bottom:10px}
.qa-more{font-size:12.5px;color:var(--txt3);text-align:center;margin-top:4px}
/* record as tabs */
#modal-p.tabbed .modal{max-width:760px;padding-top:18px}
.pt-bar{display:flex;gap:2px;overflow-x:auto;border-bottom:1px solid var(--border);margin:6px -4px 14px;padding:0 4px;scrollbar-width:none;position:sticky;top:-24px;background:var(--surface);z-index:2}
.pt-bar::-webkit-scrollbar{display:none}
.pt-bar button{border:none;background:none;padding:10px 12px;font-size:13px;color:var(--txt3);white-space:nowrap;border-bottom:2px solid transparent;cursor:pointer}
.pt-bar button.on{color:var(--em);border-bottom-color:var(--em);font-weight:700}
.pt-bar button small{display:inline-block;margin-left:5px;font-size:10.5px;font-weight:600;background:var(--bg);border-radius:8px;padding:1px 6px;color:var(--txt3)}
.pt-bar button small.done{background:rgba(31,111,109,.1);color:var(--em)}
#modal-p.tabbed details>summary{display:none}
#modal-p.tabbed details{border:none;margin:0}
#modal-p.tabbed .modal-footer{position:sticky;bottom:-24px;background:var(--surface);padding:12px 0;margin-bottom:-12px;z-index:2}`;
    document.head.appendChild(s);
  }

  function qaModal() {
    let m = $id('qa-modal');
    if (!m) { m = document.createElement('div'); m.className = 'modal-overlay'; m.id = 'qa-modal'; m.addEventListener('click', e => { if (e.target === m) qaClose(); }); document.body.appendChild(m); }
    return m;
  }
  function qaClose() { const m = $id('qa-modal'); if (m) m.classList.remove('open'); QA_OPEN = false; }
  const QA = { rs: '', contracts: [], answers: {} };

  function openQuickAdd() {
    qaStyle(); style();
    QA.rs = ''; QA.contracts = []; QA.answers = {};
    const rs = options('mp-rs') || [];
    const cons = (DB.contracts || []);
    const advs = options('mp-adv') || [];
    const m = qaModal();
    m.innerHTML = '<div class="modal"><h2>Add participant</h2>' +
      '<div class="qa-drop" id="qa-drop"><b>✨ Start from a referral</b><p>Drop a PDF or Word file here, take a photo of a paper form, or paste the email — we\'ll fill this in.</p>' +
        '<label class="btn btn-p btn-sm" style="margin:0 4px;cursor:pointer">📷 Photo / file<input type="file" id="qa-file" accept="image/*,.pdf,.docx,.txt" style="display:none"/></label>' +
        '<button class="btn btn-ghost btn-sm" type="button" id="qa-paste">📋 Paste text</button>' +
        '<div id="qa-paste-box" style="display:none;margin-top:10px"><textarea id="qa-text" style="min-height:80px;font-size:13px" placeholder="Paste the referral here…"></textarea><div style="text-align:right;margin-top:6px"><button class="btn btn-p btn-sm" id="qa-read" type="button">Fill it in</button></div></div>' +
        '<div class="ob-status" id="qa-status"></div></div>' +
      '<div id="qa-dupe"></div>' +
      '<div class="form-grid-2"><div class="form-row"><label>First name *</label><input id="qa-fn" autocomplete="off"/></div><div class="form-row"><label>Last name</label><input id="qa-ln" autocomplete="off"/></div></div>' +
      '<div class="form-grid-2"><div class="form-row"><label>Phone</label><input id="qa-phone" inputmode="tel"/></div><div class="form-row"><label>Email</label><input id="qa-email" type="email"/></div></div>' +
      '<div class="form-grid-2"><div class="form-row"><label>Date of birth</label><input id="qa-dob" type="date"/></div><div class="form-row"><label>Postcode</label><input id="qa-pc" style="text-transform:uppercase"/></div></div>' +
      '<div class="form-row"><label>Referred by</label><div class="qa-chips" id="qa-rs">' + rs.map(o => '<button type="button" data-v="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div></div>' +
      (cons.length ? '<div class="form-row"><label>Funded under</label><div class="qa-chips" id="qa-con">' + cons.filter(c => c.status !== 'closed').map(c => '<button type="button" data-v="' + esc(c.id) + '">' + esc(c.name) + '</button>').join('') + '</div></div>' : '') +
      '<div id="qa-forms"></div>' +
      (advs.length ? '<div class="form-row"><label>Adviser</label><select id="qa-adv">' + advs.map(o => '<option>' + esc(o) + '</option>').join('') + '</select></div>' : '') +
      '<div class="modal-footer" style="flex-wrap:wrap"><button class="btn btn-ghost" id="qa-cancel">Cancel</button><button class="btn btn-ghost" id="qa-full">Add &amp; open record</button><button class="btn btn-ghost" id="qa-link">📱 Add &amp; send them a link</button><button class="btn btn-p" id="qa-save">Add participant</button></div>' +
      '<div class="qa-more">Everything else — eligibility, notes, paperwork — can be added on their record when you have it.</div></div>';
    m.classList.add('open'); QA_OPEN = true;
    setTimeout(() => $id('qa-fn').focus(), 50);
    const chips = (id, multi) => { const box = $id(id); if (!box) return; box.onclick = ev => { const b = ev.target.closest('button'); if (!b) return;
      if (multi) { b.classList.toggle('on'); QA.contracts = Array.from(box.querySelectorAll('button.on')).map(x => x.dataset.v); drawQAForms(); }
      else { const was = b.classList.contains('on'); box.querySelectorAll('button').forEach(x => x.classList.remove('on')); if (!was) b.classList.add('on'); QA.rs = was ? '' : b.dataset.v; } }; };
    chips('qa-rs', false); chips('qa-con', true);
    ['qa-fn', 'qa-ln', 'qa-dob'].forEach(id => $id(id).addEventListener('input', checkDupe));
    $id('qa-cancel').onclick = qaClose;
    $id('qa-save').onclick = () => qaSave(false);
    $id('qa-full').onclick = () => qaSave(true);
    $id('qa-link').onclick = () => qaSave('link');
    $id('qa-paste').onclick = () => { const b = $id('qa-paste-box'); b.style.display = b.style.display === 'none' ? '' : 'none'; if (b.style.display === '') $id('qa-text').focus(); };
    $id('qa-read').onclick = () => qaRead({ text: val('qa-text') });
    $id('qa-file').onchange = ev => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ''; if (f) qaRead({ file: f }); };
    const drop = $id('qa-drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('drag'); const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) qaRead({ file: f }); });
  }

  // Reads the referral into the full form (hidden), then copies the essentials across
  async function qaRead(src) {
    const st = $id('qa-status'); st.className = 'ob-status'; st.textContent = '✨ Reading…';
    const obStatus = $id('ob-status');
    await readReferral(src);
    const msg = obStatus ? obStatus.innerHTML : '';
    [['qa-fn', 'mp-fn'], ['qa-ln', 'mp-ln'], ['qa-phone', 'mp-phone'], ['qa-email', 'mp-email'], ['qa-dob', 'mp-dob'], ['qa-pc', 'mp-postcode']].forEach(([a, b]) => {
      if (!val(a) && val(b)) { $id(a).value = val(b); $id(a).classList.add('ob-filled'); }
    });
    const rs = val('mp-rs'); if (rs && !QA.rs) { QA.rs = rs; document.querySelectorAll('#qa-rs button').forEach(x => x.classList.toggle('on', x.dataset.v === rs)); }
    st.className = obStatus ? obStatus.className : 'ob-status'; st.innerHTML = msg.replace('highlighted for you to check', 'check below — the rest is saved on their record');
    $id('qa-paste-box').style.display = 'none';
    checkDupe();
  }

  function checkDupe() {
    const fn = val('qa-fn').toLowerCase(), ln = val('qa-ln').toLowerCase(), box = $id('qa-dupe');
    if (!box) return;
    if (fn.length < 2 || ln.length < 2) { box.innerHTML = ''; return; }
    const hit = (DB.participants || []).find(p => (p.first_name || '').toLowerCase() === fn && (p.last_name || '').toLowerCase() === ln);
    box.innerHTML = hit ? '<div class="qa-dupe">⚠ ' + esc(hit.first_name + ' ' + hit.last_name) + ' is already on your caseload (' + esc(hit.stage) + '). <a href="#" id="qa-open-dupe">Open their record</a> instead?</div>' : '';
    if (hit) $id('qa-open-dupe').onclick = ev => { ev.preventDefault(); qaClose(); openEditP(hit.id); };
  }

  async function qaSave(openAfter) {
    if (!val('qa-fn')) { $id('qa-fn').focus(); $id('qa-fn').classList.add('ob-filled'); return; }
    const btn = $id('qa-save'); btn.disabled = true; btn.textContent = 'Adding…';
    // Copy into the full form (already reset by openAddP) and save with the normal save
    const set = (id, v) => { const e = $id(id); if (e && v != null && v !== '') e.value = v; };
    set('mp-fn', val('qa-fn')); set('mp-ln', val('qa-ln')); set('mp-phone', val('qa-phone')); set('mp-email', val('qa-email'));
    set('mp-dob', val('qa-dob')); set('mp-postcode', val('qa-pc').toUpperCase()); if (QA.rs) set('mp-rs', QA.rs); if ($id('qa-adv')) set('mp-adv', val('qa-adv'));
    if (!val('mp-start')) set('mp-start', new Date().toISOString().slice(0, 10));
    if (typeof renderContractSelector === 'function') renderContractSelector(QA.contracts);
    const names = [val('mp-fn'), val('mp-ln')];
    const data = gather();
    // Already supported? Checked on the server so nobody sees a colleague's participant
    const dupe = await serverDupeCheck(null);
    let addedAnyway = false;
    if (dupe.match) {
      const choice = await askDupe(dupe);
      if (choice === 'open') { qaClose(); if (dupe.id) openEditP(dupe.id); return; }
      if (choice === 'stop') { qaClose(); if (typeof toast === 'function') toast('Your manager has been told'); return; }
      addedAnyway = !dupe.visible;
    }
    try {
      await window.saveP();
      const p = (DB.participants || []).filter(x => x.first_name === names[0] && x.last_name === names[1]).slice(-1)[0];
      if (addedAnyway && p) serverDupeCheck(p.id);   // flag the second record for a manager to check
      let msg = '✓ Added ' + names.join(' ');
      if (QA.contracts.length && openAfter !== 'link') {   // with a link, the form is filled once they've signed
        btn.textContent = 'Filling start form…';
        const r = await autoFillStartForms(p, data);
        if (r.done.length) msg += ' · start form downloaded';
        if (r.todo.length) msg += ' · ' + r.todo.join('; ');
      }
      qaClose();
      if (typeof toast === 'function') toast(msg); else if (/to answer|could not/.test(msg)) alert(msg);
      if (openAfter === 'link' && p) sendIntake(p, { forename: p.first_name, surname: p.last_name, phone: p.phone, email: p.email, dob: val('qa-dob'), postcode: val('qa-pc').toUpperCase() }, QA.contracts);
      else if (openAfter && p) openEditP(p.id);
    } catch (e) { alert('Could not add: ' + (e.message || e)); btn.disabled = false; btn.textContent = 'Add participant'; }
  }

  // ── The record as tabs instead of a long list of folded sections ──
  function tabify(firstTab) {
    const modal = $id('modal-p'); if (!modal) return;
    const box = modal.querySelector('.modal');
    const ds = Array.from(box.querySelectorAll(':scope > details'));
    if (!ds.length) return;
    qaStyle();
    modal.classList.add('tabbed');
    const NAMES = [[/participant details/i, 'Details'], [/referral|journey/i, 'Journey'], [/assessment|notes/i, 'Notes & scores'], [/paperwork/i, 'Paperwork'], [/eligib/i, 'Eligibility'], [/job/i, 'Job outcome']];
    const short = t => { const n = NAMES.find(x => x[0].test(t)); return n ? n[1] : t.replace(/^[^A-Za-z]+/, '').replace(/\s*\d+ of \d+ filled.*/, '').trim().split(' ').slice(0, 2).join(' '); };
    let bar = $id('pt-bar');
    if (!bar) { bar = document.createElement('div'); bar.id = 'pt-bar'; bar.className = 'pt-bar'; box.insertBefore(bar, ds[0]); }
    // Anything the extensions add between sections (e.g. demographics) goes on its own tab
    const demo = Array.from(box.children).find(x => x.tagName !== 'DETAILS' && /Demographics \(optional\)/.test(x.textContent || '') && !x.contains(bar));
    const tabs = ds.map(d => ({ el: d, name: short(d.querySelector('summary').textContent) }));
    if (demo) tabs.push({ el: demo, name: 'Demographics' });
    const paint = () => {
      bar.innerHTML = tabs.map((t, i) => {
        const c = t.el.tagName === 'DETAILS' ? sectionCount(t.el) : null;
        return '<button type="button" data-i="' + i + '" class="' + (t.el.style.display !== 'none' ? 'on' : '') + '">' + esc(t.name) +
          (c && c.t ? '<small class="' + (c.f === c.t ? 'done' : '') + '">' + c.f + '/' + c.t + '</small>' : '') + '</button>';
      }).join('');
    };
    const show = i => { tabs.forEach((t, k) => { t.el.style.display = k === i ? '' : 'none'; if (t.el.tagName === 'DETAILS') t.el.open = true; }); paint(); };
    bar.onclick = ev => { const b = ev.target.closest('button'); if (b) show(+b.dataset.i); };
    box.addEventListener('input', paint); box.addEventListener('change', paint);
    const want = firstTab ? tabs.findIndex(t => new RegExp(firstTab, 'i').test(t.name)) : 0;
    show(want >= 0 ? want : 0);
  }

  // ── Contract start forms: set up by a manager, filled automatically on "Add participant" ──
  const isManager = () => typeof currentRole === 'undefined' || !currentRole || /manager|admin|owner|super/i.test(currentRole);
  const MAPS = {};   // contractId → saved map (or null)
  async function loadMap(contractId) {
    if (contractId in MAPS) return MAPS[contractId];
    try {
      const { data } = await sb.from('form_maps').select('*').eq('org_id', orgId).eq('form_key', 'contract:' + contractId).maybeSingle();
      MAPS[contractId] = data && data.items ? { id: data.id, formHash: data.form_hash, items: data.items, name: data.form_name } : null;
    } catch (e) { MAPS[contractId] = null; }
    return MAPS[contractId];
  }
  // What the adviser needs to tick on the quick-add screen: questions not covered by the quick fields or the referral
  const QUICK_COVERED = ['title', 'forename', 'surname', 'full_name', 'dob', 'ni', 'phone', 'email', 'address', 'postcode', 'participant_id', 'start_date',
    'provider', 'project', 'referral_source', 'adviser', 'keyworker_name', 'keyworker_email', 'keyworker_phone', 'today', 'organisation',
    'employer', 'job_title', 'job_start', 'hours', 'pay', 'exit_date', 'leave_reason', 'outcome_type'];
  function quickQuestions(map) {
    return (map.items || []).filter(it => it.use === 'ask' || (it.use === 'field' && !QUICK_COVERED.includes(it.field)));
  }
  async function drawQAForms() {
    const box = $id('qa-forms'); if (!box) return;
    const withForms = [];
    for (const cid of QA.contracts) {
      const c = (DB.contracts || []).find(x => String(x.id) === String(cid)); if (!c) continue;
      const map = await loadMap(cid);
      withForms.push({ c, map });
    }
    if (!withForms.length) { box.innerHTML = ''; return; }
    box.innerHTML = withForms.map(({ c, map }) => {
      if (!map) return '<div class="qa-note">📄 ' + esc(c.name) + ': no start form set up' + (isManager() ? ' — <a href="#" data-setup="' + esc(c.id) + '">set it up</a> (once, for everyone)' : ' yet — a manager can set it up under Funders → Contracts') + '.</div>';
      const qs = quickQuestions(map);
      // group yes/no grids into one row of chips (support needs)
      const grids = qs.filter(q => q.type === 'grid'), rest = qs.filter(q => q.type !== 'grid');
      return '<div class="qa-form"><div class="qa-form-h">📄 ' + esc(map.name || c.name) + ' <span>— filled in and downloaded when you add them</span></div>' +
        rest.map(q => {
          const opts = q.options && q.options.length ? q.options : (q.type === 'choice' ? ['Yes', 'No'] : null);
          const cur = QA.answers[q.id] || '';
          return '<div class="qa-q" data-q="' + esc(q.id) + '"><span>' + esc(q.label.replace(/\s+/g, ' ').slice(0, 120)) + '</span>' +
            (opts ? '<div class="qa-chips">' + opts.map(o => '<button type="button" data-v="' + esc(o) + '" class="' + (cur === o ? 'on' : '') + '">' + esc(o.length > 38 ? o.slice(0, 36) + '…' : o) + '</button>').join('') + '</div>'
                  : '<input data-t="' + esc(q.id) + '" value="' + esc(cur) + '"/>') + '</div>';
        }).join('') +
        (grids.length ? '<div class="qa-q"><span>Support needs (tick all that apply)</span><div class="qa-chips" data-grid="1">' + grids.map(g => '<button type="button" data-g="' + esc(g.id) + '" class="' + (QA.answers[g.id] === 'Yes' ? 'on' : '') + '">' + esc(g.label.slice(0, 30)) + '</button>').join('') + '</div></div>' : '') +
        '</div>';
    }).join('');
    box.onclick = ev => {
      const s = ev.target.closest('[data-setup]'); if (s) { ev.preventDefault(); setupContract(s.dataset.setup, true); return; }
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.g) { b.classList.toggle('on'); return; }
      const row = b.closest('.qa-q'); if (!row) return;
      const was = b.classList.contains('on');
      row.querySelectorAll('button').forEach(x => x.classList.remove('on')); if (!was) b.classList.add('on');
      QA.answers[row.dataset.q] = was ? '' : b.dataset.v;
    };
    box.oninput = ev => { const t = ev.target.closest('input[data-t]'); if (t) QA.answers[t.dataset.t] = t.value.trim(); };
  }
  function qaGridAnswers(map) {
    (map.items || []).filter(i => i.type === 'grid').forEach(g => {
      const b = document.querySelector('#qa-forms button[data-g="' + g.id + '"]'); if (b) QA.answers[g.id] = b.classList.contains('on') ? 'Yes' : 'No';
    });
  }

  // Fill each chosen contract's start form straight after adding
  async function autoFillStartForms(p, data) {
    const done = [], todo = [];
    for (const cid of QA.contracts) {
      const map = await loadMap(cid); if (!map) continue;
      qaGridAnswers(map);
      const answers = {};
      (map.items || []).forEach(i => { if (QA.answers[i.id]) answers[i.id] = QA.answers[i.id]; });
      try {
        const c = (DB.contracts || []).find(x => String(x.id) === String(cid)) || {};
        const { data: row } = await sb.from('contracts').select('template_data').eq('id', cid).single();
        const j = await api({ docxBase64: row.template_data, filename: (map.name || c.name || 'Start form') + ' - ' + [data.forename, data.surname].join(' '), orgId, data, map, answers });
        download(j);
        await saveToEvidence(p, j, map.name || c.name || 'Start form', cid);
        done.push(c.name || 'Start form');
        if ((j.missing || []).length) todo.push((c.name || 'Start form') + ': ' + j.missing.length + ' to answer');
        // keep the answers on their record, and the eligibility ones in Eligibility
        if (p && String(p.id).indexOf('demo-') !== 0) {
          const { data: cur } = await sb.from('participants').select('paperwork').eq('id', p.id).single();
          const pw = Object.assign({}, (cur && cur.paperwork) || {});
          pw.form_answers = Object.assign({}, pw.form_answers || {}); pw.form_answers['contract:' + cid] = Object.assign({}, pw.form_answers['contract:' + cid] || {}, answers);
          pw.eligibility = Object.assign({}, pw.eligibility || {});
          (map.items || []).forEach(i => { if (i.use === 'field' && answers[i.id] && !QUICK_COVERED.includes(i.field) && i.type !== 'grid') pw.eligibility[i.field] = answers[i.id]; });
          const needs = (map.items || []).filter(i => i.type === 'grid' && answers[i.id] === 'Yes').map(i => i.label);
          if (needs.length) pw.eligibility.support_needs = needs;
          pw.start_forms = Object.assign({}, pw.start_forms || {}); pw.start_forms['contract:' + cid] = new Date().toISOString();
          await sb.from('participants').update({ paperwork: pw }).eq('id', p.id);
          p.paperwork = pw;
        }
      } catch (e) { todo.push((MAPS[cid] && MAPS[cid].name || 'Start form') + ': could not fill (' + (e.message || e) + ')'); }
    }
    return { done, todo };
  }

  // Manager: set up a contract's form from the Contracts page (or the quick-add note)
  async function setupContract(contractId, fromQuickAdd) {
    style(); qaStyle();
    FF.pick = String(contractId); FF.oneOff = null; FF.setupOnly = true; FF.afterSetup = fromQuickAdd ? () => { delete MAPS[contractId]; drawQAForms(); } : null;
    const c = (DB.contracts || []).find(x => String(x.id) === String(contractId));
    FF.forms = c ? [{ id: c.id, name: c.name }] : [];
    const { data } = await sb.from('contracts').select('id,template_name').eq('id', contractId).not('template_data', 'is', null).maybeSingle().then(r => r, () => ({ data: null }));
    if (!data) { alert('Upload the funder\'s blank Word form on this contract first (⬆ Form).'); return; }
    setup();
  }
  function addSetupButtons() {
    if (!isManager()) return;
    document.querySelectorAll('#fund-list .civ-tpl-btn').forEach(b => {
      if (b.nextElementSibling && b.nextElementSibling.classList && b.nextElementSibling.classList.contains('civ-map-btn')) return;
      const m = /civaraUploadContractTemplate\('([^']+)'\)/.exec(b.getAttribute('onclick') || ''); if (!m) return;
      const s = document.createElement('button');
      s.className = 'btn btn-ghost btn-sm civ-map-btn'; s.textContent = '🧭 Set up form'; s.title = 'Match the form\'s questions to Vorlana once — then it fills itself';
      s.onclick = () => setupContract(m[1]);
      b.parentNode.insertBefore(s, b.nextSibling); b.parentNode.insertBefore(document.createTextNode(' '), s);
      loadMap(m[1]).then(map => { if (map) { s.textContent = '🧭 Form set up ✓'; } });
    });
  }

  // ── Participant self-service: send a link, they fill in and sign, you review ──
  const INTAKE_MAP = { title: 'mp-ptitle', forename: 'mp-fn', surname: 'mp-ln', dob: 'mp-dob', ni: 'mp-ni', phone: 'mp-phone', email: 'mp-email',
    address: 'mp-address', postcode: 'mp-postcode', gender: 'mp-gender', right_to_work: 'mp-rtw', labour_status: 'mp-labour', basic_skills: 'mp-bskills', ethnicity: 'eq-ethnicity' };
  const INTAKE_LABELS = { title: 'Title', forename: 'First name', surname: 'Last name', dob: 'Date of birth', ni: 'NI number', phone: 'Mobile', email: 'Email', address: 'Address', postcode: 'Postcode',
    gender: 'Gender', ethnicity: 'Ethnicity', right_to_work: 'Right to work', labour_status: 'Employment status', in_education: 'In education/training', education_level: 'Highest qualification',
    basic_skills: 'English & maths quals', jobless_household: 'Jobless household', single_adult_dependants: 'Single adult with dependants', caring_responsibilities: 'Caring responsibilities',
    health_condition: 'Disability / health condition', sen: 'Special educational need', homeless: 'Homeless', refugee: 'Refugee', care_leaver: 'Care leaver', adult_social_care: 'Adult Social Care', offender: 'Unspent conviction', support_needs: 'Wants help with' };

  function newToken() { const a = new Uint8Array(32); crypto.getRandomValues(a); return Array.from(a, b => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 57]).join(''); }
  function loadQR() { return window.QRCode ? Promise.resolve() : new Promise((ok, bad) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js'; s.onload = ok; s.onerror = bad; document.head.appendChild(s); }); }

  async function sendIntake(p, prefill, contractIds) {
    if (!p || String(p.id).indexOf('demo-') === 0) { alert('Intake links work for real participants (not demo ones).'); return; }
    style();
    const row = { org_id: orgId, token: newToken(), participant_id: String(p.id), contract_ids: contractIds || p.contract_ids || [], prefill: prefill || {} };
    const { error } = await sb.from('intake_requests').insert([row]);
    if (error) { alert('Could not create the link (' + error.message + '). Run intake-requests.sql in Supabase first.'); return; }
    showIntakeLink(p, row.token);
  }
  function showIntakeLink(p, token) {
    const url = location.origin + '/intake.html?t=' + token;
    const first = (p.first_name || '').trim();
    const text = 'Hi ' + (first || 'there') + ', please fill in your details and sign here (about 5 minutes): ' + url;
    ffModal('<h2>📱 Send to ' + esc(first || 'participant') + '</h2>' +
      '<div class="cxp-s" style="font-size:13px;margin-bottom:12px">They fill in their own details on their phone and sign with their finger. You\'ll see it on their record to check and accept. The link works for 14 days.</div>' +
      '<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div id="ik-qr" style="background:#fff;padding:8px;border:1px solid var(--border);border-radius:10px"></div>' +
      '<div style="flex:1;min-width:200px;display:flex;flex-direction:column;gap:6px">' +
        '<b style="font-size:13px">In person — they scan this</b>' +
        (p.phone ? '<a class="btn btn-p btn-sm" href="sms:' + esc(String(p.phone).replace(/\s+/g, '')) + '?&body=' + encodeURIComponent(text) + '">💬 Text it to ' + esc(p.phone) + '</a>' : '') +
        '<a class="btn btn-ghost btn-sm" target="_blank" href="https://wa.me/' + esc(String(p.phone || '').replace(/\D/g, '').replace(/^0/, '44')) + '?text=' + encodeURIComponent(text) + '">WhatsApp</a>' +
        (p.email ? '<a class="btn btn-ghost btn-sm" href="mailto:' + esc(p.email) + '?subject=' + encodeURIComponent('Your details for ' + ((currentOrg && currentOrg.name) || 'us')) + '&body=' + encodeURIComponent(text) + '">✉️ Email it</a>' : '') +
        '<button class="btn btn-ghost btn-sm" id="ik-copy">📋 Copy link</button>' +
        '<a class="btn btn-ghost btn-sm" target="_blank" href="' + esc(url) + '">Open here (hand them this device)</a>' +
      '</div></div>' +
      '<div class="modal-footer"><button class="btn btn-p" id="ik-done">Done</button></div>');
    $id('ik-done').onclick = () => { ffClose(); intakeBanner(); };
    $id('ik-copy').onclick = () => { (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(() => { $id('ik-copy').textContent = '✓ Copied'; }, () => prompt('Copy this link:', url)); };
    loadQR().then(() => { const b = $id('ik-qr'); if (b) new QRCode(b, { text: url, width: 150, height: 150, correctLevel: QRCode.CorrectLevel.M }); }).catch(() => { const b = $id('ik-qr'); if (b) b.textContent = 'QR unavailable — use a button'; });
  }

  // Banner on the record: send, waiting, or ready to review
  let IK = null;
  async function intakeBanner() {
    const modal = document.querySelector('#modal-p .modal'); if (!modal) return;
    let b = $id('ik-banner');
    if (!b) { b = document.createElement('div'); b.id = 'ik-banner'; const bar = $id('pt-bar') || $id('mp-title'); bar.parentNode.insertBefore(b, bar.nextSibling); }
    const p = currentParticipant();
    if (!p) { b.innerHTML = ''; return; }
    IK = null;
    try {
      const { data } = await sb.from('intake_requests').select('*').eq('org_id', orgId).eq('participant_id', String(p.id)).neq('status', 'cancelled').order('created_at', { ascending: false }).limit(1);
      IK = data && data[0];
    } catch (e) { IK = null; }
    const st = 'display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-radius:10px;padding:9px 12px;font-size:13px;margin:0 0 12px;';
    if (IK && IK.status === 'submitted') {
      b.innerHTML = '<div style="' + st + 'background:#F0FDF4;border:1px solid #BBF7D0;color:#15803D"><span>✅ ' + esc(p.first_name) + ' filled in their details and signed on ' + new Date(IK.signed_at).toLocaleDateString('en-GB') + '.</span><button class="btn btn-p btn-sm" type="button" id="ik-review">Review &amp; accept</button></div>';
      $id('ik-review').onclick = reviewIntake;
    } else if (IK && (IK.status === 'sent' || IK.status === 'opened') && new Date(IK.expires_at) > new Date()) {
      b.innerHTML = '<div style="' + st + 'background:var(--bg);border:1px solid var(--border);color:var(--txt2)"><span>📱 Link sent ' + new Date(IK.created_at).toLocaleDateString('en-GB') + (IK.status === 'opened' ? ' · they\'ve opened it' : ' · not opened yet') + '</span><span><a href="#" id="ik-show">Show link</a> · <a href="#" id="ik-cancel">Cancel</a></span></div>';
      $id('ik-show').onclick = ev => { ev.preventDefault(); showIntakeLink(p, IK.token); };
      $id('ik-cancel').onclick = async ev => { ev.preventDefault(); await sb.from('intake_requests').update({ status: 'cancelled' }).eq('id', IK.id); intakeBanner(); };
    } else {
      const signed = p.paperwork && p.paperwork.signature;
      b.innerHTML = '<div style="' + st + 'background:var(--bg);border:1px solid var(--border);color:var(--txt2)"><span>' + (signed ? '✍️ Signed by the participant ' + new Date(signed.signed_at).toLocaleDateString('en-GB') + '.' : 'Let ' + esc(p.first_name || 'them') + ' fill in their own details and sign on their phone.') + '</span>' +
        '<span style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" type="button" id="ik-sign">✍️ Sign here</button><button class="btn btn-ghost btn-sm" type="button" id="ik-send">📱 ' + (signed ? 'Send again' : 'Send them a link') + '</button></span></div>';
      $id('ik-sign').onclick = signHere;
      $id('ik-send').onclick = () => sendIntake(p, { forename: p.first_name, surname: p.last_name, phone: p.phone, email: p.email }, getSelectedContractIds ? getSelectedContractIds() : p.contract_ids);
    }
  }

  function reviewIntake() {
    const d = IK.data || {};
    const rows = Object.keys(d).filter(k => d[k] !== '' && d[k] != null && !(Array.isArray(d[k]) && !d[k].length)).map(k => {
      const v = Array.isArray(d[k]) ? d[k].join(', ') : d[k];
      const label = INTAKE_LABELS[k] || (/^form:/.test(k) ? 'Form question' : k);
      const cur = INTAKE_MAP[k] ? val(INTAKE_MAP[k]) : (ELIG_STATE[k] || '');
      const changed = cur && String(cur).toLowerCase() !== String(v).toLowerCase();
      return '<tr><td style="color:var(--txt3);padding:5px 8px 5px 0;font-size:12.5px;width:40%">' + esc(label) + '</td><td style="padding:4px 0"><input data-ik="' + esc(k) + '" value="' + esc(v) + '" style="font-size:13px;padding:5px 8px"/>' + (changed ? '<div style="color:#B45309;font-size:11.5px">was: ' + esc(cur) + '</div>' : '') + '</td></tr>';
    }).join('');
    ffModal('<h2>Review ' + esc(IK.signed_name || '') + '\'s details</h2>' +
      '<div style="max-height:46vh;overflow:auto;border:1px solid var(--border);border-radius:10px;padding:6px 12px"><table style="width:100%;border-collapse:collapse">' + rows + '</table></div>' +
      '<div style="margin-top:12px;font-size:12.5px;color:var(--txt3)">Signed ' + new Date(IK.signed_at).toLocaleString('en-GB') + '</div>' +
      '<img src="' + esc(IK.signature) + '" alt="Signature" style="max-width:260px;max-height:90px;border-bottom:1px solid var(--border);margin:4px 0 6px"/>' +
      '<div class="cxp-s" style="font-size:12px">You can correct anything above before accepting.</div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" id="ik-x">Not now</button><button class="btn btn-p" id="ik-ok">Accept into their record</button></div>', 600);
    $id('ik-x').onclick = ffClose;
    $id('ik-ok').onclick = acceptIntake;
  }

  async function acceptIntake() {
    // take any corrections the adviser made on the review screen
    document.querySelectorAll('#ff-modal input[data-ik]').forEach(i => {
      const k = i.getAttribute('data-ik'); const v = i.value.trim();
      IK.data[k] = Array.isArray(IK.data[k]) ? v.split(',').map(x => x.trim()).filter(Boolean) : v;
    });
    const d = IK.data || {}, p = currentParticipant();
    confirmOverwrite = true;
    Object.keys(INTAKE_MAP).forEach(k => { if (d[k]) setField(INTAKE_MAP[k], d[k]); });
    confirmOverwrite = false;
    const formAns = {};
    Object.keys(d).forEach(k => {
      const m = /^form:(contract:[A-Za-z0-9-]+):([a-z]\d+)$/.exec(k);
      if (m) { (formAns[m[1]] = formAns[m[1]] || {})[m[2]] = d[k]; return; }
      if (!INTAKE_MAP[k] || ['gender', 'labour_status', 'basic_skills', 'right_to_work'].includes(k)) ELIG_STATE[k] = d[k];
    });
    if (Array.isArray(d.support_needs) && d.support_needs.length && !val('mp-inter')) setField('mp-inter', 'Yes');
    drawElig();
    try {
      const { data } = await sb.from('participants').select('paperwork').eq('id', p.id).single();
      const pw = Object.assign({}, (data && data.paperwork) || {});
      pw.eligibility = Object.assign({}, pw.eligibility || {}, ELIG_STATE);
      pw.form_answers = Object.assign({}, pw.form_answers || {});
      Object.keys(formAns).forEach(k => { pw.form_answers[k] = Object.assign({}, pw.form_answers[k] || {}, formAns[k]); });
      pw.signature = { png: IK.signature, signed_name: IK.signed_name, signed_at: IK.signed_at, consent: IK.consent_text, via: 'intake link' };
      await sb.from('participants').update({ paperwork: pw }).eq('id', p.id);
      p.paperwork = pw;
      await sb.from('intake_requests').update({ status: 'accepted', accepted_at: new Date().toISOString() }).eq('id', IK.id);
    } catch (e) { alert('Could not store the signature: ' + (e.message || e)); }
    ffClose();
    document.querySelectorAll('#modal-p details').forEach(dd => { if (dd.querySelector('.ob-filled')) dd.open = true; });
    paintCounts();
    const b = $id('ik-banner');
    if (b) b.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;border-radius:10px;padding:9px 12px;font-size:13px;margin:0 0 12px;background:#FFFBEB;border:1px solid #FDE68A;color:#92400E"><span>Their answers are filled in and highlighted — press <b>Save</b> to keep them.</span></div>';
  }

  // ── Partner referrals → participant, with everything the partner gave ──
  let FROM_REF = null;
  function wrapConvert() {
    const orig = window.convertToParticipant; if (typeof orig !== 'function' || orig._ob) return;
    window.convertToParticipant = function (id) {
      const r = orig.apply(this, arguments);
      const ref = (DB.partner_referrals || []).find(x => x.id === id); if (!ref) return r;
      try {
        onOpen(true);
        $id('ob-quick').style.display = 'none';
        const pw = ref.paperwork || {};
        const put = (fid, v) => { if (v) setField(fid, v); };
        put('mp-phone', ref.phone); put('mp-email', ref.email); put('mp-dob', ref.dob);
        put('mp-ni', pw.ni); put('mp-address', pw.address); put('mp-postcode', pw.postcode);
        const e = pw.eligibility || {};
        put('mp-gender', e.gender); put('mp-rtw', e.right_to_work); put('mp-labour', e.labour_status);
        // referral source from the partner's own name where it matches a known source
        const src = /probation/i.test(ref.partner_name) ? 'Probation' : /jobcentre|dwp/i.test(ref.partner_name) ? 'Jobcentre Plus' : '';
        if (src) setField('mp-rs', src);
        Object.keys(e).forEach(k => { if (!['gender', 'right_to_work', 'labour_status'].includes(k)) ELIG_STATE[k] = e[k]; });
        drawElig();
        if ($id('mp-intake-text')) $id('mp-intake-text').value = 'Referred by ' + ref.partner_name + (ref.partner_ref ? ' (their ref ' + ref.partner_ref + ')' : '') + ' — ' + (ref.primary_need || '') + (ref.urgency && ref.urgency !== 'Standard' ? ' · ' + ref.urgency : '') + '\n\n' + (ref.notes || '');
        FROM_REF = { id: ref.id, sendLink: pw.send_link !== false, names: [ref.first_name, ref.last_name], partner: ref.partner_name };
        tabify();
        const b = $id('ik-banner') || (() => { const d = document.createElement('div'); d.id = 'ik-banner'; const bar = $id('pt-bar'); bar.parentNode.insertBefore(d, bar.nextSibling); return d; })();
        b.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;border-radius:10px;padding:9px 12px;font-size:13px;margin:0 0 12px;background:rgba(31,111,109,.06);border:1px solid rgba(31,111,109,.25);color:var(--txt2)"><span>🤝 From <b>' + esc(ref.partner_name) + '</b> — their details are filled in and highlighted.</span>' +
          '<label style="display:flex;gap:6px;align-items:center;margin:0;font-size:12.5px;text-transform:none;letter-spacing:0"><input type="checkbox" id="ref-link" style="width:auto"' + (FROM_REF.sendLink ? ' checked' : '') + '/> Send them a link to check &amp; sign after saving</label></div>';
        $id('ref-link').onchange = ev => { FROM_REF.sendLink = ev.target.checked; };
        paintCounts();
      } catch (e) { console.warn('[onboarding] convert', e); }
      return r;
    };
    window.convertToParticipant._ob = true;
  }
  // After saving a converted referral: link it back, and send the participant their link
  async function afterConvertSave() {
    if (!FROM_REF) return;
    const f = FROM_REF; FROM_REF = null;
    const p = (DB.participants || []).filter(x => x.first_name === f.names[0] && x.last_name === f.names[1]).slice(-1)[0];
    if (!p) return;
    try { await sb.from('partner_referrals').update({ participant_id: String(p.id) }).eq('id', f.id); } catch (e) { /* column may not exist yet */ }
    if (f.sendLink) sendIntake(p, { forename: p.first_name, surname: p.last_name, phone: p.phone, email: p.email }, p.contract_ids || []);
  }

  // ── Sign in person, on this device ────────────────────────
  function signHere() {
    const p = currentParticipant(); if (!p) { alert('Save the participant first.'); return; }
    const consent = 'I confirm the information I have given is true to the best of my knowledge. I agree to ' + ((currentOrg && currentOrg.name) || 'the organisation') + ' using it to support me and to report anonymously to the funders of this programme.';
    ffModal('<h2>✍️ Sign here</h2><div class="cxp-s" style="font-size:13px;margin-bottom:10px">Hand the device to ' + esc(p.first_name || 'the participant') + '.</div>' +
      '<div style="font-size:13px;background:var(--bg);border-radius:10px;padding:10px 12px;margin-bottom:10px">' + esc(consent) + '</div>' +
      '<canvas id="sh-pad" style="width:100%;height:170px;border:1.5px dashed var(--em);border-radius:12px;background:#fff;touch-action:none;display:block"></canvas>' +
      '<div style="display:flex;justify-content:space-between;font-size:12px;color:var(--txt3);margin:4px 0 10px"><span>Sign above with a finger or mouse</span><a href="#" id="sh-clear">Clear</a></div>' +
      '<div class="form-row"><label>Full name</label><input id="sh-name" value="' + esc([p.first_name, p.last_name].filter(Boolean).join(' ')) + '"/></div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" id="sh-x">Cancel</button><button class="btn btn-p" id="sh-ok">Save signature</button></div>');
    const c = $id('sh-pad'); let ctx, drawing = false, last = null, dirty = false;
    const r0 = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    c.width = r0.width * dpr; c.height = r0.height * dpr; ctx = c.getContext('2d'); ctx.scale(dpr, dpr); ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.strokeStyle = '#111';
    const pt = e => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.onpointerdown = e => { drawing = true; last = pt(e); try { c.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ } };
    c.onpointermove = e => { if (!drawing) return; const q = pt(e); ctx.beginPath(); ctx.moveTo(last.x, last.y); ctx.lineTo(q.x, q.y); ctx.stroke(); last = q; dirty = true; };
    c.onpointerup = c.onpointercancel = () => { drawing = false; };
    $id('sh-clear').onclick = ev => { ev.preventDefault(); ctx.clearRect(0, 0, c.width, c.height); dirty = false; };
    $id('sh-x').onclick = ffClose;
    $id('sh-ok').onclick = async () => {
      if (!dirty) { alert('Please sign in the box.'); return; }
      const name = val('sh-name'); if (!name) { alert('Please type their name.'); return; }
      try {
        const { data } = await sb.from('participants').select('paperwork').eq('id', p.id).single();
        const pw = Object.assign({}, (data && data.paperwork) || {});
        pw.signature = { png: c.toDataURL('image/png'), signed_name: name, signed_at: new Date().toISOString(), consent, via: 'in person' };
        await sb.from('participants').update({ paperwork: pw }).eq('id', p.id);
        p.paperwork = pw;
        ffClose(); intakeBanner();
      } catch (e) { alert('Could not save the signature: ' + (e.message || e)); }
    };
  }

  // ═══ Caseloads: separate per adviser, shared per project, duplicates to managers ═══
  const separateOn = () => !!(currentOrg && currentOrg.settings && currentOrg.settings.separate_caseloads);
  let TEAM = null;   // [{user_id, name, role, is_dsl, is_triage}]
  async function loadTeam() {
    if (TEAM) return TEAM;
    try {
      const { data: mem } = await sb.from('memberships').select('*').eq('org_id', orgId).eq('status', 'active');
      const ids = (mem || []).map(m => m.user_id);
      const { data: prof } = ids.length ? await sb.from('profiles').select('id,full_name,email').in('id', ids) : { data: [] };
      TEAM = (mem || []).map(m => { const p = (prof || []).find(x => x.id === m.user_id) || {}; return { user_id: m.user_id, name: p.full_name || p.email || 'Team member', role: m.role, is_dsl: m.is_dsl, is_triage: m.is_triage }; });
    } catch (e) { TEAM = []; }
    return TEAM;
  }
  const personName = uid => ((TEAM || []).find(t => t.user_id === uid) || {}).name || 'a colleague';
  const contractName = cid => ((DB.contracts || []).find(c => String(c.id) === String(cid)) || {}).name || '';

  // Before adding: is this person already supported? (checked on the server — never shows someone else's participant)
  async function serverDupeCheck(newId) {
    try {
      const { data, error } = await sb.rpc('check_duplicate', { p_org: orgId, p_first: val('mp-fn'), p_last: val('mp-ln'), p_dob: val('mp-dob') || null, p_ni: val('mp-ni') || null, p_contracts: QA.contracts || [], p_new: newId || null });
      if (error) return { match: false };
      return data || { match: false };
    } catch (e) { return { match: false }; }
  }
  function askDupe(res) {
    return new Promise(resolve => {
      if (res.visible) {
        ffModal('<h2>Already on your caseload</h2><div class="cxp-s" style="font-size:13px;line-height:1.6">Someone with this name' + (val('mp-dob') ? ' and date of birth' : '') + ' is already on your caseload. Open their record instead — you can add this project to it.</div>' +
          '<div class="modal-footer"><button class="btn btn-ghost" id="dp-new">Add a new record anyway</button><button class="btn btn-p" id="dp-open">Open their record</button></div>');
        $id('dp-open').onclick = () => { ffClose(); resolve('open'); };
        $id('dp-new').onclick = () => { ffClose(); resolve('add'); };
      } else {
        ffModal('<h2>Already supported by a colleague</h2><div class="cxp-s" style="font-size:13px;line-height:1.6">This person is already supported by another adviser. <b>Your manager has been told</b> and can add you to their record for this project, so everything stays in one place.</div>' +
          '<div class="modal-footer"><button class="btn btn-ghost" id="dp-new">Not the same person — add them</button><button class="btn btn-p" id="dp-ok">OK, leave it with my manager</button></div>');
        $id('dp-ok').onclick = () => { ffClose(); resolve('stop'); };
        $id('dp-new').onclick = () => { ffClose(); resolve('add'); };
      }
    });
  }

  // On a record: who works with this person (managers can share or hand over)
  async function caseloadBar() {
    const p = currentParticipant(); const modal = document.querySelector('#modal-p .modal');
    let bar = $id('cl-bar');
    if (!modal) return;
    if (!bar) { bar = document.createElement('div'); bar.id = 'cl-bar'; const at = $id('ik-banner') || $id('pt-bar') || $id('mp-title'); at.parentNode.insertBefore(bar, at); }
    bar.innerHTML = '';
    if (!p || String(p.id).indexOf('demo-') === 0) return;
    try { sb.from('participant_access_log').insert([{ org_id: orgId, participant_id: p.id, action: 'view' }]).then(() => {}, () => {}); } catch (e) { /* optional */ }
    if (!separateOn()) return;
    await loadTeam();
    let rows = [];
    try { const { data } = await sb.from('participant_access').select('*').eq('participant_id', p.id); rows = data || []; } catch (e) { rows = []; }
    const who = rows.map(r => esc(personName(r.user_id)) + (r.contract_id && contractName(r.contract_id) ? ' <span style="color:var(--txt3)">(' + esc(contractName(r.contract_id)) + ')</span>' : '')).join(' · ') || '<span style="color:var(--red)">No adviser yet</span>';
    bar.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;font-size:12.5px;margin:0 0 10px;color:var(--txt2)"><span>👥 ' + who + '</span>' +
      (isManager() ? '<span style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" type="button" id="cl-share">+ Add adviser / project</button><button class="btn btn-ghost btn-sm" type="button" id="cl-hand">Hand over</button></span>' : '') + '</div>';
    if (!isManager()) return;
    const memberOpts = (TEAM || []).map(t => '<option value="' + esc(t.user_id) + '">' + esc(t.name) + ' · ' + esc(t.role) + '</option>').join('');
    const projOpts = '<option value="">All their projects</option>' + (DB.contracts || []).map(c => '<option value="' + esc(c.id) + '">' + esc(c.name) + '</option>').join('');
    $id('cl-share').onclick = () => {
      ffModal('<h2>Add an adviser</h2><div class="cxp-s" style="font-size:13px;margin-bottom:10px">For people on more than one project — each project can have its own adviser. Everyone shares the same record.</div>' +
        '<div class="form-row"><label>Adviser</label><select id="cl-u">' + memberOpts + '</select></div><div class="form-row"><label>Project</label><select id="cl-c">' + projOpts + '</select></div>' +
        '<div class="modal-footer"><button class="btn btn-ghost" id="cl-x">Cancel</button><button class="btn btn-p" id="cl-ok">Add</button></div>');
      $id('cl-x').onclick = ffClose;
      $id('cl-ok').onclick = async () => {
        const cid = val('cl-c') || null;
        const { error } = await sb.from('participant_access').insert([{ org_id: orgId, participant_id: p.id, user_id: val('cl-u'), contract_id: cid }]);
        if (error && !/duplicate/i.test(error.message)) { alert('Could not add: ' + error.message); return; }
        if (cid && !(p.contract_ids || []).map(String).includes(String(cid))) {
          const ids = (p.contract_ids || []).concat(cid); await sb.from('participants').update({ contract_ids: ids }).eq('id', p.id); p.contract_ids = ids;
          if (typeof renderContractSelector === 'function') renderContractSelector(ids);
        }
        ffClose(); caseloadBar();
      };
    };
    $id('cl-hand').onclick = () => {
      ffModal('<h2>Hand over</h2><div class="cxp-s" style="font-size:13px;margin-bottom:10px">The new adviser takes over this person completely. The handover is recorded.</div>' +
        '<div class="form-row"><label>New adviser</label><select id="cl-u">' + memberOpts + '</select></div>' +
        '<div class="modal-footer"><button class="btn btn-ghost" id="cl-x">Cancel</button><button class="btn btn-p" id="cl-ok">Hand over</button></div>');
      $id('cl-x').onclick = ffClose;
      $id('cl-ok').onclick = async () => {
        const to = val('cl-u');
        await sb.from('participant_access').delete().eq('participant_id', p.id);
        await sb.from('participant_access').insert([{ org_id: orgId, participant_id: p.id, user_id: to }]);
        await sb.from('participants').update({ created_by: to }).eq('id', p.id);
        sb.from('participant_access_log').insert([{ org_id: orgId, participant_id: p.id, action: 'handed over to ' + personName(to) }]).then(() => {}, () => {});
        ffClose(); caseloadBar();
      };
    };
  }

  // Participants page (managers): possible duplicates and people without an adviser
  async function managerCaseloadPanel() {
    const page = $id('page-participants'); if (!page || !isManager()) return;
    let box = $id('cl-panel');
    if (!box) { box = document.createElement('div'); box.id = 'cl-panel'; const hdr = page.querySelector('.page-header'); hdr ? hdr.parentNode.insertBefore(box, hdr.nextSibling) : page.prepend(box); }
    let flags = [], assigned = new Set();
    try { const { data } = await sb.from('duplicate_flags').select('*').eq('org_id', orgId).eq('status', 'open').order('created_at'); flags = data || []; } catch (e) { flags = []; }
    if (separateOn()) { try { const { data } = await sb.from('participant_access').select('participant_id').eq('org_id', orgId); (data || []).forEach(r => assigned.add(String(r.participant_id))); } catch (e) { /* ignore */ } }
    const unassigned = separateOn() ? (DB.participants || []).filter(p => String(p.id).indexOf('demo-') !== 0 && !assigned.has(String(p.id))) : [];
    if (!flags.length && !unassigned.length) { box.innerHTML = ''; return; }
    box.innerHTML = '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">' +
      (flags.length ? '<button class="btn btn-sm" style="background:#FFFBEB;border:1px solid #FDE68A;color:#92400E" id="cl-dupes">⚠ ' + flags.length + ' possible duplicate' + (flags.length === 1 ? '' : 's') + ' to check</button>' : '') +
      (unassigned.length ? '<button class="btn btn-sm" style="background:#FEF2F2;border:1px solid #FECACA;color:#B91C1C" id="cl-unas">👤 ' + unassigned.length + ' without an adviser</button>' : '') + '</div>';
    if ($id('cl-dupes')) $id('cl-dupes').onclick = () => showDupes(flags);
    if ($id('cl-unas')) $id('cl-unas').onclick = () => showUnassigned(unassigned);
  }
  async function showDupes(flags) {
    await loadTeam();
    const pName = id => { const p = (DB.participants || []).find(x => String(x.id) === String(id)); return p ? p.first_name + ' ' + p.last_name : 'a participant'; };
    ffModal('<h2>Possible duplicates</h2><div class="cxp-s" style="font-size:13px;margin-bottom:10px">An adviser tried to add someone who is already on file. Keep one record per person — add them as an adviser for their project instead.</div>' +
      flags.map(f => {
        const d = f.details || {};
        return '<div style="border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:8px;font-size:13px">' +
          '<b>' + esc(personName(f.requested_by)) + '</b> tried to add <b>' + esc([d.first_name, d.last_name].filter(Boolean).join(' ')) + '</b>' + (d.dob ? ' (born ' + esc(d.dob) + ')' : '') +
          (d.contract_ids && d.contract_ids.length ? ' for ' + esc(d.contract_ids.map(contractName).filter(Boolean).join(', ')) : '') +
          ' — already on file as <b>' + esc(pName(f.participant_id)) + '</b>' + (f.duplicate_id ? ' <span style="color:#B45309">(a second record was added)</span>' : '') +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">' +
            '<button class="btn btn-p btn-sm" data-act="share" data-id="' + esc(f.id) + '">Add ' + esc(personName(f.requested_by)) + ' as their adviser</button>' +
            (f.duplicate_id ? '<button class="btn btn-ghost btn-sm" data-act="merge" data-id="' + esc(f.id) + '">Merge the two records</button>' : '') +
            '<button class="btn btn-ghost btn-sm" data-act="dismiss" data-id="' + esc(f.id) + '">Not the same person</button></div></div>';
      }).join('') + '<div class="modal-footer"><button class="btn btn-ghost" id="cl-x">Close</button></div>', 620);
    $id('cl-x').onclick = ffClose;
    document.querySelectorAll('#ff-modal [data-act]').forEach(b => b.onclick = async () => {
      const f = flags.find(x => x.id === b.dataset.id); const d = f.details || {}; b.disabled = true;
      try {
        if (b.dataset.act === 'share' || b.dataset.act === 'merge') {
          const cids = (d.contract_ids || []).filter(Boolean);
          for (const cid of (cids.length ? cids : [null])) await sb.from('participant_access').insert([{ org_id: orgId, participant_id: f.participant_id, user_id: f.requested_by, contract_id: cid }]).then(() => {}, () => {});
          const keep = (DB.participants || []).find(x => String(x.id) === String(f.participant_id));
          let ids = (keep && keep.contract_ids || []).map(String);
          if (b.dataset.act === 'merge' && f.duplicate_id) {
            const dup = (DB.participants || []).find(x => String(x.id) === String(f.duplicate_id));
            ids = ids.concat((dup && dup.contract_ids || []).map(String));
            await sb.from('evidence').update({ participant_id: String(f.participant_id) }).eq('participant_id', String(f.duplicate_id));
            await sb.from('intake_requests').update({ participant_id: String(f.participant_id) }).eq('participant_id', String(f.duplicate_id));
            await sb.from('participants').delete().eq('id', f.duplicate_id);
          }
          ids = Array.from(new Set(ids.concat(cids.map(String))));
          if (keep) await sb.from('participants').update({ contract_ids: ids }).eq('id', f.participant_id);
        }
        await sb.from('duplicate_flags').update({ status: b.dataset.act === 'dismiss' ? 'dismissed' : 'resolved', resolution: b.dataset.act, resolved_at: new Date().toISOString() }).eq('id', f.id);
        b.closest('div[style*="border:1px"]').style.opacity = .45; b.parentNode.innerHTML = '<span class="cxp-s">✓ Done</span>';
        if (typeof refreshTable === 'function') refreshTable('participants').then(() => { try { renderParticipants(); } catch (e) { /* page changed */ } });
      } catch (e) { alert('Could not finish: ' + (e.message || e)); b.disabled = false; }
    });
  }
  async function showUnassigned(list) {
    await loadTeam();
    const groups = {};
    list.forEach(p => { const k = p.advisor || 'Unassigned'; (groups[k] = groups[k] || []).push(p); });
    const opts = '<option value="">Choose…</option>' + (TEAM || []).map(t => '<option value="' + esc(t.user_id) + '">' + esc(t.name) + '</option>').join('');
    const guess = name => { const t = (TEAM || []).find(x => x.name && name && x.name.toLowerCase().split(' ')[0] === String(name).toLowerCase().split(/[ .]/)[0]); return t ? t.user_id : ''; };
    ffModal('<h2>Give everyone an adviser</h2><div class="cxp-s" style="font-size:13px;margin-bottom:10px">With separate caseloads on, people without an adviser are only seen by managers, safeguarding leads and triage. Match each old "Adviser" name to a team member.</div>' +
      Object.keys(groups).map((k, i) => '<div class="form-row" style="display:flex;gap:10px;align-items:center;justify-content:space-between"><span style="font-size:13px"><b>' + esc(k) + '</b> · ' + groups[k].length + ' people</span><select data-g="' + i + '" style="max-width:240px">' + opts.replace('value="' + guess(k) + '"', 'value="' + guess(k) + '" selected') + '</select></div>').join('') +
      '<div class="modal-footer"><button class="btn btn-ghost" id="cl-x">Cancel</button><button class="btn btn-p" id="cl-ok">Assign</button></div>', 560);
    $id('cl-x').onclick = ffClose;
    $id('cl-ok').onclick = async () => {
      const rows = [];
      document.querySelectorAll('#ff-modal select[data-g]').forEach(s => { const uid = s.value; if (!uid) return; groups[Object.keys(groups)[+s.dataset.g]].forEach(p => rows.push({ org_id: orgId, participant_id: p.id, user_id: uid })); });
      for (let i = 0; i < rows.length; i += 200) { const { error } = await sb.from('participant_access').insert(rows.slice(i, i + 200)); if (error && !/duplicate/i.test(error.message)) { alert('Could not assign: ' + error.message); return; } }
      ffClose(); managerCaseloadPanel();
    };
  }

  function install() {
    wrapOpeners(); wrapSave(); wrapConvert();
    window.civaraFillFunderForm = openFill;
    const rp = window.renderParticipants;
    if (typeof rp === 'function' && !rp._cl) { window.renderParticipants = function () { const r = rp.apply(this, arguments); setTimeout(managerCaseloadPanel, 30); return r; }; window.renderParticipants._cl = true; }
    const rf = window.renderFunding;
    if (typeof rf === 'function' && !rf._ob) { window.renderFunding = function () { const r = rf.apply(this, arguments); setTimeout(addSetupButtons, 50); setTimeout(addSetupButtons, 1800); return r; }; window.renderFunding._ob = true; }
    setTimeout(addSetupButtons, 2000);
  }
  // Run after app.html's inline scripts have added their own wrappers
  if (document.readyState === 'complete') setTimeout(install, 0);
  else window.addEventListener('load', () => setTimeout(install, 0));
})();
