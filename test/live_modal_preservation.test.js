'use strict';

// Regression test for the VPS bug where background Socket.IO `data_changed` / `connect` events
// called `render()`, which removes every non-persistent `.modal-bg` popup (such as New Job Request)
// while the user was typing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_JS = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');

function extractBlock(startMarker, endMarker) {
  const start = APP_JS.indexOf(startMarker);
  assert.notEqual(start, -1, `missing marker: ${startMarker}`);
  const end = APP_JS.indexOf(endMarker, start);
  assert.notEqual(end, -1, `missing end marker: ${endMarker}`);
  return APP_JS.slice(start, end);
}

function createHarness({ hash = '#/jobs?tab=requests' } = {}) {
  const handlers = {};
  const modals = [];
  let renderCount = 0;
  let activeElement = null;
  const contentEl = { contains: (el) => Boolean(el && el._inContent) };

  const makeEl = (tag) => {
    const el = {
      tagName: tag,
      className: '',
      dataset: {},
      style: {},
      children: [],
      _listeners: {},
      addEventListener(ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); },
      remove() {
        const idx = modals.indexOf(this);
        if (idx !== -1) modals.splice(idx, 1);
      },
      matches(sel) {
        return sel.split(',').map((s) => s.trim()).some((s) => {
          if (s === '[contenteditable="true"]') return this.contentEditable === 'true';
          return this.tagName.toLowerCase() === s.toLowerCase();
        });
      },
    };
    return el;
  };

  const sandbox = {
    ME: { id: 1, username: 'tester' },
    isScreenLocked: false,
    location: { hash },
    qs: (sel, root) => {
      if (sel === '#content') return contentEl;
      if (root && sel === '.modal-x') return root._xBtn || null;
      if (root && sel === '.mbody') return root._mbody || (root._mbody = makeEl('div'));
      return null;
    },
    qsa: (sel) => (sel === '.modal-bg' ? [...modals] : []),
    esc: (v) => String(v == null ? '' : v),
    showMaintenanceBanner: () => {},
    render: () => {
      renderCount++;
      // Replicate render() modal cleanup behavior for non-persistent modals.
      [...modals].forEach((el) => { if (el.dataset.persistent !== '1') el.remove(); });
    },
    window: {
      LiveERP: {
        on(ev, cb) { (handlers[ev] = handlers[ev] || []).push(cb); },
      },
    },
    document: {
      get activeElement() { return activeElement; },
      querySelector(sel) { return sel === '.modal-bg' ? (modals[0] || null) : null; },
      createElement(tag) { return makeEl(tag); },
      body: {
        appendChild(el) {
          if (el.className === 'modal-bg') {
            el._xBtn = makeEl('button');
            modals.push(el);
          }
        },
      },
    },
    setTimeout,
    clearTimeout,
  };
  sandbox.LiveERP = sandbox.window.LiveERP;

  const liveSnippet = extractBlock('const LIVE_ENTITY_ROUTES =', 'function showMaintenanceBanner(');
  const modalSnippet = extractBlock('function modal(title, bodyHtml, onMount, opts = {})', '// The server decides what a good password is');

  vm.runInNewContext(`${liveSnippet}\n${modalSnippet}\nwireLiveUpdates();`, sandbox);

  return {
    sandbox,
    modals,
    setHash: (h) => { sandbox.location.hash = h; },
    setActiveElement: (el) => { activeElement = el; },
    getRenderCount: () => renderCount,
    emit: (ev, payload) => { (handlers[ev] || []).forEach((fn) => fn(payload)); },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('live updates still refresh #/jobs when no modal or input is active', async () => {
  const h = createHarness({ hash: '#/jobs?tab=requests' });
  h.emit('data_changed', { entity: 'job_daily_work', action: 'create' });
  await wait(360);
  assert.equal(h.getRenderCount(), 1);
});

test('open non-persistent modal survives data_changed and reconnect, then refreshes after closing', async () => {
  const h = createHarness({ hash: '#/jobs?tab=requests' });
  let closeModal;
  h.sandbox.modal('New Job Request', '<input name="driver_name">', (_body, close) => { closeModal = close; });
  assert.equal(h.modals.length, 1);

  // Another user saves daily work and Socket.IO reconnects while user is typing.
  h.emit('data_changed', { entity: 'job_daily_work', action: 'create' });
  h.emit('connect');
  await wait(380);

  assert.equal(h.getRenderCount(), 0, 'render() must not run while a modal is open');
  assert.equal(h.modals.length, 1, 'New Job Request popup must remain open');

  // Closing the modal flushes the deferred live refresh.
  closeModal();
  assert.equal(h.modals.length, 0);
  await wait(180);
  assert.equal(h.getRenderCount(), 1, 'deferred live refresh should run after modal closes');
});

test('withModalOpening protects async pre-modal fetches from background live refreshes', async () => {
  const h = createHarness({ hash: '#/jobs?tab=requests' });
  let finishFetch;
  const opening = h.sandbox.withModalOpening(() => new Promise((resolve) => { finishFetch = resolve; }));

  h.emit('data_changed', { entity: 'job_request', action: 'approve' });
  await wait(360);
  assert.equal(h.getRenderCount(), 0, 'render() must wait while async modal data is loading');

  finishFetch();
  await opening;
});

test('active input in #content and inline service form routes defer background live refreshes', async () => {
  const h = createHarness({ hash: '#/jobs?tab=requests' });
  h.setActiveElement({
    _inContent: true,
    matches: (sel) => sel.includes('input'),
  });
  h.emit('data_changed', { entity: 'job_daily_work' });
  await wait(360);
  assert.equal(h.getRenderCount(), 0, 'focused input inside #content must not lose focus to render()');

  h.setActiveElement(null);
  h.setHash('#/services/new');
  h.emit('data_changed', { entity: 'service_job' });
  await wait(360);
  assert.equal(h.getRenderCount(), 0, 'inline service create form must not be wiped by render()');
});
