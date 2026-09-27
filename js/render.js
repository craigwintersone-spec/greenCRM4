// js/render.js — every renderXxx function for every page
// Depends on: config.js, utils.js, db.js, auth.js, agents.js, branding.js
//
// Each renderXxx function reads from DB and writes HTML into the
// page container in app.html. None of them write to Supabase —
// that's modals.js's job.
//
// All field names match the MAPPERS in db.js exactly.
//
// v3 (feedback measures): the Feedback page, Social Impact and the
// dashboard read the org's OWN questions (DB.survey_measures) instead
// of Vorlana's fixed fields. See the FEEDBACK — measures section.

'use strict';

// ─────────────────────────────────────────────────────────────
// SHARED HELPERS
// ─────────────────────────────────────────────────────────────

function renderEmpty(msg) {
  return '<div style="color:var(--txt3);font-size:13px;padding:20px;text-align:center">' + escapeHTML(msg) + '</div>';
}

function statCard(label, value, sub) {
  return '<div class="stat-card">' +
    '<div class="stat-lbl">' + escapeHTML(label) + '</div>' +
    '<div class="stat-val">' + escapeHTML(String(value)) + '</div>' +
    (sub ? '<div style="font-size:11px;color:var(--txt3);margin-top:4px">' + escapeHTML(sub) + '</div>' : '') +
  '</div>';
}

function riskBadge(risk) {
  const map = { High: 'var(--red)', Medium: 'var(--amber)', Low: 'var(--em)' };
  const c = map[risk] || 'var(--txt3)';
  return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:' + c +
    ';color:#fff;font-size:11px;font-weight:600">' + escapeHTML(risk || '—') + '</span>';
}

function stageBadge(stage) {
  return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:var(--bg);' +
    'border:1px solid var(--border);font-size:11px;font-weight:600;color:var(--txt2)">' +
    escapeHTML(stage || '—') + '</span>';
}

// ─────────────────────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────────────────────

function renderDashboard() {
  const P = DB.participants || [];
  const E = DB.events || [];
  const FB = DB.feedback || [];
  const V = DB.volunteers || [];

  // Greeting + time
  const hr = new Date().getHours();
  const greeting = hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
  if ($('mb-greeting')) $('mb-greeting').textContent = greeting + ' 👋';
  if ($('mb-time')) {
    $('mb-time').textContent = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
    });
  }

  // Sub-header
  if ($('dash-sub')) {
    $('dash-sub').textContent = (currentOrg && currentOrg.name) ? currentOrg.name + ' overview' : 'Overview';
  }

  // Stats grid — only for the areas this organisation uses (Settings → What you do)
  const on = k => typeof orgUses === 'function' ? orgUses(k) : true;
  const peopleOn = on('participants');
  const active = P.filter(p => p.stage !== 'Closed').length;
  const atRisk = P.filter(p => p.risk === 'High' || days(p.last_contact) > 21).length;
  const outcomesAchieved = P.filter(p => p.outcomes && p.outcomes.length > 0).length;
  const sg = $('dash-stats');
  if (sg) {
    const cards = [];
    if (peopleOn) cards.push(statCard('Active participants', active, P.length + ' total'), statCard('At-risk', atRisk, 'High risk or 21+ days no contact'), statCard('Outcomes achieved', outcomesAchieved, pct(outcomesAchieved, P.length || 1) + '%'));
    if (on('events')) cards.push(statCard('Events delivered', E.length, FB.length + ' feedback responses'));
    if (on('volunteers')) {
      const from30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
      const h30 = (DB.volunteer_hours || []).filter(h => (h.date || '') >= from30).reduce((a, h) => a + num(h.hours), 0);
      cards.push(statCard('Volunteer hours', Math.round(h30 * 10) / 10, 'last 30 days · ' + V.filter(v => v.status !== 'Inactive').length + ' volunteers'));
    }
    if (on('circular')) cards.push('<div id="dash-cx-stats" style="display:contents"></div>');
    sg.innerHTML = cards.slice(0, 6).join('');
    if (on('circular') && typeof cxReportLoad === 'function') cxReportLoad().then(() => {
      const el = $('dash-cx-stats'); if (!el || typeof CXR === 'undefined' || !CXR.ok) return;
      const r = cxReportStats({}); if (!r || !r.entries) { el.innerHTML = statCard('Diverted from waste', '0 kg', 'nothing logged yet'); return; }
      el.innerHTML = statCard('Diverted from waste', r.kg + ' kg', r.reused + ' items reused or repaired') +
        (r.foodKg ? statCard('Food shared', r.foodKg + ' kg', '≈ ' + r.meals + ' meals') : statCard('CO₂e avoided', (Math.round(r.co2 / 100) / 10) + ' t', 'estimate'));
    });
  }
  // Without a caseload, the two lists show what needs doing across the other areas
  const t1 = $('dash-risk') && $('dash-risk').previousElementSibling, t2 = $('dash-activity') && $('dash-activity').previousElementSibling;
  if (t1) t1.textContent = peopleOn ? 'At-risk — chase today' : 'Needs attention';
  if (t2) t2.textContent = 'Recent activity';
  if (!peopleOn) { _dashAttention(); return _dashRest(FB); }

  // At-risk list
  const riskEl = $('dash-risk');
  if (riskEl) {
    const at = P.filter(p => p.risk === 'High' || days(p.last_contact) > 21).slice(0, 6);
    if (!at.length) {
      riskEl.innerHTML = renderEmpty('No at-risk cases right now.');
    } else {
      riskEl.innerHTML = at.map(p =>
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">' +
          '<div>' +
            '<div style="font-size:13px;font-weight:600;color:var(--txt)">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
            '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(p.advisor || 'Unassigned') +
              ' · last contact ' + (p.last_contact ? days(p.last_contact) + 'd ago' : 'never') + '</div>' +
          '</div>' +
          riskBadge(p.risk) +
        '</div>'
      ).join('');
    }
  }

  // Recent activity
  const actEl = $('dash-activity');
  if (actEl) {
    const recent = P.filter(p => p.last_contact)
      .sort((a, b) => (b.last_contact || '').localeCompare(a.last_contact || ''))
      .slice(0, 6);
    if (!recent.length) {
      actEl.innerHTML = renderEmpty('No recent activity yet.');
    } else {
      actEl.innerHTML = recent.map(p =>
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">' +
          '<div>' +
            '<div style="font-size:13px;font-weight:600;color:var(--txt)">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
            '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(p.stage || '—') + '</div>' +
          '</div>' +
          '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(fmtD(p.last_contact)) + '</div>' +
        '</div>'
      ).join('');
    }
  }

  _dashRest(FB);
}

