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
const simple = s => String(s || '').toLowerCase().replace(/c\.i\.c\.?|c\.i\.o\.?/g, ' ').replace(/&/g, 'and').replace(/\b(the|ltd|limited|cio|cic|c\.i\.c\.|uk)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

// Candidates for a name: [{ id, name, score, match }]
async function candidates(name) {
  const q = encodeURIComponent(JSON.stringify({ q0: { query: String(name || '').slice(0, 120), limit: 5 } }));
  for (const base of [FTC + '/reconcile', FTC + '/api/v1/reconcile']) {
    const r = await get(`${base}?queries=${q}`);
    const res = r && r.q0 && Array.isArray(r.q0.result) ? r.q0.result : null;
    if (res) {
      const found = res.filter(x => x && x.id).map(x => ({ id: String(x.id), name: x.name || '', score: +x.score || 0, match: !!x.match }));
      if (found.some(x => x.match || x.score >= 60)) return found;
      return (await chSearch(name)).slice(0, 3).concat(found).slice(0, 6);   // nothing close on Find that Charity: Companies House first
    }
  }
  return chSearch(name);
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
  if (!rec) return /^GB-COH-/.test(id) ? chDetails(id.replace(/^GB-COH-/, '')) : null;   // not on Find that Charity: try Companies House
  const r = rec.data || rec;
  const ids = [].concat(pick(r, ['orgIDs', 'orgIds', 'linked_orgs']) || [], [id]).map(String);
  const chc = (ids.find(x => /^GB-(CHC|SC|NIC)-/.test(x)) || '').replace(/^GB-(CHC|SC|NIC)-/, '');
  const coh = (ids.find(x => /^GB-COH-/.test(x)) || '').replace(/^GB-COH-/, '');
  const street = pick(r, ['streetAddress', 'address_street']), town = pick(r, ['addressLocality', 'address_town', 'town']), region = pick(r, ['addressRegion', 'county']);
  const postcode = pick(r, ['postalCode', 'postcode', 'address_postcode']);
  const income = pick(r, ['latestIncome', 'income', 'latest_income']), spend = pick(r, ['latestSpending', 'spending', 'latest_spending', 'expenditure']);
  const fye = pick(r, ['latestIncomeDate', 'latestFinancialYearEnd', 'financialYearEnd', 'fye', 'latest_fye']);
  // size: people, as last reported to the regulator
  const count = names => { const v = pick(r, names); const n = Array.isArray(v) ? v.length : +v; return Number.isFinite(n) && n > 0 ? Math.round(n) : 0; };
  const staff = count(['employees', 'staff', 'numberOfEmployees', 'num_employees']);
  const vols = count(['volunteers', 'numberOfVolunteers', 'num_volunteers']);
  const trustees = count(['trustees', 'numberOfTrustees', 'num_trustees', 'trustee_count']);
  // turnover: the latest year and the one before it, for the trend
  const hist = (pick(r, ['finances', 'financialHistory', 'financial_history', 'income_history']) || []);
  const years = (Array.isArray(hist) ? hist : []).map(h => ({ end: String(h.financialYearEnd || h.fyend || h.fye || h.date || h.year || ''), income: +(h.income != null ? h.income : h.totalIncome), spend: +(h.spending != null ? h.spending : h.expenditure) }))
    .filter(y => y.end && Number.isFinite(y.income)).sort((a, b) => b.end.localeCompare(a.end));
  const latestEnd = String(fye || (years[0] && years[0].end) || '').slice(0, 10);
  const prev = years.find(y => y.end.slice(0, 10) < latestEnd);   // the year before the latest
  const facts = {
    legal_name: pick(r, ['name', 'legalName']) || '',
    charity_number: chc, company_number: coh,
    address: [street, town, region, postcode].filter(Boolean).join(', '),
    postcode: postcode || '',
    website: pick(r, ['url', 'website', 'web']) || '',
    annual_income: income != null ? gbp(income) : '',
    annual_spend: spend != null ? String(Math.round(+spend || 0) || '') : '',
    year_end: yearEnd(fye),
    staff_count: staff ? String(staff) : '',
    volunteer_count: vols ? String(vols) : '',
    trustee_count: trustees ? String(trustees) : '',
    income_previous: prev && Number.isFinite(prev.income) ? gbp(prev.income) + ' (year ending ' + prev.end.slice(0, 10) + ')' : '',
    register_year: fye ? 'year ending ' + String(fye).slice(0, 10) : ''
  };
  Object.keys(facts).forEach(k => { if (!facts[k]) delete facts[k]; });
  return { id, name: facts.legal_name || '', facts, registered: pick(r, ['dateRegistered', 'date_registered']) || '', active: pick(r, ['active']) !== false,
    summary: [chc ? 'Charity ' + chc : coh ? 'Company ' + coh : id, postcode, income != null ? 'income ' + gbp(income) : '', staff ? staff + ' staff' : '', vols ? vols + ' volunteers' : ''].filter(Boolean).join(' · ') };
}

// ── Companies House, for companies Find that Charity doesn't hold (many CICs and newer companies) ──
// With COMPANIES_HOUSE_API_KEY (free, from developer.company-information.service.gov.uk) the official API is used;
// without it, the public Find and update company information pages.
const CH_KEY = process.env.COMPANIES_HOUSE_API_KEY || '';
const CH_API = 'https://api.company-information.service.gov.uk';
const CH_WEB = 'https://find-and-update.company-information.service.gov.uk';
async function chApi(path) {
  if (!CH_KEY) return null;
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
  try { const r = await fetch(CH_API + path, { signal: c.signal, headers: { Accept: 'application/json', Authorization: 'Basic ' + Buffer.from(CH_KEY + ':').toString('base64') } }); return r.ok ? await r.json() : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
async function chPage(path) {
  const c = new AbortController(); const t = setTimeout(() => c.abort(), 8000);
  try { const r = await fetch(CH_WEB + path, { signal: c.signal, headers: { Accept: 'text/html', 'User-Agent': UA } }); return r.ok ? await r.text() : null; }
  catch (e) { return null; } finally { clearTimeout(t); }
}
const unhtml = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const titleCase = s => String(s || '').toLowerCase().replace(/\b([a-z])/g, m => m.toUpperCase()).replace(/\bC\.i\.c\.?/i, 'C.I.C.').replace(/\b(Cic|Cio|Ltd|Uk)\b/g, m => m.toUpperCase());
const POSTCODE = /\b([A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2})\b/i;

function chFacts(c) {
  const num = c.number, addr = c.address || '';
  const facts = { legal_name: c.name, company_number: num, address: addr, postcode: (addr.match(POSTCODE) || [])[1] || '' };
  Object.keys(facts).forEach(k => { if (!facts[k]) delete facts[k]; });
  return { id: 'GB-COH-' + num, name: c.name, facts, registered: c.created || '', active: !/dissolved|liquidation|removed/i.test(c.status || ''),
    summary: ['Company ' + num, c.type || '', facts.postcode, c.status, c.created ? 'since ' + c.created : ''].filter(Boolean).join(' · ') };
}
async function chDetails(number) {
  const num = String(number || '').toUpperCase().replace(/\s+/g, '');
  if (!/^([A-Z]{2}\d{6}|\d{8})$/.test(num)) return null;
  const j = await chApi('/company/' + num);
  if (j && j.company_name) {
    const a = j.registered_office_address || {};
    return chFacts({ number: num, name: titleCase(j.company_name), status: j.company_status, created: j.date_of_creation,
      type: /community-interest/i.test(j.subtype || '') ? 'Community interest company' : String(j.type || '').replace(/-/g, ' '),
      address: [a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code].filter(Boolean).join(', ') });
  }
  const h = await chPage('/company/' + num);
  if (!h) return null;
  const name = unhtml((h.match(/id="company-name"[^>]*>([\s\S]*?)<\//) || [])[1]);
  if (!name) return null;
  const dd = label => unhtml((h.match(new RegExp(label + '\\s*</dt>\\s*<dd[^>]*>([\\s\\S]*?)</dd>', 'i')) || [])[1]);
  return chFacts({ number: num, name: titleCase(name), address: dd('Registered office address'),
    status: unhtml((h.match(/id="company-status"[^>]*>([\s\S]*?)<\//) || [])[1]) || dd('Company status'),
    type: unhtml((h.match(/id="company-type"[^>]*>([\s\S]*?)<\//) || [])[1]) || dd('Company type'),
    created: unhtml((h.match(/id="company-creation-date"[^>]*>([\s\S]*?)<\//) || [])[1]) || dd('Incorporated on') });
}
async function chSearch(name) {
  const q = encodeURIComponent(String(name || '').slice(0, 120));
  const j = await chApi('/search/companies?items_per_page=5&q=' + q);
  if (j && Array.isArray(j.items)) return j.items.filter(x => x.company_number).map(x => ({ id: 'GB-COH-' + x.company_number, name: titleCase(x.title || ''), score: 50, match: simple(x.title) === simple(name) }));
  const h = await chPage('/search/companies?q=' + q);
  if (!h) return [];
  const out = [], re = /href="\/company\/([A-Z0-9]{8})"[^>]*>([\s\S]*?)<\/a>/g; let m;
  while ((m = re.exec(h)) && out.length < 5) { const nm = unhtml(m[2]); if (nm && !out.some(o => o.id === 'GB-COH-' + m[1])) out.push({ id: 'GB-COH-' + m[1], name: titleCase(nm), score: 50, match: simple(nm) === simple(name) }); }
  return out;
}

// Best guess for a name: confident only when the register's name is the same name
async function confident(name) {
  const c = await candidates(name);
  const best = c.find(x => simple(x.name) === simple(name)) || c.find(x => x.match && x.score >= 90);
  return best ? details(best.id) : null;
}

module.exports = { candidates, details, confident, idFromNumber, simple };
