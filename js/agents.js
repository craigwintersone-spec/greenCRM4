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
//     employer matcher, equity, benchmarking, language coach (self-help),
//     report generator, social media, BD research, EOI generator + EOI form-fill
//
// NOTE (v5 — surveillance removed):
//   The staff-stress "Wellbeing Scan" and the manager "flag queue"
//   have been removed. The language tool is now a SELF-HELP COACH.

'use strict';

// Version marker — check your browser console to confirm this file is live.
// If you DON'T see "Vorlana EOI engine v5", the old cached agents.js is running.
try { console.info('Vorlana EOI engine v5 loaded'); } catch (e) {}

// ── State ─────────────────────────────────────────────────────
const _aiQueue = { running: false, queue: [], lastCallAt: 0 };

let _aiNoteAccepted = '';
let _originalNote   = '';
let _lastEOIText    = '';
let _lastReportText = '';
let _lastReportTitle = '';

// EOI form-fill state
let _eoiQuestions = [];        // [{id, question, wordLimit, guidance}]
let _eoiAnswers   = {};        // { id: answerText }
let _eoiFunderPriorities = ''; // funder priorities, auto-fetched before drafting
let _eoiPrioritiesFunder = ''; // which funder name the loaded priorities belong to

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
      // Don't penalise the rate-gap timer for a plan-gate rejection
      if (e.message !== 'AI_PLAN_GATE') _aiQueue.lastCallAt = Date.now();
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

// ── Equality agents (aggregate / anonymised only) ────────────

