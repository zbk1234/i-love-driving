import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CAR, CAN } from '../config.js';

// 读入车模，转到车体局部坐标（车头朝 -Z，原点在轴距中心的地面），再按用途把零件分拣好：
//   body      车身 + 内饰（车内场景用）
//   wheel     方向盘（要能转）
//   screens   主驾仪表屏、中控屏（换成实时画的贴图）
//   glass     全部车窗（换成雨滴着色器）
//   mirrors   三面后视镜的镜片（换成真的反射）
//   can       杯托里的饮料罐（另一个模型，摆到杯托里）
// 分拣靠的是模型里的节点名和材质名，换别的模型时改这几张表就行。

// 车窗：前挡、四扇门玻璃、两块后三角窗（同一个网格）、尾门玻璃。全景天窗不算，当成深色顶棚
const NODES_GLASS = new Set(['Body010', 'DoorFrLeft002', 'DoorFrRight002', 'DoorRearLeft001', 'DoorRearRight001', 'Body020', 'DoorBack012']);
// 方向盘：轮缘、轮辐、中间的饰板和按键（后面那根横着的拨杆座不跟着转）
const NODES_WHEEL = new Set(['Dash002', 'Dash015', 'Dash019', 'Dash020']);
// 四个车轮整个在车身底下，车内车外都看不到
const SKIP = (node) => node.startsWith('Wheel');
const MAT_MIRROR = 'Mirror';
// 两块屏共用一个材质、一张贴图：按左右位置分开，主驾那块在方向盘后面
const MAT_SCREEN = 'Display';
const screenKey = (x) => (x < -0.2 ? 'cluster' : 'center');
// 模型原点在前轴附近的地面以下：车头朝 +Z，转 180° 后再挪到轴距中心的地面
const OFFSET = [0, 0.301, -1.195];

export async function loadCarModel() {
  const loader = new GLTFLoader();
  const [gltf, can] = await Promise.all([CAR.MODEL, CAN.MODEL].map((f) => loader.loadAsync(import.meta.env.BASE_URL + f)));
  const root = gltf.scene;
  root.rotation.y = Math.PI;
  root.position.set(...OFFSET);
  root.updateMatrixWorld(true);

  const model = { body: [], wheel: [], screens: {}, glass: null, mirrors: null };
  const glass = [];
  const mirrors = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const node = o.parent === root ? o.name : o.parent.name;
    if (SKIP(node)) return;
    const geometry = o.geometry;
    geometry.applyMatrix4(o.matrixWorld);
    const part = { geometry, material: o.material, name: o.material.name, node };
    if (NODES_GLASS.has(node)) glass.push(geometry);
    else if (part.name === MAT_MIRROR) mirrors.push(geometry);
    else if (part.name === MAT_SCREEN) Object.assign(model.screens, splitScreens(geometry));
    else if (NODES_WHEEL.has(node)) model.wheel.push(part);
    else model.body.push(part);
  });
  if (!glass.length || !mirrors.length) throw new Error('车模里没找到车窗或后视镜');
  model.glass = mergePositions(glass);
  model.mirrors = mergePositions(mirrors);
  model.can = placeCan(can.scene);
  return model;
}

// 饮料罐：缩放到真实大小，罐底中心落在杯托底面上，再转一下让商标朝着驾驶员
function placeCan(scene) {
  let mesh = null;
  scene.traverse((o) => {
    if (o.isMesh && !mesh) mesh = o;
  });
  scene.updateMatrixWorld(true);
  const geometry = mesh.geometry.applyMatrix4(mesh.matrixWorld);
  geometry.computeBoundingBox();
  const { min, max } = geometry.boundingBox;
  const s = CAN.H / (max.y - min.y);
  geometry.translate(-(min.x + max.x) / 2, -min.y, -(min.z + max.z) / 2);
  geometry.scale(s, s, s);
  geometry.rotateY(CAN.YAW);
  geometry.translate(...CAN.POS);
  return { geometry, material: mesh.material };
}

// 取出几何体里的三角形顶点（展开索引），返回 Float32Array
export function trianglePositions(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  return new Float32Array(g.attributes.position.array);
}

// 几块网格只取顶点位置拼成一个（车窗、镜片只用得到位置）
function mergePositions(list) {
  const arrays = list.map(trianglePositions);
  const out = new Float32Array(arrays.reduce((n, a) => n + a.length, 0));
  let k = 0;
  for (const a of arrays) {
    out.set(a, k);
    k += a.length;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g;
}

// 屏幕网格按三角形重心分成两块，各自的 uv 拉满 0..1（原来两块挤在同一张贴图的不同角落），
// 这样每块屏可以单独用一张画布
function splitScreens(geometry) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position.array;
  const uv = g.attributes.uv.array;
  const parts = {};
  for (let t = 0; t < pos.length / 9; t++) {
    const key = screenKey((pos[t * 9] + pos[t * 9 + 3] + pos[t * 9 + 6]) / 3);
    const p = (parts[key] ||= { pos: [], uv: [] });
    p.pos.push(...pos.subarray(t * 9, t * 9 + 9));
    p.uv.push(...uv.subarray(t * 6, t * 6 + 6));
  }
  const out = {};
  for (const [key, p] of Object.entries(parts)) {
    const us = p.uv.filter((_, i) => i % 2 === 0);
    const vs = p.uv.filter((_, i) => i % 2 === 1);
    const [u0, u1, v0, v1] = [Math.min(...us), Math.max(...us), Math.min(...vs), Math.max(...vs)];
    const uvs = p.uv.map((v, i) => (i % 2 === 0 ? (v - u0) / (u1 - u0) : (v - v0) / (v1 - v0)));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    out[key] = geo;
  }
  return out;
}
