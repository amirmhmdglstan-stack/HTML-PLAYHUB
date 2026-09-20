/* game.js — player window: sandboxed webview host + virtual controls + editor. */
import { CONTROL_PRESETS, CANONICAL_KEYS, KEY_LABELS, keyCodeFor, isMouseKey, mouseButtonFor, cloneLayout, newJoystick, newTouchpad, newButton } from './controls.js';

const G = window.playhubGame;
const params = new URLSearchParams(location.search);
const gameId = params.get('game');
const devMode = params.get('dev') === '1';

const $ = (id) => document.getElementById(id);
const els = {};
for (const id of ['t-exit', 't-title', 't-zoom-out', 't-zoom-label', 't-zoom-in', 't-controls', 't-edit', 't-shot', 't-reload', 't-info', 't-full', 'fs-bar', 'fs-exit', 'fs-shot', 'fs-reload', 'fs-controls', 'frame', 'guest-holder', 'overlay', 'veil', 'veil-title', 'veil-sub', 'fail-veil', 'fail-msg', 'fail-reload', 'fail-exit', 'fail-doctor', 'fail-tech', 'fail-details', 'fail-doctor-out', 'editor', 'editor-body', 'ed-add-btn', 'ed-add-joy', 'ed-add-pad', 'ed-save', 'ed-preset-save', 'ed-preset-load', 'ed-reset', 'ed-done', 'drawer', 'drawer-close', 'drawer-body', 'drawer-title', 'toast-root', 'stage-wrap']) {
  els[id] = $(id);
}

const state = {
  game: null, settings: {}, layouts: { global: {}, perGame: {} },
  layout: null, editing: false, selectedId: null,
  zoom: 100, frame: 'none', overlayOn: false,
  sessionStart: Date.now(), cursor: { x: 0.5, y: 0.5 }, // virtual cursor (fractions)
  joyKeys: new Set(), padPoll: null, elapsedTimer: null,
  failInfo: null,
};

let guest = null;

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  els['toast-root'].append(t);
  setTimeout(() => t.remove(), 3200);
}

/* ================= boot ================= */
async function boot() {
  if (!gameId) {
    showFail('No game specified.', {});
    return;
  }
  try {
    state.game = await G.invoke('games:get', gameId);
    state.settings = await G.invoke('settings:get');
    state.layouts = await G.invoke('layouts:get');
  } catch (err) {
    showFail(`Could not load game: ${err.message}`, {});
    return;
  }
  document.documentElement.dataset.theme = state.settings.theme || 'dark';
  document.documentElement.dataset.accent = state.settings.accent || 'violet';
  document.documentElement.dataset.motion = state.settings.reduceMotion ? 'reduced' : 'full';
  document.title = `${state.game.title} — HTML Playhub`;
  els['t-title'].innerHTML = '';
  els['t-title'].append(state.game.title, Object.assign(document.createElement('small'), { id: 'elapsed', textContent: '0:00' }));

  state.zoom = state.game.zoom || state.settings.defaultZoom || 100;
  state.frame = state.game.frame || state.settings.defaultFrame || 'none';
  state.layout = resolveLayout();
  state.overlayOn = !!state.settings.showVirtualControls;

  buildGuest();
  wireToolbar();
  wireKeys();
  applyFrame();
  renderOverlay();
  updateZoomLabel();
  startElapsed();

  // Screenshot requests from main.
  G.on('playhub:capture-request', async ({ replyChannel }) => {
    try {
      const img = await guest.capturePage();
      G.sendCaptureResult(replyChannel, { ok: true, pngBase64: img.toPNG().toString('base64') });
    } catch (err) {
      G.sendCaptureResult(replyChannel, { ok: false, error: String(err.message || err) });
    }
  });
  // Keys pressed while the guest has focus (forwarded by main).
  G.on('playhub:player-key', (action) => handlePlayerKey(action));
  G.on('playhub:settings-changed', (s) => {
    state.settings = s;
    document.documentElement.dataset.theme = s.theme || 'dark';
  });

  window.addEventListener('resize', () => { if (state.frame !== 'none') applyFrame(); });
}

function resolveLayout() {
  const per = state.layouts.perGame && state.layouts.perGame[gameId];
  if (per) return cloneLayout(per);
  const presetName = state.settings.defaultControlPreset || 'generic';
  if (presetName.startsWith('custom:')) {
    const custom = state.layouts.global && state.layouts.global[presetName.slice(7)];
    if (custom) return cloneLayout(custom);
  }
  return cloneLayout(CONTROL_PRESETS[presetName] || CONTROL_PRESETS.generic);
}

/* ================= guest webview ================= */
function guestURL() {
  return `playhub-game://game/${gameId}/${state.game.entryFile}`;
}

