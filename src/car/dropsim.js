import * as THREE from 'three';
import { GLASS, WIPERS } from '../config.js';
import { G } from '../core/globals.js';

// 车窗上的大水珠：有记忆的模拟。
//
// 解析的水珠（glass.js 里的 dropsLayer）每一颗都是孤立的：出现、待一会儿、原地消失。
// 真实的水珠是「活」的——被新落下的雨滴砸中而变大，挨着的吸成一颗，大到挂不住就开始淌，
// 一路吞掉别的水珠、越滚越快，身后留下一条被洗干净的水痕和几颗残留的小珠。
//
// 做法：
//   · 每块玻璃上的大水珠是 CPU 上的一组粒子（几百颗），在「玻璃坐标」里运动；
//   · 每帧把它们画进一张玻璃坐标系的贴图 tDrops（xy = 水珠内归一化位置 × 遮罩，a = 遮罩，
//     和解析水珠的格式完全一样），雨滴着色器直接拿来当又一层水珠；
//   · 正在滑动的水珠顺手往另一张贴图 tClean 里盖时间戳：「这里刚被洗过」。
//     着色器把它和雨刮的「几秒前刮过」取较小值，于是水痕里的细水珠和水膜都被清掉，过几秒再长回来。

const MAX = 2048;
const CELL = 0.012; // 合并检测用的空间哈希格距

const DROP_VERT = /* glsl */ `
  attribute vec4 aDrop;   // 位置.xy、半径、随机种子
  attribute vec4 aMove;   // 运动方向.xy、拉伸程度（0 静止 ~ 1 快速滑动）、不透明度
  varying vec2 vP;
  varying vec4 vMove;
  varying float vSeed;
  void main() {
    vec2 ey = aMove.xy;
    vec2 ex = vec2(ey.y, -ey.x);
    float tail = 1.0 + 1.8 * aMove.z;
    // 以半径为单位的局部坐标：y 沿运动方向，身后（y<0）给拖尾留出地方
    vec2 l = vec2(position.x * 1.3, position.y > 0.0 ? position.y * 1.3 : position.y * 1.3 * tail);
    vP = l;
    vMove = aMove;
    vSeed = aDrop.w;
    vec2 w = aDrop.xy + (ex * l.x + ey * l.y) * aDrop.z;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(w, 0.0, 1.0);
  }
`;

const DROP_FRAG = /* glsl */ `
  varying vec2 vP;
  varying vec4 vMove;
  varying float vSeed;
  void main() {
    vec2 d = vP;
    float st = vMove.z;
    if (d.y < 0.0) {
      // 滑动的水珠：身后拉长、越往后越窄，成一个泪滴形
      float t = -d.y / (1.3 * (1.0 + 1.8 * st));
      d.y /= 1.0 + 1.8 * st;
      d.x *= 1.0 + st * 1.6 * t;
    }
    vec2 sh = vec2(fract(vSeed * 17.3), fract(vSeed * 29.7)) - 0.5;
    d *= 1.0 + dot(d, sh) * 0.45 * (1.0 - 0.6 * st) + d.x * d.y * sh.x * 0.5; // 不规则的轮廓
    float m = smoothstep(1.0, 0.84, dot(d, d)) * vMove.w;
    if (m <= 0.0) discard;
    vec2 ey = vMove.xy;
    vec2 ex = vec2(ey.y, -ey.x);
    gl_FragColor = vec4((ex * d.x + ey * d.y) * m, 0.0, m);
  }
`;

// 「洗干净」的印章：只有在动的水珠才盖
const CLEAN_VERT = /* glsl */ `
  attribute vec4 aDrop;
  attribute vec4 aMove;
  varying vec2 vP;
  void main() {
    vP = position.xy;
    float r = aDrop.z * 0.95 * step(0.03, aMove.z);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(aDrop.xy + position.xy * r, 0.0, 1.0);
  }
`;
const CLEAN_FRAG = /* glsl */ `
  uniform float uTime;
  varying vec2 vP;
  void main() {
    if (dot(vP, vP) > 1.0) discard;
    gl_FragColor = vec4(uTime, 0.0, 0.0, 1.0);
  }
`;

