// js/agents.js — Claude API + all AI agents
// Depends on: config.js, utils.js, db.js
//
// Responsibilities:
//   • call /api/claude (the Vercel route that proxies to Anthropic)
//   • queue calls so we don't trip rate limits
//   • render the "Org Brain" progress UI
//   • clean / format AI output
//   • all specific agents: morning briefing, intake, case note,
//     RAG explainer, feedback analyst, outcomes analyst,
//     employer matcher, HR scans, equity, wellbeing, benchmarking,
//     report generator, social media, BD research, EOI generator
//
// All agents go through runAgent() which handles the progress UI,
// rate-limit retries, and plan gating.

'use strict';

// ── State ─────────────────────────────────────────────────────
const _aiQueue = { running: false, queue: [], lastCallAt: 0 };

let _aiNoteAccepted = '';
let _originalNote   = '';
let _hrFlags        = [];
let _lastEOIText    = '';
let _lastReportText = '';
let _lastReportTitle = '';

// ── Plan gate ─────────────────────────────────────────────────
function checkAIAccess() {
  const plan = (currentOrg && currentOrg.plan) || 'free';
  if (!AI_PLANS.includes(plan)) {
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;top:24px;right:24px;background:var(--surface);border:1px solid var(--amber);border-radius:var(--radiuslg);padding:16px 20px;z-index:999;max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.12)';
    msg.innerHTML =
      '<div style="font-size:13px;font-weight:700;color:var(--amber);margin-bottom:4px">✦ AI features — Pro plan only</div>' +
      '<div style="font-size:12px;color:var(--txt2)">Org Brain agents are available on the Pro and Network plans.</div>' +
      '<button onclick="this.parentElement.remove()" style="position:absolute;top:8px;right:10px;background:none;border:none;color:var(--txt3);cursor:pointer;font-size:16px">✕</button>';
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 5000);
    throw new Error('AI_PLAN_GATE');
  }
}

// ── Claude API call (with queue + retries) ───────────────────
async function callClaude(sys, user, maxTok, webSearch) {
  if (maxTok == null) maxTok = 600;
  if (webSearch == null) webSearch = false;
  checkAIAccess();
  if (sys && sys.length > 1500) sys = sys.slice(0, 1500);
  if (user && user.length > 4000) user = user.slice(0, 4000);
  if (maxTok > 1200) maxTok = 1200;

  return new Promise((resolve, reject) => {
    _aiQueue.queue.push({ sys, user, maxTok, webSearch, resolve, reject });
    _processAIQueue();
  });
}

async function _processAIQueue() {
  if (_aiQueue.running) return;
  _aiQueue.running = true;
  while (_aiQueue.queue.length) {
    const job = _aiQueue.queue.shift();
    const since = Date.now() - _aiQueue.lastCallAt;
    if (since < AI_MIN_GAP_MS) {
      await new Promise(r => setTimeout(r, AI_MIN_GAP_MS - since));
    }
    try {
      const text = await _callClaudeOnce(job.sys, job.user, job.maxTok, job.webSearch);
      _aiQueue.lastCallAt = Date.now();
      job.resolve(text);
    } catch (e) {
      _aiQueue.lastCallAt = Date.now();
      job.reject(e);
    }
  }
  _aiQueue.running = false;
}

async function _callClaudeOnce(sys, user, maxTok, webSearch, attempt) {
  if (attempt == null) attempt = 0;

  const { data: { session } } = await sb.auth.getSession();
  const token = session && session.access_token;

  const res = await fetch('/api/claude', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': token ? 'Bearer ' + token : ''
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: maxTok,
      system: sys,
      messages: [{ role: 'user', content: user }],
      web_search: webSearch
    })
  });

  // Rate limited — exponential backoff
  if (res.status === 429) {
    if (attempt >= 3) {
      const e = new Error('RATE_LIMITED');
      e.code = 'RATE_LIMITED';
      throw e;
    }
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
    const waitMs = retryAfter
      ? retryAfter * 1000
      : Math.min(30000, 4000 * Math.pow(2, attempt));
    await new Promise(r => setTimeout(r, waitMs));
    return _callClaudeOnce(sys, user, maxTok, webSearch, attempt + 1);
  }

  if (!res.ok) {
    let errMsg = 'API error ' + res.status;
    try {
      const errBody = await res.json();
      if (errBody && errBody.error && errBody.error.message) errMsg = errBody.error.message;
    } catch (e) { /* ignore */ }
    throw new Error(errMsg);
  }

  let data;
  try { data = await res.json(); }
  catch (e) { throw new Error('Bad response from API'); }

  if (data.type === 'error') {
    const msg = (data.error && data.error.message) || JSON.stringify(data.error);
    if (/rate.?limit/i.test(msg) || /tokens per minute/i.test(msg)) {
      const e = new Error('RATE_LIMITED');
      e.code = 'RATE_LIMITED';
      throw e;
    }
    throw new Error(msg);
  }

  const text = (data.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n');

  if (!text) throw new Error('Empty response');
  return text;
}

