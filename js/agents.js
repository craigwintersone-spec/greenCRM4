// js/agents.js — Claude API + all AI agents
// Depends on: config.js, utils.js, db.js
//
// Responsibilities:
//   • call /api/claude (the Vercel route that proxies to Anthropic)
//   • queue calls so we don't trip rate limits
//   • render the "Vorlana" progress UI
//   • clean / format AI output
//   • all specific agents: morning briefing, intake, case note,
//     RAG explainer, feedback analyst, outcomes analyst,
//     employer matcher, equity, benchmarking, language coach (self-help),
//     report generator, social impact report, social media, BD research,
//     EOI generator + EOI form-fill
//
// NOTE (v5 — surveillance removed):
//   The staff-stress "Wellbeing Scan" and the manager "flag queue"
//   have been removed. The language tool is now a SELF-HELP COACH.
//
// NOTE (v9):
//   • Morning Briefing now reads events, feedback and volunteer hours,
//     not just participants — flags sessions with no feedback, sessions
//     with no volunteer hours logged, and what's on this week.
//   • New Social Impact report (generateImpactReport) — button on the
//     Social Impact tab. Code computes every figure; the AI writes prose.

'use strict';

// Version marker — check your browser console to confirm this file is live.
try { console.info('Vorlana agents v10 loaded (social studio + briefing + impact report + EOI engine v8)'); } catch (e) {}

// ── State ─────────────────────────────────────────────────────
const _aiQueue = { active: 0, max: 3, queue: [], lastCallAt: 0 };   // up to 3 AI calls at once; starts spaced by AI_MIN_GAP_MS

let _aiNoteAccepted = '';
let _originalNote   = '';
let _lastEOIText    = '';
let _lastReportText = '';
let _lastReportTitle = '';
let _lastImpact = null;        // last Social Impact report { html, text, title }

// EOI form-fill state
let _eoiQuestions = [];        // [{id, question, wordLimit, guidance}]
let _eoiAnswers   = {};        // { id: answerText }
let _eoiFunderPriorities = ''; // funder priorities, auto-fetched before drafting
let _eoiPrioritiesFunder = ''; // which funder name the loaded priorities belong to
let _eoiGuidanceText = '';     // the funder's own web page, read when we fetched their form
let _eoiProject = '';          // the project this bid is for (chosen from Vorlana's suggestions)
let _eoiProjectFor = '';       // which funder that project was chosen for
let _bdOpps = {};              // found funding opportunities, keyed for the "Draft EOI" buttons

// UK real Living Wage (Living Wage Foundation, 2025/26 — announced Oct 2025) — used to value volunteer time.
// Update each October when the Foundation announces the new rate.
const VOL_HOUR_RATE = 13.45;

// ── Plan gate ─────────────────────────────────────────────────
function checkAIAccess() {
  const plan = (currentOrg && currentOrg.plan) || 'free';
  if (!AI_PLANS.includes(plan)) {
    const msg = document.createElement('div');
    msg.style.cssText = 'position:fixed;top:24px;right:24px;background:var(--surface);border:1px solid var(--amber);border-radius:var(--radiuslg);padding:16px 20px;z-index:999;max-width:320px;box-shadow:0 8px 24px rgba(0,0,0,.12)';
    msg.innerHTML =
      '<div style="font-size:13px;font-weight:700;color:var(--amber);margin-bottom:4px">✦ AI features — start a plan</div>' +
      '<div style="font-size:12px;color:var(--txt2)">Vorlana’s AI comes with every paid plan (Community, Standard and Provider).</div>' +
      '<button onclick="this.parentElement.remove()" style="position:absolute;top:8px;right:10px;background:none;border:none;color:var(--txt3);cursor:pointer;font-size:16px">✕</button>';
    document.body.appendChild(msg);
    setTimeout(() => msg.remove(), 5000);
    throw new Error('AI_PLAN_GATE');
  }
}

// ── Claude API call (with queue + retries) ───────────────────
// opts: { model, effort: 'low'|'medium'|'high', long: true (bid work: room for the funder's guidance and the full evidence) }
async function callClaude(sys, user, maxTok, webSearch, opts) {
  if (maxTok == null) maxTok = 600;
  if (webSearch == null) webSearch = false;
  opts = opts || {};
  checkAIAccess();
  const sysCap = opts.long ? 8000 : 3000, userCap = opts.long ? 45000 : 4000;
  if (sys && sys.length > sysCap) sys = sys.slice(0, sysCap);
  if (user && user.length > userCap) user = user.slice(0, userCap);
  if (opts.context && opts.context.length > 40000) opts = Object.assign({}, opts, { context: opts.context.slice(0, 40000) });
  if (maxTok > 1200) maxTok = 1200;

  return new Promise((resolve, reject) => {
    _aiQueue.queue.push({ sys, user, maxTok, webSearch, opts, resolve, reject });
    _processAIQueue();
  });
}

async function _processAIQueue() {
  while (_aiQueue.queue.length && _aiQueue.active < _aiQueue.max) {
    const job = _aiQueue.queue.shift();
    _aiQueue.active++;
    const now = Date.now(), at = Math.max(now, _aiQueue.lastCallAt + AI_MIN_GAP_MS);
    _aiQueue.lastCallAt = at;                                    // book this start slot before waiting
    (async () => {
      if (at > now) await new Promise(r => setTimeout(r, at - now));
      try { job.resolve(await _callClaudeOnce(job.sys, job.user, job.maxTok, job.webSearch, 0, job.opts)); }
      catch (e) { job.reject(e); }
      finally { _aiQueue.active--; _processAIQueue(); }
    })();
  }
}

