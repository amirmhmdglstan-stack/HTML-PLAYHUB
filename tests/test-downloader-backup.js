'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { download } = require('../src/main/downloader.js');
const backups = require('../src/main/backups.js');
const { Store } = require('../src/main/store.js');

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-dl-'));
  const p = {
    root,
    games: path.join(root, 'games'),
    thumbnails: path.join(root, 'thumbnails'),
    screenshots: path.join(root, 'screenshots'),
    backups: path.join(root, 'backups'),
    cache: path.join(root, 'cache'),
    temp: path.join(root, 'temp'),
    dbFile: path.join(root, 'playhub.json'),
    settingsFile: path.join(root, 'settings.json'),
    layoutsFile: path.join(root, 'control-layouts.json'),
  };
  for (const d of [p.games, p.thumbnails, p.screenshots, p.backups, p.cache, p.temp]) {
    fs.mkdirSync(d, { recursive: true });
  }
  return p;
}

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}

describe('downloader', () => {
  it('downloads with progress + follows redirects', async () => {
    const body = 'x'.repeat(5000);
    const { srv, base } = await serve((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, { Location: '/file' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Length': body.length });
      res.end(body);
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-dlfile-'));
    let last = null;
    const r = await download({
      url: `${base}/redir`, destFile: path.join(dir, 'f.bin'),
      onProgress: (received, total) => { last = { received, total }; },
    });
    assert.equal(r.bytes, 5000);
    assert.equal(fs.readFileSync(path.join(dir, 'f.bin'), 'utf8'), body);
    assert.equal(last.total, 5000);
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('fails after retries on 404 and cleans temp files', async () => {
    const { srv, base } = await serve((req, res) => {
      res.writeHead(404);
      res.end('no');
    });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-dl404-'));
    await assert.rejects(download({ url: `${base}/missing`, destFile: path.join(dir, 'f.bin'), retries: 1 }), /HTTP 404/);
    assert.deepEqual(fs.readdirSync(dir), []);
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('backups', () => {
  it('backup + restore round-trips game, stats and saves', () => {
    const paths = tempPaths();
    const store = new Store(paths).load();
    const userData = path.join(paths.root, 'userdata');
    const gameDir = path.join(paths.games, 'g1');
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'index.html'), '<html><title>G</title></html>');
    fs.writeFileSync(path.join(gameDir, 'playhub.manifest.json'), JSON.stringify({ id: 'g1', title: 'G', entryFile: 'index.html' }));
    const partDir = path.join(userData, 'Partitions', 'persist:playhub-g1');
    fs.mkdirSync(partDir, { recursive: true });
    fs.writeFileSync(path.join(partDir, 'save.dat'), 'progress!');
    store.upsertGame({ id: 'g1', title: 'G', entryFile: 'index.html', favorite: true, playTimeSeconds: 60 });

    const b = backups.backupGame({ paths, store, gameId: 'g1', includeSaves: true, userDataPath: userData, gameOpen: false });
    assert.equal(b.savesIncluded, true);
    assert.ok(fs.existsSync(b.file));

    // Simulate disaster: wipe game + saves.
    fs.rmSync(gameDir, { recursive: true, force: true });
    fs.rmSync(partDir, { recursive: true, force: true });
    store.removeGame('g1');

    const r = backups.restoreBackup({ paths, store, backupName: b.name, allowOverwrite: false, restoreSaves: true, userDataPath: userData, gameOpen: false });
    assert.equal(r.record.id, 'g1');
    assert.equal(r.savesRestored, true);
    assert.ok(fs.existsSync(path.join(gameDir, 'index.html')));
    assert.equal(fs.readFileSync(path.join(partDir, 'save.dat'), 'utf8'), 'progress!');
    assert.equal(store.getGame('g1').favorite, true);

    // Refuses to overwrite without explicit consent.
    assert.throws(() => backups.restoreBackup({ paths, store, backupName: b.name, userDataPath: userData }), /already installed/);
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it('backup while game open skips saves (never corrupts)', () => {
    const paths = tempPaths();
    const store = new Store(paths).load();
    const gameDir = path.join(paths.games, 'g2');
    fs.mkdirSync(gameDir, { recursive: true });
    fs.writeFileSync(path.join(gameDir, 'index.html'), '<html></html>');
    fs.writeFileSync(path.join(gameDir, 'playhub.manifest.json'), JSON.stringify({ id: 'g2', title: 'G2', entryFile: 'index.html' }));
    store.upsertGame({ id: 'g2', title: 'G2', entryFile: 'index.html' });
    const b = backups.backupGame({ paths, store, gameId: 'g2', includeSaves: true, userDataPath: paths.root, gameOpen: true });
    assert.equal(b.savesIncluded, false);
    assert.equal(b.savesSkippedOpen, true);
    fs.rmSync(paths.root, { recursive: true, force: true });
  });
});
