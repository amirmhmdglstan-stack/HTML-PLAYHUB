/* view-details.js — game details: overview, screenshots, saves, doctor, files, settings. */
import { el, formatBytes, formatDuration, formatDate, timeAgo, gradientFor, initialsFor, genreIcon } from './util.js';
import { api, library } from './api.js';
import { artBox, licenseBadge, toast, openModal, confirmDialog, withBusy, emptyState } from './ui.js';
import { hideFilterbar, playGame } from './view-library.js';

export async function renderDetails(root, nav, gameId) {
  hideFilterbar();
  let game = library.get(gameId);
  if (!game) {
    try { game = await api.gameGet(gameId); } catch { game = null; }
  }
  if (!game) {
    root.innerHTML = '';
    root.append(emptyState({ icon: '👻', title: 'Game not found', body: 'It may have been removed.', actions: [el('button', { class: 'btn', onclick: () => nav.go('library') }, 'Back to library')] }));
    return;
  }
  root.innerHTML = '';
  root.append(el('button', { class: 'back-link', onclick: () => nav.back() }, '← Back to library'));

  const hero = el('div', { class: 'detail-hero' });
  const art = artBox(game, 'detail-art');
  const info = el('div', { class: 'detail-info' });
  info.append(
    el('h1', { text: game.title }),
    el('div', { class: 'detail-sub' }, `${game.author || 'Unknown'} · v${game.version || '1.0'}${game.sourceCollection ? ` · from ${game.sourceCollection}` : ''}`),
    metaBadges(game),
    game.description ? el('p', { class: 'detail-desc', text: game.description }) : el('p', { class: 'detail-desc muted' }, 'No description yet — add one with Edit.'),
  );
  const actions = el('div', { class: 'detail-actions' });
  const btnPlay = el('button', { class: 'btn primary lg', onclick: () => playGame(game, nav) }, game.entryExists ? '▶ Play' : '⚠ Broken — details below');
  const btnFav = el('button', { class: 'btn', onclick: async () => { await api.toggleFavorite(game.id); await library.refresh(); } }, game.favorite ? '★ Favorited' : '☆ Favorite');
  actions.append(btnPlay, btnFav,
    el('button', { class: 'btn', onclick: () => editMetadata(game, nav) }, '✎ Edit'),
    el('button', { class: 'btn', onclick: (e) => withBusy(e.target, () => doBackup(game)) }, '💾 Backup'),
    el('button', { class: 'btn danger', onclick: () => doRemove(game, nav) }, '🗑 Remove'));
  info.append(actions);
  info.append(el('div', { class: 'kv' },
    kv('Playtime', game.playCount > 0 ? `${formatDuration(game.playTimeSeconds)} · ${game.playCount} session(s)` : 'Not played yet'),
    kv('Last played', game.lastPlayedAt ? timeAgo(game.lastPlayedAt) : 'Never'),
    kv('Size', `${formatBytes(game.sizeBytes)} · ${game.fileCount} file(s)`),
    kv('Added', formatDate(game.addedAt)),
    kv('Entry file', game.entryFile, true),
    kv('License', game.license || 'Unknown'),
  ));
  hero.append(art, info);
  root.append(hero);

  if (!game.entryExists) {
    root.append(el('div', { class: 'err-box' },
      `This game is broken: entry file “${game.entryFile}” is missing. `,
      el('button', { class: 'link-btn', onclick: () => tabDoctor(body, game) }, 'Run Game Doctor →')));
  }
  if (game.updateAvailable) {
    root.append(el('div', { class: 'note-box' },
      `A newer bundled version is available. Your saves and stats are preserved on update. `,
      el('button', { class: 'link-btn', onclick: () => toast('Bundle updates arrive with Playhub updates.', '') }, 'How updates work')));
  }

  const tabs = el('div', { class: 'tabs' });
  const body = el('div', {});
  root.append(tabs, body);
  const defs = [
    ['overview', 'Overview', () => tabOverview(body, game, nav)],
    ['shots', 'Screenshots', () => tabShots(body, game)],
    ['saves', 'Saves & Backups', () => tabSaves(body, game, nav)],
    ['doctor', 'Game Doctor', () => tabDoctor(body, game)],
    ['files', 'Files', () => tabFiles(body, game)],
    ['launch', 'Launch Settings', () => tabLaunch(body, game, nav)],
  ];
  if (window.__devMode) defs.push(['dev', 'Developer', () => tabDev(body, game)]);
  for (const [id, label, fn] of defs) {
    tabs.append(el('button', {
      class: `tab${id === 'overview' ? ' on' : ''}`,
      onclick: (e) => { tabs.querySelectorAll('.tab').forEach((t) => t.classList.remove('on')); e.target.classList.add('on'); fn(); },
    }, label));
  }
  tabOverview(body, game, nav);
}

