#!/usr/bin/env node
/**
 * build-catalog.mjs — builds catalog/catalog.json (the Discover catalog).
 *
 * For every repo in tools/catalog-sources.json it:
 *  1. shallow-clones into .tools-cache/ (reused unless --fresh),
 *  2. enumerates every HTML game file (glob) or explicit picks (files),
 *  3. analyzes each file LOCALLY with the app's own doctor/importer engines,
 *  4. emits a catalog entry with PINNED direct-download URLs
 *     (https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>).
 *
 * Game files are NEVER copied into this repo: users download on demand from
 * the original hosts. `direct` entries (single-file sites, zips) are validated
 * and emitted as-is.
 *
 * Validation is strict: missing files, non-HTML content, undeclared local
 * assets, duplicate ids, or bad direct URLs fail the build with exit code 1.
 *
 * Usage: node tools/build-catalog.mjs [--fresh]
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

const CACHE = path.join(ROOT, '.tools-cache');
const CATALOG_DIR = path.join(ROOT, 'catalog');
const FRESH = process.argv.includes('--fresh');

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'catalog-sources.json'), 'utf8'));

let errors = 0;
const err = (msg) => { errors++; console.log(`  ERROR ${msg}`); };
const warn = (msg) => console.log(`  warn  ${msg}`);

function gitClone(repo, dir) {
  if (fs.existsSync(path.join(dir, '.git')) && !FRESH) {
    console.log('  reuse cache');
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

function repoSlug(repoUrl) {
  const m = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(repoUrl || '');
  return m ? m[1] : null;
}

function rawUrl(repoUrl, head, relPath) {
  const slug = repoSlug(repoUrl);
  if (!slug || !head || !relPath) return null;
  return `https://raw.githubusercontent.com/${slug}/${head}/${relPath}`;
}

/** List HTML files for the supported pattern shapes. Returns repo-relative paths with forward slashes. */
function globHtml(dir, pattern, excludeDirs = []) {
  const out = [];
  const excluded = (rel) => excludeDirs.some((d) => rel === d || rel.startsWith(`${d}/`));
  if (pattern === '**/*.html') {
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === '.git') continue;
        const full = path.join(d, e.name);
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (excluded(r)) continue;
        if (e.isDirectory()) walk(full, r);
        else if (e.isFile() && /\.html?$/i.test(e.name)) out.push(r);
      }
    };
    walk(dir, '');
  } else if (pattern.includes('/')) {
    const [sub] = pattern.split('/*');
    const base = path.join(dir, sub);
    const walk = (d, rel) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const r = `${rel}/${e.name}`;
        if (excluded(r)) continue;
        if (e.isDirectory()) walk(full, r);
        else if (e.isFile() && /\.html?$/i.test(e.name)) out.push(r);
      }
    };
    if (fs.existsSync(base)) walk(base, sub);
  } else {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile() && /\.html?$/i.test(e.name)) out.push(e.name);
    }
  }
  return out.sort();
}

