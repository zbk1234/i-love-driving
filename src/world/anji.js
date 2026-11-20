import * as THREE from 'three';
import { GeoBuilder, V3 } from './geo.js';
import { worldMaterial, instancedGeo, PLACE_STRIP, PLACE_INSTANCED } from './materials.js';

const TAU = Math.PI * 2;
const TERRAIN_LENGTH = 4320;
const NOISE = `
  float anjiNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
               mix(hash21(i + vec2(0.0, 1.0)), hash21(i + 1.0), f.x), f.y);
  }
`;
const ROCK_SHAPE = `
  // Linear triangular cells give the escarpment planar fractures, not rounded noise bumps.
  float anjiFacetNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + 1.0);
    if (f.x + f.y < 1.0) return a + (b - a) * f.x + (c - a) * f.y;
    return d + (c - d) * (1.0 - f.x) + (b - d) * (1.0 - f.y);
  }
  float anjiRockRelief(float d, float az) {
    float blocks = anjiFacetNoise(vec2(d * 0.17 + az * 0.014, az * 0.105));
    float ledge = clamp((blocks - 0.30) * 3.3, 0.0, 1.0);
    float chips = anjiFacetNoise(vec2(d * 0.41 + az * 0.021, az * 0.24));
    return ((ledge - 0.48) * 11.0 + (chips - 0.5) * 3.0)
      * smoothstep(0.0, 11.0, d) * (1.0 - smoothstep(75.0, 165.0, d));
  }
`;
const HEIGHT = `
  ${NOISE}
  ${ROCK_SHAPE}
  float anjiHeight(float u, float az) {
    if (u < 0.0) {
      // Leave posts and the -6.1 m sign on a narrow, level shoulder.
      float d = max(0.0, -u - 6.4);
      float gorge = anjiNoise(vec2(az * 0.006, 31.7));
      float hill = anjiNoise(vec2(d * 0.006 + 57.0, az * 0.004));
      float fall = (34.0 + 15.0 * gorge) * (1.0 - exp(-pow(d / 27.0, 1.45)));
      float foot = smoothstep(24.0, 210.0, d) * (58.0 + 32.0 * hill);
      float valley = smoothstep(150.0, 640.0, d) * (30.0 + 32.0 * gorge);
      return -0.08 - fall - foot - valley;
    }
    float along = anjiNoise(vec2(az * 0.0041, 19.7));
    float valley = anjiNoise(vec2(az * 0.0093, 72.3));
    float d = max(0.0, u - 6.0 - valley * 2.8);
    float rise = 1.0 - exp(-pow(d / (27.0 + valley * 25.0), 1.38));
    float width = 190.0 + along * 150.0;
    float ridge = (82.0 + along * 113.0) * rise * exp(-pow(d / width, 2.0));
    float folded = anjiNoise(vec2(d * 0.033 + az * 0.0025, az * 0.021));
    float ribs = anjiNoise(vec2(d * 0.071, az * 0.046));
    ridge += smoothstep(0.0, 28.0, d) * exp(-d * 0.007)
      * ((folded - 0.5) * 23.0 + (ribs - 0.5) * 5.0);
    ridge += anjiRockRelief(d, az);
    float distant = anjiNoise(vec2(az * 0.0023 + 21.0, d * 0.003));
    float crest = 440.0 + 190.0 * anjiNoise(vec2(az * 0.0019, 8.0));
    float range = (85.0 + distant * 75.0) * exp(-pow((d - crest) / 210.0, 2.0));
    float skyline = (95.0 + along * 80.0)
      * exp(-pow((d - 1050.0 - distant * 180.0) / 360.0, 2.0));
    return -0.08 + max(0.0, ridge) + smoothstep(100.0, 310.0, d) * range
      + smoothstep(380.0, 770.0, d) * skyline;
  }
`;
const ROCK_MATERIAL = `
  ${NOISE}
  vec2 anjiFracture(vec2 p) {
    vec2 cell = floor(p);
    vec2 f = fract(p);
    float nearest = 10.0;
    float second = 10.0;
    float tint = 0.0;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        vec2 offset = vec2(float(x), float(y));
        vec2 key = cell + offset;
        vec2 seed = vec2(hash21(key), hash21(key + 71.3));
        vec2 delta = offset + 0.15 + seed * 0.7 - f;
        float distance = dot(delta, delta);
        if (distance < nearest) {
          second = nearest;
          nearest = distance;
          tint = seed.x;
        } else {
          second = min(second, distance);
        }
      }
    }
    return vec2(sqrt(second) - sqrt(nearest), tint);
  }
  void anjiWetStone(vec3 P, vec3 V, inout vec3 N, out vec3 stone, out float gloss, out float shin) {
    float u = P.x - roadX(P.z);
    float az = P.z + uOriginZ;
    vec2 face = vec2(az + u * 0.55, P.y + u * 0.18);
    float patches = anjiNoise(face * 0.24);
    float grit = anjiNoise(face * 3.7);
    float grain = anjiNoise(face * 1.1 + grit * 0.32);
    vec2 rockUV = face * vec2(0.25, 0.30);
    rockUV += vec2(anjiNoise(face * 0.8), anjiNoise(face * 0.7 + 37.1)) * 0.21;
    vec2 fracture = anjiFracture(rockUV);
    float joint = fracture.x;
    float aa = min(0.12, length(fwidth(rockUV)));
    float crack = 1.0 - smoothstep(0.012, 0.055 + aa, joint);
    float damp = anjiNoise(vec2(az * 0.43 + u * 0.15, P.y * 0.08));
    float moss = (1.0 - smoothstep(0.045, 0.16 + aa, joint))
      * smoothstep(0.29, 0.66, damp + grit * 0.20) * (0.65 + 0.35 * max(N.y, 0.0));
    stone = mix(vec3(0.105, 0.12, 0.116), vec3(0.42, 0.435, 0.40), patches * 0.7 + fracture.y * 0.3);
    stone *= (0.55 + grain * 0.66 + grit * 0.23) * (1.0 - crack * 0.73);
    float wet = (0.48 + 0.52 * uRain) * (0.55 + damp * 0.45);
    stone *= 1.0 - wet * 0.23;
    vec3 mossColor = mix(vec3(0.038, 0.085, 0.014), vec3(0.12, 0.23, 0.048), grit);
    stone = mix(stone, mossColor, moss * 0.92);
    // Screen-space surface gradient adds chipped grain without changing the planar silhouette.
    vec3 px = dFdx(P);
    vec3 py = dFdy(P);
    vec3 rx = cross(py, N);
    vec3 ry = cross(N, px);
    float det = dot(px, rx);
    float bump = grain * 0.11 - crack * 0.07;
    vec3 grad = (rx * dFdx(bump) + ry * dFdy(bump)) * sign(det) / max(abs(det), 0.00001);
    N = normalize(N - clamp(grad, vec3(-0.3), vec3(0.3)) * (1.0 - moss * 0.7));
    if (dot(N, V) < 0.0) N = -N;
    gloss = mix(0.15 + wet * 0.29, 0.045, moss);
    shin = mix(70.0, 22.0, moss);
  }
`;
const FOLIAGE_SURFACE = `
  float part = fract(vData);
  if (part > 0.8) {
    vec4 leaves = texture2D(tAnjiLeaves, vUv);
    if (leaves.a < 0.3) discard;
    albedo *= leaves.rgb;
    gloss = 0.08;
    shin = 30.0;
  } else if (part > 0.6) {
    float midrib = 1.0 - smoothstep(0.015, 0.065 + fwidth(vUv.x), abs(vUv.x - 0.5));
    albedo *= 0.86 + 0.14 * sin(vUv.y * 3.141593);
    albedo += vec3(0.025, 0.039, 0.009) * midrib;
    gloss = 0.11 + 0.06 * uRain;
    shin = 48.0;
  } else {
    float ring = abs(fract(vAnjiHeight / vAnjiInternode) - 0.5);
    float aa = min(0.12, fwidth(vAnjiHeight / vAnjiInternode));
    float node = 1.0 - smoothstep(0.025, 0.052 + aa, ring);
    if (part < 0.1) albedo = mix(albedo, vec3(0.33, 0.40, 0.19), node * 0.72);
    gloss = part < 0.3 ? 0.19 : 0.06;
    shin = 32.0;
  }
`;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let n = Math.imul(state ^ (state >>> 15), state | 1);
    n ^= n + Math.imul(n ^ (n >>> 7), n | 61);
    return ((n ^ (n >>> 14)) >>> 0) / 4294967296;
  };
}

