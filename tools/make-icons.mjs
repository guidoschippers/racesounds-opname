// Maakt de app-iconen (PNG 192/512 + maskable) zonder externe tools: een toerentellerboog met
// een rode opnamestip. Gebruik: node tools/make-icons.mjs
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../js/zip.js';

const BG = [17, 24, 39];
const ARC = [243, 244, 246];
const RED = [220, 38, 38];

// Kleur op (u, v) in 0..1, of null (achtergrond). safe = schaal voor maskable (veilige zone).
function shade(u, v, safe) {
  const x = (u - 0.5) / safe, y = (v - 0.5) / safe;
  const r = Math.hypot(x, y);
  const ang = Math.atan2(y, x); // 0 = rechts, positief = omlaag
  // Boog van 135° tot 405° (onderaan open), dikte 0.06.
  let a = ang * 180 / Math.PI;
  if (a < 0) a += 360;
  const inArc = r > 0.30 && r < 0.37 && !(a > 45 && a < 135);
  // Naald naar ~2 uur.
  const na = -35 * Math.PI / 180;
  const along = x * Math.cos(na) + y * Math.sin(na);
  const across = -x * Math.sin(na) + y * Math.cos(na);
  const needle = along > 0 && along < 0.28 && Math.abs(across) < 0.022;
  if (Math.hypot(x, y - 0.16) < 0.09) return RED;
  if (inArc || needle || r < 0.045) return ARC;
  return null;
}

function png(size, { maskable = false } = {}) {
  const safe = maskable ? 0.8 : 1;
  const ss = 4; // supersampling
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let py = 0; py < size; py++) {
    raw[py * (size * 4 + 1)] = 0;
    for (let px = 0; px < size; px++) {
      let rr = 0, gg = 0, bb = 0, aa = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (px + (sx + 0.5) / ss) / size, v = (py + (sy + 0.5) / ss) / size;
          // Afgeronde hoek voor het gewone icoon; maskable vult alles.
          const cx = Math.max(0, Math.abs(u - 0.5) - 0.32), cy = Math.max(0, Math.abs(v - 0.5) - 0.32);
          const inside = maskable || Math.hypot(cx, cy) < 0.18;
          if (!inside) continue;
          const c = shade(u, v, safe) || BG;
          rr += c[0]; gg += c[1]; bb += c[2]; aa += 255;
        }
      }
      const n = ss * ss;
      const o = py * (size * 4 + 1) + 1 + px * 4;
      const cov = aa / 255 || 1;
      raw[o] = Math.round(rr / cov);
      raw[o + 1] = Math.round(gg / cov);
      raw[o + 2] = Math.round(bb / cov);
      raw[o + 3] = Math.round(aa / n);
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dir = new URL('../icons/', import.meta.url);
writeFileSync(new URL('icon-192.png', dir), png(192));
writeFileSync(new URL('icon-512.png', dir), png(512));
writeFileSync(new URL('icon-maskable-512.png', dir), png(512, { maskable: true }));
writeFileSync(new URL('icon.svg', dir), `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="18" fill="rgb(${BG})"/>
  <path d="M 25.25 74.75 A 35 35 0 1 1 74.75 74.75" fill="none" stroke="rgb(${ARC})" stroke-width="7"/>
  <line x1="50" y1="50" x2="72.9" y2="34" stroke="rgb(${ARC})" stroke-width="4.4" stroke-linecap="round"/>
  <circle cx="50" cy="50" r="4.5" fill="rgb(${ARC})"/>
  <circle cx="50" cy="66" r="9" fill="rgb(${RED})"/>
</svg>
`);
console.log('Iconen geschreven in icons/');
