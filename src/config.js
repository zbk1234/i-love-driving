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
// 车身和内饰来自 public/models/car.glb（双门轿跑），下面的数字都是照着模型量出来的。
export const CAR = {
  MODEL: 'models/car.glb',
  LEN: 4.6,
  WID: 1.86,
  WHEELBASE: 2.75,
  // 驾驶员眼睛的位置：正对方向盘中心，比风挡上沿低约 17cm（轿跑的坐姿很低）
  EYE: [-0.365, 1.12, 0.1],
  HEAD_Y: 0.67,
  HEAD_Z: -2.05,
  // 方向盘：轮心位置，以及转轴方向（指向驾驶员）
  WHEEL_C: [-0.3645, 0.881, -0.35],
  WHEEL_AXIS: [0, 0.375, 0.927],
};

// 前挡风玻璃曲面参数（玻璃坐标 gx 横向、gy 沿玻璃向上，单位米）。
// 车内看到的玻璃用的是模型自己的网格；这组参数是对它的拟合，
// 用来在「玻璃坐标」和车体坐标之间互相换算（雨刮的位置、水珠的坐标都靠它）。
export const GLASS = {
  W0: 0.66, // 底边半宽
  W1: 0.56, // 顶边半宽
  H: 0.693, // 沿斜面的高度
  Y0: 0.973,
  DY: 0.317,
  Z0: -0.97,
  DZ: 0.616,
  SWEEP: 0.115, // 两侧向后弯的量
  BULGE: 0.02, // 中段向外鼓的量
};

// 雨刮（玻璃坐标）。左舵车的顺刮式布置：停靠时两支刮片都指向右侧，一起向左上方刮。
//   · 主驾转轴靠近左侧 A 柱根部，刮到头时刮片几乎竖直、贴着 A 柱
//   · 副驾转轴在风挡正中附近，刮片短一些，但摆角比主驾略大
//   · 刮片中点挂在刮臂末端，所以刮片内外端半径 = 臂长 ∓ 片长 / 2
// 这块风挡比普通轿车矮（斜面只有 69cm），刮片长度按它缩过。
export const WIPERS = [
  { pivot: [-0.52, -0.03], arm: 0.42, blade: 0.56, a0: 0.06, a1: 1.5 }, // 主驾
  { pivot: [0.04, -0.03], arm: 0.36, blade: 0.46, a0: 0.06, a1: 1.6 }, // 副驾
].map((w) => ({ ...w, rIn: w.arm - w.blade / 2, rOut: w.arm + w.blade / 2 }));

// 画质预设。开始页上可以选，行驶中按 Q 切换，选择会记在本机。
//   pixelRatio 渲染分辨率相对屏幕像素的上限（高分屏上才会超过 1）
//   dynamic    帧率不够时是否自动降低分辨率
//   world      外景的渲染分辨率倍率（外景是隔着湿玻璃看的，略低一点几乎看不出来）
//   msaa       多重采样抗锯齿的采样数（0 = 只用 FXAA）
//   drops      雨丝数量
//   shadow     车内阴影贴图的边长（0 = 不要阴影）
export const QUALITY = {
  low: { name: '低', pixelRatio: 0.75, dynamic: true, world: 0.7, msaa: 0, drops: 2600, shadow: 0 },
  mid: { name: '中', pixelRatio: 1.25, dynamic: true, world: 0.8, msaa: 0, drops: 5200, shadow: 768 },
  high: { name: '高', pixelRatio: 1.5, dynamic: false, world: 1, msaa: 2, drops: 7000, shadow: 1024 },
  ultra: { name: '极高', pixelRatio: 2, dynamic: false, world: 1, msaa: 4, drops: 9000, shadow: 2048 },
};
export const QUALITY_KEYS = Object.keys(QUALITY);
export const MAX_DROPS = Math.max(...QUALITY_KEYS.map((k) => QUALITY[k].drops));
