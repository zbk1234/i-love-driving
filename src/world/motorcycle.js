import * as THREE from 'three';
import { GeoBuilder, V3 } from './geo.js';

// Cruiser lamps sit behind the front wheel, so sprite offsets differ from body bounds.
export const MOTORCYCLE_SPEC = {
  len: 2.65,
  wid: 0.95,
  tail: [-0.07, 0.07, 0.565, 0.655],
  head: [0, 1.015],
  top: 1.65,
  headZ: -0.96,
  tailZ: 1.319,
};

const CHROME = [0.58, 0.62, 0.65];
const STEEL = [0.19, 0.21, 0.23];
const BLACK = [0.012, 0.014, 0.017];
const LEATHER = [0.023, 0.019, 0.018];
const DENIM = [0.032, 0.052, 0.081];
const Y_AXIS = V3(0, 1, 0);
const WHEEL_ROTATION = new THREE.Quaternion().setFromAxisAngle(Y_AXIS, Math.PI / 2);

// Bake the inverse-transpose normal transform before merging non-uniformly scaled primitives.
function append(builder, geometry, centre, scale, rotation) {
  const matrix = new THREE.Matrix4().compose(
    V3(...centre), rotation || new THREE.Quaternion(), V3(...scale),
  );
  geometry.applyMatrix4(matrix);
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  const uv = geometry.getAttribute('uv');
  const count = geometry.index ? geometry.index.count : position.count;
  const p = V3();
  const n = V3();
  for (let i = 0; i < count; i++) {
    const k = geometry.index ? geometry.index.getX(i) : i;
    p.fromBufferAttribute(position, k);
    n.fromBufferAttribute(normal, k);
    builder.vert(p, n, uv.getX(k), uv.getY(k));
  }
  geometry.dispose();
}

