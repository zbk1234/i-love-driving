// 声音大多用 Web Audio 实时合成：
//   胎噪、湿路面的嘶嘶声、风噪、发动机、伸缩缝的「咯噔」、转向灯继电器、会车呼啸、雷声。
// 雨声、雨刮、转向灯和超车时的驶过声用实录素材：页面加载时下载，AudioContext 建好后解码
// （雨刮和转向灯加载失败时退回合成声；驶过声没加载上就只剩合成的呼啸）。

const load = (url) =>
  fetch(url)
    .then((r) => (r.ok ? r.arrayBuffer() : null))
    .catch(() => null);

// 雨声实录：Freesound #648913「rain on a car」，hemogobblin，CC0。
// 车内录的雨打车顶，30.6 s 单声道，电平很稳（±1.5 dB）、没有突发事件；能量集中在 125 Hz ~ 1 kHz。
// 解码后做成无缝循环，由三路错开起点、略微变调的副本叠出立体声宽度：
// 左右两路一直在，第三路只在大雨时加进来补密度；雨越大低通开得越高。
const RAIN = {
  url: `${import.meta.env.BASE_URL}audio/rain.mp3`,
  FADE: 0.6, // 循环接缝处的交叉淡化长度（s）
  VOICES: [
    // [播放速率, 声像, 是否只在大雨时出现]
    [1.0, -0.45, false],
    [0.96, 0.45, false],
    [1.07, 0, true],
  ],
};

// 雨刮实录：Freesound #541292「Windscreen Wipers in the Rain Loop (3)」，OwlStorm，CC0。
// Hyundai Getz 车内录的高速档连续往复，截取了其中 7 个完整周期（≈1.23 s / 周期）。
// 每个周期有两声换向的「咚」：下端换向重（S，约 +26 dB），上端换向轻（W，约 +15 dB）。
// 播放时跟着游戏里雨刮的 start / turn / park 事件逐段拼接：换向声按原速播放，
// 两次换向之间的刮擦按本次行程的实际时长变速，让「咚」正好落在刮片换向的那一刻。
const WIPER = {
  url: `${import.meta.env.BASE_URL}audio/wiper.mp3`,
  S: [0.2025, 1.431, 2.6601, 3.8918, 5.1244, 6.3542, 7.586, 8.8166], // 下端换向的起振时刻（s）
  W: [0.7741, 2.0041, 3.2357, 4.4677, 5.6967, 6.9303, 8.1614], // 上端换向的起振时刻（s）
  PEAK0: 0.2151, // 第一声 S 的低频峰值位置，用来校正 MP3 解码后的起始偏移
  PRE: 0.01, // 换向声从起振前多少秒开始取
  TS: 0.11, // 下端换向声的长度
  TW: 0.05, // 上端换向声的长度
  RATE: [0.85, 1.35], // 刮擦变速的范围：再慢就提前收尾，再快就截掉行程末尾
};

// 驶过声实录：Freesound #775045「Car passing」，Otto_Hämäläinen，CC0。
// 手机在路边录的一辆车驶过，16 kHz 单声道；截成 5.5 s，车离得最近（500 Hz 以上最响）的时刻在 2.97 s。
// 同向车流里有车要和自车并排（超车或被超）时触发：按相对速度变速，起点对齐到两车并排的那一刻，
// 声像随之从侧前方摆到正侧面再收回来。
const PASS = {
  url: `${import.meta.env.BASE_URL}audio/pass.mp3`,
  PEAK: 2.97, // 最近点在素材里的位置（s）
  RATE: [0.8, 1.2], // 相对速度 10 m/s 时原速，慢了拖长变低、快了缩短变高
  MAX: 4, // 同时最多几辆
};

