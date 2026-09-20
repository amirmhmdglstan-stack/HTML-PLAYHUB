'use strict';
/**
 * doctor.js — static compatibility analysis for HTML games.
 *
 * Pure functions (no Electron) so the same engine is used by:
 *  - the main process (import wizard, game doctor view)
 *  - tools/audit-games.mjs (CI report over bundled games)
 *  - tests/
 *
 * Nothing here executes game code. It only reads files as text.
 */
const fs = require('node:fs');
const path = require('node:path');
const { isHtmlFile, isImageFile } = require('./util');

const MAX_SCAN_BYTES = 4 * 1024 * 1024; // cap per-file text scanning

function readTextCapped(filePath, cap = MAX_SCAN_BYTES) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, cap);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    return { text: buf.toString('utf8'), truncated: st.size > cap, size: st.size };
  } finally {
    fs.closeSync(fd);
  }
}

function extractTitle(html) {
  const m = html.match(/<title[^>]*>([^<]{1,200})<\/title>/i);
  if (m) return m[1].replace(/\s+/g, ' ').trim();
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']{1,200})/i)
    || html.match(/<meta[^>]+content=["']([^"']{1,200})["'][^>]+property=["']og:title["']/i);
  if (og) return og[1].trim();
  const h1 = html.match(/<h1[^>]*>([^<]{1,120})<\/h1>/i);
  if (h1) return h1[1].replace(/\s+/g, ' ').trim();
  return null;
}

function extractMetaDescription(html) {
  const m = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{1,500})/i)
    || html.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]+name=["']description["']/i);
  return m ? m[1].trim() : null;
}

function hostOf(url) {
  const m = /^https?:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])(?::\d+)?/i.exec(url);
  if (!m) return null;
  const h = m[1].toLowerCase();
  if (h === 'www.w3.org' || h === 'w3.org') return null; // XML namespaces, not deps
  return h;
}

/**
 * Hosts of resources the game actually LOADS (scripts, styles, media, models,
 * fetches, module imports). Plain hyperlinks (<a href>, comments, metadata)
 * are not loads and are reported separately as externalLinks.
 */
function extractResourceHosts(text) {
  const hosts = new Set();
  const add = (url) => { const h = hostOf(url); if (h) hosts.add(h); };
  const patterns = [
    // Resource tags with remote src/href.
    /<(?:script|link|img|audio|video|source|track|embed|iframe|frame|image)\b[^<>]*(?:src|href)\s*=\s*["'](https?:\/\/[^"'<>\s]+)["']/gi,
    // CSS resources.
    /url\(\s*["']?(https?:\/\/[^"'()\s]+)["']?\s*\)/gi,
    /@import\s+["'](https?:\/\/[^"']+)["']/gi,
    // JS module + network calls.
    /\bimport\s*\(\s*["'](https?:\/\/[^"']+)["']/gi,
    /\bfrom\s+["'](https?:\/\/[^"']+)["']/gi,
    // Import maps + dynamic script URLs: any quoted remote .js/.mjs URL.
    /["'](https?:\/\/[^"'<>\\s]+\.m?js(?:\?[^"'<>\\s]*)?)["']/gi,
    /\bfetch\s*\(\s*["'](https?:\/\/[^"']+)["']/gi,
    /new\s+(?:WebSocket|Worker|Audio|Image)\s*\(\s*["'](https?:\/\/[^"']+)["']/gi,
    // JS string assignments that look like remote resource URLs.
    /(?:src|href|url|uri|path)\s*[:=]\s*["'](https?:\/\/[^"']+\.(?:js|mjs|css|png|jpe?g|gif|webp|svg|mp3|wav|ogg|mp4|webm|wasm|json|glb|gltf|ttf|woff2?)(?:[?#][^"']*)?)["']/gi,
  ];
  for (const re of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) add(m[1]);
  }
  return [...hosts].sort();
}

