#!/usr/bin/env node
/**
 * smoke-install.mjs — headless end-to-end install test (no network).
 *
 * Simulates exactly what Discover's Install button does, using local fixture
 * files instead of downloads:
 *   1. single-file game (entry only),
 *   2. entry + catalog assets with repo-relative layout,
 *   3. zip game (entry auto-detection),
 * then: integrity check, favorite + playtime, backup with saves,
 * uninstall, restore-from-backup roundtrip.
 *
 * Usage: node tools/smoke-install.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = '/home/user/HTML-PLAYHUB';
const pathsMod = require(`${ROOT}/src/main/paths.js`);
const { Store } = require(`${ROOT}/src/main/store.js`);
const importer = require(`${ROOT}/src/main/importer.js`);
const games = require(`${ROOT}/src/main/games.js`);
const backups = require(`${ROOT}/src/main/backups.js`);

const assert = (c, m) => { if (!c) { console.error(`SMOKE FAIL: ${m}`); process.exit(1); } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-smoke-'));
pathsMod.setDataRootForTesting(tmp);
const paths = pathsMod.ensureDirs();
const store = new Store(paths).load();
store.ensureBuiltinCollections();

const GAME_HTML = (title) => `<!DOCTYPE html><html><head><title>${title}</title></head><body><canvas id=c></canvas><script>addEventListener('keydown',e=>{});requestAnimationFrame(function l(){l()});localStorage.setItem('x','1');</script></body></html>`;

// Dis retired: write fixtures as "already downloaded bytes".
const fx = path.join(tmp, 'fx');
fs.mkdirSync(fx, { recursive: true });
fs.writeFileSync(path.join(fx, 'solo.html'), GAME_HTML('Solo Game'));
fs.mkdirSync(path.join(fx, 'tree', 'sub'), { recursive: true });
fs.writeFileSync(path.join(fx, 'tree', 'sub', 'entry.html'), GAME_HTML('Tree Game').replace('</body>', '<img src="art.png"></body>'));
fs.writeFileSync(path.join(fx, 'tree', 'sub', 'art.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

async function installFromTree(gameId, files, overrides = {}) {
  const staged = importer.stageFileTree(paths, files);
  try {
    const report = await importer.analyzeRoot(staged.root, { filenameHint: files[0].rel });
    assert(report.entry, `${gameId}: no entry detected`);
    assert(!report.errors.length, `${gameId}: ${report.errors.map((e) => e.message).join(';')}`);
    return games.finalizeInstall({
      paths, store, stagingDir: staged.root, gameId,
      manifestOverrides: { title: overrides.title || report.title, entryFile: report.entry.relative, singleFile: report.singleFile, ...overrides },
      origin: 'discover',
    });
  } finally {
    importer.cleanupStaging(staged.staging);
  }
}

const t0 = Date.now();
const r1 = await installFromTree('smoke-solo', [{ rel: 'solo.html', src: path.join(fx, 'solo.html') }], { title: 'Solo Game' });
assert(r1.entryExists && r1.singleFile, 'solo game record');
const r2 = await installFromTree('smoke-tree', [
  { rel: 'sub/entry.html', src: path.join(fx, 'tree', 'sub', 'entry.html') },
  { rel: 'sub/art.png', src: path.join(fx, 'tree', 'sub', 'art.png') },
], { title: 'Tree Game' });
assert(r2.entryFile === 'sub/entry.html' && !r2.singleFile, 'tree game keeps layout');
// Unsafe asset paths must be rejected.
let threw = false;
try { importer.stageFileTree(paths, [{ rel: '../evil.html', src: path.join(fx, 'solo.html') }]); } catch { threw = true; }
assert(threw, 'traversal asset path rejected');

// Zip path (EagleCraft-style): build a zip locally, extract + auto-detect.
const AdmZip = require(`${ROOT}/node_modules/adm-zip`);
const zip = new AdmZip();
zip.addFile('SomeGame-1.0/README.txt', Buffer.from('readme'));
zip.addFile('SomeGame-1.0/play.html', Buffer.from(GAME_HTML('Zip Game')));
const zipPath = path.join(fx, 'game.zip');
zip.writeZip(zipPath);
const staged = importer.stageFileTree(paths, []);
try {
  const root = importer.extractZipSafe(zipPath, path.join(staged.root, 'unzipped'));
  const report = await importer.analyzeRoot(root, {});
  assert(report.entry && report.entry.relative === 'play.html', `zip entry detection (${report.entry && report.entry.relative})`);
  const r3 = games.finalizeInstall({
    paths, store, stagingDir: root, gameId: 'smoke-zip',
    manifestOverrides: { title: 'Zip Game', entryFile: report.entry.relative, singleFile: false },
    origin: 'discover',
  });
  assert(r3.entryExists, 'zip game record');
} finally {
  importer.cleanupStaging(staged.staging);
}

// Integrity + stats + backup roundtrip.
const problems = games.integrityCheck({ paths, store });
assert(problems.ok, `integrity: ${JSON.stringify(problems.issues).slice(0, 300)}`);
store.upsertGame({ ...store.getGame('smoke-solo'), favorite: true, playTimeSeconds: 60 });
const b = backups.backupGame({ paths, store, gameId: 'smoke-solo', includeSaves: true, userDataPath: tmp, gameOpen: false });
assert(b.file && fs.existsSync(b.file), 'backup created');
games.uninstallGame({ paths, store, gameId: 'smoke-solo' });
assert(!store.getGame('smoke-solo'), 'uninstall removes record');
const rb = backups.restoreBackup({ paths, store, backupName: b.name, allowOverwrite: false, restoreSaves: true, userDataPath: tmp, gameOpen: false });
assert(rb.record.favorite === true, 'restore preserves favorite');
const rec = store.getGame('smoke-solo');
assert(rec && rec.playTimeSeconds === 60, 'restore preserves playtime');

console.log(`SMOKE OK: 3 installs (file/assets/zip) + integrity + backup roundtrip in ${Date.now() - t0} ms`);