// 转向灯实录：Freesound #23968「061018_indicatorsR_mkh30-40_t002_ab_xtr」，ermine，CC BY-NC 3.0。
// 前排两座之间录的继电器声，每个周期一声「嗒」（亮）一声「哒」（灭）。
// 取中段最稳定的 8 个周期（≈ 0.753 s / 周期）做成无缝循环；仪表上的箭头跟着循环的相位亮灭。
const BLINK = {
  url: `${import.meta.env.BASE_URL}audio/blinker.mp3`,
  CYCLES: 8,
  PRE: 0.03, // 循环里第一声「嗒」的时刻（s）
  ON: 0.357, // 「嗒」到「哒」：灯亮的时长
  FADE: 0.02, // 接缝处的交叉淡化，落在「嗒」之前的安静段里
};

export class AudioEngine {
  constructor({ samples = true } = {}) {
    this.ctx = null;
    this.muted = false;
    // 下载不需要用户手势，页面一加载就开始；等 AudioContext 建好再解码
    this._rainFile = load(RAIN.url);
    this._wiperFile = samples ? load(WIPER.url) : Promise.resolve(null);
    this._passFile = samples ? load(PASS.url) : Promise.resolve(null);
    this._blinkFile = samples ? load(BLINK.url) : Promise.resolve(null);
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
    const loop = (buffer, rate = 1) => {
      const s = ctx.createBufferSource();
      s.buffer = buffer;
      s.loop = true;
      s.playbackRate.value = rate;
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

    // ---- 雨：车内实录，解码完成后再接进来
    this.fRain = filt('lowpass', 6000, 0.5);
    this.gRain = gain();
    chain(this.fRain, this.gRain, this.master);
    this.gRainDense = gain();
    this.gRainDense.connect(this.fRain);
    this._rainFile
      .then((ab) => ab && ctx.decodeAudioData(ab))
      .then((buf) => {
        if (!buf) return;
        const b = this._seamless(buf, RAIN.FADE);
        for (const [rate, p, dense] of RAIN.VOICES) {
          const pan = ctx.createStereoPanner();
          pan.pan.value = p;
          chain(loop(b, rate), pan, dense ? this.gRainDense : this.fRain);
        }
      })
      .catch(() => {});

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
    // 驶过的实录：隔着车身听，压掉一些高频
    this.gPassRec = gain(0.55);
    chain(this.gPassRec, filt('lowpass', 2800, 0.5), this.master);
    this.passBuf = null;
    this._passN = 0;
    this._passFile
      .then((ab) => ab && ctx.decodeAudioData(ab))
      .then((buf) => {
        if (buf) this.passBuf = buf;
      })
      .catch(() => {});

    // ---- 蹭护栏
    this.gScrape = gain();
    chain(loop(this.noise), filt('bandpass', 1700, 2.5), this.gScrape, this.master);

    // ---- 雨刮实录：解码完成前（或加载失败时）沿用合成的声音
    this.gWiper = gain();
    this.gWiper.connect(this.master);
    this.wiperBuf = null;
    this._wiperK = 0;
    this._wiperPark = -1e3;
    this._wiperFile
      .then((ab) => ab && ctx.decodeAudioData(ab))
      .then((buf) => {
        if (!buf) return;
        this._wiperOfs = this._alignWiper(buf);
        this._wiperK = Math.floor(Math.random() * WIPER.W.length);
        this.wiperBuf = buf;
      })
      .catch(() => {});

    // ---- 转向灯实录：解码前（或加载失败时）由 main.js 自己计时、合成哒哒声
    this.gBlink = gain(0.35);
    this.gBlink.connect(this.master);
    this.blinkBuf = null;
    this._blinkSrc = null;
    this._blinkFile
      .then((ab) => ab && ctx.decodeAudioData(ab))
      .then((buf) => {
        if (buf) this.blinkBuf = this._seamless(buf, BLINK.FADE);
      })
      .catch(() => {});
  }

  // MP3 编码会在开头垫一小段静音，各浏览器解码时裁掉的多少不一样；
  // 用第一声 S 的低频峰值和导出时记下的位置对齐（算法与导出脚本一致）
  _alignWiper(buf) {
    const sr = buf.sampleRate;
    const a = buf.getChannelData(0);
    const i0 = Math.floor(0.1 * sr);
    const i1 = Math.min(Math.floor(0.35 * sr), a.length);
    const k = 1 - Math.exp((-2 * Math.PI * 200) / sr);
    let lp = 0;
    let best = 0;
    let at = i0;
    for (let i = i0; i < i1; i++) {
      lp += k * (a[i] - lp);
      if (Math.abs(lp) > best) {
        best = Math.abs(lp);
        at = i;
      }
    }
    return Math.min(Math.max(at / sr - WIPER.PEAK0, -0.02), 0.08);
  }

  _noise(seconds) {
    const ctx = this.ctx;
    const n = Math.floor(seconds * ctx.sampleRate);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // 把一段实录做成严格无缝的循环：先裁掉 MP3 编解码在首尾补的静音，
  // 再把尾巴 fade 秒按等功率曲线叠到开头——循环回到开头时接上的正是原来紧跟在后面的那一段
  _seamless(buf, fade) {
    const sr = buf.sampleRate;
    const d0 = buf.getChannelData(0);
    let a = 0;
    let b = d0.length;
    while (a < b && Math.abs(d0[a]) < 1e-4) a++;
    while (b > a && Math.abs(d0[b - 1]) < 1e-4) b--;
    const margin = Math.floor(0.02 * sr);
    a += margin;
    b -= margin;
    const n = Math.floor(fade * sr);
    const len = b - a - n;
    if (len < n * 2) return buf;
    const out = this.ctx.createBuffer(buf.numberOfChannels, len, sr);
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const src = buf.getChannelData(ch);
      const dst = out.getChannelData(ch);
      dst.set(src.subarray(a, a + len));
      for (let i = 0; i < n; i++) {
        const w = (i / n) * Math.PI * 0.5;
        dst[i] = src[a + i] * Math.sin(w) + src[a + len + i] * Math.cos(w);
      }
    }
    return out;
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

    // 雨声：响度按感知曲线跟雨量走，车速越高打在车上的雨越密；大雨时叠上第三路、放开高频
    set(this.gRain.gain, 0.3 * r ** 0.7 * (0.8 + 0.3 * vn));
    set(this.gRainDense.gain, Math.min(Math.max((r - 0.45) / 0.45, 0), 1) * 0.8);
    set(this.fRain.frequency, 1800 + 7000 * r);

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
    // 素材本身带着雨声，干玻璃上手动开雨刮时压低一些
    set(this.gWiper.gain, 0.5 * (0.55 + 0.45 * Math.min(r * 1.5, 1)));
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

  // 从实录的 from 秒处取一段，在 t 时刻起以 rate 倍速播放 len 秒，首尾各淡入 / 淡出一下
  _wiperPiece(from, t, len, rate, fadeIn, fadeOut) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.wiperBuf;
    src.playbackRate.value = rate;
    const g = this._gain(0);
    fadeOut = Math.min(fadeOut, len * 0.4);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(1, t + fadeIn);
    g.gain.setValueAtTime(1, t + len - fadeOut);
    g.gain.linearRampToValueAtTime(0, t + len);
    this._chain(src, g, this.gWiper);
    src.start(t, Math.max(0, from + this._wiperOfs));
    src.stop(t + len + 0.02);
  }

  // 一次行程的刮擦：实录里 [from, to) 这段要在 [t0, t1) 内播完
  _wiperStroke(from, to, t0, t1) {
    const span = t1 - t0;
    if (span < 0.05) return;
    const [lo, hi] = WIPER.RATE;
    const rate = Math.min(Math.max((to - from) / span, lo), hi);
    this._wiperPiece(from, t0, Math.min(span, (to - from) / rate), rate, 0.015, 0.04);
  }

  // 下端换向的 S → 往上刮 → 上端换向的 W → 往下刮 → 下一个 S，k 是当前用的是第几个周期
  _wiperSample(type, dur) {
    const { S, W, PRE, TS, TW } = WIPER;
    const now = this.ctx.currentTime;
    const end = now + dur / 2; // 本次行程结束（下一个事件）的时刻
    const k = this._wiperK;
    if (type === 'start') {
      // 连续档里刚在下端换向过，刮擦接在那一声「咚」后面；间歇档从静止起步则立刻开始
      const t0 = Math.max(now, this._wiperPark + PRE + TS);
      this._wiperStroke(S[k] + TS, W[k] - PRE, t0, end);
    } else if (type === 'turn') {
      this._wiperPiece(W[k] - PRE, now, PRE + TW + 0.03, 1, 0.004, 0.03);
      this._wiperStroke(W[k] + TW, S[k + 1] - PRE, now + PRE + TW, end);
    } else if (type === 'park') {
      this._wiperPiece(S[k + 1] - PRE, now, PRE + TS + 0.03, 1, 0.004, 0.03);
      this._wiperPark = now;
      this._wiperK = (k + 1) % W.length;
    }
  }

  wiper(type, dur) {
    if (!this.ctx) return;
    if (this.wiperBuf) return this._wiperSample(type, dur);
    if (type === 'start' || type === 'turn') {
      // 胶条刮过湿玻璃的「唰——」
      this._burst(dur * 0.48, 'bandpass', type === 'start' ? 900 : 1500, 1.4, 0.05, 0.01, type === 'start' ? 1500 : 850);
    }
    if (type === 'turn' || type === 'park') {
      this._thud(type === 'turn' ? 120 : 95, 55, 0.07, 0.16);
      this._burst(0.03, 'bandpass', 900, 1, 0.05);
    }
  }

  // 同向车辆驶过自车：ttc 秒后两车并排，rel 为相对速度（m/s），du 为横向间距（正值在右）
  pass(ttc, rel, du, heavy) {
    if (!this.passBuf || this._passN >= PASS.MAX) return;
    const ctx = this.ctx;
    const [lo, hi] = PASS.RATE;
    const rate = Math.min(Math.max(rel / 10, lo), hi);
    // 最近点之前的部分按 rate 播放要 PEAK / rate 秒：时间不够就从中间切入，有富余就推迟开始
    const ahead = PASS.PEAK - ttc * rate;
    const from = Math.max(0, ahead);
    const t = ctx.currentTime + Math.max(0, -ahead / rate);
    const tc = t + (PASS.PEAK - from) / rate;
    const tEnd = t + (this.passBuf.duration - from) / rate;

    const src = ctx.createBufferSource();
    src.buffer = this.passBuf;
    src.playbackRate.value = rate;
    const level = Math.min(Math.max(rel / 8, 0.35), 1) * Math.min(1, 4 / Math.abs(du)) * (heavy ? 1.3 : 1);
    const g = this._gain(0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + (from > 0 ? 0.12 : 0.01));
    const pan = ctx.createStereoPanner();
    const side = Math.sign(du);
    pan.pan.setValueAtTime(side * 0.25, t);
    pan.pan.linearRampToValueAtTime(side * 0.75, tc);
    pan.pan.linearRampToValueAtTime(side * 0.3, tEnd);
    this._chain(src, g, pan, this.gPassRec);
    this._passN++;
    src.onended = () => this._passN--;
    src.start(t, from);
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

  // 打开转向灯：从头播循环，30 ms 后第一声「嗒」；重复调用无影响
  blinkStart() {
    if (!this.blinkBuf || this._blinkSrc) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.blinkBuf;
    src.loop = true;
    const g = this._gain(1);
    this._chain(src, g, this.gBlink);
    src.start();
    this._blinkSrc = src;
    this._blinkG = g;
    this._blinkT0 = ctx.currentTime;
  }

  blinkStop() {
    if (!this._blinkSrc) return;
    const t = this.ctx.currentTime;
    this._blinkG.gain.setTargetAtTime(0, t, 0.01);
    this._blinkSrc.stop(t + 0.08);
    this._blinkSrc = null;
  }

  // 按循环当前听到的位置算灯该不该亮；没在用实录时返回 null
  blinkLit() {
    if (!this._blinkSrc) return null;
    const ctx = this.ctx;
    const period = this.blinkBuf.duration / BLINK.CYCLES;
    const t = Math.max(0, ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0) - this._blinkT0);
    const ph = t % period;
    return ph >= BLINK.PRE && ph < BLINK.PRE + BLINK.ON;
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
