'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AdmZip = require('adm-zip');
const importer = require('../src/main/importer.js');
const games = require('../src/main/games.js');
const { Store } = require('../src/main/store.js');

const GAME = '<!DOCTYPE html><html><head><title>Zippy Racer</title></head><body><canvas></canvas><script>addEventListener("keydown",()=>{});</script></body></html>';

function tempPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-imp-'));
  const p = {
    root,
    games: path.join(root, 'games'),
    thumbnails: path.join(root, 'thumbnails'),
    temp: path.join(root, 'temp'),
    dbFile: path.join(root, 'playhub.json'),
    settingsFile: path.join(root, 'settings.json'),
    layoutsFile: path.join(root, 'control-layouts.json'),
  };
  for (const d of [p.games, p.thumbnails, p.temp]) fs.mkdirSync(d, { recursive: true });
  return p;
}

function makeZip(file, entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) zip.addFile(name, Buffer.from(content));
  zip.writeZip(file);
}

describe('importer', () => {
  it('extracts zips safely (blocks traversal, unwraps single root)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-zip-'));
    const zf = path.join(dir, 'evil.zip');
    // Note: adm-zip normalizes '..' on addFile, so traversal entries are
    // injected by renaming (simulates zips crafted by other tools).
    const zip = new AdmZip();
    zip.addFile('mygame/index.html', Buffer.from(GAME));
    zip.addFile('trap1.txt', Buffer.from('pwned'));
    zip.addFile('trap2.txt', Buffer.from('pwned'));
    zip.addFile('mygame/__MACOSX/junk', Buffer.from('x'));
    zip.addFile('mygame/._junk', Buffer.from('x'));
    zip.getEntry('trap1.txt').entryName = '../evil.html';
    zip.getEntry('trap2.txt').entryName = '../../evil2.html';
    zip.writeZip(zf);
    const out = path.join(dir, 'out');
    fs.mkdirSync(out);
    const root = importer.extractZipSafe(zf, out);
    assert.ok(fs.existsSync(path.join(root, 'index.html')));
    assert.ok(!fs.existsSync(path.join(dir, 'evil.html')));
    assert.ok(!fs.existsSync(path.join(out, 'evil.html')));
    assert.ok(!fs.existsSync(path.join(os.tmpdir(), 'evil2.html')));
    assert.ok(!fs.existsSync(path.join(root, '__MACOSX', 'junk')));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rejects empty zips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-zip2-'));
    const zf = path.join(dir, 'empty.zip');
    new AdmZip().writeZip(zf);
    assert.throws(() => importer.extractZipSafe(zf, path.join(dir, 'o')), /no usable files/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('analyzes an html file end to end', async () => {
    const paths = tempPaths();
    const store = new Store(paths).load();
    const html = path.join(paths.root, 'cool-game.html');
    fs.writeFileSync(html, GAME);
    const { record, report } = await importer.importFromSource({
      paths, store, source: { kind: 'html', path: html },
    });
    assert.equal(report.title, 'Zippy Racer');
    assert.deepEqual(report.genres, ['Racing']);
    assert.equal(report.singleFile, true);
    assert.equal(record.entryFile, 'cool-game.html');
    assert.ok(fs.existsSync(path.join(paths.games, record.id, 'cool-game.html')));
    assert.ok(fs.existsSync(path.join(paths.games, record.id, 'playhub.manifest.json')));
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it('imports a zip with assets and detects images', async () => {
    const paths = tempPaths();
    const store = new Store(paths).load();
    const zf = path.join(paths.root, 'pack.zip');
    // Minimal 1x1 PNG.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from(GAME));
    zip.addFile('cover.png', png);
    zip.writeZip(zf);
    const { record, report } = await importer.importFromSource({ paths, store, source: { kind: 'zip', path: zf } });
    assert.deepEqual(report.images, ['cover.png']);
    assert.equal(record.singleFile, false);
    assert.ok(record.thumbnail && record.thumbnail.endsWith('.png'));
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it('fails cleanly when no html exists', async () => {
    const paths = tempPaths();
    const store = new Store(paths).load();
    const zf = path.join(paths.root, 'nope.zip');
    makeZip(zf, { 'readme.txt': 'hello' });
    await assert.rejects(
      importer.importFromSource({ paths, store, source: { kind: 'zip', path: zf } }),
      /No HTML file found/
    );
    assert.deepEqual(store.allGames(), []);
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it('uniqueGameId de-duplicates', () => {
    const paths = tempPaths();
    const store = new Store(paths).load();
    store.upsertGame({ id: 'snake', title: 'Snake' });
    assert.equal(games.uniqueGameId(paths, store, 'snake'), 'snake-2');
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it('integrityCheck finds missing entries', () => {
    const paths = tempPaths();
    const store = new Store(paths).load();
    const dir = path.join(paths.games, 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'playhub.manifest.json'), JSON.stringify({ id: 'broken', title: 'Broken', entryFile: 'gone.html' }));
    store.upsertGame({ id: 'broken', title: 'Broken', entryFile: 'gone.html' });
    const r = games.integrityCheck({ paths, store });
    assert.equal(r.ok, false);
    assert.ok(r.issues.some((i) => i.code === 'missing-entry'));
    fs.rmSync(paths.root, { recursive: true, force: true });
  });
});

describe('catalog asset staging', () => {
  it('stages entry + assets preserving repo-relative layout', async () => {
    const paths = tempPaths();
    const src = path.join(paths.root, 'dl');
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub', 'entry.html'), GAME.replace('</body>', '<img src="art.png"></body>'));
    fs.writeFileSync(path.join(src, 'sub', 'art.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    const staged = importer.stageFileTree(paths, [
      { rel: 'sub/entry.html', src: path.join(src, 'sub', 'entry.html') },
      { rel: 'sub/art.png', src: path.join(src, 'sub', 'art.png') },
    ]);
    try {
      assert.ok(fs.existsSync(path.join(staged.root, 'sub', 'entry.html')));
      assert.ok(fs.existsSync(path.join(staged.root, 'sub', 'art.png')));
      const report = await importer.analyzeRoot(staged.root, { filenameHint: 'entry.html' });
      assert.equal(report.entry.relative, path.join('sub', 'entry.html'));
      assert.equal(report.singleFile, false);
    } finally {
      importer.cleanupStaging(staged.staging);
    }
    fs.rmSync(paths.root, { recursive: true, force: true });
  });

  it('rejects unsafe asset paths', () => {
    const paths = tempPaths();
    const f = path.join(paths.root, 'x.html');
    fs.writeFileSync(f, GAME);
    for (const rel of ['../evil.html', 'a/../../evil.html', '/abs.html', 'C:/win.html', 'a\\b.html', '', 'a//b.html']) {
      assert.throws(() => importer.assertSafeRelPath(rel), /Invalid|Unsafe/, rel || '(empty)');
    }
    assert.throws(() => importer.stageFileTree(paths, [{ rel: '../evil.html', src: f }]), /Unsafe/);
    assert.ok(!fs.existsSync(path.join(paths.temp, '..', 'evil.html')));
    fs.rmSync(paths.root, { recursive: true, force: true });
  });
});
