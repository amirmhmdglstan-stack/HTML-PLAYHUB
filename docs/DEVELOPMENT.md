# Development

## Prerequisites

- Node.js 22+ and npm
- Windows for packaging `.exe` (or use CI); Linux/macOS run everything else

## Setup

```bash
npm ci
npm start            # run the app (needs a display / Electron binary)
npm run dev          # same, with DevTools open
```

Portable dev data: `npm start -- --portable` (or set `HTML_PLAYHUB_PORTABLE=1`)
keeps everything in `./data/` instead of `%APPDATA%`.

## Scripts

| Command | What it does |
|---|---|
| `npm test` | 34 unit/integration tests (`node --test`) |
| `node tools/smoke-seed.mjs` | headless E2E: seed 235 games, integrity, backup→uninstall→restore |
| `node tools/audit-games.mjs` | quality gate: manifests, licenses, doctor pass, catalog schema |
| `node tools/fetch-games.mjs [--fresh]` | regenerate `bundled-games/` from `tools/bundle-sources.json` |
| `node tools/build-catalog.mjs` | regenerate `catalog/catalog.json` |
| `node tools/build-attribution.mjs` | regenerate `docs/GAMES_ATTRIBUTION.md` |
| `node tools/make-icon.mjs` | regenerate `assets/icon.png` + `assets/icon.ico` |
| `npm run pack` | electron-builder `--dir` (unpacked, for inspection) |
| `npm run dist` | Windows: NSIS setup + portable + zip into `release/` |

Order matters when curating games: **fetch → catalog → attribution → audit**.

## CI / releases (GitHub Actions)

`.github/workflows/build.yml`:

- `test` (Linux, every push): `npm ci`, `npm test`, audit, smoke seed.
- `build-win` (Windows; on `main`, tags, manual dispatch): full game fetch
  (includes direct downloads unavailable in restricted sandboxes), catalog,
  audit, `electron-builder --win`, SHA-256 checksums, artifact upload.
- `release` (on tags `v*`): attaches `.exe`/`.zip`/`checksums.txt` to a GitHub
  Release with generated notes.

**No pull requests are used in this project.** Work lands directly on branches;
releases are cut by tagging (`git tag v1.0.0 && git push origin v1.0.0`).

Manual build of any branch without tagging:

```bash
gh workflow run build.yml --ref <branch>
gh run watch <id> && gh run download <id>
```

## Conventions

- Main process: CommonJS (`src/main/`), no Electron imports in
  `util.js`/`doctor.js`/`manifest.js`/`store.js` so tools and tests run under
  plain Node.
- Renderer: vanilla ES modules, no bundler, no webfonts, no CDNs.
- Tests: colocated by area in `tests/test-*.js`, hermetic (tmp dirs, localhost
  HTTP only).
- Never commit `data/`, `.tools-cache/`, `release/`, or `node_modules/`.
- `bundled-games/` is generated but **committed** (it is the shipped library).
