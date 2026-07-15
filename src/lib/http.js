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

/** Standard error-handling middleware. */
function errorHandler(err, _req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Server error' });
}

module.exports = { asyncHandler, require_, toInt, toNum, errorHandler };
