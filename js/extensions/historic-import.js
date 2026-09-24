// js/extensions/historic-import.js  — v2.0
// ─────────────────────────────────────────────────────────────
// HISTORIC DATA IMPORT — events, volunteer hours, feedback.
//
// Three steps, run in order (or individually):
//   1. Events            → creates events, optionally linked to a contract
//   2. Volunteers/hours  → creates volunteers it hasn't seen, logs hours
//   3. Feedback          → attendee responses — ANY survey, e.g. a
//                          Google Forms export with the org's own questions
//
// v2.0 — built from Project Abundance's real Google Forms export:
//   • Tab- OR comma-separated files (Google Sheets copies as tabs).
//   • US (7/18/2026) or UK (18/07/2026) dates, with or without a time —
//     detected from the data, overridable.
//   • Feedback with NO event column: each place + date becomes a session,
//     matched to an existing event or created.
//   • The org's OWN questions are kept word-for-word in feedback.answers.
//     Agree/disagree text and 1–5 numbers become scores.
//   • Obvious questions map onto Vorlana's own fields (felt connected,
//     made a friend, comments → quotes).
//   • NO SCORE IS EVER INVENTED. v1 filled missing scores with 4/3/3 — gone.
//   • Personal-data columns (email, phone, "name and email") are detected
//     and EXCLUDED. Feedback stays anonymous; nothing is stored.
//
// Needs (SQL, once):
//   alter table feedback add column if not exists answers jsonb default '{}';
//   alter table feedback alter column enjoyed drop not null;
//   alter table feedback alter column cb drop not null;
//   alter table feedback alter column ca drop not null;
'use strict';

(function () {

var VERSION = 'v2.1';
var BATCH = 500;
var MAX_ROWS = 10000;

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function n(v) { return isNaN(+v) ? 0 : +v; }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }
function pad(x) { x = String(x); return x.length < 2 ? '0' + x : x; }

// ── file parsing (comma OR tab) ────────────────────────────
function detectDelimiter(text) {
  var first = text.split(/\r?\n/)[0] || '';
  var tabs = (first.match(/\t/g) || []).length;
  var commas = (first.match(/,/g) || []).length;
  return tabs > commas ? '\t' : ',';
}

function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  var delim = detectDelimiter(text);
  var rows = [], cur = [], field = '', inQ = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i], nx = text[i + 1];
    if (inQ) {
      if (c === '"' && nx === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === delim) { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  if (!rows.length) throw new Error('That file appears to be empty.');
  var headers = rows.shift().map(function (h) { return String(h).trim(); });
  while (rows.length && rows[rows.length - 1].every(function (c) { return !String(c).trim(); })) rows.pop();
  return { headers: headers, rows: rows, delim: delim };
}

// ── dates — detect day-first vs month-first from the data ──
var DATE_RE = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[\sT]|$)/;

function detectDateOrder(values) {
  var mdy = false, dmy = false;
  values.forEach(function (v) {
    var m = DATE_RE.exec(String(v || '').trim());
    if (!m) return;
    if (+m[1] > 12) dmy = true;
    if (+m[2] > 12) mdy = true;
  });
  if (mdy && !dmy) return 'mdy';
  return 'dmy'; // UK default when ambiguous
}