// ── Org Brain progress UI ────────────────────────────────────
function renderBrainProgress(steps, activeIdx, headerLabel, headerSub) {
  return '<div class="brain-panel">' +
    '<div class="brain-header">' +
      '<div class="brain-icon">🧠</div>' +
      '<div><div class="brain-title">' + escapeHTML(headerLabel || 'Org Brain — working') + '</div>' +
      '<div class="brain-sub">' + escapeHTML(headerSub || 'Reading live records and composing your output') + '</div></div>' +
    '</div>' +
    '<div class="brain-steps">' +
      steps.map((s, i) => {
        const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
        const icon = state === 'done'
          ? '<div class="bs-check">✓</div>'
          : state === 'active'
            ? '<div class="bs-spinner"></div>'
            : '<div class="bs-num">' + (i + 1) + '</div>';
        return '<div class="brain-step ' + state + '">' +
          '<div class="bs-icon-wrap">' + icon + '</div>' +
          '<div class="bs-text"><div class="bs-label">' + escapeHTML(s.label) + '</div>' +
          (s.meta ? '<div class="bs-meta">' + escapeHTML(s.meta) + '</div>' : '') +
          '</div></div>';
      }).join('') +
    '</div></div>';
}

async function tickBrain(container, steps, idx, headerLabel, headerSub) {
  if (!container) return;
  container.innerHTML = renderBrainProgress(steps, idx, headerLabel, headerSub);
  await new Promise(r => setTimeout(r, 420));
}