function kv(label, value, mono = false) {
  return el('div', {}, el('b', { text: label }), el('span', { class: mono ? 'mono' : '' }, String(value)));
}

function metaBadges(game) {
  const row = el('div', { class: 'toolbar-row' });
  for (const g of game.genres || []) row.append(el('span', { class: 'badge accent' }, `${genreIcon(g)} ${g}`));
  row.append(licenseBadge(game.license));
  if (game.singleFile) row.append(el('span', { class: 'badge' }, 'Single-file'));
  if (!(game.network && game.network.required)) row.append(el('span', { class: 'badge green' }, 'Offline'));
  else row.append(el('span', { class: 'badge yellow' }, 'Needs internet'));
  if (game.language && game.language !== 'en') row.append(el('span', { class: 'badge' }, `🌐 ${game.language}`));
  if (game.qualityTier) row.append(el('span', { class: 'badge blue', title: 'Curator quality tier from the source collection' }, `Tier ${game.qualityTier}`));
  return row;
}

async function tabOverview(body, game, nav) {
  body.innerHTML = '';
  const g = library.get(game.id) || game;

  // Tags + notes
  const tagsPanel = el('div', { class: 'panel' }, el('h3', { text: 'Your tags & notes' }));
  const tagRow = el('div', {});
  const renderTags = () => {
    tagRow.innerHTML = '';
    for (const t of g.customTags || []) {
      tagRow.append(el('span', { class: 'tag' }, t, el('button', {
        title: 'Remove tag', onclick: async () => {
          await api.updateGame(g.id, { customTags: (g.customTags || []).filter((x) => x !== t) });
          await library.refresh(); tabOverview(body, library.get(g.id), nav);
        },
      }, '✕')));
    }
    if (!(g.customTags || []).length) tagRow.append(el('span', { class: 'muted small' }, 'No tags yet.'));
  };
  renderTags();
  const tagInput = el('input', { class: 'text-input', placeholder: 'Add a tag…', style: 'width:200px' });
  tagInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && tagInput.value.trim()) {
      const tags = [...new Set([...(g.customTags || []), tagInput.value.trim().slice(0, 30)])];
      await api.updateGame(g.id, { customTags: tags });
      await library.refresh(); tabOverview(body, library.get(g.id), nav);
    }
  });
  const notes = el('textarea', { rows: '3', style: 'width:100%;margin-top:8px', placeholder: 'Personal notes about this game…' }, g.notes || '');
  const saveNotes = el('button', { class: 'btn sm', style: 'margin-top:8px' }, 'Save notes');
  saveNotes.onclick = async () => { await api.updateGame(g.id, { notes: notes.value.slice(0, 4000) }); await library.refresh(); toast('Notes saved.', 'good'); };
  tagsPanel.append(tagRow, el('div', { style: 'margin-top:8px' }, tagInput), notes, saveNotes);
  body.append(tagsPanel);

  // Collections membership
  const cols = (window.__collections || []).filter((c) => !c.builtin);
  if (cols.length) {
    const cp = el('div', { class: 'panel' }, el('h3', { text: 'Collections' }));
    for (const c of cols) {
      const has = (c.gameIds || []).includes(g.id);
      const label = el('label', { class: 'check-row' });
      const box = el('input', { type: 'checkbox', checked: has ? 'checked' : null });
      box.onchange = async () => {
        const ids = new Set(c.gameIds || []);
        if (box.checked) ids.add(g.id); else ids.delete(g.id);
        await api.collectionSetGames(c.id, [...ids]);
        window.__collections = await api.collectionsList();
        toast(box.checked ? `Added to ${c.name}.` : `Removed from ${c.name}.`, 'good');
      };
      label.append(box, `${c.name}`);
      cp.append(label);
    }
    body.append(cp);
  }

  // Controls summary
  const c = g.controls || {};
  const cp2 = el('div', { class: 'panel' }, el('h3', { text: 'Controls & compatibility' }));
  const bits = [];
  if (c.keyboard) bits.push('⌨ Keyboard');
  if (c.mouse) bits.push('🖱 Mouse');
  if (c.touch) bits.push('👆 Touch');
  if (c.gamepad) bits.push('🎮 Gamepad API');
  cp2.append(el('p', {}, bits.length ? bits.join('  ·  ') : 'No input signals detected.'));
  if (c.notes) cp2.append(el('p', { class: 'muted' }, c.notes));
  cp2.append(el('p', { class: 'small muted' }, 'Virtual buttons, joystick and touchpad overlays are available in the player (press F9 or use the toolbar). Real gamepads pass straight through to the game.'));
  body.append(cp2);

  // Source / legal
  const src = g.source || {};
  const lic = g.licenseDetail || {};
  body.append(el('div', { class: 'panel' }, el('h3', { text: 'Source & license' }),
    el('div', { class: 'kv' },
      kv('Author', g.author || 'Unknown'),
      kv('License', g.license || 'Unknown'),
      kv('Origin', g.origin || 'import'),
      kv('Source collection', g.sourceCollection || '—')),
    src.repo ? el('p', {}, el('button', { class: 'link-btn', onclick: async () => { try { await api.openExternal(src.repo); } catch (err) { toast(err.message, 'bad'); } } }, src.repo)) : null,
    src.homepage && src.homepage !== src.repo ? el('p', {}, el('button', { class: 'link-btn', onclick: async () => { try { await api.openExternal(src.homepage); } catch (err) { toast(err.message, 'bad'); } } }, src.homepage)) : null,
    lic.url ? el('p', { class: 'small' }, el('span', { class: 'muted' }, 'License URL: '), el('span', { class: 'mono' }, lic.url)) : null,
    el('p', { class: 'small muted' }, 'Keep this information intact when you share or export the game. “Unknown” license means: do not redistribute — personal use only.')));
}

