/* view-collections.js — built-in + custom collections. */
import { el, collectionIcon, COLLECTION_ICONS } from './util.js';
import { api, library } from './api.js';
import { toast, openModal, confirmDialog, emptyState, gameCard } from './ui.js';
import { hideFilterbar, playGame } from './view-library.js';

export async function renderCollections(root, nav) {
  hideFilterbar();
  root.innerHTML = '';
  root.append(el('div', { class: 'view-head' },
    el('h1', { text: 'Collections' }),
    el('span', { class: 'sub', text: 'Group games your way. Source collections are automatic.' })));
  root.append(el('div', { class: 'toolbar-row' },
    el('button', { class: 'btn primary sm', onclick: () => createCollection(nav) }, '＋ New collection')));

  const cols = window.__collections || [];
  const customs = cols.filter((c) => !c.builtin);
  if (customs.length) {
    root.append(el('div', { class: 'section' },
      el('div', { class: 'section-title' }, el('h2', { text: 'Your collections' })),
      el('div', { class: 'col-grid' }, ...customs.map((c) => colCard(c, nav, true)))));
  } else {
    root.append(el('div', { class: 'panel' }, el('p', { class: 'muted' }, 'No custom collections yet. Create one, then add games from any game page.')));
  }

  // Automatic: source collections.
  const bySource = new Map();
  for (const g of library.games) {
    if (!g.sourceCollection) continue;
    if (!bySource.has(g.sourceCollection)) bySource.set(g.sourceCollection, []);
    bySource.get(g.sourceCollection).push(g);
  }
  if (bySource.size) {
    root.append(el('div', { class: 'section' },
      el('div', { class: 'section-title' }, el('h2', { text: 'Source collections (automatic)' })),
      el('div', { class: 'col-grid' }, ...[...bySource.entries()].map(([name, games]) =>
        el('button', { class: 'col-card', onclick: () => renderSourceCollection(root, nav, name, games) },
          el('div', { class: 'ico' }, '📦'), el('b', { text: name }), el('span', { text: `${games.length} game(s)` }))))));
  }
}

function colCard(c, nav, canEdit) {
  const n = (c.gameIds || []).length;
  const card = el('button', { class: 'col-card', onclick: () => nav.go(`collection:${c.id}`) },
    el('div', { class: 'ico' }, collectionIcon(c.icon)),
    el('b', { text: c.name }),
    el('span', { text: `${n} game(s)` }));
  return card;
}

function createCollection(nav) {
  const nameInput = el('input', { class: 'text-input', style: 'width:100%', placeholder: 'e.g. Couch co-op, Short gems, Kids' });
  const icons = el('div', { class: 'toolbar-row' });
  let icon = 'folder';
  const btns = [];
  for (const key of Object.keys(COLLECTION_ICONS)) {
    const b = el('button', { class: `icon-btn${key === icon ? ' on' : ''}`, title: key }, COLLECTION_ICONS[key]);
    b.onclick = () => { icon = key; btns.forEach((x) => x.classList.remove('on')); b.classList.add('on'); };
    btns.push(b);
    icons.append(b);
  }
  const { close } = openModal({
    title: 'New collection',
    body: el('div', {}, el('label', { class: 'field' }, 'Name', nameInput), el('div', { style: 'margin-top:10px' }, el('b', { class: 'small' }, 'Icon'), icons)),
    footer: [
      el('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn primary', onclick: async () => {
          const name = nameInput.value.trim();
          if (!name) { toast('Give the collection a name.', 'warn'); return; }
          await api.collectionCreate(name, icon);
          window.__collections = await api.collectionsList();
          close();
          nav.refresh();
          toast(`Collection “${name}” created.`, 'good');
        },
      }, 'Create'),
    ],
  });
}

