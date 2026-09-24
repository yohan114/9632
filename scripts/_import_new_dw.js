'use strict';
// Import the NEW daily-work entries (work_date > 2026-07-19) from Daily_Work_Done updated.xlsx.
// Those days have zero entries in the system, so inserting cannot duplicate. Attachment follows
// the manual-entry flow: vehicle's open/nearest job; unresolved vehicle / equipment -> GENERAL-WS.
const ExcelJS = require('exceljs');
const { get, all, run, tx } = require('../src/db');
const aliases = require('../src/lib/aliases');
const mechanics = require('../src/lib/mechanics');
const costing = require('../src/lib/costing');
const APPLY = process.argv.includes('--apply');
const CUTOFF = '2026-07-19';

function cv(c){ const v=c.value; if(v&&typeof v==='object'){ if(v.result!==undefined)return v.result; if(v.richText)return v.richText.map(t=>t.text).join(''); if(v.text!==undefined)return v.text; } return v; }
function dateOf(v){
  if(v==null||v==='') return null;
  if(v instanceof Date) return v.toISOString().slice(0,10);
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m) return m[1]+'-'+m[2]+'-'+m[3];
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if(m) return m[3]+'-'+String(m[1]).padStart(2,'0')+'-'+String(m[2]).padStart(2,'0');
  return null;
}
function lookupAsset(v){
  const n=aliases.normalize(String(v||'')); if(!n) return null;
  const a=get('SELECT id FROM assets WHERE code_norm=?',n); if(a) return a.id;
  const al=get('SELECT asset_id FROM asset_aliases WHERE raw_norm=? AND resolved=1 AND asset_id IS NOT NULL',n);
  return al?al.asset_id:null;
}
// The live screen owns this rule — import it rather than keeping a second copy, which is
// how the unbounded version survived here after the screen was fixed.
const { jobForEntry } = require('../src/routes/dailywork');

function generalWorkshopJob(){
  const j=get("SELECT id FROM job_cards WHERE legacy_ref='general-workshop' LIMIT 1");
  return j.id;
}

(async()=>{
  const wb=new ExcelJS.Workbook();
  await wb.xlsx.readFile('D:/Yohan/WS DOC/Daily Work Done/Daily_Work_Done updated.xlsx');
  const ws=wb.getWorksheet('From 1st Dec2025');
  const rows=[];
  for(let r=2;r<=ws.rowCount;r++){
    const date=dateOf(cv(ws.getCell(r,1)));
    if(!date || date<=CUTOFF) continue;
    const veh=String(cv(ws.getCell(r,2))||'').trim();
    const desc=String(cv(ws.getCell(r,3))||'').trim();
    const mech=String(cv(ws.getCell(r,4))||'').trim()||null;
    const hours=Number(cv(ws.getCell(r,5))); const outside=Number(cv(ws.getCell(r,6)));
    if(!veh && !desc) continue;
    rows.push({date, veh, desc, mech, hours:Number.isFinite(hours)?hours:0, outside:Number.isFinite(outside)&&outside>0?outside:null});
  }
  console.log('new rows to import:', rows.length, '| dates', rows[0] && rows[0].date, '..', rows[rows.length-1] && rows[rows.length-1].date);

  const plan={ real:0, general:0, noJobVeh:[], byJob:new Map() };
  for(const x of rows){
    const assetId=lookupAsset(x.veh);
    let jobId=null, label='';
    if(assetId){ const j=jobForEntry(assetId, x.date); if(j){ jobId=j.id; label=j.job_no; plan.real++; } }
    if(!jobId){
      jobId=generalWorkshopJob(); label='GENERAL-WS'; plan.general++;
      if(assetId===null && x.veh) plan.noJobVeh.push(x.veh);
      // keep the vehicle visible when it rides on the general job
      if(x.veh) x.desc = (x.veh + ' — ' + x.desc).trim();
    }
    x.jobId=jobId;
    plan.byJob.set(label,(plan.byJob.get(label)||0)+1);
  }
  console.log('attached to real vehicle jobs:', plan.real, '| to GENERAL-WS:', plan.general);
  console.log('unmatched vehicle names -> GENERAL-WS:', [...new Set(plan.noJobVeh)].join(', ') || '(none)');
  const top=[...plan.byJob.entries()].sort((a,b)=>b[1]-a[1]).slice(0,8);
  console.log('top jobs:', top.map(([k,v])=>k+' x'+v).join(' | '));
  console.log('hours total:', rows.reduce((a,b)=>a+b.hours,0), '| outside total:', rows.reduce((a,b)=>a+(b.outside||0),0));

  if(!APPLY){ console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return; }
  const jobs=new Set();
  tx(()=>{
    for(const x of rows){
      run(`INSERT INTO job_daily_work (job_id, work_date, mechanic, description, hours, is_external, external_value, outside_labour)
           VALUES (?, ?, ?, ?, ?, 0, 0, ?)`, x.jobId, x.date, x.mech, x.desc||null, x.hours, x.outside);
      jobs.add(x.jobId);
    }
  });
  for(const jid of jobs) costing.refreshJobTotals(jid);
  for(const m of new Set(rows.map(x=>x.date.slice(0,7)))) mechanics.syncJobLabourForMonth(m);
  console.log('\nAPPLIED: inserted', rows.length, 'entries across', jobs.size, 'jobs; labour synced for', [...new Set(rows.map(x=>x.date.slice(0,7)))].join(', '));
})().catch(e=>{console.error('ERROR',e.message,e.stack);process.exit(1)});