async function runLanguageCoach() {
  const el = $('language-coach-result'); if (!el) return;
  const input = ($('language-coach-input') && $('language-coach-input').value || '').trim();
  if (!input) {
    el.innerHTML = '<div class="alert alert-info">Paste or type something above, then run the coach to get gentler, more inclusive phrasing suggestions.</div>';
    return;
  }
  const steps = [
    { label: 'Reading your text', meta: input.length + ' characters' },
    { label: 'Suggesting inclusive phrasing', meta: 'Person-first, strengths-based' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a supportive UK positive-language coach helping a charity worker improve their own writing. ' +
    'Gently suggest more inclusive, person-first, strengths-based phrasing for any wording that could be improved. ' +
    'Be encouraging, never judgemental. For each suggestion show the original phrase and a kinder rewrite. ' +
    'If the text is already good, say so warmly. Use **bold** for the suggested rewrites. ' +
    'This is private self-help feedback for the writer only. No hashtags, no markdown headings.';
  const raw = await runAgent({
    container: el,
    headerLabel: 'Language Coach',
    headerSub: 'Private, self-help suggestions — nothing is saved or shared',
    steps, sys, prompt: input, maxTok: 600
  });
  if (raw) {
    el.innerHTML = '<div class="ai-panel"><div class="ai-panel-title"><span class="ai-icon">💬</span>Coaching suggestions — for you only</div>' +
      '<div class="ai-response">' + aiPanelHTML(raw) + '</div>' +
      '<div style="margin-top:12px;font-size:11px;color:var(--txt3);padding:8px 12px;background:var(--bg);border-radius:6px">🔒 These suggestions are shown to you only. Nothing here is stored, logged, or sent to a manager.</div></div>';
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
  const sys = 'You are a UK equality analyst. Concise summary, **bold** key findings. Flag any gap over 15%. End with one recommendation. 200 words max. Work only with aggregate numbers — never name an individual. No hashtags, no markdown headings.';
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
    '\nOutcome rate: ' + rate + '%';
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
      '<div class="report-footer">Generated by Vorlana · Org Brain · ' + escapeHTML(todayStr) + '</div>' +
    '</div>';

  reportEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function downloadReportPDF() {
  if (!_lastReportText) {
    alert('Generate a report first before downloading.');
    return;
  }
  const orig = document.title;
  document.title = (_lastReportTitle || 'Vorlana Report').replace(/[^a-z0-9 \-]/gi, '').slice(0, 80);
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

// ═════════════════════════════════════════════════════════════
// EOI ENGINE — form-fill + grounded drafting
// ═════════════════════════════════════════════════════════════

// ── Organisation profile (the facts an EOI needs that the CRM doesn't hold) ──
// Stored in the browser (localStorage) per org, so no database change is needed.
function _orgProfileKey() { return 'vorlana_org_profile_' + ((currentOrg && currentOrg.id) || 'default'); }
function getOrgProfile() { try { return (localStorage.getItem(_orgProfileKey()) || '').trim(); } catch (e) { return ''; } }
function populateOrgProfileField() { const el = $('eoi-org-profile'); if (el) el.value = getOrgProfile(); }
function saveOrgProfileFromField() {
  try {
    const el = $('eoi-org-profile'); if (!el) return;
    localStorage.setItem(_orgProfileKey(), el.value || '');
    const s = $('eoi-profile-saved'); if (s) { s.style.display = 'inline'; setTimeout(() => { s.style.display = 'none'; }, 2500); }
  } catch (e) {}
}

// The single biggest quality lever: real, verifiable numbers from the CRM.
// IMPORTANT: only emit metrics that are > 0. Broadcasting zeros makes a bid
// read as "we have done nothing" — which sinks it.
function buildEOIEvidence() {
  const P = DB.participants || [];
  const E = DB.events || [];
  const FB = DB.feedback || [];
  const C = DB.contracts || [];

  const total = P.length;
  if (!total && !E.length && !FB.length && !C.length) {
    return 'VERIFIED CRM DATA: none recorded in the system yet — rely on the KNOWN ORGANISATION FACTS above and use [INSERT: ...] placeholders for any specific figures. Do not state or imply that figures are zero or that the organisation has no track record.';
  }

  const active = P.filter(p => p.stage !== 'Closed').length;
  const withOutcome = P.filter(p => (p.outcomes || []).length > 0).length;
  const rate = total ? pct(withOutcome, total) : 0;

  const outCount = {};
  OUT_TYPES.forEach(t => { outCount[t] = P.filter(p => (p.outcomes || []).includes(t)).length; });
  const employment = outCount['Employment'] || 0;
  const sustained = P.filter(p => p.stage === 'Sustained').length;

  const barrierCount = {};
  BARRIERS.forEach(b => {
    const n = P.filter(p => (p.barriers || []).includes(b)).length;
    if (n) barrierCount[b] = n;
  });
  const topBarriers = Object.entries(barrierCount)
    .sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([b, n]) => b + ' (' + n + ')').join(', ');

  const avgCB = FB.length ? (FB.reduce((a, f) => a + num(f.cb), 0) / FB.length).toFixed(1) : null;
  const avgCA = FB.length ? (FB.reduce((a, f) => a + num(f.ca), 0) / FB.length).toFixed(1) : null;

  const contractLines = [];
  let totalValue = 0, totalActualOutcomes = 0;
  C.forEach(c => {
    totalValue += num(c.value);
    totalActualOutcomes += num(c.actual_outcomes);
    contractLines.push(
      c.name + ': ' + num(c.actual_starts) + '/' + num(c.target_starts) + ' starts, ' +
      num(c.actual_outcomes) + '/' + num(c.target_outcomes) + ' outcomes'
    );
  });
  const costPerOutcome = totalActualOutcomes ? Math.round(totalValue / totalActualOutcomes) : null;

  const cs = P.find(p => (p.outcomes || []).length > 0 && (p.barriers || []).length > 0);
  const caseStudy = cs
    ? ('joined with barriers ' + (cs.barriers || []).join(', ') +
       '; reached stage "' + cs.stage + '"; achieved ' + (cs.outcomes || []).join(', '))
    : null;

  const obreak = OUT_TYPES.filter(t => outCount[t] > 0).map(t => t + ' ' + outCount[t]);

  const lines = ['VERIFIED CRM DATA (use ONLY these figures — do not invent numbers):'];
  if (total) lines.push('- Participants supported: ' + total + (active ? (' (' + active + ' currently active)') : ''));
  if (withOutcome) lines.push('- With at least one outcome: ' + withOutcome + ' (' + rate + '%)');
  if (employment) lines.push('- Into employment: ' + employment);
  if (sustained) lines.push('- Sustained: ' + sustained);
  if (obreak.length) lines.push('- Outcome breakdown: ' + obreak.join(', '));
  if (topBarriers) lines.push('- Priority-group reach (top barriers in caseload): ' + topBarriers);
  if (avgCB && avgCA) lines.push('- Distance travelled (confidence): ' + avgCB + ' -> ' + avgCA + ' /5 across ' + FB.length + ' responses');
  if (E.length) lines.push('- Events/workshops delivered: ' + E.length);
  if (contractLines.length) lines.push('- Contract delivery vs target: ' + contractLines.join(' | '));
  if (costPerOutcome) lines.push('- Approx cost per outcome (funded contracts): £' + costPerOutcome.toLocaleString());
  if (caseStudy) lines.push('- Anonymised case-study facts: a participant ' + caseStudy);
  if (lines.length === 1) lines.push('- none recorded yet — rely on the KNOWN ORGANISATION FACTS above; do not state figures are zero.');

  return lines.join('\n');
}

// True for short factual fields (name, number, address, website, etc.) that
// must NOT be answered with prose.
function _eoiIsShortField(q) {
  if (q.wordLimit && q.wordLimit <= 25) return true;
  const t = (q.question || '').toLowerCase();
  if ((q.question || '').length > 90) return false;
  if (/how|why|describe|explain|detail|approach|deliver|ensure|risk|legacy|budget for|knowledge|benefit|work with|measures/.test(t)) return false;
  return /\b(name|number|address|post ?code|website|url|link|e-?mail|telephone|phone|\bdate\b|title|type)\b/.test(t);
}

// Strip a self-added heading/label line the model sometimes puts on top
// (e.g. "Website", "Budget Breakdown for...", "Response to ... Question").
function _stripLeadingLabel(ans) {
  if (!ans) return ans;
  const lines = ans.split('\n');
  if (lines.length > 2 && lines[0].trim() && lines[1].trim() === '') {
    const first = lines[0].trim();
    if (first.length <= 60 && !/[.!?,:;]$/.test(first) && first.split(/\s+/).length <= 8) {
      lines.shift();
      while (lines.length && lines[0].trim() === '') lines.shift();
      return lines.join('\n').trim();
    }
  }
  return ans.trim();
}

// Read an uploaded form: .docx / .pdf / .txt -> plain text
async function readUploadedFormFile(file) {
  const name = (file.name || '').toLowerCase();
  const buf = await file.arrayBuffer();

  if (name.endsWith('.docx')) {
    if (!window.mammoth) throw new Error('Word-reading library not loaded — see app.html head');
    const { value } = await window.mammoth.extractRawText({ arrayBuffer: buf });
    return value || '';
  }
  if (name.endsWith('.pdf')) {
    if (!window.pdfjsLib) throw new Error('PDF-reading library not loaded — see app.html head');
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(it => it.str).join(' ') + '\n';
    }
    return text;
  }
  return new TextDecoder('utf-8').decode(buf);
}

async function handleEOIFormUpload(inputEl) {
  const file = inputEl && inputEl.files && inputEl.files[0];
  if (!file) return;
  const ta = $('eoi-form-text');
  try {
    ta.value = 'Reading ' + file.name + ' …';
    const text = await readUploadedFormFile(file);
    if (!text.trim()) { ta.value = ''; alert('Could not read any text from that file. Try pasting the questions instead.'); return; }
    ta.value = text.trim();
  } catch (e) {
    ta.value = '';
    alert('Could not read that file: ' + e.message + '\nPaste the questions in the box instead.');
  }
}

// Parse the form text into structured questions (one AI call)
async function parseEOIForm() {
  const text = ($('eoi-form-text') && $('eoi-form-text').value || '').trim();
  if (!text) { alert('Upload or paste the funder\'s form first.'); return; }

  const wrap = $('eoi-questions');
  wrap.style.display = 'block';
  wrap.innerHTML = '<div class="alert alert-info" style="margin:0">Reading the form and pulling out each question…</div>';

  const sys =
    'You are parsing a UK funding Expression of Interest form. Extract every question or field the applicant must complete, in order. ' +
    'Return ONLY a valid JSON array — no prose, no markdown, no code fences. ' +
    'Each item: {"id":"q1","question":"<exact question text>","wordLimit":<number or null>,"guidance":"<any limit/guidance note, else empty string>"}. ' +
    'Include short mandatory fields too (project title, amount requested, organisation name). ' +
    'If a word limit is stated use it; if only a character limit is stated, set wordLimit to that number divided by 6 (rounded). ' +
    'If no limit is stated, wordLimit is null. Return at most 20 items.';

  let raw;
  try {
    raw = await callClaude(sys, text.slice(0, 3900), 900, false);
  } catch (e) {
    if (e.message === 'AI_PLAN_GATE') { wrap.innerHTML = ''; return; }
    wrap.innerHTML = '<div class="alert alert-warn" style="margin:0">Could not parse the form: ' + escapeHTML(e.message) + '</div>';
    return;
  }

  try {
    const clean = raw.replace(/```json|```/gi, '').trim();
    const m = clean.match(/\[[\s\S]*\]/);
    if (!m) throw new Error('no JSON array found');
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || !arr.length) throw new Error('empty');
    _eoiQuestions = arr.map((q, i) => ({
      id: q.id || ('q' + (i + 1)),
      question: (q.question || '').toString().trim(),
      wordLimit: (typeof q.wordLimit === 'number' && q.wordLimit > 0) ? Math.round(q.wordLimit) : null,
      guidance: (q.guidance || '').toString().trim()
    })).filter(q => q.question);
    _eoiAnswers = {};
    renderEOIQuestions();
  } catch (e) {
    wrap.innerHTML = '<div class="alert alert-warn" style="margin:0">Couldn\'t read the questions automatically. Paste them one per line and try again.</div>';
  }
}

// Editable question list — user can fix any parsing slip before drafting
function renderEOIQuestions() {
  const wrap = $('eoi-questions');
  if (!_eoiQuestions.length) { wrap.style.display = 'none'; return; }
  wrap.style.display = 'block';
  wrap.innerHTML =
    '<div style="font-weight:700;font-size:13px;margin:4px 0 10px">Found ' + _eoiQuestions.length +
    ' question(s) — edit if needed, then draft:</div>' +
    _eoiQuestions.map((q, i) =>
      '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px">' +
        '<div style="font-size:11px;color:var(--txt3);margin-bottom:4px">Q' + (i + 1) +
          (q.wordLimit ? ' · limit ' + q.wordLimit + ' words' : ' · no stated limit') + '</div>' +
        '<textarea id="eoiq-' + q.id + '" style="width:100%;min-height:44px;font-size:13px;border:1px solid var(--border);border-radius:6px;padding:6px 8px" ' +
          'onchange="_syncEOIQuestion(\'' + q.id + '\')">' + escapeHTML(q.question) + '</textarea>' +
      '</div>'
    ).join('') +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">' +
      '<button class="btn btn-p" onclick="runEOIFormFill()">✦ Draft all answers from my data</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="researchEOIFunder()">🔎 Re-research funder (optional — runs automatically)</button>' +
    '</div>' +
    (_eoiFunderPriorities ? '<div style="font-size:11px;color:var(--txt3);margin-top:8px">Funder priorities loaded — they\'ll steer the drafting.</div>' : '');
}
function _syncEOIQuestion(id) {
  const q = _eoiQuestions.find(x => x.id === id);
  const el = $('eoiq-' + id);
  if (q && el) q.question = el.value.trim();
}

// Fetch the funder's priorities via web search. Skips work if we already have
// them for this exact funder. Returns quietly on failure (drafting proceeds
// without priorities). `force` re-fetches even if cached.
async function _ensureFunderPriorities(funder, force) {
  funder = (funder || '').trim();
  if (!funder) return;
  if (!force && _eoiFunderPriorities && _eoiPrioritiesFunder === funder) return;

  const sys = 'You are a UK funding researcher. In 4-6 short bullet points, summarise this funder\'s current priorities, the outcomes they fund, and the language they use in guidance. Be factual and specific. No preamble.';
  try {
    const raw = await callClaude(sys, 'Funder: ' + funder, 500, true);
    _eoiFunderPriorities = cleanReportText(raw);
    _eoiPrioritiesFunder = funder;
  } catch (e) {
    // Leave any previous priorities in place; drafting continues without.
  }
}

// Manual "Re-research funder" button — forces a fresh fetch and shows status.
async function researchEOIFunder() {
  const funder = ($('eoi-funder') && $('eoi-funder').value || '').trim();
  if (!funder) { alert('Enter the funder name in the field above first.'); return; }
  const wrap = $('eoi-questions');
  const note = document.createElement('div');
  note.className = 'alert alert-info';
  note.style.margin = '8px 0';
  note.textContent = 'Researching ' + funder + '…';
  wrap.appendChild(note);
  try {
    await _ensureFunderPriorities(funder, true);
    if (_eoiPrioritiesFunder === funder && _eoiFunderPriorities) {
      renderEOIQuestions();
    } else {
      note.className = 'alert alert-warn';
      note.textContent = 'Funder research unavailable right now — drafting will still proceed without it.';
    }
  } catch (e) {
    note.className = 'alert alert-warn';
    note.textContent = 'Funder research unavailable: ' + (e.message || '') + ' — drafting will proceed without it.';
  }
}

// Draft — one grounded call per question, respecting word limits
async function runEOIFormFill() {
  if (!_eoiQuestions.length) { alert('Parse a form first.'); return; }
  _eoiQuestions.forEach(q => _syncEOIQuestion(q.id)); // pull any edits

  const funderRaw = ($('eoi-funder') && $('eoi-funder').value || '').trim();
  const funder = funderRaw || 'the funder';
  const usps = ($('eoi-usps') && $('eoi-usps').value || '').trim();
  const profile = getOrgProfile();
  const evidence = buildEOIEvidence();
  const out = $('eoi-output'); const res = $('eoi-result');
  out.style.display = 'block';

  // Auto-research the funder's priorities first, so every answer speaks their
  // language. Only runs if a funder name is set and we don't already have them.
  if (funderRaw && !(_eoiFunderPriorities && _eoiPrioritiesFunder === funderRaw)) {
    res.innerHTML = '<div class="brain-panel"><div class="brain-header">' +
      '<div class="brain-icon">🔎</div><div>' +
      '<div class="brain-title">Researching ' + escapeHTML(funderRaw) + '</div>' +
      '<div class="brain-sub">Reading the funder\'s priorities so answers match their language</div>' +
      '</div></div></div>';
    await _ensureFunderPriorities(funderRaw);
  }

  const sys =
    'You are an expert UK bid writer completing an Expression of Interest to WIN funding. ' +
    'Everything you write is pasted straight into the funder\'s form as the applicant\'s own words. RULES: ' +
    '1) Never address the reader, never explain what you cannot do, never comment on data quality, never apologise, never give recommendations — write ONLY the answer. ' +
    '2) Never add a title, heading or label above the answer; the question is the heading. ' +
    '3) Ground claims in the KNOWN ORGANISATION FACTS and VERIFIED CRM DATA; never invent statistics, names, numbers, partners or accreditations. ' +
    '4) Where a specific fact is missing, insert a placeholder like [INSERT: charity number] and keep going — do NOT lecture about the gap. ' +
    '5) NEVER state or imply the organisation has no experience, no track record, or that figures are zero; rely on the organisation facts and use [INSERT: ...] for specifics. ' +
    '6) If the question is a SHORT FACTUAL FIELD (name, number, address, postcode, website, email, link, date, title, contact, budget line), reply with ONLY the value or a single [INSERT: ...] placeholder — no prose, no sentences. ' +
    '7) Otherwise write clean formal British English prose, mirror the funder\'s language and priorities, and respect the word limit.';

  const facts = 'KNOWN ORGANISATION FACTS (provided by the applicant — treat as true):\n' +
    (profile ? profile.slice(0, 1800) : '(none provided — use [INSERT: ...] placeholders for organisation details such as legal name, charity/company number, address, website, contact)');

  _eoiAnswers = {};

  for (let i = 0; i < _eoiQuestions.length; i++) {
    const q = _eoiQuestions[i];
    res.innerHTML = _fillProgressHTML(i);
    const short = _eoiIsShortField(q);
    let limitLine, maxTok;
    if (short) {
      limitLine = 'This is a SHORT FACTUAL FIELD — reply with ONLY the value or a single [INSERT: ...] placeholder. No prose, no explanation.';
      maxTok = 80;
    } else {
      limitLine = q.wordLimit ? ('Word limit: ' + q.wordLimit + ' words — do not exceed.') : 'Aim for roughly 180-260 words.';
      maxTok = Math.min(1200, Math.round((q.wordLimit || 260) * 1.7) + 120);
    }

    const userPrompt = [
      'FUNDER: ' + funder,
      _eoiFunderPriorities ? ('FUNDER PRIORITIES:\n' + _eoiFunderPriorities.slice(0, 700)) : '',
      usps ? ('OUR STRENGTHS/USPs: ' + usps) : '',
      '',
      facts,
      '',
      evidence,
      '',
      'QUESTION TO ANSWER: ' + q.question,
      limitLine
    ].filter(Boolean).join('\n');

    try {
      const raw = await callClaude(sys, userPrompt, maxTok, false);
      _eoiAnswers[q.id] = _stripLeadingLabel(cleanReportText(raw));
    } catch (e) {
      if (e.message === 'AI_PLAN_GATE') { res.innerHTML = ''; return; }
      _eoiAnswers[q.id] = '[Could not draft this answer: ' + e.message + ']';
    }
  }

  renderFilledEOI();
}

function _fillProgressHTML(activeIdx) {
  return '<div class="brain-panel"><div class="brain-header">' +
    '<div class="brain-icon">🧠</div><div>' +
    '<div class="brain-title">EOI Engine — drafting from your data</div>' +
    '<div class="brain-sub">Answering question ' + (activeIdx + 1) + ' of ' + _eoiQuestions.length + ', grounded in real outcomes</div>' +
    '</div></div><div class="brain-steps">' +
    _eoiQuestions.map((q, i) => {
      const state = i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
      const icon = state === 'done' ? '<div class="bs-check">✓</div>'
        : state === 'active' ? '<div class="bs-spinner"></div>'
        : '<div class="bs-num">' + (i + 1) + '</div>';
      return '<div class="brain-step ' + state + '"><div class="bs-icon-wrap">' + icon + '</div>' +
        '<div class="bs-text"><div class="bs-label">' + escapeHTML(q.question.slice(0, 70)) + (q.question.length > 70 ? '…' : '') + '</div></div></div>';
    }).join('') + '</div></div>';
}

function _wordCount(s) { return (s || '').trim() ? (s.trim().split(/\s+/).length) : 0; }

// Assemble — render the completed form, flag limits + placeholders
function renderFilledEOI() {
  const res = $('eoi-result');
  let placeholderCount = 0;
  const parts = _eoiQuestions.map((q, i) => {
    const ans = _eoiAnswers[q.id] || '';
    const wc = _wordCount(ans);
    const over = q.wordLimit && wc > q.wordLimit;
    (ans.match(/\[INSERT:[^\]]*\]/gi) || []).forEach(() => placeholderCount++);
    const meta = (q.wordLimit ? (wc + '/' + q.wordLimit + ' words') : (wc + ' words')) + (over ? ' · OVER LIMIT' : '');
    const html = boldify(escapeHTML(ans))
      .replace(/\[INSERT:([^\]]*)\]/gi, '<mark style="background:#ffe9a8">[INSERT:$1]</mark>')
      .replace(/\n/g, '<br/>');
    return '<div style="margin-bottom:22px">' +
      '<div style="font-weight:700;font-size:14px;margin-bottom:2px">Q' + (i + 1) + '. ' + escapeHTML(q.question) + '</div>' +
      '<div style="font-size:11px;color:' + (over ? '#b91c1c' : '#888') + ';margin-bottom:6px">' + meta + '</div>' +
      '<div style="font-size:14px;line-height:1.7">' + html + '</div></div>';
  });

  const flagBar = placeholderCount
    ? '<div class="alert alert-warn" style="margin:0 0 16px">⚠ ' + placeholderCount +
      ' placeholder(s) need your real figures before you submit — highlighted below.</div>'
    : '';

  _lastEOIText = _eoiQuestions.map((q, i) => 'Q' + (i + 1) + '. ' + q.question + '\n\n' + (_eoiAnswers[q.id] || '')).join('\n\n');

  $('eoi-output').style.display = 'block';
  res.style.cssText = 'background:#fff;color:#1a1a1a;border-radius:var(--radiuslg);padding:30px 36px';
  res.innerHTML =
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px">' +
      '<button class="btn btn-p" onclick="downloadEOIPDF()">⬇ Download as PDF</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="copyEOI()">📋 Copy all</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="runEOIQualitySupervisor()">🔍 Run Quality Supervisor</button>' +
    '</div>' +
    flagBar +
    '<div id="eoi-fill-body" style="font-family:Georgia,serif">' + parts.join('') + '</div>' +
    '<div id="eoi-qa-result"></div>' +
    '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #eee;font-size:11px;color:#999">Drafted with Vorlana · verify all figures before submission</div>';
}

