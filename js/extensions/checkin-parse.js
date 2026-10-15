// js/extensions/checkin-parse.js — turns a pasted or uploaded check-in form into questions (no AI needed for the usual layout)
// A question is a title line, then its answers one per line. "*" at the end means required. "(Select all that apply)" means several answers.
// "IF YOU'RE 25 OR UNDER ..." only shows for the age bands up to 25. A "how many under 16s" question adds to the attendance.
(function () {
  'use strict';
  function clean(s) { return String(s == null ? '' : s).replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim(); }
  function stripBullet(s) { return clean(s).replace(/^([\u2022\u25CF\u25CB\u2610\u2751\u2713\u2714\-\u2013\u2014\*]|\d{1,2}[.)])\s+/, ''); }
  function isTitleLine(l, first) {
    return first || /\*\s*$/.test(l) || /\?\s*\*?\s*$/.test(l) || /select all that apply/i.test(l) || /^if you('?re| are| a)\b/i.test(l);
  }
  function maxAgeOf(opt) {          // "16- 25" -> 25, "65+" -> Infinity, "Prefer not to say" -> null
    var t = String(opt || ''); if (/prefer not/i.test(t)) return null;
    if (/\+/.test(t)) return Infinity;
    var n = t.match(/\d+/g); return n ? +n[n.length - 1] : null;
  }

  function parseCheckinText(raw) {
    var lines = String(raw || '').replace(/\r/g, '').split('\n').map(clean);
    var blocks = [], cur = [];
    lines.forEach(function (l) { if (!l) { if (cur.length) blocks.push(cur); cur = []; } else cur.push(l); });
    if (cur.length) blocks.push(cur);
    // A Word file often arrives with a blank line after every paragraph, so every answer looks like its own question.
    // When that happens, ignore the blank lines and let the question-looking lines decide where each question starts.
    var oneLiners = blocks.filter(function (b) { return b.length === 1; }).length;
    if (blocks.length >= 6 && oneLiners / blocks.length > 0.6) {
      var all = lines.filter(Boolean), regrouped = [], g = null;
      all.forEach(function (l, i) {
        var looksLikeQuestion = isTitleLine(l, i === 0) || (g && g.length >= 2 && /^[A-Z].{15,}$/.test(l) && !/^(yes|no)\b/i.test(l) && /[a-z]/.test(l) && l.split(' ').length >= 4 && !/^(prefer not|other|n\/a)/i.test(l) && (/\?|\*|:$/.test(l) || /\(e\.g\.?/i.test(l) || /^(what|how|which|do|did|does|are|is|have|has|where|when|would|enter|please|select|tick|your|first part|postcode)\b/i.test(l)));
        if (looksLikeQuestion || !g) { g = [l]; regrouped.push(g); } else g.push(l);
      });
      blocks = regrouped;
    }
    var qs = [];
    blocks.forEach(function (b) {
      var q = null;
      b.forEach(function (l, i) {
        if (isTitleLine(l, i === 0)) { q = { title: l, options: [] }; qs.push(q); }
        else if (q) q.options.push(stripBullet(l));
      });
    });

    var out = [], n = 0;
    qs.forEach(function (q) {
      var title = q.title, required = /\*\s*$/.test(title);
      title = title.replace(/\s*\*\s*$/, '');
      var multi = /select all that apply/i.test(title);
      title = title.replace(/\(?\s*select all that apply\s*\)?/i, '').replace(/\s+/g, ' ').trim();
      var hint = '', m = title.match(/\s*\(([^()]*)\)\s*$/);
      if (m && /^(e\.g|if |leave|please|optional)/i.test(m[1].trim())) { hint = m[1].trim(); title = title.slice(0, m.index).trim(); }
      var options = q.options.map(function (o) { return o.replace(/\s*\*\s*$/, ''); }).filter(Boolean), other = false;
      options = options.filter(function (o) { if (/^other\s*:?\s*$/i.test(o)) { other = true; return false; } return true; });
      var item = { id: 'q' + (++n), label: title, kind: 'text', required: required, options: options, hint: hint };
      if (other) item.other = true;
      if (/location/i.test(title) && /workshop|event|session|today/i.test(title)) { item.role = 'location'; item.kind = 'single'; item.required = false; }   // the event's own location is used
      else if (/under\s*16/i.test(title)) { item.role = 'extra_people'; item.kind = 'count'; item.options = ['N/A', '1', '2', '3', '4', '5', '6 or more']; delete item.other; }
      else if (/e-?mail/i.test(title) && !options.length) { item.kind = 'email'; item.role = 'email'; item.required = false; }
      else if (/postcode/i.test(title) && !options.length) item.kind = 'postcode';
      else if (options.length) item.kind = multi ? 'multi' : 'single';
      else if (/^how many/i.test(title)) item.kind = 'number';
      if (/book|today|this session|under\s*16|brought you|how many|location/i.test(title)) item.perVisit = true;
      out.push(item);
    });

    // "IF YOU'RE 25 OR UNDER ..." only for the age bands up to 25
    var age = out.filter(function (q) { return /\bage\b/i.test(q.label) && q.options.length; })[0];
    out.forEach(function (q) {
      var mm = /^if you('?re| are)?\s*(\d+)\s*or under/i.exec(q.label) || /(\d+)\s*or under/i.exec(q.label);
      if (/^if\b/i.test(q.label) && mm) {
        q.required = false;
        var limit = +(mm[2] || mm[1]);
        if (age && limit) q.showIf = { q: age.id, maxAge: limit };
        q.label = q.label.replace(/^IF YOU('?RE| ARE)?\s*\d+\s*OR UNDER\s*[-\u2013\u2014:]*\s*/i, '').replace(/^if you('?re| are)?\s*\d+\s*or under\s*[-\u2013\u2014:]*\s*/i, '');
        q.label = q.label.charAt(0).toUpperCase() + q.label.slice(1);
      }
    });
    return out;
  }
  window.vlParseCheckinText = parseCheckinText;
  window.vlCheckinMaxAge = maxAgeOf;
})();
