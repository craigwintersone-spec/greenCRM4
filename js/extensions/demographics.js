// js/extensions/demographics.js — voluntary equality data + demographics page
// Depends on: utils.js, db.js, modals.js, render.js, router.js
//
// What this adds:
//   • Demographics section on the Add/Edit Participant modal
//   • Extra fields on the Equality monitoring modal (orientation,
//     religion, marital status, postcode)
//   • A new "Demographics" page (renderDemographics)
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
        <button class="btn btn-ghost btn-sm" data-action="export-demographics">Export CSV</button>
      </div>
      <div class="alert alert-info">Demographics are collected voluntarily for anonymised reporting. They are never shared with funders at individual level. Records with no equality data are excluded from these counts.</div>
      <div class="stats-grid" id="demo-stats"></div>
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

  function renderDemographics() {
    const P = DB.participants;
    const withData = P.filter(p => p.equality_data && Object.keys(p.equality_data).length > 0);
    $('demo-sub').textContent = withData.length + ' of ' + P.length +
      ' participants have equality data (' + pct(withData.length, P.length || 1) + '%)';

    $('demo-stats').innerHTML = [
      { l: 'Total participants', v: P.length },
      { l: 'Data completed', v: withData.length },
      { l: 'Completion rate', v: pct(withData.length, P.length || 1) + '%' },
      { l: 'Disclosed disability', v: withData.filter(p => p.equality_data.disability && p.equality_data.disability !== 'none').length }
    ].map(s => '<div class="stat-card"><div class="stat-lbl">' + escapeHTML(s.l) + '</div><div class="stat-val">' + s.v + '</div></div>').join('');

    const fields = [
      { id: 'demo-age',         key: 'age' },
      { id: 'demo-ethnicity',   key: 'ethnicity' },
      { id: 'demo-gender',      key: 'gender' },
      { id: 'demo-disability',  key: 'disability' },
      { id: 'demo-orientation', key: 'orientation' },
      { id: 'demo-religion',    key: 'religion' },
      { id: 'demo-marital',     key: 'marital' },
      { id: 'demo-postcode',    key: 'postcode' }
    ];

    fields.forEach(f => {
      const counts = {};
      withData.forEach(p => {
        const v = p.equality_data[f.key] || '(not stated)';
        counts[v] = (counts[v] || 0) + 1;
      });
      const pairs = Object.entries(counts).sort((a, b) => b[1] - a[1]);
      const total = withData.length || 1;
      const el = $(f.id); if (!el) return;
      if (!pairs.length) {
        el.innerHTML = '<div style="color:var(--txt3);font-size:12px">No data yet.</div>';
        return;
      }
      el.innerHTML = pairs.map(pair => {
        const label = pair[0], count = pair[1];
        const p = Math.round(count / total * 100);
        return '<div class="demo-bar-wrap">' +
          '<div class="demo-bar-top"><span>' + escapeHTML(label) + '</span>' +
          '<span style="font-weight:600;color:var(--em)">' + count + ' (' + p + '%)</span></div>' +
          '<div class="demo-bar-track"><div class="demo-bar-fill" style="width:' + p + '%"></div></div>' +
          '</div>';
      }).join('');
    });
  }

  function exportDemographics() {
    const P = DB.participants;
    const rows = [['Participant ID', 'Age', 'Ethnicity', 'Gender', 'Disability', 'Orientation', 'Religion', 'Marital', 'Postcode']];
    P.forEach(p => {
      const e = p.equality_data || {};
      rows.push([
        'CV-' + String(p.id).padStart(4, '0'),
        e.age || '', e.ethnicity || '', e.gender || '',
        e.disability || '', e.orientation || '', e.religion || '',
        e.marital || '', e.postcode || ''
      ]);
    });
    downloadCSV(rows, 'civara-demographics-anonymised.csv');
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
