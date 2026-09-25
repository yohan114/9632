'use strict';

/** Wrap an async route handler so thrown errors reach Express's error handler. */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** Throw a 400 unless every listed field is present and non-empty in obj. */
function require_(obj, fields) {
  const missing = fields.filter((f) => obj[f] === undefined || obj[f] === null || obj[f] === '');
  if (missing.length) {
    const err = new Error('Missing required field(s): ' + missing.join(', '));
    err.status = 400;
    throw err;
  }
}

function toInt(v, def = null) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function toNum(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// A database rule that refused a write is the user's to fix, not a server fault. It used to come
// back as a 500 carrying SQLite's own wording; it keeps its meaning, in words a storekeeper can act
// on, with a 4xx so the screen shows it as "not saved" rather than "the server broke".
function constraintError(err) {
  const code = typeof err.code === 'string' ? err.code : '';
  if (!code.startsWith('SQLITE_CONSTRAINT')) return null;
  const what = (String(err.message).split(':')[1] || '').trim();
  if (code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
    return { status: 409, error: `Not saved: another record already has this value${what ? ` (${what})` : ''}.` };
  }
  if (code === 'SQLITE_CONSTRAINT_FOREIGNKEY') {
    return { status: 409, error: 'Not saved: it refers to a record that does not exist, or the record is still in use elsewhere.' };
  }
  if (code === 'SQLITE_CONSTRAINT_NOTNULL') {
    return { status: 400, error: `Not saved: a required value is missing${what ? ` (${what})` : ''}.` };
  }
  return { status: 400, error: 'Not saved: a value is not allowed here.' };
}

/**
 * Standard error-handling middleware.
 *
 * A deliberate error (err.status set by the route) keeps its message: those are written for the
 * person using the screen. An UNEXPECTED one (a 5xx) does not: its message is whatever the code or
 * the driver happened to say — a property name, a table, a line of internal wording — which helps
 * someone probing the server and nobody at the counter. The detail goes to the log under a short
 * reference, and the reference goes to the screen, so the two can still be matched up.
 */
function errorHandler(err, req, res, _next) {
  const c = !err.status ? constraintError(err) : null;
  if (c) return res.status(c.status).json({ error: c.error });
  const status = err.status || err.statusCode || 500;
  if (status >= 500) {
    const ref = require('crypto').randomBytes(4).toString('hex');
    console.error(`[error ${ref}] ${req.method} ${req.originalUrl}`, err);
    return res.status(status).json({
      error: `Something went wrong on the server (reference ${ref}). Please try again; if it keeps happening, give this reference to the administrator.`,
      ref,
    });
  }
  // `err.data` carries what the screen needs to help (e.g. which items are short, Part 3).
  res.status(status).json({ ...(err.data || {}), error: err.message || 'Request failed' });
}

module.exports = { asyncHandler, require_, toInt, toNum, errorHandler };