function buildGuest() {
  guest = document.createElement('webview');
  guest.setAttribute('partition', `persist:playhub-${gameId}`);
  guest.setAttribute('allowpopups', 'false');
  guest.src = guestURL();
  els['guest-holder'].append(guest);

  guest.addEventListener('did-start-loading', () => {
    if (!state.failInfo) {
      els.veil.hidden = false;
      els['fail-veil'].hidden = true;
      els['veil-title'].textContent = `Loading ${state.game.title}…`;
    }
  });
  guest.addEventListener('did-finish-load', () => {
    els.veil.hidden = true;
    state.failInfo = null;
    guest.setZoomFactor(state.zoom / 100);
    notifyGuestReady();
  });
  guest.addEventListener('did-fail-load', (e) => {
    if (e.errorCode === -3) return; // aborted (e.g. during reload) — ignore
    showFail(`The game page failed to load (${e.errorDescription || 'unknown error'}).`, {
      code: e.errorCode, description: e.errorDescription, url: e.validatedURL || guestURL(),
    });
  });
  guest.addEventListener('crashed', () => {
    showFail('The game process crashed. Your launcher is fine — only the game was affected.', { crashed: true });
  });
  guest.addEventListener('unresponsive', () => toast('Game is not responding…'));
  guest.addEventListener('responsive', () => toast('Game is responding again.'));
  guest.addEventListener('new-window', (e) => {
    e.preventDefault();
    handleExternalNavigation(e.url);
  });
  guest.addEventListener('will-navigate', (e) => {
    if (!e.url.startsWith(`playhub-game://game/${gameId}/`)) {
      e.preventDefault();
      handleExternalNavigation(e.url);
    }
  });
}

let guestReadyTries = 0;
function notifyGuestReady() {
  // Main attaches guest keyboard shortcuts (F5/F9/F11/F12) via before-input-event.
  guestReadyTries++;
  G.invoke('player:guest-ready', gameId).catch(() => {
    if (guestReadyTries < 4) setTimeout(notifyGuestReady, 800);
  });
}

function handleExternalNavigation(url) {
  if (/^https?:\/\//i.test(url)) {
    G.invoke('shell:open-external', url)
      .then(() => toast('Opened in your browser.'))
      .catch(() => toast('Blocked navigation to external URL.', ''));
  } else {
    toast('Blocked navigation outside the game.', '');
  }
}

function showFail(message, info) {
  els.veil.hidden = true;
  els['fail-veil'].hidden = false;
  state.failInfo = { message, ...info, at: new Date().toISOString() };
  els['fail-msg'].textContent = message;
  els['fail-details'].hidden = true;
  els['fail-doctor-out'].innerHTML = '';
}

function technicalDetails() {
  const ua = navigator.userAgent;
  const chrome = (ua.match(/Chrome\/([0-9.]+)/) || [])[1] || 'unknown';
  return [
    `game: ${gameId}`, `entry: ${state.game ? state.game.entryFile : '?'}`,
    `url: ${(state.failInfo && state.failInfo.url) || guestURL()}`,
    `partition: persist:playhub-${gameId}`,
    `error: ${JSON.stringify({ code: state.failInfo?.code, description: state.failInfo?.description, crashed: !!state.failInfo?.crashed })}`,
    `time: ${state.failInfo?.at || new Date().toISOString()}`,
    `chrome: ${chrome}`,
  ].join('\n');
}

/* ================= toolbar / window ================= */
function wireToolbar() {
  els['t-exit'].onclick = () => window.close();
  els['fail-exit'].onclick = () => window.close();
  els['t-zoom-in'].onclick = () => setZoom(state.zoom + 25);
  els['t-zoom-out'].onclick = () => setZoom(state.zoom - 25);
  els['t-zoom-label'].onclick = () => setZoom(100);
  els['t-reload'].onclick = () => reloadGuest();
  els['fail-reload'].onclick = () => reloadGuest();
  els['t-shot'].onclick = takeScreenshot;
  els['t-controls'].onclick = toggleOverlay;
  els['t-edit'].onclick = toggleEditor;
  els['t-info'].onclick = toggleDrawer;
  els['t-full'].onclick = toggleFullscreen;
  els['drawer-close'].onclick = () => { els.drawer.hidden = true; stopPadPoll(); };
  els['fs-exit'].onclick = toggleFullscreen;
  els['fs-shot'].onclick = takeScreenshot;
  els['fs-reload'].onclick = () => reloadGuest();
  els['fs-controls'].onclick = toggleOverlay;
  els['fail-tech'].onclick = () => {
    els['fail-details'].hidden = !els['fail-details'].hidden;
    els['fail-details'].textContent = technicalDetails();
  };
  els['fail-doctor'].onclick = runFailDoctor;

  // Editor static buttons
  els['ed-add-btn'].onclick = () => { state.layout.buttons.push(newButton()); state.selectedId = state.layout.buttons[state.layout.buttons.length - 1].id; renderOverlay(); renderEditor(); };
  els['ed-add-joy'].onclick = () => { state.layout.joystick = newJoystick(); state.selectedId = state.layout.joystick.id; renderOverlay(); renderEditor(); };
  els['ed-add-pad'].onclick = () => { state.layout.touchpad = newTouchpad(); state.selectedId = state.layout.touchpad.id; renderOverlay(); renderEditor(); };
  els['ed-save'].onclick = saveLayoutForGame;
  els['ed-preset-save'].onclick = saveAsPreset;
  els['ed-preset-load'].onchange = loadPresetFromSelect;
  els['ed-reset'].onclick = resetLayout;
  els['ed-done'].onclick = toggleEditor;

  // Fullscreen mini-bar auto-hide
  document.addEventListener('fullscreenchange', () => {
    const fs = !!document.fullscreenElement;
    els['fs-bar'].hidden = !fs;
    els['fs-bar'].classList.toggle('faded', false);
    els['t-full'].classList.toggle('on', fs);
    if (fs) pokeFsBar();
  });
  document.addEventListener('mousemove', (e) => {
    if (document.fullscreenElement && e.clientY < 90) pokeFsBar();
  });
}