async function _callClaudeOnce(sys, user, maxTok, webSearch, attempt, opts) {
  if (attempt == null) attempt = 0;
  opts = opts || {};

  const getToken = async force => {
    let { data: { session } } = await sb.auth.getSession();
    if (force || !session || (session.expires_at && session.expires_at * 1000 - Date.now() < 60000)) {
      try { const r = await sb.auth.refreshSession(); if (r && r.data && r.data.session) session = r.data.session; } catch (e) { /* use what we have */ }
    }
    return session && session.access_token;
  };
  const send = async force => {
    const token = await getToken(force);
    return fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': token ? 'Bearer ' + token : '' },
      // opts.context: the part shared by many requests (funder, facts, records) — sent first and cached, so it's paid for once
      body: JSON.stringify({ model: opts.model || CLAUDE_MODEL, max_tokens: maxTok, system: sys,
        messages: [{ role: 'user', content: opts.context ? [{ type: 'text', text: opts.context, cache_control: { type: 'ephemeral' } }, { type: 'text', text: user }] : user }],
        web_search: webSearch, effort: opts.effort || undefined, purpose: opts.purpose || undefined })
    });
  };
  let res = await send(false);
  if (res.status === 401) res = await send(true);     // sign-in had gone stale: refresh once and retry

  // Rate limited — exponential backoff (but the daily allowance being used up won't clear by waiting)
  if (res.status === 429) {
    let body = null; try { body = await res.clone().json(); } catch (e) { /* ignore */ }
    if (body && body.code === 'AI_QUOTA') { const e = new Error(body.error || 'Your organisation has used today\'s AI allowance. It resets at midnight.'); e.code = 'AI_QUOTA'; throw e; }
    if (attempt >= 3) {
      const e = new Error('The AI is busy (rate limit) — wait a minute and try again');
      e.code = 'RATE_LIMITED';
      throw e;
    }
    const retryAfterHeader = res.headers.get('Retry-After');
    const retryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : null;
    const waitMs = retryAfter
      ? retryAfter * 1000
      : Math.min(30000, 4000 * Math.pow(2, attempt));
    await new Promise(r => setTimeout(r, waitMs));
    return _callClaudeOnce(sys, user, maxTok, webSearch, attempt + 1, opts);
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
      const e = new Error('The AI is busy (rate limit) — wait a minute and try again');
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

// ── Vorlana progress UI ────────────────────────────────────
function renderBrainProgress(steps, activeIdx, headerLabel, headerSub) {
  return '<div class="brain-panel">' +
    '<div class="brain-header">' +
      '<div class="brain-icon">🧠</div>' +
      '<div><div class="brain-title">' + escapeHTML(headerLabel || 'Vorlana — working') + '</div>' +
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
  // a heading written straight above its text (no blank line) still becomes a heading
  const blocks = [];
  cleaned.split(/\n\n+/).forEach(b => {
    const ls = b.trim().split('\n');
    if (ls.length > 1 && headings.has(ls[0].trim())) { blocks.push(ls[0].trim()); blocks.push(ls.slice(1).join('\n')); }
    else blocks.push(b);
  });
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
    raw = await callClaude(sys, prompt, maxTok, webSearch, opts.ai);
  } catch (e) {
    if (e.message === 'AI_PLAN_GATE') { container.innerHTML = ''; return null; }
    if (e.code === 'RATE_LIMITED' || /rate.?limit/i.test(e.message || '') || /tokens per minute/i.test(e.message || '')) {
      container.innerHTML =
        '<div class="brain-panel" style="border-color:rgba(245,158,11,.4)">' +
          '<div class="brain-header">' +
            '<div class="brain-icon" style="background:rgba(245,158,11,.18);animation:none">⏳</div>' +
            '<div>' +
              '<div class="brain-title" style="color:var(--amber)">Vorlana is busy</div>' +
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

// ── Small shared helpers for event-aware agents ──────────────
function _isoDay(d) { return d.toISOString().slice(0, 10); }
function _r1(v) { return Math.round(v * 10) / 10; }
function _fbEventId(f) { return String(f.eventId || f.event_id || ''); }
function _inRange(dateStr, from, to) {
  if (!from) return true;
  if (!dateStr) return false;
  const d = String(dateStr).slice(0, 10);
  return d >= from && d <= to;
}

// ── Specific agents ──────────────────────────────────────────

// Morning briefing — reads caseload AND events, feedback, volunteer hours.
// Every fact is computed here; the AI only turns it into a briefing.
// Which parts of Vorlana this organisation uses (Settings → What you do).
// Agents only read and talk about switched-on areas.
function orgUses(k) {
  const m = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.modules) || {};
  return m[k] !== false;
}
function orgPeople() { return orgUses('participants') ? (DB.participants || []) : []; }

// Circular facts every agent can use (figures calculated in circular.js)
async function orgCircularFacts(from, to) {
  if (!orgUses('circular') || typeof cxReportLoad !== 'function') return null;
  try { await cxReportLoad(); } catch (e) { return null; }
  if (typeof CXR === 'undefined' || !CXR.ok) return null;
  const s = cxReportStats({ from: from || null, to: to || null });
  return s && s.entries ? s : null;
}

async function runMorningBriefing() {
  const el = $('mb-body'); if (!el) return;

  const uses = { people: orgUses('participants'), events: orgUses('events'), vols: orgUses('volunteers'), funders: orgUses('funders'), circular: orgUses('circular') };
  const P  = uses.people ? (DB.participants || []) : [];
  const E  = uses.events ? (DB.events || []) : [];
  const FB = uses.events ? (DB.feedback || []) : [];
  const H  = uses.vols ? (DB.volunteer_hours || []) : [];
  const C  = uses.funders ? (DB.contracts || []) : [];

  const now = new Date();
  const today = _isoDay(now);
  const in7 = new Date(now); in7.setDate(in7.getDate() + 7);
  const ago30 = new Date(now); ago30.setDate(ago30.getDate() - 30);
  const from30 = _isoDay(ago30);
  const fmtDay = d => new Date(d).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  const names = arr => arr.map(p => p.first_name + ' ' + p.last_name).join(', ') || 'none';
  const lines = ['Today: ' + now.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long' })];
  const steps = [];
  let chase = 0;

  // ── Caseload ──
  if (uses.people) {
    const active = P.filter(p => p.stage !== 'Closed');
    const atRisk = active.filter(p => p.risk === 'High' || days(p.last_contact) > 21);
    const jobReady = P.filter(p => p.stage === 'Job Ready');
    chase += atRisk.length;
    steps.push({ label: 'Reading caseload', meta: active.length + ' active participants' });
    lines.push('', 'CASELOAD', 'Active participants: ' + active.length, 'At risk (high risk or no contact 21+ days): ' + names(atRisk), 'Job ready: ' + names(jobReady));
  }

  // ── Events and feedback ──
  if (uses.events) {
    const upcoming = E.filter(e => e.date && e.date >= today && e.date <= _isoDay(in7)).sort((a, b) => a.date.localeCompare(b.date));
    const recent = E.filter(e => e.date && e.date >= from30 && e.date <= today);
    const recentAtt = recent.reduce((a, e) => a + num(e.attendees), 0);
    const fbByEvent = {};
    FB.forEach(f => { const k = _fbEventId(f); fbByEvent[k] = (fbByEvent[k] || 0) + 1; });
    const hoursByEvent = {};
    H.forEach(h => { if (h.event_id) hoursByEvent[String(h.event_id)] = 1; });
    const noFeedback = recent.filter(e => !fbByEvent[String(e.id)]);
    const noHours = uses.vols ? recent.filter(e => !hoursByEvent[String(e.id)]) : [];
    const recentIds = {}; recent.forEach(e => { recentIds[String(e.id)] = 1; });
    const recentFb = FB.filter(f => recentIds[_fbEventId(f)]);
    const fbN = recentFb.length;
    const withCb = recentFb.filter(f => f.cb != null && f.ca != null);
    const cb = withCb.length ? _r1(withCb.reduce((a, f) => a + num(f.cb), 0) / withCb.length) : 0;
    const ca = withCb.length ? _r1(withCb.reduce((a, f) => a + num(f.ca), 0) / withCb.length) : 0;
    chase += noFeedback.length;
    steps.push({ label: 'Reading events & feedback', meta: recent.length + ' events in last 30 days · ' + upcoming.length + ' this week' });
    lines.push('', 'EVENTS',
      'Coming up in the next 7 days: ' + (upcoming.map(e => e.name + ' (' + fmtDay(e.date) + ')').join(', ') || 'none'),
      'Delivered in the last 30 days: ' + recent.length + ' events, ' + recentAtt + ' attendances',
      'Recent sessions with NO feedback collected: ' + (noFeedback.map(e => e.name).join(', ') || 'none'),
      uses.vols ? 'Recent sessions with NO volunteer hours logged: ' + (noHours.map(e => e.name).join(', ') || 'none') : '',
      '', 'FEEDBACK (last 30 days)',
      fbN ? (fbN + ' responses' + (withCb.length ? '; confidence ' + cb + ' → ' + ca + ' out of 5' : '')) : 'No feedback in the last 30 days');
  }

  // ── Volunteers ──
  if (uses.vols) {
    const recentHours = H.filter(h => _inRange(h.date, from30, today));
    const hrs30 = _r1(recentHours.reduce((a, h) => a + num(h.hours), 0));
    const perVol = {};
    recentHours.forEach(h => { const k = String(h.volunteer_id); perVol[k] = (perVol[k] || 0) + num(h.hours); });
    const topId = Object.keys(perVol).sort((a, b) => perVol[b] - perVol[a])[0];
    const topVol = topId ? (DB.volunteers || []).find(v => String(v.id) === topId) : null;
    steps.push({ label: 'Reading volunteer hours', meta: hrs30 + ' hours in 30 days' });
    lines.push('', 'VOLUNTEERS (last 30 days)', hrs30 ? (hrs30 + ' hours from ' + Object.keys(perVol).length + ' volunteers') : 'No volunteer hours logged',
      topVol ? ('Most hours: ' + topVol.name + ' (' + _r1(perVol[topId]) + 'h)') : '');
  }

  // ── Circular economy ──
  if (uses.circular && typeof cxReportLoad === 'function') {
    try {
      await cxReportLoad();
      if (typeof CXR !== 'undefined' && CXR.ok && CXR.items.length) {
        const acts = {}; CXR.acts.forEach(a => { acts[a.id] = a; });
        const items = CXR.items.filter(i => acts[i.activity_id]);
        const open = items.filter(i => !i.outcome_type);
        const tracked = open.filter(i => circMode(acts[i.activity_id]) === 'tracked');
        const stuck = tracked.filter(i => cxDays(i.updated_at) > 14);
        const byStage = {};
        stuck.forEach(i => { const s = cxStage(acts[i.activity_id], i.stage); const k = acts[i.activity_id].name + ' — ' + (s ? s.label : 'unknown step'); byStage[k] = (byStage[k] || 0) + 1; });
        const undecided = open.filter(i => circMode(acts[i.activity_id]) === 'tally');
        const lastStage = i => { const st = acts[i.activity_id].stages || []; return st.length && i.stage === st[st.length - 1].key; };
        const ready = tracked.filter(lastStage);
        // details that should have been recorded at a step the item has passed
        let missing = 0;
        tracked.concat(items.filter(i => i.outcome_type && circMode(acts[i.activity_id]) === 'tracked')).forEach(i => {
          const a = acts[i.activity_id], st = a.stages || [];
          const cur = i.outcome_type ? st.length : st.findIndex(s => s.key === i.stage);
          (a.fields || []).forEach(f => { const at = cxFieldStage(a, f); const idx = st.findIndex(s => s.key === at); if (at && idx >= 0 && cur > idx) { const v = (i.custom || {})[f.key]; if (v == null || v === '') missing++; } });
        });
        const week = cxReportStats({ from: _isoDay(new Date(Date.now() - 7 * 864e5)), to: today });
        let colsSoon = [], colsWaiting = 0;
        try {
          const { data } = await cxFrom('circular_collections').select('*').eq('org_id', orgId);
          (data || []).forEach(c => {
            if (c.status === 'scheduled' && c.scheduled_date && c.scheduled_date >= today && c.scheduled_date <= _isoDay(in7)) colsSoon.push((c.donor_org || c.donor_name || 'Donor') + ' (' + fmtDay(c.scheduled_date) + ')');
            if (c.status === 'requested') colsWaiting++;
          });
        } catch (e) { /* collections optional */ }
        chase += stuck.length + (undecided.length ? 1 : 0) + colsWaiting;
        steps.push({ label: 'Reading circular activity', meta: open.length + ' items in progress · ' + cxFmt(week ? week.kg : 0, 1) + ' kg this week' });
        lines.push('', 'CIRCULAR ECONOMY',
          'Last 7 days: ' + (week && week.entries ? week.finished + ' entries finished, ' + week.kg + ' kg diverted' + (week.foodKg ? ', ' + week.foodKg + ' kg food shared (about ' + week.meals + ' meals)' : '') + (week.fixRate != null ? ', repair fix rate ' + week.fixRate + '%' : '') : 'nothing logged'),
          'Items waiting more than 14 days at a step: ' + (stuck.length ? Object.keys(byStage).map(k => byStage[k] + ' at ' + k).join('; ') : 'none'),
          'Items ready to go out (at the last step): ' + (ready.length || 'none'),
          'Entries with no destination recorded (need sorting): ' + (undecided.length || 'none'),
          'Details missing at steps already passed (e.g. wipe certificate, PAT): ' + (missing || 'none'),
          'Collections booked for the next 7 days: ' + (colsSoon.join(', ') || 'none'),
          'Collection requests not yet scheduled: ' + (colsWaiting || 'none'));
      }
    } catch (e) { console.warn('[briefing] circular skipped', e); }
  }

  // ── Contracts ──
  if (uses.funders && C.length) {
    const prog = C.filter(c => c.status !== 'closed').map(c => {
      const bits = [];
      if (num(c.target_starts)) bits.push(num(c.actual_starts) + '/' + num(c.target_starts) + ' starts');
      if (num(c.target_outcomes)) bits.push(num(c.actual_outcomes) + '/' + num(c.target_outcomes) + ' outcomes');
      let elapsed = '';
      if (c.start_date && c.end_date) { const a = new Date(c.start_date), b = new Date(c.end_date); elapsed = ', ' + Math.max(0, Math.min(100, Math.round((now - a) / (b - a) * 100))) + '% of the contract period gone'; }
      return c.name + (bits.length ? ': ' + bits.join(', ') : ': no numeric targets') + elapsed;
    });
    steps.push({ label: 'Checking contracts', meta: C.length + ' contracts' });
    lines.push('', 'CONTRACTS', prog.join('\n') || 'none');
  }

  // ── Deadlines, money and volunteer checks (ai-office.js, demo account) ──
  let extra = null;
  if (typeof window.vlBriefingExtra === 'function') {
    try { extra = await window.vlBriefingExtra(); } catch (e) { extra = null; }
    if (extra && extra.lines && extra.lines.length) {
      chase += extra.count || 0;
      steps.push({ label: 'Checking deadlines, budgets, donations and volunteers', meta: (extra.count || 0) + ' to look at' });
      lines.push('', 'DEADLINES AND CHECKS', extra.lines.join('\n'));
    }
  }

  if (steps.length === 0) { el.innerHTML = '<div class="alert alert-info">Switch on the areas you work in (Settings → What you do) and the briefing will cover them.</div>'; return; }
  steps.push({ label: "Spotting today's priorities", meta: chase + ' things to chase' }, { label: 'Ready', meta: '' });

  const areas = [uses.people && 'caseload', uses.events && 'events and feedback', uses.vols && 'volunteers', uses.circular && 'circular economy (reuse, repair, growing, collections)', uses.funders && 'contracts'].filter(Boolean).join(', ');
  const sys = 'Generate a warm, practical morning briefing for a UK charity or community organisation manager. Use **bold** for names and figures. ' +
    'Three short sections: Priority actions today, Wins to celebrate, One observation. ' +
    'This organisation works in: ' + areas + '. Only talk about those areas — never mention participants, caseload or anything else not listed. ' +
    'Priority actions must be concrete and doable today, taken from the facts: e.g. chase named people, collect feedback for named sessions, log hours, ' +
    'move items that have waited too long, sort entries with no destination, fill in missing wipe certificates, confirm upcoming collections. ' +
    (extra ? 'Put anything in DEADLINES AND CHECKS marked URGENT first in Priority actions, then the other checks. ' : '') +
    'Use ONLY the facts given; never invent people, events, items or numbers. If a line says none, do not mention it. ' +
    'Max 220 words. Do not use ## headings or hashtags.';

  const raw = await runAgent({
    container: el,
    headerLabel: 'Vorlana — Morning Briefing',
    headerSub: 'Reading ' + areas,
    steps, sys, prompt: lines.join('\n').replace(/\n{3,}/g, '\n\n'), maxTok: 420
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
  let FB = DB.feedback || [];
  const evFilter = $('fb-filter-ev') && $('fb-filter-ev').value;
  if (evFilter) FB = FB.filter(f => String(f.eventId) === String(evFilter));
  if (!FB.length) { el.innerHTML = '<div class="alert alert-info">No feedback data yet. Add responses first.</div>'; return; }

  // v11: read the org's OWN questions (same numbers as the Feedback page cards).
  // Nothing is computed by the AI — code works out every figure, the AI writes prose.
  const hasMeasures = typeof measureStats === 'function' && typeof activeMeasures === 'function' && activeMeasures().length;
  const lines = [];
  const caveats = [];
  let journeyTxt = '';
  if (hasMeasures) {
    const j = measureJourney(FB);
    if (j) journeyTxt = j.before + ' → ' + j.after;
    if (j) lines.push('Confidence before → after (1–5): ' + j.before + ' → ' + j.after + ' (' + j.n + ' answers)');
    measureStats(FB).forEach(st => {
      if (j && (st.m.maps_to === 'cb' || st.m.maps_to === 'ca')) return;
      const q = st.m.question;
      if (st.kind === 'score') lines.push('"' + q + '": average ' + st.avg.toFixed(1) + ' / 5, ' + st.pctHigh + '% rated 4–5 (' + st.n + ' answers)');
      else if (st.kind === 'yesno') {
        lines.push('"' + q + '": ' + st.pctYes + '% yes (' + st.n + ' answers)');
        if (st.pctYes === 100 && st.n >= 20) caveats.push('"' + q + '"');
      }
      else lines.push('"' + q + '": most common answer "' + st.breakdown[0][0] + '" (' + st.breakdown[0][1] + ' of ' + st.n + ')' + (st.breakdown[1] ? ', then "' + st.breakdown[1][0] + '" (' + st.breakdown[1][1] + ')' : ''));
    });
  } else {
    const avg = k => { const v = FB.map(f => f[k]).filter(x => x != null && x !== '' && num(x) > 0).map(num); return v.length ? (v.reduce((a, b) => a + b, 0) / v.length).toFixed(1) : null; };
    const cb = avg('cb'), ca = avg('ca');
    if (cb && ca) { journeyTxt = cb + ' → ' + ca; lines.push('Confidence before → after (1–5): ' + cb + ' → ' + ca); }
    const en = FB.filter(f => f.enjoyed != null && num(f.enjoyed) > 0);
    if (en.length) lines.push('Enjoyed (rated 4–5): ' + pct(en.filter(f => num(f.enjoyed) >= 4).length, en.length) + '% of ' + en.length);
    ['learned', 'connected', 'friend'].forEach(k => lines.push({ learned: 'Learned something new', connected: 'Felt more connected', friend: 'Made a new friend' }[k] + ': ' + pct(FB.filter(f => f[k]).length, FB.length) + '%'));
  }
  const quotes = (typeof measureQuotes === 'function' ? measureQuotes(FB) : FB.filter(f => f.quote).map(f => ({ quote: f.quote })))
    .map(q => q.quote).filter(q => q.length > 12 && !/^(nothing|none|n\/?a|no|not really|all good)\b/i.test(q));
  const sample = quotes.sort(() => 0.5 - Math.random()).slice(0, 12);
  const events = new Set(FB.map(f => String(f.eventId))).size;

  const steps = [
    { label: 'Reading feedback responses', meta: FB.length + ' responses · ' + events + ' sessions' },
    { label: 'Working out the figures', meta: journeyTxt ? 'Confidence: ' + journeyTxt : lines.length + ' measures' },
    { label: 'Writing board summary', meta: '' },
    { label: 'Ready', meta: '' }
  ];
  const sys = 'You are a UK programme evaluation expert writing for a charity board. Write a 150-200 word summary. ' +
    'Use ONLY the figures given — never invent, round differently or recalculate them. Quote each question in plain words, not word-for-word. ' +
    'Lead with the strongest evidence of change. If a caveat is listed, mention it briefly and do not present that figure as evidence. ' +
    'You may paraphrase themes from the comments but do not quote a comment unless it is in the list. ' +
    'Use **bold** for key figures. End with one practical recommendation. No hashtags, no markdown headings, British English.';
  const prompt =
    'Responses: ' + FB.length + ' across ' + events + ' sessions\n\n' +
    'Figures:\n- ' + lines.join('\n- ') +
    (caveats.length ? '\n\nCaveat: every answer to ' + caveats.join(' and ') + ' was "Yes" — the form may only have offered Yes, so these are not reliable evidence.' : '') +
    (sample.length ? '\n\nA sample of participant comments:\n- ' + sample.join('\n- ') : '');
  const raw = await runAgent({
    container: el,
    headerLabel: 'Feedback Analyst Agent',
    headerSub: 'Surfacing themes from participant feedback',
    steps, sys, prompt, maxTok: 600
  });
  if (raw) aiResult(el, raw);
}

async function runOutcomesAnalyst() {
  const el = $('outcomes-analyst-result'); if (!el) return;
  if (!orgUses('participants')) { el.innerHTML = '<div class="alert alert-info">This agent works on your caseload. Switch on Participants in Settings → What you do to use it.</div>'; return; }
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
  if (!orgUses('participants')) { el.innerHTML = '<div class="alert alert-info">This agent works on your caseload. Switch on Participants in Settings → What you do to use it.</div>'; return; }
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
  if (!orgUses('participants')) { el.innerHTML = '<div class="alert alert-info">This agent works on your caseload. Switch on Participants in Settings → What you do to use it.</div>'; return; }
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
  if (!orgUses('participants')) { el.innerHTML = '<div class="alert alert-info">This agent works on your caseload. Switch on Participants in Settings → What you do to use it.</div>'; return; }
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
// NOTE: js/extensions/reporting-periods.js replaces this at startup with a
// period-aware, contract-scoped version. This is the fallback.
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
  const P = DB.participants;
  // Only events (and their feedback) linked to this contract
  const E = (DB.events || []).filter(e => toArr(e.contract_ids).map(String).includes(String(contractId)));
  const evIds = {};
  E.forEach(e => { evIds[String(e.id)] = 1; });
  const FB = (DB.feedback || []).filter(f => evIds[_fbEventId(f)]);
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
    { label: 'Writing the report', meta: 'Vorlana composing narrative with your live numbers' },
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
    'Events delivered under this contract: ' + E.length,
    avgCB ? 'Average confidence before: ' + avgCB + ' / 5' : '',
    avgCA ? 'Average confidence after: ' + avgCA + ' / 5' : '',
    'Feedback responses: ' + FB.length
  ].filter(Boolean).join('\n');

  const raw = await runAgent({
    container: progressEl,
    headerLabel: 'Vorlana — Funder Report',
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
      '<div class="report-footer">Generated with Vorlana · ' + escapeHTML(todayStr) + '</div>' +
    '</div>';

  reportEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function downloadReportPDF() {
  if (!_lastReportText && !window._lastReportText) {
    alert('Generate a report first before downloading.');
    return;
  }
  const orig = document.title;
  document.title = (_lastReportTitle || window._lastReportTitle || 'Vorlana Report').replace(/[^a-z0-9 \-]/gi, '').slice(0, 80);
  // The delivery report brings its own page margins (a repeating top and bottom gap), so the browser's page margin can be zero:
  // with no margin there is no room for the browser's URL and date header and footer.
  let st = null;
  if (document.querySelector('#report-output .pf')) {
    st = document.createElement('style'); st.id = 'vl-print-margin'; st.textContent = '@page{size:A4;margin:0}';
    document.head.appendChild(st);
  }
  const done = () => { document.title = orig; if (st) st.remove(); };
  window.addEventListener('afterprint', done, { once: true });
  setTimeout(() => {
    window.print();
    setTimeout(done, 60000);
  }, 100);
}

function copyReportText() {
  const el = document.querySelector('#report-output .report-body');
  if (!el) return;
  navigator.clipboard.writeText(el.innerText);
  const btn = $('copy-report-btn');
  if (btn) { const orig = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => btn.textContent = orig, 2000); }
}

// ── Social Impact report ─────────────────────────────────────
// Button on the Social Impact tab. The whole organisation's impact:
// people & outcomes, events & attendance, volunteers & hours, feedback,
// participant quotes. Code computes every figure; the AI writes prose.

function _impactRange(key) {
  const now = new Date();
  if (key === '12m') {
    const a = new Date(now); a.setFullYear(a.getFullYear() - 1);
    return { from: _isoDay(a), to: _isoDay(now), label: 'the last 12 months' };
  }
  if (key === 'year') {
    return { from: now.getFullYear() + '-01-01', to: _isoDay(now), label: now.getFullYear() + ' to date' };
  }
  if (key === 'quarter') {
    const q = Math.floor(now.getMonth() / 3); // current quarter index 0-3
    let y = now.getFullYear(), pq = q - 1;
    if (pq < 0) { pq = 3; y -= 1; }
    const s = new Date(y, pq * 3, 1);
    const e = new Date(y, pq * 3 + 3, 0);
    return { from: _isoDay(s), to: _isoDay(e), label: 'Q' + (pq + 1) + ' ' + y };
  }
  return { from: null, to: null, label: 'all activity to date' };
}

function _impactStats(r) {
  const P = orgPeople().filter(p => !r.from || _inRange(p.last_contact || p.created_at, r.from, r.to));
  const E = (DB.events || []).filter(e => _inRange(e.date, r.from, r.to));
  const evIds = {};
  E.forEach(e => { evIds[String(e.id)] = 1; });
  const FB = (DB.feedback || []).filter(f => !r.from || evIds[_fbEventId(f)]);
  const H = (DB.volunteer_hours || []).filter(h => _inRange(h.date, r.from, r.to));

  const withOutcome = P.filter(p => toArr(p.outcomes).length > 0).length;
  const att = E.reduce((a, e) => a + num(e.attendees), 0);
  const cap = capacityTracked() ? E.reduce((a, e) => a + num(e.capacity), 0) : 0;
  const byType = {};
  E.forEach(e => { const t = e.type || 'Other'; byType[t] = (byType[t] || 0) + 1; });

  const volIds = {};
  H.forEach(h => { volIds[String(h.volunteer_id)] = 1; });
  const hours = H.reduce((a, h) => a + num(h.hours), 0);

  const fbN = FB.length;
  const avg = k => fbN ? _r1(FB.reduce((a, f) => a + num(f[k]), 0) / fbN) : 0;
  const share = test => fbN ? pct(FB.filter(test).length, fbN) : 0;

  return {
    range: r,
    participants: P.length,
    withOutcome: withOutcome,
    outcomeRate: pct(withOutcome, P.length),
    jobs: P.filter(p => toArr(p.outcomes).includes('Employment')).length,
    sustained: P.filter(p => p.stage === 'Sustained').length,
    events: E.length,
    attendances: att,
    fill: cap ? pct(att, cap) : null,
    byType: byType,
    volunteers: Object.keys(volIds).length,
    hours: _r1(hours),
    value: hours * VOL_HOUR_RATE,
    fbN: fbN,
    enjoyed: avg('enjoyed'),
    cb: avg('cb'),
    ca: avg('ca'),
    improved: share(f => num(f.ca) > num(f.cb)),
    learned: share(f => f.learned),
    connected: share(f => f.connected),
    friend: share(f => f.friend),
    quotes: FB.filter(f => f.quote && String(f.quote).trim().length > 15).map(f => String(f.quote).trim())
  };
}

async function generateImpactReport() {
  const out = $('ir-out'); if (!out) return;
  const key = ($('ir-period') && $('ir-period').value) || 'all';
  const s = _impactStats(_impactRange(key));
  if (typeof cxReportLoad === 'function') { try { await cxReportLoad(); } catch (e) { /* optional */ } }
  const circ = (typeof cxReportStats === 'function') ? cxReportStats({ from: s.range.from || null, to: s.range.to || null }) : null;
  const hasCirc = !!(circ && circ.entries);

  if (!s.participants && !s.events && !s.fbN && !s.hours && !hasCirc) {
    out.innerHTML = '<div class="alert alert-warn">No activity recorded for this period yet.</div>';
    return;
  }

  const orgName = (currentOrg && currentOrg.name) || 'Organisation';
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
  const money = v => '£' + Math.round(v).toLocaleString('en-GB');

  const gaps = [];
  if (s.events && !s.fbN) gaps.push('No feedback was collected at events in this period.');
  if (s.events && s.fill == null && capacityTracked()) gaps.push('Event capacity was not recorded, so an attendance rate is not given.');
  if (s.events && !s.hours) gaps.push('No volunteer hours were logged in this period.');
  if (hasCirc) cxReportGaps(circ).forEach(g => gaps.push(g));

  const steps = [
    { label: 'Calculating your impact', meta: s.participants + ' participants · ' + s.events + ' events · ' + s.fbN + ' feedback' },
    { label: 'Checking data completeness', meta: gaps.length ? gaps.length + ' gap(s)' : 'complete' },
    { label: 'Writing the story', meta: 'Vorlana composing from verified numbers' },
    { label: 'Ready', meta: '' }
  ];

  const sys = 'You are a UK charity impact writer producing a Social Impact report for a board, funders and supporters. ' +
    'Warm but professional British English. Sections, each beginning with ## and the title: ' +
    'Our Impact at a Glance, People We Supported, Community & Events, Our Volunteers, ' + (hasCirc ? 'Waste, Reuse & Food, ' : '') + 'What People Told Us, Looking Ahead. ' +
    (hasCirc ? 'In Waste, Reuse & Food use only the circular figures supplied and say CO2e and value are estimates. ' : '') +
    'CRITICAL: use ONLY the figures given — never invent, estimate or recalculate a number. ' +
    'Use the quotes supplied verbatim; never invent quotes. Omit any section with no data rather than padding it. ' +
    'If data gaps are listed, mention them briefly at the end. ' +
    '500-700 words. **bold** for headline figures. No hashtags except section markers, no emoji.';

  const prompt = [
    'Organisation: ' + orgName,
    'Period: ' + s.range.label + (s.range.from ? ' (' + s.range.from + ' to ' + s.range.to + ')' : ''),
    '',
    'PEOPLE',
    'Participants supported: ' + s.participants,
    s.participants ? 'Participants with an outcome: ' + s.withOutcome + ' (' + s.outcomeRate + '%)' : '',
    s.participants ? 'Into employment: ' + s.jobs + ' · sustained: ' + s.sustained : '',
    '',
    'EVENTS',
    'Events delivered: ' + s.events,
    s.events ? 'Total attendances: ' + s.attendances : '',
    s.fill != null ? 'Attendance against capacity: ' + s.fill + '%' : '',
    s.events ? 'By type: ' + Object.keys(s.byType).map(k => k + ' ' + s.byType[k]).join(', ') : '',
    '',
    'VOLUNTEERS',
    'Active volunteers: ' + s.volunteers,
    'Hours given: ' + s.hours,
    s.hours ? 'Value of volunteer time: ' + money(s.value) + ' (at £' + VOL_HOUR_RATE.toFixed(2) + '/hour, UK Living Wage)' : '',
    '',
    'FEEDBACK',
    'Responses: ' + s.fbN,
    s.fbN ? 'Average enjoyment: ' + s.enjoyed + ' / 5' : '',
    s.fbN ? 'Confidence before ' + s.cb + ' → after ' + s.ca + ' (out of 5)' : '',
    s.fbN ? 'Felt more confident: ' + s.improved + '% · learned something new: ' + s.learned + '% · felt more connected: ' + s.connected + '% · made a friend: ' + s.friend + '%' : '',
    s.quotes.length ? 'Quotes (use verbatim):\n' + s.quotes.slice(0, 4).map(q => '- "' + q + '"').join('\n') : '',
    hasCirc ? cxReportLines(circ).join('\n') : '',
    '',
    gaps.length ? 'DATA GAPS:\n' + gaps.map(g => '- ' + g).join('\n') : ''
  ].filter(Boolean).join('\n');

  const raw = await runAgent({
    container: out,
    headerLabel: 'Vorlana — Social Impact Report',
    headerSub: s.range.label,
    steps, sys, prompt, maxTok: 1300
  });
  if (!raw) return;

  const cleaned = cleanReportText(raw);
  const body = reportTextToHTML(cleaned, raw);
  const logo = getOrgLogoUrl(currentOrg);

  const figs = [
    s.participants ? ['Participants', s.participants] : null,
    s.withOutcome ? ['Outcomes', s.withOutcome] : null,
    s.events ? ['Events', s.events] : null,
    s.attendances ? ['Attendances', s.attendances] : null,
    s.volunteers ? ['Volunteers', s.volunteers] : null,
    s.hours ? ['Volunteer hours', s.hours] : null,
    s.hours ? ['Value of time', money(s.value)] : null,
    s.fbN ? ['Feedback', s.fbN] : null,
    hasCirc ? ['Kg diverted', circ.kg] : null,
    hasCirc && circ.co2 ? ['CO₂e avoided (t)', Math.round(circ.co2 / 100) / 10] : null,
    hasCirc && circ.foodKg ? ['Meals shared', circ.meals] : null
  ].filter(Boolean);

  const docHTML =
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:20px;border-bottom:3px solid #1F6F6D;padding-bottom:14px;margin-bottom:18px">' +
      '<div>' +
        '<div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#1F6F6D;font-weight:700">Social Impact Report · ' + escapeHTML(s.range.label) + '</div>' +
        '<div style="font-size:26px;font-weight:800;color:#175655;margin-top:4px">' + escapeHTML(orgName) + '</div>' +
        '<div style="font-size:12px;color:#777">' + escapeHTML(today) + '</div>' +
      '</div>' +
      (logo ? '<img src="' + escapeHTML(logo) + '" alt="" style="max-height:60px;max-width:160px" onerror="this.remove()"/>' : '') +
    '</div>' +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">' +
      figs.map(f =>
        '<div style="border:1px solid #ddd;border-radius:8px;padding:10px;text-align:center">' +
          '<div style="font-size:22px;font-weight:800;color:#1F6F6D">' + escapeHTML(String(f[1])) + '</div>' +
          '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#777;font-weight:700">' + escapeHTML(f[0]) + '</div></div>'
      ).join('') +
    '</div>' +
    body +
    (hasCirc ? cxReportDocHTML(circ, 'Circular economy') : '') +
    '<p style="font-size:11px;color:#888;margin-top:20px;border-top:1px solid #eee;padding-top:10px">' +
      'All figures calculated directly from records held in Vorlana. Volunteer time valued at £' + VOL_HOUR_RATE.toFixed(2) +
      ' per hour (UK Living Wage). Generated by Vorlana · ' + escapeHTML(today) + '</p>';

  _lastImpact = { html: docHTML, text: cleaned, title: orgName + ' — Social Impact Report (' + s.range.label + ')' };

  out.innerHTML =
    '<div style="display:flex;gap:8px;margin:14px 0;flex-wrap:wrap">' +
      '<button class="btn btn-p btn-sm" onclick="printImpactReport()">⬇ Download as PDF</button>' +
      '<button class="btn btn-ghost btn-sm" id="ir-copy" onclick="copyImpactReport()">📋 Copy text</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="generateImpactReport()">↻ Regenerate</button>' +
    '</div>' +
    '<div class="card" style="background:#fff;color:#222;font-family:Georgia,serif;line-height:1.7;padding:32px">' + docHTML + '</div>';

  out.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function printImpactReport() {
  if (!_lastImpact) { alert('Generate the impact report first.'); return; }
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) { alert('Pop-up blocked — please allow pop-ups to download the PDF.'); return; }
  w.document.write(
    '<!doctype html><html><head><title>' + escapeHTML(_lastImpact.title) + '</title>' +
    '<style>@page{size:A4;margin:16mm}body{font-family:Georgia,serif;color:#222;line-height:1.7;margin:0}' +
    'h3{color:#175655;margin-top:22px}strong{color:#175655}</style></head><body>' +
    _lastImpact.html +
    '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},300);};</scr' + 'ipt>' +
    '</body></html>'
  );
  w.document.close();
}

function copyImpactReport() {
  if (!_lastImpact) return;
  navigator.clipboard.writeText(_lastImpact.text);
  const btn = $('ir-copy');
  if (btn) { const o = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => btn.textContent = o, 2000); }
}

// ── Social Media Studio ──────────────────────────────────────
// Posts written from REAL data: a specific event (attendance, volunteer
// hours, feedback, quotes), the org's impact for a period, a volunteer
// thank-you, or an upcoming event to promote. All platforms drafted at once.
//
// Rules baked in:
//   • Numbers are computed here; the AI never invents or recalculates them.
//   • Quotes are opt-in (unticked by default) and always anonymous.
//   • Participants are never named.
//   • Photos stay in the browser — never uploaded or stored.

const SOCIAL_PLATFORMS = {
  linkedin:  { label: 'LinkedIn',  icon: '💼', limit: 3000, guide: 'professional and warm; 120-220 words; short paragraphs with line breaks; up to 4 hashtags at the very end' },
  instagram: { label: 'Instagram', icon: '📸', limit: 2200, guide: 'warm and visual; 60-140 words; short lines; a few emoji at most; up to 10 hashtags on their own at the end' },
  facebook:  { label: 'Facebook',  icon: '👍', limit: 2000, guide: 'friendly community tone; 50-120 words; a clear call to action; hashtags optional, max 2' },
  x:         { label: 'X',         icon: '✖️', limit: 280,  guide: 'one punchy post, UNDER 260 characters in total including any hashtags; max 2 hashtags' }
};

let _socialPhoto = null;   // data URL of the user's own photo (browser only)
let _socialPosts = {};     // { platform: text }
let _socialEventId = null; // event the current posts relate to
let _socialDrafts = [];

function _socialToday() { return _isoDay(new Date()); }

// Called when the Social Media page opens (from the sidebar button).
function renderSocial() {
  if (orgUses('circular') && typeof cxReportLoad === 'function') cxReportLoad().then(() => { try { socialRefreshFacts(); } catch (e) { /* page may have changed */ } });
  const evSel = $('sm-event');
  if (evSel) {
    const cur = evSel.value;
    const today = _socialToday();
    const E = (DB.events || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    evSel.innerHTML = E.length
      ? E.map(e => '<option value="' + escapeHTML(String(e.id)) + '">' +
          escapeHTML(e.name) + ' · ' + escapeHTML(fmtD(e.date)) + (e.date && e.date > today ? ' (upcoming)' : '') +
        '</option>').join('')
      : '<option value="">No events yet</option>';
    if (cur) evSel.value = cur;
  }
  const volSel = $('sm-vol');
  if (volSel) {
    const cur = volSel.value;
    const V = (DB.volunteers || []).filter(v => (v.status || 'Active') === 'Active');
    volSel.innerHTML = V.length
      ? V.map(v => '<option value="' + escapeHTML(String(v.id)) + '">' + escapeHTML(v.name || 'Volunteer') + '</option>').join('')
      : '<option value="">No active volunteers</option>';
    if (cur) volSel.value = cur;
  }
  if ($('sm-plan-date') && !$('sm-plan-date').value) $('sm-plan-date').value = _socialToday();
  socialAboutChanged();
  loadSocialDrafts();
}

function socialAboutChanged() {
  const about = ($('sm-about') && $('sm-about').value) || 'event';
  const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
  show('sm-event-wrap', about === 'event' || about === 'upcoming');
  show('sm-period-wrap', about === 'impact');
  show('sm-vol-wrap', about === 'volunteer');
  socialRefreshFacts();
}

// Everything the post may say — computed from the database.
function _socialFacts() {
  const about = ($('sm-about') && $('sm-about').value) || 'event';
  const out = { about: about, lines: [], quotes: [], chips: [], eventId: null };
  const FB = DB.feedback || [];
  const H = DB.volunteer_hours || [];

  if (about === 'event' || about === 'upcoming') {
    const ev = (DB.events || []).find(e => String(e.id) === String($('sm-event') && $('sm-event').value));
    if (!ev) return out;
    out.eventId = String(ev.id);
    const when = ev.date ? new Date(ev.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : '';
    out.lines.push('Event: ' + ev.name);
    if (ev.type) out.lines.push('Type: ' + ev.type);
    if (when) out.lines.push('Date: ' + when);
    if (ev.location) out.lines.push('Location: ' + ev.location);

    if (about === 'upcoming') {
      out.lines.push('This event has NOT happened yet — the post should invite people to come.');
      if (num(ev.capacity)) out.lines.push('Places available: ' + Math.max(0, num(ev.capacity) - num(ev.attendees)) + ' of ' + num(ev.capacity));
      out.chips = [['📅', when || 'Date TBC'], ['📍', ev.location || 'Location TBC']];
      if (num(ev.capacity)) out.chips.push(['🎟️', num(ev.capacity) + ' places']);
      return out;
    }

    const hrs = H.filter(h => String(h.event_id) === out.eventId);
    const vols = {};
    hrs.forEach(h => { vols[String(h.volunteer_id)] = 1; });
    const hours = _r1(hrs.reduce((a, h) => a + num(h.hours), 0));
    const fb = FB.filter(f => _fbEventId(f) === out.eventId);
    const n = fb.length;

    if (num(ev.attendees)) out.lines.push('People who attended: ' + num(ev.attendees));
    if (Object.keys(vols).length) out.lines.push('Volunteers who helped: ' + Object.keys(vols).length + ', giving ' + hours + ' hours');
    if (n) {
      const avg = k => _r1(fb.reduce((a, f) => a + num(f[k]), 0) / n);
      out.lines.push('Feedback responses: ' + n);
      out.lines.push('Average enjoyment: ' + avg('enjoyed') + ' out of 5');
      out.lines.push('Confidence before ' + avg('cb') + ' → after ' + avg('ca') + ' (out of 5)');
      const l = pct(fb.filter(f => f.learned).length, n);
      const c = pct(fb.filter(f => f.connected).length, n);
      const fr = pct(fb.filter(f => f.friend).length, n);
      if (l) out.lines.push(l + '% learned something new');
      if (c) out.lines.push(c + '% felt more connected');
      if (fr) out.lines.push(fr + '% made a new friend');
      out.chips.push(['⭐', avg('enjoyed') + '/5 enjoyed']);
      out.chips.push(['📈', 'confidence ' + avg('cb') + ' → ' + avg('ca')]);
    }
    if (num(ev.attendees)) out.chips.unshift(['👥', num(ev.attendees) + ' attended']);
    if (hours) out.chips.push(['🙋', hours + 'h volunteered']);
    out.quotes = fb.filter(f => f.quote && String(f.quote).trim().length > 10).map(f => String(f.quote).trim());
    return out;
  }

  if (about === 'impact') {
    const s = _impactStats(_impactRange(($('sm-period') && $('sm-period').value) || '12m'));
    out.lines.push('Period: ' + s.range.label);
    if (s.participants) out.lines.push('People supported: ' + s.participants);
    if (s.withOutcome) out.lines.push('People achieving an outcome: ' + s.withOutcome);
    if (s.jobs) out.lines.push('Into employment: ' + s.jobs);
    if (s.events) out.lines.push('Events delivered: ' + s.events + ' with ' + s.attendances + ' attendances');
    if (s.volunteers) out.lines.push('Volunteers: ' + s.volunteers + ' giving ' + s.hours + ' hours');
    if (s.fbN) out.lines.push('Confidence before ' + s.cb + ' → after ' + s.ca + ' across ' + s.fbN + ' responses');
    const cx = (orgUses('circular') && typeof CXR !== 'undefined' && CXR.ok) ? cxReportStats({ from: s.range.from || null, to: s.range.to || null }) : null;
    if (cx && cx.entries) {
      out.lines.push('Diverted from waste: ' + cx.kg + ' kg' + (cx.reused ? ', ' + cx.reused + ' items reused or repaired' : ''));
      if (cx.foodKg) out.lines.push('Food shared: ' + cx.foodKg + ' kg (about ' + cx.meals + ' meals)');
      if (cx.co2) out.lines.push('Estimated CO2e avoided: ' + (Math.round(cx.co2 / 100) / 10) + ' tonnes (say it is an estimate)');
    }
    if (s.connected) out.lines.push(s.connected + '% felt more connected');
    out.chips = [
      s.participants ? ['👥', s.participants + ' supported'] : null,
      s.events ? ['📅', s.events + ' events'] : null,
      s.hours ? ['🙋', s.hours + 'h volunteered'] : null,
      s.fbN ? ['📈', 'confidence ' + s.cb + ' → ' + s.ca] : null,
      cx && cx.entries ? ['♻️', cx.kg + ' kg saved from waste'] : null,
      cx && cx.foodKg ? ['🥕', cx.meals + ' meals shared'] : null
    ].filter(Boolean);
    out.quotes = s.quotes;
    return out;
  }

  if (about === 'volunteer') {
    const v = (DB.volunteers || []).find(x => String(x.id) === String($('sm-vol') && $('sm-vol').value));
    if (!v) return out;
    const first = String(v.name || 'our volunteer').split(' ')[0];
    const hrs = H.filter(h => String(h.volunteer_id) === String(v.id));
    const hours = _r1(num(v.hours) + hrs.reduce((a, h) => a + num(h.hours), 0));
    const evIds = {};
    hrs.forEach(h => { if (h.event_id) evIds[String(h.event_id)] = 1; });
    const evNames = (DB.events || []).filter(e => evIds[String(e.id)]).map(e => e.name);
    out.lines.push('Volunteer first name (use first name only): ' + first);
    if (v.role) out.lines.push('Role: ' + v.role);
    if (hours) out.lines.push('Total hours given: ' + hours);
    if (evNames.length) out.lines.push('Helped at: ' + evNames.slice(0, 5).join(', '));
    if (toArr(v.skills).length) out.lines.push('Skills: ' + toArr(v.skills).join(', '));
    out.chips = [['🙋', first], hours ? ['⏱️', hours + ' hours'] : null, evNames.length ? ['📅', evNames.length + ' events'] : null].filter(Boolean);
    out.quotes = FB.filter(f => evIds[_fbEventId(f)] && f.quote && String(f.quote).trim().length > 10).map(f => String(f.quote).trim());
    out.lines.push('Make sure ' + first + ' is happy to be thanked publicly before posting.');
    return out;
  }

  // custom
  const tot = [];
  if (orgUses('participants')) tot.push('people supported: ' + (DB.participants || []).length);
  if (orgUses('events')) tot.push('events: ' + (DB.events || []).length);
  const cxAll = (orgUses('circular') && typeof CXR !== 'undefined' && CXR.ok) ? cxReportStats({}) : null;
  if (cxAll && cxAll.entries) tot.push('diverted from waste: ' + cxAll.kg + ' kg' + (cxAll.foodKg ? ', food shared: ' + cxAll.foodKg + ' kg' : ''));
  out.lines.push('Organisation totals — ' + (tot.join(', ') || 'none recorded yet'));
  out.quotes = FB.filter(f => f.quote && String(f.quote).trim().length > 10).map(f => String(f.quote).trim());
  return out;
}

function socialRefreshFacts() {
  const f = _socialFacts();
  const box = $('sm-facts');
  if (box) {
    box.innerHTML = f.chips.length
      ? '<div style="display:flex;gap:8px;flex-wrap:wrap;margin:4px 0 12px">' +
          f.chips.map(c => '<span style="font-size:12px;font-weight:600;padding:6px 12px;border-radius:20px;background:var(--bg);border:1px solid var(--border);color:var(--txt2)">' +
            c[0] + ' ' + escapeHTML(String(c[1])) + '</span>').join('') +
        '</div>'
      : '';
  }
  const qEl = $('sm-quotes');
  if (qEl) {
    const qs = f.quotes.slice(0, 8);
    qEl.innerHTML = qs.length
      ? qs.map((q, i) =>
          '<label style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--border);border-radius:9px;margin-bottom:8px;cursor:pointer;font-size:13px;color:var(--txt2);line-height:1.5;text-transform:none;letter-spacing:0;font-weight:400">' +
            '<input type="checkbox" class="sm-q" data-q="' + i + '" style="width:auto;margin-top:3px"/>' +
            '<span style="font-style:italic">"' + escapeHTML(q) + '"</span>' +
          '</label>'
        ).join('')
      : '<div style="font-size:13px;color:var(--txt3)">No feedback quotes for this yet.</div>';
    qEl._quotes = qs;
  }
}

function handleSocialPhoto(input) {
  const file = input && input.files && input.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { alert('That photo is over 8MB — please choose a smaller one.'); input.value = ''; return; }
  const r = new FileReader();
  r.onload = e => {
    _socialPhoto = e.target.result;
    const pv = $('sm-photo-preview');
    if (pv) pv.innerHTML = '<img src="' + _socialPhoto + '" style="max-height:120px;max-width:100%;border-radius:8px;border:1px solid var(--border)"/>' +
      '<div><button class="btn btn-ghost btn-sm" style="margin-top:6px" onclick="clearSocialPhoto()">Remove photo</button></div>';
    const cw = $('sm-consent-wrap'); if (cw) cw.style.display = 'block';
  };
  r.readAsDataURL(file);
}

function clearSocialPhoto() {
  _socialPhoto = null;
  if ($('sm-photo')) $('sm-photo').value = '';
  if ($('sm-photo-preview')) $('sm-photo-preview').innerHTML = '';
  if ($('sm-consent-wrap')) $('sm-consent-wrap').style.display = 'none';
  if ($('sm-consent')) $('sm-consent').checked = false;
  if (Object.keys(_socialPosts).length) renderSocialCards();
}

async function generateSocial() {
  const platforms = Array.prototype.slice.call(document.querySelectorAll('.sm-plat:checked')).map(c => c.value);
  if (!platforms.length) { alert('Pick at least one platform.'); return; }
  if (_socialPhoto && !($('sm-consent') && $('sm-consent').checked)) {
    alert('Please confirm everyone identifiable in the photo has agreed to it being shared — or remove the photo.');
    return;
  }

  const f = _socialFacts();
  const qEl = $('sm-quotes');
  const allQ = (qEl && qEl._quotes) || [];
  const picked = Array.prototype.slice.call(document.querySelectorAll('.sm-q:checked'))
    .map(cb => allQ[parseInt(cb.getAttribute('data-q'), 10)]).filter(Boolean);

  const tone = ($('sm-tone') && $('sm-tone').value) || 'warm';
  const cta = ($('sm-cta') && $('sm-cta').value.trim()) || '';
  const ctx = ($('sm-context') && $('sm-context').value.trim()) || '';
  const tags = $('sm-hashtags') ? $('sm-hashtags').checked : true;

  const out = $('sm-output'); const res = $('sm-result');
  out.style.display = 'block';

  const sys = 'You are the social media manager for a UK charity. Write ready-to-post social media posts in British English. ' +
    'Return ONLY a JSON object — no prose, no code fences — whose keys are exactly the requested platforms and whose values are the post text. ' +
    'RULES: use ONLY the facts given; never invent numbers, people, places or quotes, and never recalculate figures. ' +
    'Never name participants. Quotes may be used only if supplied, word for word, attributed as "one participant" or "a participant". ' +
    'Follow each platform\'s guide exactly. No markdown, no asterisks. ' +
    (tags ? 'Include relevant hashtags as each guide allows.' : 'Do not use any hashtags.');

  const prompt = [
    'Organisation: ' + ((currentOrg && currentOrg.name) || 'our charity'),
    'Tone: ' + tone,
    'Post type: ' + f.about,
    '',
    'FACTS:',
    f.lines.length ? f.lines.map(l => '- ' + l).join('\n') : '- (no specific facts — keep it general and do not invent any)',
    '',
    picked.length ? 'QUOTES YOU MAY USE (verbatim):\n' + picked.map(q => '- "' + q + '"').join('\n') : 'QUOTES: none — do not use or invent any quotes.',
    ctx ? '\nEXTRA CONTEXT FROM STAFF: ' + ctx : '',
    cta ? '\nCALL TO ACTION: ' + cta : '',
    _socialPhoto ? '\nA photo from the day will accompany the post.' : '',
    '',
    'PLATFORMS AND GUIDES:',
    platforms.map(p => '- ' + p + ': ' + SOCIAL_PLATFORMS[p].guide).join('\n')
  ].filter(s => s !== '').join('\n');

  const steps = [
    { label: 'Reading your data', meta: f.lines.length + ' facts · ' + picked.length + ' approved quote(s)' },
    { label: 'Writing for each platform', meta: platforms.map(p => SOCIAL_PLATFORMS[p].label).join(' · ') },
    { label: 'Ready', meta: '' }
  ];

  const raw = await runAgent({
    container: res,
    headerLabel: 'Social Media Studio',
    headerSub: 'Writing from your real data',
    steps, sys, prompt, maxTok: 1100
  });
  if (!raw) return;

  let posts = {};
  try {
    const clean = raw.replace(/```json|```/gi, '').trim();
    const m = clean.match(/\{[\s\S]*\}/);
    posts = JSON.parse(m ? m[0] : clean);
  } catch (e) {
    posts = {};
    posts[platforms[0]] = cleanReportText(raw);
  }
  _socialPosts = {};
  platforms.forEach(p => { if (posts[p]) _socialPosts[p] = String(posts[p]).trim(); });
  _socialEventId = f.eventId;
  renderSocialCards();
}

// Keep the old name working (older buttons / links).
function runSocialAgent() { return generateSocial(); }

function renderSocialCards() {
  const res = $('sm-result'); if (!res) return;
  const keys = Object.keys(_socialPosts);
  if (!keys.length) { res.innerHTML = '<div class="alert alert-warn">No posts came back — try again.</div>'; return; }

  res.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px">' +
    keys.map(p => {
      const pl = SOCIAL_PLATFORMS[p] || { label: p, icon: '📝', limit: 3000 };
      const openLabel = p === 'linkedin' ? 'Open in LinkedIn' : p === 'x' ? 'Open in X' : p === 'facebook' ? 'Copy & open Facebook' : 'Copy for Instagram';
      return '<div class="card" style="margin:0;display:flex;flex-direction:column">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">' +
          '<div style="font-weight:700;font-size:14px;color:var(--txt)">' + pl.icon + ' ' + escapeHTML(pl.label) + '</div>' +
          '<div id="sm-count-' + p + '" style="font-size:11px;font-weight:700"></div>' +
        '</div>' +
        (_socialPhoto ? '<img src="' + _socialPhoto + '" style="width:100%;max-height:180px;object-fit:cover;border-radius:8px;margin-bottom:10px"/>' : '') +
        '<textarea id="sm-txt-' + p + '" oninput="socialCount(\'' + p + '\')" style="flex:1;min-height:170px;font-size:13px;line-height:1.6">' + escapeHTML(_socialPosts[p]) + '</textarea>' +
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">' +
          '<button class="btn btn-p btn-sm" onclick="openSocial(\'' + p + '\')">' + openLabel + '</button>' +
          '<button class="btn btn-ghost btn-sm" id="sm-copy-' + p + '" onclick="copySocial(\'' + p + '\')">📋 Copy</button>' +
          (_socialPhoto && p !== 'x' ? '<button class="btn btn-ghost btn-sm" onclick="downloadSocialPhoto()">⬇ Photo</button>' : '') +
          '<button class="btn btn-ghost btn-sm" onclick="saveSocialDraft(\'' + p + '\')">🗓️ Add to plan</button>' +
        '</div>' +
      '</div>';
    }).join('') + '</div>';
  keys.forEach(socialCount);
}

function socialCount(p) {
  const t = $('sm-txt-' + p), c = $('sm-count-' + p);
  if (!t || !c) return;
  const lim = (SOCIAL_PLATFORMS[p] || {}).limit || 3000;
  const len = t.value.length;
  _socialPosts[p] = t.value;
  c.textContent = len + ' / ' + lim;
  c.style.color = len > lim ? 'var(--red)' : 'var(--txt3)';
}

function _socialText(p) { const t = $('sm-txt-' + p); return t ? t.value : (_socialPosts[p] || ''); }

function _socialClip(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta);
  return Promise.resolve();
}

function copySocial(p) {
  _socialClip(_socialText(p)).then(() => {
    const b = $('sm-copy-' + p);
    if (b) { const o = b.textContent; b.textContent = '✓ Copied'; setTimeout(() => b.textContent = o, 1800); }
  });
}

function openSocial(p) {
  const text = _socialText(p);
  const enc = encodeURIComponent(text);
  if (p === 'linkedin') { window.open('https://www.linkedin.com/feed/?shareActive=true&text=' + enc, '_blank'); return; }
  if (p === 'x') { window.open('https://x.com/intent/post?text=' + enc, '_blank'); return; }
  _socialClip(text).then(() => {
    if (p === 'facebook') {
      window.open('https://www.facebook.com/', '_blank');
      alert('Post copied. Facebook doesn\u2019t allow pre-filled text, so just paste it into a new post' + (_socialPhoto ? ' and add your photo (use \u2b07 Photo to save it).' : '.'));
    } else {
      alert('Post copied. Instagram posts are made in the app — paste the caption there' + (_socialPhoto ? ' and add your photo (use \u2b07 Photo to save it to this device).' : '.'));
    }
  });
}

function downloadSocialPhoto() {
  if (!_socialPhoto) return;
  const a = document.createElement('a');
  a.href = _socialPhoto;
  a.download = 'social-photo.jpg';
  document.body.appendChild(a); a.click(); a.remove();
}

// ── Content plan (social_posts table) ──
async function loadSocialDrafts() {
  const el = $('sm-plan'); if (!el) return;
  if (typeof sb === 'undefined' || !sb || !orgId) { el.innerHTML = renderEmpty('Content plan loads once you\u2019re signed in.'); return; }
  try {
    const { data, error } = await sb.from('social_posts').select('*').eq('org_id', orgId).order('planned_date', { ascending: true });
    if (error) throw error;
    _socialDrafts = data || [];
  } catch (e) {
    el.innerHTML = '<div class="alert alert-warn" style="margin:0">Content plan unavailable — has the <code>social_posts</code> table been created in Supabase?</div>';
    return;
  }
  renderSocialPlan();
}

function renderSocialPlan() {
  const el = $('sm-plan'); if (!el) return;
  const today = _socialToday();
  const planned = _socialDrafts.filter(d => d.status !== 'posted');
  const posted = _socialDrafts.filter(d => d.status === 'posted').slice(-5).reverse();
  if (!planned.length && !posted.length) {
    el.innerHTML = renderEmpty('Nothing planned yet. Write a post and click \u201cAdd to plan\u201d.');
    return;
  }
  const row = (d, done) => {
    const pl = SOCIAL_PLATFORMS[d.platform] || { icon: '📝', label: d.platform };
    const late = !done && d.planned_date && d.planned_date < today;
    return '<div style="display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-bottom:1px solid var(--border);' + (done ? 'opacity:.55' : '') + '">' +
      '<div style="font-size:20px">' + pl.icon + '</div>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:12px;font-weight:700;color:' + (late ? 'var(--red)' : 'var(--txt)') + '">' +
          escapeHTML(pl.label) + ' · ' + escapeHTML(d.planned_date ? fmtD(d.planned_date) : 'no date') + (late ? ' · overdue' : '') + (done ? ' · posted' : '') +
        '</div>' +
        '<div style="font-size:12px;color:var(--txt2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHTML(d.body) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:4px;flex-shrink:0">' +
        '<button class="btn btn-ghost btn-sm" onclick="copySocialDraft(\'' + escapeHTML(String(d.id)) + '\')">📋</button>' +
        (done ? '' : '<button class="btn btn-ghost btn-sm" onclick="markSocialPosted(\'' + escapeHTML(String(d.id)) + '\')">✓ Posted</button>') +
        '<button class="btn btn-ghost btn-sm" onclick="deleteSocialDraft(\'' + escapeHTML(String(d.id)) + '\')">×</button>' +
      '</div></div>';
  };
  el.innerHTML = planned.map(d => row(d, false)).join('') +
    (posted.length ? '<div style="font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;font-weight:700;margin:14px 0 4px">Recently posted</div>' + posted.map(d => row(d, true)).join('') : '');
}

async function saveSocialDraft(p) {
  const body = _socialText(p).trim();
  if (!body) return;
  const date = ($('sm-plan-date') && $('sm-plan-date').value) || _socialToday();
  try {
    await sbInsert('social_posts', { platform: p, body: body, planned_date: date, event_id: _socialEventId, status: 'draft' });
    await loadSocialDrafts();
  } catch (e) {
    alert('Could not save to the plan: ' + e.message + '\n\nHas the social_posts table been created in Supabase?');
  }
}

function copySocialDraft(id) {
  const d = _socialDrafts.find(x => String(x.id) === String(id));
  if (d) _socialClip(d.body);
}

async function markSocialPosted(id) {
  try {
    const { error } = await sb.from('social_posts').update({ status: 'posted' }).eq('id', id);
    if (error) throw error;
    await loadSocialDrafts();
  } catch (e) { alert('Could not update: ' + e.message); }
}

async function deleteSocialDraft(id) {
  if (!confirm('Remove this post from the plan?')) return;
  try {
    const { error } = await sb.from('social_posts').delete().eq('id', id);
    if (error) throw error;
    await loadSocialDrafts();
  } catch (e) { alert('Could not remove: ' + e.message); }
}

// The older "Opportunities Finder" extensions swap in their own search and cards when this flag is unset.
// This page has its own three-lane search and the Pull-their-form button, so tell them to stand down.
window._civaraBDPatched = true;

// ═════════════════════════════════════════════════════════════
// BD WORKSPACE — find funding, pull the funder's form, fill it in
// ═════════════════════════════════════════════════════════════
let _bdSel = null;       // the opportunity being worked on
let _eoiDoc = null;      // the funder's form: { kind:'docx'|'pdf'|'text', base64, name, url }

async function _agToken(force) {
  let { data: { session } } = await sb.auth.getSession();
  if (force || !session || (session.expires_at && session.expires_at * 1000 - Date.now() < 60000)) {
    try { const r = await sb.auth.refreshSession(); if (r && r.data && r.data.session) session = r.data.session; } catch (e) { /* use what we have */ }
  }
  return session && session.access_token;
}
async function _postJSON(path, body) {
  const send = async force => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await _agToken(force)) }, body: JSON.stringify(body) });
  let res = await send(false);
  if (res.status === 401) res = await send(true);
  let data = null; try { data = await res.json(); } catch (e) { /* not JSON */ }
  if (!res.ok && !(data && data.error)) throw new Error(res.status === 504 ? 'That took too long — please try again' : 'Server error (' + res.status + ')');
  return data || {};
}
function _fileToBase64(file) { return new Promise((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = () => bad(new Error('Could not read the file')); r.readAsDataURL(file); }); }
function _downloadBase64(b64, filename, mime) {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([bytes], { type: mime })); a.download = filename;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const _DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// ── the page: tabs, the details drawer, the full-screen bid ──
const _BD_LANE_SHORT = { 'Government, UKSPF and councils': 'Councils & government', 'Trusts, foundations and the Lottery': 'Trusts & Lottery', 'Corporate and environmental funders': 'Companies', 'Funders of groups like you': 'Funded groups like you' };
let _bdItems = [], _bdRemoved = [], _bdFilter = '', _bdSort = 'fit', _bdShowHidden = false, _bdSearching = false, _bdLastAt = '', _bdSavedAt = 0;
const _BD_STEPS = ['Funder', 'Questions', 'Answers', 'Gaps', 'Download'];
let _bdStep = 0;

function bdTab(v) {
  ['opps', 'bids', 'saved', 'done'].forEach(k => { const el = $('bd-v-' + k); if (el) el.style.display = k === v ? '' : 'none'; });
  document.querySelectorAll('#bd-tabs button').forEach(b => b.classList.toggle('on', b.dataset.v === v));
  if (v === 'saved') bdRenderSaved();
  if ((v === 'bids' || v === 'done') && typeof window.vlBidsPaint === 'function') window.vlBidsPaint();
}
function bdCount(id, n) { const el = $('bd-n-' + id); if (el) el.textContent = n ? String(n) : ''; }

function bdDetails(open) {
  const d = $('bd-drawer'), bg = $('bd-drawer-bg'); if (!d) return;
  if (open) { bg.style.display = 'block'; requestAnimationFrame(() => d.classList.add('open')); setTimeout(() => { const a = $('bd-area'); if (a && !a.value) a.focus(); }, 260); }
  else { d.classList.remove('open'); setTimeout(() => { bg.style.display = 'none'; }, 250); bdRefreshSummary(); }
}
// "Searching for Northgate Community Hub · Peterborough · Community & volunteering · Under £100k  Edit"
function bdWho() {
  const el = $('bd-who'); if (!el) return;
  const s = (typeof bdSetupRead === 'function' && $('bd-area')) ? bdSetupRead() : bdSetupGet();
  const what = (s.what || []).map(k => (BD_WHAT.find(x => x[0] === k) || [])[1]).filter(Boolean);
  const size = { micro: 'Under £100k', small: '£100k–£500k', medium: '£500k–£2m', large: '£2m+' }[s.size] || '';
  const name = (currentOrg && currentOrg.name) || 'your organisation';
  if (!s.area) { el.className = 'bd-who warn'; el.innerHTML = 'Tell us where you deliver and what you do, and we\'ll search for <b>' + escapeHTML(name) + '</b>. <a onclick="bdDetails(true)">Add details</a>'; return; }
  el.className = 'bd-who';
  el.innerHTML = 'Searching for <b>' + escapeHTML(name) + '</b> · ' + escapeHTML(s.area) + (what.length ? ' · ' + escapeHTML(what.slice(0, 2).join(', ')) + (what.length > 2 ? ' +' + (what.length - 2) : '') : '') + (size ? ' · ' + escapeHTML(size) : '') + ' <a onclick="bdDetails(true)">Edit</a>';
}

// The bid, full screen
function bdWsOpen() { const w = $('bd-ws'); if (!w || w.classList.contains('open')) return; w.classList.add('open'); w.scrollTop = 0; document.body.style.overflow = 'hidden'; bdWsHead(); }
function bdWsClose() { const w = $('bd-ws'); if (w) w.classList.remove('open'); document.body.style.overflow = ''; bdResume(); }
function bdWsIsOpen() { const w = $('bd-ws'); return !!(w && w.classList.contains('open')); }
function bdWsFunder() { return (($('eoi-funder') || {}).value || '').trim(); }
function bdWsHead() {
  const t = $('bd-ws-title'), s = $('bd-ws-sub'); if (!t) return;
  const f = bdWsFunder();
  t.textContent = f ? f.replace(' — ', ' · ') : 'New bid';
  const bits = [];
  if (_bdSavedAt) { const m = Math.round((Date.now() - _bdSavedAt) / 60000); bits.push('Saved ' + (m < 1 ? 'just now' : m + ' min ago')); }
  const dl = _bdSel && _bdSel.deadline ? _bdDeadline(_bdSel.deadline) : null;
  if (dl) bits.push('Closes: ' + dl.big);
  s.textContent = bits.join(' · ');
}
setInterval(() => { if (bdWsIsOpen() && _bdSavedAt) bdWsHead(); }, 60000);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('bd-drawer') && $('bd-drawer').classList.contains('open')) bdDetails(false); });
// Leaving Find funding closes the bid screen (it stays in memory: "Carry on with your … bid")
(function wrapGo(t) {
  if (typeof window.go === 'function') { const g = window.go; window.go = function (p) { if (p !== 'bd' && bdWsIsOpen()) bdWsClose(); if (p !== 'bd' && $('bd-drawer') && $('bd-drawer').classList.contains('open')) bdDetails(false); return g.apply(this, arguments); }; return; }
  if (t < 100) setTimeout(() => wrapGo(t + 1), 100);
})(0);
window.addEventListener('vl-bid-saved', () => { _bdSavedAt = Date.now(); bdWsHead(); });
function bdWsSteps(active) {
  _bdStep = active;
  const el = $('bd-steps'); if (!el) return;
  el.innerHTML = _BD_STEPS.map((l, i) => '<button type="button" class="bd-st' + (i < active ? ' d' : i === active ? ' on' : '') + '" onclick="bdWsJump(' + i + ')"><b>' + (i < active ? '✓' : i + 1) + '</b>' + l + '</button>').join('');
}
function bdWsJump(i) {
  const w = $('bd-ws'); if (!w) return;
  const target = i === 0 ? ($('bd-ws-brief') && $('bd-ws-brief').innerHTML ? $('bd-ws-brief') : $('bd-s2')) : i <= 2 ? $('eoi-output') : i === 3 ? $('eoi-gaps') : $('bd-dl');
  if (!target || target.offsetParent === null) return;
  w.scrollTo({ top: Math.max(0, target.getBoundingClientRect().top + w.scrollTop - 90), behavior: 'smooth' });
}
// A fresh, empty bid screen
function bdWsReset() {
  if ($('eoi-output')) $('eoi-output').style.display = 'none';
  if ($('eoi-result')) $('eoi-result').innerHTML = '';
  if ($('bd-ws-brief')) $('bd-ws-brief').innerHTML = '';
  if ($('bd-rail')) $('bd-rail').innerHTML = '';
  if ($('bd-pull-steps')) $('bd-pull-steps').innerHTML = '';
  if ($('bd-pull-note')) $('bd-pull-note').innerHTML = '';
  if ($('eoi-questions')) { $('eoi-questions').style.display = 'none'; $('eoi-questions').innerHTML = ''; }
  _bdSavedAt = 0; window._bdPrev = {}; window._bdRaised = null;
}
// Older code calls these: 2 = getting their form, 3 = the answers
function bdShowSection(n) {
  if (n < 2) return;
  bdWsOpen();
  if (n === 2 && $('bd-s2')) $('bd-s2').style.display = '';
  if (n >= 3 && $('eoi-output')) $('eoi-output').style.display = 'block';
  if (n === 2 && _bdStep > 1) bdWsSteps(_eoiQuestions && _eoiQuestions.length ? 1 : 0);
  bdWsHead();
}
function bdGo(n) {
  if (n === 1) { bdWsClose(); return; }
  if (_eoiQuestions && _eoiQuestions.length && $('eoi-output') && $('eoi-result') && $('eoi-result').innerHTML) { bdShowSection(3); bdWsJump(n === 2 ? 1 : 2); return; }
  bdManualStart();
}
function bdManualStart() {
  if (!(_eoiQuestions && _eoiQuestions.length && $('eoi-result') && $('eoi-result').innerHTML && bdWsIsOpen())) {
    bdWsReset(); _eoiQuestions = []; _eoiAnswers = {}; _eoiDoc = null; _bdSel = null; window._eoiAssessed = null;
    if ($('eoi-funder')) $('eoi-funder').value = '';
    if (typeof window._vlBidNew === 'function') window._vlBidNew();
  }
  bdWsOpen();
  if ($('bd-s2')) $('bd-s2').style.display = '';
  if ($('bd-funder-row')) $('bd-funder-row').style.display = '';
  const m = $('bd-manual'); if (m) m.open = true;
  bdWsSteps(0); bdWsHead();
  setTimeout(() => { const f = $('eoi-funder'); if (f && !f.value) f.focus(); }, 50);
}
// "Carry on with your … bid" when the bid screen is closed
function bdResume() {
  const el = $('bd-resume'); if (!el) return;
  const has = _eoiQuestions && _eoiQuestions.length && $('eoi-result') && $('eoi-result').innerHTML && !bdWsIsOpen();
  el.innerHTML = has ? '<div class="bd-resume" onclick="bdShowSection(3)"><span>Carry on with your <b>' + escapeHTML((bdWsFunder() || 'bid').split(' — ')[0]) + '</b> bid</span><span style="color:var(--em);font-weight:600">Open ›</span></div>' : '';
}

