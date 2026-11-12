import { WINDOW } from '../config.js';
import { SEAL_N } from './glass.js';

// 主驾电动车窗（左前门玻璃）。玻璃沿自身斜面滑进车门，由雨滴着色器在顶点里平移（uWin）。
// 门槛上的密封条像一根不动的雨刮：玻璃从它下面经过时，上面的水全被刮掉。
// 这里把玻璃上每一段高度「最近一次经过密封条的时刻」记下来交给着色器（uSeal），
// 于是刚升上来的玻璃就是一片刚刮过的区域：先是竖向的水痕，再被雨慢慢重新打湿。

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class PowerWindow {
  // material：左侧车窗的雨滴着色器；down：玻璃沿斜面向下的方向（车体坐标）
  constructor(material, down) {
    this.u = material.uniforms;
    this.u.uWin.value.set(down.x, down.y, down.z, 0);
    this.open = 0; // 0 关严 ~ 1 降到底
    this.target = 0;
    this.d = 0; // 已降下的距离（米）
    this.onStop = null; // 到头时（升到顶 / 降到底）回调
  }

  get moving() {
    return this.open !== this.target;
  }

  // 一键升降；动的过程中再按一下就掉头。返回是否正在打开
  toggle() {
    this.target = this.target > 0.5 ? 0 : 1;
    return this.target > 0.5;
  }

  // 玻璃坐标 (x, y) 这一点现在是否缩在车门里
  hides(x, y) {
    return this.d > 0 && x > WINDOW.X0 && y - WINDOW.SILL[0] - WINDOW.SILL[1] * x < this.d;
  }

  // time 与着色器的 uTime 同一时基（本帧结束时刻）
  update(dt, time) {
    if (!this.moving) return;
    const step = dt / WINDOW.TIME;
    this.open = clamp(this.open + clamp(this.target - this.open, -step, step), 0, 1);
    const d0 = this.d;
    const d1 = this.open * WINDOW.TRAVEL;
    // 这一帧密封条从 d0 扫到 d1：其间每一段高度被刮过的时刻按匀速插出来
    const seal = this.u.uSeal.value;
    const lo = Math.min(d0, d1);
    const hi = Math.max(d0, d1);
    for (let i = 0; i < SEAL_N; i++) {
      const h = (i / (SEAL_N - 1)) * WINDOW.TRAVEL;
      if (h < lo || h > hi || hi === lo) continue;
      seal[i] = time - dt + (dt * (h - d0)) / (d1 - d0);
    }
    this.d = d1;
    this.u.uWin.value.w = d1;
    if (!this.moving) this.onStop?.(this.open > 0.5);
  }
}
