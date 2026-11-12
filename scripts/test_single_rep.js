const http = require('http');

async function testSingle() {
  const loginRes = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: 1949, path: '/api/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ headers: res.headers, body: JSON.parse(d) }));
    });
    // Credentials from the environment, never from this file: WO_USER=admin WO_PASSWORD=... node scripts/test_single_rep.js
    if (!process.env.WO_PASSWORD) throw new Error('Set WO_PASSWORD (and WO_USER if not admin).');
    req.write(JSON.stringify({ username: process.env.WO_USER || 'admin', password: process.env.WO_PASSWORD }));
    req.end();
  });

  const cookie = loginRes.headers['set-cookie'].map(c => c.split(';')[0]).join('; ');

  const rep = await new Promise((resolve, reject) => {
    http.get({
      hostname: 'localhost', port: 1949, path: '/api/vehicle-costing/single-vehicle?asset_id=1&month=2026-08',
      headers: { Cookie: cookie }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve(JSON.parse(d)));
    });
  });

  console.log('Single vehicle report keys:', Object.keys(rep));
  console.log('asset:', rep.asset);
  console.log('totals:', rep.totals);
  console.log('financial:', rep.financial);
}

testSingle().catch(console.error);
