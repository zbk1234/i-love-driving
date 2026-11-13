import * as THREE from 'three';
import { CAR, ROAD, laneCenter } from '../config.js';
import { roadX, roadDX } from '../core/roadmath.js';
import { WIPER_LABELS } from './wipers.js';

// 主驾仪表屏和中控屏：画在 canvas 上，再当作自发光贴图贴到车模对应的两块屏幕上。
//   主驾仪表屏：方向盘后面那条细长的屏（约 27 × 9 cm），浅色主题——
//     左边车速、辅助驾驶 / 巡航 / 限速、功率、挡位，左下电量和续航，左上 READY 和灯光指示；
//     中间是辅助驾驶的「车道感应」：从自车后上方俯看路面，车道线、护栏、周围的车都按真实位置画出来；
//     右边导航（下一个出口、车道箭头、小地图），底部到达时间，右下角时间和车外温度
//   中控屏：中间竖着的那块（约 23 × 26 cm）——导航、收音机、车辆状态
// 两块屏的 uv 在 model.js 里已经各自拉满 0..1，所以画布按屏幕的实际长宽比开。

const FONT = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
const TAU = Math.PI * 2;
const clock = (d = new Date()) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (t) => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};

function canvas2d(w, h, scale) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(h * scale);
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  return { canvas, ctx };
}

// 一块画布 + 对应的贴图。车模的 uv 按 glTF 的约定（原点在左上），所以不翻转。
// scale 是画布分辨率相对逻辑像素的倍数，下面的绘制代码都按逻辑像素写
function panel(w, h, scale = 1) {
  const { canvas, ctx } = canvas2d(w, h, scale);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.flipY = false;
  return { canvas, ctx, texture };
}

// ------------------------------------------------------------------ 主驾仪表屏

const CW = 1024;
const CH = 346;
const CS = 1.5; // 画布按 1.5 倍分辨率画，贴到屏上字才不糊
const LIMIT = 80; // 这段高架的限速
const NAV = { NEXT: 3.3, TRIP: 26, NAME: '滨江互通' }; // 出口间距、全程（公里）：走完一轮再从头来
const MAP = { X: 762, Y: 122, W: 228, H: 178, T: 260 }; // 小地图的位置大小；T 是路网图块的高度
const C = {
  ink: '#1b2430',
  sub: '#5d6b80',
  faint: 'rgba(60,82,112,0.22)',
  green: '#11a36a',
  blue: '#1d8ff0',
  red: '#e0383e',
  amber: '#f5a516',
};

// 车道示意的虚拟相机：在自车后方 B 米、高 H 米处往前俯看（单位米）；
// X / CY / F 是画布上的中线横坐标、主点纵坐标和焦距（逻辑像素），NEAR..FAR 是画出来的纵向范围
const VIEW = { X: 536, CY: 146, F: 345, H: 5.5, B: 11, PITCH: 0.24, NEAR: -6, FAR: 160 };
const VC = Math.cos(VIEW.PITCH);
const VS = Math.sin(VIEW.PITCH);

// 车道示意里车的配色：顶面、尾面、侧面、后窗。前车（自适应巡航在跟的那辆）是蓝色
const PAL = {
  other: ['#f4f7fb', '#d4dce7', '#bfc9d7', '#8796ab'],
  lead: ['#e2f0ff', '#acd2f6', '#94bfea', '#4f7fb3'],
  own: ['#f7efef', '#ddcacc', '#cbb6b9', '#6e6977'],
  dark: ['#7c889a', '#5f6b7d', '#56616f', '#4a5463'],
};
const OWN = { len: CAR.LEN, wid: CAR.WID, top: 1.5 };
// 小车车身上半截（车舱）沿车长的范围 [后端, 前端]：相对车身中心、按车长的比例
const CABIN = { sedan: [-0.3, 0.12], suv: [-0.4, 0.12], van: [-0.46, 0.26], own: [-0.4, 0.12] };

// 转向灯箭头：x 是箭杆根部，dir = -1 朝左 / +1 朝右
function arrow(ctx, x, y, dir) {
  ctx.fillStyle = C.green;
  ctx.beginPath();
  ctx.moveTo(x + dir * 17, y);
  ctx.lineTo(x, y - 14);
  ctx.lineTo(x, y - 6);
  ctx.lineTo(x - dir * 14, y - 6);
  ctx.lineTo(x - dir * 14, y + 6);
  ctx.lineTo(x, y + 6);
  ctx.lineTo(x, y + 14);
  ctx.closePath();
  ctx.fill();
}

