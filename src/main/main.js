'use strict';
/**
 * main.js — application entry: lifecycle, windows, IPC, catalog installs, updates.
 */
const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, shell, net } = require('electron');

const { registerSchemes, registerHandlers, ensureProtocolsHandled, APP_SCHEME } = require('./protocol');
const pathsMod = require('./paths');
const { Store } = require('./store');
const { init: initLog, scope, tailLines } = require('./log');
const { formatBytes, isSafeExternalUrl } = require('./util');

const log = scope('main');
const DEV = process.argv.includes('--dev');

// Must run before app.ready.
registerSchemes();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let paths = null;
let store = null;
let mainWindow = null;
const stagingSessions = new Map(); // stagingId -> { root, staging, report, origin }

function rendererRoot() {
  return path.join(__dirname, '..', 'renderer');
}

function createMainWindow() {
  const { setMainWindow } = require('./game-window');
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: 'HTML Playhub',
    backgroundColor: '#0b0d16',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'main-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:playhub-shell',
    },
  });
  setMainWindow(mainWindow);
  mainWindow.loadURL(`${APP_SCHEME}://app/index.html`);
  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // Top-frame navigation lockdown: our UI stays in-app, web links go to the
  // OS browser, and anything else (custom schemes included) is denied so it
  // can never leak to Windows as an "open this link" prompt.
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(`${APP_SCHEME}://app/`)) return;
    e.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
    else log.warn('blocked main-window navigation to', String(url).slice(0, 160));
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return; // ignore subframes + aborts
    log.error('main window failed to load', `${code} ${desc} ${url}`);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isVisible()) mainWindow.show();
    dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: 'HTML Playhub failed to start its interface',
      message: 'The library window could not load.',
      detail: `Error ${code}: ${desc}\nURL: ${url}\n\nYour games, saves and settings are untouched. A log was written — Settings → Advanced → View logs (or the logs folder next to your data).`,
      buttons: ['Reload', 'Quit'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0 && mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      else app.quit();
    }).catch(() => {});
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    log.error('main window renderer gone', `${details.reason} (exit ${details.exitCode})`);
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  const { buildMenu } = require('./menu');
  buildMenu({
    mainWindow,
    openImport: () => mainWindow.webContents.send('playhub:navigate', 'import'),
    openSettings: () => mainWindow.webContents.send('playhub:navigate', 'settings'),
    surprise: () => mainWindow.webContents.send('playhub:surprise'),
  });
  return mainWindow;
}

function notifyLibraryChanged(reason, gameId = null) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('playhub:library-changed', { reason, gameId });
  }
}

