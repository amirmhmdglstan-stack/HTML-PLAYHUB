'use strict';
/**
 * game-preload.js — context bridge for the player window (game.html).
 * The game itself runs inside a <webview> and has NO access to this bridge.
 */
const { contextBridge, ipcRenderer } = require('electron');

const INVOKE = [
  'games:get', 'games:is-open', 'games:update', 'settings:get', 'settings:set',
  'layouts:get', 'layouts:save-game', 'layouts:save-preset', 'layouts:delete-preset',
  'doctor:diagnose', 'screenshots:list', 'shell:open-external',
  'playhub:game-screenshot', 'playhub:game-set-network-block', 'playhub:is-game-open',
  'player:guest-ready', 'stats:overview',
];

const LISTEN = ['playhub:capture-request', 'playhub:player-unresponsive', 'playhub:settings-changed', 'playhub:player-key'];

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
  sendCaptureResult: (replyChannel, payload) => ipcRenderer.send(replyChannel, payload),
};

contextBridge.exposeInMainWorld('playhubGame', api);
