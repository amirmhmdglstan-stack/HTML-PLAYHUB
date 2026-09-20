/* app.js — shell: navigation, sidebar, search, shortcuts, drag-drop, first-run. */
import { el, debounce, collectionIcon } from './util.js';
import { api, library } from './api.js';
import { toast, openModal } from './ui.js';
import { renderLibrary, renderFilterbar, libraryState, resetFilters, hideFilterbar } from './view-library.js';
import { renderHome, renderGenre, surprise } from './view-home.js';
import { renderDetails } from './view-details.js';
import { renderDiscover } from './view-discover.js';
import { renderImport } from './view-import.js';
import { renderCollections, renderCollectionDetail } from './view-collections.js';
import { renderSettings } from './view-settings.js';

const view = () => document.getElementById('view');

// ---------- navigation ----------
const nav = {
  history: [], index: -1,
  go(route) {
    this.history = this.history.slice(0, this.index + 1);
    this.history.push(route);
    if (this.history.length > 60) this.history.shift();
    this.index = this.history.length - 1;
    this.render(route);
  },
  back() { if (this.index > 0) { this.index--; this.render(this.history[this.index]); } },
  fwd() { if (this.index < this.history.length - 1) { this.index++; this.render(this.history[this.index]); } },
  refresh() { this.render(this.history[this.index] || 'home'); },
  render(route) {
    updateNavButtons();
    const root = view();
    root.scrollTop = 0;
    markActiveNav(route);
    if (route === 'home') renderHome(root, this);
    else if (route === 'library' || route === 'installed') renderLibrary(root, this, { preset: route });
    else if (route === 'favorites') renderLibrary(root, this, { preset: 'favorites' });
    else if (route === 'recent') renderLibrary(root, this, { preset: 'recent' });
    else if (route === 'broken') renderLibrary(root, this, { preset: 'broken' });
    else if (route.startsWith('genre:')) renderGenre(root, this, route.slice(6));
    else if (route.startsWith('game:')) renderDetails(root, this, route.slice(5));
    else if (route === 'collections') renderCollections(root, this);
    else if (route.startsWith('collection:')) renderCollectionDetail(root, this, route.slice(11));
    else if (route === 'discover') renderDiscover(root, this);
    else if (route === 'import') renderImport(root, this);
    else if (route.startsWith('import-file:')) renderImport(root, this, route.slice(12));
    else if (route === 'settings') renderSettings(root, this);
    else if (route === 'settings-updates') renderSettings(root, this, 'updates');
    else renderHome(root, this);
  },
};
window.__nav = nav;

function updateNavButtons() {
  document.getElementById('btn-back').disabled = nav.index <= 0;
  document.getElementById('btn-fwd').disabled = nav.index >= nav.history.length - 1;
}

const NAV_ITEMS = [
  ['home', '⌂', 'Home'],
  ['library', '▦', 'All Games'],
  ['favorites', '★', 'Favorites'],
  ['recent', '🕘', 'Recently Played'],
  ['collections', '🗂', 'Collections'],
  ['discover', '🧭', 'Discover'],
  ['import', '＋', 'Import'],
  ['settings', '⚙', 'Settings'],
];

function buildSidebar() {
  const navEl = document.getElementById('nav');
  navEl.innerHTML = '';
  const games = library.games;
  const counts = {
    library: games.length,
    favorites: games.filter((g) => g.favorite).length,
    recent: games.filter((g) => g.lastPlayedAt).length,
  };
  for (const [id, ico, label] of NAV_ITEMS) {
    navEl.append(el('button', {
      class: `nav-btn${nav.history[nav.index] === id ? ' active' : ''}`,
      dataset: { route: id },
      onclick: () => nav.go(id),
    }, el('span', { class: 'ico' }, ico), el('span', { text: label }),
      counts[id] ? el('span', { class: 'count' }, String(counts[id])) : null));
  }
  const sideCols = document.getElementById('side-collections');
  sideCols.innerHTML = '';
  for (const c of (window.__collections || []).filter((c) => !c.builtin).slice(0, 8)) {
    sideCols.append(el('button', {
      class: 'nav-btn', dataset: { route: `collection:${c.id}` },
      onclick: () => nav.go(`collection:${c.id}`),
    }, el('span', { class: 'ico' }, collectionIcon(c.icon)), el('span', { text: c.name }),
      el('span', { class: 'count' }, String((c.gameIds || []).length))));
  }
  const stats = document.getElementById('side-stats');
  const totalMin = Math.round(games.reduce((a, g) => a + (g.playTimeSeconds || 0), 0) / 60);
  stats.textContent = `${games.length} game(s) · ${totalMin}m played`;
}

