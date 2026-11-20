import * as THREE from 'three';
import { ROAD } from '../config.js';
import { GeoBuilder, V3 } from './geo.js';
import { worldMaterial, instancedGeo } from './materials.js';

const TAU = Math.PI * 2;
const GROUND_Y = -0.06;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let n = Math.imul(state ^ (state >>> 15), state | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

const GROUND = /* glsl */ `
  float desertHeight(float u, float az) {
    float relief = sin(u * 0.012 + az * 0.006) * 0.48
                 + sin(u * 0.029 - az * 0.011) * 0.22;
    return -0.06 + smoothstep(28.0, 170.0, abs(u)) * relief;
  }
`;

const NOISE = /* glsl */ `
  float desertNoise(vec2 p) {
    vec2 q = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(q), hash21(q + vec2(1.0, 0.0)), f.x),
               mix(hash21(q + vec2(0.0, 1.0)), hash21(q + vec2(1.0)), f.x), f.y);
  }
`;

function tube(b, points, radii, segments = 7) {
  for (let i = 1; i < points.length; i++) {
    b.cyl(points[i - 1], points[i], radii[i - 1], radii[i], segments, i === 1, i === points.length - 1);
  }
}

function ellipsoid(b, center, size, segments = 8, rows = 5) {
  const rings = [];
  for (let i = 0; i <= rows; i++) {
    const angle = -Math.PI / 2 + (Math.PI * i) / rows;
    const r = Math.max(0.001, Math.cos(angle));
    rings.push(Array.from({ length: segments }, (_, j) => {
      const a = (j / segments) * TAU;
      return V3(center.x + Math.cos(a) * r * size.x, center.y + Math.sin(angle) * size.y,
        center.z + Math.sin(a) * r * size.z);
    }));
  }
  b.grid(rings, { closed: true });
}

function cactusStem(b, points, radii, segments = 28) {
  const rings = points.map((p, i) => {
    const tangent = points[Math.min(i + 1, points.length - 1)].clone()
      .sub(points[Math.max(0, i - 1)]).normalize();
    const right = V3(tangent.y, -tangent.x, 0).normalize();
    const forward = V3().crossVectors(right, tangent).normalize();
    return Array.from({ length: segments }, (_, j) => {
      const angle = (j / segments) * TAU;
      const radius = radii[i] * (1.0 + 0.075 * Math.cos(angle * (segments / 4)));
      return p.clone().addScaledVector(right, Math.cos(angle) * radius)
        .addScaledVector(forward, Math.sin(angle) * radius);
    });
  });
  b.grid(rings, {
    closed: true,
    quadFn: (i, j) => {
      const rib = j % 4 === 1 || j % 4 === 2 ? 0.77 : 1;
      const age = 0.8 + Math.min(1, i / 3) * 0.2;
      return { c: [0.205 * rib * age, 0.292 * rib * age, 0.125 * rib * age] };
    },
  });
  b.fan(rings[rings.length - 1], true);
}

function cactusGeometry() {
  const b = new GeoBuilder();
  for (let variant = 0; variant < 3; variant++) {
    b.data(variant);
    const h = [5.6, 4.25, 6.4][variant];
    const radius = [0.33, 0.29, 0.37][variant];
    const levels = [0, 0.16, 0.4, 0.64, 0.85, 0.94, 0.978, 0.994, 1];
    cactusStem(b, levels.map((t) => V3(0.12 * t * t, h * t, 0.055 * Math.sin(t * 3))),
      levels.map((t) => radius * (t < 0.94 ? 1 - t * 0.13 : Math.sqrt(Math.max(0.0008, 1 - ((t - 0.94) / 0.06) ** 2)) * 0.878)));
    const arms = variant === 1 ? 1 : variant === 0 ? 2 : 3;
    for (let arm = 0; arm < arms; arm++) {
      const side = arm % 2 === 0 ? -1 : 1;
      const y = h * (0.4 + arm * 0.105);
      const reach = arm === 2 ? 0.77 : 1.05 + variant * 0.12;
      const z = arm === 2 ? 0.52 : -0.02;
      const top = y + h * (arm === 1 ? 0.29 : 0.38);
      const curve = new THREE.CatmullRomCurve3([
        V3(side * 0.12, y, 0), V3(side * reach * 0.64, y + 0.02, z * 0.7),
        V3(side * reach, y + 0.37, z), V3(side * reach, top - 0.22, z),
      ]);
      const points = curve.getPoints(8);
      const r = radius * (arm === 2 ? 0.58 : 0.7);
      const radii = points.map((_, i) => r * (1 - i * 0.018));
      points.push(V3(side * reach, top - 0.1, z), V3(side * reach, top - 0.03, z), V3(side * reach, top, z));
      radii.push(r * 0.65, r * 0.36, 0.008);
      cactusStem(b, points, radii, 20);
    }
  }
  return b.build();
}

function rockGeometry() {
  const b = new GeoBuilder();
  const rng = random(1284);
  for (let kind = 0; kind < 4; kind++) {
    b.data(kind);
    const segments = 7 + kind;
    const profile = Array.from({ length: segments }, () => 0.72 + rng() * 0.5);
    const rings = [0, 0.3, 0.73, 1].map((level, row) => profile.map((r, j) => {
      const a = (j / segments) * TAU;
      const width = [1, 1.04, 0.8, 0.37][row];
      return V3(Math.cos(a) * r * width * (0.8 + kind * 0.14),
        level * (0.52 + kind * 0.17) + (row === 0 ? -0.045 : (rng() - 0.5) * 0.15),
        Math.sin(a) * r * width);
    }));
    for (let i = 0; i < rings.length - 1; i++) {
      for (let j = 0; j < segments; j++) {
        const shade = 0.85 + rng() * 0.24;
        b.color(0.48 * shade, (0.315 + kind * 0.012) * shade, 0.205 * shade);
        const next = (j + 1) % segments;
        b.quad(rings[i][j], rings[i + 1][j], rings[i + 1][next], rings[i][next]);
      }
    }
    b.fan(rings[rings.length - 1], true);
  }
  return b.build();
}

function shrubGeometry() {
  const b = new GeoBuilder();
  const rng = random(5301);
  for (let kind = 0; kind < 3; kind++) {
    b.data(kind);
    for (let stem = 0; stem < 9; stem++) {
      const a = rng() * TAU;
      const reach = 0.35 + rng() * 0.55;
      const tip = V3(Math.cos(a) * reach, 0.25 + rng() * (kind === 2 ? 0.65 : 0.4), Math.sin(a) * reach);
      const joint = tip.clone().multiplyScalar(0.52);
      joint.y += 0.14;
      b.color(0.32, 0.24, 0.135);
      tube(b, [V3(0, 0, 0), joint, tip], [0.025, 0.015, 0.007], 4);
      for (let branch = 0; branch < 3; branch++) {
        const end = tip.clone().add(V3((rng() - 0.5) * 0.42, rng() * 0.22, (rng() - 0.5) * 0.42));
        b.color(0.37, 0.29, 0.17).cyl(joint, end, 0.012, 0.003, 4);
        for (let leaf = 0; leaf < 3; leaf++) {
          const p = end.clone().lerp(joint, leaf * 0.18);
          const angle = rng() * TAU;
          const right = V3(Math.cos(angle) * 0.12, 0.035, Math.sin(angle) * 0.12);
          const up = V3(-Math.sin(angle) * 0.045, 0.1, Math.cos(angle) * 0.045);
          if (kind === 2) b.color(0.43, 0.355, 0.21);
          else b.color(0.29 + rng() * 0.045, 0.32 + rng() * 0.035, 0.205);
          b.quad(p.clone().sub(right), p.clone().add(up), p.clone().add(right), p.clone().addScaledVector(up, -0.35));
        }
      }
    }
  }
  return b.build();
}

function skeletonGeometry() {
  const b = new GeoBuilder();
  b.color(0.79, 0.73, 0.575);
  const spine = Array.from({ length: 11 }, (_, i) => V3(0.04 * Math.sin(i * 0.7), 0.54, -0.8 + i * 0.16));
  tube(b, spine, spine.map(() => 0.052), 6);
  b.cyl(spine[0], V3(0, 0.27, -1.02), 0.06, 0.055, 6);
  for (let i = 0; i < spine.length; i++) {
    ellipsoid(b, spine[i], V3(0.09, 0.07, 0.07), 6, 3);
    if (i > 7) continue;
    for (const side of [-1, 1]) {
      const width = 0.38 + Math.sin((i / 9) * Math.PI) * 0.17;
      const points = Array.from({ length: 8 }, (_, j) => {
        const a = (j / 7) * Math.PI * 0.9;
        return V3(side * Math.sin(a) * width, 0.1 + (Math.cos(a) + 1) * 0.22, spine[i].z + Math.sin(a) * 0.075);
      });
      tube(b, points, points.map((_, j) => 0.031 - j * 0.0018), 5);
    }
  }
  ellipsoid(b, V3(0, 0.22, -1.12), V3(0.22, 0.16, 0.29), 9, 5);
  ellipsoid(b, V3(0, 0.14, -1.43), V3(0.125, 0.1, 0.23), 7, 4);
  for (const side of [-1, 1]) {
    b.color(0.68, 0.62, 0.47);
    tube(b, [V3(side * 0.16, 0.29, -1.01), V3(side * 0.39, 0.32, -0.95),
      V3(side * 0.63, 0.4, -1.03), V3(side * 0.73, 0.57, -1.12), V3(side * 0.71, 0.67, -1.18)],
    [0.075, 0.067, 0.046, 0.025, 0.005], 7);
    b.color(0.13, 0.105, 0.075);
    ellipsoid(b, V3(side * 0.195, 0.25, -1.19), V3(0.027, 0.048, 0.063), 6, 4);
    b.color(0.79, 0.73, 0.575);
    tube(b, [V3(side * 0.05, 0.5, 0.68), V3(side * 0.28, 0.29, 0.77),
      V3(side * 0.34, 0.16, 0.99), V3(side * 0.12, 0.12, 1.06)], [0.07, 0.065, 0.046, 0.035], 6);
    const hip = V3(side * 0.59, 0.1, 0.63);
    const knee = V3(side * 0.95, 0.09, 0.12);
    const hoof = V3(side * 1.22, 0.065, 0.56);
    tube(b, [hip, knee, hoof], [0.045, 0.035, 0.025], 6);
    ellipsoid(b, knee, V3(0.065, 0.05, 0.065), 6, 3);
    b.cyl(V3(side * 0.68, 0.055, -0.68), V3(side * 1.13, 0.055, -0.19), 0.031, 0.021, 5, true, true);
  }
  return b.build();
}

function tumbleweedGeometry() {
  const b = new GeoBuilder();
  const rng = random(7402);
  for (let branch = 0; branch < 30; branch++) {
    const angle = rng() * TAU;
    const axis = V3(Math.cos(angle), rng() - 0.5, Math.sin(angle)).normalize();
    const right = V3().crossVectors(axis, V3(0, 1, 0)).normalize();
    const up = V3().crossVectors(right, axis).normalize();
    const radius = 0.35 + rng() * 0.33;
    const phase = rng() * TAU;
    const points = Array.from({ length: 10 }, (_, j) => {
      const a = phase + (j / 9) * (3.4 + rng() * 0.55);
      return right.clone().multiplyScalar(Math.cos(a) * radius)
        .addScaledVector(up, Math.sin(a) * radius)
        .addScaledVector(axis, (rng() - 0.5) * 0.18);
    });
    const tint = 0.78 + rng() * 0.3;
    b.color(0.45 * tint, 0.32 * tint, 0.165 * tint);
    tube(b, points, points.map((_, i) => 0.012 - i * 0.0007), 3);
    for (const j of [3, 6, 8]) {
      const end = points[j].clone().multiplyScalar(1.13).addScaledVector(axis, 0.12);
      b.cyl(points[j], end, 0.007, 0.002, 3);
    }
  }
  return b.build();
}

function birdGeometry() {
  const b = new GeoBuilder();
  b.color(0.052, 0.044, 0.04);
  ellipsoid(b, V3(0, 0, 0), V3(0.105, 0.1, 0.37), 7, 4);
  ellipsoid(b, V3(0, 0.04, -0.34), V3(0.085, 0.08, 0.12), 6, 3);
  b.cyl(V3(0, 0.025, -0.41), V3(0, 0.01, -0.56), 0.048, 0.004, 5, true, true);
  for (const side of [-1, 1]) {
    b.quad(V3(side * 0.06, 0, -0.18), V3(side * 0.75, 0.02, -0.13),
      V3(side * 1.35, -0.015, 0.14), V3(side * 0.43, 0, 0.24));
    b.quad(V3(side * 0.06, 0, -0.18), V3(side * 0.43, 0, 0.24),
      V3(side * 0.14, -0.03, 0.34), V3(0, -0.03, 0.14));
    for (let feather = 0; feather < 4; feather++) {
      const x = side * (0.94 + feather * 0.105);
      b.quad(V3(x, 0, 0.04 + feather * 0.025), V3(x + side * 0.09, 0, 0.075 + feather * 0.025),
        V3(x + side * 0.15, -0.02, 0.24 + feather * 0.023), V3(x + side * 0.11, -0.02, 0.22 + feather * 0.023));
    }
  }
  b.quad(V3(-0.065, 0, 0.2), V3(0.065, 0, 0.2), V3(0.23, -0.015, 0.63), V3(-0.23, -0.015, 0.63));
  return b.build();
}

function mesa(b, rng, center, width, depth, height, tint) {
  const segments = 18;
  const profile = Array.from({ length: segments }, (_, j) => {
    const angle = (j / segments) * TAU + (rng() - 0.5) * 0.13;
    return { angle, radius: 0.77 + rng() * 0.34, cut: rng() };
  });
  const levels = [0, 0.08, 0.21, 0.28, 0.31, 0.46, 0.49, 0.68, 0.71, 0.86, 0.89, 0.965, 1];
  const radii = [1.34, 1.24, 1.06, 0.98, 0.81, 0.79, 0.86, 0.78, 0.64, 0.62, 0.67, 0.57, 0.565];
  const rings = levels.map((level, i) => profile.map(({ angle, radius, cut }) => {
    const erosion = 1 - (i > 2 ? cut * 0.13 : 0) + Math.sin(angle * 5 + i * 0.3) * 0.018;
    return V3(center.x + Math.cos(angle) * radius * radii[i] * width * erosion,
      center.y + level * height + (i === 0 ? -2.8 : (cut - 0.5) * Math.min(2.0, height * 0.025)),
      center.z + Math.sin(angle) * radius * radii[i] * depth * erosion);
  }));
  for (let i = 0; i < rings.length - 1; i++) {
    for (let j = 0; j < segments; j++) {
      const sediment = [0.8, 0.92, 1.08, 0.76, 0.97, 1.2, 0.88, 0.71, 1.09, 1.22, 0.88, 1.12][i];
      const shade = sediment * (0.94 + rng() * 0.1);
      b.color(tint[0] * shade, tint[1] * shade, tint[2] * shade);
      const next = (j + 1) % segments;
      b.quad(rings[i][j], rings[i + 1][j], rings[i + 1][next], rings[i][next]);
    }
  }
  b.color(tint[0] * 1.16, tint[1] * 1.19, tint[2] * 1.16).fan(rings[rings.length - 1], true);
}

function canyonGeometry(layer) {
  const b = new GeoBuilder();
  const rng = random(8312 + layer * 127);
  const tint = [[0.57, 0.295, 0.165], [0.46, 0.282, 0.212], [0.365, 0.255, 0.235]][layer];
  const size = [90, 180, 310][layer];
  for (let kind = 0; kind < 2; kind++) {
    b.data(kind);
    mesa(b, rng, V3(0, 0, 0), size * (kind === 0 ? 1.05 : 0.68), size * 0.77,
      [112, 178, 142][layer] * (kind === 0 ? 1 : 1.19), tint);
    for (let spur = 0; spur < (layer === 2 ? 3 : 2); spur++) {
      const angle = rng() * TAU;
      const offset = size * (0.52 + rng() * 0.36);
      mesa(b, rng, V3(Math.cos(angle) * offset, -0.25, Math.sin(angle) * offset),
        size * (0.23 + rng() * 0.23), size * (0.25 + rng() * 0.2),
        [72, 100, 90][layer] * (0.65 + rng() * 0.55), tint);
    }
  }
  return b.build();
}

function terrainGeometry() {
  const b = new GeoBuilder();
  const half = [0, ROAD.HALF_W, 18, 28, 42, 70, 110, 170, 260, 400, 600, 900, 1400, 2200, 3600, 6400];
  const columns = [...half.slice(1).reverse().map((u) => -u), ...half];
  b.color(0.63, 0.435, 0.255);
  for (let z = 0; z > -12000; z -= 40) {
    for (let i = 0; i < columns.length - 1; i++) {
      b.quad(V3(columns[i], GROUND_Y, z), V3(columns[i + 1], GROUND_Y, z),
        V3(columns[i + 1], GROUND_Y, z - 40), V3(columns[i], GROUND_Y, z - 40));
    }
  }
  return b.build();
}

export function createDesert(placer) {
  const group = new THREE.Group();
  group.name = 'desert';
  const clock = { value: 0 };
  const viewerZ = { value: 0 };
  const add = (name, geometry, material) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  const sand = placer.add(worldMaterial({
    vertPars: GROUND,
    place: /* glsl */ `
      float wz = position.z + uBaseZ;
      float az = wz + uOriginZ;
      float h = desertHeight(position.x, az);
      float du = (desertHeight(position.x + 0.5, az) - desertHeight(position.x - 0.5, az));
      float dz = (desertHeight(position.x, az + 0.5) - desertHeight(position.x, az - 0.5));
      wp = vec3(roadX(wz) + position.x, h, wz);
      wn = normalize(vec3(-du, 1.0, du * roadDX(wz) - dz));
    `,
    fragPars: NOISE,
    surface: /* glsl */ `
      vec2 p = vec2(vWp.x, vWp.z + uOriginZ);
      float u = abs(vWp.x - roadX(vWp.z));
      float broad = desertNoise(p * 0.012);
      float wash = desertNoise(p * vec2(0.058, 0.031));
      albedo = mix(vec3(0.49, 0.315, 0.172), vec3(0.72, 0.52, 0.31), broad * 0.64 + wash * 0.36);
      float gravel = (1.0 - smoothstep(18.0, 27.0, u)) * smoothstep(14.5, 16.0, u);
      albedo = mix(albedo, vec3(0.59, 0.425, 0.27), gravel * 0.6);
      float footprint = max(length(fwidth(p)), 0.0001);
      float grain = hash21(floor(p * 24.0)) - 0.5;
      albedo *= 1.0 + grain * 0.2 * (1.0 - smoothstep(0.02, 0.16, footprint));
      float wave = dot(p, vec2(4.5, 1.9)) + wash * 14.0;
      float ripple = sin(wave) * exp(-length(fwidth(p * vec2(4.5, 1.9))));
      albedo *= 1.0 + ripple * 0.035;
      gloss = 0.015;
      shin = 8.0;
    `,
  }), 40, 150);
  add('desert-sand', terrainGeometry(), sand);

  function scatter(name, geometry, options) {
    const {
      spacing, seed, minU, maxU, scale = [0.7, 1.3], density = 0.85,
      ahead = 2600, behind = 480, motion = '', elevation = 'desertHeight(u, iz + uOriginZ)',
      surface = 'gloss = 0.015; shin = 10.0;', fragPars = '',
    } = options;
    const back = Math.ceil(behind / spacing);
    const count = Math.ceil(ahead / spacing) + back + 2;
    const material = placer.add(worldMaterial({
      uniforms: {
        uDesertTime: clock, uDesertViewerZ: viewerZ,
        uDesertSeed: { value: seed }, uDesertMinU: { value: minU }, uDesertMaxU: { value: maxU },
        uDesertScale: { value: new THREE.Vector2(...scale) }, uDesertDensity: { value: density },
      },
      vertPars: /* glsl */ `
        ${GROUND}
        uniform float uDesertTime;
        uniform float uDesertViewerZ;
        uniform float uDesertSeed;
        uniform float uDesertMinU;
        uniform float uDesertMaxU;
        uniform vec2 uDesertScale;
        uniform float uDesertDensity;
      `,
      place: /* glsl */ `
        float iz = uBaseZ - float(gl_InstanceID) * uSpacing;
        // Hash the absolute cell, never the recycled instance index.
        float cell = floor((iz + uOriginZ) / uSpacing + 0.5);
        vec2 key = vec2(cell, uDesertSeed + aData * 19.37);
        float h0 = hash21(key);
        float h1 = hash21(key + vec2(17.13, 4.91));
        float h2 = hash21(key + vec2(41.7, 31.1));
        float h3 = hash21(key + vec2(5.2, 61.4));
        float phase = hash21(key + vec2(83.7, 12.3)) * 6.2831853;
        float side = h2 < 0.5 ? -1.0 : 1.0;
        iz += (h0 - 0.5) * uSpacing * 0.94;
        float u = side * mix(uDesertMinU, uDesertMaxU, h1 * h1);
        float scale = mix(uDesertScale.x, uDesertScale.y, h3);
        float patchDensity = 0.58 + 0.42 * hash21(vec2(floor(cell / 4.0), uDesertSeed));
        float alive = step(hash21(key + vec2(22.3, 71.8)), uDesertDensity * patchDensity);
        float endFade = smoothstep(-${(ahead + spacing * 0.5).toFixed(1)}, -${(ahead - spacing).toFixed(1)}, iz - uDesertViewerZ)
                      * (1.0 - smoothstep(${Math.max(0, back * spacing - spacing).toFixed(1)}, ${(back * spacing).toFixed(1)}, iz - uDesertViewerZ));
        vec3 size = vec3(scale, scale * (0.88 + h0 * 0.24), scale);
        vec3 p = position * size;
        vec3 n = normal / size;
        float yaw = phase;
        ${motion}
        float cs = cos(yaw);
        float sn = sin(yaw);
        p.xz = mat2(cs, -sn, sn, cs) * p.xz;
        n.xz = mat2(cs, -sn, sn, cs) * n.xz;
        p *= alive * endFade;
        float z = iz + p.z;
        wp = vec3(roadX(z) + u + p.x, ${elevation} + p.y, z);
        wn = normalize(vec3(n.x, n.y, n.z - roadDX(z) * n.x));
        vCol *= 0.88 + h2 * 0.22;
      `,
      surface,
      fragPars,
    }), spacing, back);
    add(name, instancedGeo(geometry, count), material);
  }

  scatter('desert-saguaro', cactusGeometry(), {
    spacing: 80, seed: 23, minU: 23, maxU: 195, scale: [0.62, 1.45], density: 0.82,
  });
  scatter('desert-rocks', rockGeometry(), {
    spacing: 60, seed: 147, minU: 21, maxU: 245, scale: [0.35, 1.8], density: 0.88,
    surface: 'albedo *= 0.94 + 0.06 * sin(vWp.y * 15.0); gloss = 0.01;',
  });
  scatter('desert-sagebrush', shrubGeometry(), {
    spacing: 40, seed: 319, minU: 19, maxU: 145, scale: [0.55, 1.35], density: 0.92, ahead: 2000,
  });
  scatter('desert-bones', skeletonGeometry(), {
    spacing: 600, seed: 813, minU: 20.5, maxU: 25, scale: [0.8, 1.15], density: 0.76,
  });
  scatter('desert-tumbleweed', tumbleweedGeometry(), {
    spacing: 200, seed: 421, minU: 22, maxU: 36, scale: [0.72, 1.24], density: 0.9, ahead: 2000,
    motion: /* glsl */ `
      float drift = sin(uDesertTime * 0.023 + phase) * 18.0;
      iz += drift;
      u += side * sin(uDesertTime * 0.051 + phase) * 1.5;
      float roll = -drift / (0.73 * scale);
      mat2 spin = mat2(cos(roll), -sin(roll), sin(roll), cos(roll));
      p.yz = spin * p.yz;
      n.yz = spin * n.yz;
      p.y += scale * 0.76 + abs(sin(roll * 3.0)) * 0.025;
      yaw = 0.0;
    `,
  });
  scatter('desert-birds', birdGeometry(), {
    spacing: 400, seed: 607, minU: 4, maxU: 100, scale: [0.8, 1.2], density: 0.82, ahead: 3600, behind: 800,
    elevation: '22.0 + h1 * 40.0 + sin(uDesertTime * 0.32 + phase) * 0.9',
    motion: /* glsl */ `
      float flight = uDesertTime * (0.08 + h3 * 0.025) + phase;
      iz += sin(flight * 0.7) * 80.0;
      u += sin(flight) * 34.0;
      yaw = cos(flight) * 0.7;
      float flapping = smoothstep(0.55, 0.93, sin(uDesertTime * 0.23 + phase));
      float flap = (0.1 + sin(uDesertTime * 3.8 + phase) * 0.3 * flapping)
                 * sign(p.x) * smoothstep(0.12, 0.52, abs(position.x));
      mat2 wings = mat2(cos(flap), sin(flap), -sin(flap), cos(flap));
      p.xy = wings * p.xy;
      n.xy = wings * n.xy;
    `,
  });

  const strata = /* glsl */ `
    vec2 ground = vec2(vWp.x, vWp.z + uOriginZ);
    float erosion = desertNoise(ground * 0.028);
    float band = sin(vWp.y * 0.48 + erosion * 1.3);
    float aa = max(fwidth(vWp.y * 0.48), 0.001);
    albedo *= 0.9 + 0.13 * smoothstep(-0.25 - aa, 0.25 + aa, band);
    albedo *= 0.87 + 0.19 * desertNoise(ground * 0.13);
    gloss = 0.008;
    shin = 8.0;
  `;
  for (let layer = 0; layer < 3; layer++) {
    scatter(['desert-canyon', 'desert-distant-mesas', 'desert-horizon-ridges'][layer], canyonGeometry(layer), {
      spacing: [400, 800, 1200][layer], seed: 1001 + layer * 211,
      minU: [290, 790, 1650][layer], maxU: [630, 1430, 2650][layer],
      scale: [0.72, 1.22], density: [0.64, 0.78, 0.76][layer],
      ahead: 6000, behind: 4800, surface: strata, fragPars: NOISE,
    });
  }

  return {
    group,
    update(dt, player, time) {
      clock.value = time;
      viewerZ.value = player.z;
    },
  };
}
