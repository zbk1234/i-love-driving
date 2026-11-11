import * as THREE from 'three';
import { GLASS } from '../config.js';
import { GeoBuilder, V3 } from '../world/geo.js';
import { createWindshieldGeometry, createFlatGlassGeometry, createGlassMaterial } from './glass.js';
import { Cluster, CenterScreen } from './cluster.js';

// 驾驶舱内饰（左舵）。全部用代码搭出来：仪表台是放样曲面，其余是梁和盒子。
// 傍晚 / 夜里车内几乎是剪影，重点是比例、轮廓和几块发光的屏幕。

const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const DEG = Math.PI / 180;

export function createCabin() {
  const group = new THREE.Group();

  // 内饰大多是哑光塑料和织物，用 Lambert 就够了（集显上比 PBR 便宜很多）；只有方向盘的皮革保留高光
  const matte = () => new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide });
  const matSoft = matte();
  const matTrim = matte();
  const matFabric = matte();
  const matLeather = new THREE.MeshStandardMaterial({ color: 0x0b0b0c, roughness: 0.55 });
  const matColumn = new THREE.MeshStandardMaterial({ color: 0x101012, roughness: 0.8 });
  const matSatin = new THREE.MeshStandardMaterial({ color: 0x5a5e63, roughness: 0.4, metalness: 0.5 });

  const add = (builder, material, cast = true) => {
    // 假的环境光遮蔽：越靠近地板越暗（光只从车窗进来）
    for (let i = 0; i < builder.col.length; i += 3) {
      const k = 0.3 + 0.7 * smooth(0.35, 1.0, builder.pos[i + 1]);
      builder.col[i] *= k;
      builder.col[i + 1] *= k;
      builder.col[i + 2] *= k;
    }
    const m = new THREE.Mesh(builder.build(true), material);
    m.castShadow = cast;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };

  const zg = (x) => GLASS.Z0 + GLASS.SWEEP * (x / GLASS.W0) ** 2; // 玻璃底边的 z

  // ------------------------------------------------------------ 仪表台：沿车宽方向放样的截面
  // 截面点 (z, y)，从玻璃根部一路到脚坑。主驾前方混合成带遮光檐的仪表罩。
  const dashProfile = (x) => {
    const g = zg(x);
    const base = [[g - 0.02, 0.925], [g + 0.09, 0.94], [-0.66, 0.952], [-0.6, 0.944], [-0.565, 0.915], [-0.55, 0.86], [-0.54, 0.74], [-0.52, 0.64], [-0.6, 0.55], [-0.78, 0.38]];
    const binn = [[g - 0.02, 0.925], [g + 0.09, 0.945], [-0.64, 1.0], [-0.52, 1.0], [-0.505, 0.985], [-0.52, 0.972], [-0.625, 0.968], [-0.6, 0.85], [-0.55, 0.8], [-0.62, 0.45]];
    const w = smooth(0.27, 0.17, Math.abs(x + 0.36));
    return base.map((p, i) => V3(x, lerp(p[1], binn[i][1], w), lerp(p[0], binn[i][0], w)));
  };
  {
    const b = new GeoBuilder().color(0.02, 0.0205, 0.022);
    const P = [];
    for (let i = 0; i <= 64; i++) P.push(dashProfile(lerp(-0.86, 0.86, i / 64)));
    b.grid(P, { flip: true });
    // 脚坑前壁，防止从仪表台下面看穿
    b.color(0.012, 0.012, 0.013).box(0, 0.5, -0.9, 1.74, 0.75, 0.05);
    add(b, matSoft);
  }

  // ------------------------------------------------------------ 车门、中控台、地板、座椅
  {
    const b = new GeoBuilder();
    for (const s of [-1, 1]) {
      b.color(0.04, 0.041, 0.045);
      b.box(s * 0.815, 0.6, -0.1, 0.05, 0.7, 1.5); // 前门内板
      b.box(s * 0.815, 0.6, 1.2, 0.05, 0.7, 0.98); // 后门内板
      b.color(0.02, 0.0205, 0.022);
      b.box(s * 0.775, 0.94, -0.1, 0.1, 0.035, 1.5); // 窗台
      b.box(s * 0.775, 0.94, 1.2, 0.1, 0.035, 0.98);
      b.box(s * 0.75, 0.7, 0.05, 0.08, 0.055, 0.66); // 扶手
      b.color(0.012, 0.012, 0.014);
      b.box(s * 0.805, 1.005, -0.735, 0.03, 0.13, 0.15); // 后视镜三角盖板
    }
    b.color(0.036, 0.037, 0.04);
    b.box(0, 0.5, 0.12, 0.27, 0.3, 1.25); // 中控台
    b.box(0, 0.675, 0.42, 0.25, 0.05, 0.46); // 中央扶手
    b.color(0.02, 0.02, 0.022).box(0, 0.67, -0.1, 0.07, 0.05, 0.1); // 挡把
    b.color(0.01, 0.01, 0.011).box(0, 0.25, 0.5, 1.72, 0.04, 3.4); // 地板
    b.box(0, 0.7, 2.17, 1.66, 0.74, 0.05); // 后围
    b.box(0, 1.0, 1.96, 1.42, 0.03, 0.42); // 后搁物板
    add(b, matTrim);

    const seat = new GeoBuilder().color(0.045, 0.045, 0.05);
    for (const x of [-0.36, 0.37]) seat.box(x, 0.43, 0.24, 0.5, 0.14, 0.5); // 坐垫
    seat.beam(V3(0.37, 0.48, 0.45), V3(0.37, 1.1, 0.63), 0.5, 0.13); // 副驾靠背
    seat.box(0.37, 1.22, 0.67, 0.26, 0.2, 0.11);
    seat.box(0, 0.45, 1.36, 1.46, 0.16, 0.5); // 后排
    seat.beam(V3(0, 0.5, 1.63), V3(0, 1.08, 1.8), 1.46, 0.14);
    for (const x of [-0.42, 0.42]) seat.box(x, 1.17, 1.84, 0.24, 0.17, 0.1);
    add(seat, matFabric);
  }

  // ------------------------------------------------------------ A/B/C 柱、顶棚、遮阳板
  {
    const b = new GeoBuilder().color(0.15, 0.15, 0.155);
    for (const s of [-1, 1]) {
      b.cyl(V3(s * 0.79, 0.88, -0.82), V3(s * 0.612, 1.43, -0.045), 0.05, 0.043, 14); // A 柱（圆角饰板）
      b.beam(V3(s * 0.61, 1.42, -0.06), V3(s * 0.615, 1.43, 0.64), 0.1, 0.075); // 上边梁
      b.beam(V3(s * 0.615, 1.43, 0.62), V3(s * 0.59, 1.405, 1.56), 0.1, 0.075);
      b.beam(V3(s * 0.81, 0.5, 0.66), V3(s * 0.62, 1.43, 0.66), 0.14, 0.075); // B 柱
      b.beam(V3(s * 0.81, 0.95, 1.78), V3(s * 0.575, 1.41, 1.5), 0.3, 0.08); // C 柱
    }
    // 前风挡上横梁，跟着玻璃的弧度走
    const zt = (x) => GLASS.Z0 + GLASS.DZ + GLASS.SWEEP * (x / GLASS.W0) ** 2 + 0.03;
    for (let k = 0; k < 8; k++) {
      const x0 = lerp(-0.62, 0.62, k / 8);
      const x1 = lerp(-0.62, 0.62, (k + 1) / 8);
      b.beam(V3(x0, 1.43, zt(x0)), V3(x1, 1.43, zt(x1)), 0.1, 0.075);
    }
    b.beam(V3(-0.58, 1.415, 1.6), V3(0.58, 1.415, 1.6), 0.12, 0.07); // 后风挡上横梁
    // 顶棚
    const R = [];
    for (let i = 0; i <= 8; i++) {
      const x = lerp(-0.66, 0.66, i / 8);
      const row = [];
      for (let j = 0; j <= 6; j++) row.push(V3(x, 1.462 - 0.028 * (x / 0.66) ** 2, lerp(-0.14, 1.85, j / 6)));
      R.push(row);
    }
    b.grid(R);
    // 遮阳板
    b.color(0.17, 0.17, 0.175);
    b.box(-0.36, 1.432, 0.03, 0.46, 0.018, 0.17);
    b.box(0.36, 1.432, 0.03, 0.46, 0.018, 0.17);
    add(b, matFabric);
  }

  // ------------------------------------------------------------ 方向盘
  const wheelPivot = new THREE.Group();
  wheelPivot.position.set(-0.36, 0.855, -0.36); // 轮缘上沿刚好在风挡下沿的视线之下，不挡路面
  wheelPivot.rotation.x = -24 * DEG; // 盘面上沿向前倾
  group.add(wheelPivot);
  const wheel = new THREE.Group();
  wheelPivot.add(wheel);
  {
    const part = (geo, mat, parent, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    part(new THREE.TorusGeometry(0.185, 0.0165, 14, 64), matLeather, wheel);
    part(new THREE.CylinderGeometry(0.072, 0.08, 0.05, 28).rotateX(Math.PI / 2), matColumn, wheel, 0, -0.008, -0.012);
    part(new THREE.BoxGeometry(0.118, 0.042, 0.022), matColumn, wheel, -0.126, -0.012, -0.006);
    part(new THREE.BoxGeometry(0.118, 0.042, 0.022), matColumn, wheel, 0.126, -0.012, -0.006);
    part(new THREE.BoxGeometry(0.05, 0.115, 0.02), matColumn, wheel, 0, -0.125, -0.006);
    part(new THREE.CircleGeometry(0.018, 20), matSatin, wheel, 0, -0.008, 0.0135);
    // 转向柱、护罩、拨杆（不跟着方向盘转）
    part(new THREE.CylinderGeometry(0.04, 0.046, 0.32, 16).rotateX(Math.PI / 2), matColumn, wheelPivot, 0, 0, -0.19);
    part(new THREE.BoxGeometry(0.135, 0.115, 0.2), matColumn, wheelPivot, 0, -0.012, -0.15);
    for (const s of [-1, 1]) {
      const stalk = part(new THREE.CylinderGeometry(0.008, 0.011, 0.17, 8).rotateZ(Math.PI / 2), matColumn, wheelPivot, s * 0.145, 0.012, -0.085);
      stalk.rotation.z = s * 0.18;
    }
  }

  // ------------------------------------------------------------ 仪表屏 / 中控屏（自发光）
  const cluster = new Cluster();
  const screen = new CenterScreen();
  const matCluster = new THREE.MeshBasicMaterial({ map: cluster.texture, toneMapped: false });
  const matScreen = new THREE.MeshBasicMaterial({ map: screen.texture, toneMapped: false });
  {
    const b = new GeoBuilder();
    b.quad(V3(-0.513, 0.857, -0.594), V3(-0.207, 0.857, -0.594), V3(-0.207, 0.964, -0.619), V3(-0.513, 0.964, -0.619));
    const m = new THREE.Mesh(b.build(true), matCluster);
    group.add(m);

    const M = new THREE.Matrix4()
      .makeTranslation(0.02, 0.935, -0.53)
      .multiply(new THREE.Matrix4().makeRotationY(-8 * DEG))
      .multiply(new THREE.Matrix4().makeRotationX(-12 * DEG));
    const s = new GeoBuilder().xform(M);
    s.quad(V3(-0.152, -0.08, 0.004), V3(0.152, -0.08, 0.004), V3(0.152, 0.08, 0.004), V3(-0.152, 0.08, 0.004));
    group.add(new THREE.Mesh(s.build(true), matScreen));
    const bezel = new GeoBuilder().xform(M).color(0.008, 0.008, 0.009);
    bezel.box(0, 0, -0.008, 0.322, 0.178, 0.02);
    bezel.box(0, -0.1, -0.03, 0.06, 0.06, 0.05); // 支架
    add(bezel, matTrim);

    // 贯穿仪表台的氛围灯条
    const strip = new GeoBuilder();
    strip.quad(V3(-0.8, 0.795, -0.5435), V3(0.8, 0.795, -0.5435), V3(0.8, 0.8, -0.544), V3(-0.8, 0.8, -0.544));
    group.add(new THREE.Mesh(strip.build(true), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.42, 0.95), toneMapped: false, side: THREE.DoubleSide })));
  }

  // ------------------------------------------------------------ 车窗玻璃（雨滴着色器）
  const glass = {
    front: createGlassMaterial({ wipers: true, frit: 0.034, lens: 0.11, tint: [0.84, 0.89, 0.87] }),
    // 侧窗的水膜比前挡没刮到的地方薄：水珠照旧，但不至于糊得看不清外后视镜
    left: createGlassMaterial({ lens: 0.1, tint: [0.72, 0.78, 0.76], wet: 0.5 }),
    right: createGlassMaterial({ lens: 0.1, tint: [0.72, 0.78, 0.76], wet: 0.5 }),
    rear: createGlassMaterial({ lens: 0.1, tint: [0.6, 0.65, 0.64], wet: 0.8 }),
  };
  const addGlass = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.renderOrder = 10; // 在内饰之后画：被方向盘、立柱挡住的玻璃像素不用跑昂贵的雨滴着色器
    group.add(m);
  };
  addGlass(createWindshieldGeometry(), glass.front);
  // 侧窗角点顺序：从车内看的 左下、右下、右上、左上；玻璃坐标 x 永远指向屏幕右侧
  addGlass(createFlatGlassGeometry([[-0.83, 0.955, 0.6], [-0.83, 0.955, -0.8], [-0.635, 1.41, -0.06], [-0.64, 1.42, 0.6]], [[-0.6, 0], [0.8, 0], [0.06, 0.49], [-0.6, 0.5]]), glass.left);
  addGlass(createFlatGlassGeometry([[-0.83, 0.955, 1.56], [-0.83, 0.955, 0.72], [-0.64, 1.42, 0.72], [-0.61, 1.405, 1.42]], [[-1.56, 0], [-0.72, 0], [-0.72, 0.5], [-1.42, 0.49]]), glass.left);
  addGlass(createFlatGlassGeometry([[0.83, 0.955, -0.8], [0.83, 0.955, 0.6], [0.64, 1.42, 0.6], [0.635, 1.41, -0.06]], [[-0.8, 0], [0.6, 0], [0.6, 0.5], [-0.06, 0.49]]), glass.right);
  addGlass(createFlatGlassGeometry([[0.83, 0.955, 0.72], [0.83, 0.955, 1.56], [0.61, 1.405, 1.42], [0.64, 1.42, 0.72]], [[0.72, 0], [1.56, 0], [1.42, 0.49], [0.72, 0.5]]), glass.right);
  addGlass(createFlatGlassGeometry([[0.58, 1.02, 2.13], [-0.58, 1.02, 2.13], [-0.52, 1.41, 1.64], [0.52, 1.41, 1.64]], [[-0.58, 0], [0.58, 0], [0.52, 0.62], [-0.52, 0.62]]), glass.rear);

  // ------------------------------------------------------------ 兜底背景：玻璃没盖住的缝隙直接显示外景
  const matBg = new THREE.ShaderMaterial({
    uniforms: { tScene: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 1.0, 1.0); }',
    fragmentShader: 'uniform sampler2D tScene; uniform vec2 uRes; void main() { gl_FragColor = vec4(texture2D(tScene, gl_FragCoord.xy / uRes).rgb, 1.0); }',
    depthWrite: false,
  });
  {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const m = new THREE.Mesh(g, matBg);
    m.frustumCulled = false;
    m.renderOrder = 20; // 最后画，贴在最远的深度上，只填没被任何东西盖住的像素
    group.add(m);
  }

  // ------------------------------------------------------------ 车内的几盏「灯」
  // 屏幕的冷光打在方向盘和驾驶员一侧
  const clusterGlow = new THREE.PointLight(0x9fc6ff, 0.035, 1.3, 2);
  clusterGlow.position.set(-0.36, 0.93, -0.5);
  group.add(clusterGlow);
  // 从前风挡照进来的天光
  const skyFill = new THREE.DirectionalLight(0xffffff, 0.3);
  skyFill.position.set(0, 3.2, -3.4);
  skyFill.target.position.set(0, 1.0, 0);
  group.add(skyFill, skyFill.target);

  return { group, wheel, cluster, screen, glass, matBg, matCluster, matScreen, clusterGlow, skyFill };
}
