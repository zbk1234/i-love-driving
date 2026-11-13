import { CAR, ROAD, laneCenter } from '../config.js';
import { roadX, roadYaw, roadCurvature } from '../core/roadmath.js';

// 自车：运动学自行车模型 + 两种驾驶方式
//   巡航（默认）：车道保持（纯跟踪）+ 自适应巡航，A/D 变道，W/S 调设定车速
//   手动：W/S 油门刹车，A/D 方向盘（转向幅度随车速收紧）

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// 电池：100 kWh 的电池包，综合能耗约 15.5 kWh/100km（续航按它估算）；空调、屏幕这些常开的负载约 1.5 kW
const BATTERY_KWH = 100;
const KWH_PER_KM = 0.155;
const AUX_KW = 1.5;
const MASS = 2200;

export class Vehicle {
  constructor() {
    this.z = 0;
    this.targetLane = 1;
    this.laneU = laneCenter(1);
    this.x = roadX(0) + this.laneU;
    this.yaw = roadYaw(0);
    this.speed = 80 / 3.6;
    this.steer = 0; // 前轮转角（弧度），左转为正
    this.steerInput = 0;
    this.accel = 0; // 平滑后的纵向加速度（车身俯仰用）
    this.latAcc = 0; // 平滑后的横向加速度（车身侧倾用），左转为正
    this.auto = true;
    this.cruise = 80 / 3.6;
    this.blinker = 0; // -1 左 / +1 右
    this.scrape = 0; // 蹭护栏
    this.bump = 0; // 追尾冲击
    this.throttle = 0;
    this.braking = false;
    this.power = 0; // 电驱功率（kW），负数是动能回收
    this.energy = 0.77 * BATTERY_KWH; // 电池剩余电量（kWh）
    this._adjust = 0;
  }

  get u() {
    return this.x - roadX(this.z);
  }

  get soc() {
    return this.energy / BATTERY_KWH;
  }

  get range() {
    return this.energy / KWH_PER_KM;
  }

  changeLane(dir, traffic) {
    const nl = clamp(this.targetLane + dir, 0, ROAD.LANES - 1);
    if (nl === this.targetLane) return false;
    if (!traffic.gapFree(laneCenter(nl), this.z)) return false;
    this.targetLane = nl;
    return true;
  }

  setAuto(on) {
    this.auto = on;
    if (on) {
      // 接管时就近选车道，设定车速取当前车速（至少 40km/h）
      const lane = clamp(Math.round((this.u - laneCenter(0)) / ROAD.LANE_W), 0, ROAD.LANES - 1);
      this.targetLane = lane;
      this.laneU = this.u;
      this.cruise = clamp(Math.round((this.speed * 3.6) / 5) * 5, 40, 120) / 3.6;
    } else {
      this.blinker = 0;
    }
  }