function looksLikeHtml(text) {
  const head = text.slice(0, 20000).toLowerCase();
  return /<html|<head|<body|<script|<!doctype/.test(head);
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/\s*[-–—|]\s*90s Games\s*$/i, '')
    .replace(/\s*[-–—|]\s*(Action|Puzzle|Arcade|Racing) Game\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Repo-relative asset paths actually needed by the entry page.
 * HTML->HTML refs are navigation links (ignored); only non-HTML refs that
 * resolve to real files count as required downloads.
 */
function requiredAssets(text, entryAbs, repoDir) {
  const lr = doctor.extractLocalRefs(text, path.dirname(entryAbs), repoDir);
  const needed = [];
  for (const r of lr.refs) {
    if (lr.missing.includes(r)) continue;
    if (/\.html?$/i.test(r.split('?')[0])) continue;
    if (!path.extname(r)) continue;
    let abs;
    if (r.startsWith('/')) abs = path.join(repoDir, r.slice(1));
    else abs = path.resolve(path.dirname(entryAbs), r);
    const rel = path.relative(repoDir, abs).replace(/\\/g, '/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue; // escapes repo — ignore
    needed.push(rel);
  }
  return [...new Set(needed)].sort();
}

function validId(id) {
  return /^[a-z0-9][a-z0-9-_]{0,80}$/.test(id || '');
}

const games = [];
const seen = new Set();
const heads = {};

function addEntry(entry, where) {
  if (!validId(entry.id)) { err(`${where}: bad id "${entry.id}"`); return; }
  if (seen.has(entry.id)) { err(`${where}: duplicate id "${entry.id}"`); return; }
  if (!entry.title) { err(`${where}: missing title`); return; }
  seen.add(entry.id);
  games.push(entry);
}

function analyzeGameFile({ repoDir, rel, id, override = {}, src, head }) {
  const where = `${src.key}:${rel}`;
  const abs = path.join(repoDir, rel);
  if (!fs.existsSync(abs)) { err(`${where}: file missing`); return; }
  const size = fs.statSync(abs).size;
  if (size < 300) { err(`${where}: suspiciously small (${size} bytes)`); return; }
  const text = fs.readFileSync(abs, 'utf8');
  if (!looksLikeHtml(text)) { err(`${where}: does not look like an HTML document`); return; }

  const base = path.basename(rel, path.extname(rel));
  const docTitle = cleanTitle(doctor.extractTitle(text));
  const englishName = titleize(base);
  const title = (override.title || (docTitle && docTitle.length >= 2 ? docTitle : englishName)).slice(0, 120);
  const tags = [];
  if (!override.title && title.toLowerCase() !== englishName.toLowerCase()) tags.push(englishName);

  const hosts = doctor.extractResourceHosts(text);
  const trackers = doctor.detectTrackers(hosts);
  const input = doctor.detectInputHints(text);
  const storage = doctor.detectStorageHints(text);
  const stores = Object.entries(storage).filter(([, v]) => v).map(([k]) => k);

  // Assets: declared in config must exist; page must not need undeclared ones.
  const declared = (override.assets || []).map((a) => String(a).replace(/\\/g, '/'));
  for (const a of declared) {
    if (!fs.existsSync(path.join(repoDir, a))) err(`${where}: declared asset missing: ${a}`);
  }
  const needed = requiredAssets(text, abs, repoDir);
  const missing = needed.filter((n) => !declared.includes(n));
  if (missing.length) err(`${where}: needs local assets not listed in config: ${missing.join(', ')}`);
  const assets = declared.map((a) => ({
    path: a,
    url: rawUrl(src.repo, head, a),
    size: fs.existsSync(path.join(repoDir, a)) ? fs.statSync(path.join(repoDir, a)).size : null,
  }));
  if (assets.some((a) => !a.url)) err(`${where}: could not build asset URL (repo/head?)`);

  const url = rawUrl(src.repo, head, rel);
  if (!url) { err(`${where}: could not build download URL`); return; }

  const totalSize = size + assets.reduce((s, a) => s + (a.size || 0), 0);
  const description = (override.description || doctor.extractMetaDescription(text) || '').slice(0, 2000)
    || (stores.length ? `Uses browser storage (${stores.join(', ')}) — saves persist per game.` : '');

  addEntry({
    id,
    kind: 'file',
    title,
    author: src.author || 'Unknown',
    description,
    license: (src.license && src.license.spdx) || 'Unknown',
    licenseNote: src.licenseNote || override.licenseNote || null,
    genres: (override.genres && override.genres.length ? override.genres : guessGenres(`${title} ${base}`, `${base} ${rel}`)).slice(0, 3),
    tags: tags.slice(0, 6),
    size: totalSize,
    url,
    file: path.basename(rel),
    path: rel,
    assets: assets.length ? assets : null,
    offline: hosts.length === 0,
    hasTrackers: trackers.length > 0,
    qualityTier: override.qualityTier || null,
    sourceCollection: src.collection || null,
    repo: src.repo || null,
    homepage: src.homepage || null,
    language: override.language || src.language || 'en',
  }, where);
}

// ---------- repos ----------
fs.mkdirSync(CACHE, { recursive: true });
for (const src of config.repos) {
  console.log(`\n== ${src.key} ==`);
  const dir = path.join(CACHE, src.key);
  gitClone(src.repo, dir);
  const head = gitHead(dir);
  heads[src.key] = head;
  if (!head) { err(`${src.key}: could not determine HEAD`); continue; }
  if (!repoSlug(src.repo)) { err(`${src.key}: not a github repo URL: ${src.repo}`); continue; }

  if (src.mode === 'glob') {
    let files = globHtml(dir, src.pattern, src.excludeDirs || [])
      .filter((f) => !(src.exclude || []).includes(path.basename(f)) && !(src.exclude || []).includes(f));
    let tierOf = {};
    if (src.tiersFile) {
      try {
        const tiers = JSON.parse(fs.readFileSync(path.join(dir, src.tiersFile), 'utf8')).tiers;
        for (const [tier, list] of Object.entries(tiers)) for (const f of list) tierOf[f] = tier;
        const excluded = new Set();
        for (const t of src.excludeTiers || []) for (const f of (tiers[t] || [])) excluded.add(f);
        const before = files.length;
        files = files.filter((f) => !excluded.has(path.basename(f)));
        console.log(`  tiers: ${before} -> ${files.length}`);
      } catch (e) {
        err(`${src.key}: tiers unreadable: ${e.message}`);
      }
    }
    console.log(`  ${files.length} file(s)`);
    for (const rel of files) {
      const base = path.basename(rel, path.extname(rel));
      const id = slugify(`${src.idPrefix}-${base}`);
      analyzeGameFile({ repoDir: dir, rel, id, override: { qualityTier: tierOf[path.basename(rel)] || null }, src, head });
    }
  } else if (src.mode === 'files') {
    for (const pick of src.pick) {
      analyzeGameFile({ repoDir: dir, rel: pick.src, id: pick.id, override: pick, src, head });
    }
  } else {
    err(`${src.key}: unknown mode ${src.mode}`);
  }
}

// ---------- direct entries ----------
console.log('\n== direct ==');
for (const d of config.direct || []) {
  const where = `direct:${d.id}`;
  if (!validId(d.id)) { err(`${where}: bad id`); continue; }
  if (seen.has(d.id)) { err(`${where}: duplicate id`); continue; }
  if (!d.title) { err(`${where}: missing title`); continue; }
  if (!['file', 'zip'].includes(d.kind)) { err(`${where}: bad kind ${d.kind}`); continue; }
  if (!/^https:\/\//.test(d.url || '')) { err(`${where}: bad URL`); continue; }
  seen.add(d.id);
  games.push({
    id: d.id,
    kind: d.kind,
    title: String(d.title).slice(0, 120),
    author: d.author || 'Unknown',
    description: (d.description || '').slice(0, 2000),
    license: (d.license && d.license.spdx) || 'Unknown',
    licenseNote: d.licenseNote || null,
    genres: (d.genres || []).slice(0, 3),
    tags: [],
    size: null,
    url: d.url,
    file: null,
    path: null,
    assets: null,
    offline: d.offline ?? null,
    hasTrackers: false,
    qualityTier: null,
    sourceCollection: d.collection || null,
    repo: null,
    homepage: d.homepage || null,
    language: 'en',
  });
}
console.log(`  ${(config.direct || []).length} direct entries`);

// ---------- sources summary ----------
const sources = [];
const seenCollections = new Set();
for (const src of config.repos) {
  if (seenCollections.has(src.collection)) continue;
  seenCollections.add(src.collection);
  const same = config.repos.filter((r) => r.collection === src.collection);
  const count = games.filter((g) => g.sourceCollection === src.collection && g.repo).length;
  const licenses = [...new Set(same.map((r) => (r.license && r.license.spdx) || 'Unknown'))];
  sources.push({
    collection: src.collection,
    repo: same.length === 1 ? src.repo : same.map((r) => r.repo),
    homepage: src.homepage,
    license: licenses.length === 1 ? licenses[0] : licenses.join(' / '),
    count, head: same.length === 1 ? (heads[src.key] || null) : same.map((r) => heads[r.key] || null),
  });
}
for (const collection of [...new Set((config.direct || []).map((d) => d.collection))]) {
  const first = config.direct.find((d) => d.collection === collection);
  sources.push({
    collection, repo: null, homepage: first.homepage || null,
    license: (first.license && first.license.spdx) || 'Unknown',
    count: games.filter((g) => g.sourceCollection === collection).length, head: null,
  });
}

games.sort((a, b) => String(a.title).localeCompare(String(b.title)));

fs.mkdirSync(CATALOG_DIR, { recursive: true });
fs.writeFileSync(path.join(CATALOG_DIR, 'catalog.json'), JSON.stringify({
  version: 1,
  updatedAt: new Date().toISOString(),
  sources,
  games,
}, null, 2));

console.log(`\ncatalog: ${games.length} entries from ${sources.length} sources`);
for (const s of sources) console.log(`  ${s.collection}: ${s.count} (${s.license})`);
if (errors) {
  console.log(`\nFAILED: ${errors} error(s)`);
  process.exit(1);
}
console.log('\nOK: catalog built with no errors');