async function tabShots(body, game) {
  body.innerHTML = '';
  let shots = [];
  try { shots = await api.shotsList(game.id); } catch { shots = []; }
  if (!shots.length) {
    body.append(emptyState({ icon: '📸', title: 'No screenshots yet', body: 'Capture screenshots from the player toolbar (or press F12) while playing.', actions: [el('button', { class: 'btn primary', onclick: () => playGame(game, { go: () => {} }) }, '▶ Play now')] }));
    return;
  }
  const grid = el('div', { class: 'shots' });
  body.append(el('p', { class: 'muted small' }, `${shots.length} screenshot(s), stored locally only.`), grid);
  for (const s of shots) {
    const btn = el('button', { class: 'shot', title: `${s.name} — click to view` });
    try {
      const r = await api.shotGet(game.id, s.name);
      if (r && r.dataUrl) btn.append(el('img', { src: r.dataUrl, alt: s.name, loading: 'lazy' }));
    } catch { /* keep empty */ }
    btn.onclick = () => viewShot(game, s);
    grid.append(btn);
  }
}

async function viewShot(game, s) {
  const body = el('div', { text: 'Loading…' });
  openModal({ title: s.name, wide: true, body, footer: [
    el('button', { class: 'btn danger sm', onclick: async () => { await api.shotDelete(game.id, s.name); document.querySelector('.modal-veil')?.remove(); toast('Screenshot deleted.'); } }, 'Delete'),
  ] });
  try {
    const r = await api.shotGet(game.id, s.name);
    body.innerHTML = '';
    if (r && r.dataUrl) body.append(el('img', { src: r.dataUrl, style: 'width:100%;border-radius:8px', alt: s.name }));
    else body.textContent = 'Could not load image.';
  } catch { body.textContent = 'Could not load image.'; }
}

