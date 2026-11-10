import * as THREE from 'three';
import { ROAD } from '../config.js';
import { shared } from '../core/globals.js';
import { COMMON, LIGHTING } from '../shaders/common.js';
import { GeoBuilder, V3 } from './geo.js';
import { worldMaterial, instancedGeo, PLACE_STRIP, PLACE_INSTANCED } from './materials.js';
import { makeSignAtlas } from './signs.js';

// 路侧设施：护栏、防眩板、路灯（含光晕）、轮廓标、门架标志、两侧楼群。
// 全部是「z 的函数」：几何体只建一份，位置由顶点着色器按间距算出来，无限延伸且不需要在 CPU 上管理区块。

// 把一个 (u, y) 截面沿 -Z 拉伸成长条
function stripGeometry(profile, length, step) {
  const b = new GeoBuilder();
  let cu = 0;
  let cy = 0;
  for (const p of profile) {
    cu += p[0];
    cy += p[1];
  }
  cu /= profile.length;
  cy /= profile.length;
  const rows = Math.round(length / step);
  for (let s = 0; s < profile.length - 1; s++) {
    const [u0, y0] = profile[s];
    const [u1, y1] = profile[s + 1];
    let nx = y1 - y0;
    let ny = -(u1 - u0);
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    // 法线朝外（背离截面重心）
    if (nx * ((u0 + u1) / 2 - cu) + ny * ((y0 + y1) / 2 - cy) < 0) {
      nx = -nx;
      ny = -ny;
    }
    const n = V3(nx, ny, 0);
    for (let r = 0; r < rows; r++) {
      const z0 = -r * step;
      const z1 = z0 - step;
      b.vert(V3(u0, y0, z0), n);
      b.vert(V3(u1, y1, z0), n);
      b.vert(V3(u1, y1, z1), n);
      b.vert(V3(u0, y0, z0), n);
      b.vert(V3(u1, y1, z1), n);
      b.vert(V3(u0, y0, z1), n);
    }
  }
  return b.build();
}

const SPRITE_QUAD = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
})();

export { SPRITE_QUAD };