let fsTimer = null;
function pokeFsBar() {
  els['fs-bar'].classList.remove('faded');
  clearTimeout(fsTimer);
  fsTimer = setTimeout(() => els['fs-bar'].classList.add('faded'), 2600);
}

function reloadGuest() {
  els['fail-veil'].hidden = true;
  state.failInfo = null;
  try { guest.reload(); } catch { guest.src = guestURL(); }
}

function setZoom(z) {
  state.zoom = Math.min(300, Math.max(25, Math.round(z)));
  try { guest.setZoomFactor(state.zoom / 100); } catch { /* ignore */ }
  updateZoomLabel();
  clearTimeout(setZoom._t);
  setZoom._t = setTimeout(() => {
    G.invoke('games:update', gameId, { zoom: state.zoom }).catch(() => {});
  }, 800);
}
function updateZoomLabel() { els['t-zoom-label'].textContent = `${state.zoom}%`; }

function applyFrame() {
  const f = els.frame;
  f.classList.remove('framed');
  f.style.aspectRatio = '';
  f.style.width = '';
  f.style.height = '';
  if (state.frame && state.frame !== 'none') {
    f.classList.add('framed');
    const [w, h] = state.frame.split(':').map(Number);
    f.style.aspectRatio = `${w} / ${h}`;
    // Fit inside stage: constrain by both axes.
    f.style.maxWidth = '100%';
    f.style.maxHeight = '100%';
    f.style.width = 'auto';
    f.style.height = 'auto';
    // Use available space: pick limiting dimension via CSS min().
    f.style.width = `min(100%, calc((100vh - 60px) * ${w} / ${h}))`;
  }
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else els.frame.requestFullscreen().catch(() => toast('Fullscreen was blocked.'));
}

async function takeScreenshot() {
  toast('Capturing…');
  try {
    const r = await G.invoke('playhub:game-screenshot', gameId);
    toast(`Screenshot saved (${r.name}).`);
  } catch (err) {
    toast(`Screenshot failed: ${err.message}`);
  }
}

function startElapsed() {
  const tick = () => {
    const s = Math.floor((Date.now() - state.sessionStart) / 1000);
    const mm = Math.floor(s / 60), ss = String(s % 60).padStart(2, '0');
    const n = document.getElementById('elapsed');
    if (n) n.textContent = `${mm}:${ss}`;
  };
  tick();
  state.elapsedTimer = setInterval(tick, 1000);
}

/* ================= player keys ================= */
function wireKeys() {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r')) { e.preventDefault(); reloadGuest(); }
    else if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); }
    else if (e.key === 'F12') { e.preventDefault(); takeScreenshot(); }
    else if (e.key === 'F9') { e.preventDefault(); toggleOverlay(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && state.editing && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) {
      deleteSelected();
    }
  });
  els.overlay.addEventListener('contextmenu', (e) => e.preventDefault());
}

function handlePlayerKey(action) {
  if (action === 'reload') reloadGuest();
  else if (action === 'fullscreen') toggleFullscreen();
  else if (action === 'screenshot') takeScreenshot();
  else if (action === 'controls') toggleOverlay();
}

/* ================= input injection ================= */
function guestPoint(clientX, clientY) {
  const r = els.frame.getBoundingClientRect();
  const z = state.zoom / 100;
  return {
    x: Math.round(Math.max(0, Math.min(r.width, clientX - r.left)) / z),
    y: Math.round(Math.max(0, Math.min(r.height, clientY - r.top)) / z),
  };
}

function framePoint() {
  const r = els.frame.getBoundingClientRect();
  const z = state.zoom / 100;
  return { x: Math.round((r.width * state.cursor.x) / z), y: Math.round((r.height * state.cursor.y) / z) };
}

function sendKey(canonical, down) {
  if (isMouseKey(canonical)) {
    const p = framePoint();
    guest.sendInputEvent({ type: down ? 'mouseDown' : 'mouseUp', x: p.x, y: p.y, button: mouseButtonFor(canonical), clickCount: 1 });
    return;
  }
  const keyCode = keyCodeFor(canonical);
  if (!keyCode) return;
  guest.sendInputEvent({ type: down ? 'keyDown' : 'keyUp', keyCode });
}

function sendMouseMove(x, y) {
  guest.sendInputEvent({ type: 'mouseMove', x, y });
}

