// js/extensions/demographics.js — voluntary equality data + demographics page
// Depends on: utils.js, db.js, modals.js, render.js, router.js
//
// What this adds:
//   • Demographics section on the Add/Edit Participant modal
//   • Extra fields on the Equality monitoring modal (orientation,
//     religion, marital status, postcode)
//   • A new "Demographics" page (renderDemographics) — participants,
//     volunteers and event attendees (feedback.demographics), with a
//     group switch and a report-ready headline
//   • Patches go() to handle the 'demographics' route
//   • Patches saveEqualityData() to save the extra fields
//
// All extension files run AFTER boot.js so they can patch existing
// functions safely. They use a small init() that polls until the DOM
// pieces they need are present (because some are inserted at runtime).

(function () {
  'use strict';

  // ── Boot wait ───────────────────────────────────────────────
  function whenReady(fn, attempts) {
    if (attempts == null) attempts = 0;
    if (attempts > 60) return; // give up after ~30s
    if ($('modal-p') && $('page-participants') && document.querySelector('.nav-btn')) {
      return setTimeout(fn, 400);
    }
    setTimeout(() => whenReady(fn, attempts + 1), 500);
  }
  whenReady(init);

  function init() {
    console.log('[ext:demographics] initialising');
    injectDemographicsPage();
    expandEqualityModal();
    patchGoRouter();
    patchAddParticipantModal();
    patchEqualityModal();
  }

  // ── Demographics page (rendered into <main>) ────────────────
  function injectDemographicsPage() {
    if ($('page-demographics')) return;
    const main = $('main');
    if (!main) return;
    const p = document.createElement('div');
    p.className = 'page';
    p.id = 'page-demographics';
    p.innerHTML = `
      <div class="page-header">
        <div><div class="page-title">Demographics</div><div class="page-sub" id="demo-sub">Voluntary equality data — anonymised aggregates only</div></div>
        <div style="display:flex;gap:8px;align-items:center">
          <select id="demo-group" style="width:auto">
            <option value="all">Everyone</option>
            <option value="participants">Participants</option>
            <option value="volunteers">Volunteers</option>
            <option value="attendees">Event attendees</option>
          </select>
          <button class="btn btn-ghost btn-sm" data-action="export-demographics">Export CSV</button>
        </div>
      </div>
      <div class="alert alert-info">Demographics are collected voluntarily for anonymised reporting. They are never shared with funders at individual level. Records with no equality data are excluded from these counts. Event attendees are counted per feedback response — someone who comes to three events and fills in the form each time counts three times.</div>
      <div class="stats-grid" id="demo-stats"></div>
      <div class="card" id="demo-headline" style="margin-bottom:14px;display:none"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <div class="card"><div class="card-title">Age group</div><div id="demo-age"></div></div>
        <div class="card"><div class="card-title">Ethnicity</div><div id="demo-ethnicity"></div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <div class="card"><div class="card-title">Gender</div><div id="demo-gender"></div></div>
        <div class="card"><div class="card-title">Disability</div><div id="demo-disability"></div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
        <div class="card"><div class="card-title">Sexual orientation</div><div id="demo-orientation"></div></div>
        <div class="card"><div class="card-title">Religion or belief</div><div id="demo-religion"></div></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
        <div class="card"><div class="card-title">Marital status</div><div id="demo-marital"></div></div>
        <div class="card"><div class="card-title">Postcode (first half)</div><div id="demo-postcode"></div></div>
      </div>
    `;
    main.appendChild(p);
    const grp = p.querySelector('#demo-group');
    if (grp) grp.addEventListener('change', renderDemographics);
    const exportBtn = p.querySelector('[data-action="export-demographics"]');
    if (exportBtn) exportBtn.addEventListener('click', exportDemographics);
  }

  // ── Add extra fields to the Equality modal ──────────────────
  function expandEqualityModal() {
    const modal = $('modal-eq');
    if (!modal) return;
    if (modal.querySelector('[data-civara-extra]')) return;
    const footer = modal.querySelector('.modal-footer');
    if (!footer) return;
    const wrap = document.createElement('div');
    wrap.dataset.civaraExtra = '1';
    wrap.innerHTML = `
      <div class="form-grid-2">
        <div class="form-row"><label>Sexual orientation</label><select id="eq-orientation"><option value="">Prefer not to say</option><option>Heterosexual</option><option>Gay / Lesbian</option><option>Bisexual</option><option>Other</option></select></div>
        <div class="form-row"><label>Religion or belief</label><select id="eq-religion"><option value="">Prefer not to say</option><option>No religion</option><option>Christian</option><option>Muslim</option><option>Hindu</option><option>Sikh</option><option>Jewish</option><option>Buddhist</option><option>Other</option></select></div>
      </div>
      <div class="form-grid-2">
        <div class="form-row"><label>Marital status</label><select id="eq-marital"><option value="">Prefer not to say</option><option>Single</option><option>Married / civil partnership</option><option>Cohabiting</option><option>Separated</option><option>Divorced</option><option>Widowed</option></select></div>
        <div class="form-row"><label>Postcode (first half only, e.g. SE1)</label><input id="eq-postcode" maxlength="5" placeholder="SE1"/></div>
      </div>
    `;
    footer.parentNode.insertBefore(wrap, footer);
  }

  // ── Add demographics section to Add/Edit Participant modal ──
  function patchAddParticipantModal() {
    const modal = $('modal-p');
    if (!modal) return;
    if (modal.querySelector('[data-civara-demo-section]')) return;
    const footer = modal.querySelector('.modal-footer');
    if (!footer) return;
    const wrap = document.createElement('div');
    wrap.dataset.civaraDemoSection = '1';
    wrap.style.marginTop = '12px';
    wrap.innerHTML = `
      <button type="button" class="btn btn-ghost btn-sm" id="mp-demo-toggle" style="width:100%;justify-content:space-between;display:flex;align-items:center">
        <span>📊 Demographics (optional)</span>
        <span id="mp-demo-toggle-arrow">▼</span>
      </button>
      <div id="mp-demo-body" style="display:none;border:1px solid var(--border);border-radius:8px;padding:14px;margin-top:8px;background:var(--bg)">
        <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;line-height:1.5">Voluntary equality data — used only for anonymised reporting. The participant can choose to leave any field blank.</div>
        <div class="form-grid-2">
          <div class="form-row"><label>Age group</label><select id="mp-eq-age"><option value="">Prefer not to say</option><option>16–24</option><option>25–34</option><option>35–44</option><option>45–54</option><option>55–64</option><option>65+</option></select></div>
          <div class="form-row"><label>Ethnicity</label><select id="mp-eq-ethnicity"><option value="">Prefer not to say</option><option>White British</option><option>White Irish</option><option>White Other</option><option>Mixed/Multiple</option><option>Asian/Asian British</option><option>Black/Black British</option><option>Arab</option><option>Other</option></select></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Gender</label><select id="mp-eq-gender"><option value="">Prefer not to say</option><option>Man</option><option>Woman</option><option>Non-binary</option><option>Other</option></select></div>
          <div class="form-row"><label>Disability</label><select id="mp-eq-disability"><option value="">Prefer not to say</option><option value="none">No disability</option><option value="physical">Physical / mobility</option><option value="sensory">Sensory</option><option value="mental">Mental health</option><option value="learning">Learning disability</option><option value="neurodiverse">Neurodiverse</option></select></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Sexual orientation</label><select id="mp-eq-orientation"><option value="">Prefer not to say</option><option>Heterosexual</option><option>Gay / Lesbian</option><option>Bisexual</option><option>Other</option></select></div>
          <div class="form-row"><label>Religion or belief</label><select id="mp-eq-religion"><option value="">Prefer not to say</option><option>No religion</option><option>Christian</option><option>Muslim</option><option>Hindu</option><option>Sikh</option><option>Jewish</option><option>Buddhist</option><option>Other</option></select></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Marital status</label><select id="mp-eq-marital"><option value="">Prefer not to say</option><option>Single</option><option>Married / civil partnership</option><option>Cohabiting</option><option>Separated</option><option>Divorced</option><option>Widowed</option></select></div>
          <div class="form-row"><label>Postcode (first half, e.g. SE1)</label><input id="mp-eq-postcode" maxlength="5" placeholder="SE1"/></div>
        </div>
      </div>
    `;
    footer.parentNode.insertBefore(wrap, footer);
    $('mp-demo-toggle').addEventListener('click', () => {
      const body = $('mp-demo-body'), arrow = $('mp-demo-toggle-arrow');
      const open = body.style.display === 'none';
      body.style.display = open ? 'block' : 'none';
      if (arrow) arrow.textContent = open ? '▲' : '▼';
    });
    wrapParticipantHandlers();
  }

  // Wrap openAddP / openEditP / saveP so the demographics fields are
  // populated and saved alongside the rest of the participant.
  function wrapParticipantHandlers() {
    if (window._civaraPMWrapped) return;
    window._civaraPMWrapped = true;
    const fields = ['age', 'ethnicity', 'gender', 'disability', 'orientation', 'religion', 'marital', 'postcode'];

    if (typeof window.openAddP === 'function') {
      const orig = window.openAddP;
      window.openAddP = function () {
        orig();
        fields.forEach(k => { const el = $('mp-eq-' + k); if (el) el.value = ''; });
        const body = $('mp-demo-body'), arrow = $('mp-demo-toggle-arrow');
        if (body) body.style.display = 'none';
        if (arrow) arrow.textContent = '▼';
      };
    }
    if (typeof window.openEditP === 'function') {
      const orig = window.openEditP;
      window.openEditP = function (id) {
        orig(id);
        const p = DB.participants.find(x => x.id === id);
        const ed = (p && p.equality_data) || {};
        fields.forEach(k => { const el = $('mp-eq-' + k); if (el) el.value = ed[k] || ''; });
        const hasData = fields.some(k => ed[k]);
        if (hasData) {
          const body = $('mp-demo-body'), arrow = $('mp-demo-toggle-arrow');
          if (body) body.style.display = 'block';
          if (arrow) arrow.textContent = '▲';
        }
      };
    }
    if (typeof window.saveP === 'function') {
      const orig = window.saveP;
      window.saveP = async function () {
        const captured = {};
        fields.forEach(k => {
          const v = $('mp-eq-' + k) && $('mp-eq-' + k).value;
          if (v) captured[k] = v;
        });
        if (!Object.keys(captured).length) return orig();

        // Temporarily wrap sbInsert/sbUpdate so equality_data is merged in
        const origInsert = window.sbInsert, origUpdate = window.sbUpdate;
        window.sbInsert = async function (table, payload) {
          if (table === 'participants') {
            payload.equality_data = Object.assign({}, payload.equality_data || {}, captured);
          }
          return origInsert(table, payload);
        };
        window.sbUpdate = async function (table, payload, id) {
          if (table === 'participants') {
            const existing = DB.participants.find(x => x.id === id);
            const base = (existing && existing.equality_data) || {};
            payload.equality_data = Object.assign({}, base, captured);
          }
          return origUpdate(table, payload, id);
        };

        try { await orig(); }
        finally {
          window.sbInsert = origInsert;
          window.sbUpdate = origUpdate;
        }
      };
    }
  }

  // ── Patch go() to handle the 'demographics' route ───────────
  function patchGoRouter() {
    if (window._civaraRouterPatched) return;
    window._civaraRouterPatched = true;
    const origGo = window.go;
    if (typeof origGo !== 'function') {
      console.warn('[ext:demographics] window.go not found');
      return;
    }
    window.go = function (page) {
      if (page === 'demographics') {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
        const el = $('page-demographics');
        if (el) el.classList.add('active');
        document.querySelectorAll('.nav-btn').forEach(b => {
          const onclick = b.getAttribute('onclick') || '';
          if (onclick.indexOf("'demographics'") >= 0) b.classList.add('active');
        });
        renderDemographics();
        return;
      }
      return origGo(page);
    };
  }

  // ── Tidy answers so different forms add up ───────────────
  // (Pe2 → PE2, Female → Woman, 45-64 → 45–64, "Yes, physical" → Physical / mobility)
  const DISABILITY_LABELS = {
    none: 'No disability', physical: 'Physical / mobility', sensory: 'Sensory',
    mental: 'Mental health', learning: 'Learning disability', neurodiverse: 'Neurodiverse'
  };
  function tidy(key, v) {
    if (v == null) return '';
    let s = String(v).trim();
    if (!s || /^(prefer not to say|n\/?a|none given|-)$/i.test(s)) return '';
    const low = s.toLowerCase();
    if (key === 'age') {
      const a = s.replace(/\s*[-–]\s*/g, '–').replace(/^under/i, 'Under');
      return a === '26–34' ? '25–34' : a;
    }
    if (key === 'gender') {
      if (/^(female|woman|f)$/.test(low)) return 'Woman';
      if (/^(male|man|m)$/.test(low)) return 'Man';
      if (/non[- ]?binary/.test(low)) return 'Non-binary';
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    if (key === 'disability') {
      if (DISABILITY_LABELS[low]) return DISABILITY_LABELS[low];
      if (/^(no|none|no disability)$/.test(low)) return 'No disability';
      if (/both/.test(low)) return 'Physical and mental health';
      if (/physical|mobility/.test(low)) return 'Physical / mobility';
      if (/mental/.test(low)) return 'Mental health';
      if (/sensory|sight|hearing/.test(low)) return 'Sensory';
      if (/learning/.test(low)) return 'Learning disability';
      if (/neuro|autis|adhd/.test(low)) return 'Neurodiverse';
      if (/^yes/.test(low)) return 'Yes (not specified)';
      return s;
    }
    if (key === 'postcode') {
      const m = /^([A-Z]{1,2}\d[A-Z\d]?)/.exec(s.toUpperCase().replace(/\s+/g, ' '));
      return m ? m[1] : '';
    }
    return s;
  }
  // "Black and ethnic minority" = any stated ethnicity outside the White groups
  function isBEM(eth) { return !!eth && !/^white/i.test(eth) && !/prefer not/i.test(eth); }
  function isDisabled(dis) { return !!dis && dis !== 'No disability'; }

  const FIELDS = ['age', 'ethnicity', 'gender', 'disability', 'orientation', 'religion', 'marital', 'postcode'];
  function tidyRecord(d) {
    const out = {};
    FIELDS.forEach(k => { const v = tidy(k, d && d[k]); if (v) out[k] = v; });
    return out;
  }

  // Everyone's demographics for the chosen group — records only, no names
  function demoRecords(group) {
    const recs = [];
    if (group === 'all' || group === 'participants')
      (DB.participants || []).forEach(p => recs.push({ group: 'Participant', d: tidyRecord(p.equality_data) }));
    if (group === 'all' || group === 'volunteers')
      (DB.volunteers || []).forEach(v => recs.push({ group: 'Volunteer', d: tidyRecord(v.equality_data) }));
    if (group === 'all' || group === 'attendees')
      (DB.feedback || []).forEach(f => recs.push({ group: 'Event attendee', d: tidyRecord(f.demographics) }));
    return recs;
  }

  function renderDemographics() {
    const group = ($('demo-group') && $('demo-group').value) || 'all';
    const all = demoRecords(group);
    const withData = all.filter(r => Object.keys(r.d).length > 0);
    const noun = { all: 'records', participants: 'participants', volunteers: 'volunteers', attendees: 'feedback responses' }[group];
    $('demo-sub').textContent = withData.length + ' of ' + all.length + ' ' + noun +
      ' have equality data (' + pct(withData.length, all.length || 1) + '%)';

    const eth = withData.filter(r => r.d.ethnicity);
    const dis = withData.filter(r => r.d.disability);
    const bem = eth.filter(r => isBEM(r.d.ethnicity)).length;
    const disabled = dis.filter(r => isDisabled(r.d.disability)).length;

    $('demo-stats').innerHTML = [
      { l: 'With equality data', v: withData.length, s: pct(withData.length, all.length || 1) + '% of ' + all.length },
      { l: 'Black and ethnic minority', v: eth.length ? pct(bem, eth.length) + '%' : '—', s: eth.length ? bem + ' of ' + eth.length + ' who said' : '' },
      { l: 'Disabled', v: dis.length ? pct(disabled, dis.length) + '%' : '—', s: dis.length ? disabled + ' of ' + dis.length + ' who said' : '' },
      { l: 'Postcode areas', v: new Set(withData.map(r => r.d.postcode).filter(Boolean)).size || '—', s: '' }
    ].map(x => '<div class="stat-card"><div class="stat-lbl">' + escapeHTML(x.l) + '</div><div class="stat-val">' + x.v + '</div>' +
      (x.s ? '<div style="font-size:11px;color:var(--txt3);margin-top:4px">' + escapeHTML(x.s) + '</div>' : '') + '</div>').join('');

    // One sentence a funder report can use as-is
    const pcs = withData.map(r => r.d.postcode).filter(Boolean);
    const pcCount = {};
    pcs.forEach(p => pcCount[p] = (pcCount[p] || 0) + 1);
    const topPc = Object.keys(pcCount).sort((a, b) => pcCount[b] - pcCount[a]).slice(0, 2);
    const bits = [];
    if (eth.length) bits.push(pct(bem, eth.length) + '% black and ethnic minority');
    if (dis.length) bits.push(pct(disabled, dis.length) + '% disabled');
    if (topPc.length && pcs.length) bits.push(pct(topPc.reduce((a, p) => a + pcCount[p], 0), pcs.length) + '% from ' + topPc.join(' and '));
    const hl = $('demo-headline');
    if (hl) {
      hl.style.display = bits.length ? 'block' : 'none';
      hl.innerHTML = '<div class="card-title">For your reports</div>' +
        '<div style="font-size:14px;color:var(--txt);line-height:1.6">Of the ' + noun + ' who told us: ' + escapeHTML(bits.join(', ')) + '.</div>' +
        '<div style="font-size:11px;color:var(--txt3);margin-top:6px">Black and ethnic minority counts every stated ethnicity outside the White groups. Percentages are of people who answered that question.</div>';
    }

    const ids = { age: 'demo-age', ethnicity: 'demo-ethnicity', gender: 'demo-gender', disability: 'demo-disability',
                  orientation: 'demo-orientation', religion: 'demo-religion', marital: 'demo-marital', postcode: 'demo-postcode' };
    FIELDS.forEach(key => {
      const el = $(ids[key]); if (!el) return;
      const answered = withData.filter(r => r.d[key]);
      const counts = {};
      answered.forEach(r => { counts[r.d[key]] = (counts[r.d[key]] || 0) + 1; });
      const pairs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      if (!pairs.length) { el.innerHTML = '<div style="color:var(--txt3);font-size:12px">No data yet.</div>'; return; }
      const total = answered.length;
      el.innerHTML = pairs.slice(0, key === 'postcode' ? 12 : 20).map(pair => {
        const p = Math.round(pair[1] / total * 100);
        return '<div class="demo-bar-wrap">' +
          '<div class="demo-bar-top"><span>' + escapeHTML(pair[0]) + '</span>' +
          '<span style="font-weight:600;color:var(--em)">' + pair[1] + ' (' + p + '%)</span></div>' +
          '<div class="demo-bar-track"><div class="demo-bar-fill" style="width:' + p + '%"></div></div>' +
          '</div>';
      }).join('') + '<div style="font-size:11px;color:var(--txt3);margin-top:6px">' + total + ' answered</div>';
    });
  }
  window.renderDemographics = renderDemographics;

  // Anonymised export: no IDs, no names — one row per record, group + answers
  function exportDemographics() {
    const group = ($('demo-group') && $('demo-group').value) || 'all';
    const rows = [['Group', 'Age', 'Ethnicity', 'Gender', 'Disability', 'Orientation', 'Religion', 'Marital', 'Postcode area']];
    demoRecords(group).filter(r => Object.keys(r.d).length).forEach(r => {
      const e = r.d;
      rows.push([r.group, e.age || '', e.ethnicity || '', e.gender || '', e.disability || '', e.orientation || '', e.religion || '', e.marital || '', e.postcode || '']);
    });
    downloadCSV(rows, 'demographics-anonymised.csv');
  }

  // ── Patch saveEqualityData to include the extra fields ──────
  function patchEqualityModal() {
    if (typeof window.openEqualityModal !== 'function') return;
    if (window._civaraEqualityPatched) return;
    window._civaraEqualityPatched = true;
    const orig = window.openEqualityModal;
    window.openEqualityModal = function (pid) {
      orig(pid);
      const p = DB.participants.find(x => x.id === pid);
      const ed = (p && p.equality_data) || {};
      ['orientation', 'religion', 'marital', 'postcode'].forEach(k => {
        const el = $('eq-' + k); if (el) el.value = ed[k] || '';
      });
    };
    if (typeof window.saveEqualityData === 'function') {
      window.saveEqualityData = saveEqualityWithExtras;
    }
  }

  async function saveEqualityWithExtras() {
    const _editEqPId = window._editEqPId;
    if (!_editEqPId) return;
    const btn = $('eq-save-btn');
    if (btn) { btn.textContent = 'Saving…'; btn.disabled = true; }
    try {
      const data = {
        age:         ($('eq-age')         && $('eq-age').value)         || '',
        ethnicity:   ($('eq-ethnicity')   && $('eq-ethnicity').value)   || '',
        gender:      ($('eq-gender')      && $('eq-gender').value)      || '',
        disability:  ($('eq-disability')  && $('eq-disability').value)  || '',
        orientation: ($('eq-orientation') && $('eq-orientation').value) || '',
        religion:    ($('eq-religion')    && $('eq-religion').value)    || '',
        marital:     ($('eq-marital')     && $('eq-marital').value)     || '',
        postcode:    (($('eq-postcode')   && $('eq-postcode').value)    || '').toUpperCase()
      };
      Object.keys(data).forEach(k => { if (!data[k]) delete data[k]; });
      if (sb && typeof window.sbUpdate === 'function') {
        try { await window.sbUpdate('participants', { equality_data: data }, _editEqPId); }
        catch (e) { /* ignore */ }
      }
      const idx = DB.participants.findIndex(x => x.id === _editEqPId);
      if (idx >= 0) DB.participants[idx].equality_data = data;
      closeModal('modal-eq');
      if (typeof window.renderEqMonitoringList === 'function') window.renderEqMonitoringList();
      if ($('page-demographics') && $('page-demographics').classList.contains('active')) renderDemographics();
    } catch (e) {
      alert('Save failed: ' + e.message);
    } finally {
      if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
    }
  }

})();
