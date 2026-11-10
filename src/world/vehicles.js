import { GeoBuilder, V3 } from './geo.js';

// 程序化车辆模型：把一串横截面沿车长放样成车身，再贴上车窗、车轮、车灯、车牌。
// 雨雾里主要靠轮廓和灯光，但旁边车道的车会离得很近，所以棱线、立柱、轮子这些要有。

const GLASS_C = [0.02, 0.025, 0.03];

export const PAINTS = [
  [0.55, 0.56, 0.57],
  [0.66, 0.66, 0.65],
  [0.02, 0.02, 0.025],
  [0.22, 0.23, 0.25],
  [0.04, 0.07, 0.17],
  [0.32, 0.03, 0.03],
  [0.42, 0.43, 0.45],
  [0.1, 0.11, 0.12],
];

// 每个截面站点：[沿车长位置 t(-1 车头..1 车尾), 半宽系数, 底部高度, 腰线高度, 车顶高度]
// tail: 尾灯 [x0, x1, y0, y1]；head: 大灯 [x, y]；pillars: B/C 柱位置；mirror: 外后视镜 [t, y]
export const SPECS = {
  sedan: {
    len: 4.7, wid: 1.82, tumble: 0.8, glassTop: 0.85, wheelR: 0.32, axles: [-0.6, 0.58],
    tail: [0.38, 0.72, 0.7, 0.84], head: [0.62, 0.66], top: 1.3, pillars: [0.16], mirror: [-0.3, 0.98],
    st: [
      [-1.0, 0.78, 0.38, 0.62, 0.62], [-0.96, 0.9, 0.24, 0.7, 0.7], [-0.8, 0.98, 0.2, 0.78, 0.78],
      [-0.42, 1.0, 0.2, 0.9, 0.9], [-0.36, 1.0, 0.2, 0.91, 0.99], [-0.1, 1.0, 0.2, 0.93, 1.4],
      [0.22, 1.0, 0.2, 0.94, 1.44], [0.42, 1.0, 0.2, 0.95, 1.38], [0.68, 1.0, 0.2, 0.97, 1.04],
      [0.74, 0.99, 0.2, 0.98, 0.98], [0.96, 0.92, 0.26, 0.96, 0.96], [1.0, 0.8, 0.42, 0.88, 0.88],
    ],
  },
  suv: {
    len: 4.75, wid: 1.9, tumble: 0.82, glassTop: 0.85, wheelR: 0.36, axles: [-0.6, 0.6],
    tail: [0.45, 0.78, 0.86, 1.0], head: [0.64, 0.8], top: 1.55, pillars: [0.1, 0.52], mirror: [-0.32, 1.14],
    st: [
      [-1.0, 0.8, 0.45, 0.75, 0.75], [-0.96, 0.92, 0.3, 0.86, 0.86], [-0.75, 0.99, 0.26, 0.98, 0.98],
      [-0.44, 1.0, 0.26, 1.06, 1.06], [-0.38, 1.0, 0.26, 1.07, 1.16], [-0.14, 1.0, 0.26, 1.08, 1.64],
      [0.3, 1.0, 0.26, 1.1, 1.68], [0.78, 1.0, 0.26, 1.12, 1.62], [0.95, 0.97, 0.28, 1.14, 1.3],
      [0.99, 0.94, 0.34, 1.1, 1.12], [1.0, 0.86, 0.5, 1.0, 1.0],
    ],
  },
  van: {
    len: 5.1, wid: 1.95, tumble: 0.9, glassTop: 0.8, wheelR: 0.34, axles: [-0.62, 0.6],
    tail: [0.74, 0.9, 0.9, 1.3], head: [0.66, 0.78], top: 1.75, rearGlass: [0.66, 1.25, 1.7], pillars: [-0.15, 0.4], mirror: [-0.55, 1.2],
    st: [
      [-1.0, 0.82, 0.45, 0.8, 0.8], [-0.95, 0.94, 0.28, 0.95, 0.95], [-0.72, 1.0, 0.25, 1.08, 1.12],
      [-0.48, 1.0, 0.25, 1.1, 1.8], [0.0, 1.0, 0.25, 1.12, 1.92], [0.9, 1.0, 0.25, 1.14, 1.9],
      [1.0, 0.97, 0.32, 1.14, 1.84],
    ],
  },
  bus: {
    len: 11.5, wid: 2.5, tumble: 0.97, glassTop: 0.55, wheelR: 0.5, axles: [-0.56, 0.52],
    tail: [0.85, 1.1, 0.8, 1.05], head: [0.9, 0.75], top: 2.9, rearGlass: [0.95, 1.9, 2.6], frontGlass: [1.0, 1.35, 2.5],
    pillars: [-0.72, -0.48, -0.24, 0, 0.24, 0.48, 0.72],
    st: [
      [-1.0, 0.96, 0.4, 1.25, 3.0], [-0.98, 1.0, 0.32, 1.25, 3.1], [0.98, 1.0, 0.32, 1.25, 3.1],
      [1.0, 0.97, 0.4, 1.25, 3.02],
    ],
  },
  truck: { len: 10.6, wid: 2.5, wheelR: 0.5, tail: [0.85, 1.15, 0.85, 1.02], head: [0.9, 0.85], top: 3.8 },
};

