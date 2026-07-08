// api/fill-form.js
//
// Civara — AI Read-and-Fill  (no tagging required)
// ------------------------------------------------------------------
// Upload a RAW funder form (.docx). The AI reads every line, works out what
// each field is asking for, and writes the participant's answers straight
// into the document. No {{tags}}, no Word editing.
//
// LEARNING (invisible): each line the agent fills is remembered as a
// line->field mapping in Supabase (form_tag_lessons). Next time the same
// line appears it's filled deterministically — faster, cheaper, consistent.
// Human corrections (action:"learn") override and teach it too.
//
// Deps (already in package.json):  pizzip
// Env:  ANTHROPIC_API_KEY  (required)
//       SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (optional — enables learning)
//
// ---- FILL ----
//   POST { "docxBase64":"...", "filename":"GLA-Start-Form.docx",
//          "orgId":"<org uuid>", "data": { ...participant fields } }
//   ->   { ok, filename, filledBase64, preview, missing, warnings }
//        preview = what it filled;  missing = fields it couldn't fill (alerts)
//
// ---- LEARN (from a human correction) ----
//   POST { "action":"learn", "orgId":"...", "data":{...participant used},
//          "corrections":[ { "before":"<line>", "after":"<corrected line>" } ] }
//   ->   { ok, learned }
// ------------------------------------------------------------------

const PizZip = require('pizzip');

const MODEL = process.env.TAG_FORM_MODEL || 'claude-sonnet-4-6';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const TICK_ON = '\u2612';   // ☒
const TICK_OFF = '\u2610';  // ☐

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const orgId = body.orgId || 'default';
    const scope = buildScope(body.data || {});

    // ---- Branch: learn from a human correction ----
    if (body.action === 'learn') {
      const learned = await saveLessons(orgId, body.corrections || [], scope);
      return res.status(200).json({ ok: true, learned });
    }

    // ---- Branch: read-and-fill ----
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set.' });
    }
    if (!body.docxBase64) return res.status(400).json({ ok: false, error: 'Missing docxBase64.' });

    let zip;
    try { zip = new PizZip(Buffer.from(body.docxBase64, 'base64')); }
    catch (e) { return res.status(400).json({ ok: false, error: 'Not a valid .docx (could not unzip).' }); }

    const docFile = zip.file('word/document.xml');
    if (!docFile) return res.status(400).json({ ok: false, error: 'That .docx has no document.xml.' });
    let xml = docFile.asText();

    const paragraphs = extractParagraphs(xml);
    if (!paragraphs.length) return res.status(400).json({ ok: false, error: 'No text found in that form.' });

    const warnings = [];
    if (!SUPABASE_URL || !SUPABASE_KEY) {
      warnings.push('Learning is off — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY so the agent remembers how it fills forms.');
    }

    // 1) Recall — apply learned line->field templates deterministically first
    const lessons = await loadLessons(orgId);   // [{ pattern, template }]
    const byPattern = new Map(lessons.map(l => [l.pattern, l.template]));
    const handled = new Set();
    const preview = [];

    for (const p of paragraphs) {
      const tpl = byPattern.get(normalise(p.text));
      if (tpl) {
        const after = renderTemplate(tpl, scope);
        if (after !== p.text) {
          xml = replaceParagraphText(xml, p, after);
          preview.push({ before: p.text, after, source: 'memory' });
          handled.add(p.index);
        }
      }
    }

    // 2) AI reads the rest and fills the participant's answers directly
    const remaining = paragraphs.filter(p => !handled.has(p.index));
    const toLearn = [];
    if (remaining.length) {
      const lines = remaining.map(p => `[${p.index}] ${p.text}`).join('\n');
      const ai = await callClaude(buildPrompt(lines, scope));
      const plan = parsePlan(ai);

      for (const edit of plan.edits) {
        const p = paragraphs[edit.index];
        if (!p || handled.has(p.index)) continue;
        if (normalise(edit.before) !== normalise(p.text)) {
          warnings.push(`Line ${edit.index} shifted — left untouched for safety.`);
          continue;
        }
        if (!edit.after || edit.after === p.text) continue;   // nothing filled
        xml = replaceParagraphText(xml, p, edit.after);
        preview.push({ before: p.text, after: edit.after, source: 'ai' });
        handled.add(p.index);

        // Derive a reusable template (back-map values -> <<field>>) to learn
        const tpl = templatise(p.text, edit.after, scope);
        if (tpl) toLearn.push({ before: p.text, template: tpl });
      }
    }

    // 3) Best-effort learning so next time is deterministic (non-fatal if it fails)
    if (toLearn.length) { try { await saveTemplates(orgId, toLearn); } catch (_) {} }

    // 4) Lines that look like fields but got no answer -> alerts for review
    const missing = paragraphs
      .filter(p => !handled.has(p.index) && looksLikeField(p.text))
      .map(p => ({ index: p.index, text: p.text }));
    if (missing.length) {
      warnings.push(`${missing.length} field(s) had no data or were unclear — review, correct once, and the agent learns them.`);
    }

    zip.file('word/document.xml', xml);
    const outBuf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

    return res.status(200).json({
      ok: true,
      filename: (body.filename || 'funder-form').replace(/\.docx$/i, '') + '-FILLED.docx',
      filledBase64: outBuf.toString('base64'),
      preview,
      missing,
      warnings,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Fill failed.' });
  }
};