function sendClick(x, y, button = 'left') {
  guest.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
  guest.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
}

/* ================= overlay ================= */
function toggleOverlay() {
  state.overlayOn = !state.overlayOn;
  if (!state.overlayOn && state.editing) toggleEditor();
  renderOverlay();
}

function toggleEditor() {
  state.editing = !state.editing;
  els.editor.hidden = !state.editing;
  els['t-edit'].classList.toggle('on', state.editing);
  if (state.editing && !state.overlayOn) state.overlayOn = true;
  if (!state.editing) state.selectedId = null;
  renderOverlay();
  renderEditor();
}

function renderOverlay() {
  const ov = els.overlay;
  ov.hidden = !state.overlayOn;
  ov.classList.toggle('on', state.overlayOn && !state.editing);
  ov.classList.toggle('editing', state.editing);
  els['t-controls'].classList.toggle('on', state.overlayOn);
  ov.innerHTML = '';
  if (!state.overlayOn) return;
  const layout = state.layout;
  for (const b of layout.buttons || []) ov.append(renderButton(b));
  if (layout.joystick) ov.append(renderJoystick(layout.joystick));
  if (layout.touchpad) ov.append(renderTouchpad(layout.touchpad));
}

function renderButton(b) {
  const d = document.createElement('button');
  d.className = 'vbtn' + (state.selectedId === b.id ? ' selected' : '');
  d.style.left = `${b.x}%`;
  d.style.top = `${b.y}%`;
  d.style.width = `${b.size}px`;
  d.style.height = `${b.size}px`;
  d.style.opacity = b.opacity;
  d.textContent = b.label || KEY_LABELS[b.key] || b.key;
  d.title = `${b.label || ''} → ${b.key}`.trim();

  if (state.editing) {
    enableDrag(d, b, 'button');
    d.addEventListener('pointerdown', (e) => { e.preventDefault(); state.selectedId = b.id; renderOverlay(); renderEditor(); });
    return d;
  }
  let held = false;
  const down = (e) => {
    e.preventDefault();
    d.setPointerCapture?.(e.pointerId);
    if (held) return;
    held = true;
    d.classList.add('pressed');
    try { sendKey(b.key, true); } catch { /* ignore */ }
  };
  const up = (e) => {
    e.preventDefault();
    if (!held) return;
    held = false;
    d.classList.remove('pressed');
    try { sendKey(b.key, false); } catch { /* ignore */ }
  };
  d.addEventListener('pointerdown', down);
  d.addEventListener('pointerup', up);
  d.addEventListener('pointercancel', up);
  d.addEventListener('lostpointercapture', up);
  d.addEventListener('contextmenu', (e) => e.preventDefault());
  return d;
}

function enableDrag(node, obj, kind) {
  node.addEventListener('pointerdown', (e) => {
    if (!state.editing) return;
    e.preventDefault();
    node.setPointerCapture?.(e.pointerId);
    const frame = els.frame.getBoundingClientRect();
    const move = (ev) => {
      obj.x = Math.round(Math.max(0, Math.min(100, ((ev.clientX - frame.left) / frame.width) * 100)) * 10) / 10;
      obj.y = Math.round(Math.max(0, Math.min(100, ((ev.clientY - frame.top) / frame.height) * 100)) * 10) / 10;
      node.style.left = `${obj.x}%`;
      node.style.top = `${obj.y}%`;
    };
    const up = () => {
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
      node.removeEventListener('pointercancel', up);
      renderEditor();
    };
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
  });
}

