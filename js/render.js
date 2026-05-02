// js/render.js — every renderXxx() function
// Depends on: config.js, utils.js, db.js, auth.js, agents.js
//
// One render function per page. Each one reads from DB (the in-memory
// cache populated by db.js) and writes HTML into the page's container.
//
// Render functions never call Supabase directly — db.js handles that.
// Render functions never open modals — modals.js handles that.

'use strict';

// ── Dashboard ────────────────────────────────────────────────
function renderDashboard() {
  const P = DB.participants, V = DB.volunteers, E = DB.events, FB = DB.feedback;
  const totalEvP = E.reduce((a, e) => a + num(e.attendees), 0);
  const withOutcomes = P.filter(p => p.outcomes.length > 0).length;
  const avgCB = FB.length ? (FB.reduce((a, f) => a + num(f.cb), 0) / FB.length).toFixed(1) : '-';
  const avgCA = FB.length ? (FB.reduce((a, f) => a + num(f.ca), 0) / FB.length).toFixed(1) : '-';

  if (currentOrg) $('dash-sub').textContent = currentOrg.name + ' · Overview';

  const hr = new Date().getHours();
  $('mb-greeting').textContent = (hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening') + ' 👋';
  $('mb-time').textContent = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric'
  });

  $('dash-stats').innerHTML = [
    { l: 'Active participants', v: P.filter(p => p.stage !== 'Closed').length, s: 'Across all stages' },
    { l: 'Events delivered',    v: E.length, s: totalEvP.toLocaleString() + ' people reached' },
    { l: 'Active volunteers',   v: V.filter(v => v.status === 'Active').length, s: V.reduce((a, v) => a + num(v.hours), 0) + ' hrs total' },
    { l: 'Outcomes achieved',   v: withOutcomes, s: pct(withOutcomes, P.length || 1) + '% rate' }
  ].map(s => '<div class="stat-card"><div class="stat-lbl">' + s.l + '</div><div class="stat-val">' + s.v + '</div><div class="stat-sub">' + s.s + '</div></div>').join('');

  const risk = P.filter(p => p.risk === 'High' || days(p.last_contact) > 21);
  $('dash-risk').innerHTML = risk.length
    ? risk.map(p =>
        '<div class="tl-entry">' +
        '<div class="tl-dot ' + (p.risk === 'High' ? 'red' : 'amber') + '"></div>' +
        '<div><div class="tl-lbl">' + escapeHTML(p.first_name + ' ' + p.last_name) +
        ' <span class="badge ' + rCls(p.risk) + '">' + p.risk + '</span></div>' +
        '<div class="tl-meta">' + (days(p.last_contact) > 21 ? 'No contact ' + days(p.last_contact) + 'd · ' : '') + escapeHTML(p.advisor) + '</div></div></div>'
      ).join('')
    : '<div style="color:var(--txt3);font-size:13px">No at-risk participants 🎉</div>';

  const recent = P.flatMap(p => toArr(p.notes).map(nt => Object.assign({}, nt, { who: p.first_name + ' ' + p.last_name })))
    .sort((a, b) => new Date(b.d) - new Date(a.d))
    .slice(0, 5);
  $('dash-activity').innerHTML = recent.length
    ? recent.map(nt =>
        '<div class="tl-entry"><div class="tl-dot blue"></div>' +
        '<div><div class="tl-lbl">' + escapeHTML(nt.who) + '</div>' +
        '<div class="tl-meta">' + escapeHTML((nt.t || '').slice(0, 65)) + ' · ' + fmtD(nt.d) + '</div></div></div>'
      ).join('')
    : '<div style="color:var(--txt3);font-size:13px">No recent activity.</div>';

  $('dash-fb-hi').innerHTML = [
    { l: 'Enjoyed sessions',   v: pct(FB.filter(f => f.enjoyed >= 4).length, FB.length || 1) + '%' },
    { l: 'Learned something',  v: pct(FB.filter(f => f.learned).length,      FB.length || 1) + '%' },
    { l: 'Felt more connected', v: pct(FB.filter(f => f.connected).length,   FB.length || 1) + '%' }
  ].map(r => '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--border)"><span style="font-size:13px;color:var(--txt2)">' + r.l + '</span><span style="font-weight:700;color:var(--em)">' + r.v + '</span></div>').join('');

  $('dash-conf-j').innerHTML =
    '<div style="display:flex;gap:20px;align-items:center;padding:8px 0">' +
      '<div style="text-align:center"><div style="font-size:36px;font-weight:800;color:var(--amber)">' + avgCB + '</div><div style="font-size:11px;color:var(--txt3);font-weight:600">avg before</div></div>' +
      '<div style="font-size:22px;color:var(--txt3)">→</div>' +
      '<div style="text-align:center"><div style="font-size:36px;font-weight:800;color:var(--em)">' + avgCA + '</div><div style="font-size:11px;color:var(--txt3);font-weight:600">avg after</div></div>' +
    '</div>';

  // Empty state for the morning briefing — actual call only on user click (see boot.js)
  if (!P.length && !E.length) {
    $('mb-body').innerHTML = '<div style="color:var(--txt3);font-size:13px">Add participants or events to see your morning briefing.</div>';
  } else if (!$('mb-body').innerHTML.trim() || $('mb-body').innerHTML.includes('Add participants')) {
    $('mb-body').innerHTML = '<div style="color:var(--txt3);font-size:13px">Click <strong>↻ Refresh</strong> above to generate today\'s briefing.</div>';
  }
}

// ── Impact wall ──────────────────────────────────────────────
function renderImpact() {
  const E = DB.events, FB = DB.feedback, V = DB.volunteers;
  if (currentOrg) $('impact-hd').textContent = currentOrg.name + ' · 2024–25';
  $('iw-p').textContent  = E.reduce((a, e) => a + num(e.attendees), 0).toLocaleString();
  $('iw-ev').textContent = E.length;
  $('iw-v').textContent  = V.filter(v => v.status === 'Active').length;
  $('iw-fb').textContent = FB.length;
  $('imp-enjoyed').textContent   = pct(FB.filter(f => f.enjoyed >= 4).length, FB.length || 1) + '%';
  $('imp-learned').textContent   = pct(FB.filter(f => f.learned).length,      FB.length || 1) + '%';
  $('imp-connected').textContent = pct(FB.filter(f => f.connected).length,    FB.length || 1) + '%';
  $('imp-cb').textContent = FB.length ? (FB.reduce((a, f) => a + num(f.cb), 0) / FB.length).toFixed(1) : '-';
  $('imp-ca').textContent = FB.length ? (FB.reduce((a, f) => a + num(f.ca), 0) / FB.length).toFixed(1) : '-';
  $('imp-quotes').innerHTML = FB.filter(f => f.quote).map(f => {
    const ev = DB.events.find(e => e.id === f.eventId);
    return '<div class="quote-card"><div style="font-size:13px;font-style:italic">"' + escapeHTML(f.quote) + '"</div>' +
      '<div style="font-size:11px;color:var(--txt3);margin-top:4px">' + escapeHTML(f.name || 'Anonymous') + ' · ' + escapeHTML((ev && ev.name) || '') + '</div></div>';
  }).join('') || '<div style="color:var(--txt3);font-size:13px">No quotes yet.</div>';
}

