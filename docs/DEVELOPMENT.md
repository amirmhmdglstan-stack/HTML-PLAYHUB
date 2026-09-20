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
| `npm test` | 38 unit/integration tests (`node --test`) |
| `node tools/smoke-install.mjs` | headless E2E: file/assets/zip installs, integrity, backup→uninstall→restore |
| `node tools/audit-catalog.mjs [--check-urls]` | catalog quality gate (+ download-link liveness with the flag) |
| `node tools/build-catalog.mjs [--fresh]` | regenerate `catalog/catalog.json` from `tools/catalog-sources.json` (clones into `.tools-cache/`) |

| `node tools/build-attribution.mjs` | regenerate `docs/GAMES_ATTRIBUTION.md` |
| `node tools/make-icon.mjs` | regenerate `assets/icon.png` + `assets/icon.ico` |
| `npm run pack` | electron-builder `--dir` (unpacked, for inspection) |
| `npm run dist` | Windows: NSIS setup + portable + zip into `release/` |

Order matters when curating games: **catalog → attribution → audit → audit --check-urls**.

## CI / releases (GitHub Actions)

`.github/workflows/build.yml`:

- `test` (Linux, every push): `npm ci`, `npm test`, audit, URL-liveness check, smoke install.
- `build-win` (Windows; every push, tags, manual dispatch): audit,
  `electron-builder --win` (NSIS + portable + zip), SHA-256 checksums, artifact upload.
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
- `catalog/catalog.json` is generated but **committed** (it is the shipped Discover catalog).
