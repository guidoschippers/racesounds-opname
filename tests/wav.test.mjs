import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeWav, encodeWav, levels } from '../js/wav.js';

const ascii = (b, off) => String.fromCharCode(...b.subarray(off, off + 4));

test('header is een standaard 44-byte PCM-header (mono, 48 kHz, 24-bit)', () => {
  const b = encodeWav(new Float32Array(1000), 48000, 24);
  const v = new DataView(b.buffer);
  assert.equal(ascii(b, 0), 'RIFF');
  assert.equal(v.getUint32(4, true), b.length - 8);
  assert.equal(ascii(b, 8), 'WAVE');
  assert.equal(ascii(b, 12), 'fmt ');
  assert.equal(v.getUint32(16, true), 16);
  assert.equal(v.getUint16(20, true), 1); // PCM
  assert.equal(v.getUint16(22, true), 1); // mono
  assert.equal(v.getUint32(24, true), 48000);
  assert.equal(v.getUint32(28, true), 48000 * 3);
  assert.equal(v.getUint16(32, true), 3);
  assert.equal(v.getUint16(34, true), 24);
  assert.equal(ascii(b, 36), 'data');
  assert.equal(v.getUint32(40, true), 3000);
  assert.equal(b.length, 44 + 3000);
});

test('16-bit header', () => {
  const b = encodeWav(new Float32Array(10), 44100, 16);
  const v = new DataView(b.buffer);
  assert.equal(v.getUint32(28, true), 88200);
  assert.equal(v.getUint16(32, true), 2);
  assert.equal(v.getUint16(34, true), 16);
  assert.equal(v.getUint32(40, true), 20);
  assert.equal(b.length, 64);
});

test('oneven datalengte krijgt een padbyte (RIFF), datagrootte blijft exact', () => {
  const b = encodeWav(new Float32Array(3), 48000, 24);
  const v = new DataView(b.buffer);
  assert.equal(v.getUint32(40, true), 9);
  assert.equal(b.length, 44 + 10);
  assert.equal(v.getUint32(4, true), b.length - 8);
  assert.equal(decodeWav(b).samples.length, 3);
});

for (const bits of [16, 24]) {
  test(`heen en terug ${bits}-bit binnen 1 LSB`, () => {
    const n = 4800;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.9 * Math.sin(2 * Math.PI * 440 * i / 48000);
    const w = decodeWav(encodeWav(x, 48000, bits));
    assert.equal(w.sampleRate, 48000);
    assert.equal(w.bitDepth, bits);
    assert.equal(w.channels, 1);
    assert.equal(w.headerBytes, 44);
    // Schrijven schaalt met 2^(n-1)-1, lezen met 2^(n-1) (zoals Racesounds): max. 1,5 LSB verschil.
    const lsb = 1.5 / (bits === 16 ? 32767 : 8388607);
    for (let i = 0; i < n; i++) assert.ok(Math.abs(w.samples[i] - x[i]) <= lsb, `sample ${i}`);
  });
}

test('clipt buiten -1..1 en negatieve 24-bit waarden kloppen', () => {
  const w = decodeWav(encodeWav(Float32Array.from([2, -2, -0.5, NaN]), 48000, 24));
  assert.ok(Math.abs(w.samples[0] - 1) < 1e-6);
  assert.ok(Math.abs(w.samples[1] + 1) < 1e-6);
  assert.ok(Math.abs(w.samples[2] + 0.5) < 1e-6);
  assert.equal(w.samples[3], 0);
});

test('niveaus: piek, rms en clipping', () => {
  const x = new Float32Array(1000).fill(0.5);
  x[10] = 1;
  const l = levels(x);
  assert.ok(Math.abs(l.peakDbfs) < 1e-6);
  assert.ok(Math.abs(l.rmsDbfs - 20 * Math.log10(Math.sqrt((999 * 0.25 + 1) / 1000))) < 1e-6);
  assert.equal(l.clippedSamples, 1);
});