function parseDate(v, order) {
  if (!v) return null;
  var s = String(v).trim();
  if (!s) return null;
  var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return iso[1] + '-' + pad(iso[2]) + '-' + pad(iso[3]);
  var m = DATE_RE.exec(s);
  if (m) {
    var a = +m[1], b = +m[2];
    var y = m[3].length === 2 ? ('20' + m[3]) : m[3];
    var day = order === 'mdy' ? b : a;
    var mon = order === 'mdy' ? a : b;
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return y + '-' + pad(mon) + '-' + pad(day);
  }
  var d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function parseHours(v) {
  if (v == null || v === '') return 0;
  var s = String(v).trim();
  var hm = /^(\d+)\s*:\s*(\d{1,2})$/.exec(s);
  if (hm) return +hm[1] + (+hm[2]) / 60;
  var hAndM = /^(\d+(?:\.\d+)?)\s*h(?:ours?)?(?:\s*(\d+)\s*m)?/i.exec(s);
  if (hAndM) return +hAndM[1] + (hAndM[2] ? (+hAndM[2]) / 60 : 0);
  var f = parseFloat(s.replace(/[^0-9.]/g, ''));
  return isNaN(f) ? 0 : f;
}

// Agree/disagree text or a 1–10 number → score. Anything else → null.
var LIKERT = {
  'strongly disagree': 1, 'disagree': 2, 'somewhat disagree': 2,
  'neutral': 3, 'neither agree nor disagree': 3, 'neither': 3, 'not sure': 3,
  'somewhat agree': 4, 'agree': 4, 'strongly agree': 5,
  'very poor': 1, 'poor': 2, 'average': 3, 'ok': 3, 'good': 4, 'very good': 5, 'excellent': 5
};
function toScore(v) {
  var s = norm(v);
  if (!s) return null;
  if (LIKERT[s] != null) return LIKERT[s];
  if (/^\d+(\.\d+)?$/.test(s)) { var x = +s; return (x >= 0 && x <= 10) ? x : null; }
  return null;
}
function truthy(v) {
  var s = norm(v);
  if (!s) return false;
  var sc = toScore(v);
  if (sc != null) return sc >= 4;          // agree / 4-5 counts as yes
  return /^(y|yes|yeah|true|1|x|✓|definitely|absolutely)\b/.test(s);
}

// ── column detection ───────────────────────────────────────
// Phrases of 8+ characters match anywhere in the header; shorter
// words must match the start (so "activity" can't grab a random column).
var SCHEMAS = {
  events: [
    { key: 'name',      label: 'Event name',   required: true,  match: ['event name', 'event', 'name', 'title', 'session', 'workshop'] },
    { key: 'date',      label: 'Date',         required: true,  match: ['event date', 'date', 'when', 'day', 'session date'] },
    { key: 'type',      label: 'Type',         match: ['event type', 'type', 'category', 'kind', 'strand'] },
    { key: 'location',  label: 'Location',     match: ['location', 'venue', 'where', 'site', 'place'] },
    { key: 'attendees', label: 'Attendees',    match: ['attendees', 'attendance', 'participants', 'numbers', 'headcount'] },
    { key: 'capacity',  label: 'Capacity',     match: ['capacity', 'places', 'spaces'] },
    { key: 'contract',  label: 'Funder / contract', match: ['funder', 'contract', 'funded by', 'grant', 'programme'] }
  ],
  hours: [
    { key: 'volunteer', label: 'Volunteer name', required: true, match: ['volunteer name', 'volunteer', 'full name', 'name', 'person'] },
    { key: 'email',     label: 'Email',          match: ['email', 'e-mail'] },
    { key: 'date',      label: 'Date',           required: true, match: ['session date', 'date', 'day', 'when'] },
    { key: 'hours',     label: 'Hours',          required: true, match: ['hours worked', 'hours', 'hrs', 'duration', 'time'] },
    { key: 'event',     label: 'Event',          match: ['event name', 'event', 'session', 'workshop', 'project'] },
    { key: 'activity',  label: 'What they did',  match: ['activity', 'task', 'role', 'description', 'notes'] },
    { key: 'phone',     label: 'Phone',          match: ['phone', 'mobile', 'tel'] }
  ],
  feedback: [
    { key: 'event',     label: 'Event name',          match: ['event name', 'session name', 'event'] },
    { key: 'location',  label: 'Location / venue',    match: ['where did you attend', 'which workshop did you attend', 'location', 'venue', 'site'] },
    { key: 'date',      label: 'Date / timestamp',    match: ['timestamp', 'submitted at', 'date', 'completed'] },
    { key: 'enjoyed',   label: 'Enjoyment (1-5)',     match: ['how much did you enjoy', 'enjoyment', 'enjoyed', 'overall rating', 'rating'] },
    { key: 'cb',        label: 'Confidence before',   match: ['confidence before', 'before'] },
    { key: 'ca',        label: 'Confidence after',    match: ['confidence after', 'after'] },
    { key: 'connected', label: 'Felt connected',      match: ['social connection', 'more connected', 'felt connected', 'less lonely', 'belonging', 'connected'] },
    { key: 'learned',   label: 'Learned / more skilled', match: ['more confident in my', 'learned something', 'learnt something', 'new skills', 'learned', 'learnt'] },
    { key: 'friend',    label: 'Made a friend',       match: ['new friend', 'made a friend', 'make a friend', 'friend'] },
    { key: 'quote',     label: 'Comments (quote)',    match: ['what did you enjoy most', 'what could we improve', 'any other comments', 'comments', 'comment', 'anything else', 'quote'] }
  ]
};

function hitMatches(header, hit) {
  if (hit.length >= 8) return header.indexOf(hit) !== -1;
  return header === hit || header.indexOf(hit + ' ') === 0 || header.indexOf(hit) === 0;
}

// Personal data: never imported for feedback.
function isPersonalColumn(h) {
  var x = norm(h);
  return /e-?mail|phone|mobile|telephone|postcode|address/.test(x) ||
         /\byour name\b/.test(x) || /^name$/.test(x) || /name and email/.test(x) || /full name/.test(x);
}

function autoMap(headers, schema, kind) {
  var map = {};
  var used = {};
  headers.forEach(function (h, i) {
    if (kind === 'feedback' && isPersonalColumn(h)) return;
    var hn = norm(h).replace(/[^a-z0-9 '?]/g, ' ').replace(/\s+/g, ' ').trim();
    for (var s = 0; s < schema.length; s++) {
      var key = schema[s].key;
      if (map[key] != null) continue;
      var hits = schema[s].match;
      for (var m = 0; m < hits.length; m++) {
        if (hitMatches(hn, hits[m])) { map[key] = i; used[i] = 1; return; }
      }
    }
  });
  return map;
}

// ── batched insert, with a friendly fallback for the answers column ──
function insertBatched(table, rows, onProgress) {
  if (!rows.length) return Promise.resolve({ inserted: 0, failed: 0, errors: [], ids: [] });
  var done = 0, failed = 0, errors = [];
  var chunks = [];
  for (var i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH));

  return chunks.reduce(function (p, chunk) {
    return p.then(function () {
      return sb.from(table).insert(chunk).then(function (res) {
        if (res && res.error) throw res.error;
        done += chunk.length;
      }).catch(function (e) {
        var msg = (e && e.message) || String(e);
        // answers column not created yet — retry this chunk without it
        if (table === 'feedback' && /answers/i.test(msg)) {
          var stripped = chunk.map(function (r) { var c = Object.assign({}, r); delete c.answers; return c; });
          return sb.from(table).insert(stripped).then(function (res2) {
            if (res2 && res2.error) throw res2.error;
            done += chunk.length;
            if (errors.indexOf('ANSWERS_MISSING') === -1) errors.push('ANSWERS_MISSING');
          }).catch(function (e2) {
            failed += chunk.length;
            if (errors.length < 3) errors.push((e2 && e2.message) || String(e2));
          });
        }
        failed += chunk.length;
        if (errors.length < 3) errors.push(msg);
      }).then(function () {
        if (onProgress) onProgress(done + failed, rows.length);
      });
    });
  }, Promise.resolve()).then(function () {
    return { inserted: done, failed: failed, errors: errors };
  });
}

// ── state ──────────────────────────────────────────────────
var S = { kind: 'events', headers: [], rows: [], map: {}, plan: null, dateOrder: 'dmy', delim: ',' };

// ── modal ──────────────────────────────────────────────────
function injectModal() {
  if ($('modal-himport')) return;
  var m = document.createElement('div');
  m.className = 'modal-overlay';
  m.id = 'modal-himport';
  m.innerHTML =
    '<div class="modal" style="max-width:760px">' +
      '<h2>Import historic data</h2>' +
      '<p style="font-size:13px;color:var(--txt2);line-height:1.7;margin-bottom:14px">' +
        'Bring in what you already have — including a Google Forms export. Import events first, then volunteer hours, ' +
        'then feedback. Drop a file in and we work out the columns.' +
      '</p>' +

      '<div class="vtab-bar" style="margin-bottom:16px">' +
        '<button class="vtab-btn active" data-kind="events">① Events</button>' +
        '<button class="vtab-btn" data-kind="hours">② Volunteers &amp; hours</button>' +
        '<button class="vtab-btn" data-kind="feedback">③ Feedback</button>' +
      '</div>' +

      '<div id="hi-hint" style="font-size:12px;color:var(--txt3);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:12px"></div>' +

      '<div id="hi-opts" style="display:none;margin-bottom:12px">' +
        '<div class="form-grid-3">' +
          '<div class="form-row" id="hi-bulk-wrap"><label>Link events to a funder / contract</label>' +
            '<select id="hi-bulk-contract"><option value="">— leave unlinked —</option></select></div>' +
          '<div class="form-row" id="hi-prefix-wrap" style="display:none"><label>Name new sessions</label>' +
            '<input id="hi-ev-prefix" value="Workshop" placeholder="e.g. Growing workshop"/></div>' +
          '<div class="form-row" id="hi-type-wrap" style="display:none"><label>Session type</label>' +
            '<select id="hi-ev-type"><option>Green Skills</option><option>Wellbeing</option><option>Community Event</option><option>Frailty</option><option>Other</option></select></div>' +
          '<div class="form-row"><label>Dates in this file</label>' +
            '<select id="hi-date-order"><option value="auto">Detect automatically</option><option value="dmy">Day first (UK) 18/07/2026</option><option value="mdy">Month first (US) 7/18/2026</option></select></div>' +
        '</div>' +
      '</div>' +

      '<div id="hi-drop" style="border:2px dashed var(--border);border-radius:12px;padding:26px;text-align:center;cursor:pointer;transition:border-color .15s">' +
        '<div style="font-size:30px;margin-bottom:6px">📄</div>' +
        '<div style="font-size:14px;font-weight:700;color:var(--txt)">Drop a CSV here, or click to choose</div>' +
        '<div style="font-size:11px;color:var(--txt3);margin-top:4px">Google Forms: Responses → Sheets → File → Download → CSV · Excel: Save As → CSV UTF-8</div>' +
      '</div>' +
      '<input type="file" id="hi-file" accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values" style="display:none"/>' +

      '<div id="hi-status" style="font-size:13px;margin-top:10px"></div>' +
      '<div id="hi-mapping" style="margin-top:12px;display:none"></div>' +
      '<div id="hi-plan" style="margin-top:12px"></div>' +

      '<div class="modal-footer">' +
        '<button class="btn btn-ghost" id="hi-close">Close</button>' +
        '<button class="btn btn-p" id="hi-run" disabled>Import</button>' +
      '</div>' +
    '</div>';
  document.body.appendChild(m);

  m.querySelectorAll('.vtab-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      m.querySelectorAll('.vtab-btn').forEach(function (x) { x.classList.remove('active'); });
      b.classList.add('active');
      S.kind = b.getAttribute('data-kind');
      reset();
    });
  });

  $('hi-close').addEventListener('click', function () { m.classList.remove('open'); });
  $('hi-drop').addEventListener('click', function () { $('hi-file').click(); });
  $('hi-file').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) readFile(f);
  });
  var drop = $('hi-drop');
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.style.borderColor = 'var(--em)'; });
  drop.addEventListener('dragleave', function () { drop.style.borderColor = 'var(--border)'; });
  drop.addEventListener('drop', function (e) {
    e.preventDefault(); drop.style.borderColor = 'var(--border)';
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });
  ['hi-bulk-contract', 'hi-ev-prefix', 'hi-ev-type', 'hi-date-order'].forEach(function (id) {
    $(id).addEventListener('change', function () { if (S.rows.length) { resolveDateOrder(); buildPlan(); } });
  });
  $('hi-run').addEventListener('click', runImport);
}

