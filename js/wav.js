// PCM WAV: mono, 16- of 24-bit, standaard 44-byte header (RIFF/fmt/data, geen extra chunks).
// Puur (geen browser-API's), zodat het ook onder Node getest kan worden.

/** Schrijft mono samples (-1..1) als PCM WAV. Geeft een Uint8Array terug. */
export function encodeWav(samples, sampleRate, bitDepth = 24) {
  if (bitDepth !== 16 && bitDepth !== 24) throw new Error('Alleen 16- of 24-bit');
  const bytesPerSample = bitDepth / 8;
  const dataSize = samples.length * bytesPerSample;
  const pad = dataSize % 2; // RIFF-chunks zijn even lang; padbyte telt niet mee in de datagrootte
  const buf = new Uint8Array(44 + dataSize + pad);
  const v = new DataView(buf.buffer);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) buf[off + i] = s.charCodeAt(i); };
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + dataSize + pad, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);              // grootte fmt-chunk
  v.setUint16(20, 1, true);               // PCM
  v.setUint16(22, 1, true);               // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * bytesPerSample, true); // bytes per seconde
  v.setUint16(32, bytesPerSample, true);  // blockAlign
  v.setUint16(34, bitDepth, true);
  ascii(36, 'data');
  v.setUint32(40, dataSize, true);

  const full = bitDepth === 16 ? 32767 : 8388607;
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    let s = samples[i];
    s = s > 1 ? 1 : s < -1 ? -1 : (s || 0);
    const q = Math.round(s * full);
    if (bitDepth === 16) {
      v.setInt16(off, q, true);
      off += 2;
    } else {
      buf[off] = q & 0xff;
      buf[off + 1] = (q >> 8) & 0xff;
      buf[off + 2] = (q >> 16) & 0xff;
      off += 3;
    }
  }
  return buf;
}

/** Leest PCM 16/24-bit WAV (ook met extra chunks); geeft een mono-mix terug. */
export function decodeWav(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (off) => String.fromCharCode(b[off], b[off + 1], b[off + 2], b[off + 3]);
  if (b.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Geen WAV-bestand');
  let fmt = null;
  let pos = 12;
  while (pos + 8 <= b.length) {
    const id = tag(pos);
    const size = v.getUint32(pos + 4, true);
    const body = pos + 8;
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true),
        channels: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bitDepth: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('data-chunk vóór fmt-chunk');
      if (fmt.format !== 1 || (fmt.bitDepth !== 16 && fmt.bitDepth !== 24)) throw new Error('Alleen PCM 16/24-bit');
      const bps = fmt.bitDepth / 8;
      const frames = Math.floor(Math.min(size, b.length - body) / (bps * fmt.channels));
      const out = new Float32Array(frames);
      const scale = fmt.bitDepth === 16 ? 1 / 32768 : 1 / 8388608;
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < fmt.channels; c++) {
          const o = body + (i * fmt.channels + c) * bps;
          let q;
          if (bps === 2) q = v.getInt16(o, true);
          else q = ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) << 8) >> 8;
          sum += q;
        }
        out[i] = (sum / fmt.channels) * scale;
      }
      return { sampleRate: fmt.sampleRate, bitDepth: fmt.bitDepth, channels: fmt.channels, samples: out, headerBytes: body };
    }
    pos = body + size + (size % 2);
  }
  throw new Error('Geen data-chunk gevonden');
}

/** Niveaus van een opname: piek en rms in dBFS, en het aantal (bijna) geclipte samples. */
export function levels(samples) {
  let peak = 0;
  let sum = 0;
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
    if (a >= 0.999) clipped++;
    sum += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sum / Math.max(1, samples.length));
  return { peakDbfs: toDb(peak), rmsDbfs: toDb(rms), clippedSamples: clipped };
}

export function toDb(a) {
  return 20 * Math.log10(Math.max(a, 1e-9));
}
