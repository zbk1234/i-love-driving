import * as THREE from 'three';

// 一个很小的程序化建模工具：往数组里追加三角形，最后合并成一个 BufferGeometry。
// 每个顶点带：位置、法线、uv、颜色(aColor)、自发光强度(aEmis)、材质标记(aData)。

const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const V3 = (x, y, z) => new THREE.Vector3(x, y, z);

export class GeoBuilder {
  constructor() {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.emi = [];
    this.uvs = [];
    this.dat = [];
    this._c = [1, 1, 1];
    this._e = 0;
    this._d = 0;
    this._m = null;
  }

  color(r, g, b) {
    this._c = [r, g, b];
    return this;
  }
  emis(e) {
    this._e = e;
    return this;
  }
  data(d) {
    this._d = d;
    return this;
  }
  xform(m) {
    this._m = m;
    return this;
  }

  vert(p, n, u = 0, v = 0) {
    _p.copy(p);
    _n.copy(n);
    if (this._m) {
      _p.applyMatrix4(this._m);
      _n.transformDirection(this._m);
    }
    this.pos.push(_p.x, _p.y, _p.z);
    this.nor.push(_n.x, _n.y, _n.z);
    this.col.push(this._c[0], this._c[1], this._c[2]);
    this.emi.push(this._e);
    this.dat.push(this._d);
    this.uvs.push(u, v);
  }

  // a,b,c,d 逆时针（从正面看），法线 = (b-a)×(d-a)
  quad(a, b, c, d, uv) {
    const n = V3().subVectors(b, a).cross(V3().subVectors(d, a)).normalize();
    const t = uv || [[0, 0], [1, 0], [1, 1], [0, 1]];
    this.vert(a, n, t[0][0], t[0][1]);
    this.vert(b, n, t[1][0], t[1][1]);
    this.vert(c, n, t[2][0], t[2][1]);
    this.vert(a, n, t[0][0], t[0][1]);
    this.vert(c, n, t[2][0], t[2][1]);
    this.vert(d, n, t[3][0], t[3][1]);
    return this;
  }

  box(cx, cy, cz, sx, sy, sz) {
    const x0 = cx - sx / 2;
    const x1 = cx + sx / 2;
    const y0 = cy - sy / 2;
    const y1 = cy + sy / 2;
    const z0 = cz - sz / 2;
    const z1 = cz + sz / 2;
    this.quad(V3(x1, y0, z1), V3(x1, y0, z0), V3(x1, y1, z0), V3(x1, y1, z1));
    this.quad(V3(x0, y0, z0), V3(x0, y0, z1), V3(x0, y1, z1), V3(x0, y1, z0));
    this.quad(V3(x0, y1, z1), V3(x1, y1, z1), V3(x1, y1, z0), V3(x0, y1, z0));
    this.quad(V3(x0, y0, z0), V3(x1, y0, z0), V3(x1, y0, z1), V3(x0, y0, z1));
    this.quad(V3(x0, y0, z1), V3(x1, y0, z1), V3(x1, y1, z1), V3(x0, y1, z1));
    this.quad(V3(x1, y0, z0), V3(x0, y0, z0), V3(x0, y1, z0), V3(x1, y1, z0));
    return this;
  }

