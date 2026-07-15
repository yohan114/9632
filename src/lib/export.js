'use strict';

const ExcelJS = require('exceljs');

/**
 * Stream an .xlsx download built from one or more sheets.
 * @param res  Express response
 * @param filename  e.g. "asset-costs.xlsx"
 * @param sheets  [{ name, columns:[{header,key,width?}], rows:[{...}] }]
 */
async function sendXlsx(res, filename, sheets) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkshopOne';
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name || 'Sheet');
    ws.columns = (s.columns || []).map((c) => ({ header: c.header, key: c.key, width: c.width || 18 }));
    ws.getRow(1).font = { bold: true };
    for (const row of s.rows || []) ws.addRow(row);
  }
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  await wb.xlsx.write(res);
  res.end();
}

module.exports = { sendXlsx };