// ---------------- IPC ----------------
function registerIpc() {
  const games = require('./games');
  const importer = require('./importer');
  const catalog = require('./catalog');
  const backups = require('./backups');
  const doctor = require('./doctor');
  const { createGameWindow, isGameOpen } = require('./game-window');
  const { uniqueId } = require('./util');

  const ok = (v) => v;

  // ----- library -----
  ipcMain.handle('games:list', () => ok(store.allGames()));
  ipcMain.handle('games:get', (_e, id) => {
    const g = store.getGame(id);
    if (!g) throw new Error('Game not found.');
    return g;
  });
  ipcMain.handle('games:toggle-favorite', (_e, id) => {
    const g = store.getGame(id);
    if (!g) throw new Error('Game not found.');
    g.favorite = !g.favorite;
    store.upsertGame(g);
    notifyLibraryChanged('favorite', id);
    return g.favorite;
  });
  ipcMain.handle('games:update', (_e, id, patch) => {
    const g = store.getGame(id);
    if (!g) throw new Error('Game not found.');
    const dir = games.gameDir(paths, id);
    const allowed = ['title', 'description', 'author', 'genres', 'tags', 'customTags', 'notes', 'entryFile', 'blockNetwork', 'zoom', 'frame', 'requirements'];
    for (const k of allowed) {
      if (patch[k] !== undefined) {
        if (k === 'entryFile') {
          const abs = require('./util').safeJoin(dir, patch[k]);
          if (!abs || !fs.existsSync(abs)) throw new Error('Entry file does not exist in the game folder.');
        }
        g[k] = patch[k];
      }
    }
    // Persist editable metadata back to the manifest (except per-user fields).
    try {
      const m = games.readManifest(dir);
      if (m) {
        for (const k of ['title', 'description', 'author', 'genres', 'entryFile']) {
          if (patch[k] !== undefined) m[k] = patch[k];
        }
        m.updatedAt = new Date().toISOString();
        games.writeManifest(dir, m);
      }
    } catch (err) { log.warn('manifest write failed', String(err)); }
    store.upsertGame(g);
    notifyLibraryChanged('update', id);
    return g;
  });
  ipcMain.handle('games:remove', async (_e, id) => {
    if (isGameOpen(id)) throw new Error('Close the game before removing it.');
    games.uninstallGame({ paths, store, gameId: id });
    notifyLibraryChanged('remove', id);
    return true;
  });
  ipcMain.handle('games:refresh', (_e, id) => {
    const r = games.refreshRecord({ paths, store, gameId: id });
    if (!r) throw new Error('Game folder is missing.');
    notifyLibraryChanged('refresh', id);
    return r;
  });
  ipcMain.handle('games:integrity', () => games.integrityCheck({ paths, store }));
  ipcMain.handle('games:repair-manifest', async (_e, id) => {
    const dir = games.gameDir(paths, id);
    if (!dir || !fs.existsSync(dir)) throw new Error('Game folder is missing.');
    const report = await importer.analyzeRoot(dir, { filenameHint: id });
    if (!report.entry) throw new Error('No HTML entry point found; cannot repair.');
    const { normalizeManifest } = require('./manifest');
    const prev = store.getGame(id) || {};
    const m = normalizeManifest({
      id, title: prev.title || report.title, description: prev.description || report.description,
      author: prev.author || 'Unknown', entryFile: report.entry.relative, singleFile: report.singleFile,
      genres: prev.genres && prev.genres.length ? prev.genres : report.genres,
      language: report.language,
      network: { required: !report.offlineCapable, hosts: report.externalHosts },
    });
    games.writeManifest(dir, m);
    return games.refreshRecord({ paths, store, gameId: id });
  });
  ipcMain.handle('games:open-folder', (_e, id) => {
    const dir = games.gameDir(paths, id);
    if (!dir || !fs.existsSync(dir)) throw new Error('Game folder is missing.');
    shell.showItemInFolder(path.join(dir, store.getGame(id)?.entryFile || ''));
    return true;
  });
  ipcMain.handle('games:play', (_e, id, options = {}) => {
    createGameWindow({ store, paths, gameId: id, options });
    return true;
  });
  ipcMain.handle('games:is-open', (_e, id) => isGameOpen(id));
  ipcMain.handle('games:random', (_e, filters = {}) => {
    let list = store.allGames();
    if (filters.favorites) list = list.filter((g) => g.favorite);
    if (filters.genre) list = list.filter((g) => (g.genres || []).includes(filters.genre));
    if (filters.neverPlayed) list = list.filter((g) => !(g.playCount > 0));
    if (!list.length) return null;
    return list[Math.floor(Math.random() * list.length)].id;
  });
  ipcMain.handle('games:export-zip', async (_e, id) => {
    const g = store.getGame(id);
    if (!g) throw new Error('Game not found.');
    const tmp = backups.exportGame({ paths, store, gameId: id });
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: `Export ${g.title}`,
      defaultPath: `${g.id}.zip`,
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return null;
    fs.copyFileSync(tmp, filePath);
    return filePath;
  });

  // ----- import -----
  ipcMain.handle('import:pick', async (_e, kind) => {
    const filters = kind === 'zip' ? [{ name: 'ZIP archives', extensions: ['zip'] }]
      : kind === 'html' ? [{ name: 'HTML games', extensions: ['html', 'htm'] }]
      : [{ name: 'Games', extensions: ['html', 'htm', 'zip'] }];
    if (kind === 'folder') {
      const r = await dialog.showOpenDialog(mainWindow, { title: 'Choose a game folder', properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths.length) return null;
      return { kind: 'folder', path: r.filePaths[0] };
    }
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Choose a game file', properties: ['openFile'], filters,
    });
    if (r.canceled || !r.filePaths.length) return null;
    const p = r.filePaths[0];
    return /\.zip$/i.test(p) ? { kind: 'zip', path: p } : { kind: 'html', path: p };
  });
  ipcMain.handle('import:analyze', async (event, source) => {
    const staged = await importer.stageSource(paths, source, (prog) => {
      event.sender.send('playhub:import-progress', prog);
    });
    try {
      const filenameHint = source.path ? path.basename(source.path) : (source.url || '');
      const report = await importer.analyzeRoot(staged.root, { sourceLabel: filenameHint, filenameHint });
      const stagingId = uniqueId('stage');
      stagingSessions.set(stagingId, { ...staged, report });
      // Suggest a non-colliding id.
      report.suggestedId = games.uniqueGameId(paths, store, report.suggestedId);
      // Thumbnail options: all detected images (served via thumb preview IPC).
      return { stagingId, report };
    } catch (err) {
      importer.cleanupStaging(staged.staging);
      throw err;
    }
  });
  ipcMain.handle('import:thumb-preview', async (_e, stagingId, rel) => {
    const s = stagingSessions.get(stagingId);
    if (!s) throw new Error('Import session expired.');
    const abs = require('./util').safeJoin(s.root, rel);
    if (!abs || !fs.existsSync(abs)) throw new Error('Image not found.');
    if (fs.statSync(abs).size > 5 * 1024 * 1024) throw new Error('Image too large.');
    const data = fs.readFileSync(abs).toString('base64');
    return { dataUrl: `data:${require('./util').mimeFor(abs)};base64,${data}` };
  });
  ipcMain.handle('import:confirm', async (_e, stagingId, review) => {
    const s = stagingSessions.get(stagingId);
    if (!s) throw new Error('Import session expired.');
    try {
      const gameId = games.uniqueGameId(paths, store, review.id || s.report.suggestedId);
      const record = games.finalizeInstall({
        paths, store, stagingDir: s.root, gameId,
        manifestOverrides: {
          title: review.title || s.report.title,
          description: (review.description || s.report.description || '').slice(0, 2000),
          author: review.author || 'Unknown',
          license: { spdx: review.license || 'Unknown' },
          version: review.version || '1.0',
          genres: review.genres || s.report.genres,
          tags: review.tags || [],
          language: s.report.language,
          entryFile: review.entryFile || s.report.entry.relative,
          singleFile: s.report.singleFile,
          controls: {
            keyboard: s.report.input.keyboard, mouse: s.report.input.mouse,
            touch: s.report.input.touch, gamepad: s.report.input.gamepad,
          },
          network: { required: !s.report.offlineCapable, hosts: s.report.externalHosts },
        },
        thumbnailSrc: review.thumbnailRel ? require('./util').safeJoin(s.root, review.thumbnailRel) : null,
        origin: s.origin || 'import',
      });
      if (review.blockNetwork) {
        record.blockNetwork = true;
        store.upsertGame(record);
      }
      stagingSessions.delete(stagingId);
      notifyLibraryChanged('install', gameId);
      return record;
    } finally {
      importer.cleanupStaging(s.staging);
    }
  });
  ipcMain.handle('import:cancel', async (_e, stagingId) => {
    const s = stagingSessions.get(stagingId);
    if (s) {
      importer.cleanupStaging(s.staging);
      stagingSessions.delete(stagingId);
    }
    return true;
  });

  // ----- discover / catalog -----
  ipcMain.handle('catalog:get', () => catalog.getCatalog(paths));
  ipcMain.handle('catalog:refresh', async () => catalog.refreshCatalog(paths));
  ipcMain.handle('discover:install', async (event, entry) => {
    // entry: { id, kind: 'file'|'zip', url, assets?, title, ... }
    // Downloads go to temp and are installed STRAIGHT into the library's
    // game files — a Discover install never leaves anything in a downloads
    // folder (there isn't one anymore).
    const { download } = require('./downloader');
    const staging = path.join(paths.temp, `discover-${Date.now().toString(36)}`);
    fs.mkdirSync(staging, { recursive: true });
    const sendProgress = (received, total) => {
      try { event.sender.send('playhub:download-progress', { id: entry.id, received, total }); } catch { /* window gone */ }
    };
    try {
      let root = staging;
      if (entry.kind === 'zip') {
        const destFile = path.join(staging, '__dl', 'game.zip');
        await download({
          url: entry.url, destFile, expectedSize: entry.size || null, retries: 2,
          onProgress: (received, total) => sendProgress(received, total),
        });
        root = importer.extractZipSafe(destFile, path.join(staging, 'unzipped'));
      } else {
        // Entry file + optional catalog assets, preserving repo-relative
        // layout so the game's relative references keep working.
        const files = [{ rel: entry.path || 'game.html', url: entry.url, size: entry.size || null }];
        for (const a of entry.assets || []) files.push({ rel: a.path, url: a.url, size: a.size || null });
        let done = 0;
        const expectedTotal = files.every((f) => f.size) ? files.reduce((s, f) => s + f.size, 0) : null;
        for (const f of files) {
          if (!/^https?:\/\//i.test(f.url || '')) throw new Error(`Refusing to download from an unsafe URL for ${f.rel}.`);
          const parts = importer.assertSafeRelPath(f.rel);
          const dest = path.join(staging, ...parts);
          if (!dest.startsWith(staging)) throw new Error(`Unsafe asset path: ${f.rel}`);
          await download({
            url: f.url, destFile: dest, expectedSize: f.size, retries: 2,
            onProgress: (received, total) => sendProgress(done + received, expectedTotal || (total ? done + total : null)),
          });
          done += fs.statSync(dest).size;
        }
        sendProgress(done, expectedTotal || done);
      }
      const report = await importer.analyzeRoot(root, { filenameHint: entry.file || entry.title });
      if (report.errors.length) throw new Error(report.errors.map((e) => e.message).join(' '));
      if (!report.entry) throw new Error('No playable HTML file found in the download.');
      const gameId = games.uniqueGameId(paths, store, entry.id);
      const record = games.finalizeInstall({
        paths, store, stagingDir: root, gameId,
        manifestOverrides: {
          title: entry.title, description: entry.description || report.description || '',
          author: entry.author || 'Unknown',
          license: { spdx: entry.license || 'Unknown', note: entry.licenseNote || undefined },
          version: entry.version || '1.0',
          genres: (entry.genres && entry.genres.length ? entry.genres : report.genres) || [],
          tags: entry.tags || [],
          sourceCollection: entry.sourceCollection || null,
          qualityTier: entry.qualityTier || null,
          language: report.language,
          entryFile: report.entry.relative, singleFile: report.singleFile,
          controls: { keyboard: report.input.keyboard, mouse: report.input.mouse, touch: report.input.touch, gamepad: report.input.gamepad },
          network: { required: !report.offlineCapable, hosts: report.externalHosts, trackers: report.trackers || [] },
          source: { repo: entry.repo || null, homepage: entry.homepage || null },
        },
        thumbnailSrc: report.images.length ? path.join(root, report.images[0]) : null,
        origin: 'discover',
      });
      // Privacy default: games with trackers start sandboxed (user can allow).
      if (report.trackers && report.trackers.length) {
        record.blockNetwork = true;
        store.upsertGame(record);
      }
      notifyLibraryChanged('install', gameId);
      return record;
    } finally {
      importer.cleanupStaging(staging);
    }
  });

  // ----- backups -----
  ipcMain.handle('backup:create', (_e, id, includeSaves = true) => {
    const r = backups.backupGame({
      paths, store, gameId: id, includeSaves,
      userDataPath: app.getPath('userData'), gameOpen: isGameOpen(id),
    });
    return r;
  });
  ipcMain.handle('backup:list', () => backups.listBackups(paths));
  ipcMain.handle('backup:restore', (_e, name, opts = {}) => {
    const r = backups.restoreBackup({
      paths, store, backupName: name,
      allowOverwrite: !!opts.allowOverwrite, restoreSaves: opts.restoreSaves !== false,
      userDataPath: app.getPath('userData'), gameOpen: false,
    });
    notifyLibraryChanged('restore', r.record.id);
    return { id: r.record.id, savesRestored: r.savesRestored };
  });
  ipcMain.handle('backup:delete', (_e, name) => {
    const full = path.join(paths.backups, path.basename(name));
    if (!full.startsWith(paths.backups)) throw new Error('Invalid backup name.');
    fs.rmSync(full, { force: true });
    return true;
  });
  ipcMain.handle('backup:open-folder', () => { shell.openPath(paths.backups); return true; });

  // ----- saves -----
  ipcMain.handle('saves:info', (_e, id) => {
    const pdir = backups.partitionDir(paths, id, app.getPath('userData'));
    if (!pdir) return { exists: false, size: 0 };
    let size = 0, files = 0;
    try {
      const stack = [pdir];
      while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const f = path.join(d, e.name);
          if (e.isDirectory()) stack.push(f);
          else { try { size += fs.statSync(f).size; files++; } catch { /* ignore */ } }
        }
      }
    } catch { /* ignore */ }
    return { exists: true, size, sizeText: formatBytes(size), files, path: pdir };
  });
  ipcMain.handle('saves:clear', (_e, id) => {
    if (isGameOpen(id)) throw new Error('Close the game before clearing its saves.');
    const pdir = backups.partitionDir(paths, id, app.getPath('userData'));
    if (pdir) fs.rmSync(pdir, { recursive: true, force: true });
    return true;
  });

  // ----- screenshots -----
  ipcMain.handle('screenshots:list', (_e, id) => {
    const dir = path.join(paths.screenshots, id);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.png')); } catch { return []; }
    return files.sort().reverse().map((f) => {
      const full = path.join(dir, f);
      let size = 0, mtime = '';
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtime.toISOString(); } catch { /* ignore */ }
      return { name: f, size, createdAt: mtime };
    });
  });
  ipcMain.handle('screenshots:get', (_e, id, name) => {
    const full = path.join(paths.screenshots, id, path.basename(name));
    if (!full.startsWith(paths.screenshots)) throw new Error('Invalid name.');
    const data = fs.readFileSync(full).toString('base64');
    return { dataUrl: `data:image/png;base64,${data}` };
  });
  ipcMain.handle('screenshots:delete', (_e, id, name) => {
    const full = path.join(paths.screenshots, id, path.basename(name));
    if (!full.startsWith(paths.screenshots)) throw new Error('Invalid name.');
    fs.rmSync(full, { force: true });
    return true;
  });

  // ----- collections -----
  ipcMain.handle('collections:list', () => Object.values(store.db.collections));
  ipcMain.handle('collections:create', (_e, { name, icon }) => {
    const id = uniqueId('col');
    store.db.collections[id] = { id, name: String(name || 'New Collection').slice(0, 60), icon: icon || 'folder', gameIds: [] };
    store.saveSoon();
    notifyLibraryChanged('collections');
    return store.db.collections[id];
  });
  ipcMain.handle('collections:update', (_e, id, patch) => {
    const c = store.db.collections[id];
    if (!c || c.builtin) throw new Error('Collection cannot be edited.');
    if (patch.name) c.name = String(patch.name).slice(0, 60);
    if (patch.icon) c.icon = patch.icon;
    store.saveSoon();
    notifyLibraryChanged('collections');
    return c;
  });
  ipcMain.handle('collections:delete', (_e, id) => {
    const c = store.db.collections[id];
    if (!c || c.builtin) throw new Error('Collection cannot be deleted.');
    delete store.db.collections[id];
    store.saveSoon();
    notifyLibraryChanged('collections');
    return true;
  });
  ipcMain.handle('collections:set-games', (_e, id, gameIds) => {
    const c = store.db.collections[id];
    if (!c || c.builtin) throw new Error('Collection cannot be edited.');
    c.gameIds = (gameIds || []).filter((g) => store.getGame(g));
    store.saveSoon();
    notifyLibraryChanged('collections');
    return c;
  });

  // ----- doctor / files / stats -----
  ipcMain.handle('doctor:diagnose', (_e, id) => {
    const dir = games.gameDir(paths, id);
    if (!dir || !fs.existsSync(dir)) throw new Error('Game folder is missing.');
    const rec = store.getGame(id);
    return doctor.diagnoseGame(dir, rec ? rec.entryFile : 'index.html');
  });
  ipcMain.handle('files:list', (_e, id) => {
    const dir = games.gameDir(paths, id);
    if (!dir || !fs.existsSync(dir)) throw new Error('Game folder is missing.');
    return doctor.syncWalk(dir)
      .map((f) => ({ relative: f.relative.replace(/\\/g, '/'), size: f.size }))
      .sort((a, b) => (a.relative < b.relative ? -1 : 1))
      .slice(0, 2000);
  });
  ipcMain.handle('stats:overview', () => {
    const all = store.allGames();
    const totalPlay = all.reduce((a, g) => a + (g.playTimeSeconds || 0), 0);
    const top = [...all].sort((a, b) => (b.playTimeSeconds || 0) - (a.playTimeSeconds || 0)).slice(0, 5)
      .map((g) => ({ id: g.id, title: g.title, seconds: g.playTimeSeconds || 0 }));
    return {
      totalGames: all.length,
      favorites: all.filter((g) => g.favorite).length,
      totalPlaySeconds: totalPlay,
      totalPlayText: require('./util').formatDuration(totalPlay),
      totalSize: all.reduce((a, g) => a + (g.sizeBytes || 0), 0),
      topGames: top,
      sessions: store.db.sessions.length,
    };
  });

  // ----- settings / data -----
  ipcMain.handle('settings:get', () => ({ ...store.settings, _dataRoot: paths.root, _portable: paths.portable }));
  ipcMain.handle('settings:set', (_e, patch) => {
    Object.assign(store.settings, patch || {});
    store.saveSoon();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('playhub:settings-changed', store.settings);
    return store.settings;
  });
  ipcMain.handle('data:open-folder', () => { shell.openPath(paths.root); return true; });
  ipcMain.handle('data:export-library', async () => {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip();
    store.saveNow();
    zip.addLocalFile(paths.dbFile, '', 'playhub.json');
    zip.addLocalFile(paths.settingsFile, '', 'settings.json');
    zip.addLocalFile(paths.layoutsFile, '', 'control-layouts.json');
    const tmp = path.join(paths.temp, 'playhub-library-export.zip');
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    zip.writeZip(tmp);
    const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export library data', defaultPath: 'playhub-library.zip',
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (canceled || !filePath) return null;
    fs.copyFileSync(tmp, filePath);
    return filePath;
  });
  ipcMain.handle('data:import-library', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Import library data', properties: ['openFile'],
      filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePaths.length) return null;
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(r.filePaths[0]);
    for (const name of ['playhub.json', 'settings.json', 'control-layouts.json']) {
      const e = zip.getEntry(name);
      if (!e) continue;
      const target = name === 'playhub.json' ? paths.dbFile : name === 'settings.json' ? paths.settingsFile : paths.layoutsFile;
      try { fs.copyFileSync(target, `${target}.pre-import.bak`); } catch { /* ignore */ }
      fs.writeFileSync(target, e.getData());
    }
    store.load();
    notifyLibraryChanged('import-library');
    return true;
  });
  ipcMain.handle('logs:get', (_e, n = 200) => tailLines(n));
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    dev: DEV,
  }));

  // ----- control layouts -----
  ipcMain.handle('layouts:get', () => store.layouts);
  ipcMain.handle('layouts:save-game', (_e, gameId, layout) => {
    store.layouts.perGame[gameId] = layout;
    store.saveSoon();
    return true;
  });
  ipcMain.handle('layouts:save-preset', (_e, name, layout) => {
    store.layouts.global[String(name).slice(0, 40)] = layout;
    store.saveSoon();
    return true;
  });
  ipcMain.handle('layouts:delete-preset', (_e, name) => {
    delete store.layouts.global[name];
    store.saveSoon();
    return true;
  });

  // ----- thumbnails -----
  ipcMain.handle('thumb:get', (_e, id) => {
    const rec = store.getGame(id);
    const file = rec && rec.thumbnail ? path.join(paths.thumbnails, rec.thumbnail) : null;
    if (!file || !fs.existsSync(file)) return null;
    try {
      if (fs.statSync(file).size > 4 * 1024 * 1024) return null;
      return { dataUrl: `data:${require('./util').mimeFor(file)};base64,${fs.readFileSync(file).toString('base64')}` };
    } catch { return null; }
  });

  // ----- updates -----
  ipcMain.handle('updates:check-app', async () => checkAppUpdate());

  // ----- external links (validated) -----
  ipcMain.handle('shell:open-external', async (_e, url) => {
    const u = String(url || '');
    if (!isSafeExternalUrl(u)) {
      log.warn('blocked shell:open-external for non-web URL', u.slice(0, 160));
      throw new Error('Blocked URL.');
    }
    await shell.openExternal(u);
    return true;
  });
}

