'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('../src/main/util.js');

describe('util', () => {
  it('slugify normalizes titles', () => {
    assert.equal(util.slugify('Hello World!'), 'hello-world');
    assert.equal(util.slugify('  90s Games: Snake  '), '90s-games-snake');
    assert.equal(util.slugify('', 'fallback'), 'fallback');
    assert.equal(util.slugify('霓虹装甲'), 'game');
  });

  it('titleize prettifies filenames', () => {
    assert.equal(util.titleize('snake-game.html'), 'Snake Game');
    assert.equal(util.titleize('tetris.html'), 'Tetris');
  });

  it('formatBytes / formatDuration', () => {
    assert.equal(util.formatBytes(500), '500 B');
    assert.equal(util.formatBytes(2048), '2.0 KB');
    assert.equal(util.formatDuration(0), '0s');
    assert.equal(util.formatDuration(90), '1m');
    assert.equal(util.formatDuration(8040), '2h 14m');
  });

  it('mimeFor maps game asset types', () => {
    assert.match(util.mimeFor('a.html'), /text\/html/);
    assert.match(util.mimeFor('a.js'), /javascript/);
    assert.match(util.mimeFor('a.wasm'), /wasm/);
    assert.equal(util.mimeFor('a.unknown-xyz'), 'application/octet-stream');
  });

  it('safeJoin blocks traversal', () => {
    const root = path.join(os.tmpdir(), 'playhub-test-root');
    assert.ok(util.safeJoin(root, 'games', 'x', 'index.html'));
    assert.equal(util.safeJoin(root, '..', 'evil.html'), null);
    assert.equal(util.safeJoin(root, 'a', '..', '..', 'evil'), null);
  });

  it('atomicWriteFileSync round-trips', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-atomic-'));
    const file = path.join(dir, 'db.json');
    util.atomicWriteFileSync(file, '{"a":1}');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"a":1}');
    assert.deepEqual(fs.readdirSync(dir), ['db.json']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('walkFiles caps runaway packages', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-walk-'));
    fs.writeFileSync(path.join(dir, 'a.html'), 'x'.repeat(100));
    const { files, totalBytes } = await util.walkFiles(dir);
    assert.equal(files.length, 1);
    assert.equal(totalBytes, 100);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