// 车身横截面（一圈 14 个点）：底板 → 裙边 → 车门 → 腰线 → 车窗 → 车顶，左右对称
function ringPoints(z, w, bot, belt, roof, tumble, glassTop) {
  const cabin = roof - belt > 0.08;
  const gy = belt + (roof - belt) * glassTop;
  const R = cabin
    ? [[0, bot], [w * 0.8, bot], [w, bot + 0.12], [w, belt - 0.1], [w * 0.975, belt], [w * (tumble + 0.03), gy], [w * (tumble - 0.06), roof], [0, roof + 0.025]]
    : [[0, bot], [w * 0.8, bot], [w, bot + 0.12], [w, belt - 0.1], [w * 0.975, belt], [w * 0.9, belt + 0.012], [w * 0.55, belt + 0.03], [0, belt + 0.04]];
  const pts = [];
  for (let k = 0; k < 8; k++) pts.push(V3(R[k][0], R[k][1], z));
  for (let k = 6; k >= 1; k--) pts.push(V3(-R[k][0], R[k][1], z));
  return pts;
}

// 在给定位置插入一对很近的截面，形成 B/C 柱（车窗之间的车身色立柱）
function withPillars(st, ts) {
  const out = st.map((r) => r.slice());
  const rowAt = (t) => {
    for (let i = 0; i < out.length - 1; i++) {
      const a = out[i];
      const b = out[i + 1];
      if (t >= a[0] && t <= b[0]) {
        const k = (t - a[0]) / (b[0] - a[0]);
        return a.map((v, j) => v + (b[j] - v) * k);
      }
    }
    return null;
  };
  for (const t of ts) {
    for (const tt of [t - 0.018, t + 0.018]) {
      const row = rowAt(tt);
      if (!row) continue;
      row[0] = tt;
      out.push(row);
      out.sort((x, y) => x[0] - y[0]);
    }
  }
  return out;
}

// 放样车身。沿车长方向法线平滑，横截面方向保持棱线——
// 这样车门、腰线、车窗、车顶是一块块分明的面，而不是一块肥皂。
function loftBody(b, stations, len, hw, tumble, glassTop, paint, z0 = 0, pillars = []) {
  const st = withPillars(stations, pillars);
  const rings = st.map(([t, wf, bot, belt, roof]) => ringPoints(z0 + (t * len) / 2, hw * wf, bot, belt, roof, tumble, glassTop));
  const cabin = st.map((s) => s[4] - s[3] > 0.08);
  const inPillar = (i) => pillars.some((t) => st[i][0] >= t - 0.019 && st[i + 1][0] <= t + 0.019);
  const ni = rings.length;
  const nj = rings[0].length;
  const mid = (i, j, j2) => V3().addVectors(rings[i][j], rings[i][j2]).multiplyScalar(0.5);
  for (let j = 0; j < nj; j++) {
    const j2 = (j + 1) % nj;
    const normals = [];
    for (let i = 0; i < ni; i++) {
      const dU = V3().subVectors(mid(Math.min(i + 1, ni - 1), j, j2), mid(Math.max(i - 1, 0), j, j2));
      const n = V3().subVectors(rings[i][j2], rings[i][j]).cross(dU);
      if (n.lengthSq() < 1e-10) n.set(0, 1, 0);
      normals.push(n.normalize());
    }
    for (let i = 0; i < ni - 1; i++) {
      let glass = false;
      if (cabin[i] || cabin[i + 1]) {
        const dz = (Math.abs(st[i + 1][0] - st[i][0]) * len) / 2;
        const slope = Math.abs(st[i + 1][4] - st[i][4]) / Math.max(dz, 1e-3);
        const sideGlass = (j === 4 || j === 9) && cabin[i] && cabin[i + 1] && !inPillar(i);
        const topGlass = j >= 5 && j <= 8 && slope > 0.35;
        glass = sideGlass || topGlass;
      }
      if (glass) b.color(...GLASS_C).data(1);
      else b.color(...paint).data(0);
      b.vert(rings[i][j], normals[i]);
      b.vert(rings[i + 1][j], normals[i + 1]);
      b.vert(rings[i + 1][j2], normals[i + 1]);
      b.vert(rings[i][j], normals[i]);
      b.vert(rings[i + 1][j2], normals[i + 1]);
      b.vert(rings[i][j2], normals[i]);
    }
  }
  b.color(...paint).data(0).emis(0);
  b.fan(rings[0]);
  b.fan(rings[rings.length - 1]);
}

