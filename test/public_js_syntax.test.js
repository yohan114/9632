'use strict';

// Every script the browser loads must at least parse. A syntax error anywhere in public/app.js
// stops the whole file from running, so every screen goes blank at once — and nothing on the
// server notices: the API tests all pass. That is exactly what happened on 2026-09-25, when a
// block pasted into the middle of lvlChip() left four stray lines behind (app.js:10030).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const PUBLIC = path.join(__dirname, '..', 'public');
const scripts = fs.readdirSync(PUBLIC, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.js') && !f.includes('node_modules') && !f.endsWith('.min.js'))
  .map((f) => path.join(PUBLIC, f));

test('every script under public/ parses', () => {
  assert.ok(scripts.some((f) => f.endsWith(`${path.sep}app.js`)), 'public/app.js is checked');
  for (const file of scripts) {
    const src = fs.readFileSync(file, 'utf8');
    try {
      new vm.Script(src, { filename: file });
    } catch (e) {
      assert.fail(`${path.relative(PUBLIC, file)} does not parse: ${e.message}\n${e.stack.split('\n').slice(0, 3).join('\n')}`);
    }
  }
});