  update(dt, input, traffic) {
    const L = CAR.WHEELBASE;
    let acc = 0;
    this.bump = 0;

    if (this.auto) {
      // ---- 设定车速：按住 W/S 每 0.25 秒 ±5km/h
      if (input.throttle || input.brake) {
        this._adjust -= dt;
        if (this._adjust <= 0) {
          this.cruise = clamp(this.cruise + ((input.throttle ? 5 : -5) / 3.6), 30 / 3.6, 120 / 3.6);
          this._adjust = 0.25;
          this.cruiseChanged = true;
        }
      } else {
        this._adjust = 0;
      }

      // ---- 车道保持：朝前方预瞄点转向
      const tu = laneCenter(this.targetLane);
      this.laneU += clamp(tu - this.laneU, -1.2 * dt, 1.2 * dt);
      const look = 7 + this.speed * 0.75;
      const zt = this.z - look;
      const dx = roadX(zt) + this.laneU - this.x;
      const dz = zt - this.z;
      const lat = dx * -Math.cos(this.yaw) + dz * Math.sin(this.yaw); // 目标点在车身左侧为正
      const target = Math.atan((L * 2 * lat) / (dx * dx + dz * dz));
      this.steer += (target - this.steer) * Math.min(1, dt * 6);
      this.blinker = Math.abs(tu - this.laneU) > 0.25 ? Math.sign(tu - this.laneU) : 0;

      // ---- 自适应巡航：保持约 1.5 秒车距
      const lead = traffic.leadFor(this.u, this.z);
      let vDes = this.cruise;
      if (lead.gap < 160) vDes = Math.min(vDes, lead.v + (lead.gap - (5 + this.speed * 1.5)) * 0.35);
      acc = clamp((Math.max(0, vDes) - this.speed) * 0.7, -5.5, 2.0);
      this.throttle = clamp(acc / 2 + 0.15, 0, 1);
      this.braking = acc < -1.0;
    } else {
      // ---- 手动：键盘是开关量，这里做成渐进的方向盘
      const si = input.steer;
      const rate = si !== 0 ? 1.6 : 3.2;
      this.steerInput += clamp(si - this.steerInput, -rate * dt, rate * dt);
      // 限制横向加速度约 3.2 m/s²：车速越高可用转角越小
      const maxSteer = Math.min(0.55, Math.atan((L * 3.2) / Math.max(this.speed * this.speed, 1)));
      // 键盘没法像方向盘那样一直带着一点角度过弯，所以加一层助力：
      // 松开按键时，车头自动跟随道路方向（保持当前的横向位置），按键只负责左右挪车
      const ryNow = roadYaw(this.z);
      const align = ((ryNow - this.yaw) / (0.6 * Math.max(this.speed, 3))) * (1 - Math.abs(this.steerInput));
      const follow = Math.atan(L * (roadCurvature(this.z) + align));
      this.steer += (this.steerInput * maxSteer + follow - this.steer) * Math.min(1, dt * 8);

      const drive = input.throttle ? 3.6 * Math.max(0.1, 1 - this.speed / 55) : 0;
      const resist = this.speed > 0.05 ? 0.14 + 0.00085 * this.speed * this.speed : 0;
      acc = drive - (input.brake ? 8.0 : 0) - resist;
      this.throttle = input.throttle ? 1 : 0;
      this.braking = !!input.brake;
    }

    this.speed = Math.max(0, this.speed + acc * dt);
    this.accel += (acc - this.accel) * Math.min(1, dt * 5);

    // ---- 电驱功率 = (惯性力 + 滚阻 + 风阻) × 车速；松油门、刹车时回收，最多 60 kW。按功率从电池里扣电，回收的按 70% 存回去
    const v = this.speed;
    const kw = v > 0.3 ? Math.max(-60, ((MASS * this.accel + 300 + 0.42 * v * v) * v) / 1000) : 0;
    this.power += (kw - this.power) * Math.min(1, dt * 3);
    const draw = this.power > 0 ? this.power / 0.92 : this.power * 0.7;
    this.energy = clamp(this.energy - ((draw + AUX_KW) * dt) / 3600, 0, BATTERY_KWH);

    const yawRate = (this.speed / L) * Math.tan(this.steer);
    this.yaw += yawRate * dt;
    this.x += -Math.sin(this.yaw) * this.speed * dt;
    this.z += -Math.cos(this.yaw) * this.speed * dt;
    this.latAcc += (this.speed * yawRate - this.latAcc) * Math.min(1, dt * 4);

    // ---- 车头不能偏离道路方向太多（防止手动时掉头）
    const ry = roadYaw(this.z);
    this.yaw = clamp(this.yaw, ry - 0.5, ry + 0.5);

    // ---- 护栏
    const u = this.u;
    const uMin = 0.32 + CAR.WID / 2 + 0.06;
    const uMax = ROAD.BARRIER_U - CAR.WID / 2 - 0.06;
    this.scrape = 0;
    if (u < uMin || u > uMax) {
      this.x += clamp(u, uMin, uMax) - u;
      this.yaw += (ry - this.yaw) * Math.min(1, dt * 10);
      this.speed *= Math.max(0, 1 - 1.2 * dt);
      this.scrape = Math.min(1, this.speed / 10);
    }

    // ---- 与同向车辆的碰撞：只做最简单的「顶住」
    const hit = traffic.collide(this.u, this.z);
    if (hit) {
      if (hit.dz > 0) {
        this.z = hit.car.z + hit.lim + 0.02;
        if (this.speed > hit.car.v) {
          this.bump = Math.min(1, (this.speed - hit.car.v) / 6);
          this.speed = Math.max(0, hit.car.v - 0.5);
        }
      } else {
        hit.car.z = this.z + hit.lim + 0.02;
        hit.car.v = Math.min(hit.car.v, this.speed);
      }
    }
  }
}
