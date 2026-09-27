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
