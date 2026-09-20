# Privacy

HTML Playhub is **local-first**. There are no accounts, no analytics, no
telemetry, no crash reporting, and no background uploads of any kind.

## What stays on your PC (always)

- Game files, library index, settings, control layouts
- Game saves (per-game Chromium partitions), screenshots, backups, notes, tags
- Playtime statistics and history

None of this is transmitted anywhere unless **you** explicitly export a file.

## Network traffic Playhub itself can make

| Action | When | Destination |
|---|---|---|
| Game download (Discover/URL import) | only when you click Install/import a URL | the game's host (e.g. `raw.githubusercontent.com`) |
| Catalog refresh | only via “Update catalog” button or opt-in auto-check (off by default) | `raw.githubusercontent.com` (this repo) |
| App update check | only via “Check now” or opt-in auto-check (off by default) | `api.github.com` (this repo's releases) |

## Network traffic *games* can make

Some games load libraries (e.g. Three.js) or analytics from CDNs. Playhub:

1. Detects this statically (Game Doctor → “External hosts”),
2. Badges online games in the library (`Online` vs `Offline`),
3. Offers a per-game **Offline Sandbox** that blocks all game network requests
   (auto-enabled for installed games containing trackers, suggested during import).

External links inside games open in your OS browser, never silently.

## Verification

- Search the source for `http`: all outbound destinations are listed above or
  come from game files / catalog data you can inspect (`catalog/catalog.json`).
- Run the app with no network: library, search, import of local files, play,
  controls, saves, backups, and settings all work offline.
