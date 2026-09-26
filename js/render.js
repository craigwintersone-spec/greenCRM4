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

  // Stats grid
  const active = P.filter(p => p.stage !== 'Closed').length;
  const atRisk = P.filter(p => p.risk === 'High' || days(p.last_contact) > 21).length;
  const outcomesAchieved = P.filter(p => p.outcomes && p.outcomes.length > 0).length;
  const sg = $('dash-stats');
  if (sg) {
    sg.innerHTML =
      statCard('Active participants', active, P.length + ' total') +
      statCard('At-risk', atRisk, 'High risk or 21+ days no contact') +
      statCard('Outcomes achieved', outcomesAchieved, pct(outcomesAchieved, P.length || 1) + '%') +
      statCard('Events delivered', E.length, FB.length + ' feedback responses');
  }

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
// FEEDBACK QUESTIONS — Settings card
// ─────────────────────────────────────────────────────────────

let _fqRows = null;   // working copy while editing

function renderFeedbackQuestionsCard() {
  const settingsPage = $('page-settings'); if (!settingsPage) return;
  let card = $('settings-feedback-card');
  if (!card) {
    card = document.createElement('div');
    card.id = 'settings-feedback-card';
    card.className = 'card';
    const saveBtn = $('set-save-btn');
    if (saveBtn) settingsPage.insertBefore(card, saveBtn); else settingsPage.appendChild(card);
  }
  if (!_fqRows) _fqRows = (DB.survey_measures || []).slice().sort((a, b) => (a.sort || 0) - (b.sort || 0)).map(m => Object.assign({}, m));

  const rows = _fqRows.map((m, i) =>
    '<div style="display:grid;grid-template-columns:1fr 150px 170px 32px 32px;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--border)">' +
      '<input data-fq="q" data-i="' + i + '" value="' + escapeHTML(m.question) + '" placeholder="Question as you ask it" style="font-size:13px"' + (m.id ? ' title="Changing the wording starts a new question; old answers stay with the old wording"' : '') + '/>' +
      '<select data-fq="kind" data-i="' + i + '">' + MEASURE_KINDS.map(k => '<option value="' + k[0] + '"' + ((m.kind || 'text') === k[0] ? ' selected' : '') + '>' + k[1] + '</option>').join('') + '</select>' +
      '<select data-fq="maps" data-i="' + i + '">' + MEASURE_MAPS.map(k => '<option value="' + k[0] + '"' + ((m.maps_to || '') === k[0] ? ' selected' : '') + '>' + k[1] + '</option>').join('') + '</select>' +
      '<input type="checkbox" data-fq="active" data-i="' + i + '"' + (m.active !== false ? ' checked' : '') + ' title="Active — asked on the form and shown in reports" style="width:auto"/>' +
      '<button class="btn btn-ghost btn-sm" data-fq="del" data-i="' + i + '" title="Remove">×</button>' +
    '</div>'
  ).join('');

  card.innerHTML =
    '<div class="card-title">💬 Feedback questions</div>' +
    '<div style="font-size:13px;color:var(--txt3);margin-bottom:12px;line-height:1.5">Your own questions, asked on the feedback form and on the QR feedback page, matched when you import a survey file, and turned into the numbers on your Feedback page and reports. Untick to retire a question — its old answers stay.</div>' +
    (_fqRows.length
      ? '<div style="display:grid;grid-template-columns:1fr 150px 170px 32px 32px;gap:8px;font-size:11px;color:var(--txt3);font-weight:600;text-transform:uppercase;letter-spacing:.4px"><div>Question</div><div>Type</div><div>Counts as</div><div>On</div><div></div></div>' + rows
      : '<div style="font-size:13px;color:var(--txt2);padding:10px;background:var(--bg);border-radius:8px;margin-bottom:8px">No questions yet. Start from Vorlana\'s standard set, or import a survey file on the Feedback page and the questions are lifted from it.</div>') +
    '<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap;align-items:center">' +
      '<button class="btn btn-ghost btn-sm" onclick="fqAdd()">+ Add question</button>' +
      (_fqRows.length ? '' : '<button class="btn btn-ghost btn-sm" onclick="fqUseDefaults()">Use Vorlana\'s standard questions</button>') +
      '<button class="btn btn-p btn-sm" id="fq-save-btn" onclick="fqSave()">Save questions</button>' +
      '<span id="fq-msg" style="font-size:12px;color:var(--txt3)"></span>' +
    '</div>';

  card.querySelectorAll('[data-fq]').forEach(el => {
    const i = +el.getAttribute('data-i'), what = el.getAttribute('data-fq');
    if (what === 'del') el.addEventListener('click', () => { _fqRows.splice(i, 1); renderFeedbackQuestionsCard(); });
    else el.addEventListener('change', () => {
      const r = _fqRows[i]; if (!r) return;
      if (what === 'q') r.question = el.value.trim();
      else if (what === 'kind') r.kind = el.value;
      else if (what === 'maps') r.maps_to = el.value || null;
      else if (what === 'active') r.active = el.checked;
    });
  });
}
function fqAdd() { _fqRows.push({ question: '', kind: 'score', maps_to: null, active: true, sort: _fqRows.length }); renderFeedbackQuestionsCard(); }
function fqUseDefaults() { _fqRows = DEFAULT_MEASURES.map((m, i) => Object.assign({ active: true, sort: i }, m)); renderFeedbackQuestionsCard(); }
async function fqSave() {
  const btn = $('fq-save-btn'), msg = $('fq-msg');
  const rows = _fqRows.filter(r => r.question && r.question.trim()).map((r, i) => {
    const o = { org_id: orgId, question: r.question.trim(), kind: r.kind || 'text', maps_to: r.maps_to || null, label: r.label || r.question.trim().slice(0, 60), active: r.active !== false, sort: i };
    if (r.id) o.id = r.id;
    return o;
  });
  const keepIds = rows.filter(r => r.id).map(r => r.id);
  btn.disabled = true; msg.textContent = 'Saving…';
  try {
    const gone = (DB.survey_measures || []).filter(m => !keepIds.includes(m.id)).map(m => m.id);
    if (gone.length) { const d = await sb.from('survey_measures').delete().in('id', gone); if (d.error) throw d.error; }
    if (rows.length) { const r = await sb.from('survey_measures').upsert(rows, { onConflict: 'org_id,question' }); if (r.error) throw r.error; }
    await refreshTable('survey_measures');
    _fqRows = null;
    renderFeedbackQuestionsCard();
    const m2 = $('fq-msg'); if (m2) m2.textContent = '✓ Saved';
    renderFeedback(); renderImpact();
  } catch (e) {
    msg.textContent = 'Could not save: ' + (e.message || e) + (/survey_measures|active|sort/i.test(e.message || '') ? ' — run sql/import-v3.sql (with the v3.1 additions) in Supabase.' : '');
    btn.disabled = false;
  }
}

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
const CX_KG_PER_MEAL = 0.42;              // WRAP standard meal equivalent
const CX_IMPACT_CO2 = ['reuse', 'repair', 'share'];
const CX_IMPACT_KG  = ['reuse', 'repair', 'share', 'recycle'];

