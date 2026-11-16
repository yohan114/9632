'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

test('vehicle_documents: getUpcomingExpirations handles multidb mode with workshopId without crashing', () => {
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vdocs-multidb-'));
  try {
    fs.cpSync('d:\\Master system 1\\data', path.join(TMP, 'data'), { recursive: true });
    process.env.MULTIDB = '1';
    process.env.DB_PATH = path.join(TMP, 'data', 'workshopone.db');

    const vdocs = require('../src/lib/vehicle_documents');
    
    // Call getUpcomingExpirations with workshopId=1 in multidb mode
    const list = vdocs.getUpcomingExpirations({ daysAhead: 60, workshopId: 1 });
    assert(Array.isArray(list), 'should return an array of expiring documents');

    // Also call with null workshopId
    const allSitesList = vdocs.getUpcomingExpirations({ daysAhead: 60, workshopId: null });
    assert(Array.isArray(allSitesList), 'should return array for all sites');

    // And call getFleetComplianceSummary with workshopId=1
    const summary = vdocs.getFleetComplianceSummary({ workshopId: 1 });
    assert(summary && summary.kpis, 'compliance summary should have KPIs');
  } finally {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  }
});