async function tabSaves(body, game, nav) {
  body.innerHTML = '';
  let info = { exists: false, size: 0 };
  try { info = await api.savesInfo(game.id); } catch { /* ignore */ }
  const p = el('div', { class: 'panel' }, el('h3', { text: 'Save data' }));
  if (!info.exists) {
    p.append(el('p', { class: 'muted' }, 'No save data stored yet. Play the game and its saves (localStorage, IndexedDB, cookies) are kept isolated per game.'));
  } else {
    p.append(el('p', {}, `Stored saves: `, el('b', { text: `${formatBytes(info.size)} in ${info.files} file(s)` }), el('br'), el('span', { class: 'small muted' }, 'Saves are never uploaded anywhere.')));
    p.append(el('div', { class: 'toolbar-row' },
      el('button', {
        class: 'btn danger sm', onclick: async () => {
          if (await confirmDialog({ title: 'Clear save data?', message: `Delete all saves for “${game.title}”? This cannot be undone.`, confirmText: 'Delete saves', danger: true })) {
            try { await api.savesClear(game.id); toast('Save data cleared.', 'good'); tabSaves(body, game, nav); }
            catch (err) { toast(err.message, 'bad'); }
          }
        },
      }, 'Clear save data')));
  }
  p.append(el('p', { class: 'small muted' }, 'Tip: “Backup” includes a snapshot of saves (game must be closed). Backups never touch your live saves.'));
  body.append(p);

  const bp = el('div', { class: 'panel' }, el('h3', { text: 'Backups' }));
  bp.append(el('div', { class: 'toolbar-row' },
    el('button', { class: 'btn sm primary', onclick: (e) => withBusy(e.target, () => doBackup(game).then(() => tabSaves(body, game, nav))) }, '💾 Back up now'),
    el('button', { class: 'btn sm', onclick: () => api.backupOpenFolder() }, 'Open backup folder')));
  let all = [];
  try { all = (await api.backupList()).filter((b) => b.name.startsWith(game.id + '-')); } catch { all = []; }
  if (!all.length) bp.append(el('p', { class: 'muted small' }, 'No backups of this game yet.'));
  for (const b of all) {
    bp.append(el('div', { class: 'toolbar-row', style: 'justify-content:space-between' },
      el('span', { class: 'mono small' }, `${b.name} · ${formatBytes(b.size)}`),
      el('span', {},
        el('button', {
          class: 'btn sm', style: 'margin-right:6px', onclick: async () => {
            if (await confirmDialog({ title: 'Restore backup?', message: `Restore “${game.title}” from ${b.name}? Current files will be replaced (saves are snapshotted first).`, confirmText: 'Restore' })) {
              try { await api.backupRestore(b.name, { allowOverwrite: true }); await library.refresh(); toast('Backup restored.', 'good'); nav.go(`game:${game.id}`); }
              catch (err) { toast(err.message, 'bad'); }
            }
          },
        }, 'Restore'),
        el('button', {
          class: 'btn sm danger', onclick: async () => {
            if (await confirmDialog({ title: 'Delete backup?', message: b.name, confirmText: 'Delete', danger: true })) {
              await api.backupDelete(b.name); tabSaves(body, game, nav);
            }
          },
        }, 'Delete'))));
  }
  body.append(bp);
}

