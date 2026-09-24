'use strict';
// Fill-gaps-only sync from the owner's Daily_Work_Done updated.xlsx:
//  - hours: set ONLY where the system entry has 0 hours and the file has a time
//  - outside_labour: set ONLY where the system entry has none and the file has a value
// Never overwrites an existing system value; never inserts (no duplicates).
const ExcelJS = require('exceljs');
const { get, all, run, tx } = require('../src/db');
const aliases = require('../src/lib/aliases');
const APPLY = process.argv.includes('--apply');

function cv(c){ const v=c.value; if(v&&typeof v==='object'){ if(v.result!==undefined)return v.result; if(v.richText)return v.richText.map(t=>t.text).join(''); if(v.text!==undefined)return v.text; } return v; }
function dateOf(v){
  if(v==null||v==='') return null;
  if(v instanceof Date) return v.toISOString().slice(0,10);
  const s=String(v).trim();
  let m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m) return m[1]+'-'+m[2]+'-'+m[3];
  m=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if(m) return m[3]+'-'+String(m[1]).padStart(2,'0')+'-'+String(m[2]).padStart(2,'0');
  return null;
}
const normV = (s) => aliases.normalize(String(s||'')) || String(s||'').trim().toLowerCase();
const normD = (s) => String(s||'').toLowerCase().replace(/\s+/g,' ').replace(/[.,;\s]+$/,'').trim();

(async()=>{
  const wb=new ExcelJS.Workbook();
  await wb.xlsx.readFile('D:/Yohan/WS DOC/Daily Work Done/Daily_Work_Done updated.xlsx');
  const ws=wb.getWorksheet('From 1st Dec2025');
  const fileRows=[];
  for(let r=2;r<=ws.rowCount;r++){
    const date=dateOf(cv(ws.getCell(r,1)));
    const veh=String(cv(ws.getCell(r,2))||'').trim();
    const desc=String(cv(ws.getCell(r,3))||'').trim();
    const hours=Number(cv(ws.getCell(r,5)));
    const outside=Number(cv(ws.getCell(r,6)));
    if(!date || (!veh && !desc)) continue;
    fileRows.push({row:r, date, veh, desc, hours:Number.isFinite(hours)?hours:null, outside:Number.isFinite(outside)&&outside>0?outside:null});
  }
  const dates=fileRows.map(x=>x.date).sort();
  console.log('file rows:', fileRows.length, '| date range:', dates[0], '..', dates[dates.length-1]);
  console.log('rows with outside value:', fileRows.filter(x=>x.outside).length, '| outside sum:', fileRows.reduce((a,b)=>a+(b.outside||0),0));

  // DB entries with vehicle context, keyed date|vehnorm|descnorm (queue per key for multiset pairing)
  const db=all(`SELECT w.id, w.work_date, w.hours, w.outside_labour, w.description, w.job_id,
                       a.registration reg, a.code code, a.ec_code ec
                  FROM job_daily_work w
                  LEFT JOIN job_cards j ON j.id=w.job_id
                  LEFT JOIN assets a ON a.id=j.asset_id`);
  const byKey=new Map();
  const push=(k,e)=>{ if(!byKey.has(k)) byKey.set(k,[]); byKey.get(k).push(e); };
  for(const e of db){
    const d=String(e.work_date||'').slice(0,10), dd=normD(e.description);
    for(const v of new Set([normV(e.reg), normV(e.code), normV(e.ec)].filter(Boolean))) push(d+'|'+v+'|'+dd, e);
  }
  const plan={ hour_fills:[], outside_sets:[], matched:0, already_ok:0, unmatched:[], conflicts:0 };
  for(const f of fileRows){
    const k=f.date+'|'+normV(f.veh)+'|'+normD(f.desc);
    const q=byKey.get(k);
    const e=q && q.length ? q.shift() : null;
    if(!e){ plan.unmatched.push(f); continue; }
    plan.matched++;
    let did=false;
    if(f.hours!=null && f.hours>0){
      if(!(Number(e.hours)>0)){ plan.hour_fills.push({id:e.id, job_id:e.job_id, date:f.date, veh:f.veh, hours:f.hours}); did=true; }
      else if(Number(e.hours)!==f.hours) plan.conflicts++;
    }
    if(f.outside!=null && !(Number(e.outside_labour)>0)){ plan.outside_sets.push({id:e.id, date:f.date, veh:f.veh, outside:f.outside}); did=true; }
    if(!did) plan.already_ok++;
  }
  console.log('\n--- PLAN ---');
  console.log('matched entries:', plan.matched, '| already ok:', plan.already_ok);
  console.log('hours to FILL (system=0):', plan.hour_fills.length);
  console.log('outside values to SET (system empty):', plan.outside_sets.length, '| sum:', plan.outside_sets.reduce((a,b)=>a+b.outside,0));
  console.log('hour conflicts (system value differs — UNTOUCHED):', plan.conflicts);
  console.log('unmatched file rows (NOT inserted):', plan.unmatched.length);
  const um=plan.unmatched; if(um.length){
    const byMonth={}; um.forEach(x=>{ const m=x.date.slice(0,7); byMonth[m]=(byMonth[m]||0)+1; });
    console.log('  unmatched by month:', JSON.stringify(byMonth));
    console.log('  samples:', um.slice(0,6).map(x=>x.date+' '+x.veh+' "'+x.desc.slice(0,25)+'"').join(' | '));
  }
  console.log('hour-fill samples:', plan.hour_fills.slice(0,6).map(x=>x.date+' '+x.veh+' +'+x.hours+'h').join(' | '));
  console.log('outside samples:', plan.outside_sets.slice(0,6).map(x=>x.date+' '+x.veh+' Rs'+x.outside).join(' | '));

  if(!APPLY){ console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return; }
  const costing=require('../src/lib/costing');
  const jobs=new Set();
  tx(()=>{
    for(const h of plan.hour_fills){ run('UPDATE job_daily_work SET hours=? WHERE id=?', h.hours, h.id); if(h.job_id) jobs.add(h.job_id); }
    for(const o of plan.outside_sets){ run('UPDATE job_daily_work SET outside_labour=? WHERE id=?', o.outside, o.id); }
  });
  for(const jid of jobs) costing.refreshJobTotals(jid);
  console.log('\nAPPLIED: hours filled', plan.hour_fills.length, '| outside set', plan.outside_sets.length, '| jobs recomputed', jobs.size);
})().catch(e=>{console.error('ERROR',e.message,e.stack);process.exit(1)});
