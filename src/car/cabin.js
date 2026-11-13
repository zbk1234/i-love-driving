import * as THREE from 'three';
import { CAR } from '../config.js';
import { createGlassGeometries, createGlassMaterial } from './glass.js';
import { Cluster, CenterScreen } from './cluster.js';

// 驾驶舱（左舵）：车身和内饰来自车模，这里负责换材质、接上会动的部分——
// 方向盘、仪表和屏幕（实时画的贴图）、车窗（雨滴着色器）。

// 整车有 50 多万个三角形，其中一大半从驾驶位永远看不到，画它们纯属浪费（集显上尤其明显）：
// 车漆、车灯、灯罩、牌照——这些只在外景通道里画看得见的那一小部分（见 exterior.js）
const OUTSIDE = new Set(['body', 'Light', 'glass', 'white']);
// 这几种材质车内车外都有（窗框饰条、镀铬件、亮黑饰板），车内要画，但不用它们投影：顶棚和立柱的内饰板已经把光挡住了
const NO_SHADOW = new Set(['chrome_d', 'black_shiny', 'vd_glass']);
// 座椅、后门、尾门：三角形很多（座椅就有 9 万多），影子只落在地板和后排，从驾驶位几乎看不到，也不投影
const NO_SHADOW_NODE = /^(Seats|DoorRear|DoorBack)/;
// 外后视镜的镜座和镜壳里的黑色件：在门玻璃外侧（|x| > 0.77），外景通道里已经有一份（会被镜壳正确挡住）。
// 车内通道里这一份平时被玻璃盖住看不见，车窗一降就压在外景上面成了黑块，所以从车内通道里去掉
const outsideMirror = (x, y, z) => Math.abs(x) > 0.77 && y > 0.95 && y < 1.17 && z > -0.8 && z < -0.4;
// 地板以下（底盘、保险杠下沿、排气、悬挂）：车里怎么转头都看不到
const underFloor = (x, y) => y < 0.33;

// 去掉重心落在 test 里的三角形；一个都没有就原样返回（外景通道也用这份几何，不能改它）
function dropTriangles(geometry, test) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position.array;
  const keep = [];
  for (let i = 0; i < pos.length; i += 9) {
    const c = (k) => (pos[i + k] + pos[i + 3 + k] + pos[i + 6 + k]) / 3;
    if (!test(c(0), c(1), c(2))) keep.push(i / 9);
  }
  if (keep.length * 9 === pos.length) return geometry;
  const out = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) {
    const n = attr.itemSize * 3;
    const arr = new attr.array.constructor(keep.length * n);
    keep.forEach((t, j) => arr.set(attr.array.subarray(t * n, t * n + n), j * n));
    out.setAttribute(name, new THREE.BufferAttribute(arr, attr.itemSize, attr.normalized));
  }
  return out;
}

