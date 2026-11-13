import * as THREE from 'three';
import { CAR } from '../config.js';
import { G } from '../core/globals.js';
import { trianglePositions } from './model.js';

// 三面后视镜：车内镜 + 左右外后视镜，都是「真」平面镜。镜壳是车模自带的，这里只替换镜片。
//
// 做法：把驾驶员的眼睛关于镜面做镜像，得到一个虚拟视点；从虚拟视点出发、以镜片的四个角为
// 视锥边界（离轴投影）渲染一遍外景。这样镜子里看到的范围和真车上一样由「眼睛 + 镜片」的
// 相对位置决定，而不是随便架一台朝后的相机。
//
// 镜片的朝向不照搬模型（模型是左右对称的，没有朝驾驶员调过），而是由「想让驾驶员从镜子里
// 看到哪儿」反推出来：镜面法线 = 平分「镜片→眼睛」和「镜片→目标点」两个方向。
// 镜片网格仍用模型的形状，所以和镜壳严丝合缝；反射画面按这个反推出来的镜面去投影。

const EYE = new THREE.Vector3(...CAR.EYE);
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

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
  // positions：镜片的三角形顶点（车体局部坐标）；target：想从镜子里看到的点；res：渲染分辨率
  constructor({ positions, target, res, convex = 1, kind, inner = 0 }) {
    this.convex = convex;
    this.res = res;

    const c = new THREE.Box3().setFromArray(positions).getCenter(V3(0, 0, 0));
    const toEye = EYE.clone().sub(c).normalize();
    const toTarget = V3(...target).sub(c).normalize();
    const n = toEye.add(toTarget).normalize();
    const x = V3(0, 1, 0).cross(n).normalize(); // 从正面看的右方
    const y = n.clone().cross(x).normalize();
    this.normal = n;

    // 镜片在镜面上的外接矩形（留一点余量），它决定反射相机的视锥
    let hw = 0;
    let hh = 0;
    const d = V3(0, 0, 0);
    for (let i = 0; i < positions.length; i += 3) {
      d.set(positions[i], positions[i + 1], positions[i + 2]).sub(c);
      hw = Math.max(hw, Math.abs(d.dot(x)));
      hh = Math.max(hh, Math.abs(d.dot(y)));
    }
    this.w = hw * 2.1;
    this.h = hh * 2.1;
    // 矩形的三个角（从正面看：左下、右下、左上）
    this.pa = c.clone().addScaledVector(x, -this.w / 2).addScaledVector(y, -this.h / 2);
    this.pb = c.clone().addScaledVector(x, this.w / 2).addScaledVector(y, -this.h / 2);
    this.pc = c.clone().addScaledVector(x, -this.w / 2).addScaledVector(y, this.h / 2);

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
      side: THREE.DoubleSide,
    });

    // 镜片：模型的形状，uv 是它在外接矩形里的位置（水痕、车身边缘这些效果用）
    const uv = new Float32Array((positions.length / 3) * 2);
    for (let i = 0, j = 0; i < positions.length; i += 3, j += 2) {
      d.set(positions[i], positions[i + 1], positions[i + 2]).sub(c);
      uv[j] = d.dot(x) / this.w + 0.5;
      uv[j + 1] = d.dot(y) / this.h + 0.5;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.glass = new THREE.Mesh(geo, this.material);
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

export function createMirrors(model) {
  // 模型里三面镜片在同一个网格里，按左右位置分开
  const all = trianglePositions(model.mirrors);
  const faces = { center: [], left: [], right: [] };
  for (let i = 0; i < all.length; i += 9) {
    const cx = (all[i] + all[i + 3] + all[i + 6]) / 3;
    const key = Math.abs(cx) < 0.4 ? 'center' : cx < 0 ? 'left' : 'right';
    for (let k = 0; k < 9; k++) faces[key].push(all[i + k]);
  }

  // 车内镜：从镜子里正好看到尾门玻璃的中心
  const center = new PlanarMirror({
    positions: new Float32Array(faces.center),
    target: [0, 1.2, 2.1],
    res: [512, 144],
    kind: 0,
  });
  // 左右外后视镜：朝后、略向外、略向下。右镜离眼睛远，凸得更厉害，视野更广
  const left = new PlanarMirror({
    positions: new Float32Array(faces.left),
    target: [-1.4, 0.88, 3.4],
    res: [320, 208],
    convex: 1.9,
    kind: 1,
    inner: 1,
  });
  const right = new PlanarMirror({
    positions: new Float32Array(faces.right),
    target: [1.4, 0.88, 3.4],
    res: [320, 208],
    convex: 2.7,
    kind: 1,
    inner: -1,
  });

  // 车内镜属于车内场景；外后视镜属于外景（会被车窗上的水珠折射），只有主相机看得见
  const interior = new THREE.Group();
  interior.add(center.glass);
  const exterior = new THREE.Group();
  for (const o of [left.glass, right.glass]) {
    o.frustumCulled = false;
    o.layers.set(2);
    exterior.add(o);
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
