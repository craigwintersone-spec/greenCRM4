// js/boot.js — entry point. Loaded last. Calls everything else.
// Depends on: every other file
//
// Boot sequence:
//   1. Initialise Supabase client
//   2. Get the user session (or redirect to login)
//   3. Load RBAC: super-admin status, memberships, current org/role
//   4. Load org details, apply branding + module visibility
//   5. Pull all data tables
//   6. Restore demo mode if it was on
//   7. Show the dashboard
//   8. Maybe show the first-login branding modal

'use strict';

async function refreshDashboard() {
  // Wired to the dashboard's ↻ Refresh button.
  // Re-pulls data, then triggers the morning briefing.
  await syncAll();
  go('dashboard');
  if (DB.participants.length || DB.events.length) {
    runMorningBriefing();
  }
}

async function boot() {
  // 1. Supabase
  initSB();
  if (sb) {
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      const orgParam = new URLSearchParams(window.location.search).get('org_id');
      window.location.href = 'login.html' + (orgParam ? '?org_id=' + orgParam : '');
      return;
    }
    currentUser = session.user;
  }

  // 2. RBAC
  try { await loadUserAccess(); } catch (e) { console.warn('RBAC load failed:', e); }
  if (!orgId) {
    const urlOrg = new URLSearchParams(window.location.search).get('org_id');
    if (urlOrg) orgId = urlOrg;
  }
  if (sb && currentUser && !orgId) {
    const { data: profile } = await sb.from('profiles').select('*').eq('id', currentUser.id).maybeSingle();
    if (profile && profile.org_id) orgId = profile.org_id;
  }

  // 3. Org
  if (orgId && sb) {
    const { data: orgData } = await sb.from('organisations').select('*').eq('id', orgId).maybeSingle();
    if (orgData) {
      currentOrg = orgData;
      applyBranding(orgData);
      // Banner
      const b = $('org-banner');
      b.style.display = 'flex';
      $('ob-txt').textContent = orgData.name + (orgData.sector ? ' · ' + orgData.sector : '');
      $('ob-plan').textContent = orgData.plan === 'pro' ? '✦ PRO'
                               : orgData.plan === 'network' ? 'Network'
                               : orgData.plan === 'starter' ? 'Starter'
                               : 'Free';
      applyModules(orgData.modules || {});
    }
  }

  // 4. Pull data
  await syncAll();

  // 5. Demo mode (restore from localStorage)
  if (_demoMode) loadDemoData();
  else applyDemoBanner();

  // 6. Render shell pieces
  renderSettings();
  renderOrgSwitcher();
  showRoleBadge();

  // 7. Upgrade prompt for non-Pro plans
  const plan = (currentOrg && currentOrg.plan) || 'free';
  const wrap = $('upgrade-btn-wrap');
  if (wrap && !['pro', 'network'].includes(plan)) {
    wrap.innerHTML =
      '<button class="btn btn-sm" style="width:100%;margin-bottom:8px;background:linear-gradient(135deg,#5E4CB8,#7C5BCB);color:#fff;border:none" ' +
      'onclick="showUpgradeModal()">✦ Upgrade to Pro</button>';
  }

  // 8. Show dashboard (this is the user's first view)
  go('dashboard');

  // 9. First-login branding modal (manager / admin only)
  maybeShowBrandingModal();
}

// Kick off
boot();
