// js/extensions/historic-import.js  — v3.1
// ─────────────────────────────────────────────────────────────
// HISTORIC DATA IMPORT — events, volunteer hours, feedback.
//
// v3.0 — feedback import rebuilt around one rule: IMPORT EVERYTHING,
// TIDY AFTERWARDS. No column mapping. No row is ever skipped.
//
//   1. Drop the file → "313 responses, 19 events, 25 questions" → Import.
//      • Date: the column whose values parse as dates most often
//        (Google Forms "Timestamp"). Mixed US/UK formats handled per
//        format signature. A row with no date takes the previous row's.
//      • Event name: first sensible value from any event-ish column
//        (event / workshop / session / "please specify" / a mis-used
//        "Date" column). "Other", "Yes", "N/A" are not names.
//        Rows with no name become "Session on 18 Apr 2025".
//      • Near-duplicate names ("Flower pressing", "Flower Press
//        Workshop") are grouped before events are created.
//      • Every question kept word-for-word in feedback.answers.
//      • Personal data (email, phone, postcode, name, age, gender,
//        ethnicity, disability, prize draws) never stored.
//      • Each import has a batch id and each row a hash: re-running the
//        same file adds nothing, and Undo removes exactly what it added.
//   2. Tidy events — merge look-alike names, rename "Session on …".
//   3. Confirm your questions — score / yes-no / comment / ignore, and
//      which Vorlana outcome (if any) each maps to. Saved per org in
//      survey_measures so the next export of the same form is instant.
//
// v3.4 — volunteer hours: no mapping either. Hours from an hours
// answer or End − Start; dates from override / mis-titled columns.
//
// Needs sql/import-v3.sql run once.
'use strict';

(function () {

var VERSION = 'v3.7';
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
function hash(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function niceDate(iso) {
  if (!iso) return '';
  var d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.getDate() + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] + ' ' + d.getFullYear();
}

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
  rows = rows.filter(function (r) { return r.some(function (c) { return String(c).trim(); }); });
  return { headers: headers, rows: rows, delim: delim };
}

// ── dates ──────────────────────────────────────────────────
var DATE_RE = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})(?:[\sT]|$)/;

// Google Forms exports change shape over time: "4/18/2025 12:10:26" then
// "06/04/2026 12:00". Each shape is detected separately.
function dateSignature(s) {
  var m = DATE_RE.exec(s);
  if (!m) return '';
  var padded = m[1].length === 2 && m[2].length === 2;
  var secs = /\d{1,2}:\d{2}:\d{2}/.test(s);
  return (padded ? 'p' : 'u') + (secs ? 's' : 'n');
}

function detectDateOrders(values) {
  var bySig = {};
  values.forEach(function (v) {
    var s = String(v || '').trim();
    var m = DATE_RE.exec(s);
    if (!m) return;
    var sig = dateSignature(s);
    var o = bySig[sig] = bySig[sig] || { mdy: false, dmy: false };
    if (+m[1] > 12) o.dmy = true;
    if (+m[2] > 12) o.mdy = true;
  });
  var out = {};
  Object.keys(bySig).forEach(function (sig) {
    var o = bySig[sig];
    out[sig] = (o.mdy && !o.dmy) ? 'mdy' : (o.dmy && !o.mdy) ? 'dmy' : 'auto';
  });
  return out;
}

function parseDate(v, orders, fallback) {
  if (!v) return null;
  var s = String(v).trim();
  if (!s) return null;
  var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (iso) return iso[1] + '-' + pad(iso[2]) + '-' + pad(iso[3]);
  var m = DATE_RE.exec(s);
  if (m) {
    var order = (orders && orders[dateSignature(s)]) || 'auto';
    if (order === 'auto') order = fallback || 'dmy';
    var a = +m[1], b = +m[2];
    var y = m[3].length === 2 ? ('20' + m[3]) : m[3];
    var day = order === 'mdy' ? b : a;
    var mon = order === 'mdy' ? a : b;
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return y + '-' + pad(mon) + '-' + pad(day);
  }
  var d = new Date(s);
  if (!isNaN(d.getTime()) && /\d{4}/.test(s)) return d.toISOString().slice(0, 10);
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

// ── answers: score / yes-no / text ─────────────────────────
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
function isYes(v) { return /^(y|yes|yeah|yep|true|definitely|absolutely|✓)\b/i.test(norm(v)); }
function isNo(v)  { return /^(n|no|nope|false|not really)\b/i.test(norm(v)); }
function truthy(v) {
  var sc = toScore(v);
  if (sc != null) return sc >= 4;
  return isYes(v);
}

// Demographic questions: kept ANONYMOUSLY on each response (never with a
// name or email) so the Demographics page can count event attendees.
function demoKey(h) {
  var x = norm(h);
  if (/date of birth|\bdob\b/.test(x)) return null;
  if (/\bage\b|age group|how old/.test(x)) return 'age';
  if (/gender|\bsex\b/.test(x)) return 'gender';
  if (/ethnic/.test(x)) return 'ethnicity';
  if (/disabilit/.test(x)) return 'disability';
  if (/postcode|post code/.test(x)) return 'postcode';
  if (/religio|belief/.test(x)) return 'religion';
  if (/sexual orientation/.test(x)) return 'orientation';
  return null;
}
// Postcodes: first half only (PE2 7AB → PE2)
function outwardCode(v) {
  var m = /^([A-Z]{1,2}\d[A-Z\d]?)/.exec(String(v || '').toUpperCase().trim());
  return m ? m[1] : '';
}
// Personal data: never imported for feedback.
function isPersonalColumn(h) {
  var x = norm(h);
  if (demoKey(h)) return false;
  return /e-?mail|phone|mobile|telephone|address|date of birth|\bdob\b/.test(x) ||
         /\byour name\b|^name$|name and email|full name|first name|surname/.test(x) ||
         /prize|raffle|win!|leave us a review|support us/.test(x);
}

// Values that are not an event name.
function isJunkName(v) {
  var s = norm(v);
  return !s || /^(other|others|ot|yes|no|n\/?a|none|nil|-|\.|\?|not sure|don'?t know|unknown|#name\?|#ref!|multiple)$/.test(s) || s.length > 80;
}

// "Flower pressing" / "Flower Press Workshop" / "flower-pressing" → one key
var NAME_STOP = { workshop: 1, session: 1, event: 1, class: 1, the: 1, a: 1, an: 1, and: 1, of: 1, our: 1, at: 1, in: 1 };
function nameKey(s) {
  return norm(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function (w) {
    return w && !NAME_STOP[w];
  }).map(function (w) {
    if (w.length > 5 && /ing$/.test(w)) w = w.slice(0, -3);
    else if (w.length > 4 && /s$/.test(w)) w = w.slice(0, -1);
    return w;
  }).sort().join(' ');
}

// ── column detection for events / hours (unchanged from v2) ──
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
  ]
};

function hitMatches(header, hit) {
  if (hit.length >= 8) return header.indexOf(hit) !== -1;
  return header === hit || header.indexOf(hit + ' ') === 0 || header.indexOf(hit) === 0;
}

