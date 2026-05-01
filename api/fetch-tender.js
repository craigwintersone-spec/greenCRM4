// /api/fetch-tender.js
// Server-side proxy for downloading tender documents found by the
// Opportunities Finder. We proxy through Vercel because:
//   1. Many UK gov / funder sites block CORS so the browser can't
//      download them directly.
//   2. We can verify the user is authenticated before letting them
//      hit arbitrary URLs.
//   3. We can sanity-check the URL and limit response size.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGIN_REGEX = /^https?:\/\/(localhost(:\d+)?|.*\.vercel\.app|civara\.co\.uk|www\.civara\.co\.uk)$/i;
const MAX_BYTES = 25 * 1024 * 1024; // 25 MB cap
const ALLOWED_CONTENT_TYPES = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/octet-stream', // some servers send PDFs as this
  'text/html', // some links go to a download landing page
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGIN_REGEX.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
}

async function getAuthUser(req) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;
  const r = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!r.ok) return null;
  const user = await r.json();
  return user && user.id ? user : null;
}

module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ error: 'Server misconfigured.' });
  }

  // 1. Auth
  const user = await getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in.' });

  // 2. Validate URL
  const target = req.query.url;
  if (!target || typeof target !== 'string') {
    return res.status(400).json({ error: 'Missing url parameter.' });
  }
  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).json({ error: 'Invalid URL.' }); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return res.status(400).json({ error: 'Only http(s) URLs are allowed.' });
  }
  // Block private/loopback/internal hosts to prevent SSRF
  const host = parsed.hostname.toLowerCase();
  if (
    host === 'localhost' ||
    host.startsWith('127.') ||
    host.startsWith('10.') ||
    host.startsWith('192.168.') ||
    host.startsWith('169.254.') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return res.status(400).json({ error: 'URL host not allowed.' });
  }

  // 3. Fetch with timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const upstream = await fetch(target, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; CivaraTenderBot/1.0)',
        'Accept': 'application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,*/*;q=0.8',
      },
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      return res.status(502).json({ error: 'Upstream returned ' + upstream.status });
    }

    const ct = (upstream.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const len = parseInt(upstream.headers.get('content-length') || '0', 10);
    if (len && len > MAX_BYTES) {
      return res.status(413).json({ error: 'File too large (>25MB).' });
    }
    const okType = ALLOWED_CONTENT_TYPES.some(t => ct === t || ct.startsWith(t));
    if (!okType) {
      return res.status(415).json({ error: 'Unsupported content type: ' + (ct || 'unknown') });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (buf.byteLength > MAX_BYTES) {
      return res.status(413).json({ error: 'File too large (>25MB).' });
    }

    res.setHeader('Content-Type', ct || 'application/octet-stream');
    res.setHeader('Content-Length', String(buf.byteLength));
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.status(200).send(buf);
  } catch (err) {
    clearTimeout(timeout);
    const isAbort = err.name === 'AbortError';
    return res.status(isAbort ? 504 : 502).json({
      error: isAbort ? 'Upstream timed out after 20s.' : (err.message || 'Fetch failed'),
    });
  }
};