var HINTS = {
  events: 'Needs at least: <strong>event name</strong> and <strong>date</strong>. Also reads type, location, attendees, capacity, and a funder/contract column.',
  hours: 'Needs at least: <strong>volunteer name</strong>, <strong>date</strong> and <strong>hours</strong>. Volunteers not already on your list are created.',
  feedback: 'Works with <strong>your own survey</strong> — e.g. a Google Forms export. Needs an <strong>event</strong> column, or a <strong>place + date</strong> (each place and date becomes a session). ' +
            'Every question is kept word-for-word. Columns asking for names, emails or phone numbers are <strong>left out</strong> — feedback stays anonymous.'
};

function paintOptions() {
  var opts = $('hi-opts');
  if (!opts) return;
  opts.style.display = 'block';
  var list = DB.contracts || [];
  var sel = $('hi-bulk-contract');
  var cur = sel.value;
  sel.innerHTML = '<option value="">— leave unlinked —</option>' +
    list.map(function (c) {
      var f = (DB.funders || []).filter(function (x) { return String(x.id) === String(c.funder_id); })[0];
      return '<option value="' + esc(String(c.id)) + '">' + esc(c.name + (f ? ' · ' + f.name : '')) + '</option>';
    }).join('');
  if (cur) sel.value = cur;
  $('hi-bulk-wrap').style.display = (S.kind !== 'hours' && list.length) ? '' : 'none';
  $('hi-prefix-wrap').style.display = S.kind === 'feedback' ? '' : 'none';
  $('hi-type-wrap').style.display = S.kind === 'feedback' ? '' : 'none';
}