function autoMap(headers, schema) {
  var map = {};
  headers.forEach(function (h, i) {
    var hn = norm(h).replace(/[^a-z0-9 '?]/g, ' ').replace(/\s+/g, ' ').trim();
    for (var s = 0; s < schema.length; s++) {
      var key = schema[s].key;
      if (map[key] != null) continue;
      var hits = schema[s].match;
      for (var m = 0; m < hits.length; m++) {
        if (hitMatches(hn, hits[m])) { map[key] = i; return; }
      }
    }
  });
  return map;
}

// ── FEEDBACK ANALYSIS (pure — no DOM) ──────────────────────
// Which Vorlana outcome does a question look like?
var MEASURE_HINTS = [
  ['connected', /connected|belong|less lonely|part of the community/],
  ['friend',    /friend|new people|talked to/],
  ['learned',   /learn|new skill|more skilled/],
  ['quote',     /improve|comment|anything else|tell us|favourite part|what did you enjoy/],
  ['enjoyed',   /enjoy/],
  ['cb',        /(confiden|feel|wellbeing).*before|before.*(confiden|feel|wellbeing)/],
  ['ca',        /(confiden|feel|wellbeing).*(after|now)|(after|now).*(confiden|feel|wellbeing)/]
];
function guessMeasure(q) {
  var x = norm(q);
  for (var i = 0; i < MEASURE_HINTS.length; i++) if (MEASURE_HINTS[i][1].test(x)) return MEASURE_HINTS[i][0];
  return null;
}
function guessKind(values) {
  var nonEmpty = values.filter(function (v) { return norm(v); });
  if (!nonEmpty.length) return 'ignore';
  var score = 0, yn = 0, longText = 0;
  nonEmpty.forEach(function (v) {
    if (toScore(v) != null) score++;
    else if (isYes(v) || isNo(v)) yn++;
    else if (String(v).length > 25) longText++;
  });
  var t = nonEmpty.length;
  if (score / t >= 0.6) return 'score';
  if ((yn + score) / t >= 0.6) return 'yesno';
  if (longText / t >= 0.3) return 'text';
  return 'choice';
}

function analyseFeedback(headers, rows, existingEvents, opts) {
  opts = opts || {};
  var H = headers.map(function (h) { return String(h || '').trim(); });
  var ncol = H.length;
  var colVals = function (i) { return rows.map(function (r) { return r[i] == null ? '' : String(r[i]); }); };

  // 1. date column = best date-parse rate
  var dateCol = -1, bestRate = 0, orders = {};
  for (var i = 0; i < ncol; i++) {
    var vals = colVals(i);
    var filled = vals.filter(function (v) { return v.trim(); });
    if (!filled.length) continue;
    var ok = filled.filter(function (v) { return DATE_RE.test(v.trim()) || /^\d{4}-\d{2}-\d{2}/.test(v.trim()); }).length;
    var rate = ok / filled.length;
    if (rate > bestRate || (rate === bestRate && /timestamp/.test(norm(H[i])))) { bestRate = rate; dateCol = i; }
  }
  if (dateCol >= 0) orders = detectDateOrders(colVals(dateCol));
  var fallbackOrder = opts.dateOrder || 'dmy';
  if (!opts.dateOrder) {
    var any = Object.keys(orders).map(function (k) { return orders[k]; }).filter(function (o) { return o !== 'auto'; });
    if (any.length) fallbackOrder = any[0];
  }

  // 2. event-name candidate columns (in priority order)
  var nameCols = [];
  H.forEach(function (h, i) {
    if (i === dateCol || isPersonalColumn(h)) return;
    var x = norm(h);
    if (/name of the (workshop|event|session)|which (workshop|event|session)|event name|session name|workshop name|what (workshop|event|session)|did you attend/.test(x)) nameCols.push([0, i]);
    else if (/please specify|if you answered .?other/.test(x)) nameCols.push([1, i]);
    else if (/^(event|workshop|session|activity)$/.test(x)) nameCols.push([2, i]);
    else if (/\bdate\b/.test(x) && i !== dateCol) nameCols.push([3, i]);   // a mis-used "Date" column
  });
  nameCols.sort(function (a, b) { return a[0] - b[0]; });
  nameCols = nameCols.map(function (p) { return p[1]; });

  // 3. question columns = everything else with a header; demographic columns set aside
  var excluded = [], questionCols = [], demoCols = [];
  var nameSet = {}; nameCols.forEach(function (i) { nameSet[i] = 1; });
  H.forEach(function (h, i) {
    if (!h) return;
    if (i === dateCol || nameSet[i]) return;
    var dk = demoKey(h);
    if (dk) { if (!demoCols.some(function (d) { return d.key === dk; })) demoCols.push({ i: i, key: dk, header: h }); return; }
    if (isPersonalColumn(h)) { excluded.push(h); return; }
    questionCols.push(i);
  });

  // 4. walk rows — never skip
  var lastDate = null, noDate = 0, noName = 0;
  var clusters = {};   // nameKey → { spellings: {raw: count} }
  var responses = [];
  rows.forEach(function (r, idx) {
    var date = dateCol >= 0 ? parseDate(r[dateCol], orders, fallbackOrder) : null;
    if (!date) { date = lastDate; noDate++; }
    if (!date) { date = opts.today || new Date().toISOString().slice(0, 10); }
    lastDate = date;

    var raw = '';
    for (var k = 0; k < nameCols.length && !raw; k++) {
      var v = String(r[nameCols[k]] == null ? '' : r[nameCols[k]]).trim();
      if (!isJunkName(v)) raw = v;
    }
    var key;
    if (raw) {
      key = nameKey(raw);
      var cl = clusters[key] = clusters[key] || { spellings: {} };
      cl.spellings[raw] = (cl.spellings[raw] || 0) + 1;
    } else {
      noName++;
      key = '__nameless__';
      clusters[key] = clusters[key] || { spellings: {}, nameless: true };
    }

    var answers = {};
    questionCols.forEach(function (i) {
      var q = H[i];
      var a = String(r[i] == null ? '' : r[i]).trim();
      if (!a) return;
      var sc = toScore(a);
      answers[q] = sc != null ? sc : a;
    });

    var demo = {};
    demoCols.forEach(function (d) {
      var v = String(r[d.i] == null ? '' : r[d.i]).trim();
      if (d.key === 'postcode') v = outwardCode(v);
      if (v && !/^prefer not to say$/i.test(v)) demo[d.key] = v.slice(0, 60);
    });

    var stamp = dateCol >= 0 ? String(r[dateCol] == null ? '' : r[dateCol]).trim() : '';
    responses.push({ _row: idx + 2, _key: key, _date: date, _raw: raw, _stamp: stamp, answers: answers, demographics: demo });
  });

  // 5. display name per cluster = most common spelling, tidied
  var clusterName = {};
  Object.keys(clusters).forEach(function (k) {
    if (clusters[k].nameless) return;
    var sp = clusters[k].spellings;
    var best = Object.keys(sp).sort(function (a, b) { return sp[b] - sp[a] || a.length - b.length; })[0];
    clusterName[k] = best.trim().replace(/\s+/g, ' ').replace(/^\w/, function (c) { return c.toUpperCase(); });
  });

  // 6. sessions = cluster + date → existing event or new
  var evByKeyDate = {};
  (existingEvents || []).forEach(function (e) { if (e.date) evByKeyDate[nameKey(e.name) + '|' + e.date] = e; });
  var sessions = {};
  responses.forEach(function (r) {
    var name = r._key === '__nameless__' ? ('Session on ' + niceDate(r._date)) : clusterName[r._key];
    var sk = nameKey(name) + '|' + r._date;
    r._session = sk;
    if (!sessions[sk]) {
      var ex = evByKeyDate[sk] || null;
      sessions[sk] = { name: ex ? ex.name : name, date: r._date, eventId: ex ? ex.id : null, count: 0, nameless: r._key === '__nameless__' };
    }
    sessions[sk].count++;
  });

  // 7. measures guess per question
  var measures = questionCols.map(function (i) {
    var vals = colVals(i);
    var kind = guessKind(vals);
    var maps = guessMeasure(H[i]);
    if (kind === 'text' && maps && maps !== 'quote') maps = null;
    if (kind !== 'text' && maps === 'quote') maps = null;
    if (kind === 'choice') maps = null;
    return { question: H[i], kind: kind, maps_to: maps, filled: vals.filter(function (v) { return v.trim(); }).length };
  });
  // one question per Vorlana field — the first (usually the plainest) keeps the guess
  var taken = {};
  measures.forEach(function (m) {
    if (!m.maps_to) return;
    if (taken[m.maps_to]) m.maps_to = null; else taken[m.maps_to] = 1;
  });

  var sessList = Object.keys(sessions).map(function (k) { return sessions[k]; });
  return {
    dateCol: dateCol, dateHeader: dateCol >= 0 ? H[dateCol] : null, orders: orders, fallbackOrder: fallbackOrder,
    nameCols: nameCols.map(function (i) { return H[i]; }),
    questionCols: questionCols, excluded: excluded,
    demoCols: demoCols, demoCount: responses.filter(function (r) { return Object.keys(r.demographics).length; }).length,
    responses: responses, sessions: sessions,
    newSessions: sessList.filter(function (s) { return !s.eventId; }),
    matchedSessions: sessList.filter(function (s) { return s.eventId; }).length,
    eventNames: Object.keys(clusterName).length,
    noDate: noDate, noName: noName, measures: measures
  };
}

// ── VOLUNTEER HOURS ANALYSIS (pure — no DOM) ───────────────
// Sign-in forms change over time, so hours and dates can each live in
// several columns. Per row, the first usable value wins:
//   date  : a "previous date" / "change the date" column → any other
//           column whose values are dates → the Timestamp
//   hours : a numeric "hours / how long" answer → End − Start time
//   event : a real event column if there is one, else the one Vorlana
//           event held that day (if exactly one)
//   what they did : an "activities / tasks / role" column
function parseTimeOfDay(v) {
  var s = String(v == null ? '' : v).trim().toUpperCase();
  var m = /^(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(AM|PM)?$/.exec(s);
  if (!m) return null;
  var h = +m[1], mi = +(m[2] || 0);
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  if (h > 23 || mi > 59) return null;
  return h + mi / 60;
}

function analyseHours(headers, rows, existingVols, existingEvents, opts) {
  opts = opts || {};
  var H = headers.map(function (h) { return String(h || '').trim(); });
  var hn = H.map(norm);
  var colVals = function (i) { return rows.map(function (r) { return r[i] == null ? '' : String(r[i]).trim(); }); };
  var dateRate = function (i) {
    var f = colVals(i).filter(Boolean);
    if (!f.length) return 0;
    return f.filter(function (v) { return DATE_RE.test(v) || /^\d{4}-\d{2}-\d{2}/.test(v); }).length / f.length;
  };
  var find = function (re, not) {
    for (var i = 0; i < H.length; i++) if (re.test(hn[i]) && !(not && not.test(hn[i]))) return i;
    return -1;
  };

  var nameCol  = find(/full name|your name|volunteer name|^name$|^volunteer$/);
  var emailCol = find(/e-?mail/);
  var phoneCol = find(/phone|mobile|telephone/);
  var actCol   = find(/activit|task|what .*(doing|supporting|did)|^role$/);
  var eventCol = find(/which (event|workshop|session)|name of the (event|workshop|session)|^event( name)?$/);

  // timestamp = best date column, preferring one called "timestamp"
  var stampCol = -1, best = 0;
  H.forEach(function (h, i) {
    var r = dateRate(i);
    if (r > best || (r === best && r > 0 && /timestamp/.test(hn[i]))) { best = r; stampCol = i; }
  });
  // other date columns (override first, then any mis-titled date column)
  var dateCols = [];
  H.forEach(function (h, i) {
    if (i === stampCol || i === nameCol || i === eventCol) return;
    if (dateRate(i) >= 0.6) dateCols.push([/previous date|change the date|date of (the )?session|session date|^date$/.test(hn[i]) ? 0 : 1, i]);
  });
  dateCols.sort(function (a, b) { return a[0] - b[0]; });
  dateCols = dateCols.map(function (p) { return p[1]; });

  var allDates = [];
  [stampCol].concat(dateCols).forEach(function (i) { if (i >= 0) allDates = allDates.concat(colVals(i)); });
  var orders = detectDateOrders(allDates);
  var fb = opts.dateOrder || 'mdy';
  if (!opts.dateOrder) { var any = Object.keys(orders).map(function (k) { return orders[k]; }).filter(function (o) { return o !== 'auto'; }); if (any.length) fb = any[0]; }

  // hours: numeric answers in an hours-ish column, then start/end
  var hourCols = [];
  H.forEach(function (h, i) {
    if (!/hour|how long|duration|hrs/.test(hn[i]) || dateRate(i) >= 0.5) return;
    hourCols.push(i);
  });
  var startCol = find(/start/), endCol = find(/\bend\b|finish/);

  var byEmail = {}, byName = {};
  (existingVols || []).forEach(function (v) { if (v.email) byEmail[norm(v.email)] = v; if (v.name) byName[norm(v.name)] = v; });
  var evByDate = {};
  (existingEvents || []).forEach(function (e) { if (e.date) (evByDate[e.date] = evByDate[e.date] || []).push(e); });
  var evByName = {};
  (existingEvents || []).forEach(function (e) { evByName[norm(e.name)] = e; });

  var newVols = {}, entries = [], skipped = [], volOnly = [], skills = {}, linked = 0, fromTimes = 0, fromAnswer = 0;
  rows.forEach(function (r, idx) {
    var cellAt = function (i) { return i >= 0 && r[i] != null ? String(r[i]).trim() : ''; };
    var name = cellAt(nameCol).replace(/\s+/g, ' '), email = cellAt(emailCol);
    if (!name && !email) { skipped.push({ row: idx + 2, why: 'no name' }); return; }

    // Volunteer + skills first — a volunteer is created even when the row has no hours or date
    var key = email ? norm(email) : norm(name);
    var existing = (email && byEmail[norm(email)]) || byName[norm(name)];
    if (!existing && !newVols[key]) {
      newVols[key] = { org_id: opts.orgId, name: name || email, first_name: (name || email).split(' ')[0],
        last_name: (name || '').split(' ').slice(1).join(' '), email: email || null,
        phone: cellAt(phoneCol) || null, role: 'Volunteer', status: 'Active', hours: 0, skills: '[]' };
    }
    var sk = skills[key] = skills[key] || { existing: existing || null, set: {} };
    cellAt(actCol).split(/[,;\n]/).forEach(function (a) {
      a = a.trim().replace(/\s+/g, ' ');
      // a skill is a short activity name — not a date range or a note ("From July to October", "Every Friday…")
      if (a && a.length <= 40 && !/\d/.test(a) && !/^(other|n\/?a|none)$/i.test(a) && !/^(from|every|meeting|each)\b/i.test(a)) sk.set[a.replace(/^\w/, function (c) { return c.toUpperCase(); })] = 1;
    });

    var sane = function (iso) { if (!iso) return null; var y = +iso.slice(0, 4); return (y >= 2000 && y <= new Date().getFullYear() + 1) ? iso : null; };
    // A "previous date" can't be after the form was submitted. If it is, the
    // day and month were probably typed the other way round; failing that, use the timestamp.
    var stampDate = sane(parseDate(cellAt(stampCol), orders, fb));
    var swap = function (iso) { if (!iso) return null; var p = iso.split('-'); return +p[2] <= 12 ? p[0] + '-' + p[2] + '-' + p[1] : null; };
    var date = null;
    for (var d = 0; d < dateCols.length && !date; d++) {
      var cand = sane(parseDate(cellAt(dateCols[d]), orders, fb));
      if (cand && stampDate && cand > stampDate) cand = (swap(cand) && swap(cand) <= stampDate) ? swap(cand) : null;
      date = cand;
    }
    if (!date) date = stampDate;
    if (!date) { volOnly.push({ row: idx + 2, why: name + ' — no date, volunteer added without hours' }); return; }

    var hrs = 0;
    for (var h = 0; h < hourCols.length && !hrs; h++) {
      var raw = cellAt(hourCols[h]);
      if (/^\d+(\.\d+)?(\s*(h|hrs?|hours?))?$/i.test(raw)) { var x = parseFloat(raw); if (x > 0 && x <= 16) { hrs = x; fromAnswer++; } }
    }
    if (!hrs && startCol >= 0 && endCol >= 0) {
      var st = parseTimeOfDay(cellAt(startCol)), en = parseTimeOfDay(cellAt(endCol));
      if (st != null && en != null) {
        if (en <= st && en < 12) en += 12;          // "10:00" → "2:00" meant 2 pm
        var diff = en - st;
        if (diff > 0 && diff <= 16) { hrs = Math.round(diff * 100) / 100; fromTimes++; }
      }
    }
    if (!hrs) { volOnly.push({ row: idx + 2, why: name + ' on ' + date + ' — no hours given, volunteer added without hours' }); return; }

    var ev = null, evName = cellAt(eventCol);
    if (evName) ev = evByName[norm(evName)] || null;
    if (!ev && evByDate[date] && evByDate[date].length === 1) ev = evByDate[date][0];
    if (ev) linked++;

    entries.push({ _volKey: key, _existingId: existing ? existing.id : null, _row: idx + 2,
      _stamp: cellAt(stampCol), event_id: ev ? String(ev.id) : null, session_date: date,
      hours: Math.round(hrs * 100) / 100, activity: cellAt(actCol) || null });
  });

  // skills: onto new volunteers directly; for existing ones, only what they don't already have
  var skillUpdates = [], skillCount = 0;
  Object.keys(skills).forEach(function (k) {
    var list = Object.keys(skills[k].set);
    if (!list.length) return;
    if (newVols[k]) { newVols[k].skills = JSON.stringify(list); skillCount++; return; }
    var ex = skills[k].existing;
    if (!ex) return;
    var have = (Array.isArray(ex.skills) ? ex.skills : []).map(norm);
    var add = list.filter(function (x) { return have.indexOf(norm(x)) === -1; });
    if (add.length) { skillUpdates.push({ id: ex.id, skills: (Array.isArray(ex.skills) ? ex.skills : []).concat(add) }); skillCount++; }
  });

  return {
    skillUpdates: skillUpdates, skillCount: skillCount, volOnly: volOnly,
    cols: { name: H[nameCol], stamp: H[stampCol], dates: dateCols.map(function (i) { return H[i]; }),
            hours: hourCols.map(function (i) { return H[i]; }), start: H[startCol], end: H[endCol], activity: H[actCol], event: H[eventCol] },
    newVols: Object.keys(newVols).map(function (k) { return { key: k, row: newVols[k] }; }),
    entries: entries, skipped: skipped, linked: linked, fromTimes: fromTimes, fromAnswer: fromAnswer
  };
}

// ── batched write ──────────────────────────────────────────
function writeBatched(table, rows, onProgress, upsertOn) {
  if (!rows.length) return Promise.resolve({ inserted: 0, failed: 0, errors: [] });
  var done = 0, failed = 0, errors = [];
  var chunks = [];
  for (var i = 0; i < rows.length; i += BATCH) chunks.push(rows.slice(i, i + BATCH));
  return chunks.reduce(function (p, chunk) {
    return p.then(function () {
      var q = upsertOn ? sb.from(table).upsert(chunk, { onConflict: upsertOn, ignoreDuplicates: true })
                       : sb.from(table).insert(chunk);
      return q.then(function (res) {
        if (res && res.error) throw res.error;
        done += chunk.length;
      }).catch(function (e) {
        failed += chunk.length;
        if (errors.length < 3) errors.push((e && e.message) || String(e));
      }).then(function () { if (onProgress) onProgress(done + failed, rows.length); });
    });
  }, Promise.resolve()).then(function () { return { inserted: done, failed: failed, errors: errors }; });
}

// ── state ──────────────────────────────────────────────────
var S = { kind: 'feedback', headers: [], rows: [], map: {}, plan: null, dateOrder: 'dmy', file: '', batch: null };

// ── modal ──────────────────────────────────────────────────
function injectModal() {
  if ($('modal-himport')) return;
  var m = document.createElement('div');
  m.className = 'modal-overlay';
  m.id = 'modal-himport';
  m.innerHTML =
    '<div class="modal" style="max-width:780px">' +
      '<h2>Import historic data</h2>' +
      '<p style="font-size:13px;color:var(--txt2);line-height:1.7;margin-bottom:14px">' +
        'Bring in what you already have. For feedback, drop the export from your own survey — every question is kept as you wrote it. Nothing to set up first.' +
      '</p>' +
      '<div class="vtab-bar" style="margin-bottom:16px">' +
        '<button class="vtab-btn" data-kind="events">Events</button>' +
        '<button class="vtab-btn" data-kind="hours">Volunteers &amp; hours</button>' +
        '<button class="vtab-btn active" data-kind="feedback">Feedback</button>' +
      '</div>' +
      '<div id="hi-hint" style="font-size:12px;color:var(--txt3);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:12px"></div>' +
      '<div id="hi-opts" style="display:none;margin-bottom:12px">' +
        '<div class="form-grid-3">' +
          '<div class="form-row" id="hi-bulk-wrap"><label>Link new events to a funder / contract</label>' +
            '<select id="hi-bulk-contract"><option value="">— leave unlinked —</option></select></div>' +
          '<div class="form-row" id="hi-type-wrap" style="display:none"><label>Session type</label>' +
            '<select id="hi-ev-type"><option>Community Event</option><option>Green Skills</option><option>Wellbeing</option><option>Frailty</option><option>Other</option></select></div>' +
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
      '<div id="hi-after" style="margin-top:12px"></div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-ghost" id="hi-close">Close</button>' +
        '<button class="btn btn-ghost" id="hi-undo" style="display:none">Undo this import</button>' +
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
  $('hi-file').addEventListener('change', function (e) { var f = e.target.files && e.target.files[0]; if (f) readFile(f); });
  var drop = $('hi-drop');
  drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.style.borderColor = 'var(--em)'; });
  drop.addEventListener('dragleave', function () { drop.style.borderColor = 'var(--border)'; });
  drop.addEventListener('drop', function (e) {
    e.preventDefault(); drop.style.borderColor = 'var(--border)';
    var f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) readFile(f);
  });
  ['hi-bulk-contract', 'hi-ev-type', 'hi-date-order'].forEach(function (id) {
    $(id).addEventListener('change', function () { if (S.rows.length) { resolveDateOrder(); buildPlan(); } });
  });
  $('hi-run').addEventListener('click', runImport);
  $('hi-undo').addEventListener('click', undoImport);
}

