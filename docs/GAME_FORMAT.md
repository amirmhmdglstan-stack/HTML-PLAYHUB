# Game Format — `playhub.manifest.json`

A Playhub game is a **folder** containing the game's original files plus one
sidecar: `playhub.manifest.json`. Single-file games are just a folder with one
`.html` file — the launcher never forces multi-file games into one file.

```text
games/<game-id>/
├── index.html            # or game.html, or any entry page
├── js/, css/, assets/…   # kept exactly as the game ships them
└── playhub.manifest.json # Playhub metadata (never served to the game)
```

## Manifest schema (v1)

```json
{
  "manifestVersion": 1,
  "id": "example-game",
  "title": "Example Game",
  "description": "What the game is about.",
  "author": "Author Name",
  "source": { "repo": "https://github.com/…", "homepage": "https://…", "path": "games/x.html" },
  "license": { "spdx": "MIT", "file": "collection-LICENSE.txt", "url": "https://…" },
  "version": "1.0",
  "genres": ["Arcade"],
  "tags": ["searchable", "keywords"],
  "language": "en",
  "entryFile": "index.html",
  "singleFile": false,
  "qualityTier": null,
  "sourceCollection": "90s Games",
  "controls": { "keyboard": true, "mouse": true, "touch": false, "gamepad": false, "notes": "" },
  "requirements": { "keyboard": false, "mouse": false, "landscape": false },
  "network": { "required": false, "hosts": [], "trackers": [] },
  "addedAt": "2026-09-20T00:00:00.000Z",
  "updatedAt": "2026-09-20T00:00:00.000Z"
}
```

| Field | Required | Rules |
|---|---|---|
| `id` | yes | `^[a-z0-9][a-z0-9-_]{0,80}$`, unique, doubles as the folder name |
| `title` | yes | 1–120 chars |
| `entryFile` | yes | relative path inside the folder; `..` and absolute paths rejected |
| `license.spdx` | no (warn) | SPDX id or `Unknown`; `Unknown` = personal use, do not redistribute |
| everything else | no | validated loosely; **unknown fields are preserved** for forward compat |

Validation lives in `src/main/manifest.js` (`validateManifest`).

## Adding games (users)

- **App UI**: Import wizard or drag & drop. The importer writes the manifest.
- **By hand**: create `games/<id>/`, drop files in, add a manifest, restart the
  app (or use Settings → Storage → integrity check). Missing manifests can be
  regenerated per game (Details → Launch Settings → Regenerate manifest).

## Adding games (developers / curators)

Playhub ships no games — the Discover catalog is the library. To add a source:

1. Add it to `tools/catalog-sources.json` (`glob` for collections,
   `files` + `assets` for one-offs and multi-file games, `direct` for
   single-file sites and zips).
2. `node tools/build-catalog.mjs` → clones/analyzes, regenerates
   `catalog/catalog.json` with pinned download URLs. Fails on any invalid
   entry (missing file, non-HTML, undeclared local assets, duplicate id).
3. `node tools/build-attribution.mjs` → regenerates the attribution doc.
4. `node tools/audit-catalog.mjs` → must pass with 0 errors.
5. `node tools/audit-catalog.mjs --check-urls` → verifies every download link.

The catalog only *links* to original hosts (pinned commit URLs) — game files
are never copied into this repo. If a game needs network (CDN), the builder
records it; the app discloses it and offers per-game sandboxing. Games whose
entries need local files must declare them as `assets` (downloaded together
with the entry, same layout) or they fail validation.

## Control layouts

Stored separately from games (`control-layouts.json`), keyed per game id with
global named presets:

```json
{
  "perGame": { "<game-id>": { "buttons": [...], "joystick": {...}|null, "touchpad": {...}|null } },
  "global": { "<preset-name>": { "...": "..." } }
}
```

- Button: `{ id, label, key, x, y, size, opacity }` (`x/y` in % of stage,
  `size` in px). `key` is a canonical key from `src/renderer/js/controls.js`
  (`W`, `Up`, `Space`, `MouseLeft`, …).
- Joystick: `{ id, x, y, size, mode, deadzone, sensitivity, opacity, keys: {up,down,left,right} }`.
- Touchpad: `{ id, x, y, w, h, sensitivity, opacity }` (`w/h` in %).

Built-in presets live in `CONTROL_PRESETS` (`controls.js`); add a new preset by
adding an entry there — it automatically appears in Settings and the player.

## Backups (`.playhub.zip`)

```text
game/            # full game folder incl. manifest
meta.json        # { kind:'html-playhub-backup', gameId, record:{stats,notes,tags,…} }
thumbnail.*      # artwork (if any)
saves/           # storage-partition snapshot (only when game closed)
```

Restore validates `meta.json`, refuses to overwrite without consent, and moves
existing saves aside (`.pre-restore-*`) before replacing them.
