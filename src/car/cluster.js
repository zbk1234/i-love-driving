import * as THREE from 'three';
import { WIPER_LABELS } from './wipers.js';

// 仪表和中控屏：画在 canvas 上，再当作自发光贴图贴到车模对应的表盘和屏幕上。

const FONT = '"Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif';
const TAU = Math.PI * 2;

function dial(ctx, cx, cy, r, { max, step, value, label, unit, fmt = (v) => v, redFrom = Infinity }) {
  const a0 = Math.PI * 0.78;
  const a1 = Math.PI * 2.22;
  const ang = (v) => a0 + (a1 - a0) * Math.min(1, Math.max(0, v / max));

  // 外圈
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(150,170,195,0.35)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, a1);
  ctx.stroke();
  // 已走过的弧
  ctx.lineWidth = 5;
  ctx.strokeStyle = 'rgba(120,190,255,0.75)';
  ctx.beginPath();
  ctx.arc(cx, cy, r, a0, ang(value));
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let v = 0; v <= max + 1e-6; v += step / 2) {
    const a = ang(v);
    const major = Math.abs(v / step - Math.round(v / step)) < 1e-6;
    const r0 = r - (major ? 16 : 9);
    ctx.lineWidth = major ? 3 : 1.5;
    ctx.strokeStyle = v >= redFrom ? '#ff5a3c' : major ? '#dfe7f0' : 'rgba(200,212,226,0.55)';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
    ctx.lineTo(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2));
    ctx.stroke();
    if (major) {
      ctx.fillStyle = v >= redFrom ? '#ff7a5c' : 'rgba(215,224,234,0.9)';
      ctx.font = `500 19px ${FONT}`;
      ctx.fillText(fmt(v), cx + Math.cos(a) * (r - 36), cy + Math.sin(a) * (r - 36));
    }
  }

  // 指针
  const a = ang(value);
  ctx.strokeStyle = '#ff6a45';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(a) * 58, cy + Math.sin(a) * 58);
  ctx.lineTo(cx + Math.cos(a) * (r - 20), cy + Math.sin(a) * (r - 20));
  ctx.stroke();
  ctx.lineCap = 'butt';

  ctx.fillStyle = '#eef3f8';
  ctx.font = `600 62px ${FONT}`;
  ctx.fillText(label, cx, cy - 4);
  ctx.fillStyle = 'rgba(190,203,218,0.75)';
  ctx.font = `400 18px ${FONT}`;
  ctx.fillText(unit, cx, cy + 40);
}

// 一块画布 + 对应的贴图。车模的 uv 按 glTF 的约定（原点在左上），所以不翻转
function panel(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.flipY = false;
  return { canvas, ctx: canvas.getContext('2d'), texture };
}

// 仪表：左边转速表、右边车速表、中间一块竖着的行车电脑，各是一张贴图，贴在车模对应的表盘上
export class Cluster {
  constructor() {
    this.speedo = panel(384, 384);
    this.rev = panel(384, 384);
    this.info = panel(256, 384);
    this._acc = 1;
  }

  update(dt, s) {
    this._acc += dt;
    if (this._acc < 1 / 15) return;
    this._acc = 0;

    const face = (p) => {
      p.ctx.fillStyle = '#020305';
      p.ctx.fillRect(0, 0, p.canvas.width, p.canvas.height);
      return p.ctx;
    };
    const kmh = Math.round(s.speed * 3.6);
    dial(face(this.speedo), 192, 200, 166, { max: 240, step: 40, value: s.speed * 3.6, label: String(kmh), unit: 'km/h' });
    dial(face(this.rev), 192, 200, 166, { max: 8, step: 1, value: s.rpm / 1000, label: s.gear, unit: '×1000 r/min', redFrom: 6.5 });

    // ---- 行车电脑（屏幕很小，只放最要紧的几样，字尽量大）
    const ctx = face(this.info);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // 转向灯箭头
    const arrow = (x, dir, on) => {
      ctx.fillStyle = on ? '#3ddc84' : 'rgba(120,130,145,0.18)';
      ctx.beginPath();
      ctx.moveTo(x + dir * 26, 40);
      ctx.lineTo(x, 18);
      ctx.lineTo(x, 30);
      ctx.lineTo(x - dir * 22, 30);
      ctx.lineTo(x - dir * 22, 50);
      ctx.lineTo(x, 50);
      ctx.lineTo(x, 62);
      ctx.closePath();
      ctx.fill();
    };
    arrow(40, -1, s.blinker < 0 && s.blinkOn);
    arrow(216, 1, s.blinker > 0 && s.blinkOn);

    const d = new Date();
    ctx.fillStyle = '#e6edf5';
    ctx.font = `500 36px ${FONT}`;
    ctx.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, 128, 42);

