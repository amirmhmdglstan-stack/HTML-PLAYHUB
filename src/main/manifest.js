'use strict';
/**
 * manifest.js — Playhub game manifest (playhub.manifest.json) schema + validation.
 *
 * Documented in docs/GAME_FORMAT.md. Versioned; unknown fields are preserved.
 */
const { slugify } = require('./util');

const MANIFEST_VERSION = 1;
const MANIFEST_FILENAME = 'playhub.manifest.json';

function defaultManifest(overrides = {}) {
  const now = new Date().toISOString();
  return {
    manifestVersion: MANIFEST_VERSION,
    id: overrides.id || slugify(overrides.title || 'game'),
    title: overrides.title || 'Untitled Game',
    description: overrides.description || '',
    author: overrides.author || 'Unknown',
    source: overrides.source || {},
    license: overrides.license || { spdx: 'Unknown' },
    version: overrides.version || '1.0',
    genres: overrides.genres || [],
    tags: overrides.tags || [],
    language: overrides.language || 'en',
    entryFile: overrides.entryFile || 'index.html',
    singleFile: !!overrides.singleFile,
    qualityTier: overrides.qualityTier || null,
    sourceCollection: overrides.sourceCollection || null,
    controls: Object.assign(
      { keyboard: false, mouse: false, touch: false, gamepad: false, notes: '' },
      overrides.controls || {}
    ),
    requirements: Object.assign(
      { keyboard: false, mouse: false, landscape: false },
      overrides.requirements || {}
    ),
    network: Object.assign(
      { required: false, hosts: [] },
      overrides.network || {}
    ),
    bundleVersion: overrides.bundleVersion || 0,
    addedAt: overrides.addedAt || now,
    updatedAt: now,
  };
}

function validateManifest(obj) {
  const errors = [];
  const warnings = [];
  if (!obj || typeof obj !== 'object') return { ok: false, errors: ['Manifest is not an object.'], warnings };
  if (!obj.id || typeof obj.id !== 'string') errors.push('Missing required field: id');
  else if (!/^[a-z0-9][a-z0-9-_]{0,80}$/.test(obj.id)) errors.push('Field id must be lowercase alphanumeric with dashes/underscores.');
  if (!obj.title || typeof obj.title !== 'string') errors.push('Missing required field: title');
  if (!obj.entryFile || typeof obj.entryFile !== 'string') errors.push('Missing required field: entryFile');
  else if (/^([a-z]+:|\/|\\\\)/i.test(obj.entryFile) || obj.entryFile.includes('..')) errors.push('Field entryFile must be a relative path inside the game folder.');
  if (obj.manifestVersion !== MANIFEST_VERSION) warnings.push(`Unknown manifestVersion ${obj.manifestVersion}; expected ${MANIFEST_VERSION}. Unknown fields preserved.`);
  if (!obj.license || !obj.license.spdx) warnings.push('No license recorded. Verify redistribution rights before sharing.');
  if (!obj.author) warnings.push('No author recorded.');
  return { ok: errors.length === 0, errors, warnings };
}

function normalizeManifest(obj) {
  const m = defaultManifest(obj || {});
  // Preserve unknown fields.
  for (const [k, v] of Object.entries(obj || {})) {
    if (!(k in m)) m[k] = v;
  }
  return m;
}

module.exports = { MANIFEST_VERSION, MANIFEST_FILENAME, defaultManifest, validateManifest, normalizeManifest };
