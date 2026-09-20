// electron-builder afterPack hook: trim unpackaged fat from the Electron
// distribution. Same app contents and features — just a smaller download.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(context) {
  const dir = context.appOutDir;
  let saved = 0;
  const rm = (f) => {
    try {
      const s = fs.statSync(f);
      if (s.isFile()) { saved += s.size; fs.unlinkSync(f); }
    } catch { /* already gone */ }
  };
  // Unused Chromium UI locales — keep en-US only (the app UI is English).
  // NOTE: license/attribution files are deliberately left untouched.
  try {
    const loc = path.join(dir, 'locales');
    for (const f of fs.readdirSync(loc)) {
      if (f.toLowerCase() !== 'en-us.pak') rm(path.join(loc, f));
    }
  } catch { /* no locales dir */ }
  console.log(`[afterPack] trimmed ${(saved / 1048576).toFixed(1)} MB of unused files`);
};
