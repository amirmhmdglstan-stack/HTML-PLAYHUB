#!/usr/bin/env node
/**
 * audit-catalog.mjs — CI quality gate over catalog/catalog.json.
 *
 * Always checks:
 *  - schema of every entry (id, title, kind, https URL, assets, license)
 *  - unique ids, valid asset paths (relative, no traversal)
 *  - sources summary consistent with entries
 *  - every installable entry has a URL
 *
 * With --check-urls it additionally performs a liveness check of every
 * download URL (entry + assets): HEAD with Range-GET fallback, retries.
 * 404/DNS/timeout = error; 429/5xx = warning (transient).
 * Exit code 1 on any error. Warnings pass.
 *
 * Usage: node tools/audit-catalog.mjs [--check-urls]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK_URLS = process.argv.includes('--check-urls');

let errors = 0;
let warnings = 0;
const err = (msg) => { errors++; console.log(`  ERROR ${msg}`); };
const warn = (msg) => { warnings++; console.log(`  warn  ${msg}`); };

const catalog = JSON.parse(fs.readFileSync(path.join(ROOT, 'catalog', 'catalog.json'), 'utf8'));
if (!Array.isArray(catalog.games) || !catalog.games.length) {
  console.log('  ERROR catalog has no games');
  process.exit(1);
}

console.log(`auditing ${catalog.games.length} catalog entries…`);
const stats = { file: 0, zip: 0, external: 0, offline: 0, online: 0, unknownNet: 0, trackers: 0, assets: 0 };
const ids = new Set();

for (const g of catalog.games) {
  const label = g.id || '(no id)';
  if (!g.id || !/^[a-z0-9][a-z0-9-_]{0,80}$/.test(g.id)) { err(`${label}: bad id`); continue; }
  if (ids.has(g.id)) err(`${label}: duplicate id`);
  ids.add(g.id);
  if (!g.title) err(`${label}: missing title`);
  if (!['file', 'zip', 'external'].includes(g.kind)) err(`${label}: bad kind ${g.kind}`);
  if (g.kind !== 'external' && !/^https:\/\//.test(g.url || '')) err(`${label}: installable entry without https URL`);
  if (g.kind === 'external' && !g.homepage) err(`${label}: external entry without homepage`);
  if (!g.license) warn(`${label}: no license`);
  if (g.offline !== true && g.offline !== false && g.offline !== null) err(`${label}: bad offline flag`);
  if (g.size !== null && (!Number.isInteger(g.size) || g.size < 0)) err(`${label}: bad size`);
  stats[g.kind] = (stats[g.kind] || 0) + 1;
  if (g.offline === true) stats.offline++;
  else if (g.offline === false) stats.online++;
  else stats.unknownNet++;
  if (g.hasTrackers) stats.trackers++;
  for (const a of g.assets || []) {
    stats.assets++;
    if (!a.path || a.path.includes('\\') || a.path.split('/').some((p) => !p || p === '.' || p === '..')) {
      err(`${label}: unsafe asset path ${JSON.stringify(a.path)}`);
    }
    if (!/^https:\/\//.test(a.url || '')) err(`${label}: asset without https URL: ${a.path}`);
  }
}

// Sources summary consistency.
if (Array.isArray(catalog.sources)) {
  for (const s of catalog.sources) {
    const count = catalog.games.filter((g) => g.sourceCollection === s.collection).length;
    if (count !== s.count) err(`source "${s.collection}": summary count ${s.count} != actual ${count}`);
    const heads = Array.isArray(s.head) ? s.head : [s.head];
    for (const h of heads) {
      if (h !== null && !/^[0-9a-f]{40}$/.test(h)) err(`source "${s.collection}": bad head ${h}`);
    }
  }
  const covered = new Set(catalog.sources.map((s) => s.collection));
  for (const g of catalog.games) {
    if (!covered.has(g.sourceCollection)) err(`${g.id}: sourceCollection "${g.sourceCollection}" missing from sources summary`);
  }
} else {
  warn('no sources summary');
}

async function checkOne(url, where) {
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 25000);
      let res;
      try {
        res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: ctl.signal });
        if (res.status === 405 || res.status === 403) {
          res = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: ctl.signal });
        }
      } finally {
        clearTimeout(t);
      }
      if (res.status === 429 || res.status >= 500) {
        warn(`${where}: HTTP ${res.status} (transient, retry ${i}/${attempts})`);
      } else if (res.status >= 200 && res.status < 400) {
        return;
      } else {
        err(`${where}: HTTP ${res.status}`);
        return;
      }
    } catch (e) {
      if (i === attempts) err(`${where}: unreachable (${e.cause?.code || e.message})`);
    }
    await new Promise((r) => setTimeout(r, 1500 * i));
  }
}

if (CHECK_URLS) {
  console.log('checking URL liveness (this takes a while)…');
  const jobs = [];
  for (const g of catalog.games) {
    if (g.kind === 'external') continue;
    jobs.push([g.url, g.id]);
    for (const a of g.assets || []) jobs.push([a.url, `${g.id} asset ${a.path}`]);
  }
  const CONCURRENCY = 12;
  let done = 0;
  await Promise.all(jobs.map(async ([url, where]) => {
    while (globalThis.__slots >= CONCURRENCY) await new Promise((r) => setTimeout(r, 50));
    globalThis.__slots = (globalThis.__slots || 0) + 1;
    try {
      await checkOne(url, where);
    } finally {
      globalThis.__slots--;
      done++;
      if (done % 100 === 0) console.log(`  …${done}/${jobs.length}`);
    }
  }));
  console.log(`  checked ${jobs.length} URLs`);
}

console.log(`\nstats: ${catalog.games.length} entries (file=${stats.file} zip=${stats.zip} external=${stats.external || 0}), offline=${stats.offline} online=${stats.online} unknown=${stats.unknownNet} trackers=${stats.trackers} assets=${stats.assets}`);
console.log(`result: ${errors} error(s), ${warnings} warning(s)`);
process.exit(errors ? 1 : 0);
