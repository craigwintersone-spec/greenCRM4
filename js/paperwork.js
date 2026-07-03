// js/paperwork.js — Civara auto-fill paperwork (Phase 1: Participant Start Form)
// ---------------------------------------------------------------------------
// window.civaraGenerateStartForm() reads the OPEN Add Participant form and
// downloads a filled Word (.docx) Start Form immediately — no second pop-up.
// Fill the participant in once, click "📄 Start Form", done.
// No database changes. No external libraries.
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

  // Read straight from the open Add Participant form (with optional object override).
  function gather(p) {
    p = p || {};
    return {
      title: pick(p, 'title') || elVal('mp-ptitle'),
      forename: pick(p, 'forename', 'first_name', 'firstName', 'fn') || elVal('mp-fn'),
      surname: pick(p, 'surname', 'last_name', 'lastName', 'ln') || elVal('mp-ln'),
      ni: pick(p, 'ni_number', 'ni', 'national_insurance', 'nino') || elVal('mp-ni'),
      dob: fmtDate(pick(p, 'dob', 'date_of_birth', 'dateOfBirth') || elVal('mp-dob')),
      phone: pick(p, 'phone', 'telephone', 'tel', 'mobile') || elVal('mp-phone'),
      email: pick(p, 'email', 'email_address') || elVal('mp-email'),
      address: pick(p, 'address', 'address_line', 'street') || elVal('mp-address'),
      postcode: pick(p, 'postcode', 'post_code', 'zip') || elVal('mp-postcode'),
      pid: pick(p, 'participant_id', 'pid', 'ref', 'reference') || elVal('mp-pid'),
      startDate: fmtDate(pick(p, 'start_date', 'startDate', 'start') || elVal('mp-start')) || fmtDate(new Date().toISOString()),
      referralSource: pick(p, 'referral_source', 'referralSource', 'source') || elVal('mp-rs'),
      advisor: pick(p, 'advisor', 'adviser', 'key_worker') || elVal('mp-adv'),
      stage: pick(p, 'stage', 'journey_stage') || elVal('mp-st'),
      risk: pick(p, 'risk', 'risk_level') || elVal('mp-risk'),
      background: pick(p, 'referral_background', 'background', 'intake', 'intake_text', 'referral_notes') || elVal('mp-intake-text'),
      caseNote: pick(p, 'case_note', 'case_notes', 'notes', 'note', 'assessment') || elVal('mp-note'),
      barriers: pick(p, 'barriers', 'barrier_list') || readChecked('barrier-checks'),
      safeguarding: pick(p, 'safeguarding', 'safeguarding_flag', 'safe') || elVal('mp-safe'),
      confidence: pick(p, 'confidence', 'confidence_score') || elVal('mp-conf'),
      work: pick(p, 'work_readiness', 'work') || elVal('mp-work'),
      wellbeing: pick(p, 'wellbeing') || elVal('mp-well'),
      skills: pick(p, 'skills', 'skills_score') || elVal('mp-skillsc'),
      gender: pick(p, 'gender') || elVal('mp-gender'),
      rightToWork: pick(p, 'right_to_work', 'rightToWork') || elVal('mp-rtw'),
      basicSkills: pick(p, 'basic_skills', 'basicSkills') || elVal('mp-bskills'),
      labourStatus: pick(p, 'labour_status', 'labourStatus', 'employment_status') || elVal('mp-labour'),
      interpersonal: pick(p, 'interpersonal_support', 'interpersonal') || elVal('mp-inter'),
      provider: elVal('mp-provider') || ls('civara_provider', ''),
      project: elVal('mp-project') || ls('civara_project', ''),
      generatedOn: new Date().toLocaleDateString('en-GB')
    };
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // Remember delivery org / project between participants, and prefill the
  // fields when the form is on screen.
  function prefillDelivery() {
    const pv = document.getElementById('mp-provider'), pj = document.getElementById('mp-project');
    if (pv && !pv.value) pv.value = ls('civara_provider', '');
    if (pj && !pj.value) pj.value = ls('civara_project', '');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', prefillDelivery);
  } else {
    prefillDelivery();
  }

  /* ---------- public entry point — generate straight away --------------- */
  window.civaraGenerateStartForm = function (p) {
    if (p && p.preventDefault) p = null;              // called as onclick handler
    if (!window.TextEncoder) { alert('This browser is too old to generate the form.'); return; }
    const d = gather(p);
    if (!d.forename && !d.surname) { alert('Add the participant\u2019s name first, then click Start Form.'); return; }
    lsSet('civara_provider', d.provider); lsSet('civara_project', d.project);
    let blob;
    try { blob = buildDocxBlob(d); }
    catch (e) { alert('Sorry — could not build the form: ' + e.message); return; }
    const name = ('Start Form - ' + (d.forename || '') + ' ' + (d.surname || '')).trim().replace(/\s+/g, ' ') || 'Start Form';
    download(blob, name + '.docx');
  };

})();