    // 巡航状态
    if (s.auto) {
      ctx.strokeStyle = '#49e08c';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(22, 88, 212, 128, 14);
      ctx.stroke();
      ctx.fillStyle = '#49e08c';
      ctx.font = `600 26px ${FONT}`;
      ctx.fillText('自适应巡航', 128, 116);
      ctx.font = `600 62px ${FONT}`;
      ctx.fillText(String(Math.round(s.cruise * 3.6)), 128, 172);
    } else {
      ctx.fillStyle = 'rgba(190,203,218,0.6)';
      ctx.font = `500 34px ${FONT}`;
      ctx.fillText('手动驾驶', 128, 152);
    }

    ctx.fillStyle = 'rgba(200,212,226,0.85)';
    ctx.font = `400 28px ${FONT}`;
    ctx.fillText(`雨刮 ${WIPER_LABELS[s.wiper]}`, 128, 258);
    ctx.fillText(`车外 ${s.temp}°C`, 128, 298);

    // ---- 指示灯
    const lamp = (x, color, on, text) => {
      ctx.fillStyle = on ? color : 'rgba(120,130,145,0.22)';
      ctx.font = `700 26px ${FONT}`;
      ctx.fillText(text, x, 350);
    };
    lamp(50, '#3ddc84', s.headlight, '近光');
    lamp(128, '#4aa8ff', s.highBeam, '远光');
    lamp(206, '#ffb020', s.rain > 0.75, '雨雾');

    for (const p of [this.speedo, this.rev, this.info]) p.texture.needsUpdate = true;
  }
}

// 中控屏：一张假的导航地图，每隔一段时间重画一次（时钟）
export class CenterScreen {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 544;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.flipY = false; // 贴在车模的屏幕上，uv 是 glTF 的约定
    this._acc = 100;
    // 固定的随机路网
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    this.streets = [];
    for (let i = 0; i < 16; i++) this.streets.push([rnd() * 1024, rnd() * 544, rnd() * TAU, 300 + rnd() * 900, rnd() < 0.3 ? 7 : 3]);
  }

  update(dt) {
    this._acc += dt;
    if (this._acc < 20) return;
    this._acc = 0;
    const ctx = this.ctx;
    const W = 1024;
    const H = 544;
    ctx.fillStyle = '#0a0f15';
    ctx.fillRect(0, 0, W, H);

    // 路网
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
    ctx.moveTo(430, 560);
    ctx.bezierCurveTo(450, 380, 560, 330, 590, 200);
    ctx.bezierCurveTo(610, 110, 720, 80, 760, -20);
    ctx.stroke();
    // 自车位置
    ctx.fillStyle = '#eaf2ff';
    ctx.beginPath();
    ctx.moveTo(462, 388);
    ctx.lineTo(486, 440);
    ctx.lineTo(462, 428);
    ctx.lineTo(438, 440);
    ctx.closePath();
    ctx.fill();

    // 转向提示卡片
    ctx.fillStyle = 'rgba(14,22,32,0.92)';
    ctx.beginPath();
    ctx.roundRect(28, 28, 372, 132, 14);
    ctx.fill();
    ctx.fillStyle = '#eaf2ff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `600 50px ${FONT}`;
    ctx.fillText('2.4 公里', 54, 74);
    ctx.fillStyle = '#9db2c8';
    ctx.font = `400 26px ${FONT}`;
    ctx.fillText('沿环城高架继续行驶', 54, 126);

    // 底栏
    ctx.fillStyle = 'rgba(8,12,18,0.96)';
    ctx.fillRect(0, H - 86, W, 86);
    const d = new Date();
    ctx.fillStyle = '#dbe6f2';
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, 34, H - 42);
    ctx.fillStyle = '#8fa3b8';
    ctx.font = `400 24px ${FONT}`;
    ctx.fillText('FM 101.7 交通广播 · 雨天路况', 160, H - 42);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#dbe6f2';
    ctx.font = `500 30px ${FONT}`;
    ctx.fillText('22.0°C', W - 34, H - 42);

    this.texture.needsUpdate = true;
  }
}
