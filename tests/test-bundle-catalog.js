'use strict';
// Guards the generated bundle + catalog: every entry must be attributable.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

describe('bundle + catalog integrity', () => {
  it('bundle.json matches folders on disk', () => {
    const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'bundled-games', 'bundle.json'), 'utf8'));
    assert.ok(bundle.games.length > 200, 'expected 200+ bundled games');
    for (const g of bundle.games) {
      const dir = path.join(ROOT, 'bundled-games', g.dir);
      assert.ok(fs.existsSync(path.join(dir, 'playhub.manifest.json')), g.id);
      const m = JSON.parse(fs.readFileSync(path.join(dir, 'playhub.manifest.json'), 'utf8'));
      assert.equal(m.id, g.id);
      assert.ok(m.title && m.title.length >= 2, g.id);
      assert.ok(m.author && m.author !== 'Unknown', g.id);
      assert.ok(m.license && m.license.spdx && m.license.spdx !== 'Unknown', g.id);
      assert.ok(fs.existsSync(path.join(dir, m.entryFile)), `${g.id} entry`);
    }
  });

  it('catalog covers the bundle and externals explain themselves', () => {
    const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'catalog.json'), 'utf8'));
    const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'bundled-games', 'bundle.json'), 'utf8'));
    const ids = new Set(catalog.games.map((g) => g.id));
    for (const g of bundle.games) assert.ok(ids.has(g.id), `catalog missing ${g.id}`);
    for (const g of catalog.games) {
      assert.ok(g.title, g.id);
      if (g.kind === 'external') {
        assert.ok(g.homepage, `${g.id} homepage`);
        assert.ok(g.whyExternal && g.whyExternal.length > 20, `${g.id} whyExternal`);
      } else {
        assert.ok(g.url && g.url.startsWith('https://'), `${g.id} url`);
      }
    }
  });

  it('no E-tier stubs leaked into the bundle', () => {
    const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, 'bundled-games', 'bundle.json'), 'utf8'));
    const stubs = ['blackjack-table', 'connect-arena', 'flappy-glider', 'lantern-memory', 'mahjong-link', 'mole-market', 'penalty-rush', 'stack-tower', 'word-grid'];
    for (const s of bundle.games) {
      assert.ok(!stubs.includes(s.id.replace(/^mini-/, '')), s.id);
    }
  });
});
