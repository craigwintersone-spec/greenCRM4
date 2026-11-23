// /api/bid-asks.js — the hands-free part of the bid tracker.
//   Daily (Vercel cron): for each bid submitted 8+ weeks ago with no result yet, email the person who wrote it
//   once, asking "Did you win?" with two one-tap links.
//   GET ?b=<bid id>&r=won|lost&t=<signature> → a small confirm page (so email link-scanners can't record anything)
//   POST the same three fields → records the result and says thank you.
// Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY, APP_URL, CRON_SECRET (optional)
const crypto = require('crypto');
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');
const CRON_SECRET = process.env.CRON_SECRET || null;
const WAIT_DAYS = 56;

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Accept: 'application/json', ...(opts.headers || {}) } });
  const t = await r.text(); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) { b = t; }
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}: ${typeof b === 'string' ? b : (b && b.message) || ''}`);
  return b;
}
const sign = (id, r) => crypto.createHmac('sha256', String(KEY || '')).update('bid:' + id + ':' + r).digest('hex').slice(0, 32);
const okSig = (id, r, t) => { const a = Buffer.from(sign(id, r)), b = Buffer.from(String(t || '')); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const UUID = /^[0-9a-f-]{36}$/i;

function page(title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;background:#F5F5F7;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#1D1D1F}
.c{max-width:460px;margin:12vh auto;background:#fff;border-radius:18px;box-shadow:0 6px 24px rgba(0,0,0,.06);padding:28px 26px;text-align:center}
h1{font-size:22px;margin:0 0 8px}p{color:#6E6E73;font-size:15px;line-height:1.5}button,a.b{display:inline-block;border:0;border-radius:980px;padding:11px 22px;font-size:15px;font-weight:600;cursor:pointer;text-decoration:none;margin:6px}
.y{background:#1F6F6D;color:#fff}.n{background:#EDEDF0;color:#1D1D1F}</style></head><body><div class="c">${inner}</div></body></html>`;
}

async function emailOf(userId) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } });
  const u = r.ok ? await r.json() : null;
  return u && u.email ? u.email : null;
}

async function sendAsks() {
  const before = new Date(Date.now() - WAIT_DAYS * 864e5).toISOString();
  const due = await sb(`bids?status=eq.submitted&ask_sent_at=is.null&submitted_at=lt.${encodeURIComponent(before)}&select=id,org_id,funder,programme,amount,created_by&limit=50`);
  let sent = 0;
  for (const b of due || []) {
    try {
      const to = b.created_by ? await emailOf(b.created_by) : null;
      if (to && RESEND_API_KEY) {
        const name = esc(b.funder + (b.programme ? ' — ' + b.programme : ''));
        const link = r => `${APP_URL}/api/bid-asks?b=${b.id}&r=${r}&t=${sign(b.id, r)}`;
        const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1A1A1A">
<h2 style="font-size:20px;margin:0 0 10px">Did you win it?</h2>
<p style="font-size:15px">About eight weeks ago you sent a bid to <b>${name}</b>${b.amount ? ' for ' + esc(b.amount) : ''}. Have you heard back?</p>
<p style="margin:20px 0"><a href="${link('won')}" style="display:inline-block;background:#1F6F6D;color:#fff;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:bold;margin-right:8px">Yes, we won it</a>
<a href="${link('lost')}" style="display:inline-block;background:#EDEDF0;color:#1A1A1A;padding:11px 20px;border-radius:999px;text-decoration:none;font-weight:bold">No, we didn't</a></p>
<p style="font-size:13px;color:#6B665C">One tap is all it takes. It keeps your win rate and funding totals up to date in Vorlana. Not heard yet? Just ignore this email.</p>
<p style="color:#8A857A;font-size:12px;margin-top:18px">Sent by Vorlana</p></div>`;
        const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: 'Vorlana <hello@vorlana.com>', to: [to], subject: `Did you win the ${b.funder} bid?`, html }) });
        if (!r.ok) throw new Error('Resend ' + r.status);
        sent++;
      }
      await sb(`bids?id=eq.${b.id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ ask_sent_at: new Date().toISOString() }) });
    } catch (e) { console.warn('[bid-asks]', b.id, e.message); }
  }
  return { due: (due || []).length, sent };
}

module.exports = async (req, res) => {
  try {
    if (!SUPABASE_URL || !KEY) return res.status(500).json({ error: 'Server misconfigured.' });
    const q = req.query || {};
    const body = typeof req.body === 'string' ? (() => { try { return Object.fromEntries(new URLSearchParams(req.body)); } catch (e) { return {}; } })() : (req.body || {});
    const id = String(body.b || q.b || ''), r = String(body.r || q.r || ''), t = String(body.t || q.t || '');

    // An answer from the email
    if (id || r || t) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (!UUID.test(id) || !/^(won|lost)$/.test(r) || !okSig(id, r, t)) return res.status(400).send(page('Link not valid', '<h1>That link isn\'t valid</h1><p>Please open Vorlana and update the bid there.</p>'));
      const bid = ((await sb(`bids?id=eq.${id}&select=id,funder,programme,status`)) || [])[0];
      if (!bid) return res.status(404).send(page('Bid not found', '<h1>We couldn\'t find that bid</h1><p>It may have been removed.</p>'));
      const name = esc(bid.funder + (bid.programme ? ' — ' + bid.programme : ''));
      if (req.method !== 'POST') {
        return res.status(200).send(page('Confirm', `<h1>${r === 'won' ? 'Congratulations!' : 'Sorry to hear that'}</h1><p>Record <b>${name}</b> as ${r === 'won' ? 'won' : 'not won'}?</p>
<form method="post" action="/api/bid-asks"><input type="hidden" name="b" value="${esc(id)}"><input type="hidden" name="r" value="${esc(r)}"><input type="hidden" name="t" value="${esc(t)}"><button class="y" type="submit">Yes, record it</button></form>`));
      }
      await sb(`bids?id=eq.${id}`, { method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ status: r, decided_at: new Date().toISOString() }) });
      return res.status(200).send(page('Recorded', `<h1>Thanks, recorded</h1><p><b>${name}</b> is marked as ${r === 'won' ? 'won' : 'not won'}.${r === 'won' ? ' You can add the amount you were awarded in Vorlana.' : ' Funders often give feedback if you ask, and it helps the next bid.'}</p><a class="b y" href="${APP_URL}/app.html?page=bd">Open Vorlana</a>`));
    }

    // The daily run
    if (CRON_SECRET && (req.headers.authorization || '') !== `Bearer ${CRON_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });
    return res.status(200).json(await sendAsks());
  } catch (e) {
    console.error('[bid-asks]', e);
    return res.status(500).json({ error: 'Something went wrong.' });
  }
};
module.exports._test = { sign, okSig };
