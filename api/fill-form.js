// api/fill-form.js
//
// Vorlana — AI Read-and-Fill  (no tagging required)
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

const FILL_FORM_VERSION = '5.2-signature-boxes';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    // Visiting /api/fill-form in a browser shows which version is live.
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.', version: FILL_FORM_VERSION });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const orgId = body.orgId || body.org_id || body.org || 'default';
    const rawData = body.data || body.participant || body.participantData || body.fields || {};
    const scope = buildScope(rawData);
    // Accept the uploaded form under any common field name, and strip an
    // optional data-URI prefix. Keeps existing front-end calls working.
    const docB64 = stripDataUri(
      body.docxBase64 || body.templateBase64 || body.formBase64 ||
      body.fileBase64 || body.base64 || (body.file && body.file.base64) || ''
    );

    // Only signed-in Vorlana users can run the filler (it costs AI credit)
    if (SUPABASE_URL && SUPABASE_KEY) {
      const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!tok) return res.status(401).json({ ok: false, error: 'Please sign in again, then retry.' });
      const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${tok}` } }).catch(() => null);
      if (!who || !who.ok) return res.status(401).json({ ok: false, error: 'Your sign-in has expired — refresh the page and try again.' });
    }

    // ---- Branch: learn from a human correction ----
    if (body.action === 'learn') {
      const learned = await saveLessons(orgId, body.corrections || [], scope);
      return res.status(200).json({ ok: true, learned });
    }

    // ---- Branch: read-and-fill ----
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set.' });
    }
    if (!docB64) return res.status(400).json({ ok: false, error: 'No form file received. Send the uploaded .docx as docxBase64 (templateBase64 also accepted).' });

    let zip;
    try { zip = new PizZip(Buffer.from(docB64, 'base64')); }
    catch (e) { return res.status(400).json({ ok: false, error: 'Not a valid .docx (could not unzip).' }); }

    const docFile = zip.file('word/document.xml');
    if (!docFile) return res.status(400).json({ ok: false, error: 'That .docx has no document.xml.' });
    let xml = docFile.asText();
    const hash = formHash(xml);

    // ---- Branch: set up a form once ----
    if (body.action === 'map') {
      const items = await suggestMap(buildFormItems(extractParagraphs(xml)));
      return res.status(200).json({ ok: true, version: FILL_FORM_VERSION, formHash: hash,
        items: items.map(({ _g, cells, ...it }) => it), fields: FIELD_CATALOG });
    }

    // ---- Branch: fill from a saved map (no AI) ----
    if (body.map && Array.isArray(body.map.items)) {
      if (body.map.formHash && body.map.formHash !== hash) {
        return res.status(409).json({ ok: false, error: 'This form has changed since it was set up — set it up again.', formHash: hash });
      }
      const all = extractParagraphs(xml);
      const { preview, missing, sigTargets } = fillFromMap(all, body.map.items, Object.assign({}, rawData, { answers: body.answers || rawData.answers || {} }));
      const signing = sigTargets.length && /^data:image\/png;base64,/.test(String(rawData.signature_png || ''));
      if (signing) { addSignature(zip, xml, sigTargets, rawData.signature_png); placeSignature(sigTargets); }
      xml = applyEdits(xml, all.concat(...all.map(p => p.boxes || [])));
      if (signing) xml = ensureDrawingNs(xml);
      zip.file('word/document.xml', xml);
      return res.status(200).json({ ok: true, version: FILL_FORM_VERSION, formHash: hash,
        filename: (body.filename || 'funder-form').replace(/\.docx$/i, '') + '-FILLED.docx',
        filledBase64: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }).toString('base64'), preview, missing, warnings: [] });
    }

    // Only lines with text, plus empty answer cells beside a label
    const paragraphs = extractParagraphs(xml).filter(p => p.text || p.answerFor);
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
      const tpl = byPattern.get(normalise(p.answerFor ? '§cell§' + p.answerFor : p.text));
      if (tpl) {
        const after = renderTemplate(tpl, scope);
        if (after !== p.text) {
          xml = replaceParagraphText(xml, p, after);
          spreadBoxes(p, after);
          preview.push({ before: p.text, after, source: 'memory' });
          handled.add(p.index);
        }
      }
    }

    // 2) AI reads the rest and fills the participant's answers directly
    // 1b) Tick-box questions (gender, right to work, basic skills…) are ticked by code
    tickBoxes(paragraphs, scope, handled, preview);

    const remaining = paragraphs.filter(p => !handled.has(p.index) && !p.tickQuestion && !p.inBoxes && p.tickQuestionOf == null);
    const toLearn = [];
    if (remaining.length) {
      const lines = remaining.map(p => `[${p.index}] ` + (p.answerFor ? `{EMPTY ANSWER CELL} for "${p.answerFor}"` + (p.boxes && p.boxes.length && p.spread ? ` (a row of ${p.boxes.length + 1} single-character boxes — give the whole answer, it is spread across the boxes for you)` : '') + (p.placeholder ? ` (currently shows Word placeholder "${p.text}")` : '') : p.text)).join('\n');
      const ai = await callClaude(buildPrompt(lines, scope));
      const plan = parsePlan(ai);

      const byIndex = new Map(paragraphs.map(q => [q.index, q]));
      for (const edit of plan.edits) {
        const p = byIndex.get(Number(edit.index));
        if (!p || handled.has(p.index)) continue;
        const loose = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
        if (!p.answerFor && edit.before && loose(edit.before) !== loose(p.text)) {
          warnings.push(`Line ${edit.index} shifted — left untouched for safety.`);
          continue;
        }
        if (!edit.after || edit.after === p.text) continue;   // nothing filled
        xml = replaceParagraphText(xml, p, edit.after);
        spreadBoxes(p, edit.after);
        preview.push({ before: p.answerFor || p.text, after: p.answerFor ? p.answerFor + ': ' + edit.after : edit.after, source: 'ai' });
        handled.add(p.index);

        // Derive a reusable template (back-map values -> <<field>>) to learn
        const tpl = templatise(p.answerFor ? '' : p.text, edit.after, scope);
        if (tpl) toLearn.push({ before: p.answerFor ? '§cell§' + p.answerFor : p.text, template: tpl });
      }
    }

    // 3) Best-effort learning so next time is deterministic (non-fatal if it fails)
    if (toLearn.length) { try { await saveTemplates(orgId, toLearn); } catch (_) {} }

    // 4) Lines that look like fields but got no answer -> alerts for review
    // Tick grids: "English — yes" cells ticked from an answer saved against "English"
    const gridKey = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    paragraphs.forEach(p => {
      const m = p.answerFor && /^(.+?) — (.+)$/.exec(p.answerFor);
      if (!m || handled.has(p.index)) return;
      const key = Object.keys(scope).find(k => gridKey(k) === gridKey(m[1]));
      if (!key || !scope[key]) return;
      if (gridKey(scope[key]) === gridKey(m[2])) { p.newText = TICK_ON; preview.push({ before: p.answerFor, after: m[1] + ': ' + m[2], source: 'tick' }); }
      handled.add(p.index);
    });
    // rows of a tick grid where one box was ticked are answered
    const rowDone = new Set(paragraphs.filter(p => handled.has(p.index) && p.cell).map(p => p.cell.t + ':' + p.cell.r));
    paragraphs.forEach(p => { if (p.answerFor && p.cell && rowDone.has(p.cell.t + ':' + p.cell.r) && / — /.test(p.answerFor)) handled.add(p.index); });
    // a question line followed by its tick options is reported once, by its options line
    paragraphs.forEach(p => { if (p.tickQuestionOf != null) handled.add(p.index); });
    const seenLabel = new Set();
    const missing = paragraphs
      .filter(p => !handled.has(p.index) && !p.isLabel && !(p.inBoxes && !p.tickQuestion) && !p.office &&
        (p.tickQuestion ? true : p.answerFor ? !isNoiseLine(p.answerFor) && p.answerFor.length <= 80 : /[:?]\s*$|_{2,}|\.{3,}/.test(p.text) && !isNoiseLine(p.text)))
      .filter(p => !(p.answerFor && /^[^a-z]{12,}$/.test(p.answerFor)))   // ALL-CAPS headings next to logos
      // signatures, declarations and staff-only checks are for a person to complete
      .filter(p => !/signature|signed|print name|^date:?$|certify|by signing|key worker|position in organisation|email address of|ea email|evidence you have seen|\bcheck:?$|phone number:?$/i.test(p.tickQuestion || p.answerFor || p.text))
      .map(p => {
        const g = p.answerFor && /^(.+?) — (.+)$/.exec(p.answerFor);
        if (g && !p.tickQuestion) {
          const opts = paragraphs.filter(q => q.answerFor && q.cell && p.cell && q.cell.t === p.cell.t && q.cell.r === p.cell.r && / — /.test(q.answerFor)).map(q => q.answerFor.split(' — ')[1]);
          return { index: p.index, text: g[1], options: opts.map(o => o.replace(/^./, c => c.toUpperCase())) };
        }
        return { index: p.index, text: p.tickQuestion || p.answerFor || p.text, options: p.tickOptions || null };
      })
      .filter(m => { const k = normalise(m.text).replace(/[:?_.\s]+$/, ''); if (seenLabel.has(k)) return false; seenLabel.add(k); return true; });
    if (missing.length) {
      warnings.push(`${missing.length} field(s) had no data or were unclear — review, correct once, and the agent learns them.`);
    }

    xml = applyEdits(xml, paragraphs.concat(...paragraphs.map(p => p.boxes || [])));
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
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, messages: [{ role: 'user', content: userContent }] }),
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
- Lines marked {EMPTY ANSWER CELL} for "<label>" are the blank table cells where the answer to <label> goes. For these, "before" is "" and "after" is ONLY the answer (e.g. "Doe") — not the label. If it shows a Word placeholder, "after" replaces it with the answer.
- Dates as DD/MM/YYYY. Yes/No answers as "Yes" or "No".
- Tick grids: cells labelled like "English — Yes" / "English — No" are boxes to tick. Put ${TICK_ON} in the ONE cell that matches the participant (e.g. basic_skills "Yes" → the Yes cells for English and Maths) and leave the others unchanged.
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
    employer: pick('employer', 'employer_name'),
    job_start: pick('job_start', 'job_start_date'),
    hours: pick('hours', 'hours_per_week'),
    pay: pick('pay', 'wage', 'hourly_rate'),
    exit_date: pick('exit_date', 'leaving_date'),
    leave_reason: pick('leave_reason', 'reason_for_leaving'),
    adviser: pick('adviser', 'advisor', 'key_worker'),
    referral_source: pick('referral_source', 'ref_source'),
    provider: pick('provider', 'delivery_organisation', 'organisation'),
    project: pick('project', 'programme'),
    outcome_type: pick('outcome_type'),
    interpersonal: pick('interpersonal'),
    ...Object.fromEntries(Object.entries(d).filter(([k, v]) => v != null && v !== '' && typeof v !== 'object')),
  };
}

// ------------------------------------------------------------------
// docx helpers
// ------------------------------------------------------------------
// Walks the document in order, noting which table/row/cell each paragraph
// sits in. Blank answer cells (next to or under a label cell) are kept and
// tagged with that label, so tables like "Surname | [blank]" get filled.
const PLACEHOLDER_RE = /^(click|tap)\b.{0,30}\b(here|to enter|to start|to select|to choose)\b|^(choose an item|enter text|select date)\.?$/i;
function extractParagraphs(xml) {
  const out = [];
  const tok = /<w:tbl(?=[\s>])[^>]*>|<\/w:tbl>|<w:tr(?=[\s>])[^>]*>|<w:tc(?=[\s>])[^>]*>|<w:p(?=[\s>\/])(?:\s[^>]*)?\/>|<w:p(?=[\s>])[^>]*>[\s\S]*?<\/w:p>/g;
  const stack = [];        // tables: { id, r, c, cells: {"r:c": [paraIdx]} }
  let tables = 0, m, idx = 0;
  const cellsOf = [];      // per table
  const widthsOf = [];     // cell widths (twips) per table, to spot letter-per-box rows
  const officeOf = [];     // tables under a "For office use" heading are skipped
  const hasTableIn = {};
  const borderOf = [];    // per table: "r:c" → the cell has its own box border
  const gridOf = [];      // per table: "r:c" → { g: first grid column, span }   // cells that hold a nested table are containers, not answers
  while ((m = tok.exec(xml)) !== null) {
    const t = m[0];
    if (t.startsWith('<w:tbl')) {
      const id = tables++;
      const parent = stack[stack.length - 1];
      if (parent) hasTableIn[parent.id + ':' + parent.r + ':' + parent.c] = true;
      const prev = out.slice().reverse().find(q => q.text);
      stack.push({ id, r: -1, c: -1, office: !!(prev && /office use|for official use/i.test(prev.text)) });
      cellsOf[id] = {}; widthsOf[id] = {}; gridOf[id] = {}; borderOf[id] = {}; officeOf[id] = stack[stack.length - 1].office;
      continue;
    }
    if (t === '</w:tbl>') { stack.pop(); continue; }
    const tb = stack[stack.length - 1];
    if (t.startsWith('<w:tr')) { if (tb) { tb.r++; tb.c = -1; tb.g = 0; } continue; }
    if (t.startsWith('<w:tc')) {
      if (tb) {
        tb.c++;
        const w = /<w:tcW\b[^>]*w:w="(\d+)"/.exec(xml.slice(m.index, m.index + 500).split('</w:tcPr>')[0]);
        widthsOf[tb.id][tb.r + ':' + tb.c] = w ? +w[1] : 0;
        // grid column this cell starts at, and how many it spans (for "label above" lookups)
        const head = xml.slice(m.index, m.index + 600).split('</w:tcPr>')[0];
        const gs = /<w:gridSpan\b[^>]*w:val="(\d+)"/.exec(head);
        const gb = /<w:gridBefore\b[^>]*w:val="(\d+)"/.exec(xml.slice(Math.max(0, m.index - 400), m.index));
        if (tb.c === 0 && gb) tb.g = +gb[1];
        gridOf[tb.id][tb.r + ':' + tb.c] = { g: tb.g || 0, span: gs ? +gs[1] : 1 };
        // boxes you write in have their own border; gaps between them don't
        const bd = /<w:tcBorders>([\s\S]*?)<\/w:tcBorders>/.exec(head);
        // a gap switches its top/bottom border off; a box keeps the table's lines
        borderOf[tb.id][tb.r + ':' + tb.c] = !(bd && /<w:(top|bottom)\b[^>]*w:val="(nil|none)"/.test(bd[1]));
        tb.g = (tb.g || 0) + (gs ? +gs[1] : 1);
      }
      continue;
    }
    const selfClosing = /\/>$/.test(t) && !/<\/w:p>$/.test(t);
    const inner = selfClosing ? '' : t.replace(/^<w:p[^>]*>/, '').replace(/<\/w:p>$/, '');
    const text = (inner.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map(x => x.replace(/<[^>]+>/g, '')).join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const isPh = /<w:rStyle w:val="PlaceholderText"\s*\/>/.test(t) && !/<w:r\b(?:(?!<\/w:r>)[\s\S])*<w:t[^>]*>[^<]+<\/w:t>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/.test(t.replace(/<w:r\b(?:(?!<\/w:r>)[\s\S])*PlaceholderText(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g, ''));
    const p = { index: idx++, full: t, at: m.index, inner, text: isPh ? '' : text.trim(), phText: isPh ? text.trim() : '', selfClosing, office: !!(tb && tb.office), cell: tb ? { t: tb.id, r: tb.r, c: tb.c } : null };
    out.push(p);
    if (tb) { const k = tb.r + ':' + tb.c; (cellsOf[tb.id][k] = cellsOf[tb.id][k] || []).push(p); }
  }
  // Label the first paragraph of each blank (or placeholder-only) cell
  const cellText = (t, r, c) => ((cellsOf[t] || {})[r + ':' + c] || []).map(q => q.text).join(' ').trim();
  const isBlank = s => !s || PLACEHOLDER_RE.test(s) || /^[_.\s…]+$/.test(s);
  cellsOf.forEach((cells, t) => {
    if (officeOf[t]) return;
    // walk cells row by row, left to right, so runs of boxes stay together
    const consumed = {};
    const byRow = (a, b) => a[0] - b[0] || a[1] - b[1];
    const all = Object.keys(cells).map(k => k.split(':').map(Number)).sort(byRow);
    // placeholder cells first, so a label above them isn't handed to an empty spacer cell as well
    const keys = all.filter(([r, c]) => (cells[r + ':' + c][0] || {}).phText).concat(all.filter(([r, c]) => !(cells[r + ':' + c][0] || {}).phText));
    let run = null;   // current answer cell collecting single-character boxes
    keys.forEach(([r, c]) => {
      const k = r + ':' + c;
      const txt = cellText(t, r, c);
      if (!isBlank(txt)) { run = null; return; }
      // A blank cell straight after another blank answer cell with the same label is
      // one of a row of boxes (e.g. NI number written one letter per box)
      const ownHead = r > 0 ? cellText(t, 0, c) : '';
      if (run && run.r === r && run.c === c - 1 && !(ownHead && !isBlank(ownHead) && ownHead !== run.head)) {
        cells[k].forEach(q => { q.inBoxes = true; });
        run.c = c;
        const wide = (widthsOf[t][k] || 0) > 900;
        if (run.first.spread && wide) { run.closed = true; return; }       // letter boxes end here
        if (!run.closed) { cells[k][0].bordered = !!borderOf[t][k]; run.first.boxes.push(cells[k][0]); if (wide) run.first.spread = false; }
        return;
      }
      let label = '', left = false;
      for (let cc = c - 1; cc >= 0 && !label; cc--) {
        const lt = cellText(t, r, cc);
        // a real blank cell (or a cell holding a table) in between means this isn't our label
        if (isBlank(lt)) {
          const colHead = r > 0 ? cellText(t, 0, cc) : '';
          if (hasTableIn[t + ':' + r + ':' + cc] || ((widthsOf[t][r + ':' + cc] || 0) > 400 && isBlank(colHead))) break;   // a spacer, not another answer column
          continue;
        }
        // "Provider Name | ACTION WEST LONDON | [blank]": the middle cell is a printed value, not a question
        let valueCell = false;
        if (cc > 0) { const x = cellText(t, r, cc - 1); if (!isBlank(x) && !/^\d+$/.test(x)) valueCell = true; }   // only the cell right next to it
        if (valueCell && !/[:?]\s*$/.test(lt)) { label = '__skip__'; break; }
        if (consumed[t + ':' + r + ':' + cc]) { label = '__skip__'; break; }   // already the label of a box below it
        label = lt; left = true; (cells[r + ':' + cc] || []).forEach(q => { q.isLabel = true; });
      }
      if (label === '__skip__') { run = null; return; }
      const above = r > 0 ? cellText(t, 0, c) : '';
      // Column headings only label the first row under them (not every row of a grid)
      if (above && !isBlank(above) && (left || r === 1)) {
        (cells['0:' + c] || []).forEach(q => { q.isLabel = true; });
        if (above !== label) label = label ? label + ' — ' + above : above;
      }
      if (!label && cells[k][0].phText && r > 0) {
        const me = gridOf[t][k];
        const above = Object.keys(cells).filter(kk => +kk.split(':')[0] === r - 1).find(kk => { const o = gridOf[t][kk]; return o && me && o.g <= me.g + me.span - 1 && o.g + o.span - 1 >= me.g && cellText(t, r - 1, +kk.split(':')[1]).length <= 30 && !isBlank(cellText(t, r - 1, +kk.split(':')[1])); });
        if (above) { label = cellText(t, r - 1, +above.split(':')[1]); consumed[t + ':' + above] = true; (cells[above] || []).forEach(q => { q.isLabel = true; }); }
      }
      if (!label || label.length > 120 || HAS_BOX.test(label) || hasTableIn[t + ':' + k] || /^(letters?|numbers?|digits?)$/i.test(label.trim())) { run = null; return; }
      const first = cells[k][0];
      first.answerFor = label.replace(/\s+/g, ' ').slice(0, 160);
      first.width = widthsOf[t][k] || 0;
      first.bordered = !!borderOf[t][k];
      if (first.phText) first.placeholder = true;
      first.placeholder = !!first.text && PLACEHOLDER_RE.test(first.text);
      first.boxes = [];
      // Narrow cells (under ~1.6 cm) in a row are boxes for one letter each
      first.spread = (widthsOf[t][k] || 0) > 0 && widthsOf[t][k] <= 900;
      if (/^[_.\s…]+$/.test(first.text)) first.text = '';
      run = { r, c, first, head: ownHead };
    });
  });
  // A single very narrow blank cell is a spacer, not an answer (letter-box rows are kept)
  out.forEach(p => { if (p.answerFor && !(p.boxes && p.boxes.length) && p.width > 0 && p.width < 500) { delete p.answerFor; } });
  return out;
}

// Safely set a paragraph's visible text WITHOUT restructuring it.
// We only rewrite the text inside existing <w:t> nodes (all Word plumbing —
// runs, run properties, fields, drawings — is left exactly as it was), which
// keeps the .docx valid so Word opens it. The full new text goes into the
// first <w:t>; any other <w:t> nodes in that paragraph are emptied. If the
// paragraph has no <w:t> at all, we insert one run before its closing tag.
function replaceParagraphText(xml, para, newText) { para.newText = newText; return xml; }

// Build the new XML for one paragraph (see applyEdits)
function newParagraphXml(para, newText) {
  const safe = escapeXml(newText);
  const tRe = /<w:t\b[^>]*>[\s\S]*?<\/w:t>/g;
  let newFull;

  if (para.selfClosing) {
    newFull = para.full.replace(/\s*\/>$/, '>') + `<w:r><w:t xml:space="preserve">${safe}</w:t></w:r></w:p>`;
  } else if (tRe.test(para.full)) {
    let first = true;
    newFull = para.full.replace(tRe, () => {
      if (first) { first = false; return `<w:t xml:space="preserve">${safe}</w:t>`; }
      return '<w:t xml:space="preserve"></w:t>';
    });
  } else {
    // No text node in this paragraph — add a single run just before </w:p>.
    const rPr = (para.inner.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    const run = `<w:r>${rPr}<w:t xml:space="preserve">${safe}</w:t></w:r>`;
    newFull = para.full.replace(/<\/w:p>$/, run + '</w:p>');
  }

  // Filled text should look like normal text, not grey placeholder text
  const plain = newFull.replace(/<w:rStyle w:val="PlaceholderText"\s*\/>/g, '');
  return (para.placeholder || para.phText) ? plain.replace(/<w:highlight\b[^>]*\/>/g, '').replace(/(<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*?)<w:shd\b[^>]*w:fill="(?:FFFF00|FFFF99|FFF2CC|yellow)"[^>]*\/>/gi, '$1') : plain;
}

// ------------------------------------------------------------------
// Tick boxes. Lines like "☐ Male ☐ Female ☐ Other" are matched to the
// question they answer and the right box is ticked in the Word XML itself
// (plain ☐ characters, Word checkbox controls and old-style form fields).
// ------------------------------------------------------------------
const BOX_RE = /[\u2610\u2611\u2612\u25A1\u25A2\u25FB\u274F]/g;   // ☐ ☑ ☒ □ ▢ ◻ ❏
const HAS_BOX = /[\u2610\u2611\u2612\u25A1\u25A2\u25FB\u274F]/;
const TICK_FIELDS = [
  [/\bgender\b|\bsex\b/i, 'gender'],
  [/right to (live|work)/i, 'right_to_work'],
  [/basic skills|maths and english|english and maths|esol/i, 'basic_skills'],
  [/labour market|employment status|economically|currently (un)?employed|employment situation/i, 'labour_status'],
  [/interpersonal/i, 'interpersonal'],
  [/disab/i, 'disability'],
  [/ethnic/i, 'ethnicity'],
  [/\bage\b/i, 'age_band'],
];
function buildTickGroups(paragraphs) {
  const lines = paragraphs.filter(p => !p.office);
  const boxCount = p => Math.max((p.text.match(BOX_RE) || []).length, (p.full.match(/<w:checkBox\b/g) || []).length, (p.full.match(/<w14:checkbox\b/g) || []).length);
  // Build groups: [{ paras:[{p, n}], opts:[{p, k, text}], anchor, question }]
  const groups = [], used = new Set();
  lines.forEach((p, i) => {
    if (used.has(p.index)) return;
    const n = boxCount(p); if (!n) return;
    let members = [p];
    if (p.cell) {
      members = lines.filter(q => q.cell && q.cell.t === p.cell.t && q.cell.r === p.cell.r && q.cell.c === p.cell.c && boxCount(q));
    }
    members.forEach(q => used.add(q.index));
    const opts = [];
    members.forEach(q => {
      const parts = q.text.split(BOX_RE); const lead = parts.shift();
      parts.slice(0, boxCount(q)).forEach((t, k) => opts.push({ p: q, k, text: t.replace(/\*.*$/, '').replace(/\s+/g, ' ').trim(), lead }));
    });
    if (opts.length < 2 && !(opts.length === 1 && /^(yes|no)\b/i.test(opts[0].text))) return;
    // The question: text before the first box, else the label cell on the left, else the line above
    let question = (opts[0].lead || '').trim();
    if (!question && p.cell) {
      for (let c = p.cell.c - 1; c >= 0 && !question; c--) {
        const labs = lines.filter(q => q.cell && q.cell.t === p.cell.t && q.cell.r === p.cell.r && q.cell.c === c && q.text && !/^\d+$/.test(q.text));
        if (labs.length) { question = labs.map(q => q.text).join(' '); labs.forEach(q => { q.tickQuestionOf = p.index; }); }
      }
    }
    if (!question) {
      const prev = lines.slice(Math.max(0, i - 3), i).reverse().find(q => q.text && !HAS_BOX.test(q.text));
      if (prev) { question = prev.text; prev.tickQuestionOf = p.index; }
    }
    question = question.replace(/\s+/g, ' ').trim();
    groups.push({ members, opts, question, anchor: p });
  });
  // "Is the person homeless? Is the person a refugee? …" in one tall cell with a
  // row of boxes for each: give each row its own question
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const qs = g.question.split(/(?<=\?)\s+/).filter(x => /\?$/.test(x.trim()));
    if (qs.length < 2 || !g.anchor.cell) continue;
    const next = [];
    for (let j = i + 1; j < groups.length && next.length < qs.length - 1; j++) {
      const h = groups[j];
      if (!h.anchor.cell || h.anchor.cell.t !== g.anchor.cell.t) break;
      if (h.question && !qs.some(x => h.question.includes(x))) break;
      next.push(h);
    }
    if (next.length !== qs.length - 1) continue;
    g.question = qs[0].trim();
    next.forEach((h, n) => { h.question = qs[n + 1].trim(); });
  }

  return groups;
}

// Pick the option that matches a value ("Male", "Yes", "White British"…); -1 if unsure
function chooseOption(optTexts, value) {
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const words = x => norm(x).split(' ').filter(w => w.length > 2 && !/^(and|the|other|or)$/.test(w));
  const w = norm(value); if (!w) return -1;
  const O = optTexts.map(norm);
  let k = O.findIndex(o => o === w);
  if (k < 0) k = O.findIndex(o => o && (o.startsWith(w) || w.startsWith(o)) && o.length > 1);
  if (k < 0 && /^(yes|y|true)$/.test(w)) k = O.findIndex(o => /^yes\b/.test(o));
  if (k < 0 && /^(no|n|false|none)$/.test(w)) k = O.findIndex(o => /^no\b/.test(o));
  if (k < 0 && /prefer not|chose not|not say|not disclosed/.test(w)) k = O.findIndex(o => /not to say|chose not|prefer not/.test(o));
  if (k < 0) {
    const ww = words(value);
    const scores = optTexts.map(o => { const ow = words(o); return ww.filter(x => ow.includes(x)).length; });
    const best = Math.max(0, ...scores);
    if (best >= 1 && scores.filter(x => x === best).length === 1 && best >= Math.ceil(ww.length / 2)) k = scores.indexOf(best);
  }
  return k;
}

function tickBoxes(paragraphs, scope, handled, preview) {
  const groups = buildTickGroups(paragraphs);
  const norm = x => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  groups.forEach(g => {
    g.anchor.tickQuestion = g.question || g.opts.map(o => o.text).join(' / ');
    g.anchor.tickOptions = g.opts.map(o => o.text).filter(Boolean);
    g.members.forEach(m => { if (m !== g.anchor) m.inBoxes = true; });
    const f = TICK_FIELDS.find(x => x[0].test(g.question));
    let want = f ? scope[f[1]] : '';
    if (!want) {
      const qn = norm(g.question);
      const key = Object.keys(scope).find(k => norm(k) === qn || (qn.length > 12 && norm(k).startsWith(qn.slice(0, 40))));
      if (key) want = scope[key];
    }
    const k = chooseOption(g.opts.map(o => o.text), want);
    if (k < 0) return;
    if (tickOption(g, k)) { g.members.forEach(m => handled.add(m.index)); preview.push({ before: g.question, after: g.question + ': ' + g.opts[k].text, source: 'tick' }); }
  });
}
function tickOption(g, k) {
  const o = g.opts[k]; if (!o) return false;
  const xmlNew = tickInXml(o.p.newXml || o.p.full, o.k);
  if (!xmlNew || xmlNew === o.p.full) return false;
  o.p.newXml = xmlNew;
  return true;
}

// Tick the k-th box in a paragraph's XML, whatever kind of box it is
function tickInXml(pxml, k) {
  if (/<w14:checkbox\b/.test(pxml)) {
    let i = 0;
    return pxml.replace(/<w14:checked\s+w14:val="[01]"\s*\/>/g, m => (i++ === k ? '<w14:checked w14:val="1"/>' : m))
      .replace(/(<w:sdtContent>[\s\S]*?<w:t[^>]*>)([\u2610\u2612])(<\/w:t>)/g, (() => { let j = 0; return (m, a, g, c) => a + (j++ === k ? TICK_ON : g) + c; })());
  }
  if (/<w:checkBox\b/.test(pxml)) {
    let i = 0;
    return pxml.replace(/<w:checkBox\b[^>]*>[\s\S]*?<\/w:checkBox>|<w:checkBox\b[^>]*\/>/g, m => {
      if (i++ !== k) return m;
      if (/<w:checked\b/.test(m)) return m;
      return m.replace(/<w:default\s+w:val="0"\s*\/>/, '<w:default w:val="1"/>').replace(/(<\/w:checkBox>)$/, '<w:checked/>$1');
    });
  }
  let i = 0;
  return pxml.replace(/(<w:t\b[^>]*>)([\s\S]*?)(<\/w:t>)/g, (m, a, txt, c) => a + txt.replace(BOX_RE, g => (i++ === k ? TICK_ON : (g === TICK_ON ? TICK_OFF : g))) + c);
}

// One letter per box: "AB123456C" across 9 boxes; dates as digits across 6 or 8 boxes
function spreadBoxes(p, answer) {
  if (!p.boxes || !p.boxes.length || !p.spread) return;
  // write only in the cells drawn as boxes (skip the gaps between them) when the form marks them
  let cellsIn = [p].concat(p.boxes);
  if (cellsIn.some(c => c.bordered) && cellsIn.some(c => !c.bordered)) cellsIn = cellsIn.filter(c => c.bordered);
  const total = cellsIn.length;
  let chars = String(answer || '').replace(/\s+/g, '');
  // Dates go in as digits: 6–7 boxes → DDMMYY, 8+ boxes → DDMMYYYY
  const dm = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/.exec(chars);
  if (dm) {
    const dd = dm[1].padStart(2, '0'), mm = dm[2].padStart(2, '0'), yy = dm[3].length === 2 ? '20' + dm[3] : dm[3];
    if (total >= 8) chars = dd + mm + yy; else if (total >= 6) chars = dd + mm + yy.slice(-2); else return;
  }
  if (chars.length < 2 || chars.length > total) return;   // not a box answer — leave it all in the first box
  if (!cellsIn.includes(p)) p.newText = null;
  cellsIn.forEach((c, k) => { if (chars[k] != null) c.newText = chars[k]; });
}

// Apply every edit by its position in the original XML, last first, so
// identical-looking paragraphs (e.g. many blank cells) are never mixed up.
function applyEdits(xml, paragraphs) {
  const todo = paragraphs.filter(p => p.newText != null || p.newXml).sort((a, b) => b.at - a.at);
  for (const p of todo) {
    if (xml.substr(p.at, p.full.length) !== p.full) continue;   // safety
    let head = xml.slice(0, p.at);
    // A filled Word content control should stop showing as grey placeholder text
    if (p.placeholder || p.phText) {
      const sdt = head.lastIndexOf('<w:sdtPr'), closed = head.lastIndexOf('</w:sdt>');
      if (sdt > closed) head = head.slice(0, sdt) + head.slice(sdt).replace(/<w:showingPlcHdr\s*\/>/, '');
    }
    xml = head + (p.newXml || newParagraphXml(p, p.newText)) + xml.slice(p.at + p.full.length);
  }
  return xml;
}

function looksLikeField(text) {
  if (!text || text.length < 2) return false;
  if (isNoiseLine(text)) return false;
  return /[:?]\s*$/.test(text) || /_{2,}|\.{3,}/.test(text)
      || /\b(name|date|address|postcode|phone|email|dob|status|gender|number|title|signature)\b/i.test(text);
}

// Lines that are structure or Word boilerplate, not fillable fields —
// keep them out of the "missing" alert so users only see real gaps.
function isNoiseLine(text) {
  const t = String(text).trim();
  return /^(part|section|appendix|annex)\s*\d*\s*[:.\-]?\s*$/i.test(t)   // "Part 1:", "Section 2."
      || /^(part|section|appendix|annex)\s*\d+\s*[:.\-]/i.test(t)         // "Part 1: Participant Details"
      || /click\s+(here\s+)?to\s+enter/i.test(t)                           // Word content-control placeholder
      || /^(choose an item|enter text|select date)\.?$/i.test(t)           // more Word placeholders
      || /\bsignature\b/i.test(t) && /_{2,}/.test(t)                       // signature lines are signed by hand
      || /^(for office use|office use only|guidance|notes for)/i.test(t);
}

function stripDataUri(s) {
  const str = String(s || '');
  const i = str.indexOf('base64,');
  return i > -1 ? str.slice(i + 7) : str;
}
function escapeXml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function normalise(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

// ==================================================================
// FORM SET-UP ("learn a form once")
// action "map": read the form, list every question (text, letter boxes,
//   tick boxes, yes/no grids, inline "Label:" lines) and suggest which
//   Vorlana field answers each one. The app shows this list once for
//   checking and saves it (form_maps table).
// fill with body.map: answers come straight from the saved map — no AI,
//   the same result every time. Unanswered questions are returned with
//   their options so the app can ask with buttons.
// ==================================================================
const FIELD_CATALOG = {
  title: 'Title (Mr, Ms…)', forename: 'First name', surname: 'Last name', full_name: 'Full name', dob: 'Date of birth',
  ni: 'National Insurance number', phone: 'Phone number', email: 'Email address', address: 'Home address (no postcode)', postcode: 'Home postcode',
  participant_id: 'Participant ID / reference', start_date: 'Programme start date', gender: 'Gender', ethnicity: 'Ethnicity', disability: 'Disability (from equality data)',
  age_band: 'Age group', right_to_work: 'Right to live and work in the UK (Yes/No)', basic_skills: 'Has basic skills in maths and English (Yes/No)',
  labour_status: 'Labour market status (Unemployed / Economically inactive / Employed)', interpersonal: 'Needs interpersonal skills support (Yes/No)',
  support_needs: 'List of support needs areas (English, Maths, Digital, Communication, Confidence, Working with others, Time management, Motivation to work, Motivation to do training, CV writing, Interview skills) — for yes/no grids of needs',
  education_level: 'Highest educational attainment (ISCED level)', in_education: 'Currently in education or training (Yes/No)',
  jobless_household: 'Lives in a jobless household (Yes/No)', single_adult_dependants: 'Single adult household with dependent children (Yes/No)',
  health_condition: 'Has a disability or long-term health condition (Yes/No/Prefer not to say)', sen: 'Has a special educational need (Yes/No)',
  offender: 'Offender or ex-offender (Yes/No/Prefer not to say)', homeless: 'Homeless (Yes/No)', refugee: 'Refugee (Yes/No)',
  adult_social_care: 'Known to Adult Social Care (Yes/No)', care_leaver: 'Care leaver (Yes/No)', caring_responsibilities: 'Has caring responsibilities (Yes/No)',
  evidence_seen: 'Evidence of eligibility seen (short text)', lms_evidence: 'Evidence of labour market status (short text)',
  assessment_postcode: 'Postcode where the initial assessment meeting took place',
  provider: 'Delivery organisation name', project: 'Programme / project name', referral_source: 'Referral source', adviser: 'Adviser / key worker assigned',
  keyworker_name: 'Name of the staff member filling in the form', keyworker_email: 'Email of that staff member', keyworker_phone: 'Phone of that staff member',
  employer: 'Employer (job outcome)', job_title: 'Job title', job_start: 'Job start date', hours: 'Hours per week', pay: 'Pay', exit_date: 'Exit / leaving date',
  leave_reason: 'Reason for leaving', outcome_type: 'Outcome type', today: "Today's date", organisation: 'Our organisation name'
};

function formHash(xml) { return require('crypto').createHash('sha1').update(xml).digest('hex').slice(0, 16); }

function buildFormItems(paragraphs) {
  const live = paragraphs.filter(p => !p.office);
  const groups = buildTickGroups(live);
  const used = new Set();
  const items = [];
  groups.forEach(g => {
    g.members.forEach(m => used.add(m.index));
    live.filter(q => q.tickQuestionOf === g.anchor.index).forEach(q => used.add(q.index));
    items.push({ id: 'g' + g.anchor.index, type: 'choice', label: g.question || g.opts.map(o => o.text).join(' / '), options: g.opts.map(o => o.text), _g: g });
  });
  // yes/no grids: "English — yes" / "English — no"
  const rows = {};
  live.forEach(p => {
    const m = p.answerFor && !used.has(p.index) && /^(.*?) — (yes|no|y|n)$/i.exec(p.answerFor);
    if (!m || !p.cell) return;
    const key = p.cell.t + ':' + p.cell.r;
    const r = rows[key] || (rows[key] = { label: m[1], cells: {}, first: p });
    r.cells[/^y/i.test(m[2]) ? 'yes' : 'no'] = p.index;
    used.add(p.index);
  });
  Object.values(rows).forEach(r => {
    const before = live.filter(q => q.index < r.first.index && q.text && !q.answerFor).slice(-3).map(q => q.text).join(' / ');
    items.push({ id: 'r' + r.first.index, type: 'grid', label: r.label, context: before.slice(0, 200), cells: r.cells });
  });
  // text answer cells
  live.forEach(p => {
    if (used.has(p.index) || !p.answerFor || p.inBoxes) return;
    items.push({ id: 'c' + p.index, type: 'text', label: p.answerFor, boxes: p.spread ? p.boxes.length + 1 : 0 });
    used.add(p.index);
  });
  // inline lines: "Name of Key Worker:", "Date ________", Word placeholders outside answer cells
  live.forEach(p => {
    if (used.has(p.index) || p.isLabel || p.inBoxes || p.answerFor || !p.text || HAS_BOX.test(p.text)) return;
    if (/[:]\s*$|_{3,}|\.{4,}/.test(p.text) || PLACEHOLDER_RE.test(p.text)) {
      items.push({ id: 'l' + p.index, type: 'inline', label: p.text.replace(/[_.…]{3,}/g, '').trim(), placeholder: PLACEHOLDER_RE.test(p.text) });
      used.add(p.index);
    }
  });
  return items.sort((a, b) => parseInt(a.id.slice(1), 10) - parseInt(b.id.slice(1), 10));
}

// A first guess without AI, so set-up still works if the AI is unavailable
function guessUse(it) {
  const L = it.label.toLowerCase();
  if (/signature|signed|sign here|print name|position in organisation|certify|by signing|declaration/.test(L)) return { use: 'sign' };
  if (isNoiseLine(it.label) || /^part\s*\d+\s*:?$/i.test(it.label.trim()) || /check:\s*$/i.test(it.label.trim())) return { use: 'skip' };
  if (/\b(as defined|definitions?)\b/i.test(it.label)) return { use: 'skip' };
  if (it.type === 'inline' && it.placeholder && /date/i.test(it.label)) return { use: 'field', field: 'today' };
  if (it.type === 'inline' && it.label.length > 90 && !/please (detail|provide|describe|state|give)/i.test(it.label)) return { use: 'skip' };
  if (it.type === 'grid') return { use: 'field', field: 'support_needs' };
  const table = [
    [/^title\b/, 'title'], [/forename|first name|given name/, 'forename'], [/surname|last name|family name/, 'surname'], [/full name|^name$|participant name/, 'full_name'],
    [/labour market status check|evidence.*(labour|employment status)|labour market.*evidence/, 'lms_evidence'],
    [/date of birth|\bdob\b/, 'dob'], [/\bni\b|national insurance/, 'ni'], [/key ?worker.*email|email.*key ?worker/, 'keyworker_email'], [/key ?worker.*(phone|tel)|^phone number/, 'keyworker_phone'],
    [/name of key ?worker|key ?worker name/, 'keyworker_name'], [/tele?phone|mobile|contact no/, 'phone'], [/e-?mail/, 'email'], [/assessment/, 'assessment_postcode'],
    [/post ?code/, 'postcode'], [/address/, 'address'], [/participant id|reference/, 'participant_id'], [/start date/, 'start_date'], [/provider/, 'provider'],
    [/project|programme name/, 'project'], [/gender|\bsex\b/, 'gender'], [/ethnic/, 'ethnicity'], [/right to (live|work)/, 'right_to_work'],
    [/basic skills/, 'basic_skills'], [/labour market/, 'labour_status'], [/interpersonal/, 'interpersonal'], [/educational attainment|highest (level of )?education/, 'education_level'],
    [/engaged in education|in education or training/, 'in_education'], [/jobless household/, 'jobless_household'], [/single adult household/, 'single_adult_dependants'],
    [/disabilit|health condition/, 'health_condition'], [/special education/, 'sen'], [/offender/, 'offender'], [/homeless/, 'homeless'], [/refugee/, 'refugee'],
    [/adult social care/, 'adult_social_care'], [/care leaver/, 'care_leaver'], [/caring responsibilit/, 'caring_responsibilities'],
    [/labour market status check|evidence.*(labour|employment status)/, 'lms_evidence'], [/eligibility|evidence you have seen/, 'evidence_seen'],
    [/employer/, 'employer'], [/job title/, 'job_title'], [/hours/, 'hours'], [/\bpay\b|wage|salary/, 'pay'], [/^date$|^date:$/, 'today']
  ];
  const hit = table.find(t => t[0].test(L));
  return hit ? { use: 'field', field: hit[1] } : { use: 'ask' };
}

async function suggestMap(items) {
  items.forEach(it => Object.assign(it, guessUse(it)));
  try {
    const list = items.map(it => ({ id: it.id, type: it.type, label: it.label.slice(0, 160), options: it.options ? it.options.slice(0, 12) : undefined, context: it.context || undefined }));
    const ai = await callClaude(`You are setting up a UK funder form so it can be filled automatically from a participant record.
