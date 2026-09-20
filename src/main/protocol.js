'use strict';
/**
 * protocol.js — custom protocol handlers.
 *
 *  playhub-app://app/<path>     — launcher UI (HTML/CSS/JS from src/renderer)
 *  playhub-game://game/<id>/<path> — installed game files (sandboxed origin)
 *
 * Games get their own opaque origin per scheme (NOT file://), so a game can
 * never read the user's filesystem, and games cannot reach each other's
 * storage. Traversal outside the game folder is rejected.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
let protocol = null;
try {
  // Inside Electron this is the protocol API; under plain node (tests) the
  // require succeeds but yields no API, so every use is guarded.
  protocol = require('electron').protocol;
} catch { protocol = null; }
const { mimeFor, safeJoin } = require('./util');
const { scope } = require('./log');

const log = scope('protocol');

const APP_SCHEME = 'playhub-app';
const GAME_SCHEME = 'playhub-game';

function registerSchemes() {
  if (!protocol || typeof protocol.registerSchemesAsPrivileged !== 'function') {
    log.warn('protocol API unavailable; scheme privileges not registered');
    return;
  }
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, allowServiceWorkers: false },
    },
    {
      scheme: GAME_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false, allowServiceWorkers: false },
    },
  ]);
}

function notFound(url) {
  return new Response(`Not found: ${url}`, { status: 404, headers: { 'content-type': 'text/plain' } });
}

function forbidden(msg = 'Forbidden') {
  return new Response(msg, { status: 403, headers: { 'content-type': 'text/plain' } });
}

/**
 * Serve a file as a streaming Response. Uses fs (transparent to asar
 * archives in packaged builds) — never file:// URLs, which cannot read
 * inside app.asar. Supports byte ranges so game audio/video can seek.
 * Never throws: failures become 404/500 responses.
 */
function serveFile(absPath, { noStore = false, rangeHeader = null } = {}) {
  let stat = null;
  try { stat = fs.statSync(absPath); } catch { return notFound(absPath); }
  if (!stat.isFile()) return notFound(absPath);
  try {
    const size = stat.size;
    const headers = new Headers();
    headers.set('content-type', mimeFor(absPath));
    headers.set('cross-origin-resource-policy', 'same-origin');
    headers.set('accept-ranges', 'bytes');
    if (noStore) headers.set('cache-control', 'no-store');
    else headers.set('cache-control', 'public, max-age=3600');
    let start = 0;
    let end = size - 1;
    let status = 200;
    if (rangeHeader) {
      const m = /bytes=(\d*)-(\d*)/.exec(String(rangeHeader));
      if (m) {
        if (m[1]) start = Math.min(parseInt(m[1], 10), size - 1);
        if (m[2]) end = Math.min(parseInt(m[2], 10), size - 1);
        if (m[1] === '' && m[2]) start = Math.max(0, size - parseInt(m[2], 10));
        if (start <= end) {
          status = 206;
          headers.set('content-range', `bytes ${start}-${end}/${size}`);
        }
      }
    }
    headers.set('content-length', String(end - start + 1));
    const nodeStream = fs.createReadStream(absPath, size === 0 ? {} : { start, end });
    nodeStream.on('error', () => { try { nodeStream.destroy(); } catch { /* ignore */ } });
    return new Response(Readable.toWeb(nodeStream), { status, headers });
  } catch (err) {
    log.error('serve file failed', String(err));
    return new Response('Internal error', { status: 500 });
  }
}

function fileResponse(absPath, opts) {
  return serveFile(absPath, opts);
}

