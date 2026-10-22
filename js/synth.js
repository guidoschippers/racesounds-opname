// Synthetisch motorsignaal voor tests en de testbron in de app (?bron=synth):
// een pulstrein op de ontstekingsfrequentie, elke ontsteking een uitstervende resonantie,
// met vaste verschillen per cilinder (halve orden), ruis en optioneel 50 Hz-netbrom.
// rpm mag een getal of een functie van de tijd (s) zijn.

export function synthEngine({
  rpm,
  cylinders = 4,
  seconds = 3,
  sampleRate = 48000,
  noise = 0.02,
  hum = 0,
  level = 0.5,
  seed = 1,
}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const rpmAt = typeof rpm === 'function' ? rpm : () => rpm;
  let state = seed >>> 0 || 1;
  const rand = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 4294967296 - 0.5;
  };
  const cylGain = Array.from({ length: cylinders }, (_, i) => 1 + 0.15 * Math.sin(1.7 * i + seed));
  // Resonanties van uitlaat/blok.
  const modes = [
    { hz: 110, decay: 0.012, g: 1.0 },
    { hz: 420, decay: 0.005, g: 0.5 },
    { hz: 1300, decay: 0.002, g: 0.25 },
  ];
  const pulses = []; // actieve pulsen: { t0, gain }
  let phase = 0; // in ontstekingen
  let cyl = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const fFire = (cylinders / 2) * rpmAt(t) / 60;
    phase += fFire / sampleRate;
    if (phase >= 1) {
      phase -= 1;
      pulses.push({ t0: t, gain: cylGain[cyl] });
      cyl = (cyl + 1) % cylinders;
    }
    let s = 0;
    for (let p = pulses.length - 1; p >= 0; p--) {
      const dt = t - pulses[p].t0;
      if (dt > 0.08) { pulses.splice(p, 1); continue; }
      for (const m of modes) s += pulses[p].gain * m.g * Math.exp(-dt / m.decay) * Math.sin(2 * Math.PI * m.hz * dt);
    }
    s += noise * 4 * rand();
    if (hum) s += hum * (Math.sin(2 * Math.PI * 50 * t) + 0.3 * Math.sin(2 * Math.PI * 150 * t));
    out[i] = s;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const g = peak > 0 ? level / peak : 1;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** Zaagtand op de ontstekingsfrequentie (eenvoudigste periodieke testsignaal). */
export function sawtooth({ rpm, cylinders = 4, seconds = 2, sampleRate = 48000, level = 0.5 }) {
  const f = (cylinders / 2) * rpm / 60;
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) {
    const p = (i * f / sampleRate) % 1;
    out[i] = level * (2 * p - 1);
  }
  return out;
}