function blade(b, base, direction, length, halfWidth, twist, folded) {
  const axis = direction.clone().normalize();
  const side = V3().crossVectors(axis, V3(Math.sin(twist), 1, Math.cos(twist) * 0.4)).normalize();
  const normal = V3().crossVectors(side, axis).normalize();
  const tip = base.clone().addScaledVector(axis, length).addScaledVector(normal, -length * 0.10);
  const middle = base.clone().addScaledVector(axis, length * 0.39);
  const left = middle.clone().addScaledVector(side, halfWidth);
  const right = middle.clone().addScaledVector(side, -halfWidth);
  if (folded) {
    const rib = middle.clone().addScaledVector(normal, halfWidth * 0.32);
    const points = [base, left, tip, right];
    const uv = [[0.5, 0], [0, 0.39], [0.5, 1], [1, 0.39]];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const n = V3().subVectors(points[j], points[i]).cross(V3().subVectors(rib, points[i])).normalize();
      b.vert(points[i], n, ...uv[i]);
      b.vert(points[j], n, ...uv[j]);
      b.vert(rib, n, 0.5, 0.39);
    }
  } else {
    b.vert(base, normal, 0.5, 0);
    b.vert(left, normal, 0, 0.39);
    b.vert(tip, normal, 0.5, 1);
    b.vert(base, normal, 0.5, 0);
    b.vert(tip, normal, 0.5, 1);
    b.vert(right, normal, 1, 0.39);
  }
}

function leafSprayTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const rng = random(7619);
  ctx.strokeStyle = '#9caa81';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(16, 128);
  ctx.quadraticCurveTo(250, 100, 500, 142);
  ctx.stroke();
  for (let i = 0; i < 22; i++) {
    const x = 35 + i * 19;
    const y = 122 + Math.sin(i * 0.13) * 14;
    for (const side of [-1, 1]) {
      const reach = 48 + rng() * 45;
      const tipX = x + 38 + rng() * 35;
      const tipY = y + side * reach;
      const width = 6 + rng() * 5;
      const shade = Math.floor(172 + rng() * 80);
      ctx.fillStyle = `rgb(${shade},${shade},${shade})`;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 12 - width, y + side * reach * 0.66, tipX, tipY);
      ctx.quadraticCurveTo(x + 35 + width, y + side * reach * 0.34, x, y);
      ctx.fill();
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.anisotropy = 4;
  return texture;
}

function bambooGeometry(detail, plants) {
  const b = new GeoBuilder();
  const rng = random(9163 + detail * 179);
  for (let plant = 0; plant < plants; plant++) {
    const internodes = Math.ceil((12.4 + rng() * 3.6) / 0.61);
    const height = internodes * 0.61;
    const radius = 0.072 + rng() * 0.023;
    const lean = rng() * TAU;
    const segments = detail === 0 ? internodes : detail === 1 ? 5 : detail === 2 ? 4 : 2;
    const sides = detail === 0 ? 6 : detail === 1 ? 4 : 3;
    const stem = (t) => V3(Math.cos(lean) * 0.43 * t * t, height * t,
      Math.sin(lean) * 0.43 * t * t + Math.sin(t * 4.0) * 0.07);
    const girth = (t) => radius * (1 - 0.82 * Math.pow(t, 1.65));
    for (let i = 0; i < segments; i++) {
      const t = i / segments;
      const t1 = (i + 1) / segments;
      const shade = 0.87 + rng() * 0.20;
      b.data(plant).color(0.20 * shade, 0.30 * shade, 0.085 * shade);
      b.cyl(stem(t), stem(t1), girth(t), girth(t1), sides, i === 0, i === segments - 1);
      if (detail === 0) {
        const joint = (i + 0.5) / segments;
        b.data(plant + 0.22).color(0.36, 0.41, 0.20);
        b.cyl(stem(joint - 0.0012), stem(joint + 0.0012), girth(joint) * 1.16,
          girth(joint) * 1.12, sides);
      }
    }
    const branches = detail === 0 ? 10 : detail === 1 ? 9 : detail === 2 ? 8 : 7;
    for (let branch = 0; branch < branches; branch++) {
      const t = 0.38 + branch / branches * 0.58;
      const angle = lean + branch * 2.399963 + (rng() - 0.5) * 0.6;
      const reach = (1.45 + rng() * 1.15) * (1 - Math.pow((t - 0.65) / 0.48, 2) * 0.5);
      const start = stem(t);
      const out = V3(Math.cos(angle), 0, Math.sin(angle));
      const across = V3(-out.z, 0, out.x);
      const branchPoint = (s) => start.clone().addScaledVector(out, reach * s)
        .add(V3(0, 0.85 * s - 1.05 * s * s, 0));
      b.data(plant + 0.42).color(0.23, 0.29, 0.10);
      let previous = start;
      const steps = detail === 0 ? 2 : detail === 3 ? 0 : 1;
      for (let k = 1; k <= steps; k++) {
        const next = branchPoint(k / steps);
        b.cyl(previous, next, 0.019 * (1 - (k - 1) / steps) + 0.002,
          0.019 * (1 - k / steps) + 0.002, 3);
        previous = next;
      }
      const twigs = detail === 0 ? 4 : detail === 3 ? 2 : 3;
      for (let twig = 0; twig < twigs; twig++) {
        const root = branchPoint(0.40 + twig / twigs * 0.53);
        const sign = twig % 2 ? -1 : 1;
        const length = 0.52 + rng() * 0.39;
        const direction = out.clone().multiplyScalar(0.52).addScaledVector(across, sign * 0.70).normalize();
        const twigPoint = (s) => root.clone().addScaledVector(direction, length * s)
          .add(V3(0, 0.10 * s - 0.46 * s * s, 0));
        if (detail === 0) {
          b.data(plant + 0.42).color(0.25, 0.30, 0.12);
          b.cyl(root, twigPoint(0.55), 0.007, 0.004, 3);
          b.cyl(twigPoint(0.55), twigPoint(1), 0.004, 0.001, 3);
        }
        const sprayRoot = twigPoint(0.2);
        const canopy = detail >= 2 ? 1.23 : 1.0;
        const sprayTip = sprayRoot.clone().addScaledVector(direction, (1.6 + rng() * 0.6) * canopy);
        sprayTip.y -= 0.55 + rng() * 0.35;
        const spread = across.clone().multiplyScalar(0.46 * canopy).add(V3(0, (rng() - 0.5) * 0.65, 0));
        b.data(plant + 0.87).color(0.16 + rng() * 0.045, 0.31 + rng() * 0.09, 0.065);
        b.quad(sprayRoot.clone().sub(spread), sprayTip.clone().sub(spread),
          sprayTip.clone().add(spread), sprayRoot.clone().add(spread));
        const leaves = detail === 0 ? 4 : 0;
        for (let leaf = 0; leaf < leaves; leaf++) {
          const s = 0.17 + leaf / leaves * 0.82;
          const side = leaf % 2 ? -1 : 1;
          const dir = direction.clone().multiplyScalar(0.45)
            .addScaledVector(across, side * (0.60 + rng() * 0.26));
          dir.y = -0.24 - s * 0.65 + rng() * 0.18;
          const tint = 0.73 + rng() * 0.46;
          b.data(plant + 0.72).color(0.17 * tint, 0.30 * tint, 0.075 * tint);
          blade(b, twigPoint(s), dir, (0.26 + rng() * 0.20) * (detail === 2 ? 1.35 : 1),
            (0.019 + rng() * 0.009) * (detail === 2 ? 1.4 : 1), angle + leaf * 0.7, detail === 0);
        }
      }
    }
  }
  return b.build();
}

