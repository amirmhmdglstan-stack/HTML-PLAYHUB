/* api.js — typed IPC client + in-memory library cache. */
const P = () => window.playhub;

export const api = {
  invoke: (channel, ...args) => P().invoke(channel, ...args),
  on: (channel, fn) => P().on(channel, fn),

  gamesList: () => P().invoke('games:list'),
  gameGet: (id) => P().invoke('games:get', id),
  toggleFavorite: (id) => P().invoke('games:toggle-favorite', id),
  updateGame: (id, patch) => P().invoke('games:update', id, patch),
  removeGame: (id) => P().invoke('games:remove', id),
  refreshGame: (id) => P().invoke('games:refresh', id),
  integrity: () => P().invoke('games:integrity'),
  repairManifest: (id) => P().invoke('games:repair-manifest', id),
  openFolder: (id) => P().invoke('games:open-folder', id),
  play: (id, options) => P().invoke('games:play', id, options || {}),
  isOpen: (id) => P().invoke('games:is-open', id),
  randomGame: (filters) => P().invoke('games:random', filters || {}),
  exportZip: (id) => P().invoke('games:export-zip', id),

  importPick: (kind) => P().invoke('import:pick', kind),
  importAnalyze: (source) => P().invoke('import:analyze', source),
  importThumb: (stagingId, rel) => P().invoke('import:thumb-preview', stagingId, rel),
  importConfirm: (stagingId, review) => P().invoke('import:confirm', stagingId, review),
  importCancel: (stagingId) => P().invoke('import:cancel', stagingId),

  catalog: () => P().invoke('catalog:get'),
  catalogRefresh: () => P().invoke('catalog:refresh'),
  discoverInstall: (entry) => P().invoke('discover:install', entry),

  backupCreate: (id, includeSaves) => P().invoke('backup:create', id, includeSaves !== false),
  backupList: () => P().invoke('backup:list'),
  backupRestore: (name, opts) => P().invoke('backup:restore', name, opts || {}),
  backupDelete: (name) => P().invoke('backup:delete', name),
  backupOpenFolder: () => P().invoke('backup:open-folder'),

  savesInfo: (id) => P().invoke('saves:info', id),
  savesClear: (id) => P().invoke('saves:clear', id),

  shotsList: (id) => P().invoke('screenshots:list', id),
  shotGet: (id, name) => P().invoke('screenshots:get', id, name),
  shotDelete: (id, name) => P().invoke('screenshots:delete', id, name),

  collectionsList: () => P().invoke('collections:list'),
  collectionCreate: (name, icon) => P().invoke('collections:create', { name, icon }),
  collectionUpdate: (id, patch) => P().invoke('collections:update', id, patch),
  collectionDelete: (id) => P().invoke('collections:delete', id),
  collectionSetGames: (id, gameIds) => P().invoke('collections:set-games', id, gameIds),

  diagnose: (id) => P().invoke('doctor:diagnose', id),
  filesList: (id) => P().invoke('files:list', id),
  stats: () => P().invoke('stats:overview'),

  settingsGet: () => P().invoke('settings:get'),
  settingsSet: (patch) => P().invoke('settings:set', patch),
  dataOpenFolder: () => P().invoke('data:open-folder'),
  dataExport: () => P().invoke('data:export-library'),
  dataImport: () => P().invoke('data:import-library'),
  logsGet: (n) => P().invoke('logs:get', n || 200),
  appInfo: () => P().invoke('app:info'),

  layoutsGet: () => P().invoke('layouts:get'),
  layoutSaveGame: (gameId, layout) => P().invoke('layouts:save-game', gameId, layout),
  layoutSavePreset: (name, layout) => P().invoke('layouts:save-preset', name, layout),
  layoutDeletePreset: (name) => P().invoke('layouts:delete-preset', name),

  thumbGet: (id) => P().invoke('thumb:get', id),
  checkAppUpdate: () => P().invoke('updates:check-app'),
  openExternal: (url) => P().invoke('shell:open-external', url),
};

/** Library cache: keeps the last games list + thumb-url memo to avoid refetch. */
export const library = {
  games: [],
  byId: new Map(),
  thumbUrls: new Map(),
  pendingThumbs: new Map(),
  listeners: new Set(),

  setGames(games) {
    this.games = games || [];
    this.byId = new Map(this.games.map((g) => [g.id, g]));
    this.emit();
  },
  get(id) { return this.byId.get(id); },
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const fn of this.listeners) { try { fn(); } catch { /* ignore */ } } },

  async refresh() {
    const games = await api.gamesList();
    this.setGames(games);
    return games;
  },

  /** Lazily resolve a thumbnail data URL (cached). Returns null for fallback art. */
  thumb(id) {
    if (this.thumbUrls.has(id)) return Promise.resolve(this.thumbUrls.get(id));
    if (this.pendingThumbs.has(id)) return this.pendingThumbs.get(id);
    const rec = this.byId.get(id);
    if (!rec || !rec.thumbnail) { this.thumbUrls.set(id, null); return Promise.resolve(null); }
    const p = api.thumbGet(id).then((r) => {
      const url = r && r.dataUrl ? r.dataUrl : null;
      this.thumbUrls.set(id, url);
      this.pendingThumbs.delete(id);
      return url;
    }).catch(() => {
      this.thumbUrls.set(id, null);
      this.pendingThumbs.delete(id);
      return null;
    });
    this.pendingThumbs.set(id, p);
    return p;
  },
};