// ── AI output cleaning ───────────────────────────────────────
function cleanReportText(raw) {
  if (!raw) return '';
  let t = raw;
  t = t.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  t = t.replace(/^[\s]*[-=_*]{3,}[\s]*$/gm, '');
  t = t.replace(/^#{1,6}\s+/gm, '');
  t = t.replace(/(^|\s)#([A-Za-z])/g, '$1$2');
  t = t.replace(/\n{3,}/g, '\n\n');
  return t.trim();
}

function boldify(s) { return s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>'); }

function reportTextToHTML(cleaned, originalRaw) {
  const headings = new Set();
  (originalRaw || '').split('\n').forEach(line => {
    const m = line.match(/^#{1,6}\s+(.+)$/);
    if (m) headings.add(m[1].trim());
  });
  const blocks = cleaned.split(/\n\n+/);
  return blocks.map(block => {
    const trimmed = block.trim();
    if (!trimmed) return '';
    if (headings.has(trimmed)) return '<h3>' + escapeHTML(trimmed) + '</h3>';
    if (/^[\-\*•]\s/.test(trimmed)) {
      const items = trimmed.split('\n')
        .filter(l => /^[\-\*•]\s/.test(l.trim()))
        .map(l => '<li>' + boldify(escapeHTML(l.replace(/^[\-\*•]\s+/, '').trim())) + '</li>');
      return '<ul>' + items.join('') + '</ul>';
    }
    if (/^\d+\.\s/.test(trimmed)) {
      const items = trimmed.split('\n')
        .filter(l => /^\d+\.\s/.test(l.trim()))
        .map(l => '<li>' + boldify(escapeHTML(l.replace(/^\d+\.\s+/, '').trim())) + '</li>');
      return '<ol>' + items.join('') + '</ol>';
    }
    return '<p>' + boldify(escapeHTML(trimmed)).replace(/\n/g, '<br/>') + '</p>';
  }).join('\n');
}

function aiPanelHTML(raw) {
  return reportTextToHTML(cleanReportText(raw), raw);
}

function aiResult(el, text) {
  el.innerHTML = '<div class="ai-response">' + aiPanelHTML(text) + '</div>';
}

// ── Shared agent runner ──────────────────────────────────────
async function runAgent(opts) {
  const { container, headerLabel, headerSub, steps, sys, prompt } = opts;
  const maxTok = opts.maxTok != null ? opts.maxTok : 600;
  const webSearch = !!opts.webSearch;

  if (!container) return null;

  for (let i = 0; i < steps.length - 1; i++) {
    await tickBrain(container, steps, i, headerLabel, headerSub);
  }

  let raw;
  try {
    raw = await callClaude(sys, prompt, maxTok, webSearch);
  } catch (e) {
    if (e.message === 'AI_PLAN_GATE') { container.innerHTML = ''; return null; }
    if (e.code === 'RATE_LIMITED' || /rate.?limit/i.test(e.message || '') || /tokens per minute/i.test(e.message || '')) {
      container.innerHTML =
        '<div class="brain-panel" style="border-color:rgba(245,158,11,.4)">' +
          '<div class="brain-header">' +
            '<div class="brain-icon" style="background:rgba(245,158,11,.18);animation:none">⏳</div>' +
            '<div>' +
              '<div class="brain-title" style="color:var(--amber)">Org Brain is busy</div>' +
              '<div class="brain-sub">The AI service is rate-limited. Wait about 60 seconds, then click the agent button again.</div>' +
            '</div>' +
          '</div>' +
          '<div style="font-size:12px;color:var(--txt3);background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px">Each Claude account has a per-minute token cap. Running several agents close together can hit it. Try one at a time.</div>' +
        '</div>';
      return null;
    }
    container.innerHTML = '<div class="alert alert-warn" style="margin:0"><strong>Agent could not finish.</strong> ' + escapeHTML(e.message || 'Unknown error') + '</div>';
    return null;
  }

  await tickBrain(container, steps, steps.length - 1, headerLabel, headerSub);
  await new Promise(r => setTimeout(r, 500));
  await tickBrain(container, steps, steps.length, headerLabel, headerSub);
  return raw;
}

// ── Specific agents ──────────────────────────────────────────

async function runMorningBriefing() {
  const el = $('mb-body'); if (!el) return;
  const P = DB.participants, E = DB.events, C = DB.contracts;
  const atRisk = P.filter(p => p.risk === 'High' || days(p.last_contact) > 21);
  const steps = [
    { label: 'Reading caseload', meta: P.length + ' participants · ' + E.length + ' events' },
    { label: "Spotting today's priorities", meta: atRisk.length + ' at-risk to chase' },
    { label: 'Composing your briefing', meta: 'Org Brain writing in your voice' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'Generate a warm professional morning briefing for a UK charity manager. Use **bold** for emphasis. Three short sections: Priority actions, Wins to celebrate, One strategic observation. Max 200 words. Do not use ## headings or hashtags.';
  const prompt = 'Today: ' + new Date().toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long' }) +
    '\nActive participants: ' + P.filter(p => p.stage !== 'Closed').length +
    '\nAt-risk: ' + (atRisk.map(p => p.first_name + ' ' + p.last_name).join(', ') || 'none') +
    '\nJob ready: ' + (P.filter(p => p.stage === 'Job Ready').map(p => p.first_name + ' ' + p.last_name).join(', ') || 'none') +
    '\nContracts: ' + (C.map(c => c.name).join(', ') || 'none');
  const raw = await runAgent({
    container: el,
    headerLabel: 'Org Brain — Morning Briefing',
    headerSub: "Reading your caseload to surface today's priorities",
    steps, sys, prompt, maxTok: 300
  });
  if (raw) aiResult(el, raw);
}

async function runIntakeAI() {
  const text = $('mp-intake-text').value.trim();
  if (!text) { alert('Please paste some referral background text first.'); return; }
  const el = $('mp-ai-intake-result');
  const steps = [
    { label: 'Reading referral background', meta: text.length + ' characters' },
    { label: 'Identifying barriers and risks', meta: 'Cross-checking against safeguarding indicators' },
    { label: 'Suggesting an advisor', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK social work assistant. Return ONLY a valid JSON object with: risk (Low/Medium/High), barriers (array from: Housing, Confidence, Skills gap, Transport, Childcare, Mental health, Substance misuse, Criminal record, Language, Benefits, Disability, Financial), safeguarding (none/Domestic abuse/Mental health/Substance misuse/Homelessness risk), suggested_advisor (Sarah T./Marcus O./Priya S./Unassigned), next_steps (string). No explanation, no markdown, no hashtags.';
  const raw = await runAgent({
    container: el,
    headerLabel: 'Intake Agent',
    headerSub: 'Analysing the referral to pre-fill the form',
    steps, sys, prompt: text, maxTok: 400
  });
  if (!raw) return;
  try {
    const clean = raw.replace(/```json|```/gi, '').trim();
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('No JSON found');
    const data = JSON.parse(m[0]);
    if (data.risk && ['Low', 'Medium', 'High'].includes(data.risk)) $('mp-risk').value = data.risk;
    if (data.safeguarding && ['Domestic abuse', 'Mental health', 'Substance misuse', 'Homelessness risk'].includes(data.safeguarding)) $('mp-safe').value = data.safeguarding;
    if (data.suggested_advisor && ['Sarah T.', 'Marcus O.', 'Priya S.', 'Unassigned'].includes(data.suggested_advisor)) $('mp-adv').value = data.suggested_advisor;
    if (Array.isArray(data.barriers)) {
      document.querySelectorAll('#barrier-checks input[type=checkbox]').forEach(cb => {
        cb.checked = data.barriers.includes(cb.value);
      });
    }
    el.innerHTML =
      '<div class="ai-panel" style="margin:10px 0"><div class="ai-panel-title"><span class="ai-icon">✦</span>Intake Agent — fields pre-filled above</div>' +
      '<div class="ai-response">' +
      '<p><strong>Risk:</strong> ' + escapeHTML(data.risk || '—') + '</p>' +
      '<p><strong>Safeguarding:</strong> ' + escapeHTML(data.safeguarding || 'none') + '</p>' +
      '<p><strong>Suggested advisor:</strong> ' + escapeHTML(data.suggested_advisor || '—') + '</p>' +
      '<p><strong>Barriers:</strong> ' + escapeHTML(Array.isArray(data.barriers) && data.barriers.length ? data.barriers.join(', ') : 'none') + '</p>' +
      '<p><strong>Next steps:</strong> ' + escapeHTML(data.next_steps || '—') + '</p>' +
      '</div></div>';
  } catch (e) {
    el.innerHTML = '<div class="alert alert-warn">Intake Agent could not auto-fill. Please complete the form manually.</div>';
  }
}

async function runCaseNoteAI() {
  const note = $('mp-note').value.trim();
  if (!note) { alert('Please type some case notes first.'); return; }
  $('note-ai-btn').textContent = 'Working…';
  $('note-ai-btn').disabled = true;
  _originalNote = note;
  try {
    const r = await callClaude(
      'You are a professional UK case note writer. Convert rough notes into a structured professional case note. Plain text only. No hashtags, no markdown headings, no bullets unless needed.',
      'Rough notes:\n\n' + note,
      400
    );
    const clean = cleanReportText(r);
    _aiNoteAccepted = clean;
    $('mp-note-preview-text').textContent = clean;
    $('mp-note-preview').style.display = 'block';
  } catch (e) {
    if (e.message !== 'AI_PLAN_GATE') alert('Agent unavailable: ' + e.message);
  }
  $('note-ai-btn').textContent = '✦ Case Note Agent — structure note';
  $('note-ai-btn').disabled = false;
}
function acceptAINote() { $('mp-note').value = _aiNoteAccepted; $('mp-note-preview').style.display = 'none'; }
function rejectAINote() { $('mp-note').value = _originalNote;  $('mp-note-preview').style.display = 'none'; }

async function runRAGExplainer(cid, name, funder, sp, op, linked) {
  const m = document.createElement('div');
  m.className = 'modal-overlay open';
  m.innerHTML = '<div class="modal" style="max-width:600px"><h2>🚦 RAG Explainer — ' + escapeHTML(name) + '</h2>' +
    '<div id="rag-ai-body"></div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="this.closest(\'.modal-overlay\').remove()">Close</button></div></div>';
  document.body.appendChild(m);
  const body = m.querySelector('#rag-ai-body');
  const steps = [
    { label: 'Reading contract performance', meta: linked + ' linked participants' },
    { label: 'Diagnosing root causes', meta: 'Starts: ' + sp + '% · Outcomes: ' + op + '%' },
    { label: 'Drafting actions', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK funding analyst. Provide three sections: 1) Plain-English RAG explanation, 2) Likely root causes, 3) Recommended actions. Use **bold** for emphasis. No hashtags, no markdown headings.';
  const prompt = 'Contract: ' + name + '\nFunder: ' + funder + '\nStarts: ' + sp + '%\nOutcomes: ' + op + '%\nLinked participants: ' + linked;
  const raw = await runAgent({
    container: body,
    headerLabel: 'RAG Explainer Agent',
    headerSub: 'Diagnosing contract performance',
    steps, sys, prompt, maxTok: 500
  });
  if (raw) aiResult(body, raw);
}

async function runFeedbackAnalyst() {
  const el = $('feedback-analyst-result'); if (!el) return;
  const FB = DB.feedback;
  if (!FB.length) { el.innerHTML = '<div class="alert alert-info">No feedback data yet. Add responses first.</div>'; return; }
  const avgCB = (FB.reduce((a, f) => a + num(f.cb), 0) / FB.length).toFixed(1);
  const avgCA = (FB.reduce((a, f) => a + num(f.ca), 0) / FB.length).toFixed(1);
  const enjoyed = pct(FB.filter(f => f.enjoyed >= 4).length, FB.length);
  const steps = [
    { label: 'Reading feedback responses', meta: FB.length + ' responses' },
    { label: 'Identifying themes', meta: 'Confidence: ' + avgCB + ' → ' + avgCA },
    { label: 'Writing board summary', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK programme evaluation expert. Write a 100-150 word board-ready summary. Use **bold** for emphasis. End with one clear recommendation. No hashtags, no markdown headings.';
  const prompt = 'Responses: ' + FB.length + '\nConf before: ' + avgCB + ' / 5\nConf after: ' + avgCA + ' / 5\nEnjoyed (4-5 stars): ' + enjoyed + '%';
  const raw = await runAgent({
    container: el,
    headerLabel: 'Feedback Analyst Agent',
    headerSub: 'Surfacing themes from participant feedback',
    steps, sys, prompt, maxTok: 400
  });
  if (raw) aiResult(el, raw);
}

async function runOutcomesAnalyst() {
  const el = $('outcomes-analyst-result'); if (!el) return;
  const P = DB.participants;
  if (!P.length) { el.innerHTML = '<div class="alert alert-info">No participant data yet.</div>'; return; }
  const rate = pct(P.filter(p => p.outcomes.length > 0).length, P.length);
  const high = P.filter(p => p.risk === 'High').length;
  const steps = [
    { label: 'Reading caseload', meta: P.length + ' participants' },
    { label: 'Clustering barriers and outcomes', meta: 'Outcome rate: ' + rate + '%' },
    { label: 'Spotting patterns', meta: high + ' high-risk cases' },
    { label: 'Writing insights', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK charity data analyst. Provide 3-4 actionable insights. Use **bold** for key findings. No hashtags, no markdown headings.';
  const prompt = 'Participants: ' + P.length + '\nOutcome rate: ' + rate + '%\nHigh risk: ' + high;
  const raw = await runAgent({
    container: el,
    headerLabel: 'Outcomes Analyst Agent',
    headerSub: 'Looking for patterns in your caseload',
    steps, sys, prompt, maxTok: 600
  });
  if (raw) aiResult(el, raw);
}

async function runEmployerMatcher() {
  const el = $('employer-matcher-result'); if (!el) return;
  const jr = DB.participants.filter(p => p.stage === 'Job Ready' || p.stage === 'Outcome Achieved');
  const emp = DB.employers.filter(e => e.vacancies > 0);
  if (!jr.length || !emp.length) {
    el.innerHTML = '<div class="alert alert-info">Need job-ready participants and employers with open vacancies first.</div>';
    return;
  }
  const steps = [
    { label: 'Reading job-ready participants', meta: jr.length + ' candidates' },
    { label: 'Reading employer vacancies', meta: emp.length + ' employers · ' + emp.reduce((a, e) => a + num(e.vacancies), 0) + ' vacancies' },
    { label: 'Matching candidates to roles', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK employability advisor. Suggest matches between candidates and vacancies. Use **bold** for names. Be specific about why each match fits. No hashtags, no markdown headings.';
  const prompt =
    'Candidates:\n' + jr.map(p => '- ' + p.first_name + ' ' + p.last_name + ': barriers ' + (p.barriers.join(', ') || 'none')).join('\n') +
    '\n\nEmployers:\n' + emp.map(e => '- ' + e.name + ' (' + e.sector + '): ' + e.vacancies + ' vacancies').join('\n');
  const raw = await runAgent({
    container: el,
    headerLabel: 'Employer Matcher Agent',
    headerSub: 'Finding candidates for live vacancies',
    steps, sys, prompt, maxTok: 600
  });
  if (raw) aiResult(el, raw);
}

// ── HR / Equality agents ─────────────────────────────────────
function renderHRFlags() {
  const el = $('hr-flags-list'); if (!el) return;
  if (!_hrFlags.length) {
    el.innerHTML = '<div style="color:var(--txt3);font-size:13px;padding:10px 0">No flags in the review queue.</div>';
    return;
  }
  el.innerHTML = _hrFlags.map((f, i) =>
    '<div style="background:var(--bg);border:1px solid var(--border);border-left:3px solid var(--amber);border-radius:8px;padding:12px 14px;margin-bottom:8px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
        '<div style="flex:1">' +
          '<div style="font-size:12px;font-weight:600;color:var(--txt);margin-bottom:4px">' +
            escapeHTML(f.who || 'Unknown') + ' · <span style="color:var(--txt3);font-weight:400">' + escapeHTML(f.context || 'Case note') + '</span>' +
          '</div>' +
          '<div style="font-size:13px;color:var(--txt2);font-style:italic;margin-bottom:6px">"' + escapeHTML(f.snippet || '') + '"</div>' +
          '<div style="font-size:12px;color:var(--purple)">✦ ' + escapeHTML(f.suggestion || 'Consider person-first language') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:4px">' +
          '<button class="btn btn-ghost btn-sm" onclick="dismissHRFlag(' + i + ')">Dismiss</button>' +
          '<button class="btn btn-p btn-sm" onclick="resolveHRFlag(' + i + ')">✓ Resolved</button>' +
        '</div>' +
      '</div>' +
    '</div>'
  ).join('');
}
function dismissHRFlag(i) { _hrFlags.splice(i, 1); renderHRFlags(); }
function resolveHRFlag(i) { _hrFlags.splice(i, 1); renderHRFlags(); }

async function runFullLanguageScan() {
  const el = $('language-scan-result'); if (!el) return;
  const samples = [];
  DB.participants.forEach(p => {
    toArr(p.notes).forEach(nt => {
      if (nt.t) samples.push({ who: p.first_name + ' ' + p.last_name, text: nt.t, context: 'Case note (' + (nt.d || '') + ')' });
    });
  });
  if (!samples.length) { el.innerHTML = '<div class="alert alert-info">No case notes to scan yet.</div>'; return; }
  const steps = [
    { label: 'Reading case notes', meta: samples.length + ' notes across ' + DB.participants.length + ' participants' },
    { label: 'Checking for non-inclusive language', meta: 'All 9 protected characteristics' },
    { label: 'Building flag queue', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a positive language coach. Return ONLY a JSON array of flagged items, max 5. Each: {"who":"name","context":"case note","snippet":"phrase","suggestion":"reframe"}. If nothing concerning, return [].';
  const prompt = samples.slice(0, 15).map(s => '[' + s.who + '] ' + s.text).join('\n\n');
  const raw = await runAgent({
    container: el,
    headerLabel: 'Language Coach Agent',
    headerSub: 'Scanning your case notes for inclusive language',
    steps, sys, prompt, maxTok: 600
  });
  if (!raw) return;
  try {
    const m = raw.match(/\[[\s\S]*\]/);
    const flags = m ? JSON.parse(m[0]) : [];
    _hrFlags = flags; renderHRFlags();
    el.innerHTML = '<div class="ai-response"><p>Scan complete. <strong>' + flags.length + '</strong> item' +
      (flags.length === 1 ? '' : 's') + ' added to the review queue.' +
      (flags.length === 0 ? ' Nothing concerning detected.' : '') + '</p></div>';
  } catch (e) {
    el.innerHTML = '<div class="alert alert-warn">Could not parse scan results.</div>';
  }
}

async function runEquityAnalysis() {
  const el = $('equity-result'); if (!el) return;
  const P = DB.participants;
  if (!P.length) { el.innerHTML = '<div class="alert alert-info">No participant data yet.</div>'; return; }
  const rate = pct(P.filter(p => p.outcomes.length > 0).length, P.length);
  const steps = [
    { label: 'Reading caseload', meta: P.length + ' participants' },
    { label: 'Cross-checking equality data', meta: '9 protected characteristics' },
    { label: 'Calculating outcome gaps', meta: 'Overall rate: ' + rate + '%' },
    { label: 'Writing summary', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK equality analyst. Concise summary, **bold** key findings. Flag any gap over 15%. End with one recommendation. 200 words max. No hashtags, no markdown headings.';
  const prompt = 'Total: ' + P.length +
    '\nOutcome rate: ' + rate + '%' +
    '\nSafeguarding flags: ' + P.filter(p => p.safeguarding).length +
    '\nHigh risk: ' + P.filter(p => p.risk === 'High').length;
  const raw = await runAgent({
    container: el,
    headerLabel: 'Equity Analyst Agent',
    headerSub: 'Looking for outcome gaps across protected characteristics',
    steps, sys, prompt, maxTok: 400
  });
  if (raw) {
    el.innerHTML = '<div class="ai-panel"><div class="ai-panel-title"><span class="ai-icon">📊</span>Equity analysis</div>' +
      '<div class="ai-response">' + aiPanelHTML(raw) + '</div></div>';
  }
}

async function runWellbeingScan() {
  const el = $('wellbeing-result'); if (!el) return;
  const byAdvisor = {};
  DB.participants.forEach(p => {
    if (!p.advisor || p.advisor === 'Unassigned') return;
    if (!byAdvisor[p.advisor]) byAdvisor[p.advisor] = [];
    toArr(p.notes).forEach(nt => { if (nt.t) byAdvisor[p.advisor].push(nt.t); });
  });
  const advisors = Object.keys(byAdvisor).filter(a => byAdvisor[a].length >= 2);
  if (!advisors.length) {
    el.innerHTML = '<div class="alert alert-info">Not enough advisor case notes yet to scan for patterns.</div>';
    return;
  }
  const steps = [
    { label: 'Grouping notes by advisor', meta: advisors.length + ' advisors' },
    { label: 'Looking for stress patterns', meta: 'Repeated patterns only — never single phrases' },
    { label: 'Drafting manager-only summary', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK staff wellbeing analyst. Scan for stress/burnout patterns. Be measured — only flag genuine repeated patterns. **bold** advisor names. 250 words max. Manager-only output. No hashtags, no markdown headings.';
  const prompt = advisors.map(a =>
    'Advisor: ' + a + '\nNotes (' + byAdvisor[a].length + '):\n' +
    byAdvisor[a].slice(0, 8).map((n, i) => (i + 1) + '. ' + n).join('\n')
  ).join('\n\n---\n\n');
  const raw = await runAgent({
    container: el,
    headerLabel: 'Wellbeing Scan Agent',
    headerSub: 'Manager-only · scanning for stress patterns',
    steps, sys, prompt, maxTok: 500
  });
  if (raw) {
    el.innerHTML = '<div class="ai-panel"><div class="ai-panel-title"><span class="ai-icon">💚</span>Manager-only wellbeing summary</div>' +
      '<div class="ai-response">' + aiPanelHTML(raw) + '</div></div>';
  }
}

async function runBenchmarking() {
  const el = $('benchmark-result'); if (!el) return;
  const P = DB.participants;
  const rate = P.length ? pct(P.filter(p => p.outcomes.length > 0).length, P.length) : 0;
  const steps = [
    { label: 'Anonymising your data', meta: 'Org name and participant identifiers stripped' },
    { label: 'Comparing against sector aggregates', meta: 'Similar-size UK charities' },
    { label: 'Writing benchmark report', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK sector benchmarking analyst. Anonymised comparison vs typical similar-size charities. **bold** the org position. 200 words max. Note benchmarks are illustrative. No hashtags, no markdown headings.';
  const prompt = 'Sector: ' + ((currentOrg && currentOrg.sector) || 'employability charity') +
    '\nParticipants: ' + P.length +
    '\nOutcome rate: ' + rate + '%' +
    '\nFlags in queue: ' + _hrFlags.length;
  const raw = await runAgent({
    container: el,
    headerLabel: 'Benchmarking Agent',
    headerSub: 'Comparing against anonymised sector data',
    steps, sys, prompt, maxTok: 400
  });
  if (raw) {
    el.innerHTML = '<div class="ai-panel"><div class="ai-panel-title"><span class="ai-icon">🏆</span>Benchmark report</div>' +
      '<div class="ai-response">' + aiPanelHTML(raw) + '</div>' +
      '<div style="margin-top:12px;font-size:11px;color:var(--txt3);padding:8px 12px;background:var(--bg);border-radius:6px">🔒 No organisation names ever shared.</div></div>';
  }
}

// HR settings (mode + manager email)
function saveHRMode() {
  const mode = (document.querySelector('input[name="hr-mode"]:checked') || {}).value || 'advisory';
  safeStorage.set('hr_mode', mode);
  updateHRModeBanner();
}
function saveHRSettings() {
  const mode = (document.querySelector('input[name="hr-mode"]:checked') || {}).value || 'advisory';
  const email = $('hr-manager-email').value.trim();
  safeStorage.set('hr_mode', mode);
  safeStorage.set('hr_manager_email', email);
  updateHRModeBanner();
  const msg = $('hr-settings-saved');
  if (msg) { msg.style.display = 'flex'; setTimeout(() => msg.style.display = 'none', 2500); }
}
function updateHRModeBanner() {
  const mode = (document.querySelector('input[name="hr-mode"]:checked') || {}).value || 'advisory';
  const banner = $('hr-mode-banner');
  if (!banner) return;
  const cfg = {
    strict:   { txt: '⚖️ Strict mode active — flags block save, manager alerted instantly.', cls: 'alert-warn' },
    advisory: { txt: '💬 Advisory mode active — soft warnings, can proceed, flags logged for manager review.', cls: 'alert-info' },
    silent:   { txt: '🔕 Silent mode active — no interruption, flags logged quietly, weekly digest to manager.', cls: 'alert-ok' }
  }[mode];
  banner.className = 'alert ' + cfg.cls;
  banner.style.marginBottom = '16px';
  banner.textContent = cfg.txt;
}

// ── Report generator ─────────────────────────────────────────
async function generateAIReport(type, contractId) {
  const progressEl = $('brain-progress');
  const reportEl = $('report-output');
  if (!progressEl || !reportEl) return;
  reportEl.innerHTML = '';
  progressEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const contract = DB.contracts.find(c => String(c.id) === String(contractId));
  const funder = contract && contract.funder_id
    ? (DB.funders || []).find(f => String(f.id) === String(contract.funder_id))
    : null;
  const P = DB.participants, E = DB.events, FB = DB.feedback;
  const orgName = (currentOrg && currentOrg.name) || 'Organisation';
  const todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const linked = P.filter(p => toArr(p.contract_ids).includes(String(contractId)));
  const linkedOutcomes = linked.filter(p => p.outcomes && p.outcomes.length > 0).length;
  const jobs = linked.filter(p => p.outcomes && p.outcomes.includes('Employment')).length;
  const sustained = linked.filter(p => p.stage === 'Sustained').length;
  const avgCB = FB.length ? (FB.reduce((a, f) => a + num(f.cb), 0) / FB.length).toFixed(1) : null;
  const avgCA = FB.length ? (FB.reduce((a, f) => a + num(f.ca), 0) / FB.length).toFixed(1) : null;

  const steps = [
    { label: 'Data check', meta: linked.length + ' participants · ' + E.length + ' events · ' + FB.length + ' feedback responses' },
    { label: 'Cross-checking funder requirements', meta: 'Mapping data against ' + ((funder && funder.name) || 'funder') + ' framework' },
    { label: 'Writing the report', meta: 'Org Brain composing narrative with your live numbers' },
    { label: 'Quality Supervisor check', meta: 'Verifying tone, claims and structure' },
    { label: 'Ready', meta: 'Report delivered — review and download below' }
  ];

  const sys = 'You are a professional UK bid writer producing a funder report. Write in clean formal British English. Structure with these sections in order, each beginning with ## and the section title: Executive Summary, Delivery Overview, Participant Outcomes, Distance Travelled and Wellbeing, Participant Voice, Forward Plan. Use **bold** sparingly for key statistics. 600-800 words. Use only data provided — never invent participants, outcomes or quotes. If a data point is not provided, omit gracefully. Do not use hashtags (#) anywhere except as section heading markers. Do not use horizontal rules or emoji.';

  const prompt = [
    'Organisation: ' + orgName,
    'Report date: ' + todayStr,
    'Contract: ' + ((contract && contract.name) || 'Unnamed contract'),
    'Funder: ' + ((funder && funder.name) || 'Funder'),
    'Contract value: £' + num(contract && contract.value).toLocaleString(),
    'Target starts: ' + ((contract && contract.target_starts) || 0),
    'Actual starts (linked participants): ' + linked.length,
    'Target outcomes: ' + ((contract && contract.target_outcomes) || 0),
    'Actual outcomes: ' + linkedOutcomes,
    'Employment outcomes: ' + jobs,
    'Sustained outcomes: ' + sustained,
    'Total events delivered: ' + E.length,
    avgCB ? 'Average confidence before: ' + avgCB + ' / 5' : '',
    avgCA ? 'Average confidence after: ' + avgCA + ' / 5' : '',
    'Feedback responses: ' + FB.length
  ].filter(Boolean).join('\n');

  const raw = await runAgent({
    container: progressEl,
    headerLabel: 'Org Brain — Funder Report',
    headerSub: 'Reading your data, mapping to funder requirements, writing the report',
    steps, sys, prompt, maxTok: 1400
  });
  if (!raw) return;

  const cleaned = cleanReportText(raw);
  const bodyHTML = reportTextToHTML(cleaned, raw);
  const reportTitle = ((contract && contract.name) || 'Programme Report') + ' — ' + orgName;
  _lastReportText = cleaned;
  _lastReportTitle = reportTitle;

  const _logoUrl = getOrgLogoUrl(currentOrg);
  const _headerHTML = _logoUrl
    ? '<div class="report-header-flex"><div class="report-header-text">' +
        '<div class="report-meta">' + escapeHTML((funder && funder.name) || 'Funder Report') + '</div>' +
        '<div class="report-title">' + escapeHTML((contract && contract.name) || 'Programme Report') + '</div>' +
        '<div class="report-subtitle">' + escapeHTML(orgName) + ' · ' + escapeHTML(todayStr) + '</div>' +
      '</div>' +
      '<div class="report-header-logo"><img src="' + escapeHTML(_logoUrl) + '" alt="' + escapeHTML(orgName) + '" class="org-logo-report" onerror="this.style.display=\'none\'"/></div></div>'
    : '<div class="report-header">' +
        '<div class="report-meta">' + escapeHTML((funder && funder.name) || 'Funder Report') + '</div>' +
        '<div class="report-title">' + escapeHTML((contract && contract.name) || 'Programme Report') + '</div>' +
        '<div class="report-subtitle">' + escapeHTML(orgName) + ' · ' + escapeHTML(todayStr) + '</div>' +
      '</div>';

  reportEl.innerHTML =
    '<div class="report-actions">' +
      '<button class="btn btn-p" onclick="downloadReportPDF()">⬇ Download as PDF</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="copyReportText()" id="copy-report-btn">📋 Copy text</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="generateAIReport(\'' + escapeHTML(type) + '\',\'' + escapeHTML(String(contractId)) + '\')">↻ Regenerate</button>' +
    '</div>' +
    '<div class="report-doc">' +
      _headerHTML +
      '<div class="report-body">' + bodyHTML + '</div>' +
      '<div class="report-footer">Generated by Civara · Org Brain · ' + escapeHTML(todayStr) + '</div>' +
    '</div>';

  reportEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function downloadReportPDF() {
  if (!_lastReportText) {
    alert('Generate a report first before downloading.');
    return;
  }
  const orig = document.title;
  document.title = (_lastReportTitle || 'Civara Report').replace(/[^a-z0-9 \-]/gi, '').slice(0, 80);
  setTimeout(() => {
    window.print();
    setTimeout(() => { document.title = orig; }, 1000);
  }, 100);
}

function copyReportText() {
  const el = document.querySelector('#report-output .report-body');
  if (!el) return;
  navigator.clipboard.writeText(el.innerText);
  const btn = $('copy-report-btn');
  if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => btn.textContent = orig, 2000); }
}

function downloadEOIPDF() {
  const orig = document.title;
  const title = 'EOI — ' + ($('eoi-funder').value || 'Untitled');
  document.title = title.replace(/[^a-z0-9 \-]/gi, '').slice(0, 80);
  const inner = $('eoi-result').innerHTML;
  const printWrap = document.createElement('div');
  printWrap.id = 'report-output';
  const _eoiLogoUrl = getOrgLogoUrl(currentOrg);
  const _eoiOrgName = (currentOrg && currentOrg.name) || 'Organisation';
  const _eoiDateStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const _eoiHeader = _eoiLogoUrl
    ? '<div class="report-header-flex"><div class="report-header-text"><div class="report-meta">Expression of Interest</div><div class="report-title">' + escapeHTML($('eoi-funder').value || 'Funding application') + '</div><div class="report-subtitle">' + escapeHTML(_eoiOrgName) + ' · ' + escapeHTML(_eoiDateStr) + '</div></div><div class="report-header-logo"><img src="' + escapeHTML(_eoiLogoUrl) + '" alt="' + escapeHTML(_eoiOrgName) + '" class="org-logo-report" onerror="this.style.display=\'none\'"/></div></div>'
    : '<div class="report-header"><div class="report-meta">Expression of Interest</div><div class="report-title">' + escapeHTML($('eoi-funder').value || 'Funding application') + '</div><div class="report-subtitle">' + escapeHTML(_eoiOrgName) + ' · ' + escapeHTML(_eoiDateStr) + '</div></div>';
  printWrap.innerHTML = '<div class="report-doc">' + _eoiHeader + '<div class="report-body">' + inner + '</div></div>';
  document.body.appendChild(printWrap);
  setTimeout(() => {
    window.print();
    setTimeout(() => { document.title = orig; printWrap.remove(); }, 1000);
  }, 100);
}

function copyEOI() {
  navigator.clipboard.writeText(_lastEOIText || $('eoi-result').innerText || '');
}

// ── Social media + BD ────────────────────────────────────────
async function runSocialAgent() {
  const platform = $('sm-platform').value;
  const type = $('sm-type').value;
  const tone = $('sm-tone').value;
  const context = $('sm-context').value;
  const out = $('sm-output');
  const res = $('sm-result');
  out.style.display = 'block';

  const steps = [
    { label: 'Reading your latest impact data', meta: DB.participants.length + ' participants · ' + DB.events.length + ' events' },
    { label: 'Tuning to ' + platform + ' tone', meta: tone + ' · ' + type },
    { label: 'Drafting the post', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK charity social media manager. Platform: ' + platform + '. Tone: ' + tone + '. Write the main post in clean prose. No hashtags inline (offer them separately if requested). No markdown headings.';
  const prompt = 'Org: ' + ((currentOrg && currentOrg.name) || 'org') +
    '\nContext: ' + (context || 'none') +
    '\nPost type: ' + type +
    '\nParticipants supported: ' + DB.participants.length +
    '\nEvents delivered: ' + DB.events.length;
  const raw = await runAgent({
    container: res,
    headerLabel: 'Social Media Agent',
    headerSub: 'Drafting a post in your voice',
    steps, sys, prompt, maxTok: 500
  });
  if (raw) {
    const clean = cleanReportText(raw);
    res.innerHTML = '<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:16px;font-size:14px;color:var(--txt2);line-height:1.8;white-space:pre-wrap">' + escapeHTML(clean) + '</div>';
  }
}

async function runBDResearch() {
  const wrap = $('bd-opps-wrap'); const res = $('bd-opps-result');
  wrap.style.display = 'block';
  const steps = [
    { label: 'Searching live funding sources', meta: $('bd-area').value + ' · ' + $('bd-size').value },
    { label: 'Quality Supervisor checking each result', meta: 'Verifying deadlines and eligibility' },
    { label: 'Scoring fit', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK funding researcher. Find 5 currently open opportunities. List each with funder, deadline, value, fit reason. Use **bold** for funder names. No hashtags, no markdown headings.';
  const prompt = 'Area: ' + $('bd-area').value + '\nSize: ' + $('bd-size').value + '\nSpecific: ' + $('bd-specific').value;
  const raw = await runAgent({
    container: res,
    headerLabel: 'BD Manager Agent',
    headerSub: 'Live web search · Quality Supervisor verifying results',
    steps, sys, prompt, maxTok: 900, webSearch: true
  });
  if (raw) aiResult(res, raw);
}

async function runEOIGenerator() {
  const funder = $('eoi-funder').value.trim();
  const brief = $('eoi-brief').value.trim();
  if (!funder || !brief) { alert('Please enter funder and brief.'); return; }
  const out = $('eoi-output'); const res = $('eoi-result');
  out.style.display = 'block';
  const steps = [
    { label: 'Reading the brief', meta: brief.length + ' characters' },
    { label: 'Pulling your real outcomes data', meta: DB.participants.length + ' participants · ' + DB.events.length + ' events' },
    { label: 'Writing the EOI', meta: '' },
    { label: 'Quality Supervisor check', meta: 'Tone, structure, claims' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK bid writer. Write a compelling EOI. Begin each section with ## and the section title (Executive summary, Organisation overview, Track record, Approach). 600-800 words. **bold** stats. No hashtags except section markers, no horizontal rules.';
  const prompt = 'FUNDER: ' + funder +
    '\nBRIEF: ' + brief +
    '\nOrg: ' + ((currentOrg && currentOrg.name) || 'org') +
    '\nUSPs: ' + ($('eoi-usps').value || 'none') +
    '\nOutcomes data: ' + DB.participants.length + ' participants, ' + DB.participants.filter(p => p.outcomes.length > 0).length + ' with outcomes';
  const raw = await runAgent({
    container: res,
    headerLabel: 'EOI Generator Agent',
    headerSub: 'Writing your application using real outcomes',
    steps, sys, prompt, maxTok: 1300
  });
  if (raw) {
    const cleaned = cleanReportText(raw);
    _lastEOIText = cleaned;
    res.innerHTML = reportTextToHTML(cleaned, raw);
    res.style.cssText = 'background:#fff;color:#1a1a1a;border-radius:var(--radiuslg);padding:30px 36px;font-family:Georgia,serif;line-height:1.7';
  }
}