// ------------------------------------------------------------------
// Claude
// ------------------------------------------------------------------
async function callClaude(userContent) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 4000, messages: [{ role: 'user', content: userContent }] }),
  });
  if (!r.ok) throw new Error(`Claude API error ${r.status}: ${(await r.text().catch(() => '')).slice(0, 300)}`);
  const data = await r.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}

function buildPrompt(lines, scope) {
  const data = JSON.stringify(scope, null, 2);
  return `You are filling in a UK funder form for a named participant. Below is the participant's data, then the form's lines (each prefixed with its index like [3]).

Write the participant's answers directly into the lines. Rules:
- Free-text field ("Surname:", "Date of birth ___"): append or insert the answer, e.g. "Surname: Doe".
- Tick-box / choice lines (Gender, Yes/No, Employed/Unemployed, etc.): put ${TICK_ON} next to the option that matches the participant's data and ${TICK_OFF} next to the others. Example: "Male ${TICK_OFF}  Female ${TICK_ON}".
- Use ONLY the participant data given. If you don't have a value for a field, leave that line unchanged (do not invent anything).
- Never change headings, instructions, declarations, or signature lines.
- Keep the original wording; only ADD the answer into the line.

Return ONLY a JSON object, no prose, no markdown fences, exactly:
{"edits":[{"index":<n>,"before":"<line text without the [n] prefix>","after":"<line with the answer written in>"}]}

Participant data:
${data}

Form lines:
${lines}`;
}

function parsePlan(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1) return { edits: [] };
  try {
    const parsed = JSON.parse(cleaned.slice(s, e + 1));
    return { edits: Array.isArray(parsed.edits) ? parsed.edits : [] };
  } catch (_) { return { edits: [] }; }
}

// ------------------------------------------------------------------
// Learning store (Supabase REST, no extra dep). Templates use <<field>>
// and <<field==Value>> placeholders so they re-fill for any participant.
// ------------------------------------------------------------------
async function loadLessons(orgId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/form_tag_lessons`
      + `?org_id=eq.${encodeURIComponent(orgId)}`
      + `&select=pattern,example_after&order=hits.desc&limit=300`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) return [];
    return (await r.json()).map(x => ({ pattern: x.pattern, template: x.example_after }));
  } catch (_) { return []; }
}

async function saveTemplates(orgId, items) {
  const rows = items
    .filter(i => i && i.before && i.template)
    .map(i => ({ org_id: orgId, pattern: normalise(i.before), example_before: i.before, example_after: i.template }));
  if (rows.length) await upsert(rows);
  return rows.length;
}

async function saveLessons(orgId, corrections, scope) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Learning store not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).');
  }
  const rows = (corrections || [])
    .filter(c => c && c.before && c.after && c.before !== c.after)
    .map(c => {
      // Turn the human's corrected literal line into a reusable template
      const template = templatise(c.before, c.after, scope) || c.after;
      return { org_id: orgId, pattern: normalise(c.before), example_before: c.before, example_after: template };
    });
  if (!rows.length) return 0;
  await upsert(rows);
  return rows.length;
}

async function upsert(rows) {
  const url = `${SUPABASE_URL}/rest/v1/form_tag_lessons?on_conflict=org_id,pattern`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Could not save lessons: ${r.status} ${await r.text().catch(() => '')}`);
}

function sbHeaders() { return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }; }

