#!/usr/bin/env node
/**
 * audit-games.mjs — CI quality gate over bundled-games/.
 *
 * For every bundled game it verifies:
 *  - manifest exists, validates, id matches folder
 *  - entry file exists and is non-trivial HTML
 *  - license + source attribution present
 *  - the doctor engine finds an entry and reports no errors
 *  - no suspicious packaging (absolute paths impossible by construction)
 *
 * Also validates catalog/catalog.json schema.
 * Exit code 1 on any error. Warnings are reported but pass.
 *
 * Usage: node tools/audit-games.mjs [--strict]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const doctor = require('../src/main/doctor.js');
const { validateManifest } = require('../src/main/manifest.js');

const STRICT = process.argv.includes('--strict');
const OUT = path.join(ROOT, 'bundled-games');
const bundle = JSON.parse(fs.readFileSync(path.join(OUT, 'bundle.json'), 'utf8'));

let errors = 0;
let warnings = 0;
const err = (msg) => { errors++; console.log(`  ERROR ${msg}`); };
const warn = (msg) => { warnings++; console.log(`  warn  ${msg}`); };

console.log(`auditing ${bundle.games.length} bundled games…`);
const stats = { offline: 0, online: 0, trackers: 0, keyboard: 0, totalBytes: 0 };

for (const entry of bundle.games) {
  const dir = path.join(OUT, entry.dir);
  const label = entry.id;
  if (!fs.existsSync(dir)) { err(`${label}: folder missing`); continue; }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, 'playhub.manifest.json'), 'utf8'));
  } catch {
    err(`${label}: manifest unreadable`); continue;
  }
  if (manifest.id !== entry.id) err(`${label}: manifest id mismatch (${manifest.id})`);
  const v = validateManifest(manifest);
  for (const e of v.errors) err(`${label}: ${e}`);
  if (!manifest.author || manifest.author === 'Unknown') warn(`${label}: no author`);
  if (!manifest.license || !manifest.license.spdx || manifest.license.spdx === 'Unknown') err(`${label}: no license recorded`);
  if (manifest.license && manifest.license.file && !fs.existsSync(path.join(OUT, manifest.license.file))) {
    err(`${label}: license file ${manifest.license.file} missing`);
  }
  if (!manifest.source || (!manifest.source.repo && !manifest.source.homepage)) warn(`${label}: no source recorded`);

  const entryAbs = path.join(dir, manifest.entryFile || '');
  if (!manifest.entryFile || !fs.existsSync(entryAbs)) { err(`${label}: entry file missing`); continue; }
  const size = fs.statSync(entryAbs).size;
  stats.totalBytes += size;
  if (size < 300) err(`${label}: entry suspiciously small (${size} bytes)`);
  const head = fs.readFileSync(entryAbs, 'utf8').slice(0, 20000);
  if (!/<html/i.test(head)) err(`${label}: entry does not look like HTML`);

  // Doctor pass over the folder.
  const files = doctor.syncWalk(dir).filter((f) => !f.relative.endsWith('playhub.manifest.json') && !/^thumb\./.test(f.relative));
  const analysis = doctor.analyzeDirectory(dir, files);
  for (const e of analysis.errors) err(`${label}: doctor: ${e.message}`);
  if (!analysis.entry) { err(`${label}: doctor found no entry`); continue; }
  if (analysis.offlineCapable) stats.offline++; else stats.online++;
  if (analysis.trackers.length) stats.trackers++;
  if (analysis.input.keyboard) stats.keyboard++;
  if (STRICT) for (const w of analysis.warnings) warn(`${label}: ${w.message}`);
}

// Catalog validation
console.log('validating catalog…');
const catalogPath = path.join(ROOT, 'catalog', 'catalog.json');
if (!fs.existsSync(catalogPath)) {
  err('catalog/catalog.json missing (run node tools/build-catalog.mjs)');
} else {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog.games) || !catalog.games.length) err('catalog has no games');
  else {
    const ids = new Set();
    for (const g of catalog.games) {
      if (!g.id || !g.title) { err('catalog entry missing id/title'); continue; }
      if (ids.has(g.id)) err(`catalog duplicate id: ${g.id}`);
      ids.add(g.id);
      if (g.kind === 'file' && !g.url) err(`catalog ${g.id}: installable entry without URL`);
      if (g.kind === 'external' && !g.homepage) err(`catalog ${g.id}: external entry without homepage`);
      if (!g.license) warn(`catalog ${g.id}: no license`);
    }
    // Every bundled game should be reinstallable via the catalog.
    for (const entry of bundle.games) {
      if (!ids.has(entry.id)) err(`catalog missing bundled game ${entry.id}`);
    }
  }
}

console.log(`\nstats: ${bundle.games.length} games, ${(stats.totalBytes / 1024 / 1024).toFixed(1)} MB, offline=${stats.offline} online=${stats.online} trackers=${stats.trackers} keyboard=${stats.keyboard}`);
console.log(`result: ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
