/* view-discover.js — Discover: installable catalog + external sources. */
import { el, formatBytes } from './util.js';
import { api, library } from './api.js';
import { toast, openModal, licenseBadge, emptyState, pagedList, gameCard } from './ui.js';
import { hideFilterbar, playGame } from './view-library.js';

let catalogCache = null;
let query = '';

export async function renderDiscover(root, nav) {
  hideFilterbar();
  root.innerHTML = '';
  root.append(el('div', { class: 'view-head' },
    el('h1', { text: 'Discover' }),
    el('span', { class: 'sub', text: 'Every game is a direct download from its original source — installed straight into your library.' })));

  const bar = el('div', { class: 'toolbar-row' });
  const search = el('input', { class: 'text-input', placeholder: 'Filter catalog…', style: 'max-width:320px', value: query });
  search.oninput = () => { query = search.value; renderLists(); };
  const btnRefresh = el('button', { class: 'btn sm', title: 'Fetch the newest catalog (needs internet)' }, '↻ Update catalog');
  btnRefresh.onclick = async () => {
    btnRefresh.disabled = true;
    try {
      catalogCache = await api.catalogRefresh();
      toast(`Catalog updated (${catalogCache.games.length} entries).`, 'good');
      renderLists();
    } catch (err) { toast(`Catalog update failed (offline?): ${err.message}`, 'warn'); }
    finally { btnRefresh.disabled = false; }
  };
  bar.append(search, btnRefresh, el('span', { class: 'muted small', id: 'catalog-meta' }));
  root.append(bar);
  const lists = el('div', { id: 'discover-lists' });
  root.append(lists);

  if (!catalogCache) {
    lists.append(el('p', { class: 'muted' }, 'Loading catalog…'));
    try { catalogCache = await api.catalog(); } catch { catalogCache = { games: [], sources: [] }; }
  }
  renderLists();

  function renderLists() {
    lists.innerHTML = '';
    const meta = document.getElementById('catalog-meta');
    const games = (catalogCache.games || []).filter((g) => {
      if (!query) return true;
      const hay = `${g.title} ${g.author} ${(g.genres || []).join(' ')} ${g.sourceCollection} ${g.description}`.toLowerCase();
      return query.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
    });
    if (meta) meta.textContent = `${games.length} of ${(catalogCache.games || []).length} · updated ${catalogCache.updatedAt || 'with app'} · ${catalogCache._origin === 'cache' ? 'remote' : 'shipped'} catalog`;

    const installedIds = new Set(library.games.map((g) => g.id));
    const installable = games.filter((g) => g.kind !== 'external' && !installedIds.has(g.id) && !installedIds.has(g.mapsTo));
    const external = games.filter((g) => g.kind === 'external');
    const done = games.filter((g) => installedIds.has(g.id) || installedIds.has(g.mapsTo));

    if (installable.length) {
      lists.append(el('div', { class: 'src-group' },
        el('div', { class: 'src-head' }, el('h2', { text: '⬇ Installable' }), el('p', { text: 'One click: the game file downloads and installs straight into your library. Nothing is preinstalled.' }))));
      const grid = el('div', { class: 'grid compact' });
      lists.append(grid);
      pagedList(grid, installable, (g) => catalogCard(g, nav, false));
    }
    if (external.length) {
      lists.append(el('div', { class: 'src-group' },
        el('div', { class: 'src-head' }, el('h2', { text: '🔗 External sources' }), el('p', { text: 'Visit the source in your browser, then import what you legally obtain.' }))));
      const grid = el('div', { class: 'grid compact' });
      lists.append(grid);
      pagedList(grid, external, (g) => catalogCard(g, nav, true));
    }
    if (done.length && !query) {
      lists.append(el('div', { class: 'src-group' },
        el('div', { class: 'src-head' }, el('h2', { text: '✔ Already in your library' }), el('p', { text: `${done.length} installed` }))));
    }
    if (!games.length) {
      lists.append(emptyState({ icon: '🧭', title: 'Nothing found', body: 'Try a different filter.', actions: [] }));
    }
  }
}

