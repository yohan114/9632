'use strict';

// Why did the server stop? This writes the answer to a file.
//
// The office server runs in a console window (start_server.bat). When it stopped on its own there
// was nothing to go on: the window had closed, and whatever was printed went with it. So every
// start, every stop and every crash is appended to a log file (config.crashLog, default
// logs/workshopone-crash.log) with the time, the process id and — for a crash — the full error.
//
// A CRASH ENDS THE PROCESS. After an uncaught exception Node's own advice is to log and exit: the
// process may be half-broken (a request abandoned mid-way, a timer that never fires again), and
// carrying on hides the fault instead of fixing it. The exit code is 1, so whatever started the
// server can see it failed — systemd restarts it on the VPS, and start_server.bat reports
// "Server stopped with error code 1" and keeps its window open.
//
// A NORMAL STOP IS NOT A CRASH. Ctrl+C, closing the window, or `systemctl stop` is logged as a stop
// with the reason, the database is closed cleanly, and the exit code is 0.
//
// Installed only when the server is started for real (src/server.js, require.main === module):
// the tests load the server too, and must not have their own failures turned into exits.

const fs = require('fs');
const path = require('path');

function install({ file, onStop } = {}) {
  const write = (msg) => {
    const line = `[${new Date().toISOString()}] pid ${process.pid} ${msg}\n`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line);
    } catch (e) { /* a log that cannot be written must not become a second crash */ }
    return line;
  };
  const errText = (err) => (err && err.stack) || String(err);

  let stopping = false;
  const crash = (kind) => (err) => {
    if (stopping) return;
    stopping = true;
    console.error(write(`CRASHED — ${kind}: ${errText(err)}`));
    process.exitCode = 1;
    process.exit(1);
  };
  process.on('uncaughtException', crash('uncaught exception'));
  process.on('unhandledRejection', crash('unhandled promise rejection'));

  // SIGHUP is what Windows sends when the console window is closed; SIGINT is Ctrl+C;
  // SIGTERM is systemd / pm2 / taskkill without /F.
  const reasons = { SIGINT: 'Ctrl+C', SIGTERM: 'asked to stop (service stop / restart)', SIGHUP: 'console window closed' };
  for (const sig of Object.keys(reasons)) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      write(`STOPPED — ${reasons[sig]} (${sig})`);
      try { if (onStop) onStop(); } catch (e) { write(`  (while stopping: ${errText(e)})`); }
      process.exit(0);
    });
  }

  process.on('exit', (code) => { write(`EXIT code ${code}`); });

  // A process that is killed outright (Task Manager, taskkill /F, a power cut, the PC shutting down)
  // gets no chance to write anything, so its run simply stops after STARTED. Say so on the next start
  // — "it stopped by itself" is then answered by the log: not a crash, something ended it from outside.
  const last = lastLine(file);
  if (last && !/EXIT code|STOPPED|NOTE —/.test(last)) {
    const pid = (last.match(/pid (\d+)/) || [])[1] || '?';
    write(`NOTE — the previous run (pid ${pid}) ended with no stop or crash recorded: it was closed by force (Task Manager, taskkill /F), the power was cut, or the PC shut down`);
  }
  write(`STARTED — node ${process.version}`);
  return { write };
}

function lastLine(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && l.startsWith('['));
    return lines[lines.length - 1] || null;
  } catch { return null; }
}

module.exports = { install };