var HINTS = {
  events: 'Needs at least: <strong>event name</strong> and <strong>date</strong>. Also reads type, location, attendees, capacity, and a funder/contract column.',
  hours: 'Drop your volunteer sign-in export. Vorlana finds the name, the date and the hours itself — including forms that changed over time (an hours answer on some rows, start and end times on others). Volunteers not already on your list are created.',
  feedback: 'Drop <strong>any</strong> survey export. Vorlana finds the date and the event name itself, keeps every question word-for-word, and leaves out personal data. ' +
            'Afterwards you tidy event names and confirm how each question is used in reports.'
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
  $('hi-type-wrap').style.display = S.kind === 'feedback' ? '' : 'none';
}

function reset() {
  S.headers = []; S.rows = []; S.map = {}; S.plan = null; S.batch = null;
  $('hi-status').innerHTML = '';
  $('hi-plan').innerHTML = '';
  $('hi-after').innerHTML = '';
  $('hi-mapping').style.display = 'none';
  $('hi-mapping').innerHTML = '';
  $('hi-run').disabled = true;
  $('hi-run').textContent = 'Import';
  $('hi-run').style.display = '';
  $('hi-undo').style.display = 'none';
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
      S.file = file.name;
      S.map = S.kind === 'events' ? autoMap(parsed.headers, SCHEMAS[S.kind]) : {};
      resolveDateOrder();
      $('hi-status').innerHTML = '✓ Read <strong>' + parsed.rows.length.toLocaleString() + '</strong> rows and ' +
        parsed.headers.length + ' columns from ' + esc(file.name) + (parsed.delim === '\t' ? ' (tab-separated)' : '');
      $('hi-after').innerHTML = '';
      if (S.kind === 'events') showMapping();
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
  S.dateOrder = null;   // let the analyser decide
  if (S.kind === 'events') {
    var i = S.map.date;
    var orders = i == null ? {} : detectDateOrders(S.rows.map(function (r) { return r[i]; }));
    var any = Object.keys(orders).map(function (k) { return orders[k]; }).filter(function (o) { return o !== 'auto'; });
    S.dateOrder = any[0] || 'dmy';
  }
}

