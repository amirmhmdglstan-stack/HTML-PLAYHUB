'use strict';
/**
 * importer.js — the automatic game importer pipeline.
 *
 *   source (html file | folder | zip | url)
 *     -> stage into temp dir
 *     -> analyze (doctor engine)
 *     -> build a review report + suggested manifest
 *     -> install (user-confirmed) via games.finalizeInstall
 *
 * Safety: zips are extracted defensively (no absolute paths, no traversal,
 * file-count and size caps, junk files skipped).
 */
const fs = require('node:fs');
const path = require('node:path');
const { scope } = require('./log');
const { walkFiles, titleize, slugify, safeJoin, isHtmlFile, formatBytes } = require('./util');
const { analyzeDirectory, readTextCapped, extractTitle } = require('./doctor');
const { download } = require('./downloader');
const { uniqueGameId, finalizeInstall } = require('./games');

const log = scope('importer');

const ZIP_LIMITS = { maxFiles: 20000, maxBytes: 2 * 1024 * 1024 * 1024, maxFileBytes: 500 * 1024 * 1024 };

function newStagingDir(tempDir) {
  const dir = path.join(tempDir, `stage-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupStaging(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/** Defensively extract a zip with adm-zip. Returns extracted root (unwraps single top folder). */
function extractZipSafe(zipPath, destDir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries().filter((e) => !e.isDirectory);
  if (entries.length > ZIP_LIMITS.maxFiles) throw new Error(`ZIP contains too many files (${entries.length}).`);
  let total = 0;
  const written = [];
  for (const e of entries) {
    let name = e.entryName.replace(/\\/g, '/');
    // Strip drive letters / leading slashes.
    name = name.replace(/^[a-zA-Z]:/, '').replace(/^\/+/, '');
    if (!name || name.includes('..')) continue;
    const parts = name.split('/').filter((p) => p && p !== '.' && p !== '..');
    if (!parts.length) continue;
    if (parts.includes('__MACOSX') || parts[parts.length - 1].startsWith('._')) continue;
    const target = safeJoin(destDir, ...parts);
    if (!target) continue;
    const data = e.getData();
    if (data.length > ZIP_LIMITS.maxFileBytes) throw new Error(`File too large in ZIP: ${name}`);
    total += data.length;
    if (total > ZIP_LIMITS.maxBytes) throw new Error('ZIP contents exceed the 2 GB safety limit.');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push(target);
  }
  if (!written.length) throw new Error('ZIP contained no usable files.');
  // Unwrap a single top-level folder (GitHub zips, exported folders, ...).
  const top = new Set();
  for (const w of written) top.add(path.relative(destDir, w).split(path.sep)[0]);
  if (top.size === 1) {
    const only = path.join(destDir, [...top][0]);
    try {
      if (fs.statSync(only).isDirectory()) {
        // Only unwrap when the inner dir actually contains the game (html inside).
        const inner = fs.readdirSync(only);
        if (inner.some((n) => isHtmlFile(n)) || inner.some((n) => { try { return fs.statSync(path.join(only, n)).isDirectory(); } catch { return false; } })) {
          return only;
        }
      }
    } catch { /* keep destDir */ }
  }
  return destDir;
}

async function stageSource(paths, source, onProgress = null) {
  // source: { kind: 'html'|'folder'|'zip'|'url', path?, url? }
  const staging = newStagingDir(paths.temp);
  try {
    if (source.kind === 'html') {
      if (!fs.existsSync(source.path)) throw new Error('File not found: ' + source.path);
      const base = path.basename(source.path);
      fs.copyFileSync(source.path, path.join(staging, base));
      return { root: staging, staging, cleanup: true, origin: 'file' };
    }
    if (source.kind === 'folder') {
      if (!fs.existsSync(source.path)) throw new Error('Folder not found: ' + source.path);
      const st = fs.statSync(source.path);
      if (!st.isDirectory()) throw new Error('Not a folder: ' + source.path);
      const { copyDirSync } = require('./games');
      copyDirSync(source.path, staging, { skip: (n) => n === '__MACOSX' || n === '.git' || n === 'playhub.manifest.json' });
      return { root: staging, staging, cleanup: true, origin: 'folder' };
    }
    if (source.kind === 'zip') {
      if (!fs.existsSync(source.path)) throw new Error('File not found: ' + source.path);
      const root = extractZipSafe(source.path, staging);
      return { root, staging, cleanup: true, origin: 'zip' };
    }
    if (source.kind === 'url') {
      const url = String(source.url || '').trim();
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs can be imported.');
      const dlDir = path.join(paths.downloads, `import-${Date.now().toString(36)}`);
      fs.mkdirSync(dlDir, { recursive: true });
      const isZip = /\.zip(\?|$)/i.test(url) || /\/archive\/|\/releases\/download\//i.test(url);
      const destFile = path.join(dlDir, isZip ? 'game.zip' : 'game.html');
      await download({
        url, destFile,
        onProgress: onProgress ? (r, t) => onProgress({ phase: 'download', received: r, total: t }) : null,
      });
      if (isZip) {
        const root = extractZipSafe(destFile, staging);
        return { root, staging, cleanup: true, origin: 'url', downloadedFile: destFile };
      }
      fs.copyFileSync(destFile, path.join(staging, 'game.html'));
      return { root: staging, staging, cleanup: true, origin: 'url', downloadedFile: destFile };
    }
    throw new Error('Unknown import source kind.');
  } catch (err) {
    cleanupStaging(staging);
    throw err;
  }
}

const GENRE_KEYWORDS = [
  [/tetris|block|brick|breakout|arkanoid|puzzle|match.?3|sokoban|sudoku|minesweeper|2048|jigsaw|maze|memory|simon|sliding/i, 'Puzzle'],
  [/racer|racing|drive|drift|car\b|moto|kart/i, 'Racing'],
  [/shooter|shump|bullet|invaders|defen[cs]e|tower|fps|gun|zombie|horde|sniper|tank|war|battle/i, 'Action'],
  [/platform|hopper|jump|runner|run\b|dash/i, 'Platformer'],
  [/rpg|roguel|dungeon|quest|adventure|idle|tactics|strategy|chess|card|poker|solitaire|blackjack/i, 'Strategy'],
  [/pong|tennis|soccer|football|basket|golf|hockey|billiards|pinball|sport/i, 'Sports'],
  [/snake|pac|frogger|retro|arcade|8.?bit|pixel|neon/i, 'Arcade'],
  [/sim|tycoon|farm|city|manager|survival|craft|build/i, 'Simulation'],
  [/music|rhythm|beat|piano|audio/i, 'Music'],
  [/horror|scary|backroom/i, 'Horror'],
  [/math|word|quiz|typing|educat|learn/i, 'Educational'],
];

function guessGenres(title, filename) {
  const hay = `${title} ${filename}`;
  const out = [];
  for (const [re, genre] of GENRE_KEYWORDS) {
    if (re.test(hay) && !out.includes(genre)) out.push(genre);
  }
  return out.slice(0, 3);
}

function detectLanguage(text) {
  // Cheap heuristic: CJK share + common markers.
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u4e00-\u9fff]/.test(text)) {
    const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk > 30) return 'zh-CN';
  }
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  return 'en';
}

/**
 * Analyze a staged (or installed) game root. Returns the import review report.
 */
async function analyzeRoot(root, { sourceLabel = '', filenameHint = '' } = {}) {
  const { files, totalBytes } = await walkFiles(root);
  // Ignore Playhub sidecars and OS junk for analysis.
  const relevant = files.filter((f) => {
    const b = path.basename(f.path);
    return b !== 'playhub.manifest.json' && b !== '.DS_Store' && b !== 'Thumbs.db' && !b.startsWith('._');
  });
  const analysis = analyzeDirectory(root, relevant);

  let title = (analysis.entry && analysis.entry.title) || null;
  if (!title && filenameHint) title = titleize(path.basename(filenameHint));
  if (!title && analysis.entry) title = titleize(path.basename(analysis.entry.relative));
  if (!title) title = 'Untitled Game';
  title = String(title).slice(0, 120);

  let sampleText = '';
  if (analysis.entry) {
    try { sampleText = readTextCapped(path.join(root, analysis.entry.relative), 128 * 1024).text; } catch { /* ignore */ }
  }
  const language = detectLanguage(`${title} ${sampleText.slice(0, 20000)}`);
  const genres = guessGenres(title, analysis.entry ? analysis.entry.relative : filenameHint);

  // README / license discovery.
  const readmes = relevant.filter((f) => /readme(\.|$)/i.test(path.basename(f.relative))).slice(0, 3);
  const licenses = relevant.filter((f) => /licen[cs]e|copying|copyright/i.test(path.basename(f.relative))).slice(0, 3);
  let readmeExcerpt = null;
  if (readmes.length) {
    try { readmeExcerpt = readTextCapped(readmes[0].path, 2000).text.slice(0, 1200); } catch { /* ignore */ }
  }

  return {
    sourceLabel,
    title,
    genres,
    language,
    description: analysis.metaDescription || (readmeExcerpt ? readmeExcerpt.slice(0, 500) : ''),
    entry: analysis.entry,
    candidates: analysis.candidates,
    fileCount: analysis.fileCount,
    totalBytes: analysis.totalBytes,
    totalSizeText: formatBytes(analysis.totalBytes),
    singleFile: analysis.singleFile,
    images: analysis.images,
    externalHosts: analysis.externalHosts,
    trackers: analysis.trackers,
    offlineCapable: analysis.offlineCapable,
    input: analysis.input,
    storage: analysis.storage,
    tech: analysis.tech,
    warnings: analysis.warnings,
    errors: analysis.errors,
    readmes: readmes.map((f) => f.relative),
    licenses: licenses.map((f) => f.relative),
    suggestedId: slugify(title, 'game'),
    compatibility: summarizeCompatibility(analysis),
  };
}

function summarizeCompatibility(a) {
  const rows = [];
  const push = (label, status, detail) => rows.push({ label, status, detail });
  push('HTML entry point', a.entry ? 'ok' : 'fail', a.entry ? a.entry.relative : 'none found');
  push('Local assets', a.localRefs.missing.length ? 'warn' : 'ok',
    a.localRefs.missing.length ? `${a.localRefs.missing.length} missing` : 'all references resolve');
  push('Offline capable', a.offlineCapable ? 'ok' : 'warn',
    a.offlineCapable ? 'no remote dependencies' : `${a.externalHosts.length} external host(s)`);
  if (a.offlineCapable && a.linkHosts && a.linkHosts.length) {
    push('External links', 'info', `links out (not loaded): ${a.linkHosts.slice(0, 3).join(', ')}`);
  }
  if (a.input.keyboard) push('Keyboard', 'info', 'keyboard input detected');
  if (a.input.mouse) push('Mouse', 'info', 'mouse input detected');
  if (a.input.touch) push('Touch', 'info', 'touch input detected');
  if (a.input.gamepad) push('Gamepad API', 'info', 'gamepad API usage detected');
  if (a.trackers.length) push('Trackers', 'warn', a.trackers.join(', '));
  if (a.tech.wasm) push('WebAssembly', 'info', 'uses WebAssembly');
  if (a.tech.webgl) push('WebGL', 'info', 'uses WebGL/3D');
  return rows;
}

/**
 * Full pipeline helper used by tools (non-interactive): stage -> analyze -> install.
 */
async function importFromSource({ paths, store, source, manifestOverrides = {}, install = true, onProgress = null }) {
  const staged = await stageSource(paths, source, onProgress);
  try {
    const filenameHint = source.path ? path.basename(source.path) : (source.url || '');
    const report = await analyzeRoot(staged.root, { sourceLabel: filenameHint, filenameHint });
    if (report.errors.length) {
      throw new Error(report.errors.map((e) => e.message).join(' '));
    }
    if (!install) return { staged, report, record: null };
    const gameId = uniqueGameId(paths, store, manifestOverrides.id || report.suggestedId);
    const record = finalizeInstall({
      paths, store,
      stagingDir: staged.root,
      gameId,
      manifestOverrides: {
        title: report.title,
        description: (report.description || '').slice(0, 2000),
        entryFile: report.entry.relative,
        singleFile: report.singleFile,
        genres: report.genres,
        language: report.language,
        controls: {
          keyboard: report.input.keyboard, mouse: report.input.mouse,
          touch: report.input.touch, gamepad: report.input.gamepad,
        },
        requirements: { keyboard: report.input.keyboard && !report.input.mouse && !report.input.touch, mouse: false, landscape: false },
        network: { required: !report.offlineCapable, hosts: report.externalHosts },
        ...manifestOverrides,
      },
      thumbnailSrc: report.images.length ? path.join(staged.root, report.images[0]) : null,
      origin: staged.origin,
    });
    return { staged, report, record };
  } finally {
    if (install) cleanupStaging(staged.staging);
  }
}

module.exports = {
  stageSource, cleanupStaging, extractZipSafe, analyzeRoot,
  summarizeCompatibility, importFromSource, guessGenres,
};
