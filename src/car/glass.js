import * as THREE from 'three';
import { GLASS, WIPERS } from '../config.js';
import { G } from '../core/globals.js';

// 车窗上的雨。玻璃是真实的 3D 网格（取自车模），水珠固定在「玻璃坐标」里，所以转头时水珠是贴在玻璃上的。
// 做法：外景先渲染成一张图（tScene），玻璃网格按屏幕坐标去采这张图——
//   · 水珠 = 一个小透镜：把采样点往反方向推很远，于是每颗水珠里都有一幅缩小、上下颠倒的外景
//   · 水膜 = 模糊：在清晰图和两级模糊图之间插值
//   · 雨刮 = 时间函数：解析地算出每个像素「距上次被刮过了几秒」，只显示这之后才落下的水珠

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// 前挡曲面（对车模风挡的拟合）：玻璃坐标 (gx, gy) → 车体局部坐标
export function glassPoint(gx, gy, out = new THREE.Vector3()) {
  const t = gy / GLASS.H;
  const y = GLASS.Y0 + GLASS.DY * t + GLASS.BULGE * Math.sin(Math.PI * clamp01(t));
  const z = GLASS.Z0 + GLASS.DZ * t + GLASS.SWEEP * (gx / GLASS.W0) ** 2;
  return out.set(gx, y, z);
}

