'use strict';

// ===========================================================================
// The one issue rule (stores plan, Part 3): nothing leaves a store unless it is in that store's
// stock (ST-D12).
//
// - It starts store by store, and kind by kind, on the day head office approves that store's
//   first full count of that kind (ST-D13, src/lib/stock_count.js fullyCounted). Before it, the
//   book is not yet a figure to block on.
// - An item the book shows at 0 while it sits on the shelf is put right with a quick count, which
//   head office approves; then it can be issued. Nothing is forced past zero (ST-D14).
// - It reads the shelf AFTER the write, in the same transaction: every door writes its record,
//   brings the stock up to date (stock.sync) and asks check(). A shelf the write took stock off
//   that now stands below zero refuses the whole write. An edit is judged by what it changes
//   (ST-D17): a record saved again unchanged takes nothing and is never refused.
// - Tyres and batteries are in it since Part 4: a receipt and an issue on a request are both filed
//   under the request's specification (src/lib/stock.js), and each unit goes out by its serial.
// ===========================================================================

const stock = require('./stock');
const stores = require('./stores');

const SECTIONS = ['general', 'oil', 'filter', 'tyre', 'battery'];
const n2 = (v) => Math.round((Number(v) || 0) * 100) / 100;
const fail = (status, msg, data) => { const e = new Error(msg); e.status = status; e.data = data; throw e; };

/** The day the rule started for one store and one kind of stock, or null while it has not. */
function since(storeId, section) {
  if (!storeId || !SECTIONS.includes(section)) return null;
  return require('./stock_count').fullyCounted(storeId, section);
}

/** Every kind in one store: the day the rule started, or null. */
function status(storeId) {
  return Object.fromEntries(stock.SECTIONS.map((s) => [s, since(storeId, s)]));
}

/**
 * Refuse a write that took out more than a shelf held. `changes` is what stock.sync() returned
 * (or the same shape, for a door that writes its movement itself). `hint(short)` may add a line —
 * the service form names the equivalent filters in stock.
 */
function check(changes, { hint } = {}) {
  const short = [];
  for (const c of changes || []) {
    if (!(c.delta < 0) || !since(c.store_id, c.section)) continue;
    const balance = stock.balanceOf(c.section, c.item_key, c.store_id);
    if (balance < -0.001) {
      short.push({ section: c.section, item_key: c.item_key, store_id: c.store_id,
        name: stores.itemName(c.section, c.item_key) || c.item_key,
        wanted: n2(-c.delta), in_stock: Math.max(0, n2(balance - c.delta)), store: stores.label(c.store_id) });
    }
  }
  if (!short.length) return;
  const lines = short.map((x) => `${x.name}: ${x.in_stock} in stock at ${x.store}, ${x.wanted} asked for`);
  const extra = hint ? hint(short) : null;
  fail(409, `Not enough in stock. ${lines.join('; ')}. Receive it first. If it is on the shelf, count it (quick count) and head office approves.`
    + (extra ? ' ' + extra : ''), { short });
}

module.exports = { SECTIONS, since, status, check };
