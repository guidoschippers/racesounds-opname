import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTake, estimateLive, firingHz, MIN_CONFIDENCE, rpmFromFiringHz, searchRange } from '../js/rpm.js';
import { sawtooth, synthEngine } from '../js/synth.js';

const near = (got, want, tol, msg) =>
  assert.ok(got != null && Math.abs(got / want - 1) <= tol, `${msg}: ${got?.toFixed?.(0)} i.p.v. ${want}`);

test('ontstekingsfrequentie: 4-cilinder = rpm/30', () => {
  assert.equal(firingHz(3000, 4), 100);
  assert.equal(firingHz(6000, 8), 400);
  assert.equal(rpmFromFiringHz(100, 4), 3000);
});

test('zaagtand op bekend toerental (4 cil.)', () => {
  for (const rpm of [800, 1500, 2380, 3806, 6000]) {
    const r = analyzeTake(sawtooth({ rpm, seconds: 3 }), 48000, { cylinders: 4, ...searchRange({ idleRpm: 800, limiterRpm: 6500 }) });
    near(r.rpm, rpm, 0.01, `zaagtand ${rpm}`);
    assert.ok(r.confidence > 0.5);
  }
});

const cases = [
  // [rpm, cilinders, stationair, begrenzer, netbrom, ruis]
  [800, 4, 800, 6500, 0, 0.02],
  [1500, 4, 800, 6500, 0.3, 0.05], // brom op exact de ontstekingsfrequentie
  [2380, 4, 800, 6500, 0.3, 0.05], // afgelezen 1800, echt ~2380
  [3806, 4, 800, 6500, 0, 0.05],   // afgelezen 2800, echt ~3806
  [5500, 4, 800, 6500, 0, 0.1],
  [4000, 3, 900, 6500, 0, 0.05],
  [2000, 5, 800, 6500, 0, 0.05],
  [3000, 6, 700, 7000, 0.2, 0.05],
  [1000, 8, 700, 7000, 0, 0.05],
  [7000, 8, 700, 7500, 0, 0.05],
  [9000, 12, 1000, 9500, 0, 0.05],
];
for (const [rpm, cyl, idle, limiter, hum, noise] of cases) {
  test(`pulstrein ${cyl} cil. ${rpm} rpm${hum ? ' + 50 Hz brom' : ''}`, () => {
    const x = synthEngine({ rpm, cylinders: cyl, seconds: 3, hum, noise, seed: rpm + cyl });
    const r = analyzeTake(x, 48000, { cylinders: cyl, ...searchRange({ idleRpm: idle, limiterRpm: limiter }) });
    near(r.rpm, rpm, 0.01, 'mediaan');
    assert.ok(r.spread < 0.02, `spreiding ${r.spread}`);
    const wrong = r.series.filter((s) => Math.abs(s.rpm / rpm - 1) > 0.03);
    assert.equal(wrong.length, 0, `fragmenten ernaast: ${wrong.map((s) => s.rpm.toFixed(0))}`);
  });
}

test('ook bij 44,1 kHz', () => {
  const x = synthEngine({ rpm: 2500, sampleRate: 44100, seconds: 2 });
  near(analyzeTake(x, 44100, { cylinders: 4, minRpm: 480, maxRpm: 7500 }).rpm, 2500, 0.01, '44,1 kHz');
});

test('live schatting op de laatste seconde', () => {
  const x = synthEngine({ rpm: 3200, seconds: 2, seed: 7 });
  const e = estimateLive(x, 48000, { cylinders: 4, minRpm: 480, maxRpm: 7500 });
  near(e.rpm, 3200, 0.01, 'live');
  assert.ok(e.confidence >= MIN_CONFIDENCE);
  assert.equal(estimateLive(x.subarray(0, 4800), 48000, { cylinders: 4, minRpm: 480, maxRpm: 7500 }), null, 'te kort');
});

test('gas los: verloop zakt van ~4000 naar stationair', () => {
  const rpm = (t) => (t < 1 ? 4000 : 800 + 3200 * Math.exp(-(t - 1) / 0.8));
  const x = synthEngine({ rpm, seconds: 6, seed: 3 });
  const r = analyzeTake(x, 48000, { cylinders: 4, minRpm: 480, maxRpm: 7500 });
  const good = r.series.filter((s) => s.confidence >= MIN_CONFIDENCE);
  near(good[0].rpm, 4000, 0.05, 'begin');
  near(good[good.length - 1].rpm, rpm(good[good.length - 1].t), 0.05, 'eind');
});

test('stilte/ruis geeft geen zeker toerental', () => {
  // xorshift (een simpele LCG heeft periodieke structuur die de kam wél vindt)
  let s = 12345;
  const x = new Float32Array(48000 * 4).map(() => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return 0.01 * (s / 2 ** 32 - 0.5);
  });
  const r = analyzeTake(x, 48000, { cylinders: 4, minRpm: 480, maxRpm: 7500 });
  const sure = r.series.filter((f) => f.confidence >= MIN_CONFIDENCE);
  assert.ok(sure.length <= r.series.length * 0.2, `${sure.length}/${r.series.length} zeker op ruis`);
  assert.equal(analyzeTake(new Float32Array(48000), 48000, { cylinders: 4, minRpm: 480, maxRpm: 7500 }).rpm, null);
});
