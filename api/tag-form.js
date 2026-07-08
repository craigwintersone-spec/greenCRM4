// api/tag-form.js
//
// Civara — AI Form Auto-Tagger  (with a learning loop)
// ------------------------------------------------------------------
// Takes a RAW funder Word form (.docx), reads every line, and uses Claude
// to insert Civara {{tags}} in the right places — so a human never has to
// hand-tag the form in Word.
//
// LEARNING: whenever the tagger misses a field and a human fixes it, the
// front-end sends that correction back with action:"learn". It's stored in
// Supabase (form_tag_lessons). From then on, every form for that org gets:
//   1) the exact fix applied automatically (deterministic recall), and
//   2) past corrections fed to Claude as examples (so it generalises).
// The agent gets better with every form it's corrected on.
//
// Pairs with:  api/fill-form.js  (the filler)
// Deps (already in package.json):  pizzip
// Env vars:  ANTHROPIC_API_KEY  (already set)
//            SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  (add these for learning)
//
// ---- TAG a form ----
//   POST { "docxBase64":"...", "filename":"GLA-Start-Form.docx", "orgId":"<org uuid>" }
//   ->   { ok, filename, taggedBase64, tagsUsed, preview, missing, warnings }
//        `missing` = lines the agent could not confidently tag (the "alerts").
//
// ---- LEARN from corrections ----
//   POST { "action":"learn", "orgId":"<org uuid>",
//          "corrections":[ { "before":"<line text>", "after":"<line with {{tag}}>" } ] }
//   ->   { ok, learned: <count> }
// ------------------------------------------------------------------

const PizZip = require('pizzip');

const MODEL = process.env.TAG_FORM_MODEL || 'claude-sonnet-4-6';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// ------------------------------------------------------------------
// Canonical Civara tag vocabulary — keep in sync with fill-form.js
// ------------------------------------------------------------------
const TAG_VOCAB = {
  title: 'Title / salutation', forename: 'First name', surname: 'Last name',
  full_name: 'Full name', dob: 'Date of birth (dd/mm/yyyy)', ni: 'National Insurance number',
  phone: 'Phone number', email: 'Email address', address: 'Full postal address',
  postcode: 'Postcode', participant_id: 'Civara participant ID', job_title: 'Job title / role',
  start_date: 'Programme / employment start date', end_date: 'Programme / employment end date',
  today: "Today's date (auto)",
  // choice fields -> tick-boxes, syntax {{field==Value}}
  labour_status: 'Labour market status', gender: 'Gender',
  right_to_work: 'Right to work in the UK (Yes/No)', basic_skills: 'Basic English & maths (Yes/No)',
};
const CHECKBOX_FIELDS = ['labour_status', 'gender', 'right_to_work', 'basic_skills'];

// ------------------------------------------------------------------
// Handler
// ------------------------------------------------------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed. Use POST.' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const orgId = body.orgId || 'default';

    // ---- Branch: learn from human corrections ----
    if (body.action === 'learn') {
      const learned = await saveLessons(orgId, body.corrections || []);
      return res.status(200).json({ ok: true, learned });
    }

    // ---- Branch: tag a form ----
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ ok: false, error: 'ANTHROPIC_API_KEY is not set.' });
    }
    if (!body.docxBase64) {
      return res.status(400).json({ ok: false, error: 'Missing docxBase64.' });
    }

    let zip;
    try { zip = new PizZip(Buffer.from(body.docxBase64, 'base64')); }
    catch (e) { return res.status(400).json({ ok: false, error: 'Not a valid .docx (could not unzip).' }); }

    const docFile = zip.file('word/document.xml');
    if (!docFile) return res.status(400).json({ ok: false, error: 'That .docx has no document.xml.' });
    let xml = docFile.asText();

    const paragraphs = extractParagraphs(xml);
    if (!paragraphs.length) return res.status(400).json({ ok: false, error: 'No text found in that form.' });

    // 1) Recall: pull this org's learned lessons
    const lessons = await loadLessons(orgId);          // [{ pattern, before, after }]
    const lessonByPattern = new Map(lessons.map(l => [l.pattern, l]));

    const warnings = [];
    if (SUPABASE_URL && SUPABASE_KEY) {
      if (lessons.length) warnings.push(`Applied memory: ${lessons.length} learned correction(s) available for this org.`);
    } else {
      warnings.push('Learning is off — set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to let the agent remember corrections.');
    }

    const handled = new Set();
    const preview = [];
    const tagsUsed = new Set();

    // 2) Deterministic recall — auto-apply exact learned fixes first
    for (const p of paragraphs) {
      const lesson = lessonByPattern.get(normalise(p.text));
      if (lesson && lesson.after) {
        xml = replaceParagraphText(xml, p, lesson.after);
        preview.push({ before: p.text, after: lesson.after, source: 'memory' });
        collectTags(lesson.after, tagsUsed);
        handled.add(p.index);
      }
    }

    // 3) Ask Claude for the rest, giving it the learned examples as guidance
    const remaining = paragraphs.filter(p => !handled.has(p.index));
    if (remaining.length) {
      const lines = remaining.map(p => `[${p.index}] ${p.text}`).join('\n');
      const ai = await callClaude(buildPrompt(lines, lessons));
      const plan = parseTaggingPlan(ai);

      for (const edit of plan.edits) {
        const p = paragraphs[edit.index];
        if (!p || handled.has(p.index)) continue;
        if (normalise(edit.before) !== normalise(p.text)) {
          warnings.push(`Line ${edit.index} changed unexpectedly — left untouched for safety.`);
          continue;
        }
        xml = replaceParagraphText(xml, p, edit.after);
        preview.push({ before: p.text, after: edit.after, source: 'ai' });
        collectTags(edit.after, tagsUsed);
        handled.add(p.index);
      }
    }

    // 4) Surface what's still untagged — these are the "missing tag" alerts.
    //    The front-end shows them; when the human tags them, it POSTs
    //    action:"learn" so the agent never misses them again.
    const missing = paragraphs
      .filter(p => !handled.has(p.index) && looksLikeField(p.text))
      .map(p => ({ index: p.index, text: p.text }));

    if (missing.length) {
      warnings.push(`${missing.length} line(s) need review — tag them once and the agent will learn them.`);
    }

    zip.file('word/document.xml', xml);
    const outBuf = zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });

    return res.status(200).json({
      ok: true,
      filename: (body.filename || 'form').replace(/\.docx$/i, '') + '-TAGGED.docx',
      taggedBase64: outBuf.toString('base64'),
      tagsUsed: Array.from(tagsUsed),
      preview,
      missing,        // <- show these as alerts; feed corrections back via action:"learn"
      warnings,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : 'Tagging failed.' });
  }
};

