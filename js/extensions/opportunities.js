// js/extensions/opportunities.js — improved BD Manager (live funding finder)
// Depends on: utils.js, db.js, agents.js
//
// Replaces the simple Markdown-based BD finder with a JSON-backed one
// that returns structured "tender cards", with proper buttons (View
// on funder site, Draft EOI for this opportunity).
//
// Includes a JSON repair routine in case Claude returns truncated output.
//
// NOTE: This file fixes the syntax error from the old civara-additions.js
// (the missing closing brace before `function draftEoiFor`).

(function () {
  'use strict';

  function whenReady(fn, attempts) {
    if (attempts == null) attempts = 0;
    if (attempts > 60) return;
    if ($('bd-opps-result') || $('page-bd')) return setTimeout(fn, 400);
    setTimeout(() => whenReady(fn, attempts + 1), 500);
  }
  whenReady(init);

  function init() {
    if (typeof window.runBDResearch !== 'function') return;
    if (window._civaraBDPatched) return;
    window._civaraBDPatched = true;
    window.runBDResearch = runBDResearchUpgraded;
  }

  // ── JSON parsing helpers ────────────────────────────────────
  function tryParseJSON(text) {
    if (!text) return null;
    let cleaned = text.replace(/```json|```/gi, '').trim();
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first < 0 || last < 0 || last <= first) return null;
    cleaned = cleaned.slice(first, last + 1);
    try {
      const parsed = JSON.parse(cleaned);
      return parsed.opportunities || [];
    } catch (e) {
      return null;
    }
  }

  // Repair JSON that was truncated mid-stream by finding the last
  // complete object inside the opportunities array.
  function tryRepairTruncatedJSON(text) {
    if (!text) return null;
    const start = text.indexOf('"opportunities"');
    if (start < 0) return null;
    const arrStart = text.indexOf('[', start);
    if (arrStart < 0) return null;
    let depth = 0, lastGoodEnd = -1;
    for (let i = arrStart; i < text.length; i++) {
      const c = text[i];
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) lastGoodEnd = i;
      }
    }
    if (lastGoodEnd < 0) return null;
    const head = text.slice(text.indexOf('{'), lastGoodEnd + 1);
    const repaired = head + ']}';
    try {
      const parsed = JSON.parse(repaired);
      return parsed.opportunities || null;
    } catch (e) {
      return null;
    }
  }
  // ↑ The old code was missing the closing `}` here. That single
  // missing character broke the entire civara-additions.js file at
  // parse time, which is why several features didn't work in your demo.

  // ── Main entry ──────────────────────────────────────────────
  async function runBDResearchUpgraded() {
    const wrap = $('bd-opps-wrap'), res = $('bd-opps-result');
    if (!wrap || !res) return;
    wrap.style.display = 'block';
    const area = $('bd-area').value, size = $('bd-size').value, specific = $('bd-specific').value;

    const steps = [
      { label: 'Searching live funding sources', meta: area + ' · ' + size },
      { label: 'Identifying opportunities', meta: 'gov.uk · Find a Tender · funder portals' },
      { label: 'Quality Supervisor check', meta: 'Verifying deadlines and links' },
      { label: 'Structuring opportunities', meta: '' },
      { label: 'Ready', meta: '' }
    ];

    const sys =
      'You are a UK funding researcher. Use web search, then return ONLY a JSON object.\n\n' +
      'FORBIDDEN: Do not say "Let me search...", "Based on my research...", "Here is my response...". Do not write any text before or after the JSON. Do not use markdown code fences. Do not number the opportunities outside the JSON.\n\n' +
      'Your ENTIRE response must start with { and end with }.\n\n' +
      'Find 3-5 currently open funding opportunities (keep to 5 max so the JSON fits). Always include a real https:// URL.\n\n' +
      'Keep summary, eligibility, fit_reason to ONE short sentence each (max 20 words).\n\n' +
      'Schema:\n{"opportunities":[{"funder":"string","programme":"string","summary":"one sentence","value_band":"e.g. £10k-£100k","deadline":"YYYY-MM-DD or Rolling","eligibility":"one sentence","fit_reason":"one sentence","url":"https://..."}]}\n\n' +
      'Return ONLY the JSON object.';

    const prompt = 'Area: ' + area + '\nOrg size: ' + size +
      '\nFunders or programmes of interest: ' + (specific || 'open to all suitable opportunities') +
      '\n\nReturn the JSON object now. Maximum 5 opportunities. Short sentences only.';

    if (typeof window.runAgent !== 'function') {
      res.innerHTML = '<div class="alert alert-warn">Research agent not available.</div>';
      return;
    }

    const raw = await window.runAgent({
      container: res,
      headerLabel: 'BD Manager Agent',
      headerSub: 'Live web search · Quality Supervisor verifying results',
      steps, sys, prompt, maxTok: 2500, webSearch: true
    });
    if (!raw) return;

    let opps = tryParseJSON(raw);

    // Fallback 1 — extract from a code-fenced block
    if (!opps) {
      const fence = raw.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
      if (fence) {
        try {
          const parsed = JSON.parse(fence[1]);
          opps = parsed.opportunities || null;
        } catch (e) { /* fallthrough */ }
      }
    }

    // Fallback 2 — repair truncated JSON
    if (!opps) {
      const repaired = tryRepairTruncatedJSON(raw);
      if (repaired) opps = repaired;
    }

    // Fallback 3 — ask Claude to convert prose → JSON
    if (!opps && typeof window.callClaude === 'function') {
      try {
        const fix = await window.callClaude(
          'You convert text into JSON. Return ONLY a JSON object with shape {"opportunities":[{funder, programme, summary, value_band, deadline, eligibility, fit_reason, url}]}. Maximum 5 opportunities. One sentence per text field. No prose, no fences.',
          'Convert this text into the JSON schema above. If a field is missing, use empty string. Keep it under 1500 characters. Source:\n\n' + raw.slice(0, 6000),
          2000
        );
        opps = tryParseJSON(fix);
      } catch (e) { /* swallow */ }
    }

    if (!opps) {
      res.innerHTML =
        '<div class="alert alert-warn"><strong>Could not parse opportunities.</strong> The agent returned text instead of JSON. ' +
        '<button class="btn btn-ghost btn-sm" style="margin-left:8px" id="civara-bd-retry">↻ Try again</button></div>' +
        '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--txt3)">Show raw response (for debugging)</summary>' +
        '<pre style="font-size:11px;background:var(--bg);padding:10px;border-radius:8px;margin-top:8px;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto">' +
        escapeHTML(raw) + '</pre></details>';
      const retry = $('civara-bd-retry');
      if (retry) retry.addEventListener('click', () => window.runBDResearch());
      return;
    }

    if (!opps.length) {
      res.innerHTML = '<div class="alert alert-info">No open opportunities matched. Try adjusting the area or naming a specific funder.</div>';
      return;
    }

    res.innerHTML = '';
    window._civaraOpps = opps;

    opps.forEach((o, i) => {
      const card = document.createElement('div');
      card.className = 'tender-card';
      const hasUrl = o.url && /^https?:\/\//.test(o.url);
      card.innerHTML =
        '<div class="tender-card-hd">' +
          '<div>' +
            '<div class="tender-card-funder">' + escapeHTML(o.funder || '') + '</div>' +
            '<div class="tender-card-title">' + escapeHTML(o.programme || 'Untitled programme') + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:13px;color:var(--txt2);margin-bottom:8px">' + escapeHTML(o.summary || '') + '</div>' +
        '<div class="tender-card-meta">' +
          (o.value_band ? '<span><strong>Value:</strong> ' + escapeHTML(o.value_band) + '</span>' : '') +
          (o.deadline ? '<span><strong>Deadline:</strong> ' + escapeHTML(o.deadline) + '</span>' : '') +
          (o.eligibility ? '<span><strong>Eligibility:</strong> ' + escapeHTML(o.eligibility) + '</span>' : '') +
        '</div>' +
        (o.fit_reason
          ? '<div style="font-size:12px;color:var(--em);background:rgba(31,111,109,.06);border-radius:6px;padding:8px 10px;margin-bottom:10px"><strong>Why it fits:</strong> ' + escapeHTML(o.fit_reason) + '</div>'
          : '') +
        '<div class="tender-card-actions" data-actions></div>';

      const actions = card.querySelector('[data-actions]');
      if (hasUrl) {
        const a = document.createElement('a');
        a.className = 'btn btn-p btn-sm';
        a.href = o.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        a.textContent = '⬇ View on funder site';
        actions.appendChild(a);
      } else {
        const span = document.createElement('span');
        span.style.cssText = 'font-size:12px;color:var(--txt3)';
        span.textContent = 'No funder link returned — search ' + (o.funder || 'this funder') + ' on gov.uk';
        actions.appendChild(span);
      }
      const draft = document.createElement('button');
      draft.className = 'btn btn-ghost btn-sm';
      draft.textContent = '✦ Draft EOI for this';
      draft.addEventListener('click', () => draftEoiFor(i));
      actions.appendChild(draft);
      res.appendChild(card);
    });
  }

  function draftEoiFor(idx) {
    const o = (window._civaraOpps || [])[idx]; if (!o) return;
    if (typeof window.go === 'function') window.go('bd');
    setTimeout(() => {
      const fEl = $('eoi-funder'), bEl = $('eoi-brief');
      if (fEl) fEl.value = (o.funder || '') + (o.programme ? ' — ' + o.programme : '');
      if (bEl) {
        bEl.value = [
          o.summary || '',
          '',
          'Value: ' + (o.value_band || 'TBC'),
          'Deadline: ' + (o.deadline || 'TBC'),
          'Eligibility: ' + (o.eligibility || 'TBC'),
          '',
          'Funder URL: ' + (o.url || '')
        ].join('\n');
      }
      if (bEl) bEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 300);
  }

})();
