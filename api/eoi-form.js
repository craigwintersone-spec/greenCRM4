// /api/eoi-form.js — read a funder's blank Word form and write answers into it
// ─────────────────────────────────────────────────────────────
// POST { action: 'parse', docxBase64 }
//   → { ok, items: [{ id, question, wordLimit }] }   every question the applicant must answer, in order
// POST { action: 'fill',  docxBase64, answers: { id: 'text' } }
//   → { ok, filledBase64, filled: n }                the same form with each answer written in place
//
// It understands the layouts funders actually use:
//   • a table with the question in one cell and a blank cell beside it
//   • a question row with a blank row underneath it (one-column table)
//   • a question paragraph followed by a blank paragraph
//   • a question paragraph followed by an empty one-box table (the "answer box")
//   • Word "Click here to enter text" content controls
// Anything else is returned as a plain list of questions so the answers can still be copied across.

const PizZip = require('pizzip');
const { extractParagraphs, applyEdits, escapeXml, stripDataUri } = require('./fill-form.js').helpers;

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MAX_ITEMS = 40;

// Things that are never for the applicant to write
const SKIP = /signature|signed by|sign here|print name|for (office|official|internal) use|date received|received by|application (ref|reference|number)\b|panel|assessor|office use|declaration|data protection|privacy notice|checklist/i;
// A line that states a limit: "(max 300 words)", "500 characters", "no more than 250 words"
const LIMIT_RE = /(?:max(?:imum)?\.?|up to|no more than|limit(?: of)?|not exceed(?:ing)?|within|approx\.?)?\s*\(?\s*(\d[\d,]{1,5})\s*(words?|characters?|chars?)\b/i;

function wordLimitOf(text) {
  const m = LIMIT_RE.exec(String(text || ''));
  if (!m) return null;
  const n = parseInt(m[1].replace(/,/g, ''), 10);
  if (!n) return null;
  return /^char/i.test(m[2]) ? Math.max(5, Math.round(n / 6)) : n;
}

function looksLikeQuestion(t) {
  const x = String(t || '').trim();
  if (x.length < 12) return false;
  if (/\?\s*$/.test(x)) return true;
  if (LIMIT_RE.test(x)) return true;
  if (/^(q(uestion)?\s*\d+|section\s*\d+|\d+\s*[.)]|[a-h]\s*[.)])\s*\S/i.test(x)) return true;
  if (x.length >= 25 && /\b(please\s+)?(describe|explain|tell us|outline|provide|give (details|an overview|examples)|summari[sz]e|set out|detail|list|state|identify|demonstrate|how (will|do|would|have)|what (is|are|will|would|have)|why (is|do|will|are)|who (will|are|is))\b/i.test(x)) return true;
  return false;
}

// Clean a question for display: drop leading numbering noise, collapse whitespace
function cleanQuestion(t) {
  return String(t || '').replace(/\s+/g, ' ').trim().slice(0, 700);
}

