// api/fill-form.js — Civara funder-form filler (Vercel serverless function)
// ---------------------------------------------------------------------------
// Receives a blank funder form (.docx, base64) that uses {{tags}} plus a data
// object, and returns the filled .docx. Deploy this alongside your existing
// /api/claude function. Requires: docxtemplater, pizzip (see package.json).
//
// POST body (JSON):
//   { templateBase64: "data:...;base64,UEsDB...", data: { forename:"Jane", ... }, fileName: "Form - Jane Doe" }
// Returns: the filled .docx (binary) as an attachment.

const PizZip = require('pizzip');
const Docxtemplater = require('docxtemplater');


// Custom tag parser: normal {{field}} tags return the value; special
// {{TICK:<base64url of {f,v}>}} tags return ☒ if data[f] === v, else ☐.
function tickParser(tag) {
  return {
    get: function (scope) {
      if (tag.indexOf('TICK:') === 0) {
        try {
          var o = JSON.parse(Buffer.from(tag.slice(5), 'base64url').toString('utf8'));
          return String((scope && scope[o.f]) != null ? scope[o.f] : '') === String(o.v) ? '\u2612' : '\u2610';
        } catch (e) { return '\u2610'; }
      }
      if (tag === '.') return scope;
      var v = scope ? scope[tag] : '';
      return (v == null ? '' : v);
    }
  };
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Use POST' }); return; }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    body = body || {};

    const templateBase64 = body.templateBase64;
    const data = body.data || {};
    const fileName = (body.fileName || 'Filled form').replace(/[\/\\:*?"<>|]+/g, ' ').trim() || 'Filled form';

    if (!templateBase64) { res.status(400).json({ error: 'templateBase64 is required' }); return; }

    // Strip any "data:...;base64," prefix, then decode.
    const b64 = String(templateBase64).indexOf(',') !== -1
      ? String(templateBase64).split(',').pop()
      : String(templateBase64);
    const binary = Buffer.from(b64, 'base64');

    let zip;
    try { zip = new PizZip(binary); }
    catch (e) { res.status(400).json({ error: 'The uploaded template is not a valid .docx file.' }); return; }

    let doc;
    try {
      doc = new Docxtemplater(zip, {
        delimiters: { start: '{{', end: '}}' },
        paragraphLoop: true,
        linebreaks: true,
        parser: tickParser,
        nullGetter: function () { return ''; }   // blank for any tag we didn't supply
      });
      doc.render(data);
    } catch (e) {
      // Surface template problems (e.g. an unmatched {{ or a typo'd tag) clearly.
      let msg = (e && e.message) || String(e);
      if (e && e.properties && e.properties.errors && e.properties.errors.length) {
        msg = e.properties.errors.map(function (x) {
          return (x.properties && x.properties.explanation) || x.message;
        }).join('; ');
      }
      res.status(422).json({ error: 'Template problem: ' + msg });
      return;
    }

    const out = doc.getZip().generate({ type: 'nodebuffer' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', 'attachment; filename="' + fileName + '.docx"');
    res.status(200).send(out);
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
