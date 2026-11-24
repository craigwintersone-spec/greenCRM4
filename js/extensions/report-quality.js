// js/extensions/report-quality.js — v1.0
// ─────────────────────────────────────────────────────────────
// FUNDER REPORT QUALITY — what bids already get, for funder reports.
//
//  • Report strength: the funder's grants officer marks the report on a
//    fixed rubric (five parts, 20 each). The same text is never re-scored.
//  • Checks in code: numbers not in the records, wording a funder would
//    pick at, instructions to the writer showing in the text, a figure
//    said again and again, a pace verdict contradicted, a section over the
//    funder's word limit, a funder question not answered. One-tap fixes.
//  • Raise the score: the officer lists what costs marks, the weak
//    sections are rewritten from the records, and the round is kept only
//    if the score goes up (Undo puts it back).
//  • A real case study for the data pack: a participant's notes, or one
//    feedback response with its before/after — never made up.
//
// Each report calls vlReportQA.attach(ctx) after it draws itself:
//   ctx = { text, pack, funder, voice, lint:{attendees,fbCount,hasTargets},
//           limits:{heading:words}, required:[headings], locked:[headings],
//           render(text) }  — render redraws the report from new text.
// Nothing here is printed.
'use strict';

(function () {

var $ = function (id) { return document.getElementById(id); };
var esc = function (s) { return (typeof escapeHTML === 'function') ? escapeHTML(String(s == null ? '' : s)) : String(s == null ? '' : s); };

var RUBRIC = [
  ['asks', 'Answers what this funder asks for'],
  ['evidence', 'Evidence of the difference made'],
  ['voice', 'Participant voice and a real story'],
  ['honesty', 'Progress against outcomes and targets'],
  ['clarity', 'Clear, consistent, no repetition']
];
var RUBRIC_LONG = {
  asks: 'answers what this funder asks for and wants to see, in its language and order',
  evidence: 'shows the difference made with specific figures and change (targets, before and after, comparisons), not just activity',
  voice: 'participant voice: real quotes and a short real case study that show the difference',
  honesty: 'progress against the grant\'s outcomes and targets, stated plainly, with anything behind explained from delivery',
  clarity: 'clear, consistent and concise: no repetition, padding, jargon or instructions to the writer showing; within any word limits'
};

var CTX = null;
var ST = { score: null, scoring: false, raising: '', fixing: '', raised: null, note: '' };
var CACHE = {};

// ── text helpers ───────────────────────────────────────────
function sections(text) {
  var out = [], cur = { h: '', lines: [] };
  String(text || '').split('\n').forEach(function (l) {
    var m = l.match(/^#{1,6}\s+(.+?)\s*$/);
    if (m) { out.push(cur); cur = { h: m[1].trim(), lines: [] }; } else cur.lines.push(l);
  });
  out.push(cur);
  return out.map(function (s) { return { h: s.h, body: s.lines.join('\n').trim() }; }).filter(function (s) { return s.h || s.body; });
}
function joinSecs(secs) { return secs.map(function (s) { return (s.h ? '## ' + s.h + '\n' : '') + s.body; }).join('\n\n').trim(); }
function words(t) { return (String(t || '').match(/\S+/g) || []).length; }
function sigOf(t) { var h = 0, s = String(t || ''); for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; } return s.length + ':' + h; }
function sameH(a, b) { return String(a || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ') === String(b || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' '); }
function locked(h) { return (CTX.locked || []).some(function (x) { return sameH(x, h); }); }
function isSummary(h, i) { return i === 0 || /summary|at a glance/i.test(h || ''); }
function sentences(t) { return String(t || '').split(/(?<=[.!?])\s+|\n+/).filter(function (x) { return x.trim(); }); }
// numbers a reader would notice, without dates and years
function figuresAll(t) {
  return (String(t || '').replace(/\b\d{1,2}(st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b(\s+\d{4})?/gi, ' ').replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b\d+(\.\d+)?\s*(\/|out of)\s*5\b/gi, ' ').replace(/\b\d{1,2}[–-]\d{1,2}\b/g, ' ')
    .replace(/\([^)]*\)/g, ' ')   // breakdowns in brackets
    .match(/£?\d[\d,]*(\.\d+)?%?/g) || []).filter(function (m) { return /[£%.]/.test(m) || +m.replace(/,/g, '') >= 20; })   // small whole numbers are too often different things
    .map(function (m) { return m.replace(/[£,]/g, '').replace(/\.0+(%?)$/, '$1'); });
}
// a percentage is the same figure only when it measures the same thing ("83% felt more confident" and "83% learned something new" are two figures)
var PCT_STOP = /^(of|the|a|an|and|or|to|in|on|at|for|with|who|that|which|said|were|was|had|have|has|they|their|them|responses?|respondents?|people|participants?|beneficiaries|attendees|reported|reporting|say|says|saying|felt|feel|feeling|answered|stated|identified|as)$/i;
function pctKeys(t) {
  var out = [], re = /(\d+(?:\.\d+)?)%((?:\s+[A-Za-z0-9'’-]+){0,7})/g, m;
  while ((m = re.exec(String(t || '')))) {
    var w = (m[2].match(/[A-Za-z'’-]+/g) || []).filter(function (x) { return !PCT_STOP.test(x); }).slice(0, 2).map(function (x) { return x.toLowerCase().slice(0, 5); });
    if (+m[1] >= 2) out.push(m[1] + '%|' + w.join(' '));
  }
  return out;
}
function figuresIn(t) {
  var s = String(t || '')
    .replace(/\b\d{1,2}(st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|October|November|December)\b(\s+\d{4})?/gi, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, ' ').replace(/\b(19|20)\d{2}\b/g, ' ').replace(/\b\d+\s*\/\s*5\b/g, ' ').replace(/\bout of 5\b/gi, ' ');
  var out = {};
  (s.match(/£?\d[\d,]*(\.\d+)?%?/g) || []).forEach(function (m) {
    var k = m.replace(/[£,]/g, '').replace(/\.0+(%?)$/, '$1');
    if (k.replace('%', '').length >= 2) out[k] = 1;
  });
  return Object.keys(out);
}

// Instructions to the writer that leaked into the report
var LEAK = [
  [/\bto date:\s*\d|\bof the contract period elapsed:/i, 'copies a line from the data instead of writing a sentence'],
  [/\b(relate|relates|related)\s+only\s+to\b/i, 'explains how the figures were filtered'],
  [/\bnot the same measure\b|\bare not the same (thing|figure)\b/i, 'explains what a figure is not'],
  [/\b(is|are)\s+reported\s+(here\s+)?as\b/i, 'explains how a figure is classified'],
  [/\bnot\s+(counted\s+|reported\s+)?as\s+waste\s+diverted\b/i, 'explains a counting rule'],
  [/\bonly compost in\b|\bcompost in and (compost )?out\b/i, 'explains how compost is counted'],
  [/\b(the\s+)?(figures|data|numbers|information)\s+(supplied|provided|given)\b/i, 'refers to the data the writer was given'],
  [/\bas\s+(instructed|requested)\b|\bquoted verbatim\b|\bverbatim\b/i, 'repeats an instruction to the writer'],
  [/\bthis report (does not|cannot|will not) (include|state|give|report)\b/i, 'says what the report leaves out'],
  [/\breported (separately|as an input)\b|\bharvested food is food grown\b|\bkept (apart|separate) from\b/i, 'explains how a figure is classified']
];
// Sentences that only describe how the report was put together, with no figure or quote in them, are taken out before you see it
var FILLER = /\bbest shows the difference\b|\bevidence base\b|\bwhere the evidence is strongest\b|\bthe case study below\b|\breflects? the same themes\b|\b(figures|numbers) that matter( most)?\b|\bnot directly comparable\b|\breported separately\b/i;
function scrub(text) {
  var n = 0, auto = LEAK.slice(1).map(function (L) { return L[0]; }).concat([FILLER]);
  var out = String(text || '').split('\n').map(function (line) {
    if (/^\s*#/.test(line)) return line;
    var parts = line.split(/(?<=[.!?])\s+(?=[A-Z"\u201c(\u2018])/);
    var keep = parts.filter(function (p) {
      if (/["\u201c\u201d]/.test(p) || /\d/.test(p)) return true;     // a quote or a figure: flagged for you instead, never silently cut
      var hit = auto.some(function (rx) { return rx.test(p); }); if (hit) n++; return !hit;
    });
    return keep.join(' ');
  }).join('\n').replace(/\n{3,}/g, '\n\n');
  return { text: out, removed: n };
}

// ── checks in code ─────────────────────────────────────────
function problems(text) {
  var out = [], secs = sections(text);
  var secOf = function (needle) { var hit = secs.filter(function (s) { return s.body.indexOf(needle) !== -1 && !locked(s.h); }); return hit.map(function (s) { return s.h; }); };
  // 1. numbers not in the records
  var bad = window.unknownReportNumbers ? window.unknownReportNumbers(text, CTX.pack) : [];
  if (bad.length) {
    var hs = {}; secs.forEach(function (s) { if (locked(s.h)) return; var u = window.unknownReportNumbers(s.body, CTX.pack); if (u.length) hs[s.h] = 1; });
    out.push({ k: 'nums', secs: Object.keys(hs), t: bad.length + ' figure' + (bad.length === 1 ? ' isn\'t' : 's aren\'t') + ' in your records (' + bad.slice(0, 4).join(', ') + ').', label: 'Fix it', fix: 'These figures are not in the FIGURES: ' + bad.join(', ') + '. Remove them or replace them with figures that are; reword any sentence that needs a number you were not given.' });
  }
  // 2. wording a funder would pick at
  var lint = window.reportLintFindings ? window.reportLintFindings(text, CTX.lint || {}) : [];
  if (lint.length) {
    var ls = {}; lint.forEach(function (f) { secOf(f.m).forEach(function (h) { ls[h] = 1; }); });
    out.push({ k: 'lint', secs: Object.keys(ls), t: 'Wording a funder would pick at: ' + lint.slice(0, 3).map(function (f) { return '"' + f.m + '"'; }).join(', ') + '.', label: 'Fix it', fix: 'Rewrite these: ' + lint.map(function (f) { return '"' + f.m + '" (' + f.why + ')'; }).join('; ') + '.' });
  }
  // 3. instructions showing
  var leaks = [];
  secs.forEach(function (s) { if (locked(s.h)) return; sentences(s.body).forEach(function (x) { LEAK.forEach(function (L) { if (L[0].test(x)) leaks.push({ h: s.h, x: x.trim(), why: L[1] }); }); }); });
  if (leaks.length) {
    var lh = {}; leaks.forEach(function (l) { lh[l.h] = 1; });
    out.push({ k: 'leak', secs: Object.keys(lh), t: leaks.length + ' sentence' + (leaks.length === 1 ? '' : 's') + ' talk about how the report was put together, not what was delivered: "' + leaks[0].x.slice(0, 90) + (leaks[0].x.length > 90 ? '…' : '') + '"', label: 'Take ' + (leaks.length === 1 ? 'it' : 'them') + ' out', fix: 'Remove these sentences or rewrite them about what was delivered: ' + leaks.map(function (l) { return '"' + l.x + '" (' + l.why + ')'; }).join('; ') + '.' });
  }
  // 3b. guesses and sums the figures don't state
  var SPEC = [
    [/\baccounts for (the )?(whole|all|entire)\b|\bnothing (\w+ )?(went|goes) to waste\b/i, 'a conclusion from a sum the report did itself'],
    [/\b(harder|hard|difficult) to (engage|reach)\b|\b(less|more) (likely|able) to\b|\bthis suggests\b/i, 'a reason the figures don\'t show'],
    [/\b(reported|given|set out|mentioned|shown) (above|earlier|in the summary|previously)\b/i, 'refers back instead of saying it'],
    [FILLER, 'filler or an instruction showing']
  ], specs = [];
  secs.forEach(function (s) { if (locked(s.h)) return; sentences(s.body).forEach(function (x) { SPEC.forEach(function (L) { if (L[0].test(x)) specs.push({ h: s.h, x: x.trim(), why: L[1] }); }); }); });
  if (specs.length) {
    var sh = {}; specs.forEach(function (l) { sh[l.h] = 1; });
    out.push({ k: 'spec', secs: Object.keys(sh), t: specs.length + ' sentence' + (specs.length === 1 ? '' : 's') + ' a funder could question: "' + specs[0].x.slice(0, 90) + (specs[0].x.length > 90 ? '…' : '') + '" (' + specs[0].why + ')', label: 'Fix ' + (specs.length === 1 ? 'it' : 'them'), fix: 'Remove or rewrite these so they state only what the figures show: ' + specs.map(function (l) { return '"' + l.x + '" (' + l.why + ')'; }).join('; ') + '.' });
  }
  // 4. the same figure again and again
  // (twice in one section, or in two sections after the opening one; quotes don't count)
  var seen = {}, twice = {};
  secs.forEach(function (s, i) {
    if (locked(s.h)) return;
    var body = s.body.replace(/"[^"]*"|\u201c[^\u201d]*\u201d/g, ' ');
    var all = figuresAll(body).filter(function (f) { return !/%$/.test(f); }).concat(pctKeys(body)), n = {};
    all.forEach(function (f) { n[f] = (n[f] || 0) + 1; if (n[f] === 2) (twice[f] = twice[f] || []).push(s.h); });
    Object.keys(n).forEach(function (f) { if (!isSummary(s.h, i)) (seen[f] = seen[f] || []).push(s.h); });
  });
  var rep = Object.keys(seen).filter(function (f) { return seen[f].length >= 2; }).concat(Object.keys(twice)).filter(function (f, i, a) { return a.indexOf(f) === i; });
  var shown = function (f) { return f.split('|')[0]; };
  if (rep.length) {
    var rh = {};
    rep.forEach(function (f) { (seen[f] && seen[f].length >= 2 ? seen[f].slice(1) : []).concat(twice[f] || []).forEach(function (h) { rh[h] = 1; }); });
    out.push({ k: 'repeat', secs: Object.keys(rh), t: (rep.length === 1 ? shown(rep[0]) + ' is' : rep.slice(0, 3).map(shown).join(', ') + ' are') + ' given more than once.', label: 'Say ' + (rep.length === 1 ? 'it' : 'each') + ' once', fix: 'These figures are given more than once: ' + rep.map(shown).join(', ') + '. Give each once — in the opening section or the one section it belongs to — and elsewhere add detail or meaning instead. If the same number means two different things, keep both.' });
  }
  // 5. a pace verdict contradicted
  var V = { 'ahead of pace': /\bahead\b/i, 'on track': /\bon (track|target|profile|course)\b/i, 'behind pace': /\bbehind\b|\bbelow (target|profile)\b/i };
  [['Starts', /\bstarts?\b/i, /\boutcomes?\b/i], ['Outcomes', /\boutcomes?\b/i, /\bstarts?\b/i]].forEach(function (P) {
    var m = String(CTX.pack).match(new RegExp('^' + P[0] + ' to date:.*: (ahead of pace|on track|behind pace)\\s*$', 'm'));
    if (!m) return;
    var want = m[1], wrong = [];
    secs.forEach(function (s) { sentences(s.body).forEach(function (x) {
      if (!P[1].test(x) || P[2].test(x)) return;
      var says = Object.keys(V).filter(function (k) { return V[k].test(x); });
      if (says.length && says.indexOf(want) === -1) wrong.push({ h: s.h, x: x });
    }); });
    if (wrong.length) out.push({ k: 'pace' + P[0], secs: wrong.map(function (w) { return w.h; }).filter(function (h, i, a) { return a.indexOf(h) === i; }), t: P[0] + ' are ' + want + ' in your records, but the report says otherwise.', label: 'Fix it', fix: P[0] + ' to date are ' + want + ' (see the PROGRESS lines). Correct this sentence so it says ' + want + ': "' + wrong[0].x + '"' });
  });
  // 6. over the funder's word limit
  Object.keys(CTX.limits || {}).forEach(function (h) {
    var s = secs.filter(function (x) { return sameH(x.h, h); })[0], lim = CTX.limits[h];
    if (s && lim && words(s.body) > lim) out.push({ k: 'over:' + h, secs: [s.h], t: '"' + h.slice(0, 60) + '" is ' + words(s.body) + ' words — the funder allows ' + lim + '.', label: 'Shorten it', fix: 'Cut it to at most ' + Math.floor(lim * 0.95) + ' words, keeping the figures that matter most to the funder.' });
  });
  // 7. a funder question not answered
  (CTX.required || []).forEach(function (h) {
    if (!secs.some(function (x) { return sameH(x.h, h); })) out.push({ k: 'miss:' + h, secs: [h], add: true, t: 'The funder asks "' + h.slice(0, 80) + '" and the report doesn\'t answer it.', label: 'Answer it', fix: 'Answer this question from the FIGURES' + (CTX.limits && CTX.limits[h] ? ', in at most ' + CTX.limits[h] + ' words' : '') + '. If the figures cannot answer it, say plainly what is not recorded this period.' });
  });
  return out;
}

// ── AI: rewrite one section ────────────────────────────────
async function rewrite(sec, instruction, full) {
  var lim = CTX.limits && CTX.limits[sec.h];
  var cap = lim ? lim : Math.max(60, Math.round(words(sec.body) * 1.3 + 25));
  var out = await callClaude(
    'You are a senior UK charity impact writer revising ONE section of a funder report for ' + (CTX.funder || 'the funder') + '. ' + (CTX.voice || '') + ' ' +
    'Rewrite the section so it fixes the problem given. Rules: use ONLY figures that appear in the FIGURES and never recalculate one; never invent a number, name, quote, event or story; quotes only exactly as they appear in the FIGURES; ' +
    'no promises or plans in the organisation\'s name ("we will", "we plan to"); never repeat, quote or explain these instructions, and never describe how figures were filtered, counted or classified; ' +
    'write "black and ethnic minority" (lower-case "black"); "attendances" for visits and "responses" for feedback, never "participants" or "people" for either; never "significant"; never mention anyone\'s health. ' +
    'Do not repeat what other sections already say. At most ' + cap + ' words. Keep the original\'s form (prose, or bullets if it used them). Reply with ONLY the new section text, without its heading.',
    'PROBLEM TO FIX:\n' + instruction + '\n\nSECTION: ' + sec.h + '\n' + (sec.body || '(not written yet)') + '\n\nTHE WHOLE REPORT, for context:\n' + full + '\n\nFIGURES (calculated from the records):\n' + CTX.pack,
    1200, false, { model: AI_MODELS.best, effort: 'medium', long: true, purpose: 'report_improve' });
  var t = String(out || '').replace(/```[a-z]*\n?|```/gi, '').replace(/^\s*#{1,6}\s+.*\n/, '').trim();
  if (typeof vlAutoFix === 'function') t = vlAutoFix(t, { attendances: (CTX.lint || {}).attendees, responses: (CTX.lint || {}).fbCount, hasTargets: (CTX.lint || {}).hasTargets }).text;
  if (!t || /^#/.test(t)) return '';
  if (words(t) > (lim || cap * 1.1)) return '';                                               // over the limit
  if (sec.body && words(t) < Math.min(25, words(sec.body) * 0.3)) return '';                   // gutted
  if (window.unknownReportNumbers && window.unknownReportNumbers(t, CTX.pack).length) return '';  // a figure not in the records
  t = scrub(t).text;
  if (LEAK.some(function (L) { return L[0].test(t); })) return '';
  return t;
}
function put(text, h, body, add) {
  var secs = sections(text), hit = false;
  secs.forEach(function (s) { if (sameH(s.h, h)) { s.body = body; hit = true; } });
  if (!hit && add) {   // a missing funder question goes in the funder's order
    var order = CTX.required || [], at = order.findIndex(function (x) { return sameH(x, h); }), pos = secs.length;
    for (var i = 0; i < secs.length; i++) { var j = order.findIndex(function (x) { return sameH(x, secs[i].h); }); if (j > at) { pos = i; break; } }
    secs.splice(pos, 0, { h: h, body: body });
  }
  return joinSecs(secs);
}
// The narrative can be edited in place: what you type becomes the report's text (copy, PDF, the funder's form, checks)
function inline(n) {
  var c = n.cloneNode(true);
  c.querySelectorAll('strong,b').forEach(function (b) { b.replaceWith('**' + b.textContent + '**'); });
  c.querySelectorAll('br').forEach(function (b) { b.replaceWith('\n'); });
  return c.textContent.replace(/\u00a0/g, ' ').trim();
}
function domToText(root) {
  var out = [];
  root.childNodes.forEach(function (n) {
    if (n.nodeType === 3) { if (n.textContent.trim()) out.push(n.textContent.trim()); return; }
    if (n.nodeType !== 1) return;
    var t = n.tagName;
    if (n.classList && n.classList.contains('rq-case')) { var cp = n.querySelector('p'); if (cp && inline(cp)) out.push('Case study: ' + inline(cp)); }
    else if (/^H[1-6]$/.test(t)) { if (n.textContent.trim()) out.push('## ' + n.textContent.trim()); }
    else if (t === 'UL' || t === 'OL') out.push(Array.prototype.map.call(n.querySelectorAll('li'), function (li, i) { return (t === 'OL' ? (i + 1) + '. ' : '- ') + inline(li); }).join('\n'));
    else { var s = inline(n); if (s) out.push(s); }
  });
  return out.join('\n\n');
}
var _editT = null;
function editable() {
  var ed = document.querySelector('#report-output .rq-edit'); if (!ed || ed.getAttribute('contenteditable')) return;
  if (!$('rq-edit-css')) { var st = document.createElement('style'); st.id = 'rq-edit-css'; st.textContent = '.rq-edit[contenteditable]{outline:none;border-radius:6px;transition:box-shadow .15s}.rq-edit[contenteditable]:hover{box-shadow:0 0 0 2px #E5E7EB}.rq-edit[contenteditable]:focus{box-shadow:0 0 0 2px var(--em)}@media print{.rq-edit[contenteditable]{box-shadow:none!important}}'; document.head.appendChild(st); }
  ed.setAttribute('contenteditable', 'true'); ed.setAttribute('spellcheck', 'true');
  ed.addEventListener('input', function () {
    clearTimeout(_editT);
    _editT = setTimeout(function () {
      if (!CTX) return;
      CTX.text = domToText(ed);
      var clean = (typeof cleanReportText === 'function') ? cleanReportText(CTX.text) : CTX.text;
      window._lastReportText = clean; if (window._lastReport) window._lastReport.text = clean;
      ST.edited = true; paint();
    }, 500);
  });
}
function tag() { var d = document.querySelector('#report-output .report-doc'); if (d && CTX) d.setAttribute('data-rq', CTX.key); editable(); }
function redraw(text) {
  CTX.text = text;
  try { CTX.render(text); } catch (e) { console.warn('report redraw', e); }
  tag(); paint();
}

// ── score ──────────────────────────────────────────────────
async function score(force) {
  if (!CTX || ST.scoring) return null;
  var k = sigOf(CTX.text);
  if (!force && ST.score && ST.score.sig === k) { paint(); return ST.score.score; }
  if (CACHE[k]) { ST.score = CACHE[k]; paint(); return ST.score.score; }
  ST.scoring = true; paint();
  try {
    var raw = await callClaude('You are the grants officer at ' + (CTX.funder || 'the funder') + ' reading a grantee\'s monitoring report. Mark it on five parts, each out of 20, using the whole range consistently: 18–20 excellent, 14–17 good, 10–13 adequate, under 10 weak. ' +
      RUBRIC.map(function (r) { return r[0] + ' = ' + RUBRIC_LONG[r[0]]; }).join('; ') + '. ' +
      'Judge the outcomes for people — what changed for them — not admin. Never ask for, or reward, explanations of data collection, response rates, estimates or record-keeping, and never mark down for their absence; admin detail beyond one short line costs marks under clarity. ' +
      'Progress that is behind is not marked down if the report says so plainly and explains it from the figures; hiding or blurring it is. Do not mark down figures that are simply absent from the records. ' +
      'Reply with ONLY a JSON object: {"asks":0,"evidence":0,"voice":0,"honesty":0,"clarity":0,"summary":"its main strength, under 20 words","next":"the single change that would lift the score most, naming the section, under 30 words"}',
      'FUNDER: ' + (CTX.funder || 'the funder') + (CTX.asks ? '\nWHAT THEY ASK FOR:\n' + CTX.asks : '') + '\n\nFIGURES THE WRITER HAD:\n' + String(CTX.pack).slice(0, 7000) + '\n\nREPORT:\n' + CTX.text,
      700, false, { model: AI_MODELS.smart, long: true, purpose: 'report_score' });
    var m = String(raw || '').replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
    var j = m ? JSON.parse(m[0]) : null;
    if (j && RUBRIC.every(function (r) { return isFinite(+j[r[0]]); })) {
      var cut = function (t, n) { t = String(t || '').trim(); return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…'; };
      var parts = {}; RUBRIC.forEach(function (r) { parts[r[0]] = Math.max(0, Math.min(20, Math.round(+j[r[0]]))); });
      ST.score = { score: RUBRIC.reduce(function (a, r) { return a + parts[r[0]]; }, 0), parts: parts, summary: cut(j.summary, 200), next: cut(j.next, 260), sig: k };
      CACHE[k] = ST.score;
    }
  } catch (e) { if (e && e.message === 'AI_PLAN_GATE') { ST.scoring = false; paint(); throw e; } }
  ST.scoring = false; paint();
  return ST.score ? ST.score.score : null;
}

// ── one-tap fixes for the code checks ──────────────────────
async function fix(k, quiet) {
  if (!CTX || ST.fixing || ST.raising) return;
  var p = problems(CTX.text).filter(function (x) { return x.k === k; })[0]; if (!p) return;
  ST.fixing = k; ST.note = ''; paint();
  var before = CTX.text, text = CTX.text, done = 0;
  try {
    var targets = (p.secs.length ? p.secs : []).filter(function (h) { return !locked(h); }).slice(0, 4);
    var outs = await Promise.all(targets.map(function (h) {
      var s = sections(text).filter(function (x) { return sameH(x.h, h); })[0] || { h: h, body: '' };
      return rewrite(s, p.fix, text).catch(function (e) { if (e && e.message === 'AI_PLAN_GATE') throw e; return ''; });
    }));
    targets.forEach(function (h, i) { if (outs[i]) { text = put(text, h, outs[i], p.add); done++; } });
    // keep it only if this problem is now gone or smaller, and nothing new broke
    var still = problems(text), was = problems(before);
    var worse = still.some(function (x) { return !was.some(function (y) { return y.k === x.k; }); });
    var gone = !still.some(function (x) { return x.k === k; }) || still.filter(function (x) { return x.k === k; })[0].secs.length < p.secs.length;
    if (done && gone && !worse) { ST.raised = { from: ST.score ? ST.score.score : null, undo: (ST.raised && ST.raised.undo) || before, note: 'Fixed from your records.' }; redraw(text); if (!quiet) score().catch(function () {}); }
    else ST.note = 'Couldn\'t fix that from your records without breaking something else — the highlighted text is the place to look.';
  } catch (e) { if (!(e && e.message === 'AI_PLAN_GATE')) ST.note = 'Couldn\'t fix it: ' + (e.message || e); }
  ST.fixing = ''; paint();
}
async function fixAll() {
  var ps = problems(CTX.text);
  for (var i = 0; i < ps.length; i++) { await fix(ps[i].k, true); }
  score().catch(function () {});
}

// ── raise the score ────────────────────────────────────────
async function raise() {
  if (!CTX || ST.raising || ST.scoring || ST.fixing) return;
  var say = function (t) { ST.raising = t; paint(); };
  if (!ST.score || ST.score.sig !== sigOf(CTX.text)) { say('Scoring the current version first…'); ST.raising = ''; await score(); }
  var before = CTX.text, from = ST.score ? ST.score.score : null, best = from, tried = 0, changed = 0;
  try {
    for (var round = 1; round <= 2; round++) {
      var roundStart = CTX.text, roundChanged = changed;
      say(round === 1 ? 'Reading it like their grants officer and listing what costs marks…' : 'Checking again for anything still costing marks…');
      var heads = sections(CTX.text).map(function (s) { return s.h; }).filter(function (h) { return h && !locked(h); });
      var raw = await callClaude('You are the grants officer at ' + (CTX.funder || 'the funder') + '. List the specific problems in this monitoring report that cost marks, worst first: what this funder asks for that it misses or answers vaguely; activity described without the difference it made; figures given without meaning (compare with the target, the previous period or before and after, where the FIGURES allow); weak participant voice when quotes or a case study are in the FIGURES; progress that is blurred or not explained; repetition between sections; padding, jargon, admin or sentences about how the report was put together. Every fix must be about outcomes and delivery: never ask a section to explain data collection, response rates, estimates or record-keeping. ' +
        'For each, say exactly what the rewritten section must do, using only the FIGURES — never ask for information that is not there. Use the section headings exactly as written. Only these sections may change: ' + heads.join(' | ') + '. ' +
        'Reply with ONLY a JSON array, at most 6 items: [{"section":"","problem":"","fix":""}]. If nothing would raise the score, reply [].',
        'FUNDER: ' + (CTX.funder || 'the funder') + (CTX.asks ? '\nWHAT THEY ASK FOR:\n' + CTX.asks : '') + '\n\nFIGURES (calculated from the records):\n' + String(CTX.pack).slice(0, 8000) + '\n\nREPORT:\n' + CTX.text,
        1200, false, { model: AI_MODELS.best, effort: 'medium', long: true, purpose: 'report_raise_review' });
      var m = String(raw || '').replace(/```json|```/gi, '').match(/\[[\s\S]*\]/);
      var issues = m ? JSON.parse(m[0]) : [];
      var byS = {};
      (Array.isArray(issues) ? issues : []).forEach(function (x) {
        var h = heads.filter(function (y) { return sameH(y, x.section); })[0];
        if (h && x.fix) (byS[h] = byS[h] || []).push((x.problem ? x.problem + ' → ' : '') + x.fix);
      });
      var hs = Object.keys(byS).slice(0, 5);
      if (!hs.length) break;
      say('Rewriting ' + hs.length + ' section' + (hs.length === 1 ? '' : 's') + ' to fix what the grants officer found…');
      var cur = CTX.text;
      var outs = await Promise.all(hs.map(function (h) {
        var s = sections(cur).filter(function (x) { return sameH(x.h, h); })[0];
        return rewrite(s, byS[h].join('\n'), cur).catch(function (e) { if (e && e.message === 'AI_PLAN_GATE') throw e; return ''; });
      }));
      var next = cur;
      hs.forEach(function (h, i) { tried++; if (outs[i]) { next = put(next, h, outs[i]); changed++; } });
      if (changed === roundChanged) break;
      // never keep a round that adds a problem the checks can see
      var was = problems(cur).length, now0 = problems(next).length;
      if (now0 > was) { changed = roundChanged; break; }
      redraw(next);
      say('Scoring the new version…'); ST.raising = '';
      var now = await score(true);
      if (now == null || best == null || now <= best) {
        redraw(roundStart); if (CACHE[sigOf(roundStart)]) ST.score = CACHE[sigOf(roundStart)];
        changed = roundChanged;
        // all together didn't score higher: try the officer's worst one or two on their own
        var single = hs.filter(function (h, i) { return outs[i]; }).slice(0, hs.length > 1 ? 2 : 0), won = false;
        for (var si = 0; si < single.length && !won; si++) {
          var one = put(roundStart, single[si], outs[hs.indexOf(single[si])]);
          if (problems(one).length > problems(roundStart).length) continue;
          say('Trying the change to "' + single[si].slice(0, 40) + '" on its own…'); ST.raising = '';
          redraw(one);
          var n1 = await score(true);
          if (n1 != null && best != null && n1 > best) { best = n1; changed = roundChanged + 1; won = true; }
          else { redraw(roundStart); if (CACHE[sigOf(roundStart)]) ST.score = CACHE[sigOf(roundStart)]; }
        }
        break;
      }
      best = now;
      if (now >= 88 || now - (from || 0) < 2) break;
    }
  } catch (e) { if (!(e && e.message === 'AI_PLAN_GATE')) ST.note = 'Couldn\'t finish raising the score: ' + (e.message || e); }
  ST.raising = '';
  ST.raised = { from: from, undo: changed ? before : null,
    note: changed ? changed + ' section' + (changed === 1 ? '' : 's') + ' improved and kept because the score went up.'
      : tried ? 'Tried rewriting ' + tried + ' section' + (tried === 1 ? '' : 's') + ', but none scored higher, so your version is kept.' : 'The grants officer found nothing more to fix from your records.' };
  paint();
}
function undo() {
  var r = ST.raised; if (!r || !r.undo) return;
  ST.raised = null; redraw(r.undo);
  if (CACHE[sigOf(r.undo)]) ST.score = CACHE[sigOf(r.undo)];
  paint();
}

// ── panel (on screen only) ─────────────────────────────────
function paint() {
  var out = $('report-output'); if (!out || !CTX) return;
  var doc = out.querySelector('.report-doc');
  if (!doc || doc.getAttribute('data-rq') !== CTX.key) return;     // another report is on screen now
  var el = $('rq-panel');
  if (!el) {
    el = document.createElement('div'); el.id = 'rq-panel'; el.className = 'no-print';
    el.style.cssText = 'border:1px solid var(--border);background:#fff;border-radius:12px;padding:14px 16px;margin:0 0 14px';
    var acts = out.querySelector('.report-actions');
    if (acts && acts.nextSibling) out.insertBefore(el, acts.nextSibling); else out.insertBefore(el, out.firstChild);
  }
  if (typeof window.ztAddButton === 'function') { try { window.ztAddButton(); } catch (e) { /* optional */ } }
  var head = '<div class="bd-ph">Report strength <span>the funder\'s grants officer</span></div>';
  var sc = ST.score, k = sigOf(CTX.text);
  if (ST.raising) { el.innerHTML = head + (sc ? '<div class="bd-score">' + sc.score + '<small> / 100</small></div>' : '') + '<div style="font-size:13px;color:var(--txt2);margin-top:8px"><span class="bd-spin"></span> ' + esc(ST.raising) + '</div>'; return; }
  if (ST.scoring) { el.innerHTML = head + '<div style="font-size:13px;color:var(--txt3);margin-top:8px"><span class="bd-spin"></span> Reading it like their grants officer…</div>'; return; }
  var probs = problems(CTX.text);
  var stale = sc && sc.sig !== k;
  var r = ST.raised;
  el.innerHTML = head +
    (sc ? '<div class="bd-score">' + sc.score + '<small> / 100</small>' + (r && r.from != null && r.from !== sc.score ? ' <small style="font-size:13px;color:' + (sc.score > r.from ? '#166534' : 'var(--txt3)') + '">from ' + r.from + '</small>' : '') + '</div>' +
      (sc.summary ? '<div style="font-size:12.5px;color:var(--txt2);margin-top:4px;line-height:1.5">' + esc(sc.summary) + (sc.next ? ' <b style="font-weight:600">To lift it:</b> ' + esc(sc.next) : '') + '</div>' : '') +
      '<div style="display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:11.5px;color:var(--txt3);margin-top:8px;max-width:360px">' + RUBRIC.map(function (x) { return '<span>' + esc(x[1]) + '</span><span>' + sc.parts[x[0]] + '/20</span>'; }).join('') + '</div>'
      : '<div style="font-size:13px;color:var(--txt3);margin:6px 0 4px">See how their grants officer is likely to read it.</div>') +
    (r && r.note ? '<div style="font-size:12px;color:var(--txt2);margin-top:6px">' + esc(r.note) + '</div>' : '') +
    '<div style="font-size:12px;color:var(--txt3);margin-top:6px">' + (ST.edited ? '✓ Your edits are in the report, the copy and the PDF.' : 'Click any paragraph in the report to edit it.') + '</div>' +
    (ST.note ? '<div class="bd-mwarn soft">' + esc(ST.note) + '</div>' : '') +
    probs.map(function (p) { return '<div class="bd-mwarn">' + esc(p.t) + ' ' + (ST.fixing === p.k ? '<span class="bd-spin"></span>' : '<a href="#" onclick="vlReportQA.fix(\'' + esc(p.k).replace(/'/g, '&#39;') + '\');return false">' + esc(p.label) + '</a>') + '</div>'; }).join('') +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">' +
      (!sc ? '<button class="btn btn-ghost btn-sm" type="button" onclick="vlReportQA.score()">Check it</button>' : '') +
      (probs.length > 1 && !ST.fixing ? '<button class="btn btn-ghost btn-sm" type="button" onclick="vlReportQA.fixAll()">Fix all ' + probs.length + '</button>' : '') +
      (sc && !stale && !probs.length && sc.score < 90 ? '<button class="btn btn-p btn-sm" type="button" onclick="vlReportQA.raise()">Raise the score</button>' : '') +
      (stale ? '<button class="btn btn-ghost btn-sm" type="button" onclick="vlReportQA.score()">Report changed — check again</button>' : '') +
      (r && r.undo ? '<a href="#" onclick="vlReportQA.undo();return false" style="font-size:12.5px;color:var(--txt3);font-weight:600">Undo the changes</a>' : '') +
    '</div>';
}

// ── a real case study for the data pack ────────────────────
// participants: people on the contract; feedback: responses on its events. Returns '' when there is nothing real to use.
function caseStudy(participants, feedback) {
  var H = (typeof HEALTH_QUOTE_RX !== 'undefined') ? HEALTH_QUOTE_RX : /\b(health|ill|sick|hospital|doctor|mental|therapy)\b/i;
  // sensitive notes are left out one by one, so one note never costs the whole story
  var SENS = /\b(unwell|bereave\w*|grief|safeguard\w*|police|debt|evict\w*|temporary housing|homeless\w*|benefit sanction\w*|risk)\b/i;
  var noteText = function (n) { return String((n && (n.t || n.text)) || n || '').replace(/\s+/g, ' ').trim(); };
  var P = (participants || []).filter(function (p) { return (p.outcomes || []).length && Array.isArray(p.notes) && p.notes.length; })
    .map(function (p) { return { p: p, notes: p.notes.filter(function (n) { var t = noteText(n); return t && !H.test(t) && !SENS.test(t); }) }; })
    .filter(function (x) { return x.notes.length; })
    .sort(function (a, b) { return b.notes.length - a.notes.length || b.p.outcomes.length - a.p.outcomes.length; });
  if (P[0]) {
    var p = P[0].p, notes = P[0].notes.slice().sort(function (a, b) { return String(a.d || a.date || '').localeCompare(String(b.d || b.date || '')); }).slice(-8);
    var when = function (n) { var d = n.d || n.date; return d ? new Date(d).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + ': ' : ''; };
    var first = notes[0] && (notes[0].d || notes[0].date), months = first ? Math.max(1, Math.round((Date.now() - new Date(first)) / (30.4 * 864e5))) : 0;
    var how = /self/i.test(p.ref_source || '') ? 'came to us on their own' : 'was referred by ' + String(p.ref_source || 'a partner').toLowerCase();
    var bars = (p.barriers || []).filter(function (b) { return !H.test(b); });
    return 'CASE STUDY (one real participant, anonymised — call them "one participant", never by name or with any name from the notes, including staff; use only these facts, add nothing):\n' +
      '- Starting point: ' + how + (bars.length ? ', facing barriers around ' + bars.join(' and ').toLowerCase() : '') + '\n' +
      (months ? '- With us for about ' + months + ' month' + (months === 1 ? '' : 's') + '\n' : '') +
      '- What happened, in order:\n' + notes.map(function (n) { return '  ' + when(n) + noteText(n); }).join('\n') + '\n' +
      '- Outcomes recorded: ' + p.outcomes.join(', ').toLowerCase() + (p.stage ? ' (now at the "' + p.stage + '" stage)' : '');
  }
  var F = (feedback || []).filter(function (f) { var q = String(f.quote || '').trim(); return q.length > 40 && !H.test(q) && +f.cb > 0 && +f.ca > +f.cb; })
    .sort(function (a, b) { return (b.ca - b.cb) - (a.ca - a.cb) || String(b.quote).length - String(a.quote).length; });
  if (F[0]) {
    var f = F[0], ev = (DB.events || []).filter(function (e) { return String(e.id) === String(f.eventId || f.event_id || ''); })[0];
    return 'CASE STUDY (one real feedback response, anonymised — call them "one participant"; use only these facts, add nothing): came to ' + (ev && ev.name ? ev.name : 'a session') +
      '; rated their confidence ' + (+f.cb) + ' out of 5 before and ' + (+f.ca) + ' out of 5 after; said: "' + String(f.quote).trim() + '"';
  }
  return '';
}

// ── what worked, from the records, so a learning section has something real to say ─
function whatWorked(events, feedback) {
  var by = {}, name = function (e) { return String((e && e.name) || '').trim(); };
  (events || []).forEach(function (e) { var k = name(e); if (!k) return; var r = by[k] || (by[k] = { n: 0, att: 0, fb: [] }); r.n++; r.att += +e.attendees || 0; });
  var evName = {}; (events || []).forEach(function (e) { evName[String(e.id)] = name(e); });
  (feedback || []).forEach(function (f) { var k = evName[String(f.eventId || f.event_id || '')]; if (k && by[k]) by[k].fb.push(f); });
  var keys = Object.keys(by).filter(function (k) { return by[k].n >= 2; });
  if (keys.length < 2) return [];
  var r1 = function (v) { return Math.round(v * 10) / 10; }, out = [];
  var att = keys.slice().sort(function (a, b) { return by[b].att / by[b].n - by[a].att / by[a].n; })[0];
  out.push('Best attended: ' + att + ' — ' + r1(by[att].att / by[att].n) + ' attendances a session on average, over ' + by[att].n + ' sessions');
  var gain = keys.map(function (k) { var p = by[k].fb.filter(function (f) { return +f.cb > 0 && +f.ca > 0; }); if (p.length < 5) return null;
    var b = p.reduce(function (a, f) { return a + +f.cb; }, 0) / p.length, c = p.reduce(function (a, f) { return a + +f.ca; }, 0) / p.length; return { k: k, b: r1(b), a: r1(c), g: c - b, n: p.length }; })
    .filter(Boolean).sort(function (x, y) { return y.g - x.g; });
  if (gain.length >= 2) out.push('Biggest rise in confidence: ' + gain[0].k + ' — from ' + gain[0].b + ' to ' + gain[0].a + ' out of 5 (' + gain[0].n + ' responses)');
  var enj = keys.map(function (k) { var v = by[k].fb.map(function (f) { return +f.enjoyed; }).filter(function (x) { return x > 0; }); return v.length >= 5 ? { k: k, v: r1(v.reduce(function (a, x) { return a + x; }, 0) / v.length), n: v.length } : null; })
    .filter(Boolean).sort(function (x, y) { return y.v - x.v; });
  if (enj.length >= 2 && enj[0].k !== (gain[0] && gain[0].k)) out.push('Most enjoyed: ' + enj[0].k + ' — ' + enj[0].v + ' out of 5 (' + enj[0].n + ' responses)');
  return out;
}

// ── the funder's own reporting form, read once per contract ─
var TPL = {};
async function funderQuestions(contractId) {
  var k = String(contractId || ''); if (!k) return null;
  if (TPL[k] !== undefined) return TPL[k];
  TPL[k] = null;
  try {
    var r = await sb.from('contracts').select('report_template_name,report_template_data').eq('id', contractId).single();
    var d = r && r.data;
    if (!d || !d.report_template_data || !/\.docx$/i.test(d.report_template_name || '')) return null;
    var p = await _postJSON('/api/eoi-form', { action: 'parse', docxBase64: d.report_template_data });
    var items = (p && p.ok && p.items) || [];
    items = items.map(function (it) { return { q: String(it.question || '').replace(/\s+/g, ' ').trim().replace(/[:\s]+$/, ''), limit: +it.wordLimit || 0 }; })
      .filter(function (it) { return it.q.length > 8 && !/^(name|organisation|date|signed|signature|position|contact|email|telephone|phone|address|charity number|reference|grant ref|project name|period)\b/i.test(it.q); });
    if (items.length >= 2 && items.length <= 15) TPL[k] = { name: d.report_template_name, items: items };
  } catch (e) { /* no form, or it can't be read: the standard sections are used */ }
  return TPL[k];
}

// The case study paragraph gets its own box, on screen and in print
function caseBox(html) {
  return String(html || '').replace(/<p>\s*(?:<strong>)?Case study:?(?:<\/strong>)?:?\s*([\s\S]*?)<\/p>/i, function (m, body) {
    return '<div class="rq-case" style="border-left:4px solid #1F6F6D;background:#F3F8F7;-webkit-print-color-adjust:exact;print-color-adjust:exact;border-radius:0 8px 8px 0;padding:12px 16px;margin:12px 0;break-inside:avoid"><div style="font-size:11px;font-weight:700;letter-spacing:.5px;text-transform:uppercase;color:#1F6F6D;margin-bottom:4px">Case study</div><p style="margin:0">' + body + '</p></div>';
  });
}

window.vlReportQA = {
  attach: function (ctx) {
    var fresh = !CTX || CTX.key !== ctx.key;
    CTX = ctx;
    if (fresh) ST = { score: CACHE[sigOf(ctx.text)] || null, scoring: false, raising: '', fixing: '', raised: null, note: '' };
    tag(); paint();
    if (!ST.score && fresh) score().catch(function () { /* the report is fine without a score */ });
  },
  score: function () { return score(true); },
  fix: fix, fixAll: fixAll, raise: raise, undo: undo,
  problems: function (t) { return CTX ? problems(t == null ? CTX.text : t) : []; },
  sections: sections,
  caseStudy: caseStudy,
  caseBox: caseBox,
  scrub: scrub,
  whatWorked: whatWorked,
  funderQuestions: funderQuestions
};

})();