// ---------------- app update check ----------------
function checkAppUpdate() {
  return new Promise((resolve) => {
    const current = app.getVersion();
    const req = net.request({
      method: 'GET',
      url: 'https://api.github.com/repos/amirmhmdglstan-stack/HTML-PLAYHUB/releases/latest',
      headers: { 'User-Agent': 'HTML-Playhub' },
    });
    const timer = setTimeout(() => { try { req.abort(); } catch { /* ignore */ } resolve({ ok: false, error: 'Timed out.' }); }, 15000);
    let body = '';
    req.on('response', (res) => {
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        clearTimeout(timer);
        try {
          if (res.statusCode !== 200) return resolve({ ok: false, error: `GitHub API returned ${res.statusCode}.` });
          const rel = JSON.parse(body);
          const latest = String(rel.tag_name || '').replace(/^v/, '');
          const available = compareVersions(latest, current) > 0;
          resolve({ ok: true, current, latest, available, url: rel.html_url, notes: (rel.body || '').slice(0, 2000) });
        } catch (err) { resolve({ ok: false, error: String(err) }); }
      });
    });
    req.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: String(err) }); });
    req.end();
  });
}

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

// ---------------- boot ----------------
function handleOpenFile(filePath) {
  if (!filePath || !mainWindow) return;
  if (/\.(html?|zip)$/i.test(filePath) && fs.existsSync(filePath)) {
    mainWindow.webContents.send('playhub:import-file', filePath);
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

app.on('second-instance', (_e, argv) => {
  const f = argv.find((a) => /\.(html?|zip)$/i.test(a));
  if (f) handleOpenFile(f);
  else if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

app.whenReady().then(async () => {
  try {
    paths = pathsMod.ensureDirs();
    initLog(paths.logs);
    log.info(`starting HTML Playhub v${app.getVersion()} (portable=${paths.portable})`);
    log.info(`data root: ${paths.root}`);

    store = new Store(paths).load();
    store.ensureBuiltinCollections();

    registerHandlers({ rendererRoot: rendererRoot(), getPaths: () => paths, store });
    require('./game-window').registerGameIpc({ store, paths });
    registerIpc();

    // Never load a window before the playhub-* schemes are verifiably
    // handled — otherwise Chromium hands our own URLs to Windows
    // ("get an app to open this link").
    const protocolsOk = await ensureProtocolsHandled({ timeoutMs: 8000 });
    if (!protocolsOk) {
      log.error('protocol schemes not handled; refusing to load windows');
      dialog.showErrorBox('HTML Playhub failed to start',
        'The app could not register its internal page handler.\n\nPlease restart the app. If this keeps happening, reinstall from the latest Setup.exe — your games and saves are stored separately and are safe.');
      app.quit();
      return;
    }

    createMainWindow();

  // File association / open-with: Windows passes the path as argv.
  const openFile = process.argv.slice(1).find((a) => !a.startsWith('-') && /\.(html?|zip)$/i.test(a));
  if (openFile && fs.existsSync(openFile)) {
    mainWindow.webContents.once('did-finish-load', () => handleOpenFile(openFile));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
  } catch (err) {
    try { log.error('fatal startup error', String((err && err.stack) || err)); } catch { /* ignore */ }
    try {
      dialog.showErrorBox('HTML Playhub failed to start',
        `Something went wrong during startup:\n${(err && err.message) || err}\n\nYour games and saves are stored separately and are safe.`);
    } catch { /* ignore */ }
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (store) store.saveNow();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => { if (store) store.saveNow(); });

process.on('uncaughtException', (err) => log.error('uncaughtException', String((err && err.stack) || err)));
process.on('unhandledRejection', (err) => log.error('unhandledRejection', String((err && err.stack) || err)));
