// js/extensions/reporting-periods.js — v2.0 — period-aware funder reports
// Depends on: utils.js, db.js, agents.js, branding.js
//
// Adds a "Reporting period" picker above the contracts list on the
// Reports page. Replaces generateAIReport() with a version that
// filters participants/events/feedback to the selected period.
//
// v2.0 FIXES
//   • Events, feedback and volunteer hours are now scoped to the
//     CONTRACT, not just the period. Previously every event and every
//     feedback response in the organisation went into every funder's
//     report — so one funder's report could quote another funder's
//     participants. Now only events linked to the contract
//     (events.contract_ids) count.
//   • Participant quotes are now passed to the writer. The report has
//     a "Participant Voice" section but was never given any quotes,
//     and is told never to invent them — so that section was empty.
//   • Adds enjoyment, learned/connected, and volunteer hours on the
//     contract's events.
//   • Footer says Vorlana, not Civara.
//
// This makes js/extensions/report-contract-scope.js redundant —
// delete it and remove its <script> line from app.html.

(function () {
  'use strict';

  var VERSION = 'v2.0';

  function whenReady(fn, attempts) {
    if (attempts == null) attempts = 0;
    if (attempts > 60) return;
    if ($('reports-contract-list')) return setTimeout(fn, 400);
    setTimeout(() => whenReady(fn, attempts + 1), 500);
  }
  whenReady(init);

  function init() {
    if ($('civara-period-picker')) return;
    const el = $('reports-contract-list');
    if (!el) return;

    const picker = document.createElement('div');
    picker.id = 'civara-period-picker';
    picker.className = 'card';
    picker.innerHTML = `
      <div class="card-title">Reporting period — contract funder reports</div>
      <div class="period-pick-row">
        <div class="form-row">
          <label>Period type</label>
          <select id="civara-period-type">
            <option value="cumulative">Cumulative (all-time)</option>
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        <div class="form-row" id="civara-period-month-wrap" style="display:none">
          <label>Month</label>
          <input type="month" id="civara-period-month" value="${(new Date()).toISOString().slice(0, 7)}"/>
        </div>
        <div class="form-row" id="civara-period-quarter-wrap" style="display:none">
          <label>Quarter</label>
          <select id="civara-period-quarter">${quarterOptions()}</select>
        </div>
        <div class="form-row" id="civara-period-from-wrap" style="display:none">
          <label>From</label>
          <input type="date" id="civara-period-from"/>
        </div>
        <div class="form-row" id="civara-period-to-wrap" style="display:none">
          <label>To</label>
          <input type="date" id="civara-period-to"/>
        </div>
      </div>
      <div id="civara-period-summary" style="margin-top:10px;font-size:12px;color:var(--txt3)">Reports use cumulative all-time data. Events and feedback are limited to those linked to the chosen contract.</div>
    `;
    el.parentNode.insertBefore(picker, el);

    $('civara-period-type').addEventListener('change', onPeriodTypeChange);
    ['civara-period-month', 'civara-period-quarter', 'civara-period-from', 'civara-period-to'].forEach(id => {
      const x = $(id);
      if (x) x.addEventListener('change', updatePeriodSummary);
    });

    if (typeof window.generateAIReport === 'function' && !window._civaraReportPatched) {
      window._civaraReportPatched = true;
      window.generateAIReport = patchedGenerateAIReport;
    }
    console.log('[reporting-periods ' + VERSION + '] ready');
  }

  function quarterOptions() {
    const now = new Date(); const year = now.getFullYear();
    const items = [];
    for (let y = year; y >= year - 2; y--) {
      for (let q = 4; q >= 1; q--) {
        const r = quarterRange(y, q);
        items.push({ value: y + '-Q' + q, label: 'Q' + q + ' ' + y + ' (' + r.from + ' to ' + r.to + ')' });
      }
    }
    const curQ = Math.floor(now.getMonth() / 3) + 1;
    return items.map(it =>
      '<option value="' + it.value + '"' + (it.value === year + '-Q' + curQ ? ' selected' : '') + '>' + it.label + '</option>'
    ).join('');
  }

  function quarterRange(year, q) {
    const startMonth = (q - 1) * 3;
    const from = new Date(year, startMonth, 1);
    const to   = new Date(year, startMonth + 3, 0);
    return { from: from.toISOString().split('T')[0], to: to.toISOString().split('T')[0] };
  }

  function onPeriodTypeChange() {
    const t = $('civara-period-type').value;
    ['month', 'quarter', 'from', 'to'].forEach(k => {
      const x = $('civara-period-' + k + '-wrap'); if (x) x.style.display = 'none';
    });
    if (t === 'month') $('civara-period-month-wrap').style.display = 'block';
    else if (t === 'quarter') $('civara-period-quarter-wrap').style.display = 'block';
    else if (t === 'custom') {
      $('civara-period-from-wrap').style.display = 'block';
      $('civara-period-to-wrap').style.display = 'block';
    }
    updatePeriodSummary();
  }

  function getCurrentPeriod() {
    const t = ($('civara-period-type') && $('civara-period-type').value) || 'cumulative';
    if (t === 'cumulative') return { type: 'cumulative', from: null, to: null, label: 'all-time / cumulative' };
    if (t === 'month') {
      const m = $('civara-period-month').value;
      if (!m) return { type: 'cumulative', from: null, to: null, label: 'all-time' };
      const parts = m.split('-').map(Number); const y = parts[0], mo = parts[1];
      const from = new Date(y, mo - 1, 1).toISOString().split('T')[0];
      const to   = new Date(y, mo, 0).toISOString().split('T')[0];
      const monName = new Date(y, mo - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      return { type: 'month', from, to, label: monName };
    }
    if (t === 'quarter') {
      const v = $('civara-period-quarter').value;
      const yQ = v.split('-Q'); const r = quarterRange(parseInt(yQ[0]), parseInt(yQ[1]));
      return { type: 'quarter', from: r.from, to: r.to, label: 'Q' + yQ[1] + ' ' + yQ[0] };
    }
    if (t === 'custom') {
      const from = $('civara-period-from').value, to = $('civara-period-to').value;
      if (!from || !to) return { type: 'cumulative', from: null, to: null, label: 'all-time' };
      return { type: 'custom', from, to, label: from + ' to ' + to };
    }
    return { type: 'cumulative', from: null, to: null, label: 'all-time' };
  }

  function updatePeriodSummary() {
    const p = getCurrentPeriod();
    const s = $('civara-period-summary'); if (!s) return;
    const scope = ' Events and feedback are limited to those linked to the chosen contract.';
    if (p.type === 'cumulative') s.textContent = 'Reports use cumulative all-time data.' + scope;
    else s.textContent = 'Reports will be filtered to ' + p.label + ' (' + p.from + ' → ' + p.to + ').' + scope;
  }

  function inPeriod(dateStr, period) {
    if (period.type === 'cumulative' || !period.from || !period.to) return true;
    if (!dateStr) return false;
    const d = String(dateStr).slice(0, 10);
    return d >= period.from && d <= period.to;
  }

  function linkedToContract(ev, contractId) {
    return toArr(ev && ev.contract_ids).map(String).includes(String(contractId));
  }

  async function patchedGenerateAIReport(type, contractId) {
    const progressEl = $('brain-progress'), reportEl = $('report-output');
    if (!progressEl || !reportEl) return;
    reportEl.innerHTML = '';
    progressEl.scrollIntoView({ behavior: 'smooth', block: 'start' });

    const period = getCurrentPeriod();
    const contract = DB.contracts.find(c => String(c.id) === String(contractId));
    const funder = contract && contract.funder_id
      ? (DB.funders || []).find(f => String(f.id) === String(contract.funder_id))
      : null;
    const orgName = (currentOrg && currentOrg.name) || 'Organisation';
    const todayStr = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });

    // ── participants on this contract ─────────────────────────
    const linked = DB.participants.filter(p => toArr(p.contract_ids).includes(String(contractId)));
    const linkedInPeriod = linked.filter(p => inPeriod(p.last_contact || p.created_at, period));
    const linkedOutcomes = linkedInPeriod.filter(p => p.outcomes && p.outcomes.length > 0).length;
    const jobs = linkedInPeriod.filter(p => p.outcomes && p.outcomes.includes('Employment')).length;
    const sustained = linkedInPeriod.filter(p => p.stage === 'Sustained').length;

    // ── events on this contract, in period ────────────────────
    const evLinked = (DB.events || []).filter(e => linkedToContract(e, contractId) && inPeriod(e.date, period));
    const evIds = {};
    evLinked.forEach(e => { evIds[String(e.id)] = 1; });
    // an event with nothing recorded against it was not delivered as far as the figures go (same rule as the delivery report)
    const eventsInPeriod = evLinked.filter(e => num(e.attendees) > 0 ||
      (DB.feedback || []).some(f => String(f.eventId || f.event_id || '') === String(e.id)) ||
      (DB.volunteer_hours || []).some(h => String(h.event_id || '') === String(e.id)));
    const sessionMix = {};
    eventsInPeriod.forEach(e => { const k = String(e.name || 'Session').trim(); sessionMix[k] = (sessionMix[k] || 0) + 1; });
    const attendances = eventsInPeriod.reduce((a, e) => a + num(e.attendees), 0);

    // ── feedback on those events only ─────────────────────────
    const fbInPeriod = (DB.feedback || []).filter(f => evIds[String(f.eventId || f.event_id || '')]);
    const fbN = fbInPeriod.length;
    // averages and percentages are over the people who ANSWERED — a blank is not a zero
    const avg = (rows, key) => { const v = rows.map(f => num(f[key])).filter(x => x > 0); return v.length ? (v.reduce((a, x) => a + x, 0) / v.length).toFixed(1) : null; };
    const avgEnjoyed = avg(fbInPeriod, 'enjoyed');
    const pairs = fbInPeriod.filter(f => num(f.cb) > 0 && num(f.ca) > 0), pairN = pairs.length;
    const avgCB = avg(pairs, 'cb');
    const avgCA = avg(pairs, 'ca');
    const improvedPct = pairN ? Math.round(pairs.filter(f => num(f.ca) > num(f.cb)).length / pairN * 100) : 0;
    const yn = key => { const a = fbInPeriod.filter(f => f[key] === true || f[key] === false); return [a.length, a.length ? Math.round(a.filter(f => f[key]).length / a.length * 100) : 0]; };
    const [learnedN, learnedPct] = yn('learned');
    const [connectedN, connectedPct] = yn('connected');
    // who came: the same tidying as the Demographics page
    const T = window.DemoTidy || { tidyRecord: d => d || {}, isBEM: e => !!e && !/^white/i.test(e), isDisabled: d => !!d && !/^(no|none|no disability)$/i.test(d) };
    const demo = fbInPeriod.map(f => T.tidyRecord(f.demographics)).filter(d => d && Object.keys(d).length);
    const eth = demo.filter(d => d.ethnicity), dis = demo.filter(d => d.disability), ages = {};
    demo.forEach(d => { if (d.age) ages[d.age] = (ages[d.age] || 0) + 1; });
    const reach = !demo.length ? [] : [
      'Responses with demographic data: ' + demo.length + ' of ' + fbN,
      eth.length ? 'Black and ethnic minority: ' + Math.round(eth.filter(d => T.isBEM(d.ethnicity)).length / eth.length * 100) + '% (of ' + eth.length + ' who stated ethnicity)' : '',
      dis.length ? 'Disabled: ' + Math.round(dis.filter(d => T.isDisabled(d.disability)).length / dis.length * 100) + '% (of ' + dis.length + ' who answered)' : '',
      Object.keys(ages).length ? 'Most common age groups among those responses: ' + Object.keys(ages).sort((a, b) => ages[b] - ages[a]).slice(0, 3).map(k => k + ' (' + ages[k] + ')').join(', ') : ''
    ].filter(Boolean);
    const quotes = fbInPeriod
      .filter(f => f.quote && String(f.quote).trim().length > 15 && !HEALTH_QUOTE_RX.test(String(f.quote)))
      .map(f => String(f.quote).trim())
      .filter((q, i, a) => a.indexOf(q) === i)
      .slice(0, 4);

    // ── volunteer hours on those events ───────────────────────
    const hoursRows = (DB.volunteer_hours || []).filter(h => h.event_id && evIds[String(h.event_id)]);
    const volHours = Math.round(hoursRows.reduce((a, h) => a + num(h.hours), 0) * 10) / 10;
    const volPeople = {};
    hoursRows.forEach(h => { volPeople[String(h.volunteer_id)] = 1; });
    const volCount = Object.keys(volPeople).length;

    // ── circular economy on this contract ─────────────────────
    if (typeof window.cxReportLoad === 'function' || typeof cxReportLoad === 'function') { try { await cxReportLoad(); } catch (e) { /* optional */ } }
    const circ = (typeof cxReportStats === 'function') ? cxReportStats({ from: period.from, to: period.to, contractId: contractId }) : null;
    const hasCirc = !!(circ && circ.entries);

    const periodLabel = period.type === 'cumulative' ? 'cumulative (all activity to date)' : period.label;

    const steps = [
      { label: 'Filtering to ' + periodLabel, meta: linkedInPeriod.length + ' participants · ' + eventsInPeriod.length + ' events' + (hasCirc ? ' · ' + circ.kg + ' kg circular' : '') + ' on this contract' },
      { label: 'Reading what the funder asks for', meta: 'Their reporting form, or how ' + ((funder && funder.name) || 'this funder') + ' reports' },
      { label: 'Writing the report', meta: 'Writing the narrative around your live numbers' },
      { label: 'Checking every figure', meta: 'Against your records' },
      { label: 'Ready', meta: 'Report delivered — review and download below' }
    ];

    // Written in the funder's own language (profiles live in delivery-report.js)
    const profKey = (window.detectFunderProfile ? window.detectFunderProfile((funder && funder.name) || '', contract) : 'generic');
    const prof = (window.FUNDER_PROFILES || {})[profKey] || { label: 'General', people: 'participants', tone: 'a professional UK funder report.', sections: ['Executive Summary', 'Delivery Overview', 'Who We Reached', 'Volunteer Contribution', '%CIRC%', 'Participant Experience', 'Data Quality'] };
    const elapsed = (contract && contract.start_date && contract.end_date) ? Math.max(0, Math.min(100, Math.round((Math.min(Date.now(), new Date(contract.end_date)) - new Date(contract.start_date)) / (new Date(contract.end_date) - new Date(contract.start_date)) * 100))) : null;
    // Pace is worked out here, not by the writer: contract-to-date progress against the share of the contract period gone
    const startsToDate = num(contract && contract.actual_starts) || linked.length;
    const outcomesToDate = num(contract && contract.actual_outcomes) || linked.filter(p => p.outcomes && p.outcomes.length > 0).length;
    const paceLine = (label, done, target) => {
      if (!target) return '';
      const pc = Math.round(done / target * 100);
      let line = label + ' to date: ' + done + ' of ' + target + ' target (' + pc + '%)';
      if (elapsed != null) {
        const d = pc - elapsed;
        line += ' against ' + elapsed + '% of the contract period elapsed: ' + (Math.abs(d) <= 5 ? 'on track' : d > 0 ? 'ahead of pace' : 'behind pace');
      }
      return line;
    };
    const startsPace = paceLine('Starts', startsToDate, num(contract && contract.target_starts));
    const outcomesPace = paceLine('Outcomes', outcomesToDate, num(contract && contract.target_outcomes));
    const hasTargets = !!(startsPace || outcomesPace);
    const employment = profKey === 'dwp' || jobs > 0 || sustained > 0;
    const plansText = ((currentOrg && currentOrg.settings && currentOrg.settings.report_plans) || '').toString().trim();
    const PLANS_H = 'Plans for the next period';

    // The funder's own reporting form decides the sections when it can be read; otherwise how this kind of funder reports
    const tpl = window.vlReportQA ? await window.vlReportQA.funderQuestions(contractId) : null;
    const growing = !!(circ && circ.growing), growOnly = growing && !circ.itemsDone;
    const circTitle = growOnly ? 'Growing' : (growing ? 'Growing and Circular Economy' : 'Circular Economy');
    let sections, limits = {};
    if (tpl) {
      sections = tpl.items.map(it => it.q);
      tpl.items.forEach(it => { if (it.limit) limits[it.q] = it.limit; });
    } else {
      sections = (prof.sections || []).map(x => x === '%CIRC%' ? (hasCirc ? circTitle : '') : x).filter(Boolean)
        .filter(x => !/^(what happens next|next steps|next period|forward view)$/i.test(x) && !(!plansText && /^sustainab/i.test(x)))     // plans are only ever the organisation's own words; without them a sustainability section is filler
        .map(x => x.replace(/\s*(,|and)\s*(what happens )?(next period|next steps|forward view)\s*$/i, ''));
    }
    const story = window.vlReportQA ? window.vlReportQA.caseStudy(linked, fbInPeriod) : '';
    const worked = window.vlReportQA ? window.vlReportQA.whatWorked(eventsInPeriod, fbInPeriod) : [];
    const first = sections[0] || 'Summary';

    const sys = 'You are a senior UK charity impact writer. You are writing ' + prof.tone + ' Call the people "' + prof.people + '". Write in clean formal British English, in the language this funder uses. ' +
      (tpl ? 'This report answers the funder\'s own reporting form. Use these headings, exactly as written and in this order, each beginning with ##, and answer each question directly' + (Object.keys(limits).length ? ' within its word limit' : '') + ': ' + tpl.items.map((it, i) => (i + 1) + '. ' + it.q + (it.limit ? ' (max ' + it.limit + ' words)' : '')).join(' | ') + '. If the figures cannot answer a question, say plainly what is not recorded this period. '
           : 'Structure with these sections, in this order, each beginning with ## and exactly this title: ' + sections.join(', ') + '. ') +
      'Open "' + first + '" with the most important results for this funder as plain sentences — never write about "figures that matter" or what the figures "show" in general' + (hasTargets ? ', then progress against targets' : '') + (quotes.length ? ', then the single quote that best shows the difference made' : '') + '. ' +
      (hasTargets ? 'Give progress against targets as a plain sentence in your own words, using the figures and the verdict from the PROGRESS lines (for example "11 of the 30 starts so far (37%), ahead of the 29% of the contract period gone"); never copy a PROGRESS line as it is, never work out pace yourself and never contradict the verdict. Only if a verdict is "behind pace" explain it plainly from the figures. ' : 'No targets were entered: never say delivery is on track, ahead or behind. ') +
      'Never add claims about what people did, felt or valued, or how volunteers or staff worked, unless they come from a quote or the figures. Give each figure once: within a section never twice, and after the opening section in one section only. Base any learning or challenges section on the WHAT WORKED lines (what drew people and what made the most difference) and anything behind pace; never on how data was collected. Mention that demographic answers were optional once, in a few words, in who was reached only; describe them as responses, never attendance. ' +
      'Show the difference made, not just activity: relate figures to the target, to before and after, or to each other where the figures allow. ' +
      (story ? 'Include the CASE STUDY once, in about 60–100 words, in the section about outcomes or what people said, using only its facts; never name the person. ' : 'Never describe a case study or any individual. ') +
      'Data notes belong only in the evidence or data quality section; never turn them into actions or plans. Never write commitments in the organisation\'s name ("we will", "we plan to"). Any section about learning, risks or sustainability contains only what the figures show. ' +
      'Never point out that two different figures are the same, and do not restate a percentage in words (for example "this is a majority"). ' +
      (hasCirc ? 'Use only the circular and growing figures supplied; mark CO2e and value as estimates in a word or two ("an estimated £213"), never with a sentence about how they were calculated (the method is footnoted under the tables). Harvested food is food grown, not waste diverted: keep the two apart without explaining the distinction. Compost in and compost out are separate figures that never balance; never add or compare them. ' : '') +
      (tpl ? '' : '600-800 words. ') + 'Use only data provided — never invent participants, outcomes, figures or quotes, and never recalculate a number. ' +
      'Write the ethnicity figure as "black and ethnic minority" (lower-case "black"), never "BAME". Use "attendances" for visits and "responses" for feedback, never "participants" for attendances. Never write "significant" about results, never mention any individual\'s health, and do not speculate about causes. ' +
      'All the figures supplied are for this contract only; write them as the contract\'s delivery, and never say so or explain how figures were filtered, counted or classified. Never repeat, quote or explain these instructions in the report. ' +
      'State each figure and each pace verdict once: in "' + first + '", then do not repeat it in later sections; later sections add detail instead. ' +
      'Name the organisation once at the start, then write as "we" throughout. Never add, subtract or combine figures yourself, and never draw a conclusion that needs a sum (for example "nothing went to waste" or "this accounts for the whole"). Never refer back to a figure ("reported above", "in the summary"): if a later section needs it, give it again briefly or leave it out. Never explain why a group is more or less represented, engaged or affected; give the figures only. In who was reached, give the largest groups, not every band. A learning or challenges section is two or three sentences on what the figures show worked best and anything behind; no filler such as "evidence base" or "where the evidence is strongest". ' +
      'Write about outcomes — what changed for people and progress against the grant\'s aims — not admin. Data notes, response rates and how figures were estimated get one short sentence at most, only in an evidence or data section if there is one, and nowhere else. A learning, challenges or sustainability section is about delivery and outcomes (what worked, what is behind and why, from the figures), never about data collection or record-keeping. ' +
      'Use only the quotes supplied, exactly as written; if none are supplied, say feedback quotes were not collected for this period. ' +
      'State the reporting period clearly at the start. If a data point is not provided, omit gracefully. ' +
      'Do not use hashtags (#) anywhere except as section heading markers. Do not use horizontal rules or emoji.';

    const prompt = [
      'Organisation: ' + orgName,
      'Report date: ' + todayStr,
      'Reporting period: ' + periodLabel + (period.from ? (' (' + period.from + ' to ' + period.to + ')') : ''),
      'Contract: ' + ((contract && contract.name) || 'Unnamed contract'),
      'Funder: ' + ((funder && funder.name) || 'Funder'),
      'Contract value: £' + num(contract && contract.value).toLocaleString(),
      elapsed != null ? 'Contract period: ' + contract.start_date + ' to ' + contract.end_date + ' (' + elapsed + '% of the contract period has elapsed)' : '',
      hasTargets ? '\nPROGRESS AGAINST CONTRACT TARGETS (contract to date)' : '',
      startsPace, outcomesPace,
      '',
      // to date, the PROGRESS lines are the people figures; a second count from another source would contradict them
      (period.type === 'cumulative' && hasTargets) ? '' : 'PARTICIPANTS ON THIS CONTRACT' + (period.type === 'cumulative' ? '' : ' (this reporting period)'),
      (period.type === 'cumulative' && startsPace) ? '' : 'Participants active: ' + linkedInPeriod.length,
      (period.type === 'cumulative' && outcomesPace) ? '' : 'Participants with an outcome recorded: ' + linkedOutcomes,
      employment ? 'Employment outcomes: ' + jobs : '',
      employment ? 'Sustained outcomes: ' + sustained : '',
      '',
      'EVENTS DELIVERED UNDER THIS CONTRACT',
      'Events delivered in period: ' + eventsInPeriod.length,
      eventsInPeriod.length ? 'Total attendances: ' + attendances : '',
      eventsInPeriod.length ? 'Sessions run: ' + Object.keys(sessionMix).sort((a, b) => sessionMix[b] - sessionMix[a]).slice(0, 8).map(k => k + ' (' + sessionMix[k] + ')').join('; ') : '',
      volHours ? 'Volunteers involved: ' + volCount + ' · volunteer hours: ' + volHours : '',
      '',
      'FEEDBACK FROM THESE EVENTS',
      'Feedback responses: ' + fbN,
      avgEnjoyed ? 'Average enjoyment: ' + avgEnjoyed + ' / 5' : '',
      avgCB && avgCA ? 'Average confidence: ' + avgCB + ' / 5 before, ' + avgCA + ' / 5 after (' + pairN + ' responses answered both)' : '',
      pairN ? 'Reported increased confidence: ' + improvedPct + '% (of ' + pairN + ')' : '',
      learnedN ? 'Learned something new: ' + learnedPct + '% (of ' + learnedN + ')' : '',
      connectedN ? 'Felt more connected: ' + connectedPct + '% (of ' + connectedN + ')' : '',
      reach.length ? '\nWHO WE REACHED (from optional anonymous answers)\n' + reach.join('\n') : '',
      quotes.length ? 'Participant quotes (use exactly as written):\n' + quotes.map(q => '- "' + q + '"').join('\n') : 'Participant quotes: none collected for this period',
      worked.length ? '\nWHAT WORKED (from the records)\n' + worked.join('\n') : '',
      story,
      hasCirc ? cxReportLines(circ).join('\n') : '',
      hasCirc && cxReportGaps(circ).length ? 'Data notes (data quality only):\n' + cxReportGaps(circ).map(g => '- ' + g).join('\n') : ''
    ].filter(Boolean).join('\n');

    if (typeof window.runAgent !== 'function') {
      reportEl.innerHTML = '<div class="alert alert-warn">Report agent not available.</div>';
      return;
    }
    let raw = await window.runAgent({
      container: progressEl,
      headerLabel: 'Org Brain — Funder Report',
      headerSub:   (tpl ? 'Answering ' + ((funder && funder.name) || 'the funder') + '\'s reporting form' : 'Written as ' + prof.label) + ' · every figure from your records',
      steps, sys, prompt, maxTok: 1800
    });
    if (!raw) return;
    // Verification: a number that isn't in the data pack, or wording a funder would pick at, gets one correction pass
    const lintCtx = { attendees: attendances, fbCount: fbN, hasTargets };
    const unverified0 = window.unknownReportNumbers ? window.unknownReportNumbers(raw, prompt) : [];
    const issues = window.reportLintFindings ? window.reportLintFindings(raw, lintCtx) : [];
    if (unverified0.length || issues.length) {
      const raw2 = await window.runAgent({ container: progressEl, headerLabel: 'Org Brain — Funder Report', headerSub: 'Checking the draft against your records',
        steps: [{ label: 'Checking every number and claim against the records', meta: (unverified0.length + issues.length) + ' to correct' }, { label: 'Ready', meta: '' }],
        sys: sys + (unverified0.length ? ' Your previous draft contained numbers that are NOT in the supplied data: ' + unverified0.join(', ') + '. Rewrite the full report so every number appears in the supplied data; remove or reword any sentence that needs a number you were not given.' : '') +
          (issues.length ? ' Your draft also contains wording that must not appear in a funder report: ' + issues.map(i => '"' + i.m + '" (' + i.why + ')').join('; ') + '. Rewrite those sentences so the problem is gone.' : '') + ' Keep everything else the same.',
        prompt: prompt + '\n\nPREVIOUS DRAFT:\n' + raw, maxTok: 1800 });
      if (raw2) raw = raw2;
    }
    if (typeof vlAutoFix === 'function') raw = vlAutoFix(raw, { attendances: attendances, responses: fbN, hasTargets }).text;   // nothing for the author to edit
    if (window.vlReportQA) raw = window.vlReportQA.scrub(raw).text;   // sentences about how the report was made, with no figure or quote, go before you see it
    if (plansText) raw += '\n\n## ' + PLANS_H + '\n' + plansText;   // the organisation's own words, never written for them

    const reportTitle = ((contract && contract.name) || 'Programme Report') + ' — ' + orgName + ' (' + periodLabel + ')';
    const _logoUrl = window.getOrgLogoUrl ? window.getOrgLogoUrl(currentOrg) : '';
    const _headerHTML = _logoUrl
      ? '<div class="report-header-flex"><div class="report-header-text">' +
          '<div class="report-meta">' + escapeHTML(((funder && funder.name) || 'Funder Report') + ' · ' + periodLabel) + '</div>' +
          '<div class="report-title">' + escapeHTML((contract && contract.name) || 'Programme Report') + '</div>' +
          '<div class="report-subtitle">' + escapeHTML(orgName) + ' · ' + escapeHTML(todayStr) + '</div>' +
        '</div>' +
        '<div class="report-header-logo"><img src="' + escapeHTML(_logoUrl) + '" alt="' + escapeHTML(orgName) + '" class="org-logo-report" onerror="this.style.display=\'none\'"/></div></div>'
      : '<div class="report-header">' +
          '<div class="report-meta">' + escapeHTML(((funder && funder.name) || 'Funder Report') + ' · ' + periodLabel) + '</div>' +
          '<div class="report-title">' + escapeHTML((contract && contract.name) || 'Programme Report') + '</div>' +
          '<div class="report-subtitle">' + escapeHTML(orgName) + ' · ' + escapeHTML(todayStr) + '</div>' +
        '</div>';

    // Draws the report from its text — again after every fix or rewrite
    const draw = (text) => {
      const unverified = window.unknownReportNumbers ? window.unknownReportNumbers(text, prompt) : [];
      const cleaned = window.cleanReportText ? window.cleanReportText(text) : text;
      let bodyHTML = window.reportTextToHTML ? window.reportTextToHTML(cleaned, text) : '<pre>' + escapeHTML(cleaned) + '</pre>';
      unverified.forEach(numStr => { bodyHTML = bodyHTML.replace(new RegExp('(£?)' + numStr.replace(/\./g, '\\.') + '(%?)(?![\\d])', 'g'), '<mark title="This number is not in your records — check it before sending" style="background:#FEF3C7">$1' + numStr + '$2</mark>'); });
      const verifyHTML = '<div class="no-print" style="border:1px solid ' + (unverified.length ? '#FDE68A' : '#BBF7D0') + ';background:' + (unverified.length ? '#FFFBEB' : '#F0FDF4') + ';border-radius:10px;padding:10px 14px;font-size:12.5px;margin:0 0 16px"><b>Verification</b> · ' + (tpl ? 'answers ' + escapeHTML(tpl.name) : 'written as ' + escapeHTML(prof.label)) + ' · ' +
        (unverified.length ? '<span style="color:#92400E">' + unverified.length + ' number(s) could not be matched to your records and are highlighted — check before sending.</span>' : 'every number in the narrative matches your records.') + ' <span style="color:#777">(shown here only, not in the download)</span></div>';
      window._lastReportText = cleaned;
      window._lastReport = { contractId: String(contractId), funder: (funder && funder.name) || (contract && contract.funder) || '', period, prompt, text: cleaned };   // for filling the funder's own form
      window._lastReportTitle = reportTitle;
      reportEl.innerHTML =
        '<div class="report-actions">' +
          '<button class="btn btn-p" id="civara-rep-pdf">⬇ Download as PDF</button>' +
          '<button class="btn btn-ghost btn-sm" id="civara-rep-copy">📋 Copy text</button>' +
          '<button class="btn btn-ghost btn-sm" id="civara-rep-regen">↻ Regenerate</button>' +
        '</div>' + verifyHTML +
        '<style>.pf{width:100%;border-collapse:collapse}.pf td{padding:0;border:0}.pf-gap{display:none}@media print{.pf-gap{display:block;height:14mm}.pf>tbody>tr>td{padding:0 14mm}}</style>' +
        '<table class="pf"><thead><tr><td><div class="pf-gap"></div></td></tr></thead><tbody><tr><td>' +
        '<div class="report-doc">' +
          _headerHTML +
          '<div class="report-body"><div class="rq-edit">' + bodyHTML + '</div>' + (hasCirc && !tpl ? cxReportDocHTML(circ, 'Circular economy: detail', { noFigs: true }) : '') + '</div>' +
          '<div class="report-footer">Generated with Vorlana · ' + escapeHTML(todayStr) + ' · Period: ' + escapeHTML(periodLabel) + '</div>' +
        '</div>' +
        '</td></tr></tbody><tfoot><tr><td><div class="pf-gap"></div></td></tr></tfoot></table>';
      $('civara-rep-pdf').addEventListener('click', () => window.downloadReportPDF && window.downloadReportPDF());
      $('civara-rep-copy').addEventListener('click', () => window.copyReportText && window.copyReportText());
      $('civara-rep-regen').addEventListener('click', () => window.generateAIReport(type, contractId));
    };
    draw(raw);

    // Report strength, checks in code and Raise the score — the same as bids get
    if (window.vlReportQA) window.vlReportQA.attach({
      key: 'contract:' + contractId + ':' + Date.now(), text: raw, pack: prompt, render: draw,
      funder: (funder && funder.name) || 'the funder',
      voice: 'Write as ' + prof.tone + ' Call the people "' + prof.people + '".',
      asks: tpl ? 'Their reporting form asks: ' + tpl.items.map(it => it.q + (it.limit ? ' (max ' + it.limit + ' words)' : '')).join(' | ') : 'A report in the usual shape for ' + prof.label + ': ' + sections.join(', ') + '.',
      lint: lintCtx, limits: limits, required: tpl ? sections : [], locked: plansText ? [PLANS_H] : []
    });

    reportEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

})();