function requiredMissing() {
  if (S.kind !== 'events') return [];
  return SCHEMAS[S.kind].filter(function (f) { return f.required && S.map[f.key] == null; });
}

function showMapping() {
  var schema = SCHEMAS[S.kind];
  var missing = requiredMissing();
  var wrap = $('hi-mapping');
  wrap.style.display = 'block';
  var rows = mappingRows(schema);
  wrap.innerHTML = !missing.length
    ? '<details><summary style="cursor:pointer;font-size:12px;color:var(--txt3)">Columns detected automatically — click to check or change</summary><div style="margin-top:8px">' + rows + '</div></details>'
    : '<div class="alert alert-warn" style="margin-bottom:10px">We could not find: <strong>' + missing.map(function (f) { return esc(f.label); }).join(', ') + '</strong>. Please pick the right columns below.</div>' + rows;
  bindMapping();
}

function mappingRows(schema) {
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">' +
    schema.map(function (f) {
      var opts = '<option value="">— not in my file —</option>' +
        S.headers.map(function (h, i) {
          return '<option value="' + i + '"' + (S.map[f.key] === i ? ' selected' : '') + '>' + esc(h.length > 70 ? h.slice(0, 70) + '…' : h) + '</option>';
        }).join('');
      return '<div class="form-row" style="margin:0"><label>' + esc(f.label) + (f.required ? ' *' : '') + '</label><select data-mapkey="' + f.key + '">' + opts + '</select></div>';
    }).join('') + '</div>';
}

