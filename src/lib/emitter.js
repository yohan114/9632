'use strict';

// Tiny in-process event bus (singleton).
//
// Route files fire domain events through this — e.g.
//   require('../lib/emitter').emit('stock_updated', { store_item_id: 42 });
// — without knowing anything about socket.io. server.js is the ONLY place that
// bridges these events out to connected WebSocket clients, so the transport can
// change (or be removed) without touching a single route.
//
// Because Node caches modules, every require('./emitter') returns this same bus.

const { EventEmitter } = require('events');

const bus = new EventEmitter();
// Several routes plus the socket bridge may subscribe; lift the default cap of 10
// so we never get the "possible memory leak" warning during normal operation.
bus.setMaxListeners(50);

module.exports = {
  /** Fire an event with an optional payload. */
  emit(event, data) { return bus.emit(event, data); },
  /** Subscribe to an event. */
  on(event, cb) { bus.on(event, cb); return () => bus.off(event, cb); },
  /** Unsubscribe. */
  off(event, cb) { bus.off(event, cb); },
  /** The raw EventEmitter, for advanced use (once, listenerCount, …). */
  bus,
};