function cxE(s) { return escapeHTML(s == null ? '' : String(s)); }
function cxFmt(n, dp) { return (+n || 0).toLocaleString('en-GB', { maximumFractionDigits: dp == null ? 0 : dp, minimumFractionDigits: 0 }); }
function cxAct(id) { return CX.acts.find(a => a.id === id); }
function cxColAct() { return CX.acts.find(a => a.template === 'collections'); }
function cxItemActs() { return CX.acts.filter(a => a.template !== 'collections'); }
function cxType(act, key) { return act && (act.item_types || []).find(t => t.key === key); }
function cxPerKg(t) { return !!t && /per\s*kg/i.test(t.label || ''); }
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
@media(max-width:700px){.cxp-col{min-width:180px}}`;
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
  const a = await sb.from('circular_activities').select('*').eq('org_id', orgId).eq('active', true).order('sort');
  if (a.error) { CX.err = 'Circular needs the database update. Run circular-migration.sql in Supabase, then refresh.'; CX.acts = []; CX.items = []; CX.cols = []; CX.ready = true; return; }
  CX.acts = a.data || [];
  const [it, co] = await Promise.all([
    sb.from('circular_items').select('*').eq('org_id', orgId).order('updated_at', { ascending: false }).limit(3000),
    sb.from('circular_collections').select('*').eq('org_id', orgId).order('created_at', { ascending: false }).limit(1000)
  ]);
  CX.items = it.error ? [] : (it.data || []);
  CX.cols = co.error ? [] : (co.data || []);
  if (it.error) CX.err = 'Could not load items: ' + it.error.message;
  CX.ready = true;
}

async function cxLog(item, action, from, to, data) {
  const { error } = await sb.from('circular_item_events').insert([{
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
  const p = cxPage();
  const colAct = cxColAct();
  const acts = cxItemActs();
  if (CX.tab !== 'all' && CX.tab !== 'collections' && !cxAct(CX.tab)) CX.tab = 'all';
  if (CX.tab === 'collections' && !colAct) CX.tab = 'all';

  let h = '<div class="page-header"><div><div class="page-title">♻️ Circular</div>' +
    '<div class="page-sub">Every item has a passport. Every move is logged.</div></div>' +
    '<div class="cxp-btns">' +
      '<button class="btn btn-ghost btn-sm" onclick="cxOpenScan()">📷 Scan</button>' +
      (colAct ? '<button class="btn btn-ghost btn-sm" onclick="cxOpenBooking()">🚚 New booking</button>' : '') +
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

  h += '<div class="stats-grid">' +
    statCard('In progress', cxFmt(im.inProgress)) +
    statCard('Diverted from waste', cxFmt(im.kg, 1) + ' kg') +
    (food
      ? statCard('Food shared', cxFmt(im.foodKg, 1) + ' kg', '≈ ' + cxFmt(im.foodKg / CX_KG_PER_MEAL) + ' meals')
      : statCard('CO₂e avoided', cxFmt(im.co2 / 1000, 2) + ' t', 'reuse and repair')) +
    (act && act.template === 'repair_cafe'
      ? statCard('Fix rate', im.repairTried ? Math.round(im.repairFixed / im.repairTried * 100) + '%' : '—', cxFmt(im.repairFixed) + ' of ' + cxFmt(im.repairTried) + ' fixed')
      : statCard('Value to people', '£' + cxFmt(im.value), im.income ? '£' + cxFmt(im.income) + ' sales income' : cxFmt(im.reused) + ' items reused')) +
    '</div>';

  h += CX.tab === 'all' ? cxSummaryHTML(acts) : cxBoardHTML(act);
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
      '<div style="margin:6px 0 8px">' + (a.stages || []).map(s =>
        '<span class="cxp-chip">' + cxE(s.label) + ' · ' + live.filter(i => i.stage === s.key).length + '</span>').join('') + '</div>' +
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
    if (edit) {
      const { error } = await sb.from('circular_items').update(d).eq('id', edit.id);
      if (error) throw error;
      await cxLog(Object.assign({}, edit, d), 'edited', null, null, { name: d.name, weight_kg: kg, quantity: qty, serial: d.serial });
      Object.assign(edit, d);
      cxDraw(); cxOpenItem(edit.id);
    } else {
      d.stage = stageKey; d.status = (cxStage(act, stageKey) || {}).label || '';
      d.collection_id = CX.logCtx.collection_id;
      d.org_id = orgId;
      const { data, error } = await sb.from('circular_items').insert([d]).select().single();
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

function cxResize(file, max, q) {
  return new Promise((ok, bad) => {
    const img = new Image(); const url = URL.createObjectURL(file);
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', q).split(',')[1]);
    };
    img.onerror = () => bad(new Error('Image could not be read'));
    img.src = url;
  });
}

// ── Item passport ────────────────────────────────────────────
function cxOpenByCode(code) {
  code = String(code || '').trim().toUpperCase().replace(/^.*#ITEM=/, '');
  const it = CX.items.find(i => (i.passport_code || '').toUpperCase() === code);
  if (it) cxOpenItem(it.id); else alert('No item found with code ' + code);
}

async function cxOpenItem(id, justLogged) {
  const it = CX.items.find(i => String(i.id) === String(id)); if (!it) return;
  const act = cxAct(it.activity_id);
  const stage = cxStage(act, it.stage);
  const out = cxOutcome(act, it.outcome);
  const custom = it.custom || {};
  const t = cxType(act, it.item_type);

  let actions = '';
  if (!it.outcome_type && act) {
    const idx = (act.stages || []).findIndex(s => s.key === it.stage);
    const next = act.stages[idx + 1];
    actions =
      '<div class="form-row"><label>Note (optional, saved with the next step)</label><input id="cx-note" placeholder="e.g. Wiped with nwipe, cert #1234 / given to J.S."/></div>' +
      '<div class="cxp-s" style="margin-bottom:6px">Move to stage</div><div class="cxp-btns" style="margin-bottom:12px">' +
        (next ? '<button class="btn btn-p btn-sm" onclick="cxMove(\'' + it.id + '\',\'' + next.key + '\')">→ ' + cxE(next.label) + '</button>' : '') +
        (act.stages || []).filter(s => s.key !== it.stage && (!next || s.key !== next.key)).map(s =>
          '<button class="btn btn-ghost btn-sm" onclick="cxMove(\'' + it.id + '\',\'' + s.key + '\')">' + cxE(s.label) + '</button>').join('') +
      '</div>' +
      '<div class="cxp-s" style="margin-bottom:6px">Finish as</div><div class="cxp-btns" style="margin-bottom:12px">' +
        (act.outcomes || []).map(o => '<button class="btn btn-ghost btn-sm" onclick="cxFinish(\'' + it.id + '\',\'' + o.key + '\')">' + cxE(o.label) + '</button>').join('') +
      '</div>' +
      (act.links || []).filter(l => l.on === 'end' && l.to).map(l => {
        const to = CX.acts.find(a => a.key === l.to);
        return to && to.template !== 'collections' ? '<div class="cxp-btns" style="margin-bottom:12px"><button class="btn btn-ghost btn-sm" onclick="cxPass(\'' + it.id + '\',\'' + to.id + '\')">Pass to ' + cxE(to.icon + ' ' + to.name) + ' →</button></div>' : '';
      }).join('');
  }

  cxModal(
    (justLogged ? '<div style="background:#F0FDF4;border:1px solid #BBF7D0;color:#15803D;border-radius:8px;padding:8px 12px;font-size:13px;margin-bottom:12px">✓ Logged. Print the label and stick it on the item.</div>' : '') +
    '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px"><div>' +
      '<h2 style="margin-bottom:4px">' + cxE(it.name) + (+it.quantity > 1 ? ' ×' + cxFmt(it.quantity) : '') + '</h2>' +
      '<div class="cxp-s"><span class="cxp-code">' + cxE(it.passport_code) + '</span> · ' + cxE(act ? act.icon + ' ' + act.name : 'No activity') + '</div></div>' +
      '<div class="cxp-btns"><button class="btn btn-ghost btn-sm" onclick="cxPrintLabels([\'' + it.id + '\'])">🏷️ Label</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="cxOpenLog({id:\'' + it.id + '\'})">Edit</button></div></div>' +
    '<div style="margin:14px 0;padding:12px;background:var(--bg);border-radius:8px;font-size:13px;line-height:1.8">' +
      '<strong>' + (it.outcome_type ? 'Finished: ' + cxE(out ? out.label : it.outcome) : 'Stage: ' + cxE(stage ? stage.label : (it.stage || 'unknown'))) + '</strong><br>' +
      cxFmt(it.weight_kg, 1) + ' kg · ' + cxFmt(it.co2e_kg, 1) + ' kg CO₂e · £' + cxFmt(it.value_gbp) + ' value' +
      (t ? ' <span class="cxp-s">(' + cxE(t.source || '') + ')</span>' : '') + '<br>' +
      [it.brand, it.model].filter(Boolean).map(cxE).join(' ') + (it.serial ? ' · SN ' + cxE(it.serial) : '') +
      (it.source ? '<br>From: ' + cxE(it.source) : '') +
      Object.keys(custom).filter(k => k !== 'sale_gbp').map(k => {
        const f = act && (act.fields || []).find(x => x.key === k);
        const v = custom[k] === true ? 'Yes' : custom[k] === false ? 'No' : custom[k];
        return '<br>' + cxE(f ? f.label : k) + ': ' + cxE(v);
      }).join('') +
      (+custom.sale_gbp ? '<br>Sold for £' + cxFmt(custom.sale_gbp, 2) : '') +
    '</div>' +
    actions +
    '<div class="card-title" style="margin-top:6px">Chain of custody</div><div id="cx-hist" class="cxp-s">Loading…</div>' +
    '<div class="modal-footer"><button class="btn btn-ghost" onclick="cxCloseModal()">Close</button></div>', 600);

  const { data, error } = await sb.from('circular_item_events').select('*').eq('org_id', orgId).eq('item_id', String(it.id)).order('id');
  const el = $('cx-hist'); if (!el) return;
  if (error) { el.textContent = 'Could not load history.'; return; }
  const evs = data || [];
  let intact = true;
  evs.forEach((e, i) => { if (e.prev_hash !== (i ? evs[i - 1].hash : 'GENESIS')) intact = false; });
  const lbl = k => { const s = cxStage(act, k) || cxOutcome(act, k); return s ? s.label : (k || ''); };
  el.innerHTML = evs.length
    ? '<div style="margin-bottom:10px;font-weight:700;color:' + (intact ? 'var(--em)' : 'var(--red)') + '">' +
        (intact ? '✓ Chain intact · ' + evs.length + ' linked entries' : '⚠ Chain broken — an entry does not link to the one before') + '</div>' +
      '<div class="cxp-tl">' + evs.map(e => {
        const d = e.data || {};
        const what = e.action === 'moved' ? cxE(lbl(e.from_stage)) + ' → ' + cxE(lbl(e.to_stage))
          : e.action === 'finished' ? 'Finished: ' + cxE(lbl(e.to_stage))
          : e.action === 'passed' ? 'Passed to ' + cxE(d.to_activity || 'another activity')
          : e.action === 'booked_in' ? 'Booked in from collection'
          : e.action === 'logged' ? 'Logged at ' + cxE(lbl(e.to_stage))
          : cxE(e.action);
        return '<div class="cxp-ev"><div class="cxp-t" style="font-weight:600">' + what + '</div>' +
          '<div class="cxp-s">' + new Date(e.occurred_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) +
          (e.actor_name ? ' · ' + cxE(e.actor_name) : '') + (d.note ? ' · ' + cxE(d.note) : '') +
          (d.sale_gbp ? ' · £' + cxFmt(d.sale_gbp, 2) : '') + '</div>' +
          '<div class="cxp-s" style="font-family:ui-monospace,monospace;font-size:10px">#' + cxE((e.hash || '').slice(0, 12)) + '</div></div>';
      }).join('') + '</div>'
    : 'No history recorded yet.';
}

function cxNote() { const n = $('cx-note'); return n ? n.value.trim() : ''; }

async function cxMove(id, stageKey) {
  const it = CX.items.find(i => String(i.id) === String(id)); const act = cxAct(it.activity_id);
  const from = it.stage; const note = cxNote();
  const d = { stage: stageKey, status: (cxStage(act, stageKey) || {}).label || '', updated_at: new Date().toISOString() };
  const { error } = await sb.from('circular_items').update(d).eq('id', it.id);
  if (error) { alert('Could not move: ' + error.message); return; }
  Object.assign(it, d);
  await cxLog(it, 'moved', from, stageKey, note ? { note } : {});
  cxDraw(); cxOpenItem(it.id);
}

async function cxFinish(id, outKey) {
  const it = CX.items.find(i => String(i.id) === String(id)); const act = cxAct(it.activity_id);
  const o = cxOutcome(act, outKey); const note = cxNote();
  const data = note ? { note } : {};
  const custom = Object.assign({}, it.custom || {});
  if (/sold|resold|sale/i.test(o.label)) {
    const p = prompt('Sale price £ (leave blank if unknown)');
    if (p === null) return;
    if (+p) { custom.sale_gbp = +p; data.sale_gbp = +p; }
  }
  // Link: this outcome sends the item on to another activity
  const link = (act.links || []).find(l => l.on === 'outcome:' + outKey && l.to);
  const to = link && CX.acts.find(a => a.key === link.to && a.template !== 'collections');
  if (to) {
    await cxLog(it, 'finished', it.stage, outKey, data);
    return cxPass(id, to.id, true);
  }
  const d = { outcome: outKey, outcome_type: o.type, outcome_at: new Date().toISOString(), status: o.label, custom, updated_at: new Date().toISOString() };
  const { error } = await sb.from('circular_items').update(d).eq('id', it.id);
  if (error) { alert('Could not save: ' + error.message); return; }
  const from = it.stage;
  Object.assign(it, d);
  await cxLog(it, 'finished', from, outKey, data);
  cxDraw(); cxOpenItem(it.id);
}

async function cxPass(id, toActId, silentNote) {
  const it = CX.items.find(i => String(i.id) === String(id)); const to = cxAct(toActId); const fromAct = cxAct(it.activity_id);
  const first = (to.stages || [])[0];
  const t = cxType(to, it.item_type) || (to.item_types || []).find(x => x.label === (cxType(fromAct, it.item_type) || {}).label);
  const f = t ? cxCalc(to, t.key, +it.quantity || 1, +it.weight_kg || 0) : { co2: it.co2e_kg, value: it.value_gbp };
  const d = { activity_id: to.id, category: to.name, stage: first ? first.key : null, status: first ? first.label : '',
    item_type: t ? t.key : it.item_type, co2e_kg: f.co2, value_gbp: f.value,
    outcome: null, outcome_type: null, outcome_at: null, updated_at: new Date().toISOString() };
  const { error } = await sb.from('circular_items').update(d).eq('id', it.id);
  if (error) { alert('Could not pass on: ' + error.message); return; }
  const note = silentNote ? '' : cxNote();
  Object.assign(it, d);
  await cxLog(it, 'passed', null, d.stage, Object.assign({ from_activity: fromAct && fromAct.name, to_activity: to.name }, note ? { note } : {}));
  cxDraw(); cxOpenItem(it.id);
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
      const { error } = await sb.from('circular_collections').update(d).eq('id', id); if (error) throw error;
      Object.assign(c, d);
    } else {
      d.org_id = orgId; d.activity_id = (cxColAct() || {}).id || null; d.status = sched ? 'scheduled' : 'requested';
      const { data, error } = await sb.from('circular_collections').insert([d]).select().single(); if (error) throw error;
      CX.cols.unshift(data);
    }
    cxCloseModal(); CX.tab = 'collections'; cxDraw();
  } catch (e) { alert('Could not save: ' + e.message); btn.disabled = false; }
}

async function cxColStatus(id, status, extra) {
  const c = CX.cols.find(x => x.id === id);
  const d = Object.assign({ status }, extra || {});
  const { error } = await sb.from('circular_collections').update(d).eq('id', id);
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
    const { error } = await sb.from('circular_collections').update({ status: 'booked_in' }).eq('id', id);
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

// ─────────────────────────────────────────────────────────────
// SETTINGS — UNCHANGED (your existing code)
// ─────────────────────────────────────────────────────────────

const _modState = {};

function renderSettings() {
  if (!currentOrg) return;
  const m = currentOrg.modules || {};

  // Org details
  if ($('set-name'))   $('set-name').value   = currentOrg.name || '';
  if ($('set-sector')) try { $('set-sector').value = currentOrg.sector || 'Charity / VCSE'; } catch (e) { /* ignore */ }
  if ($('set-plan'))   $('set-plan').textContent = currentOrg.plan === 'pro' ? 'Pro ✦'
                                                  : currentOrg.plan === 'network' ? 'Network'
                                                  : currentOrg.plan === 'starter' ? 'Starter'
                                                  : 'Free';
  if ($('set-status')) $('set-status').textContent = currentOrg.status || 'active';

  // Modules grid
  if (typeof SET_MODULES !== 'undefined' && $('set-modules-grid')) {
    SET_MODULES.forEach(mod => { _modState[mod.k] = m[mod.k] != null ? m[mod.k] : true; });
    $('set-modules-grid').innerHTML = SET_MODULES.map(mod => {
      const on = _modState[mod.k];
      return '<div class="mod-item ' + (on ? 'on' : '') + '" id="set-mod-item-' + mod.k + '">' +
        '<div><div style="font-size:13px;font-weight:600;color:var(--txt)">' + mod.n + '</div>' +
        '<div style="font-size:11px;color:var(--txt3);margin-top:2px">' + mod.d + '</div></div>' +
        '<div style="position:relative;width:44px;height:24px;flex-shrink:0;cursor:pointer" onclick="toggleMod(\'' + mod.k + '\')">' +
          '<div id="set-mod-track-' + mod.k + '" style="position:absolute;inset:0;border-radius:12px;background:' + (on ? '#1F6F6D' : '#E0DAD0') + ';transition:background .2s"></div>' +
          '<div id="set-mod-thumb-' + mod.k + '" style="position:absolute;top:3px;left:' + (on ? '23' : '3') + 'px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .2s;pointer-events:none;box-shadow:0 1px 2px rgba(0,0,0,.1)"></div>' +
        '</div></div>';
    }).join('');
  }

  // ── BRANDING CARD ──────────────────────────────────────────
  let brandCard = $('settings-branding-card');
  if (!brandCard) {
    brandCard = document.createElement('div');
    brandCard.id = 'settings-branding-card';
    brandCard.className = 'card';
    const settingsPage = $('page-settings');
    const saveBtn = $('set-save-btn');
    if (settingsPage && saveBtn) settingsPage.insertBefore(brandCard, saveBtn);
    else if (settingsPage) settingsPage.appendChild(brandCard);
  }
  brandCard.innerHTML =
    '<div class="card-title">🎨 Logo & brand colour</div>' +
    '<div style="font-size:13px;color:var(--txt3);margin-bottom:18px;line-height:1.5">' +
      'Upload your organisation\'s logo and choose an accent colour. Both appear in the sidebar, banner and reports.' +
    '</div>' +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px" class="set-brand-grid">' +
      '<div>' +
        '<label style="display:block;font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:600">Logo</label>' +
        '<div id="set-logo-drop" style="border:2px dashed var(--border);border-radius:10px;background:var(--bg);padding:18px;text-align:center;cursor:pointer" onclick="document.getElementById(\'set-logo-input\').click()">' +
          '<div id="set-logo-preview" style="width:100%;height:100px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:6px;margin-bottom:10px;overflow:hidden;border:1px solid var(--border)">' +
            (typeof getOrgLogoUrl === 'function' && getOrgLogoUrl(currentOrg)
              ? '<img src="' + escapeHTML(getOrgLogoUrl(currentOrg)) + '" style="max-width:100%;max-height:100%;object-fit:contain"/>'
              : '<span style="color:var(--txt3);font-size:13px">No logo yet</span>') +
          '</div>' +
          '<button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation();document.getElementById(\'set-logo-input\').click()">Choose file</button>' +
          '<input type="file" id="set-logo-input" accept="image/png,image/jpeg,image/svg+xml,image/webp" style="display:none" onchange="handleSetLogoSelect(event)"/>' +
          '<div style="font-size:11px;color:var(--txt3);margin-top:6px">PNG, JPG, SVG or WebP · max 2MB</div>' +
          '<div id="set-logo-status" style="font-size:12px;font-weight:600;margin-top:6px;min-height:16px"></div>' +
        '</div>' +
      '</div>' +
      '<div>' +
        '<label style="display:block;font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:600">Accent colour</label>' +
        '<div id="set-colour-swatches" style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px"></div>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-top:12px">' +
          '<div id="set-colour-preview" style="width:32px;height:32px;border-radius:6px;border:1px solid var(--border);flex-shrink:0;background:' + (currentOrg.brand_color || '#1F6F6D') + '"></div>' +
          '<input type="text" id="set-colour-hex" placeholder="#1F6F6D" value="' + (currentOrg.brand_color || '#1F6F6D') + '" oninput="onSetHexInput(this.value)" style="max-width:130px"/>' +
        '</div>' +
      '</div>' +
    '</div>';

  if (typeof _selectedLogoFile !== 'undefined') _selectedLogoFile = null;
  if (typeof _selectedColour !== 'undefined') _selectedColour = currentOrg.brand_color || '#1F6F6D';
  if (typeof renderSetSwatches === 'function') renderSetSwatches();

  // Feedback questions card
  _fqRows = null;
  try { renderFeedbackQuestionsCard(); } catch (e) { console.error('[feedback questions]', e); }

  // Circular activities card
  try { renderCircularSettingsCard(); } catch (e) { console.error('[circular settings]', e); }

  // Demo mode card
  let demoCard = $('demo-mode-card');
  if (!demoCard) {
    demoCard = document.createElement('div');
    demoCard.id = 'demo-mode-card';
    demoCard.className = 'card';
    const settingsPage = $('page-settings');
    const saveBtn = $('set-save-btn');
    if (settingsPage && saveBtn) settingsPage.insertBefore(demoCard, saveBtn);
  }
  demoCard.innerHTML =
    '<div class="card-title">🎭 Demo mode</div>' +
    '<div style="display:flex;justify-content:space-between;align-items:center;gap:14px">' +
      '<div style="font-size:13px;color:var(--txt2);line-height:1.6;flex:1">Show sample participants, events, feedback and a demo MoJ contract so you can explore every feature without real data. <strong style="color:var(--txt)">Nothing is saved to your database while demo mode is on.</strong></div>' +
      '<div style="position:relative;width:44px;height:24px;flex-shrink:0;cursor:pointer" id="demo-toggle" onclick="toggleDemoMode(' + (!_demoMode) + ')">' +
        '<div id="demo-toggle-track" style="position:absolute;inset:0;border-radius:12px;background:' + (_demoMode ? '#F59E0B' : '#E0DAD0') + ';transition:background .2s"></div>' +
        '<div id="demo-toggle-thumb" style="position:absolute;top:3px;left:' + (_demoMode ? '23' : '3') + 'px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .2s;pointer-events:none;box-shadow:0 1px 2px rgba(0,0,0,.1)"></div>' +
      '</div>' +
    '</div>';
}

// ─────────────────────────────────────────────────────────────
// SETTINGS HELPERS — UNCHANGED
// ─────────────────────────────────────────────────────────────

function renderSetSwatches() {
  const wrap = $('set-colour-swatches'); if (!wrap) return;
  if (typeof BRAND_COLOURS === 'undefined') return;
  wrap.innerHTML = BRAND_COLOURS.map(c =>
    '<div style="width:100%;aspect-ratio:1;border-radius:6px;cursor:pointer;background:' + c.hex +
    ';border:3px solid ' + (c.hex.toLowerCase() === _selectedColour.toLowerCase() ? 'var(--txt)' : 'transparent') +
    ';transition:all .15s;position:relative" title="' + escapeHTML(c.name) +
    '" onclick="pickSetColour(\'' + c.hex + '\')">' +
    (c.hex.toLowerCase() === _selectedColour.toLowerCase()
      ? '<span style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:14px;text-shadow:0 1px 2px rgba(0,0,0,.4)">✓</span>'
      : '') +
    '</div>'
  ).join('');
}

function pickSetColour(hex) {
  _selectedColour = hex;
  if ($('set-colour-hex')) $('set-colour-hex').value = hex;
  if ($('set-colour-preview')) $('set-colour-preview').style.background = hex;
  renderSetSwatches();
}

function onSetHexInput(v) {
  v = (v || '').trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
    _selectedColour = v;
    if ($('set-colour-preview')) $('set-colour-preview').style.background = v;
    renderSetSwatches();
  }
}

function handleSetLogoSelect(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const status = $('set-logo-status');
  if (file.size > 2 * 1024 * 1024) {
    status.textContent = '⚠ File too large (max 2MB)';
    status.style.color = 'var(--red)';
    _selectedLogoFile = null;
    return;
  }
  _selectedLogoFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    $('set-logo-preview').innerHTML =
      '<img src="' + e.target.result + '" style="max-width:100%;max-height:100%;object-fit:contain"/>';
  };
  reader.readAsDataURL(file);
  status.textContent = '✓ ' + file.name + ' ready';
  status.style.color = 'var(--em)';
}

function toggleMod(key) {
  _modState[key] = !_modState[key];
  const track = $('set-mod-track-' + key);
  const thumb = $('set-mod-thumb-' + key);
  const item  = $('set-mod-item-' + key);
  if (track) track.style.background = _modState[key] ? '#1F6F6D' : '#E0DAD0';
  if (thumb) thumb.style.left = _modState[key] ? '23px' : '3px';
  if (item)  item.classList.toggle('on', _modState[key]);
  if (key === 'circular' && typeof renderCircularSettingsCard === 'function') renderCircularSettingsCard();
}

async function saveSettings() {
  const btn = $('set-save-btn');
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    let logoUrl = currentOrg.logo_url || null;
    if (_selectedLogoFile) {
      const ext = (_selectedLogoFile.name.split('.').pop() || 'png').toLowerCase();
      const path = orgId + '/logo-' + Date.now() + '.' + ext;
      const { error: upErr } = await sb.storage.from('org-logos').upload(path, _selectedLogoFile, {
        cacheControl: '3600',
        upsert: false
      });
      if (upErr) throw new Error('Logo upload failed: ' + upErr.message);
      const { data: urlData } = sb.storage.from('org-logos').getPublicUrl(path);
      logoUrl = urlData.publicUrl;
    }

    const mods = {};
    if (typeof SET_MODULES !== 'undefined') {
      SET_MODULES.forEach(mod => mods[mod.k] = _modState[mod.k] != null ? _modState[mod.k] : true);
    }

    const d = {
      name: $('set-name').value,
      sector: $('set-sector').value,
      modules: mods,
      brand_color: _selectedColour,
      logo_url: logoUrl
    };

    if (_modState.circular !== false && typeof _circRunSave === 'function') { clearTimeout(_circSaveTimer); await _circRunSave(); }

    await sbUpdate('organisations', d, orgId);
    currentOrg = Object.assign({}, currentOrg, d);

    if (typeof applyModules === 'function') applyModules(mods);
    if (typeof applyBranding === 'function') applyBranding(currentOrg);
    if ($('ob-txt')) $('ob-txt').textContent = currentOrg.name;

    _selectedLogoFile = null;
    if ($('set-logo-status')) $('set-logo-status').textContent = '';
    $('set-save-msg').style.display = 'flex';
    setTimeout(() => $('set-save-msg').style.display = 'none', 3000);
  } catch (e) {
    alert('Save failed: ' + e.message);
  } finally {
    btn.textContent = 'Save settings';
    btn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────
// CIRCULAR ACTIVITIES — settings builder
// Stored in circular_activities (see circular-migration.sql).
// ─────────────────────────────────────────────────────────────

// ── Circular activities ─────────────────────────────────────
// Templates. Item rows: [label, kg, CO₂e kg avoided if reused, £ value to a household].
// Outcome types drive impact: reuse / repair / share count CO₂e and £; recycle counts kg only.
const CIRC_OUT_TYPES=[
  ['reuse','Reused'],['repair','Repaired'],['share','Shared (food)'],['loan','Loaned'],
  ['return','Returned to owner'],['recycle','Recycled'],['dispose','Disposed'],['other','Other']
];
const CIRC_FIELD_TYPES=[['text','Text'],['number','Number'],['date','Date'],['yesno','Yes / no']];
const CIRC_STARTER='Vorlana starter estimate';

function _circT(key,name,icon,desc,stages,outcomes,items,fields,links){
  return{key,name,icon,desc,
    stages:stages.map(s=>({key:_circSlug(s),label:s})),
    outcomes:outcomes.map(o=>({key:_circSlug(o[0]),label:o[0],type:o[1]})),
    item_types:items.map(i=>({key:_circSlug(i[0]),label:i[0],weight_kg:i[1],co2e_kg:i[2],value_gbp:i[3],source:CIRC_STARTER})),
    fields:(fields||[]).map(f=>({key:_circSlug(f[0]),label:f[0],type:f[1]})),
    links:links||[]};
}
function _circSlug(s){return String(s).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,40)||'x'}
function _circRid(p){return p+'_'+Math.random().toString(36).slice(2,8)}

const CIRC_TEMPLATES=[
  _circT('collections','Collections','🚚','Donors, councils and businesses book a pickup. Items are collected, booked in and passed on.',
    ['Requested','Scheduled','Collected','Booked in'],
    [['Passed to activity','other'],['Declined','other']],
    [],[['Donor reference','text']],[{on:'end',to:''}]),
  _circT('device_reuse','Device reuse','💻','Laptops, phones and tablets: data wiped, tested, refurbished, then donated or resold.',
    ['Booked in','Data wiped','Tested','Refurbished','Ready'],
    [['Donated','reuse'],['Resold','reuse'],['Parts harvested','recycle'],['Recycled','recycle']],
    [['Laptop',2.2,250,200],['Desktop PC',8,300,150],['Monitor',5,200,60],['Tablet',0.5,90,120],['Smartphone',0.2,55,100],['Printer',7,60,50]],
    [['Wipe method','text'],['Wipe certificate ref','text'],['PAT result','yesno']]),
  _circT('repair_cafe','Repair café','🔧','Items brought to a session. Fixed or not, back to the owner with advice.',
    ['Brought in','Diagnosed','Being repaired'],
    [['Fixed','repair'],['Partly fixed','repair'],['Not fixable – advice given','return'],['Referred on','other']],
    [['Kettle',1.2,10,20],['Toaster',1.5,12,20],['Vacuum cleaner',5,35,80],['Lamp',1,8,15],['Hairdryer',0.6,6,15],['Radio / speaker',1.5,15,30],['Clothing item',0.5,8,15],['Bike',15,100,150]],
    [['Fault','text'],['Fixer','text']]),
  _circT('furniture','Furniture & household','🛋️','Furniture and household goods checked, cleaned, then rehomed, sold or recycled.',
    ['Booked in','Checked','Cleaned / repaired','Ready'],
    [['Rehomed','reuse'],['Sold','reuse'],['Recycled','recycle'],['Disposed','dispose']],
    [['Sofa',40,90,250],['Chair',7,15,40],['Table',20,35,80],['Wardrobe',50,80,150],['Bed frame',35,60,120],['Mattress',25,60,150]],
    [['Fire safety label present','yesno']]),
  _circT('textiles','Textiles & clothing','👕','Clothing and textiles sorted, then reused, swapped, sold or recycled.',
    ['Received','Sorted'],
    [['Reused','reuse'],['Swapped','reuse'],['Sold','reuse'],['Recycled','recycle']],
    [['Clothing (per kg)',1,15,10],['Shoes (pair)',1,10,15],['Bedding / linen (per kg)',1,10,8]],
    []),
  _circT('bikes','Bikes','🚲','Bikes safety checked and refurbished, then sold, donated or loaned.',
    ['Booked in','Safety checked','Refurbished','Ready'],
    [['Sold','reuse'],['Donated','reuse'],['Loaned','loan'],['Stripped for parts','recycle'],['Recycled','recycle']],
    [['Adult bike',15,100,150],['Child bike',8,50,60]],
    [['Frame number','text']]),
  _circT('food','Food surplus','🥕','Surplus food collected, stored and shared with households or partners.',
    ['Collected','Stored'],
    [['Shared with households','share'],['Given to partner','share'],['Composted','recycle'],['Disposed','dispose']],
    [['Food (per kg)',1,2.5,3]],
    [['Use-by date','date']]),
  _circT('growing','Growing','🌱','Food grown, harvested and shared, sold or given to food banks.',
    ['Planted','Growing','Harvested'],
    [['Shared','share'],['Given to food bank','share'],['Sold','share'],['Composted','recycle']],
    [['Produce (per kg)',1,0,3]],
    [['Crop','text']]),
  _circT('tool_library','Library of things','🧰','Tools and equipment loaned out and returned.',
    ['Available','On loan','Returned','Under repair'],
    [['Retired','recycle']],
    [['Power tool',2,25,60],['Garden tool',2,10,25],['Event / camping kit',5,20,50]],
    [['Borrower','text'],['Due back','date']]),
  _circT('scrap_store','Scrap store & upcycling','🎨','Materials received, sorted and used in workshops or passed to groups.',
    ['Received','Sorted','In stock'],
    [['Used in workshop','reuse'],['Given to groups / schools','reuse'],['Sold','reuse'],['Recycled','recycle']],
    [['Materials (per kg)',1,1,2]],
    [])
];

let CIRC=[];          // org's activities (loaded + edited)
let CIRC_REMOVED=[];  // saved ids removed this session
let CIRC_READY=false;

async function loadCircSettings(){
  const{data,error}=await sb.from('circular_activities').select('*').eq('org_id',orgId).order('sort');
  if(error){
    $('cx-missing').textContent='Circular set-up needs the database update. Run circular-migration.sql in Supabase, then refresh.';
    $('cx-missing').style.display='block';
    if($('cx-body'))$('cx-body').style.display='none';
    CIRC_READY=false;
  }else{
    CIRC=(data||[]).filter(a=>a.active);
    CIRC_READY=true;
  }
  renderCircSettings();
}

function renderCircSettings(){
  const active=new Set(CIRC.map(a=>a.template).filter(Boolean));
  $('cx-tpl-grid').innerHTML=CIRC_TEMPLATES.map(t=>{
    const on=active.has(t.key);
    return `<div class="cx-tpl ${on?'on':''}">
      <div class="cx-tpl-name">${t.icon} ${escapeHTML(t.name)}</div>
      <div class="cx-tpl-desc">${escapeHTML(t.desc)}</div>
      <div>${on?'<span class="cx-chip">Added</span>':`<button class="btn btn-ghost btn-sm" onclick="circAddTemplate('${t.key}')">Add</button>`}</div>
    </div>`;
  }).join('')+
  `<div class="cx-tpl"><div class="cx-tpl-name">✏️ Build your own</div>
    <div class="cx-tpl-desc">Start blank and set your own stages, outcomes and items.</div>
    <div><button class="btn btn-ghost btn-sm" onclick="circAddCustom()">Create</button></div></div>`;

  if(!CIRC.length){
    $('cx-act-list').innerHTML='<div class="cx-hint">No activities yet. Add one above.</div>';
    return;
  }
  $('cx-act-list').innerHTML=CIRC.map((a,ai)=>_circActHTML(a,ai)).join('');
}

function _circOpt(list,val){return list.map(([v,l])=>`<option value="${v}" ${v===val?'selected':''}>${escapeHTML(l)}</option>`).join('')}

function _circActHTML(a,ai){
  const e=escapeHTML;
  const stages=a.stages.map((s,i)=>`<div class="cx-row">
      <input value="${e(s.label)}" onchange="circSet(${ai},'stages',${i},'label',this.value)"/>
      <button class="cx-ib" title="Move up" onclick="circMove(${ai},'stages',${i},-1)">↑</button>
      <button class="cx-ib" title="Move down" onclick="circMove(${ai},'stages',${i},1)">↓</button>
      <button class="cx-ib" title="Remove" onclick="circDel(${ai},'stages',${i})">×</button></div>`).join('');
  const outs=a.outcomes.map((o,i)=>`<div class="cx-row">
      <input value="${e(o.label)}" onchange="circSet(${ai},'outcomes',${i},'label',this.value)"/>
      <select style="width:170px;flex-shrink:0" onchange="circSet(${ai},'outcomes',${i},'type',this.value)">${_circOpt(CIRC_OUT_TYPES,o.type)}</select>
      <button class="cx-ib" title="Remove" onclick="circDel(${ai},'outcomes',${i})">×</button></div>`).join('');
  const items=a.item_types.map((t,i)=>`<div class="cx-row">
      <input value="${e(t.label)}" onchange="circSet(${ai},'item_types',${i},'label',this.value)"/>
      <input class="cx-n" type="number" step="0.1" min="0" value="${t.weight_kg??''}" onchange="circSet(${ai},'item_types',${i},'weight_kg',+this.value)"/>
      <input class="cx-n" type="number" step="0.1" min="0" value="${t.co2e_kg??''}" onchange="circSet(${ai},'item_types',${i},'co2e_kg',+this.value)"/>
      <input class="cx-n" type="number" step="1" min="0" value="${t.value_gbp??''}" onchange="circSet(${ai},'item_types',${i},'value_gbp',+this.value)"/>
      <button class="cx-ib" title="Remove" onclick="circDel(${ai},'item_types',${i})">×</button></div>`).join('');
  const fields=a.fields.map((f,i)=>`<div class="cx-row">
      <input value="${e(f.label)}" onchange="circSet(${ai},'fields',${i},'label',this.value)"/>
      <select style="width:130px;flex-shrink:0" onchange="circSet(${ai},'fields',${i},'type',this.value)">${_circOpt(CIRC_FIELD_TYPES,f.type)}</select>
      <button class="cx-ib" title="Remove" onclick="circDel(${ai},'fields',${i})">×</button></div>`).join('');

  const others=CIRC.filter((x,xi)=>xi!==ai).map(x=>[x.key,x.icon+' '+x.name]);
  const onOpts=[['end','Finishes the last stage']].concat(a.outcomes.map(o=>['outcome:'+o.key,'Outcome: '+o.label]));
  const links=a.links.map((l,i)=>`<div class="cx-row">
      <select onchange="circSet(${ai},'links',${i},'on',this.value)">${_circOpt(onOpts,l.on)}</select>
      <span style="font-size:13px;color:var(--txt3)">→</span>
      <select onchange="circSet(${ai},'links',${i},'to',this.value)"><option value="">Choose activity…</option>${_circOpt(others,l.to)}</select>
      <button class="cx-ib" title="Remove" onclick="circDel(${ai},'links',${i})">×</button></div>`).join('');

  return `<details class="cx-act" ${a._open?'open':''} ontoggle="CIRC[${ai}]._open=this.open">
    <summary>${e(a.icon||'♻️')} ${e(a.name)}<span class="cx-meta">${a.stages.length} stages · ${a.outcomes.length} outcomes · ${a.item_types.length} item types</span></summary>
    <div class="cx-act-body">
      <div class="cx-sec" style="display:grid;grid-template-columns:70px 1fr;gap:8px">
        <div><label>Icon</label><input value="${e(a.icon||'')}" maxlength="4" onchange="circTop(${ai},'icon',this.value)"/></div>
        <div><label>Name</label><input value="${e(a.name)}" onchange="circTop(${ai},'name',this.value)"/></div>
      </div>
      <div class="cx-sec"><div class="cx-sec-h">Stages</div>${stages||'<div class="cx-hint">No stages.</div>'}
        <button class="btn btn-ghost btn-sm" onclick="circAdd(${ai},'stages')">+ Stage</button></div>
      <div class="cx-sec"><div class="cx-sec-h">Outcomes</div>${outs||'<div class="cx-hint">No outcomes.</div>'}
        <button class="btn btn-ghost btn-sm" onclick="circAdd(${ai},'outcomes')">+ Outcome</button></div>
      <div class="cx-sec"><div class="cx-sec-h">Item types</div>
        ${a.item_types.length?'<div class="cx-cols"><span style="flex:1">Item</span><span style="width:84px">Weight kg</span><span style="width:84px">CO₂e kg</span><span style="width:84px">Value £</span><span style="width:30px"></span></div>':''}
        ${items||'<div class="cx-hint">No item types.</div>'}
        <button class="btn btn-ghost btn-sm" onclick="circAdd(${ai},'item_types')">+ Item type</button></div>
      <div class="cx-sec"><div class="cx-sec-h">Extra fields</div>${fields||'<div class="cx-hint">None. Add any detail you need to record per item.</div>'}
        <button class="btn btn-ghost btn-sm" onclick="circAdd(${ai},'fields')">+ Field</button></div>
      <div class="cx-sec"><div class="cx-sec-h">Links to other activities</div>${links||'<div class="cx-hint">No links. Items stay in this activity.</div>'}
        <button class="btn btn-ghost btn-sm" onclick="circAdd(${ai},'links')" ${others.length?'':'disabled title="Add another activity first"'}>+ Link</button></div>
      <div class="cx-sec" style="text-align:right"><button class="btn btn-ghost btn-sm" style="color:var(--red);border-color:var(--red)" onclick="circRemove(${ai})">Remove activity</button></div>
    </div>
  </details>`;
}

function _circUniqueKey(base){
  let k=_circSlug(base),n=2;
  while(CIRC.some(a=>a.key===k))k=_circSlug(base)+'_'+(n++);
  return k;
}
function circAddTemplate(key){
  const t=JSON.parse(JSON.stringify(CIRC_TEMPLATES.find(x=>x.key===key)));
  const a={key:_circUniqueKey(t.key),template:t.key,name:t.name,icon:t.icon,description:t.desc,
    stages:t.stages,outcomes:t.outcomes,item_types:t.item_types,fields:t.fields,links:t.links,_open:true};
  // Collections: default hand-over to the first other activity
  if(key==='collections'){const other=CIRC.find(x=>x.template!=='collections');a.links=[{on:'end',to:other?other.key:''}]}
  // Anything already added that finishes into nothing: offer collections → this
  CIRC.forEach(x=>{if(x.template==='collections'&&x.links.length&&!x.links[0].to)x.links[0].to=a.key});
  CIRC.push(a);
  renderCircSettings();_circQueueSave();
}
function circAddCustom(){
  CIRC.push({key:_circUniqueKey('custom'),template:null,name:'New activity',icon:'♻️',description:'',
    stages:[{key:_circRid('st'),label:'Received'},{key:_circRid('st'),label:'Ready'}],
    outcomes:[{key:_circRid('oc'),label:'Reused',type:'reuse'},{key:_circRid('oc'),label:'Recycled',type:'recycle'}],
    item_types:[],fields:[],links:[],_open:true});
  renderCircSettings();_circQueueSave();
}
function circTop(ai,f,v){CIRC[ai][f]=v;if(f!=='icon'||v)renderCircSettings();_circQueueSave()}
function circSet(ai,list,i,f,v){CIRC[ai][list][i][f]=v;if(f==='label'&&list!=='item_types'&&list!=='fields')renderCircSettings();_circQueueSave()}
function circMove(ai,list,i,d){
  const arr=CIRC[ai][list],j=i+d;if(j<0||j>=arr.length)return;
  [arr[i],arr[j]]=[arr[j],arr[i]];renderCircSettings();_circQueueSave();
}
function circDel(ai,list,i){CIRC[ai][list].splice(i,1);renderCircSettings();_circQueueSave()}
function circAdd(ai,list){
  const a=CIRC[ai];
  if(list==='stages')a.stages.push({key:_circRid('st'),label:'New stage'});
  if(list==='outcomes')a.outcomes.push({key:_circRid('oc'),label:'New outcome',type:'reuse'});
  if(list==='item_types')a.item_types.push({key:_circRid('it'),label:'New item',weight_kg:0,co2e_kg:0,value_gbp:0,source:'Set by organisation'});
  if(list==='fields')a.fields.push({key:_circRid('f'),label:'New field',type:'text'});
  if(list==='links')a.links.push({on:'end',to:''});
  renderCircSettings();_circQueueSave();
}
function circRemove(ai){
  const a=CIRC[ai];
  if(!confirm('Remove '+a.name+'? Items already logged keep their history.'))return;
  if(a.id)CIRC_REMOVED.push(a.id);
  CIRC.splice(ai,1);
  CIRC.forEach(x=>x.links=x.links.filter(l=>l.to!==a.key));
  renderCircSettings();_circQueueSave();
}
// Auto-save: every change is saved a moment after it's made
let _circSaveTimer=null,_circSaving=false,_circSaveAgain=false;
function _circStatus(t,err){const el=$('cx-save-status');if(el){el.textContent=t;el.style.color=err?'var(--red)':'var(--em)'}}
function _circQueueSave(){
  if(!CIRC_READY)return;
  _circStatus('Saving…');
  clearTimeout(_circSaveTimer);
  _circSaveTimer=setTimeout(_circRunSave,700);
}
async function _circRunSave(){
  if(_circSaving){_circSaveAgain=true;return}
  _circSaving=true;
  try{await saveCircularActivities();_circStatus('✓ Saved')}
  catch(e){_circStatus('Not saved: '+(e.message||e),true)}
  finally{_circSaving=false;if(_circSaveAgain){_circSaveAgain=false;_circRunSave()}}
}
// Item types edited by hand lose the starter-estimate label
function _circMarkEdited(){
  CIRC.forEach(a=>a.item_types.forEach(t=>{
    const tpl=CIRC_TEMPLATES.find(x=>x.key===a.template);
    const orig=tpl&&tpl.item_types.find(o=>o.key===t.key);
    if(orig&&(orig.weight_kg!==t.weight_kg||orig.co2e_kg!==t.co2e_kg||orig.value_gbp!==t.value_gbp))t.source='Set by organisation';
  }));
}

async function saveCircularActivities(){
  if(!CIRC_READY)return;
  _circMarkEdited();
  for(const a of CIRC){
    if(!a.name.trim())throw new Error('Every circular activity needs a name');
    const row={org_id:orgId,key:a.key,template:a.template,name:a.name.trim(),icon:a.icon||'♻️',
      description:a.description||'',stages:a.stages,outcomes:a.outcomes,item_types:a.item_types,
      fields:a.fields,links:a.links.filter(l=>l.to),active:true,sort:CIRC.indexOf(a),updated_at:new Date().toISOString()};
    if(a.id){
      const{error}=await sb.from('circular_activities').update(row).eq('id',a.id);
      if(error)throw error;
    }else{
      const{data,error}=await sb.from('circular_activities').insert([row]).select('id').single();
      if(error)throw error;
      a.id=data.id;
    }
  }
  for(const id of CIRC_REMOVED){
    const{error}=await sb.from('circular_activities').update({active:false}).eq('id',id);
    if(error)throw error;
  }
  CIRC_REMOVED=[];
}

// ── Settings card: circular activities ──────────────────────
function _circInjectStyle(){
  if(document.getElementById('cx-style'))return;
  const st=document.createElement('style');st.id='cx-style';
  st.textContent=`
