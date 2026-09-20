#!/usr/bin/env node
/**
 * make-icon.mjs — generates the HTML Playhub app icon with zero dependencies.
 *
 * Draws a rounded-square "arcade cabinet screen" mark with a play triangle,
 * writes a 256x256 PNG (assets/icon.png) and a Windows ICO (assets/icon.ico)
 * containing 16/24/32/48/64/128/256 PNG-compressed entries.
 *
 * Usage: node tools/make-icon.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = join(ROOT, 'assets');
mkdirSync(ASSETS, { recursive: true });

function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    crc32._t = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4)
      .copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function lerp(a, b, t) { return a + (b - a) * t; }

// Brand palette: deep-space violet -> neon magenta -> arcade amber
const C_TOP = [124, 58, 237];    // violet
const C_MID = [217, 70, 239];    // fuchsia
const C_BOT = [251, 146, 60];    // amber-orange

function drawIcon(size) {
  const px = new Uint8ClampedArray(size * size * 4);
  const radius = size * 0.225;
  const cx = size / 2;

  // Rounded-rect background with vertical gradient + subtle vignette.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Rounded rect SDF-ish test
      const qx = Math.abs(x + 0.5 - cx) - (size / 2 - radius);
      const qy = Math.abs(y + 0.5 - cx) - (size / 2 - radius);
      const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
      const dist = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
      const aa = 1.5; // antialias px
      let alpha = dist <= 0 ? 1 : dist >= aa ? 0 : 1 - dist / aa;
      if (alpha <= 0) continue;

      const t = y / (size - 1);
      let r, g, b;
      if (t < 0.55) { const k = t / 0.55; r = lerp(C_TOP[0], C_MID[0], k); g = lerp(C_TOP[1], C_MID[1], k); b = lerp(C_TOP[2], C_MID[2], k); }
      else { const k = (t - 0.55) / 0.45; r = lerp(C_MID[0], C_BOT[0], k); g = lerp(C_MID[1], C_BOT[1], k); b = lerp(C_MID[2], C_BOT[2], k); }

      // Top gloss: lighten upper-left
      const gloss = Math.max(0, 1 - (x / size) * 0.9 - (y / size) * 1.4) * 38;
      // Vignette: darken edges
      const dx = (x + 0.5 - cx) / (size / 2), dy = (y + 0.5 - cx) / (size / 2);
      const vig = Math.max(0, Math.hypot(dx, dy) - 0.55) * 46;

      const i = (y * size + x) * 4;
      px[i] = Math.max(0, Math.min(255, r + gloss - vig));
      px[i + 1] = Math.max(0, Math.min(255, g + gloss - vig));
      px[i + 2] = Math.max(0, Math.min(255, b + gloss - vig * 0.6));
      px[i + 3] = Math.round(alpha * 255);
    }
  }

  // CRT screen frame (dark rounded rect inset)
  const m = size * 0.16, sr = size * 0.07;
  const sx0 = m, sy0 = m * 0.86, sx1 = size - m, sy1 = size - m * 1.28;
  for (let y = Math.floor(sy0) - 2; y < Math.ceil(sy1) + 2; y++) {
    for (let x = Math.floor(sx0) - 2; x < Math.ceil(sx1) + 2; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const qx = Math.abs(x + 0.5 - (sx0 + sx1) / 2) - ((sx1 - sx0) / 2 - sr);
      const qy = Math.abs(y + 0.5 - (sy0 + sy1) / 2) - ((sy1 - sy0) / 2 - sr);
      const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
      const dist = Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - sr;
      let a = dist <= 0 ? 1 : dist >= 1.5 ? 0 : 1 - dist / 1.5;
      if (a <= 0) continue;
      const i = (y * size + x) * 4;
      // screen: deep navy with faint scanline shimmer
      const scan = (y % Math.max(2, Math.round(size / 90)) === 0) ? 10 : 0;
      const nr = 13 + scan, ng = 16 + scan, nb = 38 + scan;
      px[i] = nr * a + px[i] * (1 - a);
      px[i + 1] = ng * a + px[i + 1] * (1 - a);
      px[i + 2] = nb * a + px[i + 2] * (1 - a);
    }
  }

  // Play triangle (paper-white with warm tint), centered in screen
  const scx = (sx0 + sx1) / 2, scy = (sy0 + sy1) / 2;
  const th = (sy1 - sy0) * 0.52;            // triangle height
  const tw = th * 0.92;                     // triangle half-width-ish
  const xL = scx - tw * 0.42, xR = scx + tw * 0.62;
  const yT = scy - th / 2, yB = scy + th / 2;
  const rr = size * 0.02; // corner rounding approx via distance shrink
  for (let y = Math.floor(yT) - 2; y < Math.ceil(yB) + 2; y++) {
    for (let x = Math.floor(xL) - 2; x < Math.ceil(xR) + 2; x++) {
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const pxf = x + 0.5, pyf = y + 0.5;
      // Barycentric-ish inside test for triangle (xL,yT)->(xL,yB)->(xR,scy)
      const t = (pyf - yT) / (yB - yT); // 0 top .. 1 bottom
      const halfW = (xR - xL) * (t < 0.5 ? t * 2 : (1 - t) * 2);
      const inside = pxf >= xL - 0.5 && pxf <= xL + halfW + 0.5 && pyf >= yT && pyf <= yB;
      if (!inside) continue;
      const edge = Math.min(pxf - (xL - 0.5), (xL + halfW + 0.5) - pxf, size * 0.01 + rr);
      const a = Math.max(0, Math.min(1, edge / 1.5));
      const i = (y * size + x) * 4;
      // warm white with slight vertical shading
      const shade = 255 - Math.round((pyf - yT) / (yB - yT)) * 14;
      px[i] = shade * a + px[i] * (1 - a);
      px[i + 1] = (shade - 4) * a + px[i + 1] * (1 - a);
      px[i + 2] = (shade - 18) * a + px[i + 2] * (1 - a);
      px[i + 3] = 255;
    }
  }

  // Cabinet "buttons": two small dots under the screen
  const dots = [
    { dx: -0.055, c: [45, 212, 191] },  // teal
    { dx: 0.055, c: [250, 204, 21] },   // yellow
  ];
  for (const d of dots) {
    const dcx = cx + d.dx * size, dcy = size - m * 0.62, dr = size * 0.032;
    for (let y = Math.floor(dcy - dr - 1); y < dcy + dr + 1; y++) {
      for (let x = Math.floor(dcx - dr - 1); x < dcx + dr + 1; x++) {
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const dist = Math.hypot(x + 0.5 - dcx, y + 0.5 - dcy);
        const a = dist <= dr ? 1 : dist >= dr + 1.2 ? 0 : 1 - (dist - dr) / 1.2;
        if (a <= 0) continue;
        const i = (y * size + x) * 4;
        px[i] = d.c[0] * a + px[i] * (1 - a);
        px[i + 1] = d.c[1] * a + px[i + 1] * (1 - a);
        px[i + 2] = d.c[2] * a + px[i + 2] * (1 - a);
        px[i + 3] = 255;
      }
    }
  }
  return px;
}

function downscale(src, srcSize, dstSize) {
  const dst = new Uint8ClampedArray(dstSize * dstSize * 4);
  const scale = srcSize / dstSize;
  for (let y = 0; y < dstSize; y++) {
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * scale), x1 = Math.min(srcSize, Math.ceil((x + 1) * scale));
      const y0 = Math.floor(y * scale), y1 = Math.min(srcSize, Math.ceil((y + 1) * scale));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = y0; sy < y1; sy++) for (let sx = x0; sx < x1; sx++) {
        const i = (sy * srcSize + sx) * 4;
        r += src[i]; g += src[i + 1]; b += src[i + 2]; a += src[i + 3]; n++;
      }
      const o = (y * dstSize + x) * 4;
      dst[o] = r / n; dst[o + 1] = g / n; dst[o + 2] = b / n; dst[o + 3] = a / n;
    }
  }
  return dst;
}

const BASE = 256;
const base = drawIcon(BASE);
const png256 = encodePng(BASE, BASE, base);
writeFileSync(join(ASSETS, 'icon.png'), png256);
console.log('wrote assets/icon.png', png256.length, 'bytes');

// ICO: header + entries, each entry a full PNG (Vista+ style).
const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => (s === BASE ? png256 : encodePng(s, s, downscale(base, BASE, s))));
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((img, i) => {
  const s = sizes[i];
  const o = 6 + i * 16;
  header[o] = s >= 256 ? 0 : s;
  header[o + 1] = s >= 256 ? 0 : s;
  header[o + 2] = 0; // palette
  header[o + 3] = 0;
  header.writeUInt16LE(1, o + 4);
  header.writeUInt16LE(32, o + 6);
  header.writeUInt32LE(img.length, o + 8);
  header.writeUInt32LE(offset, o + 12);
  offset += img.length;
});
writeFileSync(join(ASSETS, 'icon.ico'), Buffer.concat([header, ...images]));
console.log('wrote assets/icon.ico', offset, 'bytes');
