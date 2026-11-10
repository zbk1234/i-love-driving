// 全局尺寸常量，单位：米。
// 坐标约定：Y 向上，车辆沿 -Z 行驶，右手边是 +X。
// 道路用「横向偏移 u」描述：u = x - roadX(z)，u=0 是中央隔离带，本方向车道在 u>0 一侧。

export const ROAD = {
  LANE_W: 3.75,
  LANES: 3,
  EDGE_IN: 1.0, // 内侧边线
  EDGE_OUT: 12.25, // 外侧边线 = EDGE_IN + LANES * LANE_W
  BARRIER_U: 15.0, // 外侧护栏内表面
  HALF_W: 15.3, // 桥面半宽
  // 道路中心线：x = Σ a·sin(k·z + p)，平缓的大半径弯道
  CURVE: [
    [90, 0.002, 0.6],
    [25, 0.0057, 2.1],
  ],
  // 每行驶 REBASE 米把世界原点挪一次，保证 float32 精度；
  // 所有沿路重复的间距都必须能整除它。
  REBASE: 2400,
  LAMP_S: 40, // 路灯间距
  LAMP_H: 10.5,
  LAMP_U: 2.4, // 灯头相对中央隔离带的横向伸出
  JOINT_S: 30, // 高架伸缩缝间距
};

export const laneCenter = (i) => ROAD.EDGE_IN + ROAD.LANE_W * (i + 0.5);

// 自车（左舵）。车体局部坐标：原点在轴距中心的地面，车头朝 -Z。
export const CAR = {
  LEN: 4.7,
  WID: 1.86,
  WHEELBASE: 2.8,
  EYE: [-0.36, 1.2, 0.12],
  HEAD_Y: 0.68,
  HEAD_Z: -2.05,
};

// 前挡风玻璃曲面参数（玻璃坐标 gx 横向、gy 沿玻璃向上，单位米）
export const GLASS = {
  W0: 0.74, // 底边半宽
  W1: 0.58, // 顶边半宽
  H: 0.92, // 沿斜面的高度
  Y0: 0.94,
  DY: 0.46,
  Z0: -1.0,
  DZ: 0.8,
  SWEEP: 0.2, // 两侧向后弯的量
};

// 雨刮（玻璃坐标）。左舵车：停靠时刮片指向右侧，向左上方刮。
export const WIPERS = [
  { pivot: [-0.5, -0.035], rIn: 0.16, rOut: 0.74, a0: 0.05, a1: 1.7 }, // 主驾
  { pivot: [0.13, -0.035], rIn: 0.15, rOut: 0.66, a0: 0.05, a1: 1.62 }, // 副驾
];
