// js/extensions/grow.js — finish the company journey, and set things up from a document (demo account only)
//   • After a company's team day: one tap logs the hours, writes the company's impact report, and emails it to them.
//   • Photo of a receipt: the AI reads the shop, date and amount; it waits with the bank payments to be sorted.
//   • Set up from a document: drop in a grant agreement or annual report (PDF, Word, photo or pasted text) and Vorlana
//     lists the contracts, targets, budget lines and key dates it found. Tick what's right and it creates them.
// Nothing is created from a document until a person has ticked it. Depends on ai-office.js, office-plus.js, money-auto.js.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var A = function () { return window.vlAO; }, OP = function () { return window.vlOP; };
  var on = function () { return !!(window.vlAO && window.vlAO.on()); };

  async function fileContent(f, label) {
    if (/^image\//.test(f.type)) return [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: await cxResize(f, 1600, 0.8, 2400000) } }];
    if (/\.pdf$/i.test(f.name) || f.type === 'application/pdf') {
      if (f.size > 2.4 * 1024 * 1024) throw new Error('That PDF is over 2.4 MB. Use the Word version, paste the text, or photograph the key pages.');
      var b64 = await new Promise(function (ok, bad) { var r = new FileReader(); r.onload = function () { ok(String(r.result).split(',')[1]); }; r.onerror = function () { bad(new Error('Could not read the file')); }; r.readAsDataURL(f); });
      return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } }];
    }
    if (/\.docx$/i.test(f.name) && window.mammoth) { var out = await window.mammoth.extractRawText({ arrayBuffer: await f.arrayBuffer() }); return [{ type: 'text', text: label + ':\n' + String(out.value || '').slice(0, 40000) }]; }
    return [{ type: 'text', text: label + ':\n' + (await f.text()).slice(0, 40000) }];
  }

  // ── After a company's team day ────────────────────────────────
  var openDay = null;
  window.vlCoEnqExtra = function (e, o) {
    var a = A(), esc = a.esc, id = esc(e.id);
    var done = e.day_date ? '<div style="font-size:12px;color:var(--txt3);margin-top:6px">Day done ' + esc(a.fmt(e.day_date)) + ': ' + (e.day_people || 0) + ' people, ' + (e.day_hours || 0) + ' hours logged' + (e.report_sent_at ? ' · report sent ' + esc(a.fmt(e.report_sent_at)) : '') + '</div>' : '';
    var form = openDay === String(e.id) ? '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px"><input id="cd-date" type="date" value="' + esc((o && o.offer_date && o.offer_date <= a.today() ? o.offer_date : a.today())) + '" style="width:auto"/><input id="cd-people" type="number" min="1" value="' + (e.people || (o && o.places) || '') + '" placeholder="People" style="width:90px"/><input id="cd-hours" type="number" min="0.5" step="0.5" value="6" title="Hours each" style="width:80px"/><span style="font-size:12px;color:var(--txt3)">hours each</span>' +
      '<button class="btn btn-p btn-sm" onclick="vlCoDayDone(\'' + id + '\')">Log it and write their report</button></div>' : '';
    var rep = e.report_text ? '<div style="margin-top:8px"><div id="cd-rep-' + id + '" contenteditable="true" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;line-height:1.6;outline:none">' + (typeof aiPanelHTML === 'function' ? aiPanelHTML(e.report_text) : esc(e.report_text)) + '</div>' +
      '<div style="display:flex;gap:6px;margin-top:6px"><button class="btn btn-ghost btn-sm" onclick="vlCopyEl(\'cd-rep-' + id + '\',this)">Copy</button>' + (/^(demo|mem)-/.test(String(e.id)) ? '' : '<button class="btn btn-ai btn-sm" onclick="vlCoSendReport(\'' + id + '\',this)">Email it to ' + esc(e.company) + '</button>') + '</div></div>' : '';
    if (o && o.kind === 'fund' && !e.day_date) return '';                      // only team days have a day to log
    return done + (e.day_date ? '' : '<div style="margin-top:6px"><button class="btn btn-ghost btn-sm" onclick="vlCoDayForm(\'' + id + '\')">The day has happened</button></div>') + form + '<div id="cd-status-' + id + '" style="font-size:12px;color:var(--txt3);margin-top:4px"></div>' + rep;
  };
  window.vlCoDayForm = function (id) { openDay = String(id); OP().renderCo(); };
  window.vlCoDayDone = async function (id) {
    var a = A(), op = OP(), e = op.ENQ().find(function (x) { return String(x.id) === String(id); }); if (!e) return;
    var o = op.OFF().find(function (x) { return String(x.id) === String(e.offer_id); }) || {};
    var date = $('cd-date').value || a.today(), people = parseInt($('cd-people').value, 10) || 0, each = parseFloat($('cd-hours').value) || 0;
    if (!people || !each) { alert('Add how many people came and the hours each.'); return; }
    var hours = Math.round(people * each * 10) / 10, st = $('cd-status-' + id); st.textContent = 'Logging ' + hours + ' volunteer hours…';
    try {
      // one volunteer record for the company's team, so their hours count in every report
      var nm = e.company + ' team', v = (DB.volunteers || []).find(function (x) { return String(x.name || '').toLowerCase() === nm.toLowerCase(); });
      var activity = 'Company team day: ' + (o.title || 'volunteering') + ' (' + people + ' people)';
      if (a.isDemo() || /^(demo|mem)-/.test(String(e.id))) {
        if (!v) { v = { id: 'mem-vol-' + Date.now(), name: nm, role: 'Corporate volunteer', status: 'Active', hours: 0 }; DB.volunteers.push(v); }
        (DB.volunteer_hours = DB.volunteer_hours || []).push({ id: 'mem-vh-' + Date.now(), volunteer_id: String(v.id), date: date, hours: hours, activity: activity });
      } else {
        if (!v) { await sbInsert('volunteers', { first_name: e.company, last_name: 'team', name: nm, email: e.email || null, role: 'Corporate volunteer', hours: 0, status: 'Active', skills: '[]' }); await refreshTable('volunteers'); v = (DB.volunteers || []).find(function (x) { return String(x.name || '').toLowerCase() === nm.toLowerCase(); }); }
        if (!v) throw new Error('could not create the team’s volunteer record');
        await sbInsert('volunteer_hours', { volunteer_id: String(v.id), event_id: null, session_date: date, hours: hours, activity: activity, source: 'staff' }); await refreshTable('volunteer_hours');
      }
      await op.upd('company_enquiries', id, { status: 'done', day_date: date, day_people: people, day_hours: hours }, op.ENQ());
      openDay = null; op.renderCo(); st = $('cd-status-' + id); if (st) st.textContent = 'Hours logged. Writing their impact report…';
      var y = new Date().getFullYear();
      var txt = await callClaude('Write a short impact report from a UK charity to a company whose staff volunteered with it, for the company\'s CSR and ESG reporting. Sections, each starting with ## and exactly this title: Your day, What it made possible, Our impact this year, Thank you. ' +
        'Your day: the date, how many people came and the hours given, as stated. What it made possible: what a day like this supports, using only the offer description and the charity\'s recorded work. Our impact this year: three or four real figures from the facts, as short bullets. Thank you: two sentences, and an invitation to come back. ' +
        'Use ONLY the details and facts given; never invent tasks completed, quantities, quotes or outcomes of the day itself; never name anyone the charity supports; never add up or recalculate figures. British English, warm and plain, no emoji, no hashtags except heading markers. 180-260 words.',
        'Company: ' + e.company + '\nDay: ' + (o.title || 'Team volunteering day') + '\nDate: ' + a.fmt(date) + '\nPeople: ' + people + '\nHours given in total: ' + hours + (o.description ? '\nWhat the day involves: ' + o.description : '') + '\n\nThe charity\'s records this year:\n' + a.factsFor(y + '-01-01', a.today(), { quotes: 0, eventList: 3 }), 600, false, { purpose: 'company-report' });
      if (typeof vlAutoFix === 'function') txt = vlAutoFix(String(txt)).text || txt;
      await op.upd('company_enquiries', id, { report_text: String(txt).trim() }, op.ENQ());
      op.renderCo(); if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks();
    } catch (err) { if (st) st.textContent = ''; if (err.message !== 'AI_PLAN_GATE') alert('Couldn’t finish: ' + err.message); op.renderCo(); }
  };
  window.vlCoSendReport = async function (id, btn) {
    var box = $('cd-rep-' + id), op = OP(); if (!box) return;
    var text = Array.prototype.map.call(box.children.length ? box.children : [box], function (n) { return (/^H\d$/.test(n.tagName) ? '## ' : '') + n.innerText.trim(); }).filter(Boolean).join('\n\n');
    btn.disabled = true; btn.textContent = 'Sending…';
    try { await op.api({ action: 'send_report', enquiry_id: id, text: text }); var e = op.ENQ().find(function (x) { return String(x.id) === String(id); }); if (e) { e.report_sent_at = new Date().toISOString(); e.report_text = text; } op.renderCo(); }
    catch (err) { btn.disabled = false; btn.textContent = 'Try again'; alert(err.message); }
  };

  // ── Photo of a receipt (Budgets) ──────────────────────────────
  var rcMsg = '';
  var prevTop = window.vlBudTop;
  window.vlBudTop = function (c, lines) {
    var html = typeof prevTop === 'function' ? prevTop(c, lines) : '';
    var add = '<div style="margin-top:12px;border-top:1px solid var(--border);padding-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap"><label class="btn btn-ghost btn-sm" style="cursor:pointer">📷 Photo of a receipt<input type="file" accept="image/*,.pdf" capture="environment" style="display:none" onchange="vlReceipt(this)"/></label>' +
      '<span style="font-size:12px;color:var(--txt3)">' + (rcMsg ? A().esc(rcMsg) : 'Snap it on your phone. Vorlana reads the shop, date and amount, and suggests the budget line.') + '</span></div>';
    var i = html.lastIndexOf('</div>'); return i >= 0 ? html.slice(0, i) + add + html.slice(i) : html + add;
  };
  window.vlReceipt = async function (input) {
    var f = input.files && input.files[0], a = A(); if (!f) return; input.value = ''; rcMsg = 'Reading the receipt…'; a.renderBudget();
    try {
      var j = await vAI('You read a photo or PDF of a UK shop receipt or invoice for a charity\'s bookkeeping. Return JSON only: {"payee":"shop or supplier name","date":"YYYY-MM-DD","total":0,"what":"3-6 words on what was bought"}. total is the final amount paid in pounds, including VAT. Use "" or 0 for anything you cannot read clearly; never guess a figure.',
        (await fileContent(f, 'Receipt')).concat([{ type: 'text', text: 'Read this receipt.' }]), 300);
      var amt = Math.round((parseFloat(j && j.total) || 0) * 100) / 100;
      if (!amt) { rcMsg = 'Couldn’t read the total on that one. Try a clearer photo, or add the spend by hand below.'; a.renderBudget(); return; }
      var date = /^\d{4}-\d{2}-\d{2}$/.test(j.date || '') ? j.date : a.today(), desc = [j.payee, j.what].filter(Boolean).join(' · ') || 'Receipt';
      var key = date + '|' + desc.toLowerCase() + '|' + amt.toFixed(2);
      if (a.S.spend.some(function (s) { return s.source === 'receipt' && s.external_id === key; })) { rcMsg = 'That receipt is already in (' + desc + ', ' + a.gbp(amt) + ').'; a.renderBudget(); return; }
      await a.save('budget_spend', { line_id: null, spend_date: date, amount: amt, description: desc.slice(0, 200), note: null, source: 'receipt', external_id: key, ignored: false }, 'spend');
      rcMsg = 'Read: ' + desc + ', £' + amt.toFixed(2) + ' on ' + a.fmt(date) + '. Pick its budget line under “to sort”.';
    } catch (e) { rcMsg = 'Couldn’t read it: ' + (/line_id|description|null value/.test(e.message) ? 'run the latest ai-office.sql in Supabase first.' : e.message); }
    a.renderBudget(); if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks();
  };

  // ── Set up from a document (Contracts page) ───────────────────
  var FOUND = null, suMsg = '';
  function setupButton() {
    if (!on()) return; var hdr = document.querySelector('#page-funding .page-header'); if (!hdr || $('gr-setup-btn')) return;
    var b = document.createElement('button'); b.id = 'gr-setup-btn'; b.className = 'btn btn-ai btn-sm'; b.style.marginRight = '6px'; b.textContent = '✦ Set up from a document'; b.onclick = openSetup;
    hdr.insertBefore(b, hdr.lastElementChild);
  }
  function openSetup() {
    var ov = $('gr-ov'); if (!ov) { ov = document.createElement('div'); ov.id = 'gr-ov'; ov.className = 'modal-overlay'; ov.innerHTML = '<div class="modal" style="max-width:680px"><div id="gr-body"></div></div>'; ov.addEventListener('click', function (e) { if (e.target === ov) ov.classList.remove('open'); }); document.body.appendChild(ov); }
    FOUND = null; suMsg = ''; paintSetup(); ov.classList.add('open'); ov.style.display = 'flex';
  }
  window.vlSetupOpen = openSetup;
  window.vlSetupClose = function () { var ov = $('gr-ov'); if (ov) { ov.classList.remove('open'); ov.style.display = 'none'; } };
  function paintSetup() {
    var el = $('gr-body'); if (!el) return; var a = A(), esc = a.esc;
    if (!FOUND) {
      el.innerHTML = '<h2 style="margin-top:0">Set up from a document</h2><div style="font-size:13px;color:var(--txt2);margin-bottom:12px">Drop in a grant agreement, award letter or last year’s annual report. Vorlana reads it and lists the contracts, targets, budget and key dates it finds. Nothing is created until you tick it.</div>' +
        '<label class="btn btn-p btn-sm" style="cursor:pointer">Choose a file (PDF, Word or photo)<input type="file" accept="image/*,.pdf,.docx,.txt" style="display:none" onchange="vlSetupRead(this.files[0])"/></label>' +
        '<textarea id="gr-text" placeholder="…or paste the text here" style="min-height:110px;margin-top:10px"></textarea><div style="display:flex;gap:6px;margin-top:8px"><button class="btn btn-ai btn-sm" onclick="vlSetupRead(null)">Read the pasted text</button><button class="btn btn-ghost btn-sm" onclick="vlSetupClose()">Cancel</button></div>' +
        '<div id="gr-msg" style="font-size:13px;color:var(--txt2);margin-top:10px">' + esc(suMsg) + '</div>';
      return;
    }
    var row = function (kind, i, main, sub) { return '<label style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-top:1px solid var(--border);font-size:13px;cursor:pointer"><input type="checkbox" checked data-k="' + kind + '" data-i="' + i + '" style="width:auto;margin-top:3px"/><span><b>' + esc(main) + '</b>' + (sub ? '<div style="color:var(--txt2)">' + esc(sub) + '</div>' : '') + '</span></label>'; };
    var C = FOUND.contracts, K = FOUND.key_dates;
    el.innerHTML = '<h2 style="margin-top:0">Here’s what I found</h2><div style="font-size:13px;color:var(--txt2);margin-bottom:6px">Untick anything that’s wrong. You can edit everything afterwards.</div>' +
      (C.length ? '<div style="font-weight:700;margin-top:10px">Contracts and grants</div>' + C.map(function (c, i) {
        return row('c', i, c.name + (c.funder ? ' · ' + c.funder : ''), [c.value ? a.gbp(c.value) : '', c.start_date ? a.fmt(c.start_date) + ' to ' + (c.end_date ? a.fmt(c.end_date) : '?') : '', c.target_starts ? c.target_starts + ' starts' : '', c.target_outcomes ? c.target_outcomes + ' outcomes' : '', c.report_every ? 'reports ' + ({ month: 'monthly', quarter: 'quarterly', half: 'every 6 months', year: 'yearly' })[c.report_every] : '',
          (c.budget_lines || []).length ? 'budget: ' + c.budget_lines.map(function (l) { return l.name + ' ' + a.gbp(l.amount); }).join(', ') : ''].filter(Boolean).join(' · ')); }).join('') : '') +
      (K.length ? '<div style="font-weight:700;margin-top:14px">Key dates</div>' + K.map(function (k, i) { return row('k', i, k.title, a.fmt(k.due_date) + (k.yearly ? ' · every year' : '')); }).join('') : '') +
      (!C.length && !K.length ? '<div class="alert alert-info">I couldn’t find a contract, target or date in that document.</div>' : '') +
      '<div style="display:flex;gap:6px;margin-top:14px">' + (C.length || K.length ? '<button class="btn btn-p btn-sm" id="gr-go" onclick="vlSetupCreate()">Create what’s ticked</button>' : '') + '<button class="btn btn-ghost btn-sm" onclick="vlSetupClose()">Cancel</button></div><div id="gr-msg" style="font-size:13px;color:var(--txt2);margin-top:10px">' + esc(suMsg) + '</div>';
  }
  var isoOk = function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(String(d || '')) ? d : null; };
  window.vlSetupRead = async function (file) {
    var msg = $('gr-msg'), text = ($('gr-text') || {}).value || '';
    if (!file && text.trim().length < 40) { msg.textContent = 'Choose a file or paste the text first.'; return; }
    msg.textContent = 'Reading it… this takes a few seconds.';
    try {
      var content = file ? await fileContent(file, 'Document') : [{ type: 'text', text: 'Document:\n' + text.slice(0, 40000) }];
      content.push({ type: 'text', text: 'Today is ' + A().today() + '. Return JSON only: {"contracts":[{"name":"short name of the grant, contract or project","funder":"who pays","value":0,"start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","target_starts":0,"target_outcomes":0,"report_every":"month|quarter|half|year or \\"\\"","report_due_days":0,"budget_lines":[{"name":"","amount":0}]}],"key_dates":[{"title":"","due_date":"YYYY-MM-DD","yearly":false}]}' });
      var j = await vAI('You read a UK charity\'s grant agreement, award letter, contract or annual report and pull out what its records system needs. Only include what the document states. value is the total award in pounds. target_starts is the number of people to be supported or enrolled; target_outcomes is the number of outcomes (jobs, qualifications, completions) to be achieved. ' +
        'report_every is how often monitoring reports are due; report_due_days is how many days after a period ends the report is due. budget_lines only if the document gives a budget breakdown. key_dates are dated obligations that are not regular monitoring reports: final report, audit, insurance, review meetings, claim deadlines; only future dates. Use "" or 0 for anything not stated. Never guess a date or a number.', content, 1500);
      FOUND = { contracts: ((j && j.contracts) || []).filter(function (c) { return c && String(c.name || '').trim(); }).map(function (c) {
          return { name: String(c.name).trim().slice(0, 120), funder: String(c.funder || '').trim().slice(0, 120), value: Math.round(+c.value || 0), start_date: isoOk(c.start_date), end_date: isoOk(c.end_date), target_starts: Math.round(+c.target_starts || 0), target_outcomes: Math.round(+c.target_outcomes || 0),
            report_every: /^(month|quarter|half|year)$/.test(c.report_every || '') ? c.report_every : '', report_due_days: Math.round(+c.report_due_days || 0), budget_lines: (c.budget_lines || []).filter(function (l) { return l && l.name && +l.amount > 0; }).map(function (l) { return { name: String(l.name).slice(0, 80), amount: Math.round(+l.amount) }; }) }; }),
        key_dates: ((j && j.key_dates) || []).filter(function (k) { return k && k.title && isoOk(k.due_date) && k.due_date >= A().today(); }).map(function (k) { return { title: String(k.title).slice(0, 120), due_date: k.due_date, yearly: !!k.yearly }; }) };
      suMsg = ''; paintSetup();
    } catch (e) { msg.textContent = 'Couldn’t read that: ' + e.message; }
  };
  window.vlSetupCreate = async function () {
    var a = A(), btn = $('gr-go'), ticked = { c: [], k: [] }; document.querySelectorAll('#gr-body input[type=checkbox]:checked').forEach(function (x) { ticked[x.dataset.k].push(+x.dataset.i); });
    if (!ticked.c.length && !ticked.k.length) { $('gr-msg').textContent = 'Nothing is ticked.'; return; }
    btn.disabled = true; btn.textContent = 'Creating…'; var made = { c: 0, l: 0, k: 0 }, errs = [];
    for (var i = 0; i < ticked.c.length; i++) {
      var c = FOUND.contracts[ticked.c[i]];
      try {
        var fname = c.funder || 'Funder to confirm', funder = (DB.funders || []).find(function (f) { return String(f.name || '').toLowerCase() === fname.toLowerCase(); });
        if (!funder) { funder = await sbInsert('funders', { name: fname, type: 'Other', contact_name: null, contact_email: null, notes: 'Added from a document' }); await refreshTable('funders'); }
        var row = { name: c.name, funder: fname, funder_id: funder && funder.id ? String(funder.id) : null, report_type: 'other', value: c.value, target_starts: c.target_starts, target_outcomes: c.target_outcomes, start_date: c.start_date, end_date: c.end_date, status: 'live' };
        if (c.report_every) row.report_every = c.report_every; if (c.report_due_days) row.report_due_days = c.report_due_days;
        var saved;
        try { saved = await sbInsert('contracts', row); } catch (e1) { delete row.report_every; delete row.report_due_days; saved = await sbInsert('contracts', row); }   // older databases without the reporting columns
        made.c++;
        for (var l = 0; l < c.budget_lines.length && saved && saved.id; l++) { try { await a.save('budget_lines', { contract_id: String(saved.id), name: c.budget_lines[l].name, amount: c.budget_lines[l].amount }, 'lines'); made.l++; } catch (e2) { /* budgets need ai-office.sql */ } }
      } catch (e) { errs.push(c.name + ': ' + (e.message || e)); }
    }
    for (var k = 0; k < ticked.k.length; k++) { var kd = FOUND.key_dates[ticked.k[k]]; try { await OP().addKeyDate({ title: kd.title, due_date: kd.due_date, repeat_months: kd.yearly ? 12 : null, done_at: null }); made.k++; } catch (e3) { errs.push(kd.title + ': ' + e3.message); } }
    if (made.c) { await refreshTable('contracts'); if (typeof renderFunding === 'function') renderFunding(); if (typeof renderFunders === 'function') renderFunders(); }
    if (typeof window.vlPaintChecks === 'function') window.vlPaintChecks();
    suMsg = 'Created ' + made.c + ' contract' + (made.c === 1 ? '' : 's') + (made.l ? ', ' + made.l + ' budget lines' : '') + (made.k ? ', ' + made.k + ' key date' + (made.k === 1 ? '' : 's') : '') + '. Report deadlines are now on the Funding calendar.' + (errs.length ? ' Not created: ' + errs.join('; ') : '');
    FOUND = null; paintSetup();
  };

  setInterval(setupButton, 1500);
  if (window.__VORLANA_TEST) window.__growTest = { found: function () { return FOUND; } };
})();