  // 两点之间的方梁，截面 w × d
  beam(a, b, w, d, up = V3(0, 1, 0)) {
    const axis = V3().subVectors(b, a);
    const len = axis.length();
    axis.normalize();
    const side = V3().crossVectors(axis, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    const other = V3().crossVectors(side, axis).normalize();
    const m = new THREE.Matrix4().makeBasis(side, axis, other);
    m.setPosition(V3().addVectors(a, b).multiplyScalar(0.5));
    const prev = this._m;
    this._m = prev ? prev.clone().multiply(m) : m;
    this.box(0, 0, 0, w, len, d);
    this._m = prev;
    return this;
  }

  cyl(a, b, ra, rb, seg = 10, capA = false, capB = false) {
    const w = V3().subVectors(b, a).normalize();
    const u = Math.abs(w.y) < 0.9 ? V3(0, 1, 0).cross(w).normalize() : V3(1, 0, 0).cross(w).normalize();
    const v = V3().crossVectors(w, u);
    const ring = (c, r, k) => {
      const t = (k / seg) * Math.PI * 2;
      const dir = V3().addScaledVector(u, Math.cos(t)).addScaledVector(v, Math.sin(t));
      return [V3().copy(c).addScaledVector(dir, r), dir];
    };
    for (let k = 0; k < seg; k++) {
      const [a0, n0] = ring(a, ra, k);
      const [a1, n1] = ring(a, ra, k + 1);
      const [b0] = ring(b, rb, k);
      const [b1] = ring(b, rb, k + 1);
      this.vert(a0, n0);
      this.vert(a1, n1);
      this.vert(b1, n1);
      this.vert(a0, n0);
      this.vert(b1, n1);
      this.vert(b0, n0);
      if (capA) {
        const nn = V3().copy(w).negate();
        this.vert(a, nn);
        this.vert(a1, nn);
        this.vert(a0, nn);
      }
      if (capB) {
        this.vert(b, w);
        this.vert(b0, w);
        this.vert(b1, w);
      }
    }
    return this;
  }

  // 由二维点阵 P[i][j] 生成曲面，法线平滑。closed：j 方向首尾相接。
  // quadFn(i, j) 可为单个面片覆盖 {c, e, d}；uvFn(i, j) 自定义 uv。
  grid(P, { closed = false, flip = false, quadFn = null, uvFn = null } = {}) {
    const ni = P.length;
    const nj = P[0].length;
    const N = [];
    const dU = V3();
    const dV = V3();
    for (let i = 0; i < ni; i++) {
      N.push([]);
      for (let j = 0; j < nj; j++) {
        const i0 = Math.max(i - 1, 0);
        const i1 = Math.min(i + 1, ni - 1);
        const j0 = closed ? (j - 1 + nj) % nj : Math.max(j - 1, 0);
        const j1 = closed ? (j + 1) % nj : Math.min(j + 1, nj - 1);
        dU.subVectors(P[i1][j], P[i0][j]);
        dV.subVectors(P[i][j1], P[i][j0]);
        const n = V3().crossVectors(dU, dV);
        if (n.lengthSq() < 1e-12) n.set(0, 1, 0);
        n.normalize();
        if (flip) n.negate();
        N[i].push(n);
      }
    }
    const uv = (i, j) => (uvFn ? uvFn(i, j) : [i / (ni - 1), j / (nj - 1)]);
    const save = [this._c, this._e, this._d];
    const jn = closed ? nj : nj - 1;
    for (let i = 0; i < ni - 1; i++) {
      for (let j = 0; j < jn; j++) {
        const j2 = (j + 1) % nj;
        if (quadFn) {
          const o = quadFn(i, j) || {};
          this._c = o.c || save[0];
          this._e = o.e ?? save[1];
          this._d = o.d ?? save[2];
        }
        const idx = flip
          ? [[i, j], [i + 1, j2], [i + 1, j], [i, j], [i, j2], [i + 1, j2]]
          : [[i, j], [i + 1, j], [i + 1, j2], [i, j], [i + 1, j2], [i, j2]];
        for (const [a, b] of idx) {
          const t = uv(a, b === 0 && j2 === 0 && closed ? nj : b);
          this.vert(P[a][b], N[a][b], t[0], t[1]);
        }
      }
    }
    [this._c, this._e, this._d] = save;
    return this;
  }

  // 用扇形封住一圈点
  fan(ring, flip = false) {
    const c = V3();
    for (const p of ring) c.add(p);
    c.multiplyScalar(1 / ring.length);
    const n = V3();
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      n.add(V3().subVectors(a, c).cross(V3().subVectors(b, c)));
    }
    n.normalize();
    if (flip) n.negate();
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      this.vert(c, n);
      if (flip) {
        this.vert(b, n);
        this.vert(a, n);
      } else {
        this.vert(a, n);
        this.vert(b, n);
      }
    }
    return this;
  }

  // std=true 时把颜色属性命名为 three 标准材质认识的 'color'
  build(std = false) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uvs, 2));
    if (std) {
      g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    } else {
      g.setAttribute('aColor', new THREE.Float32BufferAttribute(this.col, 3));
      g.setAttribute('aEmis', new THREE.Float32BufferAttribute(this.emi, 1));
      g.setAttribute('aData', new THREE.Float32BufferAttribute(this.dat, 1));
    }
    g.computeBoundingSphere();
    return g;
  }
}

export { V3 };