// ── a funder card ──
function _bdNorm(t) { return String(t || '').toLowerCase().replace(/&/g, 'and').replace(/\b(the|fund|foundation|trust|programme|program|grants?|scheme)\b/g, '').replace(/[^a-z0-9]+/g, ''); }
function _bdKey(o) { return _bdNorm(o.funder) + '|' + _bdNorm(o.programme); }
function _bdDeadline(s) {
  const t = String(s || '').trim();
  if (!t || /^check$/i.test(t)) return { big: 'Check', sort: 9e15 };
  if (/rolling|ongoing|any ?time|open all year|no deadline/i.test(t)) return { big: 'Rolling', sort: 8e15 };
  const d = new Date(t.replace(/(\d+)(st|nd|rd|th)/i, '$1').replace(/^[^0-9]*?(\d{1,2} \w+ \d{4}).*$/, '$1'));
  if (!isNaN(d) && d.getFullYear() > 2000) {
    const days = Math.ceil((d - new Date()) / 864e5);
    if (days < 0) return { big: 'Closed?', soon: true, sort: d.getTime() };
    if (days <= 21) return { big: days === 0 ? 'Today' : days + ' day' + (days === 1 ? '' : 's'), soon: true, sort: d.getTime() };
    return { big: d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + (d.getFullYear() !== new Date().getFullYear() ? ' ' + String(d.getFullYear()).slice(2) : ''), sort: d.getTime() };
  }
  return { big: t.length > 16 ? t.slice(0, 15) + '…' : t, small: t.length > 10, sort: 7e15 };
}
function _bdValue(s) {
  const t = String(s || '').replace(/,/g, '');
  const nums = (t.match(/£\s*\d+(?:\.\d+)?\s*(?:k|m|million)?/gi) || []).map(x => { const n = parseFloat(x.replace(/[^\d.]/g, '')); return /m(illion)?\s*$/i.test(x) ? n * 1e6 : /k\s*$/i.test(x) ? n * 1000 : n; }).filter(n => n > 0);
  if (!nums.length) return { big: t ? (t.length > 14 ? 'See page' : t) : 'Check', label: 'Grant', n: 0 };
  const max = Math.max(...nums);
  return { big: '£' + Math.round(max).toLocaleString('en-GB'), label: (nums.length > 1 || /up to|max|maximum/i.test(t)) ? 'Up to' : 'Grant', n: max };
}
function _bdCardHTML(o, key, mode) {
  const sc = o.score || 3;
  const fit = sc >= 5 ? ['bd-fit5', 'Great fit'] : sc === 4 ? ['bd-fit4', 'Good fit'] : ['bd-fit3', 'Possible fit'];
  const v = _bdValue(o.value), d = _bdDeadline(o.deadline);
  const url = /^https?:\/\//i.test(o.url || '') ? o.url : '';
  const g = o.giving && o.giving.found ? o.giving : null;
  const saved = _bdSavedList().some(x => x.key === _bdKey(o));
  return '<div class="bd-card" data-k="' + escapeHTML(_bdKey(o)) + '">' +
    '<div class="bd-card-top"><span class="bd-pill ' + fit[0] + '">' + fit[1] + '</span><span class="bd-lane">' + escapeHTML(_BD_LANE_SHORT[o.lane] || o.lane || '') + '</span></div>' +
    (o.funder && o.programme ? '<div class="bd-fn">' + escapeHTML(o.funder) + '</div><div class="bd-pn">' + escapeHTML(o.programme) + '</div>' : '<div class="bd-pn" style="margin-top:0">' + escapeHTML(o.funder || o.programme || 'Opportunity') + '</div>') +
    '<div class="bd-nums"><div class="bd-num"><b>' + escapeHTML(v.big) + '</b><span>' + v.label + '</span></div><div class="bd-num"><b class="' + (d.soon ? 'soon' : '') + '"' + (d.small ? ' style="font-size:16px"' : '') + '>' + escapeHTML(d.big) + '</b><span>Closes</span></div></div>' +
    (o.fit ? '<div class="bd-why">' + escapeHTML(o.fit) + '</div>' : '') +
    (g ? '<div class="bd-given">' + (g.localSimilar ? '<b>Funded ' + g.localSimilar + ' group' + (g.localSimilar === 1 ? '' : 's') + ' like you nearby</b>' : g.local ? 'Funds groups in your area (' + g.local + ' recent)' : 'Recent grants checked') +
      (g.typical ? ' · typical £' + g.typical.median.toLocaleString('en-GB') : '') + (g.lastAward ? ' · last award ' + escapeHTML(g.lastAward) : '') +
      ((g.localExamples || [])[0] ? '<br>e.g. ' + g.localExamples.slice(0, 2).map(x => escapeHTML(x.recipient) + (x.amount ? ' (£' + x.amount.toLocaleString('en-GB') + ')' : '')).join(', ') : '') +
      ' <a href="' + escapeHTML(g.source || 'https://www.threesixtygiving.org') + '" target="_blank" rel="noopener" style="color:inherit;font-size:11px">360Giving</a></div>' : '') +
    (o.checked ? '<div class="bd-ok">✓ ' + escapeHTML(o.checked) + '</div>' : o.linkBroken ? '<div class="bd-warnline">Their link didn\'t open — check it</div>' : '') +
    (o.eligibility ? '<details style="margin-bottom:6px"><summary>Who can apply</summary><div style="font-size:12.5px;color:var(--txt2);margin-top:4px;line-height:1.5">' + escapeHTML(o.eligibility) + '</div></details>' : '') +
    '<div class="bd-acts"><button class="btn btn-p btn-sm" type="button" onclick="pullFunderForm(\'' + key + '\')">Write the bid</button>' +
      (mode === 'saved' ? '<button class="bd-link" type="button" onclick="bdUnsave(\'' + escapeHTML(_bdKey(o)) + '\')">Remove</button>'
        : '<button class="btn btn-ghost btn-sm" type="button" onclick="bdSave(\'' + key + '\')"' + (saved ? ' disabled' : '') + '>' + (saved ? '✓ Saved' : 'Save') + '</button><button class="bd-link" type="button" onclick="bdHide(\'' + key + '\')">Not for us</button>') +
      (url ? '<a class="bd-fp" href="' + escapeHTML(url) + '" target="_blank" rel="noopener">Funder page ↗</a>' : '') + '</div></div>';
}
function bdRenderOpps() {
  const el = $('bd-list'); if (!el) return;
  const hidden = new Set(_bdHiddenList());
  const visible = _bdItems.filter(o => _bdShowHidden || !hidden.has(_bdKey(o)));
  const nHidden = _bdItems.length - _bdItems.filter(o => !hidden.has(_bdKey(o))).length;
  bdCount('opps', _bdItems.filter(o => !hidden.has(_bdKey(o))).length);
  if (!_bdItems.length) {
    el.innerHTML = _bdSearching ? '' : (_bdLastAt === 'none' ? '<div class="bd-empty" style="margin-top:16px"><b>No matches this time</b>Try again, or type a funder you have in mind in the box above and search for that.</div>' : '');
    return;
  }
  const lanes = Object.keys(_BD_LANE_SHORT).filter(l => visible.some(o => o.lane === l));
  if (_bdFilter && !lanes.includes(_bdFilter)) _bdFilter = '';
  let list = visible.filter(o => !_bdFilter || o.lane === _bdFilter);
  if (_bdSort === 'soon') list = list.slice().sort((a, b) => _bdDeadline(a.deadline).sort - _bdDeadline(b.deadline).sort);
  else if (_bdSort === 'big') list = list.slice().sort((a, b) => _bdValue(b.value).n - _bdValue(a.value).n);
  Object.keys(_bdOpps).forEach(k => { if (k.indexOf('opp') === 0) delete _bdOpps[k]; });
  const when = _bdLastAt && _bdLastAt !== 'none' && !_bdSearching ? new Date(_bdLastAt) : null;
  el.innerHTML =
    '<div class="bd-bar">' + (lanes.length > 1 ? '<span class="bd-chip' + (!_bdFilter ? ' on' : '') + '" onclick="bdFilterLane(\'\')">All ' + visible.length + '</span>' +
      lanes.map(l => '<span class="bd-chip' + (_bdFilter === l ? ' on' : '') + '" data-l="' + escapeHTML(l) + '" onclick="bdFilterLane(this.dataset.l)">' + escapeHTML(_BD_LANE_SHORT[l].replace(' & government', '')) + ' ' + visible.filter(o => o.lane === l).length + '</span>').join('') : '') +
      '<select class="bd-sort" onchange="_bdSort=this.value;bdRenderOpps()"><option value="fit"' + (_bdSort === 'fit' ? ' selected' : '') + '>Best fit first</option><option value="soon"' + (_bdSort === 'soon' ? ' selected' : '') + '>Closing soonest</option><option value="big"' + (_bdSort === 'big' ? ' selected' : '') + '>Biggest grants</option></select></div>' +
    '<div class="bd-note">' + (when && !isNaN(when) ? 'From your search on ' + when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) + '. ' : '') + 'Check dates and amounts on the funder\'s page before you apply.' +
      (nHidden ? ' <a href="#" onclick="_bdShowHidden=!_bdShowHidden;bdRenderOpps();return false" style="color:var(--em);font-weight:600">' + (_bdShowHidden ? 'Hide the ' + nHidden + ' you said no to' : nHidden + ' hidden · show') + '</a>' : '') + '</div>' +
    '<div class="bd-grid">' + list.map(o => { const k = 'opp' + _bdItems.indexOf(o); _bdOpps[k] = o; return _bdCardHTML(o, k); }).join('') + '</div>' +
    (_bdRemoved.length ? '<details style="margin-top:14px"><summary style="font-size:12.5px;color:var(--txt3);cursor:pointer">' + _bdRemoved.length + ' removed after checking their pages</summary>' +
      _bdRemoved.map(o => '<div style="font-size:12.5px;color:var(--txt2);margin:6px 0 0 14px">' + escapeHTML(o.funder || o.programme || '') + (o.programme && o.funder ? ' — ' + escapeHTML(o.programme) : '') + ': ' + escapeHTML(o.removedWhy || '') + '</div>').join('') + '</details>' : '');
}
function bdFilterLane(lane) { _bdFilter = lane || ''; bdRenderOpps(); }
// The last search stays on the page next time
function _bdKeepResults() { try { localStorage.setItem('vorlana_bd_last_' + orgId, JSON.stringify({ at: new Date().toISOString(), items: _bdItems.slice(0, 40), removed: _bdRemoved.slice(0, 20) })); } catch (e) { /* ignore */ } }
function _bdRestoreResults() {
  if (_bdItems.length || _bdSearching) return;
  try { const j = JSON.parse(localStorage.getItem('vorlana_bd_last_' + orgId) || 'null'); if (j && Array.isArray(j.items) && j.items.length) { _bdItems = j.items; _bdRemoved = j.removed || []; _bdLastAt = j.at || ''; } } catch (e) { /* ignore */ }
}

// Saved and "Not for us": kept on the organisation so the whole team sees them
function _bdSavedList() { const s = (currentOrg && currentOrg.settings && currentOrg.settings.bd_saved) || null; if (Array.isArray(s)) return s; try { return JSON.parse(localStorage.getItem('vorlana_bd_saved_' + orgId) || '[]'); } catch (e) { return []; } }
function _bdHiddenList() { const s = (currentOrg && currentOrg.settings && currentOrg.settings.bd_hidden) || null; if (Array.isArray(s)) return s; try { return JSON.parse(localStorage.getItem('vorlana_bd_hidden_' + orgId) || '[]'); } catch (e) { return []; } }
async function _bdKeep(field, list) {
  try { localStorage.setItem('vorlana_' + field + '_' + orgId, JSON.stringify(list)); } catch (e) { /* ignore */ }
  if (currentOrg) currentOrg.settings = Object.assign({}, currentOrg.settings || {}, { [field]: list });
  try {
    const r = await sb.from('organisations').select('settings').eq('id', orgId).limit(1);
    const st = (r.data && r.data[0] && r.data[0].settings) || {};
    st[field] = list;
    await sb.from('organisations').update({ settings: st }).eq('id', orgId);
  } catch (e) { /* kept on this device */ }
}
function bdSave(key) {
  const o = _bdOpps[key]; if (!o) return;
  const list = _bdSavedList().filter(x => x.key !== _bdKey(o));
  list.unshift({ key: _bdKey(o), o: Object.assign({}, o), at: new Date().toISOString() });
  _bdKeep('bd_saved', list.slice(0, 60)); bdCount('saved', Math.min(list.length, 60)); bdRenderOpps();
}
function bdUnsave(k) { const list = _bdSavedList().filter(x => x.key !== k); _bdKeep('bd_saved', list); bdCount('saved', list.length); bdRenderSaved(); bdRenderOpps(); }
function bdHide(key) {
  const o = _bdOpps[key]; if (!o) return;
  const list = _bdHiddenList().filter(k => k !== _bdKey(o)); list.unshift(_bdKey(o));
  _bdKeep('bd_hidden', list.slice(0, 300)); bdRenderOpps();
}
function bdRenderSaved() {
  const el = $('bd-v-saved'); if (!el) return;
  const list = _bdSavedList(); bdCount('saved', list.length);
  if (!list.length) { el.innerHTML = '<div class="bd-empty"><b>Nothing saved yet</b>Press Save on a funder to keep it here for later.</div>'; return; }
  el.innerHTML = '<div class="bd-grid">' + list.map((x, i) => { const k = 'sav' + i; _bdOpps[k] = x.o; return _bdCardHTML(x.o, k, 'saved'); }).join('') + '</div>';
}

// ── about your organisation (sidebar) ──
const BD_WHAT = [['employability', 'Employment & skills'], ['circular', 'Reuse, repair & circular economy'], ['growing', 'Food growing & community food'], ['environment', 'Environment & nature'],
  ['wellbeing', 'Mental health & wellbeing'], ['young', 'Children & young people'], ['older', 'Older people'], ['justice', 'Criminal justice'], ['migrants', 'Refugees & migrants'],
  ['disability', 'Disability'], ['community', 'Community & volunteering'], ['arts', 'Arts, culture & heritage'], ['digital', 'Digital inclusion'], ['housing', 'Housing & homelessness']];
function bdSetupGet() {
  const org = (currentOrg && currentOrg.settings && currentOrg.settings.bd_setup) || null;
  let loc = null; try { loc = JSON.parse(localStorage.getItem('vorlana_bd_setup_' + orgId) || 'null'); } catch (e) { /* ignore */ }
  return org || loc || {};
}
function bdSetupRead() {
  return { area: (($('bd-area') || {}).value || '').trim(), size: ($('bd-size') || {}).value || 'micro', type: ($('bd-type') || {}).value || 'Registered charity',
    what: Array.from(document.querySelectorAll('#bd-what button.on')).map(b => b.dataset.k) };
}
function bdSetupLocalSave() { try { localStorage.setItem('vorlana_bd_setup_' + orgId, JSON.stringify(bdSetupRead())); } catch (e) { /* ignore */ } bdRefreshSummary(); }
function bdWhat() { return Array.from(document.querySelectorAll('#bd-what button.on')).map(b => (BD_WHAT.find(x => x[0] === b.dataset.k) || [])[1]).filter(Boolean); }
function bdRefreshSummary() { bdWho(); }
function bdPaintWhat() {
  const box = $('bd-what'); if (!box) return;
  const setup = bdSetupGet();
  let saved = Array.isArray(setup.what) ? setup.what.slice() : [];
  const m = (currentOrg && currentOrg.modules) || {};
  if (!saved.length) { if (m.circular !== false) saved.push('circular'); saved.push('community'); }   // a starting guess; they tick what fits
  const paint = (b, on) => { b.classList.toggle('on', on); b.style.background = on ? 'var(--em)' : 'var(--surface)'; b.style.color = on ? '#fff' : 'var(--txt2)'; b.style.borderColor = on ? 'var(--em)' : 'var(--border)'; };
  box.innerHTML = BD_WHAT.map(([k, l]) => '<button type="button" data-k="' + k + '" style="border:1px solid var(--border);border-radius:16px;padding:5px 11px;font-size:12px;cursor:pointer">' + l + '</button>').join('');
  Array.from(box.children).forEach(b => paint(b, saved.includes(b.dataset.k)));
  box.onclick = e => { const b = e.target.closest('button'); if (!b) return; paint(b, !b.classList.contains('on')); bdSetupLocalSave(); };
}
function bdInit() {
  const s = bdSetupGet();
  if ($('bd-area')) $('bd-area').value = s.area || '';
  if ($('bd-size') && s.size) $('bd-size').value = s.size;
  if ($('bd-type') && s.type) $('bd-type').value = s.type;
  bdPaintWhat();
  const ta = $('eoi-org-profile'); if (ta && !ta.value) ta.value = getOrgProfile();
  if (ta && ta.value) {
    const tidy = ta.value.split('\n').filter(l => !_CHATTER.test(l)).join('\n').trim();
    if (tidy !== ta.value.trim()) {
      const removed = ta.value.split('\n').filter(l => l.trim()).length - tidy.split('\n').filter(l => l.trim()).length;
      ta.value = tidy;
      const sv = $('eoi-profile-saved'); if (sv) { sv.textContent = 'We removed ' + removed + ' line' + (removed === 1 ? ' that wasn\'t' : 's that weren\'t') + ' about your organisation — press Save to keep this'; sv.style.display = 'inline'; }
    }
  }
  bdRefreshSummary();
  _bdRestoreResults(); bdRenderOpps(); bdCount('saved', _bdSavedList().length); bdResume();
  if (!s.area) bdDetails(true);              // first visit: ask where they deliver before anything else
}