class DropSim {
  // rect：模拟覆盖的玻璃坐标范围 [x0, y0, x1, y1]
  // flow(speed, x, y, out)：这一点上水珠受到的合力方向 × 强度（重力 1.0 为基准）
  // inside(x, y)：这一点是否真的在玻璃上；wiped：是否有雨刮
  constructor({ rect, flow, inside = () => true, wiped = false }) {
    this.rect = rect;
    this.flow = flow;
    this.inside = inside;
    this.wiped = wiped;
    this.area = (rect[2] - rect[0]) * (rect[3] - rect[1]);
    this.n = 0;
    this.spawnAcc = 0;
    this.prevFrac = 0;

    const f = () => new Float32Array(MAX);
    this.x = f();
    this.y = f();
    this.r = f(); // 接触半径（米）
    this.rc = f(); // 这颗水珠能挂住的最大半径
    this.u = f(); // 滑动速度
    this.dx = f(); // 运动方向
    this.dy = f();
    this.age = f();
    this.life = f(); // 残留小珠的剩余寿命；0 表示不会自己消失
    this.ph = f(); // 蜿蜒的相位
    this.pause = f(); // 走走停停：还要停多久
    this.travel = f(); // 距离下一颗残留小珠还要走多远
    this.seed = f();
    this.sliding = new Uint8Array(MAX);
    this.dead = new Uint8Array(MAX);
    this.grid = new Map();

    // ---- 绘制：一个实例化的方片，每颗水珠一个实例
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    this.aDrop = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aMove = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 4), 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aDrop', this.aDrop);
    geo.setAttribute('aMove', this.aMove);
    geo.instanceCount = 0;
    this.geo = geo;

    // 后画的盖住先画的：rgb = mix(dst, src, m)，a = 并集
    this.matDrop = new THREE.ShaderMaterial({
      vertexShader: DROP_VERT,
      fragmentShader: DROP_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor,
      blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    // 时间戳只增不减
    this.matClean = new THREE.ShaderMaterial({
      uniforms: { uTime: G.uTime },
      vertexShader: CLEAN_VERT,
      fragmentShader: CLEAN_FRAG,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    });
    this.mesh = new THREE.Mesh(geo, this.matDrop);
    this.mesh.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.mesh);
    this.camera = new THREE.OrthographicCamera(rect[0], rect[2], rect[3], rect[1], -1, 1);

    this.rtDrops = null;
    this.rtClean = null;
    // 着色器用：(x0, y0, 1/宽, 1/高)
    this.uRect = new THREE.Vector4(rect[0], rect[1], 1 / (rect[2] - rect[0]), 1 / (rect[3] - rect[1]));
  }

