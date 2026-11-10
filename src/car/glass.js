import * as THREE from 'three';
import { GLASS, WIPERS } from '../config.js';
import { G } from '../core/globals.js';

// 车窗上的雨。玻璃是真实的 3D 网格，水珠固定在「玻璃坐标」里，所以转头时水珠是贴在玻璃上的。
// 做法：外景先渲染成一张图（tScene），玻璃网格按屏幕坐标去采这张图——
//   · 水珠 = 一个小透镜：把采样点往反方向推很远，于是每颗水珠里都有一幅缩小、上下颠倒的外景
//   · 水膜 = 模糊：在清晰图和两级模糊图之间插值
//   · 雨刮 = 时间函数：解析地算出每个像素「距上次被刮过了几秒」，只显示这之后才落下的水珠

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 前挡曲面：玻璃坐标 (gx, gy) → 车体局部坐标
export function glassPoint(gx, gy, out = new THREE.Vector3()) {
  const t = gy / GLASS.H;
  const y = GLASS.Y0 + GLASS.DY * t + 0.015 * Math.sin(Math.PI * clamp01(t));
  const z = GLASS.Z0 + GLASS.DZ * t + GLASS.SWEEP * (gx / GLASS.W0) ** 2;
  return out.set(gx, y, z);
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
// 朝车外的法线
export function glassNormal(gx, gy, out = new THREE.Vector3()) {
  glassPoint(gx + 0.01, gy, _a).sub(glassPoint(gx - 0.01, gy, _b));
  const du = _a.clone();
  glassPoint(gx, gy + 0.01, _a).sub(glassPoint(gx, gy - 0.01, _b));
  return out.crossVectors(_a, du).normalize();
}

export const glassHalfWidth = (gy) => GLASS.W0 + (GLASS.W1 - GLASS.W0) * clamp01(gy / GLASS.H);

export function createWindshieldGeometry() {
  const NS = 40;
  const NT = 24;
  const pos = [];
  const gco = [];
  const edge = [];
  const idx = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= NT; j++) {
    const t = j / NT;
    const gy = t * GLASS.H;
    const hw = glassHalfWidth(gy) + 0.03;
    for (let i = 0; i <= NS; i++) {
      const gx = (i / NS) * 2 * hw - hw;
      glassPoint(gx, gy, p);
      pos.push(p.x, p.y, p.z);
      gco.push(gx, gy);
      edge.push(Math.min(hw - Math.abs(gx), gy, GLASS.H - gy));
      if (i < NS && j < NT) {
        const a = j * (NS + 1) + i;
        idx.push(a, a + 1, a + NS + 2, a, a + NS + 2, a + NS + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aG', new THREE.Float32BufferAttribute(gco, 2));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  g.setIndex(idx);
  return g;
}

// 侧窗 / 后窗：四个角点双线性插值。corners 与 gcorners 顺序：左下、右下、右上、左上（从车内看）
export function createFlatGlassGeometry(corners, gcorners, nx = 14, ny = 8) {
  const pos = [];
  const gco = [];
  const edge = [];
  const idx = [];
  const segDist = (px, py, a, b) => {
    const vx = b[0] - a[0];
    const vy = b[1] - a[1];
    const t = clamp01(((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy));
    return Math.hypot(px - a[0] - vx * t, py - a[1] - vy * t);
  };
  const bil = (c, s, t, k) => (c[0][k] * (1 - s) + c[1][k] * s) * (1 - t) + (c[3][k] * (1 - s) + c[2][k] * s) * t;
  for (let j = 0; j <= ny; j++) {
    for (let i = 0; i <= nx; i++) {
      const s = i / nx;
      const t = j / ny;
      pos.push(bil(corners, s, t, 0), bil(corners, s, t, 1), bil(corners, s, t, 2));
      const gx = bil(gcorners, s, t, 0);
      const gy = bil(gcorners, s, t, 1);
      gco.push(gx, gy);
      let e = Infinity;
      for (let k = 0; k < 4; k++) e = Math.min(e, segDist(gx, gy, gcorners[k], gcorners[(k + 1) % 4]));
      edge.push(e);
      if (i < nx && j < ny) {
        const a = j * (nx + 1) + i;
        idx.push(a, a + 1, a + nx + 2, a, a + nx + 2, a + nx + 1);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aG', new THREE.Float32BufferAttribute(gco, 2));
  g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
  g.setIndex(idx);
  return g;
}

const FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform sampler2D tBlurA;
uniform sampler2D tBlurB;
uniform sampler2D tNoise;
uniform vec2 uRes;
uniform float uTime;
uniform float uRain;
uniform vec4 uSlideA;     // 滑动水珠层 A：方向.xy、累计相位、权重
uniform vec4 uSlideB;
uniform vec2 uSlideSign;  // 两层当前的运动方向（决定水痕拖在哪一侧）
uniform vec3 uWipe;       // 当前刮刷周期已过时间、单次刮刷时长、与上一周期的间隔
uniform float uHasWipers;
uniform vec4 uWpA;        // 雨刮轴心.xy、刮片内外半径
uniform vec4 uWpB;
uniform vec4 uWpAng;      // 两支雨刮的起止角
uniform vec3 uTint;
uniform float uLens;
uniform float uFrit;
uniform float uWet;       // 水膜厚度系数：前挡 1，侧窗薄一些
uniform vec3 uSkyAmb;
uniform float uFlash;
varying vec2 vG;
varying float vEdge;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }

// 该点距上次被雨刮刮过的秒数；ridge = 刮片前面被推着走的那道水脊
float wipeSince(vec2 g, vec4 wp, vec2 ang, out float ridge) {
  ridge = 0.0;
  vec2 d = g - wp.xy;
  float r = length(d);
  float f = (atan(d.y, d.x) - ang.x) / (ang.y - ang.x);
  if (r < wp.z || r > wp.w || f < 0.0 || f > 1.0) return 1e4;
  float D = uWipe.y;
  float tau = uWipe.x;
  // 刮片角度随时间走 (1-cos)/2：上行经过 f 的时刻 tu，回程经过的时刻 td
  float tu = D * acos(clamp(1.0 - 2.0 * f, -1.0, 1.0)) / 6.2831853;
  float td = D - tu;
  float s;
  if (tau >= td) s = tau - td;
  else if (tau >= tu) s = tau - tu;
  else s = tau + uWipe.z - td;
  if (tau < D) {
    float a = 0.5 - 0.5 * cos(6.2831853 * tau / D);
    float dir = tau < 0.5 * D ? 1.0 : -1.0;
    float ahead = (f - a) * dir * (ang.y - ang.x) * r;
    ridge = step(0.0, ahead) * smoothstep(0.018, 0.0, ahead);
  }
  return max(s, 0.0);
}

// 静止水珠：每格一颗，寿命到了原地换一颗。只有「出生晚于上次刮刷」的才画出来。
// 返回 (透镜偏移.xy, 遮罩)
vec3 dropsLayer(vec2 g, float cell, float life, float since, float density, float seed) {
  vec2 q = g / cell;
  vec2 id = floor(q);
  vec2 f = fract(q) - 0.5;
  float h = hash21(id + seed);
  float tt = uTime / life + h;
  float n = floor(tt);
  float age = (tt - n) * life;
  if (age > since) return vec3(0.0); // 刚刮过的区域绝大多数格子在这里就返回了
  vec2 rnd = hash22(id + n * 17.13 + seed);
  if (rnd.x > density) return vec3(0.0);
  vec2 c = (hash22(id * 1.37 + n * 5.1 + seed) - 0.5) * 0.5;
  float R = mix(0.11, 0.24, rnd.y) * (0.6 + 0.4 * smoothstep(0.0, life * 0.5, age));
  R *= smoothstep(0.0, 0.05, age) * (1.0 + 0.4 * exp(-age * 16.0)); // 砸上来的瞬间略微摊开
  R *= smoothstep(life, life - 0.25, age);
  vec2 d = (f - c) / max(R, 1e-4);
  d.y *= 0.88;
  float m = smoothstep(1.0, 0.72, dot(d, d));
  return vec3(d * m, m);
}

// 滑动水珠：按列排布，主水珠沿 sl.xy 方向一顿一顿地走，身后拖一条渐细的水痕和几颗残留小水珠。
// 返回 (透镜偏移.xy, 遮罩, 水痕清除量)
vec4 slideLayer(vec2 g, vec3 sl, float sgn, float since, float rain, float seed) {
  if (since < 0.9) return vec4(0.0); // 水珠至少要攒 0.9 秒才会开始往下淌
  vec2 ey = sl.xy;
  vec2 ex = vec2(ey.y, -ey.x);
  vec2 q = vec2(dot(g, ex), dot(g, ey)) / 0.034;
  const float CH = 5.0;
  float col = floor(q.x);
  float h1 = hash11(col * 3.17 + seed);
  float ph = sl.z * mix(0.55, 1.5, h1) + h1 * 31.0;
  ph += 0.12 * sin(ph * 6.2831853 + h1 * 6.0);
  float yy = q.y / CH - ph;
  float row = floor(yy);
  float fy = yy - row;
  vec2 rnd = hash22(vec2(col, row) + seed);
  if (rnd.x > 0.22 + 0.5 * rain) return vec4(0.0);
  float form = mix(0.9, 3.5, rnd.y);
  float grown = smoothstep(form, form + 0.6, since);
  if (grown <= 0.0) return vec4(0.0);
  float wig = (sin(q.y * 0.9 + h1 * 40.0) * 0.6 + sin(q.y * 2.3 + h1 * 17.0) * 0.4) * 0.22;
  float dx = fract(q.x) - 0.5 - wig;
  float along = (fy - 0.5) * CH;        // 沿运动方向相对主水珠的位置
  float behind = -along * sgn;          // >0 在水珠身后
  float R = mix(0.16, 0.26, rnd.y) * grown;
  vec2 dl = vec2(dx, along * (behind > 0.0 ? 0.55 : 1.0)) / max(R, 1e-4);
  float m = smoothstep(1.0, 0.65, dot(dl, dl));
  float tl = clamp(behind / (CH * 0.5), 0.0, 1.0);
  float tw = R * 0.5 * (1.0 - tl);
  float tm = smoothstep(tw, tw * 0.4, abs(dx)) * step(0.0, behind) * (1.0 - tl) * grown;
  float by = fract(q.y * 1.7 + h1 * 5.0) - 0.5;
  vec2 bd = vec2(dx, by / 1.7) / max(R * 0.38 * (1.0 - tl), 1e-4);
  float bm = smoothstep(1.0, 0.5, dot(bd, bd)) * step(0.0, behind) * step(tl, 0.98);
  vec2 offL = dl * m + bd * bm * (1.0 - m);
  return vec4(ex * offL.x + ey * offL.y, max(m, bm * 0.85), max(tm, m));
}

void main() {
  vec2 g = vG;
  vec2 suv = gl_FragCoord.xy / uRes;

  float since = 1e4;
  float ridge = 0.0;
  if (uHasWipers > 0.5) {
    float r1;
    float r2;
    float s1 = wipeSince(g, uWpA, uWpAng.xy, r1);
    float s2 = wipeSince(g, uWpB, uWpAng.zw, r2);
    since = min(s1, s2);
    ridge = max(r1, r2);
  }
  float rain = uRain;

  // ---- 三层由小到大的静止水珠
  vec3 acc = vec3(0.0);
  vec3 L = dropsLayer(g, 0.0042, 3.2, since, 0.2 + 0.65 * rain, 11.0);
  acc = mix(acc, L, L.z);
  L = dropsLayer(g + 0.37, 0.0095, 6.0, since, 0.15 + 0.6 * rain, 23.0);
  acc = mix(acc, L, L.z);
  L = dropsLayer(g + 0.71, 0.021, 12.0, since, 0.08 + 0.42 * rain, 37.0);
  acc = mix(acc, L, L.z);

  // ---- 滑动水珠
  float trail = 0.0;
  if (uSlideA.w > 0.01) {
    vec4 S = slideLayer(g, uSlideA.xyz, uSlideSign.x, since, rain, 51.0);
    float w = S.z * uSlideA.w;
    acc.xy = mix(acc.xy, S.xy, w);
    acc.z = max(acc.z, w);
    trail = max(trail, S.w * uSlideA.w);
  }
  if (uSlideB.w > 0.01) {
    vec4 S = slideLayer(g + 0.53, uSlideB.xyz, uSlideSign.y, since, rain, 77.0);
    float w = S.z * uSlideB.w;
    acc.xy = mix(acc.xy, S.xy, w);
    acc.z = max(acc.z, w);
    trail = max(trail, S.w * uSlideB.w);
  }

  // ---- 水膜：刮过之后几秒内重新糊上；水珠本身和水痕处是清晰的
  vec4 nf = texture2D(tNoise, g * 7.0);
  float film = rain * smoothstep(0.0, 2.6, since) * uWet;
  float blur = film * (0.5 + 0.4 * nf.b) * (1.0 - 0.85 * trail);
  blur = mix(blur, 0.05, acc.z);
  blur = max(blur, ridge * 0.6);

  vec2 off = acc.xy * uLens;
  off += (nf.rg - 0.5) * 0.012 * film * (1.0 - acc.z);
  off.y += ridge * 0.03 * (nf.a - 0.3);

  vec2 uv2 = suv - off * vec2(uRes.y / uRes.x, 1.0);
  float b2 = clamp(blur * 2.0, 0.0, 2.0);
  vec3 col;
  if (b2 < 0.02) col = texture2D(tScene, uv2).rgb;
  else if (b2 < 1.0) col = mix(texture2D(tScene, uv2).rgb, texture2D(tBlurA, uv2).rgb, b2);
  else col = mix(texture2D(tBlurA, uv2).rgb, texture2D(tBlurB, uv2).rgb, b2 - 1.0);

  // ---- 水珠边缘的暗环和一点天光高光
  float dd = dot(acc.xy, acc.xy);
  col *= 1.0 - 0.5 * acc.z * smoothstep(0.25, 0.75, dd);
  float glint = acc.z * smoothstep(0.55, 0.9, dot(normalize(acc.xy + 1e-5), vec2(-0.45, 0.89))) * smoothstep(0.2, 0.5, dd);
  col += uSkyAmb * (1.0 + uFlash * 10.0) * glint * 1.3;

  col *= uTint;

  // ---- 玻璃边缘的黑色陶瓷釉（实心边 + 渐隐圆点）
  if (uFrit > 0.0) {
    float t = (vEdge - uFrit * 0.6) / uFrit;
    float rdot = 0.5 * (1.0 - clamp(t, 0.0, 1.0));
    float dotm = step(t, 1.0) * smoothstep(rdot, rdot - 0.15, length(fract(g * 260.0) - 0.5));
    col = mix(col, vec3(0.003), max(step(t, 0.0), dotm));
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createGlassMaterial({ wipers = false, tint = [0.86, 0.9, 0.88], lens = 0.1, frit = 0, wet = 1 } = {}) {
  const [wa, wb] = WIPERS;
  return new THREE.ShaderMaterial({
    uniforms: {
      tScene: { value: null },
      tBlurA: { value: null },
      tBlurB: { value: null },
      tNoise: G.tNoise,
      uRes: { value: new THREE.Vector2(1, 1) },
      uTime: G.uTime,
      uRain: G.uRain,
      uSlideA: { value: new THREE.Vector4(0, -1, 0, 1) },
      uSlideB: { value: new THREE.Vector4(1, 0, 0, 0) },
      uSlideSign: { value: new THREE.Vector2(1, 1) },
      uWipe: { value: new THREE.Vector3(1e3, 1.2, 1e3) },
      uHasWipers: { value: wipers ? 1 : 0 },
      uWpA: { value: new THREE.Vector4(wa.pivot[0], wa.pivot[1], wa.rIn, wa.rOut) },
      uWpB: { value: new THREE.Vector4(wb.pivot[0], wb.pivot[1], wb.rIn, wb.rOut) },
      uWpAng: { value: new THREE.Vector4(wa.a0, wa.a1, wb.a0, wb.a1) },
      uTint: { value: new THREE.Color(...tint) },
      uLens: { value: lens },
      uFrit: { value: frit },
      uWet: { value: wet },
      uSkyAmb: G.uSkyAmb,
      uFlash: G.uFlash,
    },
    vertexShader: /* glsl */ `
      attribute vec2 aG;
      attribute float aEdge;
      varying vec2 vG;
      varying float vEdge;
      void main() {
        vG = aG;
        vEdge = aEdge;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
  });
}
