'use strict';
/**
 * test-catalog.js — the committed Discover catalog must be a valid,
 * directly-installable game list: schema, unique ids, https URLs, safe
 * asset paths, present licenses, consistent sources summary.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'catalog.json'), 'utf8'));

describe('discover catalog', () => {
  it('has hundreds of entries from many sources', () => {
    assert.ok(Array.isArray(catalog.games) && catalog.games.length >= 500,
      `expected 500+ entries, got ${catalog.games.length}`);
    assert.ok(Array.isArray(catalog.sources) && catalog.sources.length >= 15,
      `expected 15+ sources, got ${catalog.sources.length}`);
  });

  it('every entry validates', () => {
    const ids = new Set();
    for (const g of catalog.games) {
      assert.match(g.id, /^[a-z0-9][a-z0-9-_]{0,80}$/, `bad id ${g.id}`);
      assert.ok(!ids.has(g.id), `duplicate id ${g.id}`);
      ids.add(g.id);
      assert.ok(g.title && g.title.length <= 120, `${g.id}: title`);
      assert.ok(['file', 'zip', 'external'].includes(g.kind), `${g.id}: kind`);
      if (g.kind !== 'external') {
        assert.match(g.url || '', /^https:\/\//, `${g.id}: installable entry needs an https URL`);
      } else {
        assert.ok(g.homepage, `${g.id}: external entry needs a homepage`);
      }
      assert.ok(g.license, `${g.id}: license recorded`);
      assert.ok(g.offline === true || g.offline === false || g.offline === null, `${g.id}: offline flag`);
      for (const a of g.assets || []) {
        assert.ok(!a.path.includes('\\') && !a.path.split('/').some((p) => !p || p === '.' || p === '..'),
          `${g.id}: unsafe asset path ${a.path}`);
        assert.match(a.url || '', /^https:\/\//, `${g.id}: asset needs https URL`);
      }
    }
  });

  it('sources summary matches entries', () => {
    for (const s of catalog.sources) {
      const count = catalog.games.filter((g) => g.sourceCollection === s.collection).length;
      assert.equal(count, s.count, `source ${s.collection} count`);
    }
    const known = new Set(catalog.sources.map((s) => s.collection));
    for (const g of catalog.games) assert.ok(known.has(g.sourceCollection), `${g.id}: unknown sourceCollection`);
  });

  it('covers every promised source family', () => {
    const ids = new Set(catalog.games.map((g) => g.id));
    for (const must of ['voxelcraft', 'operation-ironhold', 'the-maze', 'reversi', 'backgammon',
      'tetris-billritz', 'blue-run', 'nightdrive', 'doom-1993', 'microdoom-v1-1',
      'velvetshuffle-cards', 'versant', 'wheres-walter', 'emberhold', 'sky-hopper',
      'prism-pop', 'last-stand-z', 'eaglercraftx-1-8', 'markvd-dirtnought',
      'localgames-chronosphire', 'the-backdooms']) {
      assert.ok(ids.has(must), `catalog must include ${must}`);
    }
    const by = (p) => catalog.games.filter((g) => g.id.startsWith(p)).length;
    assert.ok(by('90s-') >= 100, '90s games');
    assert.ok(by('mini-') >= 100, 'mini browser games');
    assert.ok(by('offline-') >= 250, 'offline pack');
  });

  it('multi-file games declare their assets', () => {
    const byId = Object.fromEntries(catalog.games.map((g) => [g.id, g]));
    assert.ok((byId['eternal-ride'].assets || []).length === 5, 'eternal-ride assets');
    assert.ok((byId['the-backdooms'].assets || []).length === 2, 'backdooms soundtrack');
    assert.ok((byId['versant'].assets || []).length === 1, 'versant logo');
  });
});
