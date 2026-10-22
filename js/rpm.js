// Toerentalschatting uit het geluid.
// De ontstekingsfrequentie is (cilinders/2) x rpm/60 (4-cilinder: rpm/30). We zoeken die
// grondtoon met een harmonische kam over het spectrum: score(f0) = som over de eerste K
// harmonischen van (niveau op h*f0 - niveau halverwege, op (h-0,5)*f0). Het vaste aantal
// harmonischen en de straf op de tussenliggende plekken voorkomen octaaffouten: f0/2 scoort
// dan maar de helft (de helft van de kampunten valt in gaten), 2*f0 krijgt de oneven
// harmonischen als straf.
// Puur (geen browser-API's), zodat het ook onder Node getest kan worden.

export const HARMONICS = 8;
/** Gewicht van de straf halverwege de harmonischen. */
const GAP_WEIGHT = 0.5;
/** Vermogensverhouding (~11 dB) waarboven een veelvoud als ontstekingsfrequentie geldt. Afgestemd
 * op drie Skoda-opnames (I4, 790/2360/3806 rpm) en synthetische 3- t/m 12-cilinders. */
const DOMINANCE = 12;

export function firingHz(rpm, cylinders) {
  return (cylinders / 2) * rpm / 60;
}

export function rpmFromFiringHz(hz, cylinders) {
  return hz * 60 * 2 / cylinders;
}

/** Zoekbereik in rpm voor een motor: ruim onder stationair tot ruim boven de begrenzer. */
export function searchRange(motor) {
  const idle = Number(motor?.idleRpm) || 800;
  const limiter = Number(motor?.limiterRpm) || 6500;
  return { minRpm: Math.max(300, Math.round(idle * 0.6)), maxRpm: Math.round(limiter * 1.15) };
}

// --- FFT (radix-2, in place) ---------------------------------------------------------------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

// --- Decimeren -------------------------------------------------------------------------------

/** Butterworth-laagdoorlaat 4e orde (twee biquads) en elke d-de sample bewaren. */
export function decimate(x, fs, d) {
  if (d <= 1) return Float64Array.from(x);
  const fc = 0.42 * fs / (2 * d);
  let y = Float64Array.from(x);
  for (const q of [0.5412, 1.3066]) y = biquadLowpass(y, fs, fc, q);
  const out = new Float64Array(Math.floor(y.length / d));
  for (let i = 0; i < out.length; i++) out[i] = y[i * d];
  return out;
}