function bindMapping() {
  document.querySelectorAll('#hi-mapping select[data-mapkey]').forEach(function (sel) {
    sel.addEventListener('change', function () {
      var k = sel.getAttribute('data-mapkey');
      if (sel.value === '') delete S.map[k]; else S.map[k] = parseInt(sel.value, 10);
      if (k === 'date') resolveDateOrder();
      showMapping();
      buildPlan();
    });
  });
}

function cell(row, key) {
  var i = S.map[key];
  if (i == null) return '';
  return String(row[i] == null ? '' : row[i]).trim();
}
function pDate(v) { return parseDate(v, {}, S.dateOrder || 'dmy'); }

function buildPlan() {
  if (requiredMissing().length) { $('hi-plan').innerHTML = ''; $('hi-run').disabled = true; return; }
  if (S.kind === 'events') planEvents();
  else if (S.kind === 'hours') planHours();
  else planFeedback();
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

// ── plan: events (unchanged behaviour) ─────────────────────
function planEvents() {
  var create = [], skipped = [];
  var existing = {};
  (DB.events || []).forEach(function (e) { existing[norm(e.name) + '|' + (e.date || '')] = e; });
  var seen = {};
  var bulkId = ($('hi-bulk-contract') && $('hi-bulk-contract').value) || '';
  var linked = 0, unmatched = {};
  S.rows.forEach(function (r, idx) {
    var name = cell(r, 'name');
    var date = pDate(cell(r, 'date'));
    if (!name) { skipped.push({ row: idx + 2, why: 'no event name' }); return; }
    if (!date) { skipped.push({ row: idx + 2, why: 'date not understood: "' + cell(r, 'date') + '"' }); return; }
    var key = norm(name) + '|' + date;
    if (existing[key] || seen[key]) { skipped.push({ row: idx + 2, why: 'already in Vorlana' }); return; }
    seen[key] = 1;
    var conIds = [];
    var conName = cell(r, 'contract');
    if (conName) {
      var c = findContract(conName);
      if (c) { conIds = [String(c.id)]; linked++; } else unmatched[conName] = (unmatched[conName] || 0) + 1;
    }
    if (!conIds.length && bulkId) { conIds = [bulkId]; linked++; }
    create.push({
      org_id: orgId, name: name, event_date: date, type: cell(r, 'type') || 'Other',
      location: cell(r, 'location') || null, attendees: n(cell(r, 'attendees')),
      capacity: n(cell(r, 'capacity')) || null, contract_ids: conIds
    });
  });
  S.plan = { kind: 'events', create: create, skipped: skipped };
  var un = Object.keys(unmatched);
  var notes = [];
  if (un.length) notes.push('No contract found for: ' + un.slice(0, 5).join(', ') + '. Those events import unlinked.');
  renderPlan([['Events to create', create.length], ['Linked to a funder', linked], ['Rows skipped', skipped.length]], skipped, create.length > 0, notes);
}

// ── plan: volunteers + hours ───────────────────────────────
function planHours() {
  var A = analyseHours(S.headers, S.rows, DB.volunteers || [], DB.events || [], { dateOrder: S.dateOrder, orgId: orgId });
  S.plan = { kind: 'hours', analysis: A, newVols: A.newVols, hourRows: A.entries, skipped: A.skipped, skillUpdates: A.skillUpdates };
  var total = A.entries.reduce(function (a, h) { return a + h.hours; }, 0);
  var short = function (h) { return h ? '“' + (h.length > 45 ? h.slice(0, 45) + '…' : h) + '”' : null; };
  var notes = [];
  notes.push('Volunteer from ' + (short(A.cols.name) || 'no name column found') + '.');
  notes.push('Date from ' + A.cols.dates.map(short).concat([short(A.cols.stamp)]).filter(Boolean).join(', then ') + '.');
  var hs = [];
  if (A.fromAnswer) hs.push(A.fromAnswer + ' from ' + A.cols.hours.map(short).join(' / '));
  if (A.fromTimes) hs.push(A.fromTimes + ' worked out from Start and End time');
  if (hs.length) notes.push('Hours: ' + hs.join('; ') + '.');
  if (A.cols.activity) notes.push('What they did — and each volunteer\'s skills — from ' + short(A.cols.activity) + '. ' + A.skillCount + ' volunteer(s) get skills.');
  if (A.volOnly.length) notes.push(A.volOnly.length + ' row(s) had a name but no hours or date — the volunteer is still added, just without an hour entry.');
  notes.push(A.linked ? A.linked + ' entries linked to the Vorlana event held that day; the rest import unlinked.' : 'Entries import unlinked to events (no single Vorlana event on those days).');
  renderPlan([
    ['Hour entries', A.entries.length],
    ['Total hours', Math.round(total * 10) / 10],
    ['Volunteers', Object.keys(A.entries.concat(A.volOnly).reduce(function (o, e) { if (e._volKey) o[e._volKey] = 1; return o; }, {})).length || A.newVols.length],
    ['New volunteers', A.newVols.length],
    ['Linked to events', A.linked],
    ['Rows skipped', A.skipped.length]
  ], A.skipped.concat(A.volOnly), (A.entries.length + A.newVols.length) > 0, notes);
}

// ── plan: feedback ─────────────────────────────────────────
function planFeedback() {
  var A = analyseFeedback(S.headers, S.rows, DB.events || [], { dateOrder: S.dateOrder });
  S.plan = { kind: 'feedback', analysis: A };

  var notes = [];
  if (A.dateHeader) {
    var fmts = Object.keys(A.orders).map(function (k) { return A.orders[k] === 'auto' ? A.fallbackOrder : A.orders[k]; });
    var hasM = fmts.indexOf('mdy') !== -1, hasD = fmts.indexOf('dmy') !== -1;
    notes.push('Dates read from “' + A.dateHeader + '”' + (hasM && hasD ? ' — the file mixes US and UK formats; both handled.' : hasM ? ' (US format, month first).' : ' (UK format, day first).'));
  } else notes.push('No date column found — rows are dated today. Add a date column to the file if that matters.');
  if (A.noDate) notes.push(A.noDate + ' row(s) had no readable date and took the date of the row before.');
  if (A.nameCols.length) notes.push('Event name taken from: ' + A.nameCols.map(function (h) { return '“' + h.slice(0, 40) + (h.length > 40 ? '…' : '') + '”'; }).join(', then ') + '.');
  if (A.noName) notes.push(A.noName + ' response(s) had no event name — they become “Session on <date>”. Rename them in the next step.');
  notes.push(A.questionCols.length + ' questions kept word-for-word on every response.');
  if (A.demoCols.length) notes.push('Demographics kept anonymously (no name or email attached) from ' + A.demoCount + ' responses: ' +
    A.demoCols.map(function (d) { return d.key === 'postcode' ? 'postcode (first half only)' : d.key; }).join(', ') + '.');
  if (A.excluded.length) notes.push('Left out (personal data, never stored): ' + A.excluded.map(function (h) { return '“' + h.slice(0, 40) + (h.length > 40 ? '…' : '') + '”'; }).join(', '));

  var sess = Object.keys(A.sessions).map(function (k) { return A.sessions[k]; }).sort(function (a, b) { return a.date.localeCompare(b.date); });
  var sessHTML = '<details style="font-size:12px;color:var(--txt2);margin-bottom:8px"><summary style="cursor:pointer">Show ' + sess.length + ' session(s)</summary>' +
    '<div style="max-height:220px;overflow:auto;background:var(--bg);border-radius:8px;padding:8px;margin-top:6px">' +
    sess.map(function (s) {
      return esc(niceDate(s.date)) + ' · ' + esc(s.name) + ' — ' + s.count + ' response' + (s.count === 1 ? '' : 's') +
        (s.eventId ? ' · <span style="color:var(--em)">already in Vorlana</span>' : ' · <strong>new</strong>');
    }).join('<br/>') + '</div></details>';

  renderPlan([
    ['Responses', A.responses.length],
    ['Events', A.eventNames + (A.noName ? 1 : 0)],
    ['Sessions', sess.length],
    ['New sessions', A.newSessions.length],
    ['Questions', A.questionCols.length],
    ['Rows skipped', 0]
  ], [], A.responses.length > 0, notes, sessHTML);
}

function renderPlan(figures, skipped, canRun, notes, extraHTML) {
  var el = $('hi-plan');
  notes = (notes || []).filter(Boolean);
  el.innerHTML =
    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(105px,1fr));gap:10px;margin-bottom:10px">' +
      figures.map(function (f) {
        return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;text-align:center">' +
          '<div style="font-size:20px;font-weight:800;color:var(--em)">' + esc(String(f[1])) + '</div>' +
          '<div style="font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.4px;font-weight:700">' + esc(f[0]) + '</div></div>';
      }).join('') + '</div>' +
    (notes.length ? '<div class="alert alert-info" style="font-size:12px;margin-bottom:8px;line-height:1.6">' + notes.map(esc).join('<br/>') + '</div>' : '') +
    (extraHTML || '') +
    (skipped.length
      ? '<details style="font-size:12px;color:var(--txt3)"><summary style="cursor:pointer">Show ' + skipped.length + ' skipped row(s)</summary>' +
        '<div style="max-height:150px;overflow:auto;background:var(--bg);border-radius:8px;padding:8px;margin-top:6px">' +
        skipped.slice(0, 100).map(function (s) { return 'Row ' + s.row + ' — ' + esc(s.why); }).join('<br/>') +
        (skipped.length > 100 ? '<br/>…and ' + (skipped.length - 100) + ' more' : '') + '</div></details>'
      : '');
  $('hi-run').disabled = !canRun;
}