function reset() {
  S.headers = []; S.rows = []; S.map = {}; S.plan = null;
  $('hi-status').innerHTML = '';
  $('hi-plan').innerHTML = '';
  $('hi-mapping').style.display = 'none';
  $('hi-mapping').innerHTML = '';
  $('hi-run').disabled = true;
  $('hi-run').textContent = 'Import';
  $('hi-file').value = '';
  $('hi-hint').innerHTML = HINTS[S.kind];
  paintOptions();
}

window.openHistoricImport = function (kind) {
  injectModal();
  if (kind) {
    S.kind = kind;
    document.querySelectorAll('#modal-himport .vtab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-kind') === kind);
    });
  }
  reset();
  $('modal-himport').classList.add('open');
};

// ── read + plan ────────────────────────────────────────────
function readFile(file) {
  if (!/\.(csv|tsv|txt)$/i.test(file.name)) {
    $('hi-status').innerHTML = '<span style="color:var(--red)">Please choose a .csv file. In Google Sheets: File → Download → CSV.</span>';
    return;
  }
  $('hi-status').textContent = 'Reading ' + file.name + '…';
  var fr = new FileReader();
  fr.onload = function (e) {
    try {
      var parsed = parseCSV(e.target.result);
      if (parsed.rows.length > MAX_ROWS) throw new Error('That file has ' + parsed.rows.length.toLocaleString() + ' rows. Please split it into files of ' + MAX_ROWS.toLocaleString() + ' rows or fewer.');
      S.headers = parsed.headers;
      S.rows = parsed.rows;
      S.delim = parsed.delim;
      S.map = autoMap(parsed.headers, SCHEMAS[S.kind], S.kind);
      resolveDateOrder();
      $('hi-status').innerHTML = '✓ Read <strong>' + parsed.rows.length.toLocaleString() + '</strong> rows and ' +
        parsed.headers.length + ' columns from ' + esc(file.name) + (parsed.delim === '\t' ? ' (tab-separated)' : '');
      showMapping();
      buildPlan();
    } catch (err) {
      $('hi-status').innerHTML = '<span style="color:var(--red)">' + esc(err.message) + '</span>';
    }
  };
  fr.onerror = function () { $('hi-status').innerHTML = '<span style="color:var(--red)">Could not read that file.</span>'; };
  fr.readAsText(file, 'utf-8');
}

function resolveDateOrder() {
  var pick = $('hi-date-order') ? $('hi-date-order').value : 'auto';
  if (pick === 'dmy' || pick === 'mdy') { S.dateOrder = pick; return; }
  var i = S.map.date;
  S.dateOrder = i == null ? 'dmy' : detectDateOrder(S.rows.map(function (r) { return r[i]; }));
}

function requiredMissing() {
  var schema = SCHEMAS[S.kind];
  var missing = schema.filter(function (f) { return f.required && S.map[f.key] == null; });
  if (S.kind === 'feedback') {
    if (S.map.date == null) missing.push({ label: 'a Date or Timestamp column' });
    if (S.map.event == null && S.map.location == null) missing.push({ label: 'an Event name column, or a Location column' });
  }
  return missing;
}

function showMapping() {
  var schema = SCHEMAS[S.kind];
  var missing = requiredMissing();
  var wrap = $('hi-mapping');
  wrap.style.display = 'block';
  var rows = mappingRows(schema);
  if (!missing.length) {
    wrap.innerHTML =
      '<details><summary style="cursor:pointer;font-size:12px;color:var(--txt3)">Columns detected automatically — click to check or change</summary>' +
      '<div style="margin-top:8px">' + rows + '</div></details>';
  } else {
    wrap.innerHTML =
      '<div class="alert alert-warn" style="margin-bottom:10px">We could not find: <strong>' +
        missing.map(function (f) { return esc(f.label); }).join(', ') +
      '</strong>. Please pick the right columns below.</div>' + rows;
  }
  bindMapping();
}

function mappingRows(schema) {
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
    schema.map(function (f) {
      var opts = '<option value="">— not in my file —</option>' +
        S.headers.map(function (h, i) {
          var pii = S.kind === 'feedback' && isPersonalColumn(h);
          if (pii) return '';
          return '<option value="' + i + '"' + (S.map[f.key] === i ? ' selected' : '') + '>' + esc(h.length > 70 ? h.slice(0, 70) + '…' : h) + '</option>';
        }).join('');
      return '<div class="form-row" style="margin:0"><label>' + esc(f.label) + (f.required ? ' *' : '') + '</label>' +
             '<select data-mapkey="' + f.key + '">' + opts + '</select></div>';
    }).join('') + '</div>';
}

function bindMapping() {
  document.querySelectorAll('#hi-mapping select[data-mapkey]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var k = sel.getAttribute('data-mapkey');
      if (sel.value === '') delete S.map[k]; else S.map[k] = parseInt(sel.value, 10);
      if (k === 'date') resolveDateOrder();
      showMapping();   // refresh the "we could not find" notice
      buildPlan();
    });
  });
}