function renderJoystick(j) {
  const d = document.createElement('div');
  d.className = 'vjoy' + (state.selectedId === j.id ? ' selected' : '');
  d.style.left = `${j.x}%`;
  d.style.top = `${j.y}%`;
  d.style.width = `${j.size}px`;
  d.style.height = `${j.size}px`;
  d.style.opacity = j.opacity;
  d.style.transform = 'translate(-50%,-50%)';
  const knob = document.createElement('div');
  knob.className = 'vjoy-knob';
  const knobSize = Math.max(24, j.size * 0.42);
  knob.style.width = `${knobSize}px`;
  knob.style.height = `${knobSize}px`;
  knob.style.left = '50%';
  knob.style.top = '50%';
  d.append(knob);

  if (state.editing) {
    enableDrag(d, j, 'joystick');
    d.addEventListener('pointerdown', (e) => { e.preventDefault(); state.selectedId = j.id; renderOverlay(); renderEditor(); });
    return d;
  }

  let active = null;
  const setKnob = (dx, dy) => {
    knob.style.left = `${50 + dx * 30}%`;
    knob.style.top = `${50 + dy * 30}%`;
  };
  const releaseAll = () => {
    for (const k of state.joyKeys) { try { sendKey(k, false); } catch { /* ignore */ } }
    state.joyKeys.clear();
    setKnob(0, 0);
  };
  d.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    d.setPointerCapture?.(e.pointerId);
    active = e.pointerId;
    move(e);
  });
  const move = (e) => {
    if (e.pointerId !== active) return;
    const r = d.getBoundingClientRect();
    let dx = ((e.clientX - (r.left + r.width / 2)) / (r.width / 2));
    let dy = ((e.clientY - (r.top + r.height / 2)) / (r.height / 2));
    const len = Math.hypot(dx, dy) || 1;
    if (len > 1) { dx /= len; dy /= len; }
    // Deadzone + sensitivity
    const dz = j.deadzone ?? 0.25;
    const sens = j.sensitivity ?? 1.2;
    let mx = dx * sens, my = dy * sens;
    if (Math.hypot(mx, my) < dz) { mx = 0; my = 0; }
    if (j.mode === '4dir') {
      if (Math.abs(mx) > Math.abs(my)) my = 0; else mx = 0;
    }
    const th = 0.35;
    const want = new Set();
    if (my < -th && j.keys.up) want.add(j.keys.up);
    if (my > th && j.keys.down) want.add(j.keys.down);
    if (mx < -th && j.keys.left) want.add(j.keys.left);
    if (mx > th && j.keys.right) want.add(j.keys.right);
    for (const k of [...state.joyKeys]) {
      if (!want.has(k)) { try { sendKey(k, false); } catch { /* ignore */ } state.joyKeys.delete(k); }
    }
    for (const k of want) {
      if (!state.joyKeys.has(k)) { try { sendKey(k, true); } catch { /* ignore */ } state.joyKeys.add(k); }
    }
    setKnob(dx, dy);
  };
  d.addEventListener('pointermove', move);
  const up = (e) => { if (e.pointerId === active) { active = null; releaseAll(); } };
  d.addEventListener('pointerup', up);
  d.addEventListener('pointercancel', up);
  return d;
}

function renderTouchpad(p) {
  const d = document.createElement('div');
  d.className = 'vpad' + (state.selectedId === p.id ? ' selected' : '');
  d.style.left = `${p.x}%`;
  d.style.top = `${p.y}%`;
  d.style.width = `${p.w}%`;
  d.style.height = `${p.h}%`;
  d.style.opacity = p.opacity;
  d.textContent = 'touchpad';

  if (state.editing) {
    enableDrag(d, p, 'touchpad');
    d.addEventListener('pointerdown', (e) => { e.preventDefault(); state.selectedId = p.id; renderOverlay(); renderEditor(); });
    return d;
  }

  const pointers = new Map();
  let downAt = 0, downPos = null, moved = 0;
  const sens = (p.sensitivity ?? 1.5) * (state.settings.inputSensitivity || 1);

  d.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    d.setPointerCapture?.(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) { downAt = Date.now(); downPos = { x: e.clientX, y: e.clientY }; moved = 0; }
  });
  d.addEventListener('pointermove', (e) => {
    const last = pointers.get(e.pointerId);
    if (!last) return;
    const dx = (e.clientX - last.x) * sens;
    const dy = (e.clientY - last.y) * sens;
    moved += Math.abs(dx) + Math.abs(dy);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // Move virtual cursor + forward.
    const r = els.frame.getBoundingClientRect();
    state.cursor.x = Math.max(0, Math.min(1, state.cursor.x + dx / r.width));
    state.cursor.y = Math.max(0, Math.min(1, state.cursor.y + dy / r.height));
    const pt = framePoint();
    try { sendMouseMove(pt.x, pt.y); } catch { /* ignore */ }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size > 0) return;
    const dt = Date.now() - downAt;
    // Tap = click (two-finger tap = right click).
    if (dt < 300 && moved < 12 && downPos) {
      const pt = guestPoint(downPos.x, downPos.y);
      const button = e.pointerId !== undefined && movedTwo ? 'right' : 'left';
      try { sendClick(pt.x, pt.y, secondFinger ? 'right' : 'left'); } catch { /* ignore */ }
    }
    secondFinger = false;
  };
  let movedTwo = false, secondFinger = false;
  const origDown = d.onpointerdown;
  d.addEventListener('pointerdown', () => { if (pointers.size >= 2) secondFinger = true; });
  d.addEventListener('pointerup', up);
  d.addEventListener('pointercancel', up);
  void origDown; void movedTwo;
  return d;
}

/* ================= editor ================= */
function keySelect(current) {
  const s = document.createElement('select');
  for (const k of CANONICAL_KEYS) {
    const o = document.createElement('option');
    o.value = k;
    o.textContent = KEY_LABELS[k] ? `${KEY_LABELS[k]} (${k})` : k;
    if (k === current) o.selected = true;
    s.append(o);
  }
  return s;
}

function field(label, control) {
  const d = document.createElement('div');
  d.className = 'ed-field';
  d.append(Object.assign(document.createElement('label'), { textContent: label }), control);
  return d;
}

function slider(min, max, step, value, fmt) {
  const wrap = document.createElement('div');
  const input = document.createElement('input');
  input.type = 'range'; input.min = min; input.max = max; input.step = step; input.value = value;
  const lab = document.createElement('span');
  lab.style.cssText = 'font-size:12px;opacity:.8';
  lab.textContent = fmt(value);
  input.addEventListener('input', () => { lab.textContent = fmt(Number(input.value)); });
  wrap.append(input, lab);
  return { wrap, input };
}

