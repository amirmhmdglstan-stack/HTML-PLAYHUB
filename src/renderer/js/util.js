/* util.js — DOM + formatting helpers for the renderer. */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(9)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function debounce(fn, ms = 200) {
  let t = null;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024, u = 0;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return s === 0 ? '—' : `${s}s`;
}

export function timeAgo(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso).getTime();
  if (Number.isNaN(d)) return 'Never';
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'Just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDate(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Never';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Deterministic gradient for generated card art (same game -> same art). */
const PALETTES = [
  ['#4c1d95', '#7c3aed', '#d946ef'], ['#0c4a6e', '#0284c7', '#22d3ee'],
  ['#14532d', '#059669', '#a3e635'], ['#7c2d12', '#ea580c', '#facc15'],
  ['#831843', '#db2777', '#f472b6'], ['#134e4a', '#0d9488', '#34d399'],
  ['#1e1b4b', '#4f46e5', '#818cf8'], ['#450a0a', '#b91c1c', '#fb7185'],
  ['#042f2e', '#0f766e', '#f59e0b'], ['#27272a', '#52525b', '#a1a1aa'],
];
export function paletteFor(id) {
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTES[h % PALETTES.length];
}
export function gradientFor(id) {
  const [a, b, c] = paletteFor(id);
  return `linear-gradient(135deg, ${a}, ${b} 55%, ${c})`;
}
export function initialsFor(title) {
  const words = String(title || '?').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Genre -> emoji-ish glyph map for icons/badges. */
const GENRE_ICONS = {
  Action: '💥', Arcade: '👾', Puzzle: '🧩', Platformer: '🏃', Racing: '🏎️',
  Strategy: '♟️', Sports: '⚽', Simulation: '🏗️', Music: '🎵', Horror: '👻',
  Educational: '📚', RPG: '🗡️', Adventure: '🗺️', Card: '🃏', Retro: '📼',
};
export function genreIcon(g) { return GENRE_ICONS[g] || '🎮'; }

export const COLLECTION_ICONS = { grid: '▦', star: '★', clock: '🕘', check: '✔', folder: '📁', gamepad: '🎮', heart: '♥', bolt: '⚡', gem: '💎', ghost: '👻', car: '🏎️', ball: '⚽', puzzle: '🧩', music: '🎵' };
export function collectionIcon(name) { return COLLECTION_ICONS[name] || '📁'; }

/* Minimal SVG-ish icon set using text glyphs (offline-safe, no icon font). */
export const ICONS = {
  home: '⌂', library: '▦', star: '★', clock: '🕘', installed: '✔', collections: '🗂', discover: '🧭',
  import: '＋', settings: '⚙', play: '▶', search: '⌕', dice: '🎲', back: '←',
};

export function downloadText(filename, text) {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
