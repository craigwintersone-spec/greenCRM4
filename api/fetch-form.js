// /api/fetch-form.js — go to a funder's page, find their Expression of Interest / application
// form (Word or PDF), download it, and hand it back.
// ─────────────────────────────────────────────────────────────
// POST { url }  → {
//   ok, kind: 'docx' | 'pdf' | 'page' | 'none',
//   filename, formUrl, base64,          // when a Word/PDF form was found (≤ 3 MB)
//   pageText,                           // the visible text of the funder's page (to read questions from when there is no file)
//   candidates: [{ title, url, kind, score }]
// }
// Server-side because most funder sites block browsers from downloading their files.
// Signed-in users only; private and internal addresses are refused.

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const MAX_FILE = 3 * 1024 * 1024;            // a response can't be more than ~4.5 MB once base64-encoded
const UA = 'Mozilla/5.0 (compatible; VorlanaFormBot/1.0; +https://www.vorlana.com)';

const DOC_TYPES = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/msword': 'doc',
  'application/pdf': 'pdf'
};

function safeUrl(u) {
  let p; try { p = new URL(u); } catch (e) { return null; }
  if (!/^https?:$/.test(p.protocol)) return null;
  const h = p.hostname.toLowerCase();
  if (h === 'localhost' || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith('.local') || h.endsWith('.internal') || h === '[::1]') return null;
  return p;
}

async function get(url, ms = 15000, accept) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms);
  try {
    const r = await fetch(url, { redirect: 'follow', signal: c.signal, headers: { 'User-Agent': UA, Accept: accept || 'text/html,application/xhtml+xml,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.8' } });
    return r;
  } finally { clearTimeout(t); }
}