function renderEditor() {
  const body = els['editor-body'];
  body.innerHTML = '';
  // Preset loader options
  const sel = els['ed-preset-load'];
  sel.innerHTML = '';
  const addOpt = (v, l) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = l;
    sel.append(o);
  };
  addOpt('', 'Load preset…');
  for (const [k, v] of Object.entries(CONTROL_PRESETS)) addOpt(`builtin:${k}`, v.label);
  for (const name of Object.keys(state.layouts.global || {})) addOpt(`custom:${name}`, `★ ${name}`);

  const sel2 = findSelected();
  if (!sel2) {
    body.append(Object.assign(document.createElement('p'), { className: 'muted', textContent: 'Click a control to edit it. Drag controls to move them.' }));
    return;
  }
  const { kind, obj } = sel2;
  if (kind === 'button') {
    const name = document.createElement('input');
    name.type = 'text'; name.value = obj.label || '';
    name.addEventListener('input', () => { obj.label = name.value.slice(0, 12); renderOverlay(); });
    body.append(field('Label', name));
    const ks = keySelect(obj.key);
    ks.addEventListener('change', () => { obj.key = ks.value; renderOverlay(); });
    body.append(field('Key / mouse button', ks));
    const size = slider(32, 120, 2, obj.size || 64, (v) => `${v}px`);
    size.input.addEventListener('input', () => { obj.size = Number(size.input.value); renderOverlay(); });
    body.append(field('Size', size.wrap));
    const op = slider(0.15, 1, 0.05, obj.opacity ?? 0.75, (v) => `${Math.round(v * 100)}%`);
    op.input.addEventListener('input', () => { obj.opacity = Number(op.input.value); renderOverlay(); });
    body.append(field('Opacity', op.wrap));
    const row = document.createElement('div');
    row.className = 'editor-actions';
    const dup = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: 'Duplicate' });
    dup.onclick = () => {
      const c = JSON.parse(JSON.stringify(obj));
      c.id = `btn-${Date.now().toString(36)}`;
      c.x = Math.min(95, c.x + 5); c.y = Math.min(95, c.y + 5);
      state.layout.buttons.push(c);
      state.selectedId = c.id;
      renderOverlay(); renderEditor();
    };
    const del = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: 'Delete' });
    del.onclick = deleteSelected;
    row.append(dup, del);
    body.append(row);
  } else if (kind === 'joystick') {
    const mode = document.createElement('select');
    for (const m of ['analog', '4dir', '8dir']) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m === 'analog' ? 'Analog (8-way)' : m === '4dir' ? '4-direction' : '8-direction (digital)';
      if (obj.mode === m) o.selected = true;
      mode.append(o);
    }
    mode.addEventListener('change', () => { obj.mode = mode.value; });
    body.append(field('Mode', mode));
    for (const dir of ['up', 'down', 'left', 'right']) {
      const ks = keySelect(obj.keys[dir]);
      ks.addEventListener('change', () => { obj.keys[dir] = ks.value; });
      body.append(field(`Key: ${dir}`, ks));
    }
    const dz = slider(0, 0.6, 0.05, obj.deadzone ?? 0.25, (v) => String(v));
    dz.input.addEventListener('input', () => { obj.deadzone = Number(dz.input.value); });
    body.append(field('Dead zone', dz.wrap));
    const sn = slider(0.5, 2.5, 0.1, obj.sensitivity ?? 1.2, (v) => `${v}×`);
    sn.input.addEventListener('input', () => { obj.sensitivity = Number(sn.input.value); });
    body.append(field('Sensitivity', sn.wrap));
    const sz = slider(80, 260, 4, obj.size || 150, (v) => `${v}px`);
    sz.input.addEventListener('input', () => { obj.size = Number(sz.input.value); renderOverlay(); });
    body.append(field('Size', sz.wrap));
    const op = slider(0.15, 1, 0.05, obj.opacity ?? 0.7, (v) => `${Math.round(v * 100)}%`);
    op.input.addEventListener('input', () => { obj.opacity = Number(op.input.value); renderOverlay(); });
    body.append(field('Opacity', op.wrap));
    const del = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: 'Delete joystick' });
    del.onclick = deleteSelected;
    body.append(del);
  } else if (kind === 'touchpad') {
    const sn = slider(0.3, 4, 0.1, obj.sensitivity ?? 1.5, (v) => `${v}×`);
    sn.input.addEventListener('input', () => { obj.sensitivity = Number(sn.input.value); });
    body.append(field('Sensitivity', sn.wrap));
    const w = slider(15, 60, 1, obj.w ?? 36, (v) => `${v}%`);
    w.input.addEventListener('input', () => { obj.w = Number(w.input.value); renderOverlay(); });
    body.append(field('Width', w.wrap));
    const h = slider(15, 60, 1, obj.h ?? 32, (v) => `${v}%`);
    h.input.addEventListener('input', () => { obj.h = Number(h.input.value); renderOverlay(); });
    body.append(field('Height', h.wrap));
    const op = slider(0.1, 0.9, 0.05, obj.opacity ?? 0.3, (v) => `${Math.round(v * 100)}%`);
    op.input.addEventListener('input', () => { obj.opacity = Number(op.input.value); renderOverlay(); });
    body.append(field('Opacity', op.wrap));
    body.append(Object.assign(document.createElement('p'), { className: 'muted', style: 'font-size:12px', textContent: 'Tap = left click · two-finger tap = right click · drag = move mouse.' }));
    const del = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: 'Delete touchpad' });
    del.onclick = deleteSelected;
    body.append(del);
  }
}