// Every question in the form, with the paragraph its answer belongs in.
function findItems(paragraphs) {
  const items = [];
  const used = new Set();                       // paragraph indexes already claimed (as question or answer)
  const live = paragraphs.filter(p => !p.office);

  // ---- group paragraphs into table cells ----
  const cells = new Map();                      // "t:r:c" → [paragraph]
  const tableRows = new Map();                  // t → { rows: Set, cols: Set }
  live.forEach(p => {
    if (!p.cell) return;
    const k = p.cell.t + ':' + p.cell.r + ':' + p.cell.c;
    (cells.get(k) || cells.set(k, []).get(k)).push(p);
    const tr = tableRows.get(p.cell.t) || tableRows.set(p.cell.t, { rows: new Set(), cols: new Set() }).get(p.cell.t);
    tr.rows.add(p.cell.r); tr.cols.add(p.cell.c);
  });
  const cellText = (t, r, c) => (cells.get(t + ':' + r + ':' + c) || []).map(p => p.text).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  const cellBlank = (t, r, c) => { const ps = cells.get(t + ':' + r + ':' + c); return !!ps && ps.every(p => !p.text); };
  const hasCell = (t, r, c) => cells.has(t + ':' + r + ':' + c);
  const nestedHolder = new Set(live.filter(p => p.cell && /<w:tbl[\s>]/.test(p.full)).map(p => p.cell.t + ':' + p.cell.r + ':' + p.cell.c));

  // the nearest body paragraphs written before a table (its question when it is a lone answer box)
  const bodyBefore = (tableFirstIndex) => {
    const out = [];
    for (let i = live.findIndex(p => p.index === tableFirstIndex) - 1; i >= 0 && out.length < 3; i--) {
      const q = live[i];
      if (q.cell) break;
      if (!q.text) { if (out.length) break; continue; }
      out.unshift(q);
      if (looksLikeQuestion(q.text) && !(q.text.length < 40 && LIMIT_RE.test(q.text))) break;
    }
    return out;
  };

  // ---- 1. tables ----
  const seenTables = new Set();
  live.forEach(p => {
    if (!p.cell || seenTables.has(p.cell.t)) return;
    seenTables.add(p.cell.t);
    const t = p.cell.t, info = tableRows.get(t);
    const rows = Array.from(info.rows).sort((a, b) => a - b), cols = Array.from(info.cols).sort((a, b) => a - b);
    const multiCol = cols.length >= 2;
    rows.forEach(r => cols.forEach(c => {
      if (!hasCell(t, r, c) || !cellBlank(t, r, c) || nestedHolder.has(t + ':' + r + ':' + c)) return;
      const target = cells.get(t + ':' + r + ':' + c)[0];
      if (used.has(target.index) || target.boxes && target.boxes.length) return;     // letter boxes belong to the participant filler
      let question = '', questionParas = [];
      // question in a cell to the left (nearest non-blank)
      for (let cc = c - 1; cc >= cols[0] && !question; cc--) {
        const lt = cellText(t, r, cc);
        if (lt) { question = lt; questionParas = cells.get(t + ':' + r + ':' + cc); }
      }
      // question in the cell above (one-column "question row, answer row" tables)
      if (!question && r > rows[0]) {
        const at = cellText(t, r - 1, c);
        if (at && (!multiCol || looksLikeQuestion(at))) { question = at; questionParas = cells.get(t + ':' + (r - 1) + ':' + c); }
      }
      // a lone empty box under a question paragraph
      if (!question && !multiCol && rows.length === 1) {
        const before = bodyBefore(info && live.find(q => q.cell && q.cell.t === t).index);
        if (before.length) { question = before.map(q => q.text).join(' '); questionParas = before; }
      }
      if (!question) return;
      // in a wide grid only a real question counts (a column heading does not)
      if (cols.length >= 3 && !(looksLikeQuestion(question) || question.length >= 40)) return;
      if (SKIP.test(question)) return;
      items.push({ target, mode: 'fill', question: cleanQuestion(question), wordLimit: wordLimitOf(question) });
      used.add(target.index);
      questionParas.forEach(q => used.add(q.index));
    }));
  });

  // ---- 2. body paragraphs: a question, then a blank line (or nothing) for the answer ----
  for (let i = 0; i < live.length; i++) {
    const q = live[i];
    if (q.cell || used.has(q.index) || !q.text || !looksLikeQuestion(q.text) || SKIP.test(q.text)) continue;
    // look ahead for the answer space, skipping hint lines ("Maximum 300 words")
    let target = null, j = i + 1, hint = '';
    for (; j < live.length && j <= i + 4; j++) {
      const n = live[j];
      if (n.cell) break;                                       // a table follows: handled above
      if (!n.text) { target = n; break; }
      if (looksLikeQuestion(n.text) && !LIMIT_RE.test(n.text)) break;   // the next question: no space was left
      hint += ' ' + n.text;
      used.add(n.index);
    }
    const strong = /\?\s*$/.test(q.text) || LIMIT_RE.test(q.text + ' ' + hint) || /^(q(uestion)?\s*\d+|\d+\s*[.)])/i.test(q.text);
    if (!target && !strong) continue;                          // not clearly a question we can answer in place
    const wl = wordLimitOf(q.text + ' ' + hint);
    if (target) {
      if (used.has(target.index)) continue;
      items.push({ target, mode: 'fill', question: cleanQuestion(q.text), wordLimit: wl });
      used.add(target.index);
    } else {
      items.push({ target: q, mode: 'insert', question: cleanQuestion(q.text), wordLimit: wl });
    }
    used.add(q.index);
  }

  // ---- 3. Word "Click here to enter text" boxes sitting on their own line under a question ----
  live.forEach((p, i) => {
    if (p.cell || used.has(p.index) || p.text || !p.phText) return;
    const prev = live.slice(Math.max(0, i - 3), i).reverse().find(x => x.text && !x.cell);
    if (!prev || SKIP.test(prev.text) || used.has(prev.index)) return;
    items.push({ target: p, mode: 'fill', question: cleanQuestion(prev.text), wordLimit: wordLimitOf(prev.text) });
    used.add(p.index);
  });

  // document order, capped
  items.sort((a, b) => a.target.index - b.target.index);
  return items.slice(0, MAX_ITEMS).map((it, n) => Object.assign(it, { id: 'e' + it.target.index }));
}

