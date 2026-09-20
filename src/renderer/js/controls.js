/* controls.js — virtual-control presets + canonical key list (shared by player & settings). */
export const CANONICAL_KEYS = [
  'W', 'A', 'S', 'D', 'Up', 'Down', 'Left', 'Right',
  'Space', 'Enter', 'Shift', 'Ctrl', 'Alt', 'Escape', 'Tab', 'Backspace',
  'Q', 'E', 'R', 'F', 'Z', 'X', 'C', 'V', 'P', 'M', 'L', 'K', 'J', 'I', 'O', 'B', 'N', 'T', 'Y', 'U', 'G', 'H',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'MouseLeft', 'MouseRight', 'MouseMiddle',
];

export const KEY_LABELS = {
  Up: '↑', Down: '↓', Left: '←', Right: '→', Space: 'Space', Escape: 'Esc',
  MouseLeft: 'Click', MouseRight: 'R-Click', MouseMiddle: 'M-Click',
};

/** Map canonical key -> Electron sendInputEvent keyCode. */
export function keyCodeFor(canonical) {
  if (/^[A-Z0-9]$/.test(canonical)) return canonical.toLowerCase();
  const map = {
    Up: 'Up', Down: 'Down', Left: 'Left', Right: 'Right',
    Space: 'Space', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Backspace: 'Backspace',
    Shift: 'Shift', Ctrl: 'Control', Alt: 'Alt',
  };
  if (map[canonical]) return map[canonical];
  if (/^F\d{1,2}$/.test(canonical)) return canonical;
  return null;
}

export function isMouseKey(canonical) {
  return canonical === 'MouseLeft' || canonical === 'MouseRight' || canonical === 'MouseMiddle';
}

export function mouseButtonFor(canonical) {
  return canonical === 'MouseLeft' ? 'left' : canonical === 'MouseRight' ? 'right' : 'middle';
}

function btn(id, label, key, x, y, size = 64, opacity = 0.75) {
  return { id, label, key, x, y, size, opacity };
}

export const CONTROL_PRESETS = {
  generic: {
    label: 'Generic (arrows + Space + Enter)',
    buttons: [
      btn('up', '↑', 'Up', 8, 62), btn('left', '←', 'Left', 2.5, 74),
      btn('right', '→', 'Right', 13.5, 74), btn('down', '↓', 'Down', 8, 86),
      btn('a', 'Space', 'Space', 86, 74, 72), btn('b', 'Enter', 'Enter', 76, 86, 64),
    ],
    joystick: null, touchpad: null,
  },
  platformer: {
    label: 'Platformer (arrows + Space + Shift)',
    buttons: [
      btn('left', '←', 'Left', 3, 76, 72), btn('right', '→', 'Right', 13, 76, 72),
      btn('jump', 'Jump', 'Space', 86, 74, 78), btn('run', 'Run', 'Shift', 75, 86, 64),
      btn('up', '↑', 'Up', 8, 62, 56), btn('down', '↓', 'Down', 8, 88, 56),
    ],
    joystick: null, touchpad: null,
  },
  fps: {
    label: 'FPS (WASD + mouse + Space + Shift)',
    buttons: [
      btn('w', 'W', 'W', 8, 62), btn('a', 'A', 'A', 2.5, 74),
      btn('d', 'D', 'D', 13.5, 74), btn('s', 'S', 'S', 8, 86),
      btn('jump', 'Jump', 'Space', 70, 86, 68), btn('sprint', 'Run', 'Shift', 61, 86, 60),
      btn('fire', 'Fire', 'MouseLeft', 86, 62, 72), btn('aim', 'Aim', 'MouseRight', 86, 76, 64),
      btn('reload', 'R', 'R', 76, 62, 56),
    ],
    joystick: null,
    touchpad: { id: 'look', x: 62, y: 40, w: 34, h: 30, sensitivity: 1.6, opacity: 0.35 },
  },
  topdown: {
    label: 'Top-down (WASD + mouse)',
    buttons: [
      btn('w', 'W', 'W', 8, 62), btn('a', 'A', 'A', 2.5, 74),
      btn('d', 'D', 'D', 13.5, 74), btn('s', 'S', 'S', 8, 86),
      btn('act', 'Act', 'MouseLeft', 86, 74, 76), btn('alt', 'Alt', 'MouseRight', 76, 86, 64),
      btn('space', 'Space', 'Space', 86, 88, 60),
    ],
    joystick: null, touchpad: null,
  },
  stick: {
    label: 'Joystick + buttons',
    buttons: [
      btn('a', 'A', 'Space', 86, 74, 72), btn('b', 'B', 'Shift', 76, 86, 64),
      btn('start', '⏎', 'Enter', 91, 88, 52),
    ],
    joystick: { id: 'stick', x: 4, y: 66, size: 150, mode: 'analog', deadzone: 0.25, sensitivity: 1.2, opacity: 0.7, keys: { up: 'Up', down: 'Down', left: 'Left', right: 'Right' } },
    touchpad: null,
  },
};

export function cloneLayout(layout) {
  return JSON.parse(JSON.stringify(layout));
}

export function newJoystick() {
  return { id: `joy-${Date.now().toString(36)}`, x: 6, y: 64, size: 150, mode: 'analog', deadzone: 0.25, sensitivity: 1.2, opacity: 0.7, keys: { up: 'W', down: 'S', left: 'A', right: 'D' } };
}

export function newTouchpad() {
  return { id: `pad-${Date.now().toString(36)}`, x: 60, y: 45, w: 36, h: 32, sensitivity: 1.5, opacity: 0.3 };
}

export function newButton() {
  return btn(`btn-${Date.now().toString(36)}`, 'A', 'Space', 45, 70, 64, 0.75);
}
