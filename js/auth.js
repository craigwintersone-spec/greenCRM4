// js/auth.js — session, role-based access, organisation switching
// Depends on: config.js, utils.js, db.js
//
// Responsibilities:
//   • work out who the user is
//   • work out which organisations they can access
//   • work out their role in the active org
//   • render the org switcher and role badge in the header
//   • sign out

'use strict';

// ── Sign out ──────────────────────────────────────────────────
async function signOut() {
  if (sb) await sb.auth.signOut();
  window.location.href = 'index.html';
}

// ── Load access info for the current user ────────────────────
//
// Sets the following globals (defined in db.js):
//   - currentUser         (Supabase user object)
//   - isSuperAdmin        (true if listed in super_admins)
//   - userMemberships     (array of { org_id, role, status, org_name })
//   - orgId               (the active org)
//   - currentRole         (role in the active org)
async function loadUserAccess() {
  if (!sb || !currentUser) return;

  // Super admin?
  try {
    const sa = await sb.from('super_admins')
      .select('user_id')
      .eq('user_id', currentUser.id)
      .maybeSingle();
    isSuperAdmin = !!sa.data;
  } catch (e) {
    isSuperAdmin = false;
  }

  // Memberships
  try {
    const memRes = await sb.from('memberships')
      .select('org_id,role,status')
      .eq('user_id', currentUser.id)
      .eq('status', 'active');
    const memOrgIds = (memRes.data || []).map(m => m.org_id);
    let memOrgs = [];
    if (memOrgIds.length) {
      const r = await sb.from('organisations')
        .select('id,name')
        .in('id', memOrgIds);
      memOrgs = r.data || [];
    }
    userMemberships = (memRes.data || []).map(m => {
      const o = memOrgs.find(x => x.id === m.org_id);
      return {
        org_id: m.org_id,
        role: m.role,
        status: m.status,
        org_name: (o && o.name) || 'Unnamed org'
      };
    });
  } catch (e) {
    userMemberships = [];
  }

  // Super admin sees every org in the org switcher
  if (isSuperAdmin) {
    try {
      const r = await sb.from('organisations').select('id,name').order('name');
      window._allOrgsForSuperAdmin = r.data || [];
    } catch (e) {
      window._allOrgsForSuperAdmin = [];
    }
  }

  // Decide which org we're working in
  const urlOrg = new URLSearchParams(window.location.search).get('org_id');
  if (urlOrg) {
    orgId = urlOrg;
    const m = userMemberships.find(x => x.org_id === orgId);
    if (m) currentRole = m.role;
    else if (isSuperAdmin) currentRole = 'super_admin';
  } else if (userMemberships.length > 0) {
    orgId = userMemberships[0].org_id;
    currentRole = userMemberships[0].role;
  } else if (isSuperAdmin && window._allOrgsForSuperAdmin && window._allOrgsForSuperAdmin.length) {
    orgId = window._allOrgsForSuperAdmin[0].id;
    currentRole = 'super_admin';
  }
}

// ── Org switcher (in the top banner) ─────────────────────────
function renderOrgSwitcher() {
  let orgList = [];

  if (isSuperAdmin && window._allOrgsForSuperAdmin && window._allOrgsForSuperAdmin.length) {
    orgList = window._allOrgsForSuperAdmin.map(o => {
      const m = userMemberships.find(x => x.org_id === o.id);
      return {
        org_id: o.id,
        org_name: o.name,
        role: m ? m.role : 'super_admin'
      };
    });
  } else {
    orgList = userMemberships;
  }

  if (orgList.length < 2 && !isSuperAdmin) return;
  if (orgList.length === 0) return;

  const obTxt = $('ob-txt');
  if (!obTxt) return;

  const existing = $('org-switcher-wrap');
  if (existing) existing.remove();

  const opts = orgList.map(o =>
    '<option value="' + escapeHTML(o.org_id) + '"' +
    (o.org_id === orgId ? ' selected' : '') + '>' +
    escapeHTML(o.org_name) + ' · ' + escapeHTML(o.role) +
    '</option>'
  ).join('');

  const switcher = document.createElement('span');
  switcher.id = 'org-switcher-wrap';
  switcher.style.cssText = 'display:inline-flex;align-items:center;gap:6px;margin-left:14px';
  switcher.innerHTML =
    '<label style="font-size:10px;color:rgba(255,255,255,.85);text-transform:uppercase;letter-spacing:.5px;margin:0;font-weight:700">Switch:</label>' +
    '<select id="org-switcher" onchange="switchOrg(this.value)" ' +
    'style="background:rgba(0,0,0,.2);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:6px;padding:3px 8px;font-size:12px;cursor:pointer;font-family:inherit;width:auto;max-width:240px">' +
    opts + '</select>';

  obTxt.parentNode.insertBefore(switcher, obTxt.nextSibling);
}

function switchOrg(newOrgId) {
  if (newOrgId === orgId) return;
  window.location.href = 'app.html?org_id=' + encodeURIComponent(newOrgId);
}

// ── Role badge in sidebar ─────────────────────────────────────
function showRoleBadge() {
  const slot = $('role-badge-slot');
  if (!slot || !currentRole) return;

  const labels = {
    manager:     { txt: '👑 Manager',     col: '#1F6F6D' },
    advisor:     { txt: '👤 Advisor',     col: '#3B82F6' },
    admin:       { txt: '⚙️ Admin',       col: '#7C5BCB' },
    super_admin: { txt: '🛡️ Super Admin', col: '#F59E0B' }
  };
  const cfg = labels[currentRole] || { txt: currentRole, col: 'var(--txt3)' };
  slot.innerHTML = '<div class="role-badge-sb" style="color:' + cfg.col + '">' +
                   escapeHTML(cfg.txt) + '</div>';
}
