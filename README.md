# HTML Playhub 🎮

**A Steam-style offline library & launcher for HTML/web games — for Windows.**

HTML Playhub ships with **no preinstalled games**. Instead, its Discover
catalog lists **615 games from 20 sources** — every one a direct download from
its original host. One click downloads the game file and installs it **straight
into your library's game files** — never into some downloads folder. You can
also import your own `.html` files, folders, ZIPs, or URLs.

- 🧭 **615 direct-download games**: 90s Games, Mini Browser Games, Offline HTML
  Games Pack (300), Voxelcraft, Operation Ironhold, Nightdrive, Blue Run,
  Tetris, DOOM/MicroDOOM, Web Demos, The Arcade, Backdooms, Reversi, Backgammon,
  MARKVD, Local Games, EagleCraft, and more — pinned URLs, verified by CI
- 📥 **Install = game files.** Downloads stage in temp and land directly in the
  library; failed installs leave nothing behind. Multi-file games download
  their assets too.
- 🕹 **Real player**: sandboxed per-game, fullscreen, zoom, aspect frames,
  screenshots, per-game saves, crash recovery that never takes the launcher down
- 🎛 **Virtual controls**: customizable buttons, analog joystick, touchpad,
  per-game layouts, presets (FPS / Platformer / Top-down / Generic)
- 🔍 **Library done right**: search, filters, sorting, collections, favorites,
  playtime tracking, notes, tags, backups with save snapshots
- 🔒 **Local-first**: no accounts, no analytics, no uploads — ever

## Download

Get the Windows build from the
[**Releases page**](https://github.com/amirmhmdglstan-stack/HTML-PLAYHUB/releases)
or from any successful **GitHub Actions** run (artifacts):

| File | What it is |
|---|---|
| `HTML Playhub-*-Setup.exe` | Installer (Start Menu + desktop shortcuts) |
| `HTML Playhub-*-Portable.exe` | Portable — keeps `data/` next to the exe |
| `HTML Playhub-*-win-x64.zip` | Plain ZIP of the app |
| `checksums.txt` | SHA-256 checksums |

No admin rights needed for the portable build.

## Features

### Discover
Every entry is a **direct download link** (pinned to a specific commit, so links
don't rot). Click Install: the game file — plus any assets it needs — downloads
with progress, is analyzed, and installs straight into your library. Games with
trackers are auto-sandboxed. Filter the catalog, update it from the repo, and
everything keeps working offline afterwards.

### Library
Home (continue playing, recently added, favorites, stats), All Games,
Favorites, Recently Played, custom Collections (+ automatic source collections),
grid/list views, instant search across titles/authors/genres/tags/descriptions,
filters (favorites, single-file, offline, genre), 7 sort orders,
🎲 Surprise Me, keyboard navigation (`/` to search, `Ctrl+R` random, `Ctrl+O` import).

### Importer (manual adds)
5-step wizard: **Choose → Analyze → Review → Install → Done**.
Handles `.html`/`.htm`, folders, `.zip` (safe extraction: traversal blocked, size
caps, single-root unwrap, junk skipped), and direct URLs. Intelligent entry-point
detection (not just `index.html`), title/artwork/genre/license detection,
compatibility report, and an Offline-Sandbox default when trackers are found.
URL imports download into temp and install into the library — like Discover,
nothing is left in a downloads folder.

### Player
Each game runs in its own **sandboxed webview** with a **per-game storage
partition** (localStorage/IndexedDB/cookies never leak between games) on an
isolated `playhub-game://` origin (games can't touch your filesystem).
Fullscreen, reload, zoom (25–300%), aspect frames, screenshots (F12),
crash/fail veils with **Game Doctor** + technical details, per-game network
sandbox toggle, and dev tools in developer mode.

### Virtual controls
Overlay buttons (proper key-down while held, key-up on release), configurable
joystick (analog / 4-dir / 8-dir, dead zone, sensitivity), touchpad (move, tap =
click, two-finger tap = right click), full layout editor (move, resize, opacity,
rename, key/mouse assignment, duplicate, delete, per-game save, named presets).
Real gamepads pass straight through (Gamepad API) with a built-in tester.

### Saves & backups
`.playhub.zip` backups contain game files + manifest + stats/notes + artwork +
a save snapshot (when the game is closed). Restore never overwrites without
confirmation and snapshots existing saves first. Library data (index, settings,
layouts) exports/imports as one ZIP for moving PCs.

### Offline-first
Everything except downloading new games and update checks works offline.
The catalog ships with the app; remote refresh is manual/opt-in.

## Adding games

- **One click**: Discover → Install. The file comes from the original host
  (GitHub, the author's site) — never re-hosted by us.
- **Manually**: Import → file / folder / ZIP / URL, or drag & drop anywhere.
- **From a Git repo**: Code → Download ZIP → import the ZIP.
- **Format details**: see [docs/GAME_FORMAT.md](docs/GAME_FORMAT.md).

## Game licenses & attribution

Games keep their own licenses (MIT, GPL-3.0, or **Unknown** when the author
states none). Playhub only *links* to the original hosts — it does not
re-host game files. Unknown-license games are for your personal use; don't
re-share those files. Full list: [docs/GAMES_ATTRIBUTION.md](docs/GAMES_ATTRIBUTION.md).

The launcher itself is **MIT licensed** (see [LICENSE](LICENSE)).

## Building

```bash
npm ci
npm test                    # 38 unit/integration tests
node tools/audit-catalog.mjs            # catalog quality gate
node tools/audit-catalog.mjs --check-urls  # verify every download link (needs internet)
node tools/smoke-install.mjs            # headless install/backup E2E
npm run dist                # Windows: NSIS + portable + zip into release/
```

`npm run dist` must run on Windows (or CI) for the `.exe` targets.
CI builds Windows artifacts on every push to the branch, and tags `v*`
automatically become GitHub Releases.
See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for the full workflow.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — systems & data flow
- [docs/GAME_FORMAT.md](docs/GAME_FORMAT.md) — manifest schema, adding games
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — dev setup, scripts, releases
- [docs/GAMES_ATTRIBUTION.md](docs/GAMES_ATTRIBUTION.md) — every game + license
- [docs/PRIVACY.md](docs/PRIVACY.md) — what leaves your PC (nothing, by default)

## Privacy

Local-first: no accounts, no telemetry, no analytics, no uploads.
The only network traffic is what **you** trigger (game downloads, catalog/update
checks) plus whatever an individual game loads (flagged by Game Doctor, blockable
per game). Details in [docs/PRIVACY.md](docs/PRIVACY.md).