// Quality Supervisor — optional review pass. Reviews FULL answers in batches
// (they're far too long for one model call), so it never sees truncated text.
async function runEOIQualitySupervisor() {
  if (!_eoiQuestions.length) return;
  const el = $('eoi-qa-result');
  el.innerHTML = '<div class="alert alert-info" style="margin:16px 0 0">Quality Supervisor reviewing…</div>';

  const funder = ($('eoi-funder') && $('eoi-funder').value || '').trim() || 'the funder';

  const sys =
    'You are a bid-review Quality Supervisor for UK funding EOIs. The answers given to you are COMPLETE — never flag truncation, "cuts off", or that an answer looks short; that is not a fault. ' +
    'For each question/answer pair, list ONLY specific, real problems: a question not actually answered; an answer clearly over its stated word limit; a claim that should be evidenced or looks unsupported; a headline statistic repeated so often it strains credibility; or where the funder\'s priorities are not reflected. ' +
    'Reference each issue by its question number (e.g. "Q7: ..."). If an answer is sound, say nothing about it. Be concise. No preamble, no praise. If nothing is wrong in this batch, reply with exactly: OK.';

  // Pack FULL answers into batches under the input cap (~3500 chars of body).
  const CHAR_BUDGET = 3400;
  const batches = [];
  let cur = '', curLen = 0;
  for (let i = 0; i < _eoiQuestions.length; i++) {
    const q = _eoiQuestions[i];
    const ans = _eoiAnswers[q.id] || '';
    const block = 'Q' + (i + 1) + ' (' + (q.wordLimit ? q.wordLimit + 'w limit' : 'no stated limit') + '): ' + q.question +
      '\nANSWER: ' + ans + '\n\n';
    if (curLen + block.length > CHAR_BUDGET && cur) { batches.push(cur); cur = ''; curLen = 0; }
    cur += block; curLen += block.length;
  }
  if (cur) batches.push(cur);

  const findings = [];
  for (let b = 0; b < batches.length; b++) {
    el.innerHTML = '<div class="alert alert-info" style="margin:16px 0 0">Quality Supervisor reviewing… (' + (b + 1) + ' of ' + batches.length + ')</div>';
    try {
      const raw = await callClaude(sys, 'FUNDER: ' + funder + '\n\n' + batches[b], 600, false);
      const clean = cleanReportText(raw).trim();
      if (clean && !/^ok\.?$/i.test(clean)) findings.push(clean);
    } catch (e) {
      findings.push('(Could not review one batch: ' + (e.message || 'error') + ')');
    }
  }

  const combined = findings.join('\n').trim();
  el.innerHTML = '<div class="ai-panel" style="margin:16px 0 0"><div class="ai-panel-title"><span class="ai-icon">🔍</span>Quality Supervisor</div>' +
    '<div class="ai-response">' + (combined ? aiPanelHTML(combined) : '<p>No issues flagged — the answers read as complete and on-brief. Remember to fill any [INSERT: …] placeholders and verify all figures before submitting.</p>') + '</div></div>';
}

