// js/circular.js — Circular economy page, passports, reports, importer
// ─────────────────────────────────────────────────────────────
// Split out of render.js. Quick log (photo / just tell it / tally),
// stock board, item passport + chain of custody, custody report,
// QR labels, scan & search, collections, importer, bulk sort, and
// the figures every report uses (cxReportStats).
// Depends on: utils.js, db.js, render.js (statCard, renderEmpty),
//   settings.js (vAI, circMode, CIRC_*, _circSlug)
'use strict';

// ─────────────────────────────────────────────────────────────
// CIRCULAR ECONOMY — v2
// Activities come from Settings → Circular activities
// (table circular_activities). Items carry a passport code, move
// through stages, and every move is written to circular_item_events
// (append-only, hash-linked in the database = chain of custody).
//
// Covers: stock board, log item (with AI photo intake), item
// passport + history, QR labels, scan-to-advance, collections
// (bookings → run sheet → collected → booked in), growing/food
// (kg shared, meals equivalent), impact strip.
// ─────────────────────────────────────────────────────────────

const CX = { acts: [], items: [], cols: [], tab: 'all', colFilter: 'open', ready: false, err: '', pendingCode: null };
// ─────────────────────────────────────────────────────────────
// DEMO-AWARE DATA ACCESS for the circular tables
// cxFrom() looks like sb.from() but, in demo mode, blends in sample
// activities, items, collections and custody history. Anything aimed
// at a demo row (id "demo-…", or a demo activity) is done in memory
// and never sent to Supabase. Real rows always go to the server.
// ─────────────────────────────────────────────────────────────
const CXD = { seeded: false, acts: [], items: [], cols: [], events: [], n: 0 };
const CXD_TABLE = { circular_activities: 'acts', circular_items: 'items', circular_collections: 'cols', circular_item_events: 'events' };
function cxDemoClear() { Object.assign(CXD, { seeded: false, acts: [], items: [], cols: [], events: [], n: 0 }); }
function _cxdIsDemo(v) { return String(v == null ? '' : v).indexOf('demo-') === 0; }
function _cxdField(row, k) {
  const m = /^(\w+)->>(\w+)$/.exec(k);
  if (m) { const o = row[m[1]] || {}; return o[m[2]] == null ? null : String(o[m[2]]); }
  return row[k];
}
function _cxdMatch(row, filters) {
  return filters.every(f => f[0] === 'eq' ? String(_cxdField(row, f[1])) === String(f[2]) : (f[2] || []).map(String).includes(String(_cxdField(row, f[1]))));
}
// Simple, stable fingerprint so demo histories show as linked
function _cxdHash(s) {
  let h1 = 0x811c9dc5, h2 = 0x1234567;
  for (let i = 0; i < s.length; i++) { h1 = Math.imul(h1 ^ s.charCodeAt(i), 16777619); h2 = Math.imul(h2 ^ s.charCodeAt(i), 2246822519); }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).repeat(4);
}
function _cxdCode() { return 'D' + (++CXD.n).toString(36).toUpperCase().padStart(3, '0') + Math.random().toString(36).slice(2, 6).toUpperCase(); }
function _cxdInsertLocal(table, row) {
  const key = CXD_TABLE[table];
  const now = new Date().toISOString();
  const r = Object.assign({}, row);
  if (table === 'circular_item_events') {
    const prev = CXD.events.filter(e => e.item_id === String(r.item_id)).slice(-1)[0];
    r.id = CXD.events.length + 1; r.occurred_at = r.occurred_at || now; r.prev_hash = prev ? prev.hash : 'GENESIS';
    r.hash = _cxdHash(r.prev_hash + '|' + r.item_id + '|' + r.action + '|' + (r.to_stage || '') + '|' + r.occurred_at);
  } else {
    r.id = r.id || 'demo-' + (table === 'circular_items' ? 'i' : table === 'circular_collections' ? 'col' : 'a') + '-' + Date.now().toString(36) + (++CXD.n);
    r._demo = true;
    if (table === 'circular_items') { r.passport_code = r.passport_code || _cxdCode(); r.custom = r.custom || {}; r.photos = r.photos || []; r.quantity = r.quantity || 1; }
    if (table === 'circular_collections') r.booking_ref = r.booking_ref || _cxdCode();
    r.created_at = r.created_at || now; r.updated_at = r.updated_at || now;
  }
  CXD[key].push(r);
  return r;
}

function cxFrom(table) {
  const o = { table, action: 'select', payload: null, sel: null, wantRows: false, filters: [], order: null, limit: null, single: false };
  const b = {
    select(s) { if (o.action === 'select') o.sel = s || '*'; else o.wantRows = true; return b; },
    insert(p) { o.action = 'insert'; o.payload = Array.isArray(p) ? p : [p]; return b; },
    update(p) { o.action = 'update'; o.payload = p; return b; },
    delete() { o.action = 'delete'; return b; },
    eq(k, v) { o.filters.push(['eq', k, v]); return b; },
    in(k, v) { o.filters.push(['in', k, v]); return b; },
    order(k, opt) { o.order = [k, opt]; return b; },
    limit(n) { o.limit = n; return b; },
    single() { o.single = true; return b; },
    then(res, rej) { return _cxdRun(o).then(res, rej); }
  };
  return b;
}

function _cxdReal(o, overrideFilters, overridePayload) {
  let q = sb.from(o.table);
  const f = overrideFilters || o.filters;
  if (o.action === 'select') q = q.select(o.sel || '*');
  else if (o.action === 'insert') q = q.insert(overridePayload || o.payload);
  else if (o.action === 'update') q = q.update(o.payload);
  else if (o.action === 'delete') q = q.delete();
  f.forEach(x => { q = x[0] === 'eq' ? q.eq(x[1], x[2]) : q.in(x[1], x[2]); });
  if (o.action !== 'select' && o.wantRows) q = q.select();
  if (o.order) q = q.order(o.order[0], o.order[1]);
  if (o.limit) q = q.limit(o.limit);
  if (o.single) q = q.single();
  return q;
}

async function _cxdRun(o) {
  const demoOn = typeof _demoMode !== 'undefined' && _demoMode;
  if (demoOn && !CXD.seeded) cxDemoSeed();
  const key = CXD_TABLE[o.table];
  const idF = o.filters.find(f => f[1] === 'id' || f[1] === 'item_id');
  const ids = idF ? (idF[0] === 'eq' ? [idF[2]] : (idF[2] || [])) : null;
  const demoIds = ids ? ids.filter(_cxdIsDemo) : [];
  const realIds = ids ? ids.filter(v => !_cxdIsDemo(v)) : null;
  const local = () => key && demoOn ? CXD[key].filter(r => _cxdMatch(r, o.filters.filter(f => !(f[1] === 'org_id')))) : [];

  if (o.action === 'insert') {
    const demoRows = o.payload.filter(r => _cxdIsDemo(r.activity_id) || _cxdIsDemo(r.item_id) || r._demo);
    const realRows = o.payload.filter(r => !demoRows.includes(r));
    let data = [], error = null;
    if (realRows.length) { const res = await _cxdReal(Object.assign({}, o, { single: false }), null, realRows); error = res.error; data = res.data || []; }
    const made = demoRows.map(r => _cxdInsertLocal(o.table, r));
    data = data.concat(made);
    return { data: o.single ? (data[0] || null) : data, error };
  }

  if (o.action === 'update' || o.action === 'delete') {
    let error = null;
    // demo rows: in memory
    const hit = local();
    if (o.action === 'update') hit.forEach(r => Object.assign(r, o.payload));
    else if (hit.length) CXD[key] = CXD[key].filter(r => !hit.includes(r));
    // real rows: to the server (skip when every targeted id is a demo one)
    if (!ids || realIds.length) {
      const f = ids ? o.filters.map(x => x === idF ? (idF[0] === 'eq' ? x : ['in', idF[1], realIds]) : x) : o.filters;
      const res = await _cxdReal(o, f); error = res.error;
    }
    return { data: null, error };
  }

  // select
  let data = [], error = null;
  if (!ids || realIds.length) {
    const f = ids ? o.filters.map(x => x === idF ? (idF[0] === 'eq' ? x : ['in', idF[1], realIds]) : x) : o.filters;
    const res = await _cxdReal(Object.assign({}, o, { single: false }), f);
    error = res.error; data = res.data || [];
  }
  if (!error || demoOn) {
    const add = local();
    if (add.length) {
      data = data.concat(add);
      if (o.order) { const [k, opt] = o.order; const asc = !opt || opt.ascending !== false; data.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * (asc ? 1 : -1)); }
      if (error && add.length) error = null;
    }
  }
  return { data: o.single ? (data[0] || null) : data, error };
}

// ── The circular sample: one organisation doing five activities ─
function cxDemoSeed() {
  cxDemoClear(); CXD.seeded = true;
  if (typeof CIRC_TEMPLATES === 'undefined') return;
  let seed = 4242;
  const R = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = a => a[Math.floor(R() * a.length)];
  const int = (a, b) => a + Math.floor(R() * (b - a + 1));
  const ago = d => new Date(Date.now() - d * 864e5 - int(1, 8) * 36e5).toISOString();
  const tpl = k => JSON.parse(JSON.stringify(CIRC_TEMPLATES.find(t => t.key === k)));
  const mk = (k, id, extra) => { const t = tpl(k); return Object.assign({ id, _demo: true, org_id: orgId, key: 'demo_' + k, template: k, name: t.name + ' (DEMO)', icon: t.icon, description: t.desc, stages: t.stages, outcomes: t.outcomes, item_types: t.item_types, fields: t.fields, links: t.links, active: true, contract_ids: [] }, extra || {}); };
  const dev = mk('device_reuse', 'demo-a-dev', { sort: 1, contract_ids: ['demo-c-2'] });
  const rep = mk('repair_cafe', 'demo-a-rep', { sort: 2, contract_ids: ['demo-c-2'] });
  const gro = mk('growing', 'demo-a-gro', { sort: 3, contract_ids: ['demo-c-3'] });
  const tex = mk('textiles', 'demo-a-tex', { sort: 4 });
  const col = mk('collections', 'demo-a-col', { sort: 0, links: [{ on: 'end', to: 'demo_device_reuse' }] });
  CXD.acts = [col, dev, rep, gro, tex];

  const people = ['Sarah T.', 'Dev Patel', 'Sam Okoro', 'Hannah Green', 'Kofi Boateng'];
  const evs = (typeof DB !== 'undefined' && DB.events || []).filter(e => e._demo);
  const evOf = rx => evs.filter(e => rx.test(e.name));
  const repairEvs = evOf(/Repair/), harvestEvs = evOf(/Harvest/), swapEvs = evOf(/Swap/);
  const logEv = (item, action, from, to, at, data, who) => {
    const prev = CXD.events.filter(e => e.item_id === String(item.id)).slice(-1)[0];
    const r = { id: CXD.events.length + 1, org_id: orgId, item_id: String(item.id), activity_id: item.activity_id, action, from_stage: from || null, to_stage: to || null, data: data || {}, actor_name: who || pick(people), occurred_at: at, prev_hash: prev ? prev.hash : 'GENESIS' };
    r.hash = _cxdHash(r.prev_hash + '|' + r.item_id + '|' + action + '|' + (to || '') + '|' + at);
    CXD.events.push(r);
  };
  const item = (act, t, x) => {
    const f = cxCalc(act, t.key, x.quantity || 1, x.weight_kg);
    const r = Object.assign({ id: 'demo-i-' + (CXD.items.length + 1), _demo: true, org_id: orgId, activity_id: act.id, item_type: t.key, name: cxLbl(t), category: act.name,
      quantity: 1, co2e_kg: f.co2, value_gbp: f.value, custom: {}, photos: [], passport_code: 'DEMO' + String(CXD.items.length + 1).padStart(3, '0') }, x);
    CXD.items.push(r); return r;
  };

  // Collections → device reuse
  const donors = [['business', 'Northgate Accountants (DEMO)', 'Robert Lane'], ['council', 'Riverside Council (DEMO)', 'Helen Price'], ['household', '', 'Mrs J. Wood'], ['business', 'Brightwave Media (DEMO)', 'Ali Shah'], ['household', '', 'Mr P. Ng'], ['site', 'Riverside Recycling Centre (DEMO)', 'Site team']];
  const colStatus = ['booked_in', 'booked_in', 'booked_in', 'collected', 'scheduled', 'requested'];
  donors.forEach((d, i) => CXD.cols.push({ id: 'demo-col-' + (i + 1), _demo: true, org_id: orgId, activity_id: col.id, booking_ref: 'DEMO-B' + (i + 1), donor_type: d[0], donor_org: d[1] || null, donor_name: d[2], donor_email: null, donor_phone: '07700 900' + (200 + i),
    address: pick(['12 Mill Lane', 'Unit 4, Fengate', '3 Park Road', '88 Lincoln Road', 'Station Yard']), postcode: pick(['PE1 5QT', 'PE2 8LN', 'PE3 6DB']), items_summary: pick(['8 laptops, 2 monitors', 'Box of phones and tablets', '1 desktop PC', '5 laptops', 'Mixed small electricals']),
    photos: [], requested_date: _dIso(60 - i * 9), scheduled_date: colStatus[i] === 'requested' ? null : _dIso(55 - i * 9 - (colStatus[i] === 'scheduled' ? 60 : 0)), status: colStatus[i],
    collected_by: ['booked_in', 'collected'].includes(colStatus[i]) ? 'Tariq Ali' : null, collected_at: ['booked_in', 'collected'].includes(colStatus[i]) ? ago(55 - i * 9) : null, notes: i === 0 ? 'Loading bay at rear.' : null, created_at: ago(62 - i * 9) }));

  const brands = [['Dell', 'Latitude 5490'], ['Lenovo', 'ThinkPad T480'], ['HP', 'EliteBook 840 G5'], ['Apple', 'MacBook Air 2017'], ['Dell', 'OptiPlex 7060'], ['Samsung', 'Galaxy Tab A'], ['Apple', 'iPhone 8']];
  const partPeople = (typeof DB !== 'undefined' && DB.participants || []).filter(p => p._demo);
  const S = dev.stages.map(s => s.key);
  for (let i = 0; i < 26; i++) {
    const t = pick(dev.item_types.slice(0, 6));
    const b = t.key === 'tablet' ? ['Samsung', 'Galaxy Tab A'] : t.key === 'smartphone' ? ['Apple', 'iPhone 8'] : t.key === 'desktop_pc' ? ['Dell', 'OptiPlex 7060'] : t.key === 'monitor' ? ['Iiyama', 'ProLite 24"'] : t.key === 'printer' ? ['Brother', 'HL-L2350'] : pick(brands.slice(0, 4));
    const start = int(8, 170);
    const colId = i < 18 ? 'demo-col-' + (1 + (i % 3)) : null;
    const colRow = colId && CXD.cols.find(c => c.id === colId);
    const it = item(dev, t, { brand: b[0], model: b[1], serial: b[0].slice(0, 2).toUpperCase() + String(100000 + int(0, 899999)), source: colRow ? (colRow.donor_org || colRow.donor_name) + ' · ' + colRow.booking_ref : pick(['Walk-in donation', 'Riverside Recycling Centre (DEMO)']),
      collection_id: colId, weight_kg: t.weight_kg, created_at: ago(start), event_id: null });
    logEv(it, colId ? 'booked_in' : 'logged', null, S[0], ago(start));
    const reach = i < 16 ? S.length : int(1, S.length - 1);   // 16 fully processed, the rest part-way
    let at = start;
    for (let k = 1; k < reach; k++) {
      at = Math.max(1, at - int(1, 6));
      const data = {};
      if (S[k] === 'data_wiped') { const m = pick(['nwipe (DoD short)', 'Blancco', 'nwipe (PRNG)']); const c = 'WC-' + int(10000, 99999); it.custom.wipe_method = m; if (i !== 7) it.custom.wipe_certificate_ref = c; data.fields = i !== 7 ? { wipe_method: m, wipe_certificate_ref: c } : { wipe_method: m }; }
      if (S[k] === 'tested') { it.custom.pat_result = i !== 11; data.fields = { pat_result: i !== 11 }; }
      logEv(it, 'moved', S[k - 1], S[k], ago(at), data);
    }
    if (i < 16) {
      at = Math.max(0, at - int(1, 10));
      const o = i < 9 ? dev.outcomes.find(x => x.key === 'donated') : i < 13 ? dev.outcomes.find(x => x.key === 'resold') : i < 15 ? dev.outcomes.find(x => x.key === 'parts_harvested') : dev.outcomes.find(x => x.key === 'recycled');
      const data = {};
      it.outcome = o.key; it.outcome_type = o.type; it.outcome_at = ago(at); it.status = o.label; it.stage = S[S.length - 1];
      if (o.key === 'donated') {
        if (i % 3 !== 2 && partPeople.length) { const p = partPeople[i % partPeople.length]; it.recipient_participant_id = p.id; data.recipient = p.first_name + ' ' + p.last_name; data.recipient_kind = 'person'; }
        else { it.custom.recipient_org = pick(['Hope Food Bank (DEMO)', 'St Mark\'s School (DEMO)']); data.recipient = it.custom.recipient_org; data.recipient_kind = 'org'; }
      }
      if (o.key === 'resold') { it.custom.sale_gbp = pick([65, 85, 95, 120, 140]); it.custom.sale_channel = pick(['eBay', 'Shop', 'Marketplace']); data.sale_gbp = it.custom.sale_gbp; data.sale_channel = it.custom.sale_channel; }
      logEv(it, 'finished', it.stage, o.key, it.outcome_at, data);
      it.updated_at = it.outcome_at;
    } else { it.stage = S[reach - 1]; it.status = dev.stages[reach - 1].label; it.updated_at = ago(Math.max(0, at)); }
  }

  // Repair café: tallies at each repair session
  const repEvs = repairEvs.length ? repairEvs : [null];
  repEvs.forEach(ev => {
    const n = int(9, 16);
    for (let k = 0; k < n; k++) {
      const t = pick(rep.item_types);
      const o = R() < 0.68 ? rep.outcomes[0] : R() < 0.5 ? rep.outcomes[1] : rep.outcomes[2];
      const at = ev ? ev.date + 'T1' + int(0, 5) + ':' + String(int(10, 59)) + ':00Z' : ago(int(1, 90));
      const it = item(rep, t, { weight_kg: t.weight_kg, event_id: ev ? ev.id : null, outcome: o.key, outcome_type: o.type, outcome_at: at, status: o.label, created_at: at, updated_at: at });
      logEv(it, 'tallied', null, o.key, at, {}, 'Sam Okoro');
    }
  });

  // Growing: harvests through the season
  const crops = gro.item_types;
  for (let k = 0; k < 34; k++) {
    const t = pick(crops); const kg = +(R() * (t.key === 'potatoes' ? 14 : 7) + 0.8).toFixed(1);
    const o = R() < 0.55 ? gro.outcomes[0] : R() < 0.7 ? gro.outcomes[1] : R() < 0.8 ? gro.outcomes[2] : gro.outcomes[3];
    const hv = harvestEvs.length && R() < 0.4 ? pick(harvestEvs) : null;
    const at = hv ? hv.date + 'T11:30:00Z' : ago(int(0, 150));
    const it = item(gro, t, { weight_kg: kg, event_id: hv ? hv.id : null, outcome: o.key, outcome_type: o.type, outcome_at: at, status: o.label, created_at: at, updated_at: at,
      custom: k % 9 === 4 ? { weight_estimated: true, estimate_basis: 'crate of produce from photo' } : {} });
    logEv(it, 'tallied', null, o.key, at, {}, pick(['Hannah Green', 'Joan Fletcher']));
  }
  // Two harvests still to sort (shows the "Sort them" tool)
  for (let k = 0; k < 2; k++) { const t = pick(crops); const at = ago(k + 1); const it = item(gro, t, { weight_kg: +(R() * 5 + 1).toFixed(1), created_at: at, updated_at: at, status: '' }); logEv(it, 'tallied', null, null, at, {}); }

  // Textiles: swap shops
  (swapEvs.length ? swapEvs : [null, null, null]).forEach(ev => {
    for (let k = 0; k < int(3, 5); k++) {
      const t = pick(tex.item_types); const kg = t.unit === 'kg' ? +(R() * 12 + 2).toFixed(1) : undefined;
      const o = pick(tex.outcomes);
      const at = ev ? ev.date + 'T14:00:00Z' : ago(int(5, 120));
      const it = item(tex, t, { weight_kg: kg != null ? kg : t.weight_kg * 3, quantity: kg != null ? 1 : 3, event_id: ev ? ev.id : null, outcome: o.key, outcome_type: o.type, outcome_at: at, status: o.label, created_at: at, updated_at: at });
      logEv(it, 'tallied', null, o.key, at, {});
    }
  });
}

const CX_KG_PER_MEAL = 0.42;              // WRAP standard meal equivalent
const CX_IMPACT_CO2 = ['reuse', 'repair', 'share'];
const CX_IMPACT_KG  = ['reuse', 'repair', 'share', 'recycle'];

function cxE(s) { return escapeHTML(s == null ? '' : String(s)); }
function cxFmt(n, dp) { return (+n || 0).toLocaleString('en-GB', { maximumFractionDigits: dp == null ? 0 : dp, minimumFractionDigits: 0 }); }
function cxAct(id) { return CX.acts.find(a => a.id === id); }
function cxColAct() { return CX.acts.find(a => a.template === 'collections'); }
function cxItemActs() { return CX.acts.filter(a => a.template !== 'collections'); }
function cxType(act, key) { return act && (act.item_types || []).find(t => t.key === key); }
function cxPerKg(t) { return !!t && (t.unit === 'kg' || (t.unit !== 'each' && /per\s*kg/i.test(t.label || ''))); }
function cxStage(act, key) { return act && (act.stages || []).find(s => s.key === key); }
function cxOutcome(act, key) { return act && (act.outcomes || []).find(o => o.key === key); }
function cxDays(d) { return d ? Math.floor((Date.now() - new Date(d).getTime()) / 86400000) : 0; }
function cxItemUrl(code) { return location.origin + '/app.html#item=' + encodeURIComponent(code); }
function cxActorName() {
  try { return (currentUser && (currentUser.user_metadata && currentUser.user_metadata.full_name || currentUser.email)) || ''; }
  catch (e) { return ''; }
}

function cxInjectStyle() {
  if (document.getElementById('cxp-style')) return;
  const st = document.createElement('style'); st.id = 'cxp-style';
  st.textContent = `
.cxp-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.cxp-tab{background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:6px 14px;font-size:13px;font-weight:600;color:var(--txt2)}
.cxp-tab.on{background:var(--em);border-color:var(--em);color:#fff}
.cxp-board{display:flex;gap:12px;overflow-x:auto;padding-bottom:8px;margin-bottom:20px}
.cxp-col{min-width:220px;flex:1;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:10px}
.cxp-col-h{font-size:12px;font-weight:700;color:var(--txt2);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px;display:flex;justify-content:space-between}
.cxp-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:9px 10px;margin-bottom:7px;cursor:pointer}
.cxp-card:hover{border-color:var(--em)}
.cxp-card.stuck{border-left:3px solid var(--amber);border-radius:0 8px 8px 0}
.cxp-t{font-size:13px;font-weight:600;color:var(--txt)}
.cxp-s{font-size:11px;color:var(--txt3)}
.cxp-code{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--em);background:rgba(31,111,109,.07);padding:1px 6px;border-radius:4px}
.cxp-sum{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;margin-bottom:20px}
.cxp-chip{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border);color:var(--txt2);margin:2px 4px 2px 0}
.cxp-btns{display:flex;flex-wrap:wrap;gap:6px}
.cxp-tl{border-left:2px solid var(--border);margin-left:6px;padding-left:14px}
.cxp-ev{position:relative;padding-bottom:12px}
.cxp-ev:before{content:'';position:absolute;left:-20px;top:5px;width:10px;height:10px;border-radius:50%;background:var(--em)}
.cxp-list-row{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border)}
.cxp-warn{background:#FFFBEB;border:1px solid #FDE68A;color:#92400E;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px}
.cxp-err{background:#FEF2F2;border:1px solid #FECACA;color:#B91C1C;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px}
@media(max-width:700px){.cxp-col{min-width:180px}}
@media(max-width:640px){
  .cxp-head{flex-direction:column;align-items:stretch;gap:10px}
  .cxp-head .page-sub{display:none}
  .cxp-head .cxp-btns{flex-wrap:wrap;gap:6px}
  .cxp-head .cxs-wrap{flex:1 1 100%;max-width:none;order:-1}
  .cxp-bt{display:none}
  .cxp-head .btn-p{margin-left:auto}
  .cxp-tabs{flex-wrap:nowrap;overflow-x:auto;margin-left:-4px;margin-right:-4px;padding:0 4px 4px;scrollbar-width:none}
  .cxp-tabs::-webkit-scrollbar{display:none}
  .cxp-tab{white-space:nowrap;flex-shrink:0}
  #page-circular .cxp-stats{gap:8px;margin-bottom:14px}
  #page-circular .cxp-stats .stat-card{padding:10px 12px}
  #page-circular .cxp-stats .stat-val{font-size:18px}
  #page-circular .cxp-stats .stat-lbl{font-size:10px}
  #page-circular .card{padding:14px}
  .cxp-list-row{flex-wrap:wrap}
}`;
  document.head.appendChild(st);
}