export function buildMotorcycle(paint = [0.15, 0.025, 0.012]) {
  const b = new GeoBuilder();
  const material = (colour, data = 0, emission = 0) => b.color(...colour).data(data).emis(emission);
  const ellipsoid = (centre, radii, rotation, segments = 12) => {
    append(b, new THREE.SphereGeometry(1, segments, 6), centre, radii, rotation);
  };
  const cylinder = (a, c, ra, rc = ra, segments = 8, capped = true) => {
    const start = V3(...a);
    const end = V3(...c);
    const axis = end.clone().sub(start);
    const rotation = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, axis.clone().normalize());
    append(b, new THREE.CylinderGeometry(rc, ra, axis.length(), segments, 1, !capped),
      start.add(end).multiplyScalar(0.5).toArray(), [1, 1, 1], rotation);
  };
  const curve = (points, radius, segments = 16, radial = 5) => {
    const path = new THREE.CatmullRomCurve3(points.map((p) => V3(...p)));
    append(b, new THREE.TubeGeometry(path, segments, radius, radial, false), [0, 0, 0], [1, 1, 1]);
  };
  const torus = (centre, radius, tube, rotation = WHEEL_ROTATION, radial = 6, segments = 24, scale = [1, 1, 1]) => {
    append(b, new THREE.TorusGeometry(radius, tube, radial, segments), centre, scale, rotation);
  };

  for (const [z, r, halfWidth] of [[-0.965, 0.36, 0.087], [0.915, 0.35, 0.108]]) {
    const rear = z > 0;
    const rubber = rear ? 0.097 : 0.087;
    material([0.011, 0.012, 0.014], 3);
    torus([0, r, z], r - rubber, rubber, WHEEL_ROTATION, 8, 32, [1, 1, halfWidth / rubber]);
    const rimR = rear ? 0.21 : 0.232;
    const rimX = rear ? 0.081 : 0.064;
    material(CHROME, 1);
    for (const side of [-1, 1]) {
      torus([side * rimX, r, z], rimR, 0.014);
      for (let i = 0; i < 16; i++) {
        const angle = i * Math.PI / 8 + (side > 0 ? Math.PI / 16 : 0);
        const rootAngle = angle + side * 0.28;
        cylinder(
          [side * 0.048, r + Math.cos(rootAngle) * 0.043, z + Math.sin(rootAngle) * 0.043],
          [side * rimX, r + Math.cos(angle) * rimR, z + Math.sin(angle) * rimR],
          0.004, 0.004, 5, false,
        );
      }
    }
    cylinder([-0.10, r, z], [0.10, r, z], 0.048, 0.048, 12);
    material(STEEL, 1);
    cylinder([-0.108, r, z], [-0.114, r, z], 0.13, 0.13, 20);
    material(BLACK, 3);
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      const y = r + Math.cos(angle) * 0.102;
      const zz = z + Math.sin(angle) * 0.102;
      cylinder([-0.115, y, zz], [-0.116, y, zz], 0.008, 0.008, 5);
    }
    b.box(-0.12, r + 0.075, z + 0.087, 0.048, 0.07, 0.072);
    material(CHROME, 1);
    cylinder([-0.173, r, z], [0.173, r, z], 0.019, 0.019, 10);
  }

  const fender = (cy, cz, radius, halfWidth, from, to) => {
    const shell = (offset) => Array.from({ length: 13 }, (_, i) => {
      const angle = from + (to - from) * i / 12;
      return Array.from({ length: 5 }, (_, j) => {
        const t = j / 2 - 1;
        const rr = radius - 0.024 * t * t + offset;
        return V3(t * halfWidth, cy + Math.cos(angle) * rr, cz + Math.sin(angle) * rr);
      });
    });
    const outer = shell(0);
    const inner = shell(-0.009);
    material(paint);
    b.grid(outer).grid(inner, { flip: true });
    for (let i = 0; i < 12; i++) {
      b.quad(outer[i][0], inner[i][0], inner[i + 1][0], outer[i + 1][0]);
      b.quad(outer[i][4], outer[i + 1][4], inner[i + 1][4], inner[i][4]);
    }
    for (let j = 0; j < 4; j++) {
      b.quad(outer[0][j], outer[0][j + 1], inner[0][j + 1], inner[0][j]);
      b.quad(outer[12][j], inner[12][j], inner[12][j + 1], outer[12][j + 1]);
    }
    material(CHROME, 1);
    for (const edge of [0, 4]) curve(outer.map((row) => row[edge].toArray()), 0.005, 10, 4);
  };
  fender(0.36, -0.965, 0.392, 0.107, -1.08, 1.08);
  fender(0.35, 0.915, 0.41, 0.145, -1.04, Math.PI / 2);

  material(BLACK, 3);
  for (const side of [-1, 1]) {
    const x = side * 0.125;
    curve([[x, 0.89, -0.52], [x, 0.55, -0.50], [x, 0.275, -0.39],
      [x, 0.275, 0.35], [x, 0.67, 0.43], [x, 0.79, 0.10]], 0.026, 18);
    cylinder([x, 0.80, 0.11], [x, 0.92, -0.49], 0.026);
    cylinder([x, 0.39, 0.24], [side * 0.16, 0.35, 0.915], 0.026);
    cylinder([x, 0.70, 0.46], [side * 0.16, 0.35, 0.915], 0.018);
  }
  cylinder([-0.14, 0.29, -0.36], [0.14, 0.29, -0.36], 0.025);
  b.beam(V3(-0.143, 0.49, 0.08), V3(-0.143, 0.52, 0.915), 0.025, 0.021);
  b.beam(V3(-0.143, 0.28, 0.08), V3(-0.143, 0.19, 0.915), 0.025, 0.021);
  material(STEEL);
  torus([-0.136, 0.35, 0.915], 0.175, 0.012, WHEEL_ROTATION, 5, 24);

  for (const side of [-1, 1]) {
    material(STEEL, 1);
    cylinder([side * 0.145, 0.36, -0.965], [side * 0.145, 0.69, -0.762], 0.035, 0.03, 10);
    material(CHROME, 1);
    cylinder([side * 0.145, 0.64, -0.793], [side * 0.145, 1.035, -0.55], 0.022, 0.022, 10);
    cylinder([side * 0.105, 0.60, -0.965], [side * 0.145, 0.42, -0.93], 0.009, 0.009, 6);
    const lower = V3(side * 0.17, 0.38, 0.86);
    const upper = V3(side * 0.17, 0.70, 0.53);
    cylinder(lower.toArray(), upper.toArray(), 0.022, 0.022, 8);
    const axis = upper.clone().sub(lower).normalize();
    const u = V3(1, 0, 0);
    const v = axis.clone().cross(u).normalize();
    const coil = [];
    for (let i = 0; i <= 36; i++) {
      const t = i / 36;
      const angle = t * Math.PI * 10;
      coil.push(lower.clone().lerp(upper, 0.12 + t * 0.72)
        .addScaledVector(u, Math.cos(angle) * 0.037)
        .addScaledVector(v, Math.sin(angle) * 0.037).toArray());
    }
    curve(coil, 0.006, 30, 4);
  }
  material(STEEL, 1);
  cylinder([-0.17, 0.90, -0.63], [0.17, 0.90, -0.63], 0.031);
  cylinder([-0.17, 1.02, -0.56], [0.17, 1.02, -0.56], 0.026);

  material(STEEL);
  ellipsoid([0, 0.435, -0.085], [0.181, 0.145, 0.185]);
  for (const direction of [-1, 1]) {
    const root = V3(0, 0.465, -0.085 + direction * 0.041);
    const axis = V3(0, Math.cos(0.43), direction * Math.sin(0.43));
    const end = root.clone().addScaledVector(axis, 0.263);
    material(BLACK, 3);
    cylinder(root.toArray(), end.toArray(), 0.092, 0.101, 12);
    for (let i = 0; i < 7; i++) {
      const centre = root.clone().addScaledVector(axis, 0.06 + i * 0.027);
      material(i % 2 ? [0.28, 0.29, 0.30] : STEEL, 1);
      cylinder(centre.toArray(), centre.clone().addScaledVector(axis, 0.009).toArray(), 0.12, 0.12, 12);
    }
    const rotation = new THREE.Quaternion().setFromUnitVectors(Y_AXIS, axis);
    material(CHROME, 1);
    ellipsoid(end.toArray(), [0.131, 0.037, 0.111], rotation);
    for (const x of [-0.115, 0.115]) {
      cylinder([x, 0.47, -0.085 + direction * 0.045],
        [x, end.y - 0.005, end.z + direction * 0.026], 0.01, 0.01, 6);
    }
  }
  material(CHROME, 1);
  ellipsoid([-0.183, 0.417, 0.075], [0.05, 0.102, 0.245]);
  cylinder([0.174, 0.438, -0.095], [0.204, 0.438, -0.095], 0.105, 0.10, 16);
  cylinder([0.158, 0.589, -0.092], [0.238, 0.589, -0.092], 0.106, 0.106, 16);
  material(STEEL);
  cylinder([0.239, 0.589, -0.092], [0.243, 0.589, -0.092], 0.071, 0.071, 16);
  material(CHROME, 1);
  cylinder([0.243, 0.589, -0.092], [0.247, 0.589, -0.092], 0.013, 0.013, 8);

  const tank = [
    [-0.565, 0.847, 0.022, 0.020], [-0.50, 0.850, 0.140, 0.095],
    [-0.37, 0.850, 0.225, 0.148], [-0.18, 0.848, 0.215, 0.137],
    [0.04, 0.824, 0.132, 0.077], [0.18, 0.803, 0.020, 0.018],
  ].map(([z, y, width, height]) => Array.from({ length: 16 }, (_, j) => {
    const angle = j * Math.PI / 8;
    return V3(Math.cos(angle) * width, y + Math.sin(angle) * height, z);
  }));
  material(paint);
  b.grid(tank, { closed: true, flip: true }).fan(tank[0], true).fan(tank[tank.length - 1]);
  material([0.54, 0.40, 0.22]);
  for (const side of [-1, 1]) {
    curve([[side * 0.144, 0.875, -0.495], [side * 0.222, 0.889, -0.37],
      [side * 0.210, 0.884, -0.18], [side * 0.125, 0.857, 0.04]], 0.0035, 10, 4);
  }
  material(CHROME, 1);
  b.box(0, 0.994, -0.335, 0.05, 0.014, 0.19);
  cylinder([0.066, 0.973, -0.19], [0.066, 0.990, -0.19], 0.030, 0.030, 12);
  cylinder([0, 0.997, -0.35], [0, 1.013, -0.35], 0.037, 0.037, 16);
  material(BLACK, 3);
  cylinder([0, 1.014, -0.35], [0, 1.016, -0.35], 0.030, 0.030, 16);
  material([0.78, 0.73, 0.60]);
  b.beam(V3(0, 1.017, -0.35), V3(0.014, 1.017, -0.368), 0.003, 0.002);

  material(LEATHER, 3);
  ellipsoid([0, 0.747, 0.32], [0.225, 0.054, 0.26]);
  ellipsoid([0, 0.789, 0.636], [0.157, 0.048, 0.163]);
  material([0.095, 0.073, 0.055]);
  for (const side of [-1, 1]) curve([[side * 0.13, 0.781, 0.12],
    [side * 0.20, 0.775, 0.33], [side * 0.15, 0.782, 0.51]], 0.003, 10, 5);

  for (const side of [-1, 1]) {
    const cx = side * 0.3335;
    const rings = [[0.40, 0.108, 0.267], [0.43, 0.129, 0.32],
      [0.685, 0.129, 0.32], [0.735, 0.116, 0.292]].map(([y, w, d]) => {
      const bevel = 0.035;
      return [[-w + bevel, -d], [w - bevel, -d], [w, -d + bevel], [w, d - bevel],
        [w - bevel, d], [-w + bevel, d], [-w, d - bevel], [-w, -d + bevel]]
        .map(([x, z]) => V3(cx + x, y, 0.823 + z));
    });
    material(LEATHER, 3);
    b.grid(rings, { closed: true }).fan(rings[0]).fan(rings[3], true);
    material([0.04, 0.032, 0.029]);
    b.box(cx, 0.707, 0.823, 0.254, 0.041, 0.593);
    for (const z of [0.65, 0.995]) {
      material([0.065, 0.045, 0.032], 3);
      b.box(side * 0.4635, 0.604, z, 0.008, 0.192, 0.031);
      material(CHROME, 1);
      b.box(side * 0.4685, 0.571, z, 0.009, 0.033, 0.040);
      material(BLACK, 3);
      b.box(side * 0.4735, 0.571, z, 0.003, 0.018, 0.023);
    }
  }

  for (const [height, x, startZ] of [[0.249, 0.294, -0.24], [0.342, 0.317, 0.09]]) {
    material(CHROME, 1);
    curve([[0.13, 0.682, startZ], [0.245, 0.61, startZ - 0.08],
      [x, 0.40, startZ - 0.12], [x, height, startZ - 0.01], [x, height, 0.30]], 0.029, 18, 7);
    cylinder([x, height, 0.19], [x, height, 1.13], 0.043, 0.047, 12);
    material(BLACK, 3);
    cylinder([x, height, 1.131], [x, height, 1.133], 0.038, 0.038, 12);
    material(CHROME, 1);
    torus([x, height, 1.133], 0.042, 0.005, new THREE.Quaternion(), 5, 16);
  }

  material(CHROME, 1);
  for (const side of [-1, 1]) {
    cylinder([side * 0.08, 1.01, -0.555], [side * 0.08, 1.13, -0.515], 0.018);
  }
  curve([[-0.45, 1.145, -0.337], [-0.33, 1.147, -0.415], [-0.16, 1.14, -0.54],
    [0, 1.135, -0.545], [0.16, 1.14, -0.54], [0.33, 1.147, -0.415],
    [0.45, 1.145, -0.337]], 0.015, 24);
  for (const side of [-1, 1]) {
    material(BLACK, 3);
    cylinder([side * 0.365, 1.147, -0.391], [side * 0.451, 1.145, -0.335], 0.025, 0.025, 10);
    curve([[side * 0.33, 1.135, -0.425], [side * 0.25, 1.02, -0.62],
      [side * 0.10, 0.84, -0.57]], 0.005, 10, 5);
    material(CHROME, 1);
    cylinder([side * 0.335, 1.15, -0.427], [side * 0.443, 1.14, -0.395], 0.008, 0.006, 6);
    cylinder([side * 0.315, 1.15, -0.436], [side * 0.37, 1.286, -0.48], 0.008, 0.008, 6);
    ellipsoid([side * 0.372, 1.294, -0.487], [0.057, 0.035, 0.013]);
    material([0.12, 0.17, 0.20], 1);
    ellipsoid([side * 0.372, 1.294, -0.474], [0.049, 0.027, 0.003]);
    material(STEEL, 1);
    cylinder([side * 0.125, 0.271, -0.424], [side * 0.392, 0.271, -0.424], 0.016);
    material(BLACK, 3);
    b.box(side * 0.305, 0.27, -0.416, 0.18, 0.035, 0.155);
  }

  material(CHROME, 1);
  cylinder([0, 1.015, -0.703], [0, 1.015, -0.937], 0.062, 0.102, 20);
  torus([0, 1.015, -0.947], 0.096, 0.01, new THREE.Quaternion(), 6, 24);
  material([1.0, 0.89, 0.69], 0, 2.5);
  ellipsoid([0, 1.015, -0.947], [0.087, 0.087, 0.013], undefined, 16);
  material(BLACK, 3);
  b.box(0, 0.603, 1.272, 0.159, 0.107, 0.042);
  material(CHROME, 1);
  ellipsoid([0, 0.61, 1.291], [0.082, 0.055, 0.021]);
  material([1.0, 0.025, 0.009], 0, 1.0);
  ellipsoid([0, 0.61, 1.305], [0.07, 0.045, 0.014]);
  material(STEEL);
  b.box(0, 0.48, 1.305, 0.15, 0.076, 0.012);
  material([0.58, 0.59, 0.54], 2);
  b.box(0, 0.482, 1.313, 0.125, 0.055, 0.003);

  material(DENIM, 3);
  ellipsoid([0, 0.829, 0.32], [0.17, 0.108, 0.142]);
  for (const side of [-1, 1]) {
    const hip = [side * 0.117, 0.83, 0.32];
    const knee = [side * 0.254, 0.616, -0.182];
    const ankle = [side * 0.30, 0.345, -0.351];
    material(DENIM, 3);
    cylinder(hip, knee, 0.095, 0.078, 10);
    ellipsoid(knee, [0.081, 0.082, 0.085]);
    cylinder(knee, ankle, 0.074, 0.051, 10);
    material([0.064, 0.083, 0.108], 3);
    curve([[side * 0.207, 0.82, 0.30], [side * 0.331, 0.62, -0.18],
      [side * 0.351, 0.37, -0.33]], 0.003, 10, 4);
    material(LEATHER, 3);
    ellipsoid([side * 0.30, 0.294, -0.433], [0.074, 0.075, 0.151]);
    ellipsoid([side * 0.30, 0.361, -0.343], [0.062, 0.091, 0.072]);
    material(BLACK, 3);
    b.box(side * 0.30, 0.223, -0.433, 0.144, 0.029, 0.302);
    material(STEEL);
    b.box(side * 0.364, 0.374, -0.342, 0.009, 0.02, 0.029);
  }

  const jacket = [[0.855, 0.295, 0.154, 0.108], [0.97, 0.27, 0.145, 0.104],
    [1.19, 0.205, 0.192, 0.113], [1.292, 0.18, 0.205, 0.11],
    [1.344, 0.164, 0.074, 0.071]].map(([y, z, width, depth]) =>
    Array.from({ length: 12 }, (_, j) => {
      const angle = j * Math.PI / 6;
      return V3(Math.cos(angle) * width, y, z + Math.sin(angle) * depth);
    }));
  material(LEATHER);
  b.grid(jacket, { closed: true }).fan(jacket[0]).fan(jacket[jacket.length - 1], true);
  material([0.06, 0.052, 0.044]);
  curve([[0.012, 0.897, 0.177], [0.012, 1.05, 0.132], [0.012, 1.27, 0.066]], 0.004, 10, 5);
  for (const side of [-1, 1]) {
    material(LEATHER);
    const shoulder = [side * 0.182, 1.27, 0.17];
    const elbow = [side * 0.303, 1.067, -0.085];
    const wrist = [side * 0.412, 1.137, -0.348];
    ellipsoid(shoulder, [0.083, 0.085, 0.087]);
    cylinder(shoulder, elbow, 0.077, 0.063, 10);
    ellipsoid(elbow, [0.065, 0.068, 0.072]);
    cylinder(elbow, wrist, 0.062, 0.043, 10);
    material(BLACK, 3);
    ellipsoid([side * 0.424, 1.148, -0.353], [0.050, 0.043, 0.055]);
    material([0.075, 0.063, 0.054]);
    curve([[side * 0.21, 1.313, 0.164], [side * 0.335, 1.10, -0.08],
      [side * 0.439, 1.157, -0.302]], 0.003, 10, 4);
    curve([[side * 0.027, 1.26, 0.065], [side * 0.099, 1.307, 0.10],
      [side * 0.058, 1.347, 0.133]], 0.008, 8, 5);
  }
  material([0.31, 0.19, 0.125], 3);
  cylinder([0, 1.328, 0.157], [0, 1.411, 0.143], 0.052, 0.050, 10);
  material([0.032, 0.036, 0.041]);
  ellipsoid([0, 1.50, 0.14], [0.126, 0.15, 0.143], undefined, 16);
  material([0.012, 0.025, 0.036], 1);
  append(b, new THREE.SphereGeometry(1, 12, 4, Math.PI + 0.48, Math.PI - 0.96,
    Math.PI * 0.31, Math.PI * 0.33), [0, 1.50, 0.14], [0.128, 0.152, 0.145]);
  material(BLACK, 3);
  b.box(0, 1.408, 0.03, 0.082, 0.015, 0.023);

  const geometry = b.build();
  geometry.computeBoundingBox();
  return geometry;
}