// ── run ────────────────────────────────────────────────────
function progressBar(what, done, total) {
  $('hi-plan').innerHTML =
    '<div style="font-size:13px;font-weight:700;color:var(--txt);margin-bottom:8px">Importing ' + esc(what) + '… ' + done.toLocaleString() + ' of ' + total.toLocaleString() + '</div>' +
    '<div style="height:10px;background:var(--bg);border-radius:5px;overflow:hidden"><div style="height:100%;width:' + Math.round(done / Math.max(total, 1) * 100) + '%;background:var(--em);transition:width .2s"></div></div>';
}

function runImport() {
  if (!S.plan) return;
  var btn = $('hi-run');
  btn.disabled = true;
  var job, extra = '';

  if (S.plan.kind === 'events') {
    job = writeBatched('events', S.plan.create, function (d, t) { progressBar('events', d, t); })
      .then(function (res) { return refreshTable('events').then(function () { return res; }); });

  } else if (S.plan.kind === 'feedback') {
    job = runFeedback();

  } else {
    var hb = 'imp-' + Date.now().toString(36);
    S.batch = hb;
    var newRows = S.plan.newVols.map(function (v) { return Object.assign({}, v.row, { import_batch: hb }); });
    var su = S.plan.skillUpdates || [];
    job = writeBatched('volunteers', newRows, function (d, t) { progressBar('volunteers', d, t); })
      .then(function () {
        return su.reduce(function (p, u) {
          return p.then(function () { return sb.from('volunteers').update({ skills: JSON.stringify(u.skills) }).eq('id', u.id).then(function () {}, function () {}); });
        }, Promise.resolve());
      })
      .then(function () { return refreshTable('volunteers'); })
      .then(function () {
        var byEmail = {}, byName = {};
        (DB.volunteers || []).forEach(function (v) { if (v.email) byEmail[norm(v.email)] = v; if (v.name) byName[norm(v.name)] = v; });
        var rows = [], orphans = 0;
        S.plan.hourRows.forEach(function (h) {
          var id = h._existingId;
          if (!id) { var v = byEmail[h._volKey] || byName[h._volKey]; id = v ? v.id : null; }
          if (!id) { orphans++; return; }
          rows.push({ org_id: orgId, volunteer_id: String(id), event_id: h.event_id, session_date: h.session_date,
            hours: h.hours, activity: h.activity, source: 'import', import_batch: hb,
            row_hash: hash(h._stamp + '|' + h._row + '|' + h._volKey + '|' + h.session_date + '|' + h.hours) });
        });
        extra += '<br/>' + S.plan.newVols.length + ' volunteer(s) created' + (su.length ? ', ' + su.length + ' existing volunteer(s) given new skills' : '') + '.' + (orphans ? ' ' + orphans + ' hour row(s) could not be matched to a volunteer.' : '');
        return writeBatched('volunteer_hours', rows, function (d, t) { progressBar('hours', d, t); }, 'org_id,row_hash');
      })
      .then(function (res) {
        if (typeof window._reloadVolunteerHours === 'function') return window._reloadVolunteerHours().then(function () { return res; });
        return res;
      });
  }

  job.then(function (res) {
    var el = $('hi-plan');
    el.innerHTML =
      '<div class="alert ' + (res.failed ? 'alert-warn' : 'alert-ok') + '">' +
        (res.failed ? '⚠' : '✓') + ' Imported <strong>' + res.inserted.toLocaleString() + '</strong> record(s).' +
        (res.failed ? ' <strong>' + res.failed.toLocaleString() + '</strong> failed.' : '') +
        (res.duplicates ? ' ' + res.duplicates + ' already in Vorlana from an earlier import — not added twice.' : '') + extra +
        (res.errors.length ? '<div style="font-size:11px;margin-top:6px;opacity:.85">' + esc(res.errors[0]) + (/answers|demographics|row_hash|import_batch|survey_measures/i.test(res.errors[0]) ? ' — run sql/import-v3.sql in Supabase, then import again.' : '') + '</div>' : '') +
      '</div>';
    btn.disabled = false;
    btn.textContent = 'Import';
    if (S.plan.kind === 'hours' && !res.failed) { btn.style.display = 'none'; $('hi-undo').style.display = ''; }
    if (S.plan.kind === 'feedback' && !res.failed) {
      btn.style.display = 'none';
      $('hi-undo').style.display = '';
      renderAfter(S.plan.analysis);
    }
    repaintAll();
  }).catch(function (e) {
    $('hi-plan').innerHTML = '<div class="alert alert-warn">Import failed: ' + esc((e && e.message) || e) + '</div>';
    btn.disabled = false;
  });
}

