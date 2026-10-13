// js/utils.js — pure helpers used everywhere. No DOM ownership, no app state.
// Depends on: nothing

'use strict';

// DOM
const $ = id => document.getElementById(id);
const closeModal = id => { const el = $(id); if (el) el.classList.remove('open'); };

// Strings
const escapeHTML = s => String(s || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const ini = n => (n || '').split(' ').map(x => x[0] || '').join('').slice(0, 2).toUpperCase();

// Numbers
const num = v => isNaN(+v) ? 0 : +v;
const pct = (n, d) => d ? Math.round(n / d * 100) : 0;

// Dates
const today = () => new Date().toISOString().split('T')[0];
const fmtD = d => d
  ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
  : '—';
const days = d => d
  ? Math.floor((Date.now() - new Date(d)) / 86400000)
  : 9999;

// Array coercion — handles both real arrays and JSON-stringified arrays from Postgres
const toArr = v => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.startsWith('[')) {
    try { return JSON.parse(v); } catch (e) { return []; }
  }
  return [];
};

// Risk class
const rCls = r => r === 'High' ? 'risk-hi' : r === 'Medium' ? 'risk-med' : 'risk-lo';

// Empty state HTML
const emptyState = (icon, title, sub, btnLabel, btnFn) =>
  '<div class="empty-state"><div class="es-icon">' + icon + '</div>' +
  '<div class="es-title">' + escapeHTML(title) + '</div>' +
  '<div class="es-sub">' + escapeHTML(sub) + '</div>' +
  (btnLabel
    ? '<button class="btn btn-p btn-sm" onclick="' + btnFn + '">' + escapeHTML(btnLabel) + '</button>'
    : '') +
  '</div>';

// Safe localStorage — silent on iframe sandbox or private mode
const safeStorage = {
  get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  },
  set(key, val) {
    try { localStorage.setItem(key, val); } catch (e) { /* swallow */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch (e) { /* swallow */ }
  }
};

// CSV export (used by exportCSV in render.js)
function downloadCSV(rows, filename) {
  const csv = rows.map(r =>
    r.map(c => '"' + String(c == null ? '' : c).replace(/"/g, '""') + '"').join(',')
  ).join('\n');
  const a = document.createElement('a');
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  a.download = filename;
  a.click();
}

// ── Honest figures for reports ───────────────────────────────
// Event capacity defaults to 20 on every event, so an "attendance rate" only means something once real capacities are entered.
function capacityTracked(events) {
  try { if (typeof currentOrg !== 'undefined' && currentOrg && currentOrg.settings && currentOrg.settings.capacity_tracked === true) return true; } catch (e) { /* ignore */ }
  const E = (events || (typeof DB !== 'undefined' && DB.events) || []).filter(e => +e.capacity > 0);
  return E.length >= 8 && E.filter(e => +e.capacity !== 20).length / E.length >= 0.25;
}
// 1135.3 -> "1,135.3"; whole numbers stay whole
function fmtNum(v, d) { const x = +v; if (!isFinite(x)) return String(v); return x.toLocaleString('en-GB', { maximumFractionDigits: d == null ? 1 : d }); }
// A quote that mentions someone's health or condition never goes into a funder report
const HEALTH_QUOTE_RX = /\b(health|illness|ill|sick|disab\w*|condition|medicat\w*|diagnos\w*|depress\w*|anxiety|anxious|cancer|pregnan\w*|surgery|operation|hospital|doctor|gp|pain|chronic|circulation|arthritis|diabet\w*|dementia|autis\w*|adhd|dyslexi\w*|mental|therapy|counsell\w*|addict\w*)\b/i;
