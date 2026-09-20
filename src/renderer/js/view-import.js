/* view-import.js — 5-step import wizard: choose -> analyze -> review -> install -> done. */
import { el, formatBytes } from './util.js';
import { api, library } from './api.js';
import { toast, openModal } from './ui.js';
import { hideFilterbar } from './view-library.js';

const state = { step: 1, source: null, stagingId: null, report: null, thumbRel: null, record: null };

export function renderImport(root, nav, presetFile = null) {
  hideFilterbar();
  Object.assign(state, { step: 1, source: null, stagingId: null, report: null, thumbRel: null, record: null });
  root.innerHTML = '';
  root.append(el('div', { class: 'view-head' }, el('h1', { text: 'Import a game' }), el('span', { class: 'sub', text: 'HTML files, folders, ZIP archives, or a direct URL.' })));
  const body = el('div', { id: 'wizard' });
  root.append(body);
  if (presetFile) {
    const kind = /\.zip$/i.test(presetFile) ? 'zip' : 'html';
    beginAnalyze(nav, { kind, path: presetFile });
  } else {
    stepChoose(nav);
  }
}

function stepsBar(current) {
  const names = ['Choose', 'Analyze', 'Review', 'Install', 'Done'];
  return el('div', { class: 'steps' }, ...names.map((n, i) =>
    el('div', { class: `step${i + 1 === current ? ' on' : ''}${i + 1 < current ? ' done' : ''}` }, `${i + 1}. ${n}`)));
}

function wizard() { return document.getElementById('wizard'); }

function stepChoose(nav) {
  state.step = 1;
  const w = wizard();
  w.innerHTML = '';
  w.append(stepsBar(1));
  w.append(el('div', { class: 'source-grid' },
    sourceCard('📄', 'HTML file', 'A single .html game', () => pickKind(nav, 'html')),
    sourceCard('📁', 'Folder', 'A game folder with assets', () => pickKind(nav, 'folder')),
    sourceCard('🗜', 'ZIP archive', 'Extracted & analyzed safely', () => pickKind(nav, 'zip')),
    sourceCard('🔗', 'URL', 'Direct link to .html or .zip', () => stepUrl(nav))));
  w.append(el('div', { class: 'note-box', style: 'margin-top:16px' },
    'Tip: you can also drag & drop a file or folder anywhere into Playhub. GitHub repositories work too — open the repo, download its ZIP (Code → Download ZIP), and import that.'));
}

function sourceCard(icon, title, sub, fn) {
  return el('button', { class: 'source-card', onclick: fn },
    el('span', { class: 'big' }, icon), el('b', { text: title }), el('span', { text: sub }));
}

async function pickKind(nav, kind) {
  try {
    const sel = await api.importPick(kind);
    if (!sel) return;
    beginAnalyze(nav, sel);
  } catch (err) { toast(err.message, 'bad'); }
}