function runFeedback() {
  var A = S.plan.analysis;
  var batch = 'imp-' + Date.now().toString(36);
  S.batch = batch;
  var evType = ($('hi-ev-type') && $('hi-ev-type').value) || 'Community Event';
  var bulkId = ($('hi-bulk-contract') && $('hi-bulk-contract').value) || '';
  var measureByQ = {};
  A.measures.forEach(function (m) { measureByQ[m.question] = m; });

  var newEvents = A.newSessions.map(function (s) {
    // everyone who left feedback was there — so responses are the minimum attendance
    return { org_id: orgId, name: s.name, event_date: s.date, type: evType, location: null, attendees: s.count, capacity: null, contract_ids: bulkId ? [bulkId] : [], import_batch: batch };
  });

  var raise = Object.keys(A.sessions).map(function (k) { return A.sessions[k]; }).filter(function (s) {
    if (!s.eventId) return false;
    var ev = (DB.events || []).filter(function (e) { return String(e.id) === String(s.eventId); })[0];
    return ev && n(ev.attendees) < s.count;
  });

  return writeBatched('events', newEvents, function (d, t) { progressBar('sessions', d, t); })
    .then(function () {
      return raise.reduce(function (p, s) {
        return p.then(function () { return sb.from('events').update({ attendees: s.count }).eq('id', s.eventId).then(function () {}, function () {}); });
      }, Promise.resolve());
    })
    .then(function () { return refreshTable('events'); })
    .then(function () {
      var byKeyDate = {};
      (DB.events || []).forEach(function (e) { if (e.date) byKeyDate[nameKey(e.name) + '|' + e.date] = e; });
      var rows = [], orphans = 0;
      A.responses.forEach(function (r) {
        var s = A.sessions[r._session];
        var eid = s && (s.eventId || (byKeyDate[r._session] && byKeyDate[r._session].id));
        if (!eid) { orphans++; return; }
        // Vorlana's standard fields from whichever question maps to them — never invented
        var std = { enjoyed: null, cb: null, ca: null, learned: false, connected: false, friend: false, quote: '' };
        Object.keys(r.answers).forEach(function (q) {
          var m = measureByQ[q];
          if (!m || !m.maps_to) return;
          var a = r.answers[q];
          if (m.maps_to === 'quote') { if (!std.quote && String(a).length > 3) std.quote = String(a); return; }
          if (m.maps_to === 'enjoyed' || m.maps_to === 'cb' || m.maps_to === 'ca') {
            var sc = toScore(a);
            if (sc == null && isYes(a)) sc = 5;      // yes/no question feeding a score field
            else if (sc == null && isNo(a)) sc = 1;
            if (sc != null) std[m.maps_to] = Math.min(5, Math.max(1, Math.round(sc)));
            return;
          }
          std[m.maps_to] = truthy(a);
        });
        rows.push({
          org_id: orgId, event_id: eid, name: '',
          enjoyed: std.enjoyed, cb: std.cb, ca: std.ca,
          learned: std.learned, connected: std.connected, friend: std.friend, quote: std.quote,
          answers: r.answers, demographics: r.demographics || {}, import_batch: batch,
          // timestamp + row number: two people giving identical answers at one session are two responses
          row_hash: hash(r._stamp + '|' + r._row + '|' + r._session + '|' + JSON.stringify(r.answers))
        });
      });
      return writeBatched('feedback', rows, function (d, t) { progressBar('responses', d, t); }, 'org_id,row_hash')
        .then(function (res) {
          return sb.from('feedback').select('id', { count: 'exact', head: true }).eq('org_id', orgId).eq('import_batch', batch)
            .then(function (c) {
              var added = (c && c.count != null) ? c.count : res.inserted;
              res.duplicates = Math.max(0, rows.length - added - res.failed);
              res.inserted = added;
              if (orphans) res.errors.unshift(orphans + ' response(s) could not be attached to a session.');
              return res;
            }, function () { return res; });
        });
    })
    .then(function (res) { return refreshTable('feedback').then(function () { return res; }); });
}