// ── Participants table ───────────────────────────────────────
function renderParticipants() {
  const q = (($('p-search') || {}).value || '').toLowerCase();
  const sf = ($('p-stage') || {}).value || '';
  const rf = ($('p-risk')  || {}).value || '';
  const flt = DB.participants.filter(p => {
    const nm = (p.first_name + ' ' + p.last_name).toLowerCase();
    return (!q || nm.includes(q)) && (!sf || p.stage === sf) && (!rf || p.risk === rf);
  });

  $('p-sub').textContent = DB.participants.length + ' total';

  const stale = DB.participants.filter(p => days(p.last_contact) > 21 && p.stage !== 'Closed');
  const al = $('p-alert');
  if (stale.length) {
    al.style.display = 'flex';
    al.textContent = '⚠ ' + stale.length + ' participant(s) — no contact in 21+ days';
  } else { al.style.display = 'none'; }

  if (!flt.length) {
    $('p-table').innerHTML = '<tr><td colspan="9">' + (DB.participants.length
      ? '<div style="text-align:center;padding:20px;color:var(--txt3)">No participants match filters.</div>'
      : emptyState('👤', 'No participants yet', 'Add your first participant.', '+ Add participant', 'openAddP()')) + '</td></tr>';
    return;
  }

  $('p-table').innerHTML = flt.map(p => {
    const d = days(p.last_contact), ov = d > 21;
    const cons = toArr(p.contract_ids).map(cid => DB.contracts.find(c => String(c.id) === String(cid))).filter(Boolean);
    return '<tr>' +
      '<td><div style="display:flex;align-items:center;gap:8px">' +
        '<div style="width:28px;height:28px;border-radius:50%;background:rgba(31,111,109,.12);display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--em)">' + ini(p.first_name + ' ' + p.last_name) + '</div>' +
        '<div><div class="cn">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
          (p.safeguarding ? '<span class="safe-flag">🔐 ' + escapeHTML(p.safeguarding) + '</span>' : '') +
        '</div></div></td>' +
      '<td style="font-size:11px;color:var(--txt3)">CV-' + String(p.id).padStart(4, '0') + '</td>' +
      '<td><span class="badge" style="background:rgba(31,111,109,.1);color:var(--em)">' + escapeHTML(p.stage) + '</span></td>' +
      '<td style="font-size:12px">' + escapeHTML(p.advisor) + '</td>' +
      '<td>' + (cons.map(c => '<span class="badge b-part">' + escapeHTML(c.name.slice(0, 16)) + '</span>').join(' ') || '<span style="font-size:11px;color:var(--txt3)">None</span>') + '</td>' +
      '<td>' + (p.outcomes.map(o => '<span class="badge b-active" style="margin:1px">' + escapeHTML(o) + '</span>').join('') || '<span style="font-size:11px;color:var(--txt3)">None yet</span>') + '</td>' +
      '<td><span class="badge ' + rCls(p.risk) + '">' + p.risk + '</span></td>' +
      '<td style="font-size:11px;color:' + (ov ? 'var(--amber)' : 'var(--txt3)') + '">' + fmtD(p.last_contact) + (ov ? ' ⚠' : '') + '</td>' +
      '<td><div style="display:flex;gap:4px">' +
        '<button class="btn btn-ghost btn-sm" onclick="openEditP(' + JSON.stringify(p.id) + ')">Edit</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="openNotes(' + JSON.stringify(p.id) + ')">Notes</button>' +
        '<button class="btn btn-danger btn-sm" onclick="deleteP(' + JSON.stringify(p.id) + ')">Del</button>' +
      '</div></td></tr>';
  }).join('');
}

// ── Contacts ─────────────────────────────────────────────────
function renderContacts() {
  $('c-sub').textContent = DB.contacts.length + ' contacts';
  $('c-table').innerHTML = DB.contacts.length
    ? DB.contacts.map(c =>
        '<tr><td class="cn">' + escapeHTML(c.first_name + ' ' + c.last_name) + '</td>' +
        '<td>' + escapeHTML(c.email || '—') + '</td>' +
        '<td><span class="badge b-vol">' + escapeHTML(c.role || '—') + '</span></td>' +
        '<td><span class="badge ' + (c.status === 'Active Supporter' ? 'b-active' : 'b-prospect') + '">' + escapeHTML(c.status) + '</span></td>' +
        '<td><div style="display:flex;gap:4px">' +
          '<button class="btn btn-ghost btn-sm" onclick="openEditC(' + JSON.stringify(c.id) + ')">Edit</button>' +
          '<button class="btn btn-danger btn-sm" onclick="deleteC(' + JSON.stringify(c.id) + ')">Del</button>' +
        '</div></td></tr>'
      ).join('')
    : '<tr><td colspan="5">' + emptyState('📋', 'No contacts yet', 'Add donors, funders, partners.', '+ Add contact', 'openAddC()') + '</td></tr>';
}