async function tabDoctor(body, game) {
  body.innerHTML = '';
  const wrap = el('div', { text: 'Analyzing…' });
  body.append(wrap);
  let result;
  try { result = await api.diagnose(game.id); }
  catch (err) { wrap.textContent = `Diagnosis failed: ${err.message}`; return; }
  wrap.innerHTML = '';
  const badge = result.summary === 'ok' ? el('span', { class: 'badge green' }, '✓ Healthy')
    : result.summary === 'warn' ? el('span', { class: 'badge yellow' }, '⚠ Warnings') : el('span', { class: 'badge red' }, '✕ Problems');
  wrap.append(el('div', { class: 'toolbar-row' }, badge,
    el('button', { class: 'btn sm', onclick: () => tabDoctor(body, game) }, '↻ Re-run')));
  const table = el('table', { class: 'check-table' });
  for (const c of result.checks) {
    table.append(el('tr', {},
      el('td', { style: 'width:170px' }, el('span', { class: `dot ${c.status}` }), el('b', { text: c.name })),
      el('td', { text: c.detail || '' })));
  }
  wrap.append(el('div', { class: 'panel' }, table));
  const a = result.analysis;
  if (a && a.warnings && a.warnings.length) {
    const wp = el('div', { class: 'panel' }, el('h3', { text: 'Warnings' }));
    for (const w of a.warnings) wp.append(el('p', { class: 'small' }, `⚠ ${w.message}`));
    wrap.append(wp);
  }
  if (a && a.externalHosts && a.externalHosts.length) {
    wrap.append(el('div', { class: 'panel' }, el('h3', { text: 'External hosts' }),
      el('p', { class: 'small mono' }, a.externalHosts.join(', ')),
      el('p', { class: 'small muted' }, 'Enable “Offline Sandbox” in Launch Settings to block these (the game may fail if it truly needs them).')));
  }
}

async function tabFiles(body, game) {
  body.innerHTML = '';
  let files = [];
  try { files = await api.filesList(game.id); } catch (err) { body.append(el('p', { text: `Could not list files: ${err.message}` })); return; }
  body.append(el('div', { class: 'toolbar-row' },
    el('span', { class: 'muted small', text: `${files.length} file(s)` }),
    el('button', { class: 'btn sm', onclick: () => api.openFolder(game.id) }, '📁 Open in Explorer')));
  const list = el('div', { class: 'panel file-list' });
  for (const f of files) list.append(el('div', {}, el('span', { text: f.relative }), el('span', { text: formatBytes(f.size) })));
  body.append(list);
}

async function tabLaunch(body, game, nav) {
  body.innerHTML = '';
  const g = library.get(game.id) || game;
  const p = el('div', { class: 'panel' }, el('h3', { text: 'Per-game launch settings' }));

  const netLabel = el('label', { class: 'check-row' });
  const netBox = el('input', { type: 'checkbox', checked: g.blockNetwork ? 'checked' : null });
  netLabel.append(netBox, el('span', {}, 'Offline Sandbox — block all internet requests from this game'));
  netBox.onchange = async () => {
    await api.updateGame(g.id, { blockNetwork: netBox.checked });
    await library.refresh();
    toast(netBox.checked ? 'Network blocked for this game.' : 'Network allowed for this game.', 'good');
  };
  p.append(netLabel, el('p', { class: 'small muted' }, 'Useful for games with trackers, or to prove a game is truly offline. Games that load libraries from a CDN will break with this on.'));

  const zoomRow = el('div', { style: 'margin-top:12px' }, el('b', { class: 'small' }, 'Default zoom'));
  const zoomSel = el('select', { 'aria-label': 'Default zoom' });
  for (const z of [50, 75, 100, 125, 150, 175, 200]) {
    zoomSel.append(el('option', { value: String(z), selected: (g.zoom || 100) === z ? 'selected' : null }, `${z}%`));
  }
  zoomSel.onchange = async () => { await api.updateGame(g.id, { zoom: Number(zoomSel.value) }); await library.refresh(); };
  zoomRow.append(' ', zoomSel);
  p.append(zoomRow);

  const frameRow = el('div', { style: 'margin-top:12px' }, el('b', { class: 'small' }, 'Aspect frame'));
  const frameSel = el('select', { 'aria-label': 'Aspect frame' });
  for (const [v, l] of [['none', 'None (fill window)'], ['16:9', '16:9'], ['4:3', '4:3'], ['1:1', '1:1'], ['9:16', '9:16 portrait']]) {
    frameSel.append(el('option', { value: v, selected: (g.frame || 'none') === v ? 'selected' : null }, l));
  }
  frameSel.onchange = async () => { await api.updateGame(g.id, { frame: frameSel.value }); await library.refresh(); };
  frameRow.append(' ', frameSel);
  p.append(frameRow, el('p', { class: 'small muted' }, 'Letterboxes the game into a fixed aspect ratio — handy for tiny or portrait games.'));
  body.append(p);

  const danger = el('div', { class: 'panel' }, el('h3', { text: 'Danger zone' }));
  danger.append(el('div', { class: 'toolbar-row' },
    el('button', {
      class: 'btn sm', onclick: async () => {
        try { const r = await api.refreshGame(g.id); await library.refresh(); toast(`Refreshed: ${formatBytes(r.sizeBytes)}`, 'good'); nav.go(`game:${g.id}`); }
        catch (err) { toast(err.message, 'bad'); }
      },
    }, '↻ Rescan files'),
    el('button', {
      class: 'btn sm', onclick: async () => {
        try { await api.repairManifest(g.id); await library.refresh(); toast('Manifest regenerated.', 'good'); nav.go(`game:${g.id}`); }
        catch (err) { toast(err.message, 'bad'); }
      },
    }, '🔧 Regenerate manifest'),
    el('button', {
      class: 'btn sm', onclick: async () => {
        const p2 = await api.exportZip(g.id);
        if (p2) toast(`Exported to ${p2}`, 'good');
      },
    }, '📦 Export as ZIP')));
  body.append(danger);
}

