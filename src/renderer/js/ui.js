/* ui.js — shared components: cards, modals, toasts, badges, art. */
import { el, gradientFor, initialsFor, formatDuration, timeAgo, formatBytes } from './util.js';
import { api, library } from './api.js';

export function toast(message, kind = '') {
  const root = document.getElementById('toast-root');
  const icons = { good: '✔', bad: '✕', warn: '⚠', '': 'ℹ' };
  const t = el('div', { class: `toast ${kind}`, role: 'status' },
    el('span', { text: icons[kind] ?? 'ℹ' }),
    el('span', { text: message }));
  root.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, 4200);
}

export function openModal({ title, body, footer = null, wide = false, onClose = null }) {
  const root = document.getElementById('modal-root');
  const veil = el('div', { class: 'modal-veil' });
  const modal = el('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-label': title });
  const head = el('div', { class: 'modal-head' }, el('h2', { text: title }),
    el('button', { class: 'icon-btn sm', title: 'Close (Esc)', 'aria-label': 'Close', onclick: () => close() }, '✕'));
  const bodyEl = el('div', { class: 'modal-body' }, body);
  modal.append(head, bodyEl);
  if (footer) modal.append(el('div', { class: 'modal-foot' }, ...footer));
  veil.append(modal);
  root.append(veil);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  function close() {
    document.removeEventListener('keydown', onKey);
    veil.remove();
    if (onClose) { try { onClose(); } catch { /* ignore */ } }
  }
  const first = modal.querySelector('input, select, textarea, button:not(.icon-btn)');
  if (first) setTimeout(() => { try { first.focus(); } catch { /* ignore */ } }, 50);
  return { close, body: bodyEl, modal };
}

export function confirmDialog({ title = 'Are you sure?', message = '', confirmText = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const { close } = openModal({
      title,
      body: el('p', { text: message }),
      footer: [
        el('button', { class: 'btn ghost', onclick: () => { close(); resolve(false); } }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, onclick: () => { close(); resolve(true); } }, confirmText),
      ],
      onClose: () => resolve(false),
    });
  });
}

/** Art container: real thumbnail when available, generated gradient otherwise. Never broken. */
export function artBox(game, cls = 'card-art') {
  const box = el('div', { class: cls });
  const fb = el('div', { class: 'fallback', style: `background:${gradientFor(game.id)}` },
    el('span', { text: initialsFor(game.title) }));
  box.append(fb);
  library.thumb(game.id).then((url) => {
    if (!url) return;
    const img = el('img', { src: url, alt: '', loading: 'lazy' });
    img.onerror = () => img.remove();
    box.append(img);
  });
  return box;
}

export function licenseBadge(license) {
  const l = String(license || 'Unknown');
  const cls = /MIT|Apache|BSD|ISC|CC0|Unlicense|Public/i.test(l) ? 'green'
    : /GPL|AGPL|LGPL|MPL|CC-BY/i.test(l) ? 'blue'
    : l === 'Unknown' ? 'yellow' : '';
  return el('span', { class: `badge ${cls}`, title: `License: ${l}` }, l.length > 14 ? l.slice(0, 13) + '…' : l);
}

