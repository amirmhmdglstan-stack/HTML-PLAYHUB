/* view-settings.js — settings: appearance, games, controls, downloads, storage, updates, about. */
import { el, formatBytes } from './util.js';
import { api, library } from './api.js';
import { toast, openModal, confirmDialog } from './ui.js';
import { hideFilterbar, libraryState } from './view-library.js';

export async function renderSettings(root, nav, section = null) {
  hideFilterbar();
  root.innerHTML = '';
  const s = window.__settings || {};
  root.append(el('div', { class: 'view-head' },
    el('h1', { text: 'Settings' }),
    el('span', { class: 'sub', text: s._portable ? 'Portable mode — data stays next to the app' : 'Installed mode' })));

  const grid = el('div', { class: 'set-grid' });
  root.append(grid);

  // ---- appearance ----
  const app = el('div', { class: 'panel' }, el('h3', { text: '🎨 Appearance' }));
  const themeRow = el('div', { class: 'theme-swatches' });
  const themes = [['system', 'System', 'linear-gradient(135deg,#0b0d16 50%,#eef1f8 50%)'], ['dark', 'Dark', '#171b2e'], ['light', 'Light', '#ffffff'], ['amoled', 'AMOLED', '#000000']];
  for (const [id, label, bg] of themes) {
    const b = el('button', { class: `swatch${s.theme === id ? ' on' : ''}`, title: label, style: `background:${bg};border-color:var(--border-strong)` });
    b.onclick = () => set({ theme: id });
    themeRow.append(b);
  }
  app.append(el('p', { class: 'small muted' }, 'Theme'), themeRow);
  const accents = el('div', { class: 'accent-dots' });
  for (const [id, color] of [['violet', '#7c3aed'], ['blue', '#2563eb'], ['green', '#059669'], ['amber', '#d97706'], ['pink', '#db2777'], ['teal', '#0d9488']]) {
    const b = el('button', { class: `accent-dot${s.accent === id ? ' on' : ''}`, title: id, style: `background:${color}` });
    b.onclick = () => set({ accent: id });
    accents.append(b);
  }
  app.append(el('p', { class: 'small muted' }, 'Accent color'), accents);
  app.append(checkRow('Reduce motion', s.reduceMotion, (v) => set({ reduceMotion: v })));
  const defView = el('select', { 'aria-label': 'Start on' });
  for (const [v, l] of [['home', 'Home'], ['library', 'Library'], ['discover', 'Discover']]) defView.append(el('option', { value: v, selected: s.defaultView === v ? 'selected' : null }, l));
  defView.onchange = () => set({ defaultView: defView.value });
  app.append(el('p', {}, el('span', { class: 'small muted' }, 'Start on: '), defView));
  grid.append(app);

  // ---- games ----
  const gm = el('div', { class: 'panel' }, el('h3', { text: '🎮 Games' }));
  gm.append(checkRow('Launch games fullscreen', s.launchFullscreen, (v) => set({ launchFullscreen: v })));
  gm.append(checkRow('Show virtual controls by default', s.showVirtualControls, (v) => set({ showVirtualControls: v })));
  const zoomSel = el('select', {});
  for (const z of [50, 75, 100, 125, 150, 175, 200]) zoomSel.append(el('option', { value: String(z), selected: (s.defaultZoom || 100) === z ? 'selected' : null }, `${z}%`));
  zoomSel.onchange = () => set({ defaultZoom: Number(zoomSel.value) });
  gm.append(el('p', {}, el('span', { class: 'small muted' }, 'Default zoom: '), zoomSel));
  const frameSel = el('select', {});
  for (const [v, l] of [['none', 'None'], ['16:9', '16:9'], ['4:3', '4:3'], ['1:1', '1:1'], ['9:16', '9:16']]) frameSel.append(el('option', { value: v, selected: (s.defaultFrame || 'none') === v ? 'selected' : null }, l));
  frameSel.onchange = () => set({ defaultFrame: frameSel.value });
  gm.append(el('p', {}, el('span', { class: 'small muted' }, 'Default aspect frame: '), frameSel));
  gm.append(checkRow('Ask before removing games', s.confirmBeforeRemove !== false, (v) => set({ confirmBeforeRemove: v })));
  grid.append(gm);

  // ---- controls ----
  const ct = el('div', { class: 'panel' }, el('h3', { text: '🕹 Controls' }));
  const presetSel = el('select', {});
  const { CONTROL_PRESETS } = await import('./controls.js');
  for (const p of Object.keys(CONTROL_PRESETS)) presetSel.append(el('option', { value: p, selected: (s.defaultControlPreset || 'generic') === p ? 'selected' : null }, CONTROL_PRESETS[p].label));
  try {
    const layouts = await api.layoutsGet();
    for (const name of Object.keys(layouts.global || {})) presetSel.append(el('option', { value: `custom:${name}`, selected: s.defaultControlPreset === `custom:${name}` ? 'selected' : null }, `★ ${name}`));
  } catch { /* ignore */ }
  presetSel.onchange = () => set({ defaultControlPreset: presetSel.value });
  ct.append(el('p', {}, el('span', { class: 'small muted' }, 'Default virtual-control preset: '), presetSel));
  const sens = el('input', { type: 'range', min: '0.2', max: '3', step: '0.1', value: String(s.inputSensitivity || 1) });
  const sensLabel = el('span', { class: 'small' }, `${s.inputSensitivity || 1}×`);
  sens.onchange = () => { sensLabel.textContent = `${sens.value}×`; set({ inputSensitivity: Number(sens.value) }); };
  ct.append(el('p', {}, el('span', { class: 'small muted' }, 'Touchpad sensitivity: '), sens, ' ', sensLabel));
  ct.append(el('p', { class: 'small muted' }, 'Edit layouts per game inside the player (F9 → Edit layout). Real gamepads work automatically — test one in the player (F9 → Gamepad test).'));
  grid.append(ct);

  // ---- downloads ----
  const dl = el('div', { class: 'panel' }, el('h3', { text: '⬇ Downloads' }));
  dl.append(el('p', { class: 'small muted' }, 'Playhub downloads one game at a time to keep installs reliable. Retries are automatic; failed downloads never touch working installs.'));
  dl.append(checkRow('Auto-check catalog for new games', !!s.checkCatalogUpdates, (v) => set({ checkCatalogUpdates: v })));
  const btnCat = el('button', { class: 'btn sm', onclick: async () => {
    try { const c = await api.catalogRefresh(); toast(`Catalog updated (${c.games.length} entries).`, 'good'); }
    catch (err) { toast(`Catalog update failed: ${err.message}`, 'warn'); }
  } }, 'Update catalog now');
  dl.append(el('div', { class: 'toolbar-row' }, btnCat));
  grid.append(dl);

  // ---- storage ----
  const st = el('div', { class: 'panel' }, el('h3', { text: '💾 Storage' }));
  st.append(el('p', { class: 'small' }, el('span', { class: 'muted' }, 'Data folder: '), el('br'), el('span', { class: 'mono small' }, s._dataRoot || '')));
  st.append(el('div', { class: 'toolbar-row' },
    el('button', { class: 'btn sm', onclick: () => api.dataOpenFolder() }, '📁 Open folder'),
    el('button', { class: 'btn sm', onclick: async () => { const p = await api.dataExport(); if (p) toast(`Library exported to ${p}`, 'good'); } }, '📤 Export library data'),
    el('button', {
      class: 'btn sm', onclick: async () => {
        if (await confirmDialog({ title: 'Import library data?', message: 'This replaces your current library index, settings and control layouts (a backup is kept). Continue?', confirmText: 'Import' })) {
          const r = await api.dataImport();
          if (r) { await library.refresh(); nav.go('home'); toast('Library data imported.', 'good'); }
        }
      },
    }, '📥 Import library data')));
  st.append(el('div', { class: 'toolbar-row' },
    el('button', {
      class: 'btn sm', onclick: async () => {
        const r = await api.integrity();
        if (r.ok) toast('Library integrity: all good. ✔', 'good');
        else {
          const body = el('div', {}, ...r.issues.slice(0, 30).map((i) => el('p', { class: 'small' }, `⚠ ${i.message}`)));
          openModal({ title: `Integrity — ${r.issues.length} issue(s)`, body });
        }
      },
    }, '🔍 Check library integrity')));
  grid.append(st);

  // ---- updates ----
  const up = el('div', { class: 'panel', id: 'settings-updates' }, el('h3', { text: '🔄 Application updates' }));
  up.append(checkRow('Auto-check for Playhub updates on startup', !!s.checkAppUpdates, (v) => set({ checkAppUpdates: v })));
  const upLabel = el('p', { class: 'small muted' }, 'No check performed yet.');
  const btnUp = el('button', { class: 'btn sm primary', onclick: async () => {
    upLabel.textContent = 'Checking…';
    const r = await api.checkAppUpdate();
    if (!r.ok) { upLabel.textContent = `Check failed: ${r.error || 'offline?'}`; return; }
    if (r.available) {
      upLabel.innerHTML = '';
      upLabel.append(`Update available: v${r.latest} (you have v${r.current}).`);
      btnGo.hidden = false;
      btnGo.dataset.url = r.url;
      toast(`Update v${r.latest} available — see Settings → Updates.`, 'warn');
      showUpdateDot(r);
    } else {
      upLabel.textContent = `You're up to date (v${r.current}).`;
      btnGo.hidden = true;
    }
  } }, 'Check now');
  const btnGo = el('button', { class: 'btn sm', hidden: 'hidden' }, '↗ Open release page');
  btnGo.onclick = () => api.openExternal(btnGo.dataset.url).catch((e) => toast(`Could not open browser: ${e.message}`, 'bad'));
  up.append(el('div', { class: 'toolbar-row' }, btnUp), upLabel, el('p', { class: 'small' }, btnGo));
  try {
    const info = await api.appInfo();
    up.append(el('p', { class: 'small muted' }, `Playhub v${info.version} · Electron ${info.electron} · Chrome ${info.chrome}`));
  } catch { /* ignore */ }
  grid.append(up);

  // ---- advanced ----
  const adv = el('div', { class: 'panel' }, el('h3', { text: '🧪 Advanced' }));
  adv.append(checkRow('Developer mode (manifest, logs, environment)', !!s.developerMode, (v) => set({ developerMode: v })));
  const btnLogs = el('button', { class: 'btn sm', onclick: async () => {
    const lines = await api.logsGet(300);
    openModal({ title: 'Logs (last 300 lines)', wide: true, body: el('pre', { class: 'code', text: lines.join('\n') || '(empty)' }) });
  } }, 'View logs');
  adv.append(el('div', { class: 'toolbar-row' }, btnLogs));
  grid.append(adv);

  // ---- about ----
  const ab = el('div', { class: 'panel' }, el('h3', { text: 'ℹ About' }));
  ab.append(el('p', { class: 'small' }, 'HTML Playhub — a local-first library & launcher for offline HTML games. No accounts, no analytics, no uploads. Your games, saves and screenshots never leave this computer unless you export them.'));
  ab.append(el('p', { class: 'small muted' }, 'Launcher: MIT License. Catalog games keep their own licenses — see each game page.'));
  grid.append(ab);

  async function set(patch) {
    Object.assign(window.__settings, patch);
    await api.settingsSet(patch);
    document.dispatchEvent(new CustomEvent('playhub:settings', { detail: window.__settings }));
    renderSettings(root, nav);
  }

  if (section === 'updates') {
    setTimeout(() => document.getElementById('settings-updates')?.scrollIntoView(), 100);
  }
}

function checkRow(label, checked, onChange) {
  const labelEl = el('label', { class: 'check-row' });
  const box = el('input', { type: 'checkbox', checked: checked ? 'checked' : null });
  box.onchange = () => onChange(box.checked);
  labelEl.append(box, el('span', { text: label }));
  return el('p', {}, labelEl);
}

function showUpdateDot(r) {
  const dot = document.getElementById('update-dot');
  if (!dot) return;
  dot.hidden = false;
  dot.textContent = `⬆ Update v${r.latest} available`;
  dot.onclick = () => document.dispatchEvent(new CustomEvent('playhub:goto-settings-updates'));
}
