// api/_lib/org-lookup.js — find an organisation on the public registers (Charity Commission, Companies House and
// others, via Find that Charity) and turn its record into the facts bids need: legal name, numbers, address,
// postcode, website, income, spending and year end. Free, public data; no key needed.
const FTC = 'https://findthatcharity.uk';
const UA = 'Vorlana/1.0 (+https://www.vorlana.com; hello@vorlana.com)';

async function get(url, ms) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), ms || 8000);
  try { const r = await fetch(url, { signal: c.signal, headers: { Accept: 'application/json', 'User-Agent': UA } }); return r.ok ? await r.json() : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
const simple = s => String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\b(the|ltd|limited|cio|cic|c\.i\.c\.|uk)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// Candidates for a name: [{ id, name, score, match }]
async function candidates(name) {
  const q = encodeURIComponent(JSON.stringify({ q0: { query: String(name || '').slice(0, 120), limit: 5 } }));
  for (const base of [FTC + '/reconcile', FTC + '/api/v1/reconcile']) {
    const r = await get(`${base}?queries=${q}`);
    const res = r && r.q0 && Array.isArray(r.q0.result) ? r.q0.result : null;
    if (res) return res.filter(x => x && x.id).map(x => ({ id: String(x.id), name: x.name || '', score: +x.score || 0, match: !!x.match }));
  }
  return [];
}
// An ID from a typed number: charity numbers are 6–7 digits; company numbers are 8 characters (CICs are companies)
function idFromNumber(n) {
  const v = String(n || '').toUpperCase().replace(/\s+/g, '');
  if (/^\d{6,7}$/.test(v)) return 'GB-CHC-' + v;
  if (/^SC\d{5,6}$/.test(v)) return 'GB-SC-' + v;
  if (/^(\d{8}|[A-Z]{2}\d{6})$/.test(v)) return 'GB-COH-' + v;
  if (/^\d{5,7}$/.test(v)) return 'GB-COH-' + v.padStart(8, '0');
  return null;
}

// Pull a value from a record, whatever the exact field names are
function pick(o, names) {
  if (!o || typeof o !== 'object') return undefined;
  for (const n of names) if (o[n] != null && o[n] !== '') return o[n];
  for (const k of Object.keys(o)) if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k])) { const v = pick(o[k], names); if (v != null && v !== '') return v; }
  return undefined;
}
const gbp = n => { const v = Math.round(+n || 0); return v ? '£' + v.toLocaleString('en-GB') : ''; };
function yearEnd(d) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

// The full record for an ID, as bid facts
async function details(id) {
  const rec = await get(`${FTC}/orgid/${encodeURIComponent(id)}.json`, 9000);
  if (!rec) return null;
  const r = rec.data || rec;
  const ids = [].concat(pick(r, ['orgIDs', 'orgIds', 'linked_orgs']) || [], [id]).map(String);
  const chc = (ids.find(x => /^GB-(CHC|SC|NIC)-/.test(x)) || '').replace(/^GB-(CHC|SC|NIC)-/, '');
  const coh = (ids.find(x => /^GB-COH-/.test(x)) || '').replace(/^GB-COH-/, '');
  const street = pick(r, ['streetAddress', 'address_street']), town = pick(r, ['addressLocality', 'address_town', 'town']), region = pick(r, ['addressRegion', 'county']);
  const postcode = pick(r, ['postalCode', 'postcode', 'address_postcode']);
  const income = pick(r, ['latestIncome', 'income', 'latest_income']), spend = pick(r, ['latestSpending', 'spending', 'latest_spending', 'expenditure']);
  const fye = pick(r, ['latestIncomeDate', 'latestFinancialYearEnd', 'financialYearEnd', 'fye', 'latest_fye']);
  const facts = {
    legal_name: pick(r, ['name', 'legalName']) || '',
    charity_number: chc, company_number: coh,
    address: [street, town, region, postcode].filter(Boolean).join(', '),
    postcode: postcode || '',
    website: pick(r, ['url', 'website', 'web']) || '',
    annual_income: income != null ? gbp(income) : '',
    annual_spend: spend != null ? String(Math.round(+spend || 0) || '') : '',
    year_end: yearEnd(fye)
  };
  Object.keys(facts).forEach(k => { if (!facts[k]) delete facts[k]; });
  return { id, name: facts.legal_name || '', facts, registered: pick(r, ['dateRegistered', 'date_registered']) || '', active: pick(r, ['active']) !== false,
    summary: [chc ? 'Charity ' + chc : coh ? 'Company ' + coh : id, postcode, income != null ? 'income ' + gbp(income) : ''].filter(Boolean).join(' · ') };
}

// Best guess for a name: confident only when the register's name is the same name
async function confident(name) {
  const c = await candidates(name);
  const best = c.find(x => simple(x.name) === simple(name)) || c.find(x => x.match && x.score >= 90);
  return best ? details(best.id) : null;
}

module.exports = { candidates, details, confident, idFromNumber, simple };
