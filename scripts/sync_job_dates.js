'use strict';
// Sync job start (requested_at) + close (completed_at/status) dates from the owner's updated
// Job Record.xlsx (Requested job + C-job sheets). Update-only-what-changed; create only jobs
// whose job number doesn't exist (normalized: leading zeros in segments ignored). No duplicates.
const ExcelJS = require('exceljs');
const { get, all, run, tx } = require('../src/db');
const aliases = require('../src/lib/aliases');
const APPLY = process.argv.includes('--apply');

function cv(c){ const v=c.value; if(v&&typeof v==='object'){ if(v.result!==undefined)return v.result; if(v.richText)return v.richText.map(t=>t.text).join(''); if(v.text!==undefined)return v.text; } return v; }
function dateOf(v){
  if(v==null||v==='') return null;
  if(v instanceof Date) return v.toISOString().slice(0,10);
  const s=String(v).trim(); const iso=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(iso) return iso[1]+'-'+iso[2]+'-'+iso[3];
  const d=new Date(s); return isNaN(d.getTime())?null:d.toISOString().slice(0,10);
}
const normJob = (s) => String(s||'').trim().split('/').map(t=>{t=t.trim(); return /^\d+$/.test(t)?String(parseInt(t,10)):t.toUpperCase();}).join('/');
const jobType = (jn) => /\/S\//i.test(jn) ? 'service' : 'repair';
function lookupAsset(v){
  const n=aliases.normalize(v); if(!n) return null;
  const a=get('SELECT id FROM assets WHERE code_norm=?',n); if(a) return a.id;
  const al=get('SELECT asset_id FROM asset_aliases WHERE raw_norm=? AND resolved=1 AND asset_id IS NOT NULL',n);
  return al?al.asset_id:null;
}