  setResolution(width, floatLinear) {
    this.rtDrops?.dispose();
    this.rtClean?.dispose();
    this.rtDrops = this.rtClean = null;
    if (!width) return;
    const h = Math.round((width * (this.rect[3] - this.rect[1])) / (this.rect[2] - this.rect[0]));
    this.rtDrops = new THREE.WebGLRenderTarget(width, h, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
    });
    // 时间戳要 32 位浮点（半精度存不下「第几秒」）；分辨率减半就够了
    const filter = floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
    this.rtClean = new THREE.WebGLRenderTarget(width >> 1, h >> 1, {
      type: THREE.FloatType,
      format: THREE.RedFormat,
      minFilter: filter,
      magFilter: filter,
      depthBuffer: false,
    });
    this.cleanFresh = true;
  }

  _add(x, y, r, life = 0) {
    if (this.n >= MAX) return -1;
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y;
    this.r[i] = r;
    this.rc[i] = 0.0036 + Math.random() * 0.002;
    this.u[i] = 0;
    this.dx[i] = 0;
    this.dy[i] = -1;
    this.age[i] = 0;
    this.life[i] = life;
    this.ph[i] = Math.random() * 6.28;
    this.pause[i] = 0;
    this.travel[i] = 0.006 + Math.random() * 0.014;
    this.seed[i] = Math.random();
    this.sliding[i] = 0;
    this.dead[i] = 0;
    return i;
  }

  // 一滴雨砸在玻璃上
  _impact() {
    const [x0, y0, x1, y1] = this.rect;
    let x;
    let y;
    for (let k = 0; k < 3; k++) {
      x = x0 + Math.random() * (x1 - x0);
      y = y0 + Math.random() * (y1 - y0);
      if (this.inside(x, y)) break;
      x = NaN;
    }
    if (Number.isNaN(x)) return;
    const s = Math.random();
    const r = 0.0013 + 0.0022 * s * s;
    // 砸在已有的水珠上：把它喂大，并让它颤一下
    for (let j = 0; j < this.n; j++) {
      if (this.life[j] > 0) continue;
      const ex = this.x[j] - x;
      const ey = this.y[j] - y;
      const rj = this.r[j];
      if (ex * ex + ey * ey < rj * rj * 0.8) {
        this.r[j] = Math.cbrt(rj ** 3 + r ** 3);
        this.age[j] = Math.min(this.age[j], 0.12);
        return;
      }
    }
    if (this._add(x, y, r) < 0) return;
    // 溅出来的几颗小珠
    const k = Math.floor(Math.random() * 3.2);
    for (let i = 0; i < k && this.n < MAX - 500; i++) {
      const a = Math.random() * 6.28;
      const d = r * (1.7 + Math.random() * 2.2);
      this._add(x + Math.cos(a) * d, y + Math.sin(a) * d, r * (0.28 + Math.random() * 0.22), 2 + Math.random() * 2.5);
    }
  }

  // rain：雨量 0~1；speed：车速 m/s；wipers：Wipers 实例（只有前挡用）
  update(dt, rain, speed, wipers) {
    if (!this.rtDrops) return;
    const { x, y, r, rc, u, dx, dy, age, life, ph, pause, travel, sliding, dead } = this;
    const [x0, y0, x1, y1] = this.rect;

    // ---- 新落下的雨滴
    this.spawnAcc += rain * 70 * this.area * dt;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      if (this.n < MAX - 400) this._impact();
    }

    // ---- 逐颗更新
    const F = _f;
    const grow = 0.00022 * rain * dt;
    const n0 = this.n;
    for (let i = 0; i < n0; i++) {
      age[i] += dt;
      if (life[i] > 0) {
        life[i] -= dt;
        if (life[i] <= 0) dead[i] = 1;
        continue;
      }
      this.flow(speed, x[i], y[i], F);
      const fm = Math.hypot(F[0], F[1]);
      // 受力越大，越小的水珠就挂不住了
      const crit = rc[i] / Math.sqrt(Math.max(fm, 0.05));
      if (!sliding[i]) {
        r[i] += grow;
        if (fm > 0.15 && r[i] > crit) {
          sliding[i] = 1;
          dx[i] = F[0] / fm;
          dy[i] = F[1] / fm;
        }
        continue;
      }
      if (fm < 0.1 || r[i] < crit * 0.7) {
        sliding[i] = 0;
        u[i] = 0;
        continue;
      }
      // 走走停停：水珠不是匀速往下淌的，会粘住一下再挣脱
      if (pause[i] > 0) pause[i] -= dt;
      else if (Math.random() < dt * 0.55) pause[i] = 0.06 + Math.random() * 0.4;
      const target = pause[i] > 0 ? 0 : fm * (0.015 + 0.1 * (r[i] / 0.004) ** 1.5);
      u[i] += (target - u[i]) * Math.min(1, dt * 8);
      // 蜿蜒：在受力方向两侧来回偏
      ph[i] += dt * (2.2 + 2.5 * this.seed[i]);
      const wob = 0.42 * Math.sin(ph[i]) + 0.24 * Math.sin(ph[i] * 2.3 + this.seed[i] * 10);
      let tx = F[0] - F[1] * wob;
      let ty = F[1] + F[0] * wob;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const k = Math.min(1, dt * 6);
      dx[i] += (tx - dx[i]) * k;
      dy[i] += (ty - dy[i]) * k;
      const dl = Math.hypot(dx[i], dy[i]) || 1;
      dx[i] /= dl;
      dy[i] /= dl;
      const dist = u[i] * dt;
      x[i] += dx[i] * dist;
      y[i] += dy[i] * dist;
      r[i] -= dist * 0.01; // 一路把水留在身后
      // 身后隔一段留下一颗小珠
      travel[i] -= dist;
      if (travel[i] <= 0) {
        travel[i] = 0.006 + Math.random() * 0.016;
        if (this.n < MAX - 40) {
          const rr = Math.min(r[i] * (0.24 + Math.random() * 0.2), 0.0011);
          this._add(x[i] - dx[i] * r[i] * 1.25 + (Math.random() - 0.5) * r[i] * 0.5, y[i] - dy[i] * r[i] * 1.25 + (Math.random() - 0.5) * r[i] * 0.5, rr, 1 + Math.random() * 1.8);
        }
      }
      if (x[i] < x0 - 0.02 || x[i] > x1 + 0.02 || y[i] < y0 - 0.02 || y[i] > y1 + 0.02) dead[i] = 1;
    }

    // ---- 雨刮：刮片扫过的水珠全部带走
    if (this.wiped && wipers) {
      const f1 = wipers.frac;
      const f0 = this.prevFrac;
      this.prevFrac = f1;
      if (f0 !== f1) {
        for (const w of WIPERS) {
          const span = w.a1 - w.a0;
          // 刮片有宽度：把这一帧扫过的角度范围两头各放宽一点
          const lo = Math.min(f0, f1);
          const hi = Math.max(f0, f1);
          for (let i = 0; i < this.n; i++) {
            const ex = x[i] - w.pivot[0];
            const ey = y[i] - w.pivot[1];
            const rr = Math.hypot(ex, ey);
            if (rr < w.rIn || rr > w.rOut) continue;
            const f = (Math.atan2(ey, ex) - w.a0) / span;
            const pad = (0.012 + r[i]) / (rr * span);
            if (f > lo - pad && f < hi + pad) dead[i] = 1;
          }
        }
      }
    }

    // ---- 合并：挨上了就吸成一颗（体积相加，位置按体积加权）
    const grid = this.grid;
    grid.clear();
    for (let i = 0; i < this.n; i++) {
      if (dead[i]) continue;
      const key = Math.floor(x[i] / CELL) * 4096 + Math.floor(y[i] / CELL);
      const cell = grid.get(key);
      if (cell) cell.push(i);
      else grid.set(key, [i]);
    }
    for (let i = 0; i < this.n; i++) {
      if (dead[i] || life[i] > 0) continue; // 残留小珠只会被别人吃，不主动合并
      const cx = Math.floor(x[i] / CELL);
      const cy = Math.floor(y[i] / CELL);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cell = grid.get((cx + ox) * 4096 + cy + oy);
          if (!cell) continue;
          for (const j of cell) {
            if (j === i || dead[j] || dead[i]) continue;
            if (life[j] <= 0 && j < i) continue; // 两颗大水珠只检查一次
            const ex = x[j] - x[i];
            const ey = y[j] - y[i];
            const lim = (r[i] + r[j]) * 0.78;
            if (ex * ex + ey * ey > lim * lim) continue;
            // 大的吃小的
            const a = life[j] <= 0 && r[j] > r[i] ? j : i;
            const b = a === i ? j : i;
            const va = r[a] ** 3;
            const vb = r[b] ** 3;
            const t = vb / (va + vb);
            x[a] += (x[b] - x[a]) * t;
            y[a] += (y[b] - y[a]) * t;
            r[a] = Math.cbrt(va + vb);
            if (sliding[b] && !sliding[a]) {
              sliding[a] = 1;
              dx[a] = dx[b];
              dy[a] = dy[b];
              u[a] = u[b] * t;
            }
            dead[b] = 1;
          }
        }
      }
    }

    // ---- 清掉死的，写实例缓冲
    const A = this.aDrop.array;
    const M = this.aMove.array;
    let m = 0;
    for (let i = 0; i < this.n; i++) {
      if (dead[i]) continue;
      if (m !== i) {
        for (const arr of [x, y, r, rc, u, dx, dy, age, life, ph, pause, travel, this.seed]) arr[m] = arr[i];
        sliding[m] = sliding[i];
      }
      dead[m] = 0;
      const res = life[m] > 0;
      // 砸上来（或被砸中）的瞬间鼓一下；残留小珠临消失前缩小、变淡
      const fade = res ? Math.min(1, life[m] / 0.7) : 1;
      const o = m * 4;
      A[o] = x[m];
      A[o + 1] = y[m];
      A[o + 2] = r[m] * (1 + 0.45 * Math.exp(-age[m] * 14)) * (res ? 0.6 + 0.4 * fade : 1);
      A[o + 3] = this.seed[m];
      M[o] = dx[m];
      M[o + 1] = dy[m];
      M[o + 2] = sliding[m] ? Math.min(1, u[m] / 0.1) : 0;
      M[o + 3] = fade;
      m++;
    }
    for (let i = m; i < this.n; i++) dead[i] = 0;
    this.n = m;
    this.geo.instanceCount = m;
    this.aDrop.needsUpdate = true;
    this.aMove.needsUpdate = true;
  }

  render(renderer) {
    if (!this.rtDrops) return;
    const auto = renderer.autoClear;
    const alpha = renderer.getClearAlpha();
    renderer.getClearColor(_clear);
    renderer.setClearColor(0x000000, 0); // 没有水珠的地方遮罩必须是 0
    // 水珠每帧重画
    renderer.autoClear = true;
    this.mesh.material = this.matDrop;
    renderer.setRenderTarget(this.rtDrops);
    renderer.render(this.scene, this.camera);
    // 时间戳是累积的，不清
    renderer.setRenderTarget(this.rtClean);
    if (this.cleanFresh) {
      renderer.clear();
      this.cleanFresh = false;
    }
    renderer.autoClear = false;
    this.mesh.material = this.matClean;
    renderer.render(this.scene, this.camera);
    renderer.autoClear = auto;
    renderer.setClearColor(_clear, alpha);
  }
}