// Single reusable modal
function cxModal(html, maxW) {
  let m = $('cx-modal');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal-overlay'; m.id = 'cx-modal';
    m.addEventListener('click', e => { if (e.target === m) cxCloseModal(); });
    document.body.appendChild(m);
  }
  m.innerHTML = '<div class="modal" style="max-width:' + (maxW || 560) + 'px">' + html + '</div>';
  m.classList.add('open');
}
function cxCloseModal() { cxStopScan(); const m = $('cx-modal'); if (m) m.classList.remove('open'); }

// ── Data ─────────────────────────────────────────────────────
async function cxLoad() {
  CX.err = '';
  const a = await cxFrom('circular_activities').select('*').eq('org_id', orgId).eq('active', true).order('sort');
  if (a.error) { CX.err = 'Circular needs the database update. Run circular-migration.sql in Supabase, then refresh.'; CX.acts = []; CX.items = []; CX.cols = []; CX.ready = true; return; }
  CX.acts = a.data || [];
  const [it, co] = await Promise.all([
    cxFrom('circular_items').select('*').eq('org_id', orgId).order('updated_at', { ascending: false }).limit(3000),
    cxFrom('circular_collections').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(1000)
  ]);
  CX.items = it.error ? [] : (it.data || []);
  CX.cols = co.error ? [] : (co.data || []);
  if (it.error) CX.err = 'Could not load items: ' + it.error.message;
  CX.ready = true;
}

async function cxLog(item, action, from, to, data) {
  const { error } = await cxFrom('circular_item_events').insert([{
    org_id: orgId, item_id: String(item.id), activity_id: item.activity_id || null,
    action, from_stage: from || null, to_stage: to || null, data: data || {}, actor_name: cxActorName()
  }]);
  if (error) console.error('[circular] custody log failed', error);
}

// ── Impact ───────────────────────────────────────────────────
function cxImpact(items) {
  const r = { inProgress: 0, finished: 0, kg: 0, co2: 0, value: 0, reused: 0, foodKg: 0, income: 0, repairTried: 0, repairFixed: 0 };
  items.forEach(i => {
    if (!i.outcome_type) { r.inProgress++; return; }
    r.finished++;
    const t = i.outcome_type;
    if (CX_IMPACT_KG.includes(t)) r.kg += +i.weight_kg || 0;
    if (CX_IMPACT_CO2.includes(t)) { r.co2 += +i.co2e_kg || 0; r.value += +i.value_gbp || 0; }
    if (t === 'reuse' || t === 'repair') r.reused += +i.quantity || 1;
    if (t === 'share') r.foodKg += +i.weight_kg || 0;
    if (i.custom && +i.custom.sale_gbp) r.income += +i.custom.sale_gbp;
    const act = cxAct(i.activity_id);
    if (act && act.template === 'repair_cafe') { r.repairTried += +i.quantity || 1; if (t === 'repair') r.repairFixed += +i.quantity || 1; }
  });
  return r;
}

// ── Page ─────────────────────────────────────────────────────
function cxPage() {
  let p = $('page-circular');
  if (!p) {
    p = document.createElement('div'); p.className = 'page'; p.id = 'page-circular';
    const main = $('main'); if (main) main.appendChild(p);
  }
  return p;
}

async function renderCircular() {
  cxInjectStyle();
  const p = cxPage();
  p.innerHTML = '<div class="page-header"><div><div class="page-title">♻️ Circular</div><div class="page-sub">Loading…</div></div></div>';
  await cxLoad();
  cxDraw();
  if (CX.pendingCode) { const c = CX.pendingCode; CX.pendingCode = null; cxOpenByCode(c); }
}

function cxDraw() {
  cxInjectPassStyle();
  const p = cxPage();
  const colAct = cxColAct();
  const acts = cxItemActs();
  if (CX.tab !== 'all' && CX.tab !== 'collections' && !cxAct(CX.tab)) CX.tab = 'all';
  if (CX.tab === 'collections' && !colAct) CX.tab = 'all';

  let h = '<div class="page-header cxp-head"><div><div class="page-title">♻️ Circular</div>' +
    '<div class="page-sub">Every item has a passport. Every move is logged.</div></div>' +
    '<div class="cxp-btns" style="align-items:center">' +
      '<div class="cxs-wrap"><input id="cxs-q" placeholder="🔍 Search ID, serial, name…" autocomplete="off" onkeyup="cxSearchInput(event)" onblur="setTimeout(()=>{const b=$(\'cxs-res\');if(b)b.innerHTML=\'\'},150)"/><div id="cxs-res" class="cxs-res"></div></div>' +
      '<button class="btn btn-ghost btn-sm" title="Set up" onclick="_setSection=\'circular\';go(\'settings\')">⚙️<span class="cxp-bt"> Set up</span></button>' +
      '<button class="btn btn-ghost btn-sm" title="Custody report" onclick="cxCustodyOpen()">📄<span class="cxp-bt"> Custody report</span></button>' +
      '<button class="btn btn-ghost btn-sm" title="Import" onclick="cxImportOpen()">⬆<span class="cxp-bt"> Import</span></button>' +
      '<button class="btn btn-ghost btn-sm" title="Scan" onclick="cxOpenScan()">📷<span class="cxp-bt"> Scan</span></button>' +
      (colAct ? '<button class="btn btn-ghost btn-sm" title="New booking" onclick="cxOpenBooking()">🚚<span class="cxp-bt"> New booking</span></button>' : '') +
      '<button class="btn btn-p btn-sm" onclick="cxOpenLog({})">+ Log item</button>' +
    '</div></div>';

  if (CX.err) h += '<div class="cxp-err">' + cxE(CX.err) + '</div>';
  if (!CX.err && !CX.acts.length) {
    h += '<div class="card">' + renderEmpty('No circular activities yet.') +
      '<div style="text-align:center"><button class="btn btn-p btn-sm" onclick="go(\'settings\')">Set up in Settings</button></div></div>';
    p.innerHTML = h; return;
  }

  h += '<div class="cxp-tabs"><button class="cxp-tab ' + (CX.tab === 'all' ? 'on' : '') + '" onclick="cxTab(\'all\')">All</button>' +
    acts.map(a => '<button class="cxp-tab ' + (CX.tab === a.id ? 'on' : '') + '" onclick="cxTab(\'' + a.id + '\')">' + cxE(a.icon) + ' ' + cxE(a.name) + '</button>').join('') +
    (colAct ? '<button class="cxp-tab ' + (CX.tab === 'collections' ? 'on' : '') + '" onclick="cxTab(\'collections\')">' + cxE(colAct.icon) + ' ' + cxE(colAct.name) + '</button>' : '') +
    '</div>';

  if (CX.tab === 'collections') { h += cxCollectionsHTML(); p.innerHTML = h; return; }

  const scope = CX.tab === 'all' ? CX.items.filter(i => i.activity_id) : CX.items.filter(i => i.activity_id === CX.tab);
  const im = cxImpact(scope);
  const act = CX.tab === 'all' ? null : cxAct(CX.tab);
  const food = !!act && ['food', 'growing'].includes(act.template);

  let stats = '<div class="stats-grid cxp-stats">' +
    statCard('In progress', cxFmt(im.inProgress)) +
    statCard('Diverted from waste', cxFmt(im.kg, 1) + ' kg') +
    (food
      ? statCard('Food shared', cxFmt(im.foodKg, 1) + ' kg', '≈ ' + cxFmt(im.foodKg / CX_KG_PER_MEAL) + ' meals')
      : statCard('CO₂e avoided', cxFmt(im.co2 / 1000, 2) + ' t', 'reuse and repair')) +
    (act && act.template === 'repair_cafe'
      ? statCard('Fix rate', im.repairTried ? Math.round(im.repairFixed / im.repairTried * 100) + '%' : '—', cxFmt(im.repairFixed) + ' of ' + cxFmt(im.repairTried) + ' fixed')
      : statCard('Value to people', '£' + cxFmt(im.value), im.income ? '£' + cxFmt(im.income) + ' sales income' : cxFmt(im.reused) + ' items reused')) +
    '</div>';

  const backlog = CX.tab !== 'all' ? CX.items.filter(i => i.activity_id === CX.tab && !i.outcome_type).length : 0;
  const wasTracked = act && circMode(act) === 'tracked';
  const bulkBtn = backlog > 8 ? '<div class="cxp-warn" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">' +
    '<span>' + backlog + ' entries aren\'t counted in your figures yet' + (wasTracked ? ' — this activity has been tracking every item one by one' : '') + '.</span>' +
    '<button class="btn btn-p btn-sm" onclick="' + (wasTracked ? 'cxFixActivity(\'' + CX.tab + '\')' : 'cxTidyOpen(\'' + CX.tab + '\')') + '">' + (wasTracked ? 'Fix this for me' : 'Sort them in bulk') + '</button></div>' : '';
  h += CX.tab === 'all' ? stats + cxSummaryHTML(acts) : cxQuickHTML(act) + bulkBtn + stats + (circMode(act) === 'tally' ? cxRecentHTML(act) : cxBoardHTML(act));
  p.innerHTML = h;
}

function cxTab(t) { CX.tab = t; cxDraw(); }

function cxSummaryHTML(acts) {
  if (!acts.length) return '<div class="card">' + renderEmpty('Only Collections is set up. Add an activity for booked-in items in Settings.') + '</div>';
  const old = CX.items.filter(i => !i.activity_id).length;
  return '<div class="cxp-sum">' + acts.map(a => {
    const its = CX.items.filter(i => i.activity_id === a.id);
    const live = its.filter(i => !i.outcome_type);
    const stuck = live.filter(i => cxDays(i.updated_at) > 14).length;
    const im = cxImpact(its);
    return '<div class="card" style="cursor:pointer;margin:0" onclick="cxTab(\'' + a.id + '\')">' +
      '<div class="card-title">' + cxE(a.icon) + ' ' + cxE(a.name) + '</div>' +
      (circMode(a) === 'tally'
        ? '<div style="margin:6px 0 8px">' + (live.length ? '<span class="cxp-chip" style="color:var(--amber);border-color:var(--amber)">' + live.length + ' to sort</span>' : '') + '<span class="cxp-chip">' + its.filter(cxIsToday).length + ' today</span><span class="cxp-chip">' + cxFmt(its.filter(i => i.created_at && new Date(i.created_at).getMonth() === new Date().getMonth() && new Date(i.created_at).getFullYear() === new Date().getFullYear()).reduce((x, i) => x + (+i.weight_kg || 0), 0), 1) + ' kg this month</span></div>'
        : '<div style="margin:6px 0 8px">' + (a.stages || []).map(s =>
        '<span class="cxp-chip">' + cxE(s.label) + ' · ' + live.filter(i => i.stage === s.key).length + '</span>').join('') + '</div>') +
      '<div class="cxp-s">' + cxFmt(im.finished) + ' finished · ' + cxFmt(im.kg, 1) + ' kg diverted' +
      (stuck ? ' · <span style="color:var(--amber);font-weight:700">' + stuck + ' waiting over 14 days</span>' : '') + '</div>' +
    '</div>';
  }).join('') + '</div>' +
  (old ? '<div class="cxp-s" style="margin-bottom:16px">' + old + ' older items were logged before activities existed. They are kept but not shown here.</div>' : '');
}

function cxBoardHTML(act) {
  const its = CX.items.filter(i => i.activity_id === act.id);
  const live = its.filter(i => !i.outcome_type);
  const done = its.filter(i => i.outcome_type).slice(0, 40);
  let h = '<div class="cxp-board">' + (act.stages || []).map(s => {
    const col = live.filter(i => i.stage === s.key);
    return '<div class="cxp-col"><div class="cxp-col-h"><span>' + cxE(s.label) + '</span><span>' + col.length + '</span></div>' +
      (col.map(cxCardHTML).join('') || '<div class="cxp-s" style="text-align:center;padding:10px 0">Empty</div>') +
      '<button class="btn btn-ghost btn-sm" style="width:100%" onclick="cxOpenLog({activity_id:\'' + act.id + '\',stage:\'' + s.key + '\'})">+ Add here</button>' +
    '</div>';
  }).join('') + '</div>';

  const orphan = live.filter(i => !cxStage(act, i.stage));
  if (orphan.length) h += '<div class="cxp-warn">' + orphan.length + ' items are at a stage that no longer exists. Open one to move it. ' +
    orphan.map(i => '<a href="#" onclick="cxOpenItem(\'' + i.id + '\');return false">' + cxE(i.passport_code) + '</a>').join(', ') + '</div>';

  h += '<div class="card"><div class="card-title">Finished</div>' +
    (done.length ? done.map(i => {
      const o = cxOutcome(act, i.outcome);
      return '<div class="cxp-list-row" style="cursor:pointer" onclick="cxOpenItem(\'' + i.id + '\')"><div><div class="cxp-t">' + cxE(i.name) + ' <span class="cxp-code">' + cxE(i.passport_code) + '</span></div>' +
        '<div class="cxp-s">' + cxE(o ? o.label : i.outcome) + ' · ' + (i.outcome_at ? new Date(i.outcome_at).toLocaleDateString('en-GB') : '') + '</div></div>' +
        '<div class="cxp-s">' + cxFmt(i.weight_kg, 1) + ' kg</div></div>';
    }).join('') : renderEmpty('Nothing finished yet.')) + '</div>';
  return h;
}

function cxCardHTML(i) {
  const d = cxDays(i.updated_at);
  return '<div class="cxp-card ' + (d > 14 ? 'stuck' : '') + '" onclick="cxOpenItem(\'' + i.id + '\')">' +
    '<div class="cxp-t">' + cxE(i.name || 'Item') + (+i.quantity > 1 ? ' ×' + cxFmt(i.quantity) : '') + '</div>' +
    '<div class="cxp-s"><span class="cxp-code">' + cxE(i.passport_code) + '</span> · ' + (d ? d + 'd here' : 'today') + '</div></div>';
}

// ── Quick log (photo → check → one tap) ──────────────────────
// Same screen for every activity. Quick tally: the tap finishes
// the entry. Tracked: the tap puts the item at a step and offers
// its QR label.
CX.q = {};
CX.undo = null;
function cxQ(act) {
  if (!CX.q[act.id]) CX.q[act.id] = { type: ((act.item_types || [])[0] || {}).key || '', amt: '', batch: false, tell: false, event: cxDefaultSession() };
  return CX.q[act.id];
}
// Sessions (events) to link circular entries to — today first, then recent
function cxSessions() {
  const today = new Date().toISOString().slice(0, 10);
  const lo = new Date(Date.now() - 45 * 864e5).toISOString().slice(0, 10);
  const hi = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  return (DB.events || []).filter(e => e.date && String(e.date).slice(0, 10) >= lo && String(e.date).slice(0, 10) <= hi)
    .sort((a, b) => {
      const at = String(a.date).slice(0, 10) === today, bt = String(b.date).slice(0, 10) === today;
      if (at !== bt) return at ? -1 : 1;
      return String(b.date).localeCompare(String(a.date));
    });
}
function cxDefaultSession() {
  const today = new Date().toISOString().slice(0, 10);
  const t = (DB.events || []).filter(e => String(e.date || '').slice(0, 10) === today);
  return t.length === 1 ? String(t[0].id) : '';
}
function cxSessionLabel(id) {
  const ev = (DB.events || []).find(e => String(e.id) === String(id)); if (!ev) return '';
  const today = new Date().toISOString().slice(0, 10);
  const d = String(ev.date || '').slice(0, 10);
  return (d === today ? 'Today' : new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })) + ' · ' + (ev.name || 'Session');
}
function cxSessionOptions(sel) {
  const list = cxSessions();
  const has = sel && list.some(e => String(e.id) === String(sel));
  return '<option value="">No session</option>' +
    (sel && !has ? '<option value="' + cxE(sel) + '" selected>' + cxE(cxSessionLabel(sel) || 'Linked session') + '</option>' : '') +
    list.map(e => '<option value="' + cxE(e.id) + '"' + (String(e.id) === String(sel) ? ' selected' : '') + '>' + cxE(cxSessionLabel(e.id)) + '</option>').join('');
}

function cxIsToday(i) { const d = i.created_at || i.updated_at; return d && new Date(d).toDateString() === new Date().toDateString(); }

function cxQuickHTML(act) {
  cxInjectQuickStyle();
  const e = cxE, q = cxQ(act), id = act.id;
  const tracked = circMode(act) === 'tracked';
  const types = act.item_types || [];
  if (q.type && !cxType(act, q.type)) q.type = (types[0] || {}).key || '';
  const t = cxType(act, q.type), kg = cxPerKg(t);
  const today = CX.items.filter(i => i.activity_id === id && cxIsToday(i));
  const food = ['food', 'growing'].includes(act.template);
  const todayKg = today.reduce((a, i) => a + (+i.weight_kg || 0), 0);
  const todayN = today.reduce((a, i) => a + (+i.quantity || 1), 0);
  let big, small;
  if (act.template === 'repair_cafe') { const fx = today.filter(i => i.outcome_type === 'repair').reduce((a, i) => a + (+i.quantity || 1), 0); big = fx + ' fixed'; small = 'of ' + todayN + ' today'; }
  else if (tracked) { big = cxFmt(today.length); small = 'logged today'; }
  else { big = cxFmt(todayKg, 1) + ' kg'; small = food ? '≈ ' + cxFmt(todayKg / CX_KG_PER_MEAL) + ' meals today' : cxFmt(todayN) + ' entries today'; }
  const speech = !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  let h = '<div class="card cxq"><div class="cxq-top"><div><div class="cxq-k">' + e(act.icon) + ' ' + e(act.name) + '</div><div class="cxq-h">' + (tracked ? 'Add an item' : 'Log it') + '</div></div>' +
    '<div style="text-align:right"><div class="cxq-big">' + big + '</div><div class="cxq-small">' + small + '</div></div></div>';

  if ((DB.events || []).length) {
    h += '<div class="cxq-sess"><span>Session</span><select onchange="cxQ(cxAct(\'' + id + '\')).event=this.value">' + cxSessionOptions(q.event) + '</select></div>';
  }
  h += '<div class="cxq-cap">' +
    '<label class="cxq-cam"><span>📷</span><div>Photo' + (kg || !t ? '<small>on the scales</small>' : '') + '</div><input type="file" accept="image/*" capture="environment" style="display:none" onchange="cxQPhoto(event,\'' + id + '\')"/></label>' +
    '<button class="cxq-tellbtn" onclick="cxQ(cxAct(\'' + id + '\')).tell=!cxQ(cxAct(\'' + id + '\')).tell;cxDraw()">✍️ Just tell it</button></div>';
  if (q.status) h += '<div class="cxq-status ' + (q.statusErr ? 'err' : '') + '">' + q.status + '</div>';
  if (q.newType) h += '<div class="cxq-status"><b>' + e(q.newType.label) + '</b> isn\'t on your list yet <button class="btn btn-p btn-sm" onclick="cxAddTypeFromAI(\'' + id + '\')">+ Add ' + e(q.newType.label) + '</button></div>';

  if (q.tell) {
    h += '<div class="cxq-tell"><textarea id="cxq-text-' + id + '" placeholder="' + (tracked ? 'e.g. 3 laptops and a monitor from Ealing, all booked in' : food ? 'e.g. 12 kg tomatoes to the food bank, 5 kg courgettes shared' : act.template === 'repair_cafe' ? 'e.g. 14 items tonight, 11 fixed, 3 kettles not fixable' : 'e.g. 20 kg clothing reused, 5 kg recycled') + '">' + e(q.text || '') + '</textarea>' +
      '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:6px">' + (speech ? '<button class="btn btn-ghost btn-sm" id="cxq-mic-' + id + '" onclick="cxQMic(\'' + id + '\')">🎤 Speak</button>' : '') +
      '<button class="btn btn-p btn-sm" id="cxq-go-' + id + '" onclick="cxQTell(\'' + id + '\')">Read it</button></div></div>';
  }
  if (q.pending && q.pending.length) {
    h += '<div class="cxq-pend"><div class="cxq-k" style="margin-bottom:6px">Check, then log</div>' + q.pending.map(p => {
      const tt = cxType(act, p.item_type);
      const dest = cxOutcome(act, p.to) || cxStage(act, p.to);
      return '<div class="cxq-pend-row"><span>' + e(tt ? tt.label : p.new_item || '?') + ' · ' + cxFmt(p.amount, 1) + ' ' + (p.unit === 'kg' ? 'kg' : '') + '</span><span class="cxq-dest">' + e(dest ? dest.label : '—') + '</span></div>';
    }).join('') +
      '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="cxQ(cxAct(\'' + id + '\')).pending=null;cxDraw()">Cancel</button><button class="btn btn-p btn-sm" onclick="cxQConfirm(\'' + id + '\')">✓ Log all</button></div></div>';
  }

  h += '<div class="cxq-chips">' + types.map(x => '<button class="cxq-chip ' + (x.key === q.type ? 'on' : '') + '" onclick="cxQ(cxAct(\'' + id + '\')).type=\'' + e(x.key) + '\';cxDraw()">' + e(cxLbl(x)) + '</button>').join('') +
    (types.length ? '' : '<span class="cxp-s">No items yet — add them in ⚙️ Set up, or take a photo.</span>') + '</div>';

  if (!q.batch) {
    if (!tracked || kg) {
      h += '<div class="cxq-amt"><input id="cxq-amt-' + id + '" type="number" inputmode="decimal" min="0" step="' + (kg ? '0.1' : '1') + '" placeholder="' + (kg ? '0.0' : '1') + '" value="' + e(q.amt) + '" oninput="cxQ(cxAct(\'' + id + '\')).amt=this.value"/><span>' + (kg ? 'kg' : 'items') + '</span></div>' +
        (q.estAmt && String(q.amt) === String(q.estAmt) ? '<div class="cxp-s" style="margin:-6px 0 12px">≈ Estimated from the photo — reports will say so. Change it if you weigh it.</div>' : '');
    }
    if (tracked) {
      const show = q.more || q.brand || q.model || q.serial;
      h += show ? '<div class="cxq-more"><input placeholder="Brand" value="' + e(q.brand || '') + '" oninput="cxQ(cxAct(\'' + id + '\')).brand=this.value"/><input placeholder="Model" value="' + e(q.model || '') + '" oninput="cxQ(cxAct(\'' + id + '\')).model=this.value"/><input placeholder="Serial" value="' + e(q.serial || '') + '" oninput="cxQ(cxAct(\'' + id + '\')).serial=this.value"/></div>'
        : '<div style="margin:-4px 0 10px"><a href="#" class="cxp-s" onclick="cxQ(cxAct(\'' + id + '\')).more=true;cxDraw();return false">+ Brand, model, serial</a></div>';
    }
    const opts = tracked ? (act.stages || []) : (act.outcomes || []);
    h += '<div class="cxq-lbl">' + (tracked ? 'Where is it now?' : act.template === 'repair_cafe' ? 'How did it go?' : 'Where did it go?') + '</div>' +
      '<div class="cxq-btns">' + opts.map((o, i) => '<button class="cxq-btn ' + (i === 0 ? 'first' : '') + '" onclick="cxQuickLog(\'' + id + '\',\'' + (tracked ? 'stage' : 'outcome') + '\',\'' + e(o.key) + '\')">' + e(o.label) + '</button>').join('') + '</div>';
    if (!tracked) h += '<div style="text-align:center;margin-top:10px"><a href="#" class="cxp-s" onclick="cxQ(cxAct(\'' + id + '\')).batch=true;cxDraw();return false">Enter totals for a whole session instead</a></div>';
  } else {
    h += '<div class="cxq-lbl">Totals for ' + e(t ? t.label : 'this item') + ' (' + (kg ? 'kg' : 'items') + ')</div>' +
      '<div class="cxq-batch">' + (act.outcomes || []).map(o => '<label><span>' + e(o.label) + '</span><input type="number" min="0" step="' + (kg ? '0.1' : '1') + '" data-out="' + e(o.key) + '" class="cxq-b-' + id + '"/></label>').join('') + '</div>' +
      '<div style="display:flex;gap:6px;justify-content:flex-end;margin-top:10px"><button class="btn btn-ghost btn-sm" onclick="cxQ(cxAct(\'' + id + '\')).batch=false;cxDraw()">Back</button><button class="btn btn-p btn-sm" onclick="cxBatchLog(\'' + id + '\')">Log totals</button></div>';
  }
  h += '</div>';

  if (CX.undo && CX.undo.act === id && Date.now() - CX.undo.at < 12000) {
    h += '<div class="cxq-toast"><span>✓ ' + e(CX.undo.text) + '</span><span>' +
      (CX.undo.label ? '<a href="#" onclick="cxPrintLabels([\'' + CX.undo.ids[0] + '\']);return false">🏷️ Label</a> · <a href="#" onclick="cxOpenItem(\'' + CX.undo.ids[0] + '\');return false">Open</a> · ' : '') +
      '<a href="#" onclick="cxUndo();return false">Undo</a></span></div>';
  }
  return h;
}