// 灯光指示：D 形灯泡朝右、光线朝左。kind = low 近光（光线往下斜）/ high 远光（水平，灯泡涂实）/ fog 雾灯（光线上一道波浪）
function lampIcon(ctx, x, y, kind, color) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y - 8);
  ctx.bezierCurveTo(x + 12, y - 8, x + 12, y + 8, x, y + 8);
  ctx.closePath();
  if (kind === 'high') ctx.fill();
  ctx.stroke();
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.moveTo(x - 4, y + i * 5.5);
    ctx.lineTo(x - 14, y + i * 5.5 + (kind === 'high' ? 0 : 3.5));
    ctx.stroke();
  }
  if (kind === 'fog') {
    ctx.beginPath();
    ctx.moveTo(x - 9, y - 10);
    ctx.bezierCurveTo(x - 14, y - 3, x - 4, y + 3, x - 9, y + 11);
    ctx.stroke();
  }
}

// 雨刮指示：风挡轮廓 + 一支刮片
function wiperIcon(ctx, x, y, color) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 13, y + 8);
  ctx.lineTo(x + 13, y + 8);
  ctx.lineTo(x + 10, y - 5);
  ctx.quadraticCurveTo(x, y - 11, x - 10, y - 5);
  ctx.closePath();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x - 1, y + 8);
  ctx.lineTo(x - 7, y - 4);
  ctx.stroke();
}

// 车道箭头：(x, y) 是箭杆底端，turn = 0 直行 / 1 右转（出口）
function laneArrow(ctx, x, y, turn, color, k = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  if (turn) {
    ctx.lineTo(0, -8);
    ctx.quadraticCurveTo(0, -14, 6, -14);
  } else {
    ctx.lineTo(0, -14);
  }
  ctx.stroke();
  ctx.beginPath();
  if (turn) {
    ctx.moveTo(13, -14);
    ctx.lineTo(6, -19);
    ctx.lineTo(6, -9);
  } else {
    ctx.moveTo(0, -21);
    ctx.lineTo(-5, -13);
    ctx.lineTo(5, -13);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

// 数字 + 小一号的单位，左对齐、y 是文字基线；返回画完后的右端 x
function numUnit(ctx, x, y, num, unit, size, color, unitColor = color) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = color;
  ctx.font = `500 ${size}px ${FONT}`;
  ctx.fillText(num, x, y);
  const w = ctx.measureText(num).width + 2;
  ctx.fillStyle = unitColor;
  ctx.font = `400 ${Math.round(size * 0.62)}px ${FONT}`;
  ctx.fillText(unit, x + w, y);
  const end = x + w + ctx.measureText(unit).width;
  ctx.textBaseline = 'middle';
  return end;
}

function circle(ctx, x, y, r) {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, TAU);
}

export class Cluster {
  constructor() {
    Object.assign(this, panel(CW, CH, CS));
    this.scene = canvas2d(CW, CH, CS); // 车道示意先画在这张上，四周淡出后再合到屏幕上
    this._acc = 1;
    this._dist = 0; // 行驶里程：导航的距离、小地图的滚动都跟着它走
    this._camU = null;
    this._z = 0;
    this._x0 = 0;
    this._dx0 = 0;
    this._lane = 1;
    // 小地图：固定的随机路网，铺满一块 MAP.W × MAP.T 的图块，上下拼接着往下滚
    let seed = 11;
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    this.streets = [];
    for (let i = 0; i < 16; i++) this.streets.push([rnd() * MAP.W, rnd() * MAP.T, rnd() * Math.PI, 40 + rnd() * 160, rnd() < 0.25 ? 5 : 2.5]);
  }

  update(dt, s) {
    this._dist += s.speed * dt;
    this._acc += dt;
    if (this._acc < 1 / 15) return;
    const step = this._acc;
    this._acc = 0;
    // 相机横向跟着自车，但慢半拍：变道时先看到自车滑过去，画面再跟上
    this._camU = this._camU === null ? s.u : this._camU + (s.u - this._camU) * Math.min(1, step * 2.5);
    this._z = s.z;
    this._x0 = roadX(s.z);
    this._dx0 = roadDX(s.z);
    this._lane = clamp(Math.floor((s.u - ROAD.EDGE_IN) / ROAD.LANE_W), 0, ROAD.LANES - 1);

    const { ctx } = this;
    const bg = ctx.createLinearGradient(0, 0, 0, CH);
    bg.addColorStop(0, '#e2e9f4');
    bg.addColorStop(1, '#c9d6e9');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, CW, CH);
    ctx.textBaseline = 'middle';

