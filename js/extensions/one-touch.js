// js/extensions/one-touch.js — speak a case note, and tap any figure to see the records behind it (demo account only)
//   • Case notes: in the notes window, press "Speak the note" and talk. Vorlana writes it up as a professional note,
//     lists the actions, and points out anything that sounds like a safeguarding concern for a person to check.
//     Nothing is recorded or kept as audio; the worker reads the note and saves it.
//   • Proof: in funder reports, the annual report, comms and Ask Vorlana, tap a figure to see the line in your
//     records it came from. A figure that isn't in the records says so. The text itself is never changed.
// Depends on ai-office.js (window.vlAO), modals.js (openNotes, addNote), agents.js (callClaude).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var on = function () { return !!(window.vlAO && window.vlAO.on()); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  // ── Spoken case notes ─────────────────────────────────────────
  var rec = null, listening = false, base = '';
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  function addVoice(id) {
    var ta = $('new-note-txt'); if (!ta || $('ot-voice')) return;
    var bar = document.createElement('div'); bar.id = 'ot-voice'; bar.style.cssText = 'margin-top:8px';
    bar.innerHTML = '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      (SR ? '<button class="btn btn-ghost btn-sm" id="ot-mic" onclick="vlNoteMic()">🎙 Speak the note</button>' : '') +
      '<button class="btn btn-ai btn-sm" id="ot-write" onclick="vlNoteWrite()">✦ Write it up</button>' +
      '<span id="ot-status" style="font-size:12px;color:var(--txt3)">' + (SR ? 'Talk it through after the meeting, or type rough notes. Nothing is recorded.' : 'Type rough notes, or use your keyboard’s microphone. This browser can’t listen directly.') + '</span></div>' +
      '<div id="ot-flag"></div>';
    ta.parentNode.appendChild(bar);
  }
  window.vlNoteMic = function () {
    var ta = $('new-note-txt'), btn = $('ot-mic'), st = $('ot-status'); if (!SR || !ta) return;
    if (listening) { rec.stop(); return; }
    rec = new SR(); rec.lang = 'en-GB'; rec.continuous = true; rec.interimResults = true;
    base = ta.value ? ta.value.replace(/\s*$/, ' ') : '';
    rec.onresult = function (e) { var fin = '', mid = ''; for (var i = 0; i < e.results.length; i++) { if (e.results[i].isFinal) fin += e.results[i][0].transcript + ' '; else mid += e.results[i][0].transcript; } ta.value = base + fin + mid; };
    rec.onerror = function (e) { st.textContent = e.error === 'not-allowed' ? 'Allow the microphone for this site, then try again.' : 'Couldn’t hear that. Try again, or type the note.'; };
    rec.onend = function () { listening = false; btn.textContent = '🎙 Speak the note'; if (ta.value.trim() && !/Couldn|Allow/.test(st.textContent)) st.textContent = 'Got it. Press “Write it up”, or keep talking.'; };
    try { rec.start(); listening = true; btn.textContent = '■ Stop'; st.textContent = 'Listening… say who you saw, what happened and what’s next.'; } catch (e) { st.textContent = 'Couldn’t start the microphone.'; }
  };
  var rough = '';
  window.vlNoteWrite = async function () {
    var ta = $('new-note-txt'), st = $('ot-status'), btn = $('ot-write'); if (!ta) return;
    if (listening && rec) rec.stop();
    var txt = ta.value.trim(); if (!txt) { st.textContent = 'Say or type the note first.'; return; }
    rough = txt; btn.disabled = true; btn.textContent = 'Writing…';
    try {
      var raw = await callClaude(
        'You turn a UK support worker\'s spoken or rough notes into a professional case note. Reply in exactly this form:\n' +
        'NOTE: one clear paragraph in plain professional British English, past tense, third person for the person supported ("they"), using only what the worker said.\n' +
        'ACTIONS: each agreed next step on its own line starting "- ", with who and when if the worker said so; write "- None stated" if there are none.\n' +
        'CONCERN: one sentence if the worker described a possible safeguarding concern (risk of harm, abuse, self-neglect, homelessness, exploitation, suicidal thoughts); otherwise the single word None.\n' +
        'Never add facts, feelings, diagnoses, dates or names the worker did not give. Do not give advice. Fix dictation slips and filler words. No headings other than those three, no markdown.',
        'Worker\'s words:\n\n' + txt, 500, false, { purpose: 'case-note' });
      var note = (String(raw).match(/NOTE:\s*([\s\S]*?)(?=\n\s*ACTIONS:|$)/i) || [])[1], acts = (String(raw).match(/ACTIONS:\s*([\s\S]*?)(?=\n\s*CONCERN:|$)/i) || [])[1], con = (String(raw).match(/CONCERN:\s*([\s\S]*)$/i) || [])[1];
      note = (note || '').trim(); acts = (acts || '').split('\n').map(function (l) { return l.replace(/^[-•*\s]+/, '').trim(); }).filter(function (l) { return l && !/^none stated\.?$/i.test(l); }); con = (con || '').trim();
      if (!note) throw new Error('nothing came back');
      ta.value = note + (acts.length ? '\nActions: ' + acts.join('; ') : '');
      ta.style.minHeight = '140px';
      st.innerHTML = 'Written up. Read it, change anything, then Save note. <a href="#" onclick="vlNoteUndo();return false">Use my own words</a>';
      $('ot-flag').innerHTML = con && !/^none\.?$/i.test(con) ? '<div class="alert alert-warn" style="margin:8px 0 0"><strong>Possible safeguarding concern.</strong> ' + esc(con) + ' Check it, follow your safeguarding procedure, and update this person’s safeguarding flag if needed.</div>' : '';
    } catch (e) { if (e.message !== 'AI_PLAN_GATE') st.textContent = 'Couldn’t write it up (' + (e.message || 'error') + '). Your own words are still there.'; }
    btn.disabled = false; btn.textContent = '✦ Write it up';
  };
  window.vlNoteUndo = function () { var ta = $('new-note-txt'); if (ta) ta.value = rough; var f = $('ot-flag'); if (f) f.innerHTML = ''; $('ot-status').textContent = 'Back to your own words.'; };
  function wrapNotes() {
    var o = window.openNotes; if (typeof o !== 'function' || o._ot) return;
    window.openNotes = function (id) { var r = o.apply(this, arguments); if (on()) addVoice(id); return r; };
    window.openNotes._ot = true;
  }

  // ── Tap a figure to see where it comes from ───────────────────
  // where each kind of text gets its facts
  var AREAS = [
    ['report-output', function () { return window._lastReport && window._lastReport.prompt; }],
    ['ao-annual-out', function () { return window._aoFacts && window._aoFacts.annual; }],
    ['ao-comms-out', function () { return window._aoFacts && window._aoFacts.comms; }],
    ['ao-ask-log', function () { return window._aoFacts && window._aoFacts.ask; }]
  ];
  var norm = function (t) { return String(t).replace(/[£,\s]/g, '').replace(/\.0+$/, '').replace(/^(\d+\.\d*?)0+$/, '$1'); };
  function tokenAt(x, y) {
    var node, off;
    if (document.caretPositionFromPoint) { var p = document.caretPositionFromPoint(x, y); if (p) { node = p.offsetNode; off = p.offset; } }
    else if (document.caretRangeFromPoint) { var r = document.caretRangeFromPoint(x, y); if (r) { node = r.startContainer; off = r.startOffset; } }
    if (!node || node.nodeType !== 3) return null;
    var t = node.textContent, a = off, b = off, ok = /[£\d.,%]/;
    while (a > 0 && ok.test(t[a - 1])) a--;
    while (b < t.length && ok.test(t[b])) b++;
    var tok = t.slice(a, b).replace(/^[.,]+|[.,]+$/g, '');
    return /\d/.test(tok) ? tok : null;
  }
  function sources(tok, facts) {
    var v = norm(tok.replace(/%$/, '')), pct = /%$/.test(tok), money = /^£/.test(tok), out = [];
    String(facts || '').split('\n').forEach(function (line) {
      var m, re = /£?\d[\d,]*(?:\.\d+)?%?/g;
      while ((m = re.exec(line))) {
        if (norm(m[0].replace(/%$/, '')) !== v) continue;
        if (pct && !/%$/.test(m[0])) continue;
        if (money && !/^£/.test(m[0])) continue;
        var s = line.replace(/\s+/g, ' ').trim();
        if (s.length > 190) { var i = Math.max(0, m.index - 80); s = (i ? '…' : '') + line.slice(i, m.index + 110).trim() + '…'; }
        if (out.indexOf(s) === -1) out.push(s); break;
      }
    });
    return out;
  }
  function pop(x, y, html) {
    var p = $('ot-pop'); if (!p) { p = document.createElement('div'); p.id = 'ot-pop'; p.className = 'no-print'; document.body.appendChild(p); }
    p.style.cssText = 'position:fixed;z-index:1200;max-width:340px;background:#1d1d1f;color:#fff;border-radius:10px;padding:10px 12px;font-size:12px;line-height:1.5;box-shadow:0 8px 24px rgba(0,0,0,.25)';
    p.innerHTML = html;
    var w = Math.min(340, window.innerWidth - 24); p.style.left = Math.max(12, Math.min(x - w / 2, window.innerWidth - w - 12)) + 'px';
    p.style.top = (y + 16 + p.offsetHeight > window.innerHeight ? Math.max(8, y - p.offsetHeight - 12) : y + 16) + 'px';
  }
  function hide() { var p = $('ot-pop'); if (p) p.remove(); }
  function onClick(e) {
    hide(); if (!on()) return;
    var area = null;
    AREAS.some(function (a) { var el = $(a[0]); if (el && el.contains(e.target)) { area = a; return true; } return false; });
    if (!area || (e.target.closest && e.target.closest('button,select,input,a,.no-print,#rq-panel,table'))) return;
    var facts = area[1](); if (!facts) return;
    var tok = tokenAt(e.clientX, e.clientY); if (!tok) return;
    var plain = norm(tok.replace(/%$/, ''));
    if (!/[£%]/.test(tok) && (plain.length < 2 || /^(19|20)\d{2}$/.test(plain))) return;      // skip single digits and years
    var src = sources(tok, facts);
    pop(e.clientX, e.clientY, src.length
      ? '<div style="font-weight:700;margin-bottom:4px">' + esc(tok) + ' · from your records</div>' + src.slice(0, 3).map(function (s) { return '<div style="opacity:.9;margin-top:3px">' + esc(s) + '</div>'; }).join('') + (src.length > 3 ? '<div style="opacity:.6;margin-top:3px">and ' + (src.length - 3) + ' more places</div>' : '')
      : '<div style="font-weight:700;color:#FDB022;margin-bottom:4px">' + esc(tok) + ' · not found in your records</div><div style="opacity:.9">Check this figure before you send it.</div>');
  }
  function hint() {
    if (!on()) return;
    AREAS.slice(0, 2).forEach(function (a) {
      var el = $(a[0]); if (!el || !a[1]() || el.querySelector('.ot-hint') || !el.querySelector('.report-body')) return;
      var h = document.createElement('div'); h.className = 'ot-hint no-print'; h.style.cssText = 'font-size:12px;color:var(--txt3);margin:6px 0'; h.textContent = 'Tap any figure to see the records it comes from.';
      el.insertBefore(h, el.firstChild);
    });
  }

  function init() {
    wrapNotes();
    document.addEventListener('click', onClick, true);
    window.addEventListener('scroll', hide, true);
    setInterval(hint, 1500);
  }
  var tries = 0;
  (function wait() { if (typeof window.openNotes === 'function' && window.vlAO) return init(); if (++tries > 80) return; setTimeout(wait, 500); })();

  if (window.__VORLANA_TEST) window.__otTest = { sources: sources, norm: norm, addVoice: addVoice };
})();
