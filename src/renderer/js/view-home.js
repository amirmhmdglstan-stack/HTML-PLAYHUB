/* view-home.js — Home: continue playing, recent, favorites, stats, discovery. */
import { el, formatDuration, timeAgo } from './util.js';
import { api, library } from './api.js';
import { gameCard, emptyState, toast } from './ui.js';
import { hideFilterbar, playGame } from './view-library.js';

let statsCache = null;

export async function renderHome(root, nav) {
  hideFilterbar();
  root.innerHTML = '';
  const games = library.games;

  if (!games.length) {
    root.append(el('div', { class: 'hero' },
      el('h1', { text: 'Welcome to HTML Playhub' }),
      el('p', { text: 'Your offline arcade. Import HTML games or grab some from Discover — then everything is one click away.' }),
      el('div', { class: 'hero-actions' },
        el('button', { class: 'btn primary lg', onclick: () => nav.go('import') }, '＋ Import your first game'),
        el('button', { class: 'btn ghost lg', onclick: () => nav.go('discover') }, '🧭 Browse Discover'))));
    root.append(howItWorks());
    return;
  }

  try { statsCache = await api.stats(); } catch { statsCache = null; }

  const recent = games.filter((g) => g.lastPlayedAt).sort((a, b) => (a.lastPlayedAt < b.lastPlayedAt ? 1 : -1)).slice(0, 6);
  const added = [...games].sort((a, b) => ((b.addedAt || '') < (a.addedAt || '') ? -1 : 1)).slice(0, 6);
  const favs = games.filter((g) => g.favorite).slice(0, 6);

  const heroGame = recent[0] || added[0];
  root.append(el('div', { class: 'hero' },
    el('h1', { text: greeting() }),
    el('p', { text: `${games.length} game(s) in your library${statsCache ? ` · ${statsCache.totalPlayText} played` : ''}. Pick up where you left off.` }),
    el('div', { class: 'hero-actions' },
      el('button', { class: 'btn primary lg', onclick: () => playGame(heroGame, nav) }, `▶ Play ${heroGame.title}`),
      el('button', { class: 'btn ghost lg', onclick: () => nav.go('library') }, 'Browse library'),
      el('button', { class: 'btn ghost lg', onclick: () => surprise(nav) }, '🎲 Surprise Me'))));

  if (statsCache) {
    root.append(el('div', { class: 'stat-strip' },
      stat(String(statsCache.totalGames), 'games'),
      stat(statsCache.totalPlayText, 'time played'),
      stat(String(statsCache.favorites), 'favorites'),
      stat(String(statsCache.sessions), 'sessions')));
  }

  const opts = {
    onOpen: (g) => nav.go(`game:${g.id}`),
    onPlay: (g) => playGame(g, nav),
    onFav: async (g) => { await api.toggleFavorite(g.id); await library.refresh(); },
  };

  if (recent.length) root.append(section('🕘 Continue Playing', recent, opts, nav, 'recent'));
  if (added.length) root.append(section('✨ Recently Added', added, opts, nav, 'library'));
  if (favs.length) root.append(section('★ Favorites', favs, opts, nav, 'favorites'));
  else {
    root.append(el('div', { class: 'section' },
      el('div', { class: 'section-title' }, el('h2', { text: '★ Favorites' })),
      el('p', { class: 'muted' }, 'Star games to pin them here.')));
  }

  // Genre spotlight
  const genres = [...new Set(games.flatMap((g) => g.genres || []))].slice(0, 8);
  if (genres.length > 1) {
    const chips = el('div', { class: 'toolbar-row' });
    for (const g of genres) {
      chips.append(el('button', { class: 'chip', onclick: () => nav.go(`genre:${g}`) }, g));
    }
    root.append(el('div', { class: 'section' },
      el('div', { class: 'section-title' }, el('h2', { text: 'Browse by genre' })),
      chips));
  }

  const broken = games.filter((g) => !g.entryExists);
  if (broken.length) {
    root.append(el('div', { class: 'warn-box' },
      `⚠ ${broken.length} game(s) have missing files. `,
      el('button', { class: 'link-btn', onclick: () => nav.go('broken') }, 'Review them →')));
  }
}

function greeting() {
  const h = new Date().getHours();
  if (h < 5) return 'Up late? Good — the arcade never closes.';
  if (h < 12) return 'Good morning, player.';
  if (h < 18) return 'Good afternoon, player.';
  return 'Good evening, player.';
}

function stat(value, label) {
  return el('div', { class: 'stat' }, el('b', { text: value }), el('span', { text: label }));
}

function section(title, games, opts, nav, target) {
  return el('div', { class: 'section' },
    el('div', { class: 'section-title' },
      el('h2', { text: title }),
      el('button', { class: 'link', onclick: () => nav.go(target) }, 'View all →')),
    el('div', { class: 'grid compact' }, ...games.map((g) => gameCard(g, opts))));
}

export async function surprise(nav) {
  const id = await api.randomGame({});
  if (!id) { toast('No games to choose from yet.', 'warn'); return; }
  const g = library.get(id);
  if (g) {
    toast(`🎲 ${g.title}`, '');
    nav.go(`game:${id}`);
  }
}

function howItWorks() {
  return el('div', { class: 'panel' },
    el('h3', { text: 'How it works' }),
    el('p', { class: 'muted' }, 'HTML Playhub keeps your web games organized and launches them in an isolated, offline-friendly player.'),
    el('div', { class: 'toolbar-row' },
      el('span', { class: 'badge' }, '1 · Import .html / .zip / folders'),
      el('span', { class: 'badge' }, '2 · Browse your library'),
      el('span', { class: 'badge' }, '3 · Press Play')));
}

export function renderGenre(root, nav, genre) {
  hideFilterbar();
  root.innerHTML = '';
  const games = library.games.filter((g) => (g.genres || []).includes(genre));
  root.append(el('button', { class: 'back-link', onclick: () => nav.back() }, '← Back'));
  const head = el('div', { class: 'view-head' }, el('h1', { text: genre }), el('span', { class: 'sub', text: `${games.length} game(s)` }));
  root.append(head);
  if (!games.length) {
    root.append(emptyState({ icon: '🗂', title: 'No games here', body: 'Nothing in this genre yet.', actions: [] }));
    return;
  }
  const opts = {
    onOpen: (g) => nav.go(`game:${g.id}`),
    onPlay: (g) => playGame(g, nav),
    onFav: async (g) => { await api.toggleFavorite(g.id); await library.refresh(); },
  };
  root.append(el('div', { class: 'grid' }, ...games.map((g) => gameCard(g, opts))));
}
