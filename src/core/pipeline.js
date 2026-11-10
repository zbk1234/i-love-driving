import * as THREE from 'three';
import { G } from './globals.js';

// 渲染管线。每帧的顺序：
//   1. 后视镜：三面镜子轮流更新，每帧只画一面
//   2. 路面平面倒影（镜像相机渲染外景）→ 竖向拉长模糊，得到湿沥青上的长光带
//   3. 外景主画面（HDR）
//   4. 外景的两级模糊（给车窗水膜用）
//   5. 车内：玻璃网格采样第 3/4 步的结果并叠加水珠，再画内饰
//   6. 泛光 + 色调映射
//   7. FXAA 抗锯齿 + 胶片颗粒，输出到屏幕

const fsGeo = new THREE.BufferGeometry();
fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
const FS_VERT = 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';

class Pass {
  constructor(frag, uniforms) {
    this.material = new THREE.ShaderMaterial({ vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });
    this.u = this.material.uniforms;
    this.mesh = new THREE.Mesh(fsGeo, this.material);
    this.mesh.frustumCulled = false;
  }
  render(renderer, target) {
    renderer.setRenderTarget(target);
    renderer.render(this.mesh, fsCam);
  }
}

// 13 点降采样（来自 COD: Advanced Warfare 的泛光做法），可选亮度阈值
const DOWN = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
vec3 tap(float x, float y) { return texture2D(tSrc, vUv + uTexel * vec2(x, y)).rgb; }
void main() {
  vec3 col = tap(0.0, 0.0) * 0.125
    + (tap(-2.0, 2.0) + tap(2.0, 2.0) + tap(-2.0, -2.0) + tap(2.0, -2.0)) * 0.03125
    + (tap(0.0, 2.0) + tap(-2.0, 0.0) + tap(2.0, 0.0) + tap(0.0, -2.0)) * 0.0625
    + (tap(-1.0, 1.0) + tap(1.0, 1.0) + tap(-1.0, -1.0) + tap(1.0, -1.0)) * 0.125;
  if (uThreshold > 0.0) {
    col = min(col, vec3(60.0));
    float br = max(col.r, max(col.g, col.b));
    float knee = uThreshold * 0.5;
    float soft = clamp(br - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee + 1e-4);
    col *= max(soft, br - uThreshold) / max(br, 1e-4);
  }
  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);
}`;

// 3×3 帐篷滤波升采样，可叠加另一张图
const UP = /* glsl */ `
uniform sampler2D tSrc;
uniform sampler2D tAdd;
uniform float uAddK;
uniform vec2 uTexel;
varying vec2 vUv;
vec3 tap(float x, float y) { return texture2D(tSrc, vUv + uTexel * vec2(x, y)).rgb; }
void main() {
  vec3 col = tap(0.0, 0.0) * 4.0
    + (tap(-1.0, 0.0) + tap(1.0, 0.0) + tap(0.0, -1.0) + tap(0.0, 1.0)) * 2.0
    + tap(-1.0, -1.0) + tap(1.0, -1.0) + tap(-1.0, 1.0) + tap(1.0, 1.0);
  col *= 0.0625;
  if (uAddK > 0.0) col += texture2D(tAdd, vUv).rgb * uAddK;
  gl_FragColor = vec4(col, 1.0);
}`;

// 单方向高斯模糊（9 点）
const BLUR = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uStep;
varying vec2 vUv;
void main() {
  vec3 col = texture2D(tSrc, vUv).rgb * 0.227027;
  col += (texture2D(tSrc, vUv + uStep).rgb + texture2D(tSrc, vUv - uStep).rgb) * 0.1945946;
  col += (texture2D(tSrc, vUv + uStep * 2.0).rgb + texture2D(tSrc, vUv - uStep * 2.0).rgb) * 0.1216216;
  col += (texture2D(tSrc, vUv + uStep * 3.0).rgb + texture2D(tSrc, vUv - uStep * 3.0).rgb) * 0.054054;
  col += (texture2D(tSrc, vUv + uStep * 4.0).rgb + texture2D(tSrc, vUv - uStep * 4.0).rgb) * 0.016216;
  gl_FragColor = vec4(col, 1.0);
}`;