function handleApp(rendererRoot, request) {
  const url = new URL(request.url);
  if (url.host !== 'app') return notFound(request.url);
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  if (rel === '' || rel === 'app' || rel.endsWith('/')) rel += 'index.html';
  // playhub-app://app/index.html  ->  index.html
  if (rel.startsWith('app/')) rel = rel.slice(4);
  if (!rel) rel = 'index.html';
  const abs = safeJoin(rendererRoot, rel);
  if (!abs) return forbidden('Invalid path.');
  let stat = null;
  try { stat = fs.statSync(abs); } catch { return notFound(request.url); }
  if (stat.isDirectory()) {
    const idx = safeJoin(abs, 'index.html');
    if (idx && fs.existsSync(idx)) return fileResponse(idx, { rangeHeader: request.headers.get('range') });
    return notFound(request.url);
  }
  // Never serve sidecar/config files through the app scheme.
  const base = path.basename(abs).toLowerCase();
  if (base === 'playhub.manifest.json') return forbidden();
  return fileResponse(abs, { rangeHeader: request.headers.get('range') });
}

function handleGame(getPaths, store, request) {
  const url = new URL(request.url);
  // playhub-game://game/<id>/<path...>
  const parts = decodeURIComponent(url.pathname).replace(/^\/+/, '').split('/');
  // Note: with standard schemes, host is 'game', pathname is '/<id>/...'.
  if (url.host !== 'game' || parts.length < 1 || !parts[0]) return notFound(request.url);
  const gameId = parts[0];
  const rec = store.getGame(gameId);
  if (!rec) return notFound(request.url);
  const paths = getPaths();
  const gameRoot = safeJoin(paths.games, gameId);
  if (!gameRoot) return forbidden();
  let rel = parts.slice(1).join('/');
  if (!rel) rel = rec.entryFile || 'index.html';
  const abs = safeJoin(gameRoot, rel);
  if (!abs) {
    log.warn(`blocked traversal for ${gameId}: ${rel}`);
    return forbidden('Path escapes game folder.');
  }
  let stat = null;
  try { stat = fs.statSync(abs); } catch { return notFound(request.url); }
  if (stat.isDirectory()) {
    const idx = safeJoin(abs, 'index.html');
    if (idx && fs.existsSync(idx)) return fileResponse(idx, { rangeHeader: request.headers.get('range') });
    return notFound(request.url);
  }
  // Never serve the manifest or dotfiles to the game itself.
  const base = path.basename(abs).toLowerCase();
  if (base === 'playhub.manifest.json' || base.startsWith('.')) return forbidden();
  // Game responses: no-store for HTML (fresh behavior), cached for assets.
  const noStore = /\.(html?|xhtml)$/i.test(base);
  return fileResponse(abs, { noStore, rangeHeader: request.headers.get('range') });
}

function registerHandlers({ rendererRoot, getPaths, store }) {
  if (!protocol || typeof protocol.handle !== 'function') {
    throw new Error('protocol API unavailable — cannot serve the app UI.');
  }
  // Electron's protocol.handle passes (request) only.
  protocol.handle(APP_SCHEME, (request) => {
    try {
      return handleApp(rendererRoot, request);
    } catch (err) {
      log.error('app protocol error', String(err));
      return new Response('Internal error', { status: 500 });
    }
  });
  protocol.handle(GAME_SCHEME, (request) => {
    try {
      return handleGame(getPaths, store, request);
    } catch (err) {
      log.error('game protocol error', String(err));
      return new Response('Internal error', { status: 500 });
    }
  });
  log.info('protocol handlers registered');
}

/**
 * Startup gate: confirm both schemes are actually handled before any window
 * loads a playhub-* URL. Without this, a first-navigation race (or a failed
 * registration) makes Chromium treat our URLs as unknown schemes and hand
 * them to Windows — the infamous "get an app to open this link" dialog.
 * Resolves true when safe to load windows, false after timeout.
 */
async function ensureProtocolsHandled({ timeoutMs = 5000 } = {}) {
  if (!protocol || typeof protocol.isProtocolHandled !== 'function') return false;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const [app, game] = await Promise.all([
        protocol.isProtocolHandled(APP_SCHEME),
        protocol.isProtocolHandled(GAME_SCHEME),
      ]);
      if (app && game) return true;
    } catch (err) {
      log.warn('protocol check failed', String(err));
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

module.exports = {
  APP_SCHEME, GAME_SCHEME, registerSchemes, registerHandlers,
  ensureProtocolsHandled, serveFile, handleApp, handleGame,
};