// Dashboard lists for organisations without a caseload: what needs doing,
// and what happened lately, across events and circular activity.
async function _dashAttention() {
  const riskEl = $('dash-risk'), actEl = $('dash-activity');
  if (!riskEl || !actEl) return;
  const on = k => typeof orgUses === 'function' ? orgUses(k) : true;
  const today = new Date().toISOString().slice(0, 10);
  const from30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
  const todo = [], recent = [];
  const row = (title, sub, act) => '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)' + (act ? ';cursor:pointer" onclick="' + act : '') + '">' +
    '<div style="min-width:0"><div style="font-size:13px;font-weight:600;color:var(--txt)">' + escapeHTML(title) + '</div><div style="font-size:11px;color:var(--txt3)">' + escapeHTML(sub) + '</div></div></div>';
  if (on('events')) {
    const fbBy = {}; (DB.feedback || []).forEach(f => { fbBy[String(f.eventId || f.event_id)] = 1; });
    (DB.events || []).filter(e => e.date && e.date >= from30 && e.date <= today && !fbBy[String(e.id)])
      .forEach(e => todo.push(row(e.name, 'No feedback collected yet · ' + fmtD(e.date), "go('events')")));
    (DB.events || []).filter(e => e.date && e.date <= today).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4)
      .forEach(e => recent.push([e.date, row(e.name, 'Event · ' + num(e.attendees) + ' attended · ' + fmtD(e.date), "go('events')")]));
  }
  if (on('circular') && typeof cxReportLoad === 'function') {
    try {
      await cxReportLoad();
      if (typeof CXR !== 'undefined' && CXR.ok) {
        const acts = {}; CXR.acts.forEach(a => { acts[a.id] = a; });
        const items = CXR.items.filter(i => acts[i.activity_id]);
        const open = items.filter(i => !i.outcome_type);
        const stuck = open.filter(i => circMode(acts[i.activity_id]) === 'tracked' && cxDays(i.updated_at) > 14);
        const toSort = open.filter(i => circMode(acts[i.activity_id]) === 'tally');
        if (stuck.length) todo.push(row(stuck.length + ' item' + (stuck.length === 1 ? '' : 's') + ' waiting over 14 days', 'Circular · longest: ' + (stuck[0].passport_code || stuck[0].name), "go('circular')"));
        if (toSort.length) todo.push(row(toSort.length + ' entr' + (toSort.length === 1 ? 'y' : 'ies') + ' with no destination', 'Circular · not counted in reports until sorted', "go('circular')"));
        items.filter(i => i.outcome_type).sort((a, b) => String(b.outcome_at || b.created_at).localeCompare(String(a.outcome_at || a.created_at))).slice(0, 5).forEach(i => {
          const a = acts[i.activity_id], o = cxOutcome(a, i.outcome);
          const d = String(i.outcome_at || i.created_at || '').slice(0, 10);
          recent.push([d, row((cxPerKg(cxType(a, i.item_type)) ? cxFmt(i.weight_kg, 1) + ' kg ' : '') + cxLbl(i.name), (a.icon || '') + ' ' + a.name + ' · ' + (o ? o.label : '') + ' · ' + fmtD(d), "go('circular')")]);
        });
      }
    } catch (e) { /* circular optional */ }
  }
  riskEl.innerHTML = todo.length ? todo.slice(0, 6).join('') : renderEmpty('Nothing needs chasing right now.');
  recent.sort((a, b) => String(b[0]).localeCompare(String(a[0])));
  actEl.innerHTML = recent.length ? recent.slice(0, 6).map(x => x[1]).join('') : renderEmpty('No recent activity yet.');
}

function _dashRest(FB) {
  // Feedback highlights
  const fbHi = $('dash-fb-hi');
  if (fbHi) {
    const quotes = measureQuotes(FB, 3);
    if (!quotes.length) {
      fbHi.innerHTML = renderEmpty('No feedback quotes yet.');
    } else {
      fbHi.innerHTML = quotes.map(q =>
        '<div style="font-size:13px;color:var(--txt2);font-style:italic;padding:8px 0;border-bottom:1px solid var(--border);line-height:1.5">' +
          '"' + escapeHTML(q.quote) + '"' +
          (q.name ? '<div style="font-size:11px;color:var(--txt3);font-style:normal;margin-top:4px;font-weight:600">— ' + escapeHTML(q.name) + '</div>' : '') +
        '</div>'
      ).join('');
    }
  }

  // Confidence journey
  const cj = $('dash-conf-j');
  if (cj) {
    if (!FB.length) {
      cj.innerHTML = renderEmpty('Add feedback responses to see confidence journey.');
    } else {
      const avgCB = stdAvg(FB, 'cb');
      const avgCA = stdAvg(FB, 'ca');
      cj.innerHTML =
        '<div style="display:flex;justify-content:space-around;align-items:center;padding:12px 0">' +
          '<div style="text-align:center">' +
            '<div style="font-size:32px;font-weight:800;color:var(--amber)">' + avgCB + '</div>' +
            '<div style="font-size:11px;color:var(--txt3);font-weight:600">before</div>' +
          '</div>' +
          '<div style="font-size:24px;color:var(--txt3)">→</div>' +
          '<div style="text-align:center">' +
            '<div style="font-size:32px;font-weight:800;color:var(--em)">' + avgCA + '</div>' +
            '<div style="font-size:11px;color:var(--txt3);font-weight:600">after</div>' +
          '</div>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--txt3);text-align:center;padding-top:8px">Across ' + FB.length + ' feedback responses</div>';
    }
  }
}

// ─────────────────────────────────────────────────────────────
// RAG DASHBOARD
// ─────────────────────────────────────────────────────────────

