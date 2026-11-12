import * as THREE from 'three';
import { ROAD, CAR, QUALITY, QUALITY_KEYS, MAX_DROPS } from './config.js';
import { G } from './core/globals.js';
import { roadState, setOrigin, roadX } from './core/roadmath.js';
import { makeNoiseTexture } from './core/noise.js';
import { Pipeline } from './core/pipeline.js';
import { Environment } from './core/env.js';
import { AudioEngine } from './core/audio.js';
import { Input } from './core/input.js';
import { Placer } from './world/materials.js';
import { createRoad } from './world/road.js';
import { createProps } from './world/props.js';
import { createSky } from './world/sky.js';
import { Traffic } from './world/traffic.js';
import { createRain } from './world/rain.js';
import { Vehicle } from './car/vehicle.js';
import { loadCarModel } from './car/model.js';
import { createCabin } from './car/cabin.js';
import { createExterior } from './car/exterior.js';
import { Wipers, WIPER_LABELS } from './car/wipers.js';
import { createDropSims } from './car/dropsim.js';
import { createMirrors } from './car/mirrors.js';

const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const DEG = Math.PI / 180;

function fatal(msg) {
  const el = $('fatal');
  el.textContent = msg;
  el.hidden = false;
  $('intro').classList.add('gone');
}

// 调试用的地址栏参数：?autostart&warp=20&t=night&rain=3&q=high&look=-30,5&manual
// 画质平时用预设（开始页 / Q 键）；?scale= ?ws= ?msaa= ?drops= 可以单独覆盖预设里的某一项
const params = new URLSearchParams(location.search);