async function tabDev(body, game) {
  body.innerHTML = '';
  const dir = el('div', { class: 'panel' }, el('h3', { text: 'Developer — record + manifest' }));
  try {
    const full = await api.gameGet(game.id);
    dir.append(el('pre', { class: 'code', text: JSON.stringify(full, null, 2) }));
  } catch (err) { dir.append(el('p', { text: err.message })); }
  body.append(dir);
  try {
    const info = await api.appInfo();
    body.append(el('div', { class: 'panel' }, el('h3', { text: 'Environment' }),
      el('pre', { class: 'code', text: JSON.stringify(info, null, 2) })));
  } catch { /* ignore */ }
}

async function doBackup(game) {
  try {
    const r = await api.backupCreate(game.id, true);
    toast(`Backup saved (${formatBytes(r.size)}${r.savesIncluded ? ', saves included' : ''}).`, 'good');
  } catch (err) {
    toast(`Backup failed: ${err.message}`, 'bad');
  }
}

async function doRemove(game, nav) {
  const settings = window.__settings || {};
  let confirmed = true;
  if (settings.confirmBeforeRemove !== false) {
    confirmed = await confirmDialog({
      title: `Remove “${game.title}”?`,
      message: 'Game files will be deleted. Saves are kept unless you clear them. This cannot be undone (make a backup first if unsure).',
      confirmText: 'Remove game', danger: true,
    });
  }
  if (!confirmed) return;
  try {
    await api.removeGame(game.id);
    await library.refresh();
    toast(`Removed ${game.title}.`, '');
    nav.go('library');
  } catch (err) {
    toast(err.message, 'bad');
  }
}

function editMetadata(game, nav) {
  const g = library.get(game.id) || game;
  const fTitle = el('input', { class: 'text-input', value: g.title });
  const fAuthor = el('input', { class: 'text-input', value: g.author || '' });
  const fDesc = el('textarea', { rows: '4', style: 'width:100%' }, g.description || '');
  const fGenres = el('input', { class: 'text-input', value: (g.genres || []).join(', ') });
  const fEntry = el('input', { class: 'text-input mono', value: g.entryFile });
  const body = el('div', { class: 'form-grid' },
    el('label', { class: 'field' }, 'Title', fTitle),
    el('label', { class: 'field' }, 'Author', fAuthor),
    el('label', { class: 'field full' }, 'Description', fDesc),
    el('label', { class: 'field' }, 'Genres (comma separated)', fGenres),
    el('label', { class: 'field' }, 'Entry file (relative path)', fEntry));
  const { close } = openModal({
    title: 'Edit metadata',
    body,
    footer: [
      el('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn primary', onclick: async () => {
          try {
            await api.updateGame(g.id, {
              title: fTitle.value.trim() || g.title,
              author: fAuthor.value.trim(),
              description: fDesc.value.slice(0, 4000),
              genres: fGenres.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5),
              entryFile: fEntry.value.trim() || g.entryFile,
            });
            await library.refresh();
            close();
            nav.go(`game:${g.id}`);
            toast('Metadata saved.', 'good');
          } catch (err) { toast(err.message, 'bad'); }
        },
      }, 'Save'),
    ],
  });
}
