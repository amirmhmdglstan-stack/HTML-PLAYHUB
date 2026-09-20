'use strict';
/** menu.js — minimal application menu (keyboard shortcuts, no dead items). */
const { Menu, shell } = require('electron');

function buildMenu({ mainWindow, openImport, openSettings, surprise }) {
  const template = [
    {
      label: 'Library',
      submenu: [
        { label: 'Go to Library', accelerator: 'Ctrl+1', click: () => mainWindow.webContents.send('playhub:navigate', 'library') },
        { label: 'Go to Discover', accelerator: 'Ctrl+2', click: () => mainWindow.webContents.send('playhub:navigate', 'discover') },
        { type: 'separator' },
        { label: 'Import Game…', accelerator: 'Ctrl+O', click: openImport },
        { label: 'Surprise Me', accelerator: 'Ctrl+R', click: surprise },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'Ctrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Documentation', click: () => shell.openExternal('https://github.com/amirmhmdglstan-stack/HTML-PLAYHUB') },
        { label: 'Check for Updates', click: () => mainWindow.webContents.send('playhub:navigate', 'settings-updates') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