function undergrowthGeometry() {
  const b = new GeoBuilder();
  const rng = random(5041);
  for (let plant = 0; plant < 4; plant++) {
    for (let branch = 0; branch < 5; branch++) {
      const angle = branch * TAU / 5 + rng() * 0.45;
      const out = V3(Math.cos(angle), 0, Math.sin(angle));
      const across = V3(-out.z, 0, out.x);
      const reach = 0.34 + rng() * 0.22;
      const height = 1.35 + rng() * 0.60;
      const point = (t) => out.clone().multiplyScalar(reach * t * t)
        .add(V3(0, height * t - 0.18 * t * t, 0));
      b.data(plant + 0.42).color(0.20, 0.26, 0.085);
      b.cyl(point(0), point(0.55), 0.014, 0.008, 3);
      b.cyl(point(0.55), point(1), 0.008, 0.002, 3);
      for (let leaf = 1; leaf <= 4; leaf++) {
        const t = 0.25 + leaf * 0.14;
        for (const side of [-1, 1]) {
          b.data(plant + 0.72).color(0.12 + rng() * 0.055, 0.26 + rng() * 0.09, 0.058);
          const dir = across.clone().multiplyScalar(side * 0.68).addScaledVector(out, 0.48);
          dir.y = 0.32 - t * 0.30;
          blade(b, point(t), dir, 0.35 + rng() * 0.18, 0.085 + rng() * 0.035, angle, false);
        }
      }
      b.data(plant + 0.72).color(0.19, 0.32, 0.082);
      blade(b, point(0.90), out.clone().multiplyScalar(0.45).add(V3(0, 1, 0)),
        0.34, 0.078, angle, false);
    }
  }
  return b.build();
}

function terrainGeometry() {
  const b = new GeoBuilder();
  const left = [-700, -480, -320, -220, -155, -108, -76, -52, -36, -25, -18, -13,
    -10, -8.5, -7.4, -6.4, -5.8, -4.65];
  const right = [4.65, 5.25, 6, 7, 8, 9, 10, 11, 12, 13.5, 15, 16.5, 18, 20, 22, 24,
    26, 28, 30, 33, 36, 39, 42, 46, 50, 54, 58, 63, 68, 74, 81, 88, 105, 125, 150,
    180, 215, 255, 305, 365, 440, 530, 640, 775, 935, 1130, 1370, 1660, 2000];
  const up = V3(0, 1, 0);
  const subdivisions = (u) => u >= 8 && u <= 88 ? 4 : 1;
  b.color(0.25, 0.29, 0.22);
  for (const columns of [left, right]) {
    for (let z = 0; z > -TERRAIN_LENGTH; z -= 8) {
      for (let i = 0; i < columns.length - 1; i++) {
        // Only the near rockface uses 2 m z samples. Stitch its edges to the 8 m grid.
        const nl = subdivisions(columns[i]);
        const nr = subdivisions(columns[i + 1]);
        const l = (j) => V3(columns[i], 0, z - j * 8 / nl);
        const r = (j) => V3(columns[i + 1], 0, z - j * 8 / nr);
        let il = 0;
        let ir = 0;
        while (il < nl || ir < nr) {
          const nextL = (il + 1) / nl;
          const nextR = (ir + 1) / nr;
          if (nextL === nextR) {
            b.quad(l(il), r(ir), r(ir + 1), l(il + 1));
            il++;
            ir++;
          } else if (nextL < nextR) {
            b.vert(l(il), up);
            b.vert(r(ir), up);
            b.vert(l(++il), up);
          } else {
            b.vert(l(il), up);
            b.vert(r(ir), up);
            b.vert(r(++ir), up);
          }
        }
      }
    }
  }
  return b.build();
}

