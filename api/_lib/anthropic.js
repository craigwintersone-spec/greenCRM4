// api/_lib/anthropic.js — one place that talks to Anthropic, for every server route.
// • Uses the current models and steps down automatically (Fable → Opus → Sonnet → older Sonnet; Haiku 5.5 → Haiku 4.5)
//   if a model isn't available on this account, rejects a setting, or runs out of room before writing any text.
// • Adjusts each request to what the model accepts: newer models think before answering (that counts towards
//   max_tokens, so they get more room), don't take temperature, and take an optional effort level.
const KEY = process.env.ANTHROPIC_API_KEY;

const MODELS = {
  best: 'claude-fable-5-2',      // bid writing and planning
  smart: 'claude-sonnet-5-5',    // funding searches, form reading, anything that needs judgement
  fast: 'claude-haiku-5-5'       // quick, simple jobs
};
const FALLBACK = {
  'claude-fable-5-2': 'claude-opus-5-5',
  'claude-opus-5-5': 'claude-sonnet-5-5',
  'claude-sonnet-5-5': 'claude-sonnet-4-6',
  'claude-haiku-5-5': 'claude-haiku-4-5-20251001'
};
const ALLOWED = new Set(['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
const EFFORTS = new Set(['low', 'medium', 'high']);
const isNew = m => /^claude-(fable|opus|sonnet|haiku|mythos)-5/.test(m);
const thinksAlways = m => /^claude-(fable|opus)-5/.test(m);

function shape(body, model, opts) {
  const b = Object.assign({}, body, { model });
  if (isNew(model)) {
    delete b.temperature; delete b.top_p; delete b.top_k;
    b.max_tokens = Math.max(b.max_tokens || 0, thinksAlways(model) ? 16000 : 8000);   // newer models may think first: room to think, then write in full
    if (opts.effort && EFFORTS.has(opts.effort)) b.output_config = { effort: opts.effort };
    if (opts.webSearch) b.tools = [{ type: 'web_search_20260209', name: 'web_search' }];
  } else {
    delete b.output_config;
    if (opts.webSearch) b.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  }
  return b;
}
const hasText = d => Array.isArray(d && d.content) && d.content.some(c => c && c.type === 'text' && String(c.text || '').trim());
// A problem with the model or a setting (try the next model), as opposed to a problem with the request itself
const modelProblem = (status, d) => status === 404 || status === 403 ||
  (status === 400 && /model|tool|web_search|output_config|effort|temperature|thinking|not (supported|available)|does not support|unsupported/i.test(JSON.stringify((d && d.error) || d || {})));

// body: { model, max_tokens, system, messages, temperature }   opts: { webSearch, effort }
// Returns { status, data, model } — model is the one that actually answered.
async function anthropic(body, opts) {
  opts = opts || {};
  if (!KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  let model = ALLOWED.has(body.model) ? body.model : MODELS.smart;
  let last = null, waited = false;
  for (let i = 0; i < 6 && model; i++) {
    const b = shape(body, model, opts);
    const headers = { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' };
    if (opts.webSearch && !isNew(model)) headers['anthropic-beta'] = 'web-search-2025-03-05';
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(b) });
    const data = await r.json().catch(() => ({}));
    last = { status: r.status, data, model };
    const noText = r.ok && !hasText(data);            // e.g. thought until it ran out of room, or a refusal
    const cutOff = r.ok && data.stop_reason === 'max_tokens' && !opts._retried;   // ran out of room part-way through: once more with less thinking
    // Busy (rate limit or overloaded): another model has its own allowance, so step down; at the end of the line wait once and retry
    const busy = r.status === 429 || r.status === 529 || /rate_limit|overloaded/i.test(String(data && data.error && data.error.type || ''));
    if (busy) {
      if (FALLBACK[model]) { model = FALLBACK[model]; continue; }
      if (!waited) { waited = true; const ra = Math.min(10, parseInt(r.headers.get('retry-after') || '5', 10) || 5); await new Promise(x => setTimeout(x, ra * 1000)); continue; }
      return last;
    }
    if (cutOff) { opts = Object.assign({}, opts, { effort: 'low', _retried: true }); body = Object.assign({}, body, { max_tokens: 24000 }); continue; }
    if ((modelProblem(r.status, data) || noText) && FALLBACK[model]) { model = FALLBACK[model]; continue; }
    return last;
  }
  return last;
}

module.exports = { anthropic, MODELS, ALLOWED, EFFORTS };
