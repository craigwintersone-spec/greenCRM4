// js/extensions/reporting-periods.js — period-aware funder reports
// Depends on: utils.js, db.js, agents.js, branding.js
//
// Adds a "Reporting period" picker above the contracts list on the
// Reports page. Replaces generateAIReport() with a version that
// filters participants/events/feedback to the selected period.

(function () {
  'use strict';

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
      <div class="card-title">Reporting period</div>
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
      <div id="civara-period-summary" style="margin-top:10px;font-size:12px;color:var(--txt3)">Reports use cumulative all-time data.</div>
    `;
    el.parentNode.insertBefore(picker, el);

    $('civara-period-type').addEventListener('change', onPeriodTypeChange);
    ['civara-period-month', 'civara-period-quarter', 'civara-period-from', 'civara-period-to'].forEach(id => {
      const el = $(id);
      if (el) el.addEventListener('change', updatePeriodSummary);
    });

    if (typeof window.generateAIReport === 'function' && !window._civaraReportPatched) {
      window._civaraReportPatched = true;
      window.generateAIReport = patchedGenerateAIReport;
    }
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
      const el = $('civara-period-' + k + '-wrap'); if (el) el.style.display = 'none';
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
    if (p.type === 'cumulative') s.textContent = 'Reports use cumulative all-time data.';
    else s.textContent = 'Reports will be filtered to ' + p.label + ' (' + p.from + ' → ' + p.to + ').';
  }

  function inPeriod(dateStr, period) {
    if (period.type === 'cumulative' || !period.from || !period.to) return true;
    if (!dateStr) return false;
    const d = String(dateStr).slice(0, 10);
    return d >= period.from && d <= period.to;
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
    const linked = DB.participants.filter(p => toArr(p.contract_ids).includes(String(contractId)));
    const linkedInPeriod = linked.filter(p => inPeriod(p.last_contact || p.created_at, period));
    const linkedOutcomes = linkedInPeriod.filter(p => p.outcomes && p.outcomes.length > 0).length;
    const jobs = linkedInPeriod.filter(p => p.outcomes && p.outcomes.includes('Employment')).length;
    const sustained = linkedInPeriod.filter(p => p.stage === 'Sustained').length;
    const eventsInPeriod = DB.events.filter(e => inPeriod(e.date, period));
    const fbInPeriod = DB.feedback.filter(f => {
      const ev = DB.events.find(e => String(e.id) === String(f.eventId));
      return ev ? inPeriod(ev.date, period) : period.type === 'cumulative';
    });
    const avgCB = fbInPeriod.length ? (fbInPeriod.reduce((a, f) => a + num(f.cb), 0) / fbInPeriod.length).toFixed(1) : null;
    const avgCA = fbInPeriod.length ? (fbInPeriod.reduce((a, f) => a + num(f.ca), 0) / fbInPeriod.length).toFixed(1) : null;
    const periodLabel = period.type === 'cumulative' ? 'cumulative (all activity to date)' : period.label;

    const steps = [
      { label: 'Filtering to ' + periodLabel, meta: linkedInPeriod.length + ' participants in scope · ' + eventsInPeriod.length + ' events' },
      { label: 'Cross-checking funder requirements', meta: 'Mapping data against ' + ((funder && funder.name) || 'funder') + ' framework' },
      { label: 'Writing the report', meta: 'Org Brain composing narrative with your live numbers' },
      { label: 'Quality Supervisor check', meta: 'Verifying tone, claims and structure' },
      { label: 'Ready', meta: 'Report delivered — review and download below' }
    ];

    const sys = 'You are a professional UK bid writer producing a funder report. Write in clean formal British English. Structure with these sections in order, each beginning with ## and the section title: Executive Summary, Delivery Overview, Participant Outcomes, Distance Travelled and Wellbeing, Participant Voice, Forward Plan. Use **bold** sparingly for key statistics. 600-800 words. Use only data provided — never invent participants, outcomes or quotes. State the reporting period clearly in the Executive Summary. If a data point is not provided, omit gracefully. Do not use hashtags (#) anywhere except as section heading markers. Do not use horizontal rules or emoji.';

    const prompt = [
      'Organisation: ' + orgName,
      'Report date: ' + todayStr,
      'Reporting period: ' + periodLabel + (period.from ? (' (' + period.from + ' to ' + period.to + ')') : ''),
      'Contract: ' + ((contract && contract.name) || 'Unnamed contract'),
      'Funder: ' + ((funder && funder.name) || 'Funder'),
      'Contract value: £' + num(contract && contract.value).toLocaleString(),
      'Target starts: ' + ((contract && contract.target_starts) || 0),
      'Actual starts in period: ' + linkedInPeriod.length,
      'Target outcomes: ' + ((contract && contract.target_outcomes) || 0),
      'Actual outcomes in period: ' + linkedOutcomes,
      'Employment outcomes in period: ' + jobs,
      'Sustained outcomes in period: ' + sustained,
      'Events delivered in period: ' + eventsInPeriod.length,
      avgCB ? 'Average confidence before (period): ' + avgCB + ' / 5' : '',
      avgCA ? 'Average confidence after (period): ' + avgCA + ' / 5' : '',
      'Feedback responses in period: ' + fbInPeriod.length
    ].filter(Boolean).join('\n');

    if (typeof window.runAgent !== 'function') {
      reportEl.innerHTML = '<div class="alert alert-warn">Report agent not available.</div>';
      return;
    }
    const raw = await window.runAgent({
      container: progressEl,
      headerLabel: 'Org Brain — Funder Report',
      headerSub:   'Reading your data, mapping to funder requirements, writing the report',
      steps, sys, prompt, maxTok: 1400
    });
    if (!raw) return;

    const cleaned = window.cleanReportText ? window.cleanReportText(raw) : raw;
    const bodyHTML = window.reportTextToHTML ? window.reportTextToHTML(cleaned, raw) : '<pre>' + escapeHTML(cleaned) + '</pre>';
    const reportTitle = ((contract && contract.name) || 'Programme Report') + ' — ' + orgName + ' (' + periodLabel + ')';
    window._lastReportText = cleaned;
    window._lastReportTitle = reportTitle;

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

    reportEl.innerHTML =
      '<div class="report-actions">' +
        '<button class="btn btn-p" id="civara-rep-pdf">⬇ Download as PDF</button>' +
        '<button class="btn btn-ghost btn-sm" id="civara-rep-copy">📋 Copy text</button>' +
        '<button class="btn btn-ghost btn-sm" id="civara-rep-regen">↻ Regenerate</button>' +
      '</div>' +
      '<div class="report-doc">' +
        _headerHTML +
        '<div class="report-body">' + bodyHTML + '</div>' +
        '<div class="report-footer">Generated by Civara · Org Brain · ' + escapeHTML(todayStr) + ' · Period: ' + escapeHTML(periodLabel) + '</div>' +
      '</div>';

    $('civara-rep-pdf').addEventListener('click', () => window.downloadReportPDF && window.downloadReportPDF());
    $('civara-rep-copy').addEventListener('click', () => window.copyReportText && window.copyReportText());
    $('civara-rep-regen').addEventListener('click', () => window.generateAIReport(type, contractId));

    reportEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

})();
