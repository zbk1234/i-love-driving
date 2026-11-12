import * as THREE from 'three';
import { WIPERS } from '../config.js';
import { glassPoint, glassNormal } from './glass.js';
import { worldMaterial } from '../world/materials.js';

// 雨刮：负责计时（供玻璃着色器计算「多久前被刮过」）和驱动刮片网格。
// 刮片角度 = a0 + (a1-a0)·(1-cos(2π·τ/D))/2，着色器里用的是同一个公式。

export const WIPER_MODES = ['auto', 'off', 'int', 'low', 'high'];
export const WIPER_LABELS = { auto: '自动', off: '关闭', int: '间歇', low: '低速', high: '高速' };

const N_BLADE = 9;
const N_ARM = 5;

function makeStrip(n) {
  // 每个截面 4 个点（底左、底右、顶右、顶左），相邻截面连成三个面（左、顶、右）
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 4 * 3), 3));
  const idx = [];
  for (let i = 0; i < n - 1; i++) {
    const a = i * 4;
    const b = a + 4;
    for (const [p, q] of [[0, 3], [3, 2], [2, 1]]) idx.push(a + p, b + p, b + q, a + p, b + q, a + q);
  }
  geo.setIndex(idx);
  const cnt = n * 4;
  geo.setAttribute('aColor', new THREE.Float32BufferAttribute(new Array(cnt * 3).fill(0.018), 3));
  geo.setAttribute('aEmis', new THREE.Float32BufferAttribute(new Array(cnt).fill(0), 1));
  geo.setAttribute('aData', new THREE.Float32BufferAttribute(new Array(cnt).fill(0), 1));
  geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(cnt * 3), 3));
  return geo;
}

const _p = new THREE.Vector3();
const _p2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _t = new THREE.Vector3();
const _s = new THREE.Vector3();

function fillStrip(geo, n, cfg, angle, r0, r1, halfW, lift, height) {
  const pos = geo.attributes.position.array;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  for (let i = 0; i < n; i++) {
    const r = r0 + ((r1 - r0) * i) / (n - 1);
    const gx = cfg.pivot[0] + r * c;
    const gy = cfg.pivot[1] + r * s;
    glassPoint(gx, gy, _p);
    glassNormal(gx, gy, _n);
    glassPoint(gx + c * 0.02, gy + s * 0.02, _p2);
    _t.subVectors(_p2, _p).normalize();
    _s.crossVectors(_n, _t).normalize();
    const o = i * 12;
    const put = (k, side, h) => {
      pos[o + k * 3] = _p.x + _s.x * side + _n.x * h;
      pos[o + k * 3 + 1] = _p.y + _s.y * side + _n.y * h;
      pos[o + k * 3 + 2] = _p.z + _s.z * side + _n.z * h;
    };
    put(0, -halfW, lift);
    put(1, halfW, lift);
    put(2, halfW, lift + height);
    put(3, -halfW, lift + height);
  }
  geo.attributes.position.needsUpdate = true;
  geo.computeVertexNormals();
}

export class Wipers {
  constructor() {
    this.mode = 'low'; // 开局用低速；自动档在默认的大雨里会直接上高速
    this.cycleStart = -1e3;
    this.prevStart = -2e3;
    this.dur = 1.2;
    this.nextStart = 0;
    this.frac = 0;
    this.tau = 1e3;
    this.gap = 1e3;
    this.onEvent = null; // (type) => void：'start' | 'turn' | 'park'
    this._phase = 2;

    this.group = new THREE.Group();
    const mat = worldMaterial({ surface: 'gloss = 0.08; shin = 30.0;' });
    this.parts = WIPERS.map((cfg) => {
      const blade = new THREE.Mesh(makeStrip(N_BLADE), mat);
      const arm = new THREE.Mesh(makeStrip(N_ARM), mat);
      for (const m of [blade, arm]) {
        m.frustumCulled = false;
        m.layers.set(2);
        this.group.add(m);
      }
      return { cfg, blade, arm };
    });
    this._pose();
  }

  cycleMode() {
    this.mode = WIPER_MODES[(WIPER_MODES.indexOf(this.mode) + 1) % WIPER_MODES.length];
    return this.mode;
  }

  _config(rain) {
    let m = this.mode;
    if (m === 'auto') m = rain < 0.12 ? 'off' : rain < 0.42 ? 'int' : rain < 0.8 ? 'low' : 'high';
    if (m === 'off') return null;
    if (m === 'int') return { dur: 1.15, period: 4.0 };
    if (m === 'low') return { dur: 1.3, period: 1.36 };
    return { dur: 0.82, period: 0.86 };
  }

  update(time, rain) {
    const cfg = this._config(rain);
    if (cfg && time >= this.nextStart && time - this.cycleStart >= this.dur) {
      this.prevStart = this.cycleStart;
      this.cycleStart = time;
      this.dur = cfg.dur;
      this.nextStart = time + cfg.period;
      this._phase = 0;
      this.onEvent?.('start', this.dur);
    }
    this.tau = time - this.cycleStart;
    this.gap = Math.min(this.cycleStart - this.prevStart, 1e3);
    const sweeping = this.tau < this.dur;
    this.frac = sweeping ? 0.5 - 0.5 * Math.cos((Math.PI * 2 * this.tau) / this.dur) : 0;
    if (this._phase === 0 && this.tau >= this.dur * 0.5) {
      this._phase = 1;
      this.onEvent?.('turn', this.dur);
    }
    if (this._phase === 1 && !sweeping) {
      this._phase = 2;
      this.onEvent?.('park', this.dur);
    }
    this._pose();
  }

  _pose() {
    for (const { cfg, blade, arm } of this.parts) {
      const ang = cfg.a0 + (cfg.a1 - cfg.a0) * this.frac;
      fillStrip(blade.geometry, N_BLADE, cfg, ang, cfg.rIn, cfg.rOut, 0.007, 0.002, 0.018);
      fillStrip(arm.geometry, N_ARM, cfg, ang, 0.0, (cfg.rIn + cfg.rOut) * 0.5, 0.008, 0.016, 0.009);
    }
  }

  applyTo(glassMaterial) {
    glassMaterial.uniforms.uWipe.value.set(this.tau, this.dur, this.gap);
  }
}