async function main() {
  const canvas = $('view');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'high-performance' });
  } catch (e) {
    fatal('无法创建 WebGL2 上下文。\n请使用较新的 Chrome / Edge，并确认已开启硬件加速。');
    return;
  }
  // 车模读完之前不能开始
  const startBtn = $('start');
  const startLabel = startBtn.textContent;
  startBtn.disabled = true;
  startBtn.textContent = '正在加载车模…';
  const model = await loadCarModel();
  startBtn.disabled = false;
  startBtn.textContent = startLabel;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  // ------------------------------------------------------------------ 场景搭建
  G.tNoise.value = makeNoiseTexture(renderer);
  const syncRoad = () => {
    G.uRoadPh.value.set(roadState.ph[0], roadState.ph[1], 0, 0);
    G.uOriginZ.value = roadState.originZ;
  };
  setOrigin(0);
  syncRoad();

  const world = new THREE.Scene(); // 车外的一切
  const cabinScene = new THREE.Scene(); // 车内（最后叠在外景上）

  const placer = new Placer();
  const road = createRoad(placer);
  world.add(road.mesh);
  world.add(createProps(renderer, placer));
  world.add(createSky());
  const traffic = new Traffic();
  world.add(traffic.group);
  const rain = createRain(Math.max(MAX_DROPS, Number(params.get('drops')) || 0));
  world.add(rain.mesh);

  const carGroup = new THREE.Group(); // 自车外部（车身、雨刮、外后视镜）
  carGroup.add(createExterior(model));
  const wipers = new Wipers();
  carGroup.add(wipers.group);
  world.add(carGroup);

  const cabin = createCabin(model);
  cabinScene.add(cabin.group);
  const dropSims = createDropSims(renderer, cabin.glass);
  const mirrors = createMirrors(model);
  cabin.group.add(mirrors.interior);
  carGroup.add(mirrors.exterior);
  const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, 1);
  cabinScene.add(hemi);
  // 两盏带阴影的平行光，分别跟踪车前、车后最近的一盏路灯：
  // 驶过路灯时 A 柱和后视镜的影子会从仪表台上扫过去
  const lampLights = [0, 1].map(() => {
    const l = new THREE.DirectionalLight(0xffffff, 0);
    l.castShadow = true;
    l.shadow.autoUpdate = false; // 只有这盏灯够亮时才更新它的阴影贴图
    l.shadow.mapSize.set(768, 768);
    l.shadow.camera.left = -1.5;
    l.shadow.camera.right = 1.5;
    l.shadow.camera.top = 1.5;
    l.shadow.camera.bottom = -1.5;
    l.shadow.camera.near = 1;
    l.shadow.camera.far = 16;
    l.shadow.bias = -0.0012;
    l.shadow.normalBias = 0.012;
    l.shadow.radius = 3;
    cabinScene.add(l, l.target);
    return l;
  });

  const camera = new THREE.PerspectiveCamera(52, 1, 0.08, 4000);
  camera.layers.enable(1);
  camera.layers.enable(2);

  const pipeline = new Pipeline(renderer);
  if (params.has('prof')) pipeline.prof = {};
  const vehicle = new Vehicle();
  const env = new Environment(params.get('t') || 'dusk', params.has('rain') ? clamp(Number(params.get('rain')), 0, 3) : 2);
  const audio = new AudioEngine();
  const input = new Input();
  if (params.has('manual')) vehicle.setAuto(false);
  if (params.has('wiper')) wipers.mode = params.get('wiper');
  traffic.reset(vehicle);

  env.onThunder = (delay, strength) => audio.thunder(delay, strength);
  wipers.onEvent = (type, dur) => audio.wiper(type, dur);

  // ------------------------------------------------------------------ 尺寸与动态分辨率
  const fixedScale = Number(params.get('scale')) || 0;
  let dynScale = 1;
  let quality = QUALITY.mid;
  let qualityKey = 'mid';
  function resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const pr = fixedScale || Math.min(window.devicePixelRatio || 1, quality.pixelRatio) * dynScale;
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    const bw = Math.floor(w * pr);
    const bh = Math.floor(h * pr);
    pipeline.setSize(bw, bh);
    camera.aspect = w / h;
    // 竖屏或很窄的窗口适当加大视角
    camera.fov = camera.aspect < 1.2 ? 66 : 52;
    camera.updateProjectionMatrix();
    G.uPixelAngle.value = (2 * Math.tan((camera.fov * DEG) / 2)) / (bh * pipeline.worldScale);
  }
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------------ 画质预设
  const qualityButtons = [...document.querySelectorAll('#quality [data-q]')];
  function setQuality(key, remember = true) {
    if (!QUALITY[key]) key = 'mid';
    qualityKey = key;
    quality = QUALITY[key];
    dynScale = 1;
    pipeline.configure({
      msaa: params.has('msaa') ? Number(params.get('msaa')) || 0 : quality.msaa,
      worldScale: Number(params.get('ws')) || quality.world,
    });
    rain.setCount(Number(params.get('drops')) || quality.drops);
    dropSims.setResolution(params.has('sim') ? Number(params.get('sim')) || 0 : quality.sim);
    for (const l of lampLights) {
      l.castShadow = quality.shadow > 0;
      if (l.shadow.mapSize.x !== quality.shadow && quality.shadow > 0) {
        l.shadow.mapSize.set(quality.shadow, quality.shadow);
        l.shadow.map?.dispose(); // 换尺寸要重建阴影贴图
        l.shadow.map = null;
      }
    }
    for (const b of qualityButtons) b.setAttribute('aria-pressed', String(b.dataset.q === key));
    if (remember) {
      try {
        localStorage.setItem('rd.quality', key);
      } catch {
        /* 隐私模式下 localStorage 不可用，忽略 */
      }
    }
    resize();
  }
  for (const b of qualityButtons) b.addEventListener('click', () => setQuality(b.dataset.q));
  {
    let saved = null;
    try {
      saved = localStorage.getItem('rd.quality');
    } catch {
      /* 同上 */
    }
    setQuality(params.get('q') || saved || 'mid', false);
  }

  // ------------------------------------------------------------------ 提示文字
  const toastEl = $('toast');
  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }
  const helpEl = $('help');
  helpEl.textContent = [
    'W / S     加速 / 刹车（巡航时调车速）',
    'A / D     转向（巡航时变道）',
    'F         自动巡航 开/关',
    'E         雨刮档位',
    'R         雨量',
    'T         傍晚 / 夜晚 / 白天',
    'L         远光灯',
    'Q         画质：低 / 中 / 高 / 极高',
    'K         来一道闪电',
    'PgUp/PgDn 座椅升 / 降',
    'M         静音      H  关闭帮助',
  ].join('\n');

  let highBeam = false;
  let started = false;
  // 座椅高度微调（相对默认坐姿，米）。坐多高是很主观的事，所以记在本机，下次打开还是这个高度
  let seatDy = 0;
  try {
    seatDy = clamp(Number(localStorage.getItem('rd.seat')) || 0, -0.06, 0.08);
  } catch {
    /* 隐私模式下 localStorage 不可用，忽略 */
  }
  const adjustSeat = (d) => {
    seatDy = clamp(Math.round((seatDy + d) * 100) / 100, -0.06, 0.08);
    try {
      localStorage.setItem('rd.seat', String(seatDy));
    } catch {
      /* 同上 */
    }
    const cm = Math.round(seatDy * 100);
    toast(`座椅高度 ${cm > 0 ? '+' : ''}${cm} cm`);
  };

  input.onPress = (code) => {
    if (!started) {
      if (code === 'Enter' || code === 'Space') start();
      return;
    }
    switch (code) {
      case 'KeyF':
        vehicle.setAuto(!vehicle.auto);
        toast(vehicle.auto ? `自动巡航：开 · ${Math.round(vehicle.cruise * 3.6)} km/h` : '自动巡航：关 · 手动驾驶');
        break;
      case 'KeyE':
        toast(`雨刮：${WIPER_LABELS[wipers.cycleMode()]}`);
        break;
      case 'KeyR':
        toast(`雨量：${env.cycleRain()}`);
        break;
      case 'KeyT':
        toast(`时间：${env.cycleTime()}`);
        break;
      case 'KeyL':
        highBeam = !highBeam;
        toast(`远光灯：${highBeam ? '开' : '关'}`);
        break;
      case 'KeyK':
        env.triggerLightning();
        break;
      case 'KeyQ':
        setQuality(QUALITY_KEYS[(QUALITY_KEYS.indexOf(qualityKey) + 1) % QUALITY_KEYS.length]);
        toast(`画质：${quality.name}`);
        break;
      case 'KeyM':
        audio.setMuted(!audio.muted);
        toast(audio.muted ? '已静音' : '声音：开');
        break;
      case 'KeyH':
        helpEl.hidden = !helpEl.hidden;
        break;
      case 'PageUp':
        adjustSeat(0.01);
        break;
      case 'PageDown':
        adjustSeat(-0.01);
        break;
      case 'KeyA':
      case 'ArrowLeft':
      case 'KeyD':
      case 'ArrowRight':
        if (vehicle.auto) {
          const dir = code === 'KeyA' || code === 'ArrowLeft' ? -1 : 1;
          const before = vehicle.targetLane;
          if (!vehicle.changeLane(dir, traffic) && before + dir >= 0 && before + dir < ROAD.LANES) {
            toast(dir < 0 ? '左侧有车，暂不变道' : '右侧有车，暂不变道');
          }
        }
        break;
      default:
    }
  };

  function start() {
    if (started) return;
    started = true;
    $('intro').classList.add('gone');
    audio.start();
    canvas.focus();
    setTimeout(() => toast('自动巡航中 · A/D 变道 · F 接管方向盘 · H 帮助'), 1400);
  }
  $('start').addEventListener('click', start);
  if (params.has('autostart')) {
    started = true;
    $('intro').classList.add('gone');
  }

  // ------------------------------------------------------------------ 每帧状态
  let time = 0;
  let slideFront = 0;
  let slideDown = 0;
  let slideBack = 0;
  let slideSign = 1;
  let lookYaw = 0;
  let lookPitch = -3.5 * DEG;
  let bounceY = 0;
  let bounceV = 0;
  let lastJoint = null;
  let blinkT = 0;
  let blinkOn = false;
  let gear = 1;
  let rpm = 1000;
  const GEAR_TOP = [5, 9.5, 14.5, 20.5, 27.5, 36, 80]; // 各档的最高车速 (m/s)

  const carMatrix = new THREE.Matrix4();
  const carQuat = new THREE.Quaternion();
  const carPos = new THREE.Vector3();
  const carFwd = new THREE.Vector3();
  const carVel = new THREE.Vector3();
  const wind = new THREE.Vector3();
  const tmpV = new THREE.Vector3();
  const tmpQ = new THREE.Quaternion();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const fixedLook = params.has('look') ? params.get('look').split(',').map(Number) : null;

  function simulate(dt) {
    time += dt;
    G.uTime.value = time;
    env.update(dt);
    vehicle.update(dt, input, traffic);

    // ---- 浮动原点：每开出 2.4 公里把所有东西往回挪一次
    if (vehicle.z < -ROAD.REBASE / 2) {
      vehicle.z += ROAD.REBASE;
      traffic.shiftZ(ROAD.REBASE);
      setOrigin(roadState.originZ - ROAD.REBASE);
      syncRoad();
    }
    placer.update(vehicle.z);

    // ---- 伸缩缝：前轴压过时车身一抖
    const jointIdx = Math.floor((vehicle.z + roadState.originZ - CAR.WHEELBASE / 2) / ROAD.JOINT_S);
    if (lastJoint !== null && jointIdx !== lastJoint && vehicle.speed > 3) {
      const k = clamp(vehicle.speed / 25, 0.3, 1);
      bounceV += 0.045 * k;
      audio.joint(CAR.WHEELBASE / vehicle.speed, k);
    }
    lastJoint = jointIdx;
    if (vehicle.bump > 0.05) {
      audio.crash(vehicle.bump);
      bounceV += 0.1 * vehicle.bump;
    }
    // 车身垂向的弹簧阻尼
    bounceV += (-bounceY * 260 - bounceV * 16) * dt;
    bounceY += bounceV * dt;

    // ---- 车身姿态：加减速点头、过弯侧倾、路面细碎振动
    const vib = clamp(vehicle.speed / 30, 0, 1);
    const shake = (Math.sin(time * 61.3) + Math.sin(time * 37.7 + 1.3)) * 0.0006 * vib + vehicle.scrape * Math.sin(time * 90) * 0.004;
    carPos.set(vehicle.x, bounceY + shake, vehicle.z);
    euler.set(vehicle.accel * 0.0042 + bounceV * 0.02, vehicle.yaw, -vehicle.latAcc * 0.006 + shake * 0.6);
    carQuat.setFromEuler(euler);
    carMatrix.compose(carPos, carQuat, tmpV.set(1, 1, 1));
    carGroup.position.copy(carPos);
    carGroup.quaternion.copy(carQuat);
    cabin.group.position.copy(carPos);
    cabin.group.quaternion.copy(carQuat);
    carFwd.set(0, 0, -1).applyQuaternion(carQuat);
    carVel.copy(carFwd).multiplyScalar(vehicle.speed);

    // ---- 驾驶员的头：鼠标控制环顾，过弯时略微看向弯心，惯性让头前后左右晃一点
    const tYaw = fixedLook ? fixedLook[0] * DEG : -Math.sign(input.look.x) * Math.abs(input.look.x) ** 1.6 * 82 * DEG + vehicle.steer * 0.7;
    const tPitch = fixedLook ? (fixedLook[1] ?? -3.5) * DEG : -3.5 * DEG + Math.sign(input.look.y) * Math.abs(input.look.y) ** 1.4 * 24 * DEG;
    const lk = 1 - Math.exp(-dt / 0.11);
    lookYaw += (tYaw - lookYaw) * lk;
    lookPitch += (tPitch - lookPitch) * lk;
    tmpV.set(CAR.EYE[0] + vehicle.latAcc * 0.004, CAR.EYE[1] + seatDy - bounceY * 0.35 + Math.sin(time * 0.9) * 0.0015, CAR.EYE[2] + vehicle.accel * 0.006);
    mirrors.update(carMatrix, tmpV); // 三面后视镜按眼睛位置重算反射视角
    camera.position.copy(tmpV).applyMatrix4(carMatrix);
    euler.set(lookPitch, lookYaw, 0);
    camera.quaternion.copy(carQuat).multiply(tmpQ.setFromEuler(euler));
    camera.updateMatrixWorld();

    // ---- 大灯
    G.uHeadPos.value.set(0, CAR.HEAD_Y, CAR.HEAD_Z).applyMatrix4(carMatrix);
    G.uHeadDir.value.copy(carFwd).add(tmpV.set(0, -0.018, 0)).normalize();
    G.uHeadColor.value.setRGB(0.93, 0.96, 1.0).multiplyScalar(env.cur.head);
    G.uHighBeam.value += ((highBeam ? 1 : 0) - G.uHighBeam.value) * Math.min(1, dt * 10);

    traffic.update(dt, { z: vehicle.z, u: vehicle.u, speed: vehicle.speed }, camera.position);

    // ---- 雨丝：带一点阵风
    wind.set(1.6 + Math.sin(time * 0.31) * 1.1, 0, 0.9 + Math.sin(time * 0.23 + 2.0) * 0.8);
    rain.update(dt, carPos, carFwd, carVel, wind, clamp(env.rain * 1.1, 0.05, 1));

    // ---- 雨刮与车窗水珠的流动
    wipers.update(time, env.rain);
    wipers.applyTo(cabin.glass.front);
    const v = vehicle.speed;
    dropSims.update(dt, env.rain, v, wipers);
    // 前挡：低速时水珠往下淌，超过约 30km/h 被气流顶着往上爬
    const rateF = clamp(0.25 - v * 0.03, -0.9, 0.25);
    slideFront += rateF * dt;
    if (Math.abs(rateF) > 0.02) slideSign = Math.sign(rateF);
    cabin.glass.front.uniforms.uSlideA.value.set(0, -1, slideFront, 1);
    cabin.glass.front.uniforms.uSlideSign.value.set(slideSign, 1);
    // 侧窗：低速往下，高速被吹成横向往后
    const wAir = smoothstep(5, 19, v);
    slideDown += (0.05 + 0.28 * (1 - wAir)) * dt;
    slideBack += v * 0.02 * dt;
    cabin.glass.left.uniforms.uSlideA.value.set(0, -1, slideDown, 1 - wAir * 0.85);
    cabin.glass.left.uniforms.uSlideB.value.set(-0.989, -0.148, slideBack, wAir);
    cabin.glass.right.uniforms.uSlideA.value.set(0, -1, slideDown, 1 - wAir * 0.85);
    cabin.glass.right.uniforms.uSlideB.value.set(0.989, -0.148, slideBack, wAir);
    cabin.glass.rear.uniforms.uSlideA.value.set(0, -1, slideDown, 1);

    // ---- 车内光照
    const flash = 1 + env.flash * 7;
    hemi.color.copy(G.uSkyAmb.value);
    hemi.groundColor.copy(G.uGndAmb.value).multiplyScalar(0.4);
    hemi.intensity = Math.PI * 0.65 * flash * env.cur.cabin;
    cabin.skyFill.color.copy(G.uSkyAmb.value);
    cabin.skyFill.intensity = Math.PI * 0.8 * flash * env.cur.cabin;
    const S = ROAD.LAMP_S;
    const ks = [Math.ceil(vehicle.z / S), Math.floor(vehicle.z / S)];
    lampLights.forEach((l, i) => {
      const lz = ks[i] * S;
      tmpV.set(roadX(lz) + ROAD.LAMP_U - carPos.x, ROAD.LAMP_H - 1.1, lz - carPos.z);
      const d2 = tmpV.lengthSq();
      tmpV.normalize();
      const att = (Math.max(tmpV.y, 0) ** 1.3 / (d2 + 2)) * 130;
      l.color.copy(G.uLampColor.value);
      l.intensity = Math.PI * att * 0.7 * (i === 1 && ks[0] === ks[1] ? 0 : 1);
      l.target.position.set(carPos.x, carPos.y + 1.1, carPos.z);
      l.position.copy(l.target.position).addScaledVector(tmpV, 8);
      l.shadow.needsUpdate = l.intensity > 0.04;
    });
    for (const sc of cabin.screens) sc.material.color.setScalar(env.cur.screens * sc.gain);

    // ---- 方向盘（约 14:1 的转向比）
    cabin.wheel.rotation.z = vehicle.steer * 14;

    // ---- 变速箱 / 转速（给仪表和发动机声用）
    if (gear < 7 && v > GEAR_TOP[gear - 1]) gear++;
    if (gear > 1 && v < GEAR_TOP[gear - 2] - 1.2) gear--;
    const lo = gear > 1 ? GEAR_TOP[gear - 2] - 1.2 : 0;
    const targetRpm = 900 + clamp((v - lo) / (GEAR_TOP[gear - 1] - lo), 0, 1) * 1500 + vehicle.throttle * 350;
    rpm += (targetRpm - rpm) * Math.min(1, dt * 5);

    // ---- 转向灯
    if (vehicle.blinker !== 0) {
      blinkT -= dt;
      if (blinkT <= 0) {
        blinkOn = !blinkOn;
        blinkT = 0.37;
        audio.blinker(blinkOn);
      }
    } else {
      blinkOn = false;
      blinkT = 0;
    }

    if (vehicle.cruiseChanged) {
      vehicle.cruiseChanged = false;
      if (started) toast(`巡航车速 ${Math.round(vehicle.cruise * 3.6)} km/h`);
    }

    cabin.cluster.update(dt, {
      speed: v,
      rpm,
      gear: 'D',
      auto: vehicle.auto,
      cruise: vehicle.cruise,
      wiper: wipers.mode,
      headlight: true,
      highBeam,
      rain: env.rain,
      blinker: vehicle.blinker,
      blinkOn,
      temp: 16,
    });
    cabin.screen.update(dt);

    audio.update({
      speed: v,
      rain: env.rain,
      rpm,
      throttle: vehicle.throttle,
      passGain: traffic.passby.gain,
      passPan: traffic.passby.pan,
      scrape: vehicle.scrape,
    });
  }

  function render() {
    dropSims.render();
    pipeline.render({
      world,
      cabin: cabinScene,
      camera,
      mirrors: mirrors.list,
      roadMaterial: road.material,
      glassMaterials: Object.values(cabin.glass),
      bgMaterial: cabin.matBg,
      exposure: env.cur.exposure,
      bloom: env.cur.bloom,
    });
  }

  // 调试句柄：控制台里 __rd.paused = true 可以冻结画面
  const debug = (window.__rd = { paused: false });

  // 调试：先空跑一段时间再出第一帧
  const warp = Number(params.get('warp')) || 0;
  for (let i = 0; i < warp * 30; i++) simulate(1 / 30);

  // ------------------------------------------------------------------ 主循环
  let last = performance.now();
  let slowT = 0;
  let fastT = 0;
  let avg = 16;
  let ceiling = 1; // 试过会卡的分辨率档位，短时间内不再往上试
  let ceilingT = 0;
  function frame(now) {
    const raw = (now - last) / 1000;
    last = now;
    const dt = Math.min(raw, 0.05);
    if (!debug.paused) simulate(dt);
    render();

    // 动态分辨率：掉到约 50 帧以下就降一档；稳稳跑满一阵子后再试着升回去
    if (!fixedScale && quality.dynamic && !debug.paused) {
      avg += (raw * 1000 - avg) * 0.05;
      slowT = avg > 19.5 ? slowT + raw : 0;
      fastT = avg < 17.4 ? fastT + raw : 0;
      ceilingT -= raw;
      const limit = ceilingT > 0 ? ceiling - 0.03 : 1;
      if (slowT > 1.5 && dynScale > 0.55) {
        ceiling = dynScale;
        ceilingT = 60;
        dynScale = Math.max(0.55, dynScale * 0.87);
        slowT = 0;
        resize();
      } else if (fastT > 8 && dynScale < limit) {
        dynScale = Math.min(limit, dynScale * 1.08);
        fastT = 0;
        resize();
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  Object.assign(debug, { renderer, world, cabinScene, camera, vehicle, traffic, env, wipers, pipeline, audio, G, simulate, render, setQuality, dropSims });
}

main().catch((e) => {
  console.error(e);
  fatal(`启动失败：${e.message}`);
});