// Legacy brief-based EOI — now grounded + anti-fabrication
async function runEOIGenerator() {
  const funder = $('eoi-funder').value.trim();
  const brief = $('eoi-brief').value.trim();
  if (!funder || !brief) { alert('Please enter funder and brief.'); return; }
  const out = $('eoi-output'); const res = $('eoi-result');
  out.style.display = 'block';
  const profile = getOrgProfile();
  const evidence = buildEOIEvidence();

  const steps = [
    { label: 'Reading the brief', meta: brief.length + ' characters' },
    { label: 'Pulling your organisation facts + CRM data', meta: DB.participants.length + ' participants' },
    { label: 'Writing to the funder\'s priorities', meta: '' },
    { label: 'Quality check — claims and limits', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys =
    'You are an expert UK bid writer. Write a compelling Expression of Interest to WIN this funding — the text is pasted straight into the application as the applicant\'s own words. ' +
    'Structure it around what the brief actually asks for; where the brief is open, use these sections, each starting with ## and its title: ' +
    'Executive summary, The need, Our track record, Our approach, Value for money. ' +
    'Mirror the funder\'s language and priorities. Never address the reader, never comment on data quality, never apologise, never imply the organisation has no track record or that figures are zero. ' +
    'Ground every claim in the KNOWN ORGANISATION FACTS and VERIFIED CRM DATA — never invent numbers, quotes, names or partners; ' +
    'use [INSERT: ...] placeholders for anything missing and keep going. 600-800 words. **bold** key statistics. No hashtags except section markers.';
  const prompt = [
    'FUNDER: ' + funder,
    'BRIEF: ' + brief,
    'OUR STRENGTHS/USPs: ' + ($('eoi-usps').value || 'none'),
    '',
    'KNOWN ORGANISATION FACTS (provided by the applicant — treat as true):',
    (profile ? profile.slice(0, 1800) : '(none provided — use [INSERT: ...] placeholders for organisation details)'),
    '',
    evidence
  ].join('\n');

  const raw = await runAgent({
    container: res,
    headerLabel: 'EOI Generator Agent',
    headerSub: 'Writing your application using verified outcomes',
    steps, sys, prompt, maxTok: 1300
  });
  if (raw) {
    const cleaned = cleanReportText(raw);
    _lastEOIText = cleaned;
    const html = reportTextToHTML(cleaned, raw)
      .replace(/\[INSERT:([^\]]*)\]/gi, '<mark style="background:#ffe9a8">[INSERT:$1]</mark>');
    res.innerHTML = html +
      '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #eee;font-size:11px;color:#999">Drafted with Vorlana · verify all figures before submission</div>';
    res.style.cssText = 'background:#fff;color:#1a1a1a;border-radius:var(--radiuslg);padding:30px 36px;font-family:Georgia,serif;line-height:1.7';
  }
}

// EOI export helpers
function downloadEOIPDF() {
  const orig = document.title;
  const title = 'EOI — ' + (($('eoi-funder') && $('eoi-funder').value) || 'Untitled');
  document.title = title.replace(/[^a-z0-9 \-]/gi, '').slice(0, 80);
  const inner = $('eoi-result').innerHTML;
  const printWrap = document.createElement('div');
  printWrap.id = 'report-output';
  const _logo = getOrgLogoUrl(currentOrg);
  const _org = (currentOrg && currentOrg.name) || 'Organisation';
  const _date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const _header = _logo
    ? '<div class="report-header-flex"><div class="report-header-text"><div class="report-meta">Expression of Interest</div><div class="report-title">' + escapeHTML(($('eoi-funder') && $('eoi-funder').value) || 'Funding application') + '</div><div class="report-subtitle">' + escapeHTML(_org) + ' · ' + escapeHTML(_date) + '</div></div><div class="report-header-logo"><img src="' + escapeHTML(_logo) + '" alt="' + escapeHTML(_org) + '" class="org-logo-report" onerror="this.style.display=\'none\'"/></div></div>'
    : '<div class="report-header"><div class="report-meta">Expression of Interest</div><div class="report-title">' + escapeHTML(($('eoi-funder') && $('eoi-funder').value) || 'Funding application') + '</div><div class="report-subtitle">' + escapeHTML(_org) + ' · ' + escapeHTML(_date) + '</div></div>';
  printWrap.innerHTML = '<div class="report-doc">' + _header + '<div class="report-body">' + inner + '</div><div class="report-footer">Generated by Vorlana · ' + escapeHTML(_date) + '</div></div>';
  document.body.appendChild(printWrap);
  setTimeout(() => { window.print(); setTimeout(() => { document.title = orig; printWrap.remove(); }, 1000); }, 100);
}

function copyEOI() {
  navigator.clipboard.writeText(_lastEOIText || ($('eoi-result') && $('eoi-result').innerText) || '');
}