// 假的环境光遮蔽：越靠近地板越暗（光只从车窗进来），烘焙成顶点色
function bakeOcclusion(geometry) {
  const pos = geometry.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = Math.min(1, Math.max(0, (pos.getY(i) - 0.3) / 0.65));
    col.fill(0.3 + 0.7 * t * t * (3 - 2 * t), i * 3, i * 3 + 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

export function createCabin(model) {
  const group = new THREE.Group();
  for (const part of [...model.body, ...model.wheel]) bakeOcclusion(part.geometry);

  // ------------------------------------------------------------ 车身 + 内饰
  const cache = new Map();
  // 内饰都是哑光的（集显上 Lambert 比 PBR 便宜很多），只有方向盘的皮革保留一点高光
  const convert = (src, leather = false) => {
    if (cache.has(src)) return cache.get(src);
    // 车身外壳是单面建模的，从车里看到的是背面，所以一律双面。
    // 半透明的全景天窗当成不透光的深色顶棚（外面的天光由 skyFill 补）
    const opts = { color: src.color, map: src.map, side: THREE.DoubleSide, vertexColors: true };
    const m = leather ? new THREE.MeshStandardMaterial({ ...opts, roughness: 0.6 }) : new THREE.MeshLambertMaterial(opts);
    m.name = src.name;
    cache.set(src, m);
    return m;
  };
  const addPart = (part, parent, leather, geometry = part.geometry) => {
    const m = new THREE.Mesh(geometry, convert(part.material, leather));
    m.castShadow = !NO_SHADOW.has(part.name) && !NO_SHADOW_NODE.test(part.node);
    m.receiveShadow = true;
    parent.add(m);
    return m;
  };
  const hidden = (x, y, z) => outsideMirror(x, y, z) || underFloor(x, y);
  for (const part of model.body) if (!OUTSIDE.has(part.name)) addPart(part, group, false, dropTriangles(part.geometry, hidden));

  // ------------------------------------------------------------ 方向盘：绕转向柱的轴线转
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(...CAR.WHEEL_C);
  wheelPivot.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(...CAR.WHEEL_AXIS).normalize());
  wheelPivot.updateMatrix();
  group.add(wheelPivot);
  const wheel = new THREE.Group();
  wheelPivot.add(wheel);
  const toPivot = wheelPivot.matrix.clone().invert();
  for (const part of model.wheel) {
    part.geometry.applyMatrix4(toPivot);
    addPart(part, wheel, true);
  }

  // ------------------------------------------------------------ 杯托里的饮料罐
  // 铝罐本来是全金属材质，可车里没有环境贴图，纯金属会黑成一片：金属度压低，让它和内饰一样吃车内的光。
  // 罐子有 30 多万个三角形，又在杯托里，不让它投影（省掉阴影通道里的开销）
  {
    bakeOcclusion(model.can.geometry);
    const m = model.can.material;
    m.vertexColors = true;
    m.metalness = 0.35;
    const can = new THREE.Mesh(model.can.geometry, m);
    can.receiveShadow = true;
    group.add(can);
  }

  // ------------------------------------------------------------ 主驾仪表屏 / 中控屏（自发光）
  const cluster = new Cluster();
  const screen = new CenterScreen();
  const screens = [];
  const addScreen = (key, texture, gain) => {
    if (!model.screens[key]) return;
    const material = new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    group.add(new THREE.Mesh(model.screens[key], material));
    screens.push({ material, gain });
  };
  // 仪表是浅色主题，整屏都亮，亮度比深色的中控屏压低不少，不然白天会糊成一片白
  addScreen('cluster', cluster.texture, 0.42);
  addScreen('center', screen.texture, 0.75);

  // ------------------------------------------------------------ 车窗玻璃（雨滴着色器）
  const glass = {
    front: createGlassMaterial({ wipers: true, lens: 0.11, tint: [0.84, 0.89, 0.87] }),
    // 侧窗的水膜比前挡没刮到的地方薄：水珠照旧，但不至于糊得看不清外后视镜
    left: createGlassMaterial({ lens: 0.1, tint: [0.72, 0.78, 0.76], wet: 0.5 }),
    right: createGlassMaterial({ lens: 0.1, tint: [0.72, 0.78, 0.76], wet: 0.5 }),
    rear: createGlassMaterial({ lens: 0.1, tint: [0.6, 0.65, 0.64], wet: 0.8 }),
  };
  const glassGeo = createGlassGeometries(model.glass);
  for (const key of Object.keys(glass)) {
    const m = new THREE.Mesh(glassGeo[key], glass[key]);
    m.renderOrder = 10; // 在内饰之后画：被方向盘、立柱挡住的玻璃像素不用跑昂贵的雨滴着色器
    group.add(m);
  }

  // ------------------------------------------------------------ 兜底背景：玻璃没盖住的缝隙直接显示外景
  const matBg = new THREE.ShaderMaterial({
    uniforms: { tScene: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }',
    fragmentShader: 'uniform sampler2D tScene; uniform vec2 uRes; void main() { gl_FragColor = vec4(texture2D(tScene, gl_FragCoord.xy / uRes).rgb, 1.0); }',
    depthWrite: false,
  });
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const m = new THREE.Mesh(g, matBg);
    m.frustumCulled = false;
    m.renderOrder = 20; // 最后画，贴在最远的深度上，只填没被任何东西盖住的像素
    group.add(m);
  }

  // ------------------------------------------------------------ 车内的几盏「灯」
  // 仪表的冷光打在方向盘和驾驶员一侧
  const clusterGlow = new THREE.PointLight(0x9fc6ff, 0.035, 1.3, 2);
  clusterGlow.position.set(CAR.EYE[0], 0.97, -0.5);
  group.add(clusterGlow);
  // 从前风挡照进来的天光
  const skyFill = new THREE.DirectionalLight(0xffffff, 0.3);
  skyFill.position.set(0, 3.2, -3.4);
  skyFill.target.position.set(0, 1.0, 0);
  group.add(skyFill, skyFill.target);

  return { group, wheel, cluster, screen, screens, glass, winDown: glassGeo.left.userData.down, matBg, clusterGlow, skyFill };
}
