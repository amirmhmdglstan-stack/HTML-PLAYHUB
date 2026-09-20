#!/usr/bin/env node
/**
 * smoke-seed.mjs — headless end-to-end check of install/seed/backup/restore.
 * Replicates main.js seedBundledGames() against a temp data root using only
 * the pure-Node modules (no Electron needed).
 *
 * Usage: node tools/smoke-seed.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { Store } = require('../src/main/store.js');
const games = require('../src/main/games.js');
const backups = require('../src/main/backups.js');
const { normalizeManifest } = require('../src/main/manifest.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-seed-'));
const paths = {
  root,
  games: path.join(root, 'games'),
  thumbnails: path.join(root, 'thumbnails'),
  screenshots: path.join(root, 'screenshots'),
  backups: path.join(root, 'backups'),
  cache: path.join(root, 'cache'),
  temp: path.join(root, 'temp'),
  downloads: path.join(root, 'downloads'),
  dbFile: path.join(root, 'playhub.json'),
  settingsFile: path.join(root, 'settings.json'),
  layoutsFile: path.join(root, 'control-layouts.json'),
};
for (const d of [paths.games, paths.thumbnails, paths.screenshots, paths.backups, paths.cache, paths.temp, paths.downloads]) {
  fs.mkdirSync(d, { recursive: true });
}

const store = new Store(paths).load();
const bundleRoot = path.join(ROOT, 'bundled-games');
const bundle = JSON.parse(fs.readFileSync(path.join(bundleRoot, 'bundle.json'), 'utf8'));

console.log(`seeding ${bundle.games.length} games into ${root} …`);
const t0 = Date.now();
let failed = 0;
for (const entry of bundle.games) {
  try {
    const srcDir = path.join(bundleRoot, entry.dir);
    const manifest = JSON.parse(fs.readFileSync(path.join(srcDir, 'playhub.manifest.json'), 'utf8'));
    const thumb = ['thumb.png', 'thumb.jpg', 'thumbnail.png'].map((n) => path.join(srcDir, n)).find((p) => fs.existsSync(p)) || null;
    games.finalizeInstall({
      paths, store, stagingDir: srcDir, gameId: entry.id,
      manifestOverrides: normalizeManifest({ ...manifest, id: entry.id }),
      thumbnailSrc: thumb, origin: 'bundled', managed: true,
    });
  } catch (err) {
    failed++;
    console.log(`  FAIL ${entry.id}: ${err.message}`);
  }
}
console.log(`seeded in ${Date.now() - t0} ms, failed=${failed}`);

// Integrity sweep
const integ = games.integrityCheck({ paths, store });
console.log(`integrity: ok=${integ.ok} issues=${integ.issues.length}`);
for (const i of integ.issues.slice(0, 10)) console.log('  ' + i.message);

// Favorite + session + backup/restore roundtrip on two games
const sample = store.allGames()[0];
store.upsertGame({ ...sample, favorite: true });
store.addSession(sample.id, new Date(Date.now() - 60000).toISOString(), new Date().toISOString());
const b = backups.backupGame({ paths, store, gameId: sample.id, includeSaves: false, userDataPath: root, gameOpen: false });
console.log(`backup: ${b.name} (${b.size} bytes)`);
games.uninstallGame({ paths, store, gameId: sample.id });
console.log(`after uninstall: installed=${store.allGames().length} (expect ${bundle.games.length - 1})`);
const r = backups.restoreBackup({ paths, store, backupName: b.name, userDataPath: root, gameOpen: false });
console.log(`restored: ${r.record.id} favorite=${r.record.favorite} playTime=${r.record.playTimeSeconds}s saves=${r.savesRestored}`);
store.saveNow();
console.log(`db size: ${fs.statSync(paths.dbFile).size} bytes`);
fs.rmSync(root, { recursive: true, force: true });

if (failed || !integ.ok) {
  console.log('SMOKE FAILED');
  process.exit(1);
}
console.log('SMOKE OK');
