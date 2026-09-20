'use strict';
/**
 * downloader.js — resumable-ish HTTP(S) downloads with progress, cancel,
 * retry and integrity checks. No dependencies.
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { scope } = require('./log');
const { uniqueId } = require('./util');

const log = scope('download');

const active = new Map(); // id -> { req, file, cleanup }

function fetchOnce(url, destFile, { timeoutMs = 30000, maxRedirects = 5, onProgress = null, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    const lib = url.startsWith('https:') ? https : http;
    const req = lib.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'HTML-Playhub/1.0' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (maxRedirects <= 0) return reject(new Error('Too many redirects.'));
        const next = new URL(res.headers.location, url).toString();
        return fetchOnce(next, destFile, { timeoutMs, maxRedirects: maxRedirects - 1, onProgress, signal }).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const total = Number(res.headers['content-length']) || null;
      let received = 0;
      const file = fs.createWriteStream(destFile);
      const entry = active.get(currentId);
      if (entry) { entry.req = req; entry.file = file; }
      const onAbort = () => {
        try { req.destroy(new Error('cancelled')); } catch { /* ignore */ }
        try { file.destroy(); } catch { /* ignore */ }
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      res.on('data', (chunk) => {
        received += chunk.length;
        if (onProgress) onProgress(received, total);
      });
      res.on('error', (err) => {
        try { file.destroy(); } catch { /* ignore */ }
        reject(err);
      });
      file.on('error', reject);
      file.on('finish', () => resolve({ bytes: received, total }));
      res.pipe(file);
    });
    req.on('timeout', () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
    const entry = active.get(currentId);
    if (entry) entry.req = req;
  });
}

// Bound per-call via AsyncLocalStorage-free approach: set before calling.
let currentId = null;

async function download({ id = uniqueId('dl'), url, destFile, expectedSize = null, retries = 3, timeoutMs = 30000, onProgress = null, signal = null }) {
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  const tmp = `${destFile}.part`;
  active.set(id, {});
  currentId = id;
  let lastErr = null;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      if (signal && signal.aborted) throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      const { bytes } = await fetchOnce(url, tmp, { timeoutMs, onProgress, signal });
      if (bytes === 0) throw new Error('Downloaded file is empty.');
      if (expectedSize && Math.abs(bytes - expectedSize) > Math.max(1024, expectedSize * 0.02)) {
        log.warn(`size mismatch for ${url}: got ${bytes}, expected ${expectedSize}`);
        // Not fatal: servers sometimes misreport; the import analyzer
        // validates content afterwards.
      }
      fs.renameSync(tmp, destFile);
      active.delete(id);
      log.info(`downloaded ${url} (${bytes} bytes)`);
      return { id, url, destFile, bytes };
    } catch (err) {
      lastErr = err;
      if (err && (err.code === 'CANCELLED' || (signal && signal.aborted))) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
        active.delete(id);
        throw Object.assign(new Error('cancelled'), { code: 'CANCELLED' });
      }
      log.warn(`download attempt ${attempt} failed for ${url}: ${err.message}`);
      if (attempt <= retries) await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  active.delete(id);
  try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  throw lastErr;
}

function cancel(id) {
  const entry = active.get(id);
  if (!entry) return false;
  try { if (entry.req) entry.req.destroy(new Error('cancelled')); } catch { /* ignore */ }
  try { if (entry.file) entry.file.destroy(); } catch { /* ignore */ }
  active.delete(id);
  return true;
}

module.exports = { download, cancel };
