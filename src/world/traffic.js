import * as THREE from 'three';
import { CAR, laneCenter } from '../config.js';
import { G, shared } from '../core/globals.js';
import { COMMON, LIGHTING } from '../shaders/common.js';
import { roadX, roadYaw } from '../core/roadmath.js';
import { SPECS, PAINTS, buildVehicle } from './vehicles.js';
import { worldMaterial, instancedGeo } from './materials.js';
import { SPRITE_QUAD } from './props.js';

// 车流：同向 16 辆（会跟车、会变道超车）+ 对向 12 辆。
// 车身是程序化放样出来的，雨雾里主要靠轮廓、尾灯和水雾来传达真实感。

function makeSpriteSet(capacity, attrs, material) {
  const geo = instancedGeo(SPRITE_QUAD, 0);
  const buffers = {};
  for (const [name, size] of attrs) {
    const arr = new Float32Array(capacity * size);
    const attr = new THREE.InstancedBufferAttribute(arr, size);
    attr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute(name, attr);
    buffers[name] = attr;
  }
  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  return { mesh, geo, buffers, capacity, count: 0 };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const rand = (a, b) => a + Math.random() * (b - a);
// 预计还有几秒并排时通知音频播放驶过声（实录里车开到最近要 3 s 左右）
const PASS_LEAD = 3.2;

export class Traffic {
  constructor() {
    this.group = new THREE.Group();
    this.same = [];
    this.opp = [];
    this.passby = { gain: 0, pan: 0 };
    this.onPass = null; // (ttc, 相对速度, 横向间距, 是否大车) => void

    const carMat = worldMaterial({
      surface: /* glsl */ `
        if (vData > 0.5 && vData < 1.5) { gloss = 0.95; shin = 260.0; }       // 车窗
        else if (vData > 1.5 && vData < 2.5) { retro = 3.0; gloss = 0.2; }    // 车牌 / 反光条
        else if (vData > 3.5) {                                               // 货厢：瓦楞板 + 雨水冲出来的脏痕
          float rib = smoothstep(0.35, 0.5, abs(fract(vUv.x * 22.0) - 0.5));
          float dirt = texture2D(tNoise, vec2(vUv.x * 3.0, vUv.y * 0.35)).a;
          albedo *= (0.82 + 0.18 * rib) * (0.6 + 0.5 * dirt) * (0.55 + 0.45 * smoothstep(0.0, 0.5, vUv.y));
          gloss = 0.3;
        }
        else if (vData > 2.5) { gloss = 0.06; }                               // 轮胎、底盘
        else { gloss = 0.6; shin = 110.0; }                                   // 车漆
        emissive = vCol * vEmis * 4.0;
        // 贴近路面的车身下缘被水雾糊住
        albedo *= 0.55 + 0.45 * smoothstep(0.15, 0.7, vWp.y);
      `,
    });

    const kindsSame = ['sedan', 'suv', 'sedan', 'truck', 'sedan', 'van', 'suv', 'sedan', 'bus', 'sedan', 'suv', 'truck', 'sedan', 'van', 'suv', 'sedan'];
    const kindsOpp = ['sedan', 'suv', 'truck', 'sedan', 'van', 'sedan', 'suv', 'bus', 'sedan', 'sedan', 'suv', 'sedan'];
    const make = (kind, dir, i) => {
      const paint = PAINTS[(i * 5 + (dir > 0 ? 0 : 3)) % PAINTS.length];
      const mesh = new THREE.Mesh(buildVehicle(kind, paint), carMat);
      mesh.visible = false;
      this.group.add(mesh);
      return {
        mesh, kind, spec: SPECS[kind], dir, heavy: kind === 'truck' || kind === 'bus',
        active: false, u: 0, targetU: 0, z: 0, v: 0, vDes: 20, brake: 0, blocked: 0, blink: 0, cool: rand(2, 8), passCue: false,
        led: i % 3 === 0,
      };
    };
    kindsSame.forEach((k, i) => this.same.push(make(k, 1, i)));
    kindsOpp.forEach((k, i) => this.opp.push(make(k, -1, i)));

    // ---- 车灯光斑（加色混合的公告板）
    this.lights = makeSpriteSet(
      260,
      [['iPos', 3], ['iCol', 3], ['iDir', 4], ['iSize', 1]],
      new THREE.ShaderMaterial({
        uniforms: shared(),
        vertexShader: /* glsl */ `
          ${COMMON}
          attribute vec3 iPos;
          attribute vec3 iCol;
          attribute vec4 iDir;
          attribute float iSize;
          varying vec2 vC;
          varying vec3 vCol;
          varying float vCore;
          varying float vHaze;
          void main() {
            vec4 mv = viewMatrix * vec4(iPos, 1.0);
            float dist = length(mv.xyz);
            vec3 toCam = normalize(cameraPosition - iPos);
            float lobe = pow(max(dot(toCam, iDir.xyz), 0.0), iDir.w);
            float size = max(iSize * (1.0 + dist * 0.012), dist * uPixelAngle * 2.0);
            vC = position.xy;
            vCore = max(0.12, dist * uPixelAngle * 1.3 / size);
            vHaze = min(dist * uFogDensity, 1.6);
            vCol = iCol * lobe * exp(-dist * uFogDensity);
            mv.xy += position.xy * size;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          varying vec2 vC;
          varying vec3 vCol;
          varying float vCore;
          varying float vHaze;
          void main() {
            float r = length(vC);
            if (r > 1.0) discard;
            float core = exp(-r * r / (vCore * vCore)) * 0.0144 / (vCore * vCore);
            float halo = exp(-r * 5.0) * 0.07 * (0.5 + vHaze);
            gl_FragColor = vec4(vCol * (core + halo) * smoothstep(1.0, 0.7, r), 1.0);
          }
        `,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        transparent: true,
      }),
    );
    this.group.add(this.lights.mesh);

    // ---- 轮胎卷起的水雾
    this.spray = makeSpriteSet(
      160,
      [['sPos', 3], ['sPar', 3]],
      new THREE.ShaderMaterial({
        uniforms: shared(),
        vertexShader: /* glsl */ `
          ${COMMON}
          ${LIGHTING}
          attribute vec3 sPos;
          attribute vec3 sPar; // 半径、不透明度、随机种子
          varying vec2 vC;
          varying vec2 vN;
          varying vec3 vLight;
          varying float vA;
          void main() {
            vec4 mv = viewMatrix * vec4(sPos, 1.0);
            float dist = length(mv.xyz);
            vC = position.xy;
            vN = position.xy * 0.2 + sPar.z * vec2(3.7, 1.9);
            vLight = uFogColor * 1.15 * (1.0 + uFlash * 5.0) + uLampColor * lampScatter(sPos) * 0.035 + uHeadColor * headBeam(sPos) * 0.1;
            vA = sPar.y * exp(-dist * uFogDensity) * smoothstep(1.5, 5.0, dist);
            mv.xy += position.xy * sPar.x;
            gl_Position = projectionMatrix * mv;
          }
        `,
        fragmentShader: /* glsl */ `
          ${COMMON}
          varying vec2 vC;
          varying vec2 vN;
          varying vec3 vLight;
          varying float vA;
          void main() {
            float r = length(vC);
            if (r > 1.0) discard;
            float n = texture2D(tNoise, vN + vec2(0.0, uTime * 0.12)).b;
            float a = vA * smoothstep(1.0, 0.15, r) * (0.35 + 1.0 * n);
            gl_FragColor = vec4(vLight, clamp(a, 0.0, 1.0));
          }
        `,
        transparent: true,
        depthWrite: false,
      }),
    );
    this.spray.mesh.layers.set(1);
    this.spray.mesh.renderOrder = 5;
    this.group.add(this.spray.mesh);

    this._sprayList = [];
  }

  // 初始时把车撒在自车前后
  reset(player) {
    for (const c of this.same) {
      for (let tries = 0; tries < 20 && !c.active; tries++) this._spawnSame(c, player, rand(-600, 200));
    }
    for (const c of this.opp) {
      for (let tries = 0; tries < 20 && !c.active; tries++) this._spawnOpp(c, player, rand(-900, 150));
    }
  }

  shiftZ(dz) {
    for (const c of this.same) c.z += dz;
    for (const c of this.opp) c.z += dz;
  }

  _laneClear(list, self, u, z, range) {
    for (const o of list) {
      if (o !== self && o.active && Math.abs(o.u - u) < 2.2 && Math.abs(o.z - z) < range) return false;
    }
    return true;
  }

  _spawnSame(c, player, forceDz) {
    const lane = c.heavy ? (Math.random() < 0.65 ? 2 : 1) : Math.floor(Math.random() * 3);
    const vDes = ([27.5, 23.5, 19.5][lane] + rand(-2, 2)) * (c.heavy ? 0.93 : 1);
    const faster = vDes > player.speed + 1.5;
    const dz = forceDz ?? (faster ? rand(170, 255) : -rand(430, 660));
    const z = player.z + dz;
    const u = laneCenter(lane) + rand(-0.15, 0.15);
    if (!this._laneClear(this.same, c, u, z, 55)) return;
    if (Math.abs(u - player.u) < 2.2 && Math.abs(dz) < 60) return;
    Object.assign(c, { u, targetU: u, z, v: vDes, vDes, active: true, brake: 0, blocked: 0, blink: 0, passCue: false });
    c.mesh.visible = true;
  }

  _spawnOpp(c, player, forceDz) {
    const lane = c.heavy ? 2 : Math.floor(Math.random() * 3);
    const dz = forceDz ?? -rand(680, 980);
    const z = player.z + dz;
    const u = -laneCenter(lane);
    if (!this._laneClear(this.opp, c, u, z, 60)) return;
    Object.assign(c, { u, targetU: u, z, v: [27, 24, 20][lane] + rand(-2, 2), active: true });
    c.mesh.visible = true;
  }

  // 自车前方同车道最近的车：自适应巡航用
  leadFor(u, z) {
    let gap = Infinity;
    let v = 0;
    for (const c of this.same) {
      if (!c.active || Math.abs(c.u - u) > 1.9) continue;
      const d = z - c.z;
      if (d > 0) {
        const g = d - (c.spec.len + CAR.LEN) / 2;
        if (g < gap) {
          gap = g;
          v = c.v;
        }
      }
    }
    return { gap, v };
  }

  // 目标车道在自车前后一段范围内是否空闲（自车变道前检查）
  gapFree(u, z, back = 14, front = 20) {
    for (const c of this.same) {
      if (!c.active || Math.abs(c.u - u) > 2.0) continue;
      const d = c.z - z;
      if (d < back && d > -front) return false;
    }
    return true;
  }

  // 自车与同向车辆的碰撞检测
  collide(u, z) {
    for (const c of this.same) {
      if (!c.active) continue;
      const dz = z - c.z;
      const lim = (c.spec.len + CAR.LEN) / 2;
      if (Math.abs(dz) < lim && Math.abs(c.u - u) < (c.spec.wid + CAR.WID) / 2 - 0.08) return { car: c, dz, lim };
    }
    return null;
  }

  update(dt, player, camPos) {
    const same = this.same;
    let pg = 0;
    let pp = 0;

    for (const c of same) {
      if (!c.active) {
        this._spawnSame(c, player);
        continue;
      }
      // ---- 跟车（IDM 模型）
      let gap = 1e9;
      let lv = c.vDes;
      for (const o of same) {
        if (o === c || !o.active || Math.abs(o.u - c.u) > 1.9) continue;
        const d = c.z - o.z;
        if (d > 0) {
          const g = d - (c.spec.len + o.spec.len) / 2;
          if (g < gap) {
            gap = g;
            lv = o.v;
          }
        }
      }
      if (Math.abs(player.u - c.u) < 1.9) {
        const d = c.z - player.z;
        if (d > 0) {
          const g = d - (c.spec.len + CAR.LEN) / 2;
          if (g < gap) {
            gap = g;
            lv = player.speed;
          }
        }
      }
      const sStar = 4 + c.v * 1.3 + (c.v * (c.v - lv)) / 3.9;
      let acc = 1.6 * (1 - (c.v / c.vDes) ** 4 - (Math.max(sStar, 0) / Math.max(gap, 0.5)) ** 2);
      acc = clamp(acc, -7, 1.8);
      c.v = Math.max(0, c.v + acc * dt);
      c.z -= c.v * dt;
      c.brake += ((acc < -1.0 ? 1 : 0) - c.brake) * Math.min(1, dt * 8);

      // ---- 被慢车压住一会儿就找空档变道
      const changing = Math.abs(c.targetU - c.u) > 0.05;
      c.cool -= dt;
      if (!changing) {
        c.blink = 0;
        c.blocked = gap < 10 + c.v * 1.9 && c.v < c.vDes - 1.5 ? c.blocked + dt : 0;
        if (c.blocked > 2.0 && c.cool < 0) {
          const lane = Math.round((c.u - laneCenter(0)) / 3.75);
          for (const dl of [-1, 1]) {
            const nl = lane + dl;
            if (nl < 0 || nl > 2 || (c.heavy && nl === 0)) continue;
            const nu = laneCenter(nl);
            let free = this._laneClear(same, c, nu, c.z - 8, 30);
            if (free && Math.abs(player.u - nu) < 2.4 && Math.abs(player.z - (c.z - 6)) < 26) free = false;
            if (free) {
              c.targetU = nu;
              c.blink = dl;
              c.blocked = 0;
              c.cool = rand(6, 14);
              break;
            }
          }
        }
      } else {
        const step = Math.sign(c.targetU - c.u) * Math.min(Math.abs(c.targetU - c.u), 1.15 * dt);
        c.u += step;
      }

      const dz = c.z - player.z;
      if (dz > 275 || dz < -690) {
        c.active = false;
        c.mesh.visible = false;
        continue;
      }
      c.mesh.position.set(roadX(c.z) + c.u, 0, c.z);
      c.mesh.rotation.y = roadYaw(c.z) + (changing ? Math.sign(c.targetU - c.u) * -0.035 : 0);

      // 擦身而过的呼啸声
      const du = c.u - player.u;
      if (Math.abs(dz) < 22 && Math.abs(du) > 1.5) {
        const g = (1 - Math.abs(dz) / 22) ** 2 * clamp(Math.abs(c.v - player.speed) / 8 + 0.25, 0, 1) * (c.heavy ? 1.3 : 0.8);
        if (g > pg) {
          pg = g;
          pp = Math.sign(du) * 0.7;
        }
      }

      // 超车 / 被超车：在相邻一两条车道、正在靠近，预计 PASS_LEAD 秒内并排就触发一次；拉开后再复位
      const rel = c.v - player.speed;
      const ttc = dz / rel;
      if (c.passCue) {
        if (ttc < 0) c.passCue = false;
      } else if (Math.abs(rel) > 1.5 && ttc > 0 && ttc < PASS_LEAD && Math.abs(du) > 1.5 && Math.abs(du) < 9) {
        c.passCue = true;
        this.onPass?.(ttc, Math.abs(rel), du, c.heavy);
      }
    }

    for (const c of this.opp) {
      if (!c.active) {
        this._spawnOpp(c, player);
        continue;
      }
      c.z += c.v * dt;
      const dz = c.z - player.z;
      if (dz > 230) {
        c.active = false;
        c.mesh.visible = false;
        continue;
      }
      c.mesh.position.set(roadX(c.z) + c.u, 0, c.z);
      c.mesh.rotation.y = roadYaw(c.z) + Math.PI;
      if (Math.abs(dz) < 26) {
        const g = (1 - Math.abs(dz) / 26) ** 2 * 0.45 * (c.heavy ? 1.4 : 1);
        if (g > pg) {
          pg = g;
          pp = -0.8;
        }
      }
    }

    this.passby.gain = pg;
    this.passby.pan = pp;
    this._updateSprites(player, camPos);
  }

  _updateSprites(player, camPos) {
    const L = this.lights;
    const iPos = L.buffers.iPos.array;
    const iCol = L.buffers.iCol.array;
    const iDir = L.buffers.iDir.array;
    const iSize = L.buffers.iSize.array;
    let n = 0;
    const blinkOn = (performance.now() / 1000) % 0.74 < 0.37;
    const push = (x, y, z, r, g, b, dx, dz, lobe, size) => {
      if (n >= L.capacity) return;
      iPos.set([x, y, z], n * 3);
      iCol.set([r, g, b], n * 3);
      iDir.set([dx, 0, dz, lobe], n * 4);
      iSize[n] = size;
      n++;
    };

    const sprays = this._sprayList;
    sprays.length = 0;
    const rain = G.uRain.value;

    const emit = (c) => {
      const yaw = c.mesh.rotation.y;
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      const rx = Math.cos(yaw);
      const rz = -Math.sin(yaw);
      const p = c.mesh.position;
      const s = c.spec;
      const hl = s.len / 2 + 0.03;
      const tx = (s.tail[0] + s.tail[1]) / 2;
      const ty = (s.tail[2] + s.tail[3]) / 2;
      const [hx, hy] = s.head;
      const tI = 3.2 + c.brake * 11;
      for (const side of [-1, 1]) {
        push(p.x - fx * hl + rx * tx * side, ty, p.z - fz * hl + rz * tx * side, tI, tI * 0.045, tI * 0.02, -fx, -fz, 1.2, 0.55);
        const hc = c.led ? [0.86, 0.93, 1.0] : [1.0, 0.9, 0.72];
        push(p.x + fx * hl + rx * hx * side, hy, p.z + fz * hl + rz * hx * side, hc[0] * 55, hc[1] * 55, hc[2] * 55, fx, fz, 5.0, 1.25);
        // 转向灯
        if (c.blink && blinkOn && side === (c.blink < 0 ? -1 : 1)) {
          push(p.x - fx * hl + rx * (tx + 0.1) * side, ty, p.z - fz * hl + rz * (tx + 0.1) * side, 9, 4.2, 0.4, -fx, -fz, 0.8, 0.5);
        }
      }
      if (c.brake > 0.05) push(p.x - fx * (hl - 0.4), s.top, p.z - fz * (hl - 0.4), c.brake * 6, c.brake * 0.25, c.brake * 0.1, -fx, -fz, 1.2, 0.4);

      // 车后拖着的水雾（越往后越大越淡）
      if (c.dir > 0 && c.v > 6) {
        const k = clamp((c.v - 6) / 16, 0, 1) * (0.35 + 0.65 * rain) * (c.heavy ? 1.6 : 1);
        for (let i = 0; i < 6; i++) {
          const d = 1.5 + i * i * 0.85 + i * 1.6;
          const zz = p.z + s.len / 2 + d;
          sprays.push([roadX(zz) + c.u, 0.55 + i * 0.22 + (c.heavy ? 0.4 : 0), zz, 1.3 + i * 0.75 + (c.heavy ? 0.9 : 0), 0.3 * k * Math.exp(-i * 0.33), c.z * 0.013 + i * 0.37]);
        }
      }
    };
    for (const c of this.same) if (c.active) emit(c);
    for (const c of this.opp) if (c.active) emit(c);

    // 自车尾部的水雾（后视镜里能看到）
    if (player.speed > 6) {
      const k = clamp((player.speed - 6) / 16, 0, 1) * (0.35 + 0.65 * rain);
      for (let i = 0; i < 5; i++) {
        const d = 2.5 + i * i * 0.9 + i * 1.6;
        const zz = player.z + CAR.LEN / 2 + d;
        sprays.push([roadX(zz) + player.u, 0.55 + i * 0.22, zz, 1.3 + i * 0.75, 0.26 * k * Math.exp(-i * 0.33), player.z * 0.013 + i * 0.37]);
      }
    }

    L.geo.instanceCount = n;
    for (const k in L.buffers) L.buffers[k].needsUpdate = true;

    // 半透明水雾需要由远及近绘制
    const S = this.spray;
    sprays.sort((a, b) => {
      const da = (a[0] - camPos.x) ** 2 + (a[2] - camPos.z) ** 2;
      const db = (b[0] - camPos.x) ** 2 + (b[2] - camPos.z) ** 2;
      return db - da;
    });
    const m = Math.min(sprays.length, S.capacity);
    const sPos = S.buffers.sPos.array;
    const sPar = S.buffers.sPar.array;
    for (let i = 0; i < m; i++) {
      const sp = sprays[i];
      sPos.set([sp[0], sp[1], sp[2]], i * 3);
      sPar.set([sp[3], sp[4], sp[5]], i * 3);
    }
    S.geo.instanceCount = m;
    S.buffers.sPos.needsUpdate = true;
    S.buffers.sPar.needsUpdate = true;
  }
}