// 贴在车身侧面的圆片（法线朝车外）
function disc(b, x, y, z, r, side, seg = 18) {
  const n = V3(side, 0, 0);
  const c = V3(x, y, z);
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * Math.PI * 2;
    const a1 = ((k + 1) / seg) * Math.PI * 2;
    b.vert(c, n);
    b.vert(V3(x, y + Math.sin(a0) * r, z + Math.cos(a0) * r), n);
    b.vert(V3(x, y + Math.sin(a1) * r, z + Math.cos(a1) * r), n);
  }
}

// 车轮：轮胎圆柱 + 贴在车身侧面的三层圆片（轮拱的黑缝、轮胎、轮毂），从侧面看就是一个完整的轮子
function addWheels(b, hw, r, zs, dual = false) {
  for (const z of zs) {
    for (const s of [-1, 1]) {
      const w = dual ? 0.5 : 0.24;
      b.color(0.015, 0.015, 0.017).data(3).emis(0);
      b.cyl(V3(s * (hw - 0.02), r, z), V3(s * (hw - 0.02 - w), r, z), r, r, 14, true, true);
      b.color(0.006, 0.006, 0.007).data(3);
      disc(b, s * (hw + 0.004), r + 0.01, z, r + 0.07, s);
      b.color(0.02, 0.02, 0.022).data(3);
      disc(b, s * (hw + 0.008), r, z, r, s);
      b.color(0.2, 0.2, 0.21).data(0);
      disc(b, s * (hw + 0.012), r, z, r * 0.62, s, 10);
    }
  }
}

function addLights(b, s, zf, zr) {
  const [tx0, tx1, ty0, ty1] = s.tail;
  const [hx, hy] = s.head;
  for (const side of [-1, 1]) {
    b.color(1.0, 0.04, 0.02).emis(1).data(0);
    b.quad(V3(side * tx0, ty0, zr), V3(side * tx1, ty0, zr), V3(side * tx1, ty1, zr), V3(side * tx0, ty1, zr));
    b.color(1.0, 0.95, 0.86).emis(2.5);
    b.quad(V3(side * (hx - 0.15), hy - 0.05, zf), V3(side * (hx + 0.15), hy - 0.05, zf), V3(side * (hx + 0.15), hy + 0.05, zf), V3(side * (hx - 0.15), hy + 0.05, zf));
  }
  b.emis(0);
  // 后保险杠下部的黑色饰板、前格栅
  const py = Math.max(ty0 - 0.3, 0.42);
  b.color(0.012, 0.012, 0.014).data(3);
  b.quad(V3(-tx1, py - 0.14, zr), V3(tx1, py - 0.14, zr), V3(tx1, py - 0.02, zr), V3(-tx1, py - 0.02, zr));
  b.quad(V3(-hx + 0.2, hy - 0.2, zf), V3(hx - 0.2, hy - 0.2, zf), V3(hx - 0.2, hy + 0.02, zf), V3(-hx + 0.2, hy + 0.02, zf));
  // 蓝底车牌（逆反射）
  b.color(0.03, 0.08, 0.42).data(2);
  b.quad(V3(-0.22, py, zr + 0.004), V3(0.22, py, zr + 0.004), V3(0.22, py + 0.14, zr + 0.004), V3(-0.22, py + 0.14, zr + 0.004));
  b.data(0);
}

