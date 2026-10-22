// Microfoon (of testbron) -> AudioWorklet -> ruwe Float32-samples.
// Houdt de laatste paar seconden bij voor de niveaumeter en de live toerentalschatting, en
// verzamelt tijdens een opname alle samples.

import { synthEngine } from './synth.js';

const HISTORY_SECONDS = 2;

// Ruwe audio: geen echo-onderdrukking, ruisonderdrukking of automatische versterking.
export const RAW_CONSTRAINTS = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  channelCount: 1,
};

export class AudioInput {
  /** synth: null voor de microfoon, of { rpm, cylinders } voor de testbron. */
  static async open(synth = null) {
    const input = new AudioInput();
    await input.init(synth);
    return input;
  }

  async init(synth) {
    this.synth = synth;
    if (!synth) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microfoon niet beschikbaar (alleen via https of localhost).');
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: RAW_CONSTRAINTS, video: false });
      const track = this.stream.getAudioTracks()[0];
      this.trackSettings = track.getSettings ? track.getSettings() : {};
      this.label = track.label || 'Microfoon';
    } else {
      this.trackSettings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
      this.label = 'Testbron (synthetisch)';
    }
    // Native samplerate van het apparaat: geen resampling.
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.sampleRate = this.ctx.sampleRate;
    await this.ctx.audioWorklet.addModule(new URL('./capture-worklet.js', import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, 'capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    this.history = new Float32Array(Math.round(HISTORY_SECONDS * this.sampleRate));
    this.histPos = 0;
    this.histFilled = 0;
    this.peak = 0;
    this.clipAt = 0;
    this.recording = null;
    this.node.port.onmessage = (e) => this.onBlock(e.data);

    if (synth) {
      this.source = this.ctx.createBufferSource();
      this.setSynthRpm(synth.rpm);
      this.source.loop = true;
      this.source.start();
    } else {
      this.source = this.ctx.createMediaStreamSource(this.stream);
    }
    this.source.connect(this.node);
    // De worklet moet aan de uitgang hangen om te blijven lopen; stil, dus geen rondzingen.
    this.mute = this.ctx.createGain();
    this.mute.gain.value = 0;
    this.node.connect(this.mute).connect(this.ctx.destination);
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** Testbron: genereer een naadloze loop op dit toerental (0 = alleen ruis, "motor uit"). */
  setSynthRpm(rpm) {
    if (!this.synth || !this.source) return;
    const cyl = this.synth.cylinders || 4;
    const cycleHz = (rpm || 1000) / 120;
    const seconds = Math.max(1, Math.round(3 * cycleHz)) / cycleHz;
    const data = rpm
      ? synthEngine({ rpm, cylinders: cyl, seconds, sampleRate: this.sampleRate, level: 0.4, noise: 0.03 })
      : synthEngine({ rpm: 1000, cylinders: cyl, seconds: 2, sampleRate: this.sampleRate, level: 0.4, noise: 1 }).map((v) => v * 0.01);
    const buf = this.ctx.createBuffer(1, data.length, this.sampleRate);
    buf.copyToChannel(data, 0);
    if (this.source.buffer) {
      // Een AudioBufferSourceNode kan maar één keer een buffer krijgen: vervang de bron.
      const old = this.source;
      this.source = this.ctx.createBufferSource();
      this.source.buffer = buf;
      this.source.loop = true;
      this.source.connect(this.node);
      this.source.start();
      old.stop();
      old.disconnect();
    } else {
      this.source.buffer = buf;
    }
  }

  onBlock(block) {
    for (let i = 0; i < block.length; i++) {
      const a = Math.abs(block[i]);
      if (a > this.peak) this.peak = a;
      if (a >= 0.999) this.clipAt = performance.now();
    }
    // Ringbuffer.
    const h = this.history;
    let p = this.histPos;
    for (let i = 0; i < block.length; i++) {
      h[p++] = block[i];
      if (p === h.length) p = 0;
    }
    this.histPos = p;
    this.histFilled = Math.min(h.length, this.histFilled + block.length);
    if (this.recording) {
      this.recording.chunks.push(block);
      this.recording.length += block.length;
    }
  }

  /** Piek sinds de vorige aanroep (voor de meter). */
  takePeak() {
    const p = this.peak;
    this.peak = 0;
    return p;
  }

  /** De laatste `seconds` seconden (of minder als er nog niet zoveel is). */
  latest(seconds) {
    const n = Math.min(this.histFilled, Math.round(seconds * this.sampleRate));
    const out = new Float32Array(n);
    const h = this.history;
    let p = (this.histPos - n + h.length) % h.length;
    for (let i = 0; i < n; i++) {
      out[i] = h[p++];
      if (p === h.length) p = 0;
    }
    return out;
  }

  startRecording() {
    this.recording = { chunks: [], length: 0, startedAt: performance.now() };
  }

  get recordedSeconds() {
    return this.recording ? this.recording.length / this.sampleRate : 0;
  }

  stopRecording() {
    const r = this.recording;
    this.recording = null;
    if (!r) return new Float32Array(0);
    const out = new Float32Array(r.length);
    let o = 0;
    for (const c of r.chunks) {
      out.set(c, o);
      o += c.length;
    }
    return out;
  }

  /** Staan echo-/ruisonderdrukking en AGC echt uit? Lijst met wat (nog) aan staat. */
  processingWarnings() {
    const s = this.trackSettings || {};
    const w = [];
    if (s.echoCancellation) w.push('echo-onderdrukking');
    if (s.noiseSuppression) w.push('ruisonderdrukking');
    if (s.autoGainControl) w.push('automatische versterking');
    return w;
  }

  async close() {
    try { this.source?.disconnect(); } catch { /* al los */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    try { await this.ctx?.close(); } catch { /* al dicht */ }
  }
}