function boulderGeometry() {
  const b = new GeoBuilder();
  const rng = random(28031);
  const triangle = (a, c, d) => {
    const n = V3().subVectors(c, a).cross(V3().subVectors(d, a)).normalize();
    b.vert(a, n);
    b.vert(c, n);
    b.vert(d, n);
  };
  for (let rock = 0; rock < 3; rock++) {
    b.data(rock).color(0.31, 0.33, 0.30);
    const angles = Array.from({ length: 7 }, (_, i) => i * TAU / 7 + (rng() - 0.5) * 0.25);
    const rings = [-0.48, 0.37, 0.94].map((y, layer) => angles.map((angle) => {
      const radius = (layer === 2 ? 0.60 : 0.88) + rng() * 0.25;
      return V3(Math.cos(angle) * radius + layer * 0.08, y + rng() * 0.13,
        Math.sin(angle) * radius * (0.85 + rock * 0.10) - layer * 0.07);
    }));
    for (let i = 0; i < 7; i++) {
      const j = (i + 1) % 7;
      for (let layer = 0; layer < 2; layer++) {
        triangle(rings[layer][i], rings[layer + 1][i], rings[layer + 1][j]);
        triangle(rings[layer][i], rings[layer + 1][j], rings[layer][j]);
      }
      triangle(rings[2][i], V3(0.18, 1.12, -0.12), rings[2][j]);
      triangle(rings[0][i], rings[0][j], V3(0, -0.48, 0));
    }
  }
  return b.build();
}

function railGeometry() {
  const b = new GeoBuilder();
  const profile = [[0.54, 0.065], [0.59, 0.015], [0.69, 0.075], [0.79, 0.015], [0.84, 0.065]];
  for (const side of [-1, 1]) {
    for (let z = 0; z > -4000; z -= 4) {
      for (let i = 0; i < profile.length - 1; i++) {
        const [y0, x0] = profile[i];
        const [y1, x1] = profile[i + 1];
        const shade = i % 2 ? 0.76 : 0.89;
        b.color(0.43 * shade, 0.47 * shade, 0.47 * shade);
        b.quad(V3(side * (4.49 + x0), y0, z), V3(side * (4.49 + x0), y0, z - 4),
          V3(side * (4.49 + x1), y1, z - 4), V3(side * (4.49 + x1), y1, z));
      }
    }
  }
  return b.build();
}

function roadsideGeometry(reflectors) {
  const b = new GeoBuilder();
  for (const side of [-1, 1]) {
    const u = side * (reflectors ? 4.96 : 4.64);
    if (reflectors) {
      b.data(0).color(0.70, 0.73, 0.68).box(u, 0.46, 0, 0.12, 1.08, 0.10);
      b.color(0.065, 0.075, 0.067).box(u, 0.80, 0, 0.126, 0.21, 0.106);
      for (const face of [-1, 1]) {
        b.data(1).color(...(face === side ? [0.78, 0.26, 0.055] : [0.82, 0.85, 0.74]));
        b.box(u, 0.81, face * 0.056, 0.075, 0.115, 0.008);
      }
    } else {
      b.color(0.26, 0.29, 0.27).box(u, 0.34, 0, 0.08, 0.89, 0.065);
      b.color(0.39, 0.42, 0.40).box(side * 4.58, 0.68, 0, 0.10, 0.09, 0.07);
    }
  }
  return b.build();
}

function signTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 384;
  const ctx = canvas.getContext('2d');
  const font = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif';
  ctx.fillStyle = '#224d40';
  ctx.fillRect(0, 0, 512, 384);
  ctx.strokeStyle = '#dfe6d6';
  ctx.lineWidth = 8;
  ctx.strokeRect(14, 14, 484, 356);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#eef0df';
  ctx.font = `600 112px ${font}`;
  ctx.fillText('安吉', 256, 102);
  ctx.font = `500 55px ${font}`;
  ctx.fillText('竹海山路', 256, 206);
  ctx.fillStyle = '#e0d8a3';
  ctx.font = `500 48px ${font}`;
  ctx.fillText('慢行', 256, 306);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function signGeometry() {
  const b = new GeoBuilder();
  b.color(0.32, 0.35, 0.32).cyl(V3(0, -0.10, 0), V3(0, 2.35, 0), 0.055, 0.05, 7, true, true);
  b.color(0.22, 0.26, 0.23).box(0, 2.25, 0, 1.76, 1.34, 0.065);
  b.data(1).color(1, 1, 1);
  b.quad(V3(-0.86, 1.60, 0.035), V3(0.86, 1.60, 0.035), V3(0.86, 2.90, 0.035), V3(-0.86, 2.90, 0.035));
  b.quad(V3(0.86, 1.60, -0.035), V3(-0.86, 1.60, -0.035), V3(-0.86, 2.90, -0.035), V3(0.86, 2.90, -0.035));
  return b.build();
}