For each form item choose how it is answered:
- "field": a Vorlana field answers it (give "field" from the catalogue below)
- "ask": the answer is not held in Vorlana — staff will be asked the first time for each participant
- "sign": signatures, "print name", dates signed, declarations, certifications, anything completed by hand at signing
- "skip": headings, logos, spacer cells, instructions, office-use items, anything that is not a question
Yes/no grids of needs (English, Maths, Digital, Confidence, CV writing…) use field "support_needs".
Return JSON only: {"map":[{"id":"…","use":"field|ask|sign|skip","field":"catalogue key or empty"}]}

Field catalogue:
${Object.entries(FIELD_CATALOG).map(([k, v]) => k + ' — ' + v).join('\n')}

Form items:
${JSON.stringify(list)}`);
    const plan = JSON.parse(String(ai).replace(/```json|```/g, '').slice(String(ai).indexOf('{'), String(ai).lastIndexOf('}') + 1));
    (plan.map || []).forEach(m => {
      const it = items.find(x => x.id === m.id); if (!it) return;
      if (m.use === 'field' && FIELD_CATALOG[m.field]) { it.use = 'field'; it.field = m.field; }
      else if (['ask', 'sign', 'skip'].includes(m.use)) { it.use = m.use; delete it.field; }
    });
  } catch (e) { /* keep the guesses */ }
  return items;
}

function fmtVal(v) {
  if (Array.isArray(v)) return v.join(', ');
  const s = String(v == null ? '' : v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? m[3] + '/' + m[2] + '/' + m[1] : s;
}

// Fill using a saved map. data = participant fields; data.answers = { itemId: value } for "ask" items
function fillFromMap(paragraphs, savedItems, data) {
  const live = paragraphs.filter(p => !p.office);
  const byIdx = new Map(paragraphs.map(p => [p.index, p]));
  const built = buildFormItems(paragraphs);
  const byId = new Map(built.map(it => [it.id, it]));
  const answers = data.answers || {};
  const preview = [], missing = [], sigTargets = [];
  savedItems.forEach(s => {
    const it = byId.get(s.id); if (!it) return;
    if (s.use === 'skip') return;
    if (s.use === 'sign') {
      const L = it.label.toLowerCase();
      const p = byIdx.get(parseInt(s.id.slice(1), 10));
      if (!p || !data.signature_png) return;
      // the participant's own signature and printed name, from their e-signature
      if (/participant|applicant|learner|client|your signature/.test(L) && /sign/.test(L) && !/key ?worker|adviser|advisor|staff|officer|witness/.test(L)) {
        sigTargets.push(p); preview.push({ before: it.label, after: it.label + ': signed electronically', source: 'signature' });
      } else if (/print name|name in capitals|full name/.test(L) && !/key ?worker|adviser|staff/.test(L) && data.signed_name) {
        p.newText = data.signed_name; preview.push({ before: it.label, after: it.label + ': ' + data.signed_name, source: 'signature' });
      }
      return;
    }
    let v = s.use === 'field' ? data[s.field] : answers[s.id];
    if (s.use === 'field' && (v == null || v === '' || (Array.isArray(v) && !v.length)) && answers[s.id] != null) v = answers[s.id];
    const empty = v == null || v === '' || (Array.isArray(v) && !v.length && it.type !== 'grid');
    const miss = () => missing.push({ id: s.id, text: it.label, type: it.type, options: it.options || (it.type === 'grid' ? ['Yes', 'No'] : null), field: s.use === 'field' ? s.field : null });
    if (it.type === 'grid') {
      let yes;
      if (Array.isArray(v)) yes = v.map(x => String(x).toLowerCase()).some(x => x && (it.label.toLowerCase().includes(x) || x.includes(it.label.toLowerCase().split(' ')[0])));
      else if (v != null && v !== '') yes = /^(y|yes|true|1)$/i.test(String(v)) || String(v).toLowerCase().includes(it.label.toLowerCase());
      if (answers[s.id] != null && answers[s.id] !== '') yes = /^(y|yes|true|1)$/i.test(String(answers[s.id]));
      if (yes === undefined) return miss();
      const cell = byIdx.get(it.cells[yes ? 'yes' : 'no']);
      if (cell) { cell.newText = TICK_ON; preview.push({ before: it.label, after: it.label + ': ' + (yes ? 'Yes' : 'No'), source: 'map' }); }
      return;
    }
    if (empty) return miss();
    if (it.type === 'choice') {
      const k = chooseOption(it.options, fmtVal(v));
      if (k < 0 || !tickOption(it._g, k)) return miss();
      preview.push({ before: it.label, after: it.label + ': ' + it.options[k], source: 'map' });
      return;
    }
    const val = fmtVal(v);
    const p = byIdx.get(parseInt(s.id.slice(1), 10)); if (!p) return;
    if (it.type === 'text') { p.newText = val; spreadBoxes(p, val); }
    else if (it.type === 'inline') p.newText = it.placeholder ? val : p.text.replace(/[_.…]{3,}\s*$/, '').replace(/\s*$/, '') + (/:$/.test(p.text.trim()) ? ' ' : ': ') + val;
    preview.push({ before: it.label, after: it.label + ': ' + val, source: 'map' });
  });
  return { preview, missing, sigTargets };
}

// Put the participant's signature image into the paragraphs that ask for it
function addSignature(zip, xml, targets, dataUrl) {
  if (!targets.length || !dataUrl) return xml;
  const b64 = String(dataUrl).split(',')[1]; if (!b64) return xml;
  zip.file('word/media/vorlana-signature.png', Buffer.from(b64, 'base64'));
  const relsPath = 'word/_rels/document.xml.rels';
  let rels = zip.file(relsPath) ? zip.file(relsPath).asText() : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
  const rid = 'rIdVorlanaSig';
  if (!rels.includes(rid)) rels = rels.replace('</Relationships>', `<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/vorlana-signature.png"/></Relationships>`);
  zip.file(relsPath, rels);
  let ct = zip.file('[Content_Types].xml').asText();
  if (!/Extension="png"/i.test(ct)) ct = ct.replace('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/>');
  zip.file('[Content_Types].xml', ct);
  return xml;
}
function ensureDrawingNs(xml) {
  const root = /<w:document\b[^>]*>/.exec(xml)[0];
  let newRoot = root;
  [['wp', 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'], ['a', 'http://schemas.openxmlformats.org/drawingml/2006/main'],
   ['pic', 'http://schemas.openxmlformats.org/drawingml/2006/picture'], ['r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships']]
    .forEach(([ns, uri]) => { if (!new RegExp('xmlns:' + ns + '=').test(newRoot)) newRoot = newRoot.replace(/>$/, ` xmlns:${ns}="${uri}">`); });
  return xml.replace(root, newRoot);
}
function placeSignature(targets) {
  const rid = 'rIdVorlanaSig';
  const cx = 1600000, cy = 480000;   // about 4.4 cm × 1.3 cm
  targets.forEach((p, n) => {
    const run = `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${9100 + n}" name="Signature ${n + 1}"/>` +
      `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${9100 + n}" name="signature.png"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
    const base = p.newXml || p.full;
    p.newXml = /\/>$/.test(base) && !/<\/w:p>$/.test(base) ? base.replace(/\s*\/>$/, '>') + run + '</w:p>' : base.replace(/<\/w:p>$/, run + '</w:p>');
  });
}