/** All external hosts mentioned anywhere (loads + plain links + comments). */
function extractExternalHosts(text) {
  const hosts = new Set();
  const re = /https?:\/\/([a-z0-9][a-z0-9.-]*[a-z0-9])(?::\d+)?/gi;
  let m;
  while ((m = re.exec(text))) {
    const h = m[1].toLowerCase();
    if (h === 'www.w3.org' || h === 'w3.org') continue;
    hosts.add(h);
  }
  return [...hosts].sort();
}

const TRACKER_HOSTS = [
  'googletagmanager.com', 'google-analytics.com', 'analytics.google.com',
  'facebook.net', 'facebook.com', 'doubleclick.net', 'googlesyndication.com',
  'hotjar.com', 'segment.io', 'mixpanel.com', 'amplitude.com', 'newrelic.com',
  'sentry.io', 'bugsnag.com', 'matomo.cloud',
];

function detectTrackers(hosts) {
  return hosts.filter((h) => TRACKER_HOSTS.some((t) => h === t || h.endsWith('.' + t)));
}

const CDN_HOSTS = [
  'cdnjs.cloudflare.com', 'unpkg.com', 'cdn.jsdelivr.net', 'cdn cold',
  'ajax.googleapis.com', 'stackpath.bootstrapcdn.com', 'cdn.tailwindcss.com',
  'code.jquery.com', 'stackpath.bootstrapcdn.com', 'fonts.googleapis.com',
  'fonts.gstatic.com', 'raw.githubusercontent.com', 'cdn.skypack.dev', 'esm.sh',
];

function detectInputHints(text) {
  const t = text.toLowerCase();
  const has = (...needles) => needles.some((n) => t.includes(n));
  const keyboard = has('keydown', 'keyup', 'keypress', 'e.key', 'event.key', '.keycode', 'which ===', 'which==')
    || /\b(e|event|ev)\.code\b/.test(t) || /\bkeycode\b/.test(t) || has('getkeyboardstate');
  const pointerLockEarly = has('requestpointerlock', 'pointerlockchange', 'movementx');
  const mouse = has('mousedown', 'mouseup', 'mousemove', 'onclick', 'click', 'pointerdown', 'contextmenu', 'clientx')
    || pointerLockEarly;
  const touch = has('touchstart', 'touchend', 'touchmove', 'ontouchstart', 'pointerdown', 'pointer events');
  const gamepad = has('getgamepads', 'gamepadconnected', 'gamepad');
  const fullscreen = has('requestfullscreen', 'webkitrequestfullscreen');
  const pointerLock = has('requestpointerlock', 'pointerlockchange', 'movementx');
  return { keyboard, mouse, touch, gamepad, fullscreen, pointerLock };
}

function detectStorageHints(text) {
  const t = text.toLowerCase();
  return {
    localStorage: t.includes('localstorage'),
    sessionStorage: t.includes('sessionstorage'),
    indexedDB: t.includes('indexeddb'),
    cookies: t.includes('document.cookie'),
    webSQL: t.includes('opendatabase'),
    fileSystem: t.includes('showdirectorypicker') || t.includes('webkitgetasentry'),
  };
}

function detectTechHints(text, fileName) {
  const t = text.toLowerCase();
  const has = (...needles) => needles.some((n) => t.includes(n));
  return {
    canvas2d: has('<canvas', 'getcontext(\'2d\')', 'getcontext("2d")'),
    webgl: has('webgl', 'three', 'babylon', 'pixi', 'phaser'),
    threejs: has('three.js', 'three.min.js', 'three.module.js', 'new three.'),
    audio: has('webaudio', 'audiocontext', '<audio', 'new audio('),
    video: has('<video'),
    wasm: has('.wasm', 'webassembly'),
    workers: has('new worker('),
    modules: has('type="module"', "type='module'"),
    jquery: has('jquery'),
    websockets: has('new websocket(', 'wss://', 'ws://'),
    webrtc: has('rtcpeerconnection'),
  };
}

