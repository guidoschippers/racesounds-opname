// Gegevensmodel: motoren, opnamesoorten, posities, het opnameprotocol en de status per item.
// Puur (geen browser-API's).

export const POSITIONS = [
  { id: 'motorkap', label: 'Zijkant motorkap' },
  { id: 'uitlaat', label: 'Uitlaat' },
  { id: 'interieur', label: 'Interieur' },
  { id: 'onboard', label: 'Onboard' },
];

export const KINDS = {
  stilte: {
    label: 'Stilte (motor uit)',
    instruction: 'Zet de motor UIT. Niet praten, niets aanraken.',
    seconds: 5,
  },
  constant: {
    label: 'Constant toerental',
    instruction: 'Breng het toerental op {rpm} tpm en houd het vast. Kijk naar de schatting hieronder.',
    minSeconds: 8,
    seconds: 12,
  },
  gaslos: {
    label: 'Gas los',
    instruction: 'Houd ~{rpm} tpm vast. Bij "LOS!" het gas in één keer loslaten en laten terugzakken.',
    cueAt: 3,
    cue: 'LOS!',
    seconds: 10,
  },
  optrekken: {
    label: 'Rustig optrekken',
    instruction: 'Motor stationair. Bij "GAS!" in ~5 s rustig naar ~{rpm} tpm, dan los.',
    cueAt: 2,
    cue: 'GAS!',
    rampSeconds: 5,
    seconds: 10,
  },
};

export const DEFAULT_RPM_TARGETS = ['idle', 1500, 2500, 3500, 4500, 5500];
export const GASLOS_RPM = 4000;
export const OPTREKKEN_RPM = 5000;

export function newMotor() {
  return {
    id: newId(),
    name: '',
    make: '',
    model: '',
    year: '',
    engineCode: '',
    cylinders: 4,
    layout: 'lijn', // lijn | V | boxer
    displacementCc: 2000,
    fuel: 'benzine', // benzine | diesel
    turbo: false,
    idleRpm: 800,
    limiterRpm: 6500,
    notes: '',
    rpmTargets: [...DEFAULT_RPM_TARGETS],
    createdAt: new Date().toISOString(),
  };
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/** Toerental van een lijstwaarde ('idle' = stationair van de motor). */
export function resolveRpm(motor, target) {
  return target === 'idle' ? Number(motor.idleRpm) || 800 : Number(target);
}

/**
 * De op te nemen items voor een motor, in protocolvolgorde: eerst stilte, dan de constante
 * toerentallen (oplopend), dan gas los en optrekken.
 */
export function recordingItems(motor) {
  const items = [{ key: 'stilte', kind: 'stilte', rpm: null, label: 'Stilte (motor uit)' }];
  const seen = new Set();
  const targets = (motor.rpmTargets?.length ? motor.rpmTargets : DEFAULT_RPM_TARGETS)
    .map((t) => ({ t, rpm: resolveRpm(motor, t) }))
    .filter(({ rpm }) => rpm > 0)
    .sort((a, b) => a.rpm - b.rpm);
  for (const { t, rpm } of targets) {
    if (seen.has(rpm)) continue;
    seen.add(rpm);
    items.push({
      key: `constant-${rpm}`,
      kind: 'constant',
      rpm,
      label: t === 'idle' ? `Stationair (${rpm} tpm)` : `${rpm} tpm`,
    });
  }
  items.push({ key: `gaslos-${GASLOS_RPM}`, kind: 'gaslos', rpm: GASLOS_RPM, label: `Gas los (${GASLOS_RPM} → stationair)` });
  items.push({ key: `optrekken-${OPTREKKEN_RPM}`, kind: 'optrekken', rpm: OPTREKKEN_RPM, label: `Rustig optrekken (→ ${OPTREKKEN_RPM})` });
  return items;
}

/** Hoort een opname bij een item? */
export function takeMatches(take, item, position) {
  return take.position === position && take.kind === item.kind && (item.rpm == null || take.rpmTarget === item.rpm);
}

/** Status van een item: 'nog niet' | 'opgenomen' | 'opnieuw' (laatste opname gemarkeerd). */
export function itemStatus(item, position, takes) {
  const mine = takes.filter((t) => takeMatches(t, item, position)).sort(byDate);
  if (!mine.length) return 'nog niet';
  return mine[mine.length - 1].redo ? 'opnieuw' : 'opgenomen';
}

export function byDate(a, b) {
  return String(a.createdAt).localeCompare(String(b.createdAt));
}

/** Waarschuwingen bij een opname (niveau en lengte). */
export function takeWarnings(take) {
  const w = [];
  if (take.clippedSamples > 0) w.push('Oversturing (clipping): zet de telefoon verder weg of kies een andere plek.');
  if (take.kind !== 'stilte' && take.peakDbfs < -30) w.push('Signaal erg zacht: telefoon dichterbij leggen.');
  const k = KINDS[take.kind];
  if (k?.minSeconds && take.durationSeconds < k.minSeconds) w.push(`Korter dan ${k.minSeconds} s.`);
  return w;
}

export function fillRpm(text, rpm) {
  return text.replace('{rpm}', rpm == null ? '' : String(rpm));
}