function markActiveNav(route) {
  document.querySelectorAll('#nav .nav-btn, #side-collections .nav-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.route === route);
  });
}

// ---------- search ----------
function wireSearch() {
  const box = document.getElementById('search');
  const clr = document.getElementById('search-clear');
  const onType = debounce(() => {
    libraryState.query = box.value.trim();
    clr.hidden = !box.value;
    const cur = nav.history[nav.index];
    if (['library', 'installed', 'favorites', 'recent', 'broken'].includes(cur)) nav.refresh();
    else if (libraryState.query) nav.go('library');
  }, 180);
  box.addEventListener('input', onType);
  clr.onclick = () => { box.value = ''; libraryState.query = ''; clr.hidden = true; nav.refresh(); box.focus(); };
}

// ---------- drag & drop ----------
function wireDrop() {
  const overlay = document.getElementById('drop-overlay');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
    depth++;
    overlay.hidden = false;
  });
  window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    overlay.hidden = true;
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    const paths = window.playhub.dropPaths(e.dataTransfer.files);
    if (!paths.length) { toast('Could not read the dropped file(s).', 'warn'); return; }
    const p = paths[0];
    if (/\.(html?|zip)$/i.test(p)) nav.go(`import-file:${p}`);
    else {
      // Might be a folder — the main process will validate.
      nav.go('import');
      setTimeout(() => toast('Dropped item is not an .html/.zip file. Use Import → Folder for directories.', 'warn'), 300);
    }
    if (paths.length > 1) setTimeout(() => toast('One at a time for now — the first file was queued.', ''), 600);
  });
}

// ---------- shortcuts ----------
function wireShortcuts() {
  document.addEventListener('keydown', (e) => {
    const inField = /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '');
    if (e.key === '/' && !inField) { e.preventDefault(); document.getElementById('search').focus(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); surprise(nav); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') { e.preventDefault(); nav.go('import'); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '1') { e.preventDefault(); nav.go('library'); }
    else if ((e.ctrlKey || e.metaKey) && e.key === '2') { e.preventDefault(); nav.go('discover'); }
    else if ((e.ctrlKey || e.metaKey) && e.key === ',') { e.preventDefault(); nav.go('settings'); }
    else if (e.altKey && e.key === 'ArrowLeft') nav.back();
    else if (e.altKey && e.key === 'ArrowRight') nav.fwd();
  });
  document.getElementById('btn-back').onclick = () => nav.back();
  document.getElementById('btn-fwd').onclick = () => nav.fwd();
  document.getElementById('btn-surprise').onclick = () => surprise(nav);
  document.getElementById('btn-import-top').onclick = () => nav.go('import');
  document.getElementById('btn-theme').onclick = cycleTheme;
}

function cycleTheme() {
  const order = ['system', 'dark', 'light', 'amoled'];
  const cur = window.__settings.theme || 'system';
  const next = order[(order.indexOf(cur) + 1) % order.length];
  api.settingsSet({ theme: next }).then(() => {
    window.__settings.theme = next;
    applySettings();
    toast(`Theme: ${next}`, '');
  });
}

function applySettings() {
  const s = window.__settings || {};
  document.documentElement.dataset.theme = s.theme || 'system';
  document.documentElement.dataset.accent = s.accent || 'violet';
  document.documentElement.dataset.motion = s.reduceMotion ? 'reduced' : 'full';
  window.__devMode = !!s.developerMode;
  if (s.defaultSort) libraryState.sort = s.defaultSort;
  if (s.libraryView) libraryState.mode = s.libraryView;
}

