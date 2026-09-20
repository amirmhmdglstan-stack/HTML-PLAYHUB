'use strict';
/**
 * util.js — small pure helpers shared by main process, tools and tests.
 * No Electron imports here so it runs under plain Node.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function slugify(input, fallback = 'game') {
  const s = String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return s || fallback;
}

function titleize(filename) {
  const base = String(filename || '').replace(/\.[a-z0-9]+$/i, '');
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Untitled Game';
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function formatDate(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Never';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
};

function mimeFor(filePath) {
  const ext = path.extname(String(filePath || '').split('?')[0]).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

/**
 * Join `target` under `root`, refusing path traversal. Returns absolute path
 * or null when the result would escape root.
 */
function safeJoin(root, ...parts) {
  const abs = path.resolve(root, ...parts);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '' ) return abs;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

function sha256String(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

function atomicWriteFileSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, filePath);
}

async function walkFiles(root, { maxFiles = 50000, maxBytes = 4 * 1024 * 1024 * 1024 } = {}) {
  const out = [];
  let totalBytes = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === '__MACOSX') continue;
        stack.push(full);
      } else if (e.isFile()) {
        let size = 0;
        try { size = (await fs.promises.stat(full)).size; } catch { continue; }
        totalBytes += size;
        out.push({ path: full, relative: path.relative(root, full), size });
        if (out.length > maxFiles) throw new Error(`Too many files (>${maxFiles}).`);
        if (totalBytes > maxBytes) throw new Error('Total size exceeds the safety limit.');
      }
    }
  }
  return { files: out, totalBytes };
}

function isHtmlFile(name) {
  return /\.(html?|xhtml)$/i.test(String(name || ''));
}

function isImageFile(name) {
  return /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i.test(String(name || ''));
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function uniqueId(prefix = 'id') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * True only for well-formed http(s) URLs. Everything else — custom schemes
 * (including our own playhub-*), file paths, javascript:, data:, blanks —
 * must never reach the OS shell.
 */
function isSafeExternalUrl(u) {
  if (typeof u !== 'string') return false;
  const s = u.trim();
  if (!s || s.length > 2048) return false;
  if (/[\s<>"'\\]/.test(s)) return false;
  let parsed = null;
  try { parsed = new URL(s); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!parsed.hostname) return false;
  return true;
}

module.exports = {
  slugify, titleize, formatBytes, formatDuration, formatDate,
  mimeFor, safeJoin, sha256File, sha256String, atomicWriteFileSync,
  walkFiles, isHtmlFile, isImageFile, clamp, uniqueId, isSafeExternalUrl,
};
