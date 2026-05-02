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
