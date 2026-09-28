// Erzeugt die PWA-Icons (PNG) ohne externe Abhängigkeiten.
// Motiv: weißer Teller mit grünem Haken auf Grün, oranger Punkt (AllergenCheck).
// Aufruf: node tools/make-icons.js  → assets/icons/*.png
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_T[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const stride = w * 4 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}
// Formen in Einheitskoordinaten (0..1)
const inside = {
  rrect: (s, x, y) => {
    if (x < s.x || y < s.y || x > s.x + s.w || y > s.y + s.h) return false;
    const r = Math.min(s.r, s.w / 2, s.h / 2);
    const cx = Math.max(s.x + r, Math.min(x, s.x + s.w - r)), cy = Math.max(s.y + r, Math.min(y, s.y + s.h - r));
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
  },
  circle: (s, x, y) => (x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r * s.r,
  seg: (s, x, y) => {
    const dx = s.x2 - s.x1, dy = s.y2 - s.y1, t = Math.max(0, Math.min(1, ((x - s.x1) * dx + (y - s.y1) * dy) / (dx * dx + dy * dy)));
    return (x - s.x1 - t * dx) ** 2 + (y - s.y1 - t * dy) ** 2 <= (s.w / 2) ** 2;
  }
};
function render(size, shapes, ss = 4) {
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let R = 0, G = 0, B = 0, A = 0;
    for (const s of shapes) {
      let cov = 0;
      for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) if (inside[s.t](s, (px + (sx + .5) / ss) / size, (py + (sy + .5) / ss) / size)) cov++;
      cov /= ss * ss; if (!cov) continue;
      const a = cov * (s.a == null ? 1 : s.a);
      R = s.c[0] * a + R * (1 - a); G = s.c[1] * a + G * (1 - a); B = s.c[2] * a + B * (1 - a); A = a + A * (1 - a);
    }
    const o = (py * size + px) * 4;
    buf[o] = A ? Math.round(R / A) : 0; buf[o + 1] = A ? Math.round(G / A) : 0; buf[o + 2] = A ? Math.round(B / A) : 0; buf[o + 3] = Math.round(A * 255);
  }
  return encodePNG(size, size, buf);
}
const GREEN = [45, 106, 62], WHITE = [255, 255, 255], ORANGE = [224, 113, 43], MINT = [207, 233, 213];
function motif(scale, full) {
  // scale < 1 verkleinert das Motiv (Safe-Zone für maskable)
  const k = (v) => 0.5 + (v - 0.5) * scale;
  const bg = full ? { t: "rrect", x: 0, y: 0, w: 1, h: 1, r: 0, c: GREEN } : { t: "rrect", x: 0, y: 0, w: 1, h: 1, r: 0.22, c: GREEN };
  return [
    bg,
    { t: "circle", cx: k(0.5), cy: k(0.53), r: 0.33 * scale, c: MINT },
    { t: "circle", cx: k(0.5), cy: k(0.53), r: 0.28 * scale, c: WHITE },
    { t: "seg", x1: k(0.37), y1: k(0.54), x2: k(0.46), y2: k(0.63), w: 0.075 * scale, c: GREEN },
    { t: "seg", x1: k(0.46), y1: k(0.63), x2: k(0.64), y2: k(0.43), w: 0.075 * scale, c: GREEN },
    { t: "circle", cx: k(0.79), cy: k(0.21), r: 0.1 * scale, c: ORANGE }
  ];
}
const out = path.join(__dirname, "..", "assets", "icons");
fs.mkdirSync(out, { recursive: true });
const jobs = [["icon-192.png", 192, motif(1, false)], ["icon-512.png", 512, motif(1, false)], ["icon-maskable-512.png", 512, motif(0.78, true)], ["apple-touch-icon.png", 180, motif(0.9, true)], ["favicon-32.png", 32, motif(1, false)]];
for (const [name, size, shapes] of jobs) { fs.writeFileSync(path.join(out, name), render(size, shapes, size > 200 ? 3 : 4)); console.log("  " + name); }
