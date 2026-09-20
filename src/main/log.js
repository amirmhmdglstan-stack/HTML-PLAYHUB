'use strict';
/**
 * log.js — tiny file + console logger with rotation.
 */
const fs = require('node:fs');
const path = require('node:path');

let logFile = null;
const memoryLog = [];
const MAX_MEM = 300;

function init(logsDir) {
  try {
    fs.mkdirSync(logsDir, { recursive: true });
    logFile = path.join(logsDir, 'playhub.log');
    // Rotate when > 2 MB.
    try {
      const st = fs.statSync(logFile);
      if (st.size > 2 * 1024 * 1024) {
        const old = path.join(logsDir, 'playhub.prev.log');
        try { fs.rmSync(old, { force: true }); } catch { /* ignore */ }
        fs.renameSync(logFile, old);
      }
    } catch { /* no existing log */ }
  } catch {
    logFile = null;
  }
}

function line(level, scope, msg, extra) {
  const ts = new Date().toISOString();
  let s = `${ts} [${level}] [${scope}] ${msg}`;
  if (extra !== undefined) {
    try { s += ' ' + (typeof extra === 'string' ? extra : JSON.stringify(extra)); }
    catch { s += ' [unserializable]'; }
  }
  return s;
}

function write(level, scope, msg, extra) {
  const s = line(level, scope, msg, extra);
  memoryLog.push(s);
  if (memoryLog.length > MAX_MEM) memoryLog.splice(0, memoryLog.length - MAX_MEM);
  if (level === 'ERROR') console.error(s);
  else if (level === 'WARN') console.warn(s);
  else console.log(s);
  if (logFile) {
    try { fs.appendFileSync(logFile, s + '\n'); } catch { /* ignore */ }
  }
}

function scope(name) {
  return {
    info: (m, e) => write('INFO', name, m, e),
    warn: (m, e) => write('WARN', name, m, e),
    error: (m, e) => write('ERROR', name, m, e),
    debug: (m, e) => write('DEBUG', name, m, e),
  };
}

function tailLines(n = 200) {
  if (logFile) {
    try {
      const data = fs.readFileSync(logFile, 'utf8');
      const lines = data.trim().split('\n');
      return lines.slice(-n);
    } catch { /* fall through */ }
  }
  return memoryLog.slice(-n);
}

module.exports = { init, scope, tailLines };
