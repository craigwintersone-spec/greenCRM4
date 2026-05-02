// js/extensions/csv-import.js — bulk import participants from a CSV file
// Depends on: utils.js, db.js, render.js
//
// Adds an "Import CSV" button to the Participants page header.
// Provides a 4-step wizard: upload → map columns → preview → import.

(function () {
  'use strict';

  const CSV_FIELDS = [
    { key: 'first_name',   label: 'First name',   required: true,  aliases: ['firstname', 'first', 'given name', 'forename', 'name first'] },
    { key: 'last_name',    label: 'Last name',    required: true,  aliases: ['lastname', 'last', 'surname', 'family name', 'name last'] },
    { key: 'email',        label: 'Email',        aliases: ['e-mail', 'email address', 'mail'] },
    { key: 'phone',        label: 'Phone',        aliases: ['mobile', 'telephone', 'tel', 'contact number', 'phone number'] },
    { key: 'ref_source',   label: 'Referral source', aliases: ['referral', 'source', 'referred by'] },
    { key: 'stage',        label: 'Stage',        aliases: ['status', 'case stage'] },
    { key: 'advisor',      label: 'Advisor',      aliases: ['caseworker', 'keyworker', 'assigned to', 'advisor name'] },
    { key: 'risk',         label: 'Risk level',   aliases: ['risk', 'priority'] },
    { key: 'safeguarding', label: 'Safeguarding flag', aliases: ['safeguarding flag', 'safeguard'] },
    { key: 'barriers',     label: 'Barriers (semicolon-separated)', aliases: ['barrier', 'support needs'] },
    { key: 'last_contact', label: 'Last contact date', aliases: ['last contact date', 'last contacted', 'last seen'] },
    { key: 'notes',        label: 'Notes', aliases: ['note', 'case note', 'comments'] }
  ];
  const STAGE_VALUES = ['Referred', 'Engaged', 'In Support', 'Job Ready', 'Outcome Achieved', 'Sustained', 'Closed'];
  const RISK_VALUES  = ['Low', 'Medium', 'High'];
  const REF_VALUES   = ['Self-referral', 'Probation', 'Jobcentre Plus', 'Community org', 'School / college'];

  let _csv = { file: null, rows: [], headers: [], mapping: {}, validated: [], errors: [] };

  // ── Boot ────────────────────────────────────────────────────
  function whenReady(fn, attempts) {
    if (attempts == null) attempts = 0;
    if (attempts > 60) return;
    if ($('page-participants') && document.querySelector('.nav-btn')) {
      return setTimeout(fn, 400);
    }
    setTimeout(() => whenReady(fn, attempts + 1), 500);
  }
  whenReady(init);

  function init() {
    console.log('[ext:csv-import] initialising');
    injectModal();
    injectImportButton();
    bindCsvModal();
  }

  function injectModal() {
    if ($('modal-csv')) return;
    const m = document.createElement('div');
    m.className = 'modal-overlay';
    m.id = 'modal-csv';
    m.innerHTML = csvModalHTML();
    document.body.appendChild(m);
  }

  function injectImportButton(attempts) {
    if (attempts == null) attempts = 0;
    if (attempts > 30) return;
    const hdr = document.querySelector('#page-participants .page-header');
    if (!hdr) return setTimeout(() => injectImportButton(attempts + 1), 300);
    if (hdr.querySelector('[data-civara-import]')) return;
    const right = hdr.querySelector('button.btn-p');
    if (!right) return;
    const btn = document.createElement('button');
    btn.className = 'btn btn-ghost btn-sm';
    btn.style.marginRight = '8px';
    btn.dataset.civaraImport = '1';
    btn.textContent = '⬆ Import CSV';
    btn.addEventListener('click', openCsvImport);
    right.parentNode.insertBefore(btn, right);
  }

  function csvModalHTML() {
    return '<div class="modal" style="max-width:760px">' +
      '<h2>Import participants from spreadsheet</h2>' +
      '<div class="csv-stepper">' +
        '<div class="pip active" id="csv-pip-1"></div>' +
        '<div class="pip" id="csv-pip-2"></div>' +
        '<div class="pip" id="csv-pip-3"></div>' +
        '<div class="pip" id="csv-pip-4"></div>' +
      '</div>' +
      '<div class="csv-step active" id="csv-step-1">' +
        '<p style="font-size:13px;color:var(--txt2);margin-bottom:14px;line-height:1.6">Upload a <strong>CSV</strong> file. We\'ll match your columns to participant fields in the next step. <a href="#" id="csv-template-link" style="color:var(--em);text-decoration:underline">Download a blank template</a>.</p>' +
        '<div class="csv-drop" id="csv-drop">' +
          '<div style="font-size:30px;margin-bottom:8px">📄</div>' +
          '<div style="font-size:13px;font-weight:600;margin-bottom:4px">Drop a CSV file here, or click to choose</div>' +
          '<div style="font-size:11px;color:var(--txt3)">.csv files · UTF-8 · up to 5,000 rows</div>' +
        '</div>' +
        '<input type="file" id="csv-file-input" accept=".csv,text/csv" style="display:none"/>' +
        '<div id="csv-file-status" style="margin-top:10px;font-size:12px;color:var(--txt3)"></div>' +
      '</div>' +
      '<div class="csv-step" id="csv-step-2">' +
        '<p style="font-size:13px;color:var(--txt2);margin-bottom:14px;line-height:1.6">We\'ve matched your columns where we could. Confirm or adjust each one. Required fields: <strong>First name, Last name</strong>.</p>' +
        '<div id="csv-mapping-list" style="background:#FFFFFF;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden"></div>' +
      '</div>' +
      '<div class="csv-step" id="csv-step-3">' +
        '<p style="font-size:13px;color:var(--txt2);margin-bottom:14px;line-height:1.6">Preview of the first 8 rows. Rows with issues are highlighted — they\'ll still import, but we\'ll skip the bad fields.</p>' +
        '<div style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius)"><table class="csv-preview-table" id="csv-preview-table"></table></div>' +
        '<div id="csv-validation-summary" class="csv-summary"></div>' +
      '</div>' +
      '<div class="csv-step" id="csv-step-4">' +
        '<div id="csv-import-progress"></div>' +
      '</div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-ghost" id="csv-cancel-btn">Cancel</button>' +
        '<button class="btn btn-ghost" id="csv-back-btn" style="display:none">Back</button>' +
        '<button class="btn btn-p" id="csv-next-btn" disabled>Next →</button>' +
      '</div>' +
    '</div>';
  }

  function bindCsvModal() {
    $('csv-cancel-btn').addEventListener('click', () => closeModal('modal-csv'));
    $('csv-back-btn').addEventListener('click', csvBack);
    $('csv-next-btn').addEventListener('click', csvNext);
    $('csv-template-link').addEventListener('click', e => { e.preventDefault(); downloadCsvTemplate(); });
    $('csv-drop').addEventListener('click', () => $('csv-file-input').click());
    $('csv-file-input').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      if (f) handleCsvFile(f);
    });
    const drop = $('csv-drop');
    drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('dragover'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
    drop.addEventListener('drop', e => {
      e.preventDefault(); drop.classList.remove('dragover');
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleCsvFile(f);
    });
  }

  function openCsvImport() {
    _csv = { file: null, rows: [], headers: [], mapping: {}, validated: [], errors: [] };
    csvShowStep(1);
    $('csv-file-status').textContent = '';
    $('csv-next-btn').disabled = true;
    $('modal-csv').classList.add('open');
  }

  function csvShowStep(n) {
    for (let i = 1; i <= 4; i++) {
      const step = $('csv-step-' + i);
      if (step) step.classList.toggle('active', i === n);
      const pip = $('csv-pip-' + i);
      if (pip) { pip.classList.toggle('active', i === n); pip.classList.toggle('done', i < n); }
    }
    $('csv-back-btn').style.display = (n > 1 && n < 4) ? 'inline-flex' : 'none';
    $('csv-next-btn').textContent = n === 3 ? 'Import →' : n === 4 ? 'Done' : 'Next →';
  }

  function downloadCsvTemplate() {
    const headers = CSV_FIELDS.map(f => f.label);
    const sample  = ['Aisha', 'Okonkwo', 'aisha@example.com', '07700900001', 'Probation', 'Engaged', 'Sarah T.', 'Medium', '', 'Confidence;Housing', '2025-01-15', 'Initial assessment'];
    downloadCSV([headers, sample], 'civara-participant-import-template.csv');
  }

  function handleCsvFile(file) {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      $('csv-file-status').innerHTML = '<span style="color:var(--red)">⚠ Please choose a .csv file. Excel files: open in Excel and use File → Save As → CSV (UTF-8).</span>';
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      $('csv-file-status').innerHTML = '<span style="color:var(--red)">⚠ File too large (max 5MB).</span>';
      return;
    }
    _csv.file = file;
    $('csv-file-status').textContent = 'Reading ' + file.name + '…';
    const r = new FileReader();
    r.onload = e => {
      try {
        const parsed = parseCsv(e.target.result);
        if (!parsed.rows.length) throw new Error('No data rows found in CSV.');
        _csv.headers = parsed.headers;
        _csv.rows = parsed.rows;
        _csv.mapping = autoMapColumns(parsed.headers);
        $('csv-file-status').innerHTML = '✓ Read ' + parsed.rows.length + ' row' +
          (parsed.rows.length === 1 ? '' : 's') + ' with ' + parsed.headers.length + ' columns.';
        $('csv-next-btn').disabled = false;
      } catch (err) {
        $('csv-file-status').innerHTML = '<span style="color:var(--red)">⚠ ' + escapeHTML(err.message) + '</span>';
      }
    };
    r.onerror = () => $('csv-file-status').innerHTML = '<span style="color:var(--red)">⚠ Could not read file.</span>';
    r.readAsText(file, 'utf-8');
  }

  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, '');
    const rows = []; let cur = []; let field = ''; let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], n = text[i + 1];
      if (inQuotes) {
        if (c === '"' && n === '"') { field += '"'; i++; }
        else if (c === '"') { inQuotes = false; }
        else field += c;
      } else {
        if (c === '"') { inQuotes = true; }
        else if (c === ',') { cur.push(field); field = ''; }
        else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
      }
    }
    if (field.length || cur.length) { cur.push(field); rows.push(cur); }
    if (!rows.length) throw new Error('CSV is empty.');
    const headers = rows.shift().map(h => h.trim());
    while (rows.length && rows[rows.length - 1].every(c => !String(c).trim())) rows.pop();
    return { headers, rows };
  }

  function autoMapColumns(headers) {
    const map = {};
    headers.forEach((h, i) => {
      const norm = h.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
      for (let j = 0; j < CSV_FIELDS.length; j++) {
        const f = CSV_FIELDS[j];
        const aliases = f.aliases || [];
        if (norm === f.key.replace(/_/g, ' ') || norm === f.label.toLowerCase() || aliases.indexOf(norm) >= 0) {
          map[f.key] = i;
          break;
        }
      }
    });
    return map;
  }

  function csvBack() {
    const cur = [1, 2, 3, 4].find(n => $('csv-step-' + n).classList.contains('active'));
    if (cur > 1) csvShowStep(cur - 1);
  }

  async function csvNext() {
    const cur = [1, 2, 3, 4].find(n => $('csv-step-' + n).classList.contains('active'));
    if (cur === 1) { renderMappingStep(); csvShowStep(2); }
    else if (cur === 2) {
      if (_csv.mapping.first_name === undefined || _csv.mapping.last_name === undefined) {
        alert('First name and last name must both be mapped.');
        return;
      }
      runValidation(); renderPreviewStep(); csvShowStep(3);
    }
    else if (cur === 3) { csvShowStep(4); await runImport(); }
    else if (cur === 4) {
      closeModal('modal-csv');
      if (typeof window.go === 'function') window.go('participants');
    }
  }

  function renderMappingStep() {
    const wrap = $('csv-mapping-list');
    wrap.innerHTML = CSV_FIELDS.map(f => {
      const sel = _csv.mapping[f.key];
      const opts = '<option value="">— skip —</option>' +
        _csv.headers.map((h, i) =>
          '<option value="' + i + '"' + (sel === i ? ' selected' : '') + '>' + escapeHTML(h) + '</option>'
        ).join('');
      return '<div class="csv-map-row">' +
        '<div><div style="font-size:13px;font-weight:600;color:var(--txt)">' + escapeHTML(f.label) +
          (f.required ? ' <span style="color:var(--red)">*</span>' : '') + '</div></div>' +
        '<div class="csv-map-arrow">←</div>' +
        '<div><select data-mapfield="' + f.key + '">' + opts + '</select></div>' +
      '</div>';
    }).join('');
    wrap.querySelectorAll('select[data-mapfield]').forEach(sel => {
      sel.addEventListener('change', e => {
        const key = e.target.dataset.mapfield;
        const val = e.target.value;
        if (val === '' || val === null) delete _csv.mapping[key];
        else _csv.mapping[key] = parseInt(val, 10);
      });
    });
  }

  function runValidation() {
    _csv.validated = []; _csv.errors = [];
    _csv.rows.forEach((row, idx) => {
      const issues = [];
      const get = k => _csv.mapping[k] !== undefined ? String(row[_csv.mapping[k]] || '').trim() : '';
      const fn = get('first_name'), ln = get('last_name');
      if (!fn) issues.push('missing first name');
      if (!ln) issues.push('missing last name');
      let stage = get('stage');
      if (stage && STAGE_VALUES.indexOf(stage) < 0) {
        const guess = STAGE_VALUES.find(s => s.toLowerCase() === stage.toLowerCase());
        if (guess) stage = guess;
        else { issues.push('stage "' + stage + '" not recognised — defaulted to Referred'); stage = 'Referred'; }
      }
      let risk = get('risk');
      if (risk && RISK_VALUES.indexOf(risk) < 0) {
        const guess = RISK_VALUES.find(s => s.toLowerCase() === risk.toLowerCase());
        if (guess) risk = guess;
        else { issues.push('risk "' + risk + '" not recognised — defaulted to Low'); risk = 'Low'; }
      }
      let ref = get('ref_source');
      if (ref && REF_VALUES.indexOf(ref) < 0) {
        const guess = REF_VALUES.find(s => s.toLowerCase() === ref.toLowerCase());
        if (guess) ref = guess; else ref = 'Self-referral';
      }
      let lc = get('last_contact');
      if (lc) {
        const d = new Date(lc);
        if (isNaN(d)) lc = ''; else lc = d.toISOString().split('T')[0];
      }
      const barriersRaw = get('barriers');
      const barriers = barriersRaw ? barriersRaw.split(/[;|]/).map(s => s.trim()).filter(Boolean) : [];
      const noteText = get('notes');
      const record = {
        first_name:   fn || '(blank)',
        last_name:    ln || '(blank)',
        email:        get('email'),
        phone:        get('phone'),
        ref_source:   ref || 'Self-referral',
        stage:        stage || 'Referred',
        advisor:      get('advisor') || 'Unassigned',
        risk:         risk || 'Low',
        safeguarding: get('safeguarding') || null,
        barriers:     barriers,
        outcomes:     [],
        last_contact: lc || null,
        notes:        noteText ? [{ t: noteText, d: today(), s: 'Imported' }] : [],
        contract_ids: [],
        equality_data: {},
        scores:       {},
        _rowIndex:    idx + 2,
        _issues:      issues
      };
      _csv.validated.push(record);
      if (issues.length) _csv.errors.push({ row: record._rowIndex, issues });
    });
  }

  function renderPreviewStep() {
    const t = $('csv-preview-table');
    const cols = ['first_name', 'last_name', 'email', 'stage', 'advisor', 'risk', 'barriers', 'last_contact'];
    const head = '<thead><tr><th style="width:30px">#</th>' + cols.map(c => '<th>' + c.replace(/_/g, ' ') + '</th>').join('') + '</tr></thead>';
    const body = '<tbody>' + _csv.validated.slice(0, 8).map(r => {
      const issueClass = r._issues.length ? ' class="csv-issue"' : '';
      return '<tr' + issueClass + '><td>' + r._rowIndex + '</td>' +
        cols.map(c => {
          let v = r[c]; if (Array.isArray(v)) v = v.join('; ');
          return '<td title="' + escapeHTML(v || '') + '">' + escapeHTML(v || '') + '</td>';
        }).join('') + '</tr>';
    }).join('') + '</tbody>';
    t.innerHTML = head + body;

    const total = _csv.validated.length, withIssues = _csv.errors.length, clean = total - withIssues;
    $('csv-validation-summary').innerHTML =
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:8px">' +
        '<div><div style="font-size:11px;color:var(--txt3);font-weight:600">Total rows</div><div style="font-size:18px;font-weight:700;color:var(--txt)">' + total + '</div></div>' +
        '<div><div style="font-size:11px;color:var(--txt3);font-weight:600">Clean</div><div style="font-size:18px;font-weight:700;color:var(--em)">' + clean + '</div></div>' +
        '<div><div style="font-size:11px;color:var(--txt3);font-weight:600">With issues</div><div style="font-size:18px;font-weight:700;color:' + (withIssues ? 'var(--amber)' : 'var(--em)') + '">' + withIssues + '</div></div>' +
      '</div>' +
      (withIssues
        ? '<div style="font-size:12px;color:var(--txt2)">Issues are non-blocking — bad fields will be skipped, the row will still import.</div>'
        : '<div style="font-size:12px;color:var(--em)">✓ All rows look good.</div>');
  }

  async function runImport() {
    const wrap = $('csv-import-progress');
    if (!sb || !orgId || typeof window.sbInsert !== 'function') {
      wrap.innerHTML = '<div class="alert alert-warn">Cannot import — not connected to your organisation. Refresh and try again.</div>';
      return;
    }
    const total = _csv.validated.length;
    let done = 0, failed = 0; const failures = [];

    wrap.innerHTML =
      '<div class="brain-panel"><div class="brain-header"><div class="brain-icon">📥</div>' +
      '<div><div class="brain-title">Importing ' + total + ' participant' + (total === 1 ? '' : 's') + '…</div>' +
      '<div class="brain-sub" id="csv-prog-sub">Starting…</div></div></div>' +
      '<div style="background:var(--bg);border-radius:8px;height:8px;overflow:hidden">' +
      '<div id="csv-prog-bar" style="height:100%;width:0%;background:var(--em);transition:width .2s"></div></div></div>';
    $('csv-next-btn').disabled = true;
    $('csv-back-btn').style.display = 'none';

    for (let i = 0; i < _csv.validated.length; i++) {
      const rec = _csv.validated[i];
      try {
        const payload = Object.assign({}, rec);
        delete payload._rowIndex; delete payload._issues;
        await window.sbInsert('participants', payload);
        done++;
      } catch (e) {
        failed++;
        failures.push({ row: rec._rowIndex, name: rec.first_name + ' ' + rec.last_name, error: e.message });
      }
      const prog = Math.round((done + failed) / total * 100);
      const bar = $('csv-prog-bar'), sub = $('csv-prog-sub');
      if (bar) bar.style.width = prog + '%';
      if (sub) sub.textContent = (done + failed) + ' of ' + total + ' processed · ' + done + ' imported';
    }

    if (typeof window.refreshTable === 'function') {
      try { await window.refreshTable('participants'); } catch (e) { /* ignore */ }
    }

    wrap.innerHTML =
      '<div class="alert ' + (failed ? 'alert-warn' : 'alert-ok') + '" style="margin-bottom:14px">' +
      (failed ? '⚠' : '✓') + ' Import finished — <strong>' + done + '</strong> imported' +
      (failed ? ', <strong>' + failed + '</strong> failed' : '') + '.</div>' +
      (failed
        ? '<div style="font-size:12px;color:var(--txt2);margin-bottom:8px">Failed rows:</div>' +
          '<div style="max-height:140px;overflow-y:auto;background:var(--bg);border-radius:8px;padding:10px;font-size:12px">' +
          failures.map(f => 'Row ' + f.row + ' (' + escapeHTML(f.name) + ') — ' + escapeHTML(f.error)).join('<br/>') +
          '</div>'
        : '');
    $('csv-next-btn').disabled = false;
    $('csv-next-btn').textContent = 'Done';
  }

})();
