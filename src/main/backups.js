'use strict';
/**
 * backups.js — game backup (.zip), restore, export, and save-data snapshots.
 *
 * A backup zip contains:
 *   game/            — full game folder (files + manifest)
 *   meta.json        — DB record subset (stats, notes, tags, settings)
 *   thumbnail.*      — artwork (if any)
 *   saves/           — Chromium partition snapshot (if present & game closed)
 */
const fs = require('node:fs');
const path = require('node:path');
const { scope } = require('./log');
const { gameDir, readManifest, refreshRecord } = require('./games');

const log = scope('backup');

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function partitionDir(paths, gameId, userDataPath) {
  // Electron persists `persist:NAME` partitions under <userData>/Partitions.
  const base = userDataPath || path.dirname(paths.root);
  const candidates = [
    path.join(base, 'Partitions', `persist:playhub-${gameId}`),
    path.join(base, 'Partitions', `playhub-${gameId}`),
  ];
  // Also probe for sanitized variants Chromium may create.
  try {
    const partRoot = path.join(base, 'Partitions');
    if (fs.existsSync(partRoot)) {
      for (const d of fs.readdirSync(partRoot)) {
        if (d.includes(gameId)) candidates.push(path.join(partRoot, d));
      }
    }
  } catch { /* ignore */ }
  return candidates.find((c) => { try { return fs.statSync(c).isDirectory(); } catch { return false; } }) || null;
}

function backupGame({ paths, store, gameId, includeSaves = true, userDataPath = null, gameOpen = false }) {
  const AdmZip = require('adm-zip');
  const rec = store.getGame(gameId);
  if (!rec) throw new Error('Game not found.');
  const dir = gameDir(paths, gameId);
  if (!dir || !fs.existsSync(dir)) throw new Error('Game folder is missing.');

  const zip = new AdmZip();
  zip.addLocalFolder(dir, 'game');

  const meta = {
    kind: 'html-playhub-backup',
    version: 1,
    gameId,
    title: rec.title,
    createdAt: new Date().toISOString(),
    record: {
      favorite: rec.favorite, notes: rec.notes, customTags: rec.customTags,
      playTimeSeconds: rec.playTimeSeconds, playCount: rec.playCount,
      lastPlayedAt: rec.lastPlayedAt, addedAt: rec.addedAt,
      blockNetwork: rec.blockNetwork, zoom: rec.zoom, frame: rec.frame,
    },
  };
  zip.addFile('meta.json', Buffer.from(JSON.stringify(meta, null, 2)));

  if (rec.thumbnail) {
    const tp = path.join(paths.thumbnails, rec.thumbnail);
    if (fs.existsSync(tp)) zip.addLocalFile(tp, '', `thumbnail${path.extname(tp)}`, `thumbnail${path.extname(tp)}`);
  }

  let savesIncluded = false;
  if (includeSaves && !gameOpen) {
    const pdir = partitionDir(paths, gameId, userDataPath);
    if (pdir) {
      try {
        zip.addLocalFolder(pdir, 'saves');
        savesIncluded = true;
      } catch (err) {
        log.warn(`could not snapshot saves for ${gameId}: ${err.message}`);
      }
    }
  }

  const name = `${gameId}-${timestamp()}.playhub.zip`;
  const dest = path.join(paths.backups, name);
  zip.writeZip(dest);
  const size = fs.statSync(dest).size;
  log.info(`backup created: ${name} (${size} bytes, saves=${savesIncluded})`);
  return { file: dest, name, size, savesIncluded, savesSkippedOpen: includeSaves && gameOpen };
}

