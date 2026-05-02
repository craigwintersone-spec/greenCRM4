// js/render.js — every renderXxx function for every page
// Depends on: config.js, utils.js, db.js, auth.js, agents.js, branding.js
//
// Each renderXxx function reads from DB and writes HTML into the
// page container in app.html. None of them write to Supabase —
// that's modals.js's job.
//
// All field names match the MAPPERS in db.js exactly.

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
    const quotes = FB.filter(f => f.quote && f.quote.trim()).slice(0, 3);
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
      const avgCB = (FB.reduce((a, f) => a + num(f.cb), 0) / FB.length).toFixed(1);
      const avgCA = (FB.reduce((a, f) => a + num(f.ca), 0) / FB.length).toFixed(1);
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

  const fbCount = FB.length || 1;
  const enjoyed = FB.filter(f => num(f.enjoyed) >= 4).length;
  const learned = FB.filter(f => f.learned).length;
  const connected = FB.filter(f => f.connected).length;

  if ($('imp-enjoyed'))   $('imp-enjoyed').textContent   = FB.length ? pct(enjoyed, fbCount) + '%' : '—';
  if ($('imp-learned'))   $('imp-learned').textContent   = FB.length ? pct(learned, fbCount) + '%' : '—';
  if ($('imp-connected')) $('imp-connected').textContent = FB.length ? pct(connected, fbCount) + '%' : '—';

  const cb = FB.map(f => num(f.cb)).filter(n => n > 0);
  const ca = FB.map(f => num(f.ca)).filter(n => n > 0);
  if ($('imp-cb')) $('imp-cb').textContent = cb.length ? (cb.reduce((a, b) => a + b, 0) / cb.length).toFixed(1) : '—';
  if ($('imp-ca')) $('imp-ca').textContent = ca.length ? (ca.reduce((a, b) => a + b, 0) / ca.length).toFixed(1) : '—';

  const quotesEl = $('imp-quotes');
  if (quotesEl) {
    const quotes = FB.filter(f => f.quote && f.quote.trim()).slice(0, 6);
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
// FEEDBACK
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

  // Stats
  const sg = $('fb-stats');
  if (sg) {
    const avgEnj = F.length ? (F.reduce((a, f) => a + num(f.enjoyed), 0) / F.length).toFixed(1) : '—';
    const avgCB = F.length ? (F.reduce((a, f) => a + num(f.cb), 0) / F.length).toFixed(1) : '—';
    const avgCA = F.length ? (F.reduce((a, f) => a + num(f.ca), 0) / F.length).toFixed(1) : '—';
    sg.innerHTML =
      statCard('Avg enjoyment', avgEnj + ' / 5') +
      statCard('Confidence before', avgCB + ' / 5') +
      statCard('Confidence after', avgCA + ' / 5');
  }

  if (!F.length) {
    list.innerHTML = '<div class="card">' + renderEmpty('No feedback responses yet.') + '</div>';
    return;
  }

  list.innerHTML = F.map(f => {
    const ev = (DB.events || []).find(e => String(e.id) === String(f.eventId));
    return '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px">' +
        '<div>' +
          '<div style="font-size:13px;font-weight:600;color:var(--txt)">' + escapeHTML(f.name || 'Anonymous') + '</div>' +
          '<div style="font-size:11px;color:var(--txt3)">' + escapeHTML(ev ? ev.name : 'Event removed') + '</div>' +
        '</div>' +
        '<div style="display:flex;gap:14px;font-size:12px;color:var(--txt2)">' +
          '<span>★ ' + num(f.enjoyed) + '/5</span>' +
          '<span>Conf ' + num(f.cb) + '→' + num(f.ca) + '</span>' +
        '</div>' +
      '</div>' +
      (f.quote ? '<div style="margin-top:10px;font-size:13px;color:var(--txt2);font-style:italic;line-height:1.6">"' + escapeHTML(f.quote) + '"</div>' : '') +
      '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">' +
        (f.learned ? '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border)">Learned new</span>' : '') +
        (f.connected ? '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border)">More connected</span>' : '') +
        (f.friend ? '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:var(--bg);border:1px solid var(--border)">New friend</span>' : '') +
      '</div>' +
      '<div style="text-align:right;margin-top:8px">' +
        '<button class="btn btn-ghost btn-sm" onclick="deleteFb(\'' + escapeHTML(String(f.id)) + '\')">×</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// CIRCULAR ECONOMY
// ─────────────────────────────────────────────────────────────

function renderCircular() {
  const tbody = $('eco-table'); if (!tbody) return;
  const I = DB.circular || [];

  // Stats
  const sg = $('eco-stats');
  if (sg) {
    const totalKg = I.reduce((a, i) => a + num(i.weight_kg), 0);
    const repaired = I.filter(i => i.status === 'Repaired' || i.status === 'Resold' || i.outcome === 'Resold' || i.outcome === 'Donated').length;
    sg.innerHTML =
      statCard('Items logged', I.length) +
      statCard('Repaired/diverted', repaired) +
      statCard('Total weight', totalKg.toFixed(1) + ' kg');
  }

  // Impact
  const impEl = $('eco-impact');
  if (impEl) {
    const totalKg = I.reduce((a, i) => a + num(i.weight_kg), 0);
    const co2 = (totalKg * 6).toFixed(1); // rough estimate, 6kg CO2 per kg waste diverted
    impEl.innerHTML =
      '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--txt2)">♻️ <strong>' + totalKg.toFixed(1) + ' kg</strong> diverted from landfill</div>' +
      '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:12px;color:var(--txt2)">🌍 <strong>~' + co2 + ' kg</strong> CO₂ saved (estimate)</div>';
  }

  if (!I.length) {
    tbody.innerHTML = '<tr><td colspan="7">' + renderEmpty('No items logged yet.') + '</td></tr>';
    return;
  }

  tbody.innerHTML = I.map(i => '<tr>' +
    '<td style="font-weight:600">' + escapeHTML(i.name || '—') + '</td>' +
    '<td>' + escapeHTML(i.category || '—') + '</td>' +
    '<td style="text-align:center">' + num(i.weight_kg).toFixed(1) + ' kg</td>' +
    '<td>' + stageBadge(i.status) + '</td>' +
    '<td>' + escapeHTML(i.fixer || '—') + '</td>' +
    '<td>' + escapeHTML(i.outcome || '—') + '</td>' +
    '<td style="text-align:right;white-space:nowrap">' +
      '<button class="btn btn-ghost btn-sm" onclick="openEditItem(\'' + escapeHTML(String(i.id)) + '\')">Edit</button> ' +
      '<button class="btn btn-ghost btn-sm" onclick="deleteItem(\'' + escapeHTML(String(i.id)) + '\')">×</button>' +
    '</td>' +
  '</tr>').join('');
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

function renderHR() {
  // Banner driven by saved HR mode
  if (typeof updateHRModeBanner === 'function') {
    try { updateHRModeBanner(); } catch (e) { /* ignore */ }
  }
  // Default tab is flags — render whatever's currently visible
  if ($('hr-flags-list') && typeof renderHRFlags === 'function') {
    try { renderHRFlags(); } catch (e) { /* ignore */ }
  }
  if (typeof renderEqMonitoringList === 'function') {
    try { renderEqMonitoringList(); } catch (e) { /* ignore */ }
  }

  // Restore HR mode radio from storage
  const saved = safeStorage.get('hr_mode') || 'advisory';
  const radio = $('hr-mode-' + saved);
  if (radio) radio.checked = true;
  const email = safeStorage.get('hr_manager_email') || '';
  if ($('hr-manager-email')) $('hr-manager-email').value = email;
}

// Stub for the equality monitoring list — the demographics extension
// patches/replaces this if it loads.
function renderEqMonitoringList() {
  const el = $('eq-monitoring-list'); if (!el) return;
  const P = DB.participants || [];
  const withData = P.filter(p => p.equality_data && Object.keys(p.equality_data).length).length;
  const badge = $('eq-completion-badge');
  if (badge) badge.textContent = withData + ' / ' + P.length + ' completed';

  if (!P.length) {
    el.innerHTML = renderEmpty('No participants yet.');
    return;
  }
  el.innerHTML = P.map(p =>
    '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">' +
      '<div style="font-size:13px">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
      '<button class="btn btn-ghost btn-sm" onclick="openEqualityModal(\'' + escapeHTML(String(p.id)) + '\')">' +
        (p.equality_data && Object.keys(p.equality_data).length ? 'Edit' : '+ Complete') +
      '</button>' +
    '</div>'
  ).join('');
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