// ------------------------------------------------------------------
// Template helpers
// ------------------------------------------------------------------
// Replace <<field>> with the value and <<field==Value>> with a tick/box.
function renderTemplate(tpl, scope) {
  return String(tpl).replace(/<<\s*([^>]+?)\s*>>/g, (_, inner) => {
    const eq = inner.indexOf('==');
    if (eq > -1) {
      const field = inner.slice(0, eq).trim();
      const want = inner.slice(eq + 2).trim();
      const actual = scope[field] != null ? String(scope[field]) : '';
      return actual.toLowerCase() === want.toLowerCase() ? TICK_ON : TICK_OFF;
    }
    const v = scope[inner.trim()];
    return v == null ? '' : String(v);
  });
}

// Derive a template from a filled line by back-mapping the participant's
// values to <<field>> placeholders. Conservative: only clear, unique matches.
function templatise(before, after, scope) {
  let tpl = after;
  let changed = false;

  // Tick marks: if the filled line has ticks, map ticked option -> <<field==Value>>.
  // Only safe when we can tie the ticked option text to a known scope value.
  if (tpl.includes(TICK_ON) || tpl.includes(TICK_OFF)) {
    for (const [field, val] of Object.entries(scope)) {
      if (!val) continue;
      const optRe = new RegExp(`(${escapeRe(String(val))})\\s*${TICK_ON}`, 'i');
      if (optRe.test(tpl)) {
        tpl = tpl.replace(optRe, `$1 <<${field}==${val}>>`);
        // Blank the other boxes so they render ☐ generically
        changed = true;
      }
    }
    // If we couldn't map ticks confidently, don't store a misleading template
    return changed ? tpl : null;
  }

  // Free-text: replace each non-trivial value with its <<field>> placeholder,
  // longest values first to avoid partial overlaps.
  const pairs = Object.entries(scope)
    .filter(([, v]) => v && String(v).length >= 2)
    .sort((a, b) => String(b[1]).length - String(a[1]).length);
  for (const [field, val] of pairs) {
    const re = new RegExp(escapeRe(String(val)), 'g');
    if (re.test(tpl)) { tpl = tpl.replace(re, `<<${field}>>`); changed = true; }
  }
  return changed ? tpl : null;
}

// ------------------------------------------------------------------
// Participant data -> canonical fields, with aliases (mismatch-proof)
// ------------------------------------------------------------------
function buildScope(d) {
  const pick = (...keys) => { for (const k of keys) if (d[k] != null && d[k] !== '') return d[k]; return ''; };
  const forename = pick('forename', 'first_name', 'firstName', 'given_name');
  const surname  = pick('surname', 'last_name', 'lastName', 'family_name');
  return {
    title: pick('title', 'salutation'), forename, surname,
    full_name: pick('full_name', 'name') || [forename, surname].filter(Boolean).join(' '),
    dob: pick('dob', 'date_of_birth', 'birth_date'),
    ni: pick('ni', 'ni_number', 'nino', 'national_insurance'),
    phone: pick('phone', 'mobile', 'telephone', 'contact_number'),
    email: pick('email', 'email_address'),
    address: pick('address', 'postal_address', 'full_address'),
    postcode: pick('postcode', 'post_code', 'zip'),
    participant_id: pick('participant_id', 'id', 'ref', 'reference'),
    job_title: pick('job_title', 'role', 'position'),
    start_date: pick('start_date', 'programme_start', 'employment_start'),
    end_date: pick('end_date', 'programme_end', 'employment_end'),
    today: new Date().toLocaleDateString('en-GB'),
    labour_status: pick('labour_status', 'employment_status', 'labour_market_status'),
    gender: pick('gender', 'sex'),
    right_to_work: pick('right_to_work', 'rtw'),
    basic_skills: pick('basic_skills', 'english_maths'),
  };
}

// ------------------------------------------------------------------
// docx helpers
// ------------------------------------------------------------------
function extractParagraphs(xml) {
  const out = [];
  const re = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m, idx = 0;
  while ((m = re.exec(xml)) !== null) {
    const inner = m[1];
    const text = (inner.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map(t => t.replace(/<[^>]+>/g, '')).join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    out.push({ index: idx++, full: m[0], inner, text: text.trim() });
  }
  return out;
}

function replaceParagraphText(xml, para, newText) {
  const pPr = (para.inner.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
  const rPr = (para.inner.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
  const newInner = `${pPr}<w:r>${rPr}<w:t xml:space="preserve">${escapeXml(newText)}</w:t></w:r>`;
  return xml.replace(para.full, para.full.replace(para.inner, newInner));
}

function looksLikeField(text) {
  if (!text || text.length < 2) return false;
  return /[:?]\s*$/.test(text) || /_{2,}|\.{3,}/.test(text)
      || /\b(name|date|address|postcode|phone|email|dob|status|gender|number|title|signature)\b/i.test(text);
}

function escapeXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalise(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
