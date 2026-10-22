// Toerentalschatting op een WAV-bestand (voor controle op echte opnames):
//   node tools/estimate.mjs opname.wav [cilinders=4] [stationair=800] [begrenzer=6500]
import { readFileSync } from 'node:fs';
import { decodeWav } from '../js/wav.js';
import { analyzeTake, searchRange } from '../js/rpm.js';

const [file, cyl = '4', idle = '800', limiter = '6500'] = process.argv.slice(2);
const wav = decodeWav(readFileSync(file));
const opts = { cylinders: Number(cyl), ...searchRange({ idleRpm: Number(idle), limiterRpm: Number(limiter) }) };
const t0 = performance.now();
const r = analyzeTake(wav.samples, wav.sampleRate, opts, 1.0);
console.log(`${file}: ${wav.sampleRate} Hz, ${wav.bitDepth}-bit, ${(wav.samples.length / wav.sampleRate).toFixed(2)} s`);
console.log(`geschat ${r.rpm?.toFixed(0)} rpm, zekerheid ${r.confidence.toFixed(2)}, spreiding ${(100 * (r.spread ?? 0)).toFixed(1)}%  (${(performance.now() - t0).toFixed(0)} ms)`);
console.log(r.series.map((s) => `${s.t.toFixed(1)}s:${s.rpm.toFixed(0)}(${s.confidence.toFixed(2)})`).join(' '));