// ---------- first run ----------
async function maybeFirstRun() {
  const s = window.__settings;
  if (s.setupDone) return;
  const themes = el('div', { class: 'theme-swatches', style: 'justify-content:center' });
  let theme = 'system';
  const tbtns = [];
  for (const [id, label, bg] of [['system', 'System', 'linear-gradient(135deg,#0b0d16 50%,#eef1f8 50%)'], ['dark', 'Dark', '#171b2e'], ['light', 'Light', '#fff'], ['amoled', 'AMOLED', '#000']]) {
    const b = el('button', { class: `swatch${id === theme ? ' on' : ''}`, title: label, style: `background:${bg};border-color:var(--border-strong);width:56px;height:40px` });
    b.onclick = () => { theme = id; tbtns.forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
    tbtns.push(b);
    themes.append(b);
  }
  const body = el('div', {},
    el('div', { class: 'setup-hero' },
      el('div', { class: 'big' }, '🎮'),
      el('h2', { text: 'Welcome to HTML Playhub' }),
      el('p', { class: 'muted' }, `${library.games.length} bundled game(s) are ready. Pick a theme — everything else just works.`)),
    themes,
    el('div', { class: 'note-box' },
      el('b', { text: 'Where games live: ' }),
      el('span', { class: 'mono small', text: s._dataRoot || '' }),
      el('br'), el('span', { class: 'small' }, 'Import .html / .zip / folders, or install more from Discover. Fully offline after that.')));
  const { close } = openModal({
    title: 'First launch',
    body,
    footer: [el('button', {
      class: 'btn primary lg', onclick: async () => {
        await api.settingsSet({ theme, setupDone: true, firstRunDone: true });
        window.__settings.theme = theme;
        window.__settings.setupDone = true;
        applySettings();
        close();
        nav.refresh();
        toast('Welcome aboard! Press 🎲 any time for a random game.', 'good');
      },
    }, 'Start playing')],
  });
}

// ---------- boot ----------
async function boot() {
  try {
    window.__settings = await api.settingsGet();
  } catch { window.__settings = {}; }
  applySettings();
  document.addEventListener('playhub:settings', () => applySettings());
  document.addEventListener('playhub:goto-settings-updates', () => nav.go('settings-updates'));

  wireSearch();
  wireDrop();
  wireShortcuts();

  try { window.__collections = await api.collectionsList(); } catch { window.__collections = []; }
  try { await library.refresh(); } catch { library.setGames([]); }

  buildSidebar();
  library.onChange(buildSidebar);
  api.on('playhub:library-changed', async () => {
    const cur = nav.history[nav.index];
    await library.refresh();
    try { window.__collections = await api.collectionsList(); } catch { /* ignore */ }
    if (cur && cur.startsWith('game:')) {
      const id = cur.slice(5);
      if (!library.get(id)) nav.go('library');
      else nav.refresh();
    } else if (cur) nav.refresh();
    else buildSidebar();
  });
  api.on('playhub:navigate', (route) => nav.go(route));
  api.on('playhub:surprise', () => surprise(nav));
  api.on('playhub:import-file', (filePath) => nav.go(`import-file:${filePath}`));
  api.on('playhub:settings-changed', (s) => {
    window.__settings = s;
    applySettings();
    const cur = nav.history[nav.index];
    if (cur === 'settings') nav.refresh();
  });

  nav.go(window.__settings.defaultView || 'home');
  await maybeFirstRun();

  // Optional startup update check (off by default; never blocks).
  if (window.__settings.checkAppUpdates) {
    api.checkAppUpdate().then((r) => {
      if (r && r.ok && r.available) {
        const dot = document.getElementById('update-dot');
        if (dot) {
          dot.hidden = false;
          dot.textContent = `⬆ Update v${r.latest} available`;
          dot.onclick = () => nav.go('settings-updates');
        }
      }
    }).catch(() => {});
  }
  // Library integrity: passive check, surfaced only if broken games exist.
  api.integrity().then((r) => {
    if (r && !r.ok && r.issues.length) {
      const n = new Set(r.issues.map((i) => i.gameId)).size;
      toast(`⚠ ${n} game(s) need attention. See library filter “broken”.`, 'warn');
    }
  }).catch(() => {});
}

boot();