function catalogCard(g, nav, isExternal) {
  const card = el('div', { class: 'card', tabindex: '0', role: 'button', 'aria-label': g.title });
  const art = el('div', { class: 'card-art' });
  art.append(el('div', { class: 'fallback', style: `background:${fallbackGradient(g.id)}` }, el('span', { text: (g.title || '?').slice(0, 2).toUpperCase() })));
  const badges = el('div', { class: 'card-badges' });
  if (g.offline === false) badges.append(el('span', { class: 'badge yellow' }, 'Online'));
  else if (g.offline === true && !isExternal) badges.append(el('span', { class: 'badge green' }, 'Offline'));
  if (g.qualityTier) badges.append(el('span', { class: 'badge blue' }, `Tier ${g.qualityTier}`));
  art.append(badges);
  card.append(art, el('div', { class: 'card-body' },
    el('div', { class: 'card-title', title: g.title }, g.title),
    el('div', { class: 'card-meta' }, `${g.author || 'Unknown'}${g.sourceCollection ? ` · ${g.sourceCollection}` : ''}`),
    el('div', { class: 'card-foot' },
      licenseBadge(g.license),
      g.size ? el('span', { class: 'badge' }, formatBytes(g.size)) : null)));

  const open = () => catalogDetails(g, nav, isExternal);
  card.onclick = open;
  card.onkeydown = (e) => { if (e.key === 'Enter') open(); };
  return card;
}

function fallbackGradient(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const hues = [258, 210, 160, 24, 330, 180, 230, 0];
  const hue = hues[h % hues.length];
  return `linear-gradient(135deg, hsl(${hue},60%,32%), hsl(${(hue + 40) % 360},65%,48%))`;
}

function catalogDetails(g, nav, isExternal) {
  const installedId = library.get(g.id) ? g.id : (g.mapsTo && library.get(g.mapsTo) ? g.mapsTo : null);
  const body = el('div', {},
    el('p', { class: 'muted', text: `${g.author || 'Unknown'}${g.sourceCollection ? ` · ${g.sourceCollection}` : ''}` }),
    g.description ? el('p', { text: g.description }) : null,
    el('div', { class: 'toolbar-row' },
      licenseBadge(g.license),
      ...(g.genres || []).map((x) => el('span', { class: 'badge accent' }, x)),
      g.size ? el('span', { class: 'badge' }, formatBytes(g.size)) : null,
      g.offline === false ? el('span', { class: 'badge yellow' }, 'Needs internet') : g.offline === true ? el('span', { class: 'badge green' }, 'Offline capable') : el('span', { class: 'badge' }, 'Connectivity unknown')),
    g.whyExternal ? el('div', { class: 'warn-box' }, g.whyExternal) : null,
    g.licenseNote ? el('div', { class: 'warn-box' }, g.licenseNote) : null,
    g.homepage ? el('p', { class: 'small' }, el('span', { class: 'muted' }, 'Source: '), el('span', { class: 'mono' }, g.homepage)) : null,
    el('div', { class: 'progress', id: 'dl-progress', hidden: true }, el('i', { style: 'width:0%' })),
    el('p', { class: 'small muted', id: 'dl-label', hidden: true }));
  const footer = [];
  if (installedId) {
    footer.push(el('button', { class: 'btn primary', onclick: () => { close(); nav.go(`game:${installedId}`); } }, 'Open in library'));
  } else if (isExternal) {
    if (g.homepage) {
      footer.push(el('button', {
        class: 'btn primary', onclick: async () => {
          try { await api.openExternal(g.homepage); } catch (err) { toast(err.message, 'bad'); }
        },
      }, '↗ Visit source'));
    }
    footer.push(
      el('button', { class: 'btn', onclick: () => { close(); nav.go('import'); toast('Download the game from its source, then import the file here.', ''); } }, 'How to import'),
    );
  } else {
    const btnInstall = el('button', { class: 'btn primary' }, `⬇ Install${g.size ? ` (${formatBytes(g.size)})` : ''}`);
    btnInstall.onclick = async () => {
      btnInstall.disabled = true;
      const bar = body.querySelector('#dl-progress');
      const label = body.querySelector('#dl-label');
      bar.hidden = false; label.hidden = false;
      const off = api.on('playhub:download-progress', (p) => {
        if (p.id !== g.id) return;
        const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
        bar.firstChild.style.width = `${pct}%`;
        label.textContent = p.total ? `${formatBytes(p.received)} of ${formatBytes(p.total)}` : formatBytes(p.received);
      });
      try {
        const rec = await api.discoverInstall(g);
        await library.refresh();
        off();
        close();
        toast(`Installed ${rec.title}.`, 'good');
        nav.go(`game:${rec.id}`);
      } catch (err) {
        off();
        btnInstall.disabled = false;
        label.textContent = `Failed: ${err.message}`;
        toast(`Install failed: ${err.message}`, 'bad');
      }
    };
    footer.push(btnInstall);
  }
  const { close } = openModal({ title: g.title || 'Game', body, footer });
}