function listBackups(paths) {
  let files = [];
  try { files = fs.readdirSync(paths.backups); } catch { return []; }
  return files
    .filter((f) => f.endsWith('.playhub.zip'))
    .map((f) => {
      const full = path.join(paths.backups, f);
      let st = null;
      try { st = fs.statSync(full); } catch { return null; }
      return { name: f, path: full, size: st.size, createdAt: st.mtime.toISOString() };
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Restore a backup. Never overwrites an existing install without explicit allow. */
function restoreBackup({ paths, store, backupName, allowOverwrite = false, restoreSaves = true, userDataPath = null, gameOpen = false }) {
  const AdmZip = require('adm-zip');
  const full = path.join(paths.backups, backupName);
  if (!fs.existsSync(full)) throw new Error('Backup file not found.');
  const zip = new AdmZip(full);
  const metaEntry = zip.getEntry('meta.json');
  if (!metaEntry) throw new Error('Not a valid Playhub backup (meta.json missing).');
  let meta;
  try { meta = JSON.parse(metaEntry.getData().toString('utf8')); } catch { throw new Error('Backup metadata is corrupted.'); }
  if (meta.kind !== 'html-playhub-backup' || !meta.gameId) throw new Error('Not a valid Playhub backup.');

  const gameId = meta.gameId;
  const dest = gameDir(paths, gameId);
  if (!dest) throw new Error('Invalid game id in backup.');
  const exists = fs.existsSync(dest);
  if (exists && !allowOverwrite) {
    throw Object.assign(new Error(`"${meta.title || gameId}" is already installed. Overwrite was not confirmed.`), { code: 'EXISTS' });
  }
  // Extract game/ to a temp dir first, validate, then move into place.
  const tmp = path.join(paths.temp, `restore-${Date.now().toString(36)}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    for (const e of zip.getEntries()) {
      if (e.isDirectory || !e.entryName.startsWith('game/')) continue;
      const rel = e.entryName.slice('game/'.length);
      if (!rel || rel.includes('..')) continue;
      const target = path.join(tmp, 'game', rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.getData());
    }
    const manifest = readManifest(path.join(tmp, 'game'));
    if (!manifest) throw new Error('Backup is missing the game manifest.');
    if (exists) fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(path.join(tmp, 'game'), dest);

    // Thumbnail
    const thumbEntry = zip.getEntries().find((e) => !e.isDirectory && e.entryName.startsWith('thumbnail.'));
    if (thumbEntry) {
      const ext = path.extname(thumbEntry.entryName);
      fs.writeFileSync(path.join(paths.thumbnails, gameId + ext), thumbEntry.getData());
    }

    // Saves (only when the game is closed; never clobber silently when open).
    let savesRestored = false;
    if (restoreSaves && !gameOpen) {
      const savesEntries = zip.getEntries().filter((e) => !e.isDirectory && e.entryName.startsWith('saves/'));
      if (savesEntries.length) {
        const pdir = path.join(userDataPath || path.dirname(paths.root), 'Partitions', `persist:playhub-${gameId}`);
        // Back up any existing partition first.
        try {
          if (fs.existsSync(pdir)) {
            const pre = `${pdir}.pre-restore-${Date.now()}`;
            fs.renameSync(pdir, pre);
            log.info(`existing saves moved to ${pre}`);
          }
          for (const e of savesEntries) {
            const rel = e.entryName.slice('saves/'.length);
            if (!rel || rel.includes('..')) continue;
            const target = path.join(pdir, rel);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, e.getData());
          }
          savesRestored = true;
        } catch (err) {
          log.warn(`save restore incomplete: ${err.message}`);
        }
      }
    }

    // Rebuild DB record, restoring stats.
    const { recordFromFolder } = require('./games');
    const prev = store.getGame(gameId);
    const fresh = recordFromFolder(paths, gameId, dest, {
      ...(meta.record || {}),
      managed: prev ? prev.managed : false,
      origin: (prev && prev.origin) || 'restore',
    });
    store.upsertGame(fresh);
    log.info(`restored backup ${backupName} -> ${gameId} (saves=${savesRestored})`);
    return { record: fresh, savesRestored };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** Export a game as a plain zip of its folder (for sharing / moving PCs). */
function exportGame({ paths, store, gameId }) {
  const AdmZip = require('adm-zip');
  const rec = store.getGame(gameId);
  if (!rec) throw new Error('Game not found.');
  const dir = gameDir(paths, gameId);
  if (!dir || !fs.existsSync(dir)) throw new Error('Game folder is missing.');
  const zip = new AdmZip();
  zip.addLocalFolder(dir, '');
  const dest = path.join(paths.temp, `${gameId}-export.zip`);
  try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
  zip.writeZip(dest);
  return dest;
}

module.exports = { backupGame, listBackups, restoreBackup, exportGame, partitionDir };
