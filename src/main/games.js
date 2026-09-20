'use strict';
/**
 * games.js — installed-game management: install, uninstall, integrity.
 */
const fs = require('node:fs');
const path = require('node:path');
const { safeJoin, slugify, titleize, formatBytes } = require('./util');
const { MANIFEST_FILENAME, normalizeManifest, validateManifest } = require('./manifest');
const { syncWalk } = require('./doctor');
const { scope } = require('./log');

const log = scope('games');

function gameDir(paths, id) {
  return safeJoin(paths.games, id);
}

function readManifest(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, MANIFEST_FILENAME), 'utf8');
    return normalizeManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeManifest(dir, manifest) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2));
}

function dirSize(files) {
  return files.reduce((a, f) => a + (f.size || 0), 0);
}

/** Build the DB record for an installed game folder. */
function recordFromFolder(paths, id, dir, extra = {}) {
  const manifest = readManifest(dir) || normalizeManifest({ id, title: titleize(id) });
  const files = syncWalk(dir).filter((f) => path.basename(f.path) !== MANIFEST_FILENAME);
  const size = dirSize(files);
  const entryAbs = safeJoin(dir, manifest.entryFile);
  const entryExists = !!(entryAbs && fs.existsSync(entryAbs));
  const now = new Date().toISOString();
  return {
    id,
    title: manifest.title,
    description: manifest.description || '',
    author: manifest.author || 'Unknown',
    license: (manifest.license && manifest.license.spdx) || 'Unknown',
    licenseDetail: manifest.license || {},
    source: manifest.source || {},
    version: manifest.version || '1.0',
    genres: manifest.genres || [],
    tags: manifest.tags || [],
    language: manifest.language || 'en',
    entryFile: manifest.entryFile,
    singleFile: !!manifest.singleFile,
    qualityTier: manifest.qualityTier || null,
    sourceCollection: manifest.sourceCollection || null,
    controls: manifest.controls || {},
    requirements: manifest.requirements || {},
    network: manifest.network || { required: false, hosts: [] },
    bundleVersion: manifest.bundleVersion || 0,
    managed: extra.managed ?? manifest.managed ?? false,
    origin: extra.origin || manifest.origin || 'import',
    fileCount: files.length,
    sizeBytes: size,
    entryExists,
    favorite: extra.favorite ?? false,
    notes: extra.notes || '',
    customTags: extra.customTags || [],
    playTimeSeconds: extra.playTimeSeconds || 0,
    playCount: extra.playCount || 0,
    lastPlayedAt: extra.lastPlayedAt || null,
    addedAt: extra.addedAt || manifest.addedAt || now,
    updatedAt: now,
    thumbnail: extra.thumbnail || thumbnailFor(paths, id),
    blockNetwork: extra.blockNetwork ?? false,
    zoom: extra.zoom ?? null,
    frame: extra.frame ?? null,
  };
}

function thumbnailFor(paths, id) {
  const exts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
  for (const e of exts) {
    const p = path.join(paths.thumbnails, id + e);
    if (fs.existsSync(p)) return id + e;
  }
  return null;
}

