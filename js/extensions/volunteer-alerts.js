// js/extensions/volunteer-alerts.js — Settings > Events: what happens when someone signs up to volunteer on a QR page.
// Staff get an email alert; the volunteer gets a thank-you sent as "<Organisation> via Vorlana", with replies going to the organisation.
// Saves into organisations.settings (volunteer_alerts, volunteer_alert_to, volunteer_thanks, volunteer_reply_to, volunteer_thanks_text).
// The emails themselves are sent by api/_lib/volunteer-mail.js.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var TXT = 'text-transform:none;letter-spacing:0';
  var okList = function (v) { return String(v || '').split(/[,;\s]+/).filter(Boolean).every(function (e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e); }); };

  async function freshSettings() {
    var r = await sb.from('organisations').select('settings').eq('id', orgId).limit(1);
    if (r.error) throw r.error;
    return (r.data && r.data[0] && r.data[0].settings) || {};
  }
  function card(st) {
    var on = function (k) { return st[k] !== false ? 'checked' : ''; };
    var box = 'display:flex;align-items:flex-start;gap:10px;font-size:14px;color:var(--txt);margin:10px 0 6px;' + TXT;
    var tick = 'width:18px;height:18px;margin:1px 0 0;flex:none';
    return '<div style="font-size:15px;font-weight:700;color:var(--txt);' + TXT + '">Volunteers</div><div style="font-size:14px;font-weight:600;color:var(--txt);margin-top:8px;' + TXT + '">When someone signs up to volunteer</div>' +
      '<div style="font-size:13px;color:var(--txt3);margin:2px 0 8px;' + TXT + '">From the \u201cI\u2019d like to volunteer\u201d button on your QR codes. They\u2019re always saved in Contacts.</div>' +
      '<label style="' + box + '"><input type="checkbox" id="vla-alerts" ' + on('volunteer_alerts') + ' style="' + tick + '"/><span>Email us straight away</span></label>' +
      '<div style="margin:0 0 10px 28px"><input id="vla-to" placeholder="Leave blank to email your owners and managers" value="' + esc(st.volunteer_alert_to || '') + '" style="width:100%;max-width:440px;font-size:13px"/>' +
        '<div style="font-size:12px;color:var(--txt3);margin-top:3px;' + TXT + '">You can add more than one address, separated by commas.</div></div>' +
      '<label style="' + box + '"><input type="checkbox" id="vla-thanks" ' + on('volunteer_thanks') + ' style="' + tick + '"/><span>Send them a thank-you email</span></label>' +
      '<div style="margin:0 0 6px 28px;font-size:13px;color:var(--txt2);' + TXT + '">It comes from \u201c' + esc((typeof currentOrg !== 'undefined' && currentOrg && currentOrg.name) || 'Your organisation') + ' via Vorlana\u201d. When they reply, it goes to:</div>' +
      '<div style="margin:0 0 8px 28px"><input id="vla-reply" placeholder="Your email for replies, e.g. hello@yourcharity.org" value="' + esc(st.volunteer_reply_to || '') + '" style="width:100%;max-width:440px;font-size:13px"/></div>' +
      '<div style="margin:0 0 10px 28px"><textarea id="vla-text" rows="3" placeholder="Anything to add? For example: our next volunteer induction is on the first Monday of the month." style="width:100%;max-width:440px;font-size:13px">' + esc(st.volunteer_thanks_text || '') + '</textarea></div>' +
      '<div style="font-size:14px;font-weight:600;color:var(--txt);margin:18px 0 2px;' + TXT + '">When volunteers check in</div>' +
      '<label style="' + box + '"><input type="checkbox" id="vla-askhours" ' + on('volunteer_ask_hours') + ' style="' + tick + '"/><span>Ask how long they\u2019re volunteering, and check them out automatically at that time</span></label>' +
      '<div style="margin:0 0 6px 28px;font-size:12px;color:var(--txt3);' + TXT + '">It\u2019s optional for volunteers. Anyone who leaves earlier can still scan out, and their real time is recorded.</div>' +
      '<div style="margin:8px 0 4px;font-size:13px;color:var(--txt2);' + TXT + '">A note shown at volunteer check-in (optional):</div>' +
      '<div style="margin:0 0 12px"><textarea id="vla-note" rows="3" maxlength="400" placeholder="For example: if you\u2019ve booked in on the calendar, you don\u2019t need to choose your hours unless you leave early." style="width:100%;max-width:468px;font-size:13px">' + esc(st.volunteer_checkin_note || '') + '</textarea></div>' +
      '<div style="display:flex;align-items:center;gap:10px"><button class="btn btn-p btn-sm" type="button" onclick="vlaSave()">Save</button><span id="vla-msg" style="font-size:12px;' + TXT + '"></span></div>';
  }
  async function render() {
    var body = $('st-body'); if (!body || (typeof _setSection !== 'undefined' && _setSection !== 'feedback')) return;
    var old = $('vla-card'); if (old) old.remove();
    var wrap = document.createElement('div'); wrap.id = 'vla-card';
    wrap.style.cssText = 'margin:0 0 26px;padding-bottom:18px;border-bottom:2px solid var(--border)';
    wrap.innerHTML = '<div style="font-size:13px;color:var(--txt3)">Loading\u2026</div>';
    var after = $('vlbk-card');
    if (after) after.insertAdjacentElement('afterend', wrap); else body.insertAdjacentElement('afterbegin', wrap);
    try { wrap.innerHTML = card(await freshSettings()); }
    catch (e) { wrap.innerHTML = '<div style="font-size:13px;color:#B91C1C">Couldn\u2019t load these settings: ' + esc(e.message || e) + '</div>'; }
  }
  window.vlaSave = async function () {
    var msg = $('vla-msg'), to = $('vla-to').value.trim(), reply = $('vla-reply').value.trim();
    var say = function (t, bad) { msg.textContent = t; msg.style.color = bad ? '#B91C1C' : '#065F46'; };
    if (to && !okList(to)) return say('Check the alert email addresses.', true);
    if (reply && !okList(reply)) return say('Check the reply email address.', true);
    say('Saving\u2026');
    try {
      var st = await freshSettings();   // merge into the latest settings so nothing else is overwritten
      Object.assign(st, { volunteer_alerts: $('vla-alerts').checked, volunteer_alert_to: to, volunteer_thanks: $('vla-thanks').checked, volunteer_reply_to: reply, volunteer_thanks_text: $('vla-text').value.trim().slice(0, 1200), volunteer_ask_hours: $('vla-askhours').checked, volunteer_checkin_note: $('vla-note').value.trim().slice(0, 400) });
      var r = await sb.from('organisations').update({ settings: st }).eq('id', orgId);
      if (r.error) throw r.error;
      if (typeof currentOrg !== 'undefined' && currentOrg) currentOrg.settings = st;
      say('Saved.');
    } catch (e) { say('Couldn\u2019t save: ' + (e.message || e), true); }
  };

  (function wait(t) {
    if (typeof renderFeedbackQuestionsCard === 'function' && typeof sb !== 'undefined') {
      var rf = window.renderFeedbackQuestionsCard;
      window.renderFeedbackQuestionsCard = function () { var r = rf.apply(this, arguments); setTimeout(function () { render().catch(function (e) { console.warn('[volunteer-alerts]', e); }); }, 60); return r; };
      return;
    }
    if (t < 100) setTimeout(function () { wait(t + 1); }, 100);
  })(0);
  if (window.__VORLANA_TEST) window.__vlaTest = { card: card, render: render };
})();