    this._drawLanes(s);
    ctx.drawImage(this.scene.canvas, 0, 0, CW, CH);
    this._drawTop(ctx, s);
    this._drawLeft(ctx, s);
    this._drawNav(ctx, s);

    this.texture.needsUpdate = true;
  }

  // ---------------------------------------------------------------- 车道感应

  // 道路中心线在前方 d 米处偏离当前切线的横向量：弯道上车道线跟着弯过去
  _dev(d) {
    return roadX(this._z - d) - this._x0 + d * this._dx0;
  }

  // 路面坐标 → 画布：u 横向（同 vehicle.u），y 高度，d 自车前方的纵向距离
  _p(u, y, d) {
    const x = u - this._camU + this._dev(d);
    const ry = y - VIEW.H;
    const rz = d + VIEW.B;
    const zc = rz * VC - ry * VS;
    return [VIEW.X + (VIEW.F * x) / zc, VIEW.CY - (VIEW.F * (ry * VC + rz * VS)) / zc];
  }

  _path(ctx, pts) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }

  // 贴地的一条带子：中线 lat(d)、半宽 half(d)（都可以是常数），从 d0 铺到 d1
  _ribbon(ctx, d0, d1, lat, half, fill) {
    const a = Math.max(d0, VIEW.NEAR);
    const b = Math.min(d1, VIEW.FAR);
    if (b <= a) return;
    const L = typeof lat === 'function' ? lat : () => lat;
    const W = typeof half === 'function' ? half : () => half;
    const n = Math.ceil((b - a) / 5);
    const left = [];
    const right = [];
    for (let i = 0; i <= n; i++) {
      const d = a + ((b - a) * i) / n;
      left.push(this._p(L(d) - W(d), 0, d));
      right.push(this._p(L(d) + W(d), 0, d));
    }
    ctx.fillStyle = fill;
    this._path(ctx, left.concat(right.reverse()));
    ctx.fill();
  }

  // 路边的护栏：立在 u 处、高 h 的一面墙
  _wall(ctx, u, h) {
    const bot = [];
    const top = [];
    const n = Math.ceil((VIEW.FAR - VIEW.NEAR) / 8);
    for (let i = 0; i <= n; i++) {
      const d = VIEW.NEAR + ((VIEW.FAR - VIEW.NEAR) * i) / n;
      bot.push(this._p(u, 0, d));
      top.push(this._p(u, h, d));
    }
    ctx.fillStyle = '#edf2f9';
    this._path(ctx, bot.concat(top.slice().reverse()));
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    top.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.stroke();
  }

  // 长方体：横向 u ± w/2，纵向 b（车尾）..f（车头），高 y0..y1。画看得见的侧面、顶面和尾面
  _box(ctx, u, w, b, f, y0, y1, pal) {
    const bb = Math.max(b, VIEW.NEAR + 0.5);
    if (f <= bb) return;
    const l = u - w / 2;
    const r = u + w / 2;
    const P = (uu, yy, dd) => this._p(uu, yy, dd);
    const face = (pts, color) => {
      ctx.fillStyle = color;
      this._path(ctx, pts);
      ctx.fill();
    };
    // 在相机右边的车看得到它的左侧面，在左边的看得到右侧面
    const rel = u - this._camU + this._dev(bb);
    if (rel - w / 2 > 0) face([P(l, y0, bb), P(l, y1, bb), P(l, y1, f), P(l, y0, f)], pal[2]);
    else if (rel + w / 2 < 0) face([P(r, y0, bb), P(r, y1, bb), P(r, y1, f), P(r, y0, f)], pal[2]);
    face([P(l, y1, bb), P(r, y1, bb), P(r, y1, f), P(l, y1, f)], pal[0]);
    face([P(l, y0, bb), P(r, y0, bb), P(r, y1, bb), P(l, y1, bb)], pal[1]);
  }

  // 贴在纵向 d 处那个竖直面上的一块（尾灯、后窗）
  _rear(ctx, l, r, y0, y1, d, color) {
    if (d < VIEW.NEAR + 0.5) return;
    ctx.fillStyle = color;
    this._path(ctx, [this._p(l, y0, d), this._p(r, y0, d), this._p(r, y1, d), this._p(l, y1, d)]);
    ctx.fill();
  }

  // 一辆车。lamp = { brake 刹车 0..1, blink 正在闪的转向灯 -1/0/1, through 贯穿式尾灯 }
  _vehicle(ctx, u, d, kind, spec, pal, lamp) {
    const { len, wid, top } = spec;
    const b = d - len / 2;
    const f = d + len / 2;
    if (f < VIEW.NEAR + 0.5 || b > VIEW.FAR) return;
    this._ribbon(ctx, b - 0.4, f + 0.3, u, wid / 2 + 0.25, 'rgba(40,62,95,0.16)'); // 车底的影子
    let lw = wid; // 尾灯所在那一面的宽度、高度、纵向位置
    let ly = [0, 0];
    let ld = b;
    if (kind === 'truck') {
      this._box(ctx, u, wid * 0.94, f - 2.3, f, 0.4, 3.0, pal);
      this._box(ctx, u, wid * 0.8, b + 0.25, f - 2.3, 0.35, 0.95, PAL.dark);
      this._box(ctx, u, wid, b, f - 2.6, 0.95, top, pal);
      lw = wid * 0.8;
      ly = [0.5, 0.75];
      ld = b + 0.25;
    } else if (kind === 'bus') {
      this._box(ctx, u, wid, b, f, 0.3, top, pal);
      this._rear(ctx, u - wid / 2 + 0.25, u + wid / 2 - 0.25, top - 1.2, top - 0.3, b, pal[3]);
      ly = [0.75, 1.05];
    } else {
      const hb = top * 0.56;
      const [c0, c1] = CABIN[kind] || CABIN.sedan;
      const cw = wid * 0.84;
      const cb = d + c0 * len;
      this._box(ctx, u, wid, b, f, 0.2, hb, pal);
      this._box(ctx, u, cw, cb, d + c1 * len, hb, top, pal);
      this._rear(ctx, u - cw / 2 + 0.12, u + cw / 2 - 0.12, hb + 0.06, top - 0.07, cb, pal[3]);
      ly = [hb - 0.17, hb - 0.05];
    }
    const l = u - lw / 2;
    const r = u + lw / 2;
    const tail = lamp.brake > 0.3 ? '#ff2b3b' : '#e2525c';
    if (lamp.through) this._rear(ctx, l + 0.06, r - 0.06, ly[0], ly[1], ld, tail);
    else {
      this._rear(ctx, l + 0.06, l + 0.42, ly[0], ly[1], ld, tail);
      this._rear(ctx, r - 0.42, r - 0.06, ly[0], ly[1], ld, tail);
    }
    if (lamp.blink < 0) this._rear(ctx, l + 0.04, l + 0.36, ly[0] - 0.02, ly[1] + 0.04, ld, C.amber);
    if (lamp.blink > 0) this._rear(ctx, r - 0.36, r - 0.04, ly[0] - 0.02, ly[1] + 0.04, ld, C.amber);
  }

  _drawLanes(s) {
    const { ctx } = this.scene;
    ctx.clearRect(0, 0, CW, CH);
    const cars = (s.cars || []).filter((c) => c.active);
    const lane = this._lane;
    const blink = performance.now() % 740 < 370;
    const uIn = 0.3; // 中央隔离护栏

    // ---- 路面、护栏
    this._ribbon(ctx, VIEW.NEAR, VIEW.FAR, (uIn + ROAD.BARRIER_U) / 2, (ROAD.BARRIER_U - uIn) / 2, 'rgba(118,142,178,0.2)');
    this._wall(ctx, uIn, 0.85);
    this._wall(ctx, ROAD.BARRIER_U, 0.85);

    // ---- 变道时目标车道铺一层淡蓝
    if (s.auto && s.targetLane !== lane) this._ribbon(ctx, 0, 80, laneCenter(s.targetLane), ROAD.LANE_W / 2, 'rgba(29,143,240,0.16)');
    // ---- 盲区：相邻车道里和自车并排的车，那一侧铺一层黄；正朝那边打着转向灯就变红
    for (const side of [-1, 1]) {
      const nl = lane + side;
      if (nl < 0 || nl >= ROAD.LANES) continue;
      const busy = cars.some((c) => Math.abs(c.u - laneCenter(nl)) < 1.6 && Math.abs(s.z - c.z) < 4 + c.spec.len / 2);
      if (busy) this._ribbon(ctx, -6, 9, laneCenter(nl), ROAD.LANE_W / 2, s.blinker === side ? 'rgba(232,56,62,0.36)' : 'rgba(245,165,22,0.28)');
    }

    // ---- 车道线：两边实线，中间 6 米线 9 米空的虚线（钉在路面上，跟着里程往后走）；辅助驾驶时本车道两侧的线变蓝
    const m = ((s.z % 15) + 15) % 15;
    for (let i = 0; i <= ROAD.LANES; i++) {
      const u = ROAD.EDGE_IN + ROAD.LANE_W * i;
      const own = s.auto && (i === lane || i === lane + 1);
      const color = own ? 'rgba(29,143,240,0.9)' : '#ffffff';
      const half = own ? 0.1 : 0.07;
      if (i === 0 || i === ROAD.LANES) this._ribbon(ctx, VIEW.NEAR, VIEW.FAR, u, half, color);
      else for (let d = m - 15; d < VIEW.FAR; d += 15) this._ribbon(ctx, d, d + 6, u, half, color);
    }

    // ---- 前车：本车道里自车前面最近的一辆
    let lead = null;
    let leadD = Infinity;
    for (const c of cars) {
      const d = s.z - c.z;
      if (d > 0 && d < leadD && Math.abs(c.u - s.u) < 1.9) {
        lead = c;
        leadD = d;
      }
    }

    if (s.auto) {
      // 导引带：从车头铺到前车车尾（没有前车就铺 70 米），变道时弯向目标车道
      const tu = laneCenter(s.targetLane);
      const end = Math.min(lead ? leadD - lead.spec.len / 2 - 1.5 : 70, 70);
      if (end > 4) {
        const lat = (d) => s.u + (tu - s.u) * smooth(d / 28);
        const g = ctx.createLinearGradient(0, this._p(s.u, 0, 2.6)[1], 0, this._p(lat(end), 0, end)[1]);
        g.addColorStop(0, 'rgba(29,143,240,0.9)');
        g.addColorStop(1, 'rgba(29,143,240,0.12)');
        this._ribbon(ctx, 2.6, end, lat, 0.6, g);
      }
      // 自车脚下的感应光圈
      const ring = [];
      for (let i = 0; i < 40; i++) {
        const a = (i / 40) * TAU;
        ring.push(this._p(s.u + Math.cos(a) * 2.6, 0, Math.sin(a) * 3.25));
      }
      this._path(ctx, ring);
      ctx.fillStyle = 'rgba(29,143,240,0.16)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(29,143,240,0.3)';
      ctx.lineWidth = 7;
      ctx.stroke();
      ctx.strokeStyle = C.blue;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // ---- 车：由远及近画（自车也排在里面）
    const list = cars.map((c) => ({ c, d: s.z - c.z })).filter((o) => o.d < VIEW.FAR + 10 && o.d > VIEW.NEAR - 12);
    list.push({ c: null, d: 0 });
    list.sort((a, b) => b.d - a.d);
    for (const { c, d } of list) {
      if (!c) this._vehicle(ctx, s.u, 0, 'own', OWN, PAL.own, { brake: s.braking ? 1 : 0, blink: s.blinkOn ? s.blinker : 0, through: true });
      else this._vehicle(ctx, c.u, d, c.kind, c.spec, c === lead ? PAL.lead : PAL.other, { brake: c.brake, blink: blink ? c.blink : 0 });
    }

    // ---- 四周淡出：两侧融进背景，远处消失在地平线
    ctx.globalCompositeOperation = 'destination-in';
    let g = ctx.createLinearGradient(315, 0, 775, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.19, '#000');
    g.addColorStop(0.81, '#000');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CW, CH);
    g = ctx.createLinearGradient(0, 70, 0, CH);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.15, '#000');
    g.addColorStop(0.8, '#000');
    g.addColorStop(1, 'rgba(0,0,0,0.25)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, CW, CH);
    ctx.globalCompositeOperation = 'source-over';
  }

  // ---------------------------------------------------------------- 顶栏：READY、灯光、转向灯、辅助驾驶状态、雨刮

  _drawTop(ctx, s) {
    ctx.textAlign = 'left';
    ctx.fillStyle = C.green;
    ctx.font = `700 17px ${FONT}`;
    ctx.fillText('READY', 34, 30);
    lampIcon(ctx, 124, 30, 'low', s.headlight ? C.green : C.faint);
    lampIcon(ctx, 164, 30, 'high', s.highBeam ? C.blue : C.faint);
    lampIcon(ctx, 204, 30, 'fog', s.rain > 0.75 ? C.green : C.faint);
    wiperIcon(ctx, CW - 40, 30, s.wiper !== 'off' ? C.green : C.faint);

    if (s.blinker < 0 && s.blinkOn) arrow(ctx, VIEW.X - 150, 30, -1);
    if (s.blinker > 0 && s.blinkOn) arrow(ctx, VIEW.X + 150, 30, 1);
    let text = '手动驾驶';
    ctx.fillStyle = C.sub;
    if (s.auto && s.blinker) {
      text = s.blinker < 0 ? '正在向左变道' : '正在向右变道';
      ctx.fillStyle = C.green;
    } else if (s.auto) {
      text = '车道保持 · 自适应巡航';
      ctx.fillStyle = C.blue;
    }
    ctx.textAlign = 'center';
    ctx.font = `500 16px ${FONT}`;
    ctx.fillText(text, VIEW.X, 30);
  }

  // ---------------------------------------------------------------- 左侧：车速、辅助驾驶 / 巡航 / 限速、功率、挡位、电量

  _drawLeft(ctx, s) {
    const kmh = Math.round(s.speed * 3.6);
    ctx.textAlign = 'center';
    ctx.fillStyle = kmh > LIMIT + 8 ? C.red : C.ink;
    ctx.font = `500 92px ${FONT}`;
    ctx.fillText(String(kmh), 122, 138);
    ctx.fillStyle = C.sub;
    ctx.font = `400 17px ${FONT}`;
    ctx.fillText('km/h', 122, 194);

    // 辅助驾驶：圆圈里一辆车夹在两条车道线中间
    const iy = 138;
    const on = s.auto;
    circle(ctx, 222, iy, 17);
    ctx.fillStyle = on ? 'rgba(29,143,240,0.12)' : 'rgba(0,0,0,0)';
    ctx.fill();
    ctx.strokeStyle = on ? C.blue : C.faint;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = on ? C.blue : C.faint;
    ctx.beginPath();
    ctx.roundRect(217, iy - 6, 10, 14, 3);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(211, iy + 9);
    ctx.lineTo(214, iy - 9);
    ctx.moveTo(233, iy + 9);
    ctx.lineTo(230, iy - 9);
    ctx.stroke();
    // 巡航设定车速
    circle(ctx, 264, iy, 17);
    ctx.strokeStyle = on ? C.blue : C.faint;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.fillStyle = on ? C.ink : C.sub;
    ctx.font = `600 16px ${FONT}`;
    ctx.fillText(String(Math.round(s.cruise * 3.6)), 264, iy + 1);
    ctx.fillStyle = on ? C.blue : C.faint;
    ctx.font = `700 10px ${FONT}`;
    ctx.fillText('MAX', 264, iy + 26);
    // 限速
    circle(ctx, 306, iy, 16);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = C.red;
    ctx.lineWidth = 3.5;
    ctx.stroke();
    ctx.fillStyle = C.ink;
    ctx.font = `600 16px ${FONT}`;
    ctx.fillText(String(LIMIT), 306, iy + 1);

    // 功率条：驱动是深色往右长（满格 150 kW），动能回收是绿色（满格 60 kW）
    const kw = s.power;
    const bx = 62;
    const bw = 130;
    ctx.fillStyle = C.faint;
    ctx.fillRect(bx, 220, bw, 3);
    ctx.fillStyle = kw < 0 ? C.green : C.ink;
    ctx.fillRect(bx, 219.5, bw * clamp(Math.abs(kw) / (kw < 0 ? 60 : 150), 0.02, 1), 4);
    numUnit(ctx, bx, 252, String(Math.round(kw)), 'kW', 24, kw < 0 ? C.green : C.ink, C.sub);
    // 驾驶员 + 挡位
    ctx.fillStyle = C.ink;
    circle(ctx, 160, 236, 4.5);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(151, 252);
    ctx.quadraticCurveTo(151, 242, 160, 242);
    ctx.quadraticCurveTo(169, 242, 169, 252);
    ctx.closePath();
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = C.green;
    ctx.font = `700 26px ${FONT}`;
    ctx.fillText(s.gear, 176, 244);

    // 电量、续航
    const soc = clamp(s.soc, 0, 1);
    const low = soc < 0.2;
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.roundRect(34, 315, 30, 14, 3);
    ctx.stroke();
    ctx.fillStyle = C.ink;
    ctx.fillRect(64.5, 319, 2.5, 6);
    ctx.fillStyle = low ? C.amber : C.ink;
    ctx.fillRect(36.5, 317.5, 25 * soc, 9);
    const x = numUnit(ctx, 76, 330, String(Math.round(soc * 100)), '%', 22, low ? C.amber : C.ink, C.sub);
    numUnit(ctx, x + 16, 330, String(Math.max(0, Math.round(s.range))), 'km', 22, C.ink, C.sub);
  }

  // ---------------------------------------------------------------- 右侧导航、底部到达时间、右下角时间和温度

  _drawNav(ctx, s) {
    const km = this._dist / 1000;
    const next = NAV.NEXT - (km % NAV.NEXT);
    const rem = NAV.TRIP - (km % NAV.TRIP);
    const mins = Math.max(1, Math.round((rem / Math.max(s.speed * 3.6, 30)) * 60));

    // ---- 下一个出口 + 车道箭头（当前所在车道的箭头是深色）
    laneArrow(ctx, MAP.X + 8, 84, 1, C.ink, 1.1);
    const x = next >= 1 ? numUnit(ctx, MAP.X + 32, 84, next.toFixed(1), 'km', 21, C.ink, C.sub) : numUnit(ctx, MAP.X + 32, 84, String(Math.round(next * 100) * 10), 'm', 21, C.ink, C.sub);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.ink;
    ctx.font = `500 18px ${FONT}`;
    ctx.fillText(NAV.NAME, x + 12, 77);
    for (let i = 0; i < ROAD.LANES; i++) {
      laneArrow(ctx, MAP.X + MAP.W / 2 + (i - 1) * 40, 114, i === ROAD.LANES - 1 ? 1 : 0, i === this._lane ? C.ink : 'rgba(27,36,48,0.32)');
    }

    // ---- 小地图：路网往下滚，绿色是规划路线，白色箭头是自车
    const { X, Y, W, H, T } = MAP;
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(X, Y, W, H, 8);
    ctx.clip();
    ctx.fillStyle = '#d3dcea';
    ctx.fillRect(X, Y, W, H);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#f3f6fb';
    const off = (this._dist * 0.15) % T;
    for (const oy of [off - T, off]) {
      for (const [sx, sy, a, len, w] of this.streets) {
        const cx = X + sx;
        const cy = Y + sy + oy;
        ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(cx - Math.cos(a) * len, cy - Math.sin(a) * len);
        ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
        ctx.stroke();
      }
    }
    const rx = X + W / 2;
    const route = () => {
      ctx.beginPath();
      ctx.moveTo(rx, Y + H + 6);
      ctx.bezierCurveTo(rx, Y + H * 0.5, rx + 18, Y + H * 0.35, rx + 14, Y - 6);
      ctx.stroke();
    };
    ctx.strokeStyle = '#1d8a55';
    ctx.lineWidth = 9;
    route();
    ctx.strokeStyle = '#3cc47c';
    ctx.lineWidth = 6;
    route();
    const ay = Y + H - 24;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#7d8aa0';
    ctx.lineWidth = 1.5;
    this._path(ctx, [[rx, ay - 12], [rx + 8, ay + 9], [rx, ay + 4], [rx - 8, ay + 9]]);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    // ---- 底部中间：到达时间、剩余里程和用时，下面一条行程进度
    const bx = VIEW.X - 96;
    ctx.fillStyle = C.ink;
    ctx.fillRect(bx, 309, 2, 17);
    ctx.fillRect(bx + 2, 309, 10, 7);
    let ex = numUnit(ctx, bx + 18, 326, clock(new Date(Date.now() + mins * 60000)), '', 19, C.ink);
    ex = numUnit(ctx, ex + 12, 326, rem.toFixed(1), 'km', 19, C.ink, C.sub);
    numUnit(ctx, ex + 12, 326, String(mins), 'min', 19, C.ink, C.sub);
    const p = 1 - rem / NAV.TRIP;
    const px0 = VIEW.X - 130;
    const px1 = VIEW.X + 130;
    ctx.fillStyle = 'rgba(27,36,48,0.16)';
    ctx.fillRect(px0, 335, px1 - px0, 2);
    ctx.fillStyle = C.blue;
    ctx.fillRect(px0, 335, (px1 - px0) * p, 2);
    const mx = px0 + (px1 - px0) * p;
    this._path(ctx, [[mx + 6, 336], [mx - 3, 331], [mx - 3, 341]]);
    ctx.fill();

    // ---- 右下角：时间、车外温度
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.ink;
    ctx.font = `500 22px ${FONT}`;
    const temp = `${s.temp}°C`;
    ctx.fillText(temp, CW - 34, 330);
    ctx.fillText(clock(), CW - 34 - ctx.measureText(temp).width - 18, 330);
    ctx.textBaseline = 'middle';
  }
}

