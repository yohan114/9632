'use strict';

// WorkshopOne — Broadcast Maintenance Warning Script
// Usage:
//   node scripts/broadcast_maintenance.js [seconds] [message] [--no-wait]
// Example:
//   node scripts/broadcast_maintenance.js 120 "System update in 2 minutes. Please save all files and log out."

const http = require('http');
const config = require('../src/config');

const args = process.argv.slice(2);
let seconds = 120;
let message = 'The system will update in 2 minutes. Please save all files, complete your current tasks, and log out now.';
let waitAfter = true;

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--no-wait') {
    waitAfter = false;
  } else if (!isNaN(Number(arg)) && i === 0) {
    seconds = Math.max(5, parseInt(arg, 10));
  } else if (typeof arg === 'string' && !arg.startsWith('--')) {
    message = arg;
  }
}

const payload = JSON.stringify({
  seconds,
  title: '⚠️ SYSTEM UPDATE NOTICE',
  message
});

const port = process.env.PORT || config.port || 1929;
const postOptions = {
  hostname: '127.0.0.1',
  port: port,
  path: '/api/system/maintenance-broadcast',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-System-Secret': config.sessionSecret
  }
};

console.log('\n======================================================');
console.log('📣 WORKSHOPONE: BROADCASTING MAINTENANCE WARNING');
console.log('======================================================');
console.log(`Target:       http://127.0.0.1:${port}/api/system/maintenance-broadcast`);
console.log(`Countdown:    ${seconds} seconds (${Math.ceil(seconds / 60)} minutes)`);
console.log(`Message:      "${message}"`);
console.log('------------------------------------------------------');

const req = http.request(postOptions, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      console.log('✅ BROADCAST DELIVERED SUCCESSFULLY to all active browser sessions!');
      console.log('   All users now see the high-visibility alert & countdown on their screens.\n');

      if (!waitAfter) {
        process.exit(0);
      }

      console.log(`⏳ Waiting ${seconds} seconds for users to finish saving and log out...`);
      console.log('   (Press Ctrl+C to abort update)\n');

      let remaining = seconds;
      const timer = setInterval(() => {
        remaining -= 5;
        if (remaining > 0) {
          const mins = Math.floor(remaining / 60);
          const secs = remaining % 60;
          const display = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
          process.stdout.write(`   ⏱️  ${display} remaining...\r`);
        } else {
          clearInterval(timer);
          console.log('\n\n✅ 2-minute countdown complete. All users given grace period.');
          console.log('🚀 Proceeding to system restart & update.\n');
          process.exit(0);
        }
      }, 5000);
    } else {
      console.error(`❌ Broadcast failed with status ${res.statusCode}:`, body);
      process.exit(1);
    }
  });
});

req.on('error', (err) => {
  console.error(`❌ Could not connect to running server at http://127.0.0.1:${port}:`, err.message);
  console.log('ℹ️  If the server is stopped, you can continue directly with the update.');
  process.exit(0);
});

req.write(payload);
req.end();
