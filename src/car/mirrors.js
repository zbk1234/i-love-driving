import * as THREE from 'three';
import { CAR } from '../config.js';
import { G } from '../core/globals.js';
import { GeoBuilder, V3 } from '../world/geo.js';
import { worldMaterial } from '../world/materials.js';

// 三面后视镜：车内镜 + 左右外后视镜，都是「真」平面镜。
//
// 做法：把驾驶员的眼睛关于镜面做镜像，得到一个虚拟视点；从虚拟视点出发、以镜片的四个角为
// 视锥边界（离轴投影）渲染一遍外景。这样镜子里看到的范围和真车上一样由「眼睛 + 镜片」的
// 相对位置决定，而不是随便架一台朝后的相机。
//
// 镜片的朝向不是手调的角度，而是由「想让驾驶员从镜子里看到哪儿」反推出来的：
// 镜面法线 = 平分「镜片→眼睛」和「镜片→目标点」两个方向。

const DEG = Math.PI / 180;
const EYE = new THREE.Vector3(...CAR.EYE);

// 圆角矩形轮廓，逆时针（从正面看）
function roundedRect(w, h, r, seg = 7) {
  const pts = [];
  const hw = w / 2 - r;
  const hh = h / 2 - r;
  const corners = [[hw, -hh, -90], [hw, hh, 0], [-hw, hh, 90], [-hw, -hh, 180]];
  for (const [cx, cy, a0] of corners) {
    for (let k = 0; k <= seg; k++) {
      const a = (a0 + (90 * k) / seg) * DEG;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

// 镜片：一片圆角矩形。顶点直接烘焙成车体局部坐标，着色器用它做投影贴图
function glassGeometry(outline, w, h, matrix) {
  const pos = [];
  const uv = [];
  const p = new THREE.Vector3();
  const put = (x, y) => {
    p.set(x, y, 0).applyMatrix4(matrix);
    pos.push(p.x, p.y, p.z);
    uv.push(x / w + 0.5, y / h + 0.5);
  };
  for (let k = 0; k < outline.length; k++) {
    const a = outline[k];
    const b = outline[(k + 1) % outline.length];
    put(0, 0);
    put(a[0], a[1]);
    put(b[0], b[1]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

// 镜壳：把轮廓按一串 [缩放, 深度] 放样成一个向后收圆的壳体
function shell(b, outline, steps) {
  const rings = steps.map(([s, z, dy = 0]) => outline.map(([x, y]) => V3(x * s, y * s + dy, z)));
  b.grid(rings, { closed: true });
  b.fan(rings[rings.length - 1], true);
}

const MIRROR_FRAG = /* glsl */ `
uniform sampler2D tMirror;
uniform sampler2D tNoise;
uniform mat4 uTexMatrix;   // 车体局部坐标 → 镜像贴图坐标
uniform float uConvex;     // 凸面镜：视野放大的倍数
uniform float uKind;       // 0 车内镜 / 1 外后视镜
uniform float uInner;      // 外后视镜靠车身的一侧：+1 在右，-1 在左
uniform float uRain;
uniform float uTime;
uniform vec3 uSkyAmb;
varying vec3 vLocal;
varying vec2 vUv;
void main() {
  vec4 c = uTexMatrix * vec4(vLocal, 1.0);
  vec2 uv = (c.xy / c.w - 0.5) * uConvex + 0.5;
  vec3 col;
  if (uKind < 0.5) {
    // 车内镜是隔着后风挡往外看的：后窗上的雨水让画面略微扭曲
    vec2 n = texture2D(tNoise, vUv * vec2(2.2, 0.6)).rg - 0.5;
    col = texture2D(tMirror, uv + n * 0.01 * uRain).rgb;
    // 镜子里其实是车厢后半部：上沿是顶棚，两侧是 C 柱，下面两角是后排头枕，中间才是后风挡
    vec2 q = vUv - 0.5;
    float frame = smoothstep(0.5, 0.465, abs(q.x)) * smoothstep(0.37, 0.31, q.y);
    float head = smoothstep(0.82, 1.05, length(vec2((abs(q.x) - 0.4) / 0.125, (q.y + 0.5) / 0.3)));
    col *= mix(0.04, 0.74, frame * head);
  } else {
    // 外后视镜：镜面上挂着水珠和水痕
    vec2 n = texture2D(tNoise, vUv * 1.5).rg - 0.5;
    vec2 n2 = texture2D(tNoise, vUv * 0.33 + vec2(0.3, uTime * 0.004)).rg - 0.5;
    col = texture2D(tMirror, uv + (n * 0.018 + n2 * 0.03) * uRain).rgb;
    // 靠车身的一侧能看到自己车身的一条边
    float e = uInner > 0.0 ? 1.0 - vUv.x : vUv.x;
    float edge = 0.085 + 0.05 * vUv.y;
    float body = smoothstep(edge, edge - 0.025, e);
    col = mix(col, uSkyAmb * (0.18 + 0.5 * vUv.y), body);
    col *= 0.86;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

class PlanarMirror {
  // center / target：车体局部坐标；size：[宽, 高, 圆角]；res：渲染分辨率
  constructor({ center, target, size, res, convex = 1, kind, inner = 0 }) {
    this.w = size[0];
    this.h = size[1];
    this.convex = convex;
    this.res = res;
    this.outline = roundedRect(size[0], size[1], size[2]);

    const c = V3(...center);
    const toEye = EYE.clone().sub(c).normalize();
    const toTarget = V3(...target).sub(c).normalize();
    const n = toEye.add(toTarget).normalize();
    const x = V3(0, 1, 0).cross(n).normalize(); // 从正面看的右方
    const y = n.clone().cross(x).normalize();
    this.matrix = new THREE.Matrix4().makeBasis(x, y, n).setPosition(c); // 镜片局部 → 车体局部
    this.normal = n;
    // 镜片三个角（从正面看：左下、右下、左上）
    this.pa = V3(-this.w / 2, -this.h / 2, 0).applyMatrix4(this.matrix);
    this.pb = V3(this.w / 2, -this.h / 2, 0).applyMatrix4(this.matrix);
    this.pc = V3(-this.w / 2, this.h / 2, 0).applyMatrix4(this.matrix);

    this.camera = new THREE.PerspectiveCamera();
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false; // 相机矩阵完全由 update() 手动给出
    this.camera.layers.enable(1);
    this.localCam = new THREE.Matrix4();
    this.pixelAngle = 0.001;

    this.target = new THREE.WebGLRenderTarget(res[0], res[1], {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
    });

    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tMirror: { value: this.target.texture },
        tNoise: G.tNoise,
        uTexMatrix: { value: new THREE.Matrix4() },
        uConvex: { value: convex },
        uKind: { value: kind },
        uInner: { value: inner },
        uRain: G.uRain,
        uTime: G.uTime,
        uSkyAmb: G.uSkyAmb,
      },
      vertexShader: /* glsl */ `
        varying vec3 vLocal;
        varying vec2 vUv;
        void main() {
          vLocal = position;
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: MIRROR_FRAG,
    });
    this.glass = new THREE.Mesh(glassGeometry(this.outline, this.w, this.h, this.matrix), this.material);
  }

  // eyeLocal：眼睛在车体局部坐标里的位置（会随车身晃动略有变化）
  update(carMatrix, eyeLocal) {
    const n = this.normal;
    // 眼睛关于镜面的镜像
    const d = _v.subVectors(eyeLocal, this.pa).dot(n);
    const pe = _pe.copy(eyeLocal).addScaledVector(n, -2 * d);
    // 虚拟视点在镜子背面，所以「屏幕」的左右是反过来的
    const vr = _vr.subVectors(this.pa, this.pb).normalize();
    const vu = _vu.subVectors(this.pc, this.pa).normalize();
    const vn = _vn.crossVectors(vr, vu); // 指向虚拟视点
    const va = _a.subVectors(this.pb, pe); // 从背面看的左下角
    const vb = _b.subVectors(this.pa, pe); // 右下角
    const vc = _c.copy(this.pb).add(this.pc).sub(this.pa).sub(pe); // 左上角
    const near = Math.max(-va.dot(vn), 0.05);
    let l = vr.dot(va);
    let r = vr.dot(vb);
    let b = vu.dot(va);
    let t = vu.dot(vc);
    // 凸面镜：以视锥中心为准放大视野
    const cx = (l + r) / 2;
    const cy = (b + t) / 2;
    l = cx + (l - cx) * this.convex;
    r = cx + (r - cx) * this.convex;
    b = cy + (b - cy) * this.convex;
    t = cy + (t - cy) * this.convex;

    const cam = this.camera;
    cam.projectionMatrix.makePerspective(l, r, t, b, near, 2500);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    this.localCam.makeBasis(vr, vu, vn).setPosition(pe);
    cam.matrixWorld.multiplyMatrices(carMatrix, this.localCam);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    this.pixelAngle = (t - b) / near / this.res[1];

    // 投影贴图矩阵在车体局部坐标里算：镜片跟着车走，镜像不会因为隔帧更新而错位
    _m.copy(this.localCam).invert();
    this.material.uniforms.uTexMatrix.value.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1).multiply(cam.projectionMatrix).multiply(_m);
  }
}

const _v = new THREE.Vector3();
const _pe = new THREE.Vector3();
const _vr = new THREE.Vector3();
const _vu = new THREE.Vector3();
const _vn = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _m = new THREE.Matrix4();

export function createMirrors() {
  // ------------------------------------------------------------ 车内后视镜
  // 挂在风挡顶部正中、离玻璃约 9cm；从镜子里正好看到后风挡的中心
  const center = new PlanarMirror({
    center: [0, 1.33, -0.235],
    target: [0, 1.3, 1.9],
    size: [0.235, 0.064, 0.02],
    res: [512, 144],
    kind: 0,
  });
  // 左右外后视镜：朝后、略向外、略向下。右镜离眼睛远，凸得更厉害，视野更广
  const left = new PlanarMirror({
    center: [-1.03, 1.035, -0.6],
    target: [-1.55, 0.9, 3.4],
    size: [0.19, 0.122, 0.032],
    res: [320, 208],
    convex: 1.9,
    kind: 1,
    inner: 1,
  });
  const right = new PlanarMirror({
    center: [1.03, 1.035, -0.6],
    target: [1.55, 0.9, 3.4],
    size: [0.19, 0.122, 0.032],
    res: [320, 208],
    convex: 2.7,
    kind: 1,
    inner: -1,
  });

  // ---- 车内镜的壳体和支架（属于车内场景，受车内光照）
  const interior = new THREE.Group();
  {
    const b = new GeoBuilder().color(0.014, 0.014, 0.016).xform(center.matrix);
    // 无边框镜：镜片四周只露出一圈很窄的黑边，壳体在背后收成圆润的一坨
    shell(b, center.outline, [[0.98, 0.0012], [1.035, 0.0006], [1.05, -0.006], [1.0, -0.017], [0.8, -0.027], [0.42, -0.032]]);
    // 球头支臂：从壳体背面伸向风挡上的底座
    const back = V3(0, 0.004, -0.028).applyMatrix4(center.matrix);
    const mount = V3(0, 1.392, -0.2);
    b.xform(null);
    b.cyl(back, mount, 0.011, 0.013, 10);
    // 风挡上的传感器罩（雨量 / 摄像头），扁扁的一块贴在玻璃内侧
    b.beam(V3(0, 1.365, -0.24), V3(0, 1.41, -0.165), 0.085, 0.03);
    const housing = new THREE.Mesh(b.build(true), new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide }));
    housing.castShadow = true;
    housing.receiveShadow = true;
    interior.add(housing, center.glass);
  }

  // ---- 外后视镜的壳体和底座（属于外景，会被车窗上的水珠折射；只有主相机看得见）
  const exterior = new THREE.Group();
  {
    const b = new GeoBuilder();
    for (const m of [left, right]) {
      const s = m === left ? -1 : 1;
      b.color(0.035, 0.04, 0.05).data(0).xform(m.matrix);
      // 镜片略微凹在壳口里；壳体向前收成流线型
      shell(b, m.outline, [[0.97, -0.003], [1.07, 0.004], [1.12, -0.006], [1.1, -0.04, 0.002], [0.94, -0.085, 0.004], [0.62, -0.115, 0.006], [0.25, -0.126, 0.007]]);
      b.xform(null);
      // 连到车门三角窗位置的底座
      b.beam(V3(s * 0.84, 0.975, -0.69), V3(s * 0.975, 0.985, -0.665), 0.075, 0.04, V3(0, 1, 0));
    }
    const housing = new THREE.Mesh(
      b.build(),
      worldMaterial({
        surface: /* glsl */ `
          vec2 bn = texture2D(tNoise, vUv * 2.5).rg - 0.5;
          N = normalize(N + vec3(bn.x, bn.y, 0.0) * 0.2 * uRain);
          gloss = 1.0;
          shin = 300.0;
        `,
      }),
    );
    for (const o of [housing, left.glass, right.glass]) {
      o.frustumCulled = false;
      o.layers.set(2);
      exterior.add(o);
    }
  }

  const list = [center, left, right];
  return {
    list,
    interior,
    exterior,
    update(carMatrix, eyeLocal) {
      for (const m of list) m.update(carMatrix, eyeLocal);
    },
  };
}
