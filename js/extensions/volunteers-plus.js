// js/extensions/volunteers-plus.js  — v1.4
// Vorlana — volunteers upgrade (part 1 of 2)
//
//   1. FIX: Edit / Delete volunteer buttons (Supabase ids are numbers, the
//      buttons pass strings, modals.js used strict === so nothing matched).
//   2. Volunteer demographics — voluntary equality_data on the volunteers row.
//   3. Hours SESSIONS LOG — `volunteer_hours` table. Totals roll up per
//      volunteer, per event, and into Social Impact. The old single `hours`
//      field is kept as an "opening balance" so nothing is lost.
//   4. Events page shows volunteers + hours per event.
//
// v1.4 FIX: logged hours vanished on refresh. Cause — this file started before
// boot.js had resolved orgId, so the first read was refused
// ("[sbQ] Refusing to query volunteer_hours without orgId") and the cache
// stayed empty. We now WAIT for orgId (and re-check for a while afterwards)
// before loading, and read volunteer_hours straight from Supabase rather than
// through db.js's refreshTable, which only knows its own built-in tables.

(function () {
'use strict';

var VERSION = 'v1.4';

// ── boot gate: wait for the app AND for orgId ──────────────
function appReady() {
  return typeof DB !== 'undefined' &&
         typeof sb !== 'undefined' && sb &&
         typeof renderVolunteers === 'function' &&
         document.getElementById('modal-vol');
}
function haveOrg() {
  return typeof orgId !== 'undefined' && !!orgId;
}
function whenReady(fn) {
  if (appReady()) return setTimeout(fn, 250);
  setTimeout(function () { whenReady(fn); }, 150);
}
whenReady(init);

// ── helpers ─────────────────────────────────────────────────
var $ = function (id) { return document.getElementById(id); };
function byId(list, id) {
  list = list || [];
  for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i];
  return null;
}
function gv(id) { var e = $(id); return e ? (e.value || '') : ''; }
function sv(id, v) { var e = $(id); if (e) e.value = (v == null ? '' : v); }
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function n(v) { return isNaN(+v) ? 0 : +v; }
function todayISO() { return new Date().toISOString().slice(0, 10); }
function fmt(d) {
  return d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';
}
function hideModal(id) { var m = $(id); if (m) m.classList.remove('open'); }

var EQ_FIELDS = ['age', 'ethnicity', 'gender', 'disability'];

// ── volunteer_hours: read straight from Supabase ───────────
function mapHours(r) {
  return {
    id: r.id,
    volunteer_id: r.volunteer_id,
    event_id: r.event_id || null,
    date: r.session_date || '',
    hours: n(r.hours),
    activity: r.activity || '',
    source: r.source || 'staff',
    wellbeing: r.wellbeing != null ? n(r.wellbeing) : null
  };
}

// ── Outcomes at the top of the Volunteers page ───────────────
// A period picker: this week, last week, any week, last 4 weeks, 3 months or 12 months (the default,
// so the figures read like a funder report), plus a week-by-week table. Weeks run Monday to Sunday.
var VOL_PERIODS = [['week', 'A week'], ['4w', 'Last 4 weeks'], ['3m', 'Last 3 months'], ['12m', 'Last 12 months']];
var volPeriod = (function () { try { return localStorage.getItem('vl_vol_period') || '12m'; } catch (e) { return '12m'; } })();
var volWeek = null;   // the Monday of the week shown, as YYYY-MM-DD
function pad2(x) { return (x < 10 ? '0' : '') + x; }
function isoLocal(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
function mondayOf(d) { var x = new Date(d); x.setHours(12, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
function addDays(isoStr, k) { var x = new Date(isoStr + 'T12:00:00'); x.setDate(x.getDate() + k); return isoLocal(x); }
function dayLabel(isoStr, withYear) { return new Date(isoStr + 'T12:00:00').toLocaleDateString('en-GB', withYear ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short' }); }
function volRange() {
  var today = isoLocal(new Date()), thisMon = isoLocal(mondayOf(new Date()));
  if (volPeriod === 'week') {
    var mon = volWeek || thisMon, sun = addDays(mon, 6);
    var lbl = mon === thisMon ? 'This week' : mon === addDays(thisMon, -7) ? 'Last week' : 'Week of ' + dayLabel(mon, true);
    return { from: mon, to: sun, label: lbl + ' · ' + dayLabel(mon) + ' – ' + dayLabel(sun, true), week: true, mon: mon, isThis: mon === thisMon };
  }
  if (volPeriod === '4w') return { from: addDays(thisMon, -21), to: today, label: 'Last 4 weeks · from ' + dayLabel(addDays(thisMon, -21), true) };
  if (volPeriod === '3m') return { from: addDays(today, -91), to: today, label: 'Last 3 months' };
  return { from: addDays(today, -365), to: today, label: 'Last 12 months', year: true };
}
window.vlVolPeriod = function (v) {
  volPeriod = v; if (v === 'week' && !volWeek) volWeek = isoLocal(mondayOf(new Date()));
  try { localStorage.setItem('vl_vol_period', v); } catch (e) { /* remembered for this visit only */ }
  try { renderVolunteers(); } catch (e) {}
};
window.vlVolWeek = function (mon) { volWeek = mon; window.vlVolPeriod('week'); };
window.vlVolDay = function (d) { window.vlVolWeek(isoLocal(mondayOf(new Date(d + 'T12:00:00')))); };
window.vlVolShift = function (k) { var r = volRange(); volWeek = addDays(r.mon || isoLocal(mondayOf(new Date())), 7 * k); window.vlVolPeriod('week'); };

function volOutcomesHTML() {
  var V = DB.volunteers || [], H = DB.volunteer_hours || [];
  var r = volRange();
  var rows = H.filter(function (h) { return h.date && h.date.slice(0, 10) >= r.from && h.date.slice(0, 10) <= r.to; });
  var hrs = Math.round(rows.reduce(function (a, h) { return a + n(h.hours); }, 0) * 10) / 10;
  var rate = (typeof VOL_HOUR_RATE !== 'undefined') ? VOL_HOUR_RATE : 13.45;
  var people = {}; rows.forEach(function (h) { people[h.volunteer_id] = (people[h.volunteer_id] || 0) + n(h.hours); });
  var first = {}; H.forEach(function (h) { if (h.date && (!first[h.volunteer_id] || h.date < first[h.volunteer_id])) first[h.volunteer_id] = h.date.slice(0, 10); });
  // new: first ever session in the period (over 12 months, as before: in the last 90 days)
  var newFrom = r.year ? addDays(isoLocal(new Date()), -90) : r.from;
  var newVols = Object.keys(first).filter(function (k) { return first[k] >= newFrom && first[k] <= r.to; }).length;
  var m6 = addDays(isoLocal(new Date()), -182), months = {};
  H.filter(function (h) { return h.date && h.date >= m6; }).forEach(function (h) { (months[h.volunteer_id] = months[h.volunteer_id] || {})[h.date.slice(0, 7)] = 1; });
  var regulars = Object.keys(months).filter(function (k) { return Object.keys(months[k]).length >= 3; }).length;
  var wb = rows.filter(function (h) { return h.wellbeing; });
  var wbAvg = wb.length ? Math.round(wb.reduce(function (a, h) { return a + h.wellbeing; }, 0) / wb.length * 10) / 10 : null;
  var card = function (label, value, sub) {
    return (typeof statCard === 'function') ? statCard(label, value, sub)
      : '<div class="stat-card"><div class="stat-label">' + esc(label) + '</div><div class="stat-value">' + value + '</div><div class="stat-sub">' + esc(sub || '') + '</div></div>';
  };
  var nameOf = {}; V.forEach(function (v) { nameOf[String(v.id)] = v.name || 'Volunteer'; });

  var picker = '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px">' +
    '<select id="vol-period" class="input" style="width:auto;padding:6px 10px;font-size:13px" onchange="vlVolPeriod(this.value)">' +
      VOL_PERIODS.map(function (p) { return '<option value="' + p[0] + '"' + (p[0] === volPeriod ? ' selected' : '') + '>' + esc(p[1]) + '</option>'; }).join('') +
    '</select>' +
    (r.week ? '<button type="button" class="btn btn-ghost btn-sm" onclick="vlVolShift(-1)">‹ Previous week</button>' +
      (r.isThis ? '' : '<button type="button" class="btn btn-ghost btn-sm" onclick="vlVolShift(1)">Next week ›</button>') +
      '<input type="date" class="input" style="width:auto;padding:5px 8px;font-size:13px" value="' + r.mon + '" title="Pick any day in the week" onchange="if(this.value)vlVolDay(this.value)" />' : '') +
    '<span style="font-size:11px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.5px">' + esc(r.label) + '</span></div>';

  var who = '';
  if (r.week) {
    var ids = Object.keys(people).sort(function (a, b) { return people[b] - people[a]; });
    who = '<div class="card" style="margin-bottom:14px"><div style="font-weight:700;font-size:13px;margin-bottom:8px">Who volunteered' + (r.isThis ? ' this week' : '') + '</div>' +
      (ids.length ? '<div style="display:flex;flex-wrap:wrap;gap:6px">' + ids.map(function (id) {
        var sess = rows.filter(function (h) { return String(h.volunteer_id) === id; }).length;
        return '<span style="background:var(--bg);border:1px solid var(--border);border-radius:999px;padding:4px 10px;font-size:12.5px">' + esc(nameOf[id] || 'Volunteer') + ' · ' + (Math.round(people[id] * 10) / 10) + 'h' + (sess > 1 ? ' (' + sess + ' sessions)' : '') + (first[id] >= r.from && first[id] <= r.to ? ' · <b style="color:var(--em)">new</b>' : '') + '</span>';
      }).join('') + '</div>' : '<div style="font-size:13px;color:var(--txt3)">No volunteer hours logged this week.</div>') + '</div>';
  }

  // week by week: the last 12 weeks, newest first; tap a week to see it
  var thisMon = isoLocal(mondayOf(new Date())), wk = [];
  for (var k = 0; k < 12; k++) {
    var mon = addDays(thisMon, -7 * k), sun = addDays(mon, 6);
    var wr = H.filter(function (h) { return h.date && h.date.slice(0, 10) >= mon && h.date.slice(0, 10) <= sun; });
    var wp = {}; wr.forEach(function (h) { wp[h.volunteer_id] = 1; });
    var wn = Object.keys(first).filter(function (id) { return first[id] >= mon && first[id] <= sun; }).length;
    wk.push({ mon: mon, sun: sun, vols: Object.keys(wp).length, hrs: Math.round(wr.reduce(function (a, h) { return a + n(h.hours); }, 0) * 10) / 10, sess: wr.length, nw: wn });
  }
  var maxH = Math.max.apply(null, wk.map(function (w) { return w.hrs; })) || 1;
  var weekly = '<details class="card" style="margin-bottom:18px"' + (r.week || volPeriod === '4w' ? ' open' : '') + '><summary style="cursor:pointer;font-weight:700;font-size:13px">Week by week · last 12 weeks</summary>' +
    '<div class="tbl-wrap" style="margin-top:10px"><table><thead><tr><th>Week</th><th>Volunteers</th><th>Hours</th><th style="width:30%"></th><th>Sessions</th><th>New</th></tr></thead><tbody>' +
    wk.map(function (w) {
      var on = r.week && r.mon === w.mon;
      return '<tr style="cursor:pointer' + (on ? ';background:var(--em-l,#EEF6F4)' : '') + '" onclick="vlVolWeek(\'' + w.mon + '\')" title="See this week">' +
        '<td style="white-space:nowrap;font-weight:' + (on ? '700' : '500') + '">' + (w.mon === thisMon ? 'This week' : esc(dayLabel(w.mon) + ' – ' + dayLabel(w.sun))) + '</td>' +
        '<td>' + w.vols + '</td><td>' + w.hrs + '</td>' +
        '<td><div style="height:8px;background:var(--bg);border-radius:4px"><div style="height:8px;width:' + Math.round(w.hrs / maxH * 100) + '%;background:var(--em);border-radius:4px"></div></div></td>' +
        '<td>' + w.sess + '</td><td>' + (w.nw || '') + '</td></tr>';
    }).join('') + '</tbody></table></div></details>';

  return picker +
    '<div class="stats-grid" style="margin-bottom:14px">' +
      card('Volunteers giving time', Object.keys(people).length, r.year ? V.filter(function (v) { return v.status === 'Active'; }).length + ' active on your list' : 'in this period') +
      card('Hours given', hrs, rows.length + ' sessions' + (rows.length ? ' · avg ' + (Math.round(hrs / rows.length * 10) / 10) + 'h' : '')) +
      card('Value of their time', '£' + Math.round(hrs * rate).toLocaleString(), 'at the real Living Wage (£' + rate.toFixed(2) + '/h)') +
      card('New volunteers', newVols, r.year ? 'first session in the last 90 days' : 'first ever session in this period') +
      (r.week ? '' : card('Regulars', regulars, 'came in 3+ different months (last 6)')) +
      (wbAvg != null ? card('Wellbeing at check-in', wbAvg + ' / 5', wb.length + ' answers') : '') +
    '</div>' + who + weekly;
}

// Loads the sessions. Resolves either way — never throws at the caller.
function loadHours() {
  if (typeof sb === 'undefined' || !sb) return Promise.resolve();
  if (!haveOrg()) return Promise.resolve();   // caller retries — see waitForOrgThenLoad
  return sb.from('volunteer_hours').select('*').eq('org_id', orgId)
    .then(function (res) {
      if (res && res.error) throw res.error;
      DB.volunteer_hours = ((res && res.data) || []).map(mapHours);
    })
    .catch(function (e) {
      console.warn('[volunteers-plus] could not load volunteer_hours:', (e && e.message) || e);
      if (!DB.volunteer_hours) DB.volunteer_hours = [];
    });
}

// orgId is set during boot, which may finish AFTER this file runs.
// Poll for it (up to ~20s), then load and repaint.
function waitForOrgThenLoad(tries) {
  tries = (tries == null) ? 80 : tries;
  if (haveOrg()) {
    return loadHours().then(function () { repaint(); });
  }
  if (tries <= 0) {
    console.warn('[volunteers-plus] orgId never arrived — hours not loaded.');
    return Promise.resolve();
  }
  return new Promise(function (resolve) {
    setTimeout(function () { resolve(waitForOrgThenLoad(tries - 1)); }, 250);
  });
}

// carry equality_data through the volunteer mapper (db.js drops unknown columns)
function patchVolunteerMapper() {
  if (typeof MAPPERS === 'undefined' || !MAPPERS.volunteers || MAPPERS._volEqPatched) return;
  var origMap = MAPPERS.volunteers;
  MAPPERS.volunteers = function (r) {
    var o = origMap(r);
    o.equality_data = r.equality_data || {};
    return o;
  };
  MAPPERS._volEqPatched = true;
}

// ── totals ─────────────────────────────────────────────────
function sessionsFor(volId) {
  return (DB.volunteer_hours || []).filter(function (s) { return String(s.volunteer_id) === String(volId); });
}
function totalHours(v) {
  return n(v.hours) + sessionsFor(v.id).reduce(function (a, s) { return a + n(s.hours); }, 0);
}
function sessionsForEvent(evId) {
  return (DB.volunteer_hours || []).filter(function (s) { return s.event_id && String(s.event_id) === String(evId); });
}

function repaint() {
  try { renderVolunteers(); } catch (e) {}
  var ev = $('page-events');
  if (ev && ev.classList.contains('active') && typeof renderEvents === 'function') { try { renderEvents(); } catch (e) {} }
  var im = $('page-impact');
  if (im && im.classList.contains('active') && typeof renderImpact === 'function') { try { renderImpact(); } catch (e) {} }
}

// ── 1. FIX: loose-id wrappers ───────────────────────────────
function wrapLoose(name, after) {
  var orig = window[name];
  if (typeof orig !== 'function') return;
  window[name] = function (id) {
    var item = byId(DB.volunteers, id);
    if (!item) return;
    var r = orig.call(this, item.id);
    if (after) { try { after(item); } catch (e) {} }
    return r;
  };
}

// ── 2. demographics in the volunteer modal ─────────────────
function injectVolDemographics() {
  var modal = $('modal-vol');
  if (!modal || modal.querySelector('[data-vol-demo]')) return;
  var footer = modal.querySelector('.modal-footer');
  if (!footer) return;

  modal.querySelectorAll('label').forEach(function (l) {
    if (/hours logged/i.test(l.textContent)) l.textContent = 'Opening balance (hours before Vorlana)';
    if (/^\s*(email|phone)\s*\*\s*$/i.test(l.textContent)) l.textContent = l.textContent.replace('*', '').trim();
  });

  var wrap = document.createElement('div');
  wrap.setAttribute('data-vol-demo', '1');
  wrap.innerHTML =
    '<details style="margin-top:8px">' +
      '<summary style="cursor:pointer;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:9px;font-weight:700;font-size:13px;color:var(--txt);user-select:none">📊 Demographics (voluntary)</summary>' +
      '<div style="padding:12px 2px 2px">' +
        '<div style="font-size:11px;color:var(--txt3);margin-bottom:10px;line-height:1.5">Voluntary equality data — anonymised reporting only. Leave any field blank.</div>' +
        '<div class="form-grid-2">' +
          '<div class="form-row"><label>Age group</label><select id="vf-eq-age"><option value="">Prefer not to say</option><option>16–24</option><option>25–34</option><option>35–44</option><option>45–54</option><option>55–64</option><option>65+</option></select></div>' +
          '<div class="form-row"><label>Ethnicity</label><select id="vf-eq-ethnicity"><option value="">Prefer not to say</option><option>White British</option><option>White Irish</option><option>White Other</option><option>Mixed/Multiple</option><option>Asian/Asian British</option><option>Black/Black British</option><option>Arab</option><option>Other</option></select></div>' +
        '</div>' +
        '<div class="form-grid-2">' +
          '<div class="form-row"><label>Gender</label><select id="vf-eq-gender"><option value="">Prefer not to say</option><option>Man</option><option>Woman</option><option>Non-binary</option><option>Other</option></select></div>' +
          '<div class="form-row"><label>Disability</label><select id="vf-eq-disability"><option value="">Prefer not to say</option><option value="none">No disability</option><option value="physical">Physical / mobility</option><option value="sensory">Sensory</option><option value="mental">Mental health</option><option value="learning">Learning disability</option><option value="neurodiverse">Neurodiverse</option></select></div>' +
        '</div>' +
      '</div>' +
    '</details>';
  footer.parentNode.insertBefore(wrap, footer);
}
function readVolEq() {
  var d = {};
  EQ_FIELDS.forEach(function (k) { var v = gv('vf-eq-' + k); if (v) d[k] = v; });
  return d;
}
function fillVolEq(v) {
  var ed = (v && v.equality_data) || {};
  EQ_FIELDS.forEach(function (k) { sv('vf-eq-' + k, ed[k] || ''); });
  showLoggedHours(v);
}

// Hours logged in Vorlana (sessions, incl. imported sign-in sheets) live in
// volunteer_hours, not in the opening-balance box — show them under it.
function showLoggedHours(v) {
  var box = $('vf-hours');
  if (!box) return;
  var note = $('vf-hours-logged');
  if (!note) {
    note = document.createElement('div');
    note.id = 'vf-hours-logged';
    note.style.cssText = 'font-size:12px;color:var(--txt2);margin-top:6px;line-height:1.5';
    box.parentNode.appendChild(note);
  }
  if (!v) { note.innerHTML = ''; return; }
  var S = sessionsFor(v.id);
  var logged = Math.round(S.reduce(function (a, s) { return a + n(s.hours); }, 0) * 10) / 10;
  var total = Math.round(totalHours(v) * 10) / 10;
  note.innerHTML = S.length
    ? '+ <strong>' + logged + 'h</strong> logged across ' + S.length + ' session' + (S.length === 1 ? '' : 's') +
      ' = <strong style="color:var(--em)">' + total + 'h total</strong> · ' +
      '<a href="#" style="color:var(--em)" onclick="event.preventDefault();closeModal(\'modal-vol\');openLogHours(\'' + esc(String(v.id)) + '\')">View sessions</a>'
    : '<span style="color:var(--txt3)">No sessions logged yet.</span>';
}

// ── saveVol with equality_data (graceful if column missing) ─
function saveVolPlus() {
  var fullName = gv('vf-name').trim();
  var email = gv('vf-email').trim();
  var phone = gv('vf-phone').trim();
  if (!fullName) { alert('Full name is required.'); return; }
  // email and phone are optional — imported sign-in sheets often don't collect them

  var btn = $('vol-save-btn');
  btn.textContent = 'Saving…'; btn.disabled = true;

  var parts = fullName.split(' ');
  var payload = {
    first_name: parts[0],
    last_name: parts.slice(1).join(' '),
    name: fullName,
    email: email || null,
    phone: phone || null,
    role: gv('vf-role'),
    hours: parseFloat(gv('vf-hours')) || 0,
    status: gv('vf-status'),
    skills: JSON.stringify(typeof getChkArr === 'function' ? getChkArr('vf-skills') : []),
    equality_data: readVolEq()
  };

  function attempt(pl) {
    return _editVolId ? sbUpdate('volunteers', pl, _editVolId) : sbInsert('volunteers', pl);
  }

  attempt(payload)
    .catch(function (e) {
      if (String((e && e.message) || '').toLowerCase().indexOf('equality_data') !== -1) {
        var p2 = Object.assign({}, payload);
        delete p2.equality_data;
        return attempt(p2).then(function (r) {
          setTimeout(function () {
            alert("Saved — but demographics could NOT be stored: the 'equality_data' column is missing on volunteers.\n\nRun in Supabase SQL Editor:\nALTER TABLE volunteers ADD COLUMN IF NOT EXISTS equality_data jsonb DEFAULT '{}';\nNOTIFY pgrst, 'reload schema';");
          }, 100);
          return r;
        });
      }
      throw e;
    })
    .then(function () { hideModal('modal-vol'); return refreshTable('volunteers'); })
    .then(function () { repaint(); })
    .catch(function (e) { alert('Save failed: ' + e.message); })
    .finally(function () { btn.textContent = 'Save volunteer'; btn.disabled = false; });
}

// ── 3. hours log modal ─────────────────────────────────────
var _hoursVolId = null;

function injectHoursModal() {
  if ($('modal-vhours')) return;
  var m = document.createElement('div');
  m.className = 'modal-overlay';
  m.id = 'modal-vhours';
  m.innerHTML =
    '<div class="modal" style="max-width:520px">' +
      '<h2 id="vh-title">Log volunteer hours</h2>' +
      '<div class="form-grid-2">' +
        '<div class="form-row"><label>Date</label><input type="date" id="vh-date"/></div>' +
        '<div class="form-row"><label>Hours</label><input type="number" id="vh-hours" min="0.25" step="0.25" placeholder="e.g. 3"/></div>' +
      '</div>' +
      '<div class="form-row"><label>Event (optional)</label><select id="vh-event"><option value="">— Not linked to an event —</option></select></div>' +
      '<div class="form-row"><label>What they did (optional)</label><input id="vh-activity" placeholder="e.g. Ran the CV workshop"/></div>' +
      '<div class="modal-footer">' +
        '<button class="btn btn-ghost" id="vh-cancel-btn">Cancel</button>' +
        '<button class="btn btn-p" id="vh-save-btn">Save hours</button>' +
      '</div>' +
      '<div id="vh-history" style="margin-top:16px"></div>' +
    '</div>';
  document.body.appendChild(m);
  $('vh-save-btn').addEventListener('click', saveHours);
  $('vh-cancel-btn').addEventListener('click', function () { hideModal('modal-vhours'); });
}

window.openLogHours = function (volId) {
  var v = byId(DB.volunteers, volId);
  if (!v) return;
  _hoursVolId = v.id;
  $('vh-title').textContent = 'Log hours — ' + v.name;
  sv('vh-date', todayISO());
  sv('vh-hours', '');
  sv('vh-activity', '');

  var sel = $('vh-event');
  var events = (DB.events || []).slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  sel.innerHTML = '<option value="">— Not linked to an event —</option>' +
    events.map(function (e) {
      return '<option value="' + esc(String(e.id)) + '">' + esc(e.name) + ' · ' + esc(fmt(e.date)) + '</option>';
    }).join('');

  renderHoursHistory(v);
  $('modal-vhours').classList.add('open');

  // if the cache is empty (e.g. boot raced us), pull it now
  if (!(DB.volunteer_hours || []).length) {
    loadHours().then(function () { renderHoursHistory(v); repaint(); });
  }
};

function renderHoursHistory(v) {
  var el = $('vh-history');
  if (!el) return;
  var s = sessionsFor(v.id).slice().sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  el.innerHTML =
    '<div style="font-size:12px;color:var(--txt3);font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-bottom:8px">' +
      'History · <span style="color:var(--em)">' + totalHours(v) + 'h total</span>' +
      (n(v.hours) ? ' <span style="font-weight:400;text-transform:none">(incl. ' + n(v.hours) + 'h opening balance)</span>' : '') +
    '</div>' +
    (s.length
      ? s.map(function (x) {
          var ev = x.event_id ? byId(DB.events, x.event_id) : null;
          return '<div style="display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px solid var(--border);font-size:13px">' +
            '<div><strong>' + n(x.hours) + 'h</strong> · ' + esc(fmt(x.date)) + (ev ? ' · ' + esc(ev.name) : '') +
              (x.activity ? '<div style="font-size:11px;color:var(--txt3)">' + esc(x.activity) + '</div>' : '') +
            '</div>' +
            '<button class="btn btn-ghost btn-sm" onclick="deleteHours(\'' + esc(String(x.id)) + '\')">×</button>' +
          '</div>';
        }).join('')
      : '<div style="font-size:13px;color:var(--txt3)">No sessions logged yet.</div>');
}

function saveHours() {
  var hrs = parseFloat(gv('vh-hours'));
  if (!_hoursVolId) return;
  if (!hrs || hrs <= 0) { alert('Enter the number of hours.'); return; }

  var btn = $('vh-save-btn');
  btn.textContent = 'Saving…'; btn.disabled = true;

  var row = {
    volunteer_id: String(_hoursVolId),
    event_id: gv('vh-event') || null,
    session_date: gv('vh-date') || todayISO(),
    hours: hrs,
    activity: gv('vh-activity') || null,
    source: 'staff'
  };

  sbInsert('volunteer_hours', row)
    .then(function (saved) {
      // show it straight away…
      DB.volunteer_hours = DB.volunteer_hours || [];
      DB.volunteer_hours.push(mapHours({
        id: (saved && saved.id != null) ? saved.id : ('tmp-' + Date.now()),
        volunteer_id: row.volunteer_id,
        event_id: row.event_id,
        session_date: row.session_date,
        hours: row.hours,
        activity: row.activity,
        source: 'staff'
      }));
      hideModal('modal-vhours');
      repaint();
      // …then re-sync from the database
      return loadHours();
    })
    .then(function () { repaint(); })
    .catch(function (e) {
      alert('Could not save hours: ' + e.message + '\n\nHas the volunteer_hours table been created in Supabase?');
    })
    .finally(function () { btn.textContent = 'Save hours'; btn.disabled = false; });
}

window.deleteHours = function (id) {
  if (!confirm('Remove this session?')) return;
  Promise.resolve(sbDelete('volunteer_hours', id))
    .then(function () {
      DB.volunteer_hours = (DB.volunteer_hours || []).filter(function (s) { return String(s.id) !== String(id); });
      var v = byId(DB.volunteers, _hoursVolId);
      if (v) renderHoursHistory(v);
      repaint();
      return loadHours();
    })
    .then(function () {
      var v = byId(DB.volunteers, _hoursVolId);
      if (v) renderHoursHistory(v);
      repaint();
    })
    .catch(function (e) { alert('Could not remove that: ' + ((e && e.message) || e)); });
};

// ── volunteers table ───────────────────────────────────────
function renderVolunteersPlus() {
  var el = $('vol-list');
  if (!el) return;
  var V = (DB.volunteers || []).slice();

  var search = (gv('vol-search') || '').toLowerCase();
  var status = gv('vol-filter-status');
  if (search) V = V.filter(function (v) { return (v.name || '').toLowerCase().indexOf(search) !== -1; });
  if (status) V = V.filter(function (v) { return v.status === status; });

  var allHours = (DB.volunteers || []).reduce(function (a, v) { return a + totalHours(v); }, 0);
  if ($('vol-sub')) $('vol-sub').textContent = V.length + ' of ' + (DB.volunteers || []).length + ' shown · ' + allHours + 'h logged in total';

  if (!V.length) {
    el.innerHTML = '<div class="card"><div style="color:var(--txt3);font-size:13px;padding:20px;text-align:center">No volunteers match your filters.</div></div>';
    return;
  }

  el.innerHTML = volOutcomesHTML() +
    '<div class="tbl-wrap"><table><thead><tr>' +
      '<th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Skills</th><th>Hours</th><th>Status</th><th></th>' +
    '</tr></thead><tbody>' +
    V.map(function (v) {
      var sessions = sessionsFor(v.id).length;
      var hasEq = v.equality_data && Object.keys(v.equality_data).length;
      return '<tr>' +
        '<td style="font-weight:600">' + esc(v.name || '—') + (hasEq ? ' <span title="Demographics recorded" style="font-size:10px;color:var(--em)">●</span>' : '') + '</td>' +
        '<td>' + esc(v.email || '—') + '</td>' +
        '<td>' + esc(v.phone || '—') + '</td>' +
        '<td>' + esc(v.role || 'Volunteer') + '</td>' +
        '<td style="font-size:11px;color:var(--txt3)">' + esc((v.skills || []).join(', ') || '—') + '</td>' +
        '<td style="text-align:center"><strong>' + totalHours(v) + '</strong>' +
          (sessions ? '<div style="font-size:10px;color:var(--txt3)">' + sessions + ' session' + (sessions === 1 ? '' : 's') + '</div>' : '') +
        '</td>' +
        '<td>' + (typeof stageBadge === 'function' ? stageBadge(v.status) : esc(v.status)) + '</td>' +
        '<td style="text-align:right;white-space:nowrap">' +
          '<button class="btn btn-p btn-sm" onclick="openLogHours(\'' + esc(String(v.id)) + '\')">+ Hours</button> ' +
          '<button class="btn btn-ghost btn-sm" onclick="openEditVol(\'' + esc(String(v.id)) + '\')">Edit</button> ' +
          '<button class="btn btn-ghost btn-sm" onclick="deleteVol(\'' + esc(String(v.id)) + '\')">×</button>' +
        '</td>' +
      '</tr>';
    }).join('') +
    '</tbody></table></div>';
}

// ── 4. events table: volunteers + hours column ─────────────
function wrapRenderEvents() {
  var orig = window.renderEvents;
  if (typeof orig !== 'function' || orig._volPlus) return;
  window.renderEvents = function () {
    var r = orig.apply(this, arguments);
    try {
      var tbl = document.querySelector('#ev-list table');
      if (!tbl) return r;
      var head = tbl.querySelector('thead tr');
      if (head && !head.querySelector('[data-vol-col]')) {
        var th = document.createElement('th');
        th.setAttribute('data-vol-col', '1');
        th.textContent = 'Volunteers';
        head.insertBefore(th, head.lastElementChild);
      }
      tbl.querySelectorAll('tbody tr').forEach(function (tr) {
        if (tr.querySelector('[data-vol-col]')) return;
        var edit = tr.querySelector('button[onclick^="openEditEv"]');
        if (!edit) return;
        var m = /openEditEv\('([^']+)'\)/.exec(edit.getAttribute('onclick') || '');
        if (!m) return;
        var s = sessionsForEvent(m[1]);
        var vols = {};
        s.forEach(function (x) { vols[String(x.volunteer_id)] = 1; });
        var hrs = s.reduce(function (a, x) { return a + n(x.hours); }, 0);
        var td = document.createElement('td');
        td.setAttribute('data-vol-col', '1');
        td.style.textAlign = 'center';
        td.innerHTML = s.length
          ? '<strong>' + Object.keys(vols).length + '</strong><div style="font-size:10px;color:var(--txt3)">' + hrs + 'h</div>'
          : '<span style="color:var(--txt3)">—</span>';
        tr.insertBefore(td, tr.lastElementChild);
      });
    } catch (e) {}
    return r;
  };
  window.renderEvents._volPlus = true;
}

// ── Social Impact: volunteer hours card ────────────────────
function wrapRenderImpact() {
  var orig = window.renderImpact;
  if (typeof orig !== 'function' || orig._volPlus) return;
  window.renderImpact = function () {
    var r = orig.apply(this, arguments);
    try {
      var page = $('page-impact');
      if (!page) return r;
      var card = $('impact-vol-hours');
      if (!card) {
        card = document.createElement('div');
        card.id = 'impact-vol-hours';
        card.className = 'card';
        page.appendChild(card);
      }
      var V = DB.volunteers || [];
      var S = DB.volunteer_hours || [];
      var total = V.reduce(function (a, v) { return a + totalHours(v); }, 0);

      var byMonth = {};
      S.forEach(function (s) {
        var k = (s.date || '').slice(0, 7);
        if (k) byMonth[k] = (byMonth[k] || 0) + n(s.hours);
      });
      var months = Object.keys(byMonth).sort().slice(-6);
      var max = Math.max.apply(null, months.map(function (k) { return byMonth[k]; }).concat([1]));

      card.innerHTML =
        '<div class="card-title">Volunteer hours</div>' +
        '<div style="display:flex;gap:24px;align-items:baseline;margin-bottom:12px">' +
          '<div style="font-size:36px;font-weight:800;color:var(--em)">' + total + 'h</div>' +
          '<div style="font-size:12px;color:var(--txt3)">across ' + V.length + ' volunteers · ' + S.length + ' logged sessions</div>' +
        '</div>' +
        (months.length
          ? months.map(function (k) {
              var lbl = new Date(k + '-01').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
              var w = Math.round(byMonth[k] / max * 100);
              return '<div style="display:flex;align-items:center;gap:10px;font-size:12px;margin-bottom:5px">' +
                '<span style="width:56px;color:var(--txt3)">' + lbl + '</span>' +
                '<div style="flex:1;height:8px;background:var(--sand);border-radius:4px;overflow:hidden"><div style="height:100%;width:' + w + '%;background:var(--em)"></div></div>' +
                '<strong style="width:44px;text-align:right">' + byMonth[k] + 'h</strong>' +
              '</div>';
            }).join('')
          : '<div style="font-size:12px;color:var(--txt3)">Log sessions to see hours by month.</div>');
    } catch (e) {}
    return r;
  };
  window.renderImpact._volPlus = true;
}

// ── init ───────────────────────────────────────────────────
function init() {
  if (!DB.volunteer_hours) DB.volunteer_hours = [];
  patchVolunteerMapper();
  injectVolDemographics();
  injectHoursModal();

  // let other extensions (e.g. historic-import) refresh the hours cache
  window._reloadVolunteerHours = loadHours;

  wrapLoose('openEditVol', fillVolEq);
  wrapLoose('deleteVol');
  var origAdd = window.openAddVol;
  if (typeof origAdd === 'function') {
    window.openAddVol = function () { var r = origAdd.apply(this, arguments); fillVolEq(null); return r; };
  }

  window.saveVol = saveVolPlus;
  window.renderVolunteers = renderVolunteersPlus;
  wrapRenderEvents();
  wrapRenderImpact();

  // Also refresh whenever the user navigates to a page that shows hours —
  // covers any remaining boot-order surprises.
  var origGo = window.go;
  if (typeof origGo === 'function' && !origGo._volPlus) {
    window.go = function (page) {
      var r = origGo.apply(this, arguments);
      if (page === 'volunteers' || page === 'events' || page === 'impact') {
        if (!(DB.volunteer_hours || []).length && haveOrg()) {
          loadHours().then(repaint);
        }
      }
      return r;
    };
    window.go._volPlus = true;
  }

  waitForOrgThenLoad();

  console.log('[volunteers-plus ' + VERSION + '] ready');
}

})();