// ── Volunteers ───────────────────────────────────────────────
function renderVolunteers() {
  const q = (($('vol-search') || {}).value || '').toLowerCase();
  const sf = ($('vol-filter-status') || {}).value || '';
  const vols = DB.volunteers.filter(v =>
    (!q || v.name.toLowerCase().includes(q) || v.email.toLowerCase().includes(q)) &&
    (!sf || v.status === sf)
  );
  $('vol-sub').textContent = DB.volunteers.length + ' volunteers · ' + DB.volunteers.reduce((a, v) => a + num(v.hours), 0) + ' hrs total';
  $('vol-list').innerHTML = vols.length
    ? vols.map(v =>
        '<div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radiuslg);padding:14px;margin-bottom:10px;box-shadow:0 1px 2px rgba(31,111,109,.04)">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start">' +
            '<div style="display:flex;gap:12px;align-items:center">' +
              '<div class="vol-avatar">' + ini(v.name) + '</div>' +
              '<div><div style="font-weight:600;font-size:14px;color:var(--txt)">' + escapeHTML(v.name) + '</div>' +
              '<div style="font-size:12px;color:var(--txt3)">' + escapeHTML(v.email) + (v.phone ? ' · ' + escapeHTML(v.phone) : '') + '</div></div>' +
            '</div>' +
            '<div style="display:flex;gap:6px">' +
              '<button class="btn btn-ghost btn-sm" onclick="openEditVol(' + JSON.stringify(v.id) + ')">Edit</button>' +
              '<button class="btn btn-danger btn-sm" onclick="deleteVol(' + JSON.stringify(v.id) + ')">Delete</button>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap">' +
            '<span class="badge b-vol">' + escapeHTML(v.role) + '</span>' +
            toArr(v.skills).slice(0, 4).map(s => '<span class="badge b-teal">' + escapeHTML(s) + '</span>').join('') +
            '<span style="font-size:11px;color:var(--txt3);margin-left:4px">' + v.hours + ' hrs · ' + v.status + '</span>' +
          '</div>' +
        '</div>'
      ).join('')
    : emptyState('🤝', 'No volunteers yet', 'Register your team members.', '+ Add volunteer', 'openAddVol()');
}

// CSV export
function exportCSV(type) {
  let rows;
  if (type === 'volunteers') {
    rows = [['Name', 'Email', 'Role', 'Hours', 'Status']]
      .concat(DB.volunteers.map(v => [v.name, v.email, v.role, v.hours, v.status]));
  } else {
    rows = [['ID', 'Name', 'Stage', 'Advisor', 'Outcomes', 'Barriers', 'Risk', 'Last Contact']]
      .concat(DB.participants.map(p => [
        'CV-' + String(p.id).padStart(4, '0'),
        p.first_name + ' ' + p.last_name,
        p.stage, p.advisor,
        p.outcomes.join(';'),
        p.barriers.join(';'),
        p.risk, p.last_contact
      ]));
  }
  downloadCSV(rows, type + '.csv');
}

// ── Employers ────────────────────────────────────────────────
function renderEmployers() {
  const rc = { 'Active partner': 'b-active', 'Engaged': 'b-engaged', 'Prospecting': 'b-prospect', 'Dormant': 'b-lapsed' };
  $('emp-sub').textContent = DB.employers.length + ' employers';
  $('emp-table').innerHTML = DB.employers.length
    ? DB.employers.map(e =>
        '<tr><td class="cn">' + escapeHTML(e.name) + '</td>' +
        '<td><span class="badge b-part">' + escapeHTML(e.sector) + '</span></td>' +
        '<td style="font-size:12px">' + escapeHTML(e.contact_name || '—') + '</td>' +
        '<td style="color:var(--em);font-weight:600">' + e.vacancies + '</td>' +
        '<td style="color:var(--em3)">' + e.placements + '</td>' +
        '<td><span class="badge ' + (rc[e.relationship] || 'b-prospect') + '">' + escapeHTML(e.relationship) + '</span></td>' +
        '<td><div style="display:flex;gap:4px">' +
          '<button class="btn btn-ghost btn-sm" onclick="openEditEmployer(' + JSON.stringify(e.id) + ')">Edit</button>' +
          '<button class="btn btn-danger btn-sm" onclick="deleteEmployer(' + JSON.stringify(e.id) + ')">Del</button>' +
        '</div></td></tr>'
      ).join('')
    : '<tr><td colspan="7">' + emptyState('🏢', 'No employers yet', 'Build your employer network.', '+ Add employer', 'openAddEmployer()') + '</td></tr>';
}

// ── Pipeline (kanban) ────────────────────────────────────────
function renderPipeline() {
  $('kanban').innerHTML = P_STAGES.map(stage => {
    const cards = DB.participants.filter(p => p.stage === stage);
    return '<div class="k-col">' +
      '<div class="k-col-hd">' + stage + '<span class="k-cnt">' + cards.length + '</span></div>' +
      (cards.length
        ? cards.map(p =>
            '<div class="k-card" onclick="openEditP(' + JSON.stringify(p.id) + ')">' +
              '<div class="k-name">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
              '<div class="k-meta">' + escapeHTML(p.advisor) + '</div>' +
              (days(p.last_contact) > 21 ? '<div class="k-flag">⚠ No contact ' + days(p.last_contact) + 'd</div>' : '') +
            '</div>'
          ).join('')
        : '<div style="color:var(--txt3);font-size:11px;text-align:center;padding:12px 4px">Empty</div>') +
    '</div>';
  }).join('');
}

// ── Referrals ────────────────────────────────────────────────
function renderReferrals() {
  $('ref-sub').textContent = DB.referrals.length + ' referrals';
  const stale = DB.referrals.filter(r => r.status === 'Referred' && days(r.referred_date) > 14);
  $('ref-alerts').innerHTML = stale.length
    ? '<div class="alert alert-warn">⚠ ' + stale.length + ' stalled referral(s)</div>'
    : '';
  $('ref-table').innerHTML = DB.referrals.length
    ? DB.referrals.map(r => {
        const d = days(r.referred_date), st = r.status === 'Referred' && d > 14;
        return '<tr><td class="cn">' + escapeHTML(r.first_name + ' ' + r.last_name) + '</td>' +
          '<td><span class="badge b-part">' + escapeHTML(r.source) + '</span></td>' +
          '<td><span class="badge b-ref">' + escapeHTML(r.status) + '</span></td>' +
          '<td style="font-size:12px">' + fmtD(r.referred_date) + '</td>' +
          '<td style="font-size:12px">' + escapeHTML(r.advisor) + '</td>' +
          '<td>' + (st ? '<span class="badge b-flag">⚠ ' + d + 'd</span>' : '—') + '</td>' +
          '<td><button class="btn btn-danger btn-sm" onclick="deleteRef(' + JSON.stringify(r.id) + ')">Del</button></td></tr>';
      }).join('')
    : '<tr><td colspan="7">' + emptyState('📨', 'No referrals yet', 'Referrals will appear here.', '+ New referral', 'openAddR()') + '</td></tr>';
}

// ── Partner referrals ────────────────────────────────────────
function getPartnerLink() {
  const base = window.location.origin + window.location.pathname.replace('app.html', '') + 'partner.html';
  return orgId ? base + '?org=' + orgId : base + '?org=YOUR_ORG_ID';
}