// ---- writing an answer into the form ----
function runsFor(text) {
  // keep [INSERT: …] placeholders visible: highlighted yellow
  const parts = String(text).split(/(\[INSERT:[^\]]*\])/gi);
  return parts.filter(x => x !== '').map(part => {
    const hl = /^\[INSERT:/i.test(part);
    const lines = part.split('\n').map(l => `<w:t xml:space="preserve">${escapeXml(l)}</w:t>`).join('<w:br/>');
    return `<w:r>${hl ? '<w:rPr><w:highlight w:val="yellow"/></w:rPr>' : ''}${lines}</w:r>`;
  }).join('');
}
function answerParas(openTag, pPr, text) {
  // blank lines start a new paragraph; single line breaks stay inside one
  const blocks = String(text).replace(/\r/g, '').trim().split(/\n{2,}/).filter(b => b.trim());
  return blocks.map(b => `${openTag}${pPr}${runsFor(b.trim())}</w:p>`).join('');
}
function writeAnswer(item, text) {
  const p = item.target;
  const pPrOf = q => (q.full.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
  if (item.mode === 'insert') {
    // a new paragraph straight after the question
    const added = answerParas('<w:p>', '<w:pPr><w:spacing w:before="60" w:after="160"/></w:pPr>', text);
    p.newXml = (p.newXml || p.full) + added;
    return;
  }
  const open = p.selfClosing ? p.full.replace(/\s*\/>$/, '>') : (p.full.match(/^<w:p(?:\s[^>]*)?>/) || ['<w:p>'])[0];
  const pPr = pPrOf(p);
  p.newXml = answerParas(open, pPr, text);
  p.phText = p.phText || '';                     // lets applyEdits clear a grey "Click here…" placeholder
}

// A clean Word document of the questions and answers — for forms that arrive as a PDF or only exist online
function answersDocx(title, subtitle, qa) {
  const para = (inner, spacing) => `<w:p><w:pPr><w:spacing w:before="0" w:after="${spacing == null ? 120 : spacing}"/></w:pPr>${inner}</w:p>`;
  const run = (text, rpr) => `<w:r>${rpr ? '<w:rPr>' + rpr + '</w:rPr>' : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  const body = [];
  body.push(para(run(title || 'Expression of Interest', '<w:b/><w:sz w:val="34"/>'), 60));
  if (subtitle) body.push(para(run(subtitle, '<w:color w:val="666666"/><w:sz w:val="20"/>'), 280));
  (qa || []).forEach((x, i) => {
    body.push(para(run('Q' + (i + 1) + '. ' + String(x.q || ''), '<w:b/><w:sz w:val="23"/>'), 40));
    if (x.limit) body.push(para(run(x.limit, '<w:color w:val="888888"/><w:sz w:val="18"/>'), 80));
    const blocks = String(x.a || '').replace(/\r/g, '').trim().split(/\n{2,}/).filter(b => b.trim());
    (blocks.length ? blocks : ['']).forEach(b => body.push(`<w:p><w:pPr><w:spacing w:before="0" w:after="140"/></w:pPr>${runsFor(b.trim())}</w:p>`));
    body.push(para('', 120));
  });
  const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' + body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>';
  const z = new PizZip();
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', doc);
  return z.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

async function authed(req) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return true;       // not configured (local test)
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return false;
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${tok}` } }).catch(() => null);
  return !!(who && who.ok);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'Use POST.' }); }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    if (!(await authed(req))) return res.status(401).json({ ok: false, error: 'Your sign-in has expired — refresh the page and try again.' });
    if (body.action === 'answers-doc') {
      const buf = answersDocx(String(body.title || '').slice(0, 200), String(body.subtitle || '').slice(0, 300), (body.qa || []).slice(0, 60));
      return res.status(200).json({ ok: true, filledBase64: buf.toString('base64') });
    }
    const b64 = stripDataUri(body.docxBase64 || '');
    if (!b64) return res.status(400).json({ ok: false, error: 'No form received.' });

    let zip;
    try { zip = new PizZip(Buffer.from(b64, 'base64')); } catch (e) { return res.status(400).json({ ok: false, error: 'That file is not a Word (.docx) document.' }); }
    const docFile = zip.file('word/document.xml');
    if (!docFile) return res.status(400).json({ ok: false, error: 'That file is not a Word (.docx) document.' });
    let xml = docFile.asText();

    const paragraphs = extractParagraphs(xml);
    const items = findItems(paragraphs);

    if (body.action === 'parse') {
      return res.status(200).json({ ok: true, items: items.map(i => ({ id: i.id, question: i.question, wordLimit: i.wordLimit })) });
    }

    if (body.action === 'fill') {
      const answers = body.answers || {};
      let n = 0;
      items.forEach(it => {
        const a = answers[it.id];
        if (a == null || !String(a).trim()) return;
        writeAnswer(it, String(a)); n++;
      });
      xml = applyEdits(xml, paragraphs.concat(...paragraphs.map(p => p.boxes || [])));
      zip.file('word/document.xml', xml);
      return res.status(200).json({ ok: true, filled: n, total: items.length, filledBase64: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }).toString('base64') });
    }
    return res.status(400).json({ ok: false, error: 'Unknown action.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Could not read that form: ' + (e && e.message || e) });
  }
};
module.exports._test = { findItems, wordLimitOf, looksLikeQuestion };
