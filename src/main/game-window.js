'use strict';
/**
 * game-window.js — the sandboxed game player window.
 *
 * Architecture:
 *  - One BrowserWindow per running game, showing OUR chrome (game.html).
 *  - The game itself runs inside a <webview> with:
 *      partition="persist:playhub-<gameId>"  -> per-game save isolation
 *      sandboxed, no Node integration         -> untrusted content stays contained
 *  - A crash in the game process (render-process-gone) only kills the
 *    webview guest; our window survives and shows recovery UI.
 *  - Virtual controls / screenshots / zoom are driven from the window's
 *    renderer via preload IPC; input injection uses sendInputEvent.
 */
const path = require('node:path');
const fs = require('node:fs');
const { BrowserWindow, session, shell, ipcMain, app, dialog } = require('electron');
const { GAME_SCHEME, APP_SCHEME } = require('./protocol');
const { isSafeExternalUrl } = require('./util');
const { scope } = require('./log');

const log = scope('game-window');

const openGames = new Map(); // gameId -> { window, startedAt, gameId }

function partitionFor(gameId) {
  return `persist:playhub-${gameId}`;
}

function applyNetworkPolicy(gameId, blockNetwork) {
  const ses = session.fromPartition(partitionFor(gameId));
  // Clear previous handler by setting a no-op filter first is not supported;
  // instead we always (re)register and branch on the flag via closure map.
  policyFlags.set(gameId, !!blockNetwork);
  if (!policyRegistered.has(gameId)) {
    policyRegistered.add(gameId);
    ses.webRequest.onBeforeRequest((details, callback) => {
      const blocked = policyFlags.get(gameId);
      const url = details.url || '';
      if (blocked && /^https?:\/\//i.test(url)) {
        log.info(`[${gameId}] blocked network request: ${url.slice(0, 120)}`);
        return callback({ cancel: true });
      }
      callback({});
    });
  }
  // Trackers are never given persistent cookies when blocked; when allowed,
  // third-party cookies still follow Chromium defaults.
}

const policyFlags = new Map();
const policyRegistered = new Set();

function createGameWindow({ store, paths, gameId, options = {} }) {
  const rec = store.getGame(gameId);
  if (!rec) throw new Error('Game is not installed.');

  // Focus existing window if already running.
  if (openGames.has(gameId)) {
    const ex = openGames.get(gameId).window;
    if (!ex.isDestroyed()) { ex.focus(); return ex; }
    openGames.delete(gameId);
  }

  applyNetworkPolicy(gameId, rec.blockNetwork);

  const settings = store.settings;
  const bounds = settings.gameWindowBounds || { width: 1280, height: 800 };
  const win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    x: bounds.x, y: bounds.y,
    minWidth: 640, minHeight: 480,
    title: `${rec.title} — HTML Playhub`,
    backgroundColor: '#0b0d16',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'game-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: true,
      partition: 'persist:playhub-shell',
    },
  });

  const startedAt = new Date().toISOString();
  openGames.set(gameId, { window: win, startedAt, gameId });

  const params = new URLSearchParams({ game: gameId });
  if (options.developer) params.set('dev', '1');
  win.loadURL(`${APP_SCHEME}://app/game.html?${params.toString()}`);

  win.once('ready-to-show', () => {
    win.show();
    if (settings.launchFullscreen || options.fullscreen) win.setFullScreen(true);
  });

  win.on('close', () => {
    try {
      const b = win.getBounds();
      if (!win.isFullScreen()) {
        store.settings.gameWindowBounds = b;
        store.saveSoon();
      }
    } catch { /* ignore */ }
  });

  win.on('closed', () => {
    const entry = openGames.get(gameId);
    openGames.delete(gameId);
    try {
      const endedAt = new Date().toISOString();
      const seconds = store.addSession(gameId, (entry && entry.startedAt) || startedAt, endedAt);
      log.info(`[${gameId}] session ended (${seconds}s)`);
      const mainWin = getMainWindow();
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('playhub:library-changed', { reason: 'session', gameId });
    } catch (err) {
      log.warn('session record failed', String(err));
    }
  });

  // The game guest lives in the webview; our window failing is still handled.
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`[${gameId}] player window renderer gone`, `${details.reason} (exit ${details.exitCode})`);
  });
  win.webContents.on('unresponsive', () => {
    log.warn(`[${gameId}] player window unresponsive`);
    win.webContents.send('playhub:player-unresponsive');
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Links clicked in OUR chrome: external -> OS browser.
    if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  // Same navigation lockdown as the launcher: our chrome stays in-app, web
  // links go to the OS browser, everything else is denied (never leaks to
  // Windows as an "open this link" prompt).
  win.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith(`${APP_SCHEME}://app/`)) return;
    e.preventDefault();
    if (isSafeExternalUrl(url)) shell.openExternal(url).catch(() => {});
    else log.warn('blocked player-window navigation to', String(url).slice(0, 160));
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    log.error(`[${gameId}] player chrome failed to load`, `${code} ${desc} ${url}`);
    if (win.isDestroyed()) return;
    if (!win.isVisible()) win.show();
    dialog.showMessageBox(win, {
      type: 'error',
      title: 'Game player failed to load',
      message: `The player window for “${rec.title}” could not load.`,
      detail: `Error ${code}: ${desc}\n\nYour games and saves are untouched. Try closing this window and playing again.`,
      buttons: ['Reload player', 'Close'],
      defaultId: 0,
    }).then(({ response }) => {
      if (win.isDestroyed()) return;
      if (response === 0) win.reload();
      else win.close();
    }).catch(() => {});
  });

  log.info(`[${gameId}] player window created`);
  return win;
}