function cell(row, key) {
  var i = S.map[key];
  if (i == null) return '';
  return String(row[i] == null ? '' : row[i]).trim();
}

function buildPlan() {
  if (requiredMissing().length) {
    $('hi-plan').innerHTML = '';
    $('hi-run').disabled = true;
    return;
  }
  if (S.kind === 'events') planEvents();
  else if (S.kind === 'hours') planHours();
  else planFeedback();
}

function dateNote() {
  return 'Dates read as ' + (S.dateOrder === 'mdy' ? 'month first (US format, e.g. 7/18/2026)' : 'day first (UK format, e.g. 18/07/2026)') +
    ' — change it above if that looks wrong.';
}

// ── contracts ──────────────────────────────────────────────
function findContract(name) {
  if (!name) return null;
  var want = norm(name);
  var list = DB.contracts || [];
  for (var i = 0; i < list.length; i++) if (norm(list[i].name) === want) return list[i];
  var funders = DB.funders || [];
  for (var f = 0; f < funders.length; f++) {
    if (norm(funders[f].name) === want) {
      for (var j = 0; j < list.length; j++) if (String(list[j].funder_id) === String(funders[f].id)) return list[j];
    }
  }
  for (var k = 0; k < list.length; k++) {
    var cn = norm(list[k].name);
    if (cn.indexOf(want) !== -1 || want.indexOf(cn) !== -1) return list[k];
  }
  return null;
}

// ── plan: events ───────────────────────────────────────────
function planEvents() {
  var create = [], skipped = [];
  var existing = {};
  (DB.events || []).forEach(function (e) { existing[norm(e.name) + '|' + (e.date || '')] = e; });
  var seen = {};
  var bulkId = ($('hi-bulk-contract') && $('hi-bulk-contract').value) || '';
  var linked = 0, unmatched = {};

  S.rows.forEach(function (r, idx) {
    var name = cell(r, 'name');
    var date = parseDate(cell(r, 'date'), S.dateOrder);
    if (!name) { skipped.push({ row: idx + 2, why: 'no event name' }); return; }
    if (!date) { skipped.push({ row: idx + 2, why: 'date not understood: "' + cell(r, 'date') + '"' }); return; }
    var key = norm(name) + '|' + date;
    if (existing[key] || seen[key]) { skipped.push({ row: idx + 2, why: 'already in Vorlana' }); return; }
    seen[key] = 1;

    var conIds = [];
    var conName = cell(r, 'contract');
    if (conName) {
      var c = findContract(conName);
      if (c) { conIds = [String(c.id)]; linked++; }
      else unmatched[conName] = (unmatched[conName] || 0) + 1;
    }
    if (!conIds.length && bulkId) { conIds = [bulkId]; linked++; }

    create.push({
      org_id: orgId,
      name: name,
      event_date: date,
      type: cell(r, 'type') || 'Other',
      location: cell(r, 'location') || null,
      attendees: n(cell(r, 'attendees')),
      capacity: n(cell(r, 'capacity')) || null,
      contract_ids: conIds
    });
  });

  S.plan = { kind: 'events', create: create, skipped: skipped };
  var un = Object.keys(unmatched);
  var notes = [dateNote()];
  if (un.length) notes.push('No contract found for: ' + un.slice(0, 5).join(', ') + '. Those events import unlinked.');
  renderPlan([
    ['Events to create', create.length],
    ['Linked to a funder', linked],
    ['Rows skipped', skipped.length]
  ], skipped, create.length > 0, notes);
}

// ── plan: volunteers + hours ───────────────────────────────
function planHours() {
  var vols = DB.volunteers || [];
  var byEmail = {}, byName = {};
  vols.forEach(function (v) {
    if (v.email) byEmail[norm(v.email)] = v;
    if (v.name) byName[norm(v.name)] = v;
  });
  var evByName = {};
  (DB.events || []).forEach(function (e) { evByName[norm(e.name)] = e; });

  var newVols = {}, hourRows = [], skipped = [], matchedEv = 0, unmatchedEv = 0;

  S.rows.forEach(function (r, idx) {
    var name = cell(r, 'volunteer');
    var email = cell(r, 'email');
    var date = parseDate(cell(r, 'date'), S.dateOrder);
    var hrs = parseHours(cell(r, 'hours'));

    if (!name && !email) { skipped.push({ row: idx + 2, why: 'no volunteer name or email' }); return; }
    if (!date) { skipped.push({ row: idx + 2, why: 'date not understood: "' + cell(r, 'date') + '"' }); return; }
    if (!hrs || hrs <= 0) { skipped.push({ row: idx + 2, why: 'hours not understood: "' + cell(r, 'hours') + '"' }); return; }

    var key = email ? norm(email) : norm(name);
    var existing = (email && byEmail[norm(email)]) || byName[norm(name)];
    if (!existing && !newVols[key]) {
      newVols[key] = {
        org_id: orgId,
        name: name || email,
        first_name: (name || email).split(' ')[0],
        last_name: (name || '').split(' ').slice(1).join(' '),
        email: email || null,
        phone: cell(r, 'phone') || null,
        role: 'Volunteer',
        status: 'Active',
        hours: 0,
        skills: '[]'
      };
    }

    var evName = cell(r, 'event');
    var ev = evName ? evByName[norm(evName)] : null;
    if (evName) { if (ev) matchedEv++; else unmatchedEv++; }

    hourRows.push({
      _volKey: key,
      _existingId: existing ? existing.id : null,
      org_id: orgId,
      event_id: ev ? String(ev.id) : null,
      session_date: date,
      hours: Math.round(hrs * 100) / 100,
      activity: cell(r, 'activity') || null,
      source: 'import'
    });
  });

  var newVolList = Object.keys(newVols).map(function (k) { return { key: k, row: newVols[k] }; });
  S.plan = { kind: 'hours', newVols: newVolList, hourRows: hourRows, skipped: skipped };
  var totalHours = hourRows.reduce(function (a, h) { return a + h.hours; }, 0);
  var notes = [dateNote()];
  if (unmatchedEv) notes.push(unmatchedEv + ' row(s) name an event not in Vorlana. Their hours still import, just unlinked.');
  renderPlan([
    ['Hour entries', hourRows.length],
    ['Total hours', Math.round(totalHours * 10) / 10],
    ['New volunteers', newVolList.length],
    ['Matched to events', matchedEv],
    ['Event not found', unmatchedEv],
    ['Rows skipped', skipped.length]
  ], skipped, hourRows.length > 0, notes);
}