.cx-tpl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.cx-tpl{padding:12px 14px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);display:flex;flex-direction:column;gap:6px}
.cx-tpl.on{border-color:rgba(31,111,109,.35);background:rgba(31,111,109,.05)}
.cx-tpl-name{font-size:13px;font-weight:700}
.cx-tpl-desc{font-size:12px;color:var(--txt3);line-height:1.45;flex:1}
.cx-act{border:1px solid var(--border);border-radius:var(--radius);margin-bottom:10px;background:var(--surface)}
.cx-act>summary{list-style:none;cursor:pointer;padding:12px 14px;display:flex;align-items:center;gap:10px;font-weight:700;font-size:14px}
.cx-act>summary::-webkit-details-marker{display:none}
.cx-meta{font-weight:400;font-size:12px;color:var(--txt3);margin-left:auto}
.cx-act-body{padding:4px 14px 14px;border-top:1px solid var(--border)}
.cx-sec{margin-top:14px}
.cx-sec label{display:block;font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;font-weight:600}
.cx-sec-h{font-size:11px;font-weight:700;color:var(--txt2);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.cx-row{display:flex;gap:6px;align-items:center;margin-bottom:6px}
.cx-row input,.cx-row select{padding:6px 9px}
.cx-n{width:84px!important;flex-shrink:0}
.cx-ib{background:var(--bg);border:1px solid var(--border);border-radius:6px;width:30px;height:30px;flex-shrink:0;color:var(--txt2);font-size:13px}
.cx-ib:hover{border-color:var(--em);color:var(--em)}
.cx-chip{display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border);color:var(--txt2)}
.cx-cols{display:flex;gap:6px;font-size:11px;color:var(--txt3);margin-bottom:4px}
.cx-hint{font-size:12px;color:var(--txt3);line-height:1.5}`;
  document.head.appendChild(st);
}

function renderCircularSettingsCard(){
  _circInjectStyle();
  let card=$('circ-settings-card');
  if(!card){
    card=document.createElement('div');
    card.id='circ-settings-card';
    card.className='card';
    const page=$('page-settings'),saveBtn=$('set-save-btn'),demo=$('demo-mode-card');
    if(page&&demo)page.insertBefore(card,demo);
    else if(page&&saveBtn)page.insertBefore(card,saveBtn);
    else if(page)page.appendChild(card);
  }
  const on=_modState.circular!==false;
  card.style.display=on?'':'none';
  if(!on)return;
  card.innerHTML=
    '<div class="card-title">♻️ Circular activities</div>'+
    '<div class="cx-hint" style="margin-bottom:14px">Add the activities you run. Each comes pre-set with stages, outcomes and item types. Change anything to match how you work, or build your own. Changes save automatically.</div>'+
    '<div id="cx-save-status" style="font-size:12px;font-weight:700;min-height:16px;margin:-8px 0 10px"></div>'+
    '<div id="cx-missing" style="display:none;background:#FEF2F2;border:1px solid #FECACA;color:#B91C1C;padding:10px 12px;border-radius:8px;font-size:13px;margin-bottom:12px"></div>'+
    '<div id="cx-body">'+
      '<div class="cx-tpl-grid" id="cx-tpl-grid"><div class="cx-hint">Loading…</div></div>'+
      '<div class="cx-sec-h" style="margin-top:20px">Set up each activity</div>'+
      '<div id="cx-act-list"></div>'+
      '<div class="cx-hint" style="margin-top:10px">Weights, CO₂e and £ values are Vorlana starter estimates. Replace them with your own or your funder\'s figures. Reports always show the source.</div>'+
    '</div>';
  CIRC=[];CIRC_REMOVED=[];CIRC_READY=false;
  loadCircSettings();
}
