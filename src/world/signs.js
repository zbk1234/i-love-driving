import * as THREE from 'three';

// 路牌贴图集（2048×1024）：
//   上半部分：8 块 512×256 的绿底指路牌
//   下半部分：8 条 1024×128 的 LED 情报板文字
// 着色器按实例序号的哈希来选用哪一块。

const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", sans-serif';

const GUIDE = [
  { cn: '市中心', en: 'City Center', arrow: 'up' },
  { cn: '机场', en: 'Airport', arrow: 'up', dist: '12 km' },
  { cn: '火车站', en: 'Railway Station', arrow: 'up', dist: '5 km' },
  { cn: '滨江大道', en: 'Binjiang Ave', arrow: 'exit', dist: '800 m' },
  { cn: '环城高架', en: 'Ring Elevated Rd', arrow: 'up' },
  { cn: '中山路', en: 'Zhongshan Rd', arrow: 'exit', dist: '1 km' },
  { cn: '体育中心', en: 'Sports Center', arrow: 'exit', dist: '500 m' },
  { cn: '南北高架', en: 'N-S Elevated Rd', arrow: 'up', dist: '2 km' },
];

const LED = [
  { text: '雨天路滑  减速慢行', color: '#ffae1a' },
  { text: '保持车距  谨慎驾驶', color: '#ffae1a' },
  { text: '前方畅通  限速 80', color: '#3dff6e' },
  { text: '雨雾天气  请开车灯', color: '#ffae1a' },
  { text: '严禁疲劳驾驶', color: '#ff4a2e' },
  { text: '前方 2 公里  车多缓行', color: '#ffae1a' },
  { text: '系好安全带  文明行车', color: '#3dff6e' },
  { text: '大雨  能见度低  控制车速', color: '#ff4a2e' },
];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawArrow(ctx, cx, cy, size, angle) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  const s = size / 2;
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.lineTo(s * 0.72, -s * 0.18);
  ctx.lineTo(s * 0.26, -s * 0.18);
  ctx.lineTo(s * 0.26, s);
  ctx.lineTo(-s * 0.26, s);
  ctx.lineTo(-s * 0.26, -s * 0.18);
  ctx.lineTo(-s * 0.72, -s * 0.18);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawGuide(ctx, x, y, s) {
  const W = 512;
  const H = 256;
  ctx.fillStyle = '#0b6a40';
  ctx.fillRect(x, y, W, H);
  ctx.strokeStyle = '#f2f5f3';
  ctx.lineWidth = 6;
  roundRect(ctx, x + 10, y + 10, W - 20, H - 20, 20);
  ctx.stroke();

  ctx.fillStyle = '#f2f5f3';
  drawArrow(ctx, x + 84, y + 128, 150, s.arrow === 'exit' ? Math.PI / 4 : 0);

  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.font = `bold 78px ${FONT}`;
  ctx.fillText(s.cn, x + 170, y + 118, 320);
  ctx.font = `600 32px ${FONT}`;
  ctx.fillText(s.en, x + 172, y + 166, 320);
  if (s.dist) {
    ctx.font = `bold 40px ${FONT}`;
    ctx.fillText(s.dist, x + 172, y + 222);
  }
  if (s.arrow === 'exit') {
    // 黄底「出口」小标
    ctx.fillStyle = '#f5c400';
    roundRect(ctx, x + 372, y + 184, 112, 46, 8);
    ctx.fill();
    ctx.fillStyle = '#111';
    ctx.font = `bold 30px ${FONT}`;
    ctx.fillText('出口', x + 396, y + 219);
  }
}

function drawLed(ctx, x, y, s) {
  ctx.fillStyle = '#030303';
  ctx.fillRect(x, y, 1024, 128);
  ctx.fillStyle = s.color;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `bold 80px ${FONT}`;
  ctx.fillText(s.text, x + 512, y + 68, 980);
}

export function makeSignAtlas(renderer) {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 2048, 1024);
  GUIDE.forEach((s, i) => drawGuide(ctx, (i % 4) * 512, Math.floor(i / 4) * 256, s));
  LED.forEach((s, i) => drawLed(ctx, (i % 2) * 1024, 512 + Math.floor(i / 2) * 128, s));

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return tex;
}
