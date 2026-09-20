'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const doctor = require('../src/main/doctor.js');

const GAME_HTML = `<!DOCTYPE html><html><head><title>Snake Deluxe</title>
<meta name="description" content="Eat dots.">
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
</head><body><canvas id="c"></canvas>
<script>
window.addEventListener('keydown', (e) => { if (e.code === 'ArrowUp') move(); });
canvas.addEventListener('click', shoot);
localStorage.setItem('hi', '1');
</script>
<p>see <a href="https://example.com/docs">docs</a></p>
</body></html>`;

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playhub-doc-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

describe('doctor', () => {
  it('extracts titles and descriptions', () => {
    assert.equal(doctor.extractTitle(GAME_HTML), 'Snake Deluxe');
    assert.equal(doctor.extractMetaDescription(GAME_HTML), 'Eat dots.');
    assert.equal(doctor.extractTitle('<html></html>'), null);
  });

  it('finds resource hosts but not plain links', () => {
    const res = doctor.extractResourceHosts(GAME_HTML);
    assert.deepEqual(res, ['cdnjs.cloudflare.com']);
    const all = doctor.extractExternalHosts(GAME_HTML);
    assert.ok(all.includes('example.com'));
  });

  it('detects trackers, input and storage', () => {
    assert.deepEqual(doctor.detectTrackers(['www.googletagmanager.com', 'example.com']), ['www.googletagmanager.com']);
    const input = doctor.detectInputHints(GAME_HTML);
    assert.equal(input.keyboard, true);
    assert.equal(input.mouse, true);
    const storage = doctor.detectStorageHints(GAME_HTML);
    assert.equal(storage.localStorage, true);
    assert.equal(storage.indexedDB, false);
  });

  it('scores entry points sensibly', () => {
    const dir = fixture({
      'index.html': GAME_HTML,
      'docs/readme.html': '<html><head><title>Readme</title></head></html>',
      'old/backup-index.html': '<html></html>',
    });
    const files = doctor.syncWalk(dir);
    const scored = files.map((f) => ({ rel: f.relative, ...doctor.scoreEntryPoint(f, dir) }))
      .sort((a, b) => b.score - a.score);
    assert.equal(scored[0].rel, 'index.html');
    assert.ok(scored[0].score > 50);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('analyzeDirectory produces a full verdict', () => {
    const dir = fixture({ 'index.html': GAME_HTML, 'art/hero.png': Buffer.alloc(100) });
    const files = doctor.syncWalk(dir);
    const a = doctor.analyzeDirectory(dir, files);
    assert.equal(a.entry.relative, 'index.html');
    assert.equal(a.offlineCapable, false);
    assert.deepEqual(a.externalHosts, ['cdnjs.cloudflare.com']);
    assert.ok(a.linkHosts.includes('example.com'));
    assert.equal(a.input.keyboard, true);
    assert.ok(a.warnings.some((w) => w.code === 'external-deps'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('flags missing local assets', () => {
    const dir = fixture({ 'index.html': '<html><head><title>T</title></head><body><img src="missing.png"><script src="js/gone.js"></script></body></html>' });
    const files = doctor.syncWalk(dir);
    const a = doctor.analyzeDirectory(dir, files);
    assert.ok(a.localRefs.missing.includes('missing.png'));
    assert.ok(a.warnings.some((w) => w.code === 'missing-assets'));
    assert.equal(a.offlineCapable, true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('diagnoseGame summarizes checks', () => {
    const dir = fixture({ 'index.html': GAME_HTML });
    const d = doctor.diagnoseGame(dir, 'index.html');
    const byName = Object.fromEntries(d.checks.map((c) => [c.name, c]));
    assert.equal(byName['Entry point'].status, 'ok');
    assert.equal(byName['Offline capable'].status, 'warn');
    assert.equal(d.summary, 'warn');
    const broken = doctor.diagnoseGame(dir, 'nope.html');
    assert.equal(broken.summary, 'fail');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
