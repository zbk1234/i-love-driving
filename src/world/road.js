import * as THREE from 'three';
import { ROAD } from '../config.js';
import { shared } from '../core/globals.js';
import { COMMON, LIGHTING } from '../shaders/common.js';

// 湿路面。几何体只是一条跟着车走的长带子，所有细节都在片元着色器里按世界坐标算出来：
// 标线、车辙积水、伸缩缝、雨点涟漪，以及最关键的——平面倒影。

const LENGTH = 1400;
const STEP = 4;

export function createRoad(placer) {
  const rows = LENGTH / STEP + 1;
  const pos = new Float32Array(rows * 2 * 3);
  const idx = [];
  for (let r = 0; r < rows; r++) {
    pos.set([-ROAD.HALF_W, 0, -r * STEP, ROAD.HALF_W, 0, -r * STEP], r * 6);
    if (r < rows - 1) {
      const a = r * 2;
      idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setIndex(idx);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      ...shared(),
      uBaseZ: { value: 0 },
      uSpacing: { value: STEP },
      tRefl: { value: null },
      tReflBlur: { value: null },
      uReflMatrix: { value: new THREE.Matrix4() },
      uReflOn: { value: 1 },
    },
    vertexShader: /* glsl */ `
      ${COMMON}
      uniform float uBaseZ;
      varying vec3 vWp;
      void main() {
        float wz = position.z + uBaseZ;
        vec3 wp = vec3(roadX(wz) + position.x, 0.0, wz);
        vWp = wp;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      ${COMMON}
      ${LIGHTING}
      varying vec3 vWp;
      uniform sampler2D tRefl;
      uniform sampler2D tReflBlur;
      uniform mat4 uReflMatrix;
      uniform float uReflOn;

      // 抗锯齿线条：线宽小于一个像素时按覆盖率淡出，远处不闪烁
      float lineMask(float d, float w, float aa) {
        return clamp((0.5 * max(w, aa) - abs(d)) / aa + 0.5, 0.0, 1.0) * min(1.0, w / aa);
      }

      // 雨点砸在水面上的同心涟漪
      vec2 ripples(vec2 p) {
        vec2 acc = vec2(0.0);
        for (int i = 0; i < 2; i++) {
          float sc = i == 0 ? 0.30 : 0.48;
          vec2 q = p / sc + float(i) * 7.31;
          vec2 id = floor(q);
          vec2 f = fract(q) - 0.5;
          float h = hash21(id + float(i) * 3.1);
          float tt = uTime * (1.3 + h * 0.9) + h * 10.0;
          float t = fract(tt);
          vec2 rnd = hash22(id * 1.9 + floor(tt));
          vec2 d = f - (rnd - 0.5) * 0.5;
          float r = length(d);
          float front = t * 0.5;
          float ring = sin((r - front) * 55.0) * smoothstep(0.07, 0.0, abs(r - front)) * (1.0 - t) * (1.0 - t);
          ring *= step(rnd.x * 0.6 + h * 0.4, 0.25 + 0.75 * uRain);
          acc += d / max(r, 1e-4) * ring;
        }
        return acc;
      }

      void main() {
        vec3 P = vWp;
        float u = P.x - roadX(P.z);
        float au = abs(u);
        vec3 Vv = cameraPosition - P;
        float dist = length(Vv);
        vec3 V = Vv / dist;

        vec2 rc2 = vec2(u, P.z);
        vec4 n1 = texture2D(tNoise, rc2 / 1.5);
        vec4 n2 = texture2D(tNoise, rc2 / 12.0 + 0.37);
        vec4 n3 = texture2D(tNoise, vec2(u / 16.0, P.z / 96.0) + 0.11);

        float aaU = max(fwidth(u), 1e-4) * 1.2;
        float aaZ = max(fwidth(P.z), 1e-4);

        // ---- 标线：两条实线边线 + 两条 6m/9m 虚线
        float edge = lineMask(au - EDGE_IN, 0.15, aaU) + lineMask(au - EDGE_OUT, 0.15, aaU);
        float fz = fract(P.z / 15.0);
        float az = aaZ / 15.0;
        float dash = smoothstep(0.0, az, fz) * (1.0 - smoothstep(0.4, 0.4 + az, fz));
        dash = mix(dash, 0.4, smoothstep(0.15, 0.5, az));
        float lanes = (lineMask(au - (EDGE_IN + LANE_W), 0.15, aaU) + lineMask(au - (EDGE_IN + 2.0 * LANE_W), 0.15, aaU)) * dash;
        float mark = clamp(edge + lanes, 0.0, 1.0);
        mark *= 0.35 + 0.65 * smoothstep(0.2, 0.45, n1.a * 0.5 + n2.a * 0.5);

        // ---- 积水：车辙、路缘和低洼处水更多
        float lu = au - EDGE_IN;
        float lf = mod(lu, LANE_W);
        float rd = min(abs(lf - 1.0), abs(lf - 2.75));
        float inLanes = step(0.0, lu) * step(au, EDGE_OUT);
        float rut = (1.0 - smoothstep(0.12, 0.5, rd)) * inLanes;
        float gutter = smoothstep(13.0, 14.6, au) + smoothstep(0.85, 0.45, au);
        float pn = n3.b * 0.55 + n2.b * 0.3 + n2.a * 0.15;
        float puddle = smoothstep(0.50, 0.58, pn + rut * 0.07 + gutter * 0.25 + (uRain - 0.6) * 0.12);

        // ---- 高架伸缩缝
        float jd = abs(fract(P.z / JOINT_S + 0.5) - 0.5) * JOINT_S;
        float joint = (1.0 - smoothstep(0.05, 0.05 + aaZ, jd)) * min(1.0, 0.12 / aaZ);

        // ---- 颜色（湿沥青很黑）
        vec3 asphalt = vec3(0.040, 0.042, 0.046) * (0.65 + 0.7 * n1.a) * (0.8 + 0.4 * n2.a);
        asphalt *= 1.0 - 0.3 * smoothstep(0.55, 0.6, n3.a);
        vec3 paint = vec3(0.50, 0.50, 0.47) * (0.55 + 0.45 * n1.a);
        vec3 albedo = mix(asphalt, paint, mark);
        albedo = mix(albedo, vec3(0.06, 0.062, 0.066), joint);
        albedo *= 1.0 - 0.5 * puddle;

        // ---- 表面法线扰动：粗糙沥青抖得厉害，积水处只有涟漪
        vec2 gn = n1.rg - 0.5;
        float nearF = 1.0 - smoothstep(18.0, 45.0, dist);
        vec2 rip = nearF > 0.0 ? ripples(P.xz) * nearF * (0.25 + 0.75 * puddle) : vec2(0.0);
        vec2 nrm = gn * mix(0.55, 0.05, puddle) + rip * 0.5;

        // ---- 平面倒影：积水处是清晰镜像，湿沥青是竖向拉长的模糊光带
        vec3 refl = uFogColor;
        if (uReflOn > 0.5) {
          vec4 rc = uReflMatrix * vec4(P.x, 0.0, P.z, 1.0);
          vec2 ruv = rc.xy / rc.w;
          vec2 wob = vec2(nrm.x * (0.2 + V.y), nrm.y) * 0.12;
          vec3 sharp = texture2D(tRefl, ruv + wob).rgb;
          vec3 rough = texture2D(tReflBlur, ruv + wob * 0.5).rgb;
          refl = mix(rough * (0.75 + 0.5 * n1.a), sharp, puddle);
        }
        float cosT = max(V.y, 0.0);
        float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
        float Fw = F * mix(0.5, 1.0, puddle) * (1.0 - 0.35 * mark);

        // ---- 漫反射
        vec3 ld;
        vec3 ls;
        lampLight(P, vec3(0.0, 1.0, 0.0), V, 20.0, ld, ls);
        float hb = headBeam(P);
        vec3 toHead = normalize(uHeadPos - P);
        vec3 amb = uSkyAmb * (1.0 + uFlash * 8.0);
        vec3 col = albedo * (amb + ld + uHeadColor * hb * max(toHead.y, 0.0));
        col += paint * mark * uHeadColor * hb * 0.22; // 标线玻璃珠的逆反射
        col = col * (1.0 - Fw) + refl * Fw;

        // ---- 雨点砸在路面上溅起的水花：近处路面上一闪即逝的小亮点，雨大时路面像在「沸腾」
        if (nearF > 0.0) {
          vec2 sq = P.xz / 0.06;
          vec2 sf = fract(sq) - 0.5;
          float sh = hash21(floor(sq) + floor(uTime * 16.0) * 7.7);
          float splash = step(1.0 - 0.016 * uRain, sh) * smoothstep(0.5, 0.15, length(sf)) * nearF;
          col += splash * (amb * 2.5 + ld * 0.6 + uHeadColor * hb * 0.12 + refl * 0.6);
        }

        col = applyFog(col, P);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.layers.set(1); // 路面自己不进倒影通道
  placer.add(material, STEP, 40);

  return { mesh, material };
}