function cxInjectQuickStyle() {
  if (document.getElementById('cxq-style')) return;
  const st = document.createElement('style'); st.id = 'cxq-style';
  st.textContent = `
.cxq{max-width:640px}
.cxq-top{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
.cxq-k{font-size:12px;color:var(--txt3)}
.cxq-h{font-size:18px;font-weight:700;color:var(--txt)}
.cxq-big{font-size:22px;font-weight:700;color:var(--em)}
.cxq-small{font-size:11px;color:var(--txt3)}
.cxq-sess{display:flex;align-items:center;gap:8px;margin:-4px 0 12px;font-size:12px;color:var(--txt3)}
.cxq-sess select{width:100%;min-width:0;flex:1;max-width:340px;padding:6px 9px;font-size:13px}
.cxq-cap{display:grid;grid-template-columns:2fr 1fr;gap:8px;margin-bottom:10px}
.cxq-cam{display:flex;align-items:center;justify-content:center;gap:10px;height:64px;margin:0;border-radius:12px;background:rgba(31,111,109,.08);border:1.5px dashed rgba(31,111,109,.35);color:var(--em);font-weight:700;font-size:15px;cursor:pointer;text-transform:none;letter-spacing:0;line-height:1.15}
.cxq-cam small{display:block;font-size:11px;font-weight:500;opacity:.8}
.cxq-cam span{font-size:22px}
.cxq-tellbtn{height:64px;border-radius:12px;border:1px solid var(--border);background:var(--surface);color:var(--txt2);font-weight:600;font-size:13px}
.cxq-status{font-size:12px;color:var(--em);background:rgba(31,111,109,.06);border-radius:8px;padding:8px 10px;margin-bottom:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.cxq-status.err{color:var(--red);background:#FEF2F2}
.cxq-tell textarea{min-height:70px;font-size:14px}
.cxq-tell{margin-bottom:10px}
.cxq-pend{border:1px solid var(--border);border-radius:10px;padding:10px 12px;margin-bottom:12px;background:var(--bg)}
.cxq-pend-row{display:flex;justify-content:space-between;font-size:13px;padding:5px 0;border-bottom:1px solid var(--border)}
.cxq-dest{color:var(--em);font-weight:600}
.cxq-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.cxq-chip{border:1px solid var(--border);background:var(--surface);border-radius:18px;padding:7px 13px;font-size:13px;color:var(--txt2)}
.cxq-chip.on{background:var(--em);border-color:var(--em);color:#fff;font-weight:600}
.cxq-amt{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.cxq-amt input{font-size:26px;font-weight:700;padding:10px 14px;height:58px;border-radius:12px}
.cxq-amt span{font-size:15px;color:var(--txt3);font-weight:600;min-width:44px}
.cxq-more{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin-bottom:12px}
.cxq-more input{font-size:13px;padding:8px 10px}
.cxq-lbl{font-size:12px;color:var(--txt3);margin-bottom:6px}
.cxq-btns{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px}
.cxq-btn{height:56px;border-radius:12px;border:1px solid var(--border);background:var(--surface);font-size:14px;font-weight:600;color:var(--txt)}
.cxq-btn.first{background:var(--em);border-color:var(--em);color:#fff}
.cxq-btn:active{transform:scale(.97)}
.cxq-batch{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
.cxq-batch label{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--txt2)}
.cxq-batch input{font-size:18px;font-weight:700;height:46px}
.cxq-toast{max-width:640px;display:flex;justify-content:space-between;gap:10px;align-items:center;flex-wrap:wrap;background:#1F2937;color:#fff;border-radius:10px;padding:10px 14px;font-size:13px;margin:-6px 0 16px}
.cxq-toast a{color:#9FE3D6;font-weight:700;text-decoration:none}
@media(max-width:600px){.cxq-cap{grid-template-columns:1fr 1fr}.cxq-more{grid-template-columns:1fr}.cxq-btns{grid-template-columns:1fr 1fr}.cxq-h{font-size:16px}.cxq-big{font-size:19px}.cxq-amt input{font-size:22px;height:52px}.cxq-btn{height:50px;font-size:13.5px}.cxq-tellbtn{font-size:13px}.cxq-sess span{display:none}}`;
  document.head.appendChild(st);
}

// Core insert used by one-tap, totals and "just tell it"
async function cxQInsert(act, typeKey, amount, kind, key, extra) {
  const t = cxType(act, typeKey);
  if (!t) throw new Error('Pick what it is first');
  const kg = cxPerKg(t);
  const amt = +amount || 0;
  if (kg && !amt) throw new Error('Enter the weight in kg');
  const qty = kg ? 1 : Math.max(1, Math.round(amt || 1));
  const weight = kg ? amt : +((+t.weight_kg || 0) * qty).toFixed(2);
  const f = cxCalc(act, t.key, qty, weight);
  const now = new Date().toISOString();
  const qs = CX.q[act.id];
  // Only the one-tap path uses the photo estimate (totals and 'just tell it' use typed numbers)
  const estimated = !(extra && extra._via) && !!(qs && qs.estAmt && String(qs.amt) === String(qs.estAmt) && String(amount) === String(qs.estAmt));
  const d = Object.assign({
    org_id: orgId, activity_id: act.id, item_type: t.key, name: cxLbl(t), category: act.name,
    event_id: qs && qs.event ? qs.event : null,
    quantity: qty, weight_kg: weight, co2e_kg: f.co2, value_gbp: f.value, custom: estimated && kg ? { weight_estimated: true, estimate_basis: qs.estBasis || '' } : {}, updated_at: now
  }, extra || {});
  if (kind === 'outcome') {
    const o = cxOutcome(act, key);
    Object.assign(d, { outcome: key, outcome_type: o.type, outcome_at: now, status: o.label, stage: null });
  } else {
    const s = cxStage(act, key);
    Object.assign(d, { stage: key, status: s ? s.label : '' });
  }
  const { data, error } = await cxFrom('circular_items').insert([d]).select().single();
  if (error) throw error;
  await cxLog(data, kind === 'outcome' ? 'tallied' : 'logged', null, key, { item_type: t.key, quantity: qty, weight_kg: weight, via: (extra && extra._via) || 'quick' });
  CX.items.unshift(data);
  return { row: data, text: (kg ? cxFmt(weight, 1) + ' kg ' : (qty > 1 ? qty + ' × ' : '')) + cxLbl(t) };
}

async function cxQuickLog(actId, kind, key) {
  const act = cxAct(actId), q = cxQ(act);
  try {
    const extra = {};
    if (kind === 'stage') { ['brand', 'model', 'serial'].forEach(k => { if (q[k]) extra[k] = q[k].trim(); }); if (q.name) extra.name = q.name; }
    const r = await cxQInsert(act, q.type, q.amt, kind, key, extra);
    const dest = cxOutcome(act, key) || cxStage(act, key);
    CX.undo = { act: actId, ids: [r.row.id], at: Date.now(), text: r.text + ' → ' + (dest ? dest.label : ''), label: kind === 'stage' };
    Object.assign(q, { amt: '', brand: '', model: '', serial: '', name: '', status: '', newType: null, more: false, estAmt: null, estBasis: '' });
    cxDraw(); cxUndoTimer();
    if (kind === 'stage' && (act.fields || []).some(f => cxFieldStage(act, f) === key)) {
      _cxPass = { id: r.row.id, action: { kind: 'move', key }, recip: 'person', personId: '', channel: '' };
      cxOpenItem(r.row.id, true);
    }
    const a = $('cxq-amt-' + actId); if (a && kind === 'outcome') a.focus();
  } catch (e) { q.status = e.message || String(e); q.statusErr = true; cxDraw(); q.statusErr = false; }
}

async function cxBatchLog(actId) {
  const act = cxAct(actId), q = cxQ(act);
  const inputs = Array.from(document.querySelectorAll('.cxq-b-' + actId)).filter(i => +i.value > 0);
  if (!inputs.length) { q.status = 'Enter at least one total'; q.statusErr = true; cxDraw(); q.statusErr = false; return; }
  const ids = [];
  try {
    for (const inp of inputs) { const r = await cxQInsert(act, q.type, +inp.value, 'outcome', inp.getAttribute('data-out'), { _via: 'totals' }); ids.push(r.row.id); }
    const t = cxType(act, q.type);
    CX.undo = { act: actId, ids, at: Date.now(), text: 'Session totals logged for ' + (t ? t.label : '') };
    q.batch = false; cxDraw(); cxUndoTimer();
  } catch (e) { q.status = e.message; q.statusErr = true; cxDraw(); q.statusErr = false; }
}

let _cxUndoT = null;
function cxUndoTimer() { clearTimeout(_cxUndoT); _cxUndoT = setTimeout(() => { if (CX.undo && Date.now() - CX.undo.at >= 12000) { CX.undo = null; if (CX.tab !== 'all') cxDraw(); } }, 12200); }
async function cxUndo() {
  const u = CX.undo; if (!u) return;
  CX.undo = null;
  for (const id of u.ids) {
    const it = CX.items.find(i => String(i.id) === String(id));
    const { error } = await cxFrom('circular_items').delete().eq('id', id);
    if (!error && it) { await cxLog(it, 'undone', null, null, {}); CX.items = CX.items.filter(i => i !== it); }
  }
  cxDraw();
}

// 📷 Photo: identify + read the scale
// Item names without the old "(per kg)" suffix
function cxLbl(v) { return String((v && v.label) != null ? v.label : (v || '')).replace(/\s*\(per\s*kg\)/i, '').trim(); }

async function cxQPhoto(ev, actId) {
  const file = ev.target.files && ev.target.files[0]; if (!file) return;
  ev.target.value = '';   // same photo can be picked again
  const act = cxAct(actId), q = cxQ(act), tracked = circMode(act) === 'tracked';
  q.status = '✨ Looking at the photo…'; q.newType = null; q.estAmt = null; q.estBasis = ''; cxDraw();
  try {
    // Sharp enough to read a scale display, small enough for the AI request limit
    const b64 = await cxResize(file, 1400, 0.8, 185000);
    const list = (act.item_types || []).map(t => t.key + ' = ' + cxLbl(t) + ' (' + (cxPerKg(t) ? 'weighed' : 'counted') + ')').join('; ');
    const j = await vAI(
      'You help a UK community organisation log what is in a photo for their "' + act.name + '" activity. Look carefully at any weighing scale display and read its digits exactly. Reply with JSON only.',
      [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
       { type: 'text', text: 'Their list: ' + (list || 'empty') + '.\nReturn {' +
         '"seen": the specific thing in the photo in 1 to 4 plain words, e.g. "Tomatoes", "School sweatshirts", "Kettle" — no brand or school names, ' +
         '"item_type": key of the list entry that is the same thing, or failing that the broader list entry it belongs to (e.g. tomatoes → a "Produce" entry), or "", ' +
         '"match": "exact" if that list entry is the same thing, "category" if it is only a broader group, "none" if nothing fits, ' +
         '"unit": "kg" or "each", ' +
         '"scale_visible": true if a weighing scale is in the photo, ' +
         '"scale_reading": the number shown on the scale display exactly as shown, or null if you cannot read it clearly, ' +
         '"scale_units": the units on the display: "kg", "g", "lb" or "oz", ' +
         '"count": how many of the main item you can see, ' +
         '"estimated_kg": if there is no readable scale, your best estimate of the total weight in kg of everything shown, using typical UK weights (e.g. T-shirt 0.2, sweatshirt 0.45, jeans 0.6, coat 1.2, bag of mixed clothes 5, tomato 0.1, potato 0.2), or null if you cannot estimate, ' +
         '"estimate_basis": a few words on how you estimated, e.g. "about 12 garments at ~0.4 kg", ' +
         (tracked ? '"brand": "", "model": "", "serial": only text you can actually read on a label else "", ' : '') +
         '"hazards": e.g. "lithium battery" or "", "confidence": "high", "medium" or "low"}. Never guess a scale reading or a serial number.' }], 450);

    const seen = String(j.seen || '').trim();
    let typeKey = j.item_type && cxType(act, j.item_type) ? j.item_type : '';
    if (!typeKey && seen) { const m = (act.item_types || []).find(t => cxLbl(t).toLowerCase() === seen.toLowerCase()); if (m) typeKey = m.key; }
    const unit = j.unit === 'each' ? 'each' : 'kg';
    // Nothing fits, or only a broad group fits: offer the specific thing as its own item
    if (seen && (!typeKey || j.match === 'category') && !(act.item_types || []).some(t => cxLbl(t).toLowerCase() === seen.toLowerCase())) {
      q.newType = { label: seen.replace(/^./, c => c.toUpperCase()), unit };
    }
    if (typeKey) q.type = typeKey;
    const t = cxType(act, q.type);
    const kg = typeKey ? cxPerKg(t) : unit === 'kg';

    // Scale → kg
    let how = '';
    const raw = j.scale_reading == null ? null : parseFloat(String(j.scale_reading).replace(',', '.'));
    if (kg && raw != null && !isNaN(raw) && raw > 0) {
      const u = String(j.scale_units || 'kg').toLowerCase();
      const v = u === 'g' ? raw / 1000 : u === 'lb' ? raw * 0.453592 : u === 'oz' ? raw * 0.0283495 : raw;
      q.amt = String(+v.toFixed(2));
      how = 'scale reads ' + raw + ' ' + u + (u !== 'kg' ? ' = ' + q.amt + ' kg' : '');
    } else if (!kg && +j.count > 0) { q.amt = String(Math.round(j.count)); how = q.amt + ' counted'; }
    else if (kg && +j.estimated_kg > 0) {
      q.amt = String(+(+j.estimated_kg).toFixed(1)); q.estAmt = q.amt; q.estBasis = j.estimate_basis || '';
      how = (j.scale_visible ? 'can\'t read the scale, so ' : '') + 'estimated ≈ ' + q.amt + ' kg' + (j.estimate_basis ? ' (' + j.estimate_basis + ')' : '') + ' — weigh it if you can';
    }
    else if (kg && j.scale_visible) how = 'I can see the scale but not read the numbers — take the photo closer to the display, or type the weight';
    else if (kg) how = 'no scale in the photo — type the weight';

    if (tracked) { ['brand', 'model', 'serial'].forEach(k => { if (j[k]) q[k] = j[k]; }); if (seen) q.name = seen; }
    const shown = seen || (t ? cxLbl(t) : 'Item');
    const filedAs = t && j.match === 'category' ? ' (logged as ' + cxLbl(t) + ')' : '';
    q.status = '✨ <b>' + cxE(shown) + '</b>' + cxE(filedAs) + (how ? ' · ' + cxE(how) : '') + (j.confidence === 'low' ? ' · not sure, please check' : '') +
      (j.hazards ? ' · <b style="color:var(--red)">⚠ ' + cxE(j.hazards) + '</b>' : '');
  } catch (e) { q.status = 'Could not read the photo: ' + cxE(e.message || e); q.statusErr = true; }
  cxDraw(); q.statusErr = false;
}

async function cxAddTypeFromAI(actId) {
  const act = cxAct(actId), q = cxQ(act); if (!q.newType) return;
  const key = _circSlug(q.newType.label) + '_' + Math.random().toString(36).slice(2, 5);
  const t = { key, label: q.newType.label, unit: q.newType.unit, weight_kg: 1, co2e_kg: 0, value_gbp: 0, source: 'Set by organisation' };
  const types = (act.item_types || []).concat(t);
  const { error } = await cxFrom('circular_activities').update({ item_types: types }).eq('id', act.id);
  if (error) { q.status = 'Could not add: ' + cxE(error.message); q.statusErr = true; cxDraw(); q.statusErr = false; return; }
  act.item_types = types; q.type = key; q.newType = null; q.status = '✓ Added ' + cxE(t.label) + ' to your list';
  cxDraw();
}

// ✍️ Just tell it
async function cxQTell(actId) {
  const act = cxAct(actId), q = cxQ(act), tracked = circMode(act) === 'tracked';
  const ta = $('cxq-text-' + actId); q.text = ta ? ta.value.trim() : '';
  if (!q.text) return;
  const btn = $('cxq-go-' + actId); if (btn) { btn.disabled = true; btn.textContent = 'Reading…'; }
  try {
    const types = (act.item_types || []).map(t => t.key + ' = ' + t.label + ' (' + (cxPerKg(t) ? 'kg' : 'each') + ')').join('; ');
    const dests = (tracked ? act.stages : act.outcomes || []).map(o => o.key + ' = ' + o.label).join('; ');
    const j = await vAI('You turn a short note from a UK community organisation into log entries. Reply with JSON only. Use only numbers stated in the note. Never invent amounts.',
      'Activity: ' + act.name + '\nItems: ' + (types || 'none') + '\n' + (tracked ? 'Steps' : 'Where it can go') + ': ' + dests +
      '\nNote: "' + q.text + '"\nReturn {"entries":[{"item_type": key or "", "new_item": name if not on the list else "", "amount": number, "unit": "kg" or "each", "to": key from ' + (tracked ? 'steps' : 'where it can go') + '}]}. ' +
      'If the note gives a total and a part (e.g. 14 items, 11 fixed), split it (11 fixed, 3 into the remaining outcome stated or implied).', 900);
    const ok = (j.entries || []).filter(p => +p.amount > 0 && (tracked ? cxStage(act, p.to) : cxOutcome(act, p.to)));
    if (!ok.length) throw new Error('Could not find amounts and destinations in that — try adding them');
    q.pending = ok; q.tell = false; q.status = '';
  } catch (e) { q.status = cxE(e.message || e); q.statusErr = true; }
  cxDraw(); q.statusErr = false;
}
async function cxQConfirm(actId) {
  const act = cxAct(actId), q = cxQ(act), tracked = circMode(act) === 'tracked';
  const ids = [];
  try {
    for (const p of q.pending) {
      let key = p.item_type && cxType(act, p.item_type) ? p.item_type : '';
      if (!key && p.new_item) {
        const m = (act.item_types || []).find(t => t.label.toLowerCase() === String(p.new_item).toLowerCase());
        if (m) key = m.key;
        else { q.newType = { label: p.new_item, unit: p.unit === 'kg' ? 'kg' : 'each' }; await cxAddTypeFromAI(actId); key = q.type; }
      }
      const n = tracked && !cxPerKg(cxType(act, key)) ? Math.max(1, Math.round(+p.amount)) : 1;
      for (let k = 0; k < n; k++) {   // tracked items get one passport each
        const r = await cxQInsert(act, key, tracked && n > 1 ? 1 : p.amount, tracked ? 'stage' : 'outcome', p.to, { _via: 'told' });
        ids.push(r.row.id);
      }
    }
    CX.undo = { act: actId, ids, at: Date.now(), text: ids.length + ' entr' + (ids.length === 1 ? 'y' : 'ies') + ' logged' };
    q.pending = null; q.text = ''; q.status = '';
    cxDraw(); cxUndoTimer();
  } catch (e) { q.status = cxE(e.message || e); q.statusErr = true; cxDraw(); q.statusErr = false; }
}
let _cxRec = null;
function cxQMic(actId) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition; if (!SR) return;
  const btn = $('cxq-mic-' + actId), ta = $('cxq-text-' + actId);
  if (_cxRec) { _cxRec.stop(); _cxRec = null; if (btn) btn.textContent = '🎤 Speak'; return; }
  _cxRec = new SR(); _cxRec.lang = 'en-GB'; _cxRec.interimResults = true; _cxRec.continuous = false;
  const base = ta.value ? ta.value + ' ' : '';
  _cxRec.onresult = ev => { ta.value = base + Array.from(ev.results).map(r => r[0].transcript).join(' '); };
  _cxRec.onend = () => { _cxRec = null; if (btn) btn.textContent = '🎤 Speak'; };
  _cxRec.start(); if (btn) btn.textContent = '■ Stop';
}

// Recent entries for quick-tally activities
function cxRecentHTML(act) {
  const its = CX.items.filter(i => i.activity_id === act.id);
  const done = its.filter(i => i.outcome_type).slice(0, 30);
  const open = its.filter(i => !i.outcome_type);
  let h = '<div class="card" style="max-width:640px"><div class="card-title">Recent</div>';
  if (open.length) h += '<div class="cxp-warn" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><span>' + open.length + ' entr' + (open.length === 1 ? 'y has' : 'ies have') + ' no destination yet, so reports leave ' + (open.length === 1 ? 'it' : 'them') + ' out.</span>' +
    '<button class="btn btn-p btn-sm" onclick="cxTidyOpen(\'' + act.id + '\')">Sort them</button></div>';
  h += done.length ? done.map(i => {
    const o = cxOutcome(act, i.outcome); const t = cxType(act, i.item_type);
    const d = new Date(i.outcome_at || i.created_at);
    return '<div class="cxp-list-row"><div><div class="cxp-t">' + (cxPerKg(t) ? cxFmt(i.weight_kg, 1) + ' kg ' : (+i.quantity > 1 ? cxFmt(i.quantity) + ' × ' : '')) + cxE(cxLbl(i.name)) + '</div>' +
      '<div class="cxp-s">' + (cxIsToday(i) ? 'Today ' + d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('en-GB')) + '</div></div>' +
      '<div style="display:flex;align-items:center;gap:10px"><span class="cxp-chip">' + cxE(o ? o.label : i.status) + '</span>' +
      '<button class="btn btn-ghost btn-sm" title="Delete" onclick="cxDelEntry(\'' + i.id + '\')">×</button></div></div>';
  }).join('') : renderEmpty('Nothing logged yet.');
  return h + '</div>';
}
async function cxDelEntry(id) {
  const it = CX.items.find(i => String(i.id) === String(id)); if (!it) return;
  if (!confirm('Delete this entry?')) return;
  const { error } = await cxFrom('circular_items').delete().eq('id', it.id);
  if (error) { alert('Could not delete: ' + error.message); return; }
  await cxLog(it, 'deleted', null, null, { name: it.name, weight_kg: it.weight_kg });
  CX.items = CX.items.filter(i => i !== it); cxDraw();
}

// ─────────────────────────────────────────────────────────────
// CIRCULAR → REPORTS
// One set of numbers for every report: Delivery report, contract
// (funder) report, session report and Social Impact.
// An item counts for a contract when its activity is funded by that
// contract (Settings → Circular → Basics → Funded by) OR it was
// logged at a session (event) linked to that contract.
// PRINCIPLE: code calculates every figure; the AI only writes prose.
// ─────────────────────────────────────────────────────────────
const CXR = { items: [], acts: [], at: 0, ok: false };

async function cxReportLoad(force) {
  if (!force && CXR.ok && Date.now() - CXR.at < 60000) return CXR;
  try {
    const a = await cxFrom('circular_activities').select('*').eq('org_id', orgId);
    if (a.error) { CXR.ok = false; return CXR; }
    const it = await cxFrom('circular_items').select('*').eq('org_id', orgId).limit(20000);
    CXR.acts = a.data || []; CXR.items = it.error ? [] : (it.data || []);
    CXR.ok = true; CXR.at = Date.now();
  } catch (e) { CXR.ok = false; }
  return CXR;
}
function _cxrArr(v) {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.charAt(0) === '[') { try { return JSON.parse(v).map(String); } catch (e) { return []; } }
  return [];
}

// o: { from, to (YYYY-MM-DD), contractId, eventId }
function cxReportStats(o) {
  o = o || {};
  if (!CXR.ok) return null;
  const acts = {}; CXR.acts.forEach(a => { acts[a.id] = a; });
  const evCons = {}; (DB.events || []).forEach(e => { evCons[String(e.id)] = _cxrArr(e.contract_ids); });
  const cid = o.contractId ? String(o.contractId) : '';
  const items = CXR.items.filter(i => {
    const a = acts[i.activity_id]; if (!a) return false;
    const d = String(i.outcome_at || i.created_at || '').slice(0, 10);
    if (o.from && o.to && (!d || d < o.from || d > o.to)) return false;
    if (o.eventId) return String(i.event_id || '') === String(o.eventId);
    if (cid) return _cxrArr(a.contract_ids).includes(cid) || (!!i.event_id && (evCons[String(i.event_id)] || []).includes(cid));
    return true;
  });
  const r = { entries: items.length, inProgress: 0, undecided: 0, inStock: 0, finished: 0, kg: 0, co2: 0, value: 0, reused: 0, foodKg: 0, meals: 0,
    repairTried: 0, repairFixed: 0, income: 0, recycledKg: 0, estKg: 0, byActivity: {}, byOutcome: {}, byBed: {}, starter: false, noSession: 0, activities: [] };
  items.forEach(i => {
    const a = acts[i.activity_id];
    const qty = +i.quantity || 1, kg = +i.weight_kg || 0;
    if (a.template === 'growing' && i.custom && i.custom.bed_planter) r.byBed[i.custom.bed_planter] = (r.byBed[i.custom.bed_planter] || 0) + kg;
    const row = r.byActivity[a.name] || (r.byActivity[a.name] = { icon: a.icon || '♻️', items: 0, kg: 0, co2: 0, value: 0 });
    if (!i.event_id) r.noSession++;
    if (!i.outcome_type) { r.inProgress++; if (circMode(a) === 'tracked') r.inStock++; else r.undecided++; return; }
    r.finished++; row.items += qty;
    const t = i.outcome_type;
    const o2 = (a.outcomes || []).find(x => x.key === i.outcome);
    const ol = (o2 ? o2.label : (i.status || t));
    r.byOutcome[ol] = (r.byOutcome[ol] || 0) + qty;
    if (CX_IMPACT_KG.includes(t)) { r.kg += kg; row.kg += kg; if (i.custom && i.custom.weight_estimated) r.estKg += kg; }
    if (t === 'recycle') r.recycledKg += kg;
    if (CX_IMPACT_CO2.includes(t)) { r.co2 += +i.co2e_kg || 0; r.value += +i.value_gbp || 0; row.co2 += +i.co2e_kg || 0; row.value += +i.value_gbp || 0; }
    if (t === 'reuse' || t === 'repair') r.reused += qty;
    if (t === 'share') r.foodKg += kg;
    if (i.custom && +i.custom.sale_gbp) r.income += +i.custom.sale_gbp;
    if (a.template === 'repair_cafe') { r.repairTried += qty; if (t === 'repair') r.repairFixed += qty; }
    const ty = (a.item_types || []).find(x => x.key === i.item_type);
    if (ty && ty.source === CIRC_STARTER && ((+i.co2e_kg || 0) > 0 || (+i.value_gbp || 0) > 0)) r.starter = true;
  });
  const r1 = v => Math.round(v * 10) / 10;
  r.kg = r1(r.kg); r.estKg = r1(r.estKg); r.co2 = r1(r.co2); r.value = Math.round(r.value); r.foodKg = r1(r.foodKg); r.recycledKg = r1(r.recycledKg);
  r.meals = Math.round(r.foodKg / CX_KG_PER_MEAL);
  r.fixRate = r.repairTried ? Math.round(r.repairFixed / r.repairTried * 100) : null;
  r.activities = Object.keys(r.byActivity);
  return r;
}