const FINAL = /* glsl */ `
uniform sampler2D tColor;
uniform sampler2D tBloom;
uniform float uExposure;
uniform float uBloom;
varying vec2 vUv;
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main() {
  vec2 c = vUv - 0.5;
  float r2 = dot(c, c);
  // 镜头边缘轻微色散
  vec2 ca = c * r2 * 0.012;
  vec3 col = vec3(texture2D(tColor, vUv + ca).r, texture2D(tColor, vUv).g, texture2D(tColor, vUv - ca).b);
  col += texture2D(tBloom, vUv).rgb * uBloom;
  col *= uExposure;
  col *= 1.0 - 0.42 * smoothstep(0.12, 0.75, r2 * 1.5); // 暗角
  col = aces(col);
  col = pow(col, vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}`;

// FXAA（Timothy Lottes 的算法，这里是广为流传的精简实现）+ 胶片颗粒
const FXAA = /* glsl */ `
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uTime;
varying vec2 vUv;
float hash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 lw = vec3(0.299, 0.587, 0.114);
  vec3 rgbM = texture2D(tSrc, vUv).rgb;
  float lNW = dot(texture2D(tSrc, vUv + vec2(-1.0, -1.0) * uTexel).rgb, lw);
  float lNE = dot(texture2D(tSrc, vUv + vec2(1.0, -1.0) * uTexel).rgb, lw);
  float lSW = dot(texture2D(tSrc, vUv + vec2(-1.0, 1.0) * uTexel).rgb, lw);
  float lSE = dot(texture2D(tSrc, vUv + vec2(1.0, 1.0) * uTexel).rgb, lw);
  float lM = dot(rgbM, lw);
  float lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  float lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));
  vec3 col = rgbM;
  if (lMax - lMin > max(0.03, lMax * 0.1)) {
    vec2 dir = vec2(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
    float reduce = max((lNW + lNE + lSW + lSE) * 0.03125, 0.0078125);
    dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + reduce), vec2(-8.0), vec2(8.0)) * uTexel;
    vec3 a = 0.5 * (texture2D(tSrc, vUv + dir * (1.0 / 3.0 - 0.5)).rgb + texture2D(tSrc, vUv + dir * (2.0 / 3.0 - 0.5)).rgb);
    vec3 b = a * 0.5 + 0.25 * (texture2D(tSrc, vUv - dir * 0.5).rgb + texture2D(tSrc, vUv + dir * 0.5).rgb);
    float lB = dot(b, lw);
    col = (lB < lMin || lB > lMax) ? a : b;
  }
  col += (hash(gl_FragCoord.xy + fract(uTime) * 311.0) - 0.5) * 0.022; // 颗粒，顺便消除色带
  gl_FragColor = vec4(col, 1.0);
}`;

const BLOOM_LEVELS = 6;

