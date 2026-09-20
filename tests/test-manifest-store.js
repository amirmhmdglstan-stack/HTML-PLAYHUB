'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const manifest = require('../src/main/manifest.js');
const { Store } = require('../src/main/store.js');

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-store-'));
  const p = {
    root,
    games: path.join(root, 'games'),
    thumbnails: path.join(root, 'thumbnails'),
    screenshots: path.join(root, 'screenshots'),
    backups: path.join(root, 'backups'),
    cache: path.join(root, 'cache'),
    temp: path.join(root, 'temp'),
    downloads: path.join(root, 'downloads'),
    logs: path.join(root, 'logs'),
    dbFile: path.join(root, 'playhub.json'),
    settingsFile: path.join(root, 'settings.json'),
    layoutsFile: path.join(root, 'control-layouts.json'),
    catalogCache: path.join(root, 'cache', 'catalog.json'),
  };
  for (const d of [p.games, p.thumbnails, p.screenshots, p.backups, p.cache, p.temp, p.downloads, p.logs]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return p;
}

describe('manifest', () => {
  it('validates good and bad manifests', () => {
    const good = manifest.normalizeManifest({ id: 'snake', title: 'Snake', entryFile: 'index.html' });
    assert.equal(manifest.validateManifest(good).ok, true);
    assert.equal(manifest.validateManifest({}).ok, false);
    assert.equal(manifest.validateManifest({ id: 'Bad ID!', title: 'x', entryFile: 'i.html' }).ok, false);
    assert.equal(manifest.validateManifest({ id: 'a', title: 'x', entryFile: '../evil.html' }).ok, false);
  });

  it('preserves unknown fields (forward compat)', () => {
    const m = manifest.normalizeManifest({ id: 'a', title: 't', entryFile: 'i.html', futureField: 42 });
    assert.equal(m.futureField, 42);
  });
});

describe('store', () => {
  it('persists games, settings and layouts atomically', () => {
    const paths = tempPaths();
    const s = new Store(paths).load();
    s.upsertGame({ id: 'g1', title: 'G1' });
    s.settings.theme = 'light';
    s.layouts.perGame.g1 = { buttons: [] };
    s.saveNow();
    assert.ok(fs.existsSync(paths.dbFile));
    const s2 = new Store(paths).load();
    assert.equal(s2.getGame('g1').title, 'G1');
    assert.equal(s2.settings.theme, 'light');
    assert.deepEqual(s2.layouts.perGame.g1, { buttons: [] });
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it('recovers from corrupt db with a backup', () => {
    const paths = tempPaths();
    fs.writeFileSync(paths.dbFile, '{not json!!!');
    const s = new Store(paths).load();
    assert.deepEqual(s.allGames(), []);
    const backups = fs.readdirSync(paths.root).filter((f) => f.includes('.corrupt-'));
    assert.equal(backups.length, 1);
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it('tracks sessions and playtime', () => {
    const paths = tempPaths();
    const s = new Store(paths).load();
    s.upsertGame({ id: 'g1', title: 'G1' });
    const secs = s.addSession('g1', '2026-01-01T10:00:00.000Z', '2026-01-01T10:02:00.000Z');
    assert.equal(secs, 120);
    assert.equal(s.getGame('g1').playTimeSeconds, 120);
    assert.equal(s.getGame('g1').playCount, 1);
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it('creates builtin collections', () => {
    const paths = tempPaths();
    const s = new Store(paths).load();
    s.ensureBuiltinCollections();
    assert.ok(s.db.collections.all);
    assert.ok(s.db.collections.favorites);
    fs.rmSync(paths.root, { recursive: true, force: true });
  });
});