function renderRAG() {
  const el = $('rag-list'); if (!el) return;
  const C = DB.contracts || [];
  const P = DB.participants || [];

  if (!C.length) {
    el.innerHTML = '<div class="card">' + renderEmpty('No contracts yet. Add a contract to see RAG status.') + '</div>';
    return;
  }

  el.innerHTML = C.map(c => {
    const linked = P.filter(p => toArr(p.contract_ids).map(String).includes(String(c.id)));
    const linkedOutcomes = linked.filter(p => p.outcomes && p.outcomes.length > 0).length;
    const startsPct = c.target_starts ? Math.round((linked.length / c.target_starts) * 100) : 0;
    const outcomesPct = c.target_outcomes ? Math.round((linkedOutcomes / c.target_outcomes) * 100) : 0;
    const worst = Math.min(startsPct, outcomesPct);
    const colour = worst >= 80 ? 'var(--em)' : worst >= 50 ? 'var(--amber)' : 'var(--red)';
    const label = worst >= 80 ? 'GREEN' : worst >= 50 ? 'AMBER' : 'RED';

    return '<div class="card" style="border-left:4px solid ' + colour + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">' +
        '<div>' +
          '<div style="font-size:14px;font-weight:700;color:var(--txt)">' + escapeHTML(c.name) + '</div>' +
          '<div style="font-size:12px;color:var(--txt3)">' + escapeHTML(c.funder || '—') + '</div>' +
        '</div>' +
        '<div style="font-size:11px;font-weight:700;color:' + colour + '">' + label + '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px">' +
        '<div><div style="font-size:11px;color:var(--txt3);font-weight:600">Starts</div>' +
          '<div style="font-size:18px;font-weight:700;color:var(--txt)">' + linked.length + ' / ' + (c.target_starts || 0) + '</div>' +
          '<div style="font-size:11px;color:var(--txt3)">' + startsPct + '%</div></div>' +
        '<div><div style="font-size:11px;color:var(--txt3);font-weight:600">Outcomes</div>' +
          '<div style="font-size:18px;font-weight:700;color:var(--txt)">' + linkedOutcomes + ' / ' + (c.target_outcomes || 0) + '</div>' +
          '<div style="font-size:11px;color:var(--txt3)">' + outcomesPct + '%</div></div>' +
      '</div>' +
      '<button class="btn btn-ai btn-sm" onclick="runRAGExplainer(\'' + escapeHTML(String(c.id)) + '\',\'' +
        escapeHTML(c.name).replace(/'/g, '\\\'') + '\',\'' +
        escapeHTML(c.funder || '').replace(/'/g, '\\\'') + '\',' +
        startsPct + ',' + outcomesPct + ',' + linked.length + ')">' +
        '✦ Explain this RAG</button>' +
    '</div>';
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// IMPACT WALL
// ─────────────────────────────────────────────────────────────

function renderImpact() {
  if (!currentOrg) return;
  try { cxImpactCard(); } catch (e) { console.error('[circular impact]', e); }

  // Header — org name + UK financial year (Apr–Mar)
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const yy1 = String(year).slice(-2);
  const yy2 = String(year + 1).slice(-2);
  if ($('impact-hd')) {
    $('impact-hd').textContent = (currentOrg.name || 'Your organisation').toUpperCase() + ' · 20' + yy1 + '–' + yy2;
  }

  const P = DB.participants || [];
  const E = DB.events || [];
  const V = DB.volunteers || [];
  const FB = DB.feedback || [];

  if ($('iw-p'))  $('iw-p').textContent  = P.length;
  if ($('iw-ev')) $('iw-ev').textContent = E.length;
  if ($('iw-v'))  $('iw-v').textContent  = V.filter(v => (v.status || 'Active') === 'Active').length;
  if ($('iw-fb')) $('iw-fb').textContent = FB.length;

  // Standard outcomes — read through the org's own questions where they map to them
  if ($('imp-enjoyed'))   $('imp-enjoyed').textContent   = stdPctOrScore(FB, 'enjoyed');
  if ($('imp-learned'))   $('imp-learned').textContent   = stdPct(FB, 'learned');
  if ($('imp-connected')) $('imp-connected').textContent = stdPct(FB, 'connected');
  if ($('imp-cb')) $('imp-cb').textContent = stdAvg(FB, 'cb');
  if ($('imp-ca')) $('imp-ca').textContent = stdAvg(FB, 'ca');

  // The org's own measures — one card each (created once, below the standard three)
  let mg = $('imp-measures');
  if (!mg && $('imp-enjoyed')) {
    mg = document.createElement('div');
    mg.id = 'imp-measures';
    const std3 = $('imp-enjoyed').parentNode.parentNode;
    std3.parentNode.insertBefore(mg, std3.nextSibling);
  }
  if (mg) {
    const own = measureStats(FB).filter(st => !['enjoyed', 'learned', 'connected', 'cb', 'ca'].includes(st.m.maps_to || ''));
    mg.innerHTML = own.length
      ? '<div class="card"><div class="card-title">What participants told us</div>' +
        '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px">' +
        own.map(st => '<div class="stat-card"><div class="stat-lbl" title="' + escapeHTML(st.m.question) + '">' + escapeHTML(measureLabel(st.m)) + '</div><div class="stat-val">' + escapeHTML(st.value) + '</div><div style="font-size:11px;color:var(--txt3);margin-top:4px">' + escapeHTML(st.sub) + '</div></div>').join('') +
        '</div></div>'
      : '';
  }

  const quotesEl = $('imp-quotes');
  if (quotesEl) {
    const quotes = measureQuotes(FB, 6);
    if (!quotes.length) {
      quotesEl.innerHTML = renderEmpty('No participant quotes yet. Add feedback responses with quotes to populate this section.');
    } else {
      quotesEl.innerHTML = quotes.map(q =>
        '<blockquote style="margin:0 0 14px 0;padding:12px 16px;border-left:3px solid var(--em);background:var(--bg);border-radius:6px;font-size:14px;color:var(--txt);line-height:1.6;font-style:italic">' +
          '"' + escapeHTML(q.quote) + '"' +
          (q.name ? '<div style="font-size:11px;color:var(--txt3);font-style:normal;margin-top:6px;font-weight:600">— ' + escapeHTML(q.name) + '</div>' : '') +
        '</blockquote>'
      ).join('');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// PARTICIPANTS
// ─────────────────────────────────────────────────────────────

function renderParticipants() {
  const tbody = $('p-table'); if (!tbody) return;
  let P = (DB.participants || []).slice();

  const search = ($('p-search') && $('p-search').value || '').toLowerCase();
  const stage = $('p-stage') && $('p-stage').value;
  const risk = $('p-risk') && $('p-risk').value;

  if (search) P = P.filter(p => (p.first_name + ' ' + p.last_name).toLowerCase().includes(search));
  if (stage) P = P.filter(p => p.stage === stage);
  if (risk)  P = P.filter(p => p.risk === risk);

  if ($('p-sub')) $('p-sub').textContent = P.length + ' of ' + (DB.participants || []).length + ' shown';

  if (!P.length) {
    tbody.innerHTML = '<tr><td colspan="9">' + renderEmpty('No participants match your filters.') + '</td></tr>';
    return;
  }

  tbody.innerHTML = P.map(p => {
    const contractCount = toArr(p.contract_ids).length;
    const outcomeCount = (p.outcomes || []).length;
    const lastContact = p.last_contact ? fmtD(p.last_contact) : '—';
    return '<tr>' +
      '<td><div style="font-weight:600">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
        '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(p.ref_source || '') + '</div></td>' +
      '<td style="font-size:11px;color:var(--txt3)">' + escapeHTML(String(p.id).slice(0, 8)) + '</td>' +
      '<td>' + stageBadge(p.stage) + '</td>' +
      '<td>' + escapeHTML(p.advisor || '—') + '</td>' +
      '<td style="text-align:center">' + contractCount + '</td>' +
      '<td style="text-align:center">' + outcomeCount + '</td>' +
      '<td>' + riskBadge(p.risk) + '</td>' +
      '<td style="font-size:11px;color:var(--txt3)">' + escapeHTML(lastContact) + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' +
        '<button class="btn btn-ghost btn-sm" onclick="openNotes(\'' + escapeHTML(String(p.id)) + '\')">📝</button> ' +
        '<button class="btn btn-ghost btn-sm" onclick="openEditP(\'' + escapeHTML(String(p.id)) + '\')">Edit</button> ' +
        '<button class="btn btn-ghost btn-sm" onclick="deleteP(\'' + escapeHTML(String(p.id)) + '\')">×</button>' +
      '</td>' +
    '</tr>';
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────────────────────

function renderContacts() {
  const tbody = $('c-table'); if (!tbody) return;
  const C = DB.contacts || [];
  if ($('c-sub')) $('c-sub').textContent = C.length + ' contacts';
  if (!C.length) {
    tbody.innerHTML = '<tr><td colspan="5">' + renderEmpty('No contacts yet. Add your first contact.') + '</td></tr>';
    return;
  }
  tbody.innerHTML = C.map(c => '<tr>' +
    '<td style="font-weight:600">' + escapeHTML(c.first_name + ' ' + c.last_name) + '</td>' +
    '<td>' + escapeHTML(c.email || '—') + '</td>' +
    '<td>' + escapeHTML(c.role || '—') + '</td>' +
    '<td>' + stageBadge(c.status) + '</td>' +
    '<td style="text-align:right;white-space:nowrap">' +
      '<button class="btn btn-ghost btn-sm" onclick="openEditC(\'' + escapeHTML(String(c.id)) + '\')">Edit</button> ' +
      '<button class="btn btn-ghost btn-sm" onclick="deleteC(\'' + escapeHTML(String(c.id)) + '\')">×</button>' +
    '</td>' +
  '</tr>').join('');
}

// ─────────────────────────────────────────────────────────────
// VOLUNTEERS
// ─────────────────────────────────────────────────────────────

function renderVolunteers() {
  const el = $('vol-list'); if (!el) return;
  let V = (DB.volunteers || []).slice();

  const search = ($('vol-search') && $('vol-search').value || '').toLowerCase();
  const status = $('vol-filter-status') && $('vol-filter-status').value;
  if (search) V = V.filter(v => (v.name || '').toLowerCase().includes(search));
  if (status) V = V.filter(v => v.status === status);

  if ($('vol-sub')) $('vol-sub').textContent = V.length + ' of ' + (DB.volunteers || []).length + ' shown';

  if (!V.length) {
    el.innerHTML = '<div class="card">' + renderEmpty('No volunteers match your filters.') + '</div>';
    return;
  }

  el.innerHTML = '<div class="tbl-wrap"><table><thead><tr>' +
    '<th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Skills</th><th>Hours</th><th>Status</th><th></th>' +
    '</tr></thead><tbody>' +
    V.map(v => '<tr>' +
      '<td style="font-weight:600">' + escapeHTML(v.name || '—') + '</td>' +
      '<td>' + escapeHTML(v.email || '—') + '</td>' +
      '<td>' + escapeHTML(v.phone || '—') + '</td>' +
      '<td>' + escapeHTML(v.role || 'Volunteer') + '</td>' +
      '<td style="font-size:11px;color:var(--txt3)">' + escapeHTML((v.skills || []).join(', ') || '—') + '</td>' +
      '<td style="text-align:center">' + num(v.hours) + '</td>' +
      '<td>' + stageBadge(v.status) + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' +
        '<button class="btn btn-ghost btn-sm" onclick="openEditVol(\'' + escapeHTML(String(v.id)) + '\')">Edit</button> ' +
        '<button class="btn btn-ghost btn-sm" onclick="deleteVol(\'' + escapeHTML(String(v.id)) + '\')">×</button>' +
      '</td>' +
    '</tr>').join('') +
    '</tbody></table></div>';
}

// ─────────────────────────────────────────────────────────────
// EMPLOYERS
// ─────────────────────────────────────────────────────────────

function renderEmployers() {
  const tbody = $('emp-table'); if (!tbody) return;
  const E = DB.employers || [];
  if ($('emp-sub')) $('emp-sub').textContent = E.length + ' employers · ' + E.reduce((a, e) => a + num(e.vacancies), 0) + ' open vacancies';
  if (!E.length) {
    tbody.innerHTML = '<tr><td colspan="7">' + renderEmpty('No employers yet.') + '</td></tr>';
    return;
  }
  tbody.innerHTML = E.map(e => '<tr>' +
    '<td style="font-weight:600">' + escapeHTML(e.name || '—') + '</td>' +
    '<td>' + escapeHTML(e.sector || '—') + '</td>' +
    '<td>' + escapeHTML(e.contact_name || '—') +
      (e.contact_email ? '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(e.contact_email) + '</div>' : '') + '</td>' +
    '<td style="text-align:center">' + num(e.vacancies) + '</td>' +
    '<td style="text-align:center">' + num(e.placements) + '</td>' +
    '<td>' + stageBadge(e.relationship) + '</td>' +
    '<td style="text-align:right;white-space:nowrap">' +
      '<button class="btn btn-ghost btn-sm" onclick="openEditEmployer(\'' + escapeHTML(String(e.id)) + '\')">Edit</button> ' +
      '<button class="btn btn-ghost btn-sm" onclick="deleteEmployer(\'' + escapeHTML(String(e.id)) + '\')">×</button>' +
    '</td>' +
  '</tr>').join('');
}

// ─────────────────────────────────────────────────────────────
// PIPELINE (Kanban)
// ─────────────────────────────────────────────────────────────

function renderPipeline() {
  const el = $('kanban'); if (!el) return;
  const P = DB.participants || [];
  const stages = ['Referred', 'Engaged', 'In Support', 'Job Ready', 'Outcome Achieved', 'Sustained'];

  el.innerHTML = stages.map(s => {
    const cards = P.filter(p => p.stage === s);
    return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:12px;min-width:220px">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--txt3);margin-bottom:10px;display:flex;justify-content:space-between">' +
        '<span>' + escapeHTML(s) + '</span><span>' + cards.length + '</span>' +
      '</div>' +
      (cards.length
        ? cards.map(p =>
            '<div style="background:#fff;border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;cursor:pointer" onclick="openEditP(\'' + escapeHTML(String(p.id)) + '\')">' +
              '<div style="font-size:13px;font-weight:600;color:var(--txt);margin-bottom:4px">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
              '<div style="display:flex;justify-content:space-between;align-items:center">' +
                '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(p.advisor || '—') + '</div>' +
                riskBadge(p.risk) +
              '</div>' +
            '</div>'
          ).join('')
        : '<div style="font-size:11px;color:var(--txt3);text-align:center;padding:14px 0">Empty</div>') +
    '</div>';
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// REFERRALS
// ─────────────────────────────────────────────────────────────

function renderReferrals() {
  const tbody = $('ref-table'); if (!tbody) return;
  const R = DB.referrals || [];
  if ($('ref-sub')) $('ref-sub').textContent = R.length + ' referrals';
  if (!R.length) {
    tbody.innerHTML = '<tr><td colspan="7">' + renderEmpty('No referrals yet.') + '</td></tr>';
    return;
  }
  tbody.innerHTML = R.map(r => '<tr>' +
    '<td style="font-weight:600">' + escapeHTML(r.first_name + ' ' + r.last_name) + '</td>' +
    '<td>' + escapeHTML(r.source || '—') + '</td>' +
    '<td>' + stageBadge(r.status) + '</td>' +
    '<td style="font-size:11px;color:var(--txt3)">' + escapeHTML(fmtD(r.referred_date)) + '</td>' +
    '<td>' + escapeHTML(r.advisor || '—') + '</td>' +
    '<td></td>' +
    '<td style="text-align:right">' +
      '<button class="btn btn-ghost btn-sm" onclick="deleteRef(\'' + escapeHTML(String(r.id)) + '\')">×</button>' +
    '</td>' +
  '</tr>').join('');
}

// ─────────────────────────────────────────────────────────────
// PARTNER REFERRALS — stub (do not touch existing portal logic)
// ─────────────────────────────────────────────────────────────

function renderPartnerRefs() {
  const tbody = $('pref-table'); if (!tbody) return;
  const R = DB.partner_referrals || [];
  if (!R.length) {
    tbody.innerHTML = '<tr><td colspan="8">' + renderEmpty('No partner referrals yet. Share your portal link with partners.') + '</td></tr>';
    return;
  }
  tbody.innerHTML = R.map(r => '<tr>' +
    '<td style="font-weight:600">' + escapeHTML((r.first_name || '') + ' ' + (r.last_name || '')) + '</td>' +
    '<td>' + escapeHTML(r.partner_name || '—') + '</td>' +
    '<td>' + escapeHTML(r.primary_need || '—') + '</td>' +
    '<td>' + stageBadge(r.urgency) + '</td>' +
    '<td>' + escapeHTML(r.safeguarding || '—') + '</td>' +
    '<td style="font-size:11px;color:var(--txt3)">' + escapeHTML(fmtD(r.created_at)) + '</td>' +
    '<td>' + stageBadge(r.status) + '</td>' +
    '<td style="text-align:right;white-space:nowrap">' +
      '<button class="btn btn-p btn-sm" onclick="convertToParticipant(\'' + escapeHTML(String(r.id)) + '\')">Convert</button>' +
    '</td>' +
  '</tr>').join('');
}

// ─────────────────────────────────────────────────────────────
// EVENTS
// ─────────────────────────────────────────────────────────────

function renderEvents() {
  const list = $('ev-list'); if (!list) return;
  let E = (DB.events || []).slice();
  const filter = $('ev-filter-type') && $('ev-filter-type').value;
  if (filter) E = E.filter(e => e.type === filter);

  if ($('ev-sub')) $('ev-sub').textContent = E.length + ' events';

  // Stats
  const sg = $('ev-stats');
  if (sg) {
    const totalAttendees = E.reduce((a, e) => a + num(e.attendees), 0);
    const avgFill = E.length ? Math.round(E.reduce((a, e) => a + (e.capacity ? (e.attendees / e.capacity) * 100 : 0), 0) / E.length) : 0;
    sg.innerHTML =
      statCard('Events', E.length) +
      statCard('Total attendees', totalAttendees) +
      statCard('Average fill', avgFill + '%');
  }

  if (!E.length) {
    list.innerHTML = '<div class="card">' + renderEmpty('No events match your filter.') + '</div>';
    return;
  }

  list.innerHTML = '<div class="tbl-wrap"><table><thead><tr>' +
    '<th>Event</th><th>Type</th><th>Date</th><th>Attendees</th><th>Capacity</th><th>Location</th><th></th>' +
    '</tr></thead><tbody>' +
    E.map(e => '<tr>' +
      '<td style="font-weight:600">' + escapeHTML(e.name) + '</td>' +
      '<td>' + escapeHTML(e.type || '—') + '</td>' +
      '<td style="font-size:11px;color:var(--txt3)">' + escapeHTML(fmtD(e.date)) + '</td>' +
      '<td style="text-align:center">' + num(e.attendees) + '</td>' +
      '<td style="text-align:center">' + num(e.capacity) + '</td>' +
      '<td>' + escapeHTML(e.location || '—') + '</td>' +
      '<td style="text-align:right;white-space:nowrap">' +
        '<button class="btn btn-ghost btn-sm" onclick="openEditEv(\'' + escapeHTML(String(e.id)) + '\')">Edit</button> ' +
        '<button class="btn btn-ghost btn-sm" onclick="deleteEv(\'' + escapeHTML(String(e.id)) + '\')">×</button>' +
      '</td>' +
    '</tr>').join('') +
    '</tbody></table></div>';
}

// Used by feedback modal — populate event dropdown
function populateFbEvSelect() {
  const sel = $('fbf-ev'); if (!sel) return;
  const E = DB.events || [];
  sel.innerHTML = '<option value="">Select event…</option>' +
    E.map(e => '<option value="' + escapeHTML(String(e.id)) + '">' + escapeHTML(e.name) + '</option>').join('');
}

// ─────────────────────────────────────────────────────────────
// FEEDBACK — measures (the org's own questions)
//
// Every org has its own feedback questions in DB.survey_measures.
// Each response keeps its answers word-for-word in f.answers, keyed by
// question text. Older rows (before measures existed) only have the
// fixed fields (enjoyed, cb, ca, learned, connected, friend, quote),
// so a measure with maps_to set falls back to those.
// ─────────────────────────────────────────────────────────────

const MEASURE_KINDS = [['score', 'Score (1–5)'], ['yesno', 'Yes / no'], ['choice', 'Multiple choice'], ['text', 'Comment / quote'], ['ignore', 'Not used in reports']];
const MEASURE_MAPS  = [['', 'Own measure'], ['cb', 'Confidence before'], ['ca', 'Confidence after'], ['enjoyed', 'Enjoyment'], ['connected', 'Felt connected'], ['learned', 'Learned / more skilled'], ['friend', 'Made a friend'], ['quote', 'Participant quote']];
const DEFAULT_MEASURES = [
  { question: 'How much did you enjoy the session?',                 kind: 'score', maps_to: 'enjoyed',   label: 'Enjoyed the session' },
  { question: 'How confident did you feel before the session?',     kind: 'score', maps_to: 'cb',        label: 'Confidence before' },
  { question: 'How confident do you feel now, after the session?',  kind: 'score', maps_to: 'ca',        label: 'Confidence after' },
  { question: 'Did you learn something new?',                        kind: 'yesno', maps_to: 'learned',   label: 'Learned something new' },
  { question: 'Do you feel more connected to your community?',       kind: 'yesno', maps_to: 'connected', label: 'Felt more connected' },
  { question: 'Did you make a new friend or talk to new people?',    kind: 'yesno', maps_to: 'friend',    label: 'Made a new friend' },
  { question: 'Is there anything else you would like to tell us?',   kind: 'text',  maps_to: 'quote',     label: 'Comments' }
];
const _LIKERT = {
  'strongly disagree': 1, 'disagree': 2, 'somewhat disagree': 2,
  'neutral': 3, 'neither agree nor disagree': 3, 'neither': 3, 'not sure': 3,
  'somewhat agree': 4, 'agree': 4, 'strongly agree': 5,
  'very poor': 1, 'poor': 2, 'average': 3, 'ok': 3, 'good': 4, 'very good': 5, 'excellent': 5
};

function activeMeasures() {
  return (DB.survey_measures || []).filter(m => m.active !== false && m.kind !== 'ignore')
    .slice().sort((a, b) => (a.sort || 0) - (b.sort || 0));
}
function measureLabel(m) {
  const l = (m.label || m.question || '').trim();
  return l.length > 42 ? l.slice(0, 42) + '…' : l;
}
function scoreOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 5 : 1;
  const s = String(v).trim().toLowerCase();
  if (_LIKERT[s] != null) return _LIKERT[s];
  if (/^\d+(\.\d+)?$/.test(s)) { const x = +s; return x >= 0 && x <= 10 ? x : null; }
  return null;
}
function yesOf(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return v;
  const sc = scoreOf(v);
  if (sc != null) return sc >= 4;
  const s = String(v).trim().toLowerCase();
  if (/^(y|yes|yeah|yep|true|definitely|absolutely|✓)/.test(s)) return true;
  if (/^(n|no|nope|false|not really)/.test(s)) return false;
  return null;
}
// The answer a response gives to a measure: its own answer first, else the fixed field it maps to.
function answerFor(f, m) {
  const a = f.answers && f.answers[m.question];
  if (a != null && a !== '') return a;
  if (!m.maps_to) return null;
  if (m.maps_to === 'quote') return f.quote || null;
  const v = f[m.maps_to];
  if (v == null || v === '') return null;
  if (typeof v === 'boolean') return (m.kind === 'score') ? (v ? 5 : 1) : (v ? 'Yes' : 'No');
  return v;
}

// One stat per active measure, computed from the responses given.
function measureStats(F) {
  const out = [];
  activeMeasures().forEach(m => {
    const vals = F.map(f => answerFor(f, m)).filter(v => v != null && v !== '');
    if (!vals.length || m.kind === 'text') return;
    if (m.kind === 'score') {
      const sc = vals.map(scoreOf).filter(x => x != null);
      if (!sc.length) return;
      const avg = sc.reduce((a, b) => a + b, 0) / sc.length;
      const high = sc.filter(x => x >= 4).length;
      out.push({ m, kind: 'score', value: avg.toFixed(1) + ' / 5', sub: pct(high, sc.length) + '% rated 4–5 · ' + sc.length + ' answers', avg, n: sc.length, pctHigh: pct(high, sc.length) });
    } else if (m.kind === 'yesno') {
      const yn = vals.map(yesOf).filter(x => x != null);
      if (!yn.length) return;
      const yes = yn.filter(Boolean).length;
      out.push({ m, kind: 'yesno', value: pct(yes, yn.length) + '%', sub: yes + ' of ' + yn.length + ' said yes', pctYes: pct(yes, yn.length), n: yn.length });
    } else {
      const counts = {};
      vals.forEach(v => { const k = String(v).trim(); counts[k] = (counts[k] || 0) + 1; });
      const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
      out.push({ m, kind: 'choice', value: top[0].length > 26 ? top[0].slice(0, 26) + '…' : top[0], sub: pct(counts[top[0]], vals.length) + '% · ' + vals.length + ' answers', breakdown: top.map(k => [k, counts[k]]), n: vals.length });
    }
  });
  return out;
}
// Before → after pair, if the org has both.
function measureJourney(F) {
  const M = activeMeasures();
  const cb = M.find(m => m.maps_to === 'cb'), ca = M.find(m => m.maps_to === 'ca');
  if (!cb || !ca) return null;
  const b = F.map(f => scoreOf(answerFor(f, cb))).filter(x => x != null);
  const a = F.map(f => scoreOf(answerFor(f, ca))).filter(x => x != null);
  if (!b.length || !a.length) return null;
  return { before: (b.reduce((x, y) => x + y, 0) / b.length).toFixed(1), after: (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1), n: Math.max(b.length, a.length) };
}
// Quotes: every text measure, plus the fixed quote field.
function measureQuotes(F, limit) {
  const textM = activeMeasures().filter(m => m.kind === 'text');
  const out = [];
  F.forEach(f => {
    let q = f.quote && f.quote.trim();
    if (!q && f.answers) {
      for (const m of textM) { const a = f.answers[m.question]; if (a && String(a).trim().length > 3) { q = String(a).trim(); break; } }
    }
    if (q && q.length > 3 && !/^(no|none|n\/a|nothing|-|\.)$/i.test(q)) out.push({ quote: q, name: f.name || '' });
  });
  return limit ? out.slice(0, limit) : out;
}
// Fixed-field fallbacks used by pages built around Vorlana's standard outcomes.
function stdPct(F, key) {
  const m = activeMeasures().find(x => x.maps_to === key);
  const vals = F.map(f => m ? yesOf(answerFor(f, m)) : (f[key] === true ? true : (f[key] === false ? false : null))).filter(x => x != null);
  return vals.length ? pct(vals.filter(Boolean).length, vals.length) + '%' : '—';
}
// Enjoyment can be a score (avg ≥4 → %) or a yes/no question; either way report a %.
function stdPctOrScore(F, key) {
  const m = activeMeasures().find(x => x.maps_to === key);
  const vals = F.map(f => m ? answerFor(f, m) : f[key]).filter(v => v != null && v !== '');
  if (!vals.length) return '—';
  const yn = vals.map(yesOf).filter(x => x != null);
  return yn.length ? pct(yn.filter(Boolean).length, yn.length) + '%' : '—';
}
function stdAvg(F, key) {
  const m = activeMeasures().find(x => x.maps_to === key);
  const vals = F.map(f => m ? scoreOf(answerFor(f, m)) : (f[key] == null ? null : num(f[key]))).filter(x => x != null && x > 0);
  return vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
}

// ─────────────────────────────────────────────────────────────
// FEEDBACK PAGE
// ─────────────────────────────────────────────────────────────

function renderFeedback() {
  const list = $('fb-list'); if (!list) return;
  let F = (DB.feedback || []).slice();

  // Populate event filter dropdown
  const filterSel = $('fb-filter-ev');
  if (filterSel) {
    const E = DB.events || [];
    const currentVal = filterSel.value;
    filterSel.innerHTML = '<option value="">All events</option>' +
      E.map(e => '<option value="' + escapeHTML(String(e.id)) + '">' + escapeHTML(e.name) + '</option>').join('');
    filterSel.value = currentVal;
  }

  const evFilter = filterSel && filterSel.value;
  if (evFilter) F = F.filter(f => String(f.eventId) === String(evFilter));

  if ($('fb-sub')) $('fb-sub').textContent = F.length + ' responses';

  // Stats — one card per question the org measures
  const sg = $('fb-stats');
  if (sg) {
    const M = activeMeasures();
    if (!M.length) {
      sg.innerHTML =
        statCard('Avg enjoyment', stdAvg(F, 'enjoyed') + ' / 5') +
        statCard('Confidence before', stdAvg(F, 'cb') + ' / 5') +
        statCard('Confidence after', stdAvg(F, 'ca') + ' / 5') +
        '<div class="stat-card" style="display:flex;flex-direction:column;justify-content:center;gap:6px">' +
          '<div style="font-size:12px;color:var(--txt2);line-height:1.5">Set up your own feedback questions and every one becomes a metric here.</div>' +
          '<button class="btn btn-ghost btn-sm" onclick="go(\'settings\');setTimeout(function(){var c=document.getElementById(\'settings-feedback-card\');if(c)c.scrollIntoView({behavior:\'smooth\'})},200)">Set up questions →</button>' +
        '</div>';
    } else {
      const stats = measureStats(F);
      const j = measureJourney(F);
      sg.innerHTML =
        (j ? '<div class="stat-card"><div class="stat-lbl">Confidence before → after</div>' +
              '<div class="stat-val"><span style="color:var(--amber)">' + j.before + '</span> <span style="color:var(--txt3);font-size:16px">→</span> <span style="color:var(--em)">' + j.after + '</span></div>' +
              '<div style="font-size:11px;color:var(--txt3);margin-top:4px">' + j.n + ' responses</div></div>' : '') +
        stats.filter(st => !(j && (st.m.maps_to === 'cb' || st.m.maps_to === 'ca'))).map(st => statCard(measureLabel(st.m), st.value, st.sub)).join('') +
        (stats.length ? '' : statCard('Responses', F.length, 'No answers to your questions yet'));
    }
  }

  if (!F.length) {
    list.innerHTML = '<div class="card">' + renderEmpty('No feedback responses yet.') + '</div>';
    return;
  }

  const M = activeMeasures();
  list.innerHTML = F.map(f => {
    const ev = (DB.events || []).find(e => String(e.id) === String(f.eventId));
    const chips = [], quotes = [];
    if (M.length) {
      M.forEach(m => {
        const a = answerFor(f, m);
        if (a == null || a === '') return;
        if (m.kind === 'text') { if (String(a).trim().length > 3) quotes.push(String(a)); return; }
        let shown = String(a);
        if (m.kind === 'yesno') { const y = yesOf(a); shown = y === true ? 'Yes' : y === false ? 'No' : shown; }
        if (m.kind === 'score') { const sc = scoreOf(a); shown = sc != null ? sc + '/5' : shown; }
        chips.push('<span title="' + escapeHTML(m.question) + '" style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border)">' + escapeHTML(measureLabel(m)) + ': <strong>' + escapeHTML(shown.length > 30 ? shown.slice(0, 30) + '…' : shown) + '</strong></span>');
      });
      if (!quotes.length && f.quote) quotes.push(f.quote);
    } else {
      if (f.enjoyed != null) chips.push('<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border)">★ ' + num(f.enjoyed) + '/5</span>');
      if (f.cb != null || f.ca != null) chips.push('<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border)">Conf ' + (f.cb == null ? '–' : num(f.cb)) + '→' + (f.ca == null ? '–' : num(f.ca)) + '</span>');
      if (f.learned) chips.push('<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border)">Learned new</span>');
      if (f.connected) chips.push('<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border)">More connected</span>');
      if (f.friend) chips.push('<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border)">New friend</span>');
      if (f.quote) quotes.push(f.quote);
    }
    return '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
        '<div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--txt)">' + escapeHTML(f.name || 'Anonymous') + '</div>' +
          '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(ev ? ev.name : 'Event removed') + (ev && ev.date ? ' · ' + escapeHTML(fmtD(ev.date)) : '') + '</div>' +
        '</div>' +
        '<button class="btn btn-ghost btn-sm" onclick="deleteFb(\'' + escapeHTML(String(f.id)) + '\')">×</button>' +
      '</div>' +
      quotes.slice(0, 2).map(q => '<div style="margin-top:10px;font-size:13px;color:var(--txt2);font-style:italic;line-height:1.6">"' + escapeHTML(q) + '"</div>').join('') +
      (chips.length ? '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">' + chips.join('') + '</div>' : '') +
    '</div>';
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// OUTCOMES
// ─────────────────────────────────────────────────────────────

function renderOutcomes() {
  const P = DB.participants || [];

  // Top stats
  const sg = $('out-stats');
  if (sg) {
    const withOutcomes = P.filter(p => p.outcomes && p.outcomes.length > 0).length;
    const sustained = P.filter(p => p.stage === 'Sustained').length;
    const closed = P.filter(p => p.stage === 'Closed').length;
    sg.innerHTML =
      statCard('Total participants', P.length) +
      statCard('With outcomes', withOutcomes, pct(withOutcomes, P.length || 1) + '%') +
      statCard('Sustained', sustained) +
      statCard('Closed', closed);
  }

  // Outcomes by type
  const byType = $('out-by-type');
  if (byType) {
    const counts = {};
    P.forEach(p => (p.outcomes || []).forEach(o => counts[o] = (counts[o] || 0) + 1));
    const arr = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    byType.innerHTML = arr.length
      ? arr.map(o => '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px"><span>' + escapeHTML(o) + '</span><strong>' + counts[o] + '</strong></div>').join('')
      : renderEmpty('No outcomes recorded yet.');
  }

  // Barriers
  const barEl = $('out-barriers');
  if (barEl) {
    const counts = {};
    P.forEach(p => (p.barriers || []).forEach(b => counts[b] = (counts[b] || 0) + 1));
    const arr = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    barEl.innerHTML = arr.length
      ? arr.map(b => '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px"><span>' + escapeHTML(b) + '</span><strong>' + counts[b] + '</strong></div>').join('')
      : renderEmpty('No barriers recorded yet.');
  }

  // Stage breakdown
  const sb = $('out-stage-breakdown');
  if (sb) {
    const stages = ['Referred', 'Engaged', 'In Support', 'Job Ready', 'Outcome Achieved', 'Sustained', 'Closed'];
    sb.innerHTML = stages.map(s => {
      const c = P.filter(p => p.stage === s).length;
      return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px">' +
        '<span>' + escapeHTML(s) + '</span><strong>' + c + '</strong></div>';
    }).join('');
  }

  // Confidence scores
  const conf = $('out-confidence');
  if (conf) {
    const withScores = P.filter(p => p.scores && p.scores.confidence);
    if (!withScores.length) {
      conf.innerHTML = renderEmpty('No confidence scores recorded yet.');
    } else {
      const avg = (withScores.reduce((a, p) => a + num(p.scores.confidence), 0) / withScores.length).toFixed(1);
      conf.innerHTML = '<div style="text-align:center;padding:14px"><div style="font-size:36px;font-weight:800;color:var(--em)">' + avg + ' / 10</div>' +
        '<div style="font-size:12px;color:var(--txt3);margin-top:4px">Average across ' + withScores.length + ' participants</div></div>';
    }
  }
}

// ─────────────────────────────────────────────────────────────
// FUNDERS
// ─────────────────────────────────────────────────────────────

function renderFunders() {
  const el = $('funders-list'); if (!el) return;
  const F = DB.funders || [];
  const C = DB.contracts || [];

  if (!F.length) {
    el.innerHTML = '<div class="card">' + renderEmpty('No funders yet. Add your first funder to start tracking contracts.') + '</div>';
    return;
  }

  el.innerHTML = F.map(f => {
    const contracts = C.filter(c => String(c.funder_id) === String(f.id));
    const totalValue = contracts.reduce((a, c) => a + num(c.value), 0);
    return '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">' +
        '<div>' +
          '<div style="font-size:15px;font-weight:700;color:var(--txt)">' + escapeHTML(f.name) + '</div>' +
          '<div style="font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px">' + escapeHTML(f.type || 'other') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px">' +
          '<button class="btn btn-p btn-sm" onclick="openAddCon(\'' + escapeHTML(String(f.id)) + '\')">+ Contract</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="openEditFunder(\'' + escapeHTML(String(f.id)) + '\')">Edit</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="deleteFunder(\'' + escapeHTML(String(f.id)) + '\')">×</button>' +
        '</div>' +
      '</div>' +
      (f.contact_name || f.contact_email
        ? '<div style="font-size:12px;color:var(--txt2);margin-bottom:8px">' + escapeHTML(f.contact_name || '') +
          (f.contact_email ? ' · ' + escapeHTML(f.contact_email) : '') + '</div>'
        : '') +
      (f.notes ? '<div style="font-size:12px;color:var(--txt3);line-height:1.6;margin-bottom:10px">' + escapeHTML(f.notes) + '</div>' : '') +
      '<div style="font-size:12px;color:var(--txt2);padding-top:10px;border-top:1px solid var(--border)">' +
        '<strong>' + contracts.length + '</strong> contract' + (contracts.length === 1 ? '' : 's') +
        ' · <strong>£' + totalValue.toLocaleString() + '</strong> total value' +
      '</div>' +
    '</div>';
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// FUNDING / CONTRACTS
// ─────────────────────────────────────────────────────────────

function renderFunding() {
  const el = $('fund-list'); if (!el) return;
  const C = DB.contracts || [];
  const P = DB.participants || [];
  if ($('fund-sub')) {
    const total = C.reduce((a, c) => a + num(c.value), 0);
    $('fund-sub').textContent = C.length + ' contracts · £' + total.toLocaleString() + ' total';
  }

  if (!C.length) {
    el.innerHTML = '<div class="card">' + renderEmpty('No contracts yet.') + '</div>';
    return;
  }

  el.innerHTML = C.map(c => {
    const linked = P.filter(p => toArr(p.contract_ids).map(String).includes(String(c.id)));
    const linkedOutcomes = linked.filter(p => p.outcomes && p.outcomes.length > 0).length;
    return '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px">' +
        '<div>' +
          '<div style="font-size:14px;font-weight:700;color:var(--txt)">' + escapeHTML(c.name) + '</div>' +
          '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(c.funder || '—') + ' · £' + num(c.value).toLocaleString() + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:flex-start">' +
          stageBadge(c.status) +
          '<button class="btn btn-ghost btn-sm" onclick="openEditCon(\'' + escapeHTML(String(c.id)) + '\')">Edit</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="deleteCon(\'' + escapeHTML(String(c.id)) + '\')">×</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;font-size:12px">' +
        '<div><div style="color:var(--txt3);font-weight:600">Starts</div><div style="color:var(--txt);font-weight:700">' + linked.length + ' / ' + (c.target_starts || 0) + '</div></div>' +
        '<div><div style="color:var(--txt3);font-weight:600">Outcomes</div><div style="color:var(--txt);font-weight:700">' + linkedOutcomes + ' / ' + (c.target_outcomes || 0) + '</div></div>' +
        '<div><div style="color:var(--txt3);font-weight:600">Start</div><div>' + escapeHTML(fmtD(c.start_date)) + '</div></div>' +
        '<div><div style="color:var(--txt3);font-weight:600">End</div><div>' + escapeHTML(fmtD(c.end_date)) + '</div></div>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// REPORTS
// ─────────────────────────────────────────────────────────────

function renderReports() {
  const el = $('reports-contract-list'); if (!el) return;
  const C = DB.contracts || [];
  if (!C.length) {
    el.innerHTML = '<div class="card">' + renderEmpty('Add a contract first to generate a funder report.') + '</div>';
    return;
  }

  el.innerHTML = '<div class="card"><div class="card-title">Select a contract to report on</div>' +
    C.map(c =>
      '<div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);gap:10px">' +
        '<div><div style="font-size:13px;font-weight:600;color:var(--txt)">' + escapeHTML(c.name) + '</div>' +
        '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(c.funder || '—') + ' · ' + escapeHTML(c.report_type || 'other') + '</div></div>' +
        '<button class="btn btn-ai btn-sm" onclick="generateAIReport(\'' + escapeHTML(c.report_type || 'other') + '\',\'' + escapeHTML(String(c.id)) + '\')">✦ Generate</button>' +
      '</div>'
    ).join('') +
    '</div>';
}

// ─────────────────────────────────────────────────────────────
// EVIDENCE
// ─────────────────────────────────────────────────────────────

function renderEvidence() {
  const tbody = $('evid-table'); if (!tbody) return;
  const E = DB.evidence || [];
  if (!E.length) {
    tbody.innerHTML = '<tr><td colspan="7">' + renderEmpty('No evidence uploaded yet.') + '</td></tr>';
    return;
  }
  tbody.innerHTML = E.map(e => '<tr>' +
    '<td style="font-weight:600">' + escapeHTML(e.participant_name || '—') + '</td>' +
    '<td>' + escapeHTML(e.type || '—') + '</td>' +
    '<td>' + escapeHTML(e.linked_outcome || '—') + '</td>' +
    '<td>' + escapeHTML(e.staff || '—') + '</td>' +
    '<td style="font-size:11px;color:var(--txt3)">' + escapeHTML(fmtD(e.evidence_date)) + '</td>' +
    '<td>' + stageBadge(e.status) + '</td>' +
    '<td style="text-align:right">' +
      '<button class="btn btn-ghost btn-sm" onclick="deleteEvid(\'' + escapeHTML(String(e.id)) + '\')">×</button>' +
    '</td>' +
  '</tr>').join('');
}

// ─────────────────────────────────────────────────────────────
// SAFEGUARDING
// ─────────────────────────────────────────────────────────────

function renderSafeguarding() {
  const flagsEl = $('safe-flags');
  const consentEl = $('consent-list');
  const P = DB.participants || [];

  if (flagsEl) {
    const flagged = P.filter(p => p.safeguarding);
    if (!flagged.length) {
      flagsEl.innerHTML = renderEmpty('No safeguarding flags recorded.');
    } else {
      flagsEl.innerHTML = flagged.map(p =>
        '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">' +
          '<div><div style="font-size:13px;font-weight:600">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
          '<div style="font-size:11px;color:var(--red);font-weight:600">' + escapeHTML(p.safeguarding) + '</div></div>' +
          riskBadge(p.risk) +
        '</div>'
      ).join('');
    }
  }

  if (consentEl) {
    if (!P.length) {
      consentEl.innerHTML = renderEmpty('No participants yet.');
    } else {
      consentEl.innerHTML =
        '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">' +
          '<span>Total participants</span><strong>' + P.length + '</strong></div>' +
        '<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);font-size:13px">' +
          '<span>With equality data</span><strong>' + P.filter(p => p.equality_data && Object.keys(p.equality_data).length).length + '</strong></div>' +
        '<div style="display:flex;justify-content:space-between;padding:8px 0;font-size:13px">' +
          '<span>Safeguarding flagged</span><strong>' + P.filter(p => p.safeguarding).length + '</strong></div>';
    }
  }
}

// ─────────────────────────────────────────────────────────────
// HR / EQUALITY (page-level — sub-tabs handled by router.js)
// ─────────────────────────────────────────────────────────────

// ── HR / EQUALITY (page-level — sub-tabs handled below) ──────
// v5: flag-queue, manager modes and wellbeing scan removed.
// Default tab is the self-help Language Coach, which needs no render.
function renderHR() {
  // The monitoring tab reads from the DB, so keep it fresh.
  if (typeof renderEqMonitoringList === 'function') {
    try { renderEqMonitoringList(); } catch (e) { /* ignore */ }
  }
}

// Switch between the Equality & Inclusion sub-tabs.
// Called from the buttons in #page-hr in app.html.
function switchHRTab(name, btn) {
  const tabs = ['coach', 'equity', 'monitoring', 'benchmark'];
  tabs.forEach(t => {
    const pane = $('hr-tab-' + t);
    if (pane) pane.style.display = (t === name) ? 'block' : 'none';
  });
  document.querySelectorAll('#page-hr .vtab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  // Refresh the monitoring list when its tab is opened.
  if (name === 'monitoring' && typeof renderEqMonitoringList === 'function') {
    try { renderEqMonitoringList(); } catch (e) { /* ignore */ }
  }
}