export function createAnji(placer) {
  const group = new THREE.Group();
  group.name = 'anji';
  const add = (name, geometry, material) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  const ground = placer.add(worldMaterial({
    vertPars: HEIGHT,
    place: `
      float wz = position.z + uBaseZ;
      float az = wz + uOriginZ;
      float h = anjiHeight(position.x, az);
      float du = (anjiHeight(position.x + 0.4, az) - anjiHeight(position.x - 0.4, az)) / 0.8;
      float dz = (anjiHeight(position.x, az + 0.4) - anjiHeight(position.x, az - 0.4)) / 0.8;
      wp = vec3(roadX(wz) + position.x, h, wz);
      wn = normalize(vec3(-du, 1.0, du * roadDX(wz) - dz));
    `,
    fragPars: ROCK_MATERIAL,
    surface: `
      float u = vWp.x - roadX(vWp.z);
      float az = vWp.z + uOriginZ;
      vec2 p = vec2(u, az);
      float patches = anjiNoise(p * vec2(0.09, 0.055));
      float fine = anjiNoise(p * 0.83 + vWp.y * 0.13);
      if (u < 0.0) {
        albedo = mix(vec3(0.12, 0.103, 0.071), vec3(0.23, 0.265, 0.13), patches);
        float moss = smoothstep(0.44, 0.70, patches) * smoothstep(5.3, 8.5, -u);
        albedo = mix(albedo, vec3(0.13, 0.22, 0.079), moss * 0.65);
        float litter = pow(anjiNoise(p * vec2(5.5, 1.5)), 7.0);
        float visible = 1.0 - smoothstep(0.06, 0.6, length(fwidth(p)));
        albedo += vec3(0.12, 0.09, 0.026) * litter * visible;
        albedo *= 0.83 + 0.21 * fine;
        gloss = 0.08;
        shin = 36.0;
      } else {
        vec3 facet = normalize(cross(dFdx(vWp), dFdy(vWp)));
        if (dot(facet, V) < 0.0) facet = -facet;
        float fractured = smoothstep(7.0, 12.0, u) * (1.0 - smoothstep(88.0, 165.0, u));
        N = normalize(mix(N, facet, fractured));
        anjiWetStone(vWp, V, N, albedo, gloss, shin);
        float cover = smoothstep(0.65, 0.94, N.y) * smoothstep(70.0, 165.0, u)
          * (0.45 + patches * 0.50);
        vec3 vegetation = mix(vec3(0.085, 0.16, 0.083), vec3(0.20, 0.285, 0.14), patches);
        albedo = mix(albedo, vegetation, cover);
        float shoulder = 1.0 - smoothstep(5.6, 8.5, u);
        albedo = mix(albedo, vec3(0.17, 0.17, 0.13) * (0.8 + fine * 0.3), shoulder);
        gloss = mix(gloss, 0.055, max(cover, shoulder));
      }
    `,
  }), 8, 100);
  add('anji-terrain', terrainGeometry(), ground);

  const leavesTexture = leafSprayTexture();
  function scatter(name, geometry, { spacing, seed, minU, maxU, plants, ahead = 3040, behind = 800,
    scale = [0.86, 1.18], bamboo = true }) {
    const back = Math.ceil(behind / spacing);
    const count = Math.ceil(ahead / spacing) + back + 2;
    const material = placer.add(worldMaterial({
      uniforms: {
        tAnjiLeaves: { value: leavesTexture },
        uAnjiSeed: { value: seed },
        uAnjiRange: { value: new THREE.Vector2(minU, maxU) },
        uAnjiScale: { value: new THREE.Vector2(...scale) },
      },
      vertPars: `
        ${HEIGHT}
        uniform float uAnjiSeed;
        uniform vec2 uAnjiRange;
        uniform vec2 uAnjiScale;
        varying float vAnjiHeight;
        varying float vAnjiInternode;
      `,
      place: `
        float iz = uBaseZ - float(gl_InstanceID) * uSpacing;
        float cell = floor((iz + uOriginZ) / uSpacing + 0.5);
        float plant = floor(aData);
        vec2 key = vec2(cell, uAnjiSeed + plant * 17.19);
        float h0 = hash21(key);
        float h1 = hash21(key + vec2(3.73, 19.1));
        float h2 = hash21(key + vec2(47.21, 7.91));
        float h3 = hash21(key + vec2(81.3, 39.7));
        iz += (h0 - 0.5) * uSpacing * 0.90;
        float band = (plant + 0.12 + h1 * 0.76) / ${plants.toFixed(1)};
        float u = -mix(uAnjiRange.x, uAnjiRange.y, band);
        float size = mix(uAnjiScale.x, uAnjiScale.y, h2);
        vec3 stretch = vec3(size, size * (0.90 + 0.19 * h3), size);
        vec3 p = position * stretch;
        vec3 n = normal / stretch;
        float yaw = h3 * 6.2831853;
        mat2 turn = mat2(cos(yaw), -sin(yaw), sin(yaw), cos(yaw));
        p.xz = turn * p.xz;
        n.xz = turn * n.xz;
        float flexibility = ${bamboo ? '0.00055' : '0.045'};
        float wave = sin(uTime * 0.85 + (iz + uOriginZ) * 0.024 + h2 * 3.0);
        float sway = flexibility * p.y * p.y;
        p.x += wave * sway;
        p.z += cos(uTime * 0.67 + h0 * 6.28) * sway * 0.38;
        n.y -= n.x * wave * flexibility * 2.0 * p.y
          + n.z * cos(uTime * 0.67 + h0 * 6.28) * flexibility * 0.76 * p.y;
        float fade = smoothstep(-${ahead.toFixed(1)}, -${(ahead - 160).toFixed(1)}, iz - cameraPosition.z)
          * (1.0 - smoothstep(${(behind - 100).toFixed(1)}, ${behind.toFixed(1)}, iz - cameraPosition.z));
        p *= fade;
        float z = iz + p.z;
        wp = vec3(roadX(z) + u + p.x, anjiHeight(u, iz + uOriginZ) + p.y, z);
        wn = normalize(vec3(n.x, n.y, n.z - roadDX(z) * n.x));
        vCol *= 0.83 + h1 * 0.25;
        vAnjiHeight = position.y;
        vAnjiInternode = 0.61;
      `,
      fragPars: 'uniform sampler2D tAnjiLeaves; varying float vAnjiHeight; varying float vAnjiInternode;',
      surface: FOLIAGE_SURFACE,
    }), spacing, back);
    add(name, instancedGeo(geometry, count), material);
  }

  scatter('anji-bamboo-near', bambooGeometry(0, 2), {
    spacing: 4, seed: 41, minU: 7.35, maxU: 14.8, plants: 2, ahead: 720, behind: 320,
  });
  scatter('anji-bamboo-middle', bambooGeometry(1, 9), {
    spacing: 4, seed: 173, minU: 12.5, maxU: 60, plants: 9, ahead: 1760, behind: 640, scale: [0.96, 1.36],
  });
  scatter('anji-bamboo-deep', bambooGeometry(2, 16), {
    spacing: 8, seed: 509, minU: 34, maxU: 190, plants: 16, ahead: 1920, behind: 560, scale: [1.08, 1.50],
  });
  scatter('anji-bamboo-valley', bambooGeometry(3, 18), {
    spacing: 12, seed: 929, minU: 165, maxU: 450, plants: 18, ahead: 2160, behind: 560, scale: [1.25, 1.75],
  });
  scatter('anji-bamboo-understory', bambooGeometry(2, 4), {
    spacing: 8, seed: 677, minU: 10, maxU: 64, plants: 4, ahead: 1200, behind: 480, scale: [0.32, 0.62],
  });
  scatter('anji-leafy-shrubs', undergrowthGeometry(), {
    spacing: 4, seed: 809, minU: 6.2, maxU: 17, plants: 4, bamboo: false,
    ahead: 1040, behind: 320, scale: [0.85, 1.12],
  });

  const rocks = boulderGeometry();
  function scatterRocks(name, { spacing, seed, range, width, height, ahead, behind, sparse = false }) {
    const back = Math.ceil(behind / spacing);
    const material = placer.add(worldMaterial({
      vertPars: HEIGHT,
      place: `
        float iz = uBaseZ - float(gl_InstanceID) * uSpacing;
        float cell = floor((iz + uOriginZ) / uSpacing + 0.5);
        vec2 key = vec2(cell, ${seed.toFixed(1)} + floor(aData) * 23.17);
        float h0 = hash21(key);
        float h1 = hash21(key + vec2(31.7, 8.3));
        float h2 = hash21(key + vec2(17.9, 52.1));
        float h3 = hash21(key + vec2(83.1, 2.9));
        iz += (h0 - 0.5) * uSpacing * 0.82;
        float u = mix(${range[0].toFixed(1)}, ${range[1].toFixed(1)}, (floor(aData) + 0.15 + h1 * 0.70) / 3.0);
        float width = mix(${width[0].toFixed(1)}, ${width[1].toFixed(1)}, h2);
        float height = mix(${height[0].toFixed(1)}, ${height[1].toFixed(1)}, h3);
        vec3 p = position * vec3(width, height, width * (0.8 + h0 * 0.4));
        float yaw = h1 * 6.2831853;
        p.xz = mat2(cos(yaw), -sin(yaw), sin(yaw), cos(yaw)) * p.xz;
        float fade = smoothstep(-${ahead.toFixed(1)}, -${(ahead - 160).toFixed(1)}, iz - cameraPosition.z)
          * (1.0 - smoothstep(${(behind - 100).toFixed(1)}, ${behind.toFixed(1)}, iz - cameraPosition.z));
        p *= fade * ${sparse ? 'step(0.34, h2)' : '1.0'};
        float z = iz + p.z;
        float base = anjiHeight(u, iz + uOriginZ);
        float bed = anjiHeight(u + p.x, z + uOriginZ);
        // Bury the lower ring in the actual terrain, including steep downhill faces.
        float skirt = 1.0 - smoothstep(0.0, 0.90, position.y);
        wp = vec3(roadX(z) + u + p.x, mix(base, bed, skirt) + p.y - 0.12, z);
        wn = vec3(0.0, 1.0, 0.0);
      `,
      fragPars: ROCK_MATERIAL,
      surface: `
        N = normalize(cross(dFdx(vWp), dFdy(vWp)));
        if (dot(N, V) < 0.0) N = -N;
        anjiWetStone(vWp, V, N, albedo, gloss, shin);
      `,
    }), spacing, back);
    add(name, instancedGeo(rocks, Math.ceil(ahead / spacing) + back + 2), material);
  }
  scatterRocks('anji-roadside-boulders', {
    spacing: 120, seed: 1289, range: [-12, -7.7], width: [1.15, 2.05], height: [2.0, 4.2],
    ahead: 1120, behind: 400, sparse: true,
  });
  scatterRocks('anji-fractured-outcrops', {
    spacing: 24, seed: 1877, range: [11, 66], width: [2.0, 4.8], height: [5.0, 11.0],
    ahead: 1600, behind: 480,
  });

  const rails = placer.add(worldMaterial({
    place: `${PLACE_STRIP}\nwn = normalize(vec3(normal.x, normal.y, normal.z - roadDX(wz) * normal.x));`,
    surface: `
      float az = vWp.z + uOriginZ;
      float wear = hash21(vec2(floor(az * 6.0), floor(vWp.y * 30.0)));
      albedo *= 0.94 + wear * 0.06;
      gloss = 0.36;
      shin = 64.0;
    `,
  }), 4, 200);
  add('anji-w-beam-guardrails', railGeometry(), rails);

  const roadsidePlace = `
    float iz = uBaseZ - float(gl_InstanceID) * uSpacing;
    float wz = iz + position.z;
    wp = vec3(roadX(wz) + position.x, position.y, wz);
    wn = normalize(vec3(normal.x, normal.y, normal.z - roadDX(wz) * normal.x));
  `;
  for (const reflectors of [false, true]) {
    const spacing = reflectors ? 40 : 8;
    const material = placer.add(worldMaterial({
      place: roadsidePlace,
      surface: 'gloss = 0.22; shin = 40.0; retro = vData * 0.85;',
    }), spacing, Math.ceil(800 / spacing));
    add(reflectors ? 'anji-reflector-posts' : 'anji-guardrail-posts',
      instancedGeo(roadsideGeometry(reflectors), Math.ceil(4000 / spacing) + 2), material);
  }

  const signs = placer.add(worldMaterial({
    uniforms: { tAnjiSign: { value: signTexture() }, uInstU: { value: -6.1 } },
    place: PLACE_INSTANCED,
    fragPars: 'uniform sampler2D tAnjiSign;',
    surface: `
      if (vData > 0.5) {
        albedo = texture2D(tAnjiSign, vUv).rgb;
        retro = 0.42;
      }
      gloss = 0.13;
      shin = 32.0;
    `,
  }), 1200, 1);
  add('anji-bamboo-road-signs', instancedGeo(signGeometry(), 5), signs);

  return { group };
}