function findSelected() {
  const id = state.selectedId;
  if (!id) return null;
  const b = (state.layout.buttons || []).find((x) => x.id === id);
  if (b) return { kind: 'button', obj: b };
  if (state.layout.joystick && state.layout.joystick.id === id) return { kind: 'joystick', obj: state.layout.joystick };
  if (state.layout.touchpad && state.layout.touchpad.id === id) return { kind: 'touchpad', obj: state.layout.touchpad };
  return null;
}

function deleteSelected() {
  const s = findSelected();
  if (!s) return;
  if (s.kind === 'button') state.layout.buttons = state.layout.buttons.filter((x) => x.id !== s.obj.id);
  else if (s.kind === 'joystick') state.layout.joystick = null;
  else state.layout.touchpad = null;
  state.selectedId = null;
  renderOverlay();
  renderEditor();
}

async function saveLayoutForGame() {
  try {
    await G.invoke('layouts:save-game', gameId, state.layout);
    state.layouts.perGame[gameId] = cloneLayout(state.layout);
    toast('Layout saved for this game.');
  } catch (err) { toast(`Save failed: ${err.message}`); }
}

async function saveAsPreset() {
  const name = promptForPresetName();
  if (!name) return;
  try {
    await G.invoke('layouts:save-preset', name, state.layout);
    state.layouts.global[name] = cloneLayout(state.layout);
    renderEditor();
    toast(`Preset “${name}” saved.`);
  } catch (err) { toast(`Save failed: ${err.message}`); }
}

function promptForPresetName() {
  // Inline mini-dialog (window.prompt is blocked in sandboxed renderers).
  const existing = document.getElementById('preset-name-row');
  if (existing) return null;
  const row = document.createElement('div');
  row.id = 'preset-name-row';
  row.className = 'ed-field';
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Preset name…';
  input.maxLength = 40;
  const ok = Object.assign(document.createElement('button'), { className: 'btn sm primary', textContent: 'Save', style: 'margin-top:6px' });
  ok.onclick = async () => {
    const name = input.value.trim();
    row.remove();
    if (!name) return;
    try {
      await G.invoke('layouts:save-preset', name, state.layout);
      state.layouts.global[name] = cloneLayout(state.layout);
      renderEditor();
      toast(`Preset “${name}” saved.`);
    } catch (err) { toast(`Save failed: ${err.message}`); }
  };
  row.append(Object.assign(document.createElement('label'), { textContent: 'Preset name' }), input, ok);
  els['editor-body'].prepend(row);
  input.focus();
  return null;
}

function loadPresetFromSelect() {
  const v = els['ed-preset-load'].value;
  if (!v) return;
  if (v.startsWith('builtin:')) {
    state.layout = cloneLayout(CONTROL_PRESETS[v.slice(8)]);
  } else if (v.startsWith('custom:')) {
    const c = state.layouts.global[v.slice(7)];
    if (c) state.layout = cloneLayout(c);
  }
  state.selectedId = null;
  renderOverlay();
  renderEditor();
  toast('Preset loaded (unsaved — save it to keep).');
}

function resetLayout() {
  const presetName = state.settings.defaultControlPreset || 'generic';
  state.layout = cloneLayout(CONTROL_PRESETS[presetName] || CONTROL_PRESETS.generic);
  state.selectedId = null;
  renderOverlay();
  renderEditor();
}

/* ================= drawer ================= */
function toggleDrawer() {
  const d = els.drawer;
  d.hidden = !d.hidden;
  if (!d.hidden) renderDrawer();
  else stopPadPoll();
}

