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
// 车身和内饰来自 public/models/NIO ET5T 2023.glb（蔚来 ET5T 旅行车），下面的数字都是照着模型量出来的。
export const CAR = {
  MODEL: 'models/NIO ET5T 2023.glb',
  LEN: 4.79,
  WID: 1.96,
  WHEELBASE: 2.888,
  // 驾驶员眼睛的位置：正对方向盘中心，头枕前面约 18cm，离顶棚约 15cm
  EYE: [-0.395, 1.18, 0.17],
  HEAD_Y: 0.76,
  HEAD_Z: -2.15,
  // 方向盘：轮心位置，以及转轴方向（指向驾驶员）
  WHEEL_C: [-0.395, 0.945, -0.335],
  WHEEL_AXIS: [0, 0.34, 0.94],
};

// 杯托里的饮料罐（public/models/monster_energy.glb），放在中控屏下方、中控台前段靠副驾那个深杯托的前半截。
//   POS 罐底中心，照着车模量的（杯托底面 y≈0.654，坑宽 x 0.02..0.09，前壁在 z≈-0.32）
//   H   罐高，500ml 的魔爪约 17cm（直径随模型比例约 6.4cm）
//   YAW 绕竖轴转的角度：模型里商标朝 +Z 偏右 10° 左右，转过来朝着驾驶员
export const CAN = {
  MODEL: 'models/monster_energy.glb',
  POS: [0.055, 0.654, -0.28],
  H: 0.169,
  YAW: -0.98,
};

// 前挡风玻璃曲面参数（玻璃坐标 gx 横向、gy 沿玻璃向上，单位米）。
// 车内看到的玻璃用的是模型自己的网格；这组参数是对它的拟合，
// 用来在「玻璃坐标」和车体坐标之间互相换算（雨刮的位置、水珠的坐标都靠它）。
export const GLASS = {
  W0: 0.8, // 底边半宽
  W1: 0.66, // 顶边半宽
  H: 1.064, // 沿斜面的高度（这块风挡很斜，一直伸到驾驶员头顶前面）
  Y0: 0.915,
  DY: 0.49,
  Z0: -1.21,
  DZ: 0.945,
  SWEEP: 0.16, // 两侧向后弯的量
  BULGE: 0.025, // 中段向外鼓的量
};

// 雨刮（玻璃坐标）。左舵车的顺刮式布置：停靠时两支刮片都指向右侧，一起向左上方刮。
//   · 主驾转轴靠近左侧 A 柱根部，刮到头时刮片几乎竖直、贴着 A 柱
//   · 副驾转轴在风挡正中附近，刮片短一些，但摆角比主驾略大
//   · 刮片中点挂在刮臂末端，所以刮片内外端半径 = 臂长 ∓ 片长 / 2
// 这块风挡又宽又斜（斜面 1.06m），主驾刮片按 26 寸、副驾按 21 寸配。
export const WIPERS = [
  { pivot: [-0.55, -0.02], arm: 0.55, blade: 0.66, a0: 0.06, a1: 1.5 }, // 主驾
  { pivot: [0.08, -0.02], arm: 0.42, blade: 0.54, a0: 0.06, a1: 1.6 }, // 副驾
].map((w) => ({ ...w, rIn: w.arm - w.blade / 2, rOut: w.arm + w.blade / 2 }));

// 主驾电动车窗（左前门玻璃，按 V 升降）。数字是左侧窗的玻璃坐标（gx 朝车头为正，gy 沿玻璃向上），照着模型量的：
// 左侧玻璃网格里有三块：gx > X0 的是前门玻璃，后面的后门玻璃和后三角窗是固定的。
export const WINDOW = {
  X0: -0.35,
  SILL: [0.028, -0.044], // 门槛密封条（= 玻璃关严时的下沿）：gy = a + b·gx，后高前低
  TRAVEL: 0.45, // 降到底时沿斜面移动的距离（门玻璃最高处离门槛约 0.44 m）
  TIME: 3.4, // 升降全程的秒数
};

// 前挡 HUD：投在主驾正前方风挡下部的 LivLiv 角色（hud.js）。数字是前挡的玻璃坐标：
//   CX 中心的 gx，Y0 下沿的 gy，H 沿斜面的高度；宽度按角色画面的宽高比、从驾驶员眼睛看过去不变形自动算出
//   MODEL 角色所在目录（public 下），来自 livliv-dev/player 仓库的精选角色
export const HUD = {
  MODEL: 'characters/k01/',
  ASPECT: 2 / 3,
  CX: -0.38,
  Y0: 0.2,
  H: 0.5,
};

// 画质预设。开始页上可以选，行驶中按 Q 切换，选择会记在本机。
//   pixelRatio 渲染分辨率相对屏幕像素的上限（高分屏上才会超过 1）
//   dynamic    帧率不够时是否自动降低分辨率
//   world      外景的渲染分辨率倍率（外景是隔着湿玻璃看的，略低一点几乎看不出来）
//   msaa       多重采样抗锯齿的采样数（0 = 只用 FXAA）
//   drops      雨丝数量
//   shadow     车内阴影贴图的边长（0 = 不要阴影）
//   sim        车窗水珠模拟的贴图宽度（0 = 不模拟，用解析的水珠）
export const QUALITY = {
  low: { name: '低', pixelRatio: 0.75, dynamic: true, world: 0.7, msaa: 0, drops: 2600, shadow: 0, sim: 0 },
  mid: { name: '中', pixelRatio: 1.25, dynamic: true, world: 0.8, msaa: 0, drops: 5200, shadow: 768, sim: 1536 },
  high: { name: '高', pixelRatio: 1.5, dynamic: false, world: 1, msaa: 2, drops: 7000, shadow: 1024, sim: 2048 },
  ultra: { name: '极高', pixelRatio: 2, dynamic: false, world: 1, msaa: 4, drops: 9000, shadow: 2048, sim: 3072 },
};
export const QUALITY_KEYS = Object.keys(QUALITY);
export const MAX_DROPS = Math.max(...QUALITY_KEYS.map((k) => QUALITY[k].drops));