export class Pipeline {
  constructor(renderer, { msaa = 0, worldScale = 0.8 } = {}) {
    this.renderer = renderer;
    this.msaa = msaa;
    // 外景是隔着湿玻璃看的，用略低的分辨率渲染几乎看不出来，却能省下一大块填充
    this.worldScale = worldScale;
    this.width = 0;
    this.height = 0;
    this.targets = [];
    this.frame = 0;

    this.reflCam = new THREE.PerspectiveCamera();
    this.reflCam.layers.set(0);
    this.reflMatrix = new THREE.Matrix4();

    this.down = new Pass(DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: 0 } });
    this.up = new Pass(UP, { tSrc: { value: null }, tAdd: { value: null }, uAddK: { value: 0 }, uTexel: { value: new THREE.Vector2() } });
    this.blur = new Pass(BLUR, { tSrc: { value: null }, uStep: { value: new THREE.Vector2() } });
    this.final = new Pass(FINAL, {
      tColor: { value: null },
      tBloom: { value: null },
      uExposure: { value: 1 },
      uBloom: { value: 0.5 },
    });
    this.fxaa = new Pass(FXAA, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uTime: G.uTime });
  }

  _rt(w, h, opts = {}) {
    const rt = new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      ...opts,
    });
    this.targets.push(rt);
    return rt;
  }

  setSize(w, h) {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    for (const t of this.targets) t.dispose();
    this.targets = [];

    const ww = w * this.worldScale;
    const wh = h * this.worldScale;
    this.rtRefl = this._rt(ww / 2, wh / 2, { depthBuffer: true });
    this.rtReflQ = this._rt(ww / 4, wh / 4);
    this.rtReflT = this._rt(ww / 4, wh / 4);
    this.rtReflB = this._rt(ww / 4, wh / 4);
    this.rtScene = this._rt(ww, wh, { depthBuffer: true, samples: this.msaa });
    this.rtA = [2, 4, 8, 16].map((d) => this._rt(ww / d, wh / d));
    this.rtBlurA = this._rt(ww / 2, wh / 2);
    this.rtBlurB8 = this._rt(ww / 8, wh / 8);
    this.rtBlurB = this._rt(ww / 4, wh / 4);
    this.rtFinal = this._rt(w, h, { depthBuffer: true, samples: this.msaa });
    this.rtBloomD = [];
    this.rtBloomU = [];
    for (let i = 0; i < BLOOM_LEVELS; i++) {
      const d = 2 << i;
      this.rtBloomD.push(this._rt(w / d, h / d));
      if (i < BLOOM_LEVELS - 1) this.rtBloomU.push(this._rt(w / d, h / d));
    }
    this.rtLDR = this._rt(w, h, { type: THREE.UnsignedByteType });
    this.fxaa.u.tSrc.value = this.rtLDR.texture;
    this.fxaa.u.uTexel.value.set(1 / w, 1 / h);
  }

  _down(src, dst, threshold = 0) {
    this.down.u.tSrc.value = src.texture;
    this.down.u.uTexel.value.set(1 / src.width, 1 / src.height);
    this.down.u.uThreshold.value = threshold;
    this.down.render(this.renderer, dst);
  }

  _up(src, dst, add = null, k = 0) {
    this.up.u.tSrc.value = src.texture;
    this.up.u.uTexel.value.set(1 / src.width, 1 / src.height);
    this.up.u.tAdd.value = add ? add.texture : src.texture;
    this.up.u.uAddK.value = add ? k : 0;
    this.up.render(this.renderer, dst);
  }

  _blur(src, dst, sx, sy) {
    this.blur.u.tSrc.value = src.texture;
    this.blur.u.uStep.value.set(sx / src.width, sy / src.height);
    this.blur.render(this.renderer, dst);
  }

  // 把主相机关于路面 y=0 做镜像（与 three 的 Reflector 同样的做法）
  _updateReflectionCamera(camera) {
    const rc = this.reflCam;
    const pos = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
    const rot = new THREE.Matrix4().extractRotation(camera.matrixWorld);
    const look = new THREE.Vector3(0, 0, -1).applyMatrix4(rot).add(pos);
    const up = new THREE.Vector3(0, 1, 0).applyMatrix4(rot);
    rc.position.set(pos.x, -pos.y, pos.z);
    rc.up.set(up.x, -up.y, up.z);
    rc.lookAt(look.x, -look.y, look.z);
    rc.projectionMatrix.copy(camera.projectionMatrix);
    rc.projectionMatrixInverse.copy(camera.projectionMatrixInverse);
    rc.updateMatrixWorld();
    this.reflMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.reflMatrix.multiply(rc.projectionMatrix).multiply(rc.matrixWorldInverse);
  }

  // 调试用（?prof）：每个阶段后回读一个像素强制同步，粗略统计各阶段的 GPU 耗时
  _sync() {
    const gl = this.renderer.getContext();
    this.renderer.setRenderTarget(null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, (this._px ||= new Uint8Array(4)));
  }

  _mark(name) {
    if (!this.prof) return;
    this._sync();
    const now = performance.now();
    this.prof[name] = (this.prof[name] || 0) * 0.95 + (now - this._t) * 0.05;
    this._t = now;
  }

  render({ world, cabin, camera, mirrors, roadMaterial, glassMaterials, bgMaterial, exposure, bloom }) {
    const r = this.renderer;
    const ru = roadMaterial.uniforms;
    this.frame++;
    // 外景里离眼睛最近的东西（雨刮、引擎盖）也有半米多远，把近裁剪面推远可以大幅提高远处的深度精度
    camera.near = 0.4;
    camera.updateProjectionMatrix();
    if (this.prof) {
      this._sync();
      this._t = performance.now();
    }

    // ---- 1. 后视镜（开头几帧全部画一遍，之后每帧轮一面）
    ru.uReflOn.value = 0;
    const pixelAngle = G.uPixelAngle.value;
    for (let i = 0; i < mirrors.length; i++) {
      if (this.frame > 4 && this.frame % mirrors.length !== i) continue;
      const m = mirrors[i];
      G.uPixelAngle.value = m.pixelAngle;
      r.setRenderTarget(m.target);
      r.render(world, m.camera);
    }
    G.uPixelAngle.value = pixelAngle;

    this._mark('mirror');

    // ---- 2. 路面倒影
    this._updateReflectionCamera(camera);
    G.uReflPass.value = 1;
    r.setRenderTarget(this.rtRefl);
    r.render(world, this.reflCam);
    G.uReflPass.value = 0;
    this._mark('reflection');
    this._down(this.rtRefl, this.rtReflQ);
    this._blur(this.rtReflQ, this.rtReflT, 0.0, 2.4);
    this._blur(this.rtReflT, this.rtReflB, 0.0, 6.5);
    this._blur(this.rtReflB, this.rtReflT, 1.3, 0.0);
    ru.tRefl.value = this.rtRefl.texture;
    ru.tReflBlur.value = this.rtReflT.texture;
    ru.uReflMatrix.value.copy(this.reflMatrix);
    ru.uReflOn.value = 1;
    this._mark('reflBlur');

    // ---- 3. 外景
    r.setRenderTarget(this.rtScene);
    r.render(world, camera);
    this._mark('world');

    // ---- 4. 模糊金字塔
    this._down(this.rtScene, this.rtA[0]);
    this._down(this.rtA[0], this.rtA[1]);
    this._down(this.rtA[1], this.rtA[2]);
    this._down(this.rtA[2], this.rtA[3]);
    this._up(this.rtA[1], this.rtBlurA);
    this._up(this.rtA[3], this.rtBlurB8);
    this._up(this.rtBlurB8, this.rtBlurB);
    this._mark('pyramid');

    // ---- 5. 车内
    for (const m of glassMaterials) {
      m.uniforms.tScene.value = this.rtScene.texture;
      m.uniforms.tBlurA.value = this.rtBlurA.texture;
      m.uniforms.tBlurB.value = this.rtBlurB.texture;
      m.uniforms.uRes.value.set(this.width, this.height);
    }
    bgMaterial.uniforms.tScene.value = this.rtScene.texture;
    bgMaterial.uniforms.uRes.value.set(this.width, this.height);
    camera.near = 0.06; // 车内的东西离眼睛很近
    camera.updateProjectionMatrix();
    r.setRenderTarget(this.rtFinal);
    r.render(cabin, camera);
    this._mark('cabin');

    // ---- 6. 泛光
    this._down(this.rtFinal, this.rtBloomD[0], 1.1);
    for (let i = 1; i < BLOOM_LEVELS; i++) this._down(this.rtBloomD[i - 1], this.rtBloomD[i]);
    let src = this.rtBloomD[BLOOM_LEVELS - 1];
    for (let i = BLOOM_LEVELS - 2; i >= 0; i--) {
      this._up(src, this.rtBloomU[i], this.rtBloomD[i], 1.0);
      src = this.rtBloomU[i];
    }

    this.final.u.tColor.value = this.rtFinal.texture;
    this.final.u.tBloom.value = src.texture;
    this.final.u.uExposure.value = exposure;
    this.final.u.uBloom.value = bloom / BLOOM_LEVELS;
    this._mark('bloom');
    this.final.render(r, this.rtLDR);

    // ---- 7. 抗锯齿，上屏
    this.fxaa.render(r, null);
    this._mark('output');
  }
}
