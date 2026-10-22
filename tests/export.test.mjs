import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignFileNames, baseName, exportZip, manifestJson, motorJson, safeName } from '../js/export.js';
import { itemStatus, newMotor, recordingItems } from '../js/model.js';
import { crc32, readZip } from '../js/zip.js';
import { decodeWav, encodeWav } from '../js/wav.js';

function motor() {
  return { ...newMotor(), id: 'm1', name: 'Skoda Octavia 2.0 TSI', make: 'Skoda', model: 'Octavia', year: 2016, engineCode: 'CHHB', turbo: true };
}

let n = 0;
function take(over) {
  n++;
  return {
    id: `t${n}`, motorId: 'm1', kind: 'constant', position: 'motorkap', rpmTarget: 2500, rpmEntered: 2500,
    rpmEstimated: 2512.4, rpmConfidence: 0.8123, rpmSpread: 0.01234, rpmSeries: [{ t: 0.25, rpm: 2510.2, confidence: 0.81 }],
    durationSeconds: 10.0213, peakDbfs: -6.04, rmsDbfs: -20.3, clippedSamples: 0, sampleRate: 48000, bitDepth: 24,
    createdAt: `2026-10-22T10:00:${String(n).padStart(2, '0')}.000Z`, notes: '', redo: false, ...over,
  };
}

test('veilige mapnaam', () => {
  assert.equal(safeName('Skoda Octavia 2.0 TSI'), 'Skoda_Octavia_2.0_TSI');
  assert.equal(safeName('Citroën C4 / 1.6 HDi'), 'Citroen_C4_1.6_HDi');
  assert.equal(safeName('  '), 'motor');
});

test('bestandsnamen: <positie>_<soort>_<rpm>rpm[_n].wav', () => {
  assert.equal(baseName(take()), 'motorkap_constant_2500rpm');
  assert.equal(baseName(take({ kind: 'stilte', rpmTarget: null })), 'motorkap_stilte');
  assert.equal(baseName(take({ kind: 'gaslos', rpmTarget: 4000, position: 'uitlaat' })), 'uitlaat_gaslos_4000rpm');
  const a = take(), b = take({ rpmTarget: 3500 }), c = take(), s = take({ kind: 'stilte', rpmTarget: null }), d = take();
  const names = assignFileNames([d, c, s, b, a]);
  assert.equal(names.get(a.id), 'motorkap_constant_2500rpm.wav');
  assert.equal(names.get(c.id), 'motorkap_constant_2500rpm_2.wav');
  assert.equal(names.get(d.id), 'motorkap_constant_2500rpm_3.wav');
  assert.equal(names.get(b.id), 'motorkap_constant_3500rpm.wav');
  assert.equal(names.get(s.id), 'motorkap_stilte.wav');
});

test('motor.json', () => {
  const j = motorJson(motor());
  assert.equal(j.naam, 'Skoda Octavia 2.0 TSI');
  assert.equal(j.cilinders, 4);
  assert.equal(j.opbouw, 'lijn');
  assert.equal(j.turbo, true);
  assert.equal(j.stationairRpm, 800);
  assert.equal(j.begrenzerRpm, 6500);
  assert.equal(j.bouwjaar, 2016);
  for (const k of ['merk', 'model', 'motorcode', 'inhoudCc', 'brandstof', 'notities']) assert.ok(k in j, k);
});

test('manifest.json: alle velden per opname', () => {
  const t1 = take({ notes: 'airco uit' });
  const t2 = take({ kind: 'stilte', rpmTarget: null, rpmEntered: null, rpmEstimated: null, rpmSeries: [] });
  const m = manifestJson(motor(), [t2, t1]);
  assert.equal(m.opnames.length, 2);
  const o = m.opnames[0];
  assert.deepEqual(Object.keys(o).filter((k) => ['bestand', 'soort', 'positie', 'rpmIngevoerd', 'rpmGeschat', 'duurSeconden', 'piekDbfs', 'datumTijd', 'notities'].includes(k)).length, 9);
  assert.equal(o.bestand, 'motorkap_constant_2500rpm.wav');
  assert.equal(o.soort, 'constant');
  assert.equal(o.positie, 'motorkap');
  assert.equal(o.rpmIngevoerd, 2500);
  assert.equal(o.rpmGeschat, 2512);
  assert.equal(o.rpmZekerheid, 0.81);
  assert.equal(o.duurSeconden, 10.021);
  assert.equal(o.piekDbfs, -6);
  assert.equal(o.datumTijd, t1.createdAt);
  assert.equal(o.notities, 'airco uit');
  assert.deepEqual(o.rpmVerloop, [[0.25, 2510, 0.81]]);
  assert.equal(m.opnames[1].bestand, 'motorkap_stilte.wav');
  assert.equal(m.opnames[1].rpmGeschat, null);
  JSON.parse(JSON.stringify(m)); // geen NaN/undefined-problemen
});

test('zip: map met WAV\'s, motor.json en manifest.json; CRC klopt', () => {
  const t1 = take(), t2 = take({ kind: 'stilte', rpmTarget: null });
  const wav = encodeWav(new Float32Array(4801).fill(0.25), 48000, 24);
  const z = exportZip(motor(), [t1, t2], new Map([[t1.id, wav], [t2.id, wav]]));
  assert.equal(z.fileName, 'Skoda_Octavia_2.0_TSI.zip');
  const bytes = Buffer.concat(z.parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
  const files = readZip(new Uint8Array(bytes));
  assert.deepEqual(files.map((f) => f.name), [
    'Skoda_Octavia_2.0_TSI/motor.json',
    'Skoda_Octavia_2.0_TSI/manifest.json',
    'Skoda_Octavia_2.0_TSI/motorkap_constant_2500rpm.wav',
    'Skoda_Octavia_2.0_TSI/motorkap_stilte.wav',
  ]);
  const manifest = JSON.parse(new TextDecoder().decode(files[1].data));
  assert.deepEqual(manifest.opnames.map((o) => o.bestand), ['motorkap_constant_2500rpm.wav', 'motorkap_stilte.wav']);
  assert.equal(decodeWav(files[2].data).samples.length, 4801);
});

test('crc32 bekende waarde', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
});

test('opnamelijst en status', () => {
  const m = motor();
  const items = recordingItems(m);
  assert.deepEqual(items.map((i) => i.key), [
    'stilte', 'constant-800', 'constant-1500', 'constant-2500', 'constant-3500', 'constant-4500', 'constant-5500',
    'gaslos-4000', 'optrekken-5000',
  ]);
  const it = items[3];
  assert.equal(itemStatus(it, 'motorkap', []), 'nog niet');
  assert.equal(itemStatus(it, 'motorkap', [take()]), 'opgenomen');
  assert.equal(itemStatus(it, 'uitlaat', [take()]), 'nog niet');
  assert.equal(itemStatus(it, 'motorkap', [take(), take({ redo: true })]), 'opnieuw');
});