function generateQR(url) {
  const canvas = $('qr-canvas'); if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const size = 140;
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { ctx.drawImage(img, 0, 0, size, size); };
  img.onerror = () => {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#1F6F6D'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('QR Code', size / 2, size / 2);
  };
  img.src = 'https://api.qrserver.com/v1/create-qr-code/?size=' + size + 'x' + size + '&data=' + encodeURIComponent(url) + '&color=1F6F6D&bgcolor=ffffff';
}

function initPartnerPortal() {
  const link = getPartnerLink();
  const el = $('partner-link-display');
  if (el) el.textContent = link;
  generateQR(link);
  const orgName = (currentOrg && currentOrg.name) || 'our organisation';
  const tpl = 'Subject: Referral portal access — ' + orgName + '\n\nDear colleague,\n\nWe use Civara to manage referrals. Please use the link below to register and submit referrals.\n\n' + link + '\n\nKind regards,\n' + orgName;
  const tplEl = $('email-tpl-body');
  if (tplEl) tplEl.textContent = tpl;
}

function copyPartnerLink() {
  const link = getPartnerLink();
  navigator.clipboard.writeText(link);
  const btn = $('copy-link-btn');
  if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = '📋 Copy', 2000); }
}

function toggleEmailTemplate() {
  const el = $('email-template'); const btn = $('email-tpl-btn');
  if (!el) return;
  const open = el.style.display === 'none';
  el.style.display = open ? 'block' : 'none';
  if (btn) btn.textContent = open ? '✉️ Hide email template' : '✉️ Show email template to send to partners';
}

function copyEmailTemplate() {
  const text = ($('email-tpl-body') && $('email-tpl-body').textContent) || '';
  navigator.clipboard.writeText(text);
}

function downloadQR() {
  const canvas = $('qr-canvas'); if (!canvas) return;
  const link = document.createElement('a');
  link.download = ((currentOrg && currentOrg.name) || 'Civara') + '-partner-portal-QR.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
}

function sharePartnerLink() {
  const link = getPartnerLink();
  if (navigator.share) {
    navigator.share({ title: 'Partner Portal', url: link });
  } else {
    copyPartnerLink();
    alert('Link copied — paste it into email or WhatsApp.');
  }
}

function printPartnerCard() { window.print(); }

function renderPartnerRefs() {
  const urg = { Urgent: 'b-flag', Crisis: 'b-flag', Standard: 'b-prospect' };
  const urgent = DB.partner_referrals.filter(r =>
    (r.urgency === 'Urgent' || r.urgency === 'Crisis') && r.status !== 'Converted'
  );
  $('pref-alerts').innerHTML = urgent.length
    ? '<div class="alert alert-warn">⚠ ' + urgent.length + ' urgent partner referral(s)</div>'
    : '';
  $('pref-table').innerHTML = DB.partner_referrals.length
    ? DB.partner_referrals.map(r => {
        const isConverted = r.status === 'Converted';
        return '<tr><td class="cn">' + escapeHTML(r.first_name + ' ' + r.last_name) + '</td>' +
          '<td style="font-size:12px">' + escapeHTML(r.partner_name || '—') + '</td>' +
          '<td style="font-size:12px">' + escapeHTML(r.primary_need || '—') + '</td>' +
          '<td><span class="badge ' + (urg[r.urgency] || 'b-prospect') + '">' + escapeHTML(r.urgency) + '</span></td>' +
          '<td>' + (r.safeguarding ? '<span class="safe-flag">🔐 ' + escapeHTML(r.safeguarding) + '</span>' : '—') + '</td>' +
          '<td style="font-size:12px">' + fmtD(r.created_at) + '</td>' +
          '<td><span class="badge ' + (isConverted ? 'b-active' : 'b-ref') + '">' + escapeHTML(r.status) + '</span></td>' +
          '<td>' + (isConverted
            ? '<span style="font-size:11px;color:var(--txt3)">✓ Converted</span>'
            : '<button class="btn btn-ghost btn-sm" onclick="convertToParticipant(' + JSON.stringify(r.id) + ')">→ Convert</button>') +
          '</td></tr>';
      }).join('')
    : '<tr><td colspan="8">' + emptyState('🤝', 'No partner referrals yet', 'Referrals from the partner portal will appear here.', '', '') + '</td></tr>';
}