// ── plan: feedback (any survey) ────────────────────────────
// A "session" is one workshop: an event NAME (if the survey asks for it)
// or a PLACE, on one DATE. Sessions are matched to events already in
// Vorlana, and created when they're new — so a survey naming workshops
// that aren't in the system yet still imports.
function planFeedback() {
  var evByNameDate = {}, evByDate = {};
  (DB.events || []).forEach(function (e) {
    if (e.date) {
      evByNameDate[norm(e.name) + '|' + e.date] = e;
      (evByDate[e.date] = evByDate[e.date] || []).push(e);
    }
  });

  var mappedIdx = {};
  Object.keys(S.map).forEach(function (k) { mappedIdx[S.map[k]] = k; });

  // The org's own questions: every column that isn't mapped and isn't personal.
  var excluded = [], questionCols = [];
  S.headers.forEach(function (h, i) {
    if (isPersonalColumn(h)) { excluded.push(h); return; }
    if (mappedIdx[i] === 'event' || mappedIdx[i] === 'location' || mappedIdx[i] === 'date') return;
    if (!String(h).trim()) return;
    questionCols.push(i);
  });

  var prefix = (($('hi-ev-prefix') && $('hi-ev-prefix').value) || 'Workshop').trim() || 'Workshop';
  var evType = ($('hi-ev-type') && $('hi-ev-type').value) || 'Other';
  var bulkId = ($('hi-bulk-contract') && $('hi-bulk-contract').value) || '';

  var sessions = {};
  var responses = [];
  var skipped = [];

  S.rows.forEach(function (r, idx) {
    var evName = S.map.event != null ? cell(r, 'event') : '';
    var loc = S.map.location != null ? cell(r, 'location') : '';
    var date = parseDate(cell(r, 'date'), S.dateOrder);

    if (!evName && !loc) { skipped.push({ row: idx + 2, why: 'no event name or location' }); return; }
    if (!date) { skipped.push({ row: idx + 2, why: 'date not understood: "' + cell(r, 'date') + '"' }); return; }

    var label = evName || loc;
    var key = norm(label) + '|' + date;

    if (!sessions[key]) {
      // 1. exact name + date  2. same date, name/place appears in the event
      var match = evByNameDate[norm(label) + '|' + date] || null;
      if (!match) {
        match = (evByDate[date] || []).filter(function (e) {
          var hay = norm((e.name || '') + ' ' + (e.location || ''));
          return hay.indexOf(norm(label)) !== -1 || norm(label).indexOf(norm(e.name || '')) !== -1;
        })[0] || null;
      }
      sessions[key] = {
        label: label,
        location: loc || '',
        date: date,
        eventId: match ? match.id : null,
        eventName: match ? match.name : (evName ? evName : (prefix + ' — ' + loc)),
        count: 0
      };
    }
    sessions[key].count++;

    // Vorlana's own fields — only ever from real answers, never invented
    function score(k) {
      if (S.map[k] == null) return null;
      var s = toScore(cell(r, k));
      if (s == null) return null;
      return Math.min(5, Math.max(1, Math.round(s)));
    }
    var answers = {};
    questionCols.forEach(function (i) {
      var q = String(S.headers[i]).trim();
      var raw = String(r[i] == null ? '' : r[i]).trim();
      if (!raw) return;
      var sc = toScore(raw);
      answers[q] = sc != null ? sc : raw;
    });

    responses.push({
      _sessionKey: key,
      org_id: orgId,
      event_id: null,
      name: '',
      enjoyed: score('enjoyed'),
      cb: score('cb'),
      ca: score('ca'),
      learned: S.map.learned != null ? truthy(cell(r, 'learned')) : false,
      connected: S.map.connected != null ? truthy(cell(r, 'connected')) : false,
      friend: S.map.friend != null ? truthy(cell(r, 'friend')) : false,
      quote: S.map.quote != null ? cell(r, 'quote') : '',
      answers: answers
    });
  });

  var sessList = Object.keys(sessions).map(function (k) { return { key: k, s: sessions[k] }; });
  var toCreate = sessList.filter(function (x) { return !x.s.eventId; });
  var matched = sessList.length - toCreate.length;

  S.plan = {
    kind: 'feedback',
    responses: responses,
    sessions: sessions,
    newEvents: toCreate.map(function (x) {
      return {
        key: x.key,
        row: {
          org_id: orgId,
          name: x.s.eventName,
          event_date: x.s.date,
          type: evType,
          location: x.s.location || null,
          attendees: 0,
          capacity: null,
          contract_ids: bulkId ? [bulkId] : []
        }
      };
    }),
    skipped: skipped
  };

  var mapLines = [];
  [['connected', 'counted as “felt more connected” when 4–5 or agree'],
   ['learned', 'counted as “learned / more skilled” when 4–5 or agree'],
   ['friend', 'counted as “made a new friend” when yes'],
   ['quote', 'used as participant quotes'],
   ['enjoyed', 'used as the enjoyment score'],
   ['cb', 'used as confidence before'],
   ['ca', 'used as confidence after']].forEach(function (p) {
    var i = S.map[p[0]];
    if (i != null) mapLines.push('“' + String(S.headers[i]).slice(0, 80) + '” — ' + p[1]);
  });

  var notes = [dateNote()];
  if (toCreate.length) {
    notes.push(toCreate.length + ' session(s) are not in Vorlana yet and will be created. Attendance isn\u2019t in a feedback file, so it starts at 0 — add the real numbers on each event afterwards.');
  }
  notes.push('All ' + questionCols.length + ' of your questions are kept word-for-word on each response.');
  if (excluded.length) notes.push('Left out (personal data, never stored): ' + excluded.map(function (h) { return '“' + String(h).slice(0, 50) + (h.length > 50 ? '…' : '') + '”'; }).join(', '));

  var sessHTML = sessList.length
    ? '<details style="font-size:12px;color:var(--txt2);margin-bottom:8px"><summary style="cursor:pointer">Show ' + sessList.length + ' session(s) found</summary>' +
      '<div style="max-height:220px;overflow:auto;background:var(--bg);border-radius:8px;padding:8px;margin-top:6px">' +
      sessList.sort(function (a, b) { return a.s.date.localeCompare(b.s.date); }).map(function (x) {
        return esc(x.s.date) + ' · ' + esc(x.s.label) + ' — ' + x.s.count + ' response' + (x.s.count === 1 ? '' : 's') +
          (x.s.eventId ? ' · <span style="color:var(--em)">matches “' + esc(x.s.eventName) + '”</span>' : ' · <strong>new</strong>');
      }).join('<br/>') + '</div></details>'
    : '';

  var mapHTML = mapLines.length
    ? '<details style="font-size:12px;color:var(--txt2);margin-bottom:8px"><summary style="cursor:pointer">How your questions are used</summary>' +
      '<div style="background:var(--bg);border-radius:8px;padding:8px;margin-top:6px">' + mapLines.map(esc).join('<br/>') + '</div></details>'
    : '';

  renderPlan([
    ['Responses', responses.length],
    ['Sessions', sessList.length],
    ['New events', toCreate.length],
    ['Matched events', matched],
    ['Your questions', questionCols.length],
    ['Rows skipped', skipped.length]
  ], skipped, responses.length > 0, notes, sessHTML + mapHTML);
}