// ------------------------------------------------------------------
// Learning store (Supabase REST — no extra dependency)
// ------------------------------------------------------------------
async function loadLessons(orgId) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return [];
  try {
    const url = `${SUPABASE_URL}/rest/v1/form_tag_lessons`
      + `?org_id=eq.${encodeURIComponent(orgId)}`
      + `&select=pattern,example_before,example_after`
      + `&order=hits.desc&limit=200`;
    const r = await fetch(url, { headers: sbHeaders() });
    if (!r.ok) return [];
    const rows = await r.json();
    return rows.map(x => ({ pattern: x.pattern, before: x.example_before, after: x.example_after }));
  } catch (e) { return []; }
}

async function saveLessons(orgId, corrections) {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    throw new Error('Learning store not configured (set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY).');
  }
  const rows = (corrections || [])
    .filter(c => c && c.before && c.after && c.before !== c.after)
    .map(c => ({
      org_id: orgId,
      pattern: normalise(c.before),
      example_before: c.before,
      example_after: c.after,
    }));
  if (!rows.length) return 0;

  // Upsert on (org_id, pattern). A DB trigger bumps `hits` on conflict.
  const url = `${SUPABASE_URL}/rest/v1/form_tag_lessons?on_conflict=org_id,pattern`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...sbHeaders(), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`Could not save lessons: ${r.status} ${await r.text().catch(() => '')}`);
  return rows.length;
}

function sbHeaders() {
  return { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
}

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

function buildPrompt(lines, lessons) {
  const vocab = Object.entries(TAG_VOCAB).map(([k, v]) => `  {{${k}}} — ${v}`).join('\n');

  // Inject up to 30 past corrections as worked examples — this is the "learning"
  // the model sees: patterns it got wrong before, now shown done right.
  let learned = '';
  if (lessons && lessons.length) {
    learned = '\nLearned from past corrections on this account — apply the SAME tagging when you see similar lines:\n'
      + lessons.slice(0, 30).map(l => `  "${l.before}"  ->  "${l.after}"`).join('\n') + '\n';
  }

  return `You are tagging a UK funder form so a CRM can auto-fill it. Below are the form's lines, each prefixed with its index like [3].

Insert Civara tags ONLY where a participant's data should go. Use ONLY these tags:
${vocab}
${learned}
Rules:
- Free-text field: put the tag where the answer belongs, e.g. "Surname: {{surname}}".
- Tick-box / choice field: put a checkbox tag next to EACH option using {{field==Value}}, e.g. "Male {{gender==Male}}  Female {{gender==Female}}". Only these are choice fields: ${CHECKBOX_FIELDS.join(', ')}.
- Do NOT tag headings, instructions, declarations, signatures, or anything that isn't a participant data field.
- Keep the original wording of each line; only ADD tags into it.
- If unsure about a line, leave it out.

Return ONLY a JSON object, no prose, no markdown fences, exactly:
{"edits":[{"index":<number>,"before":"<line text without the [n] prefix>","after":"<same line with tags added>"}]}

Form lines:
${lines}`;
}

function parseTaggingPlan(text) {
  const cleaned = String(text || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  const s = cleaned.indexOf('{'), e = cleaned.lastIndexOf('}');
  if (s === -1 || e === -1) return { edits: [] };
  try {
    const parsed = JSON.parse(cleaned.slice(s, e + 1));
    return { edits: Array.isArray(parsed.edits) ? parsed.edits : [] };
  } catch (_) { return { edits: [] }; }
}

// ------------------------------------------------------------------
// docx helpers (no extra deps)
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

function collectTags(after, set) {
  (String(after).match(/{{\s*([a-z_]+)/g) || []).forEach(m => {
    const t = m.replace(/[^a-z_]/g, '');
    if (t) set.add(t);
  });
}

// Heuristic: does this line look like it wants an answer? Used to decide
// which untagged lines are worth alerting a human about.
function looksLikeField(text) {
  if (!text || text.length < 2) return false;
  if (/{{/.test(text)) return false;                     // already tagged
  return /[:?]\s*$/.test(text)                           // ends with a colon / question
      || /_{2,}|\.{3,}/.test(text)                       // blank underline / dotted fill
      || /\b(name|date|address|postcode|phone|email|dob|status|gender|number|title)\b/i.test(text);
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function normalise(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
