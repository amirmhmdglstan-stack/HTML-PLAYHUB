'use strict';
/**
 * store.js — embedded document database (JSON file-backed, atomic writes).
 *
 * Why not SQLite? Zero native dependencies means the Windows build can never
 * fail on node-gyp/prebuilt binaries, the database file stays human-readable
 * and trivially portable, and for a game library (even 10k games) an indexed
 * in-memory JSON store is more than fast enough. Writes are atomic
 * (temp-file + rename) and debounced; metadata is cached so startup never
 * rescans game files unless something changed.
 *
 * Collections:
 *   games:        { [id]: GameRecord }      — installed games index
 *   collections:  { [id]: {id,name,icon,gameIds[],builtin} }
 *   sessions:     [ {id, gameId, startedAt, endedAt, seconds} ] (capped)
 *   downloads:    { [id]: DownloadRecord }
 *   meta:         { bundleVersion, firstRunDone, catalogUpdatedAt, ... }
 *
 * Settings and control layouts live in their own files (settings.json,
 * control-layouts.json) for independent export.
 */
const fs = require('node:fs');
const path = require('node:path');
const { atomicWriteFileSync } = require('./util');
const { scope } = require('./log');

const log = scope('store');

const DB_VERSION = 1;
const MAX_SESSIONS = 2000;

const DEFAULT_SETTINGS = {
  theme: 'system',            // system | dark | light | amoled
  accent: 'violet',           // violet | blue | green | amber | pink | teal
  reduceMotion: false,
  defaultView: 'home',        // home | library | discover
  libraryView: 'grid',        // grid | list
  defaultSort: 'recently-added',
  launchFullscreen: false,
  defaultZoom: 100,
  defaultFrame: 'none',       // none | 16:9 | 4:3 | 1:1 | 9:16
  showVirtualControls: false,
  defaultControlPreset: 'generic',
  inputSensitivity: 1.0,
  concurrentDownloads: 3,
  checkCatalogUpdates: false,
  checkAppUpdates: false,
  developerMode: false,
  confirmBeforeRemove: true,
  gameWindowBounds: null,
  firstRunDone: false,
  setupDone: false,
  ignoredUpdateVersion: null,
};

function defaultDb() {
  return {
    version: DB_VERSION,
    games: {},
    collections: {},
    sessions: [],
    downloads: {},
    meta: { createdAt: new Date().toISOString(), bundleVersion: 0 },
  };
}

class Store {
  constructor(paths) {
    this.paths = paths;
    this.db = defaultDb();
    this.settings = { ...DEFAULT_SETTINGS };
    this.layouts = { global: {}, perGame: {} };
    this._saveTimer = null;
    this._loaded = false;
  }

  load() {
    if (this._loaded) return this;
    this.db = this._readJson(this.paths.dbFile, defaultDb());
    if (!this.db || typeof this.db !== 'object') this.db = defaultDb();
    this.db.version = DB_VERSION;
    for (const k of ['games', 'collections', 'downloads']) {
      if (!this.db[k] || typeof this.db[k] !== 'object') this.db[k] = {};
    }
    if (!Array.isArray(this.db.sessions)) this.db.sessions = [];
    if (!this.db.meta || typeof this.db.meta !== 'object') this.db.meta = { bundleVersion: 0 };

    const s = this._readJson(this.paths.settingsFile, {});
    this.settings = { ...DEFAULT_SETTINGS, ...(s || {}) };
    const l = this._readJson(this.paths.layoutsFile, {});
    this.layouts = {
      global: (l && l.global) || {},
      perGame: (l && l.perGame) || {},
    };
    this._loaded = true;
    log.info(`loaded db (${Object.keys(this.db.games).length} games)`);
    return this;
  }

  _readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      const raw = fs.readFileSync(file, 'utf8');
      if (!raw.trim()) return fallback;
      return JSON.parse(raw);
    } catch (err) {
      log.warn(`could not parse ${path.basename(file)}, backing up and resetting`, String(err));
      try {
        fs.copyFileSync(file, `${file}.corrupt-${Date.now()}.bak`);
      } catch { /* ignore */ }
      return fallback;
    }
  }

  saveSoon() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveNow();
    }, 400);
  }

  saveNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = null; }
    try {
      atomicWriteFileSync(this.paths.dbFile, JSON.stringify(this.db));
      atomicWriteFileSync(this.paths.settingsFile, JSON.stringify(this.settings, null, 2));
      atomicWriteFileSync(this.paths.layoutsFile, JSON.stringify(this.layouts));
    } catch (err) {
      log.error('failed to persist store', String(err));
    }
  }

  // ---- games ----
  getGame(id) { return this.db.games[id] || null; }
  allGames() { return Object.values(this.db.games); }
  upsertGame(record) { this.db.games[record.id] = record; this.saveSoon(); }
  removeGame(id) {
    delete this.db.games[id];
    for (const c of Object.values(this.db.collections)) {
      c.gameIds = (c.gameIds || []).filter((g) => g !== id);
    }
    this.saveSoon();
  }

  // ---- collections ----
  ensureBuiltinCollections() {
    const builtins = [
      { id: 'all', name: 'All Games', icon: 'grid', builtin: 'all' },
      { id: 'favorites', name: 'Favorites', icon: 'star', builtin: 'favorites' },
      { id: 'recent', name: 'Recently Played', icon: 'clock', builtin: 'recent' },
      { id: 'installed', name: 'Installed', icon: 'check', builtin: 'installed' },
    ];
    let changed = false;
    for (const b of builtins) {
      if (!this.db.collections[b.id]) {
        this.db.collections[b.id] = { ...b, gameIds: [] };
        changed = true;
      }
    }
    if (changed) this.saveSoon();
  }

  // ---- sessions / playtime ----
  addSession(gameId, startedAt, endedAt) {
    const seconds = Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 1000));
    this.db.sessions.push({ id: `${Date.now().toString(36)}-${gameId}`, gameId, startedAt, endedAt, seconds });
    if (this.db.sessions.length > MAX_SESSIONS) {
      this.db.sessions.splice(0, this.db.sessions.length - MAX_SESSIONS);
    }
    const g = this.db.games[gameId];
    if (g) {
      g.playTimeSeconds = (g.playTimeSeconds || 0) + seconds;
      g.playCount = (g.playCount || 0) + 1;
      g.lastPlayedAt = endedAt;
    }
    this.saveSoon();
    return seconds;
  }

  playtimeFor(gameId) {
    const g = this.db.games[gameId];
    return (g && g.playTimeSeconds) || 0;
  }
}

module.exports = { Store, DEFAULT_SETTINGS, DB_VERSION };