function renderPlan(figures, skipped, canRun, notes, extraHTML) {
  var el = $('hi-plan');
  notes = (notes || []).filter(Boolean);
  el.innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:10px;margin-bottom:10px">' +
      figures.map(function (f) {
        return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center">' +
          '<div style="font-size:20px;font-weight:800;color:var(--em)">' + esc(String(f[1])) + '</div>' +
          '<div style="font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.4px;font-weight:700">' + esc(f[0]) + '</div>' +
        '</div>';
      }).join('') +
    '</div>' +
    (notes.length ? '<div class="alert alert-info" style="font-size:12px;margin-bottom:8px;line-height:1.6">' + notes.map(esc).join('<br/>') + '</div>' : '') +
    (extraHTML || '') +
    (skipped.length
      ? '<details style="font-size:12px;color:var(--txt3)"><summary style="cursor:pointer">Show ' + skipped.length + ' skipped row(s)</summary>' +
        '<div style="max-height:150px;overflow:auto;background:var(--bg);border-radius:8px;padding:8px;margin-top:6px">' +
        skipped.slice(0, 100).map(function (s) { return 'Row ' + s.row + ' — ' + esc(s.why); }).join('<br/>') +
        (skipped.length > 100 ? '<br/>…and ' + (skipped.length - 100) + ' more' : '') +
        '</div></details>'
      : '');
  $('hi-run').disabled = !canRun;
}