// 反过来：风挡上的一个点 → 玻璃坐标。先扣掉两侧的后掠，再投影到中线的斜面方向上
function windshieldCoords(x, y, z) {
  const zc = z - GLASS.SWEEP * (x / GLASS.W0) ** 2;
  const t = ((y - GLASS.Y0) * GLASS.DY + (zc - GLASS.Z0) * GLASS.DZ) / (GLASS.DY ** 2 + GLASS.DZ ** 2);
  return [x, t * GLASS.H];
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
// 朝车外的法线
export function glassNormal(gx, gy, out = new THREE.Vector3()) {
  glassPoint(gx + 0.01, gy, _a).sub(glassPoint(gx - 0.01, gy, _b));
  const du = _a.clone();
  glassPoint(gx, gy + 0.01, _a).sub(glassPoint(gx, gy - 0.01, _b));
  return out.crossVectors(_a, du).normalize();
}

// 把车模的玻璃网格（车体局部坐标，一个网格里包含全部车窗）拆成 前 / 左 / 右 / 后 四组，
// 并给每个顶点算出玻璃坐标 aG：x 永远指向「从车内看」的屏幕右侧，y 沿玻璃向上，单位米。
export function createGlassGeometries(source) {
  const pos = source.attributes.position;
  const index = source.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const groups = { front: [], left: [], right: [], rear: [] };
  const nSum = { front: new THREE.Vector3(), left: new THREE.Vector3(), right: new THREE.Vector3(), rear: new THREE.Vector3() };
  const n = new THREE.Vector3();
  for (let i = 0; i < triCount; i++) {
    const ia = index ? index.getX(i * 3) : i * 3;
    const ib = index ? index.getX(i * 3 + 1) : i * 3 + 1;
    const ic = index ? index.getX(i * 3 + 2) : i * 3 + 2;
    _a.fromBufferAttribute(pos, ia);
    _b.fromBufferAttribute(pos, ib);
    _c.fromBufferAttribute(pos, ic);
    n.subVectors(_b, _a).cross(_c.clone().sub(_a));
    const area = n.length();
    if (area < 1e-12) continue;
    // 侧窗的法线基本是横向的；前后风挡再按在车头还是车尾区分
    const side = Math.abs(n.x) > 0.6 * area;
    const cx = (_a.x + _b.x + _c.x) / 3;
    const cz = (_a.z + _b.z + _c.z) / 3;
    const key = side ? (cx < 0 ? 'left' : 'right') : cz < 0 ? 'front' : 'rear';
    groups[key].push(_a.x, _a.y, _a.z, _b.x, _b.y, _b.z, _c.x, _c.y, _c.z);
    if (n.y < 0) n.negate(); // 车窗都朝上倾，统一成朝外的那一面
    nSum[key].add(n);
  }

  const out = {};
  for (const key of Object.keys(groups)) {
    const p = groups[key];
    const g = new Float32Array((p.length / 3) * 2);
    // 沿玻璃向上的距离 = 高度差 / 玻璃的倾斜程度
    const ny = nSum[key].normalize().y;
    const rise = Math.sqrt(Math.max(1 - ny * ny, 1e-4));
    let yMin = Infinity;
    for (let i = 1; i < p.length; i += 3) yMin = Math.min(yMin, p[i]);
    for (let i = 0, j = 0; i < p.length; i += 3, j += 2) {
      const x = p[i];
      const y = p[i + 1];
      const z = p[i + 2];
      if (key === 'front') {
        const w = windshieldCoords(x, y, z);
        g[j] = w[0];
        g[j + 1] = w[1];
      } else {
        g[j] = key === 'left' ? -z : key === 'right' ? z : -x;
        g[j + 1] = (y - yMin) / rise;
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.setAttribute('aG', new THREE.BufferAttribute(g, 2));
    out[key] = geo;
  }
  return out;
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
uniform float uWet;       // 水膜厚度系数：前挡 1，侧窗薄一些
uniform vec3 uSkyAmb;
uniform float uFlash;
uniform float uSim;        // 是否有水珠模拟（dropsim.js）
uniform sampler2D tDrops;  // 模拟出来的大水珠：xy = 水珠内归一化位置 × 遮罩，a = 遮罩
uniform sampler2D tClean;  // 最近一次被滑过的水珠「洗干净」的时刻
uniform vec4 uSimRect;     // 模拟覆盖的玻璃坐标范围：x0, y0, 1/宽, 1/高
varying vec2 vG;

float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash21(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }

// 雨刮。返回该点距上次被刮过的秒数，另外给出刮片带来的两样东西：
//   bead  = 被刮片聚拢起来的水（刮片前面推着走的水脊、刮片外端甩在玻璃上的弧形水线），
//           格式和水珠一样：xy 是归一化的表面坡度方向，z 是遮罩
//   smear = 刚刮过的地方残留的极薄条纹造成的折射偏移（沿刮片扫过的弧线方向排列，零点几秒就流平）
float wipeSince(vec2 g, vec4 wp, vec2 ang, out vec3 bead, out vec2 smear) {
  bead = vec3(0.0);
  smear = vec2(0.0);
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
  s = max(s, 0.0);

  vec2 er = d / r;                 // 径向（沿刮片）
  vec2 et = vec2(-er.y, er.x);     // 切向（刮片前进 / 后退的方向）

  // ---- 水脊：刮片前面推着一道圆鼓鼓的水，粗细沿刮片不均匀，还在不停地抖
  if (tau < D) {
    float a = 0.5 - 0.5 * cos(6.2831853 * tau / D);
    float dir = tau < 0.5 * D ? 1.0 : -1.0;
    float ahead = (f - a) * dir * (ang.y - ang.x) * r;
    float w = 0.0105 * (0.75 + 0.45 * sin(r * 61.0 + tau * 9.0) * sin(r * 23.0 - 1.3));
    // 刮片本身有一定宽度：它压着的地方没有水，水脊从它的前缘开始
    float k = (ahead - 0.007) / w;
    if (k > 0.0 && k < 1.0) bead = vec3(et * dir * cos(3.14159 * k) * 0.92, sin(3.14159 * k));
    if (ahead > -0.009 && ahead < 0.007) s = 0.0;
  }

  // ---- 外端水线：刮片甩到最外圈的水留成一条弧，几秒内断成一颗颗水珠再流走
  float e = (wp.w - r) / 0.0055;
  if (e < 1.0 && s < 9.0) {
    float n = 0.5 + 0.5 * sin(f * 131.0 + 4.0 * sin(f * 37.0));
    float keep = smoothstep(s * 0.11, s * 0.11 + 0.12, n);
    float m = sin(3.14159 * e) * keep;
    if (m > bead.z) bead = vec3(-er * cos(3.14159 * e) * 0.9, m);
  }

  // ---- 刮后的细条纹
  float lines = sin(r * 4100.0 + 3.0 * sin(r * 310.0)) * 0.6 + sin(r * 1730.0 + 1.7) * 0.4;
  smear = er * lines * 0.0045 * exp(-s / 0.4);
  return s;
}

// 静止水珠。每格最多一颗，寿命到了原地换一颗；只有「出生晚于上次刮刷」的才画出来。
// 为了不露出格子的痕迹：每层的格子转一个不同的角度、水珠大小连续分布（小的多大的少）、
// 轮廓不是正圆（一头大一头小，大水珠被重力拉长）。
// cs = 这一层格子的旋转 (cos, sin)。返回 (水珠内归一化位置.xy × 遮罩, 遮罩)
vec3 dropsLayer(vec2 g, vec2 cs, float cell, float life, float since, float density, float seed) {
  vec2 q = vec2(cs.x * g.x - cs.y * g.y, cs.y * g.x + cs.x * g.y) / cell;
  vec2 id = floor(q);
  vec2 f = fract(q) - 0.5;
  float h = hash21(id + seed);
  float tt = uTime / life + h;
  float n = floor(tt);
  float age = (tt - n) * life;
  if (age > since) return vec3(0.0); // 刚刮过的区域绝大多数格子在这里就返回了
  vec2 rnd = hash22(id + n * 17.13 + seed);
  if (rnd.x > density) return vec3(0.0);
  vec2 sh = hash22(id * 1.37 + n * 5.1 + seed) - 0.5;
  float size = rnd.y * rnd.y;                       // 偏向小水珠
  float R = mix(0.07, 0.25, size) * (0.55 + 0.45 * smoothstep(0.0, life * 0.5, age));
  R *= smoothstep(0.0, 0.05, age) * (1.0 + 0.4 * exp(-age * 16.0)); // 砸上来的瞬间略微摊开
  R *= smoothstep(life, life - 0.25, age);
  vec2 c = sh * (0.9 - 3.2 * R);                    // 小水珠在格子里可以挪得更远
  vec2 e = f - c;
  vec2 d = vec2(cs.x * e.x + cs.y * e.y, -cs.y * e.x + cs.x * e.y) / max(R, 1e-4); // 转回玻璃坐标
  d.y *= 1.0 - 0.22 * size;                         // 大水珠被重力拉长
  d *= 1.0 + dot(d, sh) * 0.5 + d.x * d.y * (rnd.x - 0.5) * 0.6; // 不规则的轮廓
  float m = smoothstep(1.0, 0.84, dot(d, d));
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
  float m = smoothstep(1.0, 0.8, dot(dl, dl));
  float tl = clamp(behind / (CH * 0.5), 0.0, 1.0);
  float tw = R * 0.5 * (1.0 - tl);
  float tm = smoothstep(tw, tw * 0.4, abs(dx)) * step(0.0, behind) * (1.0 - tl) * grown;
  float by = fract(q.y * 1.7 + h1 * 5.0) - 0.5;
  vec2 bd = vec2(dx, by / 1.7) / max(R * 0.38 * (1.0 - tl), 1e-4);
  float bm = smoothstep(1.0, 0.7, dot(bd, bd)) * step(0.0, behind) * step(tl, 0.98);
  vec2 offL = dl * m + bd * bm * (1.0 - m);
  return vec4(ex * offL.x + ey * offL.y, max(m, bm * 0.85), max(tm, m));
}

void main() {
  vec2 g = vG;
  vec2 suv = gl_FragCoord.xy / uRes;

  float since = 1e4;
  vec3 bead = vec3(0.0);
  vec2 smear = vec2(0.0);
  if (uHasWipers > 0.5) {
    vec3 b1;
    vec3 b2;
    vec2 m1;
    vec2 m2;
    float s1 = wipeSince(g, uWpA, uWpAng.xy, b1, m1);
    float s2 = wipeSince(g, uWpB, uWpAng.zw, b2, m2);
    since = min(s1, s2);
    bead = b1.z > b2.z ? b1 : b2;
    smear = s1 < s2 ? m1 : m2;
  }
  float rain = uRain;
  vec4 nf = texture2D(tNoise, g * 7.0);

  // ---- 模拟的大水珠。它们滑过的地方算作「刚洗过」，和雨刮刮过是一回事
  bool sim = false;
  vec4 S = vec4(0.0);
  if (uSim > 0.5) {
    vec2 sg = (g - uSimRect.xy) * uSimRect.zw;
    if (sg.x > 0.0 && sg.x < 1.0 && sg.y > 0.0 && sg.y < 1.0) {
      sim = true;
      S = texture2D(tDrops, sg);
      float ct = texture2D(tClean, sg).r;
      if (ct > 0.0) since = min(since, max(uTime - ct, 0.0));
    }
  }
  // 水珠成片：有的地方密，有的地方稀
  float patchy = 0.5 + 1.0 * nf.b;

  // ---- 由小到大的静止水珠。有模拟时只留细的三层，最大的那些交给模拟
  vec3 acc = vec3(0.0);
  vec3 L = dropsLayer(g, vec2(0.955, 0.296), 0.0034, 2.6, since, (0.22 + 0.6 * rain) * patchy, 11.0);
  acc = mix(acc, L, L.z);
  L = dropsLayer(g + 0.37, vec2(0.454, 0.891), 0.0068, 5.0, since, (0.2 + 0.55 * rain) * patchy, 23.0);
  acc = mix(acc, L, L.z);
  L = dropsLayer(g + 0.71, vec2(-0.416, 0.909), 0.0125, 9.0, since, (0.14 + 0.5 * rain) * patchy, 37.0);
  acc = mix(acc, L, L.z);
  float trail = 0.0;
  if (sim) {
    acc.xy = acc.xy * (1.0 - S.a) + S.xy;
    acc.z = max(acc.z, S.a);
  } else {
  L = dropsLayer(g + 0.13, vec2(-0.857, 0.516), 0.024, 15.0, since, (0.06 + 0.4 * rain) * patchy, 59.0);
  acc = mix(acc, L, L.z);

  // ---- 滑动水珠
  if (uSlideA.w > 0.01) {
    vec4 Sl = slideLayer(g, uSlideA.xyz, uSlideSign.x, since, rain, 51.0);
    float w = Sl.z * uSlideA.w;
    acc.xy = mix(acc.xy, Sl.xy, w);
    acc.z = max(acc.z, w);
    trail = max(trail, Sl.w * uSlideA.w);
  }
  if (uSlideB.w > 0.01) {
    vec4 Sl = slideLayer(g + 0.53, uSlideB.xyz, uSlideSign.y, since, rain, 77.0);
    float w = Sl.z * uSlideB.w;
    acc.xy = mix(acc.xy, Sl.xy, w);
    acc.z = max(acc.z, w);
    trail = max(trail, Sl.w * uSlideB.w);
  }
  }

  // ---- 雨刮聚拢的水盖在最上面
  acc.xy = mix(acc.xy, bead.xy * bead.z, bead.z);
  acc.z = max(acc.z, bead.z);

  // ---- 水膜：刮过之后几秒内重新糊上；水珠本身和水痕处是清晰的
  float film = rain * smoothstep(0.0, 2.6, since) * uWet;
  float blur = film * (0.5 + 0.4 * nf.b) * (1.0 - 0.85 * trail);
  blur = mix(blur, 0.05, acc.z);
  blur = max(blur, length(smear) * 40.0);

  // ---- 折射。水珠是球冠：越靠边表面越陡，偏移越大，所以边缘一圈窄窄的地方压进了很大一片外景
  float dd = min(dot(acc.xy, acc.xy), 1.0);
  vec2 off = acc.xy * (uLens * 0.8 * inversesqrt(max(1.0 - 0.82 * dd, 0.14)));
  off += (nf.rg - 0.5) * 0.012 * film * (1.0 - acc.z);
  off += smear * (1.0 - acc.z);

  vec2 uv2 = suv - off * vec2(uRes.y / uRes.x, 1.0);
  float b2 = clamp(blur * 2.0, 0.0, 2.0);
  vec3 col;
  if (b2 < 0.02) col = texture2D(tScene, uv2).rgb;
  else if (b2 < 1.0) col = mix(texture2D(tScene, uv2).rgb, texture2D(tBlurA, uv2).rgb, b2);
  else col = mix(texture2D(tBlurA, uv2).rgb, texture2D(tBlurB, uv2).rgb, b2 - 1.0);

  // ---- 水珠表面的光
  if (acc.z > 0.01) {
    vec2 nd = acc.xy * inversesqrt(dd + 1e-5);
    float rim = acc.z * smoothstep(0.5, 0.97, dd);
    // 边缘很陡，光几乎折不过来：一圈细细的暗边
    col *= 1.0 - 0.6 * rim;
    // 掠射角的菲涅耳反射：边缘映出周围的光（路灯的橙色、车灯的白色）和天空
    float fres = rim * rim;
    vec3 env = texture2D(tBlurB, suv + nd * vec2(uRes.y / uRes.x, 1.0) * 0.12).rgb;
    col += (env * 0.55 + uSkyAmb * (0.25 + 0.35 * nd.y) * (1.0 + uFlash * 10.0)) * fres;
    // 朝天的那一侧有一小点锐利的高光
    float glint = acc.z * smoothstep(0.9, 0.99, dot(nd, vec2(-0.45, 0.89))) * smoothstep(0.25, 0.45, dd) * smoothstep(0.85, 0.6, dd);
    col += (uSkyAmb * (1.0 + uFlash * 10.0) + env * 0.5) * glint * 2.2;
  }

  col *= uTint;

  gl_FragColor = vec4(col, 1.0);
}
`;

export function createGlassMaterial({ wipers = false, tint = [0.86, 0.9, 0.88], lens = 0.1, wet = 1 } = {}) {
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
      uWet: { value: wet },
      uSkyAmb: G.uSkyAmb,
      uFlash: G.uFlash,
      uSim: { value: 0 },
      tDrops: { value: null },
      tClean: { value: null },
      uSimRect: { value: new THREE.Vector4(0, 0, 1, 1) },
    },
    vertexShader: /* glsl */ `
      attribute vec2 aG;
      varying vec2 vG;
      void main() {
        vG = aG;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: FRAG,
    side: THREE.DoubleSide,
  });
}