function extractLocalRefs(html, entryDir, gameRoot) {
  // Collect local (non-remote, non-data:, non-fragment) asset references.
  const refs = new Set();
  const attrRe = /(?:src|href|poster|data-src)\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = attrRe.exec(html))) {
    let u = m[1].trim();
    if (!u || u.startsWith('#') || u.startsWith('data:') || u.startsWith('blob:')) continue;
    if (/^(https?:|mailto:|tel:|javascript:)/i.test(u)) continue;
    u = u.split('#')[0].split('?')[0].trim();
    if (!u) continue;
    refs.add(u);
  }
  // CSS url(...) references
  const cssRe = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  while ((m = cssRe.exec(html))) {
    let u = m[1].trim();
    if (!u || u.startsWith('#') || u.startsWith('data:') || u.startsWith('blob:')) continue;
    if (/^(https?:|mailto:|tel:|javascript:)/i.test(u)) continue;
    u = u.split('#')[0].split('?')[0].trim();
    if (!u) continue;
    refs.add(u);
  }
  const missing = [];
  for (const r of refs) {
    let abs;
    if (r.startsWith('/')) abs = path.join(gameRoot, r.slice(1));
    else abs = path.resolve(entryDir, r);
    // Only flag files that look like real assets (skip extensionless routes).
    const ext = path.extname(abs).toLowerCase();
    if (!ext) continue;
    try {
      if (!fs.existsSync(abs)) missing.push(r);
    } catch { missing.push(r); }
  }
  return { refs: [...refs].sort(), missing: missing.sort() };
}

/**
 * Score how likely an HTML file is the game's entry point. Higher = better.
 */
