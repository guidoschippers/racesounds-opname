// PWA-controles: alles wat de service worker cachet bestaat, en elk app-bestand staat in de cache-lijst
// (anders werkt de app offline half). Manifest heeft de iconen die Chrome voor installeren eist.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const sw = readFileSync(new URL('sw.js', root), 'utf8');
const listed = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);

test('service worker: alle gecachte bestanden bestaan', () => {
  for (const f of listed) assert.ok(existsSync(new URL(f, root)), f);
});

test('service worker: alle js-, css- en icoonbestanden staan in de cache-lijst', () => {
  for (const dir of ['js', 'css', 'icons']) {
    for (const f of readdirSync(new URL(`${dir}/`, root))) assert.ok(listed.includes(`${dir}/${f}`), `${dir}/${f} ontbreekt in sw.js`);
  }
});

test('manifest: standalone, 192 en 512 px iconen', () => {
  const m = JSON.parse(readFileSync(new URL('app.webmanifest', root), 'utf8'));
  assert.equal(m.display, 'standalone');
  for (const size of ['192x192', '512x512']) assert.ok(m.icons.some((i) => i.sizes === size), size);
  for (const i of m.icons) assert.ok(existsSync(new URL(i.src, root)), i.src);
});