// ── Events ───────────────────────────────────────────────────
function renderEvents() {
  const tf = ($('ev-filter-type') || {}).value || '';
  const evs = DB.events.filter(e => !tf || e.type === tf).sort((a, b) => new Date(b.date) - new Date(a.date));
  const totalP = DB.events.reduce((a, e) => a + num(e.attendees), 0);
  $('ev-sub').textContent = DB.events.length + ' events · ' + totalP.toLocaleString() + ' participants';
  $('ev-stats').innerHTML = [
    { l: 'Total participants', v: totalP.toLocaleString() },
    { l: 'Green Skills', v: DB.events.filter(e => e.type === 'Green Skills').length },
    { l: 'Wellbeing',    v: DB.events.filter(e => e.type === 'Wellbeing').length },
    { l: 'Feedback',     v: DB.feedback.length }
  ].map(s => '<div class="stat-card"><div class="stat-lbl">' + s.l + '</div><div class="stat-val">' + s.v + '</div></div>').join('');

  const tCls = { 'Green Skills': 'b-active', 'Wellbeing': 'b-teal', 'Community Event': 'b-vol', 'Frailty': 'b-part', 'Other': 'b-engaged' };
  $('ev-list').innerHTML = evs.length
    ? evs.map(ev => {
        const fb = DB.feedback.filter(f => f.eventId == ev.id);
        const fill = Math.round(num(ev.attendees) / (num(ev.capacity) || 1) * 100);
        return '<div class="ev-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">' +
            '<div><div style="font-size:15px;font-weight:600;color:var(--txt)">' + escapeHTML(ev.name) + '</div>' +
            '<div style="font-size:12px;color:var(--txt3)">' + fmtD(ev.date) + ' · ' + escapeHTML(ev.location || '—') + '</div></div>' +
            '<div style="text-align:right"><div style="font-size:26px;font-weight:800;color:var(--em)">' + num(ev.attendees).toLocaleString() + '</div><div style="font-size:11px;color:var(--txt3);font-weight:600">participants</div></div>' +
          '</div>' +
          '<div class="fund-bar-wrap">' +
            '<div class="fund-top"><span style="font-size:11px;color:var(--txt3)">Capacity ' + ev.attendees + '/' + ev.capacity + '</span><span style="font-size:11px;color:var(--txt3)">' + fill + '%</span></div>' +
            '<div class="fund-track"><div class="fund-fill ' + (fill > 90 ? 'warn' : '') + '" style="width:' + Math.min(fill, 100) + '%"></div></div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">' +
            '<span class="badge ' + (tCls[ev.type] || 'b-engaged') + '">' + escapeHTML(ev.type) + '</span>' +
            (fb.length ? '<span class="badge b-part">' + fb.length + ' feedback</span>' : '') +
            '<div style="margin-left:auto;display:flex;gap:4px">' +
              '<button class="btn btn-ghost btn-sm" onclick="openEditEv(' + JSON.stringify(ev.id) + ')">Edit</button>' +
              '<button class="btn btn-danger btn-sm" onclick="deleteEv(' + JSON.stringify(ev.id) + ')">Delete</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('')
    : emptyState('📅', 'No events yet', 'Create your first workshop.', '+ Create event', 'openAddEv()');
  populateFbEvSelect();
}

function populateFbEvSelect() {
  [$('fb-filter-ev'), $('fbf-ev')].forEach(sel => {
    if (!sel) return;
    const cur = sel.value;
    sel.innerHTML = '<option value="">All events</option>';
    DB.events.forEach(e => {
      const o = document.createElement('option');
      o.value = e.id; o.textContent = e.name;
      if (cur == e.id) o.selected = true;
      sel.appendChild(o);
    });
  });
}

// ── Feedback ─────────────────────────────────────────────────
function renderFeedback() {
  const ef = parseInt(($('fb-filter-ev') || {}).value) || 0;
  const items = DB.feedback.filter(f => !ef || f.eventId == ef);
  const enjoyed = pct(items.filter(f => f.enjoyed >= 4).length, items.length || 1);
  const avgCB = items.length ? (items.reduce((a, f) => a + num(f.cb), 0) / items.length).toFixed(1) : '-';
  const avgCA = items.length ? (items.reduce((a, f) => a + num(f.ca), 0) / items.length).toFixed(1) : '-';
  $('fb-sub').textContent = DB.feedback.length + ' responses';
  $('fb-stats').innerHTML = [
    { l: 'Responses', v: items.length },
    { l: 'Enjoyed (4–5★)', v: enjoyed + '%' },
    { l: 'Avg conf before', v: avgCB + '/5' },
    { l: 'Avg conf after',  v: avgCA + '/5' }
  ].map(s => '<div class="stat-card"><div class="stat-lbl">' + s.l + '</div><div class="stat-val">' + s.v + '</div></div>').join('');

  $('fb-list').innerHTML = items.length
    ? items.map(f => {
        const ev = DB.events.find(e => e.id == f.eventId);
        return '<div class="ev-card">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">' +
            '<div><div style="font-size:14px;font-weight:600;color:var(--txt)">' + escapeHTML(f.name || 'Anonymous') + '</div>' +
            '<div style="font-size:12px;color:var(--txt3)">' + escapeHTML((ev && ev.name) || 'Unknown event') + '</div></div>' +
            '<div style="display:flex;gap:12px;align-items:center">' +
              '<div style="text-align:center"><div style="font-size:18px;font-weight:700;color:var(--amber)">' + f.cb + '</div><div style="font-size:10px;color:var(--txt3);font-weight:600">before</div></div>' +
              '<div style="color:var(--txt3)">→</div>' +
              '<div style="text-align:center"><div style="font-size:18px;font-weight:700;color:var(--em)">' + f.ca + '</div><div style="font-size:10px;color:var(--txt3);font-weight:600">after</div></div>' +
              '<button class="btn btn-danger btn-sm" onclick="deleteFb(' + JSON.stringify(f.id) + ')">Del</button>' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">' +
            '<span class="badge ' + (f.enjoyed >= 4 ? 'b-active' : 'b-amber') + '">★ ' + f.enjoyed + '/5</span>' +
            (f.learned   ? '<span class="badge b-teal">Learned</span>' : '') +
            (f.connected ? '<span class="badge b-vol">Connected</span>' : '') +
            (f.friend    ? '<span class="badge b-engaged">New friend</span>' : '') +
          '</div>' +
          (f.quote ? '<div style="font-size:13px;font-style:italic;color:var(--txt2)">"' + escapeHTML(f.quote) + '"</div>' : '') +
        '</div>';
      }).join('')
    : emptyState('💬', 'No feedback yet', 'Collect feedback after events.', '+ Add response', 'openAddFb()');
}

// ── Circular economy ─────────────────────────────────────────
function renderCircular() {
  const items = DB.circular;
  const diverted = items.filter(i => i.status !== 'Beyond repair').reduce((a, i) => a + num(i.weight_kg), 0);
  const co2 = (diverted * 2.5).toFixed(1);
  $('eco-stats').innerHTML = [
    { l: 'Items logged', v: items.length },
    { l: 'Repaired/resold', v: items.filter(i => ['Repaired', 'Resold'].includes(i.status)).length },
    { l: 'Kg diverted', v: diverted.toFixed(1) + 'kg' },
    { l: 'CO₂ saved',  v: co2 + 'kg' }
  ].map(s => '<div class="stat-card"><div class="stat-lbl">' + s.l + '</div><div class="stat-val">' + s.v + '</div></div>').join('');
  $('eco-impact').innerHTML = [
    '♻️ ' + items.filter(i => i.status === 'Resold').length + ' resold',
    '🎁 ' + items.filter(i => i.status === 'Donated').length + ' donated',
    '🌍 ' + co2 + 'kg CO₂ saved'
  ].map(t => '<span style="background:rgba(31,111,109,.08);border:1px solid rgba(31,111,109,.2);border-radius:8px;padding:6px 12px;font-size:13px;color:var(--em);margin:3px;display:inline-flex;font-weight:600">' + t + '</span>').join('');
  const sc = { Collected: 'b-prospect', 'In repair': 'b-engaged', Repaired: 'b-active', Resold: 'b-active', Donated: 'b-vol', 'Beyond repair': 'b-lapsed' };
  $('eco-table').innerHTML = items.length
    ? items.map(i =>
        '<tr><td class="cn">' + escapeHTML(i.name) + '</td>' +
        '<td><span class="badge b-part">' + escapeHTML(i.category) + '</span></td>' +
        '<td style="color:var(--em);font-weight:600">' + i.weight_kg + 'kg</td>' +
        '<td><span class="badge ' + (sc[i.status] || '') + '">' + escapeHTML(i.status) + '</span></td>' +
        '<td style="font-size:12px">' + escapeHTML(i.fixer || '—') + '</td>' +
        '<td><span class="badge ' + (i.outcome ? 'b-active' : 'b-prospect') + '">' + escapeHTML(i.outcome || 'Pending') + '</span></td>' +
        '<td><div style="display:flex;gap:4px">' +
          '<button class="btn btn-ghost btn-sm" onclick="openEditItem(' + JSON.stringify(i.id) + ')">Edit</button>' +
          '<button class="btn btn-danger btn-sm" onclick="deleteItem(' + JSON.stringify(i.id) + ')">Del</button>' +
        '</div></td></tr>'
      ).join('')
    : '<tr><td colspan="7">' + emptyState('♻️', 'No items logged yet', 'Start logging repair café items.', '+ Log item', 'openAddItem()') + '</td></tr>';
}

// ── RAG dashboard ────────────────────────────────────────────
function renderRAG() {
  if (!DB.contracts.length) { $('rag-list').innerHTML = '<div class="alert alert-info">No contracts yet.</div>'; return; }
  $('rag-list').innerHTML = DB.contracts.map(c => {
    const linked = DB.participants.filter(p => toArr(p.contract_ids).includes(String(c.id)));
    const actualStarts = linked.length;
    const actualOutcomes = linked.filter(p => p.outcomes.length > 0).length;
    const ts = num(c.target_starts) || 1, to = num(c.target_outcomes) || 1;
    const sp = Math.round(actualStarts / ts * 100), op = Math.round(actualOutcomes / to * 100);
    const avg = (sp + op) / 2;
    const rag = avg >= 80 ? 'green' : avg >= 50 ? 'amber' : 'red';
    const col = { green: '#1F6F6D', amber: '#F59E0B', red: '#C84545' }[rag];
    const lbl = { green: '🟢 On track', amber: '🟡 At risk', red: '🔴 Underperforming' }[rag];
    const funder = DB.funders.find(f => String(f.id) === String(c.funder_id));
    return '<div class="card" style="border-left:4px solid ' + col + ';margin-bottom:14px">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">' +
        '<div><div style="font-size:15px;font-weight:700;color:var(--txt)">' + escapeHTML(c.name) + '</div>' +
        '<div style="font-size:12px;color:var(--txt3)">' + escapeHTML((funder && funder.name) || c.funder || '—') + ' · £' + num(c.value).toLocaleString() + '</div></div>' +
        '<div style="display:flex;gap:8px;align-items:center">' +
          '<span style="font-size:12px;font-weight:700;color:' + col + '">' + lbl + '</span>' +
          '<button class="btn btn-ai btn-sm" onclick="runRAGExplainer(' + JSON.stringify(c.id) + ',' + JSON.stringify(c.name) + ',' + JSON.stringify((funder && funder.name) || c.funder || '') + ',' + sp + ',' + op + ',' + linked.length + ')">✦ Explain</button>' +
        '</div>' +
      '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px">' +
        '<div class="stat-card"><div class="stat-lbl">Starts</div><div class="stat-val">' + actualStarts + '</div><div class="stat-sub">of ' + (c.target_starts || 0) + '</div></div>' +
        '<div class="stat-card"><div class="stat-lbl">Outcomes</div><div class="stat-val">' + actualOutcomes + '</div><div class="stat-sub">of ' + (c.target_outcomes || 0) + '</div></div>' +
        '<div class="stat-card"><div class="stat-lbl">Starts %</div><div class="stat-val">' + sp + '%</div></div>' +
        '<div class="stat-card"><div class="stat-lbl">Outcomes %</div><div class="stat-val">' + op + '%</div></div>' +
      '</div></div>';
  }).join('');
}

// ── Outcomes ─────────────────────────────────────────────────
function renderOutcomes() {
  const P = DB.participants, tot = P.length;
  const withOutcomes = P.filter(p => p.outcomes.length > 0).length;
  const jobs = P.filter(p => p.outcomes.includes('Employment')).length;
  const sustained = P.filter(p => p.stage === 'Sustained').length;
  $('out-stats').innerHTML = [
    { l: 'Total starts', v: tot },
    { l: 'Positive outcomes', v: withOutcomes, s: pct(withOutcomes, tot || 1) + '% rate' },
    { l: 'Employment', v: jobs, s: pct(jobs, tot || 1) + '% of starts' },
    { l: 'Sustained', v: sustained }
  ].map(s => '<div class="stat-card"><div class="stat-lbl">' + s.l + '</div><div class="stat-val">' + s.v + '</div>' + (s.s ? '<div class="stat-sub">' + s.s + '</div>' : '') + '</div>').join('');

  $('out-by-type').innerHTML = OUT_TYPES.map(t => {
    const c = P.filter(p => p.outcomes.includes(t)).length, p2 = tot ? Math.round(c / tot * 100) : 0;
    return '<div class="fund-bar-wrap"><div class="fund-top"><span style="font-size:13px;color:var(--txt2)">' + t + '</span><span style="font-weight:600;color:var(--em)">' + c + ' (' + p2 + '%)</span></div><div class="fund-track"><div class="fund-fill" style="width:' + p2 + '%"></div></div></div>';
  }).join('');

  $('out-barriers').innerHTML = BARRIERS.map(b => {
    const c = P.filter(p => p.barriers.includes(b)).length, p2 = tot ? Math.round(c / tot * 100) : 0;
    return '<div class="fund-bar-wrap"><div class="fund-top"><span style="font-size:13px;color:var(--txt2)">' + b + '</span><span style="font-weight:600;color:var(--txt)">' + c + '</span></div><div class="fund-track"><div class="fund-fill" style="width:' + p2 + '%"></div></div></div>';
  }).join('');

  const stageEl = $('out-stage-breakdown');
  if (stageEl) {
    stageEl.innerHTML = P_STAGES.map(s => {
      const c = P.filter(p => p.stage === s).length, p2 = tot ? Math.round(c / tot * 100) : 0;
      return '<div class="fund-bar-wrap"><div class="fund-top"><span style="font-size:13px;color:var(--txt2)">' + s + '</span><span style="font-weight:600;color:var(--em)">' + c + '</span></div><div class="fund-track"><div class="fund-fill" style="width:' + p2 + '%"></div></div></div>';
    }).join('');
  }

  const FB = DB.feedback;
  const avgCB = FB.length ? (FB.reduce((a, f) => a + num(f.cb), 0) / FB.length).toFixed(1) : '-';
  const avgCA = FB.length ? (FB.reduce((a, f) => a + num(f.ca), 0) / FB.length).toFixed(1) : '-';
  const confEl = $('out-confidence');
  if (confEl) {
    confEl.innerHTML = '<div style="display:flex;gap:20px;align-items:center;padding:8px 0">' +
      '<div style="text-align:center"><div style="font-size:36px;font-weight:800;color:var(--amber)">' + avgCB + '</div><div style="font-size:11px;color:var(--txt3);font-weight:600">avg before</div></div>' +
      '<div style="font-size:22px;color:var(--txt3)">→</div>' +
      '<div style="text-align:center"><div style="font-size:36px;font-weight:800;color:var(--em)">' + avgCA + '</div><div style="font-size:11px;color:var(--txt3);font-weight:600">avg after</div></div>' +
      '</div>';
  }
}

// ── Funders ──────────────────────────────────────────────────
function renderFunders() {
  const funders = DB.funders || [];
  $('funders-sub').textContent = funders.length + ' funder' + (funders.length !== 1 ? 's' : '');
  if (!funders.length) {
    $('funders-list').innerHTML = emptyState('🏦', 'No funders yet', 'Add your funders first.', '+ Add funder', 'openAddFunder()');
    return;
  }
  $('funders-list').innerHTML = funders.map(f => {
    const ft = FUNDER_TYPES[f.type] || FUNDER_TYPES.other;
    const contracts = (DB.contracts || []).filter(c => String(c.funder_id) === String(f.id));
    return '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px">' +
        '<div style="display:flex;gap:12px;align-items:center"><div style="font-size:28px">' + ft.icon + '</div>' +
        '<div><div style="font-size:15px;font-weight:700;color:var(--txt)">' + escapeHTML(f.name) + '</div>' +
        '<div style="font-size:12px;color:var(--txt3)">' + ft.label + '</div></div></div>' +
        '<div style="display:flex;gap:6px">' +
          '<button class="btn btn-ghost btn-sm" onclick="openEditFunder(' + JSON.stringify(f.id) + ')">Edit</button>' +
          '<button class="btn btn-danger btn-sm" onclick="deleteFunder(' + JSON.stringify(f.id) + ')">Del</button>' +
        '</div>' +
      '</div>' +
      (f.contact_name ? '<div style="font-size:12px;color:var(--txt3)">' + escapeHTML(f.contact_name) + (f.contact_email ? ' · ' + escapeHTML(f.contact_email) : '') + '</div>' : '') +
      '<div style="margin-top:8px;display:flex;gap:6px"><button class="btn btn-ghost btn-sm" onclick="openAddCon(' + JSON.stringify(f.id) + ')">+ Add contract</button></div>' +
      (contracts.length ? '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">' + contracts.map(c => '<span class="badge b-part">' + escapeHTML(c.name) + '</span>').join('') + '</div>' : '') +
    '</div>';
  }).join('');
}

// ── Funding (contracts) ──────────────────────────────────────
function renderFunding() {
  $('fund-sub').textContent = DB.contracts.length + ' contracts · £' + DB.contracts.reduce((a, c) => a + num(c.value), 0).toLocaleString() + ' total';
  if (!DB.contracts.length) {
    $('fund-list').innerHTML = emptyState('💰', 'No contracts yet', 'Add a funder first.', '+ Add contract', 'openAddCon()');
    return;
  }
  $('fund-list').innerHTML = DB.contracts.map(c => {
    const linked = DB.participants.filter(p => toArr(p.contract_ids).includes(String(c.id)));
    const starts = linked.length, outcomes = linked.filter(p => p.outcomes.length > 0).length;
    const sp = Math.round(starts / (c.target_starts || 1) * 100), op = Math.round(outcomes / (c.target_outcomes || 1) * 100);
    return '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px">' +
        '<div><div style="font-size:14px;font-weight:600;color:var(--txt)">' + escapeHTML(c.name) + '</div>' +
        '<div style="font-size:12px;color:var(--txt3)">' + escapeHTML(c.funder || '—') + ' · £' + num(c.value).toLocaleString() + '</div></div>' +
        '<div style="display:flex;gap:6px">' +
          '<button class="btn btn-ghost btn-sm" onclick="openEditCon(' + JSON.stringify(c.id) + ')">Edit</button>' +
          '<button class="btn btn-danger btn-sm" onclick="deleteCon(' + JSON.stringify(c.id) + ')">Del</button>' +
        '</div>' +
      '</div>' +
      '<div class="fund-bar-wrap"><div class="fund-top"><span>Starts: ' + starts + '/' + (c.target_starts || 0) + '</span><span>' + sp + '%</span></div><div class="fund-track"><div class="fund-fill" style="width:' + Math.min(sp, 100) + '%"></div></div></div>' +
      '<div class="fund-bar-wrap"><div class="fund-top"><span>Outcomes: ' + outcomes + '/' + (c.target_outcomes || 0) + '</span><span>' + op + '%</span></div><div class="fund-track"><div class="fund-fill" style="width:' + Math.min(op, 100) + '%"></div></div></div>' +
    '</div>';
  }).join('');
}

// ── Reports list ─────────────────────────────────────────────
function renderReports() {
  const contracts = DB.contracts || [];
  const el = $('reports-contract-list'); if (!el) return;
  if (!contracts.length) {
    el.innerHTML = '<div class="alert alert-info">No contracts yet. Add a funder and contract first.</div>';
    return;
  }
  el.innerHTML = contracts.map(c => {
    const funder = (DB.funders || []).find(f => String(f.id) === String(c.funder_id));
    const linked = DB.participants.filter(p => toArr(p.contract_ids).includes(String(c.id)));
    return '<div class="card">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px">' +
        '<div><div style="font-size:14px;font-weight:700;color:var(--txt)">' + escapeHTML(c.name) + '</div>' +
        '<div style="font-size:12px;color:var(--txt3)">' + escapeHTML((funder && funder.name) || '—') + ' · £' + num(c.value).toLocaleString() + ' · ' + linked.length + ' participants</div></div>' +
        '<button class="btn btn-ai btn-sm" onclick="generateAIReport(' + JSON.stringify(c.report_type || 'other') + ',' + JSON.stringify(c.id) + ')">✦ Generate report</button>' +
      '</div></div>';
  }).join('');
}

// ── Evidence ─────────────────────────────────────────────────
function renderEvidence() {
  $('evid-table').innerHTML = DB.evidence.length
    ? DB.evidence.map(e =>
        '<tr><td class="cn">' + escapeHTML(e.participant_name) + '</td>' +
        '<td><span class="badge b-vol">' + escapeHTML(e.type) + '</span></td>' +
        '<td><span class="badge b-active">' + escapeHTML(e.linked_outcome) + '</span></td>' +
        '<td style="font-size:12px">' + escapeHTML(e.staff || '—') + '</td>' +
        '<td style="font-size:12px">' + fmtD(e.evidence_date) + '</td>' +
        '<td><span class="badge b-prospect">' + escapeHTML(e.status) + '</span></td>' +
        '<td><button class="btn btn-danger btn-sm" onclick="deleteEvid(' + JSON.stringify(e.id) + ')">Del</button></td></tr>'
      ).join('')
    : '<tr><td colspan="7">' + emptyState('🗂️', 'No evidence yet', 'Upload payslips and certificates.', '+ Upload evidence', 'openAddEvid()') + '</td></tr>';
}

// ── Safeguarding ─────────────────────────────────────────────
function renderSafeguarding() {
  const fl = DB.participants.filter(p => p.safeguarding);
  $('safe-flags').innerHTML = fl.length
    ? fl.map(p =>
        '<div class="tl-entry"><div class="tl-dot red"></div>' +
        '<div><div class="tl-lbl">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
        '<div class="tl-meta">' + escapeHTML(p.safeguarding) + ' · ' + escapeHTML(p.advisor) + '</div></div></div>'
      ).join('')
    : '<div style="color:var(--txt3);font-size:13px">No flagged cases.</div>';
  $('consent-list').innerHTML = DB.participants.length
    ? DB.participants.map(p =>
        '<div class="tl-entry"><div class="tl-dot blue"></div>' +
        '<div><div class="tl-lbl">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
        '<div class="tl-meta">Consent: ' + (toArr(p.notes).length ? 'Recorded' : 'Pending') + '</div></div></div>'
      ).join('')
    : '<div style="color:var(--txt3);font-size:13px">No participants yet.</div>';
}

// ── Settings ─────────────────────────────────────────────────
const _modState = {};

function renderSettings() {
  if (!currentOrg) return;
  const m = currentOrg.modules || {};
  if ($('set-name'))   $('set-name').value   = currentOrg.name || '';
  if ($('set-sector')) try { $('set-sector').value = currentOrg.sector || 'Charity / VCSE'; } catch (e) { /* ignore */ }
  if ($('set-plan'))   $('set-plan').textContent = currentOrg.plan === 'pro' ? 'Pro ✦'
                                                  : currentOrg.plan === 'network' ? 'Network'
                                                  : currentOrg.plan === 'starter' ? 'Starter'
                                                  : 'Free';
  if ($('set-status')) $('set-status').textContent = currentOrg.status || 'active';

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
  const btn = $('set-save-btn'); btn.textContent = 'Saving…'; btn.disabled = true;
  try {
    const mods = {};
    SET_MODULES.forEach(mod => mods[mod.k] = _modState[mod.k] != null ? _modState[mod.k] : true);
    const d = { name: $('set-name').value, sector: $('set-sector').value, modules: mods };
    await sbUpdate('organisations', d, orgId);
    currentOrg = Object.assign({}, currentOrg, d);
    applyModules(mods);
    if ($('ob-txt')) $('ob-txt').textContent = currentOrg.name;
    $('set-save-msg').style.display = 'flex';
    setTimeout(() => $('set-save-msg').style.display = 'none', 3000);
  } catch (e) {
    alert('Save failed: ' + e.message);
  } finally {
    btn.textContent = 'Save settings'; btn.disabled = false;
  }
}

// ── HR page ──────────────────────────────────────────────────
function renderHR() {
  const savedMode = safeStorage.get('hr_mode') || 'advisory';
  const radio = document.querySelector('input[name="hr-mode"][value="' + savedMode + '"]');
  if (radio) radio.checked = true;
  const savedEmail = safeStorage.get('hr_manager_email') || '';
  if ($('hr-manager-email')) $('hr-manager-email').value = savedEmail;
  updateHRModeBanner();
  renderHRFlags();
  renderEqMonitoringList();
}

function switchHRTab(tab, btn) {
  ['flags', 'equity', 'monitoring', 'wellbeing', 'benchmark', 'settings'].forEach(t => {
    const el = $('hr-tab-' + t);
    if (el) el.style.display = t === tab ? 'block' : 'none';
  });
  document.querySelectorAll('#page-hr .vtab-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
}

// Equality monitoring list (used by the HR tab)
function renderEqMonitoringList() {
  const el = $('eq-monitoring-list'); if (!el) return;
  const badge = $('eq-completion-badge');
  const P = DB.participants;
  if (!P.length) {
    el.innerHTML = emptyState('📋', 'No participants yet', 'Equality monitoring will appear once participants are added.', '', '');
    if (badge) badge.textContent = '';
    return;
  }
  const completed = P.filter(p => p.equality_data && Object.keys(p.equality_data).length > 0).length;
  if (badge) badge.textContent = completed + ' of ' + P.length + ' completed (' + pct(completed, P.length) + '%)';
  el.innerHTML = P.map(p => {
    const has = p.equality_data && Object.keys(p.equality_data).length > 0;
    return '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px 14px;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center">' +
      '<div><div style="font-size:13px;font-weight:600;color:var(--txt)">' + escapeHTML(p.first_name + ' ' + p.last_name) + '</div>' +
      '<div style="font-size:11px;color:var(--txt3)">' + (has ? '✓ Completed' : 'Not yet recorded') + '</div></div>' +
      '<button class="btn btn-ghost btn-sm" onclick="openEqualityModal(' + JSON.stringify(p.id) + ')">' + (has ? 'Edit' : '+ Add data') + '</button>' +
      '</div>';
  }).join('');
}

// ── Refresh helper ───────────────────────────────────────────
async function refresh() {
  await syncAll();
  const active = document.querySelector('.page.active');
  if (active) go(active.id.replace('page-', ''));
}

// ── Upgrade prompt ───────────────────────────────────────────
function showUpgradeModal() {
  alert('Contact hello@civara.co.uk to upgrade.');
}