let mainWindowRef = null;
function setMainWindow(win) { mainWindowRef = win; }
function getMainWindow() { return mainWindowRef; }
function isGameOpen(gameId) {
  const e = openGames.get(gameId);
  return !!(e && !e.window.isDestroyed());
}
function closeGame(gameId) {
  const e = openGames.get(gameId);
  if (e && !e.window.isDestroyed()) e.window.close();
}
function focusGame(gameId) {
  const e = openGames.get(gameId);
  if (e && !e.window.isDestroyed()) e.window.focus();
}

function registerGameIpc({ store, paths }) {
  // Screenshots: renderer asks main to capture the guest webview.
  ipcMain.handle('playhub:game-screenshot', async (event, gameId) => {
    const entry = openGames.get(gameId);
    if (!entry || entry.window.isDestroyed()) throw new Error('Game is not running.');
    // The webview lives in the player window's renderer; ask it to capture.
    // We route the request back to that renderer and await its reply.
    const win = entry.window;
    const replyChannel = `playhub:screenshot-result:${gameId}:${Date.now()}`;
    const image = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ipcMain.removeAllListeners(replyChannel);
        reject(new Error('Screenshot timed out.'));
      }, 15000);
      ipcMain.once(replyChannel, (_e, payload) => {
        clearTimeout(timeout);
        if (payload && payload.ok) resolve(payload);
        else reject(new Error((payload && payload.error) || 'Screenshot failed.'));
      });
      win.webContents.send('playhub:capture-request', { gameId, replyChannel });
    });
    const dir = path.join(paths.screenshots, gameId);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    const dest = path.join(dir, name);
    fs.writeFileSync(dest, Buffer.from(image.pngBase64, 'base64'));
    log.info(`[${gameId}] screenshot saved: ${name}`);
    return { path: dest, name };
  });

  ipcMain.handle('playhub:game-set-network-block', (_e, gameId, blocked) => {
    const rec = store.getGame(gameId);
    if (!rec) throw new Error('Game not found.');
    rec.blockNetwork = !!blocked;
    store.upsertGame(rec);
    applyNetworkPolicy(gameId, rec.blockNetwork);
    return rec.blockNetwork;
  });

  ipcMain.handle('playhub:is-game-open', (_e, gameId) => isGameOpen(gameId));

  // Renderer (player) -> guest input injection happens in the player
  // renderer via webview.sendInputEvent; no main-process hop needed.
}

module.exports = {
  createGameWindow, isGameOpen, closeGame, focusGame,
  setMainWindow, getMainWindow, registerGameIpc, partitionFor,
};
