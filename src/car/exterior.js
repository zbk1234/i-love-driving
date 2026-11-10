import * as THREE from 'three';
import { GLASS } from '../config.js';
import { GeoBuilder, V3 } from '../world/geo.js';
import { worldMaterial } from '../world/materials.js';

// 自车从驾驶位能看到的外部：引擎盖、雨刮下方的黑色盖板、车门肩线（外后视镜在 mirrors.js）。
// 它们属于外景通道（会被玻璃上的水珠折射），放在图层 2：只有主相机能看见。

const lerp = (a, b, t) => a + (b - a) * t;

export function createExterior() {
  const group = new THREE.Group();
  const paint = [0.035, 0.04, 0.05];

  const mat = worldMaterial({
    surface: /* glsl */ `
      if (vData < 0.5) {
        // 车漆上密密的小水珠：用噪声扰动法线，路灯扫过时会闪
        vec2 bn = texture2D(tNoise, vUv * 5.0).rg - 0.5;
        vec2 bn2 = texture2D(tNoise, vUv * 1.3 + 0.4).rg - 0.5;
        N = normalize(N + vec3(bn.x + bn2.x * 0.5, 0.0, bn.y + bn2.y * 0.5) * 0.22 * uRain);
        gloss = 1.0;
        shin = 420.0;
      } else if (vData < 1.5) {
        gloss = 0.95;
        shin = 300.0;
      } else {
        gloss = 0.15;
      }
    `,
  });

  const b = new GeoBuilder();
  const zRear = (x) => GLASS.Z0 + GLASS.SWEEP * (x / GLASS.W0) ** 2 - 0.07;
  const hoodY = (x, t) => {
    const base = 0.955 - 0.02 * t - 0.19 * t * t * t;
    const crown = -0.085 * Math.pow(Math.abs(x) / 0.9, 2.4);
    const ridge = 0.012 * Math.exp(-(((Math.abs(x) - 0.62) / 0.09) ** 2));
    return base + crown + ridge;
  };

  // ---- 引擎盖
  {
    const P = [];
    for (let i = 0; i <= 28; i++) {
      const x = lerp(-0.92, 0.92, i / 28);
      const row = [];
      for (let j = 0; j <= 14; j++) {
        const t = j / 14;
        row.push(V3(x, hoodY(x, t), lerp(zRear(x), -2.34, t)));
      }
      P.push(row);
    }
    b.color(...paint).data(0);
    b.grid(P, { uvFn: (i, j) => [P[i][j].x, P[i][j].z] });
    // 车头前缘向下收
    const F = [];
    for (let i = 0; i <= 28; i++) {
      const x = lerp(-0.92, 0.92, i / 28);
      F.push([V3(x, hoodY(x, 1), -2.34), V3(x, hoodY(x, 1) - 0.3, -2.4)]);
    }
    b.grid(F, { uvFn: (i, j) => [F[i][j].x, F[i][j].z] });
  }

  // ---- 风挡下沿的黑色通风盖板
  {
    const C = [];
    for (let i = 0; i <= 20; i++) {
      const x = lerp(-0.86, 0.86, i / 20);
      const zg = GLASS.Z0 + GLASS.SWEEP * (x / GLASS.W0) ** 2;
      C.push([V3(x, hoodY(x, 0) - 0.004, zRear(x)), V3(x, 0.938, zg - 0.03), V3(x, 0.93, zg + 0.02)]);
    }
    b.color(0.012, 0.012, 0.013).data(2);
    b.grid(C);
  }

  // ---- 车门外侧的肩线和翼子板侧面（从侧窗往下能看到的一条车身）
  for (const s of [-1, 1]) {
    b.color(...paint).data(0);
    const S = [];
    for (let j = 0; j <= 10; j++) {
      const z = lerp(-2.3, 2.3, j / 10);
      const yTop = z < -0.9 ? hoodY(s * 0.92, (z - zRear(0.92)) / (-2.34 - zRear(0.92))) : 0.935;
      S.push([V3(s * 0.84, yTop, z), V3(s * 0.935, yTop - 0.03, z), V3(s * 0.95, 0.45, z)]);
    }
    b.grid(S, { uvFn: (i, j) => [S[i][j].y, S[i][j].z] });

  }

  const mesh = new THREE.Mesh(b.build(), mat);
  mesh.frustumCulled = false;
  mesh.layers.set(2);
  group.add(mesh);
  return group;
}