export function buildVehicle(kind, paint) {
  const s = SPECS[kind];
  const b = new GeoBuilder();
  const hw = s.wid / 2;
  const zf = -s.len / 2 - 0.012;
  const zr = s.len / 2 + 0.012;

  if (kind === 'truck') {
    // 平头车头 + 厢体
    const cab = [[-1, 0.95, 0.6, 1.5, 2.7], [-0.9, 1.0, 0.45, 1.5, 2.85], [1, 1.0, 0.45, 1.5, 2.85]];
    loftBody(b, cab, 2.3, hw * 0.98, 0.97, 0.6, paint, -s.len / 2 + 1.15);
    b.color(...GLASS_C).data(1);
    b.quad(V3(-hw * 0.86, 1.6, zf), V3(hw * 0.86, 1.6, zf), V3(hw * 0.86, 2.42, zf), V3(-hw * 0.86, 2.42, zf));
    const bz0 = -s.len / 2 + 2.55;
    const bz1 = s.len / 2;
    b.color(0.03, 0.03, 0.035).data(3).box(0, 0.82, (bz0 + bz1) / 2 - 0.3, s.wid * 0.7, 0.4, bz1 - bz0 + 0.5);
    const cargo = [[0.4, 0.41, 0.4], [0.12, 0.18, 0.28], [0.36, 0.1, 0.08], [0.45, 0.43, 0.38]][Math.floor(Math.random() * 4)];
    b.color(...cargo).data(4).box(0, 2.45, (bz0 + bz1) / 2, s.wid, 2.7, bz1 - bz0);
    // 车尾红白反光条
    for (let k = 0; k < 8; k++) {
      const x0 = -hw + (k * s.wid) / 8;
      b.color(...(k % 2 ? [0.85, 0.85, 0.85] : [0.8, 0.06, 0.05])).data(2);
      b.quad(V3(x0, 1.12, zr), V3(x0 + s.wid / 8, 1.12, zr), V3(x0 + s.wid / 8, 1.22, zr), V3(x0, 1.22, zr));
    }
    // 防钻撞横梁
    b.color(0.05, 0.05, 0.05).data(3).box(0, 0.62, s.len / 2 - 0.1, s.wid * 0.92, 0.12, 0.1);
    addWheels(b, hw, s.wheelR, [-s.len / 2 + 1.35], false);
    addWheels(b, hw, s.wheelR, [s.len / 2 - 1.5, s.len / 2 - 2.85], true);
    addLights(b, s, zf, zr);
    // 顶部示廓灯
    b.color(1.0, 0.05, 0.02).emis(0.8).data(0);
    for (const side of [-1, 1]) b.box(side * (hw - 0.12), 3.74, zr, 0.14, 0.06, 0.02);
    b.emis(0);
    return b.build();
  }

  loftBody(b, s.st, s.len, hw, s.tumble, s.glassTop, paint, 0, s.pillars || []);
  if (s.rearGlass) {
    const [gx, gy0, gy1] = s.rearGlass;
    b.color(...GLASS_C).data(1);
    b.quad(V3(-gx, gy0, zr), V3(gx, gy0, zr), V3(gx, gy1, zr), V3(-gx, gy1, zr));
  }
  if (s.frontGlass) {
    const [gx, gy0, gy1] = s.frontGlass;
    b.color(...GLASS_C).data(1);
    b.quad(V3(-gx, gy0, zf), V3(gx, gy0, zf), V3(gx, gy1, zf), V3(-gx, gy1, zf));
  }
  if (s.mirror) {
    const [mt, my] = s.mirror;
    b.color(...paint).data(0);
    for (const side of [-1, 1]) b.box(side * (hw + 0.07), my, (mt * s.len) / 2, 0.17, 0.1, 0.08);
  }
  addWheels(b, hw, s.wheelR, s.axles.map((t) => (t * s.len) / 2));
  addLights(b, s, zf, zr);
  return b.build();
}
