import * as THREE from 'three';
import { shared } from '../core/globals.js';
import { COMMON, LIGHTING } from '../shaders/common.js';

// 外景「通用材质」工厂。
//   place   : 顶点阶段，负责算出世界坐标 wp 和世界法线 wn
//   surface : 片元阶段，负责设置 albedo / emissive / gloss / shin / retro / alpha
// 光照（环境光 + 解析式路灯 + 自车大灯）、雾、倒影通道裁剪在这里统一处理。

// 普通物体：走 modelMatrix
export const PLACE_MODEL = /* glsl */ `
  wp = (modelMatrix * vec4(position, 1.0)).xyz;
  wn = normalize(mat3(modelMatrix) * normal);
`;

// 沿路拉伸的长条（护栏等）：几何体定义在「道路空间」(u, y, z)，顶点着色器里跟着弯道走
export const PLACE_STRIP = /* glsl */ `
  float wz = position.z + uBaseZ;
  wp = vec3(roadX(wz) + position.x, position.y, wz);
  wn = normal;
`;

// 沿路按固定间距重复的实例：第 i 个实例在 z = uBaseZ - i * uSpacing，并跟随道路朝向
export const PLACE_INSTANCED = /* glsl */ `
  float iz = uBaseZ - float(gl_InstanceID) * uSpacing;
  float sl = roadDX(iz);
  float cs = inversesqrt(1.0 + sl * sl);
  float sn = sl * cs;
  vec3 rp = vec3(position.x * cs + position.z * sn, position.y, -position.x * sn + position.z * cs);
  wp = vec3(roadX(iz) + uInstU, 0.0, iz) + rp;
  wn = vec3(normal.x * cs + normal.z * sn, normal.y, -normal.x * sn + normal.z * cs);
`;

export function worldMaterial({
  place = PLACE_MODEL,
  surface = '',
  vertPars = '',
  fragPars = '',
  uniforms = {},
  ...rest
}) {
  return new THREE.ShaderMaterial({
    uniforms: { ...shared(), uBaseZ: { value: 0 }, uSpacing: { value: 1 }, uInstU: { value: 0 }, ...uniforms },
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform float uBaseZ;
      uniform float uSpacing;
      uniform float uInstU;
      attribute vec3 aColor;
      attribute float aEmis;
      attribute float aData;
      varying vec3 vWp;
      varying vec3 vWn;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vEmis;
      varying float vData;
      ${vertPars}
      void main() {
        vec3 wp;
        vec3 wn;
        vUv = uv;
        vCol = aColor;
        vEmis = aEmis;
        vData = aData;
        ${place}
        vWp = wp;
        vWn = wn;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${LIGHTING}
      varying vec3 vWp;
      varying vec3 vWn;
      varying vec2 vUv;
      varying vec3 vCol;
      varying float vEmis;
      varying float vData;
      ${fragPars}
      void main() {
        // 倒影通道：水平面以下的东西不能出现在倒影里
        if (uReflPass > 0.5 && vWp.y < -0.02) discard;
        vec3 V = normalize(cameraPosition - vWp);
        vec3 N = normalize(vWn);
        float facing = dot(N, V); // <0 表示看到的是背面
        if (facing < 0.0) N = -N;
        vec3 albedo = vCol;
        vec3 emissive = vec3(0.0);
        float gloss = 0.1;
        float shin = 40.0;
        float retro = 0.0;
        float alpha = 1.0;
        ${surface}
        vec3 col = shadeSurface(albedo, N, V, vWp, gloss, shin, retro) + emissive;
        col = applyFog(col, vWp);
        gl_FragColor = vec4(col, alpha);
      }
    `,
    side: THREE.DoubleSide,
    ...rest,
  });
}

// 把普通几何体变成 n 个实例（实例位置完全由顶点着色器决定）
export function instancedGeo(base, count) {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  for (const k of Object.keys(base.attributes)) g.setAttribute(k, base.attributes[k]);
  g.instanceCount = count;
  return g;
}

// 记录哪些 uniform 需要跟着车走：uBaseZ = (floor((carZ - offset) / spacing) + behind) * spacing + offset
export class Placer {
  constructor() {
    this.items = [];
  }
  add(material, spacing, behind, offset = 0) {
    material.uniforms.uSpacing.value = spacing;
    this.items.push({ u: material.uniforms.uBaseZ, spacing, behind, offset });
    return material;
  }
  update(carZ) {
    for (const it of this.items) {
      it.u.value = (Math.floor((carZ - it.offset) / it.spacing) + it.behind) * it.spacing + it.offset;
    }
  }
}