(async()=>{
  const wb=new ExcelJS.Workbook();
  await wb.xlsx.readFile('D:/Yohan/WS DOC/WS Main Records/Job Record.xlsx');

  // sheet job map: normKey -> {job_no, start, end, vehicle, desc, site, ref, cost}
  const sheet=new Map();
  const takeRow=(jobNo, start, end, vehicle, desc, site, ref, cost, fromCjob)=>{
    if(!jobNo || !/\d{4}\//.test(jobNo)) return;
    const k=normJob(jobNo);
    const cur=sheet.get(k)||{job_no:jobNo};
    if(start && !cur.start) cur.start=start;
    // C-job's End is the curated close date — it wins; Requested End fills gaps.
    if(end && (fromCjob || !cur.end)) cur.end=end;
    if(vehicle && !cur.vehicle) cur.vehicle=vehicle;
    if(desc && !cur.desc) cur.desc=desc;
    if(site && !cur.site) cur.site=site;
    if(fromCjob){ cur.ref=ref||cur.ref; cur.cost=cost!=null?cost:cur.cost; cur.in_cjob=true; }
    sheet.set(k,cur);
  };
  const rq=wb.getWorksheet('Requested job');
  for(let r=2;r<=rq.rowCount;r++){
    takeRow(String(cv(rq.getCell(r,1))||'').trim(), dateOf(cv(rq.getCell(r,4))), dateOf(cv(rq.getCell(r,5))),
      String(cv(rq.getCell(r,2))||'').trim(), String(cv(rq.getCell(r,3))||'').trim(), String(cv(rq.getCell(r,6))||'').trim(), null, null, false);
  }
  const cj=wb.getWorksheet('C-job');
  for(let r=2;r<=cj.rowCount;r++){
    const cost=Number(cv(cj.getCell(r,8))); 
    takeRow(String(cv(cj.getCell(r,1))||'').trim(), dateOf(cv(cj.getCell(r,5))), dateOf(cv(cj.getCell(r,6))),
      String(cv(cj.getCell(r,3))||'').trim(), String(cv(cj.getCell(r,4))||'').trim(), String(cv(cj.getCell(r,9))||'').trim(),
      String(cv(cj.getCell(r,2))||'').trim(), Number.isFinite(cost)?cost:null, true);
  }
  console.log('sheet jobs (unique normalized):', sheet.size);

  // DB job map by normalized number; detect collisions
  const dbByNorm=new Map(); let collisions=0;
  for(const j of all('SELECT id, job_no, status, requested_at, completed_at FROM job_cards')){
    const k=normJob(j.job_no);
    if(dbByNorm.has(k)) collisions++;
    else dbByNorm.set(k,j);
  }
  console.log('db jobs:', dbByNorm.size, '| normalized collisions in DB:', collisions);

  const HOLD=new Set(['2026/5/R/281']); // End=Start slip: 68,975 of labour dated AFTER that close — owner to confirm real date
  const plan={ start_updates:[], close_updates:[], newly_closed:[], creates:[], held:[], reopen_skipped:0, identical:0, unlinked:[] };
  for(const [k,s] of sheet){
    const dbj=dbByNorm.get(k);
    if(!dbj){ plan.creates.push(s); continue; }
    let touched=false;
    const dbStart=String(dbj.requested_at||'').slice(0,10), dbEnd=String(dbj.completed_at||'').slice(0,10);
    if(s.start && s.start!==dbStart){ plan.start_updates.push({id:dbj.id, job_no:dbj.job_no, from:dbStart||'-', to:s.start}); touched=true; }
    if(s.end && HOLD.has(normJob(k))){ plan.held.push(dbj.job_no+' end='+s.end); }
    else if(s.end){
      if(s.end!==dbEnd){ plan.close_updates.push({id:dbj.id, job_no:dbj.job_no, from:dbEnd||'-', to:s.end, was:dbj.status}); touched=true; }
      if(dbj.status!=='CLOSED') plan.newly_closed.push(dbj.job_no);
    } else if(dbj.status==='CLOSED'){ plan.reopen_skipped++; }
    if(!touched) plan.identical++;
  }
  console.log('\n--- PLAN ---');
  console.log('identical (no change):', plan.identical);
  console.log('start-date updates:', plan.start_updates.length);
  console.log('close-date updates:', plan.close_updates.length, '| of which newly CLOSED:', plan.newly_closed.length);
  console.log('sheet-closed but DB-closed-with-no-sheet-end (left untouched):', plan.reopen_skipped);
  console.log('NEW jobs to create:', plan.creates.length);
  console.log('\nsample start updates:', plan.start_updates.slice(0,5).map(x=>x.job_no+' '+x.from+'->'+x.to).join(' | '));
  console.log('sample close updates:', plan.close_updates.slice(0,5).map(x=>x.job_no+' '+x.from+'->'+x.to+' ['+x.was+']').join(' | '));
  console.log('newly closed sample:', plan.newly_closed.slice(0,10).join(', '));
  console.log('creates sample:', plan.creates.slice(0,8).map(x=>x.job_no+' ('+(x.vehicle||'-')+') end='+(x.end||'-')).join(' | '));

  if(!APPLY){ console.log('\nDRY RUN — nothing written. Re-run with --apply.'); return; }

  const costing=require('../src/lib/costing');
  let sU=0,cU=0,cr=0;
  tx(()=>{
    for(const u of plan.start_updates){ run('UPDATE job_cards SET requested_at=? WHERE id=?', u.to, u.id); sU++; }
    for(const u of plan.close_updates){ run(`UPDATE job_cards SET completed_at=?, closed_at=?, status='CLOSED', updated_at=datetime('now') WHERE id=?`, u.to, u.to, u.id); cU++; }
    for(const s of plan.creates){
      const assetId=lookupAsset(s.vehicle);
      if(!assetId && s.vehicle) plan.unlinked.push(s.vehicle);
      run(`INSERT INTO job_cards (job_no, legacy_ref, asset_id, type, description, site, status, requested_at, completed_at, closed_at, total_cost, is_historical, requested_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'imported')`,
        s.job_no, s.ref||null, assetId||null, jobType(s.job_no), s.desc||null, s.site||null,
        s.end?'CLOSED':'REQUESTED', s.start||s.end||new Date().toISOString().slice(0,10), s.end||null, s.end||null, s.cost||0);
      cr++;
    }
  });
  // refresh totals for jobs whose status changed to CLOSED now (stored components stay reconciled)
  for(const jn of plan.newly_closed){ const j=get('SELECT id FROM job_cards WHERE job_no=?', jn); if(j) costing.refreshJobTotals(j.id); }
  console.log('\nAPPLIED: start updates', sU, '| close updates', cU, '| created', cr);
  if(plan.unlinked.length) console.log('unlinked vehicles on created jobs:', [...new Set(plan.unlinked)].slice(0,10).join(', '));
})().catch(e=>{console.error('ERROR',e.message,e.stack);process.exit(1)});
