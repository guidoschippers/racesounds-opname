// Integratie: een geëxporteerde zip uitpakken (tar) en de WAV door racesounds-cli --analyze-file
// halen. Wordt overgeslagen als racesounds-cli niet gevonden wordt (RACESOUNDS_CLI = pad).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportZip } from '../js/export.js';
import { newMotor } from '../js/model.js';
import { analyzeTake } from '../js/rpm.js';
import { synthEngine } from '../js/synth.js';
import { decodeWav, encodeWav, levels } from '../js/wav.js';

const CLI = process.env.RACESOUNDS_CLI || 'C:/repos/Racesounds/build/bin/Release/racesounds-cli.exe';
const skip = existsSync(CLI) ? false : `racesounds-cli niet gevonden (${CLI})`;

// Op Windows de ingebouwde bsdtar (pakt zip uit); GNU tar uit Git Bash kan dat niet.
const TAR = process.platform === 'win32' && existsSync('C:/Windows/System32/tar.exe') ? 'C:/Windows/System32/tar.exe' : 'tar';

function hasTar() {
  try {
    execFileSync(TAR, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('geëxporteerde WAV is leesbaar voor racesounds-cli --analyze-file', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-opname-'));
  try {
    const motor = { ...newMotor(), id: 'm', name: 'Test I4' };
    const rpm = 2380;
    const samples = synthEngine({ rpm, cylinders: 4, seconds: 4, seed: 11 });
    const lv = levels(samples);
    const est = analyzeTake(samples, 48000, { cylinders: 4, minRpm: 480, maxRpm: 7500 });
    const take = {
      id: 't1', motorId: 'm', kind: 'constant', position: 'motorkap', rpmTarget: 1800, rpmEntered: 1800,
      rpmEstimated: est.rpm, rpmConfidence: est.confidence, rpmSpread: est.spread, rpmSeries: est.series,
      durationSeconds: 4, peakDbfs: lv.peakDbfs, rmsDbfs: lv.rmsDbfs, clippedSamples: 0, sampleRate: 48000, bitDepth: 24,
      createdAt: new Date().toISOString(), notes: '', redo: false,
    };
    const z = exportZip(motor, [take], new Map([['t1', encodeWav(samples, 48000, 24)]]));
    const zipPath = join(dir, z.fileName);
    writeFileSync(zipPath, Buffer.concat(z.parts));

    let wavPath;
    if (hasTar()) {
      execFileSync(TAR, ['-xf', z.fileName], { cwd: dir });
      wavPath = join(dir, z.folder, 'motorkap_constant_1800rpm.wav');
      const manifest = JSON.parse(readFileSync(join(dir, z.folder, 'manifest.json'), 'utf8'));
      assert.equal(manifest.opnames[0].bestand, 'motorkap_constant_1800rpm.wav');
      assert.ok(Math.abs(manifest.opnames[0].rpmGeschat / rpm - 1) < 0.01);
      assert.ok(existsSync(join(dir, z.folder, 'motor.json')));
    } else {
      wavPath = join(dir, 'los.wav');
      writeFileSync(wavPath, encodeWav(samples, 48000, 24));
    }
    assert.equal(decodeWav(readFileSync(wavPath)).headerBytes, 44);

    const out = execFileSync(CLI, ['--analyze-file', wavPath, '--cyl', '4', '--from', '0.5', '--to', '3.5'], { encoding: 'utf8' });
    assert.match(out, /48000 Hz, 24-bit, 1 kanaal/);
    assert.match(out, /4\.00 s/);
    const rpms = [...out.matchAll(/(\d+) rpm\s*$/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
    assert.ok(rpms.length > 5, out);
    const median = rpms[rpms.length >> 1];
    assert.ok(Math.abs(median / rpm - 1) < 0.02, `racesounds-cli schat ${median} i.p.v. ${rpm}\n${out}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