function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n));
}
function visibleText(html) {
  return decodeEntities(String(html || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<footer[\s\S]*?<\/footer>|<!--[\s\S]*?-->/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function linksOf(html, base) {
  const out = [];
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const raw = decodeEntities(m[2] || m[3] || m[4] || '').trim();
    if (!raw || /^(#|mailto:|tel:|javascript:)/i.test(raw)) continue;
    let abs; try { abs = new URL(raw, base).href; } catch (e) { continue; }
    const title = decodeEntities(m[5].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 160);
    out.push({ url: abs, title });
  }
  return out;
}

function kindOfUrl(u) {
  const path = u.split('?')[0].split('#')[0].toLowerCase();
  if (/\.docx$/.test(path)) return 'docx';
  if (/\.doc$/.test(path)) return 'doc';
  if (/\.pdf$/.test(path)) return 'pdf';
  if (/\.odt$/.test(path)) return 'odt';
  return null;
}

function scoreLink(l) {
  const kind = kindOfUrl(l.url);
  const hay = (l.title + ' ' + decodeURIComponent(l.url.split('/').pop() || '')).toLowerCase();
  let s = 0;
  if (kind === 'docx') s += 50; else if (kind === 'doc') s += 30; else if (kind === 'pdf') s += 22; else if (kind === 'odt') s += 8;
  if (/expression of interest|\beoi\b/.test(hay)) s += 40;
  if (/application form|apply form|proposal form/.test(hay)) s += 35;
  if (/pro ?forma|template/.test(hay)) s += 18;
  if (/application|apply|bid|proposal/.test(hay)) s += 14;
  if (/\bform\b/.test(hay)) s += 8;
  if (/guidance|guidelines|guide\b|privacy|terms|faq|annual report|accounts|policy|equalit|monitoring|logo|map\b|budget|case stud|newsletter|minutes|agenda|scoring|assessment criteria|how to apply|checklist|data protection/.test(hay)) s -= 28;
  return { kind, score: s };
}

// pages that usually lead to the form: "How to apply", "Apply now", "Application"
function applyLinks(links, baseHost) {
  return links.filter(l => { try { return new URL(l.url).hostname === baseHost; } catch (e) { return false; } })
    .filter(l => !kindOfUrl(l.url) && /how to apply|apply( now| here| for)?\b|application|expression of interest|\beoi\b|submit/i.test(l.title))
    .slice(0, 3);
}

async function download(url) {
  const r = await get(url, 20000, '*/*');
  if (!r.ok) return null;
  const ct = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const len = parseInt(r.headers.get('content-length') || '0', 10);
  if (len && len > MAX_FILE) return { tooBig: true };
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_FILE) return { tooBig: true };
  let kind = DOC_TYPES[ct] || kindOfUrl(url) || null;
  // content-type is sometimes generic: trust the file's own signature
  if (buf.slice(0, 4).toString() === '%PDF') kind = 'pdf';
  else if (buf[0] === 0x50 && buf[1] === 0x4B) kind = kind === 'doc' ? 'docx' : (kind || 'docx');
  if (!kind || !['docx', 'pdf', 'doc'].includes(kind)) return null;
  return { kind, buf };
}

async function authed(req) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return true;
  const tok = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!tok) return false;
  const who = await fetch(`${SUPABASE_URL}/auth/v1/user`, { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${tok}` } }).catch(() => null);
  return !!(who && who.ok);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'Use POST.' }); }
  try {
    if (!(await authed(req))) return res.status(401).json({ ok: false, error: 'Your sign-in has expired — refresh the page and try again.' });
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const start = safeUrl(String(body.url || '').trim());
    if (!start) return res.status(400).json({ ok: false, error: 'That doesn\'t look like a web address.' });

    const t0 = Date.now();
    const pages = [];                              // { url, html }
    const seen = new Set();
    const candidates = [];
    let pageText = '';

    const consider = (links) => links.forEach(l => {
      if (seen.has(l.url)) return; seen.add(l.url);
      const { kind, score } = scoreLink(l);
      if (kind && score >= 20) candidates.push({ title: l.title || decodeURIComponent(l.url.split('/').pop() || ''), url: l.url, kind, score });
    });

    // 1. the page itself — it may be the file
    const first = await get(start.href);
    if (!first.ok) return res.status(200).json({ ok: false, error: 'The funder\'s page answered with an error (' + first.status + ').', kind: 'none', candidates: [] });
    const ct = (first.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (DOC_TYPES[ct] || kindOfUrl(start.href)) {
      const d = await download(start.href);
      if (d && d.buf) return res.status(200).json({ ok: true, kind: d.kind, filename: decodeURIComponent(start.pathname.split('/').pop() || 'form'), formUrl: start.href, base64: d.buf.toString('base64'), candidates: [] });
    }
    const html1 = await first.text();
    pages.push({ url: first.url || start.href, html: html1 });
    pageText = visibleText(html1).slice(0, 7000);
    consider(linksOf(html1, first.url || start.href));

    // 2. no form on that page: follow its "How to apply" style links, one level
    if (!candidates.length) {
      for (const l of applyLinks(linksOf(html1, first.url || start.href), start.hostname)) {
        if (Date.now() - t0 > 22000) break;
        try {
          const r = await get(l.url, 10000);
          if (!r.ok || !/html/.test(r.headers.get('content-type') || '')) continue;
          const h = await r.text();
          pages.push({ url: r.url || l.url, html: h });
          consider(linksOf(h, r.url || l.url));
          if (pageText.length < 4000) pageText += '\n\n' + visibleText(h).slice(0, 4000);
        } catch (e) { /* try the next */ }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    // 3. download the best candidates (Word first, then PDF) until one works
    for (const c of candidates.slice(0, 3)) {
      if (Date.now() - t0 > 40000) break;
      if (!safeUrl(c.url)) continue;
      try {
        const d = await download(c.url);
        if (d && d.buf && d.kind !== 'doc') {
          return res.status(200).json({ ok: true, kind: d.kind, filename: decodeURIComponent(c.url.split('?')[0].split('/').pop() || 'form'), formUrl: c.url, base64: d.buf.toString('base64'), pageText: pageText.slice(0, 5000), candidates: candidates.slice(0, 6) });
        }
        if (d && d.tooBig) c.tooBig = true;
      } catch (e) { /* next */ }
    }

    return res.status(200).json({ ok: true, kind: pageText.length > 300 ? 'page' : 'none', pageText, candidates: candidates.slice(0, 6), pageUrl: first.url || start.href });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e && e.name === 'AbortError' ? 'The funder\'s site took too long to answer.' : ('Could not reach the funder\'s page: ' + (e && e.message || e)), kind: 'none', candidates: [] });
  }
};
module.exports._test = { scoreLink, linksOf, kindOfUrl, visibleText, safeUrl };
