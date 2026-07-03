// js/paperwork.js — Civara auto-fill paperwork (Phase 1: Participant Start Form)
// ---------------------------------------------------------------------------
// window.civaraGenerateStartForm() opens a confirm box, prefilled from the open
// participant (incl. referral background + case notes), and downloads a filled
// Word (.docx) Start Form. No database changes. No external libraries.
//
// Switch on: put this at js/paperwork.js, add <script src="js/paperwork.js"></script>
// to app.html, and a button: onclick="civaraGenerateStartForm()".
'use strict';

(function () {

  /* ---------- tiny ZIP writer (store / no compression) ------------------ */
  function crc32(bytes) {
    let table = crc32._t;
    if (!table) {
      table = crc32._t = [];
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        table[n] = c >>> 0;
      }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ table[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function strBytes(s) { return new TextEncoder().encode(s); }
  function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
  function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

  function makeZip(files) {
    const parts = [], central = [];
    let offset = 0;
    files.forEach(f => {
      const nameB = strBytes(f.name);
      const data = f.data;
      const crc = crc32(data);
      const local = new Uint8Array(
        [].concat(u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
          u32(crc), u32(data.length), u32(data.length), u16(nameB.length), u16(0)));
      parts.push(local, nameB, data);
      const cen = new Uint8Array(
        [].concat(u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
          u32(crc), u32(data.length), u32(data.length),
          u16(nameB.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)));
      central.push(cen, nameB);
      offset += local.length + nameB.length + data.length;
    });
    let centralSize = 0;
    central.forEach(c => centralSize += c.length);
    const end = new Uint8Array(
      [].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
        u32(centralSize), u32(offset), u16(0)));
    const all = parts.concat(central, [end]);
    let total = 0; all.forEach(a => total += a.length);
    const out = new Uint8Array(total);
    let p = 0; all.forEach(a => { out.set(a, p); p += a.length; });
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  /* ---------- OOXML helpers --------------------------------------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function valueRuns(v) {
    const lines = String(v == null ? '' : v).split(/\r?\n/);
    return lines.map((ln, i) =>
      (i ? '<w:br/>' : '') + '<w:t xml:space="preserve">' + esc(ln) + '</w:t>'
    ).join('');
  }
  function cell(text, w, opts) {
    opts = opts || {};
    const shd = opts.fill ? '<w:shd w:val="clear" w:color="auto" w:fill="' + opts.fill + '"/>' : '';
    const bold = opts.bold ? '<w:b/>' : '';
    return '<w:tc><w:tcPr><w:tcW w:w="' + w + '" w:type="dxa"/>' + shd +
      '<w:vAlign w:val="center"/></w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20"/>' +
      '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>' + bold + '<w:sz w:val="20"/></w:rPr></w:pPr>' +
      '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>' + bold + '<w:sz w:val="20"/></w:rPr>' +
      valueRuns(text) + '</w:r></w:p></w:tc>';
  }
  function tblBorder() {
    return '<w:tblBorders>' +
      ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
        .map(b => '<w:' + b + ' w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>').join('') +
      '</w:tblBorders>';
  }
  function rowsTable(rows) {
    const trs = rows.map(r =>
      '<w:tr>' + cell(r[0], 3200, { bold: true, fill: 'F3EEE4' }) + cell(r[1], 5800) + '</w:tr>'
    ).join('');
    return '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/>' + tblBorder() +
      '<w:tblLayout w:type="fixed"/></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="3200"/><w:gridCol w:w="5800"/></w:tblGrid>' + trs + '</w:tbl>';
  }
  function fullBox(text) {
    return '<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/>' + tblBorder() +
      '<w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="9000"/></w:tblGrid>' +
      '<w:tr>' + cell(text && String(text).trim() ? text : '\n\n', 9000) + '</w:tr></w:tbl>';
  }
  function heading(text) {
    return '<w:p><w:pPr><w:spacing w:before="220" w:after="80"/><w:shd w:val="clear" w:color="auto" w:fill="E7E6E6"/>' +
      '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="24"/></w:rPr></w:pPr>' +
      '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:b/><w:sz w:val="24"/></w:rPr>' +
      '<w:t>' + esc(text) + '</w:t></w:r></w:p>';
  }
  function para(text, opts) {
    opts = opts || {};
    const jc = opts.center ? '<w:jc w:val="center"/>' : '';
    const bold = opts.bold ? '<w:b/>' : '';
    const sz = opts.sz || 20;
    const color = opts.color ? '<w:color w:val="' + opts.color + '"/>' : '';
    return '<w:p><w:pPr>' + jc + '<w:spacing w:after="' + (opts.after != null ? opts.after : 60) + '"/>' +
      '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>' + bold + color + '<w:sz w:val="' + sz + '"/></w:rPr></w:pPr>' +
      '<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>' + bold + color + '<w:sz w:val="' + sz + '"/></w:rPr>' +
      valueRuns(text) + '</w:r></w:p>';
  }

  function buildStartFormXml(d) {
    const detail = [
      ['Title', d.title], ['Forename', d.forename], ['Surname', d.surname],
      ['NI number', d.ni], ['Date of birth', d.dob], ['Telephone', d.phone],
      ['Email address', d.email], ['Address', d.address], ['Post code', d.postcode],
      ['Participant ID', d.pid], ['Start date', d.startDate]
    ];
    const referral = [
      ['Referral source', d.referralSource], ['Adviser', d.advisor],
      ['Journey stage', d.stage], ['Risk level', d.risk]
    ];
    const assessment = [
      ['Barriers identified', d.barriers], ['Safeguarding flag', d.safeguarding],
      ['Confidence (1–10)', d.confidence], ['Work readiness (1–10)', d.work],
      ['Wellbeing (1–10)', d.wellbeing], ['Skills (1–10)', d.skills]
    ];
    const chars = [
      ['Gender', d.gender],
      ['Right to live and work in the UK', d.rightToWork],
      ['Basic skills — Maths & English', d.basicSkills],
      ['Labour market status', d.labourStatus],
      ['Needs interpersonal-skills support', d.interpersonal]
    ];
    const provider = [['Delivery organisation', d.provider], ['Programme / project', d.project]];

    const body =
      para('Participant Start Form', { center: true, bold: true, sz: 32, after: 40 }) +
      para('Initial registration & assessment — prepared in Civara on ' + d.generatedOn,
        { center: true, sz: 18, color: '808080', after: 160 }) +
      heading('Part 1: Participant Details') + rowsTable(detail) +
      heading('Part 2: Referral & Background') + rowsTable(referral) +
      para('Referral background', { bold: true, sz: 20, after: 40 }) + fullBox(d.background) +
      heading('Part 3: Initial Assessment') +
      para('Adviser notes / initial assessment', { bold: true, sz: 20, after: 40 }) + fullBox(d.caseNote) +
      rowsTable(assessment) +
      heading('Part 4: Participant Characteristics') + rowsTable(chars) +
      heading('Delivery') + rowsTable(provider) +
      para('', { after: 120 }) +
      para('Participant signature: ______________________________    Date: ____________', { sz: 20, after: 120 }) +
      para('Adviser signature: __________________________________    Date: ____________', { sz: 20 });

    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + body +
      '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>' +
      '</w:sectPr></w:body></w:document>';
  }

  function buildDocxBlob(d) {
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '</Types>';
    const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      '</Relationships>';
    const docRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    return makeZip([
      { name: '[Content_Types].xml', data: strBytes(contentTypes) },
      { name: '_rels/.rels', data: strBytes(rels) },
      { name: 'word/_rels/document.xml.rels', data: strBytes(docRels) },
      { name: 'word/document.xml', data: strBytes(buildStartFormXml(d)) }
    ]);
  }

  /* ---------- data helpers ---------------------------------------------- */
  function fmtDate(v) {
    if (!v) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
    return m ? (m[3] + '/' + m[2] + '/' + m[1]) : String(v);
  }
  function pick(o) {
    for (let i = 1; i < arguments.length; i++) {
      let v = o && o[arguments[i]];
      if (Array.isArray(v)) v = v.join(', ');
      if (v != null && String(v).trim() !== '') return v;
    }
    return '';
  }
  function elVal(id) { const e = document.getElementById(id); return e ? (e.value || '') : ''; }
  function readChecked(containerId) {
    const c = document.getElementById(containerId);
    if (!c) return '';
    const out = [];
    c.querySelectorAll('input[type=checkbox]').forEach(cb => {
      if (cb.checked) {
        const lbl = cb.closest('label');
        out.push(((lbl ? lbl.textContent : (cb.value || '')) || '').trim());
      }
    });
    return out.filter(Boolean).join(', ');
  }
  function ls(key, def) { try { return localStorage.getItem(key) || def || ''; } catch (e) { return def || ''; } }
  function lsSet(key, val) { try { localStorage.setItem(key, val); } catch (e) {} }

  function gatherPrefill(p) {
    p = p || {};
    return {
      title: pick(p, 'title'),
      forename: pick(p, 'forename', 'first_name', 'firstName', 'fn') || elVal('mp-fn'),
      surname: pick(p, 'surname', 'last_name', 'lastName', 'ln') || elVal('mp-ln'),
      ni: pick(p, 'ni_number', 'ni', 'national_insurance', 'nino'),
      dob: fmtDate(pick(p, 'dob', 'date_of_birth', 'dateOfBirth', 'birth_date')),
      phone: pick(p, 'phone', 'telephone', 'tel', 'mobile') || elVal('mp-phone'),
      email: pick(p, 'email', 'email_address') || elVal('mp-email'),
      address: pick(p, 'address', 'address_line', 'street'),
      postcode: pick(p, 'postcode', 'post_code', 'zip'),
      pid: pick(p, 'participant_id', 'pid', 'ref', 'reference', 'id'),
      startDate: fmtDate(pick(p, 'start_date', 'startDate', 'start')) || fmtDate(new Date().toISOString()),
      // referral & background
      referralSource: pick(p, 'referral_source', 'referralSource', 'source') || elVal('mp-rs'),
      advisor: pick(p, 'advisor', 'adviser', 'key_worker') || elVal('mp-adv'),
      stage: pick(p, 'stage', 'journey_stage') || elVal('mp-st'),
      risk: pick(p, 'risk', 'risk_level') || elVal('mp-risk'),
      background: pick(p, 'referral_background', 'background', 'intake', 'intake_text', 'referral_notes') || elVal('mp-intake-text'),
      // assessment
      caseNote: pick(p, 'case_note', 'case_notes', 'notes', 'note', 'assessment') || elVal('mp-note'),
      barriers: pick(p, 'barriers', 'barrier_list') || readChecked('barrier-checks'),
      safeguarding: pick(p, 'safeguarding', 'safeguarding_flag', 'safe') || elVal('mp-safe'),
      confidence: pick(p, 'confidence', 'confidence_score') || elVal('mp-conf'),
      work: pick(p, 'work_readiness', 'work') || elVal('mp-work'),
      wellbeing: pick(p, 'wellbeing') || elVal('mp-well'),
      skills: pick(p, 'skills', 'skills_score') || elVal('mp-skillsc'),
      // characteristics
      gender: pick(p, 'gender'),
      rightToWork: pick(p, 'right_to_work', 'rightToWork'),
      basicSkills: pick(p, 'basic_skills', 'basicSkills'),
      labourStatus: pick(p, 'labour_status', 'labourStatus', 'employment_status'),
      interpersonal: pick(p, 'interpersonal_support', 'interpersonal'),
      provider: ls('civara_provider', ''),
      project: ls('civara_project', '')
    };
  }

  /* ---------- confirm modal --------------------------------------------- */
  function field(label, id, value, type) {
    return '<div style="margin-bottom:11px"><label style="display:block;font-size:12px;font-weight:600;color:#4A5552;margin-bottom:5px">' +
      esc(label) + '</label><input id="' + id + '" type="' + (type || 'text') + '" value="' + esc(value) +
      '" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #E0DAD0;border-radius:9px;font-size:14px;font-family:inherit"/></div>';
  }
  function area(label, id, value) {
    return '<div style="margin-bottom:11px;grid-column:1 / -1"><label style="display:block;font-size:12px;font-weight:600;color:#4A5552;margin-bottom:5px">' +
      esc(label) + '</label><textarea id="' + id + '" style="width:100%;box-sizing:border-box;min-height:84px;padding:9px 11px;border:1px solid #E0DAD0;border-radius:9px;font-size:14px;font-family:inherit;resize:vertical">' +
      esc(value) + '</textarea></div>';
  }
  function select(label, id, value, options) {
    const opts = options.map(o => '<option value="' + esc(o) + '"' + (o === value ? ' selected' : '') + '>' + esc(o || '—') + '</option>').join('');
    return '<div style="margin-bottom:11px"><label style="display:block;font-size:12px;font-weight:600;color:#4A5552;margin-bottom:5px">' +
      esc(label) + '</label><select id="' + id + '" style="width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #E0DAD0;border-radius:9px;font-size:14px;font-family:inherit;background:#fff">' +
      opts + '</select></div>';
  }
  function subhead(t) {
    return '<div style="grid-column:1 / -1;font-size:12px;font-weight:700;color:#7A847F;text-transform:uppercase;letter-spacing:.5px;margin:8px 0 8px">' + esc(t) + '</div>';
  }

  function openStartFormModal(d) {
    closeStartFormModal();
    const wrap = document.createElement('div');
    wrap.id = 'civara-paperwork-overlay';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(23,86,85,.4);z-index:9000;display:flex;align-items:flex-start;justify-content:center;padding:24px;overflow-y:auto';
    wrap.innerHTML =
      '<div style="background:#fff;border:1px solid #E0DAD0;border-radius:14px;max-width:660px;width:100%;margin:auto;padding:24px;box-shadow:0 8px 28px -12px rgba(23,86,85,.4);font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif">' +
      '<div style="font-size:20px;font-weight:700;color:#175655;margin-bottom:4px">Generate Start Form</div>' +
      '<div style="font-size:13px;color:#7A847F;margin-bottom:18px">Details are pulled from the participant — including referral background and case notes. Complete anything missing, then download the filled Word form.</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 14px">' +
        subhead('Delivery') +
        field('Delivery organisation', 'pf-provider', d.provider) +
        field('Programme / project', 'pf-project', d.project) +
        subhead('Participant details') +
        field('Title', 'pf-title', d.title) +
        '<div></div>' +
        field('Forename', 'pf-forename', d.forename) +
        field('Surname', 'pf-surname', d.surname) +
        field('NI number', 'pf-ni', d.ni) +
        field('Date of birth', 'pf-dob', d.dob) +
        field('Telephone', 'pf-phone', d.phone) +
        field('Email', 'pf-email', d.email) +
        field('Address', 'pf-address', d.address) +
        field('Post code', 'pf-postcode', d.postcode) +
        field('Participant ID', 'pf-pid', d.pid) +
        field('Start date', 'pf-start', d.startDate) +
        subhead('Referral & background') +
        field('Referral source', 'pf-refsrc', d.referralSource) +
        field('Adviser', 'pf-advisor', d.advisor) +
        field('Journey stage', 'pf-stage', d.stage) +
        field('Risk level', 'pf-risk', d.risk) +
        area('Referral background', 'pf-background', d.background) +
        subhead('Initial assessment') +
        area('Adviser notes / initial assessment', 'pf-casenote', d.caseNote) +
        field('Barriers identified', 'pf-barriers', d.barriers) +
        field('Safeguarding flag', 'pf-safe', d.safeguarding) +
        field('Confidence (1–10)', 'pf-conf', d.confidence, 'number') +
        field('Work readiness (1–10)', 'pf-work', d.work, 'number') +
        field('Wellbeing (1–10)', 'pf-well', d.wellbeing, 'number') +
        field('Skills (1–10)', 'pf-skills', d.skills, 'number') +
        subhead('Characteristics') +
        select('Gender', 'pf-gender', d.gender, ['', 'Male', 'Female', 'Other', 'Prefer not to say']) +
        select('Right to live & work in UK', 'pf-rtw', d.rightToWork, ['', 'Yes', 'No']) +
        select('Basic skills (Maths & English)', 'pf-bskills', d.basicSkills, ['', 'Yes', 'No']) +
        select('Labour market status', 'pf-labour', d.labourStatus, ['', 'Unemployed', 'Economically inactive']) +
        select('Needs interpersonal-skills support', 'pf-inter', d.interpersonal, ['', 'Yes', 'No']) +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">' +
        '<button id="pf-cancel" style="padding:10px 16px;border-radius:9px;border:1px solid #E0DAD0;background:#fff;color:#4A5552;font-weight:600;cursor:pointer;font-family:inherit">Cancel</button>' +
        '<button id="pf-go" style="padding:10px 18px;border-radius:9px;border:none;background:#1F6F6D;color:#fff;font-weight:600;cursor:pointer;font-family:inherit">📄 Download Start Form</button>' +
      '</div>' +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', e => { if (e.target === wrap) closeStartFormModal(); });
    document.getElementById('pf-cancel').onclick = closeStartFormModal;
    document.getElementById('pf-go').onclick = doGenerate;
  }
  function closeStartFormModal() {
    const el = document.getElementById('civara-paperwork-overlay');
    if (el) el.remove();
  }

  function doGenerate() {
    const d = {
      provider: elVal('pf-provider'), project: elVal('pf-project'),
      title: elVal('pf-title'), forename: elVal('pf-forename'), surname: elVal('pf-surname'),
      ni: elVal('pf-ni'), dob: elVal('pf-dob'), phone: elVal('pf-phone'), email: elVal('pf-email'),
      address: elVal('pf-address'), postcode: elVal('pf-postcode'), pid: elVal('pf-pid'),
      startDate: elVal('pf-start'),
      referralSource: elVal('pf-refsrc'), advisor: elVal('pf-advisor'),
      stage: elVal('pf-stage'), risk: elVal('pf-risk'), background: elVal('pf-background'),
      caseNote: elVal('pf-casenote'), barriers: elVal('pf-barriers'), safeguarding: elVal('pf-safe'),
      confidence: elVal('pf-conf'), work: elVal('pf-work'), wellbeing: elVal('pf-well'), skills: elVal('pf-skills'),
      gender: elVal('pf-gender'), rightToWork: elVal('pf-rtw'), basicSkills: elVal('pf-bskills'),
      labourStatus: elVal('pf-labour'), interpersonal: elVal('pf-inter'),
      generatedOn: new Date().toLocaleDateString('en-GB')
    };
    lsSet('civara_provider', d.provider); lsSet('civara_project', d.project);

    let blob;
    try { blob = buildDocxBlob(d); }
    catch (e) { alert('Sorry — could not build the form: ' + e.message); return; }

    const name = ('Start Form - ' + (d.forename || '') + ' ' + (d.surname || '')).trim().replace(/\s+/g, ' ') || 'Start Form';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name + '.docx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    closeStartFormModal();
  }

  /* ---------- public entry point ---------------------------------------- */
  window.civaraGenerateStartForm = function (p) {
    if (p && p.preventDefault) p = null;
    if (!window.TextEncoder) { alert('This browser is too old to generate the form.'); return; }
    openStartFormModal(gatherPrefill(p));
  };

})();