function biquadLowpass(x, fs, fc, q) {
  const w = 2 * Math.PI * fc / fs;
  const alpha = Math.sin(w) / (2 * q);
  const cw = Math.cos(w);
  const a0 = 1 + alpha;
  const b0 = (1 - cw) / 2 / a0, b1 = (1 - cw) / a0, b2 = b0;
  const a1 = -2 * cw / a0, a2 = (1 - alpha) / a0;
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/** Decimatiefactor zodat de K-de harmonische van de hoogste ontstekingsfrequentie er nog in past. */
export function decimationFor(fs, cylinders, maxRpm) {
  const need = Math.max(4000, 2.5 * HARMONICS * firingHz(maxRpm, cylinders));
  return Math.max(1, Math.floor(fs / need));
}

// --- Schatting op één fragment ---------------------------------------------------------------

/**
 * Schat het toerental van een (al gedecimeerd) fragment.
 * Geeft { rpm, hz, confidence } (confidence 0..1) of null als er te weinig signaal is.
 */
export function estimateFrame(x, fs, { cylinders, minRpm, maxRpm }) {
  const n = nextPow2(x.length);
  const re = new Float64Array(n), im = new Float64Array(n);
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length || 1;
  let energy = 0;
  for (let i = 0; i < x.length; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (x.length - 1));
    re[i] = (x[i] - mean) * w;
    energy += re[i] * re[i];
  }
  if (energy < 1e-12) return null;
  fft(re, im);
  const binHz = fs / n;
  const half = n / 2;
  const mag = new Float64Array(half);
  for (let k = 0; k < half; k++) mag[k] = Math.hypot(re[k], im[k]);

  const fMin = firingHz(minRpm, cylinders);
  const fMax = firingHz(maxRpm, cylinders);
  const topBin = Math.min(half - 2, Math.ceil(HARMONICS * fMax / binHz) + 2);
  const lowBin = Math.max(1, Math.floor(0.5 * fMin / binHz));
  // Ruisvloer = mediaan over het gebruikte bereik; wortelcompressie zodat veel zwakke harmonischen
  // meetellen en één sterke piek (of netbrom) niet alles bepaalt.
  const floor = median(Array.from(mag.subarray(lowBin, topBin))) || 1e-12;
  const A = new Float64Array(half);
  for (let k = 0; k < half; k++) A[k] = Math.sqrt(mag[k] / floor);
  const at = (f) => {
    const p = f / binHz;
    const i = Math.floor(p);
    if (i < 0 || i + 1 >= half) return 0;
    const t = p - i;
    return A[i] * (1 - t) + A[i + 1] * t;
  };
  const score = (f0) => {
    let s = 0;
    for (let h = 1; h <= HARMONICS; h++) s += at(h * f0) - GAP_WEIGHT * at((h - 0.5) * f0);
    return s;
  };

  // Grof raster in stappen van 0,2%, daarna parabolisch verfijnen.
  const step = 1.002;
  let best = -Infinity, bestF = 0;
  const scores = [];
  for (let f = fMin; f <= fMax; f *= step) {
    const s = score(f);
    scores.push(s);
    if (s > best) { best = s; bestF = f; }
  }
  if (!(best > 0)) return null;
  const sl = score(bestF / step), sr = score(bestF * step);
  const den = sl - 2 * best + sr;
  const shift = den < 0 ? Math.max(-1, Math.min(1, 0.5 * (sl - sr) / den)) : 0;
  let hz = bestF * Math.pow(step, shift);

  // Stap 2: bij ongelijke cilinders zijn ook de halve orden sterk en wint de kam op de
  // cyclusfrequentie (rpm/120) of de omwentelingsfrequentie. Controleer daarom veelvouden j*hz:
  // als het vermogen op de harmonischen van j*hz ruim domineert over de overige harmonischen
  // van hz, is j*hz de ontstekingsfrequentie. Grootste j die voldoet wint. Alleen delers van het
  // aantal cilinders (cyclus, omwenteling, per bank): bij stationair is de 3e harmonische vaak
  // de sterkste, en die mag geen 3x te hoog toerental opleveren.
  {
    const pw = (f) => {
      const c = Math.round(f / binHz);
      let m = 0;
      for (let k = c - 2; k <= c + 2; k++) if (k > 0 && k < half) m = Math.max(m, mag[k] * mag[k]);
      return m;
    };
    const fLimit = 0.45 * fs;
    const base = hz;
    for (let j = Math.min(cylinders, Math.floor(fMax * 1.0001 / base)); j >= 2; j--) {
      if (cylinders % j !== 0) continue;
      let pj = 0, nj = 0, pr = 0, nr = 0;
      for (let m = 1; m <= HARMONICS * j && m * base < fLimit; m++) {
        if (m % j === 0) { pj += pw(m * base); nj++; } else { pr += pw(m * base); nr++; }
      }
      if (nj >= 2 && nr > 0 && pj / nj >= DOMINANCE * (pr / nr)) { hz = base * j; break; }
    }
  }

  // Zekerheid: hoe ver steekt de beste kamscore boven de mediaan van alle kandidaten uit?
  // Witte ruis geeft ~0,35-0,47, de Skoda-opnames 0,6-0,85, schone pulstreinen > 0,8.
  const confidence = Math.max(0, Math.min(1, (best - median(scores)) / best));
  return { rpm: rpmFromFiringHz(hz, cylinders), hz, confidence };
}

function median(a) {
  if (!a.length) return 0;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const p = (sorted.length - 1) * q;
  const i = Math.floor(p);
  const t = p - i;
  return i + 1 < sorted.length ? sorted[i] * (1 - t) + sorted[i + 1] * t : sorted[i];
}

// --- Live en hele opname ---------------------------------------------------------------------

/** Schatting op de laatste ~seconds van een (niet gedecimeerd) signaal; voor de live weergave. */
export function estimateLive(x, fs, opts, seconds = 1.0) {
  const range = { minRpm: opts.minRpm, maxRpm: opts.maxRpm };
  const d = decimationFor(fs, opts.cylinders, range.maxRpm);
  const n = Math.min(x.length, Math.round(seconds * fs));
  if (n < 0.25 * fs) return null;
  const y = decimate(x.subarray(x.length - n), fs, d);
  return estimateFrame(y, fs / d, { cylinders: opts.cylinders, ...range });
}

/**
 * Analyse van een hele opname: schattingen per fragment (frameSeconds, hop frameSeconds/2).
 * rpm = mediaan van de betrouwbare fragmenten; spread = (p90 - p10) / mediaan.
 */
export function analyzeTake(x, fs, opts, frameSeconds = 0.5) {
  const d = decimationFor(fs, opts.cylinders, opts.maxRpm);
  const y = decimate(x, fs, d);
  const fsd = fs / d;
  const frame = Math.round(frameSeconds * fsd);
  const hop = Math.max(1, Math.round(frame / 2));
  const series = [];
  for (let start = 0; start + frame <= y.length; start += hop) {
    const e = estimateFrame(y.subarray(start, start + frame), fsd, opts);
    if (e) series.push({ t: (start + frame / 2) / fsd, rpm: e.rpm, confidence: e.confidence });
  }
  const good = series.filter((s) => s.confidence >= MIN_CONFIDENCE);
  if (!good.length) return { rpm: null, confidence: 0, spread: null, series };
  const sorted = good.map((s) => s.rpm).sort((a, b) => a - b);
  const rpm = quantile(sorted, 0.5);
  return {
    rpm,
    confidence: median(good.map((s) => s.confidence)),
    spread: (quantile(sorted, 0.9) - quantile(sorted, 0.1)) / rpm,
    series,
  };
}

/** Onder deze zekerheid toont de app de schatting als onzeker. */
export const MIN_CONFIDENCE = 0.55;