function copyDirSync(src, dest, { skip = null } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip && skip(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDirSync(s, d, { skip });
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

function removeDirSync(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function uniqueGameId(paths, store, base) {
  let id = slugify(base, 'game');
  if (!store.getGame(id) && !fs.existsSync(path.join(paths.games, id))) return id;
  for (let i = 2; i < 1000; i++) {
    const c = `${id}-${i}`;
    if (!store.getGame(c) && !fs.existsSync(path.join(paths.games, c))) return c;
  }
  return `${id}-${Date.now().toString(36)}`;
}

/**
 * Install a prepared folder (already analyzed) as a game.
 * `prepare` copies files; this finalizes manifest + thumbnail + DB record.
 */
function finalizeInstall({ paths, store, stagingDir, gameId, manifestOverrides = {}, thumbnailSrc = null, origin = 'import', managed = false }) {
  const dest = gameDir(paths, gameId);
  if (!dest) throw new Error('Invalid game id.');
  if (fs.existsSync(dest)) throw new Error('A game with this id is already installed.');
  copyDirSync(stagingDir, dest, { skip: (n) => n === MANIFEST_FILENAME });

  const manifest = normalizeManifest({
    ...manifestOverrides,
    id: gameId,
    managed,
    origin,
    updatedAt: new Date().toISOString(),
  });
  const v = validateManifest(manifest);
  if (!v.ok) throw new Error('Invalid manifest: ' + v.errors.join('; '));
  writeManifest(dest, manifest);

  if (thumbnailSrc && fs.existsSync(thumbnailSrc)) {
    const ext = path.extname(thumbnailSrc).toLowerCase();
    const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
    if (allowed.includes(ext) && fs.statSync(thumbnailSrc).size <= 5 * 1024 * 1024) {
      fs.copyFileSync(thumbnailSrc, path.join(paths.thumbnails, gameId + ext));
    }
  }
  const record = recordFromFolder(paths, gameId, dest, { managed, origin });
  store.upsertGame(record);
  log.info(`installed game ${gameId} (${record.title}, ${formatBytes(record.sizeBytes)})`);
  return record;
}

function uninstallGame({ paths, store, gameId, keepSaves = true }) {
  const dir = gameDir(paths, gameId);
  if (!dir) throw new Error('Invalid game id.');
  removeDirSync(dir);
  for (const f of fs.readdirSync(paths.thumbnails)) {
    if (f === gameId || f.startsWith(gameId + '.')) {
      try { fs.rmSync(path.join(paths.thumbnails, f), { force: true }); } catch { /* ignore */ }
    }
  }
  store.removeGame(gameId);
  // Note: Chromium partition data (saves) is intentionally kept unless the
  // user explicitly clears it, so uninstall/reinstall never destroys saves.
  void keepSaves;
  log.info(`uninstalled game ${gameId}`);
}

/** Re-read a game folder and refresh its DB record (size, entry, manifest). */
function refreshRecord({ paths, store, gameId }) {
  const rec = store.getGame(gameId);
  if (!rec) return null;
  const dir = gameDir(paths, gameId);
  if (!dir || !fs.existsSync(dir)) return null;
  const fresh = recordFromFolder(paths, gameId, dir, {
    managed: rec.managed, origin: rec.origin, favorite: rec.favorite,
    notes: rec.notes, customTags: rec.customTags, playTimeSeconds: rec.playTimeSeconds,
    playCount: rec.playCount, lastPlayedAt: rec.lastPlayedAt, addedAt: rec.addedAt,
    blockNetwork: rec.blockNetwork, zoom: rec.zoom, frame: rec.frame,
  });
  store.upsertGame(fresh);
  return fresh;
}

/**
 * Integrity sweep: missing dirs, missing entries, invalid manifests.
 * Returns { ok, issues: [{gameId, code, message}] }. Does not delete anything.
 */
function integrityCheck({ paths, store }) {
  const issues = [];
  for (const g of store.allGames()) {
    const dir = gameDir(paths, g.id);
    if (!dir || !fs.existsSync(dir)) {
      issues.push({ gameId: g.id, code: 'missing-dir', message: `Game folder is missing (${g.title}).` });
      continue;
    }
    const manifest = readManifest(dir);
    if (!manifest) {
      issues.push({ gameId: g.id, code: 'missing-manifest', message: `Manifest is missing (${g.title}). It can be regenerated.` });
    } else {
      const v = validateManifest(manifest);
      for (const e of v.errors) issues.push({ gameId: g.id, code: 'invalid-manifest', message: `${g.title}: ${e}` });
    }
    const entry = safeJoin(dir, (manifest && manifest.entryFile) || g.entryFile || '');
    if (!entry || !fs.existsSync(entry)) {
      issues.push({ gameId: g.id, code: 'missing-entry', message: `Entry file "${g.entryFile}" is missing (${g.title}).` });
    }
  }
  return { ok: issues.length === 0, issues };
}

module.exports = {
  gameDir, readManifest, writeManifest, recordFromFolder, thumbnailFor,
  copyDirSync, removeDirSync, uniqueGameId, finalizeInstall, uninstallGame,
  refreshRecord, integrityCheck,
};
