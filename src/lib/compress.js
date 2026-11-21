'use strict';

/**
 * Lightweight zero-dependency HTTP Gzip compression middleware.
 * Cuts transfer size of the 1.7 MB frontend bundle and large JSON API payloads
 * by ~75–85% while leaving binary downloads, Socket.IO, 204/304/206, and small
 * payloads untouched.
 */

const zlib = require('zlib');

const COMPRESSIBLE_RE = /^(?:text\/|application\/(?:javascript|x-javascript|json|ld\+json|xml)|image\/svg\+xml)/i;
const MIN_BYTES = 1024;

function isCompressible(contentType) {
  if (!contentType) return false;
  return COMPRESSIBLE_RE.test(String(contentType).split(';')[0].trim());
}

function appendVary(res, token) {
  const existing = res.getHeader('Vary');
  if (!existing) {
    res.setHeader('Vary', token);
    return;
  }
  const str = Array.isArray(existing) ? existing.join(', ') : String(existing);
  const parts = str.split(',').map((s) => s.trim().toLowerCase());
  if (!parts.includes(token.toLowerCase())) {
    res.setHeader('Vary', `${str}, ${token}`);
  }
}

function compressMiddleware(options = {}) {
  const threshold = Number(options.threshold) >= 0 ? Number(options.threshold) : MIN_BYTES;
  const level = options.level != null ? Number(options.level) : zlib.constants.Z_DEFAULT_COMPRESSION;

  return function compress(req, res, next) {
    if (
      req.method === 'HEAD' ||
      (req.path && req.path.startsWith('/socket.io')) ||
      (req.originalUrl && req.originalUrl.startsWith('/socket.io')) ||
      req.headers.range
    ) {
      return next();
    }

    const ae = String(req.headers['accept-encoding'] || '');
    if (!/\bgzip\b/i.test(ae)) {
      return next();
    }

    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    const origWriteHead = res.writeHead.bind(res);

    let mode = null; // null | 'plain' | 'gzip'
    let gz = null;
    let ended = false;
    let headArgs = null;

    function flushHead() {
      res.writeHead = origWriteHead;
      if (!headArgs) return;
      const [status, reason, hdrs] = headArgs;
      headArgs = null;
      if (hdrs) {
        if (typeof reason === 'string') origWriteHead(status, reason, hdrs);
        else origWriteHead(status, hdrs);
      } else if (typeof reason === 'string') {
        origWriteHead(status, reason);
      } else {
        origWriteHead(status);
      }
    }

    function initMode(chunkLen, isSingleEnd) {
      if (mode !== null) return;

      const status = (headArgs && headArgs[0]) || res.statusCode || 200;
      const alreadyEncoded = res.getHeader('Content-Encoding');
      const ct = res.getHeader('Content-Type');
      const cl = Number(res.getHeader('Content-Length') || 0);

      if (
        status === 204 ||
        status === 304 ||
        status === 206 ||
        alreadyEncoded ||
        !isCompressible(ct) ||
        (isSingleEnd && chunkLen < threshold) ||
        (cl > 0 && cl < threshold)
      ) {
        mode = 'plain';
        flushHead();
        res.write = origWrite;
        res.end = origEnd;
        return;
      }

      mode = 'gzip';
      res.removeHeader('Content-Length');
      const etag = res.getHeader('ETag');
      if (typeof etag === 'string' && !etag.startsWith('W/')) {
        res.setHeader('ETag', `W/${etag}`);
      }
      res.setHeader('Content-Encoding', 'gzip');
      appendVary(res, 'Accept-Encoding');

      if (headArgs) {
        const [st, rsn, hdrs] = headArgs;
        if (hdrs && typeof hdrs === 'object') {
          for (const k of Object.keys(hdrs)) {
            if (k.toLowerCase() === 'content-length') delete hdrs[k];
          }
          hdrs['Content-Encoding'] = 'gzip';
        }
        headArgs = [st, typeof rsn === 'string' ? rsn : undefined, hdrs];
      }
      flushHead();
      if (!res.headersSent) {
        origWriteHead(res.statusCode || 200);
      }

      gz = zlib.createGzip({ level });
      gz.on('data', (d) => {
        if (!res.writableEnded) return origWrite(d);
        return false;
      });
      gz.on('drain', () => {
        res.emit('drain');
      });
      gz.on('end', () => {
        if (!ended) {
          ended = true;
          origEnd();
        }
      });
      gz.on('error', () => {
        try { gz.destroy(); } catch (_) {}
        if (!res.writableEnded) origEnd();
      });
      res.on('close', () => {
        if (gz) {
          try { gz.destroy(); } catch (_) {}
        }
      });
    }

    res.writeHead = function patchedWriteHead(statusCode, statusMessage, headers) {
      let msg = statusMessage;
      let hdrs = headers;
      if (typeof statusMessage === 'object' && statusMessage !== null) {
        hdrs = statusMessage;
        msg = undefined;
      }
      if (hdrs && typeof hdrs === 'object') {
        for (const [k, v] of Object.entries(hdrs)) {
          if (v !== undefined) res.setHeader(k, v);
        }
      }
      res.statusCode = statusCode;
      headArgs = [statusCode, msg, undefined];
      return res;
    };

    res.write = function patchedWrite(chunk, encoding, cb) {
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      const buf = chunk == null ? Buffer.alloc(0) : (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      initMode(buf.length, false);
      if (mode === 'plain') {
        return origWrite(buf, cb);
      }
      return gz.write(buf, cb);
    };

    res.end = function patchedEnd(chunk, encoding, cb) {
      if (typeof chunk === 'function') { cb = chunk; chunk = null; encoding = undefined; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      const buf = chunk == null ? Buffer.alloc(0) : (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      initMode(buf.length, mode === null);
      if (mode === 'plain') {
        return buf.length ? origEnd(buf, cb) : origEnd(cb);
      }
      if (cb) res.once('finish', cb);
      if (buf.length) gz.end(buf);
      else gz.end();
      return res;
    };

    next();
  };
}

module.exports = compressMiddleware;
