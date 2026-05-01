/* ============================================================
 * CIVARA ADDITIONS - v3
 * Drop-in replacement for civara-additions.js
 *
 * v3 fixes the "nothing happens" issue:
 *  - In app.html, DB/sb/orgId etc. are declared with `const`
 *    inside a <script> block, so they DO NOT live on window.
 *  - v1 and v2 polled for window.DB and waited forever.
 *  - v3 reads them through DOM hooks and via a small wrapper
 *    that grabs them from the existing functions like sbInsert
 *    that ARE on window (because they're declared with `function`,
 *    which DOES bind to window in non-module scripts).
 *
 * If a function isn't actually on window in your app, the
 * additions log a warning but keep working for everything else.
 * ============================================================ */

(function(){
'use strict';

// ─────────────────────────────────────────────────────────────
// Wait for app boot.
// We don't rely on window.DB — instead we wait for DOM elements
// that boot() creates (the modals, the participants page, etc.)
// ─────────────────────────────────────────────────────────────
function whenReady(fn){
  if(document.getElementById('modal-p')
     && document.getElementById('page-participants')
     && document.querySelector('.nav-btn')){
    return setTimeout(fn,400);
  }
  setTimeout(()=>whenReady(fn),120);
}
whenReady(init);

// ─────────────────────────────────────────────────────────────
// Bridge to app internals.
// app.html declares everything with `const` or `function` inside
// a single big <script> block. Top-level `function` declarations
// DO get bound to window in regular (non-module) scripts, so the
// agent runners, openAddP, generateAIReport, runBDResearch etc.
// are reachable as window.XYZ. But `const DB = ...` is NOT.
//
// To work around that, we get a live snapshot of DB by reading
// the DOM (rendered tables) where we can, OR we hijack the next
// call to a known function like sbInsert and read DB from inside
// it via window.DB.
//
// Simpler: most of the time we just need to call existing
// functions (openAddP, saveP, sbInsert) and they'll do the right
// thing. We only need DB for read-only things like the
// Demographics page, where we can read it through a getter.
// ─────────────────────────────────────────────────────────────

let _appBridge=null;
function getApp(){
  if(_appBridge)return _appBridge;
  // Try Function() to read top-level consts from the same realm.
  // This works because civara-additions.js is loaded as a non-module
  // script after app.html's main script, in the same global scope.
  try{
    _appBridge=new Function('return{DB:typeof DB!=="undefined"?DB:null,sb:typeof sb!=="undefined"?sb:null,orgId:typeof orgId!=="undefined"?orgId:null,currentOrg:typeof currentOrg!=="undefined"?currentOrg:null};')();
  }catch(e){
    _appBridge={DB:null,sb:null,orgId:null,currentOrg:null};
  }
  // Refresh the snapshot whenever called — orgId/DB mutate over time.
  return _appBridge;
}
function refreshApp(){_appBridge=null;return getApp();}

// Helpers that always re-read fresh state
function DB(){return refreshApp().DB||{participants:[],volunteers:[],events:[],feedback:[],contacts:[],employers:[],referrals:[],partner_referrals:[],circular:[],contracts:[],evidence:[],funders:[]};}
function SB(){return refreshApp().sb;}
function ORG_ID(){return refreshApp().orgId;}
function CURRENT_ORG(){return refreshApp().currentOrg;}

// ─── Helpers ───────────────────────────────────────────────────
const $=id=>document.getElementById(id);
const closeModal=id=>{const el=$(id);if(el)el.classList.remove('open');};
function escapeHTML(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function pct(n,d){return d?Math.round(n/d*100):0;}
function num(v){return isNaN(+v)?0:+v;}
function toArr(v){return Array.isArray(v)?v:(typeof v==='string'&&v.startsWith('[')?(()=>{try{return JSON.parse(v)}catch(e){return[]}})():[]);}

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
function init(){
  console.log('[civara-additions v3] initialising');
  injectModalsAndPages();
  patchGoRouter();
  patchEqualityModal();
  patchAddParticipantModal();
  patchOpportunitiesFinder();
  patchReportGenerator();
  console.log('[civara-additions v3] ready — DB has', DB().participants.length, 'participants');
}

function injectModalsAndPages(){
  if(!$('modal-csv')){
    const m=document.createElement('div');
    m.className='modal-overlay';m.id='modal-csv';
    m.innerHTML=csvModalHTML();
    document.body.appendChild(m);
    bindCsvModal();
  }
  if(!$('page-demographics')){
    const main=document.getElementById('main');
    if(main){
      const p=document.createElement('div');
      p.className='page';p.id='page-demographics';
      p.innerHTML=demographicsPageHTML();
      main.appendChild(p);
      const exportBtn=p.querySelector('[data-action="export-demographics"]');
      if(exportBtn)exportBtn.addEventListener('click',exportDemographics);
    }
  }
  injectImportButton();
  expandEqualityModal();
}

function injectImportButton(){
  const tries=()=>{
    const hdr=document.querySelector('#page-participants .page-header');
    if(!hdr)return setTimeout(tries,300);
    if(hdr.querySelector('[data-civara-import]'))return;
    const right=hdr.querySelector('button.btn-p');
    if(!right)return;
    const btn=document.createElement('button');
    btn.className='btn btn-ghost btn-sm';
    btn.style.marginRight='8px';
    btn.dataset.civaraImport='1';
    btn.textContent='⬆ Import CSV';
    btn.addEventListener('click',openCsvImport);
    right.parentNode.insertBefore(btn,right);
  };
  tries();
}

function expandEqualityModal(){
  const tries=()=>{
    const modal=$('modal-eq');
    if(!modal)return setTimeout(tries,300);
    if(modal.querySelector('[data-civara-extra]'))return;
    const footer=modal.querySelector('.modal-footer');
    if(!footer)return;
    const wrap=document.createElement('div');
    wrap.dataset.civaraExtra='1';
    wrap.innerHTML=`
      <div class="form-grid-2">
        <div class="form-row"><label>Sexual orientation</label><select id="eq-orientation"><option value="">Prefer not to say</option><option>Heterosexual</option><option>Gay / Lesbian</option><option>Bisexual</option><option>Other</option></select></div>
        <div class="form-row"><label>Religion or belief</label><select id="eq-religion"><option value="">Prefer not to say</option><option>No religion</option><option>Christian</option><option>Muslim</option><option>Hindu</option><option>Sikh</option><option>Jewish</option><option>Buddhist</option><option>Other</option></select></div>
      </div>
      <div class="form-grid-2">
        <div class="form-row"><label>Marital status</label><select id="eq-marital"><option value="">Prefer not to say</option><option>Single</option><option>Married / civil partnership</option><option>Cohabiting</option><option>Separated</option><option>Divorced</option><option>Widowed</option></select></div>
        <div class="form-row"><label>Postcode (first half only, e.g. SE1)</label><input id="eq-postcode" maxlength="5" placeholder="SE1"/></div>
      </div>
    `;
    footer.parentNode.insertBefore(wrap,footer);
  };
  tries();
}

// ─── Demographics on Add Participant ───────────────────────────
function patchAddParticipantModal(){
  const tries=()=>{
    const modal=$('modal-p');
    if(!modal)return setTimeout(tries,300);
    if(modal.querySelector('[data-civara-demo-section]'))return;
    const footer=modal.querySelector('.modal-footer');
    if(!footer)return;
    const wrap=document.createElement('div');
    wrap.dataset.civaraDemoSection='1';
    wrap.style.marginTop='12px';
    wrap.innerHTML=`
      <button type="button" class="btn btn-ghost btn-sm" id="mp-demo-toggle" style="width:100%;justify-content:space-between;display:flex;align-items:center">
        <span>📊 Demographics (optional)</span>
        <span id="mp-demo-toggle-arrow">▼</span>
      </button>
      <div id="mp-demo-body" style="display:none;border:1px solid var(--border);border-radius:8px;padding:14px;margin-top:8px;background:var(--bg)">
        <div style="font-size:11px;color:var(--txt3);margin-bottom:10px;line-height:1.5">Voluntary equality data — used only for anonymised reporting. The participant can choose to leave any field blank.</div>
        <div class="form-grid-2">
          <div class="form-row"><label>Age group</label><select id="mp-eq-age"><option value="">Prefer not to say</option><option>16–24</option><option>25–34</option><option>35–44</option><option>45–54</option><option>55–64</option><option>65+</option></select></div>
          <div class="form-row"><label>Ethnicity</label><select id="mp-eq-ethnicity"><option value="">Prefer not to say</option><option>White British</option><option>White Irish</option><option>White Other</option><option>Mixed/Multiple</option><option>Asian/Asian British</option><option>Black/Black British</option><option>Arab</option><option>Other</option></select></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Gender</label><select id="mp-eq-gender"><option value="">Prefer not to say</option><option>Man</option><option>Woman</option><option>Non-binary</option><option>Other</option></select></div>
          <div class="form-row"><label>Disability</label><select id="mp-eq-disability"><option value="">Prefer not to say</option><option value="none">No disability</option><option value="physical">Physical / mobility</option><option value="sensory">Sensory</option><option value="mental">Mental health</option><option value="learning">Learning disability</option><option value="neurodiverse">Neurodiverse</option></select></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Sexual orientation</label><select id="mp-eq-orientation"><option value="">Prefer not to say</option><option>Heterosexual</option><option>Gay / Lesbian</option><option>Bisexual</option><option>Other</option></select></div>
          <div class="form-row"><label>Religion or belief</label><select id="mp-eq-religion"><option value="">Prefer not to say</option><option>No religion</option><option>Christian</option><option>Muslim</option><option>Hindu</option><option>Sikh</option><option>Jewish</option><option>Buddhist</option><option>Other</option></select></div>
        </div>
        <div class="form-grid-2">
          <div class="form-row"><label>Marital status</label><select id="mp-eq-marital"><option value="">Prefer not to say</option><option>Single</option><option>Married / civil partnership</option><option>Cohabiting</option><option>Separated</option><option>Divorced</option><option>Widowed</option></select></div>
          <div class="form-row"><label>Postcode (first half, e.g. SE1)</label><input id="mp-eq-postcode" maxlength="5" placeholder="SE1"/></div>
        </div>
      </div>
    `;
    footer.parentNode.insertBefore(wrap,footer);
    $('mp-demo-toggle').addEventListener('click',()=>{
      const body=$('mp-demo-body');const arrow=$('mp-demo-toggle-arrow');
      const open=body.style.display==='none';
      body.style.display=open?'block':'none';
      if(arrow)arrow.textContent=open?'▲':'▼';
    });
    wrapParticipantHandlers();
  };
  tries();
}

function wrapParticipantHandlers(){
  if(window._civaraPMWrapped)return;
  window._civaraPMWrapped=true;
  const fields=['age','ethnicity','gender','disability','orientation','religion','marital','postcode'];
  if(typeof window.openAddP==='function'){
    const orig=window.openAddP;
    window.openAddP=function(){
      orig();
      fields.forEach(k=>{const el=$('mp-eq-'+k);if(el)el.value='';});
      const body=$('mp-demo-body'),arrow=$('mp-demo-toggle-arrow');
      if(body)body.style.display='none';if(arrow)arrow.textContent='▼';
    };
  }
  if(typeof window.openEditP==='function'){
    const orig=window.openEditP;
    window.openEditP=function(id){
      orig(id);
      const p=DB().participants.find(x=>x.id===id);
      const ed=p?.equality_data||{};
      fields.forEach(k=>{const el=$('mp-eq-'+k);if(el)el.value=ed[k]||'';});
      const hasData=fields.some(k=>ed[k]);
      if(hasData){
        const body=$('mp-demo-body'),arrow=$('mp-demo-toggle-arrow');
        if(body)body.style.display='block';if(arrow)arrow.textContent='▲';
      }
    };
  }
  if(typeof window.saveP==='function'){
    const orig=window.saveP;
    window.saveP=async function(){
      const captured={};
      fields.forEach(k=>{const v=$('mp-eq-'+k)?.value;if(v)captured[k]=v;});
      if(!Object.keys(captured).length)return orig();
      const origInsert=window.sbInsert,origUpdate=window.sbUpdate;
      window.sbInsert=async function(table,payload){
        if(table==='participants'){
          payload.equality_data={...(payload.equality_data||{}),...captured};
        }
        return origInsert(table,payload);
      };
      window.sbUpdate=async function(table,payload,id){
        if(table==='participants'){
          const existing=DB().participants.find(x=>x.id===id);
          const base=existing?.equality_data||{};
          payload.equality_data={...base,...captured};
        }
        return origUpdate(table,payload,id);
      };
      try{await orig();}
      finally{window.sbInsert=origInsert;window.sbUpdate=origUpdate;}
    };
  }
}

// ─── Demographics page ─────────────────────────────────────────
function demographicsPageHTML(){
  return `
    <div class="page-header">
      <div><div class="page-title">Demographics</div><div class="page-sub" id="demo-sub">Voluntary equality data — anonymised aggregates only</div></div>
      <button class="btn btn-ghost btn-sm" data-action="export-demographics">Export CSV</button>
    </div>
    <div class="alert alert-info">Demographics are collected voluntarily for anonymised reporting. They are never shared with funders at individual level. Records with no equality data are excluded from these counts.</div>
    <div class="stats-grid" id="demo-stats"></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
      <div class="card"><div class="card-title">Age group</div><div id="demo-age"></div></div>
      <div class="card"><div class="card-title">Ethnicity</div><div id="demo-ethnicity"></div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
      <div class="card"><div class="card-title">Gender</div><div id="demo-gender"></div></div>
      <div class="card"><div class="card-title">Disability</div><div id="demo-disability"></div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px">
      <div class="card"><div class="card-title">Sexual orientation</div><div id="demo-orientation"></div></div>
      <div class="card"><div class="card-title">Religion or belief</div><div id="demo-religion"></div></div>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px">
      <div class="card"><div class="card-title">Marital status</div><div id="demo-marital"></div></div>
      <div class="card"><div class="card-title">Postcode (first half)</div><div id="demo-postcode"></div></div>
    </div>
  `;
}

function patchGoRouter(){
  if(window._civaraRouterPatched)return;
  window._civaraRouterPatched=true;
  const origGo=window.go;
  if(typeof origGo!=='function'){console.warn('[civara-additions] window.go not found');return;}
  window.go=function(page){
    if(page==='demographics'){
      document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
      document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));
      const el=$('page-demographics');if(el)el.classList.add('active');
      document.querySelectorAll('.nav-btn').forEach(b=>{if(b.getAttribute('onclick')?.includes("'demographics'"))b.classList.add('active');});
      renderDemographics();
      return;
    }
    return origGo(page);
  };
}

function renderDemographics(){
  const P=DB().participants;
  const withData=P.filter(p=>p.equality_data&&Object.keys(p.equality_data).length>0);
  $('demo-sub').textContent=withData.length+' of '+P.length+' participants have equality data ('+pct(withData.length,P.length||1)+'%)';
  $('demo-stats').innerHTML=[
    {l:'Total participants',v:P.length},
    {l:'Data completed',v:withData.length},
    {l:'Completion rate',v:pct(withData.length,P.length||1)+'%'},
    {l:'Disclosed disability',v:withData.filter(p=>p.equality_data.disability&&p.equality_data.disability!=='none').length}
  ].map(s=>'<div class="stat-card"><div class="stat-lbl">'+escapeHTML(s.l)+'</div><div class="stat-val">'+s.v+'</div></div>').join('');
  const fields=[
    {id:'demo-age',key:'age'},
    {id:'demo-ethnicity',key:'ethnicity'},
    {id:'demo-gender',key:'gender'},
    {id:'demo-disability',key:'disability'},
    {id:'demo-orientation',key:'orientation'},
    {id:'demo-religion',key:'religion'},
    {id:'demo-marital',key:'marital'},
    {id:'demo-postcode',key:'postcode'}
  ];
  fields.forEach(f=>{
    const counts={};
    withData.forEach(p=>{const v=p.equality_data[f.key]||'(not stated)';counts[v]=(counts[v]||0)+1;});
    const pairs=Object.entries(counts).sort((a,b)=>b[1]-a[1]);
    const total=withData.length||1;
    const el=$(f.id);if(!el)return;
    if(!pairs.length){el.innerHTML='<div style="color:var(--txt3);font-size:12px">No data yet.</div>';return;}
    el.innerHTML=pairs.map(([label,count])=>{
      const p=Math.round(count/total*100);
      return '<div class="demo-bar-wrap"><div class="demo-bar-top"><span>'+escapeHTML(label)+'</span><span style="font-weight:600;color:var(--em)">'+count+' ('+p+'%)</span></div><div class="demo-bar-track"><div class="demo-bar-fill" style="width:'+p+'%"></div></div></div>';
    }).join('');
  });
}

function exportDemographics(){
  const P=DB().participants;
  const rows=[['Participant ID','Age','Ethnicity','Gender','Disability','Orientation','Religion','Marital','Postcode']];
  P.forEach(p=>{
    const e=p.equality_data||{};
    rows.push(['CV-'+String(p.id).padStart(4,'0'),e.age||'',e.ethnicity||'',e.gender||'',e.disability||'',e.orientation||'',e.religion||'',e.marital||'',e.postcode||'']);
  });
  const csv=rows.map(r=>r.map(c=>'"'+String(c).replace(/"/g,'""')+'"').join(',')).join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='civara-demographics-anonymised.csv';
  a.click();
}

function patchEqualityModal(){
  const tries=()=>{
    if(typeof window.openEqualityModal!=='function')return setTimeout(tries,300);
    if(window._civaraEqualityPatched)return;
    window._civaraEqualityPatched=true;
    const orig=window.openEqualityModal;
    window.openEqualityModal=function(pid){
      orig(pid);
      const p=DB().participants.find(x=>x.id===pid);
      const ed=p?.equality_data||{};
      ['orientation','religion','marital','postcode'].forEach(k=>{
        const el=$('eq-'+k);if(el)el.value=ed[k]||'';
      });
    };
    if(typeof window.saveEqualityData==='function'){
      window.saveEqualityData=saveEqualityWithExtras;
    }
  };
  tries();
}

async function saveEqualityWithExtras(){
  const _editEqPId=window._editEqPId;
  if(!_editEqPId)return;
  const btn=$('eq-save-btn');if(btn){btn.textContent='Saving…';btn.disabled=true;}
  try{
    const data={
      age:$('eq-age')?.value||'',
      ethnicity:$('eq-ethnicity')?.value||'',
      gender:$('eq-gender')?.value||'',
      disability:$('eq-disability')?.value||'',
      orientation:$('eq-orientation')?.value||'',
      religion:$('eq-religion')?.value||'',
      marital:$('eq-marital')?.value||'',
      postcode:($('eq-postcode')?.value||'').toUpperCase()
    };
    Object.keys(data).forEach(k=>{if(!data[k])delete data[k];});
    if(SB()&&typeof window.sbUpdate==='function'){try{await window.sbUpdate('participants',{equality_data:data},_editEqPId);}catch(e){}}
    const idx=DB().participants.findIndex(x=>x.id===_editEqPId);
    if(idx>=0)DB().participants[idx].equality_data=data;
    closeModal('modal-eq');
    if(typeof window.renderEqMonitoringList==='function')window.renderEqMonitoringList();
    if($('page-demographics')?.classList.contains('active'))renderDemographics();
  }catch(e){alert('Save failed: '+e.message);}
  finally{if(btn){btn.textContent='Save';btn.disabled=false;}}
}

// ═══════════════════════════════════════════════════════════════
// CSV IMPORT
// ═══════════════════════════════════════════════════════════════
const CSV_FIELDS=[
  {key:'first_name',label:'First name',required:true,aliases:['firstname','first','given name','forename','name first']},
  {key:'last_name',label:'Last name',required:true,aliases:['lastname','last','surname','family name','name last']},
  {key:'email',label:'Email',aliases:['e-mail','email address','mail']},
  {key:'phone',label:'Phone',aliases:['mobile','telephone','tel','contact number','phone number']},
  {key:'ref_source',label:'Referral source',aliases:['referral','source','referred by']},
  {key:'stage',label:'Stage',aliases:['status','case stage']},
  {key:'advisor',label:'Advisor',aliases:['caseworker','keyworker','assigned to','advisor name']},
  {key:'risk',label:'Risk level',aliases:['risk','priority']},
  {key:'safeguarding',label:'Safeguarding flag',aliases:['safeguarding flag','safeguard']},
  {key:'barriers',label:'Barriers (semicolon-separated)',aliases:['barrier','support needs']},
  {key:'last_contact',label:'Last contact date',aliases:['last contact date','last contacted','last seen']},
  {key:'notes',label:'Notes',aliases:['note','case note','comments']},
];
const STAGE_VALUES=['Referred','Engaged','In Support','Job Ready','Outcome Achieved','Sustained','Closed'];
const RISK_VALUES=['Low','Medium','High'];
const REF_VALUES=['Self-referral','Probation','Jobcentre Plus','Community org','School / college'];

let _csv={file:null,rows:[],headers:[],mapping:{},validated:[],errors:[]};

function csvModalHTML(){
  return `<div class="modal" style="max-width:760px">
    <h2>Import participants from spreadsheet</h2>
    <div class="csv-stepper">
      <div class="pip active" id="csv-pip-1"></div>
      <div class="pip" id="csv-pip-2"></div>
      <div class="pip" id="csv-pip-3"></div>
      <div class="pip" id="csv-pip-4"></div>
    </div>
    <div class="csv-step active" id="csv-step-1">
      <p style="font-size:13px;color:var(--txt2);margin-bottom:14px;line-height:1.6">Upload a <strong>CSV</strong> file. We'll match your columns to participant fields in the next step. <a href="#" id="csv-template-link" style="color:var(--em);text-decoration:underline">Download a blank template</a>.</p>
      <div class="csv-drop" id="csv-drop">
        <div style="font-size:30px;margin-bottom:8px">📄</div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px">Drop a CSV file here, or click to choose</div>
        <div style="font-size:11px;color:var(--txt3)">.csv files · UTF-8 · up to 5,000 rows</div>
      </div>
      <input type="file" id="csv-file-input" accept=".csv,text/csv" style="display:none"/>
      <div id="csv-file-status" style="margin-top:10px;font-size:12px;color:var(--txt3)"></div>
    </div>
    <div class="csv-step" id="csv-step-2">
      <p style="font-size:13px;color:var(--txt2);margin-bottom:14px;line-height:1.6">We've matched your columns where we could. Confirm or adjust each one. Required fields: <strong>First name, Last name</strong>.</p>
      <div id="csv-mapping-list" style="background:#FFFFFF;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden"></div>
    </div>
    <div class="csv-step" id="csv-step-3">
      <p style="font-size:13px;color:var(--txt2);margin-bottom:14px;line-height:1.6">Preview of the first 8 rows. Rows with issues are highlighted — they'll still import, but we'll skip the bad fields.</p>
      <div style="max-height:280px;overflow:auto;border:1px solid var(--border);border-radius:var(--radius)"><table class="csv-preview-table" id="csv-preview-table"></table></div>
      <div id="csv-validation-summary" class="csv-summary"></div>
    </div>
    <div class="csv-step" id="csv-step-4">
      <div id="csv-import-progress"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="csv-cancel-btn">Cancel</button>
      <button class="btn btn-ghost" id="csv-back-btn" style="display:none">Back</button>
      <button class="btn btn-p" id="csv-next-btn" disabled>Next →</button>
    </div>
  </div>`;
}

function bindCsvModal(){
  $('csv-cancel-btn').addEventListener('click',()=>closeModal('modal-csv'));
  $('csv-back-btn').addEventListener('click',csvBack);
  $('csv-next-btn').addEventListener('click',csvNext);
  $('csv-template-link').addEventListener('click',e=>{e.preventDefault();downloadCsvTemplate();});
  $('csv-drop').addEventListener('click',()=>$('csv-file-input').click());
  $('csv-file-input').addEventListener('change',e=>{const f=e.target.files?.[0];if(f)handleCsvFile(f);});
  const drop=$('csv-drop');
  drop.addEventListener('dragover',e=>{e.preventDefault();drop.classList.add('dragover');});
  drop.addEventListener('dragleave',()=>drop.classList.remove('dragover'));
  drop.addEventListener('drop',e=>{
    e.preventDefault();drop.classList.remove('dragover');
    const f=e.dataTransfer.files?.[0];
    if(f)handleCsvFile(f);
  });
}

function openCsvImport(){
  _csv={file:null,rows:[],headers:[],mapping:{},validated:[],errors:[]};
  csvShowStep(1);
  $('csv-file-status').textContent='';
  $('csv-next-btn').disabled=true;
  $('modal-csv').classList.add('open');
}

function csvShowStep(n){
  for(let i=1;i<=4;i++){
    $('csv-step-'+i)?.classList.toggle('active',i===n);
    const pip=$('csv-pip-'+i);
    if(pip){pip.classList.toggle('active',i===n);pip.classList.toggle('done',i<n);}
  }
  $('csv-back-btn').style.display=n>1&&n<4?'inline-flex':'none';
  $('csv-next-btn').textContent=n===3?'Import →':n===4?'Done':'Next →';
}

function downloadCsvTemplate(){
  const headers=CSV_FIELDS.map(f=>f.label);
  const sample=['Aisha','Okonkwo','aisha@example.com','07700900001','Probation','Engaged','Sarah T.','Medium','','Confidence;Housing','2025-01-15','Initial assessment'];
  const csv=[headers.join(','),sample.join(',')].join('\n');
  const a=document.createElement('a');
  a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
  a.download='civara-participant-import-template.csv';
  a.click();
}

function handleCsvFile(file){
  if(!file.name.toLowerCase().endsWith('.csv')){
    $('csv-file-status').innerHTML='<span style="color:var(--red)">⚠ Please choose a .csv file. Excel files: open in Excel and use File → Save As → CSV (UTF-8).</span>';return;
  }
  if(file.size>5*1024*1024){
    $('csv-file-status').innerHTML='<span style="color:var(--red)">⚠ File too large (max 5MB).</span>';return;
  }
  _csv.file=file;
  $('csv-file-status').textContent='Reading '+file.name+'…';
  const r=new FileReader();
  r.onload=e=>{
    try{
      const text=e.target.result;
      const{headers,rows}=parseCsv(text);
      if(!rows.length)throw new Error('No data rows found in CSV.');
      _csv.headers=headers;_csv.rows=rows;
      _csv.mapping=autoMapColumns(headers);
      $('csv-file-status').innerHTML='✓ Read '+rows.length+' row'+(rows.length===1?'':'s')+' with '+headers.length+' columns.';
      $('csv-next-btn').disabled=false;
    }catch(err){
      $('csv-file-status').innerHTML='<span style="color:var(--red)">⚠ '+escapeHTML(err.message)+'</span>';
    }
  };
  r.onerror=()=>$('csv-file-status').innerHTML='<span style="color:var(--red)">⚠ Could not read file.</span>';
  r.readAsText(file,'utf-8');
}

function parseCsv(text){
  text=text.replace(/^\uFEFF/,'');
  const rows=[];let cur=[];let field='';let inQuotes=false;
  for(let i=0;i<text.length;i++){
    const c=text[i],n=text[i+1];
    if(inQuotes){
      if(c==='"'&&n==='"'){field+='"';i++;}
      else if(c==='"'){inQuotes=false;}
      else field+=c;
    }else{
      if(c==='"'){inQuotes=true;}
      else if(c===','){cur.push(field);field='';}
      else if(c==='\n'){cur.push(field);rows.push(cur);cur=[];field='';}
      else if(c==='\r'){/* skip */}
      else field+=c;
    }
  }
  if(field.length||cur.length){cur.push(field);rows.push(cur);}
  if(!rows.length)throw new Error('CSV is empty.');
  const headers=rows.shift().map(h=>h.trim());
  while(rows.length&&rows[rows.length-1].every(c=>!String(c).trim()))rows.pop();
  return{headers,rows};
}

function autoMapColumns(headers){
  const map={};
  headers.forEach((h,i)=>{
    const norm=h.toLowerCase().replace(/[^a-z0-9 ]/g,'').replace(/\s+/g,' ').trim();
    for(const f of CSV_FIELDS){
      if(norm===f.key.replace(/_/g,' ')||norm===f.label.toLowerCase()||(f.aliases||[]).some(a=>a===norm)){
        map[f.key]=i;break;
      }
    }
  });
  return map;
}

function csvBack(){
  const cur=[1,2,3,4].find(n=>$('csv-step-'+n).classList.contains('active'));
  if(cur>1)csvShowStep(cur-1);
}

async function csvNext(){
  const cur=[1,2,3,4].find(n=>$('csv-step-'+n).classList.contains('active'));
  if(cur===1){renderMappingStep();csvShowStep(2);}
  else if(cur===2){
    if(_csv.mapping.first_name===undefined||_csv.mapping.last_name===undefined){
      alert('First name and last name must both be mapped.');return;
    }
    runValidation();renderPreviewStep();csvShowStep(3);
  }
  else if(cur===3){csvShowStep(4);await runImport();}
  else if(cur===4){closeModal('modal-csv');if(typeof window.go==='function')window.go('participants');}
}

function renderMappingStep(){
  const wrap=$('csv-mapping-list');
  wrap.innerHTML=CSV_FIELDS.map(f=>{
    const sel=_csv.mapping[f.key];
    const opts='<option value="">— skip —</option>'+_csv.headers.map((h,i)=>'<option value="'+i+'" '+(sel===i?'selected':'')+'>'+escapeHTML(h)+'</option>').join('');
    return `<div class="csv-map-row">
      <div><div style="font-size:13px;font-weight:600;color:var(--txt)">${escapeHTML(f.label)}${f.required?' <span style="color:var(--red)">*</span>':''}</div></div>
      <div class="csv-map-arrow">←</div>
      <div><select data-mapfield="${f.key}">${opts}</select></div>
    </div>`;
  }).join('');
  wrap.querySelectorAll('select[data-mapfield]').forEach(sel=>{
    sel.addEventListener('change',e=>{
      const key=e.target.dataset.mapfield;
      const val=e.target.value;
      if(val===''||val===null)delete _csv.mapping[key];
      else _csv.mapping[key]=parseInt(val,10);
    });
  });
}

function runValidation(){
  _csv.validated=[];_csv.errors=[];
  _csv.rows.forEach((row,idx)=>{
    const issues=[];
    const get=k=>_csv.mapping[k]!==undefined?String(row[_csv.mapping[k]]||'').trim():'';
    const fn=get('first_name'),ln=get('last_name');
    if(!fn)issues.push('missing first name');
    if(!ln)issues.push('missing last name');
    let stage=get('stage');
    if(stage&&!STAGE_VALUES.includes(stage)){
      const guess=STAGE_VALUES.find(s=>s.toLowerCase()===stage.toLowerCase());
      if(guess)stage=guess;else{issues.push('stage "'+stage+'" not recognised — defaulted to Referred');stage='Referred';}
    }
    let risk=get('risk');
    if(risk&&!RISK_VALUES.includes(risk)){
      const guess=RISK_VALUES.find(s=>s.toLowerCase()===risk.toLowerCase());
      if(guess)risk=guess;else{issues.push('risk "'+risk+'" not recognised — defaulted to Low');risk='Low';}
    }
    let ref=get('ref_source');
    if(ref&&!REF_VALUES.includes(ref)){
      const guess=REF_VALUES.find(s=>s.toLowerCase()===ref.toLowerCase());
      if(guess)ref=guess;else ref='Self-referral';
    }
    let lc=get('last_contact');
    if(lc){
      const d=new Date(lc);
      if(isNaN(d))lc='';
      else lc=d.toISOString().split('T')[0];
    }
    const barriersRaw=get('barriers');
    const barriers=barriersRaw?barriersRaw.split(/[;|]/).map(s=>s.trim()).filter(Boolean):[];
    const noteText=get('notes');
    const record={
      first_name:fn||'(blank)',
      last_name:ln||'(blank)',
      email:get('email'),
      phone:get('phone'),
      ref_source:ref||'Self-referral',
      stage:stage||'Referred',
      advisor:get('advisor')||'Unassigned',
      risk:risk||'Low',
      safeguarding:get('safeguarding')||null,
      barriers,
      outcomes:[],
      last_contact:lc||null,
      notes:noteText?[{t:noteText,d:(new Date()).toISOString().split('T')[0],s:'Imported'}]:[],
      contract_ids:[],
      equality_data:{},
      scores:{},
      _rowIndex:idx+2,
      _issues:issues
    };
    _csv.validated.push(record);
    if(issues.length)_csv.errors.push({row:record._rowIndex,issues});
  });
}

function renderPreviewStep(){
  const t=$('csv-preview-table');
  const cols=['first_name','last_name','email','stage','advisor','risk','barriers','last_contact'];
  const head='<thead><tr><th style="width:30px">#</th>'+cols.map(c=>'<th>'+c.replace(/_/g,' ')+'</th>').join('')+'</tr></thead>';
  const body='<tbody>'+_csv.validated.slice(0,8).map(r=>{
    const issueClass=r._issues.length?' class="csv-issue"':'';
    return '<tr'+issueClass+'><td>'+r._rowIndex+'</td>'+cols.map(c=>{
      let v=r[c];if(Array.isArray(v))v=v.join('; ');
      return '<td title="'+escapeHTML(v||'')+'">'+escapeHTML(v||'')+'</td>';
    }).join('')+'</tr>';
  }).join('')+'</tbody>';
  t.innerHTML=head+body;
  const total=_csv.validated.length,withIssues=_csv.errors.length,clean=total-withIssues;
  $('csv-validation-summary').innerHTML=`
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:8px">
      <div><div style="font-size:11px;color:var(--txt3);font-weight:600">Total rows</div><div style="font-size:18px;font-weight:700;color:var(--txt)">${total}</div></div>
      <div><div style="font-size:11px;color:var(--txt3);font-weight:600">Clean</div><div style="font-size:18px;font-weight:700;color:var(--em)">${clean}</div></div>
      <div><div style="font-size:11px;color:var(--txt3);font-weight:600">With issues</div><div style="font-size:18px;font-weight:700;color:${withIssues?'var(--amber)':'var(--em)'}">${withIssues}</div></div>
    </div>
    ${withIssues?'<div style="font-size:12px;color:var(--txt2)">Issues are non-blocking — bad fields will be skipped, the row will still import.</div>':'<div style="font-size:12px;color:var(--em)">✓ All rows look good.</div>'}
  `;
}

async function runImport(){
  const wrap=$('csv-import-progress');
  if(!SB()||!ORG_ID()||typeof window.sbInsert!=='function'){
    wrap.innerHTML='<div class="alert alert-warn">Cannot import — not connected to your organisation. Refresh and try again.</div>';return;
  }
  const total=_csv.validated.length;
  let done=0,failed=0;const failures=[];
  wrap.innerHTML=`<div class="brain-panel"><div class="brain-header"><div class="brain-icon">📥</div><div><div class="brain-title">Importing ${total} participant${total===1?'':'s'}…</div><div class="brain-sub" id="csv-prog-sub">Starting…</div></div></div><div style="background:var(--bg);border-radius:8px;height:8px;overflow:hidden"><div id="csv-prog-bar" style="height:100%;width:0%;background:var(--em);transition:width .2s"></div></div></div>`;
  $('csv-next-btn').disabled=true;$('csv-back-btn').style.display='none';
  for(const rec of _csv.validated){
    try{
      const{_rowIndex,_issues,...payload}=rec;
      await window.sbInsert('participants',payload);
      done++;
    }catch(e){
      failed++;failures.push({row:rec._rowIndex,name:rec.first_name+' '+rec.last_name,error:e.message});
    }
    const prog=Math.round((done+failed)/total*100);
    const bar=$('csv-prog-bar'),sub=$('csv-prog-sub');
    if(bar)bar.style.width=prog+'%';
    if(sub)sub.textContent=(done+failed)+' of '+total+' processed · '+done+' imported';
  }
  if(typeof window.refreshTable==='function'){try{await window.refreshTable('participants');}catch(e){}}
  wrap.innerHTML=`
    <div class="alert ${failed?'alert-warn':'alert-ok'}" style="margin-bottom:14px">${failed?'⚠':'✓'} Import finished — <strong>${done}</strong> imported${failed?', <strong>'+failed+'</strong> failed':''}.</div>
    ${failed?'<div style="font-size:12px;color:var(--txt2);margin-bottom:8px">Failed rows:</div><div style="max-height:140px;overflow-y:auto;background:var(--bg);border-radius:8px;padding:10px;font-size:12px">'+failures.map(f=>'Row '+f.row+' ('+escapeHTML(f.name)+') — '+escapeHTML(f.error)).join('<br/>')+'</div>':''}
  `;
  $('csv-next-btn').disabled=false;$('csv-next-btn').textContent='Done';
}

// ═══════════════════════════════════════════════════════════════
// PERIOD-BASED REPORTING
// ═══════════════════════════════════════════════════════════════
function patchReportGenerator(){
  const tries=()=>{
    const el=$('reports-contract-list');
    if(!el)return setTimeout(tries,300);
    if($('civara-period-picker'))return;
    const picker=document.createElement('div');
    picker.id='civara-period-picker';
    picker.className='card';
    picker.innerHTML=`
      <div class="card-title">Reporting period</div>
      <div class="period-pick-row">
        <div class="form-row">
          <label>Period type</label>
          <select id="civara-period-type">
            <option value="cumulative">Cumulative (all-time)</option>
            <option value="month">Month</option>
            <option value="quarter">Quarter</option>
            <option value="custom">Custom range</option>
          </select>
        </div>
        <div class="form-row" id="civara-period-month-wrap" style="display:none">
          <label>Month</label>
          <input type="month" id="civara-period-month" value="${(new Date()).toISOString().slice(0,7)}"/>
        </div>
        <div class="form-row" id="civara-period-quarter-wrap" style="display:none">
          <label>Quarter</label>
          <select id="civara-period-quarter">${quarterOptions()}</select>
        </div>
        <div class="form-row" id="civara-period-from-wrap" style="display:none">
          <label>From</label>
          <input type="date" id="civara-period-from"/>
        </div>
        <div class="form-row" id="civara-period-to-wrap" style="display:none">
          <label>To</label>
          <input type="date" id="civara-period-to"/>
        </div>
      </div>
      <div id="civara-period-summary" style="margin-top:10px;font-size:12px;color:var(--txt3)">Reports use cumulative all-time data.</div>
    `;
    el.parentNode.insertBefore(picker,el);
    $('civara-period-type').addEventListener('change',onPeriodTypeChange);
    ['civara-period-month','civara-period-quarter','civara-period-from','civara-period-to'].forEach(id=>{
      const el=$(id);if(el)el.addEventListener('change',updatePeriodSummary);
    });
    if(typeof window.generateAIReport==='function'&&!window._civaraReportPatched){
      window._civaraReportPatched=true;
      window.generateAIReport=patchedGenerateAIReport;
    }
  };
  tries();
}

function quarterOptions(){
  const now=new Date();const year=now.getFullYear();
  const items=[];
  for(let y=year;y>=year-2;y--){
    for(let q=4;q>=1;q--){
      items.push({value:y+'-Q'+q,label:'Q'+q+' '+y+' ('+quarterRange(y,q).from+' to '+quarterRange(y,q).to+')'});
    }
  }
  const curQ=Math.floor(now.getMonth()/3)+1;
  return items.map(it=>'<option value="'+it.value+'" '+(it.value===year+'-Q'+curQ?'selected':'')+'>'+it.label+'</option>').join('');
}
function quarterRange(year,q){
  const startMonth=(q-1)*3;
  const from=new Date(year,startMonth,1);
  const to=new Date(year,startMonth+3,0);
  return{from:from.toISOString().split('T')[0],to:to.toISOString().split('T')[0]};
}
function onPeriodTypeChange(){
  const t=$('civara-period-type').value;
  ['month','quarter','from','to'].forEach(k=>{const el=$('civara-period-'+k+'-wrap');if(el)el.style.display='none';});
  if(t==='month')$('civara-period-month-wrap').style.display='block';
  else if(t==='quarter')$('civara-period-quarter-wrap').style.display='block';
  else if(t==='custom'){$('civara-period-from-wrap').style.display='block';$('civara-period-to-wrap').style.display='block';}
  updatePeriodSummary();
}
function getCurrentPeriod(){
  const t=$('civara-period-type')?.value||'cumulative';
  if(t==='cumulative')return{type:'cumulative',from:null,to:null,label:'all-time / cumulative'};
  if(t==='month'){
    const m=$('civara-period-month').value;if(!m)return{type:'cumulative',from:null,to:null,label:'all-time'};
    const[y,mo]=m.split('-').map(Number);
    const from=new Date(y,mo-1,1).toISOString().split('T')[0];
    const to=new Date(y,mo,0).toISOString().split('T')[0];
    const monName=new Date(y,mo-1,1).toLocaleDateString('en-GB',{month:'long',year:'numeric'});
    return{type:'month',from,to,label:monName};
  }
  if(t==='quarter'){
    const v=$('civara-period-quarter').value;
    const[y,q]=v.split('-Q');
    const r=quarterRange(parseInt(y),parseInt(q));
    return{type:'quarter',from:r.from,to:r.to,label:'Q'+q+' '+y};
  }
  if(t==='custom'){
    const from=$('civara-period-from').value,to=$('civara-period-to').value;
    if(!from||!to)return{type:'cumulative',from:null,to:null,label:'all-time'};
    return{type:'custom',from,to,label:from+' to '+to};
  }
  return{type:'cumulative',from:null,to:null,label:'all-time'};
}
function updatePeriodSummary(){
  const p=getCurrentPeriod();
  const s=$('civara-period-summary');if(!s)return;
  if(p.type==='cumulative')s.textContent='Reports use cumulative all-time data.';
  else s.textContent='Reports will be filtered to '+p.label+' ('+p.from+' → '+p.to+').';
}
function inPeriod(dateStr,period){
  if(period.type==='cumulative'||!period.from||!period.to)return true;
  if(!dateStr)return false;
  const d=String(dateStr).slice(0,10);
  return d>=period.from&&d<=period.to;
}
async function patchedGenerateAIReport(type,contractId){
  const progressEl=$('brain-progress'),reportEl=$('report-output');
  if(!progressEl||!reportEl)return;
  reportEl.innerHTML='';
  progressEl.scrollIntoView({behavior:'smooth',block:'start'});
  const period=getCurrentPeriod();
  const db=DB();
  const contract=db.contracts.find(c=>String(c.id)===String(contractId));
  const funder=contract?.funder_id?(db.funders||[]).find(f=>String(f.id)===String(contract.funder_id)):null;
  const orgName=CURRENT_ORG()?.name||'Organisation';
  const todayStr=new Date().toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'});
  const linked=db.participants.filter(p=>toArr(p.contract_ids).includes(String(contractId)));
  const linkedInPeriod=linked.filter(p=>inPeriod(p.last_contact||p.created_at,period));
  const linkedOutcomes=linkedInPeriod.filter(p=>p.outcomes&&p.outcomes.length>0).length;
  const jobs=linkedInPeriod.filter(p=>p.outcomes&&p.outcomes.includes('Employment')).length;
  const sustained=linkedInPeriod.filter(p=>p.stage==='Sustained').length;
  const eventsInPeriod=db.events.filter(e=>inPeriod(e.date,period));
  const fbInPeriod=db.feedback.filter(f=>{const ev=db.events.find(e=>String(e.id)===String(f.eventId));return ev?inPeriod(ev.date,period):period.type==='cumulative';});
  const avgCB=fbInPeriod.length?(fbInPeriod.reduce((a,f)=>a+num(f.cb),0)/fbInPeriod.length).toFixed(1):null;
  const avgCA=fbInPeriod.length?(fbInPeriod.reduce((a,f)=>a+num(f.ca),0)/fbInPeriod.length).toFixed(1):null;
  const periodLabel=period.type==='cumulative'?'cumulative (all activity to date)':period.label;
  const steps=[
    {label:'Filtering to '+periodLabel,meta:linkedInPeriod.length+' participants in scope · '+eventsInPeriod.length+' events'},
    {label:'Cross-checking funder requirements',meta:'Mapping data against '+(funder?.name||'funder')+' framework'},
    {label:'Writing the report',meta:'Org Brain composing narrative with your live numbers'},
    {label:'Quality Supervisor check',meta:'Verifying tone, claims and structure'},
    {label:'Ready',meta:'Report delivered — review and download below'}
  ];
  const sys='You are a professional UK bid writer producing a funder report. Write in clean formal British English. Structure with these sections in order, each beginning with ## and the section title: Executive Summary, Delivery Overview, Participant Outcomes, Distance Travelled and Wellbeing, Participant Voice, Forward Plan. Use **bold** sparingly for key statistics. 600-800 words. Use only data provided — never invent participants, outcomes or quotes. State the reporting period clearly in the Executive Summary. If a data point is not provided, omit gracefully. Do not use hashtags (#) anywhere except as section heading markers. Do not use horizontal rules or emoji.';
  const prompt=[
    'Organisation: '+orgName,
    'Report date: '+todayStr,
    'Reporting period: '+periodLabel+(period.from?(' ('+period.from+' to '+period.to+')'):''),
    'Contract: '+(contract?.name||'Unnamed contract'),
    'Funder: '+(funder?.name||'Funder'),
    'Contract value: £'+num(contract?.value).toLocaleString(),
    'Target starts: '+(contract?.target_starts||0),
    'Actual starts in period: '+linkedInPeriod.length,
    'Target outcomes: '+(contract?.target_outcomes||0),
    'Actual outcomes in period: '+linkedOutcomes,
    'Employment outcomes in period: '+jobs,
    'Sustained outcomes in period: '+sustained,
    'Events delivered in period: '+eventsInPeriod.length,
    avgCB?'Average confidence before (period): '+avgCB+' / 5':'',
    avgCA?'Average confidence after (period): '+avgCA+' / 5':'',
    'Feedback responses in period: '+fbInPeriod.length,
  ].filter(Boolean).join('\n');
  if(typeof window.runAgent!=='function'){reportEl.innerHTML='<div class="alert alert-warn">Report agent not available.</div>';return;}
  const raw=await window.runAgent({container:progressEl,headerLabel:'Org Brain — Funder Report',headerSub:'Reading your data, mapping to funder requirements, writing the report',steps,sys,prompt,maxTok:1400});
  if(!raw)return;
  const cleaned=window.cleanReportText?window.cleanReportText(raw):raw;
  const bodyHTML=window.reportTextToHTML?window.reportTextToHTML(cleaned,raw):'<pre>'+escapeHTML(cleaned)+'</pre>';
  const reportTitle=(contract?.name||'Programme Report')+' — '+orgName+' ('+periodLabel+')';
  window._lastReportText=cleaned;window._lastReportTitle=reportTitle;
  const _logoUrl=window.getOrgLogoUrl?window.getOrgLogoUrl(CURRENT_ORG()):'';
  const _headerHTML=_logoUrl
    ?'<div class="report-header-flex"><div class="report-header-text"><div class="report-meta">'+escapeHTML((funder?.name||'Funder Report')+' · '+periodLabel)+'</div><div class="report-title">'+escapeHTML(contract?.name||'Programme Report')+'</div><div class="report-subtitle">'+escapeHTML(orgName)+' · '+escapeHTML(todayStr)+'</div></div><div class="report-header-logo"><img src="'+escapeHTML(_logoUrl)+'" alt="'+escapeHTML(orgName)+'" class="org-logo-report" onerror="this.style.display=\'none\'"/></div></div>'
    :'<div class="report-header"><div class="report-meta">'+escapeHTML((funder?.name||'Funder Report')+' · '+periodLabel)+'</div><div class="report-title">'+escapeHTML(contract?.name||'Programme Report')+'</div><div class="report-subtitle">'+escapeHTML(orgName)+' · '+escapeHTML(todayStr)+'</div></div>';
  reportEl.innerHTML=
    '<div class="report-actions">'+
      '<button class="btn btn-p" id="civara-rep-pdf">⬇ Download as PDF</button>'+
      '<button class="btn btn-ghost btn-sm" id="civara-rep-copy">📋 Copy text</button>'+
      '<button class="btn btn-ghost btn-sm" id="civara-rep-regen">↻ Regenerate</button>'+
    '</div>'+
    '<div class="report-doc">'+
      _headerHTML+
      '<div class="report-body">'+bodyHTML+'</div>'+
      '<div class="report-footer">Generated by Civara · Org Brain · '+escapeHTML(todayStr)+' · Period: '+escapeHTML(periodLabel)+'</div>'+
    '</div>';
  $('civara-rep-pdf').addEventListener('click',()=>window.downloadReportPDF&&window.downloadReportPDF());
  $('civara-rep-copy').addEventListener('click',()=>window.copyReportText&&window.copyReportText());
  $('civara-rep-regen').addEventListener('click',()=>window.generateAIReport(type,contractId));
  reportEl.scrollIntoView({behavior:'smooth',block:'start'});
}

// ═══════════════════════════════════════════════════════════════
// OPPORTUNITIES FINDER
// ═══════════════════════════════════════════════════════════════
function patchOpportunitiesFinder(){
  const tries=()=>{
    if(typeof window.runBDResearch!=='function')return setTimeout(tries,300);
    if(window._civaraBDPatched)return;
    window._civaraBDPatched=true;
    window.runBDResearch=runBDResearchUpgraded;
  };
  tries();
}

async function runBDResearchUpgraded(){
  const wrap=$('bd-opps-wrap'),res=$('bd-opps-result');
  if(!wrap||!res)return;
  wrap.style.display='block';
  const area=$('bd-area').value,size=$('bd-size').value,specific=$('bd-specific').value;
  const steps=[
    {label:'Searching live funding sources',meta:area+' · '+size},
    {label:'Hunting direct tender pack URLs',meta:'gov.uk · Find a Tender · funder portals'},
    {label:'Quality Supervisor check',meta:'Verifying deadlines and links'},
    {label:'Structuring opportunities',meta:''},
    {label:'Ready',meta:''}
  ];
  const sys=`You are a UK funding researcher. After your web search, you MUST return ONLY a JSON object — no prose, no markdown, no commentary, no headings, no greetings. Your entire response must start with { and end with }.

Find 3-6 currently open funding opportunities relevant to the criteria. For each, hunt for a DIRECT downloadable tender pack URL (PDF, DOCX, or ZIP) — check gov.uk, find-tender.service.gov.uk, Contracts Finder, GLA portals, City Bridge Foundation, National Lottery, and the funder's own site. If you cannot find a direct file URL, set tender_doc_url to "" — DO NOT make one up.

Schema (return EXACTLY this shape):
{
  "opportunities": [
    {
      "funder": "string",
      "programme": "string",
      "summary": "1-2 sentences",
      "value_band": "e.g. £10k-£100k or 'Up to £500k'",
      "deadline": "YYYY-MM-DD or 'Rolling' or 'Verify on funder site'",
      "eligibility": "1 sentence",
      "fit_reason": "1-2 sentences",
      "url": "https://...",
      "tender_doc_url": "https://... or empty string"
    }
  ]
}

Use ONLY real, verifiable, currently open programmes. RETURN ONLY THE JSON OBJECT.`;
  const prompt='Area: '+area+'\nOrg size: '+size+'\nFunders or programmes of interest: '+(specific||'open to all suitable opportunities')+'\n\nReturn the JSON object now.';
  if(typeof window.runAgent!=='function'){res.innerHTML='<div class="alert alert-warn">Research agent not available.</div>';return;}
  const raw=await window.runAgent({container:res,headerLabel:'BD Manager Agent',headerSub:'Live web search · Quality Supervisor verifying results',steps,sys,prompt,maxTok:1800,webSearch:true});
  if(!raw)return;

  // ─── Robust JSON extraction ────────────────────────────────
  let opps=tryParseJSON(raw);
  // Fallback 1: if parse failed, ask the model to convert its own prose to JSON
  if(!opps){
    try{
      const fix=await window.callClaude(
        'You convert text into JSON. Return ONLY a JSON object with shape {"opportunities":[{funder, programme, summary, value_band, deadline, eligibility, fit_reason, url, tender_doc_url}]}. No prose.',
        'Convert this text into the JSON schema above. If a field is missing in the source, use an empty string. Source text:\n\n'+raw,
        1200
      );
      opps=tryParseJSON(fix);
    }catch(e){/* swallow */}
  }
  if(!opps){
    res.innerHTML='<div class="alert alert-warn"><strong>Could not parse opportunities.</strong> The agent returned text instead of JSON. <button class="btn btn-ghost btn-sm" style="margin-left:8px" onclick="window.runBDResearch()">↻ Try again</button></div><details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--txt3)">Show raw response (for debugging)</summary><pre style="font-size:11px;background:var(--bg);padding:10px;border-radius:8px;margin-top:8px;white-space:pre-wrap;word-break:break-word;max-height:300px;overflow:auto">'+escapeHTML(raw)+'</pre></details>';
    return;
  }
  if(!opps.length){res.innerHTML='<div class="alert alert-info">No open opportunities matched. Try adjusting the area or naming a specific funder.</div>';return;}
  res.innerHTML='';
  window._civaraOpps=opps;
  opps.forEach((o,i)=>{
    const card=document.createElement('div');
    card.className='tender-card';
    const hasTender=o.tender_doc_url&&/^https?:\/\//.test(o.tender_doc_url);
    const hasUrl=o.url&&/^https?:\/\//.test(o.url);
    card.innerHTML=`
      <div class="tender-card-hd">
        <div>
          <div class="tender-card-funder">${escapeHTML(o.funder||'')}</div>
          <div class="tender-card-title">${escapeHTML(o.programme||'Untitled programme')}</div>
        </div>
      </div>
      <div style="font-size:13px;color:var(--txt2);margin-bottom:8px">${escapeHTML(o.summary||'')}</div>
      <div class="tender-card-meta">
        ${o.value_band?'<span><strong>Value:</strong> '+escapeHTML(o.value_band)+'</span>':''}
        ${o.deadline?'<span><strong>Deadline:</strong> '+escapeHTML(o.deadline)+'</span>':''}
        ${o.eligibility?'<span><strong>Eligibility:</strong> '+escapeHTML(o.eligibility)+'</span>':''}
      </div>
      ${o.fit_reason?'<div style="font-size:12px;color:var(--em);background:rgba(31,111,109,.06);border-radius:6px;padding:8px 10px;margin-bottom:10px"><strong>Why it fits:</strong> '+escapeHTML(o.fit_reason)+'</div>':''}
      <div class="tender-card-actions" data-actions></div>
      <div class="civara-tender-status" data-status style="font-size:12px;color:var(--txt3);margin-top:8px"></div>
    `;
    const actions=card.querySelector('[data-actions]');
    if(hasUrl){
      const a=document.createElement('a');
      a.className='btn btn-p btn-sm';a.href=o.url;a.target='_blank';a.rel='noopener noreferrer';
     a.textContent='⬇ View on funder site';
      actions.appendChild(a);
    }
    if(hasUrl){
      const draft=document.createElement('button');
      draft.className='btn btn-ghost btn-sm';
      draft.textContent='✦ Draft EOI for this';
      draft.addEventListener('click',()=>draftEoiFor(i));
      actions.appendChild(draft);
    }
    res.appendChild(card);
  });
}

// Helper used by runBDResearchUpgraded
function tryParseJSON(text){
  if(!text)return null;
  // Strip markdown code fences
  let cleaned=text.replace(/```json|```/gi,'').trim();
  // Find the first { ... last }
  const first=cleaned.indexOf('{');
  const last=cleaned.lastIndexOf('}');
  if(first<0||last<0||last<=first)return null;
  cleaned=cleaned.slice(first,last+1);
  try{
    const parsed=JSON.parse(cleaned);
    return parsed.opportunities||[];
  }catch(e){
    return null;
  }
}
  const area=$('bd-area').value,size=$('bd-size').value,specific=$('bd-specific').value;
  const steps=[
    {label:'Searching live funding sources',meta:area+' · '+size},
    {label:'Hunting direct tender pack URLs',meta:'gov.uk · Find a Tender · funder portals'},
    {label:'Quality Supervisor check',meta:'Verifying deadlines and links'},
    {label:'Structuring opportunities',meta:''},
    {label:'Ready',meta:''}
  ];
  const sys=`You are a UK funding researcher. Find 3-6 currently open funding opportunities relevant to the criteria. For each, hunt for a DIRECT downloadable tender pack URL (PDF, DOCX, or ZIP) — check gov.uk, Find a Tender (find-tender.service.gov.uk), Contracts Finder, GLA's funding portal, City Bridge Foundation grants pages, National Lottery, and the funder's own site. If you cannot find a direct file URL, set tender_doc_url to "" — DO NOT make one up.

Return a SINGLE JSON object with no commentary, no markdown fences, no explanation. Schema:
{
  "opportunities": [
    {
      "funder": "name of funder",
      "programme": "name of programme",
      "summary": "1-2 sentence plain-English summary",
      "value_band": "e.g. £10k-£100k or 'Up to £500k'",
      "deadline": "YYYY-MM-DD or 'Rolling' or 'Verify on funder site'",
      "eligibility": "1 sentence on who can apply",
      "fit_reason": "1-2 sentences on why this fits the org",
      "url": "https://... funder programme page (always include a real URL)",
      "tender_doc_url": "https://... DIRECT link to PDF/DOCX/ZIP tender pack, or empty string if behind a portal"
    }
  ]
}
Use ONLY real, verifiable, currently open programmes.`;
  const prompt='Area: '+area+'\nOrg size: '+size+'\nFunders or programmes of interest: '+(specific||'open to all suitable opportunities');
  if(typeof window.runAgent!=='function'){res.innerHTML='<div class="alert alert-warn">Research agent not available.</div>';return;}
  const raw=await window.runAgent({container:res,headerLabel:'BD Manager Agent',headerSub:'Live web search · Quality Supervisor verifying results',steps,sys,prompt,maxTok:1500,webSearch:true});
  if(!raw)return;
  let opps=[];
  try{
    const cleaned=raw.replace(/```json|```/gi,'').trim();
    const m=cleaned.match(/\{[\s\S]*\}/);
    if(!m)throw new Error('No JSON found in agent response.');
    const parsed=JSON.parse(m[0]);
    opps=parsed.opportunities||[];
  }catch(e){
    res.innerHTML='<div class="alert alert-warn">Could not parse opportunities (the agent responded with free text rather than JSON). Try again — usually fine on retry.</div>';
    return;
  }
  if(!opps.length){res.innerHTML='<div class="alert alert-info">No open opportunities matched. Try adjusting the area or naming a specific funder.</div>';return;}
  res.innerHTML='';
  window._civaraOpps=opps;
  opps.forEach((o,i)=>{
    const card=document.createElement('div');
    card.className='tender-card';
    const hasTender=o.tender_doc_url&&/^https?:\/\//.test(o.tender_doc_url);
    const hasUrl=o.url&&/^https?:\/\//.test(o.url);
    card.innerHTML=`
      <div class="tender-card-hd">
        <div>
          <div class="tender-card-funder">${escapeHTML(o.funder||'')}</div>
          <div class="tender-card-title">${escapeHTML(o.programme||'Untitled programme')}</div>
        </div>
      </div>
      <div style="font-size:13px;color:var(--txt2);margin-bottom:8px">${escapeHTML(o.summary||'')}</div>
      <div class="tender-card-meta">
        ${o.value_band?'<span><strong>Value:</strong> '+escapeHTML(o.value_band)+'</span>':''}
        ${o.deadline?'<span><strong>Deadline:</strong> '+escapeHTML(o.deadline)+'</span>':''}
        ${o.eligibility?'<span><strong>Eligibility:</strong> '+escapeHTML(o.eligibility)+'</span>':''}
      </div>
      ${o.fit_reason?'<div style="font-size:12px;color:var(--em);background:rgba(31,111,109,.06);border-radius:6px;padding:8px 10px;margin-bottom:10px"><strong>Why it fits:</strong> '+escapeHTML(o.fit_reason)+'</div>':''}
      <div class="tender-card-actions" data-actions></div>
      <div class="civara-tender-status" data-status style="font-size:12px;color:var(--txt3);margin-top:8px"></div>
    `;
    const actions=card.querySelector('[data-actions]');
    if(hasUrl){
      const a=document.createElement('a');
      a.className='btn btn-p btn-sm';a.href=o.url;a.target='_blank';a.rel='noopener noreferrer';
      a.textContent='↗ Open funder page';
      actions.appendChild(a);
    }
    if(hasTender){
      const dl=document.createElement('button');
      dl.className='btn btn-ghost btn-sm';
      dl.textContent='⬇ Download tender pack';
      dl.addEventListener('click',()=>fetchTenderInto(card,o.tender_doc_url,o.programme||'tender'));
      actions.appendChild(dl);
    }else{
      const note=document.createElement('span');
      note.style.cssText='font-size:11px;color:var(--txt3);align-self:center';
      note.textContent='Pack only available via funder portal — open the page to register.';
      actions.appendChild(note);
    }
    if(hasUrl){
      const draft=document.createElement('button');
      draft.className='btn btn-ghost btn-sm';
      draft.textContent='✦ Draft EOI for this';
      draft.addEventListener('click',()=>draftEoiFor(i));
      actions.appendChild(draft);
    }
    res.appendChild(card);
  });
}

async function fetchTenderInto(card,url,filename){
  const status=card.querySelector('[data-status]');
  if(!status)return;
  status.innerHTML='<span style="color:var(--purple)">Fetching tender pack…</span>';
  try{
    const sb=SB();
    if(!sb)throw new Error('Not signed in.');
    const{data:{session}}=await sb.auth.getSession();
    const token=session?.access_token;
    const r=await fetch('/api/fetch-tender?url='+encodeURIComponent(url),{headers:{'Authorization':token?'Bearer '+token:''}});
    if(!r.ok){
      const err=await r.json().catch(()=>({error:'HTTP '+r.status}));
      throw new Error(err.error||'HTTP '+r.status);
    }
    const blob=await r.blob();
    const safeName=(filename||'tender').replace(/[^a-z0-9 \-_]/gi,'').slice(0,80)||'tender';
    const ext=(url.match(/\.(pdf|docx?|xlsx?|zip)(\?|$)/i)?.[1]||'pdf').toLowerCase();
    const a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download=safeName+'.'+ext;
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(a.href),5000);
    status.innerHTML='<span style="color:var(--em)">✓ Downloaded.</span>';
  }catch(e){
    status.innerHTML='<span style="color:var(--red)">⚠ Could not fetch ('+escapeHTML(e.message)+'). Try the funder page link instead.</span>';
  }
}

function draftEoiFor(idx){
  const o=(window._civaraOpps||[])[idx];if(!o)return;
  if(typeof window.go==='function')window.go('bd');
  setTimeout(()=>{
    const fEl=$('eoi-funder'),bEl=$('eoi-brief');
    if(fEl)fEl.value=(o.funder||'')+(o.programme?' — '+o.programme:'');
    if(bEl){
      bEl.value=[
        o.summary||'',
        '',
        'Value: '+(o.value_band||'TBC'),
        'Deadline: '+(o.deadline||'TBC'),
        'Eligibility: '+(o.eligibility||'TBC'),
        '',
        'Funder URL: '+(o.url||''),
        'Tender doc: '+(o.tender_doc_url||'(see funder page)')
      ].join('\n');
    }
    bEl?.scrollIntoView({behavior:'smooth',block:'center'});
  },300);
}

})();
