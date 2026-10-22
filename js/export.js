// Export van een motor: bestandsnamen, motor.json, manifest.json en de zip.
// Puur (geen browser-API's): de WAV-data wordt als Uint8Array aangeleverd.

import { byDate, KINDS, POSITIONS } from './model.js';
import { makeZip } from './zip.js';

export const APP_NAME = 'racesounds-opname';
export const FORMAT_VERSION = 1;

/** Map- en bestandsnaamveilige naam: "Skoda Octavia 2.0 TSI" -> "Skoda_Octavia_2.0_TSI". */
export function safeName(s) {
  const t = String(s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9.\-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.]+|[_.]+$/g, '');
  return t || 'motor';
}

/** <positie>_<soort>_<rpm>rpm, of <positie>_stilte. */
export function baseName(take) {
  return take.kind === 'stilte' ? `${take.position}_stilte` : `${take.position}_${take.kind}_${take.rpmTarget}rpm`;
}

/**
 * Bestandsnamen voor alle opnames: de oudste opname met een naam krijgt de kale naam, volgende
 * opnames _2, _3, ... Geeft een Map take.id -> bestandsnaam.
 */
export function assignFileNames(takes) {
  const groups = new Map();
  for (const t of [...takes].sort(byDate)) {
    const b = baseName(t);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(t);
  }
  const names = new Map();
  for (const [b, list] of groups) list.forEach((t, i) => names.set(t.id, i === 0 ? `${b}.wav` : `${b}_${i + 1}.wav`));
  return names;
}

export function motorJson(motor) {
  return {
    app: APP_NAME,
    formaat: FORMAT_VERSION,
    naam: motor.name,
    merk: motor.make,
    model: motor.model,
    bouwjaar: motor.year === '' ? null : Number(motor.year) || motor.year,
    motorcode: motor.engineCode,
    cilinders: Number(motor.cylinders),
    opbouw: motor.layout,
    inhoudCc: Number(motor.displacementCc) || null,
    brandstof: motor.fuel,
    turbo: !!motor.turbo,
    stationairRpm: Number(motor.idleRpm) || null,
    begrenzerRpm: Number(motor.limiterRpm) || null,
    notities: motor.notes || '',
  };
}

const round = (x, d = 0) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

export function manifestJson(motor, takes, names = assignFileNames(takes)) {
  const opnames = [...takes].sort(byDate).map((t) => ({
    bestand: names.get(t.id),
    soort: t.kind,
    soortOmschrijving: KINDS[t.kind]?.label ?? t.kind,
    positie: t.position,
    positieOmschrijving: POSITIONS.find((p) => p.id === t.position)?.label ?? t.position,
    rpmDoel: t.rpmTarget ?? null,
    rpmIngevoerd: t.rpmEntered ?? null,
    rpmGeschat: round(t.rpmEstimated),
    rpmZekerheid: round(t.rpmConfidence, 2),
    rpmSpreiding: round(t.rpmSpread, 3),
    rpmVerloop: (t.rpmSeries || []).map((s) => [round(s.t, 2), round(s.rpm), round(s.confidence, 2)]),
    duurSeconden: round(t.durationSeconds, 3),
    piekDbfs: round(t.peakDbfs, 1),
    rmsDbfs: round(t.rmsDbfs, 1),
    geclipteSamples: t.clippedSamples ?? 0,
    sampleRate: t.sampleRate,
    bitDiepte: t.bitDepth,
    datumTijd: t.createdAt,
    opnieuw: !!t.redo,
    notities: t.notes || '',
  }));
  return {
    app: APP_NAME,
    formaat: FORMAT_VERSION,
    motor: motor.name,
    cilinders: Number(motor.cylinders),
    geexporteerd: new Date().toISOString(),
    toelichting: {
      rpmIngevoerd: 'afgelezen/ingevoerd toerental',
      rpmGeschat: 'uit het geluid (ontstekingsfrequentie = cilinders/2 x rpm/60), mediaan over de opname',
      rpmVerloop: '[tijd s, rpm, zekerheid 0..1] per 0,25 s',
    },
    opnames,
  };
}

/**
 * Alle bestanden voor de motormap: [{ name, data }], met data Uint8Array (WAV) of string (JSON).
 * wavBytes: Map take.id -> Uint8Array.
 */
export function exportFiles(motor, takes, wavBytes) {
  const names = assignFileNames(takes);
  const files = [
    { name: 'motor.json', data: JSON.stringify(motorJson(motor), null, 2) + '\n' },
    { name: 'manifest.json', data: JSON.stringify(manifestJson(motor, takes, names), null, 2) + '\n' },
  ];
  for (const t of [...takes].sort(byDate)) {
    const data = wavBytes.get(t.id);
    if (data) files.push({ name: names.get(t.id), data, date: new Date(t.createdAt) });
  }
  return files;
}

/** Zip met één map <motornaam>/ erin. Geeft { fileName, parts }. */
export function exportZip(motor, takes, wavBytes) {
  const folder = safeName(motor.name);
  const files = exportFiles(motor, takes, wavBytes).map((f) => ({ ...f, name: `${folder}/${f.name}` }));
  return { fileName: `${folder}.zip`, folder, parts: makeZip(files) };
}