// ── run ────────────────────────────────────────────────────
function runImport() {
  if (!S.plan) return;
  var btn = $('hi-run');
  btn.disabled = true;
  var el = $('hi-plan');

  function progress(done, total, what) {
    el.innerHTML =
      '<div style="font-size:13px;font-weight:700;color:var(--txt);margin-bottom:8px">Importing ' + esc(what) + '… ' + done.toLocaleString() + ' of ' + total.toLocaleString() + '</div>' +
      '<div style="height:10px;background:var(--bg);border-radius:5px;overflow:hidden"><div style="height:100%;width:' + Math.round(done / Math.max(total, 1) * 100) + '%;background:var(--em);transition:width .2s"></div></div>';
  }

  var job;
  var extra = '';

  if (S.plan.kind === 'events') {
    job = insertBatched('events', S.plan.create, function (d, t) { progress(d, t, 'events'); })
      .then(function (res) { return refreshTable('events').then(function () { return res; }); });

  } else if (S.plan.kind === 'feedback') {
    var plan = S.plan;
    job = insertBatched('events', plan.newEvents.map(function (x) { return x.row; }), function (d, t) { progress(d, t, 'sessions'); })
      .then(function () { return refreshTable('events'); })
      .then(function () {
        // attach each response to its session's event (new or existing)
        var byNameDate = {};
        (DB.events || []).forEach(function (e) { byNameDate[norm(e.name) + '|' + (e.date || '')] = e; });
        var orphans = 0;
        var rows = [];
        plan.responses.forEach(function (r) {
          var eid = null;
          var s = plan.sessions[r._sessionKey];
          if (s) {
            if (s.eventId) eid = s.eventId;
            else {
              var ev = byNameDate[norm(s.eventName) + '|' + s.date];
              eid = ev ? ev.id : null;
            }
          }
          if (!eid) { orphans++; return; }
          var row = Object.assign({}, r, { event_id: eid });
          delete row._sessionKey;
          rows.push(row);
        });
        if (plan.newEvents.length) extra += '<br/>' + plan.newEvents.length + ' session(s) created as events.';
        if (orphans) extra += '<br/>' + orphans + ' response(s) could not be attached to a session and were skipped.';
        return insertBatched('feedback', rows, function (d, t) { progress(d, t, 'responses'); });
      })
      .then(function (res) { return refreshTable('feedback').then(function () { return res; }); });

  } else {
    var newRows = S.plan.newVols.map(function (v) { return v.row; });
    job = insertBatched('volunteers', newRows, function (d, t) { progress(d, t, 'volunteers'); })
      .then(function () { return refreshTable('volunteers'); })
      .then(function () {
        var byEmail = {}, byName = {};
        (DB.volunteers || []).forEach(function (v) {
          if (v.email) byEmail[norm(v.email)] = v;
          if (v.name) byName[norm(v.name)] = v;
        });
        var rows = [], orphans = 0;
        S.plan.hourRows.forEach(function (h) {
          var id = h._existingId;
          if (!id) {
            var v = byEmail[h._volKey] || byName[h._volKey];
            id = v ? v.id : null;
          }
          if (!id) { orphans++; return; }
          rows.push({
            org_id: h.org_id,
            volunteer_id: String(id),
            event_id: h.event_id,
            session_date: h.session_date,
            hours: h.hours,
            activity: h.activity,
            source: h.source
          });
        });
        extra += '<br/>' + S.plan.newVols.length + ' volunteer(s) created.' +
          (orphans ? ' ' + orphans + ' hour row(s) could not be matched to a volunteer.' : '');
        return insertBatched('volunteer_hours', rows, function (d, t) { progress(d, t, 'hours'); });
      })
      .then(function (res) {
        if (typeof window._reloadVolunteerHours === 'function') {
          return window._reloadVolunteerHours().then(function () { return res; });
        }
        return res;
      });
  }

  job.then(function (res) {
    var answersMissing = res.errors.indexOf('ANSWERS_MISSING') !== -1;
    var realErrors = res.errors.filter(function (e) { return e !== 'ANSWERS_MISSING'; });
    var hint = '';
    if (realErrors.some(function (e) { return /null value/i.test(e); })) {
      hint = '<div style="font-size:12px;margin-top:6px">A score column won\u2019t accept blanks. Run in Supabase:<br/><code>alter table feedback alter column enjoyed drop not null; alter table feedback alter column cb drop not null; alter table feedback alter column ca drop not null;</code></div>';
    }
    el.innerHTML =
      '<div class="alert ' + (res.failed ? 'alert-warn' : 'alert-ok') + '">' +
        (res.failed ? '⚠' : '✓') + ' Imported <strong>' + res.inserted.toLocaleString() + '</strong> record(s).' +
        (res.failed ? ' <strong>' + res.failed.toLocaleString() + '</strong> failed.' : '') + extra +
        (realErrors.length ? '<div style="font-size:11px;margin-top:6px;opacity:.85">' + esc(realErrors[0]) + '</div>' : '') +
        hint +
        (answersMissing ? '<div style="font-size:12px;margin-top:6px">Saved without your full question answers — the <code>answers</code> column is missing. Run: <code>alter table feedback add column if not exists answers jsonb default \'{}\';</code> then import again.</div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:var(--txt3)">You can import the next step, or close this and check your Events and Feedback pages.</div>';
    btn.disabled = false;
    btn.textContent = 'Import';
    repaintAll();
  }).catch(function (e) {
    el.innerHTML = '<div class="alert alert-warn">Import failed: ' + esc((e && e.message) || e) + '</div>';
    btn.disabled = false;
  });
}

function repaintAll() {
  ['renderEvents', 'renderVolunteers', 'renderFeedback', 'renderImpact'].forEach(function (f) {
    if (typeof window[f] === 'function') { try { window[f](); } catch (e) {} }
  });
}

// ── buttons on the Events, Volunteers and Feedback pages ───
function addButtons() {
  [['page-events', 'events'], ['page-volunteers', 'hours'], ['page-feedback', 'feedback']].forEach(function (pair) {
    var page = $(pair[0]);
    if (!page) return;
    var hdr = page.querySelector('.page-header');
    if (!hdr || hdr.querySelector('.hi-btn')) return;
    var primary = hdr.querySelector('button.btn-p');
    if (!primary) return;
    var b = document.createElement('button');
    b.className = 'btn btn-ghost btn-sm hi-btn';
    b.style.marginRight = '8px';
    b.textContent = '⬆ Import history';
    b.setAttribute('onclick', "openHistoricImport('" + pair[1] + "')");
    primary.parentNode.insertBefore(b, primary);
  });
}

// ── init ───────────────────────────────────────────────────
function whenReady(fn) {
  if (typeof DB !== 'undefined' && typeof sb !== 'undefined' && sb && document.getElementById('page-events')) {
    return setTimeout(fn, 400);
  }
  setTimeout(function () { whenReady(fn); }, 150);
}

whenReady(function () {
  injectModal();
  addButtons();
  var origGo = window.go;
  if (typeof origGo === 'function' && !origGo._hi) {
    window.go = function () {
      var r = origGo.apply(this, arguments);
      try { addButtons(); } catch (e) {}
      return r;
    };
    window.go._hi = true;
  }
  console.log('[historic-import ' + VERSION + '] ready');
});

})();
