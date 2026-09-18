// js/extensions/event-qr.js  — v1.0
// ─────────────────────────────────────────────────────────────
// Adds a "📱 QR" button to every row on the Events page.
//
// Each event has its own public_token (set by the SQL migration).
// The QR points at:   /event.html?t=<token>
// That public page lets anyone, with no login:
//    • leave attendee feedback for the event
//    • check in / out as a registered volunteer (matched by email)
//
// The modal offers: copy link, download PNG, print a poster,
// and a switch to turn the public link off for that event.
//
// Uses the SAME QR library as partner-portal.js (davidshimjs
// qrcodejs) and reuses it if that file already loaded it.
//
// Depends on: db.js (sb, DB, sbUpdate, refreshTable),
//             render.js (renderEvents), utils.js ($, escapeHTML)
// Load AFTER boot.js and the other extensions.
'use strict';

(function () {

var VERSION = 'v1.0';
var QR_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js';
var _qrLib = null;

function $(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── QR library (shared with partner-portal.js) ─────────────
function loadQRLib() {
  if (window.QRCode) return Promise.resolve();
  if (_qrLib) return _qrLib;
  _qrLib = new Promise(function (resolve, reject) {
    var s = document.createElement('script');
    s.src = QR_CDN;
    s.async = true;
    s.onload = function () { resolve(); };
    s.onerror = function () { _qrLib = null; reject(new Error('Could not load QR library')); };
    document.head.appendChild(s);
  });
  return _qrLib;
}

// ── URL for an event's public page ─────────────────────────
function eventUrl(token) {
  var base = window.location.origin + window.location.pathname.replace(/[^/]*$/, '');
  return base + 'event.html?t=' + encodeURIComponent(token);
}

// ── Modal ──────────────────────────────────────────────────
var _cur = null; // { id, name, date, token, enabled }

function injectModal() {
  if ($('modal-evqr')) return;
  var m = document.createElement('div');
  m.className = 'modal-overlay';
  m.id = 'modal-evqr';
  m.innerHTML =
    '<div class="modal" style="max-width:520px">' +
      '<h2 id="evqr-title">Event QR code</h2>' +
      '<p style="font-size:13px;color:var(--txt2);line-height:1.7;margin-bottom:16px">' +
        'Print this and put it on the door, the table, or the gate. Anyone can scan it to leave feedback — ' +
        'and registered volunteers can check in and out, so their hours log themselves. No app, no login.' +
      '</p>' +

      '<div style="display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap">' +
        '<div style="background:#fff;padding:12px;border:1px solid var(--border);border-radius:10px;flex-shrink:0">' +
          '<div id="evqr-target" style="width:160px;height:160px"></div>' +
        '</div>' +
        '<div style="flex:1;min-width:200px">' +
          '<label>Public link</label>' +
          '<div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:9px 11px;font-family:monospace;font-size:11px;color:var(--em);word-break:break-all;margin-bottom:10px" id="evqr-link">—</div>' +
          '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
            '<button class="btn btn-p btn-sm" id="evqr-copy">📋 Copy link</button>' +
            '<button class="btn btn-ghost btn-sm" id="evqr-dl">⬇ Download QR</button>' +
            '<button class="btn btn-ghost btn-sm" id="evqr-print">🖨️ Print poster</button>' +
          '</div>' +
        '</div>' +
      '</div>' +

      '<div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:14px">' +
        '<div style="flex:1">' +
          '<div style="font-size:13px;font-weight:600;color:var(--txt)">Public link active</div>' +
          '<div style="font-size:11px;color:var(--txt3);line-height:1.5">Turn this off after the event to stop any further check-ins or feedback.</div>' +
        '</div>' +
        '<div style="position:relative;width:44px;height:24px;flex-shrink:0;cursor:pointer" id="evqr-toggle">' +
          '<div id="evqr-track" style="position:absolute;inset:0;border-radius:12px;background:#E0DAD0;transition:background .2s"></div>' +
          '<div id="evqr-thumb" style="position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .2s;pointer-events:none;box-shadow:0 1px 2px rgba(0,0,0,.1)"></div>' +
        '</div>' +
      '</div>' +

      '<div class="modal-footer"><button class="btn btn-ghost" id="evqr-close">Close</button></div>' +
    '</div>';
  document.body.appendChild(m);

  $('evqr-close').addEventListener('click', function () { m.classList.remove('open'); });
  $('evqr-copy').addEventListener('click', copyLink);
  $('evqr-dl').addEventListener('click', downloadQR);
  $('evqr-print').addEventListener('click', printPoster);
  $('evqr-toggle').addEventListener('click', toggleEnabled);
}

function paintToggle(on) {
  var t = $('evqr-track'), th = $('evqr-thumb');
  if (t) t.style.background = on ? '#1F6F6D' : '#E0DAD0';
  if (th) th.style.left = on ? '23px' : '3px';
}

// Open for one event — reads the token straight from Supabase so
// it always reflects the current state (db.js's mapper drops it).
window.openEventQR = function (eventId) {
  injectModal();
  if (typeof sb === 'undefined' || !sb) { alert('Not connected.'); return; }

  var ev = (DB.events || []).filter(function (e) { return String(e.id) === String(eventId); })[0];
  $('evqr-title').textContent = 'QR code — ' + ((ev && ev.name) || 'Event');
  $('evqr-link').textContent = 'Loading…';
  $('evqr-target').innerHTML = '';
  $('modal-evqr').classList.add('open');

  sb.from('events').select('id,name,event_date,public_token,public_enabled').eq('id', eventId).single()
    .then(function (res) {
      var row = res && res.data;
      if (!row) throw new Error('Event not found.');
      if (!row.public_token) {
        $('evqr-link').textContent = 'No public link yet — run the events SQL migration in Supabase, then reopen this.';
        return;
      }
      _cur = {
        id: row.id,
        name: row.name || 'Event',
        date: row.event_date || '',
        token: row.public_token,
        enabled: row.public_enabled !== false
      };
      var url = eventUrl(_cur.token);
      $('evqr-link').textContent = url;
      paintToggle(_cur.enabled);

      return loadQRLib().then(function () {
        $('evqr-target').innerHTML = '';
        new window.QRCode($('evqr-target'), {
          text: url,
          width: 160,
          height: 160,
          colorDark: '#1F6F6D',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel.M
        });
      });
    })
    .catch(function (e) {
      $('evqr-link').textContent = 'Could not load: ' + ((e && e.message) || e);
    });
};

function copyLink() {
  if (!_cur) return;
  var url = eventUrl(_cur.token);
  var btn = $('evqr-copy');
  function done() {
    var o = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(function () { btn.textContent = o; }, 1600);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(done).catch(fallback);
  } else { fallback(); }
  function fallback() {
    var ta = document.createElement('textarea');
    ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); done(); }
    catch (e) { alert('Copy failed — please copy the link manually.'); }
    document.body.removeChild(ta);
  }
}

function qrDataUrl() {
  var t = $('evqr-target');
  if (!t) return null;
  var c = t.querySelector('canvas');
  if (c) return c.toDataURL('image/png');
  var i = t.querySelector('img');
  return (i && i.src) || null;
}

function downloadQR() {
  var data = qrDataUrl();
  if (!data || !_cur) { alert('QR not ready yet — try again in a moment.'); return; }
  var slug = String(_cur.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'event';
  var a = document.createElement('a');
  a.href = data;
  a.download = 'event-qr-' + slug + '.png';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function printPoster() {
  if (!_cur) return;
  var data = qrDataUrl();
  var url = eventUrl(_cur.token);
  var orgName = (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) ? currentOrg.name : '';
  var dateStr = _cur.date
    ? new Date(_cur.date).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  var w = window.open('', '_blank', 'width=800,height=1000');
  if (!w) { alert('Pop-up blocked — please allow pop-ups to print the poster.'); return; }
  w.document.write(
    '<!doctype html><html><head><title>' + esc(_cur.name) + ' — QR poster</title>' +
    '<style>' +
      '@page{size:A4;margin:16mm}' +
      'body{font-family:system-ui,-apple-system,sans-serif;color:#22312E;margin:0;text-align:center}' +
      '.wrap{border:3px solid #1F6F6D;border-radius:18px;padding:40px 32px}' +
      '.org{font-size:15px;color:#7A847F;letter-spacing:1px;text-transform:uppercase;font-weight:700;margin-bottom:10px}' +
      'h1{font-size:40px;color:#175655;margin:0 0 6px;line-height:1.1}' +
      '.date{font-size:17px;color:#4A5552;margin-bottom:28px}' +
      '.qr{display:inline-block;padding:16px;background:#fff;border:1px solid #E0DAD0;border-radius:14px}' +
      '.ask{font-size:26px;font-weight:800;color:#1F6F6D;margin:26px 0 10px}' +
      '.lines{font-size:17px;color:#4A5552;line-height:1.9}' +
      '.url{font-family:monospace;font-size:12px;color:#1F6F6D;background:#F5F1EA;border-radius:8px;padding:10px;margin-top:22px;word-break:break-all}' +
      '.foot{font-size:12px;color:#7A847F;margin-top:20px}' +
    '</style></head><body>' +
    '<div class="wrap">' +
      (orgName ? '<div class="org">' + esc(orgName) + '</div>' : '') +
      '<h1>' + esc(_cur.name) + '</h1>' +
      (dateStr ? '<div class="date">' + esc(dateStr) + '</div>' : '') +
      (data ? '<div class="qr"><img src="' + data + '" width="300" height="300"/></div>' : '') +
      '<div class="ask">Scan me</div>' +
      '<div class="lines">' +
        '📝 Tell us how today went<br/>' +
        '🙋 Volunteers — check in &amp; out here' +
      '</div>' +
      '<div class="url">' + esc(url) + '</div>' +
      '<div class="foot">No app needed · Takes two minutes · Powered by Vorlana</div>' +
    '</div>' +
    '<scr' + 'ipt>window.onload=function(){setTimeout(function(){window.print();},300);};</scr' + 'ipt>' +
    '</body></html>'
  );
  w.document.close();
}

function toggleEnabled() {
  if (!_cur) return;
  var next = !_cur.enabled;
  paintToggle(next);
  sb.from('events').update({ public_enabled: next }).eq('id', _cur.id)
    .then(function (res) {
      if (res && res.error) throw res.error;
      _cur.enabled = next;
    })
    .catch(function (e) {
      paintToggle(_cur.enabled); // revert
      alert('Could not change that: ' + ((e && e.message) || e));
    });
}

// ── Add the QR button to each Events row ───────────────────
function wrapRenderEvents() {
  var orig = window.renderEvents;
  if (typeof orig !== 'function' || orig._evQR) return;
  window.renderEvents = function () {
    var r = orig.apply(this, arguments);
    try {
      var list = $('ev-list');
      if (!list) return r;
      list.querySelectorAll('button[onclick^="openEditEv"]').forEach(function (edit) {
        var row = edit.parentNode;
        if (!row || row.querySelector('.ev-qr-btn')) return;
        var m = /openEditEv\('([^']+)'\)/.exec(edit.getAttribute('onclick') || '');
        if (!m) return;
        var b = document.createElement('button');
        b.className = 'btn btn-ghost btn-sm ev-qr-btn';
        b.textContent = '📱 QR';
        b.title = 'Show the public QR code for this event';
        b.setAttribute('onclick', "openEventQR('" + m[1] + "')");
        row.insertBefore(b, edit);
        row.insertBefore(document.createTextNode(' '), edit);
      });
    } catch (e) { /* never break the page */ }
    return r;
  };
  window.renderEvents._evQR = true;
}

// ── init ───────────────────────────────────────────────────
function whenReady(fn) {
  if (typeof DB !== 'undefined' && typeof sb !== 'undefined' && typeof renderEvents === 'function') {
    return setTimeout(fn, 350);
  }
  setTimeout(function () { whenReady(fn); }, 150);
}

whenReady(function () {
  injectModal();
  wrapRenderEvents();
  var page = $('page-events');
  if (page && page.classList.contains('active')) { try { renderEvents(); } catch (e) {} }
  console.log('[event-qr ' + VERSION + '] ready');
});

})();
