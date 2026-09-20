#!/usr/bin/env node
/**
 * build-catalog.mjs — builds catalog/catalog.json (the Discover catalog).
 *
 * Merges:
 *  1. every bundled game (with its raw.githubusercontent download URL so
 *     users can reinstall on demand),
 *  2. extraDownloads (always installable from Discover, even if the bundle
 *     fetch skipped them),
 *  3. external entries (source links + import guidance, never auto-downloaded).
 *
 * Usage: node tools/build-catalog.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'bundled-games');
const CATALOG_DIR = path.join(ROOT, 'catalog');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'bundle-sources.json'), 'utf8'));
const bundle = JSON.parse(fs.readFileSync(path.join(OUT, 'bundle.json'), 'utf8'));

function rawUrl(repo, relPath, head = null) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(repo || '');
  if (!m || !relPath) return null;
  // Pin to the fetched commit when known for reproducibility.
  return `https://raw.githubusercontent.com/${m[1]}/${head || 'main'}/${relPath}`;
}

// Map repo key -> head sha for pinning.
const repoHeadByUrl = {};
for (const src of config.sources) {
  if (src.repo && bundle.sources && bundle.sources[src.key]) {
    repoHeadByUrl[src.repo] = bundle.sources[src.key];
  }
}

const games = [];
const seen = new Set();

// 1. bundled games
for (const entry of bundle.games) {
  const manifest = JSON.parse(fs.readFileSync(path.join(OUT, entry.dir, 'playhub.manifest.json'), 'utf8'));
  const entryStat = fs.statSync(path.join(OUT, entry.dir, manifest.entryFile));
  const url = rawUrl(manifest.source.repo, manifest.source.path, repoHeadByUrl[manifest.source.repo]);
  seen.add(manifest.id);
  games.push({
    id: manifest.id,
    kind: 'file',
    title: manifest.title,
    author: manifest.author,
    description: manifest.description || '',
    license: (manifest.license && manifest.license.spdx) || 'Unknown',
    genres: manifest.genres || [],
    size: entryStat.size,
    url,
    file: manifest.source.path ? manifest.source.path.split('/').pop() : `${manifest.id}.html`,
    offline: !(manifest.network && manifest.network.required),
    qualityTier: manifest.qualityTier || null,
    sourceCollection: manifest.sourceCollection || null,
    repo: manifest.source.repo || null,
    homepage: manifest.source.homepage || null,
  });
}

// 2. extraDownloads (skip if already bundled)
for (const dl of config.extraDownloads) {
  if (seen.has(dl.id)) continue;
  seen.add(dl.id);
  games.push({
    id: dl.id,
    kind: 'file',
    title: dl.title,
    author: dl.author,
    description: dl.description || '',
    license: (dl.license && dl.license.spdx) || 'Unknown',
    genres: dl.genres || [],
    size: null,
    url: dl.url,
    file: `${dl.id}.html`,
    offline: true,
    qualityTier: null,
    sourceCollection: dl.collection || null,
    repo: null,
    homepage: dl.homepage || null,
  });
}

// 3. externals
for (const ext of config.external) {
  games.push({ ...ext, kind: 'external', size: ext.size || null, url: null });
}

// Sources summary
const sources = [];
for (const src of config.sources) {
  const count = games.filter((g) => g.repo === src.repo && g.kind === 'file').length;
  sources.push({
    collection: src.collection, repo: src.repo, homepage: src.homepage,
    license: src.license.spdx, count, head: bundle.sources[src.key] || null,
  });
}
const markvdCount = games.filter((g) => g.sourceCollection === 'MARKVD Games').length;
if (markvdCount) {
  sources.push({ collection: 'MARKVD Games', repo: null, homepage: 'https://markvd.net/games/', license: 'MIT', count: markvdCount, head: null });
}

games.sort((a, b) => String(a.title).localeCompare(String(b.title)));

fs.mkdirSync(CATALOG_DIR, { recursive: true });
fs.writeFileSync(path.join(CATALOG_DIR, 'catalog.json'), JSON.stringify({
  version: 1,
  updatedAt: new Date().toISOString(),
  bundleVersion: bundle.version,
  sources,
  games,
}, null, 2));

console.log(`catalog: ${games.length} entries (${bundle.games.length} bundled-installable, ${config.extraDownloads.length} direct, ${config.external.length} external)`);
for (const s of sources) console.log(`  ${s.collection}: ${s.count} (${s.license})`);