function scoreEntryPoint(file, gameRoot) {
  const rel = file.relative.replace(/\\/g, '/');
  const name = path.basename(rel).toLowerCase();
  const lower = rel.toLowerCase();
  let score = 0;
  const reasons = [];

  if (/(^|\/)(index|game|main|play|app)\.html?$/.test(lower)) { score += 100; reasons.push('canonical entry filename'); }
  else if (name.endsWith('.html') || name.endsWith('.htm')) { score += 10; }

  const depth = rel.split('/').length - 1;
  score += Math.max(0, 30 - depth * 10);
  if (depth === 0) reasons.push('top-level file');

  if (/readme|license|changelog|test|spec|demo-list|index\.backup/i.test(name)) { score -= 120; reasons.push('looks like a non-game page'); }
  if (/(^|\/)(node_modules|tools?|docs?|screenshots?|assets?|vendor|lib|test|tests|coverage)\//.test(lower)) { score -= 80; reasons.push('inside a non-game folder'); }
  if (/backup|backup-|copy|old|draft/i.test(name)) { score -= 60; reasons.push('looks like a backup copy'); }
  if (file.size < 300) { score -= 40; reasons.push('suspiciously small'); }
  if (file.size > 30 * 1024 * 1024) { score -= 20; reasons.push('unusually large'); }

  try {
    const { text } = readTextCapped(file.path, 256 * 1024);
    const t = text.toLowerCase();
    if (/<canvas/i.test(text)) { score += 25; reasons.push('contains <canvas>'); }
    if (/<script/i.test(text)) { score += 15; reasons.push('contains scripts'); }
    if (/requestfullscreen|getcontext\(|new three\.|phaser|pixi|game loop|requestanimationframe/i.test(text)) { score += 15; reasons.push('game-like APIs'); }
    if (/<title[^>]*>[^<]+<\/title>/i.test(text)) { score += 5; }
    const title = extractTitle(text);
    return { score, reasons, title };
  } catch {
    return { score: score - 50, reasons: [...reasons, 'unreadable file'], title: null };
  }
}

/**
 * Full directory analysis. `files` = [{path, relative, size}] from walkFiles.
 */
function analyzeDirectory(gameRoot, files, options = {}) {
  const htmlFiles = files.filter((f) => isHtmlFile(f.relative));
  const imageFiles = files.filter((f) => isImageFile(f.relative))
    .filter((f) => !/favicon|logo.*small|thumb.*small/i.test(f.relative));
  const totalBytes = files.reduce((a, f) => a + (f.size || 0), 0);

  const scored = htmlFiles.map((f) => ({ file: f, ...scoreEntryPoint(f, gameRoot) }))
    .sort((a, b) => b.score - a.score);
  const entry = scored[0] || null;

  // Aggregate signals across entry + a sample of scripts (cap work).
  let aggregate = '';
  const texts = [];
  if (entry) {
    try { texts.push(readTextCapped(entry.file.path).text); } catch { /* ignore */ }
  }
  const jsFiles = files.filter((f) => /\.(m?js)$/i.test(f.relative)).slice(0, 12);
  for (const jf of jsFiles) {
    if (jf.size > 2 * 1024 * 1024) continue;
    try { texts.push(readTextCapped(jf.path, 512 * 1024).text); } catch { /* ignore */ }
  }
  aggregate = texts.join('\n').slice(0, 2 * 1024 * 1024);

  const externalHosts = extractResourceHosts(aggregate);
  const linkHosts = extractExternalHosts(aggregate).filter((h) => !externalHosts.includes(h));
  const trackers = detectTrackers(externalHosts);
  const cdnHosts = externalHosts.filter((h) => CDN_HOSTS.some((c) => h === c || h.endsWith('.' + c)));
  const input = detectInputHints(aggregate);
  const storage = detectStorageHints(aggregate);
  const tech = detectTechHints(aggregate + ' ' + (entry ? entry.file.relative : ''), '');

  let localRefs = { refs: [], missing: [] };
  if (entry) {
    try {
      const { text } = readTextCapped(entry.file.path);
      localRefs = extractLocalRefs(text, path.dirname(entry.file.path), gameRoot);
    } catch { /* ignore */ }
  }

  const singleFile = files.length === 1 && htmlFiles.length === 1;

  // Verdicts
  const warnings = [];
  const errors = [];
  if (!entry) errors.push({ code: 'no-entry', message: 'No HTML file found. This package does not look like a playable web game.' });
  if (entry && entry.score < 0) warnings.push({ code: 'weak-entry', message: `Best entry candidate (${entry.file.relative}) scored low — please verify it is the real game page.` });
  if (localRefs.missing.length > 0) {
    const shown = localRefs.missing.slice(0, 6).join(', ');
    warnings.push({ code: 'missing-assets', message: `Entry page references ${localRefs.missing.length} missing local file(s): ${shown}${localRefs.missing.length > 6 ? '…' : ''}` });
  }
  if (externalHosts.length > 0) {
    warnings.push({
      code: 'external-deps',
      message: `Loads resources from ${externalHosts.length} external host(s): ${externalHosts.slice(0, 4).join(', ')}${externalHosts.length > 4 ? '…' : ''}. May need internet.`,
      hosts: externalHosts,
    });
  } else if (linkHosts.length > 0) {
    warnings.push({
      code: 'external-links',
      message: `Links out to ${linkHosts.length} external site(s) (not loaded as resources): ${linkHosts.slice(0, 4).join(', ')}${linkHosts.length > 4 ? '…' : ''}.`,
      hosts: linkHosts,
      level: 'info',
    });
  }
  if (trackers.length > 0) {
    warnings.push({ code: 'trackers', message: `Possible analytics/tracking hosts detected: ${trackers.join(', ')}. Consider enabling Offline Sandbox for this game.`, hosts: trackers });
  }
  if (tech.websockets || tech.webrtc) {
    warnings.push({ code: 'network-api', message: 'Uses live network APIs (WebSocket/WebRTC) — likely requires internet or another player/server.' });
  }
  if (input.pointerLock) {
    warnings.push({ code: 'pointer-lock', message: 'Uses pointer lock (mouse-look). Play in fullscreen for best results.' });
  }

  const offlineCapable = externalHosts.length === 0 && !tech.websockets && !tech.webrtc;

  return {
    entry: entry ? {
      relative: entry.file.relative.replace(/\\/g, '/'),
      score: entry.score,
      reasons: entry.reasons,
      title: entry.title,
    } : null,
    candidates: scored.slice(0, 5).map((s) => ({
      relative: s.file.relative.replace(/\\/g, '/'), score: s.score, title: s.title,
    })),
    htmlCount: htmlFiles.length,
    fileCount: files.length,
    totalBytes,
    singleFile,
    images: imageFiles
      .sort((a, b) => (b.size || 0) - (a.size || 0))
      .slice(0, 8)
      .map((f) => f.relative.replace(/\\/g, '/')),
    externalHosts,
    linkHosts,
    cdnHosts,
    trackers,
    input,
    storage,
    tech,
    localRefs,
    offlineCapable,
    warnings,
    errors,
    metaDescription: entry ? (() => { try { return extractMetaDescription(readTextCapped(entry.file.path).text); } catch { return null; } })() : null,
  };
}

/** One-shot diagnosis for an installed game dir (used by Game Doctor view). */
function diagnoseGame(gameRoot, entryRelative) {
  const checks = [];
  const push = (name, status, detail) => checks.push({ name, status, detail });
  // status: ok | warn | fail | info

  const entryAbs = entryRelative ? path.join(gameRoot, entryRelative) : null;
  if (!entryAbs || !fs.existsSync(entryAbs)) {
    push('Entry point', 'fail', entryRelative ? `Missing: ${entryRelative}` : 'No entry file configured');
    return { checks, summary: 'fail' };
  }
  push('Entry point', 'ok', entryRelative);

  let files = [];
  try {
    const walk = require('./util').walkFilesSync;
    files = walk ? walk(gameRoot) : [];
  } catch { files = []; }
  // walkFiles is async; do a small sync walk here instead.
  files = syncWalk(gameRoot);
  const analysis = analyzeDirectory(gameRoot, files);

  push('Game files', files.length ? 'ok' : 'fail', `${files.length} file(s)`);
  if (analysis.localRefs.missing.length) push('Local assets', 'warn', `${analysis.localRefs.missing.length} missing: ${analysis.localRefs.missing.slice(0, 3).join(', ')}`);
  else push('Local assets', 'ok', analysis.localRefs.refs.length ? `${analysis.localRefs.refs.length} reference(s) resolve` : 'no external local references');
  push('Offline capable', analysis.offlineCapable ? 'ok' : 'warn',
    analysis.offlineCapable ? 'no remote dependencies detected' : `uses: ${analysis.externalHosts.slice(0, 3).join(', ')}`);
  if (analysis.offlineCapable && analysis.linkHosts && analysis.linkHosts.length) {
    push('External links', 'info', `links out (not loaded): ${analysis.linkHosts.slice(0, 3).join(', ')}`);
  }
  if (analysis.trackers.length) push('Trackers', 'warn', analysis.trackers.join(', '));
  push('Keyboard', analysis.input.keyboard ? 'info' : 'info', analysis.input.keyboard ? 'keyboard input detected' : 'no keyboard listeners detected');
  push('Mouse / touch', analysis.input.mouse || analysis.input.touch ? 'info' : 'info',
    analysis.input.mouse ? 'mouse input detected' : (analysis.input.touch ? 'touch input detected' : 'no pointer listeners detected'));
  const stores = Object.entries(analysis.storage).filter(([, v]) => v).map(([k]) => k);
  push('Save storage', 'info', stores.length ? `detected: ${stores.join(', ')} (kept per-game)` : 'no browser-storage APIs detected');
  push('Fullscreen', 'info', analysis.input.fullscreen ? 'game can request fullscreen' : 'no fullscreen API usage detected');

  const summary = checks.some((c) => c.status === 'fail') ? 'fail'
    : checks.some((c) => c.status === 'warn') ? 'warn' : 'ok';
  return { checks, summary, analysis };
}

function syncWalk(root, out = [], base = root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '__MACOSX') continue;
    const full = path.join(root, e.name);
    if (e.isDirectory()) syncWalk(full, out, base);
    else if (e.isFile()) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
      // Skip Playhub sidecar files.
      if (e.name === 'playhub.manifest.json') continue;
      out.push({ path: full, relative: path.relative(base, full), size });
    }
    if (out.length > 50000) break;
  }
  return out;
}

module.exports = {
  readTextCapped,
  extractTitle,
  extractMetaDescription,
  extractResourceHosts,
  extractExternalHosts,
  detectTrackers,
  detectInputHints,
  detectStorageHints,
  detectTechHints,
  extractLocalRefs,
  scoreEntryPoint,
  analyzeDirectory,
  diagnoseGame,
  syncWalk,
};
