import * as THREE from 'three';
import { WIPER_LABELS } from './wipers.js';

// 仪表盘和中控屏：画在 canvas 上，再当作自发光贴图贴进车里。

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

export class Cluster {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1024;
    this.canvas.height = 360;
    this.ctx = this.canvas.getContext('2d');
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this._acc = 1;
  }

  update(dt, s) {
    this._acc += dt;
    if (this._acc < 1 / 15) return;
    this._acc = 0;
    const ctx = this.ctx;
    const W = 1024;
    const H = 360;
    ctx.fillStyle = '#020305';
    ctx.fillRect(0, 0, W, H);

    const kmh = Math.round(s.speed * 3.6);
    dial(ctx, 212, 196, 150, { max: 240, step: 40, value: s.speed * 3.6, label: String(kmh), unit: 'km/h' });
    dial(ctx, 812, 196, 150, { max: 8, step: 1, value: s.rpm / 1000, label: s.gear, unit: '×1000 r/min', redFrom: 6.5 });

    // ---- 中间信息区
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    ctx.fillStyle = '#e6edf5';
    ctx.font = `500 34px ${FONT}`;
    ctx.fillText(`${hh}:${mm}`, 512, 64);
    ctx.fillStyle = 'rgba(190,203,218,0.8)';
    ctx.font = `400 19px ${FONT}`;
    ctx.fillText(`车外 ${s.temp}°C   雨`, 512, 100);

    // 巡航状态
    if (s.auto) {
      ctx.strokeStyle = '#49e08c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(432, 132, 160, 64, 10);
      ctx.stroke();
      ctx.fillStyle = '#49e08c';
      ctx.font = `600 17px ${FONT}`;
      ctx.fillText('自适应巡航', 512, 150);
      ctx.font = `600 26px ${FONT}`;
      ctx.fillText(`${Math.round(s.cruise * 3.6)} km/h`, 512, 178);
    } else {
      ctx.fillStyle = 'rgba(190,203,218,0.55)';
      ctx.font = `500 20px ${FONT}`;
      ctx.fillText('手动驾驶', 512, 164);
    }

    ctx.fillStyle = 'rgba(190,203,218,0.8)';
    ctx.font = `400 18px ${FONT}`;
    ctx.fillText(`雨刮 ${WIPER_LABELS[s.wiper]}`, 512, 230);
    ctx.fillText('续航 486 km', 512, 258);

    // ---- 指示灯
    const lamp = (x, color, on, text) => {
      ctx.fillStyle = on ? color : 'rgba(120,130,145,0.22)';
      ctx.font = `700 20px ${FONT}`;
      ctx.fillText(text, x, 312);
    };
    lamp(446, '#3ddc84', s.headlight, '近光');
    lamp(512, '#4aa8ff', s.highBeam, '远光');
    lamp(578, '#ffb020', s.rain > 0.75, '雨雾');

    // 转向灯箭头
    const arrow = (x, dir, on) => {
      ctx.fillStyle = on ? '#3ddc84' : 'rgba(120,130,145,0.18)';
      ctx.beginPath();
      ctx.moveTo(x + dir * 22, 30);
      ctx.lineTo(x, 12);
      ctx.lineTo(x, 22);
      ctx.lineTo(x - dir * 18, 22);
      ctx.lineTo(x - dir * 18, 38);
      ctx.lineTo(x, 38);
      ctx.lineTo(x, 48);
      ctx.closePath();
      ctx.fill();
    };
    arrow(396, -1, s.blinker < 0 && s.blinkOn);
    arrow(628, 1, s.blinker > 0 && s.blinkOn);

    this.texture.needsUpdate = true;
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
