import { G } from './globals.js';

// 天气与时间：三套光照预设（傍晚 / 夜晚 / 白天）、四档雨量、闪电。
// 切换时所有数值平滑过渡，而不是硬切。

export const TIMES = ['dusk', 'night', 'day'];
export const RAINS = [
  { key: 'light', name: '小雨', v: 0.28 },
  { key: 'mid', name: '中雨', v: 0.55 },
  { key: 'heavy', name: '大雨', v: 0.8 },
  { key: 'storm', name: '暴雨', v: 1.0 },
];

const PRESETS = {
  dusk: {
    name: '傍晚',
    skyTop: [0.085, 0.105, 0.15],
    fog: [0.15, 0.17, 0.205],
    skyAmb: [0.095, 0.115, 0.15],
    gndAmb: [0.028, 0.028, 0.033],
    lamp: 1.0,
    window: 1.0,
    head: 600,
    exposure: 1.05,
    bloom: 0.6,
    cabin: 1.0,
    fogK: 1.0,
    screens: 1.25,
  },
  night: {
    name: '夜晚',
    skyTop: [0.014, 0.016, 0.023],
    fog: [0.046, 0.043, 0.045],
    skyAmb: [0.02, 0.022, 0.03],
    gndAmb: [0.008, 0.008, 0.009],
    lamp: 1.0,
    window: 0.85,
    head: 600,
    exposure: 1.3,
    bloom: 0.75,
    cabin: 1.0,
    fogK: 0.85,
    screens: 0.9,
  },
  // 大雨的白天：天是铅灰色的，能见度很低，车都开着灯
  day: {
    name: '白天',
    skyTop: [0.3, 0.33, 0.37],
    fog: [0.4, 0.43, 0.46],
    skyAmb: [0.33, 0.35, 0.38],
    gndAmb: [0.1, 0.1, 0.1],
    lamp: 0.0,
    window: 0.12,
    head: 320,
    exposure: 0.92,
    bloom: 0.3,
    cabin: 2.2,
    fogK: 1.7,
    screens: 2.4,
  },
};

const LAMP_TINT = [1.0, 0.6, 0.28];
const KEYS3 = ['skyTop', 'fog', 'skyAmb', 'gndAmb'];
const KEYS1 = ['lamp', 'window', 'head', 'exposure', 'bloom', 'cabin', 'fogK', 'screens'];

export class Environment {
  constructor(time = 'dusk', rain = 2) {
    this.time = time;
    this.rainIndex = rain;
    this.rain = RAINS[rain].v;
    this.cur = structuredClone(PRESETS[time]);
    this.flash = 0;
    this._pulses = [];
    this._nextFlash = 12 + Math.random() * 14;
    this.onThunder = null; // (delaySeconds, strength) => void
    this.apply();
  }

  get timeName() {
    return PRESETS[this.time].name;
  }
  get rainName() {
    return RAINS[this.rainIndex].name;
  }

  cycleTime() {
    this.time = TIMES[(TIMES.indexOf(this.time) + 1) % TIMES.length];
    return this.timeName;
  }
  cycleRain() {
    this.rainIndex = (this.rainIndex + 1) % RAINS.length;
    return this.rainName;
  }

  triggerLightning() {
    const base = 0.5 + Math.random() * 0.5;
    const n = 2 + Math.floor(Math.random() * 3);
    let t = 0;
    for (let i = 0; i < n; i++) {
      this._pulses.push({ t, a: base * (0.4 + Math.random() * 0.6), d: 0.05 + Math.random() * 0.1 });
      t += 0.06 + Math.random() * 0.16;
    }
    const ang = Math.random() * Math.PI * 2;
    G.uFlashDir.value.set(Math.cos(ang), Math.sin(ang));
    this.onThunder?.(0.9 + Math.random() * 2.6, base);
  }

  update(dt) {
    const target = PRESETS[this.time];
    const k = 1 - Math.exp(-dt / 0.9);
    for (const key of KEYS3) for (let i = 0; i < 3; i++) this.cur[key][i] += (target[key][i] - this.cur[key][i]) * k;
    for (const key of KEYS1) this.cur[key] += (target[key] - this.cur[key]) * k;
    this.rain += (RAINS[this.rainIndex].v - this.rain) * (1 - Math.exp(-dt / 2.5));

    // ---- 闪电：雨够大才会有
    this._nextFlash -= dt;
    if (this._nextFlash <= 0) {
      if (this.rain > 0.6) this.triggerLightning();
      this._nextFlash = (this.rain > 0.9 ? 9 : 16) + Math.random() * 22;
    }
    let f = 0;
    for (const p of this._pulses) {
      p.t -= dt;
      if (p.t <= 0) f += p.a * Math.exp(p.t / p.d);
    }
    this._pulses = this._pulses.filter((p) => p.t > -1.2);
    this.flash = f;
    this.apply();
  }

  apply() {
    const c = this.cur;
    G.uSkyTop.value.setRGB(...c.skyTop);
    G.uFogColor.value.setRGB(...c.fog);
    G.uSkyAmb.value.setRGB(...c.skyAmb);
    G.uGndAmb.value.setRGB(...c.gndAmb);
    G.uLampColor.value.setRGB(LAMP_TINT[0] * c.lamp, LAMP_TINT[1] * c.lamp, LAMP_TINT[2] * c.lamp);
    G.uWindowGlow.value = c.window;
    G.uRain.value = this.rain;
    G.uFogDensity.value = 0.0036 * (0.7 + 0.95 * this.rain) * c.fogK;
    G.uFlash.value = this.flash;
  }
}
