# Architecture

HTML Playhub is an **Electron** desktop app (Windows-first) with **zero native
Node dependencies** (only `adm-zip`, pure JS) so the Windows build can never
fail on compilers/prebuilts. No frontend bundler: the UI is ES modules served
over a custom protocol.

```text
┌─ Main process (Node, src/main/) ────────────────┐
│ main.js      lifecycle, windows, IPC, installs │
│ games.js     install/uninstall/integrity        │
│ importer.js  analyze + install pipeline         │
│ doctor.js    static compatibility analysis      │
│ downloader.js progress/cancel/retry downloads   │
│ backups.js   backup/restore/export              │
│ store.js     JSON document DB (atomic writes)   │
│ protocol.js  playhub-app:// + playhub-game://   │
│ game-window.js sandboxed player windows         │
│ catalog.js   Discover catalog (shipped/cached)  │
│ paths.js     installed vs portable data dirs    │
└─────────────────────────────────────────────────┘
          │ contextBridge IPC (src/preload/)
┌─ Launcher window ──────────┐  ┌─ Player window(s) ──────┐
│ index.html + js/app.js     │  │ game.html + js/game.js  │
│ views: home/library/       │  │  ┌─ <webview> ────────┐ │
│ details/discover/import/   │  │  │ game @ playhub-    │ │
│ collections/settings       │  │  │ game:// (isolated, │ │
│                            │  │  │ per-game partition)│ │
└────────────────────────────┘  │  └────────────────────┘ │
                                │  overlay controls/editor │
                                └──────────────────────────┘
```

## Key design decisions

- **Two custom protocols.** `playhub-app://` serves the launcher UI (so ES
  modules work without `file://` CORS pain); `playhub-game://game/<id>/…`
  serves one game folder with traversal protection. Games get an opaque origin:
  no `file://` access, no cross-game storage access, manifest/sidecars never
  served.
- **Webview-per-game isolation.** The game runs in a `<webview>` guest with
  `partition="persist:playhub-<id>"` (separate localStorage/IndexedDB/cookies
  per game) and no Node access. A game crash (`crashed`, `did-fail-load`) only
  kills the guest; the player window shows recovery UI (Reload / Exit /
  Game Doctor / Technical details).
- **JSON document DB, not SQLite.** For a game library (even 10k games) an
  indexed in-memory JSON store with atomic temp-file+rename writes is faster to
  build, easier to debug, trivially portable — and removes all native build
  risk. Metadata is cached; the app never rescans game files at startup.
- **Static analysis, never execution.** The doctor/importer only read files as
  text (resource-host detection, input/storage/tech hints, entry scoring).
- **Privacy by construction.** Trackers detected → Offline Sandbox suggested
  (auto-enabled for installed games with trackers). Network policy enforced per
  partition via `webRequest.onBeforeRequest`.
- **Virtual controls via input injection.** Overlay buttons/joystick/touchpad in
  the player window call `webview.sendInputEvent` (keyDown/keyUp/mouse*).
  Real gamepads need no code — the Gamepad API passes through to the guest.

## Data layout

Installed mode: `%APPDATA%/HTML Playhub/` · Portable: `<exe-dir>/data/`

```text
playhub.json            # games index, collections, sessions, downloads, meta
settings.json           # all settings (theme … developer mode)
control-layouts.json    # per-game layouts + named presets
games/<id>/             # game files + playhub.manifest.json
thumbnails/<id>.*       # artwork cache
screenshots/<id>/*.png  # F12 captures (local only)
backups/*.playhub.zip   # full backups incl. save snapshots
cache/ downloads/ temp/ logs/
```

Chromium partitions (live saves) live under Electron's `userData/Partitions/`.

## IPC surface

Preloads expose allow-listed channels only (`main-preload.js`,
`game-preload.js`); anything else is rejected. Main handlers live in `main.js`
+ `game-window.js`. Guest web content has **no** bridge access.

## Adding to the codebase

- New compatibility rule → `src/main/doctor.js` (+ tests in `tests/`).
- New control preset → `CONTROL_PRESETS` in `src/renderer/js/controls.js`.
- New game source → `tools/catalog-sources.json` + catalog/attribution/audit (see DEVELOPMENT).
- New setting → `DEFAULT_SETTINGS` (`store.js`) + UI in `view-settings.js` +
  apply in `app.js` `applySettings()`.
- New view → `src/renderer/js/view-*.js` + route in `app.js` nav.
