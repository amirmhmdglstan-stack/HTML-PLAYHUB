'use strict';
/**
 * paths.js — resolves all filesystem locations.
 *
 * Two modes:
 *  - installed mode: user data lives in the OS app-data dir
 *    (Windows: %APPDATA%/HTML Playhub)
 *  - portable mode: user data lives in ./data next to the executable
 *    (enabled by --portable flag, PORTABLE_EXECUTABLE_DIR (electron-builder
 *    portable), or a `portable.txt` / existing `data/` dir beside the app)
 */
const path = require('node:path');
const fs = require('node:fs');

let app = null;
try {
  // Resolved only inside Electron; tools/tests inject an override instead.
  app = require('electron').app;
} catch { app = null; }

let overrideRoot = null;
function setDataRootForTesting(root) { overrideRoot = root; }

function exeDir() {
  try {
    if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
    if (app) return path.dirname(app.getPath('exe'));
  } catch { /* ignore */ }
  return process.cwd();
}

function isPortable() {
  if (process.argv.includes('--portable')) return true;
  if (process.env.HTML_PLAYHUB_PORTABLE === '1') return true;
  if (process.env.PORTABLE_EXECUTABLE_DIR) return true;
  try {
    const dir = exeDir();
    if (fs.existsSync(path.join(dir, 'portable.txt'))) return true;
    if (fs.existsSync(path.join(dir, 'data', 'playhub.json'))) return true;
  } catch { /* ignore */ }
  return false;
}

function dataRoot() {
  if (overrideRoot) return overrideRoot;
  if (isPortable()) return path.join(exeDir(), 'data');
  if (app) return path.join(app.getPath('appData'), 'HTML Playhub');
  // Plain-node fallback (tools/tests): repo-local dev data dir.
  return path.join(process.cwd(), 'playhub-dev-data');
}

/** Static read-only resources shipped with the app (inside asar when packaged). */
function resourceRoot() {
  // src/main -> app root
  return path.join(__dirname, '..', '..');
}

function allPaths() {
  const root = dataRoot();
  return {
    root,
    portable: isPortable(),
    games: path.join(root, 'games'),
    thumbnails: path.join(root, 'thumbnails'),
    screenshots: path.join(root, 'screenshots'),
    backups: path.join(root, 'backups'),
    cache: path.join(root, 'cache'),
    temp: path.join(root, 'temp'),
    logs: path.join(root, 'logs'),
    dbFile: path.join(root, 'playhub.json'),
    settingsFile: path.join(root, 'settings.json'),
    layoutsFile: path.join(root, 'control-layouts.json'),
    catalogCache: path.join(root, 'cache', 'catalog.json'),
  };
}

function ensureDirs() {
  const p = allPaths();
  for (const d of [p.root, p.games, p.thumbnails, p.screenshots, p.backups, p.cache, p.temp, p.logs]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return p;
}

module.exports = { dataRoot, resourceRoot, allPaths, ensureDirs, isPortable, setDataRootForTesting };
