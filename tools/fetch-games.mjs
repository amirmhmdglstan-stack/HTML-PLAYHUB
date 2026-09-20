#!/usr/bin/env node
/**
 * fetch-games.mjs — builds bundled-games/ from tools/bundle-sources.json.
 *
 *  - shallow-clones each source repo into .tools-cache/
 *  - copies picked game files into bundled-games/<id>/
 *  - generates playhub.manifest.json per game (reusing src/main/* engines)
 *  - copies per-collection LICENSE texts
 *  - downloads extraDownloads (best-effort; skipped with a warning offline)
 *  - writes bundled-games/bundle.json
 *
 * Usage: node tools/fetch-games.mjs [--fresh]
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const doctor = require('../src/main/doctor.js');
const { guessGenres } = require('../src/main/importer.js');
const { titleize, slugify } = require('../src/main/util.js');
const { normalizeManifest } = require('../src/main/manifest.js');

const CACHE = path.join(ROOT, '.tools-cache');
const OUT = path.join(ROOT, 'bundled-games');
const FRESH = process.argv.includes('--fresh');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'bundle-sources.json'), 'utf8'));

function gitClone(repo, dir) {
  if (fs.existsSync(path.join(dir, '.git')) && !FRESH) {
    console.log(`  reuse ${dir}`);
    return;
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  console.log(`  clone ${repo}`);
  execFileSync('git', ['clone', '--depth', '1', '-q', repo, dir], { stdio: 'inherit' });
}

function gitHead(dir) {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function globHtml(dir, pattern) {
  // Minimal glob: supports "dir/*.html" and "*.html".
  const out = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (pattern.includes('/')) walk(full, r);
      } else if (e.isFile() && /\.html?$/i.test(e.name)) {
        out.push(r.replace(/\\/g, '/'));
      }
    }
  };
  if (pattern.includes('/')) {
    const [sub] = pattern.split('/*');
    const base = path.join(dir, sub);
    if (fs.existsSync(base)) walk(base, sub);
  } else {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && /\.html?$/i.test(e.name)) out.push(e.name);
    }
  }
  return out.sort();
}

function readHead(file, n = 3000000) {
  const fd = fs.openSync(file, 'r');
  try {
    const st = fs.fstatSync(fd);
    const buf = Buffer.alloc(Math.min(st.size, n));
    fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function copyLicense(repoDir, fileName) {
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING'];
  for (const c of candidates) {
    const src = path.join(repoDir, c);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT, fileName));
      return true;
    }
  }
  return false;
}

const bundleGames = [];
const sourceHeads = {};
let totalBytes = 0;

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });
// Clean previously generated game dirs (keep nothing stale).
for (const e of fs.readdirSync(OUT)) {
  if (e === '.gitkeep') continue;
  fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[-–—|]\s*90s Games\s*$/i, '')
    .replace(/\s*[-–—|]\s*(Action|Puzzle|Arcade|Racing) Game\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function addGame({ id, title, description, author, homepage, repo, sourcePath = null, license, collection, language, genres, tags = [], qualityTier, gameFile, entryName, nameHint = '', thumbFile = null, extraFiles = [], networkHosts = null }) {
  const dest = path.join(OUT, id);
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(gameFile, path.join(dest, entryName));
  for (const extra of extraFiles) {
    fs.copyFileSync(extra.src, path.join(dest, extra.dest));
  }
  let thumb = null;
  if (thumbFile && fs.existsSync(thumbFile)) {
    const ext = path.extname(thumbFile).toLowerCase();
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext)) {
      thumb = `thumb${ext}`;
      fs.copyFileSync(thumbFile, path.join(dest, thumb));
    }
  }
  const text = readHead(path.join(dest, entryName));
  const hosts = networkHosts ?? doctor.extractResourceHosts(text);
  const trackers = doctor.detectTrackers(hosts);
  const input = doctor.detectInputHints(text);
  const storage = doctor.detectStorageHints(text);
  const stores = Object.entries(storage).filter(([, v]) => v).map(([k]) => k);
  const manifest = normalizeManifest({
    id,
    title: (cleanTitle(title) || titleize(nameHint || entryName)).slice(0, 120),
    description: (description || doctor.extractMetaDescription(text) || '').slice(0, 2000),
    author: author || 'Unknown',
    source: { repo: repo || null, homepage: homepage || null, path: sourcePath || null },
    license,
    version: '1.0',
    genres: (genres && genres.length ? genres : guessGenres(`${title || ''} ${nameHint || ''}`, nameHint || entryName)).slice(0, 3),
    tags: tags.slice(0, 6),
    language: language || 'en',
    entryFile: entryName,
    singleFile: true,
    qualityTier: qualityTier || null,
    sourceCollection: collection || null,
    controls: {
      keyboard: input.keyboard, mouse: input.mouse, touch: input.touch, gamepad: input.gamepad,
      notes: stores.length ? `Browser storage detected (${stores.join(', ')}) — saves persist per game.` : '',
    },
    requirements: { keyboard: input.keyboard && !input.mouse && !input.touch, mouse: false, landscape: false },
    network: { required: hosts.length > 0, hosts, trackers },
    bundleVersion: config.bundleVersion || 1,
    addedAt: new Date().toISOString(),
  });
  fs.writeFileSync(path.join(dest, 'playhub.manifest.json'), JSON.stringify(manifest, null, 2));
  const size = fs.statSync(path.join(dest, entryName)).size;
  totalBytes += size;
  bundleGames.push({ id, dir: id, bundleVersion: config.bundleVersion || 1 });
  return { id, size, hosts: hosts.length };
}

// ---------- clone + bundle repo sources ----------
for (const src of config.sources) {
  console.log(`\n== ${src.key} ==`);
  const dir = path.join(CACHE, src.key);
  gitClone(src.repo, dir);
  sourceHeads[src.key] = gitHead(dir);
  copyLicense(dir, src.license.file) || console.log(`  !! no LICENSE found for ${src.key}`);

  if (src.mode === 'glob') {
    let files = globHtml(dir, src.pattern).filter((f) => !(src.exclude || []).includes(path.basename(f)) && !(src.exclude || []).includes(f));
    let tierOf = {};
    if (src.tiersFile) {
      try {
        const tiers = JSON.parse(fs.readFileSync(path.join(dir, src.tiersFile), 'utf8')).tiers;
        for (const [tier, list] of Object.entries(tiers)) for (const f of list) tierOf[f] = tier;
        const excluded = new Set();
        for (const t of src.excludeTiers || []) for (const f of (tiers[t] || [])) excluded.add(f);
        const before = files.length;
        files = files.filter((f) => !excluded.has(path.basename(f)));
        console.log(`  tiers: ${before} -> ${files.length} (excluded: ${[...excluded].join(', ') || 'none'})`);
      } catch (err) {
        console.log(`  !! tiers unreadable: ${err.message}`);
      }
    }
    console.log(`  ${files.length} game(s)`);
    for (const rel of files) {
      const base = path.basename(rel, path.extname(rel));
      const id = slugify(`${src.idPrefix}-${base}`);
      const text = readHead(path.join(dir, rel));
      const docTitle = cleanTitle(doctor.extractTitle(text));
      const englishName = titleize(base);
      const finalTitle = docTitle && docTitle.length >= 2 ? docTitle : englishName;
      const extraTags = finalTitle.toLowerCase() !== englishName.toLowerCase() ? [englishName] : [];
      addGame({
        id,
        title: finalTitle,
        tags: extraTags,
        author: src.author, homepage: src.homepage, repo: src.repo,
        license: src.license, collection: src.collection, language: src.language,
        qualityTier: tierOf[path.basename(rel)] || null,
        gameFile: path.join(dir, rel), entryName: 'game.html', nameHint: base, sourcePath: rel,
      });
    }
  } else if (src.mode === 'files') {
    for (const pick of src.pick) {
      const srcFile = path.join(dir, pick.src);
      if (!fs.existsSync(srcFile)) {
        console.log(`  !! missing ${pick.src}, skipping`);
        continue;
      }
      addGame({
        id: pick.id,
        title: pick.title,
        description: src.description || '',
        author: src.author, homepage: src.homepage, repo: src.repo,
        license: src.license, collection: src.collection, language: src.language || 'en',
        genres: pick.genres || null, sourcePath: pick.src,
        gameFile: srcFile, entryName: pick.dest || path.basename(pick.src),
        nameHint: pick.title || path.basename(pick.src, path.extname(pick.src)),
        thumbFile: pick.thumb ? path.join(dir, pick.thumb) : null,
        extraFiles: (pick.extra || []).map((e) => ({ src: path.join(dir, e), dest: path.basename(e) })),
      });
    }
  }
}

// ---------- direct downloads (best effort) ----------
console.log('\n== extraDownloads ==');
fs.writeFileSync(path.join(OUT, 'MARKVD-LICENSE.txt'),
  'MIT License\nCopyright (c) 2026 Mark, MARKVD-NET\n\n' +
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\n' +
  'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\n' +
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n\n' +
  'Source: https://markvd.net/games/ (each game file also carries this license inline)\n');
for (const dl of config.extraDownloads) {
  const dest = path.join(OUT, dl.id);
  try {
    console.log(`  GET ${dl.url}`);
    const res = await fetch(dl.url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) throw new Error('file too small, refusing');
    const text = buf.toString('utf8').slice(0, 200000);
    if (!/<html/i.test(text)) throw new Error('not an HTML document');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'game.html'), buf);
    addGame({
      id: dl.id, title: dl.title, description: dl.description,
      author: dl.author, homepage: dl.homepage, repo: null,
      license: { spdx: 'MIT', file: 'MARKVD-LICENSE.txt' },
      collection: dl.collection, language: 'en', genres: dl.genres,
      gameFile: path.join(dest, 'game.html'), entryName: 'game.html',
    });
    // addGame re-copied; remove duplicate nesting side effect (none — same file).
    console.log(`  ok ${dl.id} (${buf.length} bytes)`);
  } catch (err) {
    console.log(`  SKIP ${dl.id}: ${err.message}`);
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

fs.writeFileSync(path.join(OUT, 'bundle.json'), JSON.stringify({
  version: config.bundleVersion || 1,
  updatedAt: new Date().toISOString(),
  count: bundleGames.length,
  sources: sourceHeads,
  games: bundleGames.sort((a, b) => (a.id < b.id ? -1 : 1)),
}, null, 2));

fs.writeFileSync(path.join(OUT, 'README.md'),
  '# bundled-games/ (generated)\n\nThis directory is generated by `node tools/fetch-games.mjs` — do not edit by hand.\n\nEach subfolder is one game: the original game file(s) (verbatim, unmodified), a generated `playhub.manifest.json`, and a `thumb.*` image when the source provided one.\n\nPer-collection license texts live next to the folders (`*-LICENSE.txt`) and are referenced from each manifest. GPL-licensed games ship with their full license text and attribution.\n');

console.log(`\nDone: ${bundleGames.length} games, ${(totalBytes / 1024 / 1024).toFixed(1)} MB of game files.`);
