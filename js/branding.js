// js/branding.js — first-login branding modal + applying brand to UI
// Depends on: config.js, utils.js, db.js
//
// Responsibilities:
//   • read logo + brand colour from currentOrg, apply them to UI
//   • show the branding modal on first login (manager/admin only)
//   • upload logo to Supabase storage
//   • save branding choices

'use strict';

let _selectedLogoFile = null;
let _selectedColour   = '#1F6F6D';

// ── Helpers ──────────────────────────────────────────────────
function getOrgLogoUrl(org) {
  if (!org) return '';
  return org.logo_url || org.logo || org.branding_logo || org.brand_logo || '';
}

// Apply the brand to the running UI (sidebar logo, banner, accent colour, page title)
function applyBranding(org) {
  if (!org) return;
  const primary = org.brand_color || '#1F6F6D';
  const orgName = org.name || 'Civara';

  document.documentElement.style.setProperty('--em', primary);
  document.title = orgName + ' · Civara';

  const logoUrl = getOrgLogoUrl(org);

  // Sidebar logo
  const logoEl = document.querySelector('#sidebar .sidebar-logo');
  if (logoEl) {
    if (logoUrl) {
      logoEl.innerHTML =
        '<img src="' + escapeHTML(logoUrl) + '" alt="' + escapeHTML(orgName) +
        '" class="org-logo-sidebar" onerror="this.parentElement.innerHTML=\'<img src=&quot;logo.png&quot; alt=&quot;Civara&quot; style=&quot;height:34px&quot;/>\'"/>';
    } else {
      logoEl.innerHTML = '<img src="logo.png" alt="Civara" style="height:34px;width:auto;display:block"/>';
    }
  }

  // Org banner logo (top of page)
  const obTxt = $('ob-txt');
  if (obTxt && logoUrl) {
    let bannerLogo = $('ob-logo');
    if (!bannerLogo) {
      bannerLogo = document.createElement('img');
      bannerLogo.id = 'ob-logo';
      bannerLogo.className = 'org-logo-banner';
      bannerLogo.alt = orgName;
      obTxt.parentNode.insertBefore(bannerLogo, obTxt);
    }
    bannerLogo.src = logoUrl;
    bannerLogo.onerror = function () { this.style.display = 'none'; };
  }
}

// ── Brand colour picker ──────────────────────────────────────
function renderColourSwatches() {
  const wrap = $('brand-color-swatches'); if (!wrap) return;
  wrap.innerHTML = BRAND_COLOURS.map(c =>
    '<div class="brand-swatch' + (c.hex === _selectedColour ? ' selected' : '') +
    '" style="background:' + c.hex + '" title="' + escapeHTML(c.name) +
    '" onclick="pickColour(\'' + c.hex + '\')"></div>'
  ).join('');
}

function pickColour(hex) {
  _selectedColour = hex;
  $('brand-color-hex').value = hex;
  $('brand-color-preview').style.background = hex;
  renderColourSwatches();
}

function onHexInput(v) {
  v = v.trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(v)) {
    _selectedColour = v;
    $('brand-color-preview').style.background = v;
    renderColourSwatches();
  }
}

// ── Logo file picker ─────────────────────────────────────────
function handleLogoSelect(ev) {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) {
    $('logo-upload-status').textContent = '⚠ File too large — max 2MB';
    $('logo-upload-status').style.color = 'var(--red)';
    _selectedLogoFile = null;
    return;
  }
  _selectedLogoFile = file;
  const reader = new FileReader();
  reader.onload = e => {
    $('logo-preview').innerHTML =
      '<img src="' + e.target.result + '" style="max-width:100%;max-height:100%;object-fit:contain"/>';
  };
  reader.readAsDataURL(file);
  $('logo-upload-status').textContent = '✓ ' + file.name + ' ready';
  $('logo-upload-status').style.color = 'var(--em)';
}

function showBrandingError(msg) {
  const el = $('branding-error');
  el.textContent = msg;
  el.style.display = 'flex';
}
function hideBrandingError() { $('branding-error').style.display = 'none'; }

// ── Save / skip ──────────────────────────────────────────────
async function saveBranding() {
  hideBrandingError();
  const btn = $('branding-save-btn');
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    let logoUrl = (currentOrg && currentOrg.logo_url) || null;

    if (_selectedLogoFile) {
      const ext = _selectedLogoFile.name.split('.').pop().toLowerCase();
      const path = orgId + '/logo-' + Date.now() + '.' + ext;
      const { error: upErr } = await sb.storage.from('org-logos').upload(path, _selectedLogoFile, {
        cacheControl: '3600',
        upsert: false
      });
      if (upErr) throw new Error('Upload failed: ' + upErr.message);
      const { data: urlData } = sb.storage.from('org-logos').getPublicUrl(path);
      logoUrl = urlData.publicUrl;
    }

    const newSettings = Object.assign({}, (currentOrg && currentOrg.settings) || {}, { branding_completed: true });
    const { error: updErr } = await sb.from('organisations').update({
      logo_url: logoUrl,
      brand_color: _selectedColour,
      settings: newSettings
    }).eq('id', orgId);
    if (updErr) throw new Error('Save failed: ' + updErr.message);

    currentOrg = Object.assign({}, currentOrg, {
      logo_url: logoUrl,
      brand_color: _selectedColour,
      settings: newSettings
    });
    applyBranding(currentOrg);
    closeModal('modal-branding');
  } catch (e) {
    showBrandingError(e.message);
  } finally {
    btn.textContent = 'Save and continue';
    btn.disabled = false;
  }
}

async function skipBranding() {
  try {
    const newSettings = Object.assign({}, (currentOrg && currentOrg.settings) || {}, { branding_completed: true });
    await sb.from('organisations').update({ settings: newSettings }).eq('id', orgId);
    currentOrg = Object.assign({}, currentOrg, { settings: newSettings });
  } catch (e) {
    console.warn('Could not mark branding skipped:', e);
  }
  closeModal('modal-branding');
}

// ── Show on first login ──────────────────────────────────────
function maybeShowBrandingModal() {
  if (!currentOrg) return;
  if (currentRole !== 'manager' && currentRole !== 'admin' && !isSuperAdmin) return;
  if (currentOrg.settings && currentOrg.settings.branding_completed) return;

  _selectedLogoFile = null;
  _selectedColour = currentOrg.brand_color || '#1F6F6D';
  $('brand-color-hex').value = _selectedColour;
  $('brand-color-preview').style.background = _selectedColour;
  if (currentOrg.logo_url) {
    $('logo-preview').innerHTML =
      '<img src="' + escapeHTML(currentOrg.logo_url) + '" style="max-width:100%;max-height:100%;object-fit:contain"/>';
  }
  renderColourSwatches();
  hideBrandingError();
  $('logo-upload-status').textContent = '';
  $('modal-branding').classList.add('open');
}