function renderDrawer() {
  const g = state.game;
  const b = els['drawer-body'];
  b.innerHTML = '';
  els['drawer-title'].textContent = g.title;

  b.append(Object.assign(document.createElement('h4'), { textContent: 'Session' }));
  b.append(kv('Playing for', elapsedText()));
  b.append(kv('Total playtime', fmtDur(g.playTimeSeconds)));
  b.append(kv('Entry', g.entryFile));

  b.append(Object.assign(document.createElement('h4'), { textContent: 'Network' }));
  const netLabel = document.createElement('label');
  netLabel.style.cssText = 'display:flex;gap:8px;align-items:center;font-size:13px';
  const netBox = document.createElement('input');
  netBox.type = 'checkbox';
  netBox.checked = !!g.blockNetwork;
  netBox.onchange = async () => {
    try {
      await G.invoke('playhub:game-set-network-block', gameId, netBox.checked);
      g.blockNetwork = netBox.checked;
      toast(netBox.checked ? 'Network blocked — reload the game to apply fully.' : 'Network allowed.');
    } catch (err) { toast(err.message); }
  };
  netLabel.append(netBox, 'Offline Sandbox (block internet)');
  b.append(netLabel);
  if (g.network && g.network.hosts && g.network.hosts.length) {
    b.append(kv('Known hosts', g.network.hosts.slice(0, 6).join(', ') + (g.network.hosts.length > 6 ? '…' : '')));
  }

  b.append(Object.assign(document.createElement('h4'), { textContent: 'Game Doctor' }));
  const docOut = document.createElement('div');
  const docBtn = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: 'Run diagnosis' });
  docBtn.onclick = async () => {
    docOut.textContent = 'Analyzing…';
    try {
      const r = await G.invoke('doctor:diagnose', gameId);
      docOut.innerHTML = '';
      for (const c of r.checks) {
        const colors = { ok: '#34d399', warn: '#fbbf24', fail: '#f87171', info: '#60a5fa' };
        const row = document.createElement('div');
        row.style.cssText = 'font-size:12.5px;margin:3px 0';
        row.append(Object.assign(document.createElement('span'), { textContent: '● ', style: `color:${colors[c.status] || '#999'}` }));
        row.append(`${c.name}: ${c.detail || ''}`);
        docOut.append(row);
      }
    } catch (err) { docOut.textContent = `Failed: ${err.message}`; }
  };
  b.append(docBtn, docOut);

  b.append(Object.assign(document.createElement('h4'), { textContent: 'Gamepad test' }));
  b.append(Object.assign(document.createElement('p'), { className: 'muted', style: 'font-size:12px', textContent: 'Real controllers pass straight through to the game. Press buttons to verify yours is seen.' }));
  const padOut = document.createElement('div');
  padOut.id = 'pad-out';
  b.append(padOut);
  startPadPoll(padOut);

  b.append(Object.assign(document.createElement('h4'), { textContent: 'Shortcuts' }));
  const keys = [['F5', 'Reload'], ['F9', 'Virtual controls'], ['F11', 'Fullscreen'], ['F12', 'Screenshot']];
  for (const [k, v] of keys) b.append(kv(k, v));

  if (devMode) {
    const dt = Object.assign(document.createElement('button'), { className: 'btn sm', textContent: 'Open guest DevTools' });
    dt.onclick = () => { try { guest.openDevTools(); } catch { toast('DevTools unavailable.'); } };
    b.append(Object.assign(document.createElement('h4'), { textContent: 'Developer' }), dt);
  }
}

function kv(k, v) {
  const d = document.createElement('div');
  d.className = 'kv';
  d.append(Object.assign(document.createElement('b'), { textContent: k }), String(v));
  return d;
}

function elapsedText() {
  const s = Math.floor((Date.now() - state.sessionStart) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDur(s) {
  s = s || 0;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return s ? `${s}s` : '—';
}

function startPadPoll(out) {
  stopPadPoll();
  const loop = () => {
    const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean);
    out.innerHTML = '';
    if (!pads.length) {
      out.append(Object.assign(document.createElement('p'), { className: 'muted', style: 'font-size:12px', textContent: 'No gamepad detected. Connect one and press any button.' }));
    }
    for (const p of pads.slice(0, 2)) {
      out.append(Object.assign(document.createElement('div'), { style: 'font-size:12.5px;font-weight:700', textContent: `${p.id.slice(0, 40)}` }));
      const grid = document.createElement('div');
      grid.className = 'pad-test';
      p.buttons.forEach((btn, i) => {
        const c = document.createElement('div');
        c.className = 'pad-btn' + (btn.pressed ? ' pressed' : '');
        c.textContent = `B${i}`;
        grid.append(c);
      });
      out.append(grid);
      const axes = document.createElement('div');
      axes.className = 'pad-axis';
      axes.textContent = 'axes: ' + p.axes.map((a) => a.toFixed(2)).join(' ');
      out.append(axes);
    }
  };
  loop();
  state.padPoll = setInterval(loop, 250);
}

function stopPadPoll() {
  if (state.padPoll) { clearInterval(state.padPoll); state.padPoll = null; }
}

async function runFailDoctor() {
  const out = els['fail-doctor-out'];
  out.textContent = 'Analyzing…';
  try {
    const r = await G.invoke('doctor:diagnose', gameId);
    out.innerHTML = '';
    const t = document.createElement('table');
    for (const c of r.checks) {
      const colors = { ok: '#34d399', warn: '#fbbf24', fail: '#f87171', info: '#60a5fa' };
      const tr = document.createElement('tr');
      const td1 = document.createElement('td');
      td1.append(Object.assign(document.createElement('span'), { textContent: '● ', style: `color:${colors[c.status]}` }), c.name);
      const td2 = document.createElement('td');
      td2.textContent = c.detail || '';
      tr.append(td1, td2);
      t.append(tr);
    }
    out.append(t);
  } catch (err) { out.textContent = `Diagnosis failed: ${err.message}`; }
}

boot();
