import { ROAD } from '../config.js';

// 道路中心线（JS 侧）。GLSL 里有一份完全相同的实现（shaders/common.js），两边必须保持一致。
// 世界坐标是「局部」的：absoluteZ = localZ + originZ，originZ 只在 rebase 时变化。

const TAU = Math.PI * 2;

export const roadState = {
  originZ: 0,
  ph: ROAD.CURVE.map((c) => c[2]),
};

export function setOrigin(originZ) {
  roadState.originZ = originZ;
  ROAD.CURVE.forEach((c, i) => {
    roadState.ph[i] = (((originZ * c[1] + c[2]) % TAU) + TAU) % TAU;
  });
}

export function roadX(z) {
  let x = 0;
  for (let i = 0; i < ROAD.CURVE.length; i++) {
    const c = ROAD.CURVE[i];
    x += c[0] * Math.sin(z * c[1] + roadState.ph[i]);
  }
  return x;
}

export function roadDX(z) {
  let d = 0;
  for (let i = 0; i < ROAD.CURVE.length; i++) {
    const c = ROAD.CURVE[i];
    d += c[0] * c[1] * Math.cos(z * c[1] + roadState.ph[i]);
  }
  return d;
}

// 道路切线方向对应的车头偏航角（rotation.y）
export const roadYaw = (z) => Math.atan(roadDX(z));

// 沿行驶方向（-Z）的道路曲率，左弯为正：车速 × 曲率 = 跟住弯道所需的横摆角速度
export function roadCurvature(z) {
  let dd = 0;
  for (let i = 0; i < ROAD.CURVE.length; i++) {
    const c = ROAD.CURVE[i];
    dd -= c[0] * c[1] * c[1] * Math.sin(z * c[1] + roadState.ph[i]);
  }
  const d = roadDX(z);
  return -dd / (1 + d * d) ** 1.5;
}
