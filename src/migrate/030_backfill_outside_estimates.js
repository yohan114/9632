'use strict';

const ExcelJS = require('exceljs');
const path = require('path');
const { all, run, tx } = require('../db');

async function backfill() {
  const wb = new ExcelJS.Workbook();
  const filePath = path.join(__dirname, '../../June_Bill.xlsx');
  await wb.xlsx.readFile(filePath);

  const repairSheet = wb.getWorksheet('Repair cost');
  const serviceSheet = wb.getWorksheet('Service cost');

  const repairUpdates = [];
  const serviceUpdates = [];

  // 1. Repair cost sheet
  for (let r = 7; r <= 120; r++) {
    const row = repairSheet.getRow(r);
    const jobNo = String(row.getCell(3).value || '').trim();
    if (!jobNo || !jobNo.includes('/R/')) continue;
    
    const remCell = row.getCell(14); // Remarks / Outside estimate
    let val = 0;
    if (remCell.value != null) {
      if (typeof remCell.value === 'object' && remCell.value.result !== undefined) {
        val = Number(remCell.value.result) || 0;
      } else {
        val = Number(remCell.value) || 0;
      }
    }
    if (val > 0) {
      repairUpdates.push({ jobNo, val });
    }
  }

  // 2. Service cost sheet
  for (let r = 6; r <= 31; r++) {
    const row = serviceSheet.getRow(r);
    const jobNo = String(row.getCell(3).value || '').trim();
    if (!jobNo) continue;

    const outCell = row.getCell(15); // Outside Value Without Transport
    let val = 0;
    if (outCell.value != null) {
      if (typeof outCell.value === 'object' && outCell.value.result !== undefined) {
        val = Number(outCell.value.result) || 0;
      } else {
        val = Number(outCell.value) || 0;
      }
    }
    if (val > 0) {
      serviceUpdates.push({ jobNo, val });
    }
  }

  console.log(`Found ${repairUpdates.length} repair outside estimates and ${serviceUpdates.length} service outside estimates.`);

  tx(() => {
    let repCount = 0;
    for (const item of repairUpdates) {
      const info = run('UPDATE job_cards SET outside_estimate = ? WHERE job_no = ?', item.val, item.jobNo);
      if (info.changes > 0) repCount++;
    }

    let svcCount = 0;
    for (const item of serviceUpdates) {
      const info = run('UPDATE service_jobs SET outside_estimate = ? WHERE job_no = ?', item.val, item.jobNo);
      if (info.changes > 0) svcCount++;
    }

    console.log(`Updated ${repCount} job_cards rows and ${svcCount} service_jobs rows in DB.`);
  });
}

if (require.main === module) {
  backfill().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}

module.exports = backfill;
