// js/extensions/office-plus.js — more of the back office (demo account only, with ai-office.js)
//   • Gift Aid claim: the HMRC schedule for gifts with a declaration, the addresses it still needs, and "mark as claimed"
//   • Thank-yous sent from Vorlana in one tap (api/office.js), not copied out
//   • Trustee pack: a monthly board report written from the records (Reports)
//   • Key dates: insurance, annual return, policy reviews, DBS renewals, on the funding calendar and the morning checks
//   • Company partners: list a team day or something to fund; companies find it on companies.html and enquire
// Needs ai-office.sql.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var A = function () { return window.vlAO; };
  var KD = [], OFF = [], ENQ = [], sqlOk = true, gaMsg = '', coMsg = '';
  var chain = function (name, fn) { var prev = window[name]; window[name] = function () { var r = typeof prev === 'function' ? prev.apply(this, arguments) : undefined; var mine = fn.apply(this, arguments); return name === 'vlExtraChecks' || name === 'vlExtraCal' ? (r || []).concat(mine || []) : (typeof r === 'string' || typeof mine === 'string') ? (r || '') + (mine || '') : (r && r.then ? r.then(function () { return mine; }) : mine); }; };

  async function token() { try { var s = await sb.auth.getSession(); return (s && s.data && s.data.session && s.data.session.access_token) || ''; } catch (e) { return ''; } }
  async function api(body) {
    var r = await fetch('/api/office', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (await token()) }, body: JSON.stringify(Object.assign({ org_id: A().oid() }, body)) });
    var j = await r.json().catch(function () { return {}; }); if (!r.ok || j.ok === false) throw new Error(j.error || ('Error ' + r.status)); return j;
  }
  async function ins(table, row, list) {
    if (!sqlOk) { row.id = 'mem-' + Date.now() + Math.random().toString(36).slice(2, 6); list.push(row); return row; }
    var r = await sb.from(table).insert([Object.assign({ org_id: A().oid() }, row)]).select(); if (r.error) throw new Error(r.error.message);
    var s = (r.data && r.data[0]) || row; list.push(s); return s;
  }
  async function upd(table, id, p, list) { var x = list.find(function (k) { return String(k.id) === String(id); }); if (x) Object.assign(x, p); if (sqlOk && !/^(mem|demo)-/.test(String(id))) { var r = await sb.from(table).update(p).eq('id', id); if (r && r.error) alert(r.error.message); } }
  async function del(table, id, list) { var i = list.findIndex(function (k) { return String(k.id) === String(id); }); if (i >= 0) list.splice(i, 1); if (sqlOk && !/^(mem|demo)-/.test(String(id))) await sb.from(table).delete().eq('id', id); }

  chain('vlAOLoaded', async function () {
    var a = A(), res = await Promise.all([a.q('key_dates'), a.q('company_offers'), a.q('company_enquiries')]);
    sqlOk = res[0] !== null && res[1] !== null;
    KD = res[0] || []; OFF = res[1] || []; ENQ = res[2] || [];
    if (a.isDemo() && !KD.some(function (k) { return k._demo; })) [['Public liability insurance renewal', 18, 12], ['Charity Commission annual return', 64, 12], ['Safeguarding policy review', -6, 12], ['DBS checks: review who is due', 95, 12]].forEach(function (k, i) {
      KD.push({ id: 'demo-kd-' + i, _demo: true, title: k[0], due_date: a.iso(a.addDays(new Date(), k[1])), repeat_months: k[2], done_at: null });
    });
    if (a.isDemo() && !OFF.some(function (o) { return o._demo; })) {
      OFF.push({ id: 'demo-of-1', _demo: true, kind: 'team_day', title: 'Team day in the community garden', description: 'Bring up to 12 colleagues for a day of planting, path clearing and building raised beds alongside our Wednesday growing group. Tools, gloves and lunch from the garden provided.', offer_date: a.iso(a.addDays(new Date(), 40)), places: 12, amount: 600, area: 'Riverside', cause: 'Community and environment', open: true });
      ENQ.push({ id: 'demo-en-1', _demo: true, offer_id: 'demo-of-1', company: 'Fenmoor Building Society', contact_name: 'Neil Barker', email: 'neil.barker@example.com', people: 10, message: 'We have a volunteering day to use before March. Is the garden day still free?', status: 'new', created_at: new Date().toISOString() });
    }
  });

  // ── Gift Aid claim (Donations page) ───────────────────────────
  var claimable = function () { return A().S.don.filter(function (d) { return d.gift_aid && !d.gift_aid_claimed_at && A().n(d.amount) > 0; }); };
  var hasAddr = function (d) { return !!(String(d.donor_house || '').trim() && String(d.donor_postcode || '').trim()); };
  chain('vlDonTop', function () {
    var a = A(), esc = a.esc, C = claimable(); if (!C.length && !gaMsg) return '';
    var ready = C.filter(hasAddr), need = {}; C.filter(function (d) { return !hasAddr(d); }).forEach(function (d) { need[d.donor_name] = (need[d.donor_name] || 0) + 1; });
    var names = Object.keys(need), total = function (L) { return L.reduce(function (s, d) { return s + a.giftAidable(d); }, 0); };
    return '<div class="card" style="margin-bottom:14px"><div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div class="card-title" style="margin:0">Gift Aid claim</div>' +
      '<div style="display:flex;gap:6px"><button class="btn btn-p btn-sm" onclick="vlGAExport()"' + (ready.length ? '' : ' disabled') + '>Download HMRC schedule (' + ready.length + ')</button>' + (ready.length ? '<button class="btn btn-ghost btn-sm" onclick="vlGAClaimed()">Mark these as claimed</button>' : '') + '</div></div>' +
      '<div style="font-size:13px;color:var(--txt2);margin:6px 0">' + a.gbp(total(ready)) + ' ready to claim from ' + ready.length + ' gift' + (ready.length === 1 ? '' : 's') + (names.length ? '. ' + a.gbp(total(C) - total(ready)) + ' more is waiting on a home address for ' + names.length + ' donor' + (names.length === 1 ? '' : 's') + ' (HMRC needs house number and postcode).' : '.') + '</div>' +
      names.slice(0, 8).map(function (nm, i) { return '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:13px;padding:5px 0;border-top:1px solid var(--border)"><span style="flex:2;min-width:140px"><b>' + esc(nm) + '</b> · ' + need[nm] + ' gift' + (need[nm] === 1 ? '' : 's') + '</span><input id="ga-h-' + i + '" placeholder="House name or number" style="flex:2;min-width:130px"/><input id="ga-p-' + i + '" placeholder="Postcode" style="flex:1;min-width:90px"/><button class="btn btn-ghost btn-sm" onclick="vlGAAddr(' + i + ')">Save</button></div>'; }).join('') +
      (names.length > 8 ? '<div style="font-size:12px;color:var(--txt3)">and ' + (names.length - 8) + ' more donors</div>' : '') +
      '<div style="font-size:11px;color:var(--txt3);margin-top:8px">Only gifts from individuals with a Gift Aid declaration can be claimed. The file is in the layout of HMRC’s Gift Aid schedule: paste it into their spreadsheet in Charities Online.' + (gaMsg ? ' <b>' + esc(gaMsg) + '</b>' : '') + '</div></div>';
  });
  window.vlGAAddr = async function (i) {
    var a = A(), need = []; claimable().filter(function (d) { return !hasAddr(d); }).forEach(function (d) { if (need.indexOf(d.donor_name) === -1) need.push(d.donor_name); });
    var nm = need[i], h = ($('ga-h-' + i).value || '').trim(), p = ($('ga-p-' + i).value || '').trim().toUpperCase(); if (!nm || !h || !p) { alert('Add the house name or number and the postcode.'); return; }
    var list = a.S.don.filter(function (d) { return d.donor_name === nm; });
    for (var k = 0; k < list.length; k++) await a.patch('donations', 'don', list[k].id, { donor_house: h, donor_postcode: p });
    a.renderDonations();
  };
  function gaRows() {
    return claimable().filter(hasAddr).map(function (d) {
      var parts = String(d.donor_name).trim().split(/\s+/), title = /^(mr|mrs|ms|miss|dr|mx|rev|prof)\.?$/i.test(parts[0]) ? parts.shift() : '';
      var dt = String(d.gift_date).slice(0, 10).split('-');
      return [title, parts[0] || '', parts.slice(1).join(' ') || parts[0] || '', d.donor_house, d.donor_postcode, '', '', dt[2] + '/' + dt[1] + '/' + dt[0].slice(2), A().n(d.amount).toFixed(2)];
    });
  }
  window.vlGAExport = function () {
    var rows = [['Title', 'First name', 'Last name', 'House name or number', 'Postcode', 'Aggregated donations', 'Sponsored event', 'Donation date', 'Amount']].concat(gaRows());
    var csv = rows.map(function (r) { return r.map(function (v) { v = String(v == null ? '' : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(','); }).join('\n');
    var el = document.createElement('a'); el.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); el.download = 'gift-aid-schedule-' + A().today() + '.csv'; el.click();
    gaMsg = 'Downloaded. Once HMRC has it, press “Mark these as claimed” so they aren’t claimed twice.'; A().renderDonations();
  };
  window.vlGAClaimed = async function () {
    var a = A(), list = claimable().filter(hasAddr); if (!list.length || !confirm('Mark ' + list.length + ' gift' + (list.length === 1 ? '' : 's') + ' as claimed from HMRC?')) return;
    var now = new Date().toISOString(); for (var i = 0; i < list.length; i++) await a.patch('donations', 'don', list[i].id, { gift_aid_claimed_at: now });
    gaMsg = list.length + ' gifts marked as claimed.'; a.renderDonations();
  };
  window.__gaRows = gaRows;

  // ── Thank-you sent in one tap ─────────────────────────────────
  window.vlThanksExtra = function (d) {
    if (!d.donor_email || /^(demo|mem)-/.test(String(d.id))) return '';
    return '<button class="btn btn-ai btn-sm" onclick="vlThanksSend(\'' + A().esc(d.id) + '\',this)">Send from Vorlana</button>';
  };
  window.vlThanksSend = async function (id, btn) {
    var box = $('ao-thx-' + id), text = box ? box.innerText.trim() : ''; if (!text) return;
    btn.disabled = true; btn.textContent = 'Sending…';
    try { var j = await api({ action: 'send_thanks', donation_id: id, text: text }); var d = A().S.don.find(function (x) { return String(x.id) === String(id); }); if (d) { d.thanked_at = j.thanked_at; d.thanks_sent_at = j.thanked_at; } A().renderDonations(); if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks(); }
    catch (e) { btn.disabled = false; btn.textContent = 'Send from Vorlana'; alert(e.message); }
  };

  // ── Trustee pack (Reports page) ───────────────────────────────
  function trusteeCard() {
    var host = $('ao-annual'); if (!host || $('op-trustee')) return;
    var d = document.createElement('div'); d.id = 'op-trustee'; d.style.cssText = 'border-top:1px solid var(--border);margin-top:14px;padding-top:12px';
    d.innerHTML = '<div style="font-weight:700;margin-bottom:2px">Trustee pack</div><div style="font-size:13px;color:var(--txt2);margin-bottom:8px">A board report for the last month: delivery, contracts against targets, money, and the risks trustees should know about. No names.</div>' +
      '<button class="btn btn-ai btn-sm" onclick="vlTrusteePack()">✦ Write this month’s trustee pack</button>';
    host.insertBefore(d, $('ao-annual-out'));
  }
  window.vlTrusteePack = async function () {
    var a = A(), out = $('ao-annual-out'), to = a.today(), from = a.iso(a.addDays(new Date(), -31)), y = new Date(), fy = (y.getMonth() >= 3 ? y.getFullYear() : y.getFullYear() - 1) + '-04-01';
    var checks = a.checksFor('trustee').map(function (c) { return (c.lvl === 'red' ? 'URGENT: ' : '') + c.text; });
    var keys = KD.filter(function (k) { return !k.done_at && k.due_date <= a.iso(a.addDays(new Date(), 60)); }).map(function (k) { return k.title + ': due ' + a.fmt(k.due_date) + (k.due_date < to ? ' (overdue)' : ''); });
    var facts = 'LAST MONTH\n' + a.factsFor(from, to, { quotes: 2, budgetLines: true, eventList: 4 }) + '\n\nFINANCIAL YEAR TO DATE\n' + a.factsFor(fy, to, { quotes: 0, eventList: 0 }) +
      '\n\nRISKS AND THINGS TO NOTE\n' + (checks.join('\n') || 'none') + '\n\nGOVERNANCE DATES (next 60 days)\n' + (keys.join('\n') || 'none');
    window._aoFacts = window._aoFacts || {}; window._aoFacts.annual = facts;
    var label = 'Trustee report · ' + new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    var sys = 'You are writing the monthly report to a UK charity\'s board of trustees, from the facts only. Sections, each starting with ## and exactly this title: Headlines, Delivery this month, Contracts and targets, Money, Risks and governance, For the board to decide. ' +
      'Headlines: three or four bullets a busy trustee must know, the most serious first. Contracts and targets: each live contract with its progress and time gone, as given. Money: donations, Gift Aid, budgets and spend as given; if none are given say finance figures come from the accounts. ' +
      'Risks and governance: everything in RISKS AND THINGS TO NOTE and GOVERNANCE DATES, plainly, urgent first; if both say none, say there is nothing to flag. For the board to decide: only decisions the facts clearly call for (for example a contract ending with no renewal); otherwise the single line "[Chair to add: items for decision]". ' +
      'Never name a participant, volunteer or donor. Never invent figures, plans or reasons; never add up or recalculate; say which period a figure covers. Write as "we". British English, plain and direct, no emoji, no hashtags except heading markers. 350-500 words.';
    var raw = await runAgent({ container: out, headerLabel: 'Trustee pack', headerSub: 'Reading the last month',
      steps: [{ label: 'Reading delivery', meta: '' }, { label: 'Checking contracts and money', meta: '' }, { label: 'Listing risks and key dates', meta: checks.length + keys.length + ' to note' }, { label: 'Writing', meta: '' }, { label: 'Ready', meta: '' }], sys: sys, prompt: facts, maxTok: 1000, ai: { purpose: 'trustee-pack', long: true } });
    if (!raw) return; if (typeof vlAutoFix === 'function') raw = vlAutoFix(raw).text || raw;
    out.innerHTML = '<div class="card"><div style="font-size:20px;font-weight:700;margin-bottom:2px">' + a.esc(a.orgName()) + '</div><div style="color:var(--txt3);margin-bottom:12px">' + a.esc(label) + '</div>' +
      '<div id="ao-annual-text" class="report-body" contenteditable="true" style="outline:none;line-height:1.65">' + aiPanelHTML(raw) + '</div>' +
      '<div class="no-print" style="display:flex;gap:6px;margin-top:12px"><button class="btn btn-ghost btn-sm" onclick="vlCopyEl(\'ao-annual-text\',this)">Copy</button><button class="btn btn-ghost btn-sm" onclick="vlPrintAnnual()">Download PDF</button></div></div>';
  };

  // ── Key dates (funding calendar + morning checks) ─────────────
  chain('vlExtraCal', function (t, until) { return KD.filter(function (k) { return !k.done_at && k.due_date <= until; }).map(function (k) { return { date: k.due_date < t ? t : k.due_date, kind: 'date', what: k.title + (k.due_date < t ? ' (was due ' + A().fmt(k.due_date) + ')' : ''), page: 'calendar' }; }); });
  chain('vlExtraChecks', function () {
    var a = A(), t = a.today(), soon = a.iso(a.addDays(new Date(), 30)), out = [];
    KD.forEach(function (k) { if (k.done_at) return; if (k.due_date < t) out.push({ lvl: 'red', page: 'calendar', text: k.title + ' was due ' + a.fmt(k.due_date) }); else if (k.due_date <= soon) out.push({ lvl: 'amber', page: 'calendar', text: k.title + ' is due ' + a.fmt(k.due_date) }); });
    var nw = ENQ.filter(function (e) { return e.status === 'new'; });
    if (nw.length) out.push({ lvl: 'amber', page: 'companies', text: nw.length + ' compan' + (nw.length === 1 ? 'y has' : 'ies have') + ' asked about working with you: ' + nw.slice(0, 3).map(function (e) { return e.company; }).join(', ') });
    return out;
  });
  var USUAL = ['Charity Commission annual return', 'Annual accounts filing', 'Public liability insurance renewal', 'Employers’ liability insurance renewal', 'Safeguarding policy review', 'Data protection (ICO) fee', 'DBS checks: review who is due', 'Health and safety risk assessment review', 'Trustee AGM'];
  window.vlCalAfter = function () {
    var page = $('page-calendar'); if (!page) return; var box = $('op-kd'); if (!box) { box = document.createElement('div'); box.id = 'op-kd'; box.className = 'card'; box.style.marginTop = '14px'; page.appendChild(box); }
    var a = A(), esc = a.esc, t = a.today(), list = KD.filter(function (k) { return !k.done_at; }).sort(function (x, y) { return x.due_date < y.due_date ? -1 : 1; });
    box.innerHTML = '<div class="card-title">Key dates</div><div style="font-size:13px;color:var(--txt2);margin-bottom:8px">Insurance, annual return, policy reviews, DBS renewals. Add each once: Vorlana reminds you 30 days ahead and rolls yearly ones on when you tick them.</div>' +
      list.map(function (k) { return '<div style="display:flex;gap:10px;align-items:center;font-size:13px;padding:7px 0;border-top:1px solid var(--border)"><span style="width:92px;font-weight:600;color:' + (k.due_date < t ? '#B42318' : 'inherit') + '">' + esc(a.fmt(k.due_date)) + '</span><span style="flex:1">' + esc(k.title) + (k.repeat_months ? ' <span style="color:var(--txt3)">· yearly</span>' : '') + '</span><button class="btn btn-p btn-sm" onclick="vlKDDone(\'' + esc(k.id) + '\')">Done</button><button class="btn btn-ghost btn-sm" onclick="vlKDDel(\'' + esc(k.id) + '\')">×</button></div>'; }).join('') +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px"><input id="kd-title" list="kd-usual" placeholder="What’s due (pick or type)" style="flex:3;min-width:200px"/><datalist id="kd-usual">' + USUAL.map(function (u) { return '<option value="' + esc(u) + '">'; }).join('') + '</datalist>' +
      '<input id="kd-date" type="date" style="flex:1;min-width:130px"/><label style="display:flex;gap:6px;align-items:center;font-size:13px"><input type="checkbox" id="kd-rep" checked style="width:auto"/> Every year</label><button class="btn btn-p btn-sm" onclick="vlKDAdd()">+ Add</button></div>' +
      (sqlOk ? '' : '<div style="font-size:12px;color:#B7791F;margin-top:8px">Not saved yet: run the latest ai-office.sql in Supabase.</div>');
  };
  var refreshCal = function () { A().renderCalendar().then(window.vlCalAfter); if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks(); };
  window.vlKDAdd = async function () { var t = ($('kd-title').value || '').trim(), d = $('kd-date').value; if (!t || !d) { alert('Add what’s due and the date.'); return; } try { await ins('key_dates', { title: t, due_date: d, repeat_months: $('kd-rep').checked ? 12 : null, done_at: null }, KD); } catch (e) { alert('Couldn’t save: ' + e.message); } refreshCal(); };
  window.vlKDDone = async function (id) { var k = KD.find(function (x) { return String(x.id) === String(id); }); if (!k) return; var a = A();
    if (k.repeat_months) { var nx = new Date(k.due_date + 'T12:00:00'); do { nx.setMonth(nx.getMonth() + k.repeat_months); } while (a.iso(nx) <= a.today()); await upd('key_dates', id, { due_date: a.iso(nx) }, KD); } else await upd('key_dates', id, { done_at: new Date().toISOString() }, KD);
    refreshCal(); };
  window.vlKDDel = async function (id) { if (!confirm('Remove this date?')) return; await del('key_dates', id, KD); refreshCal(); };

  // ── Company partners ──────────────────────────────────────────
  function coPage() {
    var main = $('main'); if (!main || $('page-companies')) return; var d = document.createElement('div'); d.className = 'page'; d.id = 'page-companies';
    d.innerHTML = '<div class="page-header"><div><div class="page-title">Company partners</div><div class="page-sub">Team volunteering days and things to fund, for companies looking to give</div></div><a class="btn btn-ghost btn-sm" href="companies.html" target="_blank">See the public page</a></div><div id="op-co"></div>';
    main.appendChild(d);
  }
  function renderCo() {
    var el = $('op-co'); if (!el) return; var a = A(), esc = a.esc;
    var enq = ENQ.slice().sort(function (x, y) { return String(x.created_at) < String(y.created_at) ? 1 : -1; });
    el.innerHTML = (enq.length ? '<div class="card" style="margin-bottom:14px"><div class="card-title">Enquiries</div>' + enq.map(function (e) { var o = OFF.find(function (x) { return String(x.id) === String(e.offer_id); });
        return '<div style="padding:9px 0;border-top:1px solid var(--border);font-size:13px"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><span><b>' + esc(e.company) + '</b>' + (e.contact_name ? ' · ' + esc(e.contact_name) : '') + (e.people ? ' · ' + e.people + ' people' : '') + ' · about ' + esc(o ? o.title : 'an offer') + '</span>' +
          '<span style="display:flex;gap:6px;align-items:center">' + (e.status === 'new' ? '<span class="badge" style="background:#FEF6E7;color:#B7791F">New</span>' : '<span class="badge" style="background:#E7F6EC;color:#1E7B3C">Replied</span>') + '<a class="btn btn-ghost btn-sm" href="mailto:' + esc(e.email) + '?subject=' + encodeURIComponent('Re: ' + (o ? o.title : 'your enquiry') + ' at ' + a.orgName()) + '">Reply</a>' + (e.status === 'new' ? '<button class="btn btn-p btn-sm" onclick="vlCoReplied(\'' + esc(e.id) + '\')">Mark replied</button>' : '') + '</span></div>' +
          (e.message ? '<div style="color:var(--txt2);margin-top:4px">' + esc(e.message) + '</div>' : '') + (typeof window.vlCoEnqExtra === 'function' ? window.vlCoEnqExtra(e, o) : '') + '</div>'; }).join('') + '</div>' : '') +
      '<div class="card" style="margin-bottom:14px"><div class="card-title">What you’re offering</div>' + (OFF.length ? OFF.map(function (o) {
        return '<div style="padding:9px 0;border-top:1px solid var(--border);font-size:13px;display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap"><div style="flex:1;min-width:240px"><b>' + esc(o.title) + '</b> <span class="badge" style="background:' + (o.kind === 'fund' ? '#E8F0FE;color:#1A56DB' : '#E7F6EC;color:#1E7B3C') + '">' + (o.kind === 'fund' ? 'To fund' : 'Team day') + '</span>' +
          '<div style="color:var(--txt3);margin:2px 0">' + esc([o.offer_date ? a.fmt(o.offer_date) : '', o.places ? 'up to ' + o.places + ' people' : '', o.amount ? a.gbp(o.amount) + (o.kind === 'fund' ? '' : ' suggested donation') : '', o.area].filter(Boolean).join(' · ')) + '</div><div style="color:var(--txt2)">' + esc(o.description || '') + '</div></div>' +
          '<div style="display:flex;gap:6px;align-items:flex-start"><button class="btn btn-ghost btn-sm" onclick="vlCoToggle(\'' + esc(o.id) + '\')">' + (o.open ? 'Close' : 'Reopen') + '</button><button class="btn btn-ghost btn-sm" onclick="vlCoDel(\'' + esc(o.id) + '\')">×</button></div></div>'; }).join('') : '<div style="font-size:13px;color:var(--txt3)">Nothing listed yet.</div>') + '</div>' +
      '<div class="card"><div class="card-title">Add an offer</div><div style="font-size:13px;color:var(--txt2);margin-bottom:8px">Say what it is in a few words and Vorlana writes the listing from what you actually do.</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap"><select id="co-kind" style="flex:1;min-width:130px"><option value="team_day">Team volunteering day</option><option value="fund">Something to fund</option></select><input id="co-title" placeholder="e.g. Garden clear-up day, or A term of cooking sessions" style="flex:3;min-width:220px"/>' +
      '<input id="co-date" type="date" title="Date (optional)" style="flex:1;min-width:130px"/><input id="co-places" type="number" min="1" placeholder="People" style="flex:1;min-width:80px"/><input id="co-amt" type="number" min="0" placeholder="£" style="flex:1;min-width:80px"/><input id="co-area" placeholder="Area or town" style="flex:1;min-width:120px"/></div>' +
      '<textarea id="co-desc" placeholder="Description (or press Write it for me)" style="min-height:80px;margin-top:8px"></textarea>' +
      '<div style="display:flex;gap:6px;margin-top:8px"><button class="btn btn-ai btn-sm" id="co-ai" onclick="vlCoWrite()">✦ Write it for me</button><button class="btn btn-p btn-sm" onclick="vlCoAdd()">List it</button></div>' +
      (coMsg ? '<div style="font-size:13px;color:var(--txt2);margin-top:8px">' + esc(coMsg) + '</div>' : '') + (sqlOk ? '' : '<div style="font-size:12px;color:#B7791F;margin-top:8px">Not saved yet, and not on the public page: run the latest ai-office.sql in Supabase.</div>') + '</div>';
  }
  window.vlCoWrite = async function () {
    var a = A(), title = ($('co-title').value || '').trim(), kind = $('co-kind').value, btn = $('co-ai'); if (!title) { alert('Say what the offer is first.'); return; }
    btn.disabled = true; btn.textContent = 'Writing…';
    try {
      var t = await callClaude('Write a listing a UK charity shows to companies looking for ' + (kind === 'fund' ? 'something worthwhile to fund' : 'a team volunteering day') + '. 60-90 words, one paragraph, warm and concrete: what the company\'s people will do or what the money pays for, who benefits, and one or two real figures from the charity\'s recent work in the facts. ' +
        'Use only the offer details and the facts; never invent activities, figures, facilities or promises (no mention of lunch, transport or photos unless given). Never name anyone the charity supports. British English, no emoji, no hashtags, no headings.',
        'Offer: ' + title + ($('co-places').value ? '\nPeople: up to ' + $('co-places').value : '') + ($('co-amt').value ? '\nAmount: £' + $('co-amt').value : '') + ($('co-date').value ? '\nDate: ' + a.fmt($('co-date').value) : '') + '\n\nThe charity\'s recent work:\n' + a.factsFor(a.iso(a.addDays(new Date(), -180)), a.today(), { quotes: 0, eventList: 4 }), 300, false, { purpose: 'company-offer' });
      $('co-desc').value = String(t || '').trim();
    } catch (e) { if (e.message !== 'AI_PLAN_GATE') alert('Couldn’t write it: ' + e.message); }
    btn.disabled = false; btn.textContent = '✦ Write it for me';
  };
  window.vlCoAdd = async function () {
    var title = ($('co-title').value || '').trim(); if (!title) { alert('Give the offer a title.'); return; }
    try { await ins('company_offers', { kind: $('co-kind').value, title: title, description: ($('co-desc').value || '').trim() || null, offer_date: $('co-date').value || null, places: parseInt($('co-places').value, 10) || null, amount: parseFloat($('co-amt').value) || null, area: ($('co-area').value || '').trim() || null, cause: (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.sector) || null, open: true }, OFF); coMsg = 'Listed. Companies can see it on the public page.'; }
    catch (e) { coMsg = 'Couldn’t save: ' + e.message; }
    renderCo();
  };
  window.vlCoToggle = async function (id) { var o = OFF.find(function (x) { return String(x.id) === String(id); }); if (o) await upd('company_offers', id, { open: !o.open }, OFF); renderCo(); };
  window.vlCoDel = async function (id) { if (!confirm('Remove this offer?')) return; await del('company_offers', id, OFF); renderCo(); };
  window.vlCoReplied = async function (id) { await upd('company_enquiries', id, { status: 'replied' }, ENQ); renderCo(); if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks(); };

  // ── start ─────────────────────────────────────────────────────
  var tries = 0;
  (function wait() {
    if (window.vlAO && window.vlAO.on() && $('ao-ask-btn')) {            // ai-office has started for this (demo) organisation
      coPage(); window.VL_EXTRA_PAGES = window.VL_EXTRA_PAGES || {}; window.VL_EXTRA_PAGES.companies = renderCo;
      setInterval(trusteeCard, 1200); return;
    }
    if (++tries > 120) return; setTimeout(wait, 500);
  })();
  window.vlOP = { ENQ: function () { return ENQ; }, OFF: function () { return OFF; }, renderCo: renderCo, api: api, upd: upd, addKeyDate: function (row) { return ins('key_dates', row, KD); }, sqlOk: function () { return sqlOk; } };
  if (window.__VORLANA_TEST) window.__opTest = { KD: function () { return KD; }, OFF: function () { return OFF; }, ENQ: function () { return ENQ; }, gaRows: gaRows };
})();
