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
const { protocol, net } = require('electron');
const { mimeFor, safeJoin } = require('./util');
const { scope } = require('./log');

const log = scope('protocol');

const APP_SCHEME = 'playhub-app';
const GAME_SCHEME = 'playhub-game';

function registerSchemes() {
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

function fileResponse(absPath, { noStore = false } = {}) {
  return net.fetch('file:///' + absPath.replace(/\\/g, '/').replace(/^([a-zA-Z]):/, '$1:')).then((res) => {
    if (!res.ok) return res;
    const headers = new Headers(res.headers);
    headers.set('content-type', mimeFor(absPath));
    headers.set('cross-origin-resource-policy', 'same-origin');
    if (noStore) headers.set('cache-control', 'no-store');
    else headers.set('cache-control', 'public, max-age=3600');
    return new Response(res.body, { status: res.status, headers });
  });
}

function handleApp(rendererRoot, request) {
  const url = new URL(request.url);
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
    if (idx && fs.existsSync(idx)) return fileResponse(idx);
    return notFound(request.url);
  }
  // Never serve sidecar/config files through the app scheme.
  const base = path.basename(abs).toLowerCase();
  if (base === 'playhub.manifest.json') return forbidden();
  return fileResponse(abs);
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
    if (idx && fs.existsSync(idx)) return fileResponse(idx);
    return notFound(request.url);
  }
  // Never serve the manifest or dotfiles to the game itself.
  const base = path.basename(abs).toLowerCase();
  if (base === 'playhub.manifest.json' || base.startsWith('.')) return forbidden();
  // Game responses: no-store for HTML (fresh behavior), cached for assets.
  const noStore = /\.(html?|xhtml)$/i.test(base);
  return fileResponse(abs, { noStore });
}

function registerHandlers({ rendererRoot, getPaths, store }) {
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

module.exports = { APP_SCHEME, GAME_SCHEME, registerSchemes, registerHandlers };