function stepUrl(nav) {
  const input = el('input', { class: 'text-input', style: 'width:100%', placeholder: 'https://example.com/game.html  or  https://…/game.zip' });
  const { close } = openModal({
    title: 'Import from URL',
    body: el('div', {}, el('p', { class: 'muted small' }, 'Direct links to a single .html file or a .zip archive. Repository pages cannot be imported directly — download a ZIP from the repo first.'), input),
    footer: [
      el('button', { class: 'btn ghost', onclick: () => close() }, 'Cancel'),
      el('button', {
        class: 'btn primary', onclick: () => {
          const url = input.value.trim();
          if (!/^https?:\/\//i.test(url)) { toast('Enter a valid http(s) URL.', 'warn'); return; }
          close();
          beginAnalyze(nav, { kind: 'url', url });
        },
      }, 'Analyze URL'),
    ],
  });
}

async function beginAnalyze(nav, source) {
  state.step = 2;
  state.source = source;
  const w = wizard();
  w.innerHTML = '';
  w.append(stepsBar(2));
  const label = source.path ? source.path : source.url;
  w.append(el('p', {}, 'Analyzing ', el('b', { class: 'mono small', text: label })));
  const prog = el('div', { class: 'progress' }, el('i', { style: 'width:5%' }));
  const status = el('p', { class: 'muted small' }, 'Staging files…');
  w.append(prog, status);
  const off = api.on('playhub:import-progress', (p) => {
    if (p.phase === 'download') {
      const pct = p.total ? Math.round((p.received / p.total) * 100) : 50;
      prog.firstChild.style.width = `${pct}%`;
      status.textContent = p.total ? `Downloading… ${formatBytes(p.received)} of ${formatBytes(p.total)}` : `Downloading… ${formatBytes(p.received)}`;
    }
  });
  try {
    prog.firstChild.style.width = '30%';
    const { stagingId, report } = await api.importAnalyze(source);
    off();
    state.stagingId = stagingId;
    state.report = report;
    state.thumbRel = (report.images && report.images[0]) || null;
    prog.firstChild.style.width = '100%';
    stepReview(nav);
  } catch (err) {
    off();
    w.append(el('div', { class: 'err-box' }, `Analysis failed: ${err.message}`));
    w.append(el('div', { class: 'toolbar-row' }, el('button', { class: 'btn', onclick: () => stepChoose(nav) }, '← Start over')));
  }
}

function stepReview(nav) {
  state.step = 3;
  const { report } = state;
  const w = wizard();
  w.innerHTML = '';
  w.append(stepsBar(3));

  if (report.errors && report.errors.length) {
    w.append(el('div', { class: 'err-box' }, report.errors.map((e) => e.message).join(' ')));
  }
  for (const warn of report.warnings || []) {
    w.append(el('div', { class: 'warn-box' }, warn.message));
  }

  const fTitle = el('input', { class: 'text-input', value: report.title });
  const fAuthor = el('input', { class: 'text-input', value: '', placeholder: 'Author name' });
  const fDesc = el('textarea', { rows: '3', style: 'width:100%' }, report.description || '');
  const fGenres = el('input', { class: 'text-input', value: (report.genres || []).join(', ') });
  const fLicense = el('select', {});
  for (const l of ['Unknown', 'MIT', 'Apache-2.0', 'GPL-3.0', 'LGPL-3.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'CC0-1.0', 'CC-BY-4.0', 'CC-BY-NC-4.0', 'Unlicense', 'Proprietary']) {
    fLicense.append(el('option', { value: l }, l));
  }
  const fEntry = el('select', {});
  for (const c of report.candidates || []) {
    fEntry.append(el('option', { value: c.relative, selected: report.entry && c.relative === report.entry.relative ? 'selected' : null },
      `${c.relative}  (score ${c.score})${c.title ? ` — ${c.title}` : ''}`));
  }
  w.append(el('div', { class: 'panel' }, el('h3', { text: 'Review & edit' }),
    el('div', { class: 'form-grid' },
      el('label', { class: 'field' }, 'Title', fTitle),
      el('label', { class: 'field' }, 'Author', fAuthor),
      el('label', { class: 'field full' }, 'Description', fDesc),
      el('label', { class: 'field' }, 'Genres (comma separated)', fGenres),
      el('label', { class: 'field' }, 'License', el('span', { class: 'hint' }, 'Only redistribute games you have rights to.'), fLicense),
      el('label', { class: 'field full' }, 'Entry point', fEntry))));

  // Compatibility summary
  const comp = el('div', { class: 'panel' }, el('h3', { text: `Compatibility — ${report.totalSizeText} · ${report.fileCount} file(s)${report.singleFile ? ' · single-file' : ''}` }));
  const table = el('table', { class: 'check-table' });
  for (const r of report.compatibility || []) {
    table.append(el('tr', {}, el('td', { style: 'width:170px' }, el('span', { class: `dot ${r.status}` }), el('b', { text: r.label })), el('td', { text: r.detail || '' })));
  }
  comp.append(table);
  w.append(comp);

  // Artwork picker
  const artPanel = el('div', { class: 'panel' }, el('h3', { text: 'Artwork' }));
  const thumbs = el('div', { class: 'thumb-pick' });
  const noneBtn = el('button', { class: `thumb-opt${state.thumbRel ? '' : ' on'}`, style: 'height:84px;color:var(--muted)' }, 'Generated art');
  noneBtn.onclick = () => { state.thumbRel = null; [...thumbs.children].forEach((c) => c.classList.remove('on')); noneBtn.classList.add('on'); };
  thumbs.append(noneBtn);
  for (const rel of report.images || []) {
    const b = el('button', { class: `thumb-opt${state.thumbRel === rel ? ' on' : ''}`, title: rel });
    b.append(el('span', { class: 'small muted' }, 'loading…'));
    api.importThumb(state.stagingId, rel).then((r) => {
      b.innerHTML = '';
      if (r && r.dataUrl) b.append(el('img', { src: r.dataUrl, alt: rel }));
      else b.append(el('span', { class: 'small' }, rel));
    }).catch(() => { b.innerHTML = ''; b.append(el('span', { class: 'small' }, rel)); });
    b.onclick = () => { state.thumbRel = rel; [...thumbs.children].forEach((c) => c.classList.remove('on')); b.classList.add('on'); };
    thumbs.append(b);
  }
  if (!(report.images || []).length) artPanel.append(el('p', { class: 'muted small' }, 'No images found in the package — Playhub will generate artwork. You can change the entry above if the wrong page was detected.'));
  artPanel.append(thumbs);
  w.append(artPanel);

  const netLabel = el('label', { class: 'check-row' });
  const netBox = el('input', { type: 'checkbox', checked: (report.trackers && report.trackers.length > 0) ? 'checked' : null });
  netLabel.append(netBox, el('span', {}, 'Offline Sandbox — block all internet requests from this game'));
  w.append(el('div', { class: 'panel' }, netLabel,
    el('p', { class: 'small muted' }, (report.trackers && report.trackers.length)
      ? `Recommended: trackers detected (${report.trackers.join(', ')}). You can change this later per game.`
      : 'Optional. Enable for games with trackers, or to prove a game is truly offline.')));

  w.append(el('div', { class: 'toolbar-row' },
    el('button', { class: 'btn ghost', onclick: async () => { await api.importCancel(state.stagingId); stepChoose(nav); } }, '← Cancel'),
    el('button', {
      class: 'btn primary lg', onclick: () => stepInstall(nav, {
        title: fTitle.value.trim(), author: fAuthor.value.trim(), description: fDesc.value,
        genres: fGenres.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 5),
        license: fLicense.value, entryFile: fEntry.value, blockNetwork: netBox.checked,
      }),
    }, 'Install game →')));
}

async function stepInstall(nav, review) {
  state.step = 4;
  const w = wizard();
  w.innerHTML = '';
  w.append(stepsBar(4));
  w.append(el('p', { text: 'Installing…' }));
  try {
    const record = await api.importConfirm(state.stagingId, { ...review, thumbnailRel: state.thumbRel });
    await library.refresh();
    state.record = record;
    stepDone(nav);
  } catch (err) {
    w.append(el('div', { class: 'err-box' }, `Install failed: ${err.message}. Nothing was changed.`));
    w.append(el('div', { class: 'toolbar-row' }, el('button', { class: 'btn', onclick: () => stepChoose(nav) }, '← Start over')));
  }
}

function stepDone(nav) {
  state.step = 5;
  const w = wizard();
  w.innerHTML = '';
  w.append(stepsBar(5));
  const g = state.record;
  w.append(el('div', { class: 'empty' },
    el('div', { class: 'big' }, '🎉'),
    el('h2', { text: `“${g.title}” is ready!` }),
    el('p', { text: `${formatBytes(g.sizeBytes)} · ${g.entryFile}` }),
    el('div', { class: 'empty-actions' },
      el('button', { class: 'btn primary lg', onclick: () => api.play(g.id) }, '▶ Play now'),
      el('button', { class: 'btn', onclick: () => nav.go(`game:${g.id}`) }, 'View details'),
      el('button', { class: 'btn ghost', onclick: () => renderImport(document.getElementById('view'), nav) }, 'Import another'))));
}