export function gameCard(game, { onOpen, onPlay, onFav, compact = false } = {}) {
  const card = el('div', {
    class: 'card', tabindex: '0', role: 'button',
    'aria-label': `${game.title}. Press Enter to open.`,
    onclick: (e) => { if (!e.target.closest('button')) onOpen(game); },
    onkeydown: (e) => {
      if (e.key === 'Enter') onOpen(game);
      else if (e.key === ' ' && e.target === card) { e.preventDefault(); onPlay(game); }
    },
  });
  const art = artBox(game);
  const fav = el('button', {
    class: `card-fav${game.favorite ? '' : ' dim'}`,
    title: game.favorite ? 'Remove from favorites' : 'Add to favorites',
    'aria-label': 'Toggle favorite',
    onclick: (e) => { e.stopPropagation(); onFav(game); },
  }, game.favorite ? '★' : '☆');
  const badges = el('div', { class: 'card-badges' });
  if (!game.entryExists) badges.append(el('span', { class: 'badge red', title: 'Entry file is missing' }, 'Broken'));
  else if (game.network && game.network.required) badges.append(el('span', { class: 'badge yellow', title: 'Needs internet (external resources)' }, 'Online'));
  else badges.append(el('span', { class: 'badge green', title: 'Fully offline capable' }, 'Offline'));
  if (game.updateAvailable) badges.append(el('span', { class: 'badge blue' }, 'Update'));
  const play = el('button', { class: 'card-play', 'aria-label': `Play ${game.title}`, onclick: (e) => { e.stopPropagation(); onPlay(game); } },
    el('i', {}, '▶ Play'));
  art.append(badges, fav, play);
  const genre = (game.genres && game.genres[0]) || (game.sourceCollection ? 'Collection' : 'Game');
  card.append(art, el('div', { class: 'card-body' },
    el('div', { class: 'card-title', title: game.title }, game.title),
    el('div', { class: 'card-meta' }, `${genre} · ${game.author || 'Unknown'}`),
    compact ? null : el('div', { class: 'card-foot' },
      licenseBadge(game.license),
      game.playCount > 0 ? el('span', { class: 'badge', title: `Played ${game.playCount} time(s), last ${timeAgo(game.lastPlayedAt)}` }, formatDuration(game.playTimeSeconds)) : null,
      game.language && game.language !== 'en' ? el('span', { class: 'badge', title: 'Game language' }, game.language) : null,
    )));
  return card;
}

export function gameRow(game, { onOpen, onPlay, onFav } = {}) {
  const row = el('button', { class: 'row', onclick: () => onOpen(game) });
  const art = el('div', { class: 'row-art' });
  art.append(el('div', { class: 'fallback', style: `background:${gradientFor(game.id)}`, text: initialsFor(game.title) }));
  library.thumb(game.id).then((url) => {
    if (!url) return;
    const img = el('img', { src: url, alt: '', loading: 'lazy' });
    img.onerror = () => img.remove();
    art.append(img);
  });
  row.append(art,
    el('div', { class: 'row-main' },
      el('div', { class: 'row-title' }, game.title),
      el('div', { class: 'row-meta' },
        `${(game.genres || []).join(' · ') || 'Game'} — ${game.author || 'Unknown'} · ${formatBytes(game.sizeBytes)}${game.playCount > 0 ? ` · ${formatDuration(game.playTimeSeconds)} played` : ''}`)),
    el('div', { class: 'row-side' },
      game.favorite ? el('span', { title: 'Favorite' }, '★') : null,
      licenseBadge(game.license),
      el('button', {
        class: 'btn sm primary', 'aria-label': `Play ${game.title}`,
        onclick: (e) => { e.stopPropagation(); onPlay(game); },
      }, '▶ Play')));
  return row;
}

export function emptyState({ icon = '🎮', title, body, actions = [] }) {
  return el('div', { class: 'empty' },
    el('div', { class: 'big' }, icon),
    el('h2', { text: title }),
    el('p', { text: body }),
    el('div', { class: 'empty-actions' }, ...actions));
}

/** Infinite-scroll renderer: renders items in chunks as the sentinel appears. */
export function pagedList(container, items, renderItem, { pageSize = 48 } = {}) {
  container.innerHTML = '';
  if (!items.length) return () => {};
  let shown = 0;
  const sentinel = el('div', { class: 'sentinel' });
  container.append(sentinel);
  const renderMore = () => {
    const frag = document.createDocumentFragment();
    for (let i = shown; i < Math.min(shown + pageSize, items.length); i++) {
      const n = renderItem(items[i], i);
      if (n) frag.append(n);
    }
    shown = Math.min(shown + pageSize, items.length);
    container.insertBefore(frag, sentinel);
    if (shown >= items.length) {
      sentinel.remove();
      observer.disconnect();
    }
  };
  const observer = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) renderMore();
  }, { root: document.getElementById('view'), rootMargin: '600px' });
  observer.observe(sentinel);
  renderMore();
  return () => observer.disconnect();
}

export async function withBusy(btn, fn) {
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Working…';
  try { return await fn(); }
  finally { btn.disabled = false; btn.innerHTML = old; }
}

export function stars(n) { return '★'.repeat(n) + '☆'.repeat(Math.max(0, 5 - n)); }