export function renderCollectionDetail(root, nav, id) {
  hideFilterbar();
  const c = (window.__collections || []).find((x) => x.id === id);
  root.innerHTML = '';
  if (!c) {
    root.append(emptyState({ icon: '🗂', title: 'Collection not found', body: '', actions: [el('button', { class: 'btn', onclick: () => nav.go('collections') }, 'Back')] }));
    return;
  }
  root.append(el('button', { class: 'back-link', onclick: () => nav.back() }, '← Back'));
  root.append(el('div', { class: 'view-head' },
    el('h1', { text: `${collectionIcon(c.icon)} ${c.name}` }),
    el('span', { class: 'sub', text: `${(c.gameIds || []).length} game(s)` })));
  if (!c.builtin) {
    root.append(el('div', { class: 'toolbar-row' },
      el('button', { class: 'btn sm', onclick: () => renameCollection(c, nav) }, '✎ Rename'),
      el('button', { class: 'btn sm', onclick: () => editCollectionGames(c, nav) }, '🎮 Add / remove games'),
      el('button', {
        class: 'btn sm danger', onclick: async () => {
          if (await confirmDialog({ title: `Delete “${c.name}”?`, message: 'The collection is deleted; games stay in your library.', confirmText: 'Delete', danger: true })) {
            await api.collectionDelete(c.id);
            window.__collections = await api.collectionsList();
            nav.go('collections');
          }
        },
      }, 'Delete collection')));
  }
  const games = (c.gameIds || []).map((gid) => library.get(gid)).filter(Boolean);
  if (!games.length) {
    root.append(emptyState({ icon: '📭', title: 'Empty collection', body: c.builtin ? '' : 'Add games with “Add / remove games”, or from any game page.', actions: [] }));
    return;
  }
  const opts = {
    onOpen: (g) => nav.go(`game:${g.id}`),
    onPlay: (g) => playGame(g, nav),
    onFav: async (g) => { await api.toggleFavorite(g.id); await library.refresh(); },
  };
  root.append(el('div', { class: 'grid' }, ...games.map((g) => gameCard(g, opts))));
}

function renameCollection(c, nav) {
  const input = el('input', { class: 'text-input', style: 'width:100%', value: c.name });
  const { close } = openModal({
    title: 'Rename collection',
    body: input,
    footer: [
      el('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn primary', onclick: async () => {
          const name = input.value.trim();
          if (!name) return;
          await api.collectionUpdate(c.id, { name });
          window.__collections = await api.collectionsList();
          close(); nav.refresh();
        },
      }, 'Save'),
    ],
  });
}

function editCollectionGames(c, nav) {
  const q = el('input', { class: 'text-input', style: 'width:100%;margin-bottom:10px', placeholder: 'Filter games…' });
  const list = el('div', { style: 'max-height:320px;overflow-y:auto;display:flex;flex-direction:column;gap:4px' });
  const selected = new Set(c.gameIds || []);
  const render = () => {
    list.innerHTML = '';
    const query = q.value.toLowerCase();
    for (const g of library.games) {
      if (query && !`${g.title} ${g.author}`.toLowerCase().includes(query)) continue;
      const label = el('label', { class: 'check-row' });
      const box = el('input', { type: 'checkbox', checked: selected.has(g.id) ? 'checked' : null });
      box.onchange = () => { if (box.checked) selected.add(g.id); else selected.delete(g.id); };
      label.append(box, g.title);
      list.append(label);
    }
  };
  q.oninput = render;
  render();
  const { close } = openModal({
    title: `Games in “${c.name}”`, wide: true,
    body: el('div', {}, q, list),
    footer: [
      el('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn primary', onclick: async () => {
          await api.collectionSetGames(c.id, [...selected]);
          window.__collections = await api.collectionsList();
          close(); nav.refresh();
          toast('Collection updated.', 'good');
        },
      }, 'Save'),
    ],
  });
}

export function renderSourceCollection(root, nav, name, games) {
  hideFilterbar();
  root.innerHTML = '';
  root.append(el('button', { class: 'back-link', onclick: () => nav.back() }, '← Back'));
  root.append(el('div', { class: 'view-head' }, el('h1', { text: `📦 ${name}` }), el('span', { class: 'sub', text: `${games.length} game(s)` })));
  const opts = {
    onOpen: (g) => nav.go(`game:${g.id}`),
    onPlay: (g) => playGame(g, nav),
    onFav: async (g) => { await api.toggleFavorite(g.id); await library.refresh(); },
  };
  root.append(el('div', { class: 'grid' }, ...games.map((g) => gameCard(g, opts))));
}
