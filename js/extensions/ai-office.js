// js/extensions/ai-office.js — the AI back office (demo account only while it's being tested)
//   1. Morning briefing: deadlines, money and volunteer checks worked out in code, run once a day by itself
//   2. Ask Vorlana: questions answered from the organisation's own records
//   3. Funding calendar: report deadlines, contract ends, renewals and bid deadlines in one list (.ics download)
//   4. Comms: weekly story pack, monthly newsletter, volunteer thank-yous (on Social Media)
//   5. Annual / trustee report from a year of records (on Reports)
//   6. Budget: budget lines and spend per contract, fed into that contract's funder reports
//   7. Donations: donor, amount, Gift Aid, restricted fund, thanked
// Shows only when organisations.settings.demo_account = true. Needs ai-office.sql for budgets and donations to save;
// without it they work in memory with sample rows.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var n = function (v) { var x = parseFloat(v); return isNaN(x) ? 0 : x; };
  var iso = function (d) { var x = new Date(d); return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
  var addDays = function (d, k) { var x = new Date(d); x.setDate(x.getDate() + k); return x; };
  var addMonths = function (d, k) { var x = new Date(d); x.setMonth(x.getMonth() + k); return x; };
  var fmt = function (d) { if (!d) return ''; var x = new Date(String(d).length === 10 ? d + 'T12:00:00' : d); return isNaN(x) ? String(d) : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  var gbp = function (v) { return '£' + Math.round(n(v)).toLocaleString('en-GB'); };
  var today = function () { return iso(new Date()); };
  var orgName = function () { return (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || 'Our organisation'; };
  var oid = function () { return typeof orgId !== 'undefined' ? orgId : null; };
  var uses = function (k) { return typeof orgUses !== 'function' || orgUses(k); };
  var isDemo = function () { return typeof _demoMode !== 'undefined' && _demoMode; };

  function on() { return !!(typeof currentOrg !== 'undefined' && currentOrg && currentOrg.settings && currentOrg.settings.demo_account === true); }

  // ── Store for budgets and donations ──────────────────────────
  var S = { don: [], lines: [], spend: [], sql: { don: true, bud: true }, loaded: false, bids: [] };

  async function q(table) {
    if (typeof sb === 'undefined' || !sb || !oid()) return null;
    try { var r = await sb.from(table).select('*').eq('org_id', oid()); return r.error ? null : (r.data || []); } catch (e) { return null; }
  }
  async function load() {
    var res = await Promise.all([q('donations'), q('budget_lines'), q('budget_spend'), q('bids')]);
    S.sql.don = res[0] !== null; S.sql.bud = res[1] !== null && res[2] !== null;
    S.don = (res[0] || []).slice(); S.lines = (res[1] || []).slice(); S.spend = (res[2] || []).slice(); S.bids = res[3] || [];
    if (isDemo()) addSamples();
    S.loaded = true;
  }
  function addSamples() {
    if (!S.don.some(function (d) { return d._demo; })) {
      var donors = [['Margaret Ellis', 50, 'Card', true, '', 300], ['Northgate Rotary Club', 750, 'Bank transfer', false, 'Garden project', 270], ['Tom Okafor', 20, 'Direct debit', true, '', 240],
        ['Priya Shah', 100, 'Card', true, '', 200], ['St Mark\'s Church', 400, 'Cheque', false, 'Community meals', 160], ['Tom Okafor', 20, 'Direct debit', true, '', 210],
        ['Hannah Lee', 35, 'Cash', false, '', 120], ['Greenway Supermarket', 1000, 'Bank transfer', false, 'Garden project', 90], ['Tom Okafor', 20, 'Direct debit', true, '', 180],
        ['David Moore', 250, 'Card', true, '', 45], ['Aisha Begum', 60, 'Card', true, '', 12], ['Local Lions Club', 300, 'Bank transfer', false, 'Community meals', 4]];
      donors.forEach(function (d, i) {
        S.don.push({ id: 'demo-don-' + i, _demo: true, donor_name: d[0], amount: d[1], method: d[2], gift_aid: d[3], fund: d[4] || null, restricted: !!d[4],
          gift_date: iso(addDays(new Date(), -d[5])), thanked_at: d[5] > 20 ? addDays(new Date(), -d[5] + 3).toISOString() : null, donor_email: '' });
      });
    }
    if (!S.lines.some(function (l) { return l._demo; })) {
      (DB.contracts || []).filter(function (c) { return n(c.value) > 0; }).slice(0, 2).forEach(function (c, ci) {
        var split = [['Staff costs', 0.6], ['Venue and room hire', 0.1], ['Materials and equipment', 0.15], ['Volunteer expenses', 0.05], ['Management and overheads', 0.1]];
        var el = elapsedPct(c) == null ? 50 : elapsedPct(c);
        split.forEach(function (s, i) {
          var id = 'demo-bl-' + ci + '-' + i, amt = Math.round(n(c.value) * s[1]);
          S.lines.push({ id: id, _demo: true, contract_id: String(c.id), name: s[0], amount: amt });
          var share = (el / 100) * (i === 2 ? 1.35 : i === 3 ? 0.6 : 0.95), months = 6, total = Math.round(amt * share);
          for (var m = 0; m < months; m++) S.spend.push({ id: id + '-s' + m, _demo: true, line_id: id, spend_date: iso(addDays(new Date(), -m * 30 - 3)), amount: Math.round(total / months), note: m === 0 ? 'This month' : '' });
        });
      });
    }
  }
  async function save(table, row, key) {
    var sqlOk = table === 'donations' ? S.sql.don : S.sql.bud;
    if (!sqlOk) { row.id = 'mem-' + Date.now() + Math.random().toString(36).slice(2, 6); S[key].push(row); return row; }
    var r = await sb.from(table).insert([Object.assign({ org_id: oid() }, row)]).select();
    if (r.error) throw new Error(r.error.message);
    var saved = (r.data && r.data[0]) || row; S[key].push(saved); return saved;
  }
  async function patch(table, key, id, p) {
    var row = S[key].find(function (x) { return String(x.id) === String(id); }); if (!row) return;
    Object.assign(row, p);
    if (/^(demo|mem)-/.test(String(id))) return;
    var r = await sb.from(table).update(p).eq('id', id); if (r && r.error) alert('Couldn’t save: ' + r.error.message);
  }
  async function remove(table, key, id) {
    S[key] = S[key].filter(function (x) { return String(x.id) !== String(id); });
    if (/^(demo|mem)-/.test(String(id))) return;
    var r = await sb.from(table).delete().eq('id', id); if (r && r.error) alert('Couldn’t delete: ' + r.error.message);
  }

  // ── Shared figures ────────────────────────────────────────────
  function elapsedPct(c) {
    if (!c.start_date || !c.end_date) return null;
    var a = new Date(c.start_date), b = new Date(c.end_date), t = new Date();
    if (isNaN(a) || isNaN(b) || b <= a) return null;
    return Math.max(0, Math.min(100, Math.round((t - a) / (b - a) * 100)));
  }
  var MONTHS = { month: 1, quarter: 3, half: 6, year: 12 };
  // every report period for a contract (same rules as the daily reminder job)
  function reportPeriods(c) {
    var every = c.report_every || 'quarter', k = MONTHS[every]; if (!k || !c.start_date) return [];
    var start = new Date(c.start_date + 'T12:00:00'); if (isNaN(start)) return [];
    var end = c.end_date ? new Date(c.end_date + 'T12:00:00') : addMonths(new Date(), 12), out = [];
    for (var from = start, i = 0; from <= end && i < 120; i++) {
      var to = addDays(addMonths(from, k), -1); if (to > end) to = end;
      out.push({ from: iso(from), to: iso(to), due: iso(addDays(to, c.report_due_days || 0)), hasDue: !!c.report_due_days });
      from = addMonths(from, k);
    }
    return out;
  }
  function parseDeadline(s) {
    if (!s) return null; var t = String(s).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
    var d = new Date(t.replace(/(\d+)(st|nd|rd|th)/, '$1')); return isNaN(d) ? null : iso(d);
  }
  function spentOn(lineId) { return S.spend.filter(function (s) { return String(s.line_id) === String(lineId); }).reduce(function (a, s) { return a + n(s.amount); }, 0); }
  function budgetOf(c) {
    var lines = S.lines.filter(function (l) { return String(l.contract_id) === String(c.id); });
    if (!lines.length) return null;
    var rows = lines.map(function (l) { return { id: l.id, name: l.name, budget: n(l.amount), spent: spentOn(l.id) }; });
    var b = rows.reduce(function (a, r) { return a + r.budget; }, 0), s = rows.reduce(function (a, r) { return a + r.spent; }, 0);
    return { rows: rows, budget: b, spent: s, pct: b ? Math.round(s / b * 100) : 0, elapsed: elapsedPct(c) };
  }
  function giftAidable(d) { return d.gift_aid ? n(d.amount) * 0.25 : 0; }

  // ── 1. Morning briefing checks ───────────────────────────────
  function checks() {
    var out = [], t = today(), in14 = iso(addDays(new Date(), 14)), in21 = iso(addDays(new Date(), 21)), in90 = iso(addDays(new Date(), 90));
    var C = uses('funders') ? (DB.contracts || []).filter(function (c) { return c.status !== 'closed'; }) : [];
    C.forEach(function (c) {
      if ((c.report_every || 'quarter') !== 'off') {
        var p = reportPeriods(c).find(function (x) { return x.due >= t; });
        if (p && p.due <= in14) out.push({ lvl: p.due <= iso(addDays(new Date(), 5)) ? 'red' : 'amber', page: 'reports', text: 'Report for ' + c.name + ' (' + fmt(p.from) + ' to ' + fmt(p.to) + ') ' + (p.hasDue ? 'is due ' : 'period ends ') + fmt(p.due) });
      }
      if (c.end_date && c.end_date >= t && c.end_date <= in90) out.push({ lvl: 'amber', page: 'calendar', text: c.name + ' ends ' + fmt(c.end_date) + ': time to line up renewal or the next funder' });
      var el = elapsedPct(c);
      if (el != null && el >= 15) {
        [['starts', c.target_starts, c.actual_starts], ['outcomes', c.target_outcomes, c.actual_outcomes]].forEach(function (x) {
          if (n(x[1]) > 0) { var pc = Math.round(n(x[2]) / n(x[1]) * 100); if (pc < el - 10) out.push({ lvl: pc < el - 25 ? 'red' : 'amber', page: 'funding', text: c.name + ': ' + n(x[2]) + ' of ' + n(x[1]) + ' ' + x[0] + ' (' + pc + '%) with ' + el + '% of the contract gone' }); }
        });
      }
      var bd = budgetOf(c);
      if (bd) {
        bd.rows.forEach(function (r) { if (r.budget && r.spent > r.budget) out.push({ lvl: 'red', page: 'budget', text: c.name + ': ' + r.name + ' is overspent, ' + gbp(r.spent) + ' of ' + gbp(r.budget) }); });
        if (bd.elapsed != null && bd.pct > bd.elapsed + 15) out.push({ lvl: 'amber', page: 'budget', text: c.name + ': ' + bd.pct + '% of the budget spent with ' + bd.elapsed + '% of the contract gone' });
      }
    });
    S.bids.forEach(function (b) {
      if (b.status !== 'drafted') return; var d = parseDeadline(b.deadline);
      if (d && d >= t && d <= in21) out.push({ lvl: d <= iso(addDays(new Date(), 7)) ? 'red' : 'amber', page: 'bd', text: 'Bid to ' + b.funder + ' closes ' + fmt(d) + ' and is still a draft' });
    });
    if (uses('participants')) {
      var sg = (DB.participants || []).filter(function (p) { return p.stage !== 'Closed' && (p.safeguarding || p.risk === 'High') && (!p.last_contact || (new Date() - new Date(p.last_contact)) / 864e5 > 14); });
      if (sg.length) out.push({ lvl: 'red', page: 'participants', text: sg.length + ' high-risk or safeguarding ' + (sg.length === 1 ? 'person has' : 'people have') + ' had no contact for 14+ days: ' + sg.slice(0, 4).map(function (p) { return p.first_name + ' ' + p.last_name; }).join(', ') + (sg.length > 4 ? ' and ' + (sg.length - 4) + ' more' : '') });
    }
    if (uses('volunteers')) {
      var H = DB.volunteer_hours || [];
      if (H.length) {
        var from = iso(addDays(new Date(), -30)), act = {};
        H.forEach(function (h) { if (String(h.date || '').slice(0, 10) >= from) act[String(h.volunteer_id)] = 1; });
        var quiet = (DB.volunteers || []).filter(function (v) { return v.status === 'Active' && !act[String(v.id)]; });
        if (quiet.length) out.push({ lvl: 'amber', page: 'volunteers', text: quiet.length + ' active volunteer' + (quiet.length === 1 ? ' has' : 's have') + ' logged no hours in 30 days: ' + quiet.slice(0, 4).map(function (v) { return v.name; }).join(', ') + (quiet.length > 4 ? ' and ' + (quiet.length - 4) + ' more' : '') });
      }
    }
    if (uses('events')) {
      var soon = (DB.events || []).filter(function (e) { return e.date >= t && e.date <= iso(addDays(new Date(), 2)); });
      soon.forEach(function (e) { out.push({ lvl: 'info', page: 'events', text: e.name + ' on ' + fmt(e.date) + (e.capacity ? ': ' + n(e.attendees) + ' of ' + n(e.capacity) + ' places taken' : '') }); });
    }
    var unthanked = S.don.filter(function (d) { return !d.thanked_at && d.gift_date && (new Date() - new Date(d.gift_date)) / 864e5 >= 2; });
    if (unthanked.length) out.push({ lvl: 'amber', page: 'donations', text: unthanked.length + ' donation' + (unthanked.length === 1 ? '' : 's') + ' not thanked yet (' + gbp(unthanked.reduce(function (a, d) { return a + n(d.amount); }, 0)) + ')' });
    var order = { red: 0, amber: 1, info: 2 };
    return out.sort(function (a, b) { return order[a.lvl] - order[b.lvl]; });
  }
  // fed into runMorningBriefing (agents.js) so the AI's priority actions include them
  window.vlBriefingExtra = async function () {
    if (!on()) return null;
    if (!S.loaded) await load();
    var c = checks();
    return { lines: c.length ? c.map(function (x) { return (x.lvl === 'red' ? 'URGENT: ' : '') + x.text; }) : ['none'], count: c.filter(function (x) { return x.lvl !== 'info'; }).length };
  };
  var DOT = { red: '#B42318', amber: '#B7791F', info: '#1A56DB' };
  function paintChecks() {
    var body = $('mb-body'); if (!body) return;
    var box = $('ao-checks');
    if (!box) { box = document.createElement('div'); box.id = 'ao-checks'; body.parentNode.insertBefore(box, body); }
    var c = checks();
    box.innerHTML = '<div style="font-size:12px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:var(--txt3);margin:4px 0 8px">Today’s checks</div>' +
      (c.length ? c.map(function (x) {
        return '<div onclick="go(\'' + x.page + '\')" style="display:flex;gap:10px;align-items:flex-start;padding:7px 10px;border:1px solid var(--border);border-radius:8px;margin-bottom:6px;cursor:pointer;font-size:13px;background:var(--surface,#fff)">' +
          '<span style="width:8px;height:8px;border-radius:50%;background:' + DOT[x.lvl] + ';margin-top:6px;flex-shrink:0"></span><span>' + esc(x.text) + '</span></div>';
      }).join('') : '<div style="font-size:13px;color:var(--txt3);margin-bottom:8px">Nothing due or overdue. All clear.</div>');
  }
  var CACHE_KEY = function () { return 'vl_mb_' + oid() + '_' + today(); };
  function wrapBriefing() {
    var orig = window.runMorningBriefing; if (typeof orig !== 'function' || orig._ao) return;
    window.runMorningBriefing = async function () {
      if (!on()) return orig.apply(this, arguments);
      if (!S.loaded) await load();
      paintChecks();
      await orig.apply(this, arguments);
      var b = $('mb-body');
      if (b && b.querySelector('.ai-response')) { try { localStorage.setItem(CACHE_KEY(), b.innerHTML); } catch (e) { /* private mode */ } }
    };
    window.runMorningBriefing._ao = true;
  }
  // once a day by itself: today's briefing is kept, and shown again on the next visit
  var autoDone = false;
  function autoBriefing() {
    if (autoDone || !on() || !$('mb-body')) return; autoDone = true;
    var cached = null; try { cached = localStorage.getItem(CACHE_KEY()); } catch (e) { /* none */ }
    if (cached) { paintChecks(); $('mb-body').innerHTML = cached; var tm = $('mb-time'); if (tm) tm.textContent = 'Written this morning'; }
    else window.runMorningBriefing();
  }

  // ── Facts pack (Ask Vorlana, comms, annual report) ───────────
  function inR(d, from, to) { d = String(d || '').slice(0, 10); return !!d && d >= from && d <= to; }
  function factsFor(from, to, opts) {
    opts = opts || {};
    var L = ['Organisation: ' + orgName(), 'Today: ' + fmt(today()), 'Period covered: ' + fmt(from) + ' to ' + fmt(to)];
    if (uses('events')) {
      var E = (DB.events || []).filter(function (e) { return inR(e.date, from, to); });
      var att = E.reduce(function (a, e) { return a + n(e.attendees); }, 0), types = {}, mo = {};
      E.forEach(function (e) { types[e.type || 'Other'] = (types[e.type || 'Other'] || 0) + 1; var k = String(e.date).slice(0, 7); mo[k] = (mo[k] || 0) + n(e.attendees); });
      L.push('', 'EVENTS', 'Events delivered: ' + E.length, 'Attendances: ' + att);
      if (Object.keys(types).length) L.push('Events by type: ' + Object.keys(types).sort(function (a, b) { return types[b] - types[a]; }).map(function (k) { return k + ' ' + types[k]; }).join(', '));
      if (Object.keys(mo).length > 1) L.push('Attendances by month: ' + Object.keys(mo).sort().map(function (k) { return new Date(k + '-01T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) + ' ' + mo[k]; }).join(', '));
      var big = E.slice().sort(function (a, b) { return n(b.attendees) - n(a.attendees); }).slice(0, opts.eventList || 6);
      if (big.length) L.push('Largest events: ' + big.map(function (e) { return e.name + ' (' + fmt(e.date) + ', ' + n(e.attendees) + ' attendances)'; }).join('; '));
      var up = (DB.events || []).filter(function (e) { return e.date > today(); }).sort(function (a, b) { return a.date < b.date ? -1 : 1; }).slice(0, 5);
      if (opts.upcoming && up.length) L.push('Coming up: ' + up.map(function (e) { return e.name + ' (' + fmt(e.date) + ')'; }).join('; '));
      var ids = {}; E.forEach(function (e) { ids[String(e.id)] = 1; });
      var FB = (DB.feedback || []).filter(function (f) { return ids[String(f.eventId || '')]; });
      if (FB.length) {
        var pair = FB.filter(function (f) { return f.cb != null && f.ca != null; });
        L.push('', 'FEEDBACK', 'Feedback responses: ' + FB.length);
        if (pair.length) {
          var cb = Math.round(pair.reduce(function (a, f) { return a + n(f.cb); }, 0) / pair.length * 10) / 10, ca = Math.round(pair.reduce(function (a, f) { return a + n(f.ca); }, 0) / pair.length * 10) / 10;
          L.push('Average confidence: ' + cb + ' out of 5 before, ' + ca + ' out of 5 after (' + pair.length + ' responses)', 'Reported increased confidence: ' + Math.round(pair.filter(function (f) { return n(f.ca) > n(f.cb); }).length / pair.length * 100) + '% (of ' + pair.length + ')');
        }
        var lrn = FB.filter(function (f) { return f.learned; }).length; if (lrn) L.push('Said they learned something new: ' + lrn + ' of ' + FB.length + ' responses');
        var qs = FB.map(function (f) { return String(f.quote || '').trim(); }).filter(function (s) { return s.length > 15; }).slice(0, opts.quotes || 6);
        if (qs.length) L.push('Quotes (use exactly as written): ' + qs.map(function (s) { return '"' + s + '"'; }).join(' | '));
      }
    }
    if (uses('participants')) {
      var P = DB.participants || [], stages = {};
      P.forEach(function (p) { stages[p.stage] = (stages[p.stage] || 0) + 1; });
      var withOut = P.filter(function (p) { return (p.outcomes || []).length; }).length;
      L.push('', 'PEOPLE SUPPORTED (current caseload, all time)', 'People on record: ' + P.length, 'By stage: ' + Object.keys(stages).map(function (k) { return k + ' ' + stages[k]; }).join(', '), 'People with at least one outcome recorded: ' + withOut);
    }
    if (uses('volunteers')) {
      var H = (DB.volunteer_hours || []).filter(function (h) { return inR(h.date, from, to); });
      var hrs = Math.round(H.reduce(function (a, h) { return a + n(h.hours); }, 0) * 10) / 10, per = {};
      H.forEach(function (h) { per[String(h.volunteer_id)] = (per[String(h.volunteer_id)] || 0) + n(h.hours); });
      var V = DB.volunteers || [];
      L.push('', 'VOLUNTEERS', 'Volunteers on record: ' + V.length + ' (' + V.filter(function (v) { return v.status === 'Active'; }).length + ' active)', 'Volunteer hours logged: ' + hrs, 'Volunteers who gave time: ' + Object.keys(per).length);
      var top = Object.keys(per).sort(function (a, b) { return per[b] - per[a]; }).slice(0, 5).map(function (id) { var v = V.find(function (x) { return String(x.id) === id; }); return v ? v.name + ' ' + Math.round(per[id] * 10) / 10 + ' hours' : null; }).filter(Boolean);
      if (top.length && opts.volNames) L.push('Most hours: ' + top.join(', '));
    }
    if (uses('funders')) {
      var C = DB.contracts || [];
      if (C.length) {
        L.push('', 'CONTRACTS AND GRANTS');
        C.forEach(function (c) {
          var bits = [c.funder ? 'funder ' + c.funder : '', n(c.value) ? 'value ' + gbp(c.value) : '', c.start_date ? fmt(c.start_date) + ' to ' + fmt(c.end_date) : '',
            n(c.target_starts) ? n(c.actual_starts) + ' of ' + n(c.target_starts) + ' starts' : '', n(c.target_outcomes) ? n(c.actual_outcomes) + ' of ' + n(c.target_outcomes) + ' outcomes' : '',
            elapsedPct(c) != null ? elapsedPct(c) + '% of the contract period gone' : '', c.status === 'closed' ? 'closed' : ''].filter(Boolean);
          L.push(c.name + ': ' + bits.join(', '));
          var bd = budgetOf(c); if (bd) L.push('  Budget ' + gbp(bd.budget) + ', spent ' + gbp(bd.spent) + ' (' + bd.pct + '%)' + (opts.budgetLines ? ': ' + bd.rows.map(function (r) { return r.name + ' ' + gbp(r.spent) + ' of ' + gbp(r.budget); }).join('; ') : ''));
        });
      }
    }
    var D = S.don.filter(function (d) { return inR(d.gift_date, from, to); });
    if (D.length) {
      var tot = D.reduce(function (a, d) { return a + n(d.amount); }, 0), funds = {}, donors = {};
      D.forEach(function (d) { var k = d.fund || 'Unrestricted'; funds[k] = (funds[k] || 0) + n(d.amount); donors[d.donor_name] = 1; });
      L.push('', 'DONATIONS', 'Donations: ' + D.length + ' gifts from ' + Object.keys(donors).length + ' donors, ' + gbp(tot) + ' in total', 'By fund: ' + Object.keys(funds).map(function (k) { return k + ' ' + gbp(funds[k]); }).join(', '),
        'Gift Aid that can be claimed: ' + gbp(D.reduce(function (a, d) { return a + giftAidable(d); }, 0)), 'Not yet thanked: ' + D.filter(function (d) { return !d.thanked_at; }).length);
    }
    return L.join('\n');
  }

  async function circFacts(from, to) {
    try { if (typeof orgCircularFacts !== 'function') return ''; var s = await orgCircularFacts(from, to); if (!s) return '';
      return '\n\nCIRCULAR ECONOMY\nEntries finished: ' + (s.finished || 0) + '\nWeight diverted: ' + (s.kg || 0) + ' kg' + (s.foodKg ? '\nFood shared: ' + s.foodKg + ' kg (about ' + s.meals + ' meals)' : '') + (s.fixRate != null ? '\nRepair fix rate: ' + s.fixRate + '%' : '');
    } catch (e) { return ''; }
  }

  // ── 2. Ask Vorlana ────────────────────────────────────────────
  var chat = [];
  function askUI() {
    if ($('ao-ask-btn')) return;
    var b = document.createElement('button'); b.id = 'ao-ask-btn'; b.className = 'no-print'; b.textContent = '✦ Ask Vorlana';
    b.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:900;background:#1F6F6D;color:#fff;border:0;border-radius:22px;padding:11px 18px;font-weight:600;font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,.18);cursor:pointer';
    b.onclick = function () { var p = $('ao-ask'); p.style.display = p.style.display === 'none' ? 'flex' : 'none'; if (p.style.display === 'flex') $('ao-ask-q').focus(); };
    document.body.appendChild(b);
    var p = document.createElement('div'); p.id = 'ao-ask'; p.className = 'no-print';
    p.style.cssText = 'display:none;flex-direction:column;position:fixed;right:20px;bottom:72px;z-index:901;width:min(400px,calc(100vw - 32px));height:min(540px,calc(100vh - 110px));background:var(--surface,#fff);border:1px solid var(--border);border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.18);overflow:hidden';
    p.innerHTML = '<div style="padding:12px 14px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center"><div><div style="font-weight:700">Ask Vorlana</div><div style="font-size:12px;color:var(--txt3)">Answers from your own records only</div></div><button class="btn btn-ghost btn-sm" onclick="document.getElementById(\'ao-ask\').style.display=\'none\'">×</button></div>' +
      '<div id="ao-ask-log" style="flex:1;overflow:auto;padding:12px 14px;font-size:13px;line-height:1.55"><div style="color:var(--txt3)">Try: “How many attendances this year?” · “Which contract is behind?” · “How much Gift Aid can we claim?” · “Who gave the most volunteer hours this year?”</div></div>' +
      '<div style="display:flex;gap:6px;padding:10px;border-top:1px solid var(--border)"><input id="ao-ask-q" placeholder="Ask about your work…" style="flex:1" onkeydown="if(event.key===\'Enter\')vlAsk()"/><button class="btn btn-p btn-sm" onclick="vlAsk()">Ask</button></div>';
    document.body.appendChild(p);
  }
  function paintChat() {
    var log = $('ao-ask-log'); if (!log) return;
    log.innerHTML = chat.map(function (m) {
      return m.who === 'me' ? '<div style="text-align:right;margin:8px 0"><span style="display:inline-block;background:#E8F2F1;border-radius:12px;padding:7px 11px;max-width:85%;text-align:left">' + esc(m.text) + '</span></div>'
        : '<div style="margin:8px 0">' + (m.text === null ? '<span style="color:var(--txt3)">Reading your records…</span>' : (typeof aiPanelHTML === 'function' ? aiPanelHTML(m.text) : esc(m.text))) + '</div>';
    }).join('');
    log.scrollTop = log.scrollHeight;
  }
  window.vlAsk = async function () {
    var i = $('ao-ask-q'), qn = (i.value || '').trim(); if (!qn) return; i.value = '';
    if (!S.loaded) await load();
    chat.push({ who: 'me', text: qn }); var ans = { who: 'ai', text: null }; chat.push(ans); paintChat();
    var y = new Date(), fy = y.getMonth() >= 3 ? y.getFullYear() : y.getFullYear() - 1;
    var ctx = 'THIS CALENDAR YEAR\n' + factsFor(y.getFullYear() + '-01-01', today(), { volNames: true, budgetLines: true, quotes: 3 }) +
      '\n\nTHIS FINANCIAL YEAR (from 1 April ' + fy + ')\n' + factsFor(fy + '-04-01', today(), { volNames: true, quotes: 0, eventList: 3 }) +
      '\n\nLAST 30 DAYS\n' + factsFor(iso(addDays(new Date(), -30)), today(), { volNames: true, quotes: 3, upcoming: true }) +
      '\n\nALL TIME\n' + factsFor('2000-01-01', today(), { quotes: 0, eventList: 3 }) + (await circFacts(y.getFullYear() + '-01-01', today())) +
      '\n\nDEADLINES AND CHECKS TODAY\n' + (checks().map(function (x) { return x.text; }).join('\n') || 'none') +
      '\n\nCALENDAR (next 6 months)\n' + calItems().filter(function (x) { return x.date <= iso(addMonths(new Date(), 6)); }).slice(0, 25).map(function (x) { return fmt(x.date) + ': ' + x.what; }).join('\n');
    var sys = 'You are Vorlana, the assistant inside a UK charity\'s records system. Answer the question using ONLY the FACTS provided. Be short and direct: one to four sentences, or a short list. Use **bold** for the key figure. ' +
      'Never invent people, events, figures or dates. Never add up, average or calculate new figures yourself; if the question needs a figure that is not in the facts, say plainly it isn\'t in your records and name the page in Vorlana where it would be (Events, Volunteers, Contracts, Budget, Donations, Reports, Funding calendar). ' +
      'Say which period a figure covers. Use "black and ethnic minority", never "BAME". British English. No headings.';
    var hist = chat.slice(-8, -2).map(function (m) { return (m.who === 'me' ? 'Q: ' : 'A: ') + m.text; }).join('\n');
    try { ans.text = await callClaude(sys, (hist ? 'Earlier in this chat:\n' + hist + '\n\n' : '') + 'Question: ' + qn, 500, false, { context: 'FACTS\n' + ctx, purpose: 'ask' }); }
    catch (e) { ans.text = 'Sorry, I couldn’t answer that just now (' + (e.message || 'error') + ').'; }
    paintChat();
  };

  // ── 3. Funding calendar ───────────────────────────────────────
  function calItems() {
    var out = [], t = today(), until = iso(addMonths(new Date(), 13));
    (DB.contracts || []).filter(function (c) { return c.status !== 'closed'; }).forEach(function (c) {
      if ((c.report_every || 'quarter') !== 'off') reportPeriods(c).forEach(function (p) {
        if (p.due >= t && p.due <= until) out.push({ date: p.due, kind: 'report', what: (p.hasDue ? 'Report due: ' : 'Reporting period ends: ') + c.name + ' (' + fmt(p.from) + ' to ' + fmt(p.to) + ')', page: 'reports' });
      });
      if (c.end_date && c.end_date >= t && c.end_date <= until) {
        out.push({ date: c.end_date, kind: 'end', what: 'Contract ends: ' + c.name + (c.funder ? ' (' + c.funder + ')' : ''), page: 'funding' });
        var r = iso(addDays(new Date(c.end_date + 'T12:00:00'), -90));
        out.push({ date: r < t ? t : r, kind: 'renew', what: 'Start renewal or next bid: ' + c.name + ' ends in 3 months', page: 'bd' });
      }
    });
    S.bids.forEach(function (b) { var d = parseDeadline(b.deadline); if (d && d >= t && d <= until && (b.status === 'drafted' || b.status === 'submitted')) out.push({ date: d, kind: 'bid', what: 'Bid deadline: ' + b.funder + (b.programme ? ' · ' + b.programme : '') + (b.status === 'submitted' ? ' (sent)' : ' (draft)'), page: 'bd' }); });
    return out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  }
  var KIND = { report: ['Report', '#1A56DB', '#E8F0FE'], end: ['Ends', '#B42318', '#FDECEC'], renew: ['Renewal', '#B7791F', '#FEF6E7'], bid: ['Bid', '#1E7B3C', '#E7F6EC'] };
  async function renderCalendar() {
    var el = $('ao-cal-body'); if (!el) return;
    if (!S.loaded) await load();
    var items = calItems();
    if (!items.length) { el.innerHTML = '<div class="card" style="color:var(--txt3)">Nothing in the next 12 months. Add start and end dates to your contracts, and how often they report, and deadlines appear here.</div>'; return; }
    var by = {};
    items.forEach(function (x) { var k = x.date.slice(0, 7); (by[k] = by[k] || []).push(x); });
    el.innerHTML = Object.keys(by).map(function (k) {
      return '<div class="card" style="margin-bottom:12px"><div class="card-title">' + new Date(k + '-01T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) + '</div>' +
        by[k].map(function (x) { var kd = KIND[x.kind];
          return '<div onclick="go(\'' + x.page + '\')" style="display:flex;gap:12px;align-items:center;padding:8px 0;border-top:1px solid var(--border);cursor:pointer;font-size:13px"><div style="width:86px;flex-shrink:0;font-weight:600">' + esc(fmt(x.date)) + '</div>' +
            '<span class="badge" style="background:' + kd[2] + ';color:' + kd[1] + ';flex-shrink:0">' + kd[0] + '</span><div>' + esc(x.what) + '</div></div>'; }).join('') + '</div>';
    }).join('');
  }
  window.vlCalendarICS = function () {
    var lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Vorlana//Funding calendar//EN'];
    calItems().forEach(function (x, i) {
      var d = x.date.replace(/-/g, ''), nx = iso(addDays(new Date(x.date + 'T12:00:00'), 1)).replace(/-/g, '');
      lines.push('BEGIN:VEVENT', 'UID:vl-' + d + '-' + i + '@vorlana.com', 'DTSTAMP:' + new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z', 'DTSTART;VALUE=DATE:' + d, 'DTEND;VALUE=DATE:' + nx,
        'SUMMARY:' + x.what.replace(/[,;]/g, function (c) { return '\\' + c; }), 'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY', 'DESCRIPTION:' + x.what.replace(/[,;]/g, function (c) { return '\\' + c; }), 'END:VALARM', 'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' })); a.download = 'vorlana-funding-calendar.ics'; a.click();
  };

  // ── 4. Comms (Social Media page) ──────────────────────────────
  function commsCard() {
    var page = $('page-social'); if (!page || $('ao-comms')) return;
    var c = document.createElement('div'); c.id = 'ao-comms'; c.className = 'ai-panel'; c.style.marginBottom = '16px';
    c.innerHTML = '<div class="ai-panel-title"><span class="ai-icon">✦</span>Comms, written for you</div>' +
      '<div style="font-size:13px;color:var(--txt2);margin-bottom:10px">Written from what you actually delivered. Check it, then copy it into your newsletter tool, website or email.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-ai btn-sm" onclick="vlComms(\'story\')">This week’s story pack</button><button class="btn btn-ai btn-sm" onclick="vlComms(\'news\')">This month’s newsletter</button><button class="btn btn-ai btn-sm" onclick="vlComms(\'thanks\')">Volunteer thank-yous</button></div>' +
      '<div id="ao-comms-out" style="margin-top:12px"></div>';
    var hdr = page.querySelector('.page-header'); page.insertBefore(c, hdr ? hdr.nextSibling : page.firstChild);
  }
  function copyBox(id, text) {
    return '<div class="card" style="margin-top:10px"><div id="' + id + '" contenteditable="true" style="font-size:13px;line-height:1.6;outline:none">' + (typeof aiPanelHTML === 'function' ? aiPanelHTML(text) : esc(text)) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:10px" class="no-print"><button class="btn btn-ghost btn-sm" onclick="vlCopyEl(\'' + id + '\',this)">Copy</button></div></div>';
  }
  window.vlCopyEl = function (id, btn) {
    var t = ($(id) || {}).innerText || '';
    var done = function () { if (btn) { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); } };
    try { navigator.clipboard.writeText(t).then(done, done); } catch (e) { done(); }
  };
  window.vlComms = async function (kind) {
    var out = $('ao-comms-out'); if (!S.loaded) await load();
    var to = today(), from = iso(addDays(new Date(), kind === 'story' ? -7 : -30));
    var facts = factsFor(from, to, { volNames: true, quotes: 8, upcoming: true }) + (await circFacts(from, to));
    var rule = ' Use ONLY the facts given; never invent people, events, figures or quotes; quotes exactly as written. Never name a participant or anyone receiving support. Use "black and ethnic minority", never "BAME". British English, warm and plain. No hashtags except in the social post section, no emoji.';
    var spec = {
      story: { label: 'Story pack', sys: 'Write a weekly story pack for a UK charity\'s comms. Sections with ## headings: Story of the week (120-160 words, from the events, figures and quotes), Social post (under 60 words, up to 3 hashtags), Website news item (headline and 80-100 words), Photo ideas for next week (3 bullets, from the events coming up).' + rule, tok: 900 },
      news: { label: 'Newsletter', sys: 'Write a monthly supporter newsletter for a UK charity. Sections with ## headings: a subject line (one line), Hello (two sentences), What we did this month (figures and highlights), In their words (one or two quotes, if supplied), Thank you (volunteers and donors, as groups, no amounts per person), What\'s coming up (from the events coming up), How you can help (volunteer, donate, share; two sentences). 350-450 words.' + rule, tok: 1100 },
      thanks: { label: 'Thank-yous', sys: 'Write a short personal thank-you message for each volunteer named in "Most hours", one per volunteer, each starting with a ## heading of their name. 50-70 words each, warm and specific: mention their hours and the kind of events delivered in the period. Sign off from the team at the organisation.' + rule, tok: 1000 }
    }[kind];
    if (kind === 'thanks' && !/Most hours:/.test(facts)) { out.innerHTML = '<div class="alert alert-info">No volunteer hours logged in the last 30 days, so there’s no one to thank yet.</div>'; return; }
    var raw = await runAgent({ container: out, headerLabel: 'Comms — ' + spec.label, headerSub: 'Reading the last ' + (kind === 'story' ? '7' : '30') + ' days',
      steps: [{ label: 'Reading what you delivered', meta: '' }, { label: 'Picking the best story', meta: '' }, { label: 'Writing', meta: '' }, { label: 'Ready', meta: '' }],
      sys: spec.sys, prompt: facts, maxTok: spec.tok, ai: { purpose: 'comms' } });
    if (raw) { if (typeof vlAutoFix === 'function') raw = vlAutoFix(raw).text || raw; out.innerHTML = copyBox('ao-comms-text', raw); }
  };

  // ── 5. Annual / trustee report (Reports page) ─────────────────
  function annualCard() {
    var page = $('page-reports'); if (!page || $('ao-annual')) return;
    var y = new Date(), fy = y.getMonth() >= 3 ? y.getFullYear() : y.getFullYear() - 1, opts = '';
    for (var i = 0; i < 3; i++) { var s = fy - i; opts += '<option value="' + s + '-04-01|' + (s + 1) + '-03-31">Financial year ' + s + '–' + String(s + 1).slice(2) + (i === 0 ? ' (so far)' : '') + '</option>'; }
    for (var j = 0; j < 3; j++) { var cy = y.getFullYear() - j; opts += '<option value="' + cy + '-01-01|' + cy + '-12-31">Calendar year ' + cy + (j === 0 ? ' (so far)' : '') + '</option>'; }
    var c = document.createElement('div'); c.id = 'ao-annual'; c.className = 'card'; c.style.marginBottom = '20px';
    c.innerHTML = '<div class="card-title">Annual report for trustees and supporters</div><div style="font-size:13px;color:var(--txt2);margin-bottom:10px">A year of your records written up as an annual report: what you did, the difference made, volunteers, money in and spent. Click into the text to edit it.</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><select id="ao-annual-year" style="width:auto">' + opts + '</select><button class="btn btn-ai btn-sm" onclick="vlAnnualReport()">✦ Write annual report</button></div><div id="ao-annual-out" style="margin-top:12px"></div>';
    var list = $('reports-contract-list'); page.insertBefore(c, list || null);
  }
  window.vlAnnualReport = async function () {
    var out = $('ao-annual-out'); if (!S.loaded) await load();
    var r = ($('ao-annual-year').value || '').split('|'), from = r[0], to = r[1] > today() ? today() : r[1], label = $('ao-annual-year').selectedOptions[0].textContent;
    var facts = factsFor(from, to, { quotes: 6, budgetLines: true, eventList: 8 }) + (await circFacts(from, to));
    var sys = 'You are a senior UK charity writer. Write an annual report for trustees and supporters covering ' + label + ', from the facts only. ' +
      'Sections, each starting with ## and exactly this title: Our year at a glance, What we did, The difference we made, Our volunteers, Money in and how we used it, Thank you, Looking ahead. ' +
      'Our year at a glance: four to six bullets of the headline figures. What we did: activities by area, with figures. The difference we made: feedback results and one or two quotes exactly as written. ' +
      'Money in and how we used it: contracts and grants by funder, donations and Gift Aid, budgets and spend, only as given; if no money figures are given say finance figures come from the accounts. ' +
      'Looking ahead: only the contracts still running and when they end; then one line "[Trustees to add: plans and priorities for next year]". ' +
      'Use ONLY the facts; never invent people, outcomes, figures, plans or quotes; never add up, average or recalculate figures; give each figure once. Never name a participant. Write as "we", naming the organisation once at the start. ' +
      'Use "attendances" for visits and "responses" for feedback. Use "black and ethnic minority", never "BAME". No emoji, no horizontal rules, no hashtags except heading markers. 650-850 words.';
    var raw = await runAgent({ container: out, headerLabel: 'Annual report — ' + label, headerSub: 'Reading a year of records',
      steps: [{ label: 'Reading events, feedback and people', meta: '' }, { label: 'Reading volunteers', meta: '' }, { label: 'Reading contracts, budgets and donations', meta: '' }, { label: 'Writing', meta: '' }, { label: 'Ready', meta: '' }],
      sys: sys, prompt: facts, maxTok: 1200, ai: { purpose: 'annual-report', long: true } });
    if (!raw) return;
    if (typeof vlAutoFix === 'function') raw = vlAutoFix(raw).text || raw;
    var bad = typeof window.unknownReportNumbers === 'function' ? window.unknownReportNumbers(raw.replace(/\b(19|20)\d{2}\b/g, ''), facts) : [];
    out.innerHTML = (bad.length ? '<div class="alert alert-warn no-print">Check these figures — they aren’t in your records: ' + bad.map(esc).join(', ') + '</div>' : '') +
      '<div class="card"><div style="font-size:20px;font-weight:700;margin-bottom:2px">' + esc(orgName()) + '</div><div style="color:var(--txt3);margin-bottom:12px">Annual report · ' + esc(label.replace(' (so far)', '')) + '</div>' +
      '<div id="ao-annual-text" class="report-body" contenteditable="true" style="outline:none;line-height:1.65">' + aiPanelHTML(raw) + '</div>' +
      '<div class="no-print" style="display:flex;gap:6px;margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="vlCopyEl(\'ao-annual-text\',this)">Copy</button><button class="btn btn-ghost btn-sm" onclick="vlPrintAnnual()">Download PDF</button></div></div>';
  };
  window.vlPrintAnnual = function () {
    var box = $('ao-annual-out').querySelector('.card'); if (!box) return;
    var w = window.open('', '_blank'); if (!w) { window.print(); return; }
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>' + esc(orgName()) + ' annual report</title><style>body{font-family:Arial,Helvetica,sans-serif;font-size:11.5pt;line-height:1.6;color:#1d1d1f;max-width:720px;margin:32px auto;padding:0 24px}h3{color:#1F6F6D;margin:22px 0 6px}.no-print{display:none}</style></head><body>' + box.innerHTML + '</body></html>');
    w.document.close(); setTimeout(function () { w.print(); }, 300);
  };

  // ── 6. Budget page ────────────────────────────────────────────
  var budC = null;
  async function renderBudget() {
    var el = $('ao-bud-body'); if (!el) return;
    if (!S.loaded) await load();
    var C = (DB.contracts || []);
    if (!C.length) { el.innerHTML = '<div class="card" style="color:var(--txt3)">Add a contract first, then its budget lines.</div>'; return; }
    if (!budC || !C.some(function (c) { return String(c.id) === String(budC); })) budC = String(C[0].id);
    var c = C.find(function (x) { return String(x.id) === budC; }), bd = budgetOf(c), lines = S.lines.filter(function (l) { return String(l.contract_id) === budC; });
    var head = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:12px"><select onchange="vlBudPick(this.value)" style="width:auto">' + C.map(function (x) { return '<option value="' + esc(x.id) + '"' + (String(x.id) === budC ? ' selected' : '') + '>' + esc(x.name) + '</option>'; }).join('') + '</select>' +
      (S.sql.bud ? '' : '<span style="font-size:12px;color:#B7791F">Not saved yet: run ai-office.sql in Supabase to keep budgets.</span>') + '</div>';
    var stats = bd ? '<div class="stats-grid">' + [['Budget', gbp(bd.budget)], ['Spent', gbp(bd.spent)], ['Left', gbp(bd.budget - bd.spent)], ['Spent vs time', bd.pct + '%' + (bd.elapsed != null ? ' vs ' + bd.elapsed + '%' : '')]].map(function (s) { return '<div class="stat-card"><div class="stat-lbl">' + s[0] + '</div><div class="stat-val">' + s[1] + '</div></div>'; }).join('') + '</div>' : '';
    var table = '<div class="card"><div class="card-title">Budget lines</div>' + (bd ? '<div class="tbl-wrap"><table><thead><tr><th>Line</th><th>Budget</th><th>Spent</th><th>Left</th><th>% spent</th><th></th></tr></thead><tbody>' +
      bd.rows.map(function (r) { var pc = r.budget ? Math.round(r.spent / r.budget * 100) : 0, col = r.spent > r.budget ? '#B42318' : (bd.elapsed != null && pc > bd.elapsed + 15) ? '#B7791F' : 'inherit';
        return '<tr><td style="font-weight:600">' + esc(r.name) + '</td><td>' + gbp(r.budget) + '</td><td>' + gbp(r.spent) + '</td><td>' + gbp(r.budget - r.spent) + '</td><td style="color:' + col + ';font-weight:600">' + pc + '%</td><td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="vlBudDelLine(\'' + esc(r.id) + '\')">×</button></td></tr>'; }).join('') +
      '</tbody></table></div>' : '<div style="color:var(--txt3);font-size:13px;margin-bottom:8px">No budget lines yet for this contract.</div>') +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"><input id="ao-bl-name" placeholder="Line, e.g. Staff costs" style="flex:2;min-width:160px"/><input id="ao-bl-amt" type="number" min="0" placeholder="Budget £" style="flex:1;min-width:100px"/><button class="btn btn-p btn-sm" onclick="vlBudAddLine()">+ Add line</button></div></div>';
    var spend = S.spend.filter(function (s) { return lines.some(function (l) { return String(l.id) === String(s.line_id); }); }).sort(function (a, b) { return a.spend_date < b.spend_date ? 1 : -1; });
    var spendCard = lines.length ? '<div class="card" style="margin-top:14px"><div class="card-title">Spend</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px"><select id="ao-sp-line" style="flex:2;min-width:150px">' + lines.map(function (l) { return '<option value="' + esc(l.id) + '">' + esc(l.name) + '</option>'; }).join('') + '</select>' +
      '<input id="ao-sp-date" type="date" value="' + today() + '" style="flex:1;min-width:130px"/><input id="ao-sp-amt" type="number" min="0" step="0.01" placeholder="£" style="flex:1;min-width:90px"/><input id="ao-sp-note" placeholder="What for (optional)" style="flex:2;min-width:150px"/><button class="btn btn-p btn-sm" onclick="vlBudAddSpend()">+ Add spend</button></div>' +
      (spend.length ? '<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Line</th><th>Amount</th><th>Note</th><th></th></tr></thead><tbody>' + spend.slice(0, 40).map(function (s) { var l = lines.find(function (x) { return String(x.id) === String(s.line_id); });
        return '<tr><td>' + esc(fmt(s.spend_date)) + '</td><td>' + esc(l ? l.name : '') + '</td><td>' + gbp(s.amount) + '</td><td>' + esc(s.note || '') + '</td><td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="vlBudDelSpend(\'' + esc(s.id) + '\')">×</button></td></tr>'; }).join('') + '</tbody></table></div>' : '<div style="color:var(--txt3);font-size:13px">No spend logged yet.</div>') + '</div>' : '';
    el.innerHTML = head + stats + table + spendCard + '<div style="font-size:12px;color:var(--txt3);margin-top:10px">Budget and spend go into this contract’s funder reports.</div>';
  }
  window.vlBudPick = function (id) { budC = String(id); renderBudget(); };
  window.vlBudAddLine = async function () {
    var nm = ($('ao-bl-name').value || '').trim(), amt = n($('ao-bl-amt').value); if (!nm || !amt) { alert('Add a name and an amount.'); return; }
    try { await save('budget_lines', { contract_id: budC, name: nm, amount: amt }, 'lines'); } catch (e) { alert('Couldn’t save: ' + e.message); }
    renderBudget();
  };
  window.vlBudDelLine = async function (id) {
    if (!confirm('Delete this budget line and its spend?')) return;
    S.spend = S.spend.filter(function (s) { return String(s.line_id) !== String(id); });
    await remove('budget_lines', 'lines', id); renderBudget();
  };
  window.vlBudAddSpend = async function () {
    var amt = n($('ao-sp-amt').value); if (!amt) { alert('Add an amount.'); return; }
    try { await save('budget_spend', { line_id: $('ao-sp-line').value, spend_date: $('ao-sp-date').value || today(), amount: amt, note: ($('ao-sp-note').value || '').trim() || null }, 'spend'); } catch (e) { alert('Couldn’t save: ' + e.message); }
    renderBudget();
  };
  window.vlBudDelSpend = async function (id) { await remove('budget_spend', 'spend', id); renderBudget(); };
  // one line for the contract's funder report (reporting-periods.js)
  window.vlBudgetFacts = function (c, period) {
    if (!on() || !c) return '';
    var bd = budgetOf(c); if (!bd) return '';
    var inP = function (s) { return !period || !period.from || inR(s.spend_date, period.from, period.to); };
    var ids = {}; bd.rows.forEach(function (r) { ids[String(r.id)] = r; });
    var per = {}; S.spend.forEach(function (s) { if (ids[String(s.line_id)] && inP(s)) per[s.line_id] = (per[s.line_id] || 0) + n(s.amount); });
    var pSum = Object.keys(per).reduce(function (a, k) { return a + per[k]; }, 0);
    return '\nBUDGET AND SPEND (use only these figures; describe spend against budget plainly)\nBudget: ' + gbp(bd.budget) + '; spent to date: ' + gbp(bd.spent) + ' (' + bd.pct + '% of the budget' + (bd.elapsed != null ? ', with ' + bd.elapsed + '% of the contract period gone' : '') + ')' +
      (period && period.from ? '\nSpent in this reporting period: ' + gbp(pSum) : '') +
      '\nBy budget line (spent to date of budget): ' + bd.rows.map(function (r) { return r.name + ' ' + gbp(r.spent) + ' of ' + gbp(r.budget) + (r.spent > r.budget ? ' (over budget)' : ''); }).join('; ');
  };

  // ── 7. Donations page ─────────────────────────────────────────
  var donShow = 'all';
  async function renderDonations() {
    var el = $('ao-don-body'); if (!el) return;
    if (!S.loaded) await load();
    var y = new Date(), fy = (y.getMonth() >= 3 ? y.getFullYear() : y.getFullYear() - 1) + '-04-01';
    var D = S.don.slice().sort(function (a, b) { return String(a.gift_date) < String(b.gift_date) ? 1 : -1; });
    var thisFY = D.filter(function (d) { return String(d.gift_date) >= fy; });
    var ga = thisFY.reduce(function (a, d) { return a + giftAidable(d); }, 0), unth = D.filter(function (d) { return !d.thanked_at; });
    var show = donShow === 'unthanked' ? unth : donShow === 'restricted' ? D.filter(function (d) { return d.fund; }) : D;
    var stats = '<div class="stats-grid">' + [['Given this financial year', gbp(thisFY.reduce(function (a, d) { return a + n(d.amount); }, 0))], ['Gifts', thisFY.length], ['Gift Aid to claim', gbp(ga)], ['Not thanked', unth.length]].map(function (s) { return '<div class="stat-card"><div class="stat-lbl">' + s[0] + '</div><div class="stat-val">' + s[1] + '</div></div>'; }).join('') + '</div>';
    var funds = {}; thisFY.filter(function (d) { return d.fund; }).forEach(function (d) { funds[d.fund] = (funds[d.fund] || 0) + n(d.amount); });
    var fundLine = Object.keys(funds).length ? '<div style="font-size:13px;color:var(--txt2);margin:-4px 0 12px">Restricted this year: ' + Object.keys(funds).map(function (k) { return esc(k) + ' ' + gbp(funds[k]); }).join(' · ') + '</div>' : '';
    var form = '<div class="card" style="margin-bottom:14px"><div class="card-title">Add a donation</div><div style="display:flex;gap:6px;flex-wrap:wrap">' +
      '<input id="ao-d-name" placeholder="Donor name" style="flex:2;min-width:150px"/><input id="ao-d-email" placeholder="Email (optional)" style="flex:2;min-width:150px"/><input id="ao-d-amt" type="number" min="0" step="0.01" placeholder="£" style="flex:1;min-width:80px"/><input id="ao-d-date" type="date" value="' + today() + '" style="flex:1;min-width:130px"/>' +
      '<select id="ao-d-method" style="flex:1;min-width:120px"><option>Card</option><option>Bank transfer</option><option>Direct debit</option><option>Cash</option><option>Cheque</option><option>Online platform</option></select>' +
      '<input id="ao-d-fund" placeholder="Restricted fund (leave empty if unrestricted)" style="flex:2;min-width:200px"/><label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" id="ao-d-ga" style="width:auto"/> Gift Aid declaration</label><button class="btn btn-p btn-sm" onclick="vlDonAdd()">+ Add</button></div>' +
      (S.sql.don ? '' : '<div style="font-size:12px;color:#B7791F;margin-top:8px">Not saved yet: run ai-office.sql in Supabase to keep donations.</div>') + '</div>';
    var tabs = '<div style="display:flex;gap:6px;margin-bottom:8px">' + [['all', 'All'], ['unthanked', 'Not thanked'], ['restricted', 'Restricted']].map(function (t) { return '<button class="btn btn-sm ' + (donShow === t[0] ? 'btn-p' : 'btn-ghost') + '" onclick="vlDonShow(\'' + t[0] + '\')">' + t[1] + '</button>'; }).join('') + '<button class="btn btn-ghost btn-sm ml-auto" onclick="vlDonCSV()">Export CSV</button></div>';
    var table = show.length ? '<div class="tbl-wrap"><table><thead><tr><th>Date</th><th>Donor</th><th>Amount</th><th>Method</th><th>Fund</th><th>Gift Aid</th><th>Thanked</th><th></th></tr></thead><tbody>' + show.map(function (d) {
      return '<tr><td>' + esc(fmt(d.gift_date)) + '</td><td style="font-weight:600">' + esc(d.donor_name) + '</td><td>' + gbp(d.amount) + '</td><td>' + esc(d.method || '') + '</td><td>' + esc(d.fund || 'Unrestricted') + '</td><td>' + (d.gift_aid ? 'Yes' : '—') + '</td>' +
        '<td>' + (d.thanked_at ? esc(fmt(d.thanked_at)) : '<button class="btn btn-ai btn-sm" onclick="vlDonThank(\'' + esc(d.id) + '\')">Write thank-you</button>') + '</td><td style="text-align:right"><button class="btn btn-ghost btn-sm" onclick="vlDonDel(\'' + esc(d.id) + '\')">×</button></td></tr>' +
        '<tr id="ao-th-' + esc(d.id) + '" style="display:none"><td colspan="8"></td></tr>';
    }).join('') + '</tbody></table></div>' : '<div class="card" style="color:var(--txt3)">No donations here yet.</div>';
    el.innerHTML = stats + fundLine + form + tabs + table;
  }
  window.vlDonShow = function (k) { donShow = k; renderDonations(); };
  window.vlDonAdd = async function () {
    var nm = ($('ao-d-name').value || '').trim(), amt = n($('ao-d-amt').value); if (!nm || !amt) { alert('Add the donor’s name and the amount.'); return; }
    var fund = ($('ao-d-fund').value || '').trim();
    try { await save('donations', { donor_name: nm, donor_email: ($('ao-d-email').value || '').trim() || null, amount: amt, gift_date: $('ao-d-date').value || today(), method: $('ao-d-method').value, gift_aid: $('ao-d-ga').checked, fund: fund || null, restricted: !!fund }, 'don'); }
    catch (e) { alert('Couldn’t save: ' + e.message); }
    renderDonations();
  };
  window.vlDonDel = async function (id) { if (!confirm('Delete this donation?')) return; await remove('donations', 'don', id); renderDonations(); };
  window.vlDonThank = async function (id) {
    var d = S.don.find(function (x) { return String(x.id) === String(id); }); if (!d) return;
    var row = $('ao-th-' + id); row.style.display = ''; var cell = row.firstChild; cell.innerHTML = '<div style="color:var(--txt3);font-size:13px">Writing…</div>';
    var prev = S.don.filter(function (x) { return x.donor_name === d.donor_name && String(x.id) !== String(id); }).length;
    var facts = factsFor(iso(addDays(new Date(), -90)), today(), { quotes: 2 });
    var sys = 'Write a short, warm thank-you email from a UK charity to a donor. 70-110 words, starting "Dear <first name>,". Say what the gift helps with, using one or two real figures from the recent work in the facts' + (d.fund ? ' and the restricted fund it goes to' : '') + '. ' + (prev ? 'They have given before: thank them for their continued support. ' : '') +
      (d.gift_aid ? 'Mention that Gift Aid adds 25p to every pound at no cost to them. ' : '') + 'Never invent figures, people or plans; never name anyone the charity supports. British English. Sign off "With thanks, the team at ' + orgName() + '". No subject line, no headings.';
    var txt;
    try { txt = await callClaude(sys, 'Donor: ' + d.donor_name + '\nGift: ' + gbp(d.amount) + ' on ' + fmt(d.gift_date) + (d.fund ? '\nFund: ' + d.fund : '\nUnrestricted gift') + '\n\nRecent work:\n' + facts, 400, false, { purpose: 'donor-thanks' }); }
    catch (e) { cell.innerHTML = '<div class="alert alert-warn">' + esc(e.message) + '</div>'; return; }
    cell.innerHTML = '<div id="ao-thx-' + esc(id) + '" contenteditable="true" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.6;white-space:pre-wrap;outline:none">' + esc(txt.trim()) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:8px"><button class="btn btn-ghost btn-sm" onclick="vlCopyEl(\'ao-thx-' + esc(id) + '\',this)">Copy</button>' + (d.donor_email ? '<a class="btn btn-ghost btn-sm" href="mailto:' + esc(d.donor_email) + '?subject=' + encodeURIComponent('Thank you from ' + orgName()) + '&body=' + encodeURIComponent(txt.trim()) + '">Open in email</a>' : '') +
      '<button class="btn btn-p btn-sm" onclick="vlDonThanked(\'' + esc(id) + '\')">Mark as thanked</button></div>';
  };
  window.vlDonThanked = async function (id) { await patch('donations', 'don', id, { thanked_at: new Date().toISOString() }); renderDonations(); };
  window.vlDonCSV = function () {
    var rows = [['Date', 'Donor', 'Email', 'Amount', 'Method', 'Fund', 'Gift Aid', 'Gift Aid value', 'Thanked']].concat(S.don.map(function (d) { return [d.gift_date, d.donor_name, d.donor_email || '', n(d.amount).toFixed(2), d.method || '', d.fund || 'Unrestricted', d.gift_aid ? 'Yes' : 'No', giftAidable(d).toFixed(2), d.thanked_at ? String(d.thanked_at).slice(0, 10) : '']; }));
    var csv = rows.map(function (r) { return r.map(function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'donations.csv'; a.click();
  };

  // ── Pages, nav, router ────────────────────────────────────────
  var PAGES = {
    calendar: { title: 'Funding calendar', sub: 'Report deadlines, contract ends, renewals and bid deadlines', body: 'ao-cal-body', render: renderCalendar, extra: '<button class="btn btn-ghost btn-sm" onclick="vlCalendarICS()">Add to my calendar (.ics)</button>' },
    budget: { title: 'Budgets', sub: 'Budget lines and spend for each contract', body: 'ao-bud-body', render: renderBudget, extra: '' },
    donations: { title: 'Donations', sub: 'Gifts, Gift Aid, restricted funds and thank-yous', body: 'ao-don-body', render: renderDonations, extra: '' }
  };
  function injectPages() {
    var main = $('main'); if (!main) return;
    Object.keys(PAGES).forEach(function (k) {
      if ($('page-' + k)) return; var P = PAGES[k], d = document.createElement('div'); d.className = 'page'; d.id = 'page-' + k;
      d.innerHTML = '<div class="page-header"><div><div class="page-title">' + P.title + '</div><div class="page-sub">' + P.sub + '</div></div>' + P.extra + '</div><div id="' + P.body + '"></div>';
      main.appendChild(d);
    });
  }
  window.VL_EXTRA_PAGES = { calendar: function () { renderCalendar(); }, budget: function () { renderBudget(); }, donations: function () { renderDonations(); } };
  function showNav() { window.__aoOn = true; document.querySelectorAll('.nav-btn.ao-only').forEach(function (b) { b.style.display = ''; }); }

  function init() {
    if (!on()) return;
    injectPages(); showNav(); askUI(); commsCard(); annualCard(); wrapBriefing();
    load().then(function () { if ($('page-dashboard') && $('page-dashboard').classList.contains('active')) autoBriefing(); });
    var og = window.go;
    if (typeof og === 'function' && !og._ao) {
      window.go = function (page) { var r = og.apply(this, arguments); if (page === 'dashboard') setTimeout(autoBriefing, 300); if (page === 'reports') annualCard(); return r; };
      window.go._ao = true;
    }
  }
  // wait for sign-in and the organisation to load
  var tries = 0;
  (function wait() {
    if (typeof currentOrg !== 'undefined' && currentOrg && $('main') && typeof go === 'function' && typeof runAgent === 'function' && (DB.events || []).length + (DB.participants || []).length + (DB.contracts || []).length > 0) return setTimeout(init, 600);
    if (++tries > 60) { if (typeof currentOrg !== 'undefined' && currentOrg) init(); return; }
    setTimeout(wait, 500);
  })();

  if (window.__VORLANA_TEST) window.__aoTest = { S: S, checks: checks, calItems: calItems, factsFor: factsFor, budgetOf: budgetOf, reportPeriods: reportPeriods, load: load };
})();