function undoImport() {
  if (!S.batch) return;
  var isHours = S.plan && S.plan.kind === 'hours';
  if (!confirm(isHours ? 'Remove every hour entry and new volunteer this import added?' : 'Remove everything this import added (responses and any new sessions)?')) return;
  var b = S.batch;
  var job = isHours
    ? sb.from('volunteer_hours').delete().eq('org_id', orgId).eq('import_batch', b)
        .then(function () { return sb.from('volunteers').delete().eq('org_id', orgId).eq('import_batch', b); })
        .then(function () { return refreshTable('volunteers'); })
        .then(function () { if (typeof window._reloadVolunteerHours === 'function') return window._reloadVolunteerHours(); })
    : sb.from('feedback').delete().eq('org_id', orgId).eq('import_batch', b)
        .then(function () { return sb.from('events').delete().eq('org_id', orgId).eq('import_batch', b); })
        .then(function () { return Promise.all([refreshTable('events'), refreshTable('feedback')]); });
  job
    .then(function () {
      S.batch = null;
      $('hi-plan').innerHTML = '<div class="alert alert-ok">Import removed.</div>';
      $('hi-after').innerHTML = '';
      $('hi-undo').style.display = 'none';
      $('hi-run').style.display = '';
      repaintAll();
    })
    .catch(function (e) { $('hi-plan').innerHTML = '<div class="alert alert-warn">Undo failed: ' + esc(e.message || e) + '</div>'; });
}

// ── after import: tidy events + confirm questions ──────────
var KINDS = [['score', 'Score (1–5)'], ['yesno', 'Yes / no'], ['choice', 'Multiple choice'], ['text', 'Comment / quote'], ['ignore', 'Not used in reports']];
var MAPS = [['', 'own measure'], ['cb', 'Confidence before'], ['ca', 'Confidence after'], ['enjoyed', 'Enjoyment'], ['connected', 'Felt connected'], ['learned', 'Learned / more skilled'], ['friend', 'Made a friend'], ['quote', 'Participant quote']];

function eventClusters() {
  var by = {};
  (DB.events || []).forEach(function (e) {
    var k = /^session on /i.test(e.name) ? '__nameless__:' + e.id : nameKey(e.name);
    var c = by[k] = by[k] || { key: k, names: {}, ids: [] };
    c.names[e.name] = (c.names[e.name] || 0) + 1;
    c.ids.push(e.id);
  });
  return Object.keys(by).map(function (k) { return by[k]; }).filter(function (c) {
    return Object.keys(c.names).length > 1 || /^__nameless__/.test(c.key);
  });
}

function renderAfter(A) {
  var el = $('hi-after');
  var clusters = eventClusters();
  var tidy = clusters.length
    ? '<div style="font-size:13px;font-weight:700;margin:14px 0 6px">1 · Tidy event names</div>' +
      '<div style="font-size:12px;color:var(--txt3);margin-bottom:8px">These look like the same workshop spelled differently. Pick the name to keep, or type a new one.</div>' +
      clusters.map(function (c, ci) {
        var names = Object.keys(c.names).sort(function (a, b) { return c.names[b] - c.names[a]; });
        var isNameless = /^__nameless__/.test(c.key);
        return '<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--border);font-size:12px">' +
          '<div style="flex:1;color:var(--txt2)">' + (isNameless ? 'No name given: ' : '') + names.map(esc).join(' · ') + '</div>' +
          '<input data-cl="' + ci + '" list="hi-names-' + ci + '" value="' + esc(isNameless ? '' : names[0]) + '" placeholder="Event name" style="width:200px"/>' +
          '<datalist id="hi-names-' + ci + '">' + names.map(function (nm) { return '<option value="' + esc(nm) + '">'; }).join('') + '</datalist>' +
          '<button class="btn btn-ghost btn-sm" data-merge="' + ci + '">' + (isNameless ? 'Rename' : 'Merge') + '</button></div>';
      }).join('')
    : '<div style="font-size:12px;color:var(--txt3);margin:14px 0 6px">✓ Event names look tidy — nothing to merge.</div>';

  var measures = '<div style="font-size:13px;font-weight:700;margin:16px 0 6px">2 · How your questions are used in reports</div>' +
    '<div style="font-size:12px;color:var(--txt3);margin-bottom:8px">We guessed from the answers. Change anything that looks wrong, then save — the next export of this form imports straight through.</div>' +
    A.measures.map(function (m, mi) {
      return '<div style="display:grid;grid-template-columns:1fr 150px 170px;gap:8px;align-items:center;padding:5px 0;border-top:1px solid var(--border);font-size:12px">' +
        '<div title="' + esc(m.question) + '">' + esc(m.question.length > 70 ? m.question.slice(0, 70) + '…' : m.question) + '</div>' +
        '<select data-mk="' + mi + '">' + KINDS.map(function (k) { return '<option value="' + k[0] + '"' + (m.kind === k[0] ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select>' +
        '<select data-mm="' + mi + '">' + MAPS.map(function (k) { return '<option value="' + k[0] + '"' + ((m.maps_to || '') === k[0] ? ' selected' : '') + '>' + k[1] + '</option>'; }).join('') + '</select></div>';
    }).join('') +
    '<div style="margin-top:10px;display:flex;gap:8px;align-items:center"><button class="btn btn-p btn-sm" id="hi-save-measures">Save measures</button><span id="hi-measures-msg" style="font-size:12px;color:var(--txt3)"></span></div>';

  el.innerHTML = tidy + measures;

  el.querySelectorAll('button[data-merge]').forEach(function (b) {
    b.addEventListener('click', function () {
      var ci = +b.getAttribute('data-merge');
      var c = clusters[ci];
      var name = (el.querySelector('input[data-cl="' + ci + '"]').value || '').trim();
      if (!name) return;
      b.disabled = true; b.textContent = '…';
      sb.from('events').update({ name: name }).eq('org_id', orgId).in('id', c.ids)
        .then(function (r) { if (r && r.error) throw r.error; return refreshTable('events'); })
        .then(function () { repaintAll(); renderAfter(A); })
        .catch(function (e) { b.disabled = false; b.textContent = 'Merge'; alert('Could not rename: ' + (e.message || e)); });
    });
  });

  $('hi-save-measures').addEventListener('click', function () {
    var rows = A.measures.map(function (m, mi) {
      var kind = el.querySelector('select[data-mk="' + mi + '"]').value;
      var maps = el.querySelector('select[data-mm="' + mi + '"]').value || null;
      return { org_id: orgId, question: m.question, kind: kind, maps_to: maps, label: m.question.slice(0, 60), active: kind !== 'ignore', sort: mi };
    });
    var msg = $('hi-measures-msg');
    msg.textContent = 'Saving…';
    sb.from('survey_measures').upsert(rows, { onConflict: 'org_id,question' })
      .then(function (r) {
        if (r && r.error) throw r.error;
        msg.textContent = '✓ Saved. Your Feedback page and reports now use these questions.';
        return (typeof refreshTable === 'function') ? refreshTable('survey_measures') : null;
      })
      .then(function () { repaintAll(); })
      .catch(function (e) { msg.textContent = 'Could not save: ' + (e.message || e) + (/survey_measures/i.test(e.message || '') ? ' — run sql/import-v3.sql first.' : ''); });
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

// exposed for tests / other extensions
window.HistoricImport = { VERSION: VERSION, parseCSV: parseCSV, analyseFeedback: analyseFeedback, analyseHours: analyseHours, nameKey: nameKey, parseDate: parseDate, detectDateOrders: detectDateOrders };

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
