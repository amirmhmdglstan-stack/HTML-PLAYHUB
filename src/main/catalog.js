'use strict';
/**
 * catalog.js — the Discover catalog (shipped + cached remote).
 *
 * The catalog lists installable/external games. It is generated at build
 * time by tools/build-catalog.mjs into catalog/catalog.json and shipped
 * with the app. Optionally the user can refresh it from the Playhub
 * repository (manual button or opt-in auto check); on failure the shipped
 * catalog is used — Discover never breaks offline mode.
 */
const fs = require('node:fs');
const path = require('node:path');
const { scope } = require('./log');

const log = scope('catalog');

const REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/amirmhmdglstan-stack/HTML-PLAYHUB/main/catalog/catalog.json';

function shippedCatalogPath() {
  return path.join(__dirname, '..', '..', 'catalog', 'catalog.json');
}

function loadShipped() {
  try {
    const raw = fs.readFileSync(shippedCatalogPath(), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    log.warn('no shipped catalog', String(err));
    return { version: 1, updatedAt: null, sources: [], games: [] };
  }
}

function loadCached(paths) {
  try {
    if (!fs.existsSync(paths.catalogCache)) return null;
    return JSON.parse(fs.readFileSync(paths.catalogCache, 'utf8'));
  } catch {
    return null;
  }
}

function getCatalog(paths) {
  const shipped = loadShipped();
  const cached = loadCached(paths);
  // Prefer whichever is newer (by updatedAt), fall back to shipped.
  if (cached && Array.isArray(cached.games) && cached.games.length) {
    const a = Date.parse(cached.updatedAt || '') || 0;
    const b = Date.parse(shipped.updatedAt || '') || 0;
    if (a >= b) return { ...cached, _origin: 'cache' };
  }
  return { ...shipped, _origin: 'shipped' };
}

async function refreshCatalog(paths, { timeoutMs = 20000 } = {}) {
  const { download } = require('./downloader');
  const tmp = `${paths.catalogCache}.new`;
  await download({ url: REMOTE_CATALOG_URL, destFile: tmp, retries: 1, timeoutMs });
  const parsed = JSON.parse(fs.readFileSync(tmp, 'utf8'));
  if (!parsed || !Array.isArray(parsed.games)) throw new Error('Remote catalog is invalid.');
  fs.mkdirSync(path.dirname(paths.catalogCache), { recursive: true });
  fs.renameSync(tmp, paths.catalogCache);
  log.info(`catalog refreshed (${parsed.games.length} entries)`);
  return { ...parsed, _origin: 'cache' };
}

module.exports = { getCatalog, refreshCatalog, loadShipped, REMOTE_CATALOG_URL };
