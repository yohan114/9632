'use strict';

// The screen-fitting rules, and the thing that quietly defeats them.
//
// A media query adds NO specificity. `@media (max-width:1500px) { table { font-size: 12px } }`
// placed above the plain `table { font-size: 13px }` loses to it at every screen size, in silence —
// no warning, no error, the page simply keeps the old value. That is exactly what happened on the
// first attempt at these rules: `.nav` narrowed (its base rule was above) while the table font did
// not (its base rule was below), which looked like a browser cache problem for a good while.
//
// So the test is about ORDER, not about pixel values. The measured numbers belong in the
// stylesheet's own comment where whoever changes them will read them; what a test can usefully
// defend is that the override still overrides.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert');

const CSS = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
// The comments in this stylesheet explain at length what NOT to do — "not table-layout:fixed",
// "overflow-wrap, NOT word-break". Grepping the raw file therefore finds the very strings the
// tests are checking are absent, and every content assertion passes or fails for the wrong reason.
const RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '');

const at = (needle) => CSS.indexOf(needle);
const lineOf = (idx) => CSS.slice(0, idx).split('\n').length;

test('the screen-fitting tiers exist', () => {
  assert.ok(at('and (max-width: 1500px)') !== -1,
    'the 1500px tier is what makes a 1366 and 1440 laptop fit');
  assert.ok(at('and (max-width: 1300px)') !== -1,
    'the 1300px tier is what makes a 1280 screen fit');
});

test('they come AFTER the base rules they override', () => {
  // The whole bug, in one assertion.
  const baseTable = at('\ntable { width: 100%');
  const baseNav = at('\n.nav {');
  const tier1500 = at('and (max-width: 1500px)');
  const tier1300 = at('and (max-width: 1300px)');

  assert.ok(baseTable !== -1 && baseNav !== -1, 'base table/.nav rules not found — has the file been restructured?');
  assert.ok(tier1500 > baseTable,
    `the 1500px tier is at line ${lineOf(tier1500)} but the base table rule is at line ${lineOf(baseTable)}; ` +
    'a media query adds no specificity, so placed first it loses and the table keeps its wide type — silently');
  assert.ok(tier1500 > baseNav, 'same for .nav');
  assert.ok(tier1300 > tier1500,
    'the narrower tier must come last, or the wider one overrides it on the narrowest screens');
});

test('the desktop tiers do not reach down onto a phone', () => {
  // They have to sit at the end of the file to override the base table rules — which means that
  // without a lower bound they ALSO match a 375px screen, and being last they would beat the phone
  // layout declared earlier. Caught exactly that way: the phone picked up desktop padding.
  for (const q of RULES.match(/@media[^{]+/g) || []) {
    if (!/max-width:\s*1[345]00px/.test(q)) continue;
    const floor = q.match(/min-width:\s*(\d+)px/);
    assert.ok(floor, `"${q.trim()}" has no lower bound, so it also applies on a phone`);
    assert.ok(Number(floor[1]) > 780,
      `"${q.trim()}" starts at ${floor[1]}px, which overlaps the 780px phone layout`);
  }
});

test('wrapping is done with overflow-wrap, never word-break', () => {
  // word-break:break-word tells the browser a column may be one character wide. It crushed a
  // "200 Breaker" plate to 165px tall and stood every row carrying one at 312px.
  const tiers = RULES.slice(RULES.indexOf('and (max-width: 1500px)'));
  assert.ok(/overflow-wrap:\s*break-word/.test(tiers), 'the wrapping tier must set overflow-wrap');
  assert.ok(!/word-break/.test(tiers),
    'word-break in the responsive tiers would bring back the sideways-text rows');
});

test('a wide table can still be scrolled rather than silently cut', () => {
  // 1024x768 genuinely cannot show eleven columns. The fallback must be a scrollbar the reader can
  // see — `auto`, never `hidden`, which would remove the content with no sign it was there.
  assert.match(RULES, /\.table-wrap\.no-hscroll\s*\{\s*overflow-x:\s*auto/,
    'overflow-x:hidden here would hide columns with nothing on screen to say so');
  assert.ok(!/table-layout:\s*fixed/.test(RULES),
    'table-layout:fixed shares the width equally and crushes the long columns — it is what made ' +
    '496 of 500 job rows over 200px tall');
});
