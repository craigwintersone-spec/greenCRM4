// js/extensions/partner-portal.js
// ─────────────────────────────────────────────────────────────
// Wires up the "Your partner portal link & QR code" card on the
// Partner Referrals page. The HTML for the card already lives in
// app.html — this file is what makes it actually work.
//
// What it does:
//   1. Loads the qrcode.js library from CDN (once).
//   2. Defines the click handlers that app.html references:
//        copyPartnerLink, downloadQR, sharePartnerLink,
//        printPartnerCard, toggleEmailTemplate, copyEmailTemplate
//   3. Patches renderPartnerRefs so the QR + link render every
//      time the user opens the page. Has to redraw on each visit
//      because the canvas is hidden while the page is hidden,
//      and currentOrg.id only exists after sign-in.
//
// Depends on: auth.js (currentOrg), render.js (renderPartnerRefs),
//             utils.js ($, escapeHTML).
// Loads after: boot.js — same as every other extensions/*.js file.
'use strict';

(function () {

  // ── 1. Load qrcode.js from CDN once ──────────────────────────
  // Using davidshimjs/qrcodejs — small, no deps, draws into a
  // div using either canvas or table fallback. We swap our
  // <canvas> for a <div> at render time so the lib is happy.
  const QR_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
  let _qrLibPromise = null;

  function loadQRLib() {
    if (window.QRCode) return Promise.resolve();
    if (_qrLibPromise) return _qrLibPromise;
    _qrLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = QR_CDN;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        _qrLibPromise = null; // allow retry
        reject(new Error('Could not load QR library'));
      };
      document.head.appendChild(s);
    });
    return _qrLibPromise;
  }

  // ── 2. Build the partner portal URL for the current org ──────
  function getPartnerPortalUrl() {
    if (typeof currentOrg === 'undefined' || !currentOrg || !currentOrg.id) return null;
    // Use the same origin the CRM is served from so it works on
    // localhost, preview deploys and production without changes.
    const base = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
    return base + 'partner.html?org=' + encodeURIComponent(currentOrg.id);
  }

  // ── 3. Render the QR + link into the card ────────────────────
  // Called from the patched renderPartnerRefs below.
  async function renderPartnerPortalCard() {
    const linkEl = document.getElementById('partner-link-display');
    const canvas = document.getElementById('qr-canvas');
    if (!linkEl || !canvas) return; // card not on screen

    const url = getPartnerPortalUrl();
    if (!url) {
      linkEl.textContent = 'Sign in to generate your partner link.';
      return;
    }

    linkEl.textContent = url;

    // qrcode.js wants a <div>, not a <canvas>. Replace the canvas
    // with a div the first time, then clear and redraw on each
    // subsequent visit.
    let qrTarget = document.getElementById('qr-target');
    if (!qrTarget) {
      qrTarget = document.createElement('div');
      qrTarget.id = 'qr-target';
      qrTarget.style.width = '140px';
      qrTarget.style.height = '140px';
      canvas.parentNode.replaceChild(qrTarget, canvas);
    } else {
      qrTarget.innerHTML = '';
    }

    try {
      await loadQRLib();
      // eslint-disable-next-line no-new
      new window.QRCode(qrTarget, {
        text: url,
        width: 140,
        height: 140,
        colorDark: '#1F6F6D',
        colorLight: '#ffffff',
        correctLevel: window.QRCode.CorrectLevel.M
      });
    } catch (e) {
      qrTarget.innerHTML =
        '<div style="font-size:11px;color:var(--red);padding:8px">QR could not load. Check your connection.</div>';
      console.error('[partner-portal] QR generation failed:', e);
    }
  }

  // ── 4. Click handlers referenced by app.html ─────────────────

  window.copyPartnerLink = async function () {
    const url = getPartnerPortalUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      flashBtn('copy-link-btn', '✓ Copied');
    } catch (e) {
      // Fallback for older browsers / non-https contexts
      const ta = document.createElement('textarea');
      ta.value = url;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); flashBtn('copy-link-btn', '✓ Copied'); }
      catch (_) { alert('Copy failed — please copy the link manually.'); }
      document.body.removeChild(ta);
    }
  };

  window.downloadQR = function () {
    const target = document.getElementById('qr-target');
    if (!target) return;
    // qrcode.js renders a <canvas> inside the target on supported
    // browsers, with a fallback <img>. We grab whichever exists.
    const canvas = target.querySelector('canvas');
    const img = target.querySelector('img');
    let dataUrl = null;
    if (canvas) {
      dataUrl = canvas.toDataURL('image/png');
    } else if (img && img.src) {
      dataUrl = img.src;
    }
    if (!dataUrl) {
      alert('QR code not ready yet — please try again in a moment.');
      return;
    }
    const orgName = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name)
      ? currentOrg.name : 'civara';
    const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = 'partner-portal-qr-' + (slug || 'civara') + '.png';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  window.sharePartnerLink = async function () {
    const url = getPartnerPortalUrl();
    if (!url) return;
    const orgName = (currentOrg && currentOrg.name) ? currentOrg.name : 'our team';
    const shareData = {
      title: orgName + ' — Partner Portal',
      text: 'Send referrals to ' + orgName + ' via our secure partner portal:',
      url: url
    };
    if (navigator.share) {
      try { await navigator.share(shareData); }
      catch (e) { /* user cancelled — silent */ }
    } else {
      // Fallback — copy to clipboard
      window.copyPartnerLink();
    }
  };

  window.printPartnerCard = function () {
    const url = getPartnerPortalUrl();
    if (!url) return;
    const orgName = (currentOrg && currentOrg.name) ? escapeHTML(currentOrg.name) : 'Our team';
    const target = document.getElementById('qr-target');
    const canvas = target && target.querySelector('canvas');
    const img = target && target.querySelector('img');
    const qrSrc = canvas ? canvas.toDataURL('image/png') : (img ? img.src : '');

    const w = window.open('', '_blank', 'width=720,height=900');
    if (!w) {
      alert('Pop-up blocked — please allow pop-ups to print the card.');
      return;
    }
    w.document.write(
      '<!doctype html><html><head><title>Referral card — ' + orgName + '</title>' +
      '<style>' +
        '@page{size:A5;margin:14mm}' +
        'body{font-family:system-ui,-apple-system,sans-serif;color:#2B2B2B;margin:0;padding:0}' +
        '.card{border:2px solid #1F6F6D;border-radius:14px;padding:28px;text-align:center}' +
        'h1{font-size:22px;color:#1F6F6D;margin:0 0 6px 0}' +
        '.sub{font-size:13px;color:#6B7672;margin-bottom:18px}' +
        '.qr{margin:14px auto;display:inline-block;padding:10px;background:#fff;border:1px solid #E0DAD0;border-radius:10px}' +
        '.url{font-family:monospace;font-size:11px;color:#1F6F6D;word-break:break-all;margin-top:10px;padding:8px;background:#F5F1EA;border-radius:6px}' +
        '.foot{font-size:11px;color:#6B7672;margin-top:18px;line-height:1.6}' +
      '</style></head><body>' +
      '<div class="card">' +
        '<h1>Refer to ' + orgName + '</h1>' +
        '<div class="sub">Scan the QR code or visit the link to register and submit a referral.</div>' +
        (qrSrc ? '<div class="qr"><img src="' + qrSrc + '" width="220" height="220"/></div>' : '') +
        '<div class="url">' + escapeHTML(url) + '</div>' +
        '<div class="foot">Secure portal · GDPR compliant · Powered by Civara</div>' +
      '</div>' +
      '<script>window.onload=function(){setTimeout(function(){window.print();},250);};<' + '/script>' +
      '</body></html>'
    );
    w.document.close();
  };

  window.toggleEmailTemplate = function () {
    const box = document.getElementById('email-template');
    const btn = document.getElementById('email-tpl-btn');
    const body = document.getElementById('email-tpl-body');
    if (!box || !btn || !body) return;
    const showing = box.style.display !== 'none';
    if (showing) {
      box.style.display = 'none';
      btn.textContent = '✉️ Show email template to send to partners';
    } else {
      body.textContent = buildEmailTemplate();
      box.style.display = 'block';
      btn.textContent = '✉️ Hide email template';
    }
  };

  window.copyEmailTemplate = async function () {
    const text = buildEmailTemplate();
    try {
      await navigator.clipboard.writeText(text);
      alert('✓ Email template copied to clipboard.');
    } catch (e) {
      alert('Copy failed — please select the text manually.');
    }
  };

  // ── 5. Helpers ───────────────────────────────────────────────

  function buildEmailTemplate() {
    const url = getPartnerPortalUrl() || '[your portal link]';
    const orgName = (currentOrg && currentOrg.name) ? currentOrg.name : 'our team';
    return (
      'Subject: Quick way to refer clients to ' + orgName + '\n\n' +
      'Hi [name],\n\n' +
      'We\'ve set up a secure partner portal so you can refer clients to ' + orgName + ' in a couple of minutes — no email back-and-forth, no spreadsheets.\n\n' +
      'How it works:\n' +
      '  1. Register once using the link below (you\'ll get an account in your name).\n' +
      '  2. Submit referrals straight from your dashboard.\n' +
      '  3. Track each referral\'s progress — Referred → Engaged → In delivery → Outcome.\n\n' +
      'Your unique invitation link:\n' +
      url + '\n\n' +
      'Urgent referrals are flagged for same-day or 48-hour response. Standard referrals get a response within 2 working days.\n\n' +
      'Any questions, just reply to this email.\n\n' +
      'Thanks,\n' +
      '[Your name]\n' +
      orgName
    );
  }

  function flashBtn(id, msg) {
    const b = document.getElementById(id);
    if (!b) return;
    const original = b.textContent;
    b.textContent = msg;
    setTimeout(() => { b.textContent = original; }, 1600);
  }

  // ── 6. Patch renderPartnerRefs so the QR draws on every visit ─
  // We don't replace it — we wrap it so the existing table render
  // (which is in render.js) still happens.
  if (typeof window.renderPartnerRefs === 'function') {
    const _original = window.renderPartnerRefs;
    window.renderPartnerRefs = function () {
      const result = _original.apply(this, arguments);
      // Run after the original so the card markup is in the DOM
      // (it's static HTML in app.html, but this also handles any
      // future case where it's injected dynamically).
      try { renderPartnerPortalCard(); }
      catch (e) { console.error('[partner-portal] render failed:', e); }
      return result;
    };
  } else {
    // Fallback — render.js didn't load or function was renamed.
    // Try once on DOMContentLoaded so the page at least shows the QR.
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(renderPartnerPortalCard, 500);
    });
  }

})();