function cxReportLines(r) {
  if (!r || !r.entries) return [];
  const m = v => '£' + Math.round(v).toLocaleString('en-GB');
  return [
    '',
    'CIRCULAR ECONOMY (calculated from item records)',
    'Activities: ' + r.activities.join(', '),
    'Items and batches with a final outcome: ' + r.finished,
    r.inStock ? 'Items currently being processed (in stock, not yet counted): ' + r.inStock : '',
    'Weight diverted from waste (reused, repaired, shared or recycled): ' + r.kg + ' kg' + (r.recycledKg ? ' (of which recycled: ' + r.recycledKg + ' kg)' : '') + (r.estKg ? ' — ' + r.estKg + ' kg of this was estimated from photos rather than weighed' : ''),
    r.reused ? 'Items reused or repaired: ' + r.reused : '',
    r.co2 ? 'Estimated CO2e avoided: ' + r.co2 + ' kg (' + (Math.round(r.co2 / 100) / 10) + ' tonnes)' : '',
    r.value ? 'Estimated value to people receiving items: ' + m(r.value) : '',
    r.foodKg ? 'Food shared: ' + r.foodKg + ' kg (about ' + r.meals + ' meals at 420 g per meal, WRAP)' : '',
    r.fixRate != null ? 'Repair: ' + r.repairFixed + ' of ' + r.repairTried + ' items fixed (' + r.fixRate + '% fix rate)' : '',
    r.income ? 'Income from resale: ' + m(r.income) : '',
    'By outcome: ' + Object.keys(r.byOutcome).map(k => k + ' ' + r.byOutcome[k]).join(', '),
    'Method: CO2e and value use per-item factors held in Vorlana' + (r.starter ? ', some of which are Vorlana starter estimates not yet set by the organisation' : ' set by the organisation') + '. State that these are estimates.'
  ].filter(Boolean);
}

function cxReportGaps(r) {
  const g = [];
  if (!r || !r.entries) return g;
  if (r.estKg) g.push(r.estKg + ' kg of the weight diverted was estimated from photos rather than weighed.');
  if (r.starter) g.push('Some CO2e and value figures use Vorlana starter estimates rather than the organisation\'s own figures.');
  if (r.undecided) g.push(r.undecided + ' circular entr' + (r.undecided === 1 ? 'y has' : 'ies have') + ' no destination recorded yet, so ' + (r.undecided === 1 ? 'it is' : 'they are') + ' not counted in the impact figures.');
  return g;
}

// Figures + tables for the report document
function cxReportDocHTML(r, title) {
  if (!r || !r.entries) return '';
  const esc = escapeHTML, m = v => '£' + Math.round(v).toLocaleString('en-GB');
  const figs = [
    ['Diverted from waste', r.kg.toLocaleString('en-GB') + ' kg'],
    r.co2 ? ['CO₂e avoided (est.)', (Math.round(r.co2 / 100) / 10) + ' t'] : null,
    r.reused ? ['Items reused or repaired', r.reused] : null,
    r.foodKg ? ['Food shared', r.foodKg + ' kg'] : null,
    r.foodKg ? ['Meals equivalent', r.meals] : null,
    r.fixRate != null ? ['Repair fix rate', r.fixRate + '%'] : null,
    r.value ? ['Value to people (est.)', m(r.value)] : null,
    r.income ? ['Resale income', m(r.income)] : null
  ].filter(Boolean);
  const actRows = r.activities.map(k => { const a = r.byActivity[k]; return '<tr><td>' + esc(a.icon + ' ' + k) + '</td><td>' + a.items + '</td><td>' + (Math.round(a.kg * 10) / 10) + '</td><td>' + (Math.round(a.co2 * 10) / 10) + '</td></tr>'; }).join('');
  const outKeys = Object.keys(r.byOutcome).sort((a, b) => r.byOutcome[b] - r.byOutcome[a]);
  const bedKeys = Object.keys(r.byBed || {}).sort((a, b) => r.byBed[b] - r.byBed[a]);
  return '<h3>' + esc(title || 'Circular economy') + '</h3>' +
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:10px 0 16px">' + figs.map(f =>
      '<div style="border:1px solid #ddd;border-radius:8px;padding:10px;text-align:center"><div style="font-size:20px;font-weight:800;color:#1F6F6D">' + esc(String(f[1])) + '</div>' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#777;font-weight:700">' + esc(f[0]) + '</div></div>').join('') + '</div>' +
    '<table class="dr-tbl" style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px"><thead><tr><th style="text-align:left">Activity</th><th style="text-align:left">Items</th><th style="text-align:left">kg</th><th style="text-align:left">CO₂e kg</th></tr></thead><tbody>' + actRows + '</tbody></table>' +
    (outKeys.length ? '<table class="dr-tbl" style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:10px"><thead><tr><th style="text-align:left">Where it went</th><th style="text-align:left">Items</th></tr></thead><tbody>' +
      outKeys.map(k => '<tr><td>' + esc(k) + '</td><td>' + r.byOutcome[k] + '</td></tr>').join('') + '</tbody></table>' : '') +
    (bedKeys.length ? '<table class="dr-tbl" style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:10px"><thead><tr><th style="text-align:left">Yield by bed / planter</th><th style="text-align:left">kg</th></tr></thead><tbody>' +
      bedKeys.map(k => '<tr><td>' + esc(k) + '</td><td>' + (Math.round(r.byBed[k] * 10) / 10) + '</td></tr>').join('') + '</tbody></table>' : '') +
    '<p style="font-size:11px;color:#777">CO₂e and value are estimates from per-item factors' + (r.starter ? ' (including Vorlana starter estimates)' : ' set by the organisation') + '. Meals at 420 g per meal (WRAP). Weight diverted includes items reused, repaired, shared or recycled.' + (r.estKg ? ' ' + r.estKg + ' kg of weight was estimated from photos rather than weighed.' : '') + '</p>';
}

// Social Impact page card
async function cxImpactCard() {
  const page = $('page-impact'); if (!page) return;
  if (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.modules && currentOrg.modules.circular === false) { const c = $('cx-impact-card'); if (c) c.remove(); return; }
  await cxReportLoad();
  const sel = $('ir-period');
  if (sel && !sel._cx) { sel._cx = true; sel.addEventListener('change', () => cxImpactCard()); }
  const key = (sel && sel.value) || 'all';
  let from = null, to = null;
  if (typeof _impactRange === 'function') { try { const rg = _impactRange(key); from = rg.from || null; to = rg.to || null; } catch (e) { /* all time */ } }
  const r = cxReportStats({ from, to });
  let card = $('cx-impact-card');
  if (!r || !r.entries) { if (card) card.remove(); return; }
  if (!card) {
    card = document.createElement('div'); card.id = 'cx-impact-card'; card.className = 'card';
    const wall = page.querySelector('.impact-wall');
    if (wall && wall.nextSibling) page.insertBefore(card, wall.nextSibling); else page.appendChild(card);
  }
  const m = v => '£' + Math.round(v).toLocaleString('en-GB');
  card.innerHTML = '<div class="card-title">♻️ Circular economy</div><div class="stats-grid" style="margin:0">' +
    statCard('Diverted from waste', r.kg.toLocaleString('en-GB') + ' kg') +
    (r.co2 ? statCard('CO₂e avoided', (Math.round(r.co2 / 100) / 10) + ' t', 'estimate') : '') +
    (r.foodKg ? statCard('Food shared', r.foodKg + ' kg', '≈ ' + r.meals + ' meals') : '') +
    (r.fixRate != null ? statCard('Fix rate', r.fixRate + '%', r.repairFixed + ' of ' + r.repairTried) : statCard('Items reused', r.reused)) +
    (r.value ? statCard('Value to people', m(r.value), 'estimate') : '') + '</div>';
}

// ─────────────────────────────────────────────────────────────
// CIRCULAR IMPORTER — historic spreadsheets, no column mapping
// CSV / TSV / Excel. ✨ reads the headers and values and matches
// them to the activity's items and destinations; the code does all
// the counting, dates and weights. Duplicates are skipped, new
// items are added to the list, and the whole import can be undone.
// ─────────────────────────────────────────────────────────────
const CXI = { file: null, headers: [], rows: [], act: null, map: {}, vals: { item: {}, outcome: {}, stage: {} }, gUnit: 'kg', plan: null, batch: null, link: true, defOut: '', defStage: '' };
const CXI_FIELDS = [
  ['date', 'Date'], ['item', 'Item / crop'], ['kg', 'Weight'], ['qty', 'Quantity'], ['outcome', 'Where it went / result'],
  ['stage', 'Step'], ['name', 'Description'], ['brand', 'Brand'], ['model', 'Model'], ['serial', 'Serial'], ['source', 'Donor / source'], ['sale', 'Sale price'], ['notes', 'Notes'],
  ['bed', 'Bed / planter'], ['batch', 'Batch number'], ['harvester', 'Harvester / picker'], ['packer', 'Packer'], ['packdate', 'Packing date']
];

function cxImportOpen() {
  const acts = cxItemActs();
  if (!acts.length) { alert('Add an activity in ⚙️ Set up first.'); return; }
  const cur = CX.tab !== 'all' && cxAct(CX.tab) && CX.tab !== 'collections' ? CX.tab : acts[0].id;
  cxModal('<h2>Import past records</h2>' +
    '<div class="cxp-s" style="font-size:13px;line-height:1.5;margin-bottom:14px">Upload a spreadsheet of past harvests, repairs, donations or devices. No column matching needed — ✨ works out which column is which, and you check the result before anything is saved.</div>' +
    '<div class="form-row"><label>Which activity is this for?</label><select id="cxi-act">' + acts.map(a => '<option value="' + a.id + '"' + (a.id === cur ? ' selected' : '') + '>' + cxE(a.icon + ' ' + a.name) + '</option>').join('') + '</select></div>' +
    '<div class="form-row"><label>File</label><input type="file" id="cxi-file" accept=".csv,.tsv,.txt,.xlsx,.xls,text/csv"/><div class="cxp-s" style="margin-top:4px">CSV, TSV or Excel. First row should be the column headings.</div></div>' +
    ((DB.events || []).length ? '<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin-bottom:6px"><input type="checkbox" id="cxi-link" checked style="width:auto"/> Link rows to a session held on the same date</label>' : '') +
    '<div id="cxi-msg" class="cxp-s" style="margin-top:8px"></div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="cxCloseModal()">Cancel</button><button class="btn btn-p" id="cxi-go" onclick="cxImportRead()">Read file</button></div>', 560);
}

function cxiParseDelimited(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/)[0] || '';
  const delim = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let cur = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], nx = text[i + 1];
    if (q) { if (c === '"' && nx === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; }
    else if (c === '"') q = true;
    else if (c === delim) { cur.push(f); f = ''; }
    else if (c === '\n') { cur.push(f); rows.push(cur); cur = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f.length || cur.length) { cur.push(f); rows.push(cur); }
  return rows;
}
async function cxiLoadXLSX() {
  if (window.XLSX) return;
  await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'; s.onload = ok; s.onerror = () => bad(new Error('Could not load the Excel reader — save the sheet as CSV and try again')); document.head.appendChild(s); });
}
async function cxiReadFile(file) {
  let rows;
  if (/\.xlsx?$/i.test(file.name)) {
    await cxiLoadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, dateNF: 'yyyy-mm-dd', defval: '' });
  } else rows = cxiParseDelimited(await file.text());
  // header = first row with 2+ filled cells
  let hi = rows.findIndex(r => r.filter(c => String(c).trim()).length >= 2);
  if (hi < 0) throw new Error('That file looks empty.');
  const headers = rows[hi].map((h, i) => String(h).trim() || ('Column ' + (i + 1)));
  const body = rows.slice(hi + 1).filter(r => r.some(c => String(c).trim()));
  if (!body.length) throw new Error('No data rows found under the headings.');
  return { headers, rows: body.map(r => headers.map((_, i) => String(r[i] == null ? '' : r[i]).trim())) };
}

// Best guess from headings alone — used when ✨ is unavailable
function cxiGuess(headers) {
  const rx = {
    date: /date|when|day|timestamp|time/i, kg: /kg|kilo|weight|grams?\b|\bg\b/i, qty: /qty|quantity|count|number of|how many|^no\.?$|items?$/i,
    outcome: /outcome|result|status|destination|went|fixed|repaired|where|given to/i, stage: /stage|step/i, serial: /serial|s\/n|frame/i,
    brand: /brand|make|manufacturer/i, model: /model/i, source: /donor|source|from|site|supplier/i, sale: /price|sold for|sale|£/i,
    notes: /note|comment/i, item: /item|type|crop|produce|product|category|what|device|object/i, name: /description|desc|name/i,
    bed: /bed|planter|plot|row\s*no/i, batch: /batch/i, harvester: /harvest(er)?\s*(or)?\s*pick|picker/i, packer: /^packer/i, packdate: /pack(ing)?\s*date/i
  };
  const m = {}, used = new Set();
  ['date', 'serial', 'brand', 'model', 'kg', 'qty', 'sale', 'outcome', 'stage', 'source', 'notes', 'item', 'bed', 'batch', 'harvester', 'packer', 'packdate', 'name'].forEach(f => {
    const h = headers.find(x => !used.has(x) && rx[f].test(x));
    if (h) { m[f] = h; used.add(h); }
  });
  return m;
}
function cxiDistinct(col, cap) {
  const i = CXI.headers.indexOf(col); if (i < 0) return [];
  const seen = new Map();
  CXI.rows.forEach(r => { const v = r[i]; if (v && !seen.has(v.toLowerCase())) seen.set(v.toLowerCase(), v); });
  return Array.from(seen.values()).slice(0, cap || 80);
}
function cxiMatch(list, raw) {
  const v = String(raw || '').trim().toLowerCase(); if (!v) return '';
  const exact = list.find(x => x.label.toLowerCase() === v || x.key === v);
  if (exact) return exact.key;
  const part = list.find(x => v.includes(x.label.toLowerCase()) || x.label.toLowerCase().includes(v));
  return part ? part.key : '';
}

async function cxImportRead() {
  const f = $('cxi-file').files && $('cxi-file').files[0];
  const msg = $('cxi-msg'), btn = $('cxi-go');
  if (!f) { msg.textContent = 'Choose a file first.'; return; }
  btn.disabled = true; btn.textContent = 'Reading…';
  try {
    const { headers, rows } = await cxiReadFile(f);
    Object.assign(CXI, { file: f.name, headers, rows, act: cxAct($('cxi-act').value), link: $('cxi-link') ? $('cxi-link').checked : false, batch: null });
    const act = CXI.act, tracked = circMode(act) === 'tracked';
    CXI.map = cxiGuess(headers); CXI.vals = { item: {}, outcome: {}, stage: {} }; CXI.gUnit = 'kg';
    CXI.defOut = '';
    msg.textContent = '✨ Working out the columns…';
    try {
      const cols = headers.map((h, i) => {
        const vals = cxiDistinct(h, 12);
        return '"' + h + '": ' + JSON.stringify(vals);
      }).join('\n');
      const j = await vAI('You map a charity\'s spreadsheet to their records. Reply with JSON only. Never invent values.',
        'Activity: ' + act.name + ' (' + (tracked ? 'each item tracked' : 'quick tally') + ')\n' +
        'Item list: ' + (act.item_types || []).map(t => t.key + ' = ' + t.label + ' (' + (cxPerKg(t) ? 'weighed' : 'counted') + ')').join('; ') + '\n' +
        'Destinations: ' + (act.outcomes || []).map(o => o.key + ' = ' + o.label).join('; ') + '\n' +
        (tracked ? 'Steps: ' + (act.stages || []).map(s => s.key + ' = ' + s.label).join('; ') + '\n' : '') +
        'Columns with sample values:\n' + cols + '\n\n' +
        'Return {"columns": {' + CXI_FIELDS.map(x => '"' + x[0] + '": exact column heading or ""').join(', ') + '}, "weight_unit": "kg" or "g"}. ' +
        'item = what the thing is (crop, device, item type). outcome = where it went or the repair result. kg = weight. qty = number of items. Leave a field "" if no column fits.', 700);
      const c = j.columns || {};
      const m = {};
      Object.keys(c).forEach(k => { if (c[k] && headers.includes(c[k])) m[k] = c[k]; });
      if (Object.keys(m).length) CXI.map = m;
      if (j.weight_unit === 'g') CXI.gUnit = 'g';
      // Value matching for item and outcome columns
      const itemVals = CXI.map.item ? cxiDistinct(CXI.map.item, 120) : [];
      const outVals = CXI.map.outcome ? cxiDistinct(CXI.map.outcome, 60) : [];
      const stVals = tracked && CXI.map.stage ? cxiDistinct(CXI.map.stage, 40) : [];
      if (itemVals.length || outVals.length || stVals.length) {
        const v = await vAI('You match spreadsheet values to a charity\'s lists. Reply with JSON only.',
          'Item list: ' + (act.item_types || []).map(t => t.key + ' = ' + t.label).join('; ') + '\nDestinations: ' + (act.outcomes || []).map(o => o.key + ' = ' + o.label + ' (' + o.type + ')').join('; ') +
          (tracked ? '\nSteps: ' + (act.stages || []).map(s => s.key + ' = ' + s.label).join('; ') : '') +
          '\nItem values: ' + JSON.stringify(itemVals) + '\nOutcome values: ' + JSON.stringify(outVals) + (stVals.length ? '\nStep values: ' + JSON.stringify(stVals) : '') +
          '\nReturn {"item": {value: key, or "NEW:Tidy name" if nothing on the list fits}, "outcome": {value: key or ""}, "stage": {value: key or ""}}. ' +
          'Merge spelling variants and plurals onto the same key (e.g. "tomato", "Tomatoes ") . For repair results, yes/fixed/repaired → the fixed key, no/not fixed → the not fixable key.', 1500);
        CXI.vals = { item: v.item || {}, outcome: v.outcome || {}, stage: v.stage || {} };
      }
    } catch (e) {
      msg.textContent = '✨ unavailable (' + e.message + ') — using a best guess from the headings.';
    }
    cxiPickDateCol();
    cxImportPreview();
  } catch (e) { msg.textContent = e.message || String(e); btn.disabled = false; btn.textContent = 'Read file'; }
}

// Dates: UK order unless the column proves otherwise (a first part over 12
// means day-first, a second part over 12 means month-first). Excel serials ok.
function cxiDateOrder(values) {
  let dmy = false, mdy = false;
  values.forEach(v => { const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.]\d{2,4}/.exec(String(v || '').trim()); if (m) { if (+m[1] > 12) dmy = true; if (+m[2] > 12) mdy = true; } });
  return mdy && !dmy ? 'mdy' : 'dmy';
}
function cxiDate(v, order) {
  const s = String(v || '').trim(); if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  if (/^\d{5}(\.\d+)?$/.test(s)) { const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(+s) * 864e5); return d.toISOString().slice(0, 10); }
  m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})/.exec(s);
  if (m) {
    const a = +m[1], b = +m[2]; const y = m[3].length === 2 ? '20' + m[3] : m[3];
    let day = order === 'mdy' ? b : a, mon = order === 'mdy' ? a : b;
    if (mon > 12 && day <= 12) { const t = day; day = mon; mon = t; }
    if (mon < 1 || mon > 12 || day < 1 || day > 31) return null;
    return y + '-' + String(mon).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }
  const d = new Date(s);
  return !isNaN(d) && /\d{4}/.test(s) ? d.toISOString().slice(0, 10) : null;
}
function cxiNum(v) { const n = parseFloat(String(v || '').replace(/,/g, '').replace(/[^0-9.\-]/g, '')); return isNaN(n) ? null : n; }
function cxiFp(actId, date, type, kg, qty, dest, serial) {
  return [actId, date || '', type || '', Math.round((+kg || 0) * 100) / 100, +qty || 1, dest || '', (serial || '').toLowerCase()].join('|');
}
// "Tomato", "tomatoes ", "TOMATOES" → one key
function cxiNorm(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/(ies)$/, 'y').replace(/(oes|ses|xes)$/, m => m.slice(0, -2)).replace(/([^s])s$/, '$1'); }

// The date column is the one whose values read as dates most often
function cxiPickDateCol() {
  let best = CXI.map.date || '', bestRate = -1;
  CXI.headers.forEach((h, i) => {
    const vals = CXI.rows.map(r => r[i]).filter(Boolean);
    if (!vals.length) return;
    const ord = cxiDateOrder(vals);
    const rate = vals.filter(v => /^\d{4}-\d|^\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{2,4}|^\d{5}(\.\d+)?$/.test(String(v).trim()) && cxiDate(v, ord)).length / vals.length;
    const bonus = h === CXI.map.date ? 0.05 : 0;
    if (rate + bonus > bestRate && rate >= 0.6) { bestRate = rate + bonus; best = h; }
  });
  if (best) CXI.map.date = best;
}

