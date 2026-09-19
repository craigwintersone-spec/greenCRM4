// js/extensions/historic-import.js  — v1.0
// ─────────────────────────────────────────────────────────────
// HISTORIC DATA IMPORT — events, volunteer hours, feedback.
//
// For an organisation arriving with two years of spreadsheets.
// Three steps, run in order (or individually):
//
//   1. Events            → creates events, optionally linked to a contract
//   2. Volunteers/hours  → creates volunteers it hasn't seen, logs their
//                          hours, matched to events imported in step 1
//   3. Feedback          → attendee responses, matched to those events
//
// DESIGN — "outcomes not admin":
//   • Columns are auto-detected. Mapping is only shown if we guess wrong.
//   • One summary screen: what will be created, what will be matched.
//   • Inserts are BATCHED (500 rows per request), so thousands of rows
//     take seconds rather than the ten-plus minutes a row-at-a-time
//     import would need.
//   • A bad row never stops the import. It is skipped and listed.
//
// Depends on: db.js (DB, sb, orgId, refreshTable), utils.js
// Load AFTER the other extensions.
'use strict';

(function () {

var VERSION = 'v1.0';
var BATCH = 500;          // rows per insert request
var MAX_ROWS = 10000;     // sanity cap per file

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function n(v) { return isNaN(+v) ? 0 : +v; }
function norm(s) { return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' '); }

// ── CSV parsing ────────────────────────────────────────────
function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  var rows = [], cur = [], field = '', inQ = false;
  for (var i = 0; i < text.length; i++) {
    var c = text[i], nx = text[i + 1];
    if (inQ) {
      if (c === '"' && nx === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  if (!rows.length) throw new Error('That file appears to be empty.');
  var headers = rows.shift().map(function (h) { return String(h).trim(); });
  while (rows.length && rows[rows.length - 1].every(function (c) { return !String(c).trim(); })) rows.pop();
  return { headers: headers, rows: rows };
}

// ── date handling — UK spreadsheets are messy ──────────────
function parseDate(v) {
  if (!v) return null;
  var s = String(v).trim();
  if (!s) return null;

  // already ISO
  var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return iso[1] + '-' + pad(iso[2]) + '-' + pad(iso[3]);

  // dd/mm/yyyy or dd-mm-yy  (UK order assumed — the common case here)
  var uk = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/.exec(s);
  if (uk) {
    var y = uk[3].length === 2 ? ('20' + uk[3]) : uk[3];
    return y + '-' + pad(uk[2]) + '-' + pad(uk[1]);
  }

  // "12 March 2024" / "March 12, 2024"
  var d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}
function pad(x) { x = String(x); return x.length < 2 ? '0' + x : x; }

// hours can be "3", "3.5", "3h 30m", "3:30"
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

// ── column auto-detection ──────────────────────────────────
var SCHEMAS = {
  events: [
    { key: 'name',      label: 'Event name',   required: true,  match: ['event', 'event name', 'name', 'title', 'session', 'workshop', 'activity'] },
    { key: 'date',      label: 'Date',         required: true,  match: ['date', 'event date', 'when', 'day', 'session date'] },
    { key: 'type',      label: 'Type',         match: ['type', 'category', 'event type', 'kind', 'strand'] },
    { key: 'location',  label: 'Location',     match: ['location', 'venue', 'where', 'site', 'place'] },
    { key: 'attendees', label: 'Attendees',    match: ['attendees', 'attendance', 'participants', 'numbers', 'people', 'headcount', 'no. attended'] },
    { key: 'capacity',  label: 'Capacity',     match: ['capacity', 'places', 'max', 'spaces'] }
  ],
  hours: [
    { key: 'volunteer', label: 'Volunteer name', required: true, match: ['volunteer', 'name', 'volunteer name', 'person', 'full name', 'who'] },
    { key: 'email',     label: 'Email',          match: ['email', 'e-mail', 'email address', 'contact'] },
    { key: 'date',      label: 'Date',           required: true, match: ['date', 'day', 'session date', 'when'] },
    { key: 'hours',     label: 'Hours',          required: true, match: ['hours', 'hrs', 'time', 'duration', 'hours worked', 'no. hours'] },
    { key: 'event',     label: 'Event',          match: ['event', 'session', 'workshop', 'activity', 'event name', 'project'] },
    { key: 'activity',  label: 'What they did',  match: ['activity', 'task', 'role', 'notes', 'description', 'what'] },
    { key: 'phone',     label: 'Phone',          match: ['phone', 'mobile', 'tel', 'telephone'] }
  ],
  feedback: [
    { key: 'event',     label: 'Event',              required: true, match: ['event', 'session', 'workshop', 'event name', 'activity'] },
    { key: 'name',      label: 'Participant name',   match: ['name', 'participant', 'attendee', 'respondent', 'who'] },
    { key: 'enjoyed',   label: 'Enjoyment (1-5)',    match: ['enjoyed', 'enjoyment', 'rating', 'score', 'satisfaction', 'how was it'] },
    { key: 'cb',        label: 'Confidence before',  match: ['confidence before', 'before', 'conf before', 'pre', 'cb'] },
    { key: 'ca',        label: 'Confidence after',   match: ['confidence after', 'after', 'conf after', 'post', 'ca'] },
    { key: 'learned',   label: 'Learned something',  match: ['learned', 'learnt', 'learned something new', 'new skills'] },
    { key: 'connected', label: 'Felt connected',     match: ['connected', 'felt connected', 'belonging', 'less lonely'] },
    { key: 'friend',    label: 'Made a friend',      match: ['friend', 'made a friend', 'new friend'] },
    { key: 'quote',     label: 'Comment / quote',    match: ['quote', 'comment', 'comments', 'feedback', 'what they said', 'anything else'] }
  ]
};

function autoMap(headers, schema) {
  var map = {};
  headers.forEach(function (h, i) {
    var hn = norm(h).replace(/[^a-z0-9 ]/g, '').trim();
    for (var s = 0; s < schema.length; s++) {
      if (map[schema[s].key] != null) continue;
      var hits = schema[s].match;
      for (var m = 0; m < hits.length; m++) {
        if (hn === hits[m] || hn.indexOf(hits[m]) === 0) { map[schema[s].key] = i; return; }
      }
    }
  });
  return map;
}

function truthy(v) {
  var s = norm(v);
  return s === 'y' || s === 'yes' || s === 'true' || s === '1' || s === 'x' || s === '✓';
}

// ── batched insert ─────────────────────────────────────────
function insertBatched(table, rows, onProgress) {
  if (!rows.length) return Promise.resolve({ inserted: 0, failed: 0, errors: [] });
  var done = 0, failed = 0, errors = [];
  var chunks = [];
  for (var i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH));

  return chunks.reduce(function (p, chunk) {
    return p.then(function () {
      return sb.from(table).insert(chunk).then(function (res) {
        if (res && res.error) throw res.error;
        done += chunk.length;
      }).catch(function (e) {
        failed += chunk.length;
        if (errors.length < 3) errors.push((e && e.message) || String(e));
      }).then(function () {
        if (onProgress) onProgress(done + failed, rows.length);
      });
    });
  }, Promise.resolve()).then(function () {
    return { inserted: done, failed: failed, errors: errors };
  });
}

// ── state ──────────────────────────────────────────────────
var S = { kind: 'events', headers: [], rows: [], map: {}, plan: null };

// ── modal ──────────────────────────────────────────────────
function injectModal() {
  if ($('modal-himport')) return;
  var m = document.createElement('div');
  m.className = 'modal-overlay';
  m.id = 'modal-himport';
  m.innerHTML =
    '<div class="modal" style="max-width:720px">' +
      '<h2>Import historic data</h2>' +
      '<p style="font-size:13px;color:var(--txt2);line-height:1.7;margin-bottom:14px">' +
        'Bring in what you already have. Import events first, then volunteer hours, then feedback — ' +
        'each step matches against the one before. Drop a CSV in and we work out the columns.' +
      '</p>' +

      '<div class="vtab-bar" style="margin-bottom:16px">' +
        '<button class="vtab-btn active" data-kind="events">① Events</button>' +
        '<button class="vtab-btn" data-kind="hours">② Volunteers &amp; hours</button>' +
        '<button class="vtab-btn" data-kind="feedback">③ Feedback</button>' +
      '</div>' +

      '<div id="hi-hint" style="font-size:12px;color:var(--txt3);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:12px"></div>' +

      '<div id="hi-drop" style="border:2px dashed var(--border);border-radius:12px;padding:26px;text-align:center;cursor:pointer;transition:border-color .15s">' +
        '<div style="font-size:30px;margin-bottom:6px">📄</div>' +
        '<div style="font-size:14px;font-weight:700;color:var(--txt)">Drop a CSV here, or click to choose</div>' +
        '<div style="font-size:11px;color:var(--txt3);margin-top:4px">Excel: File → Save As → CSV UTF-8</div>' +
      '</div>' +
      '<input type="file" id="hi-file" accept=".csv,text/csv" style="display:none"/>' +

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
  $('hi-run').addEventListener('click', runImport);
}

var HINTS = {
  events: 'Needs at least: <strong>event name</strong> and <strong>date</strong>. Also reads type, location, attendees, capacity.',
  hours: 'Needs at least: <strong>volunteer name</strong>, <strong>date</strong> and <strong>hours</strong>. Volunteers not already on your list will be created. If a row names an event, we match it to your events.',
  feedback: 'Needs at least: <strong>event</strong>. Also reads enjoyment, confidence before/after, learned, connected, and any comment. Rows whose event cannot be matched are skipped.'
};

function reset() {
  S.headers = []; S.rows = []; S.map = {}; S.plan = null;
  $('hi-status').innerHTML = '';
  $('hi-plan').innerHTML = '';
  $('hi-mapping').style.display = 'none';
  $('hi-mapping').innerHTML = '';
  $('hi-run').disabled = true;
  $('hi-file').value = '';
  $('hi-hint').innerHTML = HINTS[S.kind];
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
  if (!/\.csv$/i.test(file.name)) {
    $('hi-status').innerHTML = '<span style="color:var(--red)">Please choose a .csv file. In Excel: File → Save As → CSV UTF-8.</span>';
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
      S.map = autoMap(parsed.headers, SCHEMAS[S.kind]);
      $('hi-status').innerHTML = '✓ Read <strong>' + parsed.rows.length.toLocaleString() + '</strong> rows from ' + esc(file.name);
      showMappingIfNeeded();
      buildPlan();
    } catch (err) {
      $('hi-status').innerHTML = '<span style="color:var(--red)">' + esc(err.message) + '</span>';
    }
  };
  fr.onerror = function () { $('hi-status').innerHTML = '<span style="color:var(--red)">Could not read that file.</span>'; };
  fr.readAsText(file, 'utf-8');
}

// Only show mapping if a required column wasn't detected.
function showMappingIfNeeded() {
  var schema = SCHEMAS[S.kind];
  var missing = schema.filter(function (f) { return f.required && S.map[f.key] == null; });
  var wrap = $('hi-mapping');

  if (!missing.length) {
    wrap.style.display = 'block';
    wrap.innerHTML =
      '<details><summary style="cursor:pointer;font-size:12px;color:var(--txt3)">Columns detected automatically — click to check or change</summary>' +
      '<div style="margin-top:8px">' + mappingRows(schema) + '</div></details>';
    bindMapping();
    return;
  }

  wrap.style.display = 'block';
  wrap.innerHTML =
    '<div class="alert alert-warn" style="margin-bottom:10px">We could not find: <strong>' +
      missing.map(function (f) { return esc(f.label); }).join(', ') +
    '</strong>. Please pick the right columns below.</div>' + mappingRows(schema);
  bindMapping();
}

function mappingRows(schema) {
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
    schema.map(function (f) {
      var opts = '<option value="">— not in my file —</option>' +
        S.headers.map(function (h, i) {
          return '<option value="' + i + '"' + (S.map[f.key] === i ? ' selected' : '') + '>' + esc(h) + '</option>';
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
      buildPlan();
    });
  });
}

function cell(row, key) {
  var i = S.map[key];
  if (i == null) return '';
  return String(row[i] == null ? '' : row[i]).trim();
}

// Work out exactly what will happen, before anything is written.
function buildPlan() {
  var schema = SCHEMAS[S.kind];
  var missing = schema.filter(function (f) { return f.required && S.map[f.key] == null; });
  if (missing.length) {
    $('hi-plan').innerHTML = '';
    $('hi-run').disabled = true;
    return;
  }

  if (S.kind === 'events') planEvents();
  else if (S.kind === 'hours') planHours();
  else planFeedback();
}

// ── plan: events ───────────────────────────────────────────
function planEvents() {
  var create = [], skipped = [];
  var existing = {};
  (DB.events || []).forEach(function (e) { existing[norm(e.name) + '|' + (e.date || '')] = e; });
  var seen = {};

  S.rows.forEach(function (r, idx) {
    var name = cell(r, 'name');
    var date = parseDate(cell(r, 'date'));
    if (!name) { skipped.push({ row: idx + 2, why: 'no event name' }); return; }
    if (!date) { skipped.push({ row: idx + 2, why: 'date not understood: "' + cell(r, 'date') + '"' }); return; }
    var key = norm(name) + '|' + date;
    if (existing[key] || seen[key]) { skipped.push({ row: idx + 2, why: 'already in Vorlana' }); return; }
    seen[key] = 1;
    create.push({
      org_id: orgId,
      name: name,
      event_date: date,
      type: cell(r, 'type') || 'Other',
      location: cell(r, 'location') || null,
      attendees: n(cell(r, 'attendees')),
      capacity: n(cell(r, 'capacity')) || null,
      contract_ids: []
    });
  });

  S.plan = { kind: 'events', create: create, skipped: skipped };
  renderPlan([
    ['Events to create', create.length],
    ['Rows skipped', skipped.length]
  ], skipped, create.length > 0);
}

// ── plan: volunteers + hours ───────────────────────────────
function planHours() {
  var vols = DB.volunteers || [];
  var byEmail = {}, byName = {};
  vols.forEach(function (v) {
    if (v.email) byEmail[norm(v.email)] = v;
    if (v.name) byName[norm(v.name)] = v;
  });
  var events = DB.events || [];
  var evByName = {};
  events.forEach(function (e) { evByName[norm(e.name)] = e; });

  var newVols = {}, hourRows = [], skipped = [], matchedEv = 0, unmatchedEv = 0;

  S.rows.forEach(function (r, idx) {
    var name = cell(r, 'volunteer');
    var email = cell(r, 'email');
    var date = parseDate(cell(r, 'date'));
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
  renderPlan([
    ['Hour entries', hourRows.length],
    ['Total hours', Math.round(totalHours * 10) / 10],
    ['New volunteers', newVolList.length],
    ['Matched to events', matchedEv],
    ['Event not found', unmatchedEv],
    ['Rows skipped', skipped.length]
  ], skipped, hourRows.length > 0,
    unmatchedEv ? unmatchedEv + ' row(s) name an event that is not in Vorlana. Their hours will still import, just not linked to an event. Import your events first if you want them linked.' : '');
}

// ── plan: feedback ─────────────────────────────────────────
function planFeedback() {
  var evByName = {};
  (DB.events || []).forEach(function (e) { evByName[norm(e.name)] = e; });

  var create = [], skipped = [];
  S.rows.forEach(function (r, idx) {
    var evName = cell(r, 'event');
    var ev = evName ? evByName[norm(evName)] : null;
    if (!ev) { skipped.push({ row: idx + 2, why: 'event not found: "' + evName + '"' }); return; }

    function score(k) {
      var v = parseInt(cell(r, k), 10);
      if (isNaN(v)) return null;
      return Math.min(5, Math.max(1, v));
    }

    create.push({
      org_id: orgId,
      event_id: ev.id,
      name: cell(r, 'name') || '',
      enjoyed: score('enjoyed') || 4,
      cb: score('cb') || 3,
      ca: score('ca') || 3,
      learned: truthy(cell(r, 'learned')),
      connected: truthy(cell(r, 'connected')),
      friend: truthy(cell(r, 'friend')),
      quote: cell(r, 'quote') || ''
    });
  });

  S.plan = { kind: 'feedback', create: create, skipped: skipped };
  renderPlan([
    ['Responses to import', create.length],
    ['Rows skipped', skipped.length]
  ], skipped, create.length > 0,
    skipped.length ? 'Skipped rows name an event that is not in Vorlana. Import your events first, then try again.' : '');
}

function renderPlan(figures, skipped, canRun, note) {
  var el = $('hi-plan');
  el.innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:10px;margin-bottom:10px">' +
      figures.map(function (f) {
        return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center">' +
          '<div style="font-size:20px;font-weight:800;color:var(--em)">' + esc(String(f[1])) + '</div>' +
          '<div style="font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.4px;font-weight:700">' + esc(f[0]) + '</div>' +
        '</div>';
      }).join('') +
    '</div>' +
    (note ? '<div class="alert alert-info" style="font-size:12px;margin-bottom:8px">' + esc(note) + '</div>' : '') +
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
      '<div style="height:10px;background:var(--bg);border-radius:5px;overflow:hidden"><div style="height:100%;width:' + Math.round(done / total * 100) + '%;background:var(--em);transition:width .2s"></div></div>';
  }

  var job;
  if (S.plan.kind === 'events') {
    job = insertBatched('events', S.plan.create, function (d, t) { progress(d, t, 'events'); })
      .then(function (res) { return refreshTable('events').then(function () { return res; }); });

  } else if (S.plan.kind === 'feedback') {
    job = insertBatched('feedback', S.plan.create, function (d, t) { progress(d, t, 'feedback'); })
      .then(function (res) { return refreshTable('feedback').then(function () { return res; }); });

  } else {
    // volunteers first, so their new ids can be attached to the hours
    var newRows = S.plan.newVols.map(function (v) { return v.row; });
    job = insertBatched('volunteers', newRows, function (d, t) { progress(d, t, 'volunteers'); })
      .then(function () { return refreshTable('volunteers'); })
      .then(function () {
        // re-match by email/name now the volunteers exist
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
        S.plan._orphans = orphans;
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
    var extra = '';
    if (S.plan.kind === 'hours') {
      extra = '<br/>' + S.plan.newVols.length + ' volunteer(s) created.' +
              (S.plan._orphans ? ' ' + S.plan._orphans + ' hour row(s) could not be matched to a volunteer and were skipped.' : '');
    }
    el.innerHTML =
      '<div class="alert ' + (res.failed ? 'alert-warn' : 'alert-ok') + '">' +
        (res.failed ? '⚠' : '✓') + ' Imported <strong>' + res.inserted.toLocaleString() + '</strong> record(s).' +
        (res.failed ? ' <strong>' + res.failed.toLocaleString() + '</strong> failed.' : '') + extra +
        (res.errors.length ? '<div style="font-size:11px;margin-top:6px;opacity:.85">' + esc(res.errors[0]) + '</div>' : '') +
      '</div>' +
      '<div style="font-size:12px;color:var(--txt3)">You can now import the next step, or close this and check your Reports page.</div>';
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

// ── buttons on the Events and Volunteers pages ─────────────
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
  // pages render lazily — add buttons again after navigation
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
