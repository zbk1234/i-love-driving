// 声音全部用 Web Audio 实时合成，不依赖任何音频文件：
//   雨打车顶 / 玻璃（预先生成的雨点序列循环）、胎噪、湿路面的嘶嘶声、风噪、
//   发动机、雨刮、伸缩缝的「咯噔」、转向灯继电器、会车呼啸、雷声。

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  get ready() {
    return !!this.ctx;
  }

  start() {
    if (this.ctx) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.ratio.value = 3;
    comp.attack.value = 0.01;
    comp.release.value = 0.3;
    this.master.connect(comp).connect(ctx.destination);
    this.master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.9);

    this.noise = this._noise(4);
    const loop = (buffer) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.start(0, Math.random() * buffer.duration);
      return s;
    };
    const filt = (type, f, q = 0.7) => {
      const b = ctx.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    const gain = (v = 0) => {
      const g = ctx.createGain();
      g.gain.value = v;
      return g;
    };
    const chain = (...nodes) => {
      for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
      return nodes[nodes.length - 1];
    };
    this._filt = filt;
    this._gain = gain;
    this._chain = chain;

    // ---- 雨
    this.gHiss = gain();
    chain(loop(this.noise), filt('highpass', 1100), filt('lowpass', 6500), this.gHiss, this.master);
    this.gRoof = gain();
    chain(loop(this._patter(6, 420, 260, 1500, 0.012, 0.03)), filt('lowpass', 2800), this.gRoof, this.master);
    this.gGlass = gain();
    chain(loop(this._patter(5, 360, 1800, 5600, 0.002, 0.008)), filt('highpass', 1200), this.gGlass, this.master);

    // ---- 路噪 / 湿路面嘶声 / 风噪
    this.fRoad = filt('lowpass', 110);
    this.gRoad = gain();
    chain(loop(this.noise), this.fRoad, this.gRoad, this.master);
    this.fTyre = filt('bandpass', 2400, 0.6);
    this.gTyre = gain();
    chain(loop(this.noise), this.fTyre, this.gTyre, this.master);
    this.fWind = filt('bandpass', 420, 0.5);
    this.gWind = gain();
    chain(loop(this.noise), this.fWind, this.gWind, this.master);

    // ---- 发动机（隔着防火墙听到的低沉嗡声）
    this.osc1 = ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = ctx.createOscillator();
    this.osc2.type = 'triangle';
    this.fEng = filt('lowpass', 170, 1.1);
    this.gEng = gain();
    this.osc1.connect(this.fEng);
    this.osc2.connect(this.fEng);
    chain(this.fEng, this.gEng, this.master);
    this.osc1.start();
    this.osc2.start();

    // ---- 会车 / 超车的呼啸
    this.fPass = filt('bandpass', 700, 0.5);
    this.gPass = gain();
    this.pan = ctx.createStereoPanner();
    chain(loop(this.noise), this.fPass, this.gPass, this.pan, this.master);

    // ---- 蹭护栏
    this.gScrape = gain();
    chain(loop(this.noise), filt('bandpass', 1700, 2.5), this.gScrape, this.master);
  }

  _noise(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(seconds * ctx.sampleRate);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // 一段可循环的「雨点」：大量随机时刻的衰减脉冲，每个脉冲带一点共振音色
  _patter(seconds, perSecond, f0, f1, d0, d1) {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const n = Math.floor(seconds * sr);
    const buf = ctx.createBuffer(2, n, sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      const count = Math.floor(seconds * perSecond);
      for (let k = 0; k < count; k++) {
        const t0 = Math.floor(Math.random() * n);
        const amp = Math.random() ** 3 * 0.55 + 0.03;
        const w = (Math.PI * 2 * (f0 + Math.random() * (f1 - f0))) / sr;
        const decay = (d0 + Math.random() * (d1 - d0)) * sr;
        const len = Math.min(Math.floor(decay * 5), n);
        const mul = Math.exp(-1 / decay);
        const ph = Math.random() * 6.283;
        let e = amp;
        for (let i = 0; i < len; i++) {
          d[(t0 + i) % n] += e * (0.65 * Math.sin(w * i + ph) + 0.35 * (Math.random() * 2 - 1));
          e *= mul;
        }
      }
      for (let i = 0; i < n; i++) d[i] *= 0.3;
    }
    return buf;
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.15);
  }

  update(s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const set = (param, v, tc = 0.15) => param.setTargetAtTime(v, t, tc);
    const v = s.speed;
    const r = s.rain;
    const vn = Math.min(v / 33, 1);

    set(this.gHiss.gain, 0.09 * r);
    set(this.gRoof.gain, 1.25 * r * (0.75 + 0.25 * vn));
    set(this.gGlass.gain, 0.7 * r * (0.55 + 0.6 * vn));

    set(this.gRoad.gain, 0.03 + vn * 0.4);
    set(this.fRoad.frequency, 90 + v * 5);
    set(this.gTyre.gain, vn ** 1.5 * 0.16 * (0.4 + 0.6 * r));
    set(this.fTyre.frequency, 1700 + v * 45);
    set(this.gWind.gain, Math.min(v / 40, 1) ** 2 * 0.2);
    set(this.fWind.frequency, 280 + v * 11);

    const f0 = (s.rpm / 60) * 2;
    set(this.osc1.frequency, f0, 0.08);
    set(this.osc2.frequency, f0 / 2, 0.08);
    set(this.fEng.frequency, 120 + s.rpm * 0.055);
    set(this.gEng.gain, 0.03 + s.throttle * 0.035);

    set(this.gPass.gain, s.passGain * 0.5, 0.08);
    set(this.fPass.frequency, 450 + s.passGain * 700, 0.08);
    set(this.pan.pan, s.passPan, 0.1);
    set(this.gScrape.gain, s.scrape * 0.3, 0.05);
  }

  // 一次性的噪声脉冲
  _burst(dur, type, f, q, peak, when = 0, fEnd = null) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const fl = this._filt(type, f, q);
    if (fEnd) fl.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
    const g = this._gain(0);
    peak = Math.max(peak, 0.0002);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + Math.min(0.02, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    this._chain(src, fl, g, this.master);
    src.start(t, Math.random() * 3);
    src.stop(t + dur + 0.05);
  }

  // 低频「咚」
  _thud(f0, f1, dur, peak, when = 0) {
    const ctx = this.ctx;
    const t = ctx.currentTime + when;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = this._gain(0);
    g.gain.setValueAtTime(Math.max(peak, 0.0002), t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    this._chain(o, g, this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  wiper(type, dur) {
    if (!this.ctx) return;
    if (type === 'start' || type === 'turn') {
      // 胶条刮过湿玻璃的「唰——」
      this._burst(dur * 0.48, 'bandpass', type === 'start' ? 900 : 1500, 1.4, 0.05, 0.01, type === 'start' ? 1500 : 850);
    }
    if (type === 'turn' || type === 'park') {
      this._thud(type === 'turn' ? 120 : 95, 55, 0.07, 0.16);
      this._burst(0.03, 'bandpass', 900, 1, 0.05);
    }
  }

  // 压过伸缩缝：前后轴各「咯噔」一下
  joint(axleDelay, strength) {
    if (!this.ctx) return;
    for (const d of [0, axleDelay]) {
      this._thud(78, 42, 0.1, 0.32 * strength, d);
      this._burst(0.05, 'lowpass', 500, 0.7, 0.1 * strength, d);
    }
  }

  blinker(high) {
    if (!this.ctx) return;
    this._burst(0.02, 'bandpass', high ? 2600 : 1900, 6, 0.12);
  }

  crash(strength) {
    if (!this.ctx) return;
    this._thud(110, 38, 0.3, 0.6 * strength);
    this._burst(0.25, 'lowpass', 1200, 0.7, 0.4 * strength);
  }

  // 雷声：先是一声闷响，随后是持续几秒、起伏不定的滚雷
  thunder(delay, strength) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const dur = 4.5 + Math.random() * 3;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const fl = this._filt('lowpass', 420, 0.5);
    fl.frequency.setValueAtTime(420, t);
    fl.frequency.exponentialRampToValueAtTime(70, t + dur);
    const g = this._gain(0);
    const steps = 48;
    const curve = new Float32Array(steps);
    let roll = 1;
    for (let i = 0; i < steps; i++) {
      const x = i / (steps - 1);
      roll = Math.max(0.25, Math.min(1.2, roll + (Math.random() - 0.5) * 0.5));
      const attack = Math.min(1, x / 0.03);
      curve[i] = attack * Math.exp(-x * 3.2) * roll * strength * 0.9;
    }
    curve[steps - 1] = 0;
    g.gain.setValueCurveAtTime(curve, t, dur);
    this._chain(src, fl, g, this.master);
    src.start(t);
    src.stop(t + dur + 0.1);
  }
}
