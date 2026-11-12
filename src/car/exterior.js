import * as THREE from 'three';
import { worldMaterial, PLACE_MODEL } from '../world/materials.js';

// 自车从驾驶位能看到的外部：引擎盖、翼子板、车门外侧、外后视镜的壳体。
// 它们属于外景通道（会被玻璃上的水珠折射，也受路灯的解析光照），放在图层 2：只有主相机能看见。
// 只留下从车窗里看得见的那部分三角形：车头、车尾的上表面，和车身两侧窗线附近的一条。

// 材质名 → [颜色（线性空间）, 是否车漆]
const PARTS = {
  '23___Default': [[0.74, 0.74, 0.74], 1], // 白色车漆
  '17___Default': [[0.42, 0.42, 0.42], 1], // 车尾的浅灰部分
  '24___Default': [[0.018, 0.018, 0.018], 0], // 黑色饰条、格栅、窗框
};

// 三角形的重心是否落在「从车窗里看得见」的区域
const visible = (x, y, z) => y > 0.72 && (z < -0.85 || z > 1.7 || Math.abs(x) > 0.74);

function visibleSubset(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position.array;
  const nor = g.attributes.normal.array;
  const outPos = [];
  const outNor = [];
  for (let i = 0; i < pos.length; i += 9) {
    const x = (pos[i] + pos[i + 3] + pos[i + 6]) / 3;
    const y = (pos[i + 1] + pos[i + 4] + pos[i + 7]) / 3;
    const z = (pos[i + 2] + pos[i + 5] + pos[i + 8]) / 3;
    if (!visible(x, y, z)) continue;
    for (let k = 0; k < 9; k++) {
      outPos.push(pos[i + k]);
      outNor.push(nor[i + k]);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(outPos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(outNor, 3));
  return out;
}

export function createExterior(model) {
  const group = new THREE.Group();
  for (const part of model.body) {
    const spec = PARTS[part.name];
    if (!spec) continue;
    const geometry = visibleSubset(part.geometry);
    if (!geometry.attributes.position.count) continue;
    const mat = worldMaterial({
      place: `${PLACE_MODEL} vLp = position;`,
      vertPars: 'varying vec3 vLp;',
      fragPars: 'varying vec3 vLp; uniform vec3 uColor; uniform float uPaint;',
      uniforms: { uColor: { value: new THREE.Color(...spec[0]) }, uPaint: { value: spec[1] } },
      surface: /* glsl */ `
        albedo = uColor;
        if (uPaint > 0.5) {
          // 车漆上密密的小水珠：用噪声扰动法线，路灯扫过时会闪
          vec2 bn = texture2D(tNoise, vLp.xz * 5.0).rg - 0.5;
          vec2 bn2 = texture2D(tNoise, vLp.xz * 1.3 + 0.4).rg - 0.5;
          N = normalize(N + vec3(bn.x + bn2.x * 0.5, 0.0, bn.y + bn2.y * 0.5) * 0.22 * uRain);
          gloss = 1.0;
          shin = 420.0;
        } else {
          gloss = 0.15;
        }
      `,
    });
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.frustumCulled = false;
    mesh.layers.set(2);
    group.add(mesh);
  }
  return group;
}