// IMPORT EVERYTHING, TIDY AFTERWARDS — the same rule as the event importer.
// Only completely empty rows and rows already in Vorlana are left out.
// Gaps are filled sensibly and listed by row number so they can be tidied.
function cxiBuild() {
  const act = CXI.act, tracked = circMode(act) === 'tracked', col = f => CXI.headers.indexOf(CXI.map[f] || '');
  const ci = {}; CXI_FIELDS.forEach(f => { ci[f[0]] = col(f[0]); });
  const types = act.item_types || [];
  const newTypes = {}, out = [], notes = [], left = [];
  const note = (row, why) => notes.push({ row, why });
  const byDate = {};
  (DB.events || []).forEach(e => { const d = String(e.date || '').slice(0, 10); (byDate[d] = byDate[d] || []).push(e); });
  const order = ci.date >= 0 ? cxiDateOrder(CXI.rows.map(r => r[ci.date])) : 'dmy';
  const today = new Date().toISOString().slice(0, 10);
  const have = {};
  CX.items.filter(i => i.activity_id === act.id).forEach(i => {
    const fp = (i.custom && i.custom.fp) || cxiFp(act.id, String(i.outcome_at || i.created_at || '').slice(0, 10), i.item_type, i.weight_kg, i.quantity, i.outcome || i.stage, i.serial);
    have[fp] = (have[fp] || 0) + 1;
  });
  const seen = {};
  let dupes = 0, empty = 0, lastDate = null;
  const c = { noDate: 0, noItem: 0, noWeight: 0, noDest: 0, badDate: 0 };
  const findType = raw => {
    const mv = CXI.vals.item[raw] || CXI.vals.item[String(raw).trim()];
    if (mv && String(mv).indexOf('NEW:') !== 0 && types.some(t => t.key === mv)) return { t: types.find(t => t.key === mv) };
    const n = cxiNorm(raw);
    const hit = types.find(t => cxiNorm(t.label) === n) || (n.length > 3 && types.find(t => cxiNorm(t.label).includes(n) || n.includes(cxiNorm(t.label))));
    if (hit) return { t: hit };
    const label = (mv && String(mv).indexOf('NEW:') === 0 ? String(mv).slice(4) : String(raw)).trim().replace(/\s+/g, ' ').replace(/^./, x => x.toUpperCase());
    return { newLabel: label, nk: cxiNorm(label) };
  };
  CXI.rows.forEach((r, idx) => {
    const rowNo = idx + 2;   // row 1 is the headings
    const g = k => ci[k] >= 0 ? String(r[ci[k]] || '').trim() : '';
    const rawItem = g('item'), rawKg = g('kg'), rawQty = g('qty'), rawOut = g('outcome'), rawSt = g('stage');
    if (!rawItem && !rawKg && !rawQty && !rawOut && !rawSt && !g('name') && !g('serial')) { empty++; return; }

    // item — never dropped: unknown becomes "Not recorded"
    let t;
    if (rawItem) {
      const f = findType(rawItem);
      if (f.t) t = f.t;
      else {
        const hasKg = ci.kg >= 0 && cxiNum(rawKg) != null;
        t = newTypes[f.nk] || (newTypes[f.nk] = { key: _circSlug(f.newLabel) + '_' + Math.random().toString(36).slice(2, 5), label: f.newLabel, unit: hasKg && ci.qty < 0 ? 'kg' : 'each', weight_kg: 1, co2e_kg: 0, value_gbp: 0, source: 'Set by organisation', _new: true });
      }
    } else if (types.length === 1 && ci.item < 0) t = types[0];
    else {
      const nr = types.find(x => cxiNorm(x.label) === 'not recorded');
      t = nr || newTypes['not recorded'] || (newTypes['not recorded'] = { key: 'not_recorded', label: 'Not recorded', unit: ci.kg >= 0 ? 'kg' : 'each', weight_kg: ci.kg >= 0 ? 1 : 0, co2e_kg: 0, value_gbp: 0, source: 'Set by organisation', _new: true });
      c.noItem++; note(rowNo, 'no item — imported as "Not recorded"');
    }

    // amounts — never estimated: a missing weight is imported as 0 kg and listed
    let kg = cxiNum(rawKg); if (kg != null && CXI.gUnit === 'g') kg = kg / 1000;
    let qty = cxiNum(rawQty);
    const perKg = t.unit === 'kg' || (t.unit !== 'each' && /per\s*kg/i.test(t.label));
    let noWeight = false;
    if (perKg) { qty = 1; if (kg == null || kg < 0) { kg = 0; noWeight = true; c.noWeight++; note(rowNo, 'no weight — imported as 0 kg'); } }
    else { qty = Math.max(1, Math.round(qty || 1)); if (kg == null || kg <= 0) kg = +((+t.weight_kg || 0) * qty).toFixed(2); }

    // destination / step — undecided rows are imported and left to tidy
    let okey = '', skey = '';
    if (rawOut) { const v = CXI.vals.outcome[rawOut]; okey = v && cxOutcome(act, v) ? v : cxiMatch(act.outcomes || [], rawOut); }
    if (tracked && rawSt) { const v = CXI.vals.stage[rawSt]; skey = v && cxStage(act, v) ? v : cxiMatch(act.stages || [], rawSt); }
    if (!okey && !tracked && CXI.defOut) okey = CXI.defOut;
    if (!okey && !skey && tracked) skey = CXI.defStage || ((act.stages || [])[0] || {}).key || '';
    if (!okey && !skey) { c.noDest++; note(rowNo, (rawOut ? '"' + rawOut + '" not matched' : 'no destination') + ' — imported as undecided'); }

    // date — missing takes the row above's, then today
    let date = ci.date >= 0 ? cxiDate(g('date'), order) : null;
    if (!date) {
      if (ci.date >= 0) { if (g('date')) { c.badDate++; note(rowNo, 'date "' + g('date') + '" not understood — used ' + (lastDate ? 'the row above\'s' : 'today')); } else { c.noDate++; note(rowNo, 'no date — used ' + (lastDate ? 'the row above\'s' : 'today')); } }
      date = lastDate || today;
    } else lastDate = date;

    const fp = cxiFp(act.id, date, t.key, kg, qty, okey || skey, g('serial'));
    seen[fp] = (seen[fp] || 0) + 1;
    if (seen[fp] <= (have[fp] || 0)) { dupes++; left.push({ row: rowNo, why: 'already in Vorlana' }); return; }
    let event_id = null;
    if (CXI.link && byDate[date] && byDate[date].length === 1) event_id = String(byDate[date][0].id);
    out.push({ t, kg, qty, okey, skey, date, event_id, fp, noWeight, name: g('name'), brand: g('brand'), model: g('model'), serial: g('serial'), source: g('source'), sale: cxiNum(g('sale')), notes: g('notes'), row: rowNo, rawOut,
      bed: g('bed'), batch: g('batch'), harvester: g('harvester'), packer: g('packer'), packdate: ci.packdate >= 0 ? cxiDate(g('packdate'), order) : '' });
  });
  return { entries: out, notes, left, dupes, empty, counts: c, newTypes: Object.values(newTypes) };
}

function cxImportPreview() {
  const act = CXI.act, tracked = circMode(act) === 'tracked';
  const p = CXI.plan = cxiBuild();
  const e = cxE;
  const kg = p.entries.reduce((a, x) => a + (+x.kg || 0), 0);
  const byItem = {}, byDest = {};
  p.entries.forEach(x => { byItem[x.t.label] = (byItem[x.t.label] || 0) + (+x.kg || 0); const d = cxOutcome(act, x.okey) || cxStage(act, x.skey); const l = d ? d.label : '—'; byDest[l] = (byDest[l] || 0) + 1; });
  const linked = p.entries.filter(x => x.event_id).length;
  const dates = p.entries.map(x => x.date).filter(Boolean).sort();
  const cn = p.counts;
  const gapTxt = [cn.noDest ? cn.noDest + ' undecided destination' : '', cn.noWeight ? cn.noWeight + ' with no weight' : '', cn.noItem ? cn.noItem + ' with no item' : '', (cn.noDate + cn.badDate) ? (cn.noDate + cn.badDate) + ' with a missing or unclear date' : ''].filter(Boolean).join(', ');
  const colSel = f => '<select onchange="CXI.map[\'' + f + '\']=this.value;cxImportPreview()" style="padding:5px 8px;font-size:12px"><option value="">—</option>' +
    CXI.headers.map(h => '<option' + (CXI.map[f] === h ? ' selected' : '') + '>' + e(h) + '</option>').join('') + '</select>';
  const shown = CXI_FIELDS.filter(f => (tracked || f[0] !== 'stage'));
  cxModal('<h2>Check before importing</h2>' +
    '<div class="cxp-s" style="margin-bottom:12px">' + e(CXI.file) + ' · ' + CXI.rows.length + ' rows · into ' + e(act.icon + ' ' + act.name) + '</div>' +
    '<div class="stats-grid" style="margin-bottom:12px">' +
      statCard('Rows to import', p.entries.length, 'of ' + CXI.rows.length + ' in the file') +
      statCard('Total weight', cxFmt(kg, 1) + ' kg') +
      statCard('Already in Vorlana', p.dupes, 'skipped') +
      (dates.length ? statCard('Dates', new Date(dates[0]).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }), 'to ' + new Date(dates[dates.length - 1]).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })) : '') +
    '</div>' +
    (gapTxt ? '<div class="cxp-warn">Every row is imported. To tidy afterwards: ' + e(gapTxt) + '.</div>' : '') +
    (p.empty ? '<div class="cxp-s" style="margin-bottom:8px">' + p.empty + ' completely empty row' + (p.empty === 1 ? '' : 's') + ' ignored.</div>' : '') +
    (!CXI.map.date ? '<div class="cxp-warn">No date column found — entries will be dated today. Pick the date column below if there is one.</div>' : '') +
    (p.newTypes.length ? '<div class="cxq-status">New on your list: ' + p.newTypes.map(t => '<b>' + e(t.label) + '</b> <small>(' + (t.unit === 'kg' ? 'weighed' : 'counted') + ')</small>').join(', ') + '</div>' : '') +
    (CXI.link && (DB.events || []).length ? '<div class="cxp-s" style="margin-bottom:10px">' + linked + ' of ' + p.entries.length + ' linked to a session on the same date.</div>' : '') +
    (!tracked ? '<div class="form-row"><label>Rows with no destination</label><select onchange="CXI.defOut=this.value;cxImportPreview()"><option value="">Import as undecided — tidy later</option>' +
      (act.outcomes || []).map(o => '<option value="' + e(o.key) + '"' + (o.key === CXI.defOut ? ' selected' : '') + '>' + e(o.label) + '</option>').join('') + '</select></div>' : '') +
    (tracked ? '<div class="form-row"><label>Rows with no step — import into</label><select onchange="CXI.defStage=this.value;cxImportPreview()">' +
      (act.stages || []).map(st => '<option value="' + e(st.key) + '"' + (st.key === (CXI.defStage || (act.stages[0] || {}).key) ? ' selected' : '') + '>' + e(st.label) + '</option>').join('') + '</select></div>' : '') +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">' +
      '<div><div class="cxq-lbl">By item</div>' + Object.keys(byItem).sort((a, b) => byItem[b] - byItem[a]).slice(0, 8).map(k => '<div class="cxp-list-row" style="padding:4px 0"><span class="cxp-s">' + e(k) + '</span><span class="cxp-s">' + cxFmt(byItem[k], 1) + ' kg</span></div>').join('') + '</div>' +
      '<div><div class="cxq-lbl">By destination</div>' + Object.keys(byDest).map(k => '<div class="cxp-list-row" style="padding:4px 0"><span class="cxp-s">' + e(k) + '</span><span class="cxp-s">' + byDest[k] + '</span></div>').join('') + '</div>' +
    '</div>' +
    (p.notes.length || p.left.length ? '<details style="margin-bottom:10px"><summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--txt2)">Show ' + (p.notes.length + p.left.length) + ' row note' + (p.notes.length + p.left.length === 1 ? '' : 's') + '</summary>' +
      '<div class="cxp-s" style="max-height:180px;overflow:auto;margin-top:6px;line-height:1.7">' + p.notes.concat(p.left).sort((x, y) => x.row - y.row).slice(0, 200).map(n => 'Row ' + n.row + ' — ' + e(n.why)).join('<br>') + '</div></details>' : '') +
    '<details><summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--txt2);margin-bottom:8px">Columns used (change if ✨ got one wrong)</summary>' +
      '<div style="display:grid;grid-template-columns:130px 1fr;gap:6px 10px;align-items:center;font-size:12px">' + shown.map(f => '<span>' + f[1] + '</span>' + colSel(f[0])).join('') + '</div>' +
      '<div style="margin-top:8px;font-size:12px">Weight column is in <select onchange="CXI.gUnit=this.value;cxImportPreview()" style="width:auto;padding:4px 8px;font-size:12px"><option value="kg"' + (CXI.gUnit === 'kg' ? ' selected' : '') + '>kg</option><option value="g"' + (CXI.gUnit === 'g' ? ' selected' : '') + '>grams</option></select></div>' +
    '</details>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="cxCloseModal()">Cancel</button>' +
      '<button class="btn btn-p" id="cxi-save" onclick="cxImportSave()"' + (p.entries.length ? '' : ' disabled') + '>Import ' + p.entries.length + ' rows</button></div>', 640);
}

async function cxImportSave() {
  const act = CXI.act, p = CXI.plan; if (!p || !p.entries.length) return;
  const btn = $('cxi-save'); btn.disabled = true;
  const batch = 'imp_' + Date.now().toString(36);
  try {
    if (p.newTypes.length) {
      btn.textContent = 'Adding new items…';
      const types = (act.item_types || []).concat(p.newTypes.map(t => { const c = Object.assign({}, t); delete c._new; return c; }));
      const { error } = await cxFrom('circular_activities').update({ item_types: types }).eq('id', act.id);
      if (error) throw error;
      act.item_types = types;
    }
    const rows = p.entries.map(x => {
      const at = x.date ? x.date + 'T12:00:00Z' : new Date().toISOString();
      const f = cxCalc(act, x.t.key, x.qty, x.kg);
      const o = x.okey ? cxOutcome(act, x.okey) : null, st = x.skey ? cxStage(act, x.skey) : null;
      const custom = { import_batch: batch, fp: x.fp };
      if (x.notes) custom.note = x.notes;
      if (x.sale) custom.sale_gbp = x.sale;
      if (x.noWeight) custom.no_weight = true;
      if (x.rawOut && !x.okey) custom.raw_outcome = x.rawOut;
      if (x.bed) custom.bed_planter = x.bed;
      if (x.batch) custom.batch_number = x.batch;
      if (x.harvester) custom.harvester = x.harvester;
      if (x.packer) custom.packer = x.packer;
      if (x.packdate) custom.packing_date = x.packdate;
      custom.import_row = x.row;
      return {
        org_id: orgId, activity_id: act.id, item_type: x.t.key, name: x.name || x.t.label, category: act.name,
        quantity: x.qty, weight_kg: x.kg, co2e_kg: f.co2, value_gbp: f.value,
        brand: x.brand || null, model: x.model || null, serial: x.serial || null, source: x.source || null, event_id: x.event_id,
        stage: o ? null : (st ? st.key : null), outcome: o ? o.key : null, outcome_type: o ? o.type : null, outcome_at: o ? at : null,
        status: o ? o.label : (st ? st.label : ''), custom, created_at: at, updated_at: at
      };
    });
    const saved = [];
    for (let i = 0; i < rows.length; i += 250) {
      btn.textContent = 'Saving ' + Math.min(i + 250, rows.length) + ' of ' + rows.length + '…';
      const { data, error } = await cxFrom('circular_items').insert(rows.slice(i, i + 250)).select();
      if (error) throw error;
      saved.push(...(data || []));
    }
    // One custody-log entry per item, in bulk
    for (let i = 0; i < saved.length; i += 250) {
      await cxFrom('circular_item_events').insert(saved.slice(i, i + 250).map(it => ({
        org_id: orgId, item_id: String(it.id), activity_id: act.id, action: 'imported', to_stage: it.outcome || it.stage,
        data: { file: CXI.file, import_batch: batch }, actor_name: cxActorName()
      })));
    }
    CX.items = saved.concat(CX.items);
    CXI.batch = batch;
    if (typeof CXR !== 'undefined') CXR.at = 0;
    cxModal('<h2>✓ Imported</h2><div style="font-size:14px;margin-bottom:10px">' + saved.length + ' entries added to ' + cxE(act.icon + ' ' + act.name) + '.</div>' +
      '<div class="cxp-s">They now count in the Circular page, Social Impact and every funder report for their dates.</div>' +
      '<div class="modal-footer"><button class="btn btn-ghost" style="color:var(--red);margin-right:auto" onclick="cxImportUndo(\'' + batch + '\')">Undo this import</button><button class="btn btn-p" onclick="cxCloseModal();CX.tab=\'' + act.id + '\';cxDraw()">Done</button></div>');
  } catch (e) {
    alert('Import stopped: ' + (e.message || e) + (CXI.batch ? '' : '\nAnything saved so far can be removed with Undo.'));
    cxImportUndoOffer(batch);
  }
}
function cxImportUndoOffer(batch) {
  cxModal('<h2>Import did not finish</h2><div class="cxp-s">Remove the rows that were saved, then try again.</div><div class="modal-footer"><button class="btn btn-p" onclick="cxImportUndo(\'' + batch + '\')">Remove saved rows</button></div>');
}
async function cxImportUndo(batch) {
  if (!confirm('Remove every entry from this import?')) return;
  const { error } = await cxFrom('circular_items').delete().eq('org_id', orgId).eq('custom->>import_batch', batch);
  if (error) { alert('Could not undo: ' + error.message); return; }
  CX.items = CX.items.filter(i => !(i.custom && i.custom.import_batch === batch));
  if (typeof CXR !== 'undefined') CXR.at = 0;
  cxCloseModal(); cxDraw();
}

// ── Sort undecided entries in bulk ───────────────────────────
// Imported or quick-logged entries with no destination aren't counted
// in reports. Grouped by item and by what the file said, one choice
// per group — dates stay as logged.
let _cxTidy = null;
// One click: switches a wrongly-tracked activity to quick tally, then opens
// the backlog pre-set to its one most common outcome, so it's a single confirm.
async function cxFixActivity(actId) {
  const act = cxAct(actId); if (!act) return;
  try {
    const { error } = await cxFrom('circular_activities').update({ mode: 'tally' }).eq('id', act.id);
    if (error) throw error;
    act.mode = 'tally';
  } catch (e) { alert('Could not switch the activity: ' + (e.message || e)); return; }
  cxTidyOpen(actId, true);
}

function cxTidyOpen(actId, quick) {
  const act = cxAct(actId); if (!act) return;
  const open = CX.items.filter(i => i.activity_id === actId && !i.outcome_type);
  if (!open.length) return;
  const groups = {};
  open.forEach(i => {
    const raw = (i.custom && i.custom.raw_outcome) || '';
    const k = (i.item_type || '') + '|' + raw.toLowerCase();
    const g = groups[k] || (groups[k] = { key: k, type: i.item_type, raw, ids: [], kg: 0, qty: 0, pick: '' });
    g.ids.push(i.id); g.kg += +i.weight_kg || 0; g.qty += +i.quantity || 1;
  });
  _cxTidy = { act: actId, groups: Object.values(groups).sort((a, b) => b.ids.length - a.ids.length), quick: !!quick };
  // Pre-pick where the file's wording matches a destination
  _cxTidy.groups.forEach(g => { if (g.raw) g.pick = cxiMatch(act.outcomes || [], g.raw) || ''; });
  // "Fix this for me": everything still unpicked defaults to the activity's most-used outcome
  if (quick) {
    const counts = {};
    CX.items.filter(i => i.activity_id === actId && i.outcome_type).forEach(i => { counts[i.outcome] = (counts[i.outcome] || 0) + 1; });
    const common = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0] || (act.outcomes[0] || {}).key;
    _cxTidy.groups.forEach(g => { if (!g.pick) g.pick = common; });
  }
  cxTidyDraw();
}
function cxTidyDraw() {
  const t = _cxTidy, act = cxAct(t.act), e = cxE;
  const opts = sel => '<option value="">Leave for now</option>' + (act.outcomes || []).map(o => '<option value="' + e(o.key) + '"' + (o.key === sel ? ' selected' : '') + '>' + e(o.label) + '</option>').join('');
  const total = t.groups.reduce((a, g) => a + g.ids.length, 0);
  cxModal((t.quick ? '<h2>✓ Switched to quick tally</h2>' : '<h2>Sort ' + total + ' undecided entr' + (total === 1 ? 'y' : 'ies') + '</h2>') +
    '<div class="cxp-s" style="margin-bottom:12px">' + (t.quick
      ? 'New entries will now log in one tap. These ' + total + ' older entries have no outcome — check the guess below, then confirm. Dates stay as they were logged.'
      : 'These have no destination, so reports leave them out. Pick where each group went — dates stay as they were logged.') + '</div>' +
    '<div class="form-row"><label>Quick: set every group to</label><select onchange="_cxTidy.groups.forEach(g=>g.pick=this.value);cxTidyDraw()">' + opts(t.quick ? t.groups[0].pick : '') + '</select></div>' +
    '<div style="max-height:360px;overflow:auto">' + t.groups.map((g, i) => {
      const ty = cxType(act, g.type);
      return '<div class="cxp-list-row"><div style="min-width:0"><div class="cxp-t">' + e(ty ? ty.label : 'Item') + ' · ' + g.ids.length + ' entr' + (g.ids.length === 1 ? 'y' : 'ies') + '</div>' +
        '<div class="cxp-s">' + cxFmt(g.kg, 1) + ' kg' + (g.raw ? ' · file said "' + e(g.raw) + '"' : ' · no destination in the file') + '</div></div>' +
        '<select style="width:auto;max-width:190px" onchange="_cxTidy.groups[' + i + '].pick=this.value">' + opts(g.pick) + '</select></div>';
    }).join('') + '</div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="cxCloseModal()">Cancel</button><button class="btn btn-p" id="cx-tidy-go" onclick="cxTidyApply()">Apply</button></div>', 620);
}
async function cxTidyApply() {
  const t = _cxTidy, act = cxAct(t.act), btn = $('cx-tidy-go');
  const todo = t.groups.filter(g => g.pick);
  if (!todo.length) { cxCloseModal(); return; }
  btn.disabled = true;
  let done = 0;
  try {
    for (const g of todo) {
      const o = cxOutcome(act, g.pick);
      for (let i = 0; i < g.ids.length; i += 200) {
        const ids = g.ids.slice(i, i + 200);
        btn.textContent = 'Saving ' + (done + ids.length) + '…';
        // outcome_at stays empty so reports keep each entry's own logged date
        const { error } = await cxFrom('circular_items').update({ outcome: o.key, outcome_type: o.type, status: o.label, updated_at: new Date().toISOString() }).in('id', ids);
        if (error) throw error;
        await cxFrom('circular_item_events').insert(ids.map(id => ({ org_id: orgId, item_id: String(id), activity_id: act.id, action: 'finished', to_stage: o.key, data: { via: 'sorted in bulk' }, actor_name: cxActorName() })));
        CX.items.forEach(it => { if (ids.includes(it.id)) Object.assign(it, { outcome: o.key, outcome_type: o.type, status: o.label }); });
        done += ids.length;
      }
    }
    if (typeof CXR !== 'undefined') CXR.at = 0;
    cxCloseModal(); cxDraw();
  } catch (e) { alert('Stopped after ' + done + ': ' + (e.message || e)); btn.disabled = false; btn.textContent = 'Apply'; }
}

// ── Log / edit item ──────────────────────────────────────────
function cxOpenLog(o) {
  const acts = cxItemActs();
  if (!acts.length) { alert('Add an activity in Settings first.'); return; }
  const edit = o.id ? CX.items.find(i => i.id === o.id) : null;
  const actId = (edit && edit.activity_id) || o.activity_id || (CX.tab !== 'all' && CX.tab !== 'collections' ? CX.tab : acts[0].id);
  CX.logCtx = { edit, collection_id: o.collection_id || (edit && edit.collection_id) || null, source: o.source || (edit && edit.source) || '' };
  cxModal(
    '<h2>' + (edit ? 'Edit ' + cxE(edit.passport_code) : 'Log item') + '</h2>' +
    (edit ? '' : '<div style="margin-bottom:12px"><button class="btn btn-ghost btn-sm" onclick="$(\'cx-photo\').click()">📷 Identify from photo</button>' +
      '<input type="file" id="cx-photo" accept="image/*" capture="environment" style="display:none" onchange="cxPhoto(event)"/>' +
      '<span id="cx-photo-status" class="cxp-s" style="margin-left:8px"></span></div>') +
    '<div class="form-grid-2">' +
      '<div class="form-row"><label>Activity</label><select id="cx-act" onchange="cxLogFill()">' +
        acts.map(a => '<option value="' + a.id + '" ' + (a.id === actId ? 'selected' : '') + '>' + cxE(a.icon + ' ' + a.name) + '</option>').join('') + '</select></div>' +
      '<div class="form-row"><label>Item type</label><select id="cx-type" onchange="cxLogType()"></select></div>' +
    '</div>' +
    '<div class="form-row"><label>Name / description</label><input id="cx-name" placeholder="Left blank = item type"/></div>' +
    '<div class="form-grid-2">' +
      '<div class="form-row" id="cx-qty-row"><label>Quantity</label><input id="cx-qty" type="number" min="1" step="1" value="1" oninput="cxLogType(true)"/></div>' +
      '<div class="form-row"><label id="cx-kg-lbl">Weight (kg)</label><input id="cx-kg" type="number" min="0" step="0.1"/></div>' +
    '</div>' +
    '<div class="form-grid-2">' +
      '<div class="form-row"><label>Stage</label><select id="cx-stage"></select></div>' +
      '<div class="form-row"><label>Source / donor</label><input id="cx-source" placeholder="e.g. WLWA Southall site"/></div>' +
    '</div>' +
    ((DB.events || []).length ? '<div class="form-row"><label>Session</label><select id="cx-event">' + cxSessionOptions(edit ? edit.event_id : (CX.q[actId] && CX.q[actId].event != null ? CX.q[actId].event : cxDefaultSession())) + '</select></div>' : '') +
    '<details id="cx-more"><summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--txt2);margin-bottom:10px">Brand, model, serial</summary>' +
      '<div class="form-grid-2"><div class="form-row"><label>Brand</label><input id="cx-brand"/></div><div class="form-row"><label>Model</label><input id="cx-model"/></div></div>' +
      '<div class="form-row"><label>Serial / frame number</label><input id="cx-serial"/></div>' +
    '</details>' +
    '<div id="cx-fields"></div>' +
    '<div class="cxp-s" id="cx-factors" style="margin-top:6px"></div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="cxCloseModal()">Cancel</button>' +
      '<button class="btn btn-p" id="cx-save" onclick="cxSaveItem()">' + (edit ? 'Save' : 'Log item') + '</button></div>'
  );
  cxLogFill(o.stage);
  if (edit) {
    $('cx-type').value = edit.item_type || '';
    $('cx-name').value = edit.name || '';
    $('cx-qty').value = edit.quantity || 1;
    $('cx-kg').value = edit.weight_kg || '';
    $('cx-brand').value = edit.brand || ''; $('cx-model').value = edit.model || ''; $('cx-serial').value = edit.serial || '';
    $('cx-source').value = edit.source || '';
    $('cx-stage').value = edit.stage || ''; $('cx-stage').disabled = true;
    $('cx-act').disabled = true;
    cxLogType(true, true);
    const act = cxAct(edit.activity_id);
    (act.fields || []).forEach(f => { const el = $('cx-f-' + f.key); if (!el) return; const v = (edit.custom || {})[f.key]; if (f.type === 'yesno') el.value = v === true ? 'yes' : v === false ? 'no' : ''; else el.value = v == null ? '' : v; });
    if (edit.brand || edit.model || edit.serial) $('cx-more').open = true;
  } else {
    $('cx-source').value = CX.logCtx.source || '';
  }
}

