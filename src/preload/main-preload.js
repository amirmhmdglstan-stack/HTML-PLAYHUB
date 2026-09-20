'use strict';
/**
 * main-preload.js — context bridge for the launcher window.
 * Exposes a minimal, explicit IPC surface as window.playhub.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const INVOKE = [
  'games:list', 'games:get', 'games:toggle-favorite', 'games:update',
  'games:remove', 'games:refresh', 'games:integrity', 'games:repair-manifest',
  'games:open-folder', 'games:play', 'games:is-open', 'games:random', 'games:export-zip',
  'import:pick', 'import:analyze', 'import:thumb-preview', 'import:confirm', 'import:cancel',
  'catalog:get', 'catalog:refresh', 'discover:install',
  'backup:create', 'backup:list', 'backup:restore', 'backup:delete', 'backup:open-folder',
  'saves:info', 'saves:clear',
  'screenshots:list', 'screenshots:get', 'screenshots:delete',
  'collections:list', 'collections:create', 'collections:update', 'collections:delete', 'collections:set-games',
  'doctor:diagnose', 'files:list', 'stats:overview',
  'settings:get', 'settings:set', 'data:open-folder', 'data:export-library', 'data:import-library',
  'logs:get', 'app:info',
  'layouts:get', 'layouts:save-game', 'layouts:save-preset', 'layouts:delete-preset',
  'thumb:get', 'updates:check-app', 'shell:open-external',
];

const LISTEN = [
  'playhub:library-changed', 'playhub:navigate', 'playhub:surprise',
  'playhub:import-file', 'playhub:import-progress', 'playhub:download-progress',
  'playhub:settings-changed',
];

const api = {
  invoke: (channel, ...args) => {
    if (!INVOKE.includes(channel)) return Promise.reject(new Error(`Blocked IPC channel: ${channel}`));
    return ipcRenderer.invoke(channel, ...args);
  },
  on: (channel, fn) => {
    if (!LISTEN.includes(channel)) throw new Error(`Blocked listener channel: ${channel}`);
    const wrapped = (_e, ...args) => fn(...args);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  /** Resolve real filesystem paths for files dropped into the window. */
  dropPaths: (files) => {
    const out = [];
    for (const f of files || []) {
      try {
        const p = webUtils.getPathForFile(f);
        if (p) out.push(p);
      } catch { /* ignore */ }
    }
    return out;
  },
};

contextBridge.exposeInMainWorld('playhub', api);
