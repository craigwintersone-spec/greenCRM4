// js/onboarding.js — faster participant onboarding + funder form filling
// ─────────────────────────────────────────────────────────────
// Adds to the participant form (modal-p):
//   ✨ Fill from a referral — photo, PDF, Word or pasted text; the AI
//      fills every field it can and highlights them for checking.
//   Sections open themselves and show "4 of 9 filled".
// Replaces the funder-form filler (civaraFillFunderForm) with one
// screen: pick the form (or upload a // js/onboarding.js — faster participant onboarding + funder form filling
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
      window[name] = function () { const r = orig.apply(this, arguments); try { onOpen(name === 'openAddP'); } catch (e) { console.warn('[onboarding]', e); } return r; };
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
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch('/api/fill-form', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: session ? 'Bearer ' + session.access_token : '' }, body: JSON.stringify(body) });
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
      } catch (e) { alert('Filled this time, but the set-up could not be saved (' + (e.message || e) + '). Run form-maps.sql in Supabase so it is remembered.'); }
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
    if ($id('ff-dl')) $id('ff-dl').onclick = () => download(j);
    if ($id('ff-dl2')) $id('ff-dl2').onclick = () => download(j);
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

  function install() {
    wrapOpeners(); wrapSave();
    window.civaraFillFunderForm = openFill;
  }
  // Run after app.html's inline scripts have added their own wrappers
  if (document.readyState === 'complete') setTimeout(install, 0);
  else window.addEventListener('load', () => setTimeout(install, 0));
})();one-off), fill, see what was
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
    style(); injectQuick();
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
      window[name] = function () { const r = orig.apply(this, arguments); try { onOpen(name === 'openAddP'); } catch (e) { console.warn('[onboarding]', e); } return r; };
      window[name]._ob = true;
    });
  }

  // ── Funder form filling ────────────────────────────────────
  function fmtDate(v) { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '')); return m ? m[3] + '/' + m[2] + '/' + m[1] : (v || ''); }
  function gather() {
    const d = {
      forename: val('mp-fn'), surname: val('mp-ln'), title: val('mp-ptitle'), ni: val('mp-ni'), dob: fmtDate(val('mp-dob')), address: val('mp-address'),
      postcode: val('mp-postcode'), phone: val('mp-phone'), email: val('mp-email'), participant_id: val('mp-pid'), start_date: fmtDate(val('mp-start')),
      gender: val('mp-gender'), right_to_work: val('mp-rtw'), basic_skills: val('mp-bskills'), labour_status: val('mp-labour'), interpersonal: val('mp-inter'),
      adviser: val('mp-adv'), referral_source: val('mp-rs'), stage: val('mp-st'), risk: val('mp-risk'), outcome_type: val('mp-outcome-type'),
      job_title: val('mp-job-title'), employer: val('mp-employer'), job_start: fmtDate(val('mp-job-start')), hours: val('mp-hours'), pay: val('mp-pay'),
      exit_date: fmtDate(val('mp-exit-date')), leave_reason: val('mp-leave-reason'), provider: val('mp-provider'), project: val('mp-project'),
      organisation: (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || '', today: new Date().toLocaleDateString('en-GB')
    };
    const p = currentParticipant();
    const extra = (p && p.paperwork && p.paperwork.extra) || {};
    Object.keys(extra).forEach(k => { if (extra[k] && !d[k]) d[k] = extra[k]; });
    Object.keys(FF.extra).forEach(k => { if (FF.extra[k]) d[k] = FF.extra[k]; });
    return d;
  }
  function currentParticipant() { return (typeof _editPId !== 'undefined' && _editPId) ? (DB.participants || []).find(x => x.id === _editPId) : null; }

  const FF = { forms: [], pick: null, oneOff: null, extra: {}, last: null };
  function ffModal(html) {
    let m = $id('ff-modal');
    if (!m) { m = document.createElement('div'); m.className = 'modal-overlay'; m.id = 'ff-modal'; m.style.zIndex = 600; m.addEventListener('click', e => { if (e.target === m) m.classList.remove('open'); }); document.body.appendChild(m); }
    m.innerHTML = '<div class="modal" style="max-width:560px">' + html + '</div>';
    m.classList.add('open');
  }
  function ffClose() { const m = $id('ff-modal'); if (m) m.classList.remove('open'); }

  async function openFill() {
    style();
    FF.pick = null; FF.oneOff = null; FF.extra = {}; FF.last = null;
    ffModal('<h2>📄 Fill a funder form</h2><div class="cxp-s" style="font-size:13px">Loading forms…</div>');
    let rows = [];
    try {
      const { data } = await sb.from('contracts').select('id,name,template_name').eq('org_id', orgId).not('template_data', 'is', null);
      rows = data || [];
    } catch (e) { rows = []; }
    const linked = (typeof getSelectedContractIds === 'function') ? getSelectedContractIds().map(String) : [];
    rows.sort((a, b) => (linked.includes(String(b.id)) ? 1 : 0) - (linked.includes(String(a.id)) ? 1 : 0));
    FF.forms = rows;
    if (rows.length) FF.pick = String(rows[0].id);
    drawPicker(linked);
  }
  function drawPicker(linked) {
    const who = [val('mp-fn'), val('mp-ln')].filter(Boolean).join(' ') || 'this participant';
    ffModal('<h2>📄 Fill a funder form</h2><div class="cxp-s" style="font-size:13px;margin-bottom:6px">For <b>' + esc(who) + '</b> — answers come from their record.</div>' +
      '<div class="ff-list">' + FF.forms.map(r => '<div class="ff-opt ' + (FF.pick === String(r.id) && !FF.oneOff ? 'on' : '') + '" data-id="' + esc(r.id) + '"><div>📄</div><div><b>' + esc(r.name) + '</b><span>' + esc(r.template_name || 'form.docx') + (linked.includes(String(r.id)) ? ' · linked to this participant' : '') + '</span></div></div>').join('') +
        '<label class="ff-opt ' + (FF.oneOff ? 'on' : '') + '" style="margin:0"><div>⬆</div><div><b>' + (FF.oneOff ? esc(FF.oneOff.name) : 'Use a different form') + '</b><span>' + (FF.oneOff ? 'Ready to fill' : 'Upload any funder\'s blank Word form (.docx)') + '</span></div><input type="file" id="ff-file" accept=".docx" style="display:none"/></label>' +
      '</div>' +
      (!FF.forms.length ? '<div class="cxp-s" style="margin-bottom:8px">Tip: upload a funder\'s form on its contract (Funders → Contracts → ⬆ Form) and it\'s ready here every time.</div>' : '') +
      '<div class="modal-footer"><button class="btn btn-ghost" id="ff-cancel">Cancel</button><button class="btn btn-p" id="ff-go"' + (FF.pick || FF.oneOff ? '' : ' disabled') + '>Fill form</button></div>');
    document.querySelectorAll('#ff-modal .ff-opt[data-id]').forEach(el => el.onclick = () => { FF.pick = el.getAttribute('data-id'); FF.oneOff = null; drawPicker(linked); });
    $id('ff-file').onchange = async ev => {
      const f = ev.target.files && ev.target.files[0]; if (!f) return;
      if (!/\.docx$/i.test(f.name)) { alert('Please choose a Word .docx file. (Older .doc files: open in Word and Save As .docx.)'); return; }
      if (f.size > 3 * 1024 * 1024) { alert('That file is over 3 MB — funder forms are usually much smaller.'); return; }
      FF.oneOff = { name: f.name, data: await fileB64(f) }; FF.pick = null; drawPicker(linked);
    };
    $id('ff-cancel').onclick = ffClose;
    $id('ff-go').onclick = () => runFill();
  }

  async function runFill() {
    const who = [val('mp-fn'), val('mp-ln')].filter(Boolean).join(' ');
    ffModal('<h2>📄 Filling…</h2><div class="cxp-s" style="font-size:13px;line-height:1.6">✨ Reading every question on the form and writing in ' + esc(who || 'the participant') + '\'s answers. This usually takes 10–30 seconds.</div>');
    try {
      let docB64, formName;
      if (FF.oneOff) { docB64 = FF.oneOff.data; formName = FF.oneOff.name.replace(/\.docx$/i, ''); }
      else {
        const { data, error } = await sb.from('contracts').select('name,template_data').eq('id', FF.pick).single();
        if (error || !data) throw new Error('Could not load that form');
        docB64 = data.template_data; formName = data.name;
      }
      const { data: { session } } = await sb.auth.getSession();
      const res = await fetch('/api/fill-form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: session ? 'Bearer ' + session.access_token : '' },
        body: JSON.stringify({ docxBase64: docB64, filename: (formName + ' - ' + who).trim(), orgId: orgId, data: gather() })
      });
      let j; try { j = await res.json(); } catch (e) { throw new Error(res.status === 504 ? 'The form took too long to fill — try again, it is usually quicker the second time' : 'The form filler is not responding (HTTP ' + res.status + ')'); }
      if (!j || j.ok !== true) throw new Error((j && j.error) || 'HTTP ' + res.status);
      FF.last = j;
      showResult(j);
    } catch (e) {
      ffModal('<h2>📄 Couldn\'t fill the form</h2><div class="cxq-status err" style="color:var(--red)">' + esc(e.message || e) + '</div>' +
        '<div class="modal-footer"><button class="btn btn-ghost" id="ff-x">Close</button><button class="btn btn-p" id="ff-retry">Try again</button></div>');
      $id('ff-x').onclick = ffClose; $id('ff-retry').onclick = () => runFill();
    }
  }

  function download(j) {
    const bin = atob(j.filledBase64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = j.filename || 'form-FILLED.docx';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  function showResult(j) {
    const filled = (j.preview || []).length, miss = j.missing || [];
    ffModal('<h2>📄 Form filled</h2>' +
      '<div class="ff-ok">✓ ' + filled + ' answer' + (filled === 1 ? '' : 's') + ' written in. Check it over before sending.</div>' +
      (miss.length ? '<div class="ff-miss"><div style="font-size:13px;font-weight:700;margin-bottom:8px">⚠ ' + miss.length + ' question' + (miss.length === 1 ? '' : 's') + ' left blank — add the answers and fill again</div>' +
        miss.slice(0, 12).map((m, i) => '<div class="form-row"><label>' + esc(String(m.text).replace(/[:_.\s]+$/, '')) + '</label><input data-k="' + esc(String(m.text).replace(/[:_.\s]+$/, '')) + '" class="ff-add" value="' + esc(FF.extra[String(m.text).replace(/[:_.\s]+$/, '')] || '') + '"/></div>').join('') +
        (miss.length > 12 ? '<div class="cxp-s">…and ' + (miss.length - 12) + ' more</div>' : '') + '</div>' : '') +
      (filled ? '<details><summary style="cursor:pointer;font-size:13px;color:var(--txt2);margin-bottom:6px">What was filled</summary><div class="ff-prev">' +
        (j.preview || []).map(p => esc(p.after)).join('<br>') + '</div></details>' : '') +
      '<div class="modal-footer"><button class="btn btn-ghost" id="ff-done">Close</button>' +
        (miss.length ? '<button class="btn btn-ghost" id="ff-again">Save answers &amp; fill again</button>' : '') +
        '<button class="btn btn-p" id="ff-dl">⬇ Download</button></div>');
    $id('ff-done').onclick = ffClose;
    $id('ff-dl').onclick = () => download(j);
    if ($id('ff-again')) $id('ff-again').onclick = async () => {
      document.querySelectorAll('#ff-modal .ff-add').forEach(i => { if (i.value.trim()) FF.extra[i.getAttribute('data-k')] = i.value.trim(); });
      await saveExtras();
      runFill();
    };
  }

  // Answers added here are kept on the participant for next time
  async function saveExtras() {
    const p = currentParticipant(); if (!p || !Object.keys(FF.extra).length || String(p.id).indexOf('demo-') === 0) return;
    try {
      const { data } = await sb.from('participants').select('paperwork').eq('id', p.id).single();
      const pw = Object.assign({}, (data && data.paperwork) || {});
      pw.extra = Object.assign({}, pw.extra || {}, FF.extra);
      await sb.from('participants').update({ paperwork: pw }).eq('id', p.id);
      p.paperwork = pw;
    } catch (e) { console.warn('[fill] could not save extra answers', e); }
  }

  // Saving the participant rebuilds paperwork from the form — keep the extra answers
  function wrapSave() {
    const orig = window.saveP; if (typeof orig !== 'function' || orig._ob) return;
    window.saveP = async function () {
      const p = currentParticipant();
      const extra = p && p.paperwork && p.paperwork.extra;
      const r = await orig.apply(this, arguments);
      if (p && extra && Object.keys(extra).length && String(p.id).indexOf('demo-') !== 0) {
        try {
          const { data } = await sb.from('participants').select('paperwork').eq('id', p.id).single();
          const pw = Object.assign({}, (data && data.paperwork) || {});
          if (!pw.extra) { pw.extra = extra; await sb.from('participants').update({ paperwork: pw }).eq('id', p.id); }
        } catch (e) { /* non-fatal */ }
      }
      return r;
    };
    window.saveP._ob = true;
  }

  function install() {
    wrapOpeners(); wrapSave();
    window.civaraFillFunderForm = openFill;
  }
  // Run after app.html's inline scripts have added their own wrappers
  if (document.readyState === 'complete') setTimeout(install, 0);
  else window.addEventListener('load', () => setTimeout(install, 0));
})();