function cxLogFill(stageKey) {
  const act = cxAct($('cx-act').value); if (!act) return;
  $('cx-type').innerHTML = (act.item_types || []).map(t => '<option value="' + cxE(t.key) + '">' + cxE(t.label) + '</option>').join('') + '<option value="">Other</option>';
  $('cx-stage').innerHTML = (act.stages || []).map(s => '<option value="' + cxE(s.key) + '">' + cxE(s.label) + '</option>').join('');
  if (stageKey) $('cx-stage').value = stageKey;
  $('cx-fields').innerHTML = (act.fields || []).map(f => {
    const id = 'cx-f-' + f.key;
    const input = f.type === 'yesno' ? '<select id="' + id + '"><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select>'
      : '<input id="' + id + '" type="' + (f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text') + '"/>';
    return '<div class="form-row"><label>' + cxE(f.label) + '</label>' + input + '</div>';
  }).join('');
  const noSerial = ['food', 'growing', 'textiles', 'scrap_store'].includes(act.template);
  $('cx-more').style.display = noSerial ? 'none' : '';
  cxLogType();
}

function cxLogType(keepKg, silent) {
  const act = cxAct($('cx-act').value); const t = cxType(act, $('cx-type').value);
  const perKg = cxPerKg(t);
  $('cx-qty-row').style.display = perKg ? 'none' : '';
  $('cx-kg-lbl').textContent = perKg ? 'Weight (kg)' : 'Total weight (kg)';
  if (!keepKg || !perKg) {
    if (t && !perKg && !silent) $('cx-kg').value = +((+t.weight_kg || 0) * (+$('cx-qty').value || 1)).toFixed(2);
    if (t && perKg && !keepKg) $('cx-kg').value = '';
  }
  $('cx-factors').textContent = t ? (perKg ? 'Per kg: ' : 'Each: ') + (+t.co2e_kg || 0) + ' kg CO₂e · £' + (+t.value_gbp || 0) + ' value · ' + (t.source || '') : 'Other: no CO₂e or value counted.';
}

function cxCalc(act, typeKey, qty, kg) {
  const t = cxType(act, typeKey);
  if (!t) return { co2: 0, value: 0 };
  if (cxPerKg(t)) return { co2: +(kg * (+t.co2e_kg || 0)).toFixed(2), value: +(kg * (+t.value_gbp || 0)).toFixed(2) };
  return { co2: +(qty * (+t.co2e_kg || 0)).toFixed(2), value: +(qty * (+t.value_gbp || 0)).toFixed(2) };
}

async function cxSaveItem() {
  const btn = $('cx-save'); btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const edit = CX.logCtx.edit;
    const act = cxAct($('cx-act').value);
    const typeKey = $('cx-type').value;
    const t = cxType(act, typeKey);
    const perKg = cxPerKg(t);
    const qty = perKg ? 1 : Math.max(1, Math.round(+$('cx-qty').value || 1));
    const kg = +$('cx-kg').value || 0;
    if (perKg && !kg) throw new Error('Enter the weight in kg');
    const custom = Object.assign({}, edit ? edit.custom : {});
    (act.fields || []).forEach(f => {
      const el = $('cx-f-' + f.key); if (!el) return;
      let v = el.value;
      if (f.type === 'yesno') v = v === 'yes' ? true : v === 'no' ? false : null;
      else if (f.type === 'number') v = v === '' ? null : +v;
      if (v === '' || v == null) delete custom[f.key]; else custom[f.key] = v;
    });
    const f = cxCalc(act, typeKey, qty, kg);
    const stageKey = $('cx-stage').value;
    const d = {
      activity_id: act.id, item_type: typeKey || null,
      name: $('cx-name').value.trim() || (t ? t.label.replace(/\s*\(per kg\)/i, '') : 'Item'),
      category: act.name, quantity: qty, weight_kg: kg, co2e_kg: f.co2, value_gbp: f.value,
      brand: $('cx-brand').value.trim() || null, model: $('cx-model').value.trim() || null, serial: $('cx-serial').value.trim() || null,
      source: $('cx-source').value.trim() || null, custom, updated_at: new Date().toISOString()
    };
    if ($('cx-event')) d.event_id = $('cx-event').value || null;
    if (edit) {
      const { error } = await cxFrom('circular_items').update(d).eq('id', edit.id);
      if (error) throw error;
      await cxLog(Object.assign({}, edit, d), 'edited', null, null, { name: d.name, weight_kg: kg, quantity: qty, serial: d.serial });
      Object.assign(edit, d);
      cxDraw(); cxOpenItem(edit.id);
    } else {
      d.stage = stageKey; d.status = (cxStage(act, stageKey) || {}).label || '';
      d.collection_id = CX.logCtx.collection_id;
      d.org_id = orgId;
      const { data, error } = await cxFrom('circular_items').insert([d]).select().single();
      if (error) throw error;
      await cxLog(data, CX.logCtx.collection_id ? 'booked_in' : 'logged', null, stageKey,
        { name: d.name, item_type: typeKey, quantity: qty, weight_kg: kg, source: d.source, collection_id: d.collection_id });
      CX.items.unshift(data);
      if (CX.logCtx.collection_id) await cxMarkBookedIn(CX.logCtx.collection_id);
      cxDraw();
      cxOpenItem(data.id, true);
    }
  } catch (e) {
    alert('Could not save: ' + (e.message || e) + (/quantity|column/i.test(e.message || '') ? ' — run circular-migration-v2.sql in Supabase.' : ''));
    btn.disabled = false; btn.textContent = 'Save';
  }
}

// ── AI photo intake ──────────────────────────────────────────
async function cxPhoto(ev) {
  const file = ev.target.files && ev.target.files[0]; if (!file) return;
  const st = $('cx-photo-status'); st.textContent = 'Reading photo…';
  try {
    const b64 = await cxResize(file, 1024, 0.7);
    const act = cxAct($('cx-act').value);
    const types = (act.item_types || []).map(t => t.key + ' = ' + t.label).join('; ');
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch('/api/claude', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': session ? 'Bearer ' + session.access_token : '' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6', max_tokens: 400, purpose: 'circular_intake',
        system: 'You identify donated items for a UK reuse charity from one photo. Reply with JSON only, no other text.',
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text: 'Item types for this activity: ' + (types || 'none') + '.\nReturn {"item_type": one key from the list or "", "name": short description, "brand": "", "model": "", "serial": text read from any label or "", "weight_kg": estimate number, "hazards": e.g. "lithium battery" or "", "condition": short}. Only read serials you can actually see. Never guess a serial.' }
        ] }]
      })
    });
    const data = await res.json();
    if (!res.ok || data.type === 'error') throw new Error((data.error && (data.error.message || data.error)) || 'AI unavailable');
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const j = JSON.parse(text.replace(/```json|```/g, '').trim());
    if (j.item_type && cxType(act, j.item_type)) { $('cx-type').value = j.item_type; cxLogType(); }
    if (j.name) $('cx-name').value = j.name;
    if (j.brand || j.model || j.serial) {
      $('cx-more').open = true;
      if (j.brand) $('cx-brand').value = j.brand;
      if (j.model) $('cx-model').value = j.model;
      if (j.serial) $('cx-serial').value = j.serial;
    }
    if (+j.weight_kg && !$('cx-kg').value) $('cx-kg').value = +j.weight_kg;
    st.innerHTML = '✓ Filled in — check before saving' + (j.hazards ? ' · <strong style="color:var(--red)">⚠ ' + cxE(j.hazards) + '</strong>' : '') + (j.condition ? ' · ' + cxE(j.condition) : '');
  } catch (e) {
    st.textContent = 'Could not read photo: ' + (e.message || e);
  }
}

// Shrinks a photo until it fits the AI request limit (200k chars incl. prompt).
// Starts at max px / quality q, then steps down size and quality.
function cxResize(file, max, q, limit) {
  limit = limit || 140000;
  return new Promise((ok, bad) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let side = Math.min(max, Math.max(img.width, img.height)), quality = q, out = '';
      for (let n = 0; n < 8; n++) {
        const s = side / Math.max(img.width, img.height);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.width * s)); c.height = Math.max(1, Math.round(img.height * s));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        out = c.toDataURL('image/jpeg', quality).split(',')[1];
        if (out.length <= limit) return ok(out);
        if (quality > 0.5) quality = Math.max(0.5, quality - 0.1); else side = Math.round(side * 0.8);
      }
      out.length <= limit ? ok(out) : bad(new Error('Photo is too detailed to send — try again a little further away'));
    };
    img.onerror = () => bad(new Error('Image could not be read. On iPhone, set Camera → Formats → Most Compatible if this keeps happening'));
    img.src = url;
  });
}

