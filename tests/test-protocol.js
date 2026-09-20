'use strict';
// Protocol layer: asar-safe fs streaming, byte ranges, traversal guards.
// Runs under plain node (the electron API is guarded inside protocol.js).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proto = require('../src/main/protocol.js');
const util = require('../src/main/util.js');

function fakeRequest(url) {
  return { url, headers: new Headers() };
}

describe('protocol serveFile', () => {
  let dir;
  let htmlFile;
  let binFile;
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-proto-'));
    htmlFile = path.join(dir, 'index.html');
    fs.writeFileSync(htmlFile, '<!doctype html><title>t</title>hello-bytes');
    binFile = path.join(dir, 'sfx.dat');
    fs.writeFileSync(binFile, Buffer.from('0123456789abcdef'));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('streams a file with correct type and length', async () => {
    const res = proto.serveFile(htmlFile);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), util.mimeFor(htmlFile));
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    const text = await res.text();
    assert.match(text, /hello-bytes/);
    assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(text)));
  });

  it('honors byte ranges (206) for media seeking', async () => {
    const res = proto.serveFile(binFile, { rangeHeader: 'bytes=4-9' });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes 4-9/16');
    assert.equal(await res.text(), '456789');
  });

  it('never throws: missing file and directory become 404', async () => {
    assert.equal(proto.serveFile(path.join(dir, 'nope.html')).status, 404);
    assert.equal(proto.serveFile(dir).status, 404);
  });
});

describe('protocol handleApp', () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-approot-'));
    fs.mkdirSync(path.join(root, 'js'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>APP');
    fs.writeFileSync(path.join(root, 'js', 'a.js'), 'console.log(1)');
    fs.writeFileSync(path.join(root, 'playhub.manifest.json'), '{}');
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('serves the shell, blocks traversal and sidecar files', async () => {
    const ok = await proto.handleApp(root, fakeRequest('playhub-app://app/index.html'));
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /APP/);
    assert.equal(proto.handleApp(root, fakeRequest('playhub-app://app/playhub.manifest.json')).status, 403);
    // Traversal can never escape: the URL parser normalizes .. away (404) or
    // safeJoin refuses it (403). Either way the file is not served.
    assert.ok([403, 404].includes(proto.handleApp(root, fakeRequest('playhub-app://app/%2e%2e/%2e%2e/etc/passwd')).status));
    assert.equal(proto.handleApp(root, fakeRequest('playhub-app://evil/index.html')).status, 404);
  });
});

describe('protocol handleGame', () => {
  let games;
  const store = {
    getGame: (id) => (id === 'g1' ? { id: 'g1', entryFile: 'index.html' } : null),
  };
  const getPaths = () => ({ games });
  before(() => {
    games = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-games-'));
    fs.mkdirSync(path.join(games, 'g1'), { recursive: true });
    fs.writeFileSync(path.join(games, 'g1', 'index.html'), '<!doctype html>GAME1');
    fs.writeFileSync(path.join(games, 'g1', 'playhub.manifest.json'), '{}');
  });
  after(() => fs.rmSync(games, { recursive: true, force: true }));

  it('serves game files, defaults to entry, guards manifest/traversal/unknown', async () => {
    const main = await proto.handleGame(getPaths, store, fakeRequest('playhub-game://game/g1/index.html'));
    assert.equal(main.status, 200);
    assert.match(await main.text(), /GAME1/);
    assert.equal(main.headers.get('cache-control'), 'no-store');
    const def = await proto.handleGame(getPaths, store, fakeRequest('playhub-game://game/g1/'));
    assert.equal(def.status, 200);
    assert.equal(proto.handleGame(getPaths, store, fakeRequest('playhub-game://game/g1/playhub.manifest.json')).status, 403);
    assert.ok([403, 404].includes(proto.handleGame(getPaths, store, fakeRequest('playhub-game://game/g1/%2e%2e/%2e%2e/x')).status));
    assert.equal(proto.handleGame(getPaths, store, fakeRequest('playhub-game://game/nope/index.html')).status, 404);
  });
});

function fakeSession() {
  const handlers = new Map();
  return {
    handlers,
    protocol: {
      handle: (scheme, fn) => { handlers.set(scheme, fn); },
      isProtocolHandled: async (scheme) => handlers.has(scheme),
    },
  };
}

describe('protocol multi-session registration', () => {
  let root;
  let games;
  const store = {
    getGame: (id) => (id === 'g1' ? { id: 'g1', entryFile: 'index.html' } : null),
  };
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-sesapp-'));
    fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>SHELL');
    games = fs.mkdtempSync(path.join(os.tmpdir(), 'ph-sesgames-'));
    fs.mkdirSync(path.join(games, 'g1'), { recursive: true });
    fs.writeFileSync(path.join(games, 'g1', 'index.html'), '<!doctype html>GAME1');
    proto.setHandlerContext({ rendererRoot: root, getPaths: () => ({ games }), store });
  });
  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(games, { recursive: true, force: true });
    proto.setHandlerContext(null);
  });

  it('registers both schemes on every session given (the partition bug)', () => {
    const def = fakeSession();
    const shell = fakeSession();
    const game = fakeSession();
    proto.registerHandlers({
      rendererRoot: root, getPaths: () => ({ games }), store,
      sessions: [def, shell, game],
    });
    for (const ses of [def, shell, game]) {
      assert.ok(ses.handlers.has('playhub-app'), 'app scheme missing on a session');
      assert.ok(ses.handlers.has('playhub-game'), 'game scheme missing on a session');
    }
  });

  it('session handlers actually serve responses', async () => {
    const ses = fakeSession();
    assert.equal(proto.ensureSessionHandlers(ses), true);
    const appRes = await ses.handlers.get('playhub-app')(fakeRequest('playhub-app://app/index.html'));
    assert.equal(appRes.status, 200);
    assert.match(await appRes.text(), /SHELL/);
    const gameRes = await ses.handlers.get('playhub-game')(fakeRequest('playhub-game://game/g1/index.html'));
    assert.equal(gameRes.status, 200);
    assert.match(await gameRes.text(), /GAME1/);
  });

  it('gate passes only when every session handles both schemes', async () => {
    const good = fakeSession();
    proto.ensureSessionHandlers(good);
    assert.equal(await proto.ensureProtocolsHandled({ sessions: [good], timeoutMs: 200 }), true);
    const bad = fakeSession(); // nothing registered
    assert.equal(await proto.ensureProtocolsHandled({ sessions: [good, bad], timeoutMs: 200 }), false);
  });

  it('ensureSessionHandlers never throws on garbage', () => {
    assert.equal(proto.ensureSessionHandlers(null), false);
    assert.equal(proto.ensureSessionHandlers({}), false);
    assert.equal(proto.ensureSessionHandlers({ protocol: {} }), false);
  });

  it('registerHandlers throws when no session could take handlers', () => {
    assert.throws(() => proto.registerHandlers({
      rendererRoot: root, getPaths: () => ({ games }), store, sessions: [],
    }), /protocol API unavailable/);
  });
});