export function createProps(renderer, placer) {
  const group = new THREE.Group();
  const add = (mesh) => {
    mesh.frustumCulled = false;
    group.add(mesh);
    return mesh;
  };

  // ---------------------------------------------------------------- 混凝土护栏
  const concrete = placer.add(
    worldMaterial({
      place: PLACE_STRIP,
      surface: /* glsl */ `
        vec4 nz = texture2D(tNoise, vec2(vWp.z / 6.0, vWp.y / 1.5));
        float streak = texture2D(tNoise, vec2(vWp.z / 3.0, vWp.y / 24.0)).a;
        albedo = vec3(0.26, 0.26, 0.25) * (0.6 + 0.5 * nz.a) * (0.65 + 0.6 * streak);
        float jt = abs(fract(vWp.z / 4.0) - 0.5) * 4.0;
        albedo *= 0.55 + 0.45 * smoothstep(0.0, 0.035, jt);
        albedo *= 0.5 + 0.5 * smoothstep(0.0, 0.5, vWp.y); // 底部溅水发黑
        gloss = 0.22;
        shin = 30.0;
      `,
    }),
    8,
    20,
  );
  const median = [[0.32, 0], [0.32, 0.1], [0.18, 0.36], [0.12, 1.0], [-0.12, 1.0], [-0.18, 0.36], [-0.32, 0.1], [-0.32, 0]];
  const B = ROAD.BARRIER_U;
  const outer = [[B, 0], [B, 0.12], [B + 0.12, 0.42], [B + 0.18, 1.1], [B + 0.45, 1.1], [B + 0.45, -1.2]];
  add(new THREE.Mesh(stripGeometry(median, 1400, 8), concrete));
  add(new THREE.Mesh(stripGeometry(outer, 1400, 8), concrete));
  add(new THREE.Mesh(stripGeometry(outer.map(([u, y]) => [-u, y]), 1400, 8), concrete));

  // ---------------------------------------------------------------- 防眩板（中央隔离带上的绿色竖板）
  {
    const b = new GeoBuilder();
    b.xform(new THREE.Matrix4().makeRotationY(0.35));
    b.color(0.015, 0.085, 0.045).box(0, 1.46, 0, 0.2, 0.92, 0.028);
    const mat = placer.add(
      worldMaterial({ place: PLACE_INSTANCED, surface: 'gloss = 0.35; shin = 60.0;' }),
      1,
      80,
    );
    add(new THREE.Mesh(instancedGeo(b.build(), 680), mat));
  }

  // ---------------------------------------------------------------- 路灯杆（中央隔离带，双臂）
  {
    const b = new GeoBuilder();
    b.color(0.27, 0.28, 0.29);
    b.cyl(V3(0, 1.0, 0), V3(0, 10.2, 0), 0.11, 0.07, 8);
    for (const s of [-1, 1]) {
      b.color(0.27, 0.28, 0.29).cyl(V3(0, 9.85, 0), V3(s * 2.1, 10.5, 0), 0.05, 0.04, 6);
      b.color(0.12, 0.12, 0.13).box(s * ROAD.LAMP_U, 10.5, 0, 0.78, 0.12, 0.3);
      // 灯罩：朝下的发光面
      b.color(1, 1, 1).emis(1);
      b.quad(V3(s * ROAD.LAMP_U - 0.33, 10.435, -0.12), V3(s * ROAD.LAMP_U + 0.33, 10.435, -0.12), V3(s * ROAD.LAMP_U + 0.33, 10.435, 0.12), V3(s * ROAD.LAMP_U - 0.33, 10.435, 0.12));
      b.emis(0);
    }
    const mat = placer.add(
      worldMaterial({
        place: PLACE_INSTANCED,
        surface: 'emissive = vEmis * uLampColor * 28.0; gloss = 0.3; shin = 50.0;',
      }),
      ROAD.LAMP_S,
      3,
    );
    add(new THREE.Mesh(instancedGeo(b.build(), 30), mat));
  }

  // ---------------------------------------------------------------- 路灯光晕（雨雾里的一团光）
  {
    const mat = placer.add(
      new THREE.ShaderMaterial({
        uniforms: { ...shared(), uBaseZ: { value: 0 }, uSpacing: { value: 1 } },
        vertexShader: /* glsl */ `
          ${COMMON}
          uniform float uBaseZ;
          varying vec2 vC;
          varying float vDist;
          varying float vSize;
          void main() {
            int id = gl_InstanceID;
            float side = (id % 2 == 0) ? -1.0 : 1.0;
            float lz = uBaseZ - float(id / 2) * LAMP_S;
            vec3 c = vec3(roadX(lz) + side * LAMP_U, LAMP_H - 0.1, lz);
            vec4 mv = viewMatrix * vec4(c, 1.0);
            float dist = length(mv.xyz);
            float size = 2.4 + dist * 0.014;
            vC = position.xy;
            vDist = dist;
            vSize = size;
            mv.xy += position.xy * size;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          ${COMMON}
          varying vec2 vC;
          varying float vDist;
          varying float vSize;
          void main() {
            float r = length(vC);
            if (r > 1.0) discard;
            float T = exp(-vDist * uFogDensity);
            // 灯芯：远处不足一个像素时放大并等能量变暗，避免闪烁
            float cr = max(0.035, vDist * uPixelAngle * 1.3 / vSize);
            float core = exp(-r * r / (cr * cr)) * 55.0 * (0.035 * 0.035) / (cr * cr);
            float haze = min(vDist * uFogDensity, 1.6);
            float halo = (exp(-r * 7.0) * 1.3 + exp(-r * r * 9.0) * 0.1 * (0.5 + uRain)) * (0.5 + haze);
            float edge = smoothstep(1.0, 0.7, r);
            gl_FragColor = vec4(uLampColor * (core + halo) * T * edge, 1.0);
          }
        `,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
      ROAD.LAMP_S,
      3,
    );
    add(new THREE.Mesh(instancedGeo(SPRITE_QUAD, 60), mat));
  }

  // ---------------------------------------------------------------- 轮廓标（护栏上的逆反射小点，被大灯照亮）
  {
    const mat = placer.add(
      new THREE.ShaderMaterial({
        uniforms: { ...shared(), uBaseZ: { value: 0 }, uSpacing: { value: 1 } },
        vertexShader: /* glsl */ `
          ${COMMON}
          ${LIGHTING}
          uniform float uBaseZ;
          varying vec2 vC;
          varying vec3 vCol;
          void main() {
            int id = gl_InstanceID;
            bool inner = (id % 2) == 0;
            float iz = uBaseZ - float(id / 2) * 8.0;
            vec3 c = vec3(roadX(iz) + (inner ? 0.335 : ${(ROAD.BARRIER_U - 0.03).toFixed(3)}), inner ? 0.72 : 0.8, iz);
            vec4 mv = viewMatrix * vec4(c, 1.0);
            float dist = length(mv.xyz);
            float size = max(0.05, dist * uPixelAngle * 1.1);
            float att = (0.05 * 0.05) / (size * size);
            vC = position.xy;
            mv.xy += position.xy * size;
            gl_Position = projectionMatrix * mv;
            vec3 tint = inner ? vec3(1.0, 0.72, 0.12) : vec3(1.0);
            vec3 lit = uHeadColor * headBeam(c) * 7.0 + uSkyAmb * 0.25;
            vCol = tint * lit * att * exp(-dist * uFogDensity);
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vC;
          varying vec3 vCol;
          void main() {
            float r = length(vC);
            if (r > 1.0) discard;
            gl_FragColor = vec4(vCol * smoothstep(1.0, 0.5, r), 1.0);
          }
        `,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
      8,
      8,
    );
    add(new THREE.Mesh(instancedGeo(SPRITE_QUAD, 180), mat));
  }

  // ---------------------------------------------------------------- 门架：绿底指路牌 / LED 情报板
  {
    const tSigns = makeSignAtlas(renderer);
    const frame = (b) => {
      const X1 = ROAD.BARRIER_U + 0.3;
      b.color(0.3, 0.31, 0.32).data(0);
      b.box(0, 4.8, 0, 0.36, 7.6, 0.36);
      b.box(X1, 4.85, 0, 0.36, 7.5, 0.36);
      b.box(X1 / 2, 6.9, 0, X1, 0.16, 0.16);
      b.box(X1 / 2, 8.5, 0, X1, 0.16, 0.16);
      for (let x = 0.95; x < X1; x += 1.9) {
        b.beam(V3(x - 0.95, 6.9, 0), V3(x + 0.95, 8.5, 0), 0.07, 0.07, V3(0, 0, 1));
        b.box(x + 0.95, 7.7, 0, 0.07, 1.6, 0.07);
      }
    };
    const sign = (b, x0, x1, y0, y1, kind) => {
      // 背板 + 朝向来车（+Z）的牌面
      b.color(0.2, 0.2, 0.2).data(0).box((x0 + x1) / 2, (y0 + y1) / 2, 0.1, x1 - x0, y1 - y0, 0.05);
      b.color(1, 1, 1).data(kind);
      b.quad(V3(x0, y0, 0.2), V3(x1, y0, 0.2), V3(x1, y1, 0.2), V3(x0, y1, 0.2));
    };

    const makeMat = () =>
      worldMaterial({
        place: /* glsl */ `
          ${PLACE_INSTANCED}
          float kAbs = floor((iz + uOriginZ) / uSpacing);
          vAtlas = vec2(0.0);
          if (aData > 0.5 && aData < 2.5) {
            float t = floor(hash11(kAbs * 1.7 + aData * 13.1) * 7.999);
            vAtlas = (vec2(mod(t, 4.0), floor(t / 4.0)) + vec2(uv.x, 1.0 - uv.y)) * 0.25;
          } else if (aData > 2.5) {
            float t = floor(hash11(kAbs * 2.3 + 5.7) * 7.999);
            vAtlas = vec2((mod(t, 2.0) + uv.x) * 0.5, 0.5 + (floor(t / 2.0) + 1.0 - uv.y) * 0.125);
          }
          vAtlas.y = 1.0 - vAtlas.y;
        `,
        vertPars: 'varying vec2 vAtlas;',
        fragPars: 'varying vec2 vAtlas; uniform sampler2D tSigns;',
        uniforms: { tSigns: { value: tSigns } },
        surface: /* glsl */ `
          gloss = 0.25;
          if (vData > 0.5 && vData < 2.5) {
            if (facing > 0.0) {
              albedo = texture2D(tSigns, vAtlas).rgb;
              retro = 2.4;
              gloss = 0.12;
            } else {
              albedo = vec3(0.2);
            }
          } else if (vData > 2.5) {
            albedo = vec3(0.012);
            if (facing > 0.0) {
              vec3 t = texture2D(tSigns, vAtlas).rgb;
              vec2 g = vUv * vec2(448.0, 56.0);
              float dots = smoothstep(0.48, 0.22, length(fract(g) - 0.5));
              dots = mix(dots, 0.42, smoothstep(0.3, 0.9, fwidth(g.y)));
              emissive = t * dots * 4.0;
            }
          }
        `,
      });

    const bg = new GeoBuilder();
    frame(bg);
    sign(bg, 1.3, 7.7, 5.9, 9.1, 1);
    sign(bg, 8.3, 14.7, 5.9, 9.1, 2);
    add(new THREE.Mesh(instancedGeo(bg.build(), 3), placer.add(makeMat(), 800, 1, 20)));

    const bl = new GeoBuilder();
    frame(bl);
    sign(bl, 1.4, 14.6, 6.75, 8.4, 3);
    add(new THREE.Mesh(instancedGeo(bl.build(), 3), placer.add(makeMat(), 800, 1, 420)));
  }

  // ---------------------------------------------------------------- 两侧楼群（高架外，雾里的剪影 + 亮着的窗）
  {
    const b = new GeoBuilder();
    b.box(0, 0.5, 0, 1, 1, 1);
    const mat = placer.add(
      worldMaterial({
        vertPars: 'varying vec2 vFacade; varying float vWall; varying vec3 vSeed;',
        fragPars: 'varying vec2 vFacade; varying float vWall; varying vec3 vSeed;',
        place: /* glsl */ `
          int id = gl_InstanceID;
          int vi = id % 4;
          float side = vi < 2 ? -1.0 : 1.0;
          float row = float(vi % 2);
          float z0 = uBaseZ - float(id / 4) * uSpacing;
          float kAbs = floor((z0 + uOriginZ) / uSpacing + 0.5);
          vec2 hs = vec2(kAbs, float(vi) * 7.0 + 3.0);
          float h1 = hash21(hs);
          float h2 = hash21(hs + 11.7);
          float h3 = hash21(hs + 23.1);
          float h4 = hash21(hs + 37.9);
          float bw = mix(20.0, 44.0, h1);
          float bd = mix(16.0, 30.0, h2);
          float bh = mix(10.0, 50.0, h3 * h3) + row * mix(12.0, 80.0, h4);
          float bu = side * (46.0 + bd * 0.5 + row * 62.0 + h2 * 22.0);
          float iz = z0 + (h4 - 0.5) * 20.0;
          vec3 lp = position * vec3(bd, bh + 24.0, bw);
          lp.y -= 24.0;
          wp = vec3(roadX(iz) + bu + lp.x, lp.y, iz + lp.z);
          wn = normal;
          vFacade = abs(normal.x) > 0.5 ? vec2(lp.z, lp.y) : vec2(lp.x, lp.y);
          vWall = 1.0 - abs(normal.y);
          vSeed = vec3(h1 * 97.0 + kAbs * 0.37, h3, h4);
        `,
        surface: /* glsl */ `
          // 住宅楼（style=0）窗小而暖，亮灯的户数随机；写字楼（style=1）是横向的玻璃带，整层亮或整层暗
          float style = step(0.55, vSeed.y);
          vec2 q = vFacade / mix(vec2(1.9, 3.0), vec2(2.6, 3.6), style);
          vec2 id = floor(q);
          vec2 f = abs(fract(q) - 0.5);
          vec2 wsz = mix(vec2(0.52, 0.42), vec2(0.9, 0.56), style) * 0.5;
          vec2 aa = fwidth(q) * 0.75 + 1e-4;
          float win = (1.0 - smoothstep(wsz.x - aa.x, wsz.x + aa.x, f.x)) * (1.0 - smoothstep(wsz.y - aa.y, wsz.y + aa.y, f.y));
          float litFrac = mix(0.1, 0.34, vSeed.z);
          float hw = hash21(id + vSeed.x);
          float hfloor = hash21(vec2(id.y, vSeed.x));
          float lit = mix(step(1.0 - litFrac, hw), step(0.55, hfloor) * step(0.25, hw), style);
          vec3 warm = vec3(1.0, 0.66, 0.34);
          vec3 cool = vec3(0.66, 0.82, 1.0);
          float isCool = mix(step(0.8, hash21(id * 1.31 + vSeed.x + 5.0)), step(0.35, hfloor * 1.7 - 0.2), style);
          vec3 wc = mix(warm, cool, isCool);
          float br = 0.12 + 0.9 * pow(hash21(id * 0.77 + vSeed.x + 9.0), 2.0);
          // 窗帘 / 室内的明暗变化
          br *= 0.6 + 0.4 * smoothstep(0.0, wsz.y, f.y + 0.1 * hw);
          vec3 em = wc * win * lit * br;
          // 远处窗户不足一个像素：换成整面墙的平均亮度，避免闪烁
          float litAvg = mix(litFrac, 0.34, style);
          vec3 avg = mix(warm, cool, mix(0.2, 0.55, style)) * litAvg * wsz.x * wsz.y * 4.0 * 0.42;
          em = mix(em, avg, smoothstep(0.35, 0.9, max(aa.x, aa.y)));
          float tone = 0.65 + 0.6 * vSeed.z;
          vec3 wall = mix(vec3(0.19, 0.185, 0.18), vec3(0.11, 0.125, 0.15), style) * tone;
          // 雨水在外墙上留下的竖向水渍
          wall *= 0.75 + 0.5 * texture2D(tNoise, vec2(vFacade.x * 0.06, vFacade.y * 0.008) + vSeed.x).a;
          albedo = mix(wall, vec3(0.025, 0.032, 0.04), win * vWall);
          emissive = em * vWall * uWindowGlow * 1.7;
          gloss = 0.12 + 0.7 * win * vWall;
        `,
      }),
      60,
      4,
    );
    add(new THREE.Mesh(instancedGeo(b.build(), 16 * 4), mat));
  }

  return group;
}