// ── Item passport ────────────────────────────────────────────
// One screen per item: where it is, the next step in one tap, how it
// left, and the chain of custody. Anything a step or outcome needs
// (wipe certificate, PAT, who received it, sale price) is asked for
// in a small panel right there — no browser pop-ups.
function cxOpenByCode(code) {
  code = String(code || '').trim().toUpperCase().replace(/^.*#ITEM=/, '');
  const it = CX.items.find(i => (i.passport_code || '').toUpperCase() === code);
  if (it) cxOpenItem(it.id); else { const r = cxSearchItems(code); if (r.length === 1) cxOpenItem(r[0].id); else alert('No item found for ' + code); }
}

// Which step asks for each extra field (set in Settings; sensible defaults)
function cxFieldStage(act, f) {
  if (f.ask_at === '-') return '';
  if (f.ask_at) return f.ask_at;
  const st = act.stages || [];
  const find = rx => (st.find(s => rx.test(s.label)) || {}).key || '';
  const k = (f.key + ' ' + f.label).toLowerCase();
  if (/wipe|erase|data/.test(k)) return find(/wip|eras|data/i);
  if (/pat|test|safety/.test(k)) return find(/test|pat|safety|check/i);
  if (/fire/.test(k)) return find(/check|inspect/i);
  if (/borrow|due/.test(k)) return find(/loan/i);
  if (/frame|serial/.test(k)) return (st[0] || {}).key || '';
  return '';
}
// What an outcome needs to ask for
function cxOutcomeKind(o) {
  if (!o) return '';
  if (/sold|resold|sale/i.test(o.label)) return 'sale';
  if (o.type === 'loan' || /loan/i.test(o.label)) return 'loan';
  if (/donat|rehom|given|gift|shared|food bank|partner/i.test(o.label) || (o.type === 'reuse' && !/swap/i.test(o.label))) return 'recipient';
  return '';
}
function cxPersonName(p) { return ((p.first_name || '') + ' ' + (p.last_name || '')).trim() || 'Unnamed'; }

let _cxPass = null;   // { id, action: {kind:'move'|'finish', key}, recip: 'person'|'org'|'none', personId, channel }

async function cxOpenItem(id, justLogged) {
  const it = CX.items.find(i => String(i.id) === String(id)); if (!it) return;
  if (!_cxPass || _cxPass.id !== it.id) _cxPass = { id: it.id, action: null, recip: 'person', personId: '', channel: '' };
  const act = cxAct(it.activity_id), e = cxE;
  const custom = it.custom || {};
  const t = cxType(act, it.item_type);
  const out = cxOutcome(act, it.outcome);
  const stages = (act && act.stages) || [];
  const idx = stages.findIndex(s => s.key === it.stage);
  const tracked = act && circMode(act) === 'tracked';
  cxInjectPassStyle();

  // Progress rail (tracked) or status line
  const rail = tracked && stages.length
    ? '<div class="pp-rail">' + stages.map((s, i) => '<div class="pp-step ' + (it.outcome_type ? 'done' : i < idx ? 'done' : i === idx ? 'now' : '') + '"><span></span><em>' + e(s.label) + '</em></div>').join('') +
      '<div class="pp-step ' + (it.outcome_type ? 'now' : '') + '"><span></span><em>' + e(out ? out.label : 'Out') + '</em></div></div>'
    : '';

  // Details
  const det = [];
  if (it.brand || it.model) det.push(['Make', [it.brand, it.model].filter(Boolean).join(' ')]);
  if (it.serial) det.push(['Serial', it.serial]);
  det.push(['Weight', cxFmt(it.weight_kg, 1) + ' kg']);
  if (+it.co2e_kg) det.push(['CO₂e', cxFmt(it.co2e_kg, 1) + ' kg']);
  if (+it.value_gbp) det.push(['Value', '£' + cxFmt(it.value_gbp)]);
  if (it.source) det.push(['From', it.source]);
  if (it.event_id && cxSessionLabel(it.event_id)) det.push(['Session', cxSessionLabel(it.event_id)]);
  (act && act.fields || []).forEach(f => { const v = custom[f.key]; if (v != null && v !== '') det.push([f.label, v === true ? 'Yes' : v === false ? 'No' : v]); });
  if (it.recipient_participant_id) { const p = (DB.participants || []).find(x => String(x.id) === String(it.recipient_participant_id)); det.push(['Given to', p ? cxPersonName(p) : 'A person we support']); }
  else if (custom.recipient_org) det.push(['Given to', custom.recipient_org]);
  if (+custom.sale_gbp) det.push(['Sold for', '£' + cxFmt(custom.sale_gbp, 2) + (custom.sale_channel ? ' · ' + custom.sale_channel : '')]);
  if (custom.borrower) det.push(['Borrower', custom.borrower + (custom.due_back ? ' · due ' + new Date(custom.due_back).toLocaleDateString('en-GB') : '')]);

  // Actions
  let actions = '';
  if (act && !it.outcome_type) {
    const next = stages[idx + 1];
    const others = stages.filter((s, i) => i !== idx && (!next || s.key !== next.key));
    actions = '<div class="pp-sec">' +
      (next ? '<button class="pp-next" onclick="cxPassAct(\'move\',\'' + e(next.key) + '\')">Move to ' + e(next.label) + ' →</button>' : '') +
      (others.length ? '<div class="pp-mini">' + (next ? 'or ' : 'Move to ') + others.map(s => '<a href="#" onclick="cxPassAct(\'move\',\'' + e(s.key) + '\');return false">' + e(s.label) + '</a>').join(' · ') + '</div>' : '') +
      '<div class="pp-lbl">' + (tracked ? 'Finished with it?' : 'Where did it go?') + '</div><div class="pp-outs">' +
        (act.outcomes || []).map(o => '<button class="pp-out ' + (_cxPass.action && _cxPass.action.key === o.key ? 'on' : '') + '" onclick="cxPassAct(\'finish\',\'' + e(o.key) + '\')">' + e(o.label) + '</button>').join('') + '</div>' +
      (act.links || []).filter(l => l.on === 'end' && l.to).map(l => { const to = CX.acts.find(a => a.key === l.to); return to && to.template !== 'collections' ? '<div class="pp-mini"><a href="#" onclick="cxPass(\'' + it.id + '\',\'' + to.id + '\');return false">Pass to ' + e(to.icon + ' ' + to.name) + ' →</a></div>' : ''; }).join('') +
      '<div id="pp-panel">' + cxPassPanelHTML(it, act) + '</div></div>';
  } else if (it.outcome_type) {
    actions = '<div class="pp-sec pp-done"><span>✓ ' + e(out ? out.label : it.status) + (it.outcome_at ? ' · ' + new Date(it.outcome_at).toLocaleDateString('en-GB') : '') + '</span>' +
      '<a href="#" onclick="cxReopen(\'' + it.id + '\');return false">Undo</a></div>';
  }

  cxModal(
    (justLogged ? '<div class="pp-ok">✓ Logged — print the label and stick it on the item.</div>' : '') +
    '<div class="pp-head"><div style="min-width:0"><div class="pp-code">' + e(it.passport_code || '') + '</div>' +
      '<div class="pp-name">' + e(it.name) + (+it.quantity > 1 ? ' ×' + cxFmt(it.quantity) : '') + '</div>' +
      '<div class="cxp-s">' + e(act ? act.icon + ' ' + act.name : '') + (t ? ' · ' + e(t.label) : '') + (it.stage && !it.outcome_type ? ' · ' + cxDays(it.updated_at) + ' days at this step' : '') + '</div></div>' +
      '<div class="pp-tools"><button class="btn btn-ghost btn-sm" title="Custody record for this item" onclick="cxCustodyOpen({itemId:\'' + it.id + '\'})">📄</button><button class="btn btn-ghost btn-sm" title="Print label" onclick="cxPrintLabels([\'' + it.id + '\'])">🏷️</button><button class="btn btn-ghost btn-sm" title="Edit details" onclick="cxOpenLog({id:\'' + it.id + '\'})">✎</button><button class="btn btn-ghost btn-sm" title="Close" onclick="cxCloseModal()">✕</button></div></div>' +
    rail + actions +
    '<div class="pp-grid">' + det.map(d => '<div><span>' + e(d[0]) + '</span><b>' + e(d[1]) + '</b></div>').join('') + '</div>' +
    '<details class="pp-hist" id="pp-hist-wrap"><summary id="pp-hist-sum">Chain of custody</summary><div id="cx-hist" class="cxp-s">Loading…</div></details>', 560);

  const { data, error } = await cxFrom('circular_item_events').select('*').eq('org_id', orgId).eq('item_id', String(it.id)).order('id');
  const el = $('cx-hist'); if (!el) return;
  if (error) { el.textContent = 'Could not load history.'; return; }
  const evs = data || [];
  let intact = true;
  evs.forEach((ev, i) => { if (ev.prev_hash !== (i ? evs[i - 1].hash : 'GENESIS')) intact = false; });
  const sum = $('pp-hist-sum');
  if (sum) sum.innerHTML = 'Chain of custody <span style="color:' + (intact ? 'var(--em)' : 'var(--red)') + ';font-weight:700">' + (intact ? '✓ intact' : '⚠ broken') + '</span> · ' + evs.length + ' entr' + (evs.length === 1 ? 'y' : 'ies');
  const lbl = k => { const s = cxStage(act, k) || cxOutcome(act, k); return s ? s.label : (k || ''); };
  el.innerHTML = evs.length ? '<div class="cxp-tl">' + evs.map(ev => {
    const d = ev.data || {};
    const what = ev.action === 'moved' ? e(lbl(ev.from_stage)) + ' → ' + e(lbl(ev.to_stage))
      : ev.action === 'finished' ? 'Finished: ' + e(lbl(ev.to_stage))
      : ev.action === 'reopened' ? 'Reopened'
      : ev.action === 'details' ? 'Details added at ' + e(lbl(ev.to_stage))
      : ev.action === 'passed' ? 'Passed to ' + e(d.to_activity || 'another activity')
      : ev.action === 'booked_in' ? 'Booked in from collection'
      : ev.action === 'imported' ? 'Imported from ' + e(d.file || 'a file')
      : ev.action === 'logged' || ev.action === 'tallied' ? 'Logged' + (ev.to_stage ? ' at ' + e(lbl(ev.to_stage)) : '')
      : e(ev.action);
    const extra = Object.keys(d.fields || {}).map(k => { const f = act && (act.fields || []).find(x => x.key === k); const v = d.fields[k]; return e(f ? f.label : k) + ': ' + e(v === true ? 'Yes' : v === false ? 'No' : v); });
    if (d.recipient) extra.push('to ' + e(d.recipient));
    if (d.sale_gbp) extra.push('£' + cxFmt(d.sale_gbp, 2) + (d.sale_channel ? ' via ' + e(d.sale_channel) : ''));
    if (d.note) extra.push(e(d.note));
    return '<div class="cxp-ev"><div class="cxp-t" style="font-weight:600">' + what + '</div>' +
      '<div class="cxp-s">' + new Date(ev.occurred_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) + (ev.actor_name ? ' · ' + e(ev.actor_name) : '') + (extra.length ? ' · ' + extra.join(' · ') : '') + '</div>' +
      '<div class="cxp-s" style="font-family:ui-monospace,monospace;font-size:10px">#' + e((ev.hash || '').slice(0, 12)) + '</div></div>';
  }).join('') + '</div>' : 'No history recorded yet.';
}

// The panel under the buttons — only shown when a choice needs details
function cxPassPanelHTML(it, act) {
  const a = _cxPass.action; if (!a) return '';
  const e = cxE, custom = it.custom || {};
  let body = '', title = '';
  if (a.kind === 'move') {
    const s = cxStage(act, a.key); title = (a.key === it.stage ? 'Details for ' : 'Move to ') + (s ? s.label : '');
    body = (act.fields || []).filter(f => cxFieldStage(act, f) === a.key).map(f => {
      const id = 'pp-f-' + f.key, v = custom[f.key];
      if (f.type === 'yesno') return '<div class="pp-field"><label>' + e(f.label) + '</label><div class="pp-seg" data-for="' + id + '">' +
        ['Yes', 'No'].map(x => '<button type="button" class="' + ((v === true && x === 'Yes') || (v === false && x === 'No') ? 'on' : '') + '" onclick="this.parentNode.querySelectorAll(\'button\').forEach(b=>b.classList.remove(\'on\'));this.classList.add(\'on\');$(\'' + id + '\').value=\'' + x.toLowerCase() + '\'">' + (x === 'Yes' ? '✓ Pass / Yes' : '✗ Fail / No') + '</button>').join('') +
        '</div><input type="hidden" id="' + id + '" value="' + (v === true ? 'yes' : v === false ? 'no' : '') + '"/></div>';
      return '<div class="pp-field"><label>' + e(f.label) + '</label><input id="' + id + '" type="' + (f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text') + '" value="' + e(v == null ? '' : v) + '"/></div>';
    }).join('');
  } else {
    const o = cxOutcome(act, a.key); title = o ? o.label : '';
    const kind = cxOutcomeKind(o);
    if (kind === 'sale') {
      body = '<div class="pp-field"><label>Price</label><div class="pp-money"><span>£</span><input id="pp-price" type="number" inputmode="decimal" min="0" step="0.01" placeholder="0.00"/></div></div>' +
        '<div class="pp-field"><label>Sold through</label><div class="pp-chips">' + ['Shop', 'Online', 'eBay', 'Marketplace', 'Event', 'Other'].map(c => '<button type="button" class="' + (_cxPass.channel === c ? 'on' : '') + '" onclick="_cxPass.channel=\'' + c + '\';this.parentNode.querySelectorAll(\'button\').forEach(b=>b.classList.remove(\'on\'));this.classList.add(\'on\')">' + c + '</button>').join('') + '</div></div>';
    } else if (kind === 'recipient' || kind === 'loan') {
      const r = _cxPass.recip;
      body = '<div class="pp-field"><label>' + (kind === 'loan' ? 'Borrowed by' : 'Who received it?') + '</label><div class="pp-seg">' +
        [['person', 'Someone we support'], ['org', 'An organisation'], ['none', 'Not recorded']].map(x => '<button type="button" class="' + (r === x[0] ? 'on' : '') + '" onclick="cxPassRecip(\'' + x[0] + '\')">' + x[1] + '</button>').join('') + '</div></div>' +
        (r === 'person' ? '<div class="pp-field" style="position:relative"><input id="pp-person" placeholder="Start typing a name…" autocomplete="off" oninput="cxPersonSearch(this.value)" value="' + e(_cxPass.personId ? cxPersonName((DB.participants || []).find(p => String(p.id) === String(_cxPass.personId)) || {}) : '') + '"/><div id="pp-person-list" class="pp-drop"></div>' +
          '<div class="cxp-s" style="margin-top:4px">Links it to their record, so it shows in their support and outcomes.</div></div>' : '') +
        (r === 'org' ? '<div class="pp-field"><input id="pp-org" list="pp-orgs" placeholder="e.g. Ealing Foodbank"/><datalist id="pp-orgs">' + cxKnownOrgs().map(x => '<option value="' + e(x) + '">').join('') + '</datalist></div>' : '') +
        (kind === 'loan' ? '<div class="pp-field"><label>Due back</label><input id="pp-due" type="date"/></div>' : '');
    }
  }
  return '<div class="pp-panel"><div class="pp-panel-h">' + e(title) + '</div>' + body +
    '<div class="pp-field"><input id="pp-note" placeholder="Note (optional)"/></div>' +
    '<div class="pp-panel-f"><a href="#" onclick="_cxPass.action=null;cxOpenItem(\'' + it.id + '\');return false">Cancel</a><button class="btn btn-p" id="pp-confirm" onclick="cxPassConfirm()">Confirm</button></div></div>';
}
function cxKnownOrgs() {
  const s = new Set();
  CX.items.forEach(i => { if (i.custom && i.custom.recipient_org) s.add(i.custom.recipient_org); });
  (DB.funders || []).forEach(f => f.name && s.add(f.name));
  return Array.from(s).slice(0, 50);
}
function cxPassRecip(r) { _cxPass.recip = r; _cxPass.personId = ''; const it = CX.items.find(i => i.id === _cxPass.id); $('pp-panel').innerHTML = cxPassPanelHTML(it, cxAct(it.activity_id)); }
function cxPersonSearch(q) {
  const box = $('pp-person-list'); if (!box) return;
  _cxPass.personId = '';
  q = String(q || '').toLowerCase().trim();
  if (q.length < 2) { box.innerHTML = ''; return; }
  const hits = (DB.participants || []).filter(p => cxPersonName(p).toLowerCase().includes(q)).slice(0, 6);
  box.innerHTML = hits.length ? hits.map(p => '<div onclick="_cxPass.personId=\'' + cxE(String(p.id)) + '\';$(\'pp-person\').value=this.textContent;$(\'pp-person-list\').innerHTML=\'\'">' + cxE(cxPersonName(p)) + '</div>').join('')
    : '<div class="cxp-s" style="cursor:default">No match — pick "An organisation" or "Not recorded"</div>';
}

// Tap a step or outcome: go straight through when nothing is needed
function cxPassAct(kind, key) {
  const it = CX.items.find(i => i.id === _cxPass.id), act = cxAct(it.activity_id);
  let needs = false;
  if (kind === 'move') needs = (act.fields || []).some(f => cxFieldStage(act, f) === key);
  else needs = !!cxOutcomeKind(cxOutcome(act, key));
  if (!needs) return kind === 'move' ? cxMove(it.id, key) : cxFinish(it.id, key, {});
  _cxPass.action = { kind, key }; _cxPass.recip = 'person'; _cxPass.personId = ''; _cxPass.channel = '';
  cxOpenItem(it.id);
  setTimeout(() => { const f = document.querySelector('#pp-panel input:not([type=hidden])'); if (f) f.focus(); }, 30);
}

async function cxPassConfirm() {
  const it = CX.items.find(i => i.id === _cxPass.id), act = cxAct(it.activity_id), a = _cxPass.action;
  const btn = $('pp-confirm'); if (btn) btn.disabled = true;
  const note = ($('pp-note') || {}).value || '';
  if (a.kind === 'move') {
    const fields = {};
    (act.fields || []).filter(f => cxFieldStage(act, f) === a.key).forEach(f => {
      const el = $('pp-f-' + f.key); if (!el) return;
      let v = el.value;
      if (f.type === 'yesno') v = v === 'yes' ? true : v === 'no' ? false : null;
      else if (f.type === 'number') v = v === '' ? null : +v;
      if (v !== '' && v != null) fields[f.key] = v;
    });
    return cxMove(it.id, a.key, { note, fields });
  }
  const o = cxOutcome(act, a.key), kind = cxOutcomeKind(o), extra = { note };
  if (kind === 'sale') { const p = +(($('pp-price') || {}).value || 0); if (p) extra.sale_gbp = p; if (_cxPass.channel) extra.sale_channel = _cxPass.channel; }
  if (kind === 'recipient' || kind === 'loan') {
    if (_cxPass.recip === 'person') {
      if (!_cxPass.personId && ($('pp-person') || {}).value) { alert('Pick the person from the list, or choose "An organisation" / "Not recorded".'); if (btn) btn.disabled = false; return; }
      if (_cxPass.personId) extra.personId = _cxPass.personId;
    }
    if (_cxPass.recip === 'org') { const v = (($('pp-org') || {}).value || '').trim(); if (v) extra.org = v; }
    if (kind === 'loan' && $('pp-due') && $('pp-due').value) extra.due_back = $('pp-due').value;
  }
  return cxFinish(it.id, a.key, extra);
}

async function cxMove(id, stageKey, opt) {
  opt = opt || {};
  const it = CX.items.find(i => String(i.id) === String(id)); const act = cxAct(it.activity_id);
  const from = it.stage;
  const custom = Object.assign({}, it.custom || {}, opt.fields || {});
  const d = { stage: stageKey, status: (cxStage(act, stageKey) || {}).label || '', custom, updated_at: new Date().toISOString() };
  const { error } = await cxFrom('circular_items').update(d).eq('id', it.id);
  if (error) { alert('Could not move: ' + error.message); return; }
  Object.assign(it, d);
  const data = {}; if (opt.note) data.note = opt.note; if (opt.fields && Object.keys(opt.fields).length) data.fields = opt.fields;
  await cxLog(it, from === stageKey ? 'details' : 'moved', from, stageKey, data);
  _cxPass.action = null;
  cxDraw(); cxOpenItem(it.id);
}

async function cxFinish(id, outKey, extra) {
  extra = extra || {};
  const it = CX.items.find(i => String(i.id) === String(id)); const act = cxAct(it.activity_id);
  const o = cxOutcome(act, outKey);
  const data = {};
  if (extra.note) data.note = extra.note;
  const custom = Object.assign({}, it.custom || {});
  const d = {};
  if (extra.sale_gbp) { custom.sale_gbp = extra.sale_gbp; data.sale_gbp = extra.sale_gbp; }
  if (extra.sale_channel) { custom.sale_channel = extra.sale_channel; data.sale_channel = extra.sale_channel; }
  if (extra.personId) { d.recipient_participant_id = String(extra.personId); const p = (DB.participants || []).find(x => String(x.id) === String(extra.personId)); data.recipient = p ? cxPersonName(p) : 'a person we support'; data.recipient_kind = 'person'; }
  if (extra.org) { custom.recipient_org = extra.org; data.recipient = extra.org; data.recipient_kind = 'org'; }
  if (extra.due_back) { custom.due_back = extra.due_back; data.due_back = extra.due_back; }
  if (extra.personId && cxOutcomeKind(o) === 'loan') { const p = (DB.participants || []).find(x => String(x.id) === String(extra.personId)); if (p) custom.borrower = cxPersonName(p); }
  if (extra.org && cxOutcomeKind(o) === 'loan') custom.borrower = extra.org;
  // Link: this outcome hands the item to another activity
  const link = (act.links || []).find(l => l.on === 'outcome:' + outKey && l.to);
  const to = link && CX.acts.find(a => a.key === link.to && a.template !== 'collections');
  if (to) { await cxLog(it, 'finished', it.stage, outKey, data); _cxPass.action = null; return cxPass(id, to.id, true); }
  Object.assign(d, { outcome: outKey, outcome_type: o.type, outcome_at: new Date().toISOString(), status: o.label, custom, updated_at: new Date().toISOString() });
  const { error } = await cxFrom('circular_items').update(d).eq('id', it.id);
  if (error) { alert('Could not save: ' + error.message); const b = $('pp-confirm'); if (b) b.disabled = false; return; }
  const from = it.stage;
  Object.assign(it, d);
  await cxLog(it, 'finished', from, outKey, data);
  _cxPass.action = null;
  cxDraw(); cxOpenItem(it.id);
}

async function cxReopen(id) {
  const it = CX.items.find(i => String(i.id) === String(id)); if (!it) return;
  const act = cxAct(it.activity_id);
  const custom = Object.assign({}, it.custom || {}); delete custom.sale_gbp; delete custom.sale_channel; delete custom.recipient_org; delete custom.due_back; delete custom.borrower;
  const back = it.stage || ((act.stages || []).slice(-1)[0] || {}).key || null;
  const d = { outcome: null, outcome_type: null, outcome_at: null, recipient_participant_id: null, custom, stage: back, status: (cxStage(act, back) || {}).label || '', updated_at: new Date().toISOString() };
  const { error } = await cxFrom('circular_items').update(d).eq('id', it.id);
  if (error) { alert('Could not undo: ' + error.message); return; }
  const was = it.outcome;
  Object.assign(it, d);
  await cxLog(it, 'reopened', was, back, {});
  cxDraw(); cxOpenItem(it.id);
}

async function cxPass(id, toActId, silent) {
  const it = CX.items.find(i => String(i.id) === String(id)); const to = cxAct(toActId); const fromAct = cxAct(it.activity_id);
  const first = (to.stages || [])[0];
  const t = cxType(to, it.item_type) || (to.item_types || []).find(x => x.label === (cxType(fromAct, it.item_type) || {}).label);
  const f = t ? cxCalc(to, t.key, +it.quantity || 1, +it.weight_kg || 0) : { co2: it.co2e_kg, value: it.value_gbp };
  const d = { activity_id: to.id, category: to.name, stage: first ? first.key : null, status: first ? first.label : '',
    item_type: t ? t.key : it.item_type, co2e_kg: f.co2, value_gbp: f.value,
    outcome: null, outcome_type: null, outcome_at: null, updated_at: new Date().toISOString() };
  const { error } = await cxFrom('circular_items').update(d).eq('id', it.id);
  if (error) { alert('Could not pass on: ' + error.message); return; }
  Object.assign(it, d);
  await cxLog(it, 'passed', null, d.stage, { from_activity: fromAct && fromAct.name, to_activity: to.name });
  cxDraw(); cxOpenItem(it.id);
}

function cxInjectPassStyle() {
  if (document.getElementById('pp-style')) return;
  const st = document.createElement('style'); st.id = 'pp-style';
  st.textContent = `
.pp-ok{background:#F0FDF4;border:1px solid #BBF7D0;color:#15803D;border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:12px}
.pp-head{display:flex;justify-content:space-between;gap:10px;align-items:flex-start;margin-bottom:12px}
.pp-code{font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;color:var(--em);letter-spacing:.5px}
.pp-name{font-size:19px;font-weight:700;color:var(--txt);margin:2px 0}
.pp-tools{display:flex;gap:4px;flex-shrink:0}
.pp-rail{display:flex;margin:4px 0 16px;overflow-x:auto}
.pp-step{flex:1;min-width:64px;position:relative;text-align:center}
.pp-step span{display:block;width:12px;height:12px;border-radius:50%;background:var(--border);margin:0 auto 5px;position:relative;z-index:1}
.pp-step:before{content:'';position:absolute;top:5px;left:-50%;width:100%;height:2px;background:var(--border)}
.pp-step:first-child:before{display:none}
.pp-step.done span,.pp-step.done:before,.pp-step.now:before{background:var(--em)}
.pp-step.now span{background:var(--em);box-shadow:0 0 0 4px rgba(31,111,109,.18)}
.pp-step em{font-style:normal;font-size:10.5px;color:var(--txt3);display:block;line-height:1.2}
.pp-step.now em{color:var(--txt);font-weight:700}
.pp-sec{border-top:1px solid var(--border);border-bottom:1px solid var(--border);padding:14px 0;margin-bottom:14px}
.pp-next{width:100%;height:50px;border-radius:12px;border:none;background:var(--em);color:#fff;font-size:15px;font-weight:700}
.pp-mini{font-size:12px;color:var(--txt3);text-align:center;margin:8px 0 2px}
.pp-mini a{color:var(--txt2);font-weight:600}
.pp-lbl{font-size:12px;color:var(--txt3);margin:14px 0 6px}
.pp-outs{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:6px}
.pp-out{height:44px;border-radius:10px;border:1px solid var(--border);background:var(--surface);font-size:13px;font-weight:600;color:var(--txt)}
.pp-out.on{border:2px solid var(--em);color:var(--em)}
.pp-panel{background:var(--bg);border-radius:12px;padding:12px;margin-top:12px}
.pp-panel-h{font-size:14px;font-weight:700;margin-bottom:10px}
.pp-field{margin-bottom:10px}
.pp-field label{display:block;font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.4px;font-weight:600;margin-bottom:5px}
.pp-seg{display:flex;gap:4px;flex-wrap:wrap}
.pp-seg button,.pp-chips button{border:1px solid var(--border);background:var(--surface);border-radius:18px;padding:7px 12px;font-size:12.5px;color:var(--txt2)}
.pp-seg button.on,.pp-chips button.on{background:var(--em);border-color:var(--em);color:#fff;font-weight:600}
.pp-chips{display:flex;gap:4px;flex-wrap:wrap}
.pp-money{display:flex;align-items:center;gap:6px}.pp-money span{font-size:20px;font-weight:700;color:var(--txt3)}.pp-money input{font-size:20px;font-weight:700}
.pp-drop{position:absolute;left:0;right:0;background:var(--surface);border:1px solid var(--border);border-radius:8px;box-shadow:0 6px 18px rgba(0,0,0,.08);z-index:5}
.pp-drop:empty{display:none}
.pp-drop div{padding:8px 12px;font-size:13px;cursor:pointer}.pp-drop div:hover{background:var(--bg)}
.pp-panel-f{display:flex;justify-content:space-between;align-items:center}
.pp-panel-f a{font-size:13px;color:var(--txt3)}
.pp-done{display:flex;justify-content:space-between;align-items:center;font-size:14px;font-weight:700;color:var(--em)}
.pp-done a{font-size:12px;font-weight:600;color:var(--txt3)}
.pp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px 14px;margin-bottom:14px}
.pp-grid div{min-width:0}
.pp-grid span{display:block;font-size:10.5px;color:var(--txt3);text-transform:uppercase;letter-spacing:.4px;font-weight:600}
.pp-grid b{display:block;font-size:13px;color:var(--txt);font-weight:600;overflow-wrap:anywhere}
.pp-hist summary{cursor:pointer;font-size:13px;color:var(--txt2);margin-bottom:10px}
@media(max-width:600px){#cx-modal{padding:0}#cx-modal .modal{padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px));width:100%;max-width:100%!important;max-height:92vh;overflow-y:auto;border-radius:16px 16px 0 0;margin:auto 0 0}#cx-modal.open{align-items:flex-end}.pp-name{font-size:17px}.pp-grid{grid-template-columns:1fr 1fr}.pp-outs{grid-template-columns:1fr 1fr}.form-grid-2{grid-template-columns:1fr}}
.cxs-wrap{position:relative;flex:1;min-width:180px;max-width:320px}
.cxs-wrap input{padding:7px 12px;font-size:13px;border-radius:20px}
.cxs-res{position:absolute;top:calc(100% + 4px);left:0;right:0;background:var(--surface);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.1);z-index:20;max-height:360px;overflow:auto}
.cxs-res:empty{display:none}
.cxs-row{padding:9px 12px;cursor:pointer;border-bottom:1px solid var(--border)}
.cxs-row:last-child{border-bottom:none}
.cxs-row:hover,.cxs-row.on{background:var(--bg)}`;
  document.head.appendChild(st);
}

// ── Search: ID, serial, name, make, donor ────────────────────
function cxSearchItems(q) {
  q = String(q || '').trim().toLowerCase().replace(/^.*#item=/, '');
  if (q.length < 2) return [];
  const score = i => {
    const code = (i.passport_code || '').toLowerCase();
    if (code === q) return 100;
    if (code.startsWith(q)) return 80;
    if ((i.serial || '').toLowerCase() === q) return 90;
    if ((i.serial || '').toLowerCase().includes(q)) return 60;
    const hay = [i.name, i.brand, i.model, i.source, i.custom && i.custom.recipient_org, i.custom && i.custom.note].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q) ? 30 : 0;
  };
  return CX.items.map(i => [score(i), i]).filter(x => x[0] > 0).sort((a, b) => b[0] - a[0] || String(b[1].updated_at).localeCompare(String(a[1].updated_at))).slice(0, 8).map(x => x[1]);
}
let _cxsSel = 0;
function cxSearchInput(ev) {
  const box = $('cxs-res'); if (!box) return;
  const hits = cxSearchItems(ev.target.value);
  if (ev.key === 'Enter') {
    const pick = hits[_cxsSel] || hits[0];
    if (pick) { box.innerHTML = ''; ev.target.value = ''; cxOpenItem(pick.id); }
    else if (ev.target.value.trim()) box.innerHTML = '<div class="cxs-row cxp-s" style="cursor:default">Nothing found for "' + cxE(ev.target.value.trim()) + '"</div>';
    return;
  }
  if (ev.key === 'Escape') { box.innerHTML = ''; ev.target.blur(); return; }
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { _cxsSel = Math.max(0, Math.min(hits.length - 1, _cxsSel + (ev.key === 'ArrowDown' ? 1 : -1))); }
  else _cxsSel = 0;
  cxInjectPassStyle();
  box.innerHTML = hits.map((i, n) => {
    const a = cxAct(i.activity_id), o = cxOutcome(a, i.outcome), s = cxStage(a, i.stage);
    return '<div class="cxs-row ' + (n === _cxsSel ? 'on' : '') + '" onmousedown="event.preventDefault();$(\'cxs-res\').innerHTML=\'\';$(\'cxs-q\').value=\'\';cxOpenItem(\'' + i.id + '\')">' +
      '<div class="cxp-t"><span class="cxp-code">' + cxE(i.passport_code || '') + '</span> ' + cxE(i.name) + '</div>' +
      '<div class="cxp-s">' + cxE(a ? a.icon + ' ' + a.name : '') + ' · ' + cxE(o ? o.label : s ? s.label : (i.status || '')) + (i.serial ? ' · SN ' + cxE(i.serial) : '') + '</div></div>';
  }).join('');
}

// ── QR labels ────────────────────────────────────────────────
function cxPrintLabels(ids) {
  const its = ids.map(id => CX.items.find(i => String(i.id) === String(id))).filter(Boolean);
  const org = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || 'Vorlana';
  const w = window.open('', '_blank', 'width=480,height=640');
  if (!w) { alert('Allow pop-ups to print labels.'); return; }
  const labels = its.map((i, n) =>
    '<div class="l"><div id="q' + n + '" class="q"></div><div class="t"><div class="c">' + cxE(i.passport_code) + '</div>' +
    '<div class="n">' + cxE(i.name) + '</div><div class="o">' + cxE(org) + '<br>Scan for history</div></div></div>').join('');
  w.document.write('<!DOCTYPE html><html><head><title>Labels</title><style>' +
    '@page{size:62mm 29mm;margin:0}body{margin:0;font-family:Arial,sans-serif}' +
    '.l{width:62mm;height:29mm;display:flex;align-items:center;gap:2mm;padding:1.5mm;box-sizing:border-box;page-break-after:always}' +
    '.q{width:25mm;height:25mm;flex-shrink:0}.q img,.q canvas{width:25mm!important;height:25mm!important}' +
    '.c{font:700 13pt ui-monospace,Menlo,monospace;letter-spacing:.5px}.n{font-size:8pt;margin:1mm 0;max-height:7mm;overflow:hidden}.o{font-size:6.5pt;color:#555}' +
    '</style></head><body>' + labels +
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script><script>' +
    'var urls=' + JSON.stringify(its.map(i => cxItemUrl(i.passport_code))) + ';' +
    'urls.forEach(function(u,n){new QRCode(document.getElementById("q"+n),{text:u,width:200,height:200,correctLevel:QRCode.CorrectLevel.M});});' +
    'setTimeout(function(){window.print();},600);<\/script></body></html>');
  w.document.close();
}

// ── Scan ─────────────────────────────────────────────────────
let _cxStream = null, _cxScanTimer = null;
function cxStopScan() {
  if (_cxScanTimer) { clearInterval(_cxScanTimer); _cxScanTimer = null; }
  if (_cxStream) { _cxStream.getTracks().forEach(t => t.stop()); _cxStream = null; }
}
async function cxOpenScan() {
  cxModal('<h2>Scan item</h2>' +
    '<video id="cx-video" playsinline muted style="width:100%;border-radius:8px;background:#000;max-height:320px"></video>' +
    '<div class="cxp-s" id="cx-scan-status" style="margin:8px 0">Starting camera…</div>' +
    '<div class="form-row"><label>Or type the code</label><div style="display:flex;gap:6px"><input id="cx-code" placeholder="e.g. 3FA9C21B" style="text-transform:uppercase"/>' +
    '<button class="btn btn-p" onclick="cxScanned($(\'cx-code\').value)">Open</button></div></div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="cxCloseModal()">Close</button></div>', 480);
  const status = $('cx-scan-status');
  try {
    _cxStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    const v = $('cx-video'); v.srcObject = _cxStream; await v.play();
    let detect;
    if ('BarcodeDetector' in window) {
      const bd = new BarcodeDetector({ formats: ['qr_code'] });
      detect = async () => { const r = await bd.detect(v); return r[0] && r[0].rawValue; };
    } else {
      if (!window.jsQR) await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js'; s.onload = ok; s.onerror = bad; document.head.appendChild(s); });
      const c = document.createElement('canvas'); const ctx = c.getContext('2d', { willReadFrequently: true });
      detect = async () => {
        if (!v.videoWidth) return null;
        c.width = v.videoWidth; c.height = v.videoHeight; ctx.drawImage(v, 0, 0);
        const r = window.jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height);
        return r && r.data;
      };
    }
    status.textContent = 'Point the camera at the label';
    _cxScanTimer = setInterval(async () => {
      try { const val = await detect(); if (val) cxScanned(val); } catch (e) { /* keep trying */ }
    }, 350);
  } catch (e) {
    status.textContent = 'Camera not available — type the code instead.';
  }
}
function cxScanned(val) {
  cxStopScan();
  const code = String(val || '').replace(/^.*#item=/i, '');
  if (!code.trim()) return;
  cxOpenByCode(decodeURIComponent(code));
}

// ── Collections ──────────────────────────────────────────────
const CX_COL_STATUS = [['requested', 'Requested'], ['scheduled', 'Scheduled'], ['collected', 'Collected'], ['booked_in', 'Booked in'], ['cancelled', 'Cancelled']];
function cxColStatusLabel(s) { const f = CX_COL_STATUS.find(x => x[0] === s); return f ? f[1] : s; }

function cxCollectionsHTML() {
  const f = CX.colFilter;
  const list = CX.cols.filter(c => f === 'all' ? true : f === 'open' ? ['requested', 'scheduled', 'collected'].includes(c.status) : c.status === f);
  const today = new Date().toISOString().slice(0, 10);
  const stat = s => CX.cols.filter(c => c.status === s).length;
  const booked = CX.items.filter(i => i.collection_id);
  let h = '<div class="stats-grid">' +
    statCard('Requested', stat('requested')) + statCard('Scheduled', stat('scheduled')) +
    statCard('Collected, not booked in', stat('collected')) +
    statCard('Items booked in', cxFmt(booked.length), cxFmt(booked.reduce((a, i) => a + (+i.weight_kg || 0), 0), 1) + ' kg') + '</div>';
  h += '<div class="card"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">' +
    '<div class="cxp-tabs" style="margin:0">' + [['open', 'Open'], ['requested', 'Requested'], ['scheduled', 'Scheduled'], ['collected', 'Collected'], ['booked_in', 'Booked in'], ['all', 'All']].map(x =>
      '<button class="cxp-tab ' + (f === x[0] ? 'on' : '') + '" onclick="CX.colFilter=\'' + x[0] + '\';cxDraw()">' + x[1] + '</button>').join('') + '</div>' +
    '<div style="display:flex;gap:6px;align-items:center"><input type="date" id="cx-run-date" value="' + today + '" style="width:auto"/>' +
    '<button class="btn btn-ghost btn-sm" onclick="cxRunSheet($(\'cx-run-date\').value)">🗺️ Run sheet</button></div></div>' +
    (list.length ? list.map(c =>
      '<div class="cxp-list-row"><div style="flex:1;min-width:0">' +
        '<div class="cxp-t">' + cxE(c.donor_org || c.donor_name || 'Donor') + ' <span class="cxp-code">' + cxE(c.booking_ref) + '</span> <span class="cxp-chip">' + cxE(cxColStatusLabel(c.status)) + '</span></div>' +
        '<div class="cxp-s">' + cxE([c.address, c.postcode].filter(Boolean).join(', ')) + (c.donor_phone ? ' · ' + cxE(c.donor_phone) : '') + '</div>' +
        '<div class="cxp-s">' + cxE(c.items_summary || '') + (c.scheduled_date ? ' · 📅 ' + new Date(c.scheduled_date).toLocaleDateString('en-GB') : c.requested_date ? ' · wants ' + new Date(c.requested_date).toLocaleDateString('en-GB') : '') + '</div>' +
      '</div><div class="cxp-btns" style="justify-content:flex-end">' +
        (c.status === 'requested' || c.status === 'scheduled' ? '<button class="btn btn-ghost btn-sm" onclick="cxSchedule(\'' + c.id + '\')">📅 ' + (c.status === 'scheduled' ? 'Move' : 'Schedule') + '</button>' +
          '<button class="btn btn-p btn-sm" onclick="cxCollected(\'' + c.id + '\')">✓ Collected</button>' : '') +
        (c.status === 'collected' || c.status === 'booked_in' ? '<button class="btn btn-p btn-sm" onclick="cxBookIn(\'' + c.id + '\')">+ Book in item</button>' : '') +
        (c.status === 'booked_in' ? '<button class="btn btn-ghost btn-sm" onclick="cxCustodyOpen({collection:\'' + c.id + '\',activity:\'\'})">📄 Custody</button>' : '') +
        '<button class="btn btn-ghost btn-sm" onclick="cxOpenBooking(\'' + c.id + '\')">Edit</button>' +
      '</div></div>').join('') : renderEmpty('No collections here.')) + '</div>';
  return h;
}

function cxOpenBooking(id) {
  const c = id ? CX.cols.find(x => x.id === id) : {};
  const v = k => cxE(c[k] || '');
  cxModal('<h2>' + (id ? 'Collection ' + cxE(c.booking_ref) : 'New collection booking') + '</h2>' +
    '<div class="form-grid-2">' +
      '<div class="form-row"><label>Donor type</label><select id="cb-type">' + [['household', 'Household'], ['business', 'Business'], ['council', 'Council / public body'], ['partner', 'Partner organisation'], ['site', 'Waste / collection site']].map(o =>
        '<option value="' + o[0] + '" ' + (c.donor_type === o[0] ? 'selected' : '') + '>' + o[1] + '</option>').join('') + '</select></div>' +
      '<div class="form-row"><label>Organisation</label><input id="cb-org" value="' + v('donor_org') + '"/></div>' +
    '</div><div class="form-grid-2">' +
      '<div class="form-row"><label>Contact name</label><input id="cb-name" value="' + v('donor_name') + '"/></div>' +
      '<div class="form-row"><label>Phone</label><input id="cb-phone" value="' + v('donor_phone') + '"/></div>' +
    '</div>' +
    '<div class="form-row"><label>Email</label><input id="cb-email" type="email" value="' + v('donor_email') + '"/></div>' +
    '<div class="form-grid-2"><div class="form-row"><label>Address</label><input id="cb-addr" value="' + v('address') + '"/></div>' +
      '<div class="form-row"><label>Postcode</label><input id="cb-pc" value="' + v('postcode') + '" style="text-transform:uppercase"/></div></div>' +
    '<div class="form-row"><label>What is being collected</label><textarea id="cb-items">' + v('items_summary') + '</textarea></div>' +
    '<div class="form-grid-2"><div class="form-row"><label>Preferred date</label><input id="cb-req" type="date" value="' + v('requested_date') + '"/></div>' +
      '<div class="form-row"><label>Scheduled for</label><input id="cb-sched" type="date" value="' + v('scheduled_date') + '"/></div></div>' +
    '<div class="form-row"><label>Notes (access, parking, stairs)</label><textarea id="cb-notes">' + v('notes') + '</textarea></div>' +
    '<div class="modal-footer">' + (id && c.status !== 'cancelled' && c.status !== 'booked_in' ? '<button class="btn btn-ghost" style="color:var(--red);margin-right:auto" onclick="cxColStatus(\'' + id + '\',\'cancelled\')">Cancel booking</button>' : '') +
      '<button class="btn btn-ghost" onclick="cxCloseModal()">Close</button><button class="btn btn-p" id="cb-save" onclick="cxSaveBooking(' + (id ? '\'' + id + '\'' : '') + ')">Save</button></div>');
}

async function cxSaveBooking(id) {
  const btn = $('cb-save'); btn.disabled = true;
  const sched = $('cb-sched').value || null;
  const d = {
    donor_type: $('cb-type').value, donor_org: $('cb-org').value.trim() || null, donor_name: $('cb-name').value.trim() || null,
    donor_phone: $('cb-phone').value.trim() || null, donor_email: $('cb-email').value.trim() || null,
    address: $('cb-addr').value.trim() || null, postcode: ($('cb-pc').value || '').trim().toUpperCase() || null,
    items_summary: $('cb-items').value.trim() || null, requested_date: $('cb-req').value || null,
    scheduled_date: sched, notes: $('cb-notes').value.trim() || null
  };
  try {
    if (id) {
      const c = CX.cols.find(x => x.id === id);
      if (c.status === 'requested' && sched) d.status = 'scheduled';
      const { error } = await cxFrom('circular_collections').update(d).eq('id', id); if (error) throw error;
      Object.assign(c, d);
    } else {
      d.org_id = orgId; d.activity_id = (cxColAct() || {}).id || null; d.status = sched ? 'scheduled' : 'requested';
      const { data, error } = await cxFrom('circular_collections').insert([d]).select().single(); if (error) throw error;
      CX.cols.unshift(data);
    }
    cxCloseModal(); CX.tab = 'collections'; cxDraw();
  } catch (e) { alert('Could not save: ' + e.message); btn.disabled = false; }
}

async function cxColStatus(id, status, extra) {
  const c = CX.cols.find(x => x.id === id);
  const d = Object.assign({ status }, extra || {});
  const { error } = await cxFrom('circular_collections').update(d).eq('id', id);
  if (error) { alert('Could not update: ' + error.message); return false; }
  Object.assign(c, d); cxCloseModal(); cxDraw(); return true;
}
function cxSchedule(id) {
  const c = CX.cols.find(x => x.id === id);
  const d = prompt('Collection date (YYYY-MM-DD)', c.scheduled_date || c.requested_date || new Date().toISOString().slice(0, 10));
  if (!d) return;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { alert('Use the format YYYY-MM-DD'); return; }
  cxColStatus(id, 'scheduled', { scheduled_date: d });
}
function cxCollected(id) {
  const by = prompt('Collected by (name or van)', cxActorName());
  if (by === null) return;
  const extra = { collected_by: by || null, collected_at: new Date().toISOString() };
  const save = () => cxColStatus(id, 'collected', extra);
  if (navigator.geolocation) navigator.geolocation.getCurrentPosition(p => { extra.lat = p.coords.latitude; extra.lng = p.coords.longitude; save(); }, save, { timeout: 5000 });
  else save();
}
function cxBookIn(id) {
  const c = CX.cols.find(x => x.id === id);
  const colAct = cxColAct();
  const link = colAct && (colAct.links || []).find(l => l.on === 'end' && l.to);
  const to = link && CX.acts.find(a => a.key === link.to);
  cxOpenLog({ collection_id: id, activity_id: to ? to.id : null, source: [c.donor_org || c.donor_name, c.booking_ref].filter(Boolean).join(' · ') });
}
async function cxMarkBookedIn(id) {
  const c = CX.cols.find(x => x.id === id);
  if (c && c.status !== 'booked_in') {
    const { error } = await cxFrom('circular_collections').update({ status: 'booked_in' }).eq('id', id);
    if (!error) c.status = 'booked_in';
  }
}

function cxRunSheet(date) {
  const list = CX.cols.filter(c => c.scheduled_date === date && c.status === 'scheduled')
    .sort((a, b) => (a.postcode || '').localeCompare(b.postcode || ''));
  if (!list.length) { alert('No scheduled collections on that date.'); return; }
  const w = window.open('', '_blank'); if (!w) { alert('Allow pop-ups to print the run sheet.'); return; }
  const org = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || '';
  w.document.write('<!DOCTYPE html><html><head><title>Run sheet ' + cxE(date) + '</title><style>body{font-family:Arial,sans-serif;padding:20px;font-size:12px}' +
    'h1{font-size:18px;margin:0 0 4px}table{width:100%;border-collapse:collapse;margin-top:14px}td,th{border:1px solid #ccc;padding:8px;text-align:left;vertical-align:top}th{background:#f3f3f3}.b{width:60px}</style></head><body>' +
    '<h1>Collection run sheet · ' + new Date(date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) + '</h1><div>' + cxE(org) + ' · ' + list.length + ' stops · ordered by postcode</div>' +
    '<table><tr><th>#</th><th>Ref</th><th>Donor</th><th>Address</th><th>Items</th><th>Notes</th><th class="b">Done</th></tr>' +
    list.map((c, i) => '<tr><td>' + (i + 1) + '</td><td>' + cxE(c.booking_ref) + '</td><td>' + cxE([c.donor_org, c.donor_name, c.donor_phone].filter(Boolean).join('<br>')) +
      '</td><td>' + cxE([c.address, c.postcode].filter(Boolean).join(', ')) + '</td><td>' + cxE(c.items_summary || '') + '</td><td>' + cxE(c.notes || '') + '</td><td></td></tr>').join('') +
    '</table><script>setTimeout(function(){window.print()},300)<\/script></body></html>');
  w.document.close();
}

// ── Open an item straight from a scanned label URL (#item=CODE) ─
(function cxHashWatch() {
  function check() {
    const m = (location.hash || '').match(/^#item=([^&]+)/i);
    if (!m) return;
    CX.pendingCode = decodeURIComponent(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
    if (typeof go === 'function') go('circular');
  }
  let tries = 0;
  const t = setInterval(() => {
    tries++;
    if (typeof orgId !== 'undefined' && orgId && typeof currentOrg !== 'undefined' && currentOrg && document.querySelector('.nav-btn')) {
      clearInterval(t); setTimeout(check, 500);
    } else if (tries > 120) clearInterval(t);
  }, 500);
  window.addEventListener('hashchange', check);
})();

// ─────────────────────────────────────────────────────────────
// CHAIN OF CUSTODY REPORT
// For councils, corporate donors and funders: every item, where it
// came from, each step with date and who did it, the details recorded
// at each step (wipe certificate, PAT…), where it went, and a check
// that its history links up unbroken. Print / PDF or CSV.
// ─────────────────────────────────────────────────────────────
const CXC = { rows: null, f: null };

function cxCustodyOpen(pre) {
  pre = pre || {};
  const acts = cxItemActs();
  if (!acts.length) { alert('Add an activity in ⚙️ Set up first.'); return; }
  const tracked = acts.filter(a => circMode(a) === 'tracked');
  const cur = pre.collection ? '' : pre.activity || (CX.tab !== 'all' && cxAct(CX.tab) && CX.tab !== 'collections' ? CX.tab : (tracked[0] || acts[0]).id);
  const sources = Array.from(new Set(CX.items.map(i => i.source).filter(Boolean))).sort();
  const e = cxE;
  cxModal('<h2>📄 Chain of custody report</h2>' +
    '<div class="cxp-s" style="margin-bottom:14px">Every item, each step with date and who did it, what was recorded, where it went — and a check that nothing in its history has been changed.</div>' +
    (pre.itemId ? '<input type="hidden" id="cxc-item" value="' + e(pre.itemId) + '"/><div class="cxq-status">One item: ' + e((CX.items.find(i => String(i.id) === String(pre.itemId)) || {}).passport_code || '') + '</div>' :
    '<div class="form-grid-2">' +
      '<div class="form-row"><label>Activity</label><select id="cxc-act"><option value="">All activities</option>' + acts.map(a => '<option value="' + a.id + '"' + (a.id === cur ? ' selected' : '') + '>' + e(a.icon + ' ' + a.name) + '</option>').join('') + '</select></div>' +
      '<div class="form-row"><label>Items</label><select id="cxc-state"><option value="all">All</option><option value="done">Finished only</option><option value="open">Still in progress</option></select></div>' +
    '</div><div class="form-grid-2">' +
      '<div class="form-row"><label>Received from</label><input type="date" id="cxc-from" value="' + e(pre.from || '') + '"/></div>' +
      '<div class="form-row"><label>Received to</label><input type="date" id="cxc-to" value="' + e(pre.to || '') + '"/></div>' +
    '</div>' +
    '<div class="form-row"><label>Donor / source</label><select id="cxc-src"><option value="">Any</option>' +
      (pre.collection ? '<option value="col:' + e(pre.collection) + '" selected>This collection only</option>' : '') +
      sources.map(x => '<option value="' + e(x) + '">' + e(x) + '</option>').join('') + '</select></div>') +
    '<label style="display:flex;gap:8px;align-items:center;font-size:13px;margin:4px 0 6px"><input type="checkbox" id="cxc-names" style="width:auto"/> Show names of people who received items (internal use only)</label>' +
    '<div id="cxc-msg" class="cxp-s"></div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="cxCloseModal()">Cancel</button>' +
      '<button class="btn btn-ghost" id="cxc-csv" onclick="cxCustodyRun(\'csv\')">⬇ CSV</button>' +
      '<button class="btn btn-p" id="cxc-go" onclick="cxCustodyRun(\'doc\')">Open report</button></div>', 560);
}

async function cxCustodyRun(kind) {
  const msg = $('cxc-msg');
  const f = {
    item: $('cxc-item') ? $('cxc-item').value : '',
    act: $('cxc-act') ? $('cxc-act').value : '', state: $('cxc-state') ? $('cxc-state').value : 'all',
    from: $('cxc-from') ? $('cxc-from').value : '', to: $('cxc-to') ? $('cxc-to').value : '',
    src: $('cxc-src') ? $('cxc-src').value : '', names: $('cxc-names').checked
  };
  let items = CX.items.filter(i => i.activity_id && cxAct(i.activity_id));
  if (f.item) items = items.filter(i => String(i.id) === String(f.item));
  else {
    if (f.act) items = items.filter(i => i.activity_id === f.act);
    if (f.state === 'done') items = items.filter(i => i.outcome_type);
    if (f.state === 'open') items = items.filter(i => !i.outcome_type);
    if (f.from) items = items.filter(i => String(i.created_at || '').slice(0, 10) >= f.from);
    if (f.to) items = items.filter(i => String(i.created_at || '').slice(0, 10) <= f.to);
    if (f.src.indexOf('col:') === 0) items = items.filter(i => String(i.collection_id) === f.src.slice(4));
    else if (f.src) items = items.filter(i => i.source === f.src);
  }
  if (!items.length) { msg.textContent = 'No items match.'; return; }
  if (items.length > 2000) { msg.textContent = 'That is ' + items.length + ' items — narrow the dates to 2,000 or fewer.'; return; }
  msg.textContent = 'Reading the history of ' + items.length + ' items…';
  const evs = {};
  const ids = items.map(i => String(i.id));
  for (let k = 0; k < ids.length; k += 150) {
    const { data, error } = await cxFrom('circular_item_events').select('*').eq('org_id', orgId).in('item_id', ids.slice(k, k + 150)).order('id');
    if (error) { msg.textContent = 'Could not read history: ' + error.message; return; }
    (data || []).forEach(ev => { (evs[ev.item_id] = evs[ev.item_id] || []).push(ev); });
  }
  const rows = items.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).map(it => {
    const list = evs[String(it.id)] || [];
    let intact = list.length > 0;
    list.forEach((ev, n) => { if (ev.prev_hash !== (n ? list[n - 1].hash : 'GENESIS')) intact = false; });
    return { it, act: cxAct(it.activity_id), evs: list, intact, received: list.length ? list[0].occurred_at : it.created_at };
  });
  CXC.rows = rows; CXC.f = f;
  if (kind === 'csv') cxCustodyCSV(rows, f); else cxCustodyDoc(rows, f);
  msg.textContent = '';
}

function cxCustodyRecipient(it, names) {
  const c = it.custom || {};
  if (it.recipient_participant_id) {
    if (!names) return 'A person we support';
    const p = (DB.participants || []).find(x => String(x.id) === String(it.recipient_participant_id));
    return p ? cxPersonName(p) : 'A person we support';
  }
  return c.recipient_org || c.borrower || '';
}
function cxCustodyStep(ev, act, names) {
  const d = ev.data || {};
  const lbl = k => { const s = cxStage(act, k) || cxOutcome(act, k); return s ? s.label : (k || ''); };
  let what = ev.action === 'moved' ? lbl(ev.to_stage)
    : ev.action === 'finished' ? 'Out: ' + lbl(ev.to_stage)
    : ev.action === 'details' ? 'Details at ' + lbl(ev.to_stage)
    : ev.action === 'reopened' ? 'Reopened'
    : ev.action === 'passed' ? 'Passed to ' + (d.to_activity || 'another activity')
    : ev.action === 'booked_in' ? 'Booked in (collection)'
    : ev.action === 'imported' ? 'Imported record'
    : ev.action === 'logged' || ev.action === 'tallied' ? 'Received' + (ev.to_stage ? ' at ' + lbl(ev.to_stage) : '')
    : ev.action === 'edited' ? 'Details corrected'
    : ev.action;
  const extra = Object.keys(d.fields || {}).map(k => { const f = (act.fields || []).find(x => x.key === k); const v = d.fields[k]; return (f ? f.label : k) + ': ' + (v === true ? 'Yes' : v === false ? 'No' : v); });
  if (d.recipient) {
    const isPerson = d.recipient_kind ? d.recipient_kind === 'person' : (DB.participants || []).some(p => cxPersonName(p) === d.recipient);
    extra.push('to ' + (names || !isPerson ? d.recipient : 'a person we support'));
  }
  if (d.sale_gbp) extra.push('£' + (+d.sale_gbp).toFixed(2) + (d.sale_channel ? ' via ' + d.sale_channel : ''));
  if (d.note) extra.push(d.note);
  return { when: ev.occurred_at, what, who: ev.actor_name || '', extra: extra.join(' · '), hash: (ev.hash || '').slice(0, 10) };
}

function cxCustodyDoc(rows, f) {
  const esc = cxE;
  const org = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || '';
  const logo = typeof getOrgLogoUrl === 'function' ? getOrgLogoUrl(currentOrg) : '';
  const acts = Array.from(new Set(rows.map(r => r.act.name)));
  const done = rows.filter(r => r.it.outcome_type).length;
  const broken = rows.filter(r => !r.intact).length;
  const kg = rows.reduce((a, r) => a + (+r.it.weight_kg || 0), 0);
  const byOut = {};
  rows.forEach(r => { const o = cxOutcome(r.act, r.it.outcome); const k = o ? o.label : 'In progress'; byOut[k] = (byOut[k] || 0) + (+r.it.quantity || 1); });
  // Coverage of each detail asked at a step (e.g. wipe certificate)
  const cover = [];
  const seenF = {};
  rows.forEach(r => (r.act.fields || []).forEach(fl => {
    const st = cxFieldStage(r.act, fl); if (!st) return;
    const idx = (r.act.stages || []).findIndex(s => s.key === st);
    const cur = (r.act.stages || []).findIndex(s => s.key === r.it.stage);
    const reached = r.it.outcome_type || cur >= idx;
    if (!reached) return;
    const k = r.act.name + '|' + fl.key;
    const o = seenF[k] || (seenF[k] = { label: fl.label, act: r.act.name, n: 0, have: 0 });
    o.n++; const v = (r.it.custom || {})[fl.key]; if (v != null && v !== '') o.have++;
  }));
  Object.values(seenF).forEach(o => cover.push(o));
  const dates = rows.map(r => String(r.received || '').slice(0, 10)).filter(Boolean).sort();
  const scope = [
    acts.join(', '),
    f.from || f.to ? 'received ' + (f.from ? new Date(f.from).toLocaleDateString('en-GB') : 'start') + ' – ' + (f.to ? new Date(f.to).toLocaleDateString('en-GB') : 'today') : (dates.length ? 'received ' + new Date(dates[0]).toLocaleDateString('en-GB') + ' – ' + new Date(dates[dates.length - 1]).toLocaleDateString('en-GB') : ''),
    f.src ? (f.src.indexOf('col:') === 0 ? 'one collection' : 'from ' + f.src) : ''
  ].filter(Boolean).join(' · ');
  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const fmt = d => d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '';

  const table = rows.map(r => {
    const it = r.it, o = cxOutcome(r.act, it.outcome), st = cxStage(r.act, it.stage);
    const steps = r.evs.map(ev => cxCustodyStep(ev, r.act, f.names));
    const rec = cxCustodyRecipient(it, f.names);
    return '<tr><td class="c">' + esc(it.passport_code || '') + '</td>' +
      '<td><b>' + esc(it.name) + '</b>' + (+it.quantity > 1 ? ' ×' + it.quantity : '') + '<br><span class="m">' + esc([it.brand, it.model].filter(Boolean).join(' ')) + (it.serial ? '<br>SN ' + esc(it.serial) : '') + '</span></td>' +
      '<td>' + esc(fmt(r.received)) + '<br><span class="m">' + esc(it.source || '') + '</span></td>' +
      '<td class="s">' + (steps.length ? steps.map(s => '<div><b>' + esc(s.what) + '</b> ' + esc(fmt(s.when)) + (s.who ? ' · ' + esc(s.who) : '') + (s.extra ? '<br><span class="m">' + esc(s.extra) + '</span>' : '') + '</div>').join('') : '<span class="m">No history recorded</span>') + '</td>' +
      '<td>' + (o ? '<b>' + esc(o.label) + '</b><br><span class="m">' + esc(fmt(it.outcome_at || it.updated_at)) + (rec ? '<br>' + esc(rec) : '') + '</span>' : '<span class="m">In progress' + (st ? ': ' + esc(st.label) : '') + '</span>') + '</td>' +
      '<td class="k">' + (r.intact ? '✓' : '<span style="color:#B91C1C">✗</span>') + '</td></tr>';
  }).join('');

  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to open the report.'); return; }
  w.document.write('<!DOCTYPE html><html><head><title>Chain of custody — ' + esc(org) + '</title><style>' +
    'body{font-family:Arial,Helvetica,sans-serif;color:#222;margin:28px;font-size:12px}' +
    '.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1F6F6D;padding-bottom:12px;margin-bottom:16px}' +
    '.hd small{display:block;text-transform:uppercase;letter-spacing:1px;color:#1F6F6D;font-weight:700;font-size:10px}' +
    'h1{font-size:22px;margin:4px 0;color:#175655}.sub{color:#666}' +
    '.figs{display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin:14px 0}' +
    '.fig{border:1px solid #ddd;border-radius:6px;padding:8px;text-align:center}.fig b{display:block;font-size:18px;color:#1F6F6D}.fig span{font-size:9px;text-transform:uppercase;color:#777;font-weight:700;letter-spacing:.4px}' +
    'h2{font-size:14px;margin:18px 0 6px;color:#175655}' +
    'table{width:100%;border-collapse:collapse}th{text-align:left;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:#555;border-bottom:2px solid #bbb;padding:5px}' +
    'td{border-bottom:1px solid #e5e5e5;padding:6px 5px;vertical-align:top}td.c{font-family:Menlo,monospace;font-weight:700;color:#1F6F6D;white-space:nowrap}td.k{text-align:center;font-weight:700;color:#15803D;font-size:14px}' +
    'td.s div{margin-bottom:3px}.m{color:#777;font-size:11px}' +
    '.ok{background:#F0FDF4;border:1px solid #BBF7D0;color:#15803D;padding:8px 10px;border-radius:6px;margin:10px 0}.bad{background:#FEF2F2;border:1px solid #FECACA;color:#B91C1C;padding:8px 10px;border-radius:6px;margin:10px 0}' +
    '.sig{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:30px}.sig div{border-top:1px solid #999;padding-top:6px;color:#555}' +
    '.bar{position:sticky;top:0;background:#fff;padding:8px 0;margin:-8px 0 8px;text-align:right}.bar button{background:#1F6F6D;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-weight:700;cursor:pointer}' +
    '@media print{.bar{display:none}body{margin:12mm}tr{page-break-inside:avoid}}' +
    '</style></head><body><div class="bar"><button onclick="window.print()">Print / save as PDF</button></div>' +
    '<div class="hd"><div><small>Chain of custody report</small><h1>' + esc(org) + '</h1><div class="sub">' + esc(scope) + '<br>Generated ' + esc(today) + (cxActorName() ? ' by ' + esc(cxActorName()) : '') + '</div></div>' +
      (logo ? '<img src="' + esc(logo) + '" style="max-height:56px;max-width:160px" onerror="this.remove()"/>' : '') + '</div>' +
    '<div class="figs"><div class="fig"><b>' + rows.length + '</b><span>Items</span></div><div class="fig"><b>' + done + '</b><span>Finished</span></div>' +
      '<div class="fig"><b>' + (rows.length - done) + '</b><span>In progress</span></div><div class="fig"><b>' + (Math.round(kg * 10) / 10) + ' kg</b><span>Weight</span></div>' +
      '<div class="fig"><b>' + (broken ? broken : '✓') + '</b><span>' + (broken ? 'Broken histories' : 'All histories intact') + '</span></div></div>' +
    (broken ? '<div class="bad">' + broken + ' item' + (broken === 1 ? '' : 's') + ' marked ✗ below ' + (broken === 1 ? 'has' : 'have') + ' a history that does not link up, or no history at all (for example records created before custody logging began).</div>'
      : '<div class="ok">Every item\'s history links up unbroken from the first entry to the last.</div>') +
    '<h2>Where items went</h2><table><tr><th>Outcome</th><th>Items</th></tr>' + Object.keys(byOut).sort((a, b) => byOut[b] - byOut[a]).map(k => '<tr><td>' + esc(k) + '</td><td>' + byOut[k] + '</td></tr>').join('') + '</table>' +
    (cover.length ? '<h2>Details recorded at each step</h2><table><tr><th>Detail</th><th>Activity</th><th>Recorded</th></tr>' + cover.map(c => '<tr><td>' + esc(c.label) + '</td><td>' + esc(c.act) + '</td><td>' + c.have + ' of ' + c.n + ' items that reached that step' + (c.have < c.n ? ' <b style="color:#B45309">(' + (c.n - c.have) + ' missing)</b>' : ' ✓') + '</td></tr>').join('') + '</table>' : '') +
    '<h2>Item by item</h2><table><tr><th>ID</th><th>Item</th><th>Received</th><th>Custody steps (date · who · recorded)</th><th>Outcome</th><th>✓</th></tr>' + table + '</table>' +
    '<p class="m" style="margin-top:16px">How to read this: each item\'s history is written once and cannot be edited or deleted. Every entry carries a fingerprint (hash) of the entry before it, so ✓ means no step has been changed, removed or inserted since it was recorded. ' +
      (f.names ? 'This copy includes the names of individuals and is for internal use.' : 'Individuals who received items are not named.') + '</p>' +
    '<div class="sig"><div>Prepared by (name, signature, date)</div><div>Received by (name, signature, date)</div></div>' +
    '</body></html>');
  w.document.close();
}

function cxCustodyCSV(rows, f) {
  const fieldKeys = [];
  rows.forEach(r => (r.act.fields || []).forEach(fl => { if (!fieldKeys.some(x => x.key === fl.key)) fieldKeys.push(fl); }));
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const head = ['ID', 'Item', 'Make', 'Model', 'Serial', 'Activity', 'Source', 'Received', 'Status', 'Outcome date', 'Recipient', 'Weight kg', 'Sale £'].concat(fieldKeys.map(x => x.label), ['History intact', 'Custody steps']);
  const lines = [head.map(q).join(',')].concat(rows.map(r => {
    const it = r.it, c = it.custom || {}, o = cxOutcome(r.act, it.outcome), st = cxStage(r.act, it.stage);
    return [it.passport_code, it.name, it.brand, it.model, it.serial, r.act.name, it.source, String(r.received || '').slice(0, 10),
      o ? o.label : 'In progress' + (st ? ': ' + st.label : ''), o ? String(it.outcome_at || it.updated_at || '').slice(0, 10) : '',
      cxCustodyRecipient(it, f.names), it.weight_kg, c.sale_gbp || '']
      .concat(fieldKeys.map(x => c[x.key] === true ? 'Yes' : c[x.key] === false ? 'No' : (c[x.key] == null ? '' : c[x.key])),
        [r.intact ? 'Yes' : 'No', r.evs.map(ev => { const s = cxCustodyStep(ev, r.act, f.names); return String(s.when).slice(0, 10) + ' ' + s.what + (s.who ? ' (' + s.who + ')' : '') + (s.extra ? ' — ' + s.extra : ''); }).join(' | ')])
      .map(q).join(',');
  }));
  const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'chain-of-custody-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