// ------------------------------------------------------------------ 中控屏：上面是导航地图，下面两张卡片（收音机、车辆状态），最底下一条状态栏
export class CenterScreen {
  constructor() {
    Object.assign(this, panel(720, 792));
    this._acc = 100;
    this._dist = 0; // 行驶里程，用来让导航的「还有多远」往下走
    // 固定的随机路网
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    this.streets = [];
    for (let i = 0; i < 14; i++) this.streets.push([rnd() * 720, rnd() * 500, rnd() * TAU, 260 + rnd() * 700, rnd() < 0.3 ? 7 : 3]);
  }

  update(dt, s) {
    this._dist += s.speed * dt;
    this._acc += dt;
    if (this._acc < 1) return;
    this._acc = 0;
    const { ctx } = this;
    const W = 720;
    const H = 792;
    const MAP = 500;
    ctx.fillStyle = '#0a0f15';
    ctx.fillRect(0, 0, W, H);

    // ---- 地图
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, W, MAP);
    ctx.clip();
    ctx.lineCap = 'round';
    for (const [x, y, a, len, w] of this.streets) {
      ctx.strokeStyle = w > 4 ? '#27313d' : '#19212b';
      ctx.lineWidth = w * 2.2;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(a) * len, y - Math.sin(a) * len);
      ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
      ctx.stroke();
    }
    // 规划路线（高架）
    ctx.strokeStyle = '#2f7de0';
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.moveTo(330, MAP + 20);
    ctx.bezierCurveTo(345, 360, 430, 320, 450, 210);
    ctx.bezierCurveTo(465, 120, 540, 90, 570, -20);
    ctx.stroke();
    // 自车位置
    ctx.fillStyle = '#eaf2ff';
    ctx.beginPath();
    ctx.moveTo(338, 376);
    ctx.lineTo(362, 428);
    ctx.lineTo(338, 416);
    ctx.lineTo(314, 428);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // 转向提示卡片：距离跟着里程往下走，走完一段再从头来
    const left = 2.4 - ((this._dist / 1000) % 2.4);
    ctx.fillStyle = 'rgba(14,22,32,0.92)';
    ctx.beginPath();
    ctx.roundRect(24, 24, 400, 128, 16);
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#eaf2ff';
    ctx.font = `600 48px ${FONT}`;
    ctx.fillText(left >= 1 ? `${left.toFixed(1)} 公里` : `${Math.round(left * 100) * 10} 米`, 50, 70);
    ctx.fillStyle = '#9db2c8';
    ctx.font = `400 26px ${FONT}`;
    ctx.fillText('沿环城高架继续行驶', 50, 120);
    // 当前车速
    ctx.fillStyle = 'rgba(14,22,32,0.92)';
    ctx.beginPath();
    ctx.arc(W - 74, MAP - 74, 50, 0, TAU);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#eaf2ff';
    ctx.font = `600 38px ${FONT}`;
    ctx.fillText(String(Math.round(s.speed * 3.6)), W - 74, MAP - 82);
    ctx.fillStyle = '#8fa3b8';
    ctx.font = `400 18px ${FONT}`;
    ctx.fillText('km/h', W - 74, MAP - 48);

    // ---- 两张卡片
    const card = (x, title, lines) => {
      ctx.fillStyle = '#121a24';
      ctx.beginPath();
      ctx.roundRect(x, MAP + 20, 324, 168, 18);
      ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = '#8fa3b8';
      ctx.font = `400 22px ${FONT}`;
      ctx.fillText(title, x + 24, MAP + 54);
      lines.forEach(([text, color, size], i) => {
        ctx.fillStyle = color;
        ctx.font = `${size > 30 ? 600 : 400} ${size}px ${FONT}`;
        ctx.fillText(text, x + 24, MAP + 100 + i * 46);
      });
    };
    card(24, '收音机', [
      ['FM 101.7', '#eaf2ff', 40],
      ['交通广播 · 雨天路况', '#9db2c8', 24],
    ]);
    card(372, '车辆', [
      [s.auto ? `巡航 ${Math.round(s.cruise * 3.6)} km/h` : '手动驾驶', s.auto ? '#49e08c' : '#eaf2ff', 32],
      [`雨刮 ${WIPER_LABELS[s.wiper]} · ${s.highBeam ? '远光' : '近光'}`, '#9db2c8', 24],
    ]);

    // ---- 底栏
    ctx.fillStyle = 'rgba(8,12,18,0.96)';
    ctx.fillRect(0, H - 92, W, 92);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#dbe6f2';
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText(clock(), 30, H - 46);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#8fa3b8';
    ctx.font = `400 24px ${FONT}`;
    ctx.fillText(`车外 ${s.temp}°C`, W / 2, H - 46);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#dbe6f2';
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText('22.0°C', W - 30, H - 46);

    this.texture.needsUpdate = true;
  }
}
