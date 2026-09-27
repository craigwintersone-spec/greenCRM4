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

const FILL_FORM_VERSION = '4.2-ticks';

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

    const remaining = paragraphs.filter(p => !handled.has(p.index));
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
    // rows of a tick grid where one box was ticked are answered
    const rowDone = new Set(paragraphs.filter(p => handled.has(p.index) && p.cell).map(p => p.cell.t + ':' + p.cell.r));
    paragraphs.forEach(p => { if (p.answerFor && p.cell && rowDone.has(p.cell.t + ':' + p.cell.r) && / — /.test(p.answerFor)) handled.add(p.index); });
    // a question line followed by its tick options is reported once, by its options line
    paragraphs.forEach(p => { if (p.tickQuestionOf != null) handled.add(p.index); });
    const seenLabel = new Set();
    const missing = paragraphs
      .filter(p => !handled.has(p.index) && !p.isLabel && !p.inBoxes && !p.office &&
        (p.tickQuestion ? true : p.answerFor ? !isNoiseLine(p.answerFor) && p.answerFor.length <= 80 : /[:?]\s*$|_{2,}|\.{3,}/.test(p.text) && !isNoiseLine(p.text)))
      .filter(p => !(p.answerFor && /^[^a-z]{12,}$/.test(p.answerFor)))   // ALL-CAPS headings next to logos
      .map(p => ({ index: p.index, text: p.tickQuestion || p.answerFor || p.text }))
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
const PLACEHOLDER_RE = /^(click|tap)(\s+or\s+tap)?\s+(here\s+)?to\s+enter\b|^(choose an item|enter text|select date)\.?$/i;
function extractParagraphs(xml) {
  const out = [];
  const tok = /<w:tbl(?=[\s>])[^>]*>|<\/w:tbl>|<w:tr(?=[\s>])[^>]*>|<w:tc(?=[\s>])[^>]*>|<w:p(?=[\s>\/])(?:\s[^>]*)?\/>|<w:p(?=[\s>])[^>]*>[\s\S]*?<\/w:p>/g;
  const stack = [];        // tables: { id, r, c, cells: {"r:c": [paraIdx]} }
  let tables = 0, m, idx = 0;
  const cellsOf = [];      // per table
  const widthsOf = [];     // cell widths (twips) per table, to spot letter-per-box rows
  const officeOf = [];     // tables under a "For office use" heading are skipped
  while ((m = tok.exec(xml)) !== null) {
    const t = m[0];
    if (t.startsWith('<w:tbl')) {
      const id = tables++;
      const prev = out.slice().reverse().find(q => q.text);
      stack.push({ id, r: -1, c: -1, office: !!(prev && /office use|for official use/i.test(prev.text)) });
      cellsOf[id] = {}; widthsOf[id] = {}; officeOf[id] = stack[stack.length - 1].office;
      continue;
    }
    if (t === '</w:tbl>') { stack.pop(); continue; }
    const tb = stack[stack.length - 1];
    if (t.startsWith('<w:tr')) { if (tb) { tb.r++; tb.c = -1; } continue; }
    if (t.startsWith('<w:tc')) {
      if (tb) {
        tb.c++;
        const w = /<w:tcW\b[^>]*w:w="(\d+)"/.exec(xml.slice(m.index, m.index + 500).split('</w:tcPr>')[0]);
        widthsOf[tb.id][tb.r + ':' + tb.c] = w ? +w[1] : 0;
      }
      continue;
    }
    const selfClosing = /\/>$/.test(t) && !/<\/w:p>$/.test(t);
    const inner = selfClosing ? '' : t.replace(/^<w:p[^>]*>/, '').replace(/<\/w:p>$/, '');
    const text = (inner.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [])
      .map(x => x.replace(/<[^>]+>/g, '')).join('')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const p = { index: idx++, full: t, at: m.index, inner, text: text.trim(), selfClosing, office: !!(tb && tb.office), cell: tb ? { t: tb.id, r: tb.r, c: tb.c } : null };
    out.push(p);
    if (tb) { const k = tb.r + ':' + tb.c; (cellsOf[tb.id][k] = cellsOf[tb.id][k] || []).push(p); }
  }
  // Label the first paragraph of each blank (or placeholder-only) cell
  const cellText = (t, r, c) => ((cellsOf[t] || {})[r + ':' + c] || []).map(q => q.text).join(' ').trim();
  const isBlank = s => !s || PLACEHOLDER_RE.test(s) || /^[_.\s…]+$/.test(s);
  cellsOf.forEach((cells, t) => {
    if (officeOf[t]) return;
    // walk cells row by row, left to right, so runs of boxes stay together
    const keys = Object.keys(cells).map(k => k.split(':').map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let run = null;   // current answer cell collecting single-character boxes
    keys.forEach(([r, c]) => {
      const k = r + ':' + c;
      const txt = cellText(t, r, c);
      if (!isBlank(txt)) { run = null; return; }
      // A blank cell straight after another blank answer cell with the same label is
      // one of a row of boxes (e.g. NI number written one letter per box)
      const ownHead = r > 0 ? cellText(t, 0, c) : '';
      if (run && run.r === r && run.c === c - 1 && !(ownHead && !isBlank(ownHead) && ownHead !== run.head)) {
        run.first.boxes.push(cells[k][0]); run.c = c; cells[k].forEach(q => { q.inBoxes = true; });
        if ((widthsOf[t][k] || 0) > 900) run.first.spread = false;
        return;
      }
      let label = '', left = false;
      for (let cc = c - 1; cc >= 0 && !label; cc--) { const lt = cellText(t, r, cc); if (!isBlank(lt)) { label = lt; left = true; (cells[r + ':' + cc] || []).forEach(q => { q.isLabel = true; }); } }
      const above = r > 0 ? cellText(t, 0, c) : '';
      // Column headings only label the first row under them (not every row of a grid)
      if (above && !isBlank(above) && (left || r === 1)) {
        (cells['0:' + c] || []).forEach(q => { q.isLabel = true; });
        if (above !== label) label = label ? label + ' — ' + above : above;
      }
      if (!label || label.length > 120) { run = null; return; }
      const first = cells[k][0];
      first.answerFor = label.replace(/\s+/g, ' ').slice(0, 160);
      first.placeholder = !!first.text && PLACEHOLDER_RE.test(first.text);
      first.boxes = [];
      // Narrow cells (under ~1.6 cm) in a row are boxes for one letter each
      first.spread = (widthsOf[t][k] || 0) > 0 && widthsOf[t][k] <= 900;
      if (/^[_.\s…]+$/.test(first.text)) first.text = '';
      run = { r, c, first, head: ownHead };
    });
  });
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

  return newFull;
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
function tickBoxes(paragraphs, scope, handled, preview) {
  const lines = paragraphs.filter(p => !p.office);
  lines.forEach((p, i) => {
    const boxes = (p.text.match(BOX_RE) || []).length;
    const legacy = (p.full.match(/<w:checkBox\b/g) || []).length;
    const ctrls = (p.full.match(/<w14:checkbox\b/g) || []).length;
    const n = Math.max(boxes, legacy, ctrls);
    if (n < 2 && !(n === 1 && /yes|no/i.test(p.text))) return;
    // options: the words after each box
    const parts = p.text.split(BOX_RE);
    let question = parts.shift().trim();
    let opts = parts.map(x => x.replace(/\*.*$/, '').replace(/\s+/g, ' ').trim()).filter((x, k) => k < n);
    if (!opts.length || opts.every(o => !o)) return;
    if (!question) {
      const prev = lines.slice(Math.max(0, i - 3), i).reverse().find(q => q.text && !HAS_BOX.test(q.text));
      if (prev) { question = prev.text; prev.tickQuestionOf = p.index; }
      else if (p.cell) question = (lines.find(q => q.isLabel && q.cell && q.cell.t === p.cell.t && q.cell.r === p.cell.r) || {}).text || '';
    }
    p.tickQuestion = question || opts.join(' / ');
    const f = TICK_FIELDS.find(x => x[0].test(question));
    if (!f) return;
    const want = String(scope[f[1]] || '').trim().toLowerCase();
    if (!want) return;
    const norm = x => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const w = norm(want);
    let k = opts.findIndex(o => norm(o) === w);
    if (k < 0) k = opts.findIndex(o => norm(o).startsWith(w) || w.startsWith(norm(o)) && norm(o).length > 1);
    if (k < 0 && /^(yes|y|true)$/.test(w)) k = opts.findIndex(o => /^yes\b/i.test(o));
    if (k < 0 && /^(no|n|false)$/.test(w)) k = opts.findIndex(o => /^no\b/i.test(o));
    if (k < 0 && /prefer not|chose not|not say/.test(w)) k = opts.findIndex(o => /not to say|chose not|prefer not/i.test(o));
    if (k < 0) return;
    const xmlNew = tickInXml(p.full, k);
    if (!xmlNew || xmlNew === p.full) return;
    p.newXml = xmlNew;
    handled.add(p.index);
    if (p.tickQuestionOf == null) { /* question on the same line */ }
    preview.push({ before: p.text, after: p.tickQuestion + ': ' + opts[k], source: 'tick' });
  });
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
  const total = p.boxes.length + 1;
  let chars = String(answer || '').replace(/\s+/g, '');
  const digits = chars.replace(/\D/g, '');
  if (/^\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}$/.test(chars) && (total === 8 || total === 6)) chars = total === 8 ? digits.padStart(8, '0') : digits.slice(0, 4) + digits.slice(-2);
  if (chars.length < 2 || chars.length > total) return;   // not a box answer — leave it all in the first box
  p.newText = chars[0];
  p.boxes.forEach((b, i) => { if (chars[i + 1] != null) b.newText = chars[i + 1]; });
}

// Apply every edit by its position in the original XML, last first, so
// identical-looking paragraphs (e.g. many blank cells) are never mixed up.
function applyEdits(xml, paragraphs) {
  const todo = paragraphs.filter(p => p.newText != null || p.newXml).sort((a, b) => b.at - a.at);
  for (const p of todo) {
    if (xml.substr(p.at, p.full.length) !== p.full) continue;   // safety
    let head = xml.slice(0, p.at);
    // A filled Word content control should stop showing as grey placeholder text
    if (p.placeholder) {
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
