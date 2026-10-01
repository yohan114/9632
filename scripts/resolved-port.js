'use strict';

// The port the app WILL bind — for whoever has to start it.
//
// start_server.bat needs that number three times over: to see whether the server is already
// running, to print the address, and to open the browser there. It used to keep its own copy of
// the number and pass nothing on to node, so the two halves could disagree — and did. It
// announced and opened 1929 while `node src/server.js` bound 3000, src/config.js's default,
// because nothing told node otherwise. On a PC where another program already held 3000 the server
// then did not start at all, and "nobody can sign in" was the only symptom anyone saw.
//
// So the launcher asks here rather than keeping a second copy of the answer. This prints the port
// when one is configured — PORT in the environment, or PORT in .env, resolved by src/config.js
// itself, quotes and inline comments and all — and prints NOTHING when nothing is configured
// anywhere. Silence is the launcher's cue to supply its own machine's default, which it then
// passes to node, so the port it opens is always the port the server binds.
//
// src/config.js copies .env into process.env as it loads, so PORT is set afterwards exactly when
// it was configured somewhere. Unset means nothing but config.js's own 3000 fallback would apply,
// and no deployment relies on that: the VPS sets PORT in .env (deploy/VPS.md), and the office copy
// runs on 1929.

const config = require('../src/config');

if (process.env.PORT) process.stdout.write(String(config.port));
