/* view-library.js — browsable, searchable, filterable game library. */
import { el } from './util.js';
import { api, library } from './api.js';
import { gameCard, gameRow, emptyState, pagedList, toast } from './ui.js';

export const SORTS = [
  { id: 'recently-added', label: 'Recently added' },
  { id: 'recently-played', label: 'Recently played' },
  { id: 'most-played', label: 'Most played' },
  { id: 'playtime', label: 'Playtime' },
  { id: 'alphabetical', label: 'A–Z' },
  { id: 'size', label: 'Size' },
  { id: 'favorites', label: 'Favorites first' },
];

export const libraryState = {
  query: '',
  preset: 'all', // all | installed | favorites | recent | collection:<id> | genre:<g> | broken
  genre: '',
  collectionId: '',
  favoritesOnly: false,
  singleFileOnly: false,
  offlineOnly: false,
  sort: 'recently-added',
  mode: 'grid', // grid | list
};

function matchesQuery(g, q) {
  if (!q) return true;
  const hay = [g.title, g.author, g.description, (g.genres || []).join(' '), (g.tags || []).join(' '),
    (g.customTags || []).join(' '), g.sourceCollection, g.license, g.notes].filter(Boolean).join(' ').toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

export function filterGames(games, st = libraryState) {
  let list = games.slice();
  if (st.preset === 'favorites' || st.favoritesOnly) list = list.filter((g) => g.favorite);
  if (st.preset === 'recent') list = list.filter((g) => g.lastPlayedAt).sort((a, b) => (a.lastPlayedAt < b.lastPlayedAt ? 1 : -1));
  if (st.preset === 'broken') list = list.filter((g) => !g.entryExists);
  if (st.genre) list = list.filter((g) => (g.genres || []).includes(st.genre));
  if (st.collectionId) {
    const col = (window.__collections || []).find((c) => c.id === st.collectionId);
    if (col && !col.builtin) {
      const set = new Set(col.gameIds || []);
      list = list.filter((g) => set.has(g.id));
    }
  }
  if (st.singleFileOnly) list = list.filter((g) => g.singleFile);
  if (st.offlineOnly) list = list.filter((g) => !(g.network && g.network.required));
  if (st.query) list = list.filter((g) => matchesQuery(g, st.query));

  const by = {
    'recently-added': (a, b) => ((b.addedAt || '') < (a.addedAt || '') ? -1 : 1),
    'recently-played': (a, b) => ((b.lastPlayedAt || '') < (a.lastPlayedAt || '') ? -1 : 1),
    'most-played': (a, b) => (b.playCount || 0) - (a.playCount || 0),
    playtime: (a, b) => (b.playTimeSeconds || 0) - (a.playTimeSeconds || 0),
    alphabetical: (a, b) => String(a.title).localeCompare(String(b.title)),
    size: (a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0),
    favorites: (a, b) => ((b.favorite ? 1 : 0) - (a.favorite ? 1 : 0)) || String(a.title).localeCompare(String(b.title)),
  }[st.sort] || ((a, b) => 0);
  if (!(st.preset === 'recent' && !st.query)) list.sort(by);
  return list;
}

export function allGenres(games) {
  const set = new Set();
  for (const g of games) for (const x of g.genres || []) set.add(x);
  return [...set].sort();
}

const PRESET_TITLES = {
  all: ['All Games', 'Every game in your library'],
  installed: ['Installed', 'Games ready to play offline'],
  favorites: ['Favorites', 'Your starred games'],
  recent: ['Recently Played', 'Jump back in'],
  broken: ['Needs Attention', 'Games with missing files'],
};

export function renderLibrary(root, nav, opts = {}) {
  if (opts.preset) libraryState.preset = opts.preset;
  if (opts.genre !== undefined) libraryState.genre = opts.genre;
  if (opts.collectionId !== undefined) libraryState.collectionId = opts.collectionId;

  const games = library.games;
  const [title, sub] = PRESET_TITLES[libraryState.preset] || ['Library', ''];
  const list = filterGames(games);

  root.innerHTML = '';
  renderFilterbar(nav);

  const head = el('div', { class: 'view-head' },
    el('h1', { text: libraryState.genre ? libraryState.genre : title }),
    el('span', { class: 'sub', text: `${list.length} of ${games.length} game(s)${libraryState.query ? ` for “${libraryState.query}”` : ''}` }));
  root.append(head);

  if (!games.length) {
    root.append(emptyState({
      icon: '📚', title: 'Your library is empty',
      body: 'Import your own HTML games or install some from Discover to get started.',
      actions: [
        el('button', { class: 'btn primary', onclick: () => nav.go('import') }, '＋ Import Game'),
        el('button', { class: 'btn', onclick: () => nav.go('discover') }, '🧭 Browse Discover'),
      ],
    }));
    return;
  }
  if (!list.length) {
    root.append(emptyState({
      icon: '🔍', title: 'No games match',
      body: 'Try a different search or clear the filters.',
      actions: [el('button', { class: 'btn', onclick: () => { resetFilters(); renderLibrary(root, nav); syncSearchBox(); } }, 'Clear filters')],
    }));
    return;
  }

  const wrap = el('div', { class: libraryState.mode === 'grid' ? 'grid' : 'rows' });
  root.append(wrap);
  const cardOpts = {
    onOpen: (g) => nav.go(`game:${g.id}`),
    onPlay: (g) => playGame(g, nav),
    onFav: async (g) => { await api.toggleFavorite(g.id); await library.refresh(); },
  };
  pagedList(wrap, list, (g) => libraryState.mode === 'grid' ? gameCard(g, cardOpts) : gameRow(g, cardOpts));
}

export async function playGame(game, nav) {
  if (!game.entryExists) {
    toast(`“${game.title}” is missing its entry file. Open Game Doctor for details.`, 'bad');
    nav.go(`game:${game.id}`);
    return;
  }
  try {
    await api.play(game.id);
  } catch (err) {
    toast(`Could not launch: ${err.message}`, 'bad');
  }
}

export function resetFilters() {
  Object.assign(libraryState, {
    query: '', genre: '', collectionId: '', favoritesOnly: false,
    singleFileOnly: false, offlineOnly: false,
  });
}

function syncSearchBox() {
  const box = document.getElementById('search');
  if (box) box.value = libraryState.query;
  const clr = document.getElementById('search-clear');
  if (clr) clr.hidden = !libraryState.query;
}

export function renderFilterbar(nav) {
  const bar = document.getElementById('filterbar');
  bar.hidden = false;
  bar.innerHTML = '';
  const st = libraryState;
  const rerender = () => renderLibrary(document.getElementById('view'), nav);

  const chip = (label, on, fn, title = '') =>
    el('button', { class: `chip${on ? ' on' : ''}`, title, onclick: () => { fn(); renderFilterbar(nav); rerender(); } }, label);

  bar.append(
    chip('★ Favorites', st.preset === 'favorites' || st.favoritesOnly, () => {
      if (st.preset === 'favorites') st.preset = 'all'; else st.favoritesOnly = !st.favoritesOnly;
    }),
    chip('📄 Single-file', st.singleFileOnly, () => { st.singleFileOnly = !st.singleFileOnly; }, 'Games that are one self-contained file'),
    chip('📴 Offline', st.offlineOnly, () => { st.offlineOnly = !st.offlineOnly; }, 'Hide games that need internet'),
  );

  const genres = allGenres(library.games);
  if (genres.length) {
    const sel = el('select', {
      class: 'chip', 'aria-label': 'Filter by genre',
      onchange: (e) => { st.genre = e.target.value; rerender(); },
    }, el('option', { value: '' }, 'All genres'));
    for (const g of genres) sel.append(el('option', { value: g, selected: st.genre === g ? 'selected' : null }, g));
    bar.append(sel);
  }

  bar.append(el('span', { class: 'filterbar-spacer' }));

  const sortSel = el('select', {
    'aria-label': 'Sort games',
    onchange: (e) => { st.sort = e.target.value; api.settingsSet({ defaultSort: st.sort }); rerender(); },
  });
  for (const s of SORTS) sortSel.append(el('option', { value: s.id, selected: st.sort === s.id ? 'selected' : null }, `Sort: ${s.label}`));
  bar.append(sortSel);

  const modeBtn = el('button', {
    class: 'chip', title: 'Toggle grid/list view',
    onclick: () => {
      st.mode = st.mode === 'grid' ? 'list' : 'grid';
      api.settingsSet({ libraryView: st.mode });
      renderFilterbar(nav); rerender();
    },
  }, st.mode === 'grid' ? '☰ List' : '▦ Grid');
  bar.append(modeBtn);
}

export function hideFilterbar() {
  const bar = document.getElementById('filterbar');
  bar.hidden = true;
  bar.innerHTML = '';
}
