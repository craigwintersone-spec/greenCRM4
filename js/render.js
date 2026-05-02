// ─────────────────────────────────────────────────────────────
// PATCH for js/render.js
//
// Replace the existing renderSettings() function (and add the new
// helpers below it) with this version. It keeps everything you had
// (modules grid, demo mode card, save button) and inserts a new
// "Branding" card containing the logo uploader and colour picker.
//
// Depends on existing globals from branding.js:
//   _selectedColour, _selectedLogoFile, applyBranding(),
//   pickColour(), onHexInput(), handleLogoSelect(),
//   getOrgLogoUrl(), renderColourSwatches()
//
// And from db.js / auth.js:
//   currentOrg, orgId, sb, sbUpdate(), $(), escapeHTML()
// ─────────────────────────────────────────────────────────────

// ── Settings ─────────────────────────────────────────────────
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

  // ── BRANDING CARD (new) ────────────────────────────────────
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
      // LOGO column
      '<div>' +
        '<label style="display:block;font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:600">Logo</label>' +
        '<div id="set-logo-drop" style="border:2px dashed var(--border);border-radius:10px;background:var(--bg);padding:18px;text-align:center;cursor:pointer" onclick="document.getElementById(\'set-logo-input\').click()">' +
          '<div id="set-logo-preview" style="width:100%;height:100px;display:flex;align-items:center;justify-content:center;background:#fff;border-radius:6px;margin-bottom:10px;overflow:hidden;border:1px solid var(--border)">' +
            (getOrgLogoUrl(currentOrg)
              ? '<img src="' + escapeHTML(getOrgLogoUrl(currentOrg)) + '" style="max-width:100%;max-height:100%;object-fit:contain"/>'
              : '<span style="color:var(--txt3);font-size:13px">No logo yet</span>') +
          '</div>' +
          '<button type="button" class="btn btn-ghost btn-sm" onclick="event.stopPropagation();document.getElementById(\'set-logo-input\').click()">Choose file</button>' +
          '<input type="file" id="set-logo-input" accept="image/png,image/jpeg,image/svg+xml,image/webp" style="display:none" onchange="handleSetLogoSelect(event)"/>' +
          '<div style="font-size:11px;color:var(--txt3);margin-top:6px">PNG, JPG, SVG or WebP · max 2MB</div>' +
          '<div id="set-logo-status" style="font-size:12px;font-weight:600;margin-top:6px;min-height:16px"></div>' +
        '</div>' +
      '</div>' +
      // COLOUR column
      '<div>' +
        '<label style="display:block;font-size:11px;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;font-weight:600">Accent colour</label>' +
        '<div id="set-colour-swatches" style="display:grid;grid-template-columns:repeat(6,1fr);gap:6px"></div>' +
        '<div style="display:flex;align-items:center;gap:10px;margin-top:12px">' +
          '<div id="set-colour-preview" style="width:32px;height:32px;border-radius:6px;border:1px solid var(--border);flex-shrink:0;background:' + (currentOrg.brand_color || '#1F6F6D') + '"></div>' +
          '<input type="text" id="set-colour-hex" placeholder="#1F6F6D" value="' + (currentOrg.brand_color || '#1F6F6D') + '" oninput="onSetHexInput(this.value)" style="max-width:130px"/>' +
        '</div>' +
      '</div>' +
    '</div>';

  // Initialise branding state for this view
  _selectedLogoFile = null;
  _selectedColour = currentOrg.brand_color || '#1F6F6D';
  renderSetSwatches();

  // Demo mode card (unchanged)
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

// ── Settings-page-scoped branding helpers ────────────────────
// (Kept separate from branding.js's modal helpers so the two views
// don't share DOM ids.)

function renderSetSwatches() {
  const wrap = $('set-colour-swatches'); if (!wrap) return;
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

// ── Module toggle (unchanged) ────────────────────────────────
function toggleMod(key) {
  _modState[key] = !_modState[key];
  const track = $('set-mod-track-' + key);
  const thumb = $('set-mod-thumb-' + key);
  const item  = $('set-mod-item-' + key);
  if (track) track.style.background = _modState[key] ? '#1F6F6D' : '#E0DAD0';
  if (thumb) thumb.style.left = _modState[key] ? '23px' : '3px';
  if (item)  item.classList.toggle('on', _modState[key]);
}

// ── Save settings — extended to include branding ─────────────
async function saveSettings() {
  const btn = $('set-save-btn');
  btn.textContent = 'Saving…';
  btn.disabled = true;
  try {
    // 1. Upload new logo if user picked one
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

    // 2. Build modules object
    const mods = {};
    SET_MODULES.forEach(mod => mods[mod.k] = _modState[mod.k] != null ? _modState[mod.k] : true);

    // 3. Build update payload
    const d = {
      name: $('set-name').value,
      sector: $('set-sector').value,
      modules: mods,
      brand_color: _selectedColour,
      logo_url: logoUrl
    };

    await sbUpdate('organisations', d, orgId);
    currentOrg = Object.assign({}, currentOrg, d);

    // 4. Apply changes immediately
    applyModules(mods);
    applyBranding(currentOrg);
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