const _f = [0, 0];
const _clear = new THREE.Color();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// 前挡：低速时重力占上风，水珠往下淌；超过约 30km/h 被气流顶着往上爬，并略微向两侧散开
function flowFront(speed, x, y, out) {
  const s = clamp(1 - speed * 0.12, -3.2, 1);
  out[0] = s < 0 ? (x / GLASS.W0) * 0.3 * -s : 0;
  out[1] = -s;
}
// 侧窗：低速往下，高速被吹成横向往后（back = 车尾方向在玻璃坐标里的符号）
const flowSide = (back) => (speed, x, y, out) => {
  const air = smooth(5, 19, speed);
  out[0] = back * 0.989 * air * 1.6;
  out[1] = -(1 - 0.85 * air) - 0.148 * air * 1.6;
};

// 给前挡和左右门窗各建一套模拟（后窗和后三角窗离视线远，仍用解析的水珠）
export function createDropSims(renderer, glass) {
  // 32 位浮点渲染目标不是哪儿都有；没有就退回解析水珠
  const supported = renderer.capabilities.isWebGL2 !== false && renderer.extensions.has('EXT_color_buffer_float');
  const floatLinear = renderer.extensions.has('OES_texture_float_linear');
  const sims = {
    front: new DropSim({
      rect: [-0.7, -0.01, 0.7, 0.71],
      flow: flowFront,
      inside: (x, y) => y > 0 && y < GLASS.H && Math.abs(x) < GLASS.W0 + ((GLASS.W1 - GLASS.W0) * y) / GLASS.H + 0.02,
      wiped: true,
    }),
    // 侧窗的玻璃坐标：x 指向「从车内看」的右方，所以左窗的车尾方向是 -x，右窗是 +x
    left: new DropSim({ rect: [-0.48, -0.01, 0.78, 0.39], flow: flowSide(-1) }),
    right: new DropSim({ rect: [-0.78, -0.01, 0.48, 0.39], flow: flowSide(1) }),
  };
  const list = Object.keys(sims);
  for (const key of list) glass[key].uniforms.uSimRect.value = sims[key].uRect;

  return {
    supported,
    sims,
    // width = 0 关闭模拟
    setResolution(width) {
      const w = supported ? width : 0;
      for (const key of list) {
        const sim = sims[key];
        sim.setResolution(w, floatLinear);
        const u = glass[key].uniforms;
        u.uSim.value = w ? 1 : 0;
        u.tDrops.value = sim.rtDrops ? sim.rtDrops.texture : null;
        u.tClean.value = sim.rtClean ? sim.rtClean.texture : null;
      }
    },
    update(dt, rain, speed, wipers) {
      for (const key of list) sims[key].update(dt, rain, speed, wipers);
    },
    render() {
      for (const key of list) sims[key].render(renderer);
    },
  };
}