// ── find funding: four live searches, merged, de-duplicated, checked and scored ──
async function runBDResearch() {
  if (_bdSearching) return;
  if (!(($('bd-area') || {}).value || '').trim()) { bdDetails(true); return; }
  _bdSearching = true;
  try { await _bdResearch(); }
  finally {
    _bdSearching = false;
    if (!_bdItems.length) _bdLastAt = 'none';
    const p = $('bd-progress'); if (p) p.style.display = 'none';
    bdRenderOpps();
    if (_bdItems.length) _bdKeepResults();
  }
}
async function _bdResearch() {
  const wrap = $('bd-opps-wrap'); const res = $('bd-opps-result');
  const area = (($('bd-area') || {}).value || '').trim();
  wrap.style.display = 'block';
  const size = $('bd-size').value, specific = ($('bd-specific').value || '').trim(), type = $('bd-type') ? $('bd-type').value : 'Registered charity';
  const what = bdWhat().join(', ') || 'community work';
  const sizeTxt = { micro: 'under £100k', small: '£100k–£500k', medium: '£500k–£2m', large: 'over £2m' }[size] || size;
  const profile = _eoiCleanProfile(getOrgProfile());
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const baseCore = 'Today is ' + today + '. Organisation: a ' + type + ' with turnover ' + sizeTxt + ', delivering ' + what + ' in ' + area + '.' +
    (specific ? ' Particularly interested in: ' + specific + '.' : '');
  // a short, tidy extract of the profile (labelled lines only) — never free chatter
  const profBits = profile.split('\n').filter(l => /^(mission|track record|partnerships|founded|where you deliver|accreditations)[^:]*:/i.test(l.trim())).join('\n').slice(0, 700);
  const base = baseCore + (profBits ? '\nAbout them: ' + profBits : '');
  const rules = ' You will NEVER ask questions or ask for clarification, and you do NOT need the organisation\'s name or registration number to search: search now with the details given and return results. If you are unsure of something, make a sensible assumption and carry on. Find up to 6 funding opportunities that are OPEN NOW or open on a rolling basis and that this organisation is actually eligible for (right area, right size, right type). ' +
    'For each give: funder, programme name, deadline (or "rolling"), grant or contract value, eligibility in one line, one sentence on why it fits THIS organisation, and the application or information URL. ' +
    'Prefer local and regional funders over national ones where an area is given. Never invent deadlines, values or URLs — if unsure, say "check". Skip anything closed.';
  const lanes = [
    ['Government, UKSPF and councils', 'You are a UK public-sector funding researcher. Search for ' + area + ' council grants, combined authority and UKSPF / Shared Prosperity funds, Contracts Finder and Find a Tender notices, Find a Grant (gov.uk), and government programmes relevant to ' + what + '.'],
    ['Trusts, foundations and the Lottery', 'You are a UK grants researcher. Search the National Lottery Community Fund (Awards for All, Reaching Communities, Partnerships), the community foundation covering ' + area + ', and trusts and foundations that fund ' + what + ' (for example Esmée Fairbairn, Garfield Weston, Tudor Trust, Henry Smith, Lloyds Bank Foundation, Power to Change, Postcode Lottery, Allen Lane, Paul Hamlyn, Trust for London where relevant).'],
    ['Corporate and environmental funders', 'You are a UK funding researcher. Search corporate and landfill/environmental funders that fit ' + what + ' in ' + area + ': Veolia Environmental Trust, Biffa Award, SUEZ Communities Trust, Enovert, FCC Communities Foundation, Tesco Stronger Starts, Co-op Local Community Fund, Greggs Foundation, Aviva Community Fund, National Grid, water company funds, Screwfix Foundation, B&Q Foundation, Asda Foundation, Morrisons Foundation, Benefact Trust, and energy or housing-association community funds.'],
    ['Funders of groups like you', 'You are a UK grants researcher who finds funders by what they have ALREADY funded. Search 360Giving GrantNav (grantnav.threesixtygiving.org), funders\' published grants lists and local news for grants awarded in the last three years to organisations in ' + area + ' doing ' + what + '. Return the funders behind those grants whose programmes are open now, and in "fit" name the similar group they funded and roughly how much.']
  ];
  // Each search returns its own scored list; they run side by side and appear as each one finishes
  const json = ' Reply with ONLY a JSON array, no other words and no code fences. Each item: {"funder":"","programme":"","deadline":"","value":"","eligibility":"","fit":"","url":"","score":0}. ' +
    '"fit" is one sentence on why it suits this organisation. "score" is 1–5 for how well it fits (5 = made for them). Use "" for anything you are unsure of. If nothing fits, reply [].';
  const status = lanes.map(() => 'searching');
  let items = [];
  _bdOpps = {}; _bdItems = []; _bdRemoved = []; _bdFilter = ''; _bdLastAt = '';
  res.innerHTML = '<div class="bd-prog" id="bd-progress"></div>';
  let checking = '', giving = '';                          // '' | 'running' | 'done'
  let removed = [];                                        // closed or not eligible, found when checking their pages
  const paintProgress = () => {
    const el = $('bd-progress'); if (!el) return;
    const lanesDone = status.filter(x => x !== 'searching').length;
    const units = lanesDone + (checking === 'done' ? 1 : 0) + (giving === 'done' ? 1 : 0);
    const n = items.length;
    const txt = lanesDone < lanes.length ? 'Searching councils, trusts and companies…' + (n ? ' <b>' + n + ' found</b>' : '')
      : checking === 'running' ? 'Checking each funder\'s page is open and you can apply…'
      : giving === 'running' ? 'Checking who they\'ve funded before…' : '';
    el.innerHTML = txt ? '<span class="bd-spin"></span><span>' + txt + '</span><div class="bar"><i style="width:' + Math.max(6, Math.round(100 * units / (lanes.length + 2))) + '%"></i></div>' : '';
    el.style.display = txt ? '' : 'none';
  };
  const norm = _bdNorm;
  const addItems = (list, laneName) => {
    (Array.isArray(list) ? list : []).forEach(o => {
      if (!o || !(o.funder || o.programme)) return;
      if (/\bclosed\b/i.test(String(o.deadline || ''))) return;
      o.lane = laneName; o.score = Math.max(1, Math.min(5, Math.round(+o.score || 3)));
      const key = norm(o.funder) + '|' + norm(o.programme);
      const twin = items.find(x => norm(x.funder) + '|' + norm(x.programme) === key);
      if (twin) { if (o.score > twin.score) Object.assign(twin, o, { lane: twin.lane }); return; }   // same opportunity from two searches: keep one
      items.push(o);
    });
    items.sort((a, b) => b.score - a.score);
  };
  const paintList = () => { _bdItems = items; _bdRemoved = removed; bdRenderOpps(); };
  const parse = t => {                                            // the JSON array, even with a sentence before or after it
    const txt = String(t || '').replace(/<\/?cite[^>]*>/gi, '').replace(/```json|```/gi, '');
    const endAt = txt.lastIndexOf(']');
    for (let i = txt.indexOf('['), tries = 0; i >= 0 && i < endAt && tries < 30; i = txt.indexOf('[', i + 1), tries++) {
      try { const v = JSON.parse(txt.slice(i, endAt + 1)); if (Array.isArray(v)) return v; } catch (e) { /* try the next [ */ }
    }
    return null;
  };
  const refused = t => !t || _eoiLooksLikeRefusal(t) || (!/https?:\/\/|\[/i.test(t) && /\b(please (clarify|confirm|provide)|could you|i need (you )?to|what i need)\b/i.test(t));
  const lane = async (l, i) => {
    let out = '';
    try {
      const so = { model: AI_MODELS.research, effort: 'medium', purpose: 'bd_search' };
      out = await callClaude(l[1] + rules + json, base, 1200, true, so);
      if (refused(out)) out = await callClaude(l[1] + rules + ' Your last reply asked questions instead of searching. That is not allowed. Search now.' + json, baseCore, 1200, true, so);
      let list = parse(out);
      if (!list && out && /https?:\/\//i.test(out)) {                 // prose came back: tidy just this search into the list
        const fix = await callClaude('Turn this funding research into ONE JSON array and nothing else. Each item: {"funder":"","programme":"","deadline":"","value":"","eligibility":"","fit":"","url":"","score":0}. "score" is 1–5 for fit to the organisation. Drop anything closed.', 'ORGANISATION: ' + base.slice(0, 500) + '\n\nRESEARCH:\n' + String(out).replace(/<\/?cite[^>]*>/gi, '').slice(0, 3400), 1200, false);
        list = parse(fix);
      }
      addItems(list || [], l[0]);
      status[i] = 'done';
    } catch (e) {
      status[i] = 'failed';
      if (e && e.message === 'AI_PLAN_GATE') { res.innerHTML = ''; throw e; }
    }
    paintProgress(); paintList();
  };
  paintProgress();
  try { await Promise.all(lanes.map(lane)); } catch (e) { return; }
  paintProgress(); paintList();

  // Check every result on the funder's own page: does it open, is it still open, can this organisation apply?
  if (!items.length) return;
  checking = 'running'; paintProgress();
  try {
    const top = items.slice(0, 15);
    let pages = [];
    try { const r = await _postJSON('/api/fetch-form', { action: 'check', urls: top.map(o => /^https?:\/\//i.test(o.url || '') ? o.url : '') }); pages = (r && r.pages) || []; } catch (e) { pages = []; }
    top.forEach((o, i) => { const pg = pages[i]; if (pg && o.url && !pg.ok) o.linkBroken = true; });
    const listing = top.map((o, i) => '#' + i + ' ' + (o.funder || '') + ' — ' + (o.programme || '') + ' | said deadline: ' + (o.deadline || '?') + ' | said value: ' + (o.value || '?') +
      '\nTHEIR PAGE: ' + ((pages[i] && pages[i].text) ? pages[i].text.slice(0, 1400) : '(page did not open)')).join('\n\n');
    const raw = await callClaude('You check UK funding opportunities for a grants adviser. Today is ' + today + '. For each numbered opportunity, use THEIR PAGE text (if it opened) to decide: ' +
      'is it open now or on a rolling basis ("open"), closed or no longer running ("closed"), or not clear from the page ("unclear"); the real deadline and grant size if the page states them; and whether THIS organisation can apply ("yes", "no" or "unclear") with a few words of reason (area, organisation type, income, focus). ' +
      'Only say "closed" or "no" when the page clearly shows it. Reply with ONLY a JSON array: [{"i":0,"status":"open","deadline":"","value":"","eligible":"yes","reason":""}]',
      'ORGANISATION: ' + baseCore + '\n\nOPPORTUNITIES:\n' + listing, 1200, false, { model: AI_MODELS.smart, effort: 'medium', long: true, purpose: 'bd_check' });
    const verdicts = parse(raw) || [];
    verdicts.forEach(v => {
      const o = top[+v.i]; if (!o) return;
      const pageOk = pages[+v.i] && pages[+v.i].ok && pages[+v.i].text;
      if (v.status === 'closed') { o.removedWhy = 'closed' + (v.reason ? ' (' + v.reason + ')' : ''); return; }
      if (v.eligible === 'no') { o.removedWhy = 'not eligible' + (v.reason ? ': ' + v.reason : ''); return; }
      if (pageOk && v.deadline) o.deadline = v.deadline;
      if (pageOk && v.value) o.value = v.value;
      if (pageOk && v.status === 'open') o.checked = v.eligible === 'yes' ? 'Open and you can apply' : 'Open — checked on their page';
      if (v.eligible === 'unclear' && o.score > 3) o.score -= 1;
    });
    removed = items.filter(o => o.removedWhy);
    items = items.filter(o => !o.removedWhy);
    items.forEach(o => { if (o.linkBroken && o.score > 2) o.score -= 1; });
    items.sort((a, b) => (b.score - a.score) || ((b.checked ? 1 : 0) - (a.checked ? 1 : 0)));
  } catch (e) { if (e && e.message === 'AI_PLAN_GATE') return; }
  checking = 'done'; paintProgress(); paintList();

  // Who each funder has actually given to (360Giving open grants data)
  try {
    const names = [...new Set(items.slice(0, 10).map(o => o.funder).filter(Boolean))].slice(0, 8);
    if (!names.length) return;
    giving = 'running'; paintProgress();
    const facts = (currentOrg && currentOrg.settings && currentOrg.settings.bid_facts) || {};
    const pcs = [...new Set(String((facts.postcode || '') + ' ' + (facts.address || '') + ' ' + getOrgProfile()).toUpperCase().match(/\b[A-Z]{1,2}\d[A-Z\d]?\b/g) || [])].map(p => p.replace(/\d.*$/, '')).slice(0, 3);
    const kw = [...new Set((what + ' ' + (DB.events || []).slice(0, 40).map(e => e.name).join(' ')).toLowerCase().split(/[^a-z]+/).filter(w => w.length > 4 && !/^(event|session|together|community|support|people|group|groups|local)$/.test(w)))].slice(0, 20);
    const r = await _postJSON('/api/funder-giving', { funders: names, area, postcodes: pcs, keywords: kw });
    const byName = {}; ((r && r.funders) || []).forEach(f => { if (f && f.asked) byName[f.asked] = f; });
    items.forEach(o => {
      const g = byName[o.funder]; if (!g) return;
      o.giving = g;
      if (g.localSimilar && o.score < 5) o.score += 1;                        // they fund groups like this nearby: a stronger bet
      if (g.found && g.recent >= 50 && !g.local && !g.similar && o.score > 2) o.score -= 1;   // lots of grants, none like this
    });
    items.sort((a, b) => (b.score - a.score) || (((b.giving && b.giving.localSimilar) || 0) - ((a.giving && a.giving.localSimilar) || 0)));
  } catch (e) { /* giving data is a bonus */ }
  giving = 'done'; paintProgress(); paintList();
}

// ── about your organisation: saved on the organisation so the whole team shares it ──
function _orgProfileKey() { return 'vorlana_org_profile_' + ((currentOrg && currentOrg.id) || 'default'); }
function getOrgProfile() {
  const org = (currentOrg && currentOrg.settings && currentOrg.settings.bd_profile) || '';
  if (org) return String(org).trim();
  try { return (localStorage.getItem(_orgProfileKey()) || '').trim(); } catch (e) { return ''; }
}
function populateOrgProfileField() { const el = $('eoi-org-profile'); if (el && !el.value) el.value = getOrgProfile(); if (typeof bdInit === 'function') bdInit(); }
async function saveOrgProfileFromField() {
  const el = $('eoi-org-profile'); if (!el) return;
  const text = el.value || '';
  try { localStorage.setItem(_orgProfileKey(), text); } catch (e) { /* ignore */ }
  try {
    const settings = Object.assign({}, (currentOrg && currentOrg.settings) || {}, { bd_profile: text, bd_setup: bdSetupRead() });
    await sbUpdate('organisations', { settings }, orgId);
    if (currentOrg) currentOrg.settings = settings;
  } catch (e) { /* advisers can't save for the org; the local copy still works */ }
  bdSetupLocalSave();
  const s = $('eoi-profile-saved'); if (s) { s.style.display = 'inline'; setTimeout(() => { s.style.display = 'none'; }, 2500); }
}
// Looks the organisation up and drafts the profile for the person to check. Never writes commentary into it.
async function fillOrgProfileFromWeb() {
  const el = $('eoi-org-profile'); if (!el) return;
  const name = (currentOrg && currentOrg.name) || '';
  const site = (($('bd-site') || {}).value || '').trim();
  const before = el.value;
  el.value = 'Looking up your organisation…';
  const sys = 'You are a UK bid researcher. Using web search, build an organisation profile for an Expression of Interest, from the organisation\'s own website, the Charity Commission register and Companies House. ' +
    'The website or number given is the source of truth for WHO the organisation is. The account name may be just an internal label (for example a test account) — if it differs from what you find, ignore it and describe the organisation you found. ' +
    'Output ONLY the profile, one "Label: value" line per item, exactly in this layout. Write [CHECK] after any value you could not confirm. NEVER write warnings, comments, questions or explanations. ' +
    'Layout:\nLegal & trading name: … (charity no. …, company no. …)\nRegistered address: …\nWebsite: …\nLead contact: … [CHECK]\nFounded: … · Where you deliver: …\nMission: …\nTrack record: … (only real, published numbers)\nPartnerships: …\nAccreditations and policies: …';
  try {
    const out = await callClaude(sys, 'Website / details given: ' + (site || 'none') + '\nAccount label (may be wrong, ignore if it differs): ' + name, 900, true);
    const lines = String(out || '').replace(/<\/?cite[^>]*>/gi, '').split('\n').map(x => x.trim()).filter(x => /^[A-Z][A-Za-z &\/'’\-–·()]{2,40}:\s*\S/.test(x));
    if (lines.length < 3) { el.value = before; alert('We couldn\'t confirm enough about the organisation online. Please type a few lines in the box instead — who you are, what you\'ve achieved, who you work with.'); return; }
    el.value = lines.join('\n'); bdRefreshSummary();
  } catch (e) { el.value = before; if (e && e.message !== 'AI_PLAN_GATE') alert('Could not look it up: ' + (e.message || e)); }
}

// ── pull the funder's form, read it, answer it, fill it in ──
async function _docxText(b64) {
  if (!window.mammoth) return '';
  const bin = atob(b64); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const { value } = await window.mammoth.extractRawText({ arrayBuffer: bytes.buffer });
  return value || '';
}
const _QS_SYS = 'You are parsing a UK funding Expression of Interest form. Extract every question or field the applicant must complete, in order. ' +
  'Return ONLY a valid JSON array — no prose, no markdown, no code fences. ' +
  'Each item: {"id":"q1","question":"<exact question text, word for word>","wordLimit":<number or null>,"charLimit":<number or null>,"guidance":"<any limit/guidance note, else empty string>"}. ' +
  'Include short mandatory fields too (project title, amount requested, organisation name). ' +
  'Copy limits exactly as the form states them: a word limit goes in wordLimit; a character limit goes in charLimit (and wordLimit is then that number divided by 6, rounded). Never turn characters into words in the question text. ' +
  'If no limit is stated, wordLimit is null. Return at most 25 items. If the text contains no application questions at all, return [].';
async function _parseQuestionsText(text) {
  const raw = await callClaude(_QS_SYS, String(text).slice(0, 12000), 1100, false, { model: AI_MODELS.smart, long: true, purpose: 'bid_questions' });
  const m = String(raw || '').replace(/```json|```/gi, '').trim().match(/\[[\s\S]*\]/);
  if (!m) return [];
  const arr = JSON.parse(m[0]);
  return Array.isArray(arr) ? arr : [];
}
async function _pdfQuestions(b64) {
  const out = await vAI(_QS_SYS, [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }, { type: 'text', text: 'Extract the questions from this form.' }], 1800);
  return Array.isArray(out) ? out : (out && Array.isArray(out.questions) ? out.questions : []);
}
function _toQuestions(arr) {
  return (arr || []).map((q, i) => ({ id: q.id || ('q' + (i + 1)), question: String(q.question || '').trim(),
    wordLimit: (typeof q.wordLimit === 'number' && q.wordLimit > 0) ? Math.round(q.wordLimit) : null,
    charLimit: (typeof q.charLimit === 'number' && q.charLimit > 0) ? Math.round(q.charLimit) : null, guidance: String(q.guidance || '').trim() })).filter(q => q.question);
}
// 1. their form: the page's own link first, then ask the web where it lives
async function _findFunderForm(o, name) {
  const tried = new Set(); let pageText = '';
  const tryUrl = async u => {
    if (!u || tried.has(u)) return null; tried.add(u);
    let r; try { r = await _postJSON('/api/fetch-form', { url: u }); } catch (e) { return null; }
    if (r && r.pageText && r.pageText.length > pageText.length) pageText = r.pageText;
    return r && r.ok && r.base64 ? r : null;
  };
  let r = await tryUrl(o.url);
  if (!r) {
    let urls = [];
    try {
      const raw = await callClaude('You find official funder pages. Reply with ONLY up to 3 full URLs, one per line: the official page or document where applicants get the Expression of Interest / application form for this funding programme. No other text.',
        'Funder / programme: ' + name + (o.url ? '\nKnown page: ' + o.url : ''), 300, true);
      urls = (String(raw).match(/https?:\/\/[^\s)>\]"']+/g) || []).slice(0, 3);
    } catch (e) { if (e && e.message === 'AI_PLAN_GATE') throw e; }
    for (const u of urls) { r = await tryUrl(u); if (r) break; }
  }
  if (r) return { kind: r.kind, base64: r.base64, filename: r.filename, formUrl: r.formUrl, pageText };
  return { kind: pageText ? 'page' : 'none', pageText };
}
// 2. its questions
async function _readFormQuestions(found, o, name) {
  if (found.kind === 'docx' && found.base64) {
    const r = await _postJSON('/api/eoi-form', { action: 'parse', docxBase64: found.base64 });
    if (r.ok && r.items && r.items.length) { _eoiDoc = { kind: 'docx', base64: found.base64, name: found.filename, url: found.formUrl }; _eoiQuestions = _toQuestions(r.items); return; }
    found.text = await _docxText(found.base64);       // a Word file with no answer spaces we recognise: read it as text
  }
  if (found.kind === 'pdf' && found.base64) {
    let arr = []; try { arr = await _pdfQuestions(found.base64); } catch (e) { if (e && e.message === 'AI_PLAN_GATE') throw e; }
    if (arr.length) { _eoiDoc = { kind: 'pdf', name: found.filename, url: found.formUrl }; _eoiQuestions = _toQuestions(arr); return; }
  }
  const text = found.text || found.pageText || '';
  if (text.trim()) {
    const arr = await _parseQuestionsText(text);
    if (arr.length) { _eoiDoc = { kind: 'text', url: found.formUrl || (o && o.url) }; _eoiQuestions = _toQuestions(arr); return; }
  }
  const raw = await callClaude('You are a UK bid researcher. Find the actual Expression of Interest / application questions an applicant must answer for this specific funding programme. Return each question on its own line, with any stated word or character limit in brackets. If you cannot find the exact form, list the key questions or assessment criteria the application is known to require, one per line. No preamble, just the questions.',
    'Funder / programme: ' + name + (o && o.url ? '\nInfo page: ' + o.url : ''), 900, true);
  const arr = await _parseQuestionsText(cleanReportText(raw));
  if (arr.length) { _eoiDoc = { kind: 'text', url: o && o.url, fromWeb: true }; _eoiQuestions = _toQuestions(arr); }
}
// 3. their form, with the answers written in
async function _buildFilledForm() {
  if (!_eoiDoc || _eoiDoc.kind !== 'docx') return null;
  const answers = {}; _eoiQuestions.forEach(q => { const a = _plainAnswer(_eoiAnswers[q.id] || '').trim(); if (a) answers[q.id] = a; });
  const r = await _postJSON('/api/eoi-form', { action: 'fill', docxBase64: _eoiDoc.base64, answers });
  if (!r.ok) throw new Error(r.error || 'Could not fill the form');
  return r;
}
function _eoiFileName(suffix) {
  const funder = (($('eoi-funder') || {}).value || '').trim();
  const base = (_eoiDoc && _eoiDoc.name) ? _eoiDoc.name.replace(/\.(docx|pdf|doc)$/i, '') : (funder || 'Expression of Interest');
  return (base + ' - ' + ((currentOrg && currentOrg.name) || 'our organisation') + ' - ' + suffix + '.docx').replace(/[^\w .()\-]+/g, '_');
}
async function downloadFilledForm() {
  const btn = $('eoi-dl-form'); const label = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Preparing…'; }
  try { const r = await _buildFilledForm(); if (r) _downloadBase64(r.filledBase64, _eoiFileName('filled in'), _DOCX_MIME); }
  catch (e) { alert('Could not fill their form: ' + (e.message || e)); }
  finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
}
async function downloadAnswersDoc() {
  const funder = (($('eoi-funder') || {}).value || '').trim() || 'the funder';
  const org = _eoiApplicant(_eoiCleanProfile(getOrgProfile())) || (currentOrg && currentOrg.name) || '';
  const qa = _eoiQuestions.map(q => { const a = _plainAnswer(_eoiAnswers[q.id] || ''); return { q: q.question, a, limit: (q.wordLimit ? 'Limit ' + q.wordLimit + ' words · ' : '') + _wordCount(a) + ' words' }; });
  try {
    const r = await _postJSON('/api/eoi-form', { action: 'answers-doc', title: 'Expression of Interest — ' + funder, subtitle: org + ' · ' + new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }), qa });
    if (!r.ok) throw new Error(r.error || 'failed');
    _downloadBase64(r.filledBase64, _eoiFileName('answers'), _DOCX_MIME);
  } catch (e) { alert('Could not make the document: ' + (e.message || e)); }
}

// The whole thing, from one click on a result
async function pullFunderForm(key) {
  const o = _bdOpps[key]; if (!o) { alert('That result is no longer on screen — please run the search again.'); return; }
  _bdSel = o;
  const name = (o.funder && o.programme) ? (o.funder + ' — ' + o.programme) : (o.programme || o.funder || '');
  const steps = [{ label: 'Finding their form' }, { label: 'Reading the questions' }, { label: 'Writing your answers' }, { label: 'Filling in their form' }];
  const show = (i, sub) => { const el = $('bd-pull-steps'); if (el) el.innerHTML = i >= 4 ? '' : renderBrainProgress(steps, i, 'Writing your bid for ' + (o.funder || name), sub || 'This can take a few minutes — you can leave this screen and come back'); bdWsSteps(i <= 0 ? 0 : i === 1 ? 1 : 2); };
  const note = (html, tone) => { const n = $('bd-pull-note'); if (n) n.innerHTML = html ? '<div class="bd-pullnote" style="' + (tone === 'warn' ? 'background:#FFFBEB' : tone === 'ok' ? 'background:#F0FDF4' : '') + '">' + html + '</div>' : ''; };
  let watchdog = null;
  try {
    if ($('eoi-funder')) $('eoi-funder').value = name;
    _eoiDoc = null; _eoiQuestions = []; _eoiAnswers = {}; _eoiFunderPriorities = ''; _eoiPrioritiesFunder = ''; _eoiGuidanceText = ''; _eoiProject = ''; _eoiProjectFor = ''; _eoiBrief = null; window._eoiAssessed = null;
    bdWsReset();
    if ($('bd-manual')) $('bd-manual').open = false;
    if ($('bd-funder-row')) $('bd-funder-row').style.display = 'none';
    bdShowSection(2);
    note('');
    show(0, 'Looking on their website…');
    // a gentle nudge if it's slow, so it never looks stuck
    watchdog = setTimeout(() => note('Still working — funder sites and the AI can be slow. You can wait, or <a href="#" onclick="bdManualStart();return false" style="color:var(--em);font-weight:600">upload their form instead</a>.'), 60000);
    window._eoiOnProgress = (i, n) => { steps[2].meta = i < 0 ? 'Planning the bid' : (i + ' of ' + n + ' answers written'); show(2, 'Writing every answer from your project, records and their criteria'); };

    const found = await _findFunderForm(o, name);
    _eoiGuidanceText = String(found.pageText || '').slice(0, 14000);
    steps[0].meta = found.base64 ? (found.filename || 'form found') : (found.kind === 'page' ? 'No file to download — reading their page' : 'No downloadable form found');
    show(1, 'Reading what they ask');
    await _readFormQuestions(found, o, name);
    if (!_eoiQuestions.length) throw new Error('NO_QUESTIONS');
    steps[1].meta = _eoiQuestions.length + ' question' + (_eoiQuestions.length === 1 ? '' : 's') + (_eoiDoc && _eoiDoc.kind === 'docx' ? ' · Word form' : _eoiDoc && _eoiDoc.kind === 'pdf' ? ' · PDF form' : '');
    show(2, 'Writing every answer from your profile and records');
    bdShowSection(3);
    await runEOIFormFill();
    window._eoiOnProgress = null;
    if (!Object.keys(_eoiAnswers).length) { note('✦ Writing bids with Vorlana is part of the <b>Pro</b> plan. You can still upload or paste the funder\'s questions and answer them yourself.', 'warn'); return; }
    show(3, 'Putting the answers into their form');
    if (_eoiDoc && _eoiDoc.kind === 'docx') {
      try { const r = await _buildFilledForm(); _eoiDoc.filled = { n: r.filled, total: r.total }; steps[3].meta = r.filled + ' of ' + r.total + ' answer spaces filled'; }
      catch (e) { steps[3].meta = 'couldn\'t write into their file — answers are below'; }
    } else steps[3].meta = 'Their form isn\'t a Word file, so the answers are written out for you to copy across';
    show(4, 'Done');
    renderFilledEOI();
  } catch (e) {
    window._eoiOnProgress = null;
    if (e && e.message === 'AI_PLAN_GATE') { note('✦ Writing bids with Vorlana is part of the <b>Pro</b> plan. You can still upload or paste the funder\'s questions and answer them yourself.', 'warn'); }
    else {
      const m = $('bd-manual'); if (m) m.open = true;
      const st = $('bd-pull-steps'); if (st) st.innerHTML = '';
      if ($('bd-funder-row')) $('bd-funder-row').style.display = '';
      if ($('bd-s2')) $('bd-s2').style.display = '';
      bdWsSteps(0);
      note((e && e.message === 'NO_QUESTIONS' ? 'We couldn\'t find an application form or questions for <b>' + escapeHTML(name) + '</b> on their website.' : 'Something went wrong getting the form' + (e && e.message ? ' <span style="color:var(--txt3)">(' + escapeHTML(e.message) + ')</span>' : '') + '.') +
        '<br>No problem — upload their form, paste their questions, or write from their brief below.' + (o.url ? ' <a href="' + escapeHTML(o.url) + '" target="_blank" rel="noopener" style="color:var(--em);font-weight:600">Open their page ↗</a>' : ''), 'warn');
    }
  } finally { if (watchdog) clearTimeout(watchdog); }
}
var startEOIFromOpportunity = pullFunderForm;      // older buttons and bookmarks keep working

// ═════════════════════════════════════════════════════════════
// EOI ENGINE — form-fill + grounded drafting
// ═════════════════════════════════════════════════════════════

// The single biggest quality lever: real, verifiable numbers from the CRM.
// IMPORTANT: only emit metrics that are > 0. Broadcasting zeros makes a bid
// read as "we have done nothing" — which sinks it.
function buildEOIEvidence() {
  const P = orgPeople();
  const E = orgUses('events') ? (DB.events || []) : [];
  const H = orgUses('volunteers') ? (DB.volunteer_hours || []) : [];
  const cx = (orgUses('circular') && typeof CXR !== 'undefined' && CXR.ok) ? cxReportStats({}) : null;
  const FB = DB.feedback || [];
  const C = DB.contracts || [];

  const total = P.length;
  if (!total && !E.length && !FB.length && !C.length && !(cx && cx.entries) && !H.length) {
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
    // cost per outcome only means something for contracts with outcome targets
    if (num(c.target_outcomes)) { totalValue += num(c.value); totalActualOutcomes += num(c.actual_outcomes); }
    const bits = [];
    if (num(c.target_starts)) bits.push(num(c.actual_starts) + '/' + num(c.target_starts) + ' starts');
    if (num(c.target_outcomes)) bits.push(num(c.actual_outcomes) + '/' + num(c.target_outcomes) + ' outcomes');
    if (bits.length) contractLines.push(c.name + ': ' + bits.join(', '));
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
  const hrs = Math.round(H.reduce((a, h) => a + num(h.hours), 0));
  if (hrs) lines.push('- Volunteer hours given: ' + hrs + ' (valued at about £' + Math.round(hrs * VOL_HOUR_RATE).toLocaleString() + ' at the Living Wage)');
  if (cx && cx.entries) {
    lines.push('- Diverted from waste: ' + cx.kg + ' kg' + (cx.reused ? ' (' + cx.reused + ' items reused or repaired)' : ''));
    if (cx.foodKg) lines.push('- Food grown/shared: ' + cx.foodKg + ' kg (about ' + cx.meals + ' meals)');
    if (cx.fixRate != null) lines.push('- Repair fix rate: ' + cx.fixRate + '% (' + cx.repairFixed + ' of ' + cx.repairTried + ')');
    if (cx.co2) lines.push('- Estimated CO2e avoided: ' + (Math.round(cx.co2 / 100) / 10) + ' tonnes (an estimate from per-item factors)');
    if (cx.income) lines.push('- Income from resale: £' + Math.round(cx.income).toLocaleString());
  }
  if (contractLines.length) lines.push('- Contract delivery vs target: ' + contractLines.join(' | '));
  if (costPerOutcome) lines.push('- Approx cost per outcome (funded contracts): £' + costPerOutcome.toLocaleString());
  if (caseStudy) lines.push('- Anonymised case-study facts: a participant ' + caseStudy);

  // ── Richer evidence: what people say, who we reach, the trend, a real story ──
  const day = d => String(d || '').slice(0, 10);
  const today = new Date().toISOString().slice(0, 10), back = n => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const fbN = FB.filter(f => f.enjoyed != null || f.cb != null || f.learned != null);
  if (fbN.length >= 10) {
    const share = (arr, test) => arr.length ? Math.round(100 * arr.filter(test).length / arr.length) : null;
    const en = fbN.filter(f => f.enjoyed != null && f.enjoyed !== ''), conf = fbN.filter(f => f.cb != null && f.ca != null && f.cb !== '' && f.ca !== '');
    const yn = k => fbN.filter(f => typeof f[k] === 'boolean');
    const bits = [];
    if (en.length >= 10) bits.push(share(en, f => num(f.enjoyed) >= 4) + '% rated their session 4 or 5 out of 5');
    if (conf.length >= 10) bits.push(share(conf, f => num(f.ca) > num(f.cb)) + '% felt more confident afterwards');
    if (yn('learned').length >= 10) bits.push(share(yn('learned'), f => f.learned) + '% learned something new');
    if (yn('connected').length >= 10) bits.push(share(yn('connected'), f => f.connected) + '% felt more connected to their community');
    if (yn('friend').length >= 10) bits.push(share(yn('friend'), f => f.friend) + '% made a new friend or talked to new people');
    if (bits.length) lines.push('- What people told us (' + fbN.length + ' feedback responses): ' + bits.join('; '));
  }
  const quotes = [], seenEv = {};
  FB.slice().sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))).forEach(f => {
    const q = String(f.quote || '').trim(), ev = f.eventId || f.event_id || '';
    if (quotes.length >= 5 || q.length < 25 || q.length > 220 || seenEv[ev] >= 2) return;
    if (quotes.some(x => x.toLowerCase() === q.toLowerCase())) return;
    seenEv[ev] = (seenEv[ev] || 0) + 1; quotes.push(q);
  });
  if (quotes.length) lines.push('- Real quotes from feedback (quote word for word or not at all, never attribute a name): ' + quotes.map(q => '"' + q.replace(/"/g, "'") + '"').join(' | '));
  const eqRows = P.map(p => p.equality_data || {}).concat(FB.map(f => f.demographics || {})).filter(d => d && (d.ethnicity || d.age || d.disability));
  if (eqRows.length >= 10) {
    const eth = eqRows.filter(d => d.ethnicity && !/prefer not/i.test(d.ethnicity));
    const bame = eth.filter(d => !/^white/i.test(d.ethnicity)).length;
    const dis = eqRows.filter(d => /^(yes|no)$/i.test(d.disability || ''));
    const ages = eqRows.filter(d => d.age);
    const older = ages.filter(d => /65|55/.test(d.age)).length, young = ages.filter(d => /16|18|^under/i.test(d.age)).length;
    const reach = [];
    if (eth.length >= 10) reach.push(Math.round(100 * bame / eth.length) + '% black and ethnic minority');
    if (dis.length >= 10) reach.push(Math.round(100 * dis.filter(d => /yes/i.test(d.disability)).length / dis.length) + '% disabled');
    if (ages.length >= 10) { reach.push(Math.round(100 * older / ages.length) + '% aged 55 or over'); if (young) reach.push(Math.round(100 * young / ages.length) + '% aged 16–24'); }
    if (reach.length) lines.push('- Who we reach (of people who told us, ' + eqRows.length + ' records): ' + reach.join(', '));
  }
  const past = E.filter(e => day(e.date) && day(e.date) <= today);
  const inWin = (from, to) => past.filter(e => day(e.date) > from && day(e.date) <= to);
  const last6 = inWin(back(182), today), prev6 = inWin(back(365), back(182));
  if (last6.length >= 4) {
    const att = arr => arr.reduce((a, e) => a + num(e.attendees), 0);
    lines.push('- Last 6 months: ' + last6.length + ' sessions, ' + att(last6) + ' attendances — visits, not unique people' + (prev6.length >= 4 ? ' (the 6 months before: ' + prev6.length + ' sessions, ' + att(prev6) + ' attendances)' : ''));
  }
  const story = P.filter(p => (p.outcomes || []).length && Array.isArray(p.notes) && p.notes.length)
    .sort((a, b) => (b.notes.length - a.notes.length))[0];
  if (story) {
    const sc = story.scores || {};
    lines.push('- A real story to use as an anonymised case study (call them "one participant" or by first initial only, never by name): referred by ' + (story.ref_source || 'a partner') +
      (story.barriers && story.barriers.length ? '; facing ' + story.barriers.join(', ').toLowerCase() : '') + '; ' + story.notes.slice(-3).map(n => n.t).join(' ') +
      ' Outcome: ' + story.outcomes.join(', ').toLowerCase() + '.' + (sc.confidence ? ' Confidence score now ' + sc.confidence + '/10.' : ''));
  }
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
  const ta = $('eoi-form-text'); const lower = (file.name || '').toLowerCase();
  bdShowSection(2);
  _eoiDoc = null;
  if (lower.endsWith('.docx')) {
    try {
      ta.value = 'Reading ' + file.name + ' …';
      const b64 = await _fileToBase64(file);
      const r = await _postJSON('/api/eoi-form', { action: 'parse', docxBase64: b64 });
      if (r.ok && r.items && r.items.length) {
        _eoiDoc = { kind: 'docx', base64: b64, name: file.name };
        _eoiQuestions = _toQuestions(r.items); _eoiAnswers = {};
        ta.value = '';
        renderEOIQuestions();
        const q = $('eoi-questions'); if (q && q.scrollIntoView) q.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
    } catch (e) { /* fall through: read it as plain text */ }
  }
  try {
    ta.value = 'Reading ' + file.name + ' …';
    const text = await readUploadedFormFile(file);
    if (!text.trim()) { ta.value = ''; alert('Could not read any text from that file. Try pasting the questions instead.'); return; }
    ta.value = text.trim();
    await parseEOIForm({ keepDoc: true });
    if (lower.endsWith('.pdf') && _eoiQuestions.length) _eoiDoc = { kind: 'pdf', name: file.name };
    else if (_eoiQuestions.length) _eoiDoc = { kind: 'text' };
  } catch (e) {
    ta.value = '';
    alert('Could not read that file: ' + e.message + '\nPaste the questions in the box instead.');
  }
}

// Parse the form text into structured questions (one AI call)
async function parseEOIForm(opts) {
  if (!(opts && opts.keepDoc)) _eoiDoc = null;
  bdShowSection(2);
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
  bdWsSteps(1); bdWsHead();
  wrap.innerHTML =
    '<div style="font-weight:700;font-size:13px;margin:4px 0 10px">Found ' + _eoiQuestions.length +
    ' question(s)' + (_eoiDoc && _eoiDoc.kind === 'docx' ? ' in their Word form' : '') + ' — edit if needed, then write the answers:</div>' +
    _eoiQuestions.map((q, i) =>
      '<div style="border:1px solid var(--border);border-radius:8px;padding:10px 12px;margin-bottom:8px">' +
        '<div style="font-size:11px;color:var(--txt3);margin-bottom:4px">Q' + (i + 1) +
          (q.wordLimit ? ' · limit ' + q.wordLimit + ' words' : ' · no stated limit') + '</div>' +
        '<textarea id="eoiq-' + q.id + '" style="width:100%;min-height:44px;font-size:13px;border:1px solid var(--border);border-radius:6px;padding:6px 8px" ' +
          'onchange="_syncEOIQuestion(\'' + q.id + '\')">' + escapeHTML(q.question) + '</textarea>' +
      '</div>'
    ).join('') +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">' +
      '<button class="btn btn-p" onclick="runEOIFormFill()">✦ ' + (_eoiDoc && _eoiDoc.kind === 'docx' ? 'Write the answers and fill their form' : 'Write the answers from my data') + '</button>' +
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
let _eoiBrief = null;   // { needsProposal, proposal: { maxPages, maxWords, sections: [{ title, asks }] }, rules: {...}, cannotApply: [], confirms: [] }
async function _ensureFunderPriorities(funder, force) {
  funder = (funder || '').trim();
  if (!funder) return;
  if (!force && _eoiFunderPriorities && _eoiPrioritiesFunder === funder) return;
  const shape = 'Use exactly these headings, each followed by short factual bullet points: PRIORITIES (what they want to fund and the change they want to see), ' +
    'HOW THEY DECIDE (what assessors or trustees score or look for, in their words, and what makes an application stand out or fail), ' +
    'WHAT YOU MUST SUBMIT (online form questions, any written proposal or application document with its sections and page or word limit, budget or financial tables, accounts and other documents), ' +
    'FUNDING RULES (grant size, how much of a project or budget they will fund, match funding they expect to be secured, what they will and will not pay for, duration), ' +
    'ELIGIBILITY (who can and cannot apply — legal forms, income, area), THEIR STYLE (how they like to be written to, key words and phrases they use). ' +
    'Say "not stated" where the information is not there. Never invent. No preamble.';
  try {
    let raw = '';
    if (_eoiGuidanceText && _eoiGuidanceText.length > 400) {     // their own page: the most reliable source
      raw = await callClaude('You read UK funders\' guidance for bid writers. From the funder page text below, pull out everything an applicant needs. If the page points to separate guidance (for example a PDF), search for it too. ' + shape,
        'Funder / programme: ' + funder + '\n\nTHEIR PAGE:\n' + _eoiGuidanceText, 1200, true, { model: AI_MODELS.smart, effort: 'medium', long: true, purpose: 'bid_funder' });
    }
    if (!raw || raw.length < 200) {
      raw = await callClaude('You are a UK funding researcher. Search for this funder\'s current guidance for applicants (their how-to-apply page and any application guidelines document) and summarise it. ' + shape,
        'Funder / programme: ' + funder, 1200, true, { model: AI_MODELS.smart, effort: 'medium', purpose: 'bid_funder' });
    }
    _eoiFunderPriorities = cleanReportText(raw);
    _eoiPrioritiesFunder = funder;
    _eoiBrief = null;
    try {
      const j = await callClaude('From this funder summary, reply with ONLY a JSON object, no other words: {"needsProposal":false,"proposal":{"maxPages":0,"maxWords":0,"sections":[{"title":"","asks":""}]},"rules":{"shareOfCost":"","matchFunding":"","minGrant":0,"maxGrant":0,"typical":""},"cannotApply":[""],"confirms":[""],"documents":[""]}. ' +
        '"needsProposal" is true only if they ask for a written proposal or application document beyond the online form questions; list its sections in their order with what each must cover. "rules" are the money rules in their words. "cannotApply" lists legal forms or groups they exclude (for example "CICs"). "confirms" lists things only the applicant can confirm or declare (policies, declarations, tax status, previous applications, accounts). "documents" lists every document they want attached or uploaded (for example latest accounts, bank statement, safeguarding policy, budget, photos). Never invent.',
        _eoiFunderPriorities.slice(0, 6000) + '\n\nIf they want a written proposal, search for their current application guidelines document and list EVERY section it names, in its order, with what each must cover — do not shorten the list.', 1200, true, { model: AI_MODELS.smart, long: true, purpose: 'bid_brief' });
      const m = String(j || '').replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
      if (m) _eoiBrief = JSON.parse(m[0]);
    } catch (e) { if (e && e.message === 'AI_PLAN_GATE') throw e; }
  } catch (e) {
    if (e && e.message === 'AI_PLAN_GATE') throw e;
  }
}
// Questions only the organisation can answer: declarations, policies, tax status, previous applications, how they heard
const _EOI_CONFIRM_RE = /declar|i confirm|please confirm|confirm (that|you)|authoris|safeguarding polic|polic(y|ies) in place|tax (resid|status)|vat regist|applied (to us|for a grant from|before)|previously applied|how did you (hear|find)|consent to|contact permission|happy for us to contact|terms and conditions|data protection statement|signature|decision.?makers|trustees .*belong|leadership .*(belong|identif)|belong to a specific group/i;
const _EOI_FOLLOWUP_RE = /^\s*if (you )?(have )?(selected|answered|ticked|chose|said)\s+["']?(yes|no)\b/i;
// Does the funder exclude this kind of organisation?
function _eoiExcluded() {
  const type = String((($('bd-type') && typeof bdSetupRead === 'function') ? bdSetupRead() : ((typeof bdSetupGet === 'function' && bdSetupGet()) || {})).type || '').toLowerCase();
  const ex = (_eoiBrief && Array.isArray(_eoiBrief.cannotApply)) ? _eoiBrief.cannotApply.filter(Boolean) : [];
  if (!type || !ex.length) return '';
  const hit = ex.find(x => { const t = String(x).toLowerCase(); return (/cic|community interest/.test(t) && /cic/.test(type)) || (/compan|business/.test(t) && /^company/.test(type)) || (/unincorporated|community group/.test(t) && /unincorporated|community group/.test(type)) || (/social enterprise/.test(t) && /social enterprise/.test(type)); });
  return hit ? String(hit) : '';
}

// ── The project the bid is for: Vorlana suggests three from what the organisation already does; one tap to choose ──
function _eoiProgrammes() {
  const names = {};
  (DB.events || []).filter(e => !e._demo || (typeof _demoMode !== 'undefined' && _demoMode)).forEach(e => { if (e.name) names[e.name] = (names[e.name] || 0) + 1; });
  const ev = Object.entries(names).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, c]) => n + ' (' + c + ' sessions)');
  const con = (DB.contracts || []).map(c => c.name + (c.funder ? ' — funded by ' + c.funder : '') + (c.value ? ', £' + num(c.value).toLocaleString() : '')).slice(0, 6);
  return (ev.length ? 'Regular activities: ' + ev.join('; ') + '\n' : '') + (con.length ? 'Current funded work: ' + con.join('; ') : '');
}
// The money a bid needs — never invented. Asked once (when the funder has money rules or wants finances) and remembered.
function _eoiNeedsMoney() {
  const r = (_eoiBrief && _eoiBrief.rules) || {};
  return !!(_eoiBrief && (_eoiBrief.needsProposal || r.shareOfCost || r.matchFunding)) || _eoiQuestions.some(q => /budget|income|financ|cost|spend|turnover|accounts|match fund|secured/i.test(q.question));
}
function _eoiMoneyFacts() {
  const f = ((currentOrg && currentOrg.settings && currentOrg.settings.bid_facts) || {});
  const gbp = v => { const n = +String(v || '').replace(/[^\d.]/g, ''); return n ? '£' + Math.round(n).toLocaleString('en-GB') : ''; };
  const lines = [];
  if (f.annual_spend) lines.push('Total spending in the last full year: ' + gbp(f.annual_spend));
  if (f.annual_income) lines.push('Total income in the last full year: ' + (gbp(f.annual_income) || f.annual_income));
  if (f.income_previous) lines.push('Total income the year before: ' + f.income_previous);
  if (f.secured_income) lines.push('Income already secured for the next 12 months: ' + gbp(f.secured_income));
  if (f.reserves) lines.push('Unrestricted reserves: ' + gbp(f.reserves));
  const con = (DB.contracts || []).filter(c => !c._demo || (typeof _demoMode !== 'undefined' && _demoMode)).filter(c => c.value);
  if (con.length) lines.push('Current funded contracts (whole-contract values): ' + con.map(c => (c.funder || c.name) + ' £' + num(c.value).toLocaleString('en-GB') + (c.start_date && c.end_date ? ' (' + c.start_date.slice(0, 7) + ' to ' + c.end_date.slice(0, 7) + ')' : '')).join('; '));
  const g = (typeof _bdSel !== 'undefined' && _bdSel && _bdSel.giving && _bdSel.giving.found) ? _bdSel.giving : null;
  if (g && g.typical) lines.push('This funder\'s typical recent grant: £' + g.typical.median.toLocaleString('en-GB') + ' (middle half £' + g.typical.low.toLocaleString('en-GB') + '–£' + g.typical.high.toLocaleString('en-GB') + ', from ' + g.recent + ' recent grants)');
  return lines.length ? 'MONEY FACTS (the only money figures you may use; never invent budgets, totals, income or secured amounts — if one is needed and missing, use an [INSERT: ...] placeholder):\n' + lines.join('\n') : 'MONEY FACTS: none given — never invent budgets, totals, income or secured amounts; use [INSERT: ...] placeholders for them.';
}
async function _eoiMoneyCheck(res, funder) {
  if (!_eoiNeedsMoney()) return;
  const f = ((currentOrg && currentOrg.settings && currentOrg.settings.bid_facts) || {});
  if ((f.annual_spend && f.secured_income != null && f.secured_income !== '') || window._eoiMoneyAskedFor === funder) return;   // asked once; change them any time in Settings > Organisation
  const needSpend = !f.annual_spend;
  return new Promise(resolve => {
    window._eoiMoneyDone = async function (skip) {
      if (!skip) {
        const vals = { annual_spend: ($('eoi-m-spend') || {}).value, secured_income: ($('eoi-m-secured') || {}).value, reserves: ($('eoi-m-res') || {}).value };
        const keep = {}; Object.keys(vals).forEach(k => { const v = String(vals[k] || '').trim(); if (v) keep[k] = v; });
        if (Object.keys(keep).length && typeof sb !== 'undefined' && sb && orgId) {
          try {
            const r = await sb.from('organisations').select('settings').eq('id', orgId).limit(1);
            const st = (r.data && r.data[0] && r.data[0].settings) || {};
            st.bid_facts = Object.assign({}, st.bid_facts || {}, keep);
            const u = await sb.from('organisations').update({ settings: st }).eq('id', orgId);
            if (!u.error && currentOrg) currentOrg.settings = st;
            else if (currentOrg) { currentOrg.settings = currentOrg.settings || {}; currentOrg.settings.bid_facts = Object.assign({}, currentOrg.settings.bid_facts || {}, keep); }
          } catch (e) { if (currentOrg) { currentOrg.settings = currentOrg.settings || {}; currentOrg.settings.bid_facts = Object.assign({}, currentOrg.settings.bid_facts || {}, keep); } }
        }
      }
      window._eoiMoneyAskedFor = funder; window._eoiMoneyDone = null; resolve();
    };
    const r = (_eoiBrief && _eoiBrief.rules) || {};
    const rule = [r.shareOfCost, r.matchFunding, r.typical].filter(Boolean).join(' · ');
    const v = k => escapeHTML(f[k] || '');
    res.innerHTML = '<div style="font-size:18px;font-weight:700;letter-spacing:-.01em;margin-bottom:4px">' + (needSpend ? 'A few numbers, so the money is right' : 'One number, so the money is right') + '</div>' +
      '<div style="font-size:13px;color:var(--txt3);margin-bottom:12px">' + escapeHTML(funder) + (rule ? ' — ' + escapeHTML(rule) : ' looks at your finances') + '. Vorlana uses these to set the right amount and build the budget tables, and never makes figures up. Remembered for your next bid.</div>' +
      '<div class="card" style="padding:16px 18px;margin-bottom:10px">' +
        (needSpend ? '<label style="text-transform:none;letter-spacing:0;font-size:13px;font-weight:600;color:var(--txt)">Total spending in your last full year (from your accounts)</label><input id="eoi-m-spend" inputmode="decimal" placeholder="e.g. 48,000" value="' + v('annual_spend') + '" style="max-width:240px;margin-bottom:10px"/>' : '<div style="font-size:12.5px;color:var(--txt3);margin-bottom:10px">Spending last year: £' + escapeHTML(String(f.annual_spend).replace(/^£/, '')) + ' (from your details — change it in Settings › Organisation).</div>') +
        '<label style="text-transform:none;letter-spacing:0;font-size:13px;font-weight:600;color:var(--txt)">Money already secured for the next 12 months</label><input id="eoi-m-secured" inputmode="decimal" placeholder="e.g. 22,000 (0 if none)" value="' + v('secured_income') + '" style="max-width:240px;margin-bottom:10px"/>' +
        (needSpend ? '<label style="text-transform:none;letter-spacing:0;font-size:13px;font-weight:600;color:var(--txt)">Unrestricted reserves (optional)</label><input id="eoi-m-res" inputmode="decimal" placeholder="e.g. 9,000" value="' + v('reserves') + '" style="max-width:240px"/>' : '') +
        ((DB.contracts || []).length ? '<div style="font-size:12px;color:var(--txt3);margin-top:10px">Your current funders and contract values come from Funders → Contracts.</div>' : '') +
      '</div><div style="display:flex;gap:10px;align-items:center"><button class="btn btn-p" type="button" onclick="_eoiMoneyDone(false)">Continue</button><a href="#" onclick="_eoiMoneyDone(true);return false" style="font-size:12.5px;color:var(--txt3)">Skip — leave money as gaps</a></div>';
  });
}

async function _eoiChooseProject(res, funder, facts, evidence) {
  if (_eoiProject && _eoiProjectFor === funder) return;
  res.innerHTML = '<div class="brain-panel"><div class="brain-header"><div class="brain-icon">💡</div><div><div class="brain-title">Finding the best project to put to ' + escapeHTML(funder) + '</div><div class="brain-sub">Matching what you already do to what they fund</div></div></div></div>';
  let ideas = [];
  try {
    const raw = await callClaude('You are a senior UK bid strategist. Suggest the 3 strongest projects this organisation could put to this funder: each must build on work the organisation ALREADY does (from the facts and records), match the funder\'s priorities and criteria, and ask for an amount inside the funder\'s grant range that is realistic for the organisation\'s size. ' +
      'Follow the funder\'s FUNDING RULES exactly: if they fund only a share of the cost or expect match funding, set "total" to the full cost, "amount" to the share they would fund and "other" to the rest and where it would come from. Shape each idea around what THIS funder cares about most. ' +
      'Reply with ONLY a JSON array of 3 items, no other words: [{"title":"","summary":"two sentences: what it is and the change it makes","who":"who benefits and roughly how many","amount":"£ amount to ask this funder for","total":"£ total cost","other":"other funding needed and from where, or empty","duration":"e.g. 12 months","outcomes":["2-3 measurable outcomes"]}]. Never invent partners or track record that are not in the facts. Use only the venues, activities, staff and partners the organisation already has — do not add a new venue, site, partner or paid post unless the facts show one.',
      'FUNDER: ' + funder + '\n' + (_eoiFunderPriorities ? 'WHAT THE FUNDER WANTS:\n' + _eoiFunderPriorities.slice(0, 2500) + '\n' : '') + '\n' + facts.slice(0, 3000) + '\n\n' + _eoiProgrammes() + '\n\n' + evidence,
      1200, false, { model: AI_MODELS.smart, effort: 'medium', long: true, purpose: 'bid_project' });
    const t = String(raw || '').replace(/```json|```/gi, ''); const m = t.match(/\[[\s\S]*\]/);
    if (m) ideas = JSON.parse(m[0]).filter(x => x && x.title).slice(0, 3);
  } catch (e) { if (e && e.message === 'AI_PLAN_GATE') throw e; }
  const asText = x => x.title + ': ' + (x.summary || '') + (x.who ? ' Who benefits: ' + x.who + '.' : '') + (x.amount ? ' Amount requested: ' + x.amount + '.' : '') + (x.total ? ' Total cost: ' + x.total + '.' : '') + (x.other ? ' Other funding: ' + x.other + '.' : '') + (x.duration ? ' Duration: ' + x.duration + '.' : '') +
    (Array.isArray(x.outcomes) && x.outcomes.length ? ' Outcomes: ' + x.outcomes.join('; ') + '.' : '');
  if (!ideas.length) { _eoiProject = ''; _eoiProjectFor = funder; return; }    // no suggestions: write from the organisation's work
  return new Promise(resolve => {
    window._eoiPick = function (i) {
      const own = (($('eoi-own-project') || {}).value || '').trim();
      _eoiProject = i === 'own' ? own : i === 'none' ? '' : asText(ideas[i]);
      _eoiProjectFor = funder; window._eoiPick = null; resolve();
    };
    const ex = _eoiExcluded();
    res.innerHTML = (ex ? '<div class="alert alert-warn" style="margin:0 0 14px">⚠ ' + escapeHTML(funder) + '\'s guidance says they don\'t fund <b>' + escapeHTML(ex) + '</b>, and your profile says you are one. Check before you spend time on this — you can still write it.</div>' : '') +
      '<div style="font-size:18px;font-weight:700;letter-spacing:-.01em;margin-bottom:4px">Which project should this bid be for?</div>' +
      '<div style="font-size:13px;color:var(--txt3);margin-bottom:14px">Built from what you already do and what ' + escapeHTML(funder) + ' funds. Tap one and we\'ll write the bid around it.</div>' +
      ideas.map((x, i) => '<div class="card" style="margin-bottom:12px;padding:16px 18px"><div style="display:flex;gap:14px;align-items:flex-start;justify-content:space-between;flex-wrap:wrap">' +
        '<div style="flex:1;min-width:240px"><div style="font-weight:700;font-size:15px;color:var(--txt)">' + escapeHTML(x.title) + '</div>' +
        '<div style="font-size:13.5px;color:var(--txt2);margin:4px 0 6px;line-height:1.5">' + escapeHTML(x.summary || '') + '</div>' +
        '<div style="font-size:12.5px;color:var(--txt3)">' + [x.amount ? 'Ask ' + x.amount : '', x.total && x.total !== x.amount ? 'of ' + x.total + ' total' : '', x.duration, x.who].filter(Boolean).map(escapeHTML).join(' · ') + '</div>' +
        (x.other ? '<div style="font-size:12px;color:var(--txt3);margin-top:2px">Rest from: ' + escapeHTML(x.other) + '</div>' : '') +
        (Array.isArray(x.outcomes) && x.outcomes.length ? '<ul style="margin:6px 0 0 18px;font-size:12.5px;color:var(--txt2)">' + x.outcomes.map(o => '<li>' + escapeHTML(o) + '</li>').join('') + '</ul>' : '') +
        '</div><button class="btn btn-p" type="button" onclick="_eoiPick(' + i + ')">Use this</button></div></div>').join('') +
      '<details style="margin-top:4px"><summary style="font-size:13px;color:var(--em);cursor:pointer;font-weight:600">Something else in mind?</summary>' +
        '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input id="eoi-own-project" placeholder="One line is enough, e.g. a weekly cook club for 30 older people, £8,000 over a year" style="flex:1;min-width:240px"/>' +
        '<button class="btn btn-ghost" type="button" onclick="_eoiPick(\'own\')">Use mine</button></div>' +
        '<a href="#" onclick="_eoiPick(\'none\');return false" style="display:inline-block;margin-top:8px;font-size:12.5px;color:var(--txt3)">Skip — write about our work in general</a></details>';
    const pulled = $('bd-pull-steps'); if (pulled && pulled.scrollIntoView) res.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// ── One plan for the whole bid: the key message for each answer and which evidence goes where, so nothing repeats ──
// Facts the organisation has given once (saved on the organisation), so the same gaps never come back
const _EOI_FACT_KEYS = [
  ['legal_name', /legal name|organisation name|name of (your )?organisation|governing document/i, 'Legal name'],
  ['charity_number', /charity (registration )?number|registered charity number|charity no/i, 'Charity number'],
  ['company_number', /company (registration )?number|company no/i, 'Company number'],
  ['address', /registered address|organisation('s)? address|full address|venue (name and )?(street )?address|address and postcode|address of/i, 'Address'],
  ['venue', /venue|building where|main location|room or hall/i, 'Main venue'],
  ['postcode', /postcode/i, 'Postcode'],
  ['year_end', /year end|accounting year|financial year end/i, 'Accounting year end'],
  ['annual_income', /annual income|total income|turnover|income for the (last|most recent) year|income bracket|size of (your )?organisation/i, 'Income, latest year (turnover)'],
  ['annual_spend', /annual (spend|expenditure)|total (spend|expenditure)|running costs/i, 'Spending, latest year'],
  ['people_per_year', /unique (people|individuals)|people .{0,30}(typical|each|a|per) year|directly support|how many people does your (whole )?organisation/i, 'People you support in a typical year'],
  ['income_previous', /previous year|year before|last two years/i, 'Income, the year before'],
  ['staff_count', /how many (paid )?(staff|employees)|number of (paid )?(staff|employees)/i, 'Paid staff'],
  ['volunteer_count', /how many volunteers|number of volunteers/i, 'Volunteers'],
  ['trustee_count', /how many trustees|number of trustees|board members/i, 'Trustees'],
  ['website', /website|web address/i, 'Website'],
  ['contact', /lead contact|contact (name|person|details)|main contact/i, 'Main contact'],
  ['area', /ward|neighbourhood|local authority|areas? (you )?serve/i, 'Area and wards served'],
  ['signatories', /signator/i, 'Bank signatories'],
  ['trustee_review', /trustee .*(review|report|meet)|finance review/i, 'How often trustees review finances']
];
function _eoiKnownFacts() {
  const st = (currentOrg && currentOrg.settings) || {}, f = Object.assign({}, st.bid_facts || {});
  // what Vorlana already knows fills anything not given
  if (!f.contact && typeof currentUser !== 'undefined' && currentUser) {
    const md = currentUser.user_metadata || {};
    f.contact = [md.full_name || md.name, currentUser.email].filter(Boolean).join(', ');
  }
  if (!f.venue) {
    const n = {}; (DB.events || []).forEach(e => { if (e.location) n[e.location] = (n[e.location] || 0) + 1; });
    const top = Object.entries(n).sort((a, b) => b[1] - a[1])[0]; if (top && top[1] >= 3) f.venue = top[0] + ' (where most sessions are held)';
  }
  const lines = _EOI_FACT_KEYS.filter(k => f[k[0]]).map(k => k[2] + ': ' + f[k[0]]);
  if (f.secured_income) lines.push('Money secured for the next 12 months: ' + f.secured_income);
  if (f.register_year) lines.push('(Register figures are for the ' + f.register_year + '.)');
  const vActive = (DB.volunteers || []).filter(v => v.status !== 'Inactive').length, people = (typeof orgPeople === 'function' ? orgPeople() : (DB.participants || [])).length;
  if (vActive || people) lines.push('Recorded in Vorlana now: ' + [people ? people + ' participants on the caseload' : '', vActive ? vActive + ' active volunteers' : ''].filter(Boolean).join(', ') + ' (use these for current numbers; register figures are from the last accounts)');
  return lines.length ? 'FACTS THE ORGANISATION HAS CONFIRMED (use exactly, never as a placeholder):\n' + lines.join('\n') : '';
}

// One plan for the whole bid: the type and length of every answer, one fact sheet, each quote used once, a suggested budget
async function _eoiMakePlan(funder, facts, evidence, quotes) {
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  try {
    const raw = await callClaude('You are a senior UK bid writer planning a whole funding application before anyone writes. Today is ' + today + '. Reply with ONLY one JSON object, no other words:\n' +
      '{"facts":{"name of fact":"value"}, "budget":[{"line":"","amount":0,"note":""}], "answers":[{"n":1,"type":"fact|choice|short|full","words":0,"message":"","use":"","quotes":[],"criteria":""}]}\n' +
      'RULES: "facts" is ONE fact sheet every answer must use identically: project name, amount requested, duration, realistic start and end dates (allow for the funder\'s decision time from their guidance — assume 12 weeks if not stated — and never plan seasonal work that would start after its season), people reached, sessions, volunteers now and new, and any targets. Take every number from the records; never invent. ' +
      'For EVERY question give "type": "confirm" = a declaration, policy, tax status, previous application, how they heard of the funder, consent or anything only the applicant can confirm (never answered for them); "fact" = a single value such as a name, number, date, postcode, amount (words 0); "choice" = pick one of the options they list, optionally one short sentence (words 25); "short" = one or two sentences (words 50); "full" = a written answer (words = their limit, or 220; for proposal sections use the word limit given). ' +
      'PERSONALISE to this funder: "message" must say why the point matters to THIS funder (their priorities, how they decide, their funding rules and style), not just answer the question. Respect their money rules in the facts (total cost, amount asked, other funding, and a Plan B where they expect one). ' +
      '"message" is the one point that answer makes; "use" names the figures and examples it uses — each headline figure in at most two answers; "quotes" lists quote numbers from QUOTES, each quote used in ONE answer only, at most one quote per answer and only where it strengthens it. ' +
      'Answers must build one argument without repeating each other: give every proposal section its own job and never put the same sub-topic (for example "if you award a different amount", "a varied funding base") in two places. Money in "facts" must come from MONEY FACTS only, and the amount asked must follow the funder\'s money rules and recent giving. If a question asks for a budget or cost breakdown, fill "budget" with lines that add up exactly to the amount requested, built from the MONEY FACTS; otherwise leave it empty.',
      'FUNDER: ' + funder + '\n' + (_eoiFunderPriorities ? 'WHAT THE FUNDER WANTS:\n' + _eoiFunderPriorities.slice(0, 3000) + '\n' : '') + (_eoiProject ? '\nTHE PROJECT: ' + _eoiProject + '\n' : '') +
      '\n' + facts.slice(0, 4500) + '\n\n' + evidence + '\n\nQUOTES:\n' + (quotes.length ? quotes.map((q, i) => (i + 1) + '. "' + q + '"').join('\n') : '(none)') +
      '\n\nQUESTIONS:\n' + _eoiQuestions.map((q, i) => (i + 1) + '. ' + q.question + (q.wordLimit ? ' (' + q.wordLimit + ' words)' : '') + (q.guidance ? ' — guidance: ' + q.guidance.slice(0, 200) : '')).join('\n'),
      1200, false, { model: AI_MODELS.best, effort: 'medium', long: true, purpose: 'bid_plan' });
    const t = String(raw || '').replace(/```json|```/gi, ''); const m = t.match(/\{[\s\S]*\}/);
    const obj = m ? JSON.parse(m[0]) : {};
    const plan = { facts: obj.facts || {}, budget: Array.isArray(obj.budget) ? obj.budget : [], byId: {} };
    (Array.isArray(obj.answers) ? obj.answers : []).forEach(x => { const q = _eoiQuestions[(+x.n || 0) - 1]; if (q) plan.byId[q.id] = x; });
    return plan;
  } catch (e) { if (e && e.message === 'AI_PLAN_GATE') throw e; return { facts: {}, budget: [], byId: {} }; }
}

// Read the whole bid the way the funder's assessor would, then fix only what needs fixing
async function _eoiAssess(funder, sheet, writeOne) {
  const qa = _eoiQuestions.map((q, i) => 'Q' + (i + 1) + '. ' + q.question + (q.charLimit ? ' (limit ' + q.charLimit + ' characters; this one has ' + String(_eoiAnswers[q.id] || '').length + ')' : q.wordLimit ? ' (limit ' + q.wordLimit + ' words)' : '') + '\nANSWER: ' + (_eoiAnswers[q.id] || '')).join('\n\n');
  let issues = [];
  try {
    const raw = await callClaude('You are the funder\'s assessor reading a whole application. List ONLY real problems that would cost marks: an answer that does not answer its own question; a one-line question answered with paragraphs (or the reverse); a number or fact that contradicts the FACT SHEET or another answer; a quote or statistic repeated across answers; a claim about the organisation that is not in the facts (for example governance, consultation or partnerships that were never stated — remove the claim and write around it; only use an [INSERT: ...] placeholder when the question itself cannot be answered without that fact); placeholders that ask the applicant to confirm or explain something (rewrite so they are not needed); dates that do not work; anything over its word limit; an answer that is generic and does not speak to THIS funder\'s priorities, how they decide, their money rules or style (rewrite it for them); a request that breaks their funding rules — do the maths: work out the amount asked as a share of the total budget or project cost and compare it with their rules and typical grant; any money figure not in MONEY FACTS or the FACT SHEET (invented); attendances presented as numbers of people; two sections covering the same sub-topic. Never fill in [CONFIRM: …] items — leave them exactly as they are. ' +
      'Reply with ONLY a JSON array, no other words: [{"n":1,"problem":"","fix":"exactly what the rewritten answer must do"}]. If the bid is sound, reply [].',
      'FUNDER: ' + funder + '\n' + (_eoiFunderPriorities ? 'WHAT THE FUNDER WANTS:\n' + _eoiFunderPriorities.slice(0, 2500) + '\n' : '') + '\nFACT SHEET:\n' + sheet + '\n\n' + _eoiMoneyFacts() + '\n\nAPPLICATION:\n' + qa,
      1200, false, { model: AI_MODELS.best, effort: 'medium', long: true, purpose: 'bid_assess' });
    const t = String(raw || '').replace(/```json|```/gi, ''); const m = t.match(/\[[\s\S]*\]/);
    issues = m ? JSON.parse(m[0]) : [];
  } catch (e) { if (e && e.message === 'AI_PLAN_GATE') throw e; return 0; }
  const byQ = {};
  (Array.isArray(issues) ? issues : []).forEach(x => { const q = _eoiQuestions[(+x.n || 0) - 1]; if (q && x.fix && !/^\[CONFIRM:/.test(_eoiAnswers[q.id] || '')) (byQ[q.id] = byQ[q.id] || []).push(x.problem + ' → ' + x.fix); });
  const ids = Object.keys(byQ).slice(0, 10);
  await Promise.all(ids.map(id => writeOne(_eoiQuestions.find(q => q.id === id), byQ[id].join('\n'))));
  return ids.length;
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
// ── The bid writer never stops to ask questions ──────────────
// The applicant is whoever the organisation profile says it is; the account name is only an internal label.
function _eoiApplicant(profile) {
  const m = /(?:legal\s*(?:&|and)?\s*trading\s*name|legal\s*name|organisation\s*name|trading\s*name)\s*:\s*([^\n(]+)/i.exec(profile || '');
  return (m && m[1].trim()) || '';
}
// A stale warning pasted into the profile (e.g. "no organisation called X exists…") must never be treated as a fact about the applicant
const _CHATTER = /(no (such )?organisation|(does ?n['’]?t|do(es)? not|did ?n['’]?t) (appear|exist|match|seem)|not (found|registered|listed|exist)|could ?n['’]?t (find|verify|confirm)|cannot (confirm|verify)|critical mismatch|mismatch|clarif|please (confirm|provide|clarify)|what i need|i (need|appreciate|cannot|can['’]?t|could ?n['’]?t)|your (search|request) (findings|results)|you['’]?ve (given|provided)|the website you|test account|\btester\d*\b)/i;
function _eoiCleanProfile(profile) {
  return String(profile || '').split('\n').filter(l => !_CHATTER.test(l)).join('\n').trim();
}
const _EOI_NEVER_STOP = 'ABSOLUTE RULE: you are producing finished text that is pasted straight into an application. You must ALWAYS write the full draft. ' +
  'If anything looks inconsistent, unverifiable, mismatched or missing (names, registration numbers, websites, or track record that does not obviously match the funder), do NOT stop, do NOT ask questions, do NOT list what you need and do NOT comment. ' +
  'Treat the organisation facts as true, write the best honest draft, and use [INSERT: ...] for anything missing. ' +
  'Where the funder\'s priorities differ from the organisation\'s main work, describe the organisation\'s real activities in the terms the funder values (never claim work that is not in the facts) and use [INSERT: ...] for specific evidence. ';
function _eoiLooksLikeRefusal(t) {
  const x = String(t || '').trim().slice(0, 900).toLowerCase();
  return /^(i need to pause|i need to clarify|i appreciate|thank you for (the|your) (clarification|context|details)|i('| a)?m unable|i cannot|i can't|before i can|unfortunately|i('| a)?m sorry|sorry,|there('| i)?s a (critical )?(mismatch|problem|issue)|let me start fresh|i think there may be)/.test(x) ||
    /(what i need from you|i need you to (confirm|clarify)|i need to clarify|could you (please )?(confirm|clarify|provide)|critical mismatch|once you (clarify|confirm)|please (confirm|clarify|provide) (the|your|which)|what is the correct)/.test(x);
}
async function _eoiCallNoRefusal(sys, user, maxTok) {
  let raw = await callClaude(sys, user, maxTok, false);
  if (_eoiLooksLikeRefusal(raw)) {
    raw = await callClaude(sys + 'Your previous reply asked for clarification instead of writing. That is not allowed. Write the complete answer now. ',
      user + '\n\n(Write the finished text now. No questions, no commentary. Use [INSERT: ...] for anything missing.)', maxTok, false);
  }
  return raw;
}

async function runEOIFormFill() {
  if (orgUses('circular') && typeof cxReportLoad === 'function') { try { await cxReportLoad(); } catch (e) { /* optional */ } }
  if (!_eoiQuestions.length) { alert('Parse a form first.'); return; }
  _eoiQuestions.forEach(q => _syncEOIQuestion(q.id)); // pull any edits

  const funderRaw = ($('eoi-funder') && $('eoi-funder').value || '').trim();
  const funder = funderRaw || 'the funder';
  const usps = ($('eoi-usps') && $('eoi-usps').value || '').trim();
  const profile = _eoiCleanProfile(getOrgProfile());
  const evidenceAll = buildEOIEvidence();
  const quotes = ((evidenceAll.split('\n').find(l => /^- Real quotes/.test(l)) || '').match(/"([^"]+)"/g) || []).map(q => q.slice(1, -1));
  const evidence = evidenceAll.split('\n').filter(l => !/^- Real quotes/.test(l)).join('\n');   // quotes are handed out by the plan instead
  const out = $('eoi-output'); const res = $('eoi-result');
  out.style.display = 'block';
  if ($('bd-rail')) $('bd-rail').innerHTML = '';
  if ($('eoi-questions')) $('eoi-questions').style.display = 'none';
  bdWsSteps(2); bdWsHead();
  const panel = (icon, title, sub) => '<div class="brain-panel"><div class="brain-header"><div class="brain-icon">' + icon + '</div><div><div class="brain-title">' + title + '</div><div class="brain-sub">' + sub + '</div></div></div></div>';

  const applicant = _eoiApplicant(profile) || (currentOrg && currentOrg.name) || '';
  const known = _eoiKnownFacts();
  let facts = (applicant ? 'APPLICANT: ' + applicant + ' (any other name is just an internal label — ignore it)\n\n' : '') + (known ? known + '\n\n' : '') +
    'KNOWN ORGANISATION FACTS (provided by the applicant — treat as true):\n' +
    (profile ? profile.slice(0, 4000) : '(none provided — use [INSERT: ...] placeholders for organisation details such as legal name, charity/company number, address, website, contact)');

  try {
    if (funderRaw && !(_eoiFunderPriorities && _eoiPrioritiesFunder === funderRaw)) {
      res.innerHTML = panel('🔎', 'Reading ' + escapeHTML(funderRaw) + '\'s guidance', 'Their priorities, what assessors look for, eligibility and grant size');
      await _ensureFunderPriorities(funderRaw);
    }
    // Their recent giving (360Giving), if Find funding found it
    const gv = (typeof _bdSel !== 'undefined' && _bdSel && _bdSel.giving && _bdSel.giving.found) ? _bdSel.giving : null;
    if (gv && _eoiFunderPriorities && _eoiFunderPriorities.indexOf('THEIR RECENT GIVING') < 0) {
      _eoiFunderPriorities += '\nTHEIR RECENT GIVING (360Giving open data, ' + gv.recent + ' recent grants): typical grant £' + (gv.typical ? gv.typical.median.toLocaleString('en-GB') + ' (£' + gv.typical.low.toLocaleString('en-GB') + '–£' + gv.typical.high.toLocaleString('en-GB') + ')' : '?') +
        '; ' + gv.local + ' to groups in this area, ' + gv.similar + ' for similar work' + ((gv.localExamples || []).length ? '; e.g. ' + gv.localExamples.map(x => x.recipient + ' — ' + x.title + ' (£' + (x.amount || 0).toLocaleString('en-GB') + ')').join('; ') : '');
    }
    if (funderRaw) await _eoiMoneyCheck(res, funder);
    facts = facts + '\n\n' + _eoiMoneyFacts();
    if (funderRaw) await _eoiChooseProject(res, funder, facts, evidenceAll);
    // Funders like Garfield Weston judge a written proposal, not the online form: write that too
    const pr = _eoiBrief && _eoiBrief.needsProposal && _eoiBrief.proposal && Array.isArray(_eoiBrief.proposal.sections) ? _eoiBrief.proposal.sections.filter(x => x && x.title) : [];
    if (pr.length && !_eoiQuestions.some(q => q.proposal)) {
      const pages = +_eoiBrief.proposal.maxPages || 0, totalWords = +_eoiBrief.proposal.maxWords || (pages ? Math.round(pages * 430) : 0);
      const each = totalWords ? Math.max(80, Math.floor(totalWords * 0.9 / pr.length)) : null;
      pr.slice(0, 16).forEach((x, k) => _eoiQuestions.push({ id: 'p' + (k + 1), proposal: true, question: 'Proposal — ' + x.title + (x.asks ? ': ' + x.asks : ''), wordLimit: each, charLimit: null, guidance: x.asks || '' }));
    }
    res.innerHTML = panel('🧭', 'Planning your bid', 'One fact sheet, the right length for every question, each quote used once');
    if (typeof window._eoiOnProgress === 'function') { try { window._eoiOnProgress(-1, _eoiQuestions.length); } catch (e) { /* display only */ } }
    const plan = await _eoiMakePlan(funder, facts, evidence, quotes);
    const sheet = Object.keys(plan.facts).map(k => k + ': ' + plan.facts[k]).join('\n');
    const budget = plan.budget.length ? plan.budget.map(b => '- ' + b.line + ': £' + Math.round(+b.amount || 0).toLocaleString('en-GB') + (b.note ? ' — ' + b.note : '')).join('\n') : '';

    const sys =
      'You are an expert UK bid writer completing a funding application to WIN it. Everything you write is pasted straight into the funder\'s form as the applicant\'s own words. RULES: ' +
      '1) Answer EXACTLY the question asked, at the length its TYPE says. A "fact" is the value alone (a name, number, date, postcode, amount, yes/no) — no sentences. A "choice" is the option itself, then at most one short sentence. A "short" answer is one or two sentences. ' +
      '2) Never address the reader, explain what you cannot do, comment on data, apologise or add a heading — write ONLY the answer. ' +
      '3) Use the FACT SHEET for every number, name and date, word for word, so the whole bid agrees with itself. Use only the evidence and quotes the PLAN gives this answer. ' +
      '4) Never invent statistics, partners, consultation, governance, policies, accreditations or dates. Use a placeholder ONLY for a fact the question cannot be answered without and that only the organisation can know (an identifier, address, postcode, date, amount it holds) — write it short, like [INSERT: charity number]. Never write placeholders such as "confirm…", "explain why…" or "example of…": if a claim is not in the facts, leave it out and write around it; if something can be reasoned from the records (for example a target from a baseline), reason it yourself. At most one placeholder per written answer. If the organisation has confirmed a fact, use it. ' +
      '5) NEVER state or imply the organisation has no track record or that figures are zero. Money: use ONLY the MONEY FACTS and the FACT SHEET — never invent a budget, total cost, income, secured amount or funder contribution. Attendances are visits, not people: never present them as the number of people helped. Do not mention rules or requirements that do not apply to this application. ' +
      '6) Full answers: clear, warm, specific British English — lead with the direct answer, then the evidence; be concrete (who, how many, how often, what changes); stay under the limit. ' +
      '7) Write for THIS funder, not any funder: show how the answer meets what they fund and how they decide, use their own words and style, and follow their money rules (share of cost, match funding, what they will not pay for). A generic answer that could go to any funder is a failed answer. ' + _EOI_NEVER_STOP;

    _eoiAnswers = {};
    { const mm = _bdMoneyFromPlan(plan); if (mm) { mm.synced = _bdMoneySig(mm); _eoiAnswers.__money = mm; } }
    const state = _eoiQuestions.map(() => '');
    const paint = () => {
      res.innerHTML = _fillProgressHTML(state);
      const done = state.filter(x => x === 'done').length;
      if (typeof window._eoiOnProgress === 'function') { try { window._eoiOnProgress(done, _eoiQuestions.length); } catch (e) { /* display only */ } }
    };

    const writeOne = async (q, fixNote) => {
      const i = _eoiQuestions.indexOf(q), p = plan.byId[q.id] || {};
      const type = (!q.proposal && _EOI_CONFIRM_RE.test(q.question)) ? 'confirm' : (p.type === 'confirm' ? (q.question.length < 110 && !/describe|explain|tell us|how|why/i.test(q.question) ? 'fact' : 'full') : (p.type || (_eoiIsShortField(q) ? 'fact' : 'full')));
      if (type === 'confirm') {                    // only the organisation can confirm this: never answered for them
        _eoiAnswers[q.id] = '[CONFIRM: ' + q.question.replace(/\s+/g, ' ').replace(/[:?.]\s*$/, '').slice(0, 90) + (q.question.length > 90 ? '…' : '') + ']';
        if (i >= 0 && !fixNote) { state[i] = 'done'; paint(); }
        return;
      }
      const words = type === 'fact' ? 0 : type === 'choice' ? 25 : type === 'short' ? 50 : (q.charLimit ? Math.floor(q.charLimit / 6.3) : (q.wordLimit || +p.words || 220));
      const myQuotes = (Array.isArray(p.quotes) ? p.quotes : []).map(n => quotes[(+n || 0) - 1]).filter(Boolean);
      const isBudget = /budget|cost|break ?down|headings/i.test(q.question) && budget;
      const shared = [
        'FUNDER: ' + funder,
        _eoiFunderPriorities ? ('WHAT THE FUNDER WANTS:\n' + _eoiFunderPriorities.slice(0, 2500)) : '',
        _eoiProject ? ('THE PROJECT THIS BID IS FOR: ' + _eoiProject) : '',
        sheet ? ('FACT SHEET (use exactly):\n' + sheet) : '',
        _bdMoneyText(_eoiAnswers.__money),
        usps ? ('OUR STRENGTHS/USPs: ' + usps) : '',
        '', facts, '', evidence
      ].filter(Boolean).join('\n');
      const userPrompt = [
        isBudget ? ('SUGGESTED BUDGET (use these lines and amounts; they add up to the amount requested):\n' + budget) : '',
        'TYPE: ' + type + (q.charLimit && type !== 'fact' ? ' — HARD LIMIT ' + q.charLimit + ' characters including spaces (about ' + words + ' words); stay well under it' : words ? ' — about ' + words + ' words at most' : ' — the value only'),
        p.message ? ('PLAN FOR THIS ANSWER — the point it makes: ' + p.message + (p.use ? ' | evidence to use: ' + p.use : '') + (p.criteria ? ' | criteria: ' + p.criteria : '')) : '',
        myQuotes.length ? ('QUOTE YOU MAY USE (word for word, no name attached): "' + myQuotes.join('" / "') + '"') : 'Use no quotes in this answer.',
        q.guidance ? ('THE FUNDER\'S GUIDANCE FOR THIS QUESTION: ' + q.guidance) : '',
        (function () {
          if (type !== 'full' && type !== 'short') return '';
          const pa = typeof window._vlProvenAnswers === 'function' ? window._vlProvenAnswers(q.question) : [];
          return pa.length ? 'PROVEN ANSWERS FROM YOUR PAST BIDS (' + pa.map(x => x.status).join(', ') + ' — reuse what works, but bring every fact up to date with the FACT SHEET and write it for THIS funder):\n' + pa.map(x => '— to ' + x.funder + ': ' + x.answer.slice(0, 1400)).join('\n') : '';
        })(),
        fixNote ? ('AN ASSESSOR FLAGGED THE LAST VERSION — fix this:\n' + fixNote + '\nLAST VERSION:\n' + (_eoiAnswers[q.id] || '')) : '',
        'QUESTION TO ANSWER: ' + q.question
      ].filter(Boolean).join('\n');
      if (i >= 0 && !fixNote) { state[i] = 'active'; paint(); }
      try {
        const o = type === 'fact' ? { model: AI_MODELS.smart, long: true, context: shared, purpose: 'bid_field' } : { model: AI_MODELS.best, effort: 'medium', long: true, context: shared, purpose: fixNote ? 'bid_fix' : 'bid_answer' };
        let raw = await callClaude(sys, userPrompt, 1200, false, o);
        if (_eoiLooksLikeRefusal(raw)) raw = await callClaude(sys + 'Your previous reply asked for clarification instead of writing. That is not allowed. Write the answer now. ', userPrompt + '\n\n(Write the finished text now. Use [INSERT: ...] for anything missing.)', 1200, false, o);
        let ans = _eoiLooksLikeRefusal(raw) ? (_eoiAnswers[q.id] || '[INSERT: ' + q.question.replace(/[:?]\s*$/, '').slice(0, 80) + ']') : _stripLeadingLabel(cleanReportText(raw));
        // Cut off part-way through a sentence: write it once more
        if (type === 'full' && _wordCount(ans) > 40 && !/[.!?)"'’”\]]\s*$/.test(ans.trim())) {
          try { const again = await callClaude(sys, userPrompt + '\n\n(Your last version stopped mid-sentence. Write the complete answer, ending with a full sentence.)', 1200, false, o); const t = _stripLeadingLabel(cleanReportText(again)); if (t && !_eoiLooksLikeRefusal(t)) ans = t; } catch (e) { /* keep it */ }
        }
        if (q.charLimit && ans.length > q.charLimit) {
          for (let tries = 0; tries < 2 && ans.length > q.charLimit; tries++) {
            try {
              const cut = await callClaude('Shorten this funding application answer to at most ' + Math.floor(q.charLimit * 0.92) + ' characters including spaces (it is now ' + ans.length + '). Keep every figure, name and [INSERT: ...] placeholder and the strongest points. Reply with ONLY the shortened answer.',
                ans, 1200, false, { model: AI_MODELS.smart, purpose: 'bid_trim' });
              const t = _stripLeadingLabel(cleanReportText(cut));
              if (t && !_eoiLooksLikeRefusal(t) && t.length < ans.length) ans = t;
            } catch (e) { break; }
          }
        }
        const limit = q.charLimit ? 0 : (q.wordLimit || (type === 'full' ? 0 : words));
        if (limit && _wordCount(ans) > limit + (type === 'full' ? 0 : 10)) {
          try {
            const cut = await callClaude('Shorten this funding application answer to at most ' + Math.max(1, Math.floor(limit * 0.95)) + ' words. Keep every figure, name and [INSERT: ...] placeholder and the strongest points. Reply with ONLY the shortened answer.',
              ans, 1200, false, { model: AI_MODELS.smart, purpose: 'bid_trim' });
            const t = _stripLeadingLabel(cleanReportText(cut));
            if (t && !_eoiLooksLikeRefusal(t) && _wordCount(t) < _wordCount(ans)) ans = t;
          } catch (e) { /* keep it; the word count shows it */ }
        }
        _eoiAnswers[q.id] = ans;
      } catch (e) {
        if (e.message === 'AI_PLAN_GATE') throw e;
        if (!_eoiAnswers[q.id]) _eoiAnswers[q.id] = '[Could not draft this answer: ' + e.message + ']';
      }
      if (i >= 0 && !fixNote) { state[i] = 'done'; paint(); }
    };

    paint();
    await Promise.all(_eoiQuestions.map(q => writeOne(q)));
    // "If you selected Yes…" follow-ups depend on the answer before them
    _eoiQuestions.forEach((q, i) => {
      const m = _EOI_FOLLOWUP_RE.exec(q.question); const prev = _eoiQuestions[i - 1]; if (!m || !prev) return;
      const pa = String(_eoiAnswers[prev.id] || '');
      if (/^\[CONFIRM:/.test(pa)) _eoiAnswers[q.id] = '[CONFIRM: ' + q.question.replace(/\s+/g, ' ').slice(0, 90) + ']';
      else if (/^\s*no\b/i.test(pa) && /yes/i.test(m[4])) _eoiAnswers[q.id] = 'Not applicable';
      else if (/^\s*yes\b/i.test(pa) && /no/i.test(m[4])) _eoiAnswers[q.id] = 'Not applicable';
    });

    // The assessor's read of the whole bid, then fixes
    res.innerHTML = panel('🔍', 'Checking the whole bid like an assessor', 'Does every answer answer its question, agree with the rest and avoid repeating itself?');
    const fixed = await _eoiAssess(funder, sheet, writeOne);
    window._eoiAssessed = { fixed };
  } catch (e) {
    if (e && e.message === 'AI_PLAN_GATE') { res.innerHTML = ''; return; }
    throw e;
  }

  renderFilledEOI();
}

function _fillProgressHTML(state) {
  const done = state.filter(x => x === 'done').length;
  return '<div class="brain-panel"><div class="brain-header">' +
    '<div class="brain-icon">🧠</div><div>' +
    '<div class="brain-title">Writing your bid</div>' +
    '<div class="brain-sub">' + done + ' of ' + _eoiQuestions.length + ' answers written, from your project, records and the funder\'s criteria</div>' +
    '</div></div><div class="brain-steps">' +
    _eoiQuestions.map((q, i) => {
      const st = state[i];
      const icon = st === 'done' ? '<div class="bs-check">✓</div>'
        : st === 'active' ? '<div class="bs-spinner"></div>'
        : '<div class="bs-num">' + (i + 1) + '</div>';
      return '<div class="brain-step ' + st + '"><div class="bs-icon-wrap">' + icon + '</div>' +
        '<div class="bs-text"><div class="bs-label">' + escapeHTML(q.question.slice(0, 70)) + (q.question.length > 70 ? '…' : '') + '</div></div></div>';
    }).join('') + '</div></div>';
}

function _wordCount(s) { return (s || '').trim() ? (s.trim().split(/\s+/).length) : 0; }

// Assemble — render the completed form, flag limits + placeholders
function _plainAnswer(a) { return String(a || '').replace(/\*\*([^*]+)\*\*/g, '$1'); }
function _eoiCountHTML(q, ans) {
  const wc = _wordCount(ans), len = ans.length;
  const lim = q.charLimit || q.wordLimit || 0, used = q.charLimit ? len : wc;
  const over = lim && used > lim;
  return { over, pct: lim ? Math.min(100, Math.round(100 * used / lim)) : 0, lim,
    text: (q.charLimit ? len + ' / ' + q.charLimit + ' characters' : q.wordLimit ? wc + ' / ' + q.wordLimit + ' words' : wc + (wc === 1 ? ' word' : ' words')) + (over ? ' · over the limit' : '') };
}
// The answer as text, with the highlighted gaps turned back into [INSERT: …] so they stay gaps
function _bdAnsText(el) {
  let out = '';
  const walk = n => n.childNodes.forEach(c => {
    if (c.nodeType === 3) out += c.nodeValue;
    else if (c.nodeName === 'BR') out += '\n';
    else if (c.nodeName === 'MARK' && c.dataset && c.dataset.t != null) out += c.classList.contains('conf') ? '[CONFIRM:' + c.dataset.t + ']' : '[INSERT: ' + c.dataset.t + ']';
    else if (c.nodeType === 1) { if (/^(DIV|P)$/.test(c.nodeName) && out && !out.endsWith('\n')) out += '\n'; walk(c); }
  });
  walk(el);
  return out.replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function _eoiEditAnswer(id, el) {
  _eoiAnswers[id] = _bdAnsText(el);
  const q = _eoiQuestions.find(x => x.id === id); if (!q) return;
  const c = _eoiCountHTML(q, _eoiAnswers[id]);
  const m = $('eoi-wc-' + id); if (m) { m.textContent = c.text; m.classList.toggle('over', !!c.over); }
  const b = $('eoi-bar-' + id); if (b) { b.style.width = c.pct + '%'; b.classList.toggle('over', !!c.over); }
}
function _eoiAnswerHTML(ans) {
  return boldify(escapeHTML(ans))
    .replace(/\[CONFIRM:([^\]]*)\]/gi, (m, t) => '<mark class="conf" contenteditable="false" data-t="' + t + '">For you to confirm</mark>')
    .replace(/\[INSERT:([^\]]*)\]/gi, (m, t) => '<mark class="gap" contenteditable="false" data-t="' + t.trim() + '">' + t.trim() + '?</mark>')
    .replace(/\n/g, '<br/>');
}
function renderFilledEOI() {
  const res = $('eoi-result');
  window._eoiLastKind = 'form';
  const funderShort = (bdWsFunder() || 'the funder').split(' — ')[0];
  const parts = _eoiQuestions.map((q, i) => {
    const ans = _eoiAnswers[q.id] || '', id = escapeHTML(q.id);
    const c = _eoiCountHTML(q, ans);
    const confirm = /^\[CONFIRM:/.test(ans);
    const firstProposal = q.proposal && !(_eoiQuestions[i - 1] || {}).proposal;
    const title = q.proposal ? q.question.replace(/^Proposal — /, '').split(':')[0] : q.question;
    const num = q.proposal ? '' : (i + 1) + '. ';
    const long = !confirm && _wordCount(ans) >= 25;
    return (firstProposal ? '<div class="bd-sect">Written proposal</div><div class="bd-sect-s">What ' + escapeHTML(funderShort) + ' actually judges' + (_eoiBrief && _eoiBrief.proposal && _eoiBrief.proposal.maxPages ? ' · up to ' + _eoiBrief.proposal.maxPages + ' pages' : '') + '. Download it as a Word document and attach it.</div>' : '') +
      '<div class="bd-q" id="bd-q-' + id + '"><div class="bd-q-h"><div class="bd-q-t">' + num + escapeHTML(title) + '</div><div class="bd-q-n' + (c.over ? ' over' : '') + '" id="eoi-wc-' + id + '">' + (confirm ? 'Only you can answer' : c.text) + '</div></div>' +
      (c.lim && !confirm ? '<div class="bd-wc"><i id="eoi-bar-' + id + '" class="' + (c.over ? 'over' : '') + '" style="width:' + c.pct + '%"></i></div>' : '<div style="height:10px"></div>') +
      (confirm ? '<div class="bd-ans" style="color:#1E3A8A">Tick or type this yourself in ' + escapeHTML(funderShort) + '\'s form — Vorlana never answers declarations for you.</div>'
        : '<div class="bd-ans" id="eoi-ans-' + id + '" contenteditable="true" spellcheck="true" oninput="_eoiEditAnswer(\'' + id + '\',this)">' + _eoiAnswerHTML(ans) + '</div>' +
          '<div class="bd-q-a"><button type="button" onclick="bdAnsFocus(\'' + id + '\')">Edit</button>' +
          (long ? '<button type="button" onclick="bdAns(\'' + id + '\',\'shorter\',this)">Make shorter</button><button type="button" onclick="bdAns(\'' + id + '\',\'stronger\',this)">Make stronger</button>' : '') +
          '<button type="button" onclick="bdCopyAns(\'' + id + '\',this)">Copy</button>' +
          (window._bdPrev && window._bdPrev[q.id] != null ? '<button type="button" onclick="bdAnsUndo(\'' + id + '\')">Undo</button>' : '') + '</div>') +
      '</div>';
  });

  const docx = !!(_eoiDoc && _eoiDoc.kind === 'docx');
  const docNote = !_eoiDoc || _eoiDoc.reopened ? '' : docx
    ? '<div class="bd-pullnote" style="background:#F0FDF4;color:#166534;margin:0 0 14px">✓ Their own Word form is filled in' + (_eoiDoc.filled ? ' — ' + _eoiDoc.filled.n + ' of ' + _eoiDoc.filled.total + ' answer spaces' : '') + '. Edit any answer below, then download.</div>'
    : '<div class="bd-pullnote" style="margin:0 0 14px">Their form is ' + (_eoiDoc.kind === 'pdf' ? 'a PDF' : 'online') + ', so copy each answer across, or download them all as a Word document.' +
      (_eoiDoc.fromWeb ? '<br><b>We couldn\'t open their actual form</b>, so these questions and limits come from their published guidance. Check each limit against the real form — if they differ, <a href="#" onclick="bdUseOtherForm();return false" style="color:var(--em);font-weight:600">paste their questions in</a> and we\'ll rewrite to fit.' : '') + '</div>';

  _lastEOIText = _eoiQuestions.map((q, i) => 'Q' + (i + 1) + '. ' + q.question + '\n\n' + _plainAnswer(_eoiAnswers[q.id] || '')).join('\n\n');

  bdShowSection(3);
  if ($('bd-s2') && _eoiQuestions.length && Object.keys(_eoiAnswers).length) $('bd-s2').style.display = 'none';
  res.style.cssText = '';
  res.innerHTML = docNote + parts.join('') + '<div id="eoi-qa-result"></div>' +
    '<div style="margin-top:14px;font-size:11.5px;color:var(--txt3)">Drafted with Vorlana · check every figure before you submit</div>';
  bdWsBrief(); bdRenderRail(); bdResume();
}

// What this funder wants, in a few lines, above the answers
function bdWsBrief() {
  const el = $('bd-ws-brief'); if (!el) return;
  const t = String(_eoiFunderPriorities || '').trim();
  if (!t) { el.innerHTML = ''; return; }
  const section = h => { const m = new RegExp('(?:^|\\n)[#*\\s]*' + h + '[^\\n]*\\n([\\s\\S]*?)(?=\\n[#*\\s]*(?:PRIORITIES|HOW THEY DECIDE|WHAT YOU MUST SUBMIT|FUNDING RULES|ELIGIBILITY|THEIR STYLE|THEIR RECENT GIVING)\\b|$)', 'i').exec(t); return m ? m[1] : ''; };
  const bullets = s => s.split('\n').map(x => x.replace(/^[\s\-•*·]+/, '').replace(/\*\*/g, '').trim()).filter(x => x && !/^not stated\.?$/i.test(x));
  const want = bullets(section('PRIORITIES')).slice(0, 3).map(x => x.replace(/[.;]\s*$/, '')).join('; ');
  const decide = bullets(section('HOW THEY DECIDE')).slice(0, 2).map(x => x.replace(/[.;]\s*$/, '')).join('; ');
  const r = (_eoiBrief && _eoiBrief.rules) || {};
  const money = [r.maxGrant ? 'up to £' + Number(r.maxGrant).toLocaleString('en-GB') : '', r.shareOfCost || '', r.matchFunding || ''].filter(Boolean).join(' · ');
  if (!want && !decide) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="bd-brief">' + (want ? '<b>What this funder wants:</b> ' + escapeHTML(want) + '. ' : '') + (decide ? '<b>How they decide:</b> ' + escapeHTML(decide) + '. ' : '') + (money ? '<b>Money:</b> ' + escapeHTML(money) + '.' : '') +
    '<div style="font-size:12.5px;color:var(--txt3);margin-top:4px">Every answer is written to this — not just to the question.</div>' +
    '<details><summary>Everything we read about them</summary><div style="white-space:pre-wrap;font-size:12.5px;margin-top:6px;color:var(--txt2)">' + escapeHTML(t.replace(/\*\*/g, '')) + '</div></details></div>';
}

// The right-hand side: bid strength, what's left to do, documents, download
function bdRenderRail() {
  const el = $('bd-rail'); if (!el) return;
  const form = window._eoiLastKind === 'form' && _eoiQuestions.length;
  const docx = !!(_eoiDoc && _eoiDoc.kind === 'docx');
  el.innerHTML = (form ? '<div class="bd-panel" id="bd-score"></div><div class="bd-panel" id="bd-money"></div><div class="bd-panel" id="eoi-gaps"></div><div id="bd-attach"></div>' : '') +
    '<div class="bd-dl" id="bd-dl">' +
      (docx ? '<button class="btn btn-p" id="eoi-dl-form" type="button" onclick="downloadFilledForm()">Download their form, filled in</button>' : '') +
      (form ? '<button class="btn ' + (docx ? 'btn-ghost' : 'btn-p') + '" type="button" onclick="downloadAnswersDoc()">Download Word</button>' : '') +
      '<div style="display:flex;gap:8px"><button class="btn btn-ghost" style="flex:1" type="button" onclick="downloadEOIPDF()">PDF</button><button class="btn btn-ghost" style="flex:1" type="button" onclick="copyEOI();this.textContent=\'Copied\'">Copy all</button></div>' +
      '<a href="#" onclick="bdUseOtherForm();return false" style="font-size:12.5px;color:var(--txt3);text-align:center;margin-top:4px">Use a different form</a>' +
    '</div>';
  if (form) { bdRenderScore(); bdRenderMoney(); renderEOIGaps(); bdRenderAttach(); }
  else bdWsSteps(4);
}
function bdUseOtherForm() {
  if ($('bd-s2')) $('bd-s2').style.display = '';
  if ($('bd-funder-row')) $('bd-funder-row').style.display = '';
  const m = $('bd-manual'); if (m) m.open = true;
  const w = $('bd-ws'); if (w) w.scrollTo({ top: 0, behavior: 'smooth' });
}
function _bdAnswersSig() { return _eoiQuestions.map(q => String(_eoiAnswers[q.id] || '').length).join('.'); }
function bdRenderScore() {
  const el = $('bd-score'); if (!el) return;
  const sc = _eoiAnswers.__score;
  const fixed = window._eoiAssessed && window._eoiAssessed.fixed;
  const head = '<div class="bd-ph">Bid strength <span>assessor check</span></div>';
  if (window._bdRaising) { el.innerHTML = head + (sc && typeof sc.score === 'number' ? '<div class="bd-score">' + Math.round(sc.score) + '<small> / 100</small></div>' : '') + '<div style="font-size:13px;color:var(--txt2);margin-top:8px;line-height:1.5"><span class="bd-spin"></span> ' + escapeHTML(window._bdRaising) + '</div>'; return; }
  if (window._bdScoring) { el.innerHTML = head + '<div style="font-size:13px;color:var(--txt3);margin-top:8px"><span class="bd-spin"></span> Reading it like their assessor…</div>'; return; }
  if (!sc || typeof sc.score !== 'number') {
    el.innerHTML = head + '<div style="font-size:13px;color:var(--txt3);margin:6px 0 8px">See how their assessor is likely to score it.</div><button class="btn btn-ghost btn-sm" type="button" onclick="bdScore()">Check it</button>';
    const tag = bdWsFunder() + '|' + _eoiQuestions.length;
    if (window._bdScoreTried !== tag) { window._bdScoreTried = tag; bdScore(); }
    return;
  }
  const stale = sc.sig && sc.sig !== _bdAnswersSig();
  const r = window._bdRaised;
  const probs = _bdStructural();
  el.innerHTML = head +
    '<div class="bd-score">' + Math.round(sc.score) + '<small> / 100</small>' + (r && r.from != null && r.from !== Math.round(sc.score) ? ' <small style="font-size:13px;color:' + (sc.score > r.from ? '#166534' : 'var(--txt3)') + '">from ' + r.from + '</small>' : '') + '</div>' +
    (sc.summary ? '<div style="font-size:12.5px;color:var(--txt2);margin-top:4px;line-height:1.5">' + escapeHTML(sc.summary) + (sc.next ? ' <b style="font-weight:600">To lift it:</b> ' + escapeHTML(sc.next) : '') + '</div>' : '') +
    (fixed && !r ? '<div style="font-size:12px;color:#166534;margin-top:6px">✓ ' + fixed + ' answer' + (fixed === 1 ? '' : 's') + ' already improved by the assessor check</div>' : '') +
    (r && r.note ? '<div style="font-size:12px;color:var(--txt2);margin-top:6px;line-height:1.45">' + escapeHTML(r.note) + '</div>' : '') +
    (sc.parts ? '<div style="display:grid;grid-template-columns:1fr auto;gap:2px 10px;font-size:11.5px;color:var(--txt3);margin-top:8px">' + _BD_RUBRIC.map(x => '<span>' + escapeHTML(x[1].split(',')[0]) + '</span><span>' + sc.parts[x[0]] + '/20</span>').join('') + '</div>' : '') +
    probs.map(p => '<div class="bd-mwarn">' + escapeHTML(p.t) + ' ' + (window._bdFixing === p.id ? '<span class="bd-spin"></span>' : '<a href="#" onclick="bdFixQ(\'' + escapeHTML(p.id) + '\',\'' + p.k + '\');return false">' + p.label + '</a>') + '</div>').join('') +
    '<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-top:10px">' +
      (sc.score < 88 && !stale && !probs.length ? '<button class="btn btn-p btn-sm" type="button" onclick="bdRaise()">Raise the score</button>' : '') +
      (stale ? '<button class="btn btn-ghost btn-sm" type="button" onclick="bdScore()">Answers changed — check again</button>' : '') +
      (r && r.undo ? '<a href="#" onclick="bdRaiseUndo();return false" style="font-size:12.5px;color:var(--txt3);font-weight:600">Undo the changes</a>' : '') + '</div>';
}
// Scored on a fixed rubric (five parts, 20 marks each) so the same bid gets the same score; identical answers are never scored twice
const _BD_RUBRIC = [['fit', 'Fit with what this funder wants and its priorities'], ['evidence', 'Specific, evidenced claims and clear outcomes'], ['voice', 'Community involvement and the people who benefit, as this funder asks'], ['money', 'Value for money, a budget that adds up, and money rules met'], ['clarity', 'Answers the questions, consistent, complete and within limits']];
async function bdScore(force) {
  if (window._bdScoring || !_eoiQuestions.length) return;
  const sig = _bdAnswersSig();
  window._bdScoreCache = window._bdScoreCache || {};
  if (!force && _eoiAnswers.__score && _eoiAnswers.__score.sig === sig) { bdRenderScore(); return _eoiAnswers.__score.score; }
  if (window._bdScoreCache[sig]) { _eoiAnswers.__score = window._bdScoreCache[sig]; bdRenderScore(); return _eoiAnswers.__score.score; }
  window._bdScoring = true; bdRenderScore();
  const funder = bdWsFunder() || 'the funder';
  try {
    const raw = await callClaude('You are the funder\'s assessor. Mark this application on five parts, each out of 20, using the whole range consistently: 18–20 excellent, 14–17 good, 10–13 adequate, under 10 weak. ' + _BD_RUBRIC.map(r => r[0] + ' = ' + r[1]).join('; ') + '. ' +
      'Do not mark down [CONFIRM: …] items — the applicant completes those. A few short [INSERT: …] gaps cost a mark or two. An answer over its limit or cut off mid-sentence loses marks under clarity. ' +
      'Reply with ONLY a JSON object: {"fit":0,"evidence":0,"voice":0,"money":0,"clarity":0,"summary":"its main strength, under 20 words","next":"the single change that would lift the score most, naming the question number, under 30 words"}',
      'FUNDER: ' + funder + '\n' + (_eoiFunderPriorities ? 'WHAT THE FUNDER WANTS:\n' + _eoiFunderPriorities.slice(0, 2500) + '\n' : '') + _bdMoneyText(_eoiAnswers.__money) + '\n\nAPPLICATION:\n' + _bdQA(), 700, false, { model: AI_MODELS.smart, long: true, purpose: 'bid_score' });
    const m = String(raw || '').replace(/```json|```/gi, '').match(/\{[\s\S]*\}/);
    const j = m ? JSON.parse(m[0]) : null;
    if (j && _BD_RUBRIC.every(r => isFinite(+j[r[0]]))) {
      const cut = (t, n) => { t = String(t || '').trim(); if (t.length <= n) return t; const s = t.slice(0, n); const k = Math.max(s.lastIndexOf('. '), s.lastIndexOf('; ')); return (k > n * 0.5 ? s.slice(0, k + 1) : s.replace(/\s+\S*$/, '') + '…'); };
      const parts = {}; _BD_RUBRIC.forEach(r => { parts[r[0]] = Math.max(0, Math.min(20, Math.round(+j[r[0]]))); });
      const score = _BD_RUBRIC.reduce((a, r) => a + parts[r[0]], 0);
      _eoiAnswers.__score = { score, parts, summary: cut(j.summary, 200), next: cut(j.next, 260), sig, at: new Date().toISOString() };
      window._bdScoreCache[sig] = _eoiAnswers.__score;
      if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon();
    }
  } catch (e) { /* the bid is fine without a score */ }
  window._bdScoring = false; bdRenderScore();
  return _eoiAnswers.__score ? _eoiAnswers.__score.score : null;
}
// What's wrong with an answer, checked in code: over the limit, cut off, a changed people target or a new £ figure
function _bdOver(q, t) { return q.charLimit ? String(t).length > q.charLimit : q.wordLimit ? _wordCount(t) > q.wordLimit : false; }
function _bdCutOff(t) {
  const x = String(t || '').trim(); if (_wordCount(x) < 25) return false;
  const last = x.split('\n').filter(l => l.trim()).pop() || '';
  return !/[.!?…:;)"'”’\]]\s*$/.test(x) && !/^\s*([-•*]|\d+[.)])\s/.test(last);
}
const _BD_PEOPLE_RE = () => /\b(at least )(\d[\d,]*)( (?:more |extra )?(?:referred |new |local )?(?:people|participants|walkers|residents|families|children|young people|adults)\b)(?!\s+(?:will be|to be|who will be|are)\s+trained)(?![^.]{0,40}\bvolunteer)/gi;
function _bdPeopleSaid(t) {
  const out = []; let r; const re = _BD_PEOPLE_RE();
  while ((r = re.exec(String(t || '')))) out.push(+r[2].replace(/,/g, ''));
  return out;
}
// Put the people target into an answer: a plain swap of the number, done in code
function _bdPeopleFix(t, people) {
  if (!people) return t;
  return String(t || '').replace(_BD_PEOPLE_RE(), (all, a, n, rest) => { const v = +n.replace(/,/g, ''); return v !== people && v >= people * 0.2 ? a + people.toLocaleString('en-GB') + rest : all; });
}
function _bdCheck(q, t, base) {
  if (!t) return 'empty';
  if (_bdOver(q, t) && !_bdOver(q, base || '')) return 'over the limit';
  if (_bdCutOff(t) && !_bdCutOff(base || '')) return 'cut off';
  const m = _eoiAnswers.__money;
  if (m && m.people) { const had = new Set(_bdPeopleSaid(base)); if (_bdPeopleSaid(t).some(n => n !== m.people && n >= m.people * 0.2 && !had.has(n))) return 'changes the people target'; }
  const pounds = x => (String(x).replace(/,/g, '').match(/£\s?\d+(?:\.\d+)?\s?k?/gi) || []).map(v => Math.round(_bdNum(v.replace('£', ''))));
  const allowed = new Set(pounds((base || '') + '\n' + _bdFactsBundle()));
  if (pounds(t).some(n => !allowed.has(n))) return 'new money figure';
  return '';
}
// Bring an answer inside its limit (never longer than the limit, never cut off)
async function _bdFit(q, t) {
  for (let i = 0; i < 2 && _bdOver(q, t); i++) {
    try {
      const cut = await callClaude('Shorten this funding application answer to at most ' + (q.charLimit ? Math.floor(q.charLimit * 0.92) + ' characters including spaces' : Math.floor(q.wordLimit * 0.93) + ' words') + '. Keep every figure, name and [INSERT: ...] placeholder and the strongest points. End with a complete sentence. Reply with ONLY the shortened answer.',
        t, 1400, false, { model: AI_MODELS.smart, purpose: 'bid_trim' });
      const c = _stripLeadingLabel(cleanReportText(cut));
      if (c && !_eoiLooksLikeRefusal(c) && c.length < t.length) t = c; else break;
    } catch (e) { break; }
  }
  return t;
}
// Every problem in the bid that the code can see for itself
function _bdStructural() {
  const out = [], m = _eoiAnswers.__money;
  _eoiQuestions.forEach((q, i) => {
    const a = String(_eoiAnswers[q.id] || ''); if (!a || /^\[CONFIRM:/.test(a)) return;
    if (_bdOver(q, a)) out.push({ id: q.id, k: 'over', t: 'Q' + (i + 1) + ' is over the limit (' + (q.charLimit ? a.length + ' / ' + q.charLimit + ' characters' : _wordCount(a) + ' / ' + q.wordLimit + ' words') + ').', label: 'Trim it' });
    if (_bdCutOff(a)) out.push({ id: q.id, k: 'cut', t: 'Q' + (i + 1) + ' stops mid-sentence.', label: 'Finish it' });
    if (m && m.people) { const bad = _bdPeopleSaid(a).filter(n => n !== m.people && n >= m.people * 0.2); if (bad.length) out.push({ id: q.id, k: 'people', t: 'Q' + (i + 1) + ' says ' + bad[0] + ' people — the target is ' + m.people + '.', label: 'Fix it' }); }
  });
  return out;
}
async function bdFixQ(id, k) {
  const q = _eoiQuestions.find(x => x.id === id); if (!q) return;
  const a = String(_eoiAnswers[id] || '');
  window._bdFixing = id; bdRenderScore();
  try {
    let t = '';
    if (k === 'over') t = await _bdFit(q, a);
    else if (k === 'people') t = _bdPeopleFix(a, (_eoiAnswers.__money || {}).people);
    else t = await _bdImprove(q, 'The answer stops mid-sentence. Finish it properly within the limit; change nothing else.', true);
    if (t && t !== a && !(_bdOver(q, t) || _bdCutOff(t))) { window._bdPrev = window._bdPrev || {}; window._bdPrev[id] = a; _eoiAnswers[id] = t; if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon(); }
    else alert('Vorlana couldn\'t fix that one automatically — press Edit on that answer and change it by hand.');
  } catch (e) { if (!(e && e.message === 'AI_PLAN_GATE')) alert('Couldn\'t fix that answer: ' + (e.message || e)); }
  window._bdFixing = null; renderFilledEOI();
}
function _bdQA() {
  return _eoiQuestions.map((q, i) => 'Q' + (i + 1) + '. ' + q.question + (q.charLimit ? ' (limit ' + q.charLimit + ' characters; now ' + String(_eoiAnswers[q.id] || '').length + ')' : q.wordLimit ? ' (limit ' + q.wordLimit + ' words; now ' + _wordCount(_eoiAnswers[q.id] || '') + ')' : '') + '\nANSWER: ' + (_eoiAnswers[q.id] || '')).join('\n\n');
}
// Everything the writer may use, so a rewrite never needs to invent
function _bdFactsBundle() {
  const known = typeof _eoiKnownFacts === 'function' ? _eoiKnownFacts() : '';
  return [_bdMoneyText(_eoiAnswers.__money), _eoiProject ? 'THE PROJECT: ' + _eoiProject : '', known ? 'FACTS:\n' + known : '', 'ABOUT THE ORGANISATION:\n' + _eoiCleanProfile(getOrgProfile()).slice(0, 2500),
    typeof _eoiMoneyFacts === 'function' ? _eoiMoneyFacts() : '', 'RECORDS:\n' + buildEOIEvidence()].filter(Boolean).join('\n\n');
}
// ── The money: one sheet that every answer must match. The code does the adding up, never the AI. ──
function _bdGBP(n) { return '£' + Math.round(+n || 0).toLocaleString('en-GB'); }
function _bdMoneySig(m) { return m ? JSON.stringify([m.ask, m.total, m.people || 0, m.cover, (m.other || []).map(o => [o.from, o.amount, o.secured]), (m.lines || []).map(l => [l.line, l.amount])]) : ''; }
function _bdMoneyFromPlan(plan) {
  const f = (plan && plan.facts) || {}, pick = re => { const k = Object.keys(f).find(x => re.test(x)); return k ? _bdNum(String(f[k]).replace(/£/g, '')) : null; };
  const proj = String(_eoiProject || '');
  const fromProj = re => { const m = re.exec(proj); return m ? _bdNum(m[1].replace(/£/g, '')) : null; };
  const ask = pick(/amount (requested|asked)|request(ed)?\b|grant (requested|amount)|amount$/i) || fromProj(/Amount requested:\s*([^.]+)/i);
  if (!ask) return null;
  let total = pick(/total (project )?cost|project cost|total budget/i) || fromProj(/Total cost:\s*([^.]+)/i) || ask;
  if (total < ask) total = ask;
  const otherTxt = (/Other funding:\s*([^.]+)/i.exec(proj) || [])[1] || '';
  const lines = (plan && Array.isArray(plan.budget) ? plan.budget : []).filter(b => b && b.line && +b.amount > 0).map(b => ({ line: String(b.line).slice(0, 80), amount: Math.round(+b.amount) }));
  const sum = lines.reduce((a, l) => a + l.amount, 0);
  const people = pick(/people|beneficiar|participants|reach/i);
  return { ask: Math.round(ask), total: Math.round(total), people: people && people > 1 ? Math.round(people) : null, syncedPeople: people && people > 1 ? Math.round(people) : null, cover: sum && Math.abs(sum - ask) <= Math.abs(sum - total) ? 'grant' : 'total',
    other: total > ask ? [{ from: otherTxt.replace(/£\s*[\d,.]+\s*k?/gi, '').replace(/^\s*(from|of)\s+/i, '').trim().slice(0, 80) || 'Other funding', amount: Math.round(total - ask), secured: false }] : [], lines };
}
function _bdMoneyText(m) {
  if (!m) return '';
  const sum = (m.lines || []).reduce((a, l) => a + (+l.amount || 0), 0);
  return 'MONEY SHEET (fixed — every answer must use these exact figures; never change them):\n- Amount requested from this funder: ' + _bdGBP(m.ask) + '\n- Total project cost: ' + _bdGBP(m.total) +
    ((m.other || []).length ? '\n- Other funding: ' + m.other.map(o => (o.from || 'Other funding') + ' ' + _bdGBP(o.amount) + (o.secured ? ' (secured)' : ' (not yet secured)')).join('; ') : '') +
    (m.people ? '\n- People who will directly benefit over the whole project: ' + m.people + ' (about ' + _bdGBP(m.ask / m.people) + ' of the grant each)' : '') +
    ((m.lines || []).length ? '\n- Budget (' + (m.cover === 'grant' ? 'what this grant pays for' : 'the whole project') + '): ' + m.lines.map(l => l.line + ' ' + _bdGBP(l.amount)).join('; ') + '; total ' + _bdGBP(sum) : '');
}
function _bdBudgetText(m) {
  const sum = m.lines.reduce((a, l) => a + (+l.amount || 0), 0);
  return m.lines.map(l => '- ' + l.line + ': ' + _bdGBP(l.amount)).join('\n') + '\n' + (m.cover === 'grant' ? 'Total requested: ' + _bdGBP(sum) : 'Total project cost: ' + _bdGBP(sum) +
    '\nRequested from this funder: ' + _bdGBP(m.ask) + ((m.other || []).length ? '\nOther funding: ' + m.other.map(o => (o.from || 'other funding') + ' ' + _bdGBP(o.amount) + (o.secured ? ' (secured)' : ' (not yet secured)')).join('; ') : ''));
}
// What doesn't add up, worked out in code
function _bdVfm(m) {
  if (!m || !m.people || !m.ask) return null;
  const f = (currentOrg && currentOrg.settings && currentOrg.settings.bid_facts) || {};
  const spend = _bdNum(String(f.annual_spend || f.annual_income || '').replace(/£/g, '')) || 0, ppy = _bdNum(String(f.people_per_year || '')) || 0;
  const own = spend && ppy > 1 ? Math.round(spend / ppy) : 0, perHead = Math.round(m.ask / m.people);
  return { perHead, own, high: own ? perHead > own * 2 : perHead > 1500 };
}
function _bdIsBudgetQ(q) { return /budget|spend (it|the money|the grant|this) on|what (would|will) you spend|what costs|cost(s)? break ?down|break ?down (of )?(your |the )?(project )?costs?|headings/i.test(q.question || ''); }
function _bdMoneyIssues(m) {
  const out = [];
  if (!m) return out;
  const sum = (m.lines || []).reduce((a, l) => a + (+l.amount || 0), 0), other = (m.other || []).reduce((a, o) => a + (+o.amount || 0), 0);
  if (m.lines.length && m.cover === 'total' && sum !== m.total) out.push({ t: 'The budget lines add up to ' + _bdGBP(sum) + ', but the total cost says ' + _bdGBP(m.total) + '.', fix: 'total=' + sum, label: 'Make the total ' + _bdGBP(sum) });
  if (m.lines.length && m.cover === 'grant' && sum !== m.ask) out.push({ t: 'The budget lines add up to ' + _bdGBP(sum) + ', but you\'re asking for ' + _bdGBP(m.ask) + '.', fix: 'ask=' + sum, label: 'Ask for ' + _bdGBP(sum) });
  if (m.ask + other !== m.total) out.push({ t: _bdGBP(m.ask) + ' asked + ' + _bdGBP(other) + ' other funding = ' + _bdGBP(m.ask + other) + ', not the ' + _bdGBP(m.total) + ' total.', fix: 'other=' + (m.total - m.ask), label: m.total - m.ask > 0 ? 'Other funding ' + _bdGBP(m.total - m.ask) : 'Total ' + _bdGBP(m.ask + other) });
  const max = _eoiBrief && _eoiBrief.rules && +_eoiBrief.rules.maxGrant;
  if (max && m.ask > max) out.push({ t: 'You\'re asking for more than their maximum of ' + _bdGBP(max) + '.' });
  // Answers that state a different total or ask
  _eoiQuestions.forEach((q, i) => {
    const a = String(_eoiAnswers[q.id] || '').replace(/,/g, '');
    const said = (re, want, what) => { let x; const r = new RegExp(re, 'gi'); while ((x = r.exec(a))) { const n = _bdNum(x[1]); if (n && Math.abs(n - want) > 1 && n > 99) { out.push({ t: 'Q' + (i + 1) + ' says the ' + what + ' is ' + _bdGBP(n) + ' — the sheet says ' + _bdGBP(want) + '.', sync: true }); return; } } };
    said('total (?:project )?(?:cost|budget)(?: is| of)?[^£.]{0,25}£\\s?([\\d.]+\\s?k?)', m.total, 'total cost');
    said('(?:asking|ask|request(?:ing)?)[^£.]{0,40}£\\s?([\\d.]+\\s?k?)', m.ask, 'amount asked');
  });
  const target = m.cover === 'grant' ? m.ask : m.total;
  if (m.lines.length <= 1 && target >= 5000) out.push({ t: m.lines.length ? 'The budget is one lump of ' + _bdGBP(sum) + ' — funders expect it broken into costs.' : 'There\'s no budget yet — funders expect the ' + _bdGBP(target) + ' broken into costs.', fix: 'build', label: 'Break it down' });
  // Costs written in a budget answer must add up to the budget
  const known = new Set([m.ask, m.total, sum].concat((m.other || []).map(o => Math.round(+o.amount || 0))));
  // A cost line reads like "coordinator at £78,000", "Training: £14,000", "£6,000 for venues"
  const costs = x => { const t = String(x).replace(/,/g, ''), out2 = []; let r;
    const re1 = /(?:\bat|:|–|—|\bcosting|\bcosts)\s*£\s?(\d+(?:\.\d+)?\s?k?)\b/gi, re2 = /£\s?(\d+(?:\.\d+)?\s?k?)\s+(?:for|on|towards)\s+(?!(?:\d|three|two|one|four|five|the next|36|24|12))/gi;
    while ((r = re1.exec(t))) out2.push(Math.round(_bdNum(r[1])));
    while ((r = re2.exec(t))) out2.push(Math.round(_bdNum(r[1])));
    return out2; };
  const lineAmts = m.lines.map(l => Math.round(+l.amount || 0));
  _eoiQuestions.forEach((q, i) => {
    if (!_bdIsBudgetQ(q)) return;
    const items = costs(_eoiAnswers[q.id] || '').filter(n => n > 0 && (!known.has(n) || lineAmts.includes(n)));
    if (items.length < 2) return;
    const s2 = items.reduce((a, n) => a + n, 0);
    const same = items.length === lineAmts.length && items.every(n => lineAmts.includes(n));
    if (same || s2 === target && items.every(n => lineAmts.includes(n))) return;
    if (m.lines.length >= 2 && sum === target) out.push({ t: 'Q' + (i + 1) + '\'s costs (' + _bdGBP(s2) + ') don\'t match the budget yet.', sync: true });   // the sheet is right; the answer needs the figures
    else if (s2 !== target) out.push({ t: 'Q' + (i + 1) + ' lists costs adding up to ' + _bdGBP(s2) + ', but the budget is ' + _bdGBP(target) + '.', fix: 'build', label: 'Rebuild the budget' });
  });
  // Value for money: what each person costs, against what the organisation's work costs now
  const vfm = _bdVfm(m);
  if (!m.people && m.ask) out.push({ t: 'Add how many people this will reach, so Vorlana can check value for money.', soft: true });
  else if (vfm && vfm.high && !m.peopleOk) out.push({ t: _bdGBP(vfm.perHead) + ' per person (' + _bdGBP(m.ask) + ' for ' + m.people + ' people) looks high' + (vfm.own ? ' — your work now costs about ' + _bdGBP(vfm.own) + ' a person a year' : '') + '. Funders weigh value for money.', fix: 'people', label: 'Raise the target', fix2: 'peopleok', label2: 'It\'s right — explain why', vfm: true });
  (m.other || []).filter(o => !o.secured && o.amount > 0).forEach(o => out.push({ t: _bdGBP(o.amount) + ' from ' + (o.from || 'other funding') + ' isn\'t secured yet — say when you\'ll know, and what happens if it doesn\'t come.', soft: true }));
  return out;
}
function bdRenderMoney() {
  const el = $('bd-money'); if (!el) return;
  const m = _eoiAnswers.__money;
  const head = '<div class="bd-ph">The money <span>added up by Vorlana</span></div>';
  if (!m) {
    if (window._bdMoneyReading) { el.innerHTML = head + '<div style="font-size:13px;color:var(--txt3);margin-top:8px"><span class="bd-spin"></span> Reading the figures from your answers…</div>'; return; }
    el.innerHTML = head + '<div style="font-size:13px;color:var(--txt3);margin:6px 0 8px">One set of figures every answer must match.</div><button class="btn btn-ghost btn-sm" type="button" onclick="bdMoneyRead()">Set up the money</button>';
    if (window._bdMoneyTried !== bdWsFunder() && _eoiQuestions.some(q => /£/.test(_eoiAnswers[q.id] || ''))) { window._bdMoneyTried = bdWsFunder(); bdMoneyRead(); }
    return;
  }
  const sum = m.lines.reduce((a, l) => a + (+l.amount || 0), 0);
  const issues = _bdMoneyIssues(m), hard = issues.filter(x => !x.soft && !x.sync && !x.vfm);
  const inp = (path, v, w, ph) => '<input data-m="' + path + '" value="' + escapeHTML(v == null ? '' : String(v)) + '" placeholder="' + (ph || '') + '" onchange="bdMoneySet(this)" style="width:' + w + '"/>';
  el.innerHTML = head +
    '<div class="bd-mrow"><span>Asking for</span>' + inp('ask', _bdGBP(m.ask), '110px') + '</div>' +
    '<div class="bd-mrow"><span>Total project cost</span>' + inp('total', _bdGBP(m.total), '110px') + '</div>' +
    '<div class="bd-mrow"><span>People who\'ll benefit' + (m.people ? ' <small style="color:var(--txt3)">· ' + _bdGBP(m.ask / m.people) + ' each</small>' : '') + (m.peopleWhy ? '<br><small style="color:var(--txt3)">' + escapeHTML(m.peopleWhy) + '</small>' : '') + '</span>' + inp('people', m.people || '', '110px', 'e.g. 240') + '</div>' +
    (window._bdPeopleBusy ? '<div style="font-size:12.5px;color:var(--txt3);margin-top:6px"><span class="bd-spin"></span> Working out a realistic target from your records…</div>' : '') +
    (m.other || []).map((o, i) => '<div class="bd-mrow"><span>' + inp('other.' + i + '.from', o.from, '100%', 'Other funding from') + '<label class="bd-sec"><input type="checkbox" ' + (o.secured ? 'checked' : '') + ' onchange="bdMoneyOther(' + i + ',this.checked)"/> secured</label></span>' + inp('other.' + i + '.amount', _bdGBP(o.amount), '110px') + '</div>').join('') +
    '<a href="#" class="bd-madd" onclick="bdMoneyAdd(\'other\');return false">+ other funding</a>' +
    (window._bdMoneyBuilding ? '<div style="font-size:12.5px;color:var(--txt3);margin-top:10px"><span class="bd-spin"></span> Breaking the budget into costs…</div>' : '') +
    (m.lines.some(l => l.suggested) ? '<div style="font-size:11.5px;color:var(--txt3);margin-top:10px">Suggested costs — check each against your real costs.</div>' : '') +
    '<div class="bd-msub">Budget <select onchange="bdMoneySet(this)" data-m="cover"><option value="total"' + (m.cover === 'total' ? ' selected' : '') + '>whole project</option><option value="grant"' + (m.cover === 'grant' ? ' selected' : '') + '>this grant only</option></select></div>' +
    m.lines.map((l, i) => '<div class="bd-mrow">' + inp('lines.' + i + '.line', l.line, '100%', 'What it pays for') + inp('lines.' + i + '.amount', _bdGBP(l.amount), '96px') + '<button type="button" class="bd-mx" onclick="bdMoneyDel(' + i + ')" aria-label="Remove">✕</button></div>').join('') +
    '<div class="bd-mrow bd-mtot"><span><a href="#" class="bd-madd" style="margin:0" onclick="bdMoneyAdd(\'lines\');return false">+ budget line</a></span><b>' + _bdGBP(sum) + '</b></div>' +
    (issues.length ? issues.map(x => '<div class="bd-mwarn' + (x.soft ? ' soft' : '') + '">' + escapeHTML(x.t) + (x.fix ? ' <a href="#" onclick="bdMoneyFix(\'' + x.fix + '\');return false">' + escapeHTML(x.label) + '</a>' : '') + (x.fix2 ? ' · <a href="#" onclick="bdMoneyFix(\'' + x.fix2 + '\');return false">' + escapeHTML(x.label2) + '</a>' : '') + '</div>').join('')
      : '<div style="font-size:12.5px;color:#166534;margin-top:8px">✓ Everything adds up.</div>') +
    (m.synced !== _bdMoneySig(m) || issues.some(x => x.sync) ? '<button class="btn btn-p btn-sm" type="button" style="margin-top:10px" onclick="bdMoneySync()"' + (window._bdMoneySyncing ? ' disabled' : '') + '>' + (window._bdMoneySyncing ? '<span class="bd-spin"></span> Updating your answers…' : 'Put these figures in every answer') + '</button>' : '') +
    (hard.length && m.synced !== _bdMoneySig(m) ? '<div style="font-size:11.5px;color:var(--txt3);margin-top:6px">Fix the red lines first so the answers get the right figures.</div>' : '');
}
function _bdMoneySave() { if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon(); bdRenderMoney(); }
function bdMoneySet(el) {
  const m = _eoiAnswers.__money; if (!m) return;
  const path = el.dataset.m.split('.'), v = el.value;
  const val = /amount$|^ask$|^total$|^people$/.test(path[path.length - 1]) ? Math.round(_bdNum(String(v).replace(/£/g, '')) || 0) : v.trim();
  if (path[0] === 'people') { m.peopleOk = false; delete m.peopleWhy; }
  if (path.length === 1) m[path[0]] = val; else { const row = m[path[0]][+path[1]] || {}; row[path[2]] = val; delete row.suggested; }
  _bdMoneySave();
}
function bdMoneyOther(i, on) { const m = _eoiAnswers.__money; if (m && m.other[i]) { m.other[i].secured = !!on; _bdMoneySave(); } }
function bdMoneyAdd(k) { const m = _eoiAnswers.__money; if (!m) return; m[k].push(k === 'lines' ? { line: '', amount: 0 } : { from: '', amount: 0, secured: false }); _bdMoneySave(); }
function bdMoneyDel(i) { const m = _eoiAnswers.__money; if (!m) return; m.lines.splice(i, 1); _bdMoneySave(); }
function bdMoneyFix(f) {
  const m = _eoiAnswers.__money; if (!m) return;
  if (f === 'build') { bdMoneyBuild(); return; }
  if (f === 'people') { bdMoneyPeople(); return; }
  if (f === 'peopleok') { m.peopleOk = true; _bdMoneySave(); return; }
  const [k, v] = f.split('='), n = Math.round(+v);
  if (k === 'total') { m.total = n; const other = Math.max(0, n - m.ask); if (m.other.length === 1) m.other[0].amount = other; else if (!m.other.length && other) m.other.push({ from: 'Other funding', amount: other, secured: false }); }
  if (k === 'ask') { m.ask = n; m.total = n + m.other.reduce((a, o) => a + (+o.amount || 0), 0); }
  if (k === 'other') { if (n <= 0) { m.total = m.ask + m.other.reduce((a, o) => a + (+o.amount || 0), 0); } else if (m.other.length === 1) m.other[0].amount = n; else if (!m.other.length) m.other.push({ from: 'Other funding', amount: n, secured: false }); else m.total = m.ask + m.other.reduce((a, o) => a + (+o.amount || 0), 0); }
  _bdMoneySave();
}
// Break the budget into costs that add up exactly: starts from costs already in the answers, fills the rest from the project
async function bdMoneyBuild() {
  const m = _eoiAnswers.__money; if (!m || window._bdMoneyBuilding) return;
  const target = m.cover === 'grant' ? m.ask : m.total;
  if (!target) return;
  window._bdMoneyBuilding = true; bdRenderMoney();
  try {
    const raw = await callClaude('You are a UK charity finance lead building the budget for a funding application. Break ' + _bdGBP(target) + ' (' + (m.cover === 'grant' ? 'the amount asked from this funder' : 'the total project cost') + ') into 3 to 8 cost lines that add up EXACTLY to ' + target + '. ' +
      'Start from the costs already stated in the answers and keep their amounts where they fit; add lines for what is missing (for example staff time, sessional workers, venue, travel, training, materials, evaluation, a fair share of overheads), sized realistically for this organisation and project length, and only for things the project actually does. Follow the funder\'s rules on what they will and will not pay for. ' +
      'Reply with ONLY a JSON array: [{"line":"short name with the working, e.g. Walk coordinator (0.6 FTE, 36 months)","amount":0}]',
      _bdMoneyText(m) + '\n\n' + (_eoiFunderPriorities ? 'FUNDER RULES:\n' + _eoiFunderPriorities.slice(0, 2000) + '\n\n' : '') + (_eoiProject ? 'THE PROJECT: ' + _eoiProject + '\n\n' : '') + 'THE BID:\n' + _bdQA(),
      1200, false, { model: AI_MODELS.best, effort: 'medium', long: true, purpose: 'bid_budget' });
    const mm = String(raw || '').replace(/```json|```/gi, '').match(/\[[\s\S]*\]/); const arr = mm ? JSON.parse(mm[0]) : [];
    let lines = (Array.isArray(arr) ? arr : []).filter(l => l && l.line && +l.amount > 0).map(l => ({ line: String(l.line).slice(0, 90), amount: Math.round(+l.amount), suggested: true }));
    if (lines.length >= 2) {
      const diff = target - lines.reduce((a, l) => a + l.amount, 0);        // the code makes it add up, not the AI
      if (diff) { const big = lines.reduce((a, l) => l.amount > a.amount ? l : a, lines[0]); if (big.amount + diff > 0 && Math.abs(diff) <= target * 0.1) big.amount += diff; else lines.push({ line: 'Not yet itemised — to confirm', amount: diff, suggested: true }); }
      m.lines = lines.filter(l => l.amount !== 0);
    }
  } catch (e) { if (!(e && e.message === 'AI_PLAN_GATE')) alert('Couldn\'t build the budget: ' + (e.message || e)); }
  window._bdMoneyBuilding = false;
  _bdMoneySave();
}
// A realistic number of people for this money, worked out from how the work runs now
async function bdMoneyPeople() {
  const m = _eoiAnswers.__money; if (!m || window._bdPeopleBusy) return;
  window._bdPeopleBusy = true; bdRenderMoney();
  const vfm = _bdVfm(m) || {};
  try {
    const raw = await callClaude('You plan charity projects. The bid below promises too few people for the money. Work out a realistic number of people this project could directly benefit over its whole length, from how the work runs now (sessions, group sizes, how long each person stays, how many places it covers, staff time in the budget) and the records. Aim for good value for money, but only a number the organisation could honestly deliver. ' +
      'Reply with ONLY JSON: {"people":0,"why":"the working in under 20 words, e.g. 4 weekly walks x 8 new walkers every 6 weeks x 3 years"}',
      _bdMoneyText(m) + (vfm.own ? '\nTheir work now costs about ' + _bdGBP(vfm.own) + ' per person a year.' : '') + '\n\n' + (_eoiProject ? 'THE PROJECT: ' + _eoiProject + '\n\n' : '') + _bdFactsBundle().slice(0, 5000) + '\n\nTHE BID:\n' + _bdQA(),
      600, false, { model: AI_MODELS.smart, long: true, purpose: 'bid_people' });
    const mm = String(raw || '').replace(/```json|```/gi, '').match(/\{[\s\S]*\}/); const j = mm ? JSON.parse(mm[0]) : null;
    if (j && +j.people > (m.people || 0)) { m.people = Math.round(+j.people); m.peopleWhy = String(j.why || '').slice(0, 160); m.peopleOk = false; }
    else if (j) alert('The records don\'t support a bigger number honestly. Consider asking for less, or press "It\'s right — explain why".');
  } catch (e) { if (!(e && e.message === 'AI_PLAN_GATE')) alert('Couldn\'t work out a target: ' + (e.message || e)); }
  window._bdPeopleBusy = false;
  _bdMoneySave();
}
// For bids written before the money sheet: read the intended figures once
async function bdMoneyRead() {
  if (window._bdMoneyReading) return;
  window._bdMoneyReading = true; bdRenderMoney();
  try {
    const raw = await callClaude('Read this funding application and pull out its money: the amount asked from this funder, the total project cost, other funding (who from, how much, whether secured) and the budget lines. Where answers disagree, use the budget question\'s lines and the figures used most often. Never invent. ' +
      'Itemise the budget lines exactly as the answers list them (never one lump line for the whole amount). ' +
      'Also give "people": the number of people the project will directly benefit over its whole length (the main beneficiary target, not volunteers or staff), or 0 if not stated. ' +
      'Reply with ONLY JSON: {"ask":0,"total":0,"people":0,"other":[{"from":"","amount":0,"secured":false}],"lines":[{"line":"","amount":0}],"cover":"total or grant (does the budget cover the whole project or just this grant)"}',
      (_eoiProject ? 'THE PROJECT: ' + _eoiProject + '\n\n' : '') + _bdQA(), 1000, false, { model: AI_MODELS.smart, long: true, purpose: 'bid_money_read' });
    const mm = String(raw || '').replace(/```json|```/gi, '').match(/\{[\s\S]*\}/); const j = mm ? JSON.parse(mm[0]) : null;
    if (j && +j.ask > 0) {
      _eoiAnswers.__money = { ask: Math.round(+j.ask), total: Math.round(+j.total || +j.ask), people: +j.people > 1 ? Math.round(+j.people) : null, syncedPeople: +j.people > 1 ? Math.round(+j.people) : null, cover: j.cover === 'grant' ? 'grant' : 'total',
        other: (Array.isArray(j.other) ? j.other : []).filter(o => o && +o.amount > 0).map(o => ({ from: String(o.from || 'Other funding').slice(0, 80), amount: Math.round(+o.amount), secured: !!o.secured })),
        lines: (Array.isArray(j.lines) ? j.lines : []).filter(l => l && l.line && +l.amount > 0).map(l => ({ line: String(l.line).slice(0, 80), amount: Math.round(+l.amount) })) };
      if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon();
    }
  } catch (e) { /* they can set it up by hand */ }
  window._bdMoneyReading = false;
  if (!_eoiAnswers.__money) _eoiAnswers.__money = { ask: 0, total: 0, cover: 'total', other: [], lines: [] };
  bdRenderMoney();
}
// Put the sheet's figures into every answer: the budget answer is written by code, the rest only have their money sentences corrected
async function bdMoneySync() {
  const m = _eoiAnswers.__money; if (!m || window._bdMoneySyncing) return;
  window._bdMoneySyncing = true; bdRenderMoney();
  const sheet = _bdMoneyText(m);
  const isBudget = q => _bdIsBudgetQ(q);
  const before = Object.assign({}, _eoiAnswers);
  try {
    await Promise.all(_eoiQuestions.map(async q => {
      const a = String(_eoiAnswers[q.id] || '');
      if (!a || /^\[CONFIRM:/.test(a)) return;
      if (isBudget(q) && m.lines.length && _wordCount(a) >= 6 && _wordCount(a) < 80) { _eoiAnswers[q.id] = _bdBudgetText(m); return; }   // a list-style budget answer: written by code

      const wrongPeople = m.people ? _bdPeopleSaid(a).filter(n => n !== m.people && n >= m.people * 0.2) : [];
      const peopleChanged = m.people && (wrongPeople.length || (m.syncedPeople && m.syncedPeople !== m.people && new RegExp('\\b' + m.syncedPeople + '\\b').test(a)));
      const explain = m.peopleOk && !m.explained && /value|cost|budget|money|spend|right organisation|benefit/i.test(q.question);
      if (!/£/.test(a) && !peopleChanged && !explain) return;
      const out = await callClaude('Correct ONLY the money in this funding application answer so it matches the MONEY SHEET exactly: the amount asked, total project cost, other funding (and whether it is secured) and budget figures. Change no other words. ' +
        (peopleChanged ? 'The number of people who will directly benefit is now ' + m.people + ' (it was ' + ([m.syncedPeople].concat(wrongPeople).filter(Boolean).filter((v, i, x) => x.indexOf(v) === i).join(' or ') || 'different') + '): change that target everywhere it appears, and any count worked out from it; leave percentages, volunteer numbers and current figures alone. ' : '') +
        (explain ? 'Where it fits, add one or two sentences explaining why the cost per person (' + _bdGBP(m.ask / m.people) + ') is what it is, using only the records and the budget (for example intensive or one-to-one support, or lasting change). ' : '') +
        (isBudget(q) ? 'This answer explains the budget: list the MONEY SHEET budget lines and amounts, all of them, so they add up to the total shown. ' : '') +
        'Leave the organisation\'s own finances (annual income, spending, reserves, existing grants, volunteer value) exactly as they are. If a sentence states a project or budget figure that is not on the sheet, correct it to the sheet or remove that figure. Reply with ONLY the full answer.',
        sheet + '\n\nQUESTION: ' + q.question + '\n\nANSWER:\n' + a, 1400, false, { model: AI_MODELS.smart, long: true, purpose: 'bid_money_sync' });
      let t = _stripLeadingLabel(cleanReportText(out));
      if (!t || _eoiLooksLikeRefusal(t) || _wordCount(t) < _wordCount(a) * 0.8 || _wordCount(t) > _wordCount(a) * 1.15 + 10) return;
      t = _bdPeopleFix(await _bdFit(q, t), m.people);
      if (!(_bdOver(q, t) && !_bdOver(q, a)) && !(_bdCutOff(t) && !_bdCutOff(a))) _eoiAnswers[q.id] = t;
    }));
    // any answer the AI pass skipped still gets the right target
    if (m.people) _eoiQuestions.forEach(q => { const a = String(_eoiAnswers[q.id] || ''); if (a && !/^\[CONFIRM:/.test(a)) _eoiAnswers[q.id] = _bdPeopleFix(a, m.people); });
    m.synced = _bdMoneySig(m); m.syncedPeople = m.people || null; if (m.peopleOk) m.explained = true;
    window._bdMoneyUndo = before;
  } catch (e) { if (!(e && e.message === 'AI_PLAN_GATE')) alert('Couldn\'t update every answer: ' + (e.message || e)); }
  window._bdMoneySyncing = false;
  if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon();
  renderFilledEOI();
}

// Rewrite one answer to score higher, optionally to an assessor's note
async function _bdImprove(q, note, allowPeople) {
  const ans = String(_eoiAnswers[q.id] || ''); if (!ans || /^\[CONFIRM:/.test(ans)) return '';
  const wc = _wordCount(ans);
  const short = !q.proposal && wc < 25;
  const limitTxt = q.charLimit ? 'at most ' + Math.floor(q.charLimit * 0.95) + ' characters including spaces' : q.wordLimit ? 'at most ' + Math.floor(q.wordLimit * 0.97) + ' words' : short ? 'as short as it is now — this is a short field' : 'about ' + Math.round(wc * 1.1) + ' words at most';
  const out = await callClaude('You are an expert UK bid writer improving ONE answer in a funding application so it scores higher with THIS funder. Make it more specific, more evidenced and more clearly about what this funder wants and how they decide; lead with the direct answer; use their words; make every sentence read naturally. ' +
    'Use ONLY facts already in the answer or in the FACTS and RECORDS given — never invent numbers, partners, consultation, policies, places or quotes. Keep the answer consistent with the rest of the application. ' +
    'If a figure or phrase in the answer looks wrong, garbled or makes no sense (for example reserves far bigger than income, a place that contradicts the rest, a fragment like "through Hubs and once"), do not guess: remove it and write around it. ' +
    'Gaps are a last resort: write around anything missing. Add at most ONE new [INSERT: …] placeholder, and only for a fact the funder cannot do without and only the applicant knows (for example the names of the neighbourhoods, or unrestricted reserves). A placeholder is 2–6 words naming the fact, like [INSERT: unrestricted reserves] — never a question, an instruction or a comment. Never write notes to the applicant in the answer. Keep every existing [INSERT: …] and [CONFIRM: …] placeholder. ' +
    'Length: ' + limitTxt + ' — this is a hard limit. Never comment or add a heading. Reply with ONLY the improved answer.',
    ['QUESTION: ' + q.question + (q.guidance ? '\nTHEIR GUIDANCE: ' + q.guidance : ''), note ? 'THE ASSESSOR SAID — fix this:\n' + note : '', 'CURRENT ANSWER:\n' + ans].filter(Boolean).join('\n\n'),
    1400, false, { model: AI_MODELS.best, effort: 'medium', long: true, purpose: note ? 'bid_raise' : 'bid_improve',
      context: ['FUNDER: ' + (bdWsFunder() || 'the funder'), _eoiFunderPriorities ? 'WHAT THE FUNDER WANTS:\n' + _eoiFunderPriorities.slice(0, 2500) : '', _bdFactsBundle()].filter(Boolean).join('\n\n') });
  let t = _stripLeadingLabel(cleanReportText(out));
  if (!t || _eoiLooksLikeRefusal(t)) return '';
  // Never more than one new gap, and gaps are short names — not questions or notes
  const ph = x => (String(x).match(/\[INSERT:[^\]]*\]/gi) || []);
  const added = ph(t).filter(x => !ph(ans).includes(x));
  if (added.length > 1 || added.some(x => x.split(/\s+/).length > 9 || /\?|confirm|check |e\.g\.|for example|if recorded/i.test(x))) return '';
  // Inside the limit, not cut off, money and the people target unchanged — otherwise the old answer stays
  t = await _bdFit(q, t);
  const problem = _bdCheck(q, t, ans);
  if (problem && !(allowPeople && problem === 'changes the people target')) return '';
  return t;
}
// "Raise the score": the assessor lists what costs marks, the weak answers are rewritten to fix it, then it's scored again (two rounds at most)
async function bdRaise() {
  if (window._bdRaising || window._bdScoring || !_eoiQuestions.length) return;
  const say = t => { window._bdRaising = t; bdRenderScore(); };
  // Start from a score of exactly these answers
  if (!_eoiAnswers.__score || _eoiAnswers.__score.sig !== _bdAnswersSig()) { say('Scoring your current version first…'); window._bdRaising = ''; await bdScore(); }
  const before = Object.assign({}, _eoiAnswers);
  const from = _eoiAnswers.__score ? Math.round(_eoiAnswers.__score.score) : null;
  let best = from, kept = 0, tried = 0;
  const funder = bdWsFunder() || 'the funder';
  let changed = 0, gapsBack = 0;
  try {
    for (let round = 1; round <= 2; round++) {
      const roundStart = Object.assign({}, _eoiAnswers), roundGaps = gapsBack, roundChanged = changed;
      say(round === 1 ? 'Reading it like their assessor and listing what costs marks…' : 'Checking again for anything still costing marks…');
      const raw = await callClaude('You are the funder\'s assessor. List the specific problems in this application that cost marks, worst first: answers that miss what the question or this funder wants; vague claims without evidence that the FACTS could support; weak links to their priorities and how they decide; value for money not shown; things that contradict each other or the FACTS; figures that look wrong or garbled phrases; repetition between answers; over-length answers. ' +
        'For each, say exactly what the rewritten answer must do, using only the FACTS given — prefer fixes that need no new information (cut, clarify, reorder, link to their priorities, use the records). Only if the funder truly cannot score the answer without it, say the answer should ask for ONE named fact (2–6 words). Each answer must stay within its word or character limit. Never touch [CONFIRM: …] items. ' +
        'Reply with ONLY a JSON array, at most 8 items: [{"n":1,"problem":"","fix":""}]. If nothing would raise the score, reply [].',
        'FUNDER: ' + funder + '\n' + (_eoiFunderPriorities ? 'WHAT THE FUNDER WANTS:\n' + _eoiFunderPriorities.slice(0, 2500) + '\n' : '') + '\n' + _bdFactsBundle().slice(0, 7000) + '\n\nAPPLICATION:\n' + _bdQA(),
        1500, false, { model: AI_MODELS.best, effort: 'medium', long: true, purpose: 'bid_raise_review' });
      const m = String(raw || '').replace(/```json|```/gi, '').match(/\[[\s\S]*\]/);
      const issues = m ? JSON.parse(m[0]) : [];
      const byQ = {};
      (Array.isArray(issues) ? issues : []).forEach(x => { const q = _eoiQuestions[(+x.n || 0) - 1]; if (q && x.fix && !/^\[CONFIRM:/.test(_eoiAnswers[q.id] || '')) (byQ[q.id] = byQ[q.id] || []).push((x.problem ? x.problem + ' → ' : '') + x.fix); });
      const ids = Object.keys(byQ).slice(0, 8);
      if (!ids.length) break;
      say('Rewriting ' + ids.length + ' answer' + (ids.length === 1 ? '' : 's') + ' to fix what the assessor found…');
      await Promise.all(ids.map(async id => {
        const q = _eoiQuestions.find(x => x.id === id);
        try {
          const t = await _bdImprove(q, byQ[id].join('\n'));
          tried++;
          const add = t ? Math.max(0, (t.match(/\[INSERT:/g) || []).length - (String(_eoiAnswers[id]).match(/\[INSERT:/g) || []).length) : 0;
          if (t && t !== _eoiAnswers[id] && gapsBack + add <= 3) { gapsBack += add; _eoiAnswers[id] = t; changed++; }     // three new questions at most for the whole bid
        } catch (e) { if (e && e.message === 'AI_PLAN_GATE') throw e; }
      }));
      if (changed === roundChanged) break;
      renderFilledEOI();
      say('Scoring the new version…');
      window._bdRaising = '';
      const now = await bdScore(true);
      // Keep the round only if it scores higher; otherwise put every answer back
      if (now == null || best == null || now <= best) {
        _eoiAnswers = Object.assign({}, roundStart); changed = roundChanged; gapsBack = roundGaps;
        renderFilledEOI();
        break;
      }
      best = now; kept++;
      if (now >= 85 || now - (from || 0) < 2) break;
    }
  } catch (e) { if (!(e && e.message === 'AI_PLAN_GATE')) alert('Couldn\'t finish raising the score: ' + (e.message || e)); }
  window._bdRaising = '';
  const now = _eoiAnswers.__score ? Math.round(_eoiAnswers.__score.score) : null;
  window._bdRaised = { from, undo: changed ? before : null,
    note: !changed ? (tried ? 'Tried rewriting ' + tried + ' answer' + (tried === 1 ? '' : 's') + ', but none scored higher, so your version is kept.' : 'The assessor found nothing more it could fix from your records.') + (now != null && now < 80 ? ' What\'s left needs facts only you have — check To finish.' : '')
      : changed + ' answer' + (changed === 1 ? '' : 's') + ' improved and kept because the score went up.' + (gapsBack ? ' ' + gapsBack + ' new question' + (gapsBack === 1 ? '' : 's') + ' for you under To finish — answering ' + (gapsBack === 1 ? 'it' : 'them') + ' will lift it further.' : '') + (now != null && now < 80 ? ' What\'s left needs facts only you have — check To finish.' : '') };
  if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon();
  renderFilledEOI();
}
function bdRaiseUndo() {
  const r = window._bdRaised; if (!r || !r.undo) return;
  _eoiAnswers = Object.assign({}, r.undo);
  if (window._bdScoreCache && _eoiAnswers.__score && window._bdScoreCache[_bdAnswersSig()]) _eoiAnswers.__score = window._bdScoreCache[_bdAnswersSig()];
  window._bdRaised = null;
  if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon();
  renderFilledEOI();
}

// Make shorter / Make stronger / Copy / Undo on each answer
function bdAnsFocus(id) { const el = $('eoi-ans-' + id); if (!el) return; el.focus(); const r = document.createRange(); r.selectNodeContents(el); r.collapse(false); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); }
function bdCopyAns(id, btn) { try { navigator.clipboard.writeText(_plainAnswer(_eoiAnswers[id] || '')); } catch (e) { /* ignore */ } if (btn) { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy'; }, 1500); } }
function bdAnsUndo(id) {
  if (!window._bdPrev || window._bdPrev[id] == null) return;
  _eoiAnswers[id] = window._bdPrev[id]; delete window._bdPrev[id];
  renderFilledEOI(); if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon();
}
async function bdAns(id, how, btn) {
  const q = _eoiQuestions.find(x => x.id === id); if (!q) return;
  const ans = String(_eoiAnswers[id] || ''); if (!ans) return;
  const box = btn && btn.parentNode; if (box) box.querySelectorAll('button').forEach(b => { b.disabled = true; });
  if (btn) btn.innerHTML = '<span class="bd-spin"></span> ' + (how === 'shorter' ? 'Shortening…' : 'Strengthening…');
  const wc = _wordCount(ans);
  try {
    let t = '';
    if (how === 'shorter') {
      const target = q.charLimit && ans.length > q.charLimit ? Math.floor(q.charLimit * 0.92) + ' characters including spaces' : q.wordLimit && wc > q.wordLimit ? Math.floor(q.wordLimit * 0.95) + ' words' : Math.max(20, Math.round(wc * 0.75)) + ' words';
      const out = await callClaude('Shorten this funding application answer to at most ' + target + '. Keep every figure, name and [INSERT: ...] or [CONFIRM: ...] placeholder, and the points that matter most to the funder. Plain British English. Reply with ONLY the shortened answer.',
        'QUESTION: ' + q.question + '\n\nANSWER:\n' + ans, 1200, false, { model: AI_MODELS.smart, purpose: 'bid_trim' });
      t = _stripLeadingLabel(cleanReportText(out));
      if (!t || _eoiLooksLikeRefusal(t) || t.length >= ans.length || _bdCutOff(t)) t = '';
    } else t = await _bdImprove(q, '');
    if (t) {
      window._bdPrev = window._bdPrev || {}; window._bdPrev[id] = ans;
      _eoiAnswers[id] = t;
      if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon();
    }
  } catch (e) { if (!(e && e.message === 'AI_PLAN_GATE')) alert('Couldn\'t change that answer: ' + (e.message || e)); }
  renderFilledEOI();
  const card = $('bd-q-' + id); if (card) card.scrollIntoView({ block: 'nearest' });
}

// Documents the funder wants attached
function _eoiDocToggle(i, on) {
  const n = (window._eoiDocNames || [])[i]; if (!n) return;
  _eoiAnswers.__docs = Object.assign({}, _eoiAnswers.__docs || {}, { [n]: on == null ? !(_eoiAnswers.__docs || {})[n] : !!on });
  if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon();
  bdRenderAttach();
}
function bdRenderAttach() {
  const el = $('bd-attach'); if (!el) return;
  const fromBrief = (_eoiBrief && Array.isArray(_eoiBrief.documents)) ? _eoiBrief.documents.filter(Boolean) : [];
  const st = (_eoiAnswers.__docs && typeof _eoiAnswers.__docs === 'object') ? _eoiAnswers.__docs : {};
  const names = [...new Set(fromBrief.concat(Object.keys(st)))].slice(0, 15);
  if (!names.length) { el.innerHTML = ''; return; }
  _eoiAnswers.__docs = Object.assign({}, ...names.map(n => ({ [n]: !!st[n] })));
  window._eoiDocNames = names;
  const done = names.filter(n => _eoiAnswers.__docs[n]).length;
  el.innerHTML = '<div class="bd-panel"><div class="bd-ph">Attach <span>' + done + ' of ' + names.length + ' ready</span></div><div style="font-size:12px;color:var(--txt3);margin:2px 0 4px">A missing document is one of the commonest reasons bids are turned down.</div>' +
    names.map((n, i) => '<div class="bd-gi"><button type="button" class="bd-ck' + (_eoiAnswers.__docs[n] ? ' y' : '') + '" onclick="_eoiDocToggle(' + i + ')" aria-label="Ready">' + (_eoiAnswers.__docs[n] ? '✓' : '') + '</button><div class="tx">' + (_eoiAnswers.__docs[n] ? '<s>' + escapeHTML(n) + '</s>' : escapeHTML(n)) + '</div></div>').join('') + '</div>';
}

// "To finish": every gap to fill and everything only they can confirm, in one checklist.
// The same thing asked in different words becomes one question. Organisation facts are remembered for the next bid; bank details never are.
function _eoiGapKey(label) {
  return String(label || '').replace(/\s*\((e\.g\.|for example)[^)]*\)/gi, '').replace(/,?\s*(e\.g\.|for example|such as)[\s\S]*$/i, '').replace(/[\s.:;–-]+$/, '').trim().toLowerCase();
}
function bdConfirm(qid) {
  _eoiAnswers.__confirmed = Object.assign({}, _eoiAnswers.__confirmed || {}, { [qid]: !(_eoiAnswers.__confirmed || {})[qid] });
  if (typeof window._vlBidSaveSoon === 'function') window._vlBidSaveSoon();
  renderEOIGaps();
}
function renderEOIGaps() {
  const box = $('eoi-gaps'); if (!box) return;
  const typed = {};                // keep anything already typed when the list redraws
  (window._eoiGapList || []).forEach((g, i) => { const el = $('eoi-gap-' + i); if (el && el.value.trim()) typed[g.ask] = el.value; });
  const gaps = {};
  _eoiQuestions.forEach(q => { (String(_eoiAnswers[q.id] || '').match(/\[INSERT:[^\]]*\]/gi) || []).forEach(m => {
    const label = m.replace(/^\[INSERT:\s*/i, '').replace(/\]$/, '').trim(), key = _eoiGapKey(label);
    if (key) { (gaps[key] = gaps[key] || { label, n: 0, qs: [] }).n++; const qn = _eoiQuestions.indexOf(q) + 1; if (!q.proposal && !gaps[key].qs.includes(qn)) gaps[key].qs.push(qn); }
  }); });
  const keys = Object.keys(gaps);
  const sig = keys.slice().sort().join('|');
  let groups = (window._eoiGapGroups && window._eoiGapGroups.sig === sig) ? window._eoiGapGroups.list : null;
  if (!groups) {
    groups = keys.map(k => ({ ask: gaps[k].label, covers: [k] }));
    if (keys.length > 2 && !window._eoiGapGrouping) {
      window._eoiGapGrouping = true;
      callClaude('Group these gaps from a funding application so the applicant answers each real piece of information once. Gaps that need the same answer (for example several ways of asking for the venue name or postcode) go in one group. Write each group\'s "ask" as a short plain question. Reply with ONLY a JSON array: [{"ask":"","covers":[0,3]}] using the gap numbers.',
        keys.map((k, i) => i + '. ' + gaps[k].label).join('\n'), 800, false, { model: AI_MODELS.smart, purpose: 'bid_gaps' })
        .then(raw => {
          const m = String(raw || '').replace(/```json|```/gi, '').match(/\[[\s\S]*\]/); const arr = m ? JSON.parse(m[0]) : [];
          const used = new Set(), list = [];
          (Array.isArray(arr) ? arr : []).forEach(g => { const cov = (g.covers || []).map(n => keys[+n]).filter(k => k && !used.has(k)); if (cov.length) { cov.forEach(k => used.add(k)); list.push({ ask: String(g.ask || gaps[cov[0]].label), covers: cov }); } });
          keys.forEach(k => { if (!used.has(k)) list.push({ ask: gaps[k].label, covers: [k] }); });
          window._eoiGapGroups = { sig, list };
        }).catch(() => { window._eoiGapGroups = { sig, list: groups }; })
        .finally(() => { window._eoiGapGrouping = false; renderEOIGaps(); });
    }
  }
  const bank = k => /bank|sort code|account (number|name)|roll number|statement/i.test(k);
  const saved = ((currentOrg && currentOrg.settings && currentOrg.settings.bid_facts) || {});
  const fact = t => (_EOI_FACT_KEYS.find(f => f[1].test(t)) || [])[0];
  window._eoiGapList = groups;
  const conf = _eoiQuestions.filter(q => /^\[CONFIRM:/.test(_eoiAnswers[q.id] || ''));
  const confirmed = _eoiAnswers.__confirmed || {};
  const filled = Array.isArray(_eoiAnswers.__filled) ? _eoiAnswers.__filled : [];
  const total = filled.length + groups.length + conf.length;
  const done = filled.length + conf.filter(q => confirmed[q.id]).length;
  const where = g => { const qs = [...new Set(g.covers.flatMap(k => (gaps[k] && gaps[k].qs) || []))].sort((a, b) => a - b); return qs.length ? ' · Q' + qs.join(', Q') : ''; };
  const open = groups.filter(g => !bank(g.ask + ' ' + g.covers.join(' ')));
  // Suggested answers, worked out once per set of gaps
  const ssig = sig + '#' + groups.map(g => g.ask).join('|');
  const sugg = (window._eoiGapSugg && window._eoiGapSugg.sig === ssig) ? window._eoiGapSugg.list : null;
  if (!sugg && open.length && !window._eoiGapSuggesting && !window._eoiGapGrouping) {
    window._eoiGapSuggesting = true;
    _bdSuggestGaps(groups).then(list => { window._eoiGapSugg = { sig: ssig, list }; }).catch(() => { window._eoiGapSugg = { sig: ssig, list: [] }; })
      .finally(() => { window._eoiGapSuggesting = false; renderEOIGaps(); });
  }
  bdWsSteps(done < total ? 3 : 4);
  if (!total) { box.innerHTML = '<div class="bd-ph">To finish</div><div style="font-size:13px;color:#166534;margin-top:8px">✓ Nothing left to fill in.</div>'; return; }
  box.innerHTML = '<div class="bd-ph">To finish <span>' + done + ' of ' + total + ' done' + (window._eoiGapGrouping ? ' · tidying…' : '') + '</span></div>' +
    '<div class="bd-meter"><i style="width:' + Math.round(100 * done / total) + '%"></i></div>' +
    filled.map(f => '<div class="bd-gi"><span class="bd-ck y">✓</span><div class="tx"><s>' + escapeHTML(f) + '</s></div></div>').join('') +
    groups.map((g, i) => bank(g.ask + ' ' + g.covers.join(' '))
      ? '<div class="bd-gi"><span class="bd-ck" style="cursor:default">🔒</span><div class="tx">' + escapeHTML(g.ask) + '<br><small>Type bank details straight into the funder\'s form. Vorlana never stores them.</small></div></div>'
      : (function () {
          const sg = sugg && sugg[i], kept = typed[g.ask] || (fact(g.ask) && saved[fact(g.ask)]) || '';
          return '<div class="bd-gi"><span class="bd-ck" style="cursor:default"></span><div class="tx">' + escapeHTML(g.ask) + '<small>' + where(g) + '</small>' +
            '<input id="eoi-gap-' + i + '" value="' + escapeHTML(kept) + '" placeholder="' + escapeHTML(sg && sg.suggest ? 'e.g. ' + sg.suggest : '') + '" oninput="bdGapCheck(' + i + ')" onkeydown="if(event.key===\'Enter\')applyEOIGaps()"/>' +
            (sg && sg.suggest ? '<div class="bd-sugg"><button type="button" onclick="bdUseSugg(' + i + ')">' + escapeHTML(sg.suggest) + '</button><span>' + (sg.source === 'records' ? 'from your records' : 'typical — check it') + (sg.why ? ' · ' + escapeHTML(sg.why) : '') + '</span></div>'
              : window._eoiGapSuggesting ? '<div class="bd-sugg"><span><span class="bd-spin"></span> Working out a suggestion…</span></div>' : '') +
            '<div class="bd-gapw" id="eoi-gap-w-' + i + '"></div></div></div>';
        })()).join('') +
    conf.map(q => '<div class="bd-gi"><button type="button" class="bd-ck' + (confirmed[q.id] ? ' y' : '') + '" onclick="bdConfirm(\'' + escapeHTML(q.id) + '\')" aria-label="Done">' + (confirmed[q.id] ? '✓' : '') + '</button><div class="tx">' + (confirmed[q.id] ? '<s>' : '') + 'Only you can confirm: ' + escapeHTML(q.question.slice(0, 120)) + (q.question.length > 120 ? '…' : '') + (confirmed[q.id] ? '</s>' : '') + '<small> · Q' + (_eoiQuestions.indexOf(q) + 1) + '</small></div></div>').join('') +
    (open.length ? '<div style="margin-top:10px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><button class="btn btn-p btn-sm" type="button" onclick="applyEOIGaps()">Put these into my answers</button>' +
      (sugg && sugg.some(x => x && x.suggest) ? '<a href="#" onclick="bdUseSugg(-1);return false" style="font-size:12.5px;color:var(--em);font-weight:600">Use all suggestions</a>' : '') + '<span id="eoi-gap-msg" style="font-size:12px"></span></div>' : '');
  groups.forEach((g, i) => bdGapCheck(i));
}
// A likely answer for each gap: from the records where they give it, otherwise what's typical for an organisation this size and this funder
async function _bdSuggestGaps(groups) {
  const list = groups.map((g, i) => i + '. ' + g.ask).join('\n');
  const raw = await callClaude('You help a UK charity finish a funding application. For each numbered gap, suggest the most likely correct answer, in line with this funder\'s requirements and rules. ' +
    'Use the FACTS and RECORDS where they give the answer (source "records"). Where only the applicant can know it, suggest a realistic, typical value for an organisation of THIS size and income that fits the funder\'s rules (source "typical") — for example reserves of 3 to 6 months\' spending, a match-funding share the funder accepts, a number of sessions that fits the targets already in the bid. Never suggest anything that contradicts the FACTS or the rest of the bid. ' +
    'Keep each suggestion short — the value itself, ready to drop into a sentence. For number answers also give a plausible range. Skip bank details. ' +
    'Reply with ONLY a JSON array: [{"i":0,"suggest":"","source":"records","why":"under 10 words","min":null,"max":null}]',
    'FUNDER: ' + (bdWsFunder() || 'the funder') + '\n' + (_eoiFunderPriorities ? 'WHAT THE FUNDER WANTS AND THEIR RULES:\n' + _eoiFunderPriorities.slice(0, 2500) + '\n' : '') +
    '\n' + _bdFactsBundle().slice(0, 6000) + '\n\nTHE BID SO FAR (short):\n' + _eoiQuestions.map((q, i) => 'Q' + (i + 1) + ' ' + q.question + ': ' + String(_eoiAnswers[q.id] || '').slice(0, 500)).join('\n') + '\n\nGAPS:\n' + list,
    1200, false, { model: AI_MODELS.smart, long: true, purpose: 'bid_gap_suggest' });
  const m = String(raw || '').replace(/```json|```/gi, '').match(/\[[\s\S]*\]/);
  const arr = m ? JSON.parse(m[0]) : [];
  const out = [];
  (Array.isArray(arr) ? arr : []).forEach(x => { const i = +x.i; if (i >= 0 && i < groups.length && x.suggest) out[i] = { suggest: String(x.suggest).slice(0, 140), source: x.source === 'records' ? 'records' : 'typical', why: String(x.why || '').slice(0, 90), min: isFinite(+x.min) && x.min !== null ? +x.min : null, max: isFinite(+x.max) && x.max !== null ? +x.max : null }; });
  return out;
}
function bdUseSugg(i) {
  const s = (window._eoiGapSugg && window._eoiGapSugg.list) || [];
  (i < 0 ? s.map((x, k) => k) : [i]).forEach(k => { const el = $('eoi-gap-' + k), x = s[k]; if (el && x && x.suggest && (i >= 0 || !el.value.trim())) { el.value = x.suggest; bdGapCheck(k); } });
}
// Catch numbers that can't be right before they go into the bid
function _bdNum(v) {
  const t = String(v || '').replace(/,/g, '').trim(); const m = t.match(/(-?\d+(?:\.\d+)?)\s*(k|m|million|thousand)?/i); if (!m) return null;
  const n = parseFloat(m[1]); const u = (m[2] || '').toLowerCase();
  return u === 'k' || u === 'thousand' ? n * 1e3 : u === 'm' || u === 'million' ? n * 1e6 : n;
}
function _bdGapProblem(i) {
  const g = (window._eoiGapList || [])[i], el = $('eoi-gap-' + i); if (!g || !el) return '';
  const v = el.value.trim(); if (!v) return '';
  const ask = (g.ask + ' ' + g.covers.join(' ')).toLowerCase(), n = _bdNum(v);
  const facts = (currentOrg && currentOrg.settings && currentOrg.settings.bid_facts) || {};
  const income = _bdNum(facts.annual_income) || 0;
  const s = ((window._eoiGapSugg && window._eoiGapSugg.list) || [])[i];
  const money = /reserve|secured|match|fund|income|turnover|spend|cost|budget|amount|£|saving/.test(ask);
  if (/percent|%|proportion|share/.test(ask) && n != null && n > 100 && !/£/.test(v)) return 'A percentage can\'t be over 100.';
  if (money && n == null && v.length < 40) return 'This needs an amount, for example £25,000.';
  if (money && n != null && income && /reserve|secured|match/.test(ask) && n > income * 2) return 'That\'s more than twice your yearly income (£' + Math.round(income).toLocaleString('en-GB') + '). Check it.';
  if (s && n != null && s.min != null && s.max != null && s.max > 0 && (n < s.min / 3 || n > s.max * 3)) return 'That looks unusual — about ' + (money ? '£' : '') + Math.round(s.min).toLocaleString('en-GB') + '–' + (money ? '£' : '') + Math.round(s.max).toLocaleString('en-GB') + ' would be typical. Check it.';
  if (!/\d/.test(v) && /how many|number of|how much|amount|figure/.test(ask) && !/^(none|0|nil|n\/a)$/i.test(v)) return 'This needs a number.';
  if (v.split(/\s+/).length <= 3 && /and once|^and |^or |^the$/i.test(v)) return 'That doesn\'t look like a full answer.';
  return '';
}
function bdGapCheck(i) {
  const w = $('eoi-gap-w-' + i); if (!w) return;
  const p = _bdGapProblem(i);
  w.textContent = p; w.style.display = p ? 'block' : 'none';
  const el = $('eoi-gap-' + i); if (el) el.style.borderColor = p ? '#D97706' : '';
}
async function applyEOIGaps() {
  const groups = window._eoiGapList || [], vals = {}, facts = {}, labels = [];
  const flagged = groups.map((g, i) => { bdGapCheck(i); return _bdGapProblem(i) ? i + '=' + (($('eoi-gap-' + i) || {}).value || '') : ''; }).filter(Boolean).join('|');
  if (flagged && window._eoiGapOverride !== flagged) {
    window._eoiGapOverride = flagged;
    const msg = $('eoi-gap-msg'); if (msg) { msg.style.color = '#B45309'; msg.textContent = 'Some answers look wrong — check the amber ones, or press again to use them anyway.'; }
    return;
  }
  window._eoiGapOverride = '';
  groups.forEach((g, i) => {
    const el = $('eoi-gap-' + i); const v = el && el.value.trim(); if (!v) return;
    g.covers.forEach(k => { vals[k] = v; });
    labels.push(g.ask.replace(/\?\s*$/, '') + ': ' + v);
    const f = (_EOI_FACT_KEYS.find(x => x[1].test(g.ask)) || _EOI_FACT_KEYS.find(x => g.covers.some(k => x[1].test(k))) || [])[0];
    if (f && !/bank|sort code|account (number|name)|roll number/i.test(g.ask)) facts[f] = v;     // remembered for the next bid
  });
  if (!Object.keys(vals).length) return;
  const touched = [];
  _eoiQuestions.forEach(q => {
    const was = String(_eoiAnswers[q.id] || ''), used = [];
    _eoiAnswers[q.id] = was.replace(/\[INSERT:[^\]]*\]/gi, m => {
      const label = m.replace(/^\[INSERT:\s*/i, '').replace(/\]$/, '').trim(), key = _eoiGapKey(label);
      if (vals[key] == null) return m;
      used.push('"' + label + '" → ' + vals[key]); return vals[key];
    });
    if (used.length && _wordCount(was) >= 25) touched.push({ q, used });
  });
  // Work each value into its sentence properly; anything that doesn't make sense goes back as a question
  if (touched.length) {
    const msg = $('eoi-gap-msg'); if (msg) msg.innerHTML = '<span class="bd-spin"></span> Working them into your answers…';
    const sheet = _bdFactsBundle().slice(0, 5000);
    await Promise.all(touched.map(async x => {
      try {
        const out = await callClaude('The applicant has just typed values into gaps in this funding application answer. Rewrite ONLY the sentences that contain those values so they read naturally and correctly in British English; leave every other word exactly as it is. ' +
          'If a value does not actually answer what its gap asked, or is clearly wrong against the FACTS (for example reserves larger than the whole annual income, a fragment that is not a real answer), take it out and put back one [INSERT: …] placeholder of 2–6 words naming the fact (never a question or a note). Never invent anything. Reply with ONLY the full answer.',
          'GAPS FILLED (what was asked → what they typed):\n' + x.used.join('\n') + '\n\n' + sheet + '\n\nQUESTION: ' + x.q.question + '\n\nANSWER:\n' + _eoiAnswers[x.q.id], 1400, false, { model: AI_MODELS.smart, long: true, purpose: 'bid_gap_blend' });
        let t = _stripLeadingLabel(cleanReportText(out));
        if (t && !_eoiLooksLikeRefusal(t) && _wordCount(t) > _wordCount(_eoiAnswers[x.q.id]) * 0.7) { t = await _bdFit(x.q, t); if (!_bdCutOff(t) && !(_bdOver(x.q, t) && !_bdOver(x.q, _eoiAnswers[x.q.id]))) _eoiAnswers[x.q.id] = t; }
      } catch (e) { /* the value stays as typed */ }
    }));
  }
  _eoiAnswers.__filled = (Array.isArray(_eoiAnswers.__filled) ? _eoiAnswers.__filled : []).concat(labels).slice(-30);
  if (Object.keys(facts).length && typeof sb !== 'undefined' && sb && orgId) {
    try {
      const r = await sb.from('organisations').select('settings').eq('id', orgId).limit(1);
      const st = (r.data && r.data[0] && r.data[0].settings) || {};
      st.bid_facts = Object.assign({}, st.bid_facts || {}, facts);
      const u = await sb.from('organisations').update({ settings: st }).eq('id', orgId);
      if (!u.error && currentOrg) currentOrg.settings = st;
    } catch (e) { /* the answers are still filled */ }
  }
  renderFilledEOI();
  if (_eoiDoc && _eoiDoc.kind === 'docx') { try { const r = await _buildFilledForm(); _eoiDoc.filled = { n: r.filled, total: r.total }; } catch (e) { /* download still rebuilds it */ } }
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
      const raw = await callClaude(sys, 'FUNDER: ' + funder + (_eoiFunderPriorities ? '\nWHAT THE FUNDER WANTS:\n' + _eoiFunderPriorities.slice(0, 2000) : '') + '\n\n' + batches[b], 600, false, { model: AI_MODELS.smart, long: true, purpose: 'bid_review' });
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
  if (orgUses('circular') && typeof cxReportLoad === 'function') { try { await cxReportLoad(); } catch (e) { /* optional */ } }
  const funder = $('eoi-funder').value.trim();
  const brief = $('eoi-brief').value.trim();
  if (!funder || !brief) { alert('Please enter funder and brief.'); return; }
  const out = $('eoi-output'); const res = $('eoi-result');
  out.style.display = 'block';
  const profile = _eoiCleanProfile(getOrgProfile());
  const evidence = buildEOIEvidence();

  const steps = [
    { label: 'Reading the brief', meta: brief.length + ' characters' },
    { label: 'Pulling your organisation facts + CRM data', meta: [orgUses('participants') ? orgPeople().length + ' participants' : '', orgUses('events') ? (DB.events || []).length + ' events' : ''].filter(Boolean).join(' · ') || 'your records' },
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
    'use [INSERT: ...] placeholders for anything missing and keep going. 600-800 words. **bold** key statistics. No hashtags except section markers. ' + _EOI_NEVER_STOP;
  const applicantName = _eoiApplicant(profile);
  const prompt = [
    applicantName ? 'APPLICANT: ' + applicantName + ' (the organisation named in the facts below; any other name is just an internal label — ignore it)' : '',
    'FUNDER: ' + funder,
    'BRIEF: ' + brief,
    'OUR STRENGTHS/USPs: ' + ($('eoi-usps').value || 'none'),
    '',
    'KNOWN ORGANISATION FACTS (provided by the applicant — treat as true):',
    (profile ? profile.slice(0, 1800) : '(none provided — use [INSERT: ...] placeholders for organisation details)'),
    '',
    evidence
  ].join('\n').replace(/^\n+/, '');

  let raw = await runAgent({
    container: res,
    headerLabel: 'EOI Generator Agent',
    headerSub: 'Writing your application using verified outcomes',
    steps, sys, prompt, maxTok: 1300, ai: { model: AI_MODELS.best, effort: 'medium', long: true, purpose: 'bid_brief' }
  });
  if (raw && _eoiLooksLikeRefusal(raw)) {      // never hand the person a list of questions instead of a bid
    try { raw = await callClaude(sys + 'Your previous reply asked for clarification instead of writing. That is not allowed. Write the complete Expression of Interest now. ', prompt + '\n\n(Write the finished text now. No questions, no commentary. Use [INSERT: ...] for anything missing.)', 1300, false, { model: AI_MODELS.best, effort: 'medium', long: true, purpose: 'bid_brief' }); }
    catch (e) { raw = ''; }
    if (!raw || _eoiLooksLikeRefusal(raw)) {
      res.innerHTML = '<div class="alert alert-warn">We couldn\'t write this one automatically. Add a few lines about your organisation under <b>About your organisation</b> (who you are, what you\'ve achieved, who you work with), then press <b>Write my bid</b> again.</div>';
      return;
    }
  }
  if (raw) {
    const cleaned = cleanReportText(raw);
    _lastEOIText = cleaned; window._eoiLastKind = 'brief';
    if (typeof bdShowSection === 'function') bdShowSection(3);
    const html = reportTextToHTML(cleaned, raw)
      .replace(/\[INSERT:([^\]]*)\]/gi, '<mark style="background:#ffe9a8">[INSERT:$1]</mark>');
    res.innerHTML = html +
      '<div style="margin-top:20px;padding-top:12px;border-top:1px solid #eee;font-size:11px;color:#999">Drafted with Vorlana · verify all figures before submission</div>';
    res.style.cssText = 'background:var(--surface);color:var(--txt);border-radius:16px;padding:26px 30px;line-height:1.7';
    if ($('bd-s2')) $('bd-s2').style.display = 'none';
    bdRenderRail(); bdResume();
  }
}

// EOI export helpers
function downloadEOIPDF() {
  const orig = document.title;
  const title = 'EOI — ' + (($('eoi-funder') && $('eoi-funder').value) || 'Untitled');
  document.title = title.replace(/[^a-z0-9 \-]/gi, '').slice(0, 80);
  const inner = (window._eoiLastKind === 'form' && _eoiQuestions.length)
    ? _eoiQuestions.map((q, i) => (q.proposal && !(_eoiQuestions[i - 1] || {}).proposal ? '<h2>Written proposal</h2>' : '') +
        '<h3>' + (q.proposal ? '' : 'Q' + (i + 1) + '. ') + escapeHTML(q.proposal ? q.question.replace(/^Proposal — /, '').split(':')[0] : q.question) + '</h3>' +
        '<p>' + boldify(escapeHTML(/^\[CONFIRM:/.test(_eoiAnswers[q.id] || '') ? '(For you to complete)' : _plainAnswer(_eoiAnswers[q.id] || ''))).replace(/\n/g, '<br/>') + '</p>').join('')
    : $('eoi-result').innerHTML;
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
  const text = (window._eoiLastKind === 'form' && _eoiQuestions.length)
    ? _eoiQuestions.map((q, i) => 'Q' + (i + 1) + '. ' + q.question + '\n\n' + _plainAnswer(_eoiAnswers[q.id] || '')).join('\n\n')
    : (_lastEOIText || ($('eoi-result') && $('eoi-result').innerText) || '');
  navigator.clipboard.writeText(text);
}
