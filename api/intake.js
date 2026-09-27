// /api/intake.js — public endpoint behind intake.html (participant self-service)
// ─────────────────────────────────────────────────────────────
// GET  ?t=<token>   → org name/logo/colour, the prefilled details, and the
//                     questions this person needs to answer (standard profile
//                     plus anything the chosen contracts' forms ask)
// POST { t, data, signature, signed_name } → saves the answers and signature
//
// SECURITY — this is PUBLIC:
//   • The browser never gets a Supabase key; only this function (server key)
//     reads or writes intake_requests, and only the row matching the token.
//   • Tokens are 32 random characters, expire after 14 days, and stop working
//     once submitted. Nothing about other participants is ever returned.
//   • Rate limited per IP; payload sizes capped.

const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const RATE = { windowMs: 60 * 1000, max: 30, hits: new Map() };

const YN = ['Yes', 'No', 'Prefer not to say'];
// The standard profile — the same keys the form filler uses (api/fill-form.js FIELD_CATALOG)
const PROFILE = [
  { section: 'About you', key: 'title', label: 'Title', type: 'choice', options: ['Mr', 'Mrs', 'Miss', 'Ms', 'Mx', 'Dr'] },
  { section: 'About you', key: 'forename', label: 'First name', type: 'text', required: true },
  { section: 'About you', key: 'surname', label: 'Last name', type: 'text', required: true },
  { section: 'About you', key: 'dob', label: 'Date of birth', type: 'date', required: true },
  { section: 'About you', key: 'ni', label: 'National Insurance number', type: 'text', hint: 'e.g. AB 12 34 56 C — on payslips and benefit letters' },
  { section: 'About you', key: 'phone', label: 'Mobile number', type: 'tel' },
  { section: 'About you', key: 'email', label: 'Email', type: 'email' },
  { section: 'About you', key: 'address', label: 'Home address', type: 'text' },
  { section: 'About you', key: 'postcode', label: 'Postcode', type: 'text' },
  { section: 'About you', key: 'gender', label: 'Gender', type: 'choice', options: ['Male', 'Female', 'Other', 'Prefer not to say'] },
  { section: 'About you', key: 'ethnicity', label: 'Ethnicity', type: 'choice', options: ['White British', 'White Irish', 'White – Gypsy, Roma or Irish Traveller', 'White – other', 'Mixed – White and Black Caribbean', 'Mixed – White and Black African', 'Mixed – White and Asian', 'Mixed – other', 'Asian – Indian', 'Asian – Pakistani', 'Asian – Bangladeshi', 'Asian – Chinese', 'Asian – other', 'Black – African', 'Black – Caribbean', 'Black – other', 'Arab', 'Other', 'Prefer not to say'] },
  { section: 'Your situation', key: 'right_to_work', label: 'Do you have the right to live and work in the UK?', type: 'choice', options: ['Yes', 'No'], required: true },
  { section: 'Your situation', key: 'labour_status', label: 'Which best describes you right now?', type: 'choice', options: ['Unemployed', 'Economically inactive', 'Employed'] },
  { section: 'Your situation', key: 'in_education', label: 'Are you in education or training?', type: 'choice', options: ['Yes', 'No'] },
  { section: 'Your situation', key: 'education_level', label: 'Your highest qualification', type: 'choice', options: ['None / below primary (ISCED 0)', 'Primary (ISCED 1)', 'GCSE or equivalent (ISCED 2)', 'A level or equivalent (ISCED 3)', 'Post-A level, not degree (ISCED 4)', 'Degree or higher (ISCED 5–8)'],
    map: { 'None / below primary (ISCED 0)': 'Below Primary education (ISCED level 0)', 'Primary (ISCED 1)': 'Primary education or equivalent (ISCED 1)', 'GCSE or equivalent (ISCED 2)': 'Lower secondary education or equivalent (ISCED 2)',
      'A level or equivalent (ISCED 3)': 'Upper secondary education or equivalent (ISCED 3)', 'Post-A level, not degree (ISCED 4)': 'Post-secondary (non-tertiary) education or equivalent (ISCED 4)', 'Degree or higher (ISCED 5–8)': 'Tertiary education or equivalent (ISCED 5-8)' } },
  { section: 'Your situation', key: 'basic_skills', label: 'Do you have English and maths qualifications (Entry Level, Level 1 or 2)?', type: 'choice', options: ['Yes', 'No'] },
  { section: 'Your situation', key: 'jobless_household', label: 'Does anyone in your home work?', type: 'choice', options: ['Yes, someone works', 'No, nobody works', 'Prefer not to say'], map: { 'Yes, someone works': 'No', 'No, nobody works': 'Yes' } },
  { section: 'Your situation', key: 'single_adult_dependants', label: 'Are you the only adult at home, with children who depend on you?', type: 'choice', options: YN },
  { section: 'Your situation', key: 'caring_responsibilities', label: 'Do you care for someone?', type: 'choice', options: YN },
  { section: 'Your situation', key: 'health_condition', label: 'Do you have a disability or long-term health condition?', type: 'choice', options: YN },
  { section: 'Your situation', key: 'sen', label: 'Do you have a special educational need?', type: 'choice', options: YN },
  { section: 'Your situation', key: 'homeless', label: 'Are you homeless right now?', type: 'choice', options: YN },
  { section: 'Your situation', key: 'refugee', label: 'Are you a refugee?', type: 'choice', options: YN },
  { section: 'Your situation', key: 'care_leaver', label: 'Have you been in care (a care leaver)?', type: 'choice', options: YN },
  { section: 'Your situation', key: 'adult_social_care', label: 'Are you supported by Adult Social Care?', type: 'choice', options: YN },
  { section: 'Your situation', key: 'offender', label: 'Do you have an unspent conviction?', type: 'choice', options: YN, hint: 'This does not stop you taking part.' },
  { section: 'What would help', key: 'support_needs', label: 'What would you like help with?', type: 'multi', options: ['English', 'Maths', 'Digital', 'Communication', 'Confidence', 'Working with others', 'Time management', 'Motivation to work', 'Motivation to do training', 'CV writing', 'Interview skills'] }
];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function limited(req) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const now = Date.now(), rec = RATE.hits.get(ip);
  if (!rec || now - rec.t > RATE.windowMs) { RATE.hits.set(ip, { t: now, n: 1 }); return false; }
  rec.n++; return rec.n > RATE.max;
}
async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, Object.assign({}, opts, {
    headers: Object.assign({ apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', Prefer: 'return=representation' }, opts.headers || {})
  }));
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.status === 204 ? [] : r.json();
}
const clean = v => String(v == null ? '' : v).replace(/[\u0000-\u001f<>]/g, ' ').trim().slice(0, 300);

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!SUPABASE_URL || !KEY) return res.status(500).json({ ok: false, error: 'Not configured' });
  if (limited(req)) return res.status(429).json({ ok: false, error: 'Too many requests — wait a minute and try again.' });
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const token = String((req.query && req.query.t) || body.t || '').replace(/[^A-Za-z0-9]/g, '');
  if (token.length < 24) return res.status(400).json({ ok: false, error: 'This link is not complete — ask for a new one.' });
  try {
    const rows = await sb(`intake_requests?token=eq.${token}&select=*&limit=1`);
    const r = rows[0];
    if (!r) return res.status(404).json({ ok: false, error: 'This link is not valid — ask for a new one.' });
    if (r.status === 'cancelled') return res.status(410).json({ ok: false, error: 'This link has been cancelled.' });
    if (['submitted', 'accepted'].includes(r.status)) return res.status(200).json({ ok: true, done: true });
    if (new Date(r.expires_at) < new Date()) return res.status(410).json({ ok: false, error: 'This link has expired — ask for a new one.' });

    if (req.method === 'GET') {
      const org = (await sb(`organisations?id=eq.${r.org_id}&select=name,logo_url,brand_color&limit=1`))[0] || {};
      // Extra questions from the chosen contracts' forms that aren't in the standard profile
      const extra = [];
      const ids = Array.isArray(r.contract_ids) ? r.contract_ids : [];
      if (ids.length) {
        const keys = ids.map(id => `"contract:${String(id).replace(/[^A-Za-z0-9-]/g, '')}"`).join(',');
        const maps = await sb(`form_maps?org_id=eq.${r.org_id}&form_key=in.(${encodeURIComponent(keys)})&select=form_key,items`).catch(() => []);
        maps.forEach(m => (m.items || []).forEach(it => {
          if (it.use === 'ask' && (it.type === 'choice' || it.type === 'text') && !/sign|signature|office/i.test(it.label))
            extra.push({ section: 'A few more questions', key: 'form:' + m.form_key + ':' + it.id, label: it.label, type: it.type === 'choice' ? 'choice' : 'text', options: it.options || undefined });
        }));
      }
      if (r.status === 'sent') await sb(`intake_requests?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'opened' }) }).catch(() => {});
      return res.status(200).json({ ok: true, org: { name: org.name || '', logo: org.logo_url || '', colour: org.brand_color || '#1F6F6D' },
        prefill: r.prefill || {}, questions: PROFILE.map(({ map, ...q }) => q).concat(extra),
        consent: `I confirm the information I have given is true to the best of my knowledge. I agree to ${org.name || 'the organisation'} using it to support me and to report anonymously to the funders of this programme, as described in their privacy notice.` });
    }

    if (req.method === 'POST') {
      if (JSON.stringify(body).length > 400000) return res.status(413).json({ ok: false, error: 'Too much data.' });
      const sig = String(body.signature || '');
      if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(sig) || sig.length < 400) return res.status(400).json({ ok: false, error: 'Please sign in the box before sending.' });
      const signedName = clean(body.signed_name);
      if (!signedName) return res.status(400).json({ ok: false, error: 'Please type your name under your signature.' });
      const data = {};
      const allowed = new Set(PROFILE.map(q => q.key));
      Object.entries(body.data || {}).forEach(([k, v]) => {
        if (!(allowed.has(k) || /^form:contract:[A-Za-z0-9-]+:[a-z]\d+$/.test(k))) return;
        const q = PROFILE.find(x => x.key === k);
        if (Array.isArray(v)) data[k] = v.map(clean).filter(Boolean).slice(0, 20);
        else data[k] = q && q.map && q.map[v] ? q.map[v] : clean(v);
      });
      const miss = PROFILE.filter(q => q.required && !data[q.key]).map(q => q.label);
      if (miss.length) return res.status(400).json({ ok: false, error: 'Please answer: ' + miss.join(', ') });
      const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
      await sb(`intake_requests?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({
        status: 'submitted', data, signature: sig, signed_name: signedName, signed_at: new Date().toISOString(), consent_text: clean(body.consent).slice(0, 600), submit_ip: ip
      }) });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: 'Something went wrong — please try again.' });
  }
};
