// /api/_lib/sentinel-mail.js — the morning briefing, by email
// Sent once a day after Sentinel's 06:00 run: the briefing team by team, every urgent card, and what's new since yesterday.
// To: SENTINEL_EMAIL (one address, or several separated by commas), otherwise hello@vorlana.com.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = (process.env.APP_URL || 'https://www.vorlana.com').replace(/\/$/, '');
const TO = (process.env.SENTINEL_EMAIL || 'hello@vorlana.com').split(',').map(x => x.trim()).filter(Boolean);
const SENT_ACTION = 'Emailed the morning briefing';

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmt = t => esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br/>');
const TIER_COLOUR = { urgent: '#B91C1C', high: '#B45309', medium: '#1F6F6D', low: '#6B7280' };

async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${path.split('?')[0]} ${r.status}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
}

// Once a day: a second run (someone pressing Run) doesn't send it again
async function sentToday() {
  const start = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' }) + 'T00:00:00Z').toISOString();
  try { const rows = await sb(`sentinel_actions?agent=eq.Chief%20of%20Staff&action=eq.${encodeURIComponent(SENT_ACTION)}&created_at=gte.${start}&select=id&limit=1`); return rows && rows.length > 0; }
  catch (e) { return false; }
}

// briefing: { headline, narrative, stats }; teams: [{ name, open, urgent, high }]; urgent: open urgent cards; fresh: cards added this morning
async function sendBriefingEmail({ briefing, teams, urgent, fresh, force }) {
  if (!RESEND_API_KEY) return { sent: false, why: 'RESEND_API_KEY not set' };
  if (!briefing) return { sent: false, why: 'no briefing' };
  if (!force && await sentToday()) return { sent: false, why: 'already sent today' };

  const day = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/London' });
  const card = d => `<div style="border-left:3px solid ${TIER_COLOUR[d.tier] || '#1F6F6D'};padding:6px 10px;margin:6px 0;background:#FAFAF8">
      <div style="font-size:11px;color:${TIER_COLOUR[d.tier] || '#1F6F6D'};font-weight:700;text-transform:uppercase;letter-spacing:.4px">${esc(d.tier)} · ${esc(d.team || d.agent || '')}</div>
      <div style="font-size:14px;font-weight:600;color:#111">${esc(d.title)}</div>
      ${d.description ? `<div style="font-size:12.5px;color:#555;margin-top:2px">${esc(String(d.description).slice(0, 220))}</div>` : ''}</div>`;
  const freshOther = (fresh || []).filter(d => d.tier !== 'urgent');
  const html = `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:640px;margin:0 auto;color:#222">
    <div style="background:#1F6F6D;color:#fff;border-radius:12px;padding:20px 22px">
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.6px;opacity:.85;font-weight:600">Sentinel · ${esc(day)}</div>
      <div style="font-size:20px;font-weight:800;margin:6px 0 12px">${esc(briefing.headline)}</div>
      <div style="font-size:14px;line-height:1.65">${fmt(briefing.narrative)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;margin:18px 0;font-size:13px">
      <tr style="text-align:left;color:#777;font-size:11px;text-transform:uppercase"><th style="padding:6px 4px">Team</th><th>Open</th><th>Urgent</th><th>High</th></tr>
      ${(teams || []).map(t => `<tr style="border-top:1px solid #eee"><td style="padding:7px 4px;font-weight:600">${esc(t.name)}</td><td>${t.open}</td><td style="color:${t.urgent ? '#B91C1C' : '#999'};font-weight:${t.urgent ? 700 : 400}">${t.urgent}</td><td>${t.high}</td></tr>`).join('')}
    </table>
    ${(urgent || []).length ? `<h3 style="font-size:14px;margin:18px 0 4px;color:#B91C1C">Urgent (${urgent.length})</h3>` + urgent.slice(0, 15).map(card).join('') : '<p style="font-size:13px;color:#166534">✓ Nothing urgent.</p>'}
    ${freshOther.length ? `<h3 style="font-size:14px;margin:18px 0 4px">New this morning (${freshOther.length})</h3>` + freshOther.slice(0, 12).map(card).join('') + (freshOther.length > 12 ? `<p style="font-size:12px;color:#777">and ${freshOther.length - 12} more</p>` : '') : ''}
    <p style="margin:22px 0 6px"><a href="${APP_URL}/super-admin.html" style="background:#1F6F6D;color:#fff;text-decoration:none;padding:10px 18px;border-radius:999px;font-weight:600;font-size:14px">Open Sentinel</a></p>
    <p style="font-size:11px;color:#999;margin-top:18px">Sent by Sentinel after its 06:00 run. Only to ${esc(TO.join(', '))}.</p></div>`;

  const subject = `${(urgent || []).length ? '🔴 ' : ''}Sentinel · ${briefing.headline}`;
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Sentinel <hello@vorlana.com>', to: TO, subject: subject.slice(0, 180), html }) });
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (await r.text()).slice(0, 200));
  try { await sb('sentinel_actions', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify([{ agent: 'Chief of Staff', action: SENT_ACTION, detail: `To ${TO.join(', ')} · ${(urgent || []).length} urgent · ${(fresh || []).length} new`, org_id: null, cost_pence: 0 }]) }); } catch (e) { /* the email went; the log line is a nicety */ }
  return { sent: true, to: TO };
}

module.exports = { sendBriefingEmail };
